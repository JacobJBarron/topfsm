/**
 * Crewtavo's access to its own Railway project. The owner connects it in setup right after
 * deploying (Login with Railway: still signed in to Railway, they press Authorize), or pastes a
 * project token. It's required on Railway: until it's there, the owner is asked at sign-in
 * (railwayNeeded), since the warnings before the trial runs out need it (services/hosting.ts).
 * Crewtavo keeps it, encrypted, until the owner removes it; Settings → Web address and Settings →
 * Hosting use it.
 *
 * OAuth access tokens last an hour and refresh themselves when used; the refresh token lasts a
 * year from when it was issued and rotates on every refresh, so the daily "railway" task refreshes
 * any that haven't been used in a month to keep the connection alive.
 */
import type { AddressOverview } from "@crewtavo/core";
import type { Env } from "../env";
import { railwayLinks } from "../lib/address";
import { asJson, HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";
import { deleteClient, projectAccess, railwayIds, RailwayError, refreshAccess, registerClient, SCOPE, type RailwayAccess, type RailwayClient } from "../integrations/railway";
import { platformOf } from "../lib/address";
import { loadSecret, saveSecret, type StoredSecret } from "../integrations/tokens";

/** Refresh tokens that haven't rotated in this long get refreshed by the daily task. */
export const KEEP_ALIVE_MS = 30 * 24 * 60 * 60_000;

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

const clientOf = (secret: StoredSecret | null): RailwayClient | null =>
  secret?.extra?.client_id && secret.extra.client_secret && secret.extra.redirect_uri
    ? {
        client_id: secret.extra.client_id,
        client_secret: secret.extra.client_secret,
        redirect_uri: secret.extra.redirect_uri,
        scope: secret.extra.scope,
        registration_access_token: secret.extra.registration_access_token,
        registration_client_uri: secret.extra.registration_client_uri,
      }
    : null;

/** Whether Crewtavo holds Railway access, and the Railway pages for doing things by hand. */
export async function railwayState(env: Env, admin: Db, companyId: string): Promise<Omit<NonNullable<AddressOverview["railway"]>, "domains">> {
  const [{ data: row }, secret] = await Promise.all([
    admin.from("integrations").select("status, settings, last_error").match({ company_id: companyId, provider: "railway" }).maybeSingle(),
    loadSecret(env, admin, companyId, "railway").catch(() => null),
  ]);
  const links = railwayLinks(env);
  return {
    connected: Boolean(row?.status === "connected" && (secret?.access_token || secret?.api_key)),
    oauth: Boolean(links) && (row?.settings as { oauth_refused?: boolean } | null)?.oauth_refused !== true,
    settingsUrl: links?.settingsUrl ?? null,
    variablesUrl: links?.variablesUrl ?? null,
    tokensUrl: links?.tokensUrl ?? null,
    projectName: env.RAILWAY_PROJECT_NAME ?? null,
    error: row && row.status !== "connected" ? row.last_error : null,
  };
}

/** How long "Ask me tomorrow" puts off connecting Railway, for an owner who can't right now. */
export const LATER_MS = 24 * 60 * 60_000;

/**
 * Whether the owner still has to connect Railway: on a one-business instance on Railway, until
 * they have (or after Railway stopped accepting the sign-in), except for a day after "Ask me
 * tomorrow". GET /me says so, and the app asks at sign-in.
 */
export function railwayNeeded(env: Env, row: { status: string } | null, companySettings: unknown, now = Date.now()): boolean {
  if (env.CREWTAVO_SINGLE_COMPANY !== "1" || platformOf(env) !== "railway" || !railwayIds(env)) return false;
  const later = Date.parse(String((companySettings as { railway_later?: string } | null)?.railway_later ?? ""));
  if (later > now) return false;
  return row?.status !== "connected";
}

/** "Ask me tomorrow": the owner can't connect Railway right now (Railway is down, or someone else looks after it). */
export async function connectRailwayLater(admin: Db, companyId: string): Promise<void> {
  const { data } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  const settings = (data?.settings ?? {}) as Record<string, unknown>;
  const { error } = await admin.from("companies").update({ settings: asJson({ ...settings, railway_later: new Date(Date.now() + LATER_MS).toISOString() }) }).eq("id", companyId);
  if (error) throw new HttpError(500, "Couldn't save that. Try again.");
}

/** Keeps why a Railway sign-in failed, for the screen to show (never taken from the address bar). */
export async function noteRailwayError(admin: Db, companyId: string, message: string): Promise<void> {
  const { data: row } = await admin.from("integrations").select("status").match({ company_id: companyId, provider: "railway" }).maybeSingle();
  if (row) await admin.from("integrations").update({ last_error: message }).match({ company_id: companyId, provider: "railway" });
  else await admin.from("integrations").insert({ company_id: companyId, provider: "railway", status: "disconnected", last_error: message });
}

/**
 * Railway refused this instance's Login with Railway client itself (invalid_client: removed there,
 * or its secret no longer matches): forget it, so the next Log in with Railway registers a new one
 * rather than sending the same one again every time. Any other refusal keeps it.
 */
export async function forgetRefusedClient(admin: Db, companyId: string, error: unknown): Promise<void> {
  if (!(error instanceof RailwayError) || !/invalid_client|unauthorized_client/.test(error.message)) return;
  await admin.from("integration_secrets").delete().match({ company_id: companyId, provider: "railway" });
}

/** Railway stopped taking the sign-in (removed there, or it ran out): Settings offers to connect again. */
async function lapsed(admin: Db, companyId: string, error: unknown) {
  await admin
    .from("integrations")
    .update({ status: "error", last_error: `Railway stopped accepting Crewtavo's sign-in (${failure(error)}). Connect Railway again.` })
    .match({ company_id: companyId, provider: "railway" });
}

async function refreshAndSave(env: Env, admin: Db, companyId: string, secret: StoredSecret, access: RailwayAccess): Promise<RailwayAccess> {
  const client = clientOf(secret);
  if (!client) throw new RailwayError("Crewtavo's Railway sign-in is incomplete. Connect Railway again.");
  try {
    const fresh = await refreshAccess(client, access);
    await saveSecret(env, admin, companyId, "railway", {
      ...secret,
      access_token: fresh.token,
      refresh_token: fresh.refresh_token,
      expires_at: fresh.expires_at,
      extra: { ...secret.extra, refreshed_at: String(Date.now()) },
    });
    return fresh;
  } catch (error) {
    // A refused refresh token won't work later either; anything else (Railway unreachable) might.
    if (error instanceof RailwayError && error.status >= 400 && error.status < 500) {
      // Unless another server (or the daily task) refreshed it meanwhile and saved the new one: Railway
      // refused the old refresh token, not the connection.
      const latest = await loadSecret(env, admin, companyId, "railway").catch(() => null);
      if (latest?.access_token && latest.refresh_token && latest.refresh_token !== secret.refresh_token) {
        return { method: "oauth", token: latest.access_token, refresh_token: latest.refresh_token, expires_at: latest.expires_at };
      }
      await lapsed(admin, companyId, error);
      await forgetRefusedClient(admin, companyId, error);
    }
    throw error;
  }
}

/** Reads of Railway access under way in this server, by company. */
const reading = new Map<string, Promise<RailwayAccess | null>>();

/**
 * One read of a company's Railway access at a time in this server, shared by everyone who asks
 * meanwhile (Settings → Web address and Hosting, a files move, uploads, the daily task). Login with
 * Railway's refresh token changes on every refresh and Railway takes each one only once, so two
 * refreshes at once would both send the same one, and the one Railway refused would mark the
 * connection lapsed although the other had just saved new tokens.
 */
function oneAtATime(companyId: string, read: () => Promise<RailwayAccess | null>): Promise<RailwayAccess | null> {
  const going = reading.get(companyId);
  if (going) return going;
  const shared: Promise<RailwayAccess | null> = read().finally(() => {
    if (reading.get(companyId) === shared) reading.delete(companyId);
  });
  reading.set(companyId, shared);
  return shared;
}

/** Usable Railway access for this company, refreshed when it's about to run out; null without any. */
export function railwayAccess(env: Env, admin: Db, companyId: string): Promise<RailwayAccess | null> {
  return oneAtATime(companyId, () => readRailwayAccess(env, admin, companyId));
}

async function readRailwayAccess(env: Env, admin: Db, companyId: string): Promise<RailwayAccess | null> {
  const [secret, { data: row }] = await Promise.all([
    loadSecret(env, admin, companyId, "railway"),
    admin.from("integrations").select("status").match({ company_id: companyId, provider: "railway" }).maybeSingle(),
  ]);
  if (row?.status !== "connected") return null;
  if (secret?.extra?.method === "token" && secret.api_key) return { method: "token", token: secret.api_key };
  if (!secret?.access_token) return null;
  const access: RailwayAccess = { method: "oauth", token: secret.access_token, refresh_token: secret.refresh_token, expires_at: secret.expires_at };
  if (!access.expires_at || access.expires_at - Date.now() > 120_000) return access;
  return refreshAndSave(env, admin, companyId, secret, access);
}

/** This instance's OAuth client at Railway, registered once per address it signs in from. */
export async function railwayClient(env: Env, admin: Db, companyId: string, redirectUri: string, name: string): Promise<RailwayClient> {
  const secret = await loadSecret(env, admin, companyId, "railway").catch(() => null);
  const known = clientOf(secret);
  // A client from before the scope was recorded asked for SCOPE too; one made for another scope is replaced.
  if (known?.redirect_uri === redirectUri && (!known.scope || known.scope === SCOPE)) return known;
  let client: RailwayClient;
  try {
    client = await registerClient(redirectUri, name);
  } catch (error) {
    // Railway turned the registration down: the screen offers a project token instead from now on.
    const refused = { settings: asJson({ oauth_refused: true }), last_error: failure(error) };
    const { data: row } = await admin.from("integrations").select("status").match({ company_id: companyId, provider: "railway" }).maybeSingle();
    if (row) await admin.from("integrations").update(refused).match({ company_id: companyId, provider: "railway" });
    else await admin.from("integrations").insert({ company_id: companyId, provider: "railway", status: "disconnected", ...refused });
    throw error;
  }
  if (known) await deleteClient(known);
  await admin.from("integrations").upsert({ company_id: companyId, provider: "railway", status: "disconnected", settings: asJson({}), last_error: null });
  const { client_id, client_secret, redirect_uri, registration_access_token, registration_client_uri } = client;
  await saveSecret(env, admin, companyId, "railway", {
    extra: { method: "oauth", client_id, client_secret, redirect_uri, scope: SCOPE, ...(registration_access_token ? { registration_access_token } : {}), ...(registration_client_uri ? { registration_client_uri } : {}) },
  });
  return client;
}

/** Keeps the access, after checking it reaches this instance's project. */
export async function saveRailwayAccess(env: Env, admin: Db, companyId: string, userId: string, access: RailwayAccess): Promise<void> {
  await projectAccess(env, access);
  const secret = await loadSecret(env, admin, companyId, "railway").catch(() => null);
  const stored: StoredSecret =
    access.method === "token"
      ? { api_key: access.token, extra: { method: "token" } }
      : {
          ...secret,
          access_token: access.token,
          refresh_token: access.refresh_token,
          expires_at: access.expires_at,
          extra: { ...secret?.extra, method: "oauth", refreshed_at: String(Date.now()) },
        };
  const { error } = await admin.from("integrations").upsert({
    company_id: companyId, provider: "railway", status: "connected", account_label: env.RAILWAY_PROJECT_NAME ?? "Railway", connected_by: userId, connected_at: new Date().toISOString(), last_error: null,
    settings: asJson(access.method === "token" ? { method: "token" } : { method: "oauth", scope: SCOPE }),
  });
  if (error) throw new HttpError(500, "Couldn't save the Railway sign-in. Try again.");
  // A project token replaces a Login with Railway client; let Railway forget that one.
  if (access.method === "token") {
    const client = clientOf(secret);
    if (client) await deleteClient(client);
  }
  await saveSecret(env, admin, companyId, "railway", stored);
}

/** Forgets Railway access and removes this instance's OAuth client there. */
export async function forgetRailway(env: Env, admin: Db, companyId: string): Promise<void> {
  const client = clientOf(await loadSecret(env, admin, companyId, "railway").catch(() => null));
  if (client) await deleteClient(client);
  await admin.from("integrations").delete().match({ company_id: companyId, provider: "railway" });
}

/** The daily "railway" task: refreshes sign-ins that haven't rotated in a month, so they don't run out. */
export async function keepRailwayAlive(env: Env, admin: Db): Promise<{ refreshed: number; lapsed: number }> {
  const { data: rows, error } = await admin.from("integrations").select("company_id").match({ provider: "railway", status: "connected" });
  if (error) throw new Error(error.message);
  let refreshed = 0;
  let failed = 0;
  for (const { company_id } of rows ?? []) {
    const secret = await loadSecret(env, admin, company_id, "railway").catch(() => null);
    if (!secret?.refresh_token || secret.extra?.method === "token") continue;
    if (Date.now() - Number(secret.extra?.refreshed_at ?? 0) < KEEP_ALIVE_MS) continue;
    try {
      // As a read of the access, so a page asking at the same moment waits for this refresh rather than sending the same refresh token.
      await oneAtATime(company_id, () => refreshAndSave(env, admin, company_id, secret, { method: "oauth", token: secret.access_token ?? "", refresh_token: secret.refresh_token }));
      refreshed++;
    } catch {
      failed++;
    }
  }
  return { refreshed, lapsed: failed };
}

/**
 * The setup step after "Set up your business" (Connect Railway, then a web address): pending for a
 * business set up on Railway, until the owner finishes or skips it.
 */
export type RailwaySetup = "pending" | "done" | "skipped";

export async function setRailwaySetup(admin: Db, companyId: string, status: RailwaySetup): Promise<void> {
  const { data } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  const settings = (data?.settings ?? {}) as Record<string, unknown>;
  const { error } = await admin.from("companies").update({ settings: asJson({ ...settings, railway_setup: status }) }).eq("id", companyId);
  if (error) throw new HttpError(500, "Couldn't save that. Try again.");
}
