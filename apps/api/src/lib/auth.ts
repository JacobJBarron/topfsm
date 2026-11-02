import { isRole, memberPermissions, STAFF, type Permission, type Role } from "@crewtavo/core";
import { AuthClient } from "@supabase/supabase-js";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { ASSISTANT_NO_API, isRead } from "./assistants";
import { dbError, HttpError, uuid } from "./http";
import { allow } from "./limit";
import { stackServices } from "./stack";
import { adminClient, publishableKey, userClient } from "./supabase";

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Verifies the Supabase access token (signature, expiry) and attaches a client that acts as the
 * user. Works for browser sessions and for MCP access tokens from Supabase's OAuth server; an AI
 * assistant's token only reads here: it changes things with its MCP tools (lib/assistants.ts).
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) throw new HttpError(401, "Sign in to continue.");
  const db = userClient(c.env, token);
  const { data, error } = await db.auth.getClaims(token);
  const sub = data?.claims?.sub;
  if (error || !sub) throw new HttpError(401, "Your session has expired. Sign in again.");
  const client = typeof data.claims.client_id === "string" && data.claims.client_id ? data.claims.client_id : null;
  if (client && !isRead(c.req.method)) throw new HttpError(403, ASSISTANT_NO_API);
  c.set("userId", sub);
  c.set("token", token);
  c.set("sessionId", typeof data.claims.session_id === "string" ? data.claims.session_id : "");
  const meta = (data.claims as { app_metadata?: unknown }).app_metadata;
  c.set("appMetadata", meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {});
  c.set("db", db);
  await next();
});

/**
 * Requires membership in the company named by the X-Company-Id header, with one of `roles` (the
 * team, STAFF, when none are given) and a role that includes `permission`. Postgres RLS enforces
 * the same rules; this gives clear errors before any work starts. Closed to subs by default: a
 * route a sub uses opts in with WITH_SUBS (or names "subcontractor").
 */
export function requireCompany(roles: readonly Role[] = STAFF, permission?: Permission) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const companyId = c.req.header("x-company-id");
    if (!companyId || !uuid.safeParse(companyId).success) throw new HttpError(400, "Choose a company first.");
    const { data, error } = await c.var.db
      .from("memberships")
      .select("role, role_id, subcontractor_id")
      .eq("company_id", companyId)
      .eq("user_id", c.var.userId)
      .eq("active", true)
      .maybeSingle();
    if (error) throw dbError(error);
    if (!data || !isRole(data.role)) throw new HttpError(403, "You're not a member of this company.");
    let custom: string[] | null = null;
    if (data.role_id) {
      const role = await c.var.db.from("company_roles").select("permissions").eq("id", data.role_id).maybeSingle();
      if (role.error) throw dbError(role.error);
      custom = role.data?.permissions ?? [];
    }
    const permissions = memberPermissions(data.role, custom);
    if (!roles.includes(data.role) || (permission && !permissions.includes(permission))) {
      throw new HttpError(403, "You don't have permission to do that. Ask an admin if you need it.");
    }
    c.set("companyId", companyId);
    c.set("role", data.role);
    c.set("permissions", permissions);
    c.set("subcontractorId", data.subcontractor_id ?? null);
    await next();
  });
}

/**
 * A one-time link from an email (invite, password reset, sign-in) that opens the app, which redeems
 * the token itself (supabase.auth.verifyOtp in apps/web/src/lib/session.tsx). Supabase's own
 * action_link instead bounces through its redirect allow-list and falls back to the project's Site
 * URL (localhost on a new project), so it breaks until someone edits the Supabase dashboard.
 * `welcome` shows the "set your password" screen for a person who was invited but never signed in.
 */
export function emailAuthLink(base: string, tokenHash: string, type: "invite" | "recovery" | "magiclink", welcome = false): string {
  const params = new URLSearchParams({ token_hash: tokenHash, type });
  if (welcome) params.set("welcome", "1");
  return `${base}/?${params}`;
}

/** A password that isn't the account's. */
export const WRONG_PASSWORD = "That password isn't right.";
/** Someone who only signs in with Google may never have chosen a password. */
export const NO_PASSWORD =
  "You sign in with Google, so your account may not have a Crewtavo password yet. Set one under Settings → Profile → Change password, then try again.";

