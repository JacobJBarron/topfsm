/**
 * Subs' own sign-ins (services/subAccess.ts, routes/subs.ts) and the API closed to them by default
 * (requireCompany in lib/auth.ts), against a small stand-in for PostgREST and Supabase Auth: fetch is
 * stubbed, and tables live in memory. (What a sub can read and change in the database itself is
 * tested in supabase/tests/sub_isolation_test.sql.)
 *
 * The guard against forgetting: every route behind a sign-in is called as a sub, and each must refuse
 * (403, for being a sub) except the few on the list below; every route that isn't behind one is on a
 * list of its own, so one added with its own way of signing in fails until it's decided about. A
 * route added later is covered without anyone remembering.
 */
import { subLoginMark, TERMS_VERSION } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { requireUser } from "../src/lib/auth";
import { guardConsent, NO_ASSISTANTS_FOR_SUBS } from "../src/lib/assistants";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Crewtavo <noreply@example.com>",
};
const texting: Env = { ...env, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "twilio-token", TWILIO_FROM_NUMBER: "+15405550000" };

const CO = "00000000-0000-4000-8000-0000000000a1";
const OTHER_CO = "00000000-0000-4000-8000-0000000000a2";
const OFFICE = "00000000-0000-4000-8000-000000000001";
const CREW = "00000000-0000-4000-8000-000000000002";
const AL = "00000000-0000-4000-8000-000000000005";
const NEW_USER = "00000000-0000-4000-8000-0000000000ff";
const APEX = "00000000-0000-4000-8000-0000000000b1";
const VISIT = "00000000-0000-4000-8000-0000000000c1";

// Sessions Supabase Auth vouches for (getClaims asks /auth/v1/user about HS256 tokens).
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const tokenFor = (sub: string, claims: object = {}) =>
  `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.c2ln`;

type Row = Record<string, unknown>;
interface Account {
  id: string;
  email: string;
  last_sign_in_at?: string | null;
  /** Set only by the server: a sign-in made for a sub carries its mark (subLoginMark). */
  app_metadata?: Record<string, unknown>;
}
interface World {
  tables: Record<string, Row[]>;
  accounts: Record<string, Account>;
  /** Rate limits whose key matches are used up. */
  full?: RegExp;
  /** Twilio refuses texts. */
  twilioDown?: boolean;
  /** What public.sub_sign_ins_for_email answers. */
  emailSignIns?: Row[];
  /** What other database functions answer, by name. */
  rpcAnswers?: Record<string, unknown>;
}

interface Call {
  method: string;
  url: URL;
  path: string;
  body: any;
  /** The server's key (rather than a person's session) sent it. */
  admin: boolean;
}

/** Answers one PostgREST filter (eq, neq, in, is) the way PostgREST would. */
function matches(row: Row, key: string, value: string) {
  const [op, ...rest] = value.split(".");
  const arg = rest.join(".");
  const cell = row[key];
  if (op === "eq") return String(cell) === arg;
  if (op === "neq") return String(cell) !== arg;
  if (op === "in") return arg.slice(1, -1).split(",").includes(String(cell));
  if (op === "is") return arg === "null" ? cell === null || cell === undefined : String(cell) === arg;
  return true;
}
const FILTER_SKIP = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function serve(world: World) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies stay text
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const call: Call = { method, url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body, admin: (headers.get("apikey") ?? "") === "sb_secret_test" };
    calls.push(call);
    return answer(call, headers);
  });

  function answer(call: Call, headers: Headers): Response {
    const { url, method, body } = call;
    if (url.host === "api.resend.com") return Response.json({ id: "email-1" });
    if (url.host === "api.twilio.com") return world.twilioDown ? Response.json({ message: "The 'To' number is not a valid phone number." }, { status: 400 }) : Response.json({ sid: "SM1" });
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "someone", aud: "authenticated", role: "authenticated" });
    if (url.pathname === "/auth/v1/admin/users" && method === "POST") {
      const account: Account = { id: NEW_USER, email: body.email, app_metadata: { provider: "email", ...body.app_metadata } };
      world.accounts[NEW_USER] = account;
      // The account's profile, as private.handle_new_user makes it.
      (world.tables.profiles ??= []).push({ user_id: NEW_USER, email: body.email, full_name: body.user_metadata?.full_name ?? "", phone: null });
      return Response.json({ ...account, aud: "authenticated", user_metadata: body.user_metadata ?? {} });
    }
    const userPath = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (userPath) {
      const account = world.accounts[userPath[1]!];
      return account ? Response.json({ aud: "authenticated", ...account }) : Response.json({ msg: "User not found" }, { status: 404 });
    }
    if (url.pathname === "/auth/v1/admin/generate_link") {
      const account = Object.values(world.accounts).find((a) => a.email === body.email);
      const links = calls.filter((c) => c.url.pathname === "/auth/v1/admin/generate_link").length;
      return Response.json({ ...account, action_link: "https://example.supabase.co/verify", hashed_token: `tok-${links}`, verification_type: body.type, redirect_to: body.redirect_to, email_otp: "123456" });
    }
    if (!url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    const path = call.path;
    if (path === "rpc/rate_limit_hit") return Response.json(!world.full?.test(body.p_key));
    if (path === "rpc/user_id_for_email") return Response.json(Object.values(world.accounts).find((a) => a.email === body.p_email)?.id ?? null);
    if (path === "rpc/company_basics") {
      const company = (world.tables.companies ?? []).find((c) => c.id === body.p_company);
      return Response.json(company ? [{ id: company.id, name: company.name, timezone: "America/New_York", currency: "USD", phone: null, logo: null, settings: {} }] : []);
    }
    if (path === "rpc/sub_sign_ins_for_email") return Response.json(world.emailSignIns ?? []);
    if (path === "rpc/visit_contact") return Response.json([{ name: "Ann Client", phone: null, email: null }]);
    if (path.startsWith("rpc/")) return Response.json(world.rpcAnswers?.[path.slice(4)] ?? []);
    const rows = (world.tables[path] ??= []);
    const filters = [...url.searchParams].filter(([k]) => !FILTER_SKIP.has(k));
    const picked = rows.filter((r) => filters.every(([k, v]) => matches(r, k, v)));
    const one = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (method === "POST") {
      const added = (Array.isArray(body) ? body : [body]) as Row[];
      rows.push(...added);
      return Response.json(one ? added[0] : added, { status: 201 });
    }
    if (method === "PATCH") {
      for (const r of picked) Object.assign(r, body);
      return Response.json(picked);
    }
    if (method === "DELETE") {
      world.tables[path] = rows.filter((r) => !picked.includes(r));
      return Response.json(picked);
    }
    if (one) return picked.length ? Response.json(picked[0]) : Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 });
    return Response.json(picked);
  }

  const emails = () => calls.filter((c) => c.url.host === "api.resend.com").map((c) => c.body);
  const texts = () => calls.filter((c) => c.url.host === "api.twilio.com").map((c) => Object.fromEntries(new URLSearchParams(c.body as string)));
  return { calls, emails, texts };
}
afterEach(() => vi.unstubAllGlobals());

const apex = () => ({ id: APEX, company_id: CO, name: "Apex Roofing LLC", contact_name: "Al Apex", phone: "+15405550101", email: "al@apex.test", active: true, can_contact_clients: false, uses_clock: false });
/** Oscar Roofing: Opal in the office, Cy on the crew, and Apex Roofing, a sub, with no sign-in yet. */
const oscar = (extra: Partial<World["tables"]> = {}): World => ({
  tables: {
    companies: [{ id: CO, name: "Oscar Roofing", email: "office@oscar.test", settings: {} }],
    memberships: [
      { company_id: CO, user_id: OFFICE, role: "office", role_id: null, subcontractor_id: null, active: true },
      { company_id: CO, user_id: CREW, role: "field_crew", role_id: null, subcontractor_id: null, active: true },
    ],
    subcontractors: [apex()],
    profiles: [
      { user_id: OFFICE, email: "opal@oscar.test", full_name: "Opal Office", phone: null },
      { user_id: CREW, email: "cy@oscar.test", full_name: "Cy Crew", phone: null },
    ],
    ...extra,
  },
  accounts: {
    [OFFICE]: { id: OFFICE, email: "opal@oscar.test", last_sign_in_at: "2026-10-20T12:00:00Z" },
    [CREW]: { id: CREW, email: "cy@oscar.test", last_sign_in_at: "2026-10-20T12:00:00Z" },
  },
});
/** Al's sign-in, made by Oscar for Apex: it carries Oscar's mark for Apex. */
const AL_MARK = { provider: "email", crewtavo_sub: subLoginMark(CO, APEX) };
/** The same, with Al signed in as Apex's sub. */
const withAl = (lastSignIn: string | null = "2026-10-24T13:00:00Z"): World => {
  const w = oscar();
  w.tables.memberships!.push({ company_id: CO, user_id: AL, role: "subcontractor", role_id: null, subcontractor_id: APEX, active: true });
  w.tables.profiles!.push({ user_id: AL, email: "al@apex.test", full_name: "Al Apex", phone: "+15405550101" });
  w.accounts[AL] = { id: AL, email: "al@apex.test", last_sign_in_at: lastSignIn, app_metadata: AL_MARK };
  return w;
};

const as = (who: string, path: string, init: { method?: string; body?: unknown; company?: string } = {}, e: Env = env) =>
  app.request(
    `/api${path}`,
    {
      method: init.method ?? "GET",
      // Al's session carries his account's app_metadata, as Supabase Auth's tokens do.
      headers: { Authorization: `Bearer ${tokenFor(who, who === AL ? { app_metadata: AL_MARK } : {})}`, "X-Company-Id": init.company ?? CO, "Content-Type": "application/json" },
      ...(init.body !== undefined || (init.method && init.method !== "GET") ? { body: JSON.stringify(init.body ?? {}) } : {}),
    },
    e,
  );

// ===== Closed to subs by default ================================================================

/**
 * What a sub may reach: their own account (not a company's), My day and their visits' status and
 * notes, push, their own photo, and their own job offers. Everything else answers 403.
 */
const SUB_ROUTES = new Set([
  "GET /api/me",
  "PATCH /api/me",
  "GET /api/push/key",
  "POST /api/push/subscriptions",
  "POST /api/push/unsubscribe",
  "POST /api/push/test",
  "GET /api/schedule",
  "PATCH /api/visits/:id",
  "PUT /api/team/:userId/photo",
  "DELETE /api/team/:userId/photo",
  // Their own job offers, to read and answer (routes/subOffers.ts): for subs only.
  "GET /api/sub/offers",
  "GET /api/sub/offers/totals",
  "GET /api/sub/offers/:id/company",
  "POST /api/sub/offers/:id/answer",
  // The owner's spare keys: the person's own account; anyone but an owner is refused inside.
  "GET /api/account/spare-keys",
  "POST /api/account/spare-keys",
  // Their own password (Settings → Profile), for a sub on their own account.
  "POST /api/account/password",
]);

/**
 * Public routes a sub uses: signing in with a code by text or by email on a new phone
 * (routes/signInCodes.ts). No sign-in needed, so they're outside the walk below; they answer a sub the
 * way they answer anyone.
 */
const PUBLIC_SUB_ROUTES = ["POST /api/auth/text-code", "POST /api/auth/text-code/verify", "POST /api/auth/email-code", "POST /api/auth/email-code/verify"];

/**
 * Every route that isn't behind requireUser, as method and path: the app's own middleware, public
 * pages and webhooks with their own checks, signing in, AI assistants (their own token, refused for
 * subs: NO_ASSISTANTS_FOR_SUBS, tested below) and the scheduler (CRON_SECRET). A route added later
 * with its own way of signing in fails the test below until it's listed here, and so decided about.
 */
const NOT_SIGNED_IN_ROUTES = [
  // Middleware for the whole app, the assistant endpoint and its well-known documents.
  "ALL /*", "ALL /mcp", "ALL /.well-known/*",
  // Before anyone signs in.
  "GET /api/config", "GET /api/health", "GET /api/presets", "GET /api/setup", "POST /api/setup/owner",
  "POST /api/auth/email-link", "POST /api/auth/recover", ...PUBLIC_SUB_ROUTES,
  // Callbacks and webhooks, each checked its own way.
  "GET /api/apps/:provider/callback", "GET /api/railway/callback", "POST /api/webhooks/twilio", "POST /api/webhooks/stripe", "POST /api/webhooks/stripe/:company",
  // Pages for people without an account, behind signed links: a sub's paperwork, the Client Hub,
  // booking forms, logos, unsubscribing, reviews, referrals and calendar feeds; and the pictures on
  // estimates (letterheads, packages, price list items), each under a name never reused.
  "GET /api/public/paperwork/:token", "POST /api/public/paperwork/:token/uploads", "POST /api/public/paperwork/:token/files",
  "GET /api/hub/:token", "POST /api/hub/:token/approve", "POST /api/hub/:token/request-changes", "POST /api/hub/:token/accept-range", "POST /api/hub/:token/promo",
  "DELETE /api/hub/:token/promo", "POST /api/hub/:token/pay", "POST /api/hub/:token/message", "GET /api/hub/:token/drawings/:file", "GET /api/hub/:token/visits/:file",
  "POST /api/hub/:token/request", "POST /api/hub/:token/autopay/setup", "POST /api/hub/:token/autopay/finish", "POST /api/hub/:token/autopay/confirm",
  "POST /api/hub/:token/autopay/off", "POST /api/hub/:token/tip", "POST /api/public/forms/:company/:form/promo", "GET /api/public/forms/:company/:form", "POST /api/public/forms/:company/:form",
  "POST /api/public/forms/:company/:form/files", "GET /api/public/logo/:company/:file", "GET /api/public/letterhead/:company/:file",
  "GET /api/public/package/:company/:file", "GET /api/public/service/:company/:file", "GET /api/public/unsubscribe/:token", "POST /api/public/unsubscribe/:token",
  "GET /api/public/r/:token", "GET /api/public/refer/:token", "POST /api/public/refer/:token",
  // A campaign email's tracking image and tracked links (routes/public.ts): a random token each.
  "GET /api/public/o/:token", "GET /api/public/c/:token/:n", "GET /api/calendar/:file",
  // A social post's picture, fetched by Meta and Google (routes/public.ts): a random token each, for 7 days.
  "GET /api/public/social/:file", "HEAD /api/public/social/:file",
  // The instance's own documents, AI assistants (their own tokens) and website analytics.
  "GET /.well-known/crewtavo-instance", "GET /.well-known/oauth-protected-resource", "GET /.well-known/oauth-protected-resource/mcp",
  "GET /.well-known/oauth-authorization-server", "GET /.well-known/oauth-authorization-server/auth/v1", "GET /.well-known/openid-configuration/auth/v1",
  "GET /mcp", "POST /mcp", "GET /v.js", "POST /v",
  // Website forms: the address a business's own form sends to, and its pages.
  "OPTIONS /f/:key", "POST /f/:key", "GET /f/:key", "GET /f/:key/thanks",
  // The scheduler, with CRON_SECRET.
  "GET /api/cron/:task", "POST /api/cron/:task",
];

/** requireCompany's answer to someone whose level a route doesn't take: a sub, for every route not opted in. */
const SUB_REFUSAL = "You don't have permission to do that. Ask an admin if you need it.";
/** Routes that refuse a sub in their own words before requireCompany is reached. */
const OWN_REFUSALS: Record<string, string> = {
  // Setting up a business isn't a company's route: a sign-in made for a sub can't (routes/account.ts).
  "POST /api/companies": "This sign-in is for your work with another business. To run your own business on Crewtavo, use a different email address.",
};