/** Auth itself counted too many sign-ins for this account (not the tries counted here). */
export const TOO_MANY_SIGN_INS = "Too many sign-in attempts for this account. Try again in 15 minutes.";

/**
 * Where Auth itself answers: in an instance, its own service on the private network, not this
 * server's gateway, whose sign-in pause (lib/signInGuard.ts) a stranger who knows the email could set
 * off; otherwise the Supabase project's.
 */
function authService(env: AppEnv["Bindings"]): string {
  return stackServices(env as unknown as Record<string, string | undefined>)?.auth.replace(/\/$/, "") ?? `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;
}

/** Tries one person gets an hour across all their sign-ins, for each kind of check. */
const TRIES_PER_PERSON = 50;

/**
 * The signed-in person's current password, asked for before something a leftover session or an
 * unlocked phone shouldn't do quietly (new spare keys, changing the Stripe key or the password).
 * Checked with a throwaway sign-in that's ended right away; `limit` names the tries counted, `max`
 * an hour for each sign-in, so a stolen session can't use up the owner's own, and 50 an hour for
 * the person, so many sessions can't guess without end. Their profile comes back, for the record.
 */
export async function confirmPassword(c: Context<AppEnv>, password: string, limit: string, max = 5): Promise<{ email: string; full_name: string | null }> {
  const { userId, sessionId } = c.var;
  if (!(await allow(c.env, `${limit}:${userId}:${sessionId}`, max, 3600)) || !(await allow(c.env, `${limit}:${userId}`, TRIES_PER_PERSON, 3600))) {
    throw new HttpError(429, "Too many tries. Wait an hour and try again.");
  }
  const { data: profile } = await adminClient(c.env).from("profiles").select("email, full_name").eq("user_id", userId).maybeSingle();
  if (!profile?.email) throw new HttpError(400, "Your account has no email address.");
  const key = publishableKey(c.env);
  const check = new AuthClient({ url: authService(c.env), headers: { Authorization: `Bearer ${key}`, apikey: key }, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
  const { error: wrong } = await check.signInWithPassword({ email: profile.email, password });
  if (wrong?.status === 429) throw new HttpError(429, TOO_MANY_SIGN_INS);
  if (wrong && (!wrong.status || wrong.status >= 500)) throw new HttpError(503, "Couldn't check your password. Try again in a moment.");
  if (wrong) {
    const providers = c.var.appMetadata.providers;
    throw new HttpError(400, Array.isArray(providers) && providers.length && !providers.includes("email") ? NO_PASSWORD : WRONG_PASSWORD);
  }
  await check.signOut({ scope: "local" }).catch(() => undefined);
  return { email: profile.email, full_name: profile.full_name };
}

/** Giving admin access without the password. */
export const ADMIN_PASSWORD = "Enter your password to give someone admin access.";

/**
 * Giving someone admin-level access (adminLevel), or a link into an account that has it, asks for
 * the giver's own password: a stolen session could otherwise make an admin whose password it knows.
 */
export async function confirmAdminGrant(c: Context<AppEnv>, password: string | undefined) {
  if (!password) throw new HttpError(400, ADMIN_PASSWORD);
  return confirmPassword(c, password, "admin-grant", 10);
}

/** The current_password a request may carry, for routes whose body is otherwise empty. */
export async function passwordIn(c: Context<AppEnv>): Promise<string | undefined> {
  const body: unknown = await c.req.json().catch(() => null);
  const password = body && typeof body === "object" ? (body as { current_password?: unknown }).current_password : undefined;
  return typeof password === "string" && password.length <= 200 ? password : undefined;
}

/** Sign-ins that prove the person has their email: a reset, invitation or sign-in link, or an emailed code. */
export const EMAILED_SIGN_INS = ["recovery", "invite", "magiclink", "otp"] as const;

/**
 * Whether the session behind a token's claims began within `seconds`, by one of `methods`. Auth's amr
 * entries say how each sign-in happened and when; a refreshed token keeps them.
 */
export function signedInWithin(claims: Record<string, unknown> | null | undefined, methods: readonly string[], seconds: number): boolean {
  const since = Date.now() / 1000 - seconds;
  const amr = Array.isArray(claims?.amr) ? (claims.amr as Array<{ method?: unknown; timestamp?: unknown } | null>) : [];
  return amr.some((e) => typeof e?.method === "string" && methods.includes(e.method) && typeof e.timestamp === "number" && e.timestamp >= since);
}