/** Every route behind a sign-in (requireUser), as method and path. Public routes have their own checks. */
function signedInRoutes() {
  const routes = new Map<string, boolean>();
  for (const r of app.routes) {
    const key = `${r.method} ${r.path}`;
    routes.set(key, (routes.get(key) ?? false) || r.handler === requireUser);
  }
  return [...routes].filter(([, signedIn]) => signedIn).map(([key]) => key);
}

/** An instance on Railway, so the routes only an instance has are there to be refused. */
const instance: Env = { ...env, CREWTAVO_SINGLE_COMPANY: "1", RAILWAY_PROJECT_ID: "project-1", RAILWAY_PUBLIC_DOMAIN: "ops.example.com" };
/** Bodies a route checks before anything else; the rest get an empty one. */
const BODIES: Record<string, unknown> = {
  "POST /api/companies": { name: "Al's Roofing", trade_preset: "roofing", timezone: "America/New_York", terms_version: TERMS_VERSION },
};

/** A path with its parameters filled in: an id, or the first choice a pattern allows. */
const fill = (path: string, id: string) => path.replace(/:[a-zA-Z_]+(\{([^}|]+)[^}]*\})?/g, (_, _p, choice) => choice ?? id);

describe("the API, for a sub", () => {
  it("refuses every route that isn't theirs", async () => {
    serve(withAl());
    const routes = signedInRoutes();
    // Sanity: the walk sees the whole app, including routes added for subs.
    expect(routes.length).toBeGreaterThan(150);
    expect(routes).toEqual(expect.arrayContaining([...SUB_ROUTES, "GET /api/team", "POST /api/subs/:id/sign-in-link", "GET /api/dashboard", "POST /api/kb/ask"]));
    // Pay: even their own is the office's to set, agree and mark paid.
    expect(routes).toEqual(expect.arrayContaining([
      "POST /api/job-pay/suggest", "POST /api/job-pay", "GET /api/job-pay/:id", "POST /api/job-pay/:id/accept", "POST /api/job-pay/:id/done", "POST /api/job-pay/:id/cancel",
      "POST /api/job-pay/mark-paid", "POST /api/job-pay/unmark-paid", "GET /api/subs/1099", "GET /api/subs/1099/csv", "GET /api/subs/workers-comp", "GET /api/subs/workers-comp/csv",
    ]));
    // Offers: sending, changing and taking one back are the office's, even their own.
    expect(routes).toEqual(expect.arrayContaining(["POST /api/job-pay/:id/offer", "POST /api/job-pay/:id/offer/change", "POST /api/job-pay/:id/offer/withdraw"]));
    const open: string[] = [];
    for (const route of routes) {
      if (SUB_ROUTES.has(route)) continue;
      const [method, path] = route.split(" ") as [string, string];
      const res = await as(AL, fill(path, VISIT).replace(/^\/api/, ""), { method, body: BODIES[route] }, instance);
      // Refused for being a sub, not by chance (the stand-in world lacking a row): requireCompany's
      // words, or the few routes' own known refusals.
      const error = res.status === 403 ? ((await res.json()) as { error?: string }).error : null;
      if (res.status !== 403) open.push(`${route} answered ${res.status}`);
      else if (error !== SUB_REFUSAL && error !== OWN_REFUSALS[route]) open.push(`${route} answered 403 for another reason: ${error}`);
    }
    expect(open).toEqual([]);
  });

  it("knows every route that isn't behind a sign-in, so one added with its own sign-in is decided about", () => {
    const all = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    const signedIn = new Set(signedInRoutes());
    expect([...all].filter((route) => !signedIn.has(route)).sort()).toEqual([...NOT_SIGNED_IN_ROUTES].sort());
  });

  it("leaves signing in with a code by text or by email open, to a sub as to anyone", async () => {
    serve(withAl());
    const routes = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    expect(PUBLIC_SUB_ROUTES.filter((route) => !routes.has(route))).toEqual([]);
    expect(signedInRoutes().filter((route) => PUBLIC_SUB_ROUTES.includes(route))).toEqual([]);
    // Signed in or not, the same answers: this instance can't text, and a code nobody asked for isn't right.
    const asked = await as(AL, "/auth/text-code", { method: "POST", body: { phone: "540-555-0101" } });
    expect([asked.status, await asked.json()]).toEqual([200, { sent: false, reason: "sms_off" }]);
    const tried = await as(AL, "/auth/text-code/verify", { method: "POST", body: { phone: "540-555-0101", code: "123456" } });
    expect([tried.status, (await tried.json()).error]).toEqual([400, "That code isn't right. Check the text and try again."]);
    // By email: the same answer for every address, and a code nobody asked for isn't right.
    const emailed = await as(AL, "/auth/email-code", { method: "POST", body: { email: "al@apex.test" } });
    expect([emailed.status, await emailed.json()]).toEqual([200, { sent: true }]);
    const typed = await as(AL, "/auth/email-code/verify", { method: "POST", body: { email: "al@apex.test", code: "123456" } });
    expect([typed.status, (await typed.json()).error]).toEqual([400, "That code isn't right. Check the email and try again."]);
  });

  it("answers the routes that are theirs", async () => {
    serve(withAl());
    const answers: Record<string, number> = {};
    for (const route of SUB_ROUTES) {
      const [method, path] = route.split(" ") as [string, string];
      const filled = fill(path, path.includes(":userId") ? AL : VISIT).replace(/^\/api/, "").replace("/schedule", "/schedule?from=2026-10-25&to=2026-10-26");
      answers[route] = (await as(AL, filled, { method })).status;
    }
    expect(Object.entries(answers).filter(([, status]) => status === 403 || status >= 500)).toEqual([]);
  });

  it("gives My day their visits with the client's name from visit_contact, and nothing of the company's", async () => {
    const world = withAl();
    world.tables.visits = [{ id: VISIT, company_id: CO, title: "Tear off", status: "scheduled", scheduled_on: "2026-10-25" }];
    const { calls } = serve(world);
    const res = await as(AL, "/schedule?from=2026-10-25&to=2026-10-25");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.visits).toEqual([expect.objectContaining({ id: VISIT, contact: { name: "Ann Client", phone: null, email: null } })]);
    expect(calls.filter((c) => c.path === "rpc/visit_contact").map((c) => c.body)).toEqual([{ p_visit: VISIT }]);
  });

  it("lets a sub change their visit's status and notes, and nothing else", async () => {
    const world = withAl();
    world.tables.visits = [{ id: VISIT, company_id: CO, title: "Tear off", status: "scheduled" }];
    serve(world);
    expect((await as(AL, `/visits/${VISIT}`, { method: "PATCH", body: { status: "en_route", forward_only: true } })).status).toBe(200);
    expect((await as(AL, `/visits/${VISIT}`, { method: "PATCH", body: { notes: "Soft decking" } })).status).toBe(200);
    expect(world.tables.visits[0]).toMatchObject({ status: "en_route", notes: "Soft decking" });
    for (const change of [{ title: "Easy" }, { scheduled_on: "2026-10-26" }, { assignee_ids: [AL] }, { status: "cancelled" }, { status: "unscheduled" }]) {
      const res = await as(AL, `/visits/${VISIT}`, { method: "PATCH", body: change });
      expect(res.status, JSON.stringify(change)).toBe(403);
    }
    expect(world.tables.visits[0]).toMatchObject({ title: "Tear off", status: "en_route" });
  });

  it("lets a sub's Complete tapped offline carry the time it was tapped", async () => {
    const world = withAl();
    world.tables.visits = [{ id: VISIT, company_id: CO, title: "Tear off", status: "in_progress", completed_at: null }];
    serve(world);
    const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const res = await as(AL, `/visits/${VISIT}`, { method: "PATCH", body: { status: "completed", forward_only: true, completed_at: at } });
    expect(res.status).toBe(200);
    // Sent on to the database, whose guard on subs' visits (private.visit_sub_guard) has the last word.
    expect(world.tables.visits[0]).toMatchObject({ status: "completed", completed_at: at });
  });

  it("only changes their own photo", async () => {
    serve(withAl());
    expect((await as(AL, `/team/${OFFICE}/photo`, { method: "DELETE" })).status).toBe(403);
    expect((await as(AL, `/team/${OFFICE}/photo`, { method: "PUT", body: { photo: "A".repeat(200) } })).status).toBe(403);
    expect((await as(AL, `/team/${AL}/photo`, { method: "DELETE" })).status).toBe(200);
  });

  it("can't make spare keys, which are for owners", async () => {
    serve(withAl());
    const res = await as(AL, "/account/spare-keys", { method: "POST", body: { password: "x" } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/^Spare keys are for the owner/);
  });

  it("gives a sub's sign-in the company's basics and their sub, and keeps them from setting up a business", async () => {
    const { calls } = serve(withAl());
    const me = await (await as(AL, "/me")).json();
    expect(me.can_create_company).toBe(false);
    expect(me.memberships).toEqual([
      expect.objectContaining({
        role: "subcontractor",
        role_name: "Subcontractor",
        permissions: [],
        company: { id: CO, name: "Oscar Roofing", timezone: "America/New_York", currency: "USD", phone: null, logo: null, settings: {} },
        subcontractor: { id: APEX, name: "Apex Roofing LLC", can_contact_clients: false, uses_clock: false, own_sign_in: true, has_phone: true, has_email: true, phone_on_file: true },
        email_connected: false,
        ai_connected: false,
      }),
    ]);
    expect(calls.some((c) => c.path === "rpc/company_basics" && !c.admin)).toBe(true);
    const res = await as(AL, "/companies", { method: "POST", body: { name: "Al's Roofing", trade_preset: "roofing", timezone: "America/New_York", terms_version: TERMS_VERSION } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/^This sign-in is for your work with another business/);
    expect(calls.some((c) => c.path === "rpc/create_company")).toBe(false);
  });

  it("says whether their record has a number and an email a sign-in code can go to, without either", async () => {
    const cases: Array<[Row, Record<string, unknown>, { has_phone: boolean; has_email: boolean; phone_on_file: boolean }]> = [
      [{}, {}, { has_phone: true, has_email: true, phone_on_file: true }],
      [{ phone: null, email: null }, {}, { has_phone: false, has_email: false, phone_on_file: false }],
      // A placeholder address nothing is sent to, and a number that isn't whole (texts still try it).
      [{ phone: "555-0101", email: `sub-${APEX}@subs.crewtavo.invalid` }, {}, { has_phone: false, has_email: false, phone_on_file: true }],
      // A UK number gets codes only once the company adds the UK.
      [{ phone: "+44 20 7946 0958" }, {}, { has_phone: false, has_email: true, phone_on_file: true }],
      [{ phone: "+44 20 7946 0958" }, { subs: { sign_in_countries: ["44"] } }, { has_phone: true, has_email: true, phone_on_file: true }],
    ];
    for (const [record, settings, ways] of cases) {
      const world = withAl();
      world.tables.subcontractors = [{ ...apex(), ...record }];
      world.tables.companies![0]!.settings = settings;
      serve(world);
      const me = await (await as(AL, "/me")).json();
      expect(me.memberships[0].subcontractor, JSON.stringify(record)).toEqual({ id: APEX, name: "Apex Roofing LLC", can_contact_clients: false, uses_clock: false, own_sign_in: true, ...ways });
      expect(JSON.stringify(me.memberships[0])).not.toMatch(/al@apex|5550101|7946/);
    }
    // Someone's own account they sign in to as a sub: codes and the office's record aren't for it.
    const own = withAl();
    own.accounts[AL]!.app_metadata = { provider: "email" };
    serve(own);
    const me = await (await app.request("/api/me", { headers: { Authorization: `Bearer ${tokenFor(AL)}` } }, env)).json();
    expect(me.memberships[0].subcontractor).toMatchObject({ own_sign_in: false, has_phone: false, has_email: false, phone_on_file: false });
  });

  it("doesn't keep someone with their own account, whom an office gave sub access, from setting up a business", async () => {
    const world = withAl();
    // Al's own account: no mark, though his only membership is Oscar's sub access.
    world.accounts[AL]!.app_metadata = { provider: "email" };
    const { calls } = serve(world);
    const res = await app.request("/api/me", { headers: { Authorization: `Bearer ${tokenFor(AL)}` } }, env);
    expect((await res.json()).can_create_company).toBe(true);
    const made = await app.request("/api/companies", { method: "POST", headers: { Authorization: `Bearer ${tokenFor(AL)}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Al's Roofing", trade_preset: "general", timezone: "America/New_York", terms_version: TERMS_VERSION }) }, env);
    expect(made.status).not.toBe(403);
    expect(calls.some((c) => c.path === "rpc/create_company")).toBe(true);
  });

  it("isn't on the team list, and can't be invited to the team or given a reset link", async () => {
    serve(withAl());
    const team = await (await as(OFFICE, "/team")).json();
    expect(team.map((m: { user_id: string }) => m.user_id).sort()).toEqual([OFFICE, CREW].sort());
    const world = withAl();
    world.tables.memberships![0]!.role = "admin";
    serve(world);
    const invite = await as(OFFICE, "/team/invite", { method: "POST", body: { email: "new@apex.test", role: "subcontractor" } });
    expect(invite.status).toBe(400);
    expect((await invite.json()).error).toMatch(/Give them a sign-in from their page under Subs/);
    expect((await as(OFFICE, "/team/invite", { method: "POST", body: { email: "sub-x@subs.invalid", role: "field_crew" } })).status).toBe(400);
    expect((await as(OFFICE, `/team/${AL}/invite-link`, { method: "POST" })).status).toBe(400);
    expect((await as(OFFICE, `/team/${AL}/password-link`, { method: "POST" })).status).toBe(400);
  });

  it("joins the team only once their sub sign-in is removed, which then gives way to the team's", async () => {
    const world = withAl();
    world.tables.memberships![0]!.role = "admin";
    const { calls } = serve(world);
    const res = await as(OFFICE, "/team/invite", { method: "POST", body: { email: "al@apex.test", role: "field_crew" } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("They sign in as your sub. Remove their sign-in on their page under Subs first.");
    expect(world.tables.memberships!.filter((m) => m.user_id === AL)).toEqual([expect.objectContaining({ role: "subcontractor", active: true })]);
    expect(calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link")).toBe(false);

    world.tables.memberships!.find((m) => m.user_id === AL)!.active = false;
    const joined = await as(OFFICE, "/team/invite", { method: "POST", body: { email: "al@apex.test", role: "field_crew" } });
    expect(joined.status).toBe(201);
    expect(world.tables.memberships!.filter((m) => m.user_id === AL)).toEqual([expect.objectContaining({ role: "field_crew", active: true })]);
    // The old sub sign-in went with the server's key; the team's was added as the admin, so the database checks the grant.
    expect(calls.find((c) => c.method === "DELETE" && c.path === "memberships")?.admin).toBe(true);
    expect(calls.filter((c) => c.method === "POST" && c.path === "memberships").map((c) => c.admin)).toEqual([false]);
  });
});

// ===== The office gives a sub a sign-in =========================================================

describe("a sub's sign-in", () => {
  it("is made on the sub's stand-in address, named after them, and texted from Crewtavo's number to the number on the office's record", async () => {
    const world = oscar();
    const { texts, calls } = serve(world);
    const res = await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "text" } }, texting);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      access: { state: "invited", user_id: NEW_USER, last_sign_in_at: null, shared: false },
      link: "https://ops.example.com/?token_hash=tok-1&type=magiclink",
      texted: true,
      emailed: false,
      sms_link: null,
      reason: null,
    });
    // Marked as Apex's sign-in, where only the server can set it: links go only to such an account. On
    // Apex's stand-in address: their real email stays on the office's record, where codes and notices go.
    expect(calls.find((c) => c.url.pathname === "/auth/v1/admin/users")?.body).toMatchObject({ email: `sub-${APEX}@subs.invalid`, email_confirm: true, user_metadata: { full_name: "Al Apex" }, app_metadata: { crewtavo_sub: `${CO}:${APEX}` } });
    expect(world.tables.memberships).toContainEqual(expect.objectContaining({ company_id: CO, user_id: NEW_USER, role: "subcontractor", subcontractor_id: APEX, active: true }));
    // Made with the server's key: from a browser the database refuses a sub's sign-in.
    expect(calls.find((c) => c.method === "POST" && c.path === "memberships")?.admin).toBe(true);
    // Named after them, but the office's phone for them isn't put on the profile the team can read.
    expect(world.tables.profiles).toContainEqual(expect.objectContaining({ user_id: NEW_USER, full_name: "Al Apex", phone: null }));
    expect(JSON.stringify(world.tables.profiles)).not.toMatch(/al@apex|5550101/);
    expect(texts()).toEqual([expect.objectContaining({ To: "+15405550101", Body: "Oscar Roofing: here's your link to sign in and see your jobs with us. It works once, within a day: https://ops.example.com/?token_hash=tok-1&type=magiclink" })]);
  });

  it("without texting set up, gives a link that opens Messages on the office's phone", async () => {
    const { texts } = serve(oscar());
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: {} })).json();
    expect(texts()).toEqual([]);
    expect(body.texted).toBe(false);
    expect(body.sms_link).toBe(`sms:+15405550101?&body=${encodeURIComponent("Oscar Roofing: here's your link to sign in and see your jobs with us. It works once, within a day: https://ops.example.com/?token_hash=tok-1&type=magiclink")}`);
    expect(body.link).toBe("https://ops.example.com/?token_hash=tok-1&type=magiclink");
  });

  it("emails it to the sub's own address", async () => {
    const { emails } = serve(oscar());
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "email" } })).json();
    expect(body).toMatchObject({ emailed: true, texted: false, reason: null });
    expect(emails()).toEqual([expect.objectContaining({ to: ["al@apex.test"], subject: "Your sign-in for Oscar Roofing" })]);
  });

  it("for a sub with no email, uses an address nothing ever emails", async () => {
    const world = oscar();
    world.tables.subcontractors = [{ ...apex(), email: null }];
    const { emails, calls } = serve(world);
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "email" } })).json();
    expect(calls.find((c) => c.url.pathname === "/auth/v1/admin/users")?.body.email).toBe(`sub-${APEX}@subs.invalid`);
    expect(calls.find((c) => c.url.pathname === "/auth/v1/admin/generate_link")?.body).toMatchObject({ type: "magiclink", email: `sub-${APEX}@subs.invalid` });
    expect(body).toMatchObject({ emailed: false, reason: "Add an email address for this sub first, or copy the link.", link: "https://ops.example.com/?token_hash=tok-1&type=magiclink" });
    expect(emails()).toEqual([]);
  });

  it("gives access to an account the sub's email already has, but no link into it, and leaves it as they have it", async () => {
    const world = oscar();
    // Someone who signed up themselves, and hasn't even signed in yet.
    world.accounts[AL] = { id: AL, email: "al@apex.test", last_sign_in_at: null, app_metadata: { provider: "email" } };
    world.tables.profiles!.push({ user_id: AL, email: "al@apex.test", full_name: "Albert Apex", phone: null });
    const { calls } = serve(world);
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "none" } })).json();
    expect(body).toMatchObject({ access: { state: "active", user_id: null, last_sign_in_at: null, shared: true }, link: null, sms_link: null });
    expect(body.reason).toMatch(/^They already have their own Crewtavo sign-in/);
    expect(calls.some((c) => c.url.pathname === "/auth/v1/admin/users" || c.url.pathname === "/auth/v1/admin/generate_link")).toBe(false);
    expect(world.tables.memberships).toContainEqual(expect.objectContaining({ user_id: AL, role: "subcontractor", subcontractor_id: APEX, active: true }));
    // Their profile is theirs: the office's name and phone for the sub don't go on it.
    expect(world.tables.profiles).toContainEqual({ user_id: AL, email: "al@apex.test", full_name: "Albert Apex", phone: null });
    expect(calls.some((c) => c.method === "PATCH" && c.path === "profiles")).toBe(false);
    // Nor does the office see when they sign in.
    world.accounts[AL]!.last_sign_in_at = "2026-10-24T13:00:00Z";
    expect(await (await as(OFFICE, `/subs/${APEX}/access`)).json()).toEqual({ state: "active", user_id: null, last_sign_in_at: null, shared: true });
    // Sending again (the sign-in is theirs now) still makes no link.
    const again = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "text" } }, texting)).json();
    expect(again).toMatchObject({ link: null, texted: false });
    expect(calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link" || c.url.host === "api.twilio.com")).toBe(false);
  });

  it("makes no link for an account someone already uses, even with no business of their own", async () => {
    const world = oscar();
    world.accounts[AL] = { id: AL, email: "al@apex.test", last_sign_in_at: "2026-09-01T12:00:00Z", app_metadata: { provider: "email" } };
    const { calls } = serve(world);
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "none" } })).json();
    expect(body).toMatchObject({ access: { shared: true, last_sign_in_at: null }, link: null });
    expect(calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link")).toBe(false);
  });

  it("makes no link for a sign-in that's also for another business, even one turned off there", async () => {
    const world = withAl();
    world.tables.memberships!.push({ company_id: OTHER_CO, user_id: AL, role: "field_crew", role_id: null, subcontractor_id: null, active: false });
    const { calls } = serve(world);
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "none" } })).json();
    expect(body).toMatchObject({ access: { shared: true }, link: null });
    expect(calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link")).toBe(false);
  });

  it("never takes over a sign-in another business made for its own sub: Apex gets one of its own", async () => {
    const world = oscar();
    // Al subs for Papa too, which made him a sign-in under the same email.
    world.accounts[AL] = { id: AL, email: "al@apex.test", last_sign_in_at: null, app_metadata: { crewtavo_sub: subLoginMark(OTHER_CO, "00000000-0000-4000-8000-0000000000b9") } };
    const { calls } = serve(world);
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "none" } })).json();
    expect(body).toMatchObject({ access: { state: "invited", user_id: NEW_USER, shared: false }, link: "https://ops.example.com/?token_hash=tok-1&type=magiclink" });
    expect(calls.find((c) => c.url.pathname === "/auth/v1/admin/users")?.body).toMatchObject({ email: `sub-${APEX}@subs.invalid`, app_metadata: { crewtavo_sub: `${CO}:${APEX}` } });
    // Papa's sign-in is left as it is: still nobody's but Papa's sub's, so its codes and links still work there.
    expect(world.tables.memberships!.some((m) => m.user_id === AL)).toBe(false);
    expect(world.accounts[AL]!.app_metadata).toEqual({ crewtavo_sub: subLoginMark(OTHER_CO, "00000000-0000-4000-8000-0000000000b9") });
  });

  it("gives a new link to the sign-in made here, after they've used it (a new phone, say)", async () => {
    const { calls } = serve(withAl("2026-10-20T12:00:00Z"));
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "none" } })).json();
    expect(body).toMatchObject({ access: { state: "active", user_id: AL, last_sign_in_at: "2026-10-20T12:00:00Z", shared: false }, link: "https://ops.example.com/?token_hash=tok-1&type=magiclink" });
    expect(calls.find((c) => c.url.pathname === "/auth/v1/admin/generate_link")?.body).toMatchObject({ type: "magiclink", email: "al@apex.test" });
  });

  it("gives another of the company's subs with the same email a sign-in of its own, not Apex's", async () => {
    const world = withAl();
    const birch = "00000000-0000-4000-8000-0000000000b2";
    world.tables.subcontractors!.push({ ...apex(), id: birch, name: "Birch Gutters" });
    const { calls } = serve(world);
    const res = await as(OFFICE, `/subs/${birch}/sign-in-link`, { method: "POST", body: {} });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.url.pathname === "/auth/v1/admin/users")?.body).toMatchObject({ email: `sub-${birch}@subs.invalid`, app_metadata: { crewtavo_sub: `${CO}:${birch}` } });
    expect(world.tables.memberships!.filter((m) => m.user_id === AL)).toEqual([expect.objectContaining({ subcontractor_id: APEX })]);
  });

  it("isn't for an email that's someone's own account, already one of the company's subs", async () => {
    const world = withAl();
    world.accounts[AL]!.app_metadata = { provider: "email" };
    const birch = "00000000-0000-4000-8000-0000000000b2";
    world.tables.subcontractors!.push({ ...apex(), id: birch, name: "Birch Gutters" });
    serve(world);
    const res = await as(OFFICE, `/subs/${birch}/sign-in-link`, { method: "POST", body: {} });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("That email already signs in for another of your subs. Each sub needs their own email, or none.");
  });

  it("asks for a phone number before texting", async () => {
    const world = oscar();
    world.tables.subcontractors = [{ ...apex(), phone: null }];
    const { texts } = serve(world);
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "text" } }, texting)).json();
    expect(body).toMatchObject({ texted: false, sms_link: null, reason: "Add a phone number for this sub first, or copy the link.", link: "https://ops.example.com/?token_hash=tok-1&type=magiclink" });
    expect(texts()).toEqual([]);
  });

  it("when the text doesn't go out, says why and offers the office's own Messages", async () => {
    const world = oscar();
    world.twilioDown = true;
    serve(world);
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "text" } }, texting)).json();
    expect(body.texted).toBe(false);
    expect(body.reason).toMatch(/^The text provider refused it \(400/);
    expect(body.sms_link).toMatch(/^sms:\+15405550101\?&body=/);
  });

  it("isn't for someone on the team", async () => {
    const world = oscar();
    world.tables.subcontractors = [{ ...apex(), email: "cy@oscar.test" }];
    serve(world);
    const res = await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: {} });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("That email belongs to someone on your team. A sub needs their own email, or none.");
    expect(world.tables.memberships!.filter((m) => m.role === "subcontractor")).toEqual([]);
  });

  it("gives no link for someone who uses Crewtavo with another business, who signs in their own way", async () => {
    const world = oscar();
    world.accounts[AL] = { id: AL, email: "al@apex.test", last_sign_in_at: "2026-10-01T12:00:00Z" };
    world.tables.memberships!.push({ company_id: OTHER_CO, user_id: AL, role: "owner", role_id: null, subcontractor_id: null, active: true });
    const { texts, calls } = serve(world);
    const body = await (await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: { send: "text" } }, texting)).json();
    expect(body).toMatchObject({ access: { state: "active", user_id: null, last_sign_in_at: null, shared: true }, link: null, texted: false, sms_link: null });
    expect(body.reason).toMatch(/They already have their own Crewtavo sign-in/);
    expect(calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link")).toBe(false);
    expect(texts()).toEqual([]);
  });

  it("says where it stands, and is taken away (signing out their phones) and given back", async () => {
    const world = withAl(null);
    const { calls } = serve(world);
    expect(await (await as(OFFICE, `/subs/${APEX}/access`)).json()).toEqual({ state: "invited", user_id: AL, last_sign_in_at: null, shared: false });
    world.accounts[AL]!.last_sign_in_at = "2026-10-24T13:00:00Z";
    expect(await (await as(OFFICE, "/subs/access")).json()).toEqual([{ subcontractor_id: APEX, state: "active", user_id: AL, last_sign_in_at: "2026-10-24T13:00:00Z", shared: false }]);
    expect(await (await as(OFFICE, `/subs/${APEX}/access`, { method: "DELETE" })).json()).toEqual({ state: "none", user_id: null, last_sign_in_at: null, shared: false });
    expect(world.tables.memberships!.find((m) => m.user_id === AL)?.active).toBe(false);
    // Every phone it was used on is signed out, so giving it back later doesn't bring one back.
    expect(calls.filter((c) => c.path === "rpc/end_sessions").map((c) => [c.body, c.admin])).toEqual([[{ p_user: AL }, true]]);
    // An inactive sign-in can't be used: requireCompany finds no membership for it.
    expect((await as(AL, "/schedule?from=2026-10-25&to=2026-10-25")).status).toBe(403);
    const back = await as(OFFICE, `/subs/${APEX}/access`, { method: "POST" });
    expect(back.status).toBe(201);
    expect(await back.json()).toMatchObject({ state: "active", user_id: AL });
    expect(world.tables.memberships!.filter((m) => m.user_id === AL)).toEqual([expect.objectContaining({ active: true, subcontractor_id: APEX })]);
  });

  it("goes with the sub when the office deletes them, signing their phones out, and a sub added again gets a new one", async () => {
    const world = withAl();
    const { calls } = serve(world);
    const res = await as(OFFICE, `/subs/${APEX}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, signed_out: true });
    // Deleted as the office person asking (row-level security and the database's rules decide).
    expect(calls.find((c) => c.method === "DELETE" && c.path === "subcontractors")).toMatchObject({ admin: false });
    expect(calls.filter((c) => c.path === "rpc/end_sessions").map((c) => c.body)).toEqual([{ p_user: AL }]);
    // The membership went with the sub (the database cascades it); added again with the same email,
    // the sub gets a new sign-in on its own stand-in address, and a link for it.
    world.tables.memberships = world.tables.memberships!.filter((m) => m.user_id !== AL);
    const again = "00000000-0000-4000-8000-0000000000b3";
    world.tables.subcontractors = [{ ...apex(), id: again }];
    const body = await (await as(OFFICE, `/subs/${again}/sign-in-link`, { method: "POST", body: { send: "none" } })).json();
    expect(body).toMatchObject({ access: { shared: false, user_id: NEW_USER }, link: expect.stringContaining("token_hash=") });
    expect(calls.find((c) => c.url.pathname === "/auth/v1/admin/users")?.body).toMatchObject({ email: `sub-${again}@subs.invalid`, app_metadata: { crewtavo_sub: `${CO}:${again}` } });
  });

  it("deleting a sub doesn't sign someone out of their own account, and is for the office", async () => {
    const world = withAl();
    world.accounts[AL]!.app_metadata = { provider: "email" };
    const { calls } = serve(world);
    expect((await as(CREW, `/subs/${APEX}`, { method: "DELETE" })).status).toBe(403);
    expect(await (await as(OFFICE, `/subs/${APEX}`, { method: "DELETE" })).json()).toEqual({ deleted: true, signed_out: false });
    expect(calls.some((c) => c.path === "rpc/end_sessions")).toBe(false);
  });

  it("doesn't sign someone out of their own account when the office takes its access away", async () => {
    const world = withAl();
    world.accounts[AL]!.app_metadata = { provider: "email" };
    const { calls } = serve(world);
    expect((await as(OFFICE, `/subs/${APEX}/access`, { method: "DELETE" })).status).toBe(200);
    expect(world.tables.memberships!.find((m) => m.user_id === AL)?.active).toBe(false);
    expect(calls.some((c) => c.path === "rpc/end_sessions")).toBe(false);
  });

  it("isn't given to a sub the office turned off, and a turned-off sub's sign-in shows as off", async () => {
    const world = oscar();
    world.tables.subcontractors = [{ ...apex(), active: false }];
    serve(world);
    const res = await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This sub is turned off. Turn them back on to give them a sign-in.");
    const off = withAl();
    off.tables.subcontractors = [{ ...apex(), active: false }];
    serve(off);
    expect(await (await as(OFFICE, `/subs/${APEX}/access`)).json()).toEqual({ state: "none", user_id: null, last_sign_in_at: null, shared: false });
    expect(await (await as(OFFICE, "/subs/access")).json()).toEqual([{ subcontractor_id: APEX, state: "none", user_id: null, last_sign_in_at: null, shared: false }]);
  });

  it("limits how many links one person sends", async () => {
    const world = withAl();
    world.full = /^sub-sign-in-link:/;
    const { calls } = serve(world);
    const res = await as(OFFICE, `/subs/${APEX}/sign-in-link`, { method: "POST", body: {} });
    expect(res.status).toBe(429);
    expect(calls.filter((c) => c.path === "rpc/rate_limit_hit").map((c) => [c.body.p_key, c.body.p_max, c.body.p_window_seconds])).toEqual([[`sub-sign-in-link:${OFFICE}`, 20, 3600]]);
    expect(calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link")).toBe(false);
  });

  it("is for the office with the subs area; the crew can't, and only schedulers list subs to put on a visit", async () => {
    serve(withAl());
    expect((await as(CREW, `/subs/${APEX}/sign-in-link`, { method: "POST", body: {} })).status).toBe(403);
    expect((await as(CREW, `/subs/${APEX}/access`)).status).toBe(403);
    expect((await as(CREW, "/subs/logins")).status).toBe(403);
    expect(await (await as(OFFICE, "/subs/logins")).json()).toEqual([{ user_id: AL, subcontractor_id: APEX, name: "Apex Roofing LLC", contact_name: "Al Apex", trade: undefined, active: true }]);
  });

  it("tells the office when another of its subs' sign-ins has the same email, so codes by email go to neither", async () => {
    const world = withAl();
    world.tables.subcontractors![0]!.email = " Al@Apex.test ";
    const other = "00000000-0000-4000-8000-0000000000b2";
    const elsewhere = { user_id: NEW_USER, company_id: "00000000-0000-4000-8000-0000000000a9", subcontractor_id: "00000000-0000-4000-8000-0000000000b9", company_name: "Papa Paving" };
    const mine = { user_id: AL, company_id: CO, subcontractor_id: APEX, company_name: "Oscar Roofing" };
    const { calls } = serve(world);
    const shared = async () => (await (await as(OFFICE, `/subs/${APEX}/code-email`)).json()).shared;
    // Only Apex's own sign-in: no.
    world.emailSignIns = [mine];
    expect(await shared()).toBe(false);
    expect(calls.filter((c) => c.path === "rpc/sub_sign_ins_for_email").map((c) => [c.body, c.admin])).toEqual([[{ p_email: "al@apex.test" }, true]]);
    // Another of Oscar's subs' sign-ins: yes, with or without Apex's own.
    world.emailSignIns = [mine, { ...mine, user_id: CREW, subcontractor_id: other }];
    expect(await shared()).toBe(true);
    world.emailSignIns = [{ ...mine, user_id: CREW, subcontractor_id: other }];
    expect(await shared()).toBe(true);
    // A sub's sign-in at another business isn't Oscar's to learn about.
    world.emailSignIns = [mine, elsewhere];
    expect(await shared()).toBe(false);
    // No address on file, or a placeholder: nothing to look up.
    for (const email of [null, `sub-${APEX}@subs.crewtavo.invalid`]) {
      world.tables.subcontractors![0]!.email = email;
      const asked = calls.length;
      expect(await shared()).toBe(false);
      expect(calls.slice(asked).some((c) => c.path === "rpc/sub_sign_ins_for_email")).toBe(false);
    }
    // The office with the subs area only.
    expect((await as(CREW, `/subs/${APEX}/code-email`)).status).toBe(403);
    expect((await as(AL, `/subs/${APEX}/code-email`)).status).toBe(403);
  });

  it("still names a sub on the schedule once they can't sign in, so the office can take them off visits", async () => {
    const removed = withAl();
    removed.tables.memberships!.find((m) => m.user_id === AL)!.active = false;
    serve(removed);
    expect(await (await as(OFFICE, "/subs/logins")).json()).toEqual([expect.objectContaining({ user_id: AL, name: "Apex Roofing LLC", active: false })]);
    const off = withAl();
    off.tables.subcontractors = [{ ...apex(), active: false }];
    serve(off);
    expect(await (await as(OFFICE, "/subs/logins")).json()).toEqual([expect.objectContaining({ user_id: AL, active: false })]);
  });

  it("is named with their business on Timesheets and reports (GET /team?with_subs=1), without their phone or email", async () => {
    serve(withAl());
    const plain = await (await as(OFFICE, "/team")).json();
    expect(plain.map((m: { user_id: string }) => m.user_id)).not.toContain(AL);
    const all = await (await as(OFFICE, "/team?with_subs=1")).json();
    expect(all.find((m: { user_id: string }) => m.user_id === AL)).toMatchObject({
      user_id: AL, role: "subcontractor", role_id: null, active: true, labor_rate: null,
      profile: { user_id: AL, email: null, full_name: "Al Apex", phone: null },
      sub: { id: APEX, name: "Apex Roofing LLC" },
    });
    expect(all.find((m: { user_id: string }) => m.user_id === CREW).sub).toBeUndefined();
  });
});

// ===== Automations ================================================================================

describe("automations", () => {
  it("never notify a sub, even one on the visit, whoever the rule names", async () => {
    const { performAction } = await import("../src/services/automations");
    const { adminClient } = await import("../src/lib/supabase");
    const world = withAl();
    world.tables.visit_assignees = [{ visit_id: VISIT, user_id: AL }, { visit_id: VISIT, user_id: CREW }];
    const { calls } = serve(world);
    const ctx = { subject: "visit", id: VISIT, label: "Tear off", company: { id: CO, name: "Oscar Roofing" }, client: null, facts: {}, vars: {}, appPath: `/visits/${VISIT}`, jobId: null, propertyId: null };
    const all = ["owner", "admin", "office", "estimator", "crew_lead", "field_crew", "assigned"];
    for (const roles of [["assigned"], ["field_crew"], all]) {
      world.tables.notifications = [];
      await performAction(env, adminClient(env), ctx as never, { type: "notify", roles } as never, "Visit started", null).catch(() => undefined);
      expect(world.tables.notifications.map((n) => n.user_id), roles.join()).not.toContain(AL);
    }
    expect(world.tables.notifications.map((n) => n.user_id).sort()).toEqual([OFFICE, CREW].sort());
    await expect(performAction(env, adminClient(env), ctx as never, { type: "notify", user_ids: [AL] } as never, "Just Al", null)).rejects.toThrow(/No one on the team/);
    expect(calls.filter((c) => c.path === "memberships" && c.url.searchParams.has("active")).every((c) => c.url.searchParams.get("role") === "neq.subcontractor")).toBe(true);
  });
});

// ===== Notices reach the sub at the office's record ==============================================

describe("a sub's notices", () => {
  const notice = (extra: Row = {}) => ({ id: "n1", company_id: CO, user_id: AL, kind: "jobs", title: "Smith roof, Tue Nov 3, 24 squares, $2,040.", body: "New job offer.", link: "/field/jobs/p1", read_at: null, ...extra });
  /** Al's sign-in on Apex's stand-in address, with nothing of the office's on his profile. */
  const world = (record: Row = {}, contacts: Row[] | null = null) => {
    const w = withAl();
    w.tables.profiles = w.tables.profiles!.map((p) => (p.user_id === AL ? { ...p, email: `sub-${APEX}@subs.invalid`, phone: null } : p));
    w.tables.subcontractors = [{ ...apex(), ...record }];
    w.tables.notification_prefs = [{ company_id: CO, user_id: AL, email: ["jobs"], sms: ["jobs"], push: [] }];
    w.tables.push_subscriptions = [];
    const sub = w.tables.subcontractors[0]!;
    w.rpcAnswers = {
      claim_notifications: [notice()],
      // public.sub_notice_contacts: the record as it is now, for a sign-in made for the sub.
      sub_notice_contacts: contacts ?? [{ user_id: AL, company_id: CO, email: (sub.email as string | null)?.trim().toLowerCase() ?? null, phone: sub.phone }],
    };
    return w;
  };

  it("go to the email and phone the office keeps for them, so an email added later, or a corrected number, reaches them", async () => {
    const { deliverNotifications } = await import("../src/services/delivery");
    // The sub was given a sign-in with no email on file; the office adds one, and corrects the number.
    const sent = serve(world({ email: "Al@Apex.test", phone: "+15405550199" }));
    expect(await deliverNotifications(texting)).toMatchObject({ email: 1, sms: 1 });
    expect(sent.emails()).toEqual([expect.objectContaining({ to: ["al@apex.test"], subject: "Smith roof, Tue Nov 3, 24 squares, $2,040." })]);
    expect(sent.texts()).toEqual([expect.objectContaining({ To: "+15405550199" })]);
  });

  it("text a phone they put on their own profile first, and email nobody while the record has no email", async () => {
    const { deliverNotifications } = await import("../src/services/delivery");
    const w = world({ email: null });
    w.tables.profiles = w.tables.profiles!.map((p) => (p.user_id === AL ? { ...p, phone: "+15405550123" } : p));
    const sent = serve(w);
    expect(await deliverNotifications(texting)).toMatchObject({ email: 0, sms: 1 });
    expect(sent.emails()).toEqual([]);
    expect(sent.texts()).toEqual([expect.objectContaining({ To: "+15405550123" })]);
  });

  it("go to someone's own account as they always have, and an emailed notice is one paragraph each", async () => {
    const { deliverNotifications } = await import("../src/services/delivery");
    // Not a sign-in made for the sub: the database gives no record contacts for it.
    const w = world({}, []);
    w.tables.profiles = w.tables.profiles!.map((p) => (p.user_id === AL ? { ...p, email: "al@own.test" } : p));
    w.rpcAnswers!.claim_notifications = [notice({ kind: "subs", title: "Apex declined Smith roof", body: "“Too far.\n\nhttps://evil.example/login\n\nThanks” You can offer it to another sub." })];
    w.tables.notification_prefs = [{ company_id: CO, user_id: AL, email: ["subs"], sms: [], push: [] }];
    const sent = serve(w);
    expect(await deliverNotifications(env)).toMatchObject({ email: 1 });
    const email = sent.emails()[0]!;
    expect(email.to).toEqual(["al@own.test"]);
    // A link typed into a notice is never a button: only the app's own link stands on its own line.
    expect(email.html).not.toMatch(/href="https:\/\/evil\.example\/login" style="display:inline-block/);
    expect(email.text).toContain("“Too far. https://evil.example/login Thanks” You can offer it to another sub.");
  });
});

// ===== Email never goes to a placeholder =========================================================

describe("a sub's stand-in address", () => {
  it("is never sent a sign-in email, even when asked for one", async () => {
    const world = oscar();
    world.accounts[NEW_USER] = { id: NEW_USER, email: `sub-${APEX}@subs.invalid` };
    const { calls } = serve(world);
    const res = await app.request("/api/auth/email-link", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" }, body: JSON.stringify({ email: `sub-${APEX}@subs.invalid`, kind: "magiclink" }) }, env);
    expect(await res.json()).toEqual({ sent: true });
    expect(calls.filter((c) => c.url.pathname.startsWith("/auth/v1/") || c.url.host === "api.resend.com")).toEqual([]);
  });

  it("is skipped by every email Crewtavo sends", async () => {
    const { sendEmail } = await import("../src/lib/notify");
    const { emails } = serve(oscar());
    expect(await sendEmail(env, { to: `sub-${APEX}@subs.invalid`, subject: "Hi", text: "Hi" })).toEqual({ sent: false, reason: "They have no email address. Text them instead." });
    expect(emails()).toEqual([]);
  });
});

// ===== AI assistants =============================================================================

describe("AI assistants", () => {
  const rpc = (bearer: string, method: string, params?: object) =>
    app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, env);

  it("refuse a sub's sign-in", async () => {
    const { calls } = serve(withAl());
    const result = (await (await rpc(tokenFor(AL, { client_id: "claude" }), "tools/call", { name: "list_services", arguments: {} })).json()).result;
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: NO_ASSISTANTS_FOR_SUBS }] });
    expect(calls.some((c) => c.path === "services")).toBe(false);
  });

  it("still work for someone on the team who is also a sub elsewhere, at their own company only", async () => {
    const world = withAl();
    world.tables.memberships!.push({ company_id: OTHER_CO, user_id: AL, role: "owner", role_id: null, subcontractor_id: null, active: true });
    world.tables.companies!.push({ id: OTHER_CO, name: "Al's Gutters", settings: { assistants: { enabled: true } } });
    serve(world);
    const own = (await (await rpc(tokenFor(AL, { client_id: "claude" }), "tools/call", { name: "list_services", arguments: { company_id: OTHER_CO } })).json()).result;
    expect(own.isError).toBeUndefined();
    const theirs = (await (await rpc(tokenFor(AL, { client_id: "claude" }), "tools/call", { name: "list_services", arguments: { company_id: CO } })).json()).result;
    expect(theirs).toMatchObject({ isError: true, content: [{ text: NO_ASSISTANTS_FOR_SUBS }] });
  });
});

describe("connecting an AI assistant", () => {
  const consent = (who: string, action: string) =>
    new Request("https://ops.example.com/auth/v1/oauth/authorizations/auth-1/consent", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenFor(who)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  const passed: string[] = [];
  const send = async (request: Request) => (passed.push(await request.text()), Response.json({ redirect_url: "https://claude.ai/callback" }));

  it("is refused for someone whose only sign-ins are a sub's", async () => {
    // Row-level security shows the person their own memberships; here, a sub's sign-in alone.
    serve({ tables: { memberships: [{ company_id: CO, user_id: AL, role: "subcontractor", active: true }] }, accounts: {} });
    passed.length = 0;
    const res = await guardConsent(env, consent(AL, "approve"), "/auth/v1", send);
    expect(res.status).toBe(403);
    expect((await res.json()).msg).toBe(NO_ASSISTANTS_FOR_SUBS);
    expect(passed).toEqual([]);
    // Saying no, or anything else Auth is asked, goes through.
    expect((await guardConsent(env, consent(AL, "deny"), "/auth/v1", send)).status).toBe(200);
    expect(passed).toEqual([JSON.stringify({ action: "deny" })]);
  });

  it("goes through for someone on a team", async () => {
    serve({ tables: { memberships: [{ company_id: CO, user_id: OFFICE, role: "office", active: true }, { company_id: OTHER_CO, user_id: OFFICE, role: "subcontractor", active: true }] }, accounts: {} });
    passed.length = 0;
    expect((await guardConsent(env, consent(OFFICE, "approve"), "/auth/v1", send)).status).toBe(200);
    expect(passed).toEqual([JSON.stringify({ action: "approve" })]);
  });
});
