/**
 * Google reviews (integrations/googleBusiness.ts, services/googleReviews.ts, routes/googleReviews.ts
 * and the Google Business Profile parts of routes/apps.ts): signing in and picking the location,
 * Google's review link, disconnecting (and not signing Google Calendar out with it), syncing (what's
 * asked, stopping early, the first full pass in pieces, telling the office, deletions confirmed one
 * by one, one worker at a time), the problems told apart (Google's approval, the APIs not turned on,
 * a sign-in to reconnect, a lost location, Google busy or down), replies, Suggest a reply, Sync now,
 * matching by hand, and how review notifications go out. PostgREST is a stand-in kept in memory, with
 * the database's functions acted out as simply as they're needed (what they really do is in
 * supabase/tests/google_reviews_test.sql). Google answers over a stubbed fetch, and Claude is mocked:
 * nothing reaches Google or Anthropic.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { APPROVAL_MESSAGE, NAME_FOLDS, REVIEW_STOP_NOTE, SIGNIN_MESSAGE } from "@crewtavo/core/reviews";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";

vi.mock("../src/services/ai", async (original) => {
  const real = await original<typeof import("../src/services/ai")>();
  return { ...real, complete: vi.fn(real.complete) };
});
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendEmail: vi.fn(async () => ({ sent: true, id: "email-1" })),
}));
vi.mock("../src/lib/webpush", async (original) => ({
  ...(await original<typeof import("../src/lib/webpush")>()),
  sendPush: vi.fn(async () => ({ ok: true, gone: false, status: 201 })),
}));

const ai = await import("../src/services/ai");
const notify = await import("../src/lib/notify");
const webpush = await import("../src/lib/webpush");
const { app } = await import("../src/app");
const { adminClient } = await import("../src/lib/supabase");
const { syncCompany, liftReviewStop, replyPhone } = await import("../src/services/googleReviews");
const { googleProblem, PROJECT_SUSPENDED } = await import("../src/integrations/googleBusiness");
const { deliverNotifications } = await import("../src/services/delivery");
const { signToken } = await import("../src/lib/crypto");
const complete = vi.mocked(ai.complete);
const sendEmail = vi.mocked(notify.sendEmail);
const sendPush = vi.mocked(webpush.sendPush);

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  GOOGLE_CLIENT_ID: "123456789012-crewtavo.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-secret",
};
const CO = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const USER = "00000000-0000-4000-8000-0000000000e1";
const BOB = "00000000-0000-4000-8000-0000000000b1";
const LOCATION = "locations/9";
const PARENT = "accounts/1/locations/9";

type Row = Record<string, any>;
interface Call {
  method: string;
  host: string;
  path: string;
  params: URLSearchParams;
  body: any;
}
interface World {
  tables: Record<string, Row[]>;
  rpc: Record<string, (body: any, world: World) => unknown>;
  google: (call: Call) => unknown;
  calls: Call[];
  pending: number;
}

// ---------------------------------------------------------------------------------------------
// PostgREST in memory, and Google
// ---------------------------------------------------------------------------------------------

const KEYS: Record<string, string[]> = { integrations: ["company_id", "provider"], integration_secrets: ["company_id", "provider"], review_syncs: ["company_id"] };
const NOT_FILTERS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function matches(row: Row, params: URLSearchParams) {
  for (const [column, filter] of params) {
    if (NOT_FILTERS.has(column) || column.includes("->") || column.includes(".")) continue;
    const value = row[column];
    if (filter.startsWith("eq.") && String(value) !== filter.slice(3)) return false;
    if (filter.startsWith("neq.") && String(value) === filter.slice(4)) return false;
    if (filter === "is.null" && value != null) return false;
    if (filter === "not.is.null" && value == null) return false;
    if (filter.startsWith("in.(") && !filter.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(value))) return false;
    if (filter.startsWith("lt.") && !(value != null && String(value) < filter.slice(3))) return false;
  }
  return true;
}

const now = () => new Date().toISOString();

/** The database's functions, as simply as the API needs them to act. */
function functions(): World["rpc"] {
  const syncOf = (w: World, company: string) => w.tables.review_syncs!.find((s) => s.company_id === company);
  const stopped = () => Response.json({ code: "55000", message: "This sync was stopped" }, { status: 400 });
  // The clients of reviews just removed or marked that no live review stops anymore (private.unreviewed).
  const lifted = (w: World, gone: Row[]) => [...new Set(gone.filter((r) => r.client_id && !r.deleted_at).map((r) => r.client_id as string))]
    .filter((client) => !w.tables.reviews!.some((r) => r.client_id === client && !r.deleted_at && !gone.includes(r)));
  return {
    rate_limit_hit: (b, w) => {
      const hits = (w.tables.limits ??= []);
      hits.push({ key: b.p_key });
      return hits.filter((h) => h.key === b.p_key).length <= b.p_max;
    },
    claim_review_sync: (b, w) => {
      let s = syncOf(w, b.p_company);
      if (!s) w.tables.review_syncs!.push((s = { company_id: b.p_company, full_seen: 0, failures: 0 }));
      if (s.locked_until && s.locked_until > now()) return null;
      s.claim = crypto.randomUUID();
      s.locked_until = new Date(Date.now() + b.p_hold_seconds * 1000).toISOString();
      return s.claim;
    },
    set_review_location: (b, w) => {
      let s = syncOf(w, b.p_company);
      if (!s) w.tables.review_syncs!.push((s = { company_id: b.p_company, full_seen: 0, failures: 0 }));
      const moved = s.location_id !== b.p_location_id;
      const gone = w.tables.reviews!.filter((r) => r.company_id === b.p_company && r.location_id !== b.p_location_id);
      const lift = lifted(w, gone);
      w.tables.reviews = w.tables.reviews!.filter((r) => !gone.includes(r));
      Object.assign(s, { account: b.p_account, location_id: b.p_location_id, claim: null, locked_until: null, next_sync_at: now(), problem: null, problem_detail: null, failures: 0, access_notice: null },
        moved ? { full_started_at: null, full_page_token: null, full_seen: 0, first_synced_at: null, full_synced_at: null } : {});
      return { removed: gone.length, lifted_clients: lift };
    },
    end_review_sync: (b, w) => {
      if (!b.p_remove) {
        Object.assign(syncOf(w, b.p_company) ?? {}, { claim: null, locked_until: null, next_sync_at: null, problem: null, problem_detail: null, access_notice: null });
        return { removed: 0, lifted_clients: [] };
      }
      const gone = w.tables.reviews!.filter((r) => r.company_id === b.p_company);
      const lift = lifted(w, gone);
      w.tables.reviews = w.tables.reviews!.filter((r) => !gone.includes(r));
      w.tables.review_syncs = w.tables.review_syncs!.filter((s) => s.company_id !== b.p_company);
      return { removed: gone.length, lifted_clients: lift };
    },
    record_reviews: (b, w) => {
      const s = syncOf(w, b.p_company);
      if (!s || s.claim !== b.p_claim || s.location_id !== b.p_location_id) return stopped();
      return (b.p_reviews as Row[]).map((item) => {
        const old = w.tables.reviews!.find((r) => r.company_id === b.p_company && r.location_id === b.p_location_id && r.review_id === item.review_id);
        if (!old) {
          const fresh = s.first_synced_at && Date.parse(item.posted_at) > Date.now() - 14 * 86_400_000;
          w.tables.reviews!.push({ id: crypto.randomUUID(), company_id: b.p_company, location_id: b.p_location_id, ...item, notify: fresh ? "new" : null, notified_at: null, seen_at: now(), deleted_at: null });
          return "new";
        }
        // A reply written here since the page was fetched (or a minute before) is kept.
        const written = old.reply_written_at && Date.parse(old.reply_written_at) > Date.parse(b.p_fetched_at ?? now()) - 60_000;
        const incoming = written ? { ...item, reply_comment: old.reply_comment ?? null, reply_updated_at: old.reply_updated_at ?? null } : item;
        const same = !old.deleted_at && ["rating", "comment", "reply_comment", "reply_updated_at", "google_updated_at"].every((k) => (old[k] ?? null) === (incoming[k] ?? null));
        Object.assign(old, same ? {} : { ...incoming, deleted_at: null, replied_by: incoming.reply_comment === old.reply_comment ? old.replied_by : null }, { seen_at: now() });
        return same ? "same" : "changed";
      });
    },
    mark_deleted_reviews: (b, w) => {
      const marked = w.tables.reviews!.filter((r) => (b.p_ids as string[]).includes(r.id) && !r.deleted_at);
      const lift = lifted(w, marked);
      for (const r of marked) r.deleted_at = now();
      return { marked: marked.length, lifted_clients: lift };
    },
    claim_review_notices: (b, w) => {
      const s = syncOf(w, b.p_company);
      if (!s || s.claim !== b.p_claim) return 0;
      const told = w.tables.reviews!.filter((r) => r.company_id === b.p_company && r.notify && !r.notified_at && !r.deleted_at);
      for (const r of told) {
        r.notified_at = now();
        w.tables.notifications!.push({ id: crypto.randomUUID(), company_id: b.p_company, user_id: USER, kind: r.rating <= 2 ? "review_low" : "review", title: `${r.reviewer_name} left a ${r.rating}-star review`, body: r.comment, link: `/marketing?tab=reviews&review=${r.id}`, read_at: null });
      }
      return told.length;
    },
    note_review_access: (b, w) => {
      (w.tables.access ??= []).push(b);
      const s = syncOf(w, b.p_company);
      if (b.p_kind === "in" && s && !s.first_synced_at) s.first_synced_at = now();
      if (b.p_kind !== "in" && b.p_kind !== "ok" && s) {
        if (s.access_notice === b.p_kind) return false;
        s.access_notice = b.p_kind;
      }
      return true;
    },
    set_review_client: (b, w) => {
      const review = w.tables.reviews!.find((r) => r.id === b.p_review && r.company_id === b.p_company);
      if (!review) return Response.json({ code: "P0002", message: "That review isn't here" }, { status: 404 });
      const before = review.client_id;
      review.client_id = b.p_client;
      return { client_id: b.p_client, lifted_client: before && before !== b.p_client ? before : null };
    },
  };
}

/** Stubs fetch with PostgREST in memory and Google's answers (`google`, which returns a Response or JSON). */
function serve(over: Partial<World> = {}): World {
  const world: World = {
    tables: { memberships: [{ company_id: CO, user_id: USER, role: "owner", role_id: null, subcontractor_id: null, active: true }], company_roles: [], reviews: [], review_syncs: [], notifications: [], ...over.tables },
    rpc: { ...functions(), ...over.rpc },
    google: over.google ?? (() => undefined),
    calls: [],
    pending: 0,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    world.pending++;
    try {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const text = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
      let body: any;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = Object.fromEntries(new URLSearchParams(text));
      }
      const call: Call = { method, host: url.host, path: url.pathname, params: url.searchParams, body };
      world.calls.push(call);
      if (url.host !== "example.supabase.co") {
        const out = world.google(call);
        if (out === undefined) throw new Error(`Nothing answers ${method} ${url}`);
        return out instanceof Response ? out : Response.json(out);
      }
      if (url.pathname === "/auth/v1/user") return Response.json({ id: USER, aud: "authenticated", role: "authenticated" });
      const path = url.pathname.replace(/^\/rest\/v1\//, "");
      if (path.startsWith("rpc/")) {
        const fn = world.rpc[path.slice(4)];
        const out = fn ? fn(body, world) : null;
        return out instanceof Response ? out : Response.json(out ?? null);
      }
      const rows = (world.tables[path] ??= []);
      const single = headers.get("accept")?.includes("vnd.pgrst.object");
      const reply = (data: Row[]) => (single ? (data[0] ? Response.json(data[0]) : Response.json({ message: "No rows" }, { status: 406 })) : Response.json(data));
      const found = () => rows.filter((r) => matches(r, url.searchParams));
      if (method === "HEAD") return new Response(null, { headers: { "content-range": `*/${found().length}` } });
      if (method === "GET") return reply(found());
      if (method === "PATCH") {
        const hit = found();
        for (const r of hit) Object.assign(r, body);
        return reply(hit);
      }
      if (method === "DELETE") {
        const hit = found();
        world.tables[path] = rows.filter((r) => !hit.includes(r));
        return reply(hit);
      }
      const keys = KEYS[path];
      const out: Row[] = [];
      for (const item of Array.isArray(body) ? body : [body]) {
        const existing = keys ? rows.find((r) => keys.every((k) => r[k] === item[k])) : undefined;
        if (existing) {
          if (!headers.get("prefer")?.includes("ignore-duplicates")) Object.assign(existing, item);
          out.push(existing);
        } else {
          const row = { id: crypto.randomUUID(), ...item };
          rows.push(row);
          out.push(row);
        }
      }
      return reply(out);
    } finally {
      world.pending--;
    }
  });
  return world;
}

/** Waits for work the routes leave running after they answer (runInBackground). */
async function settle(world: World) {
  for (let quiet = 0; quiet < 3; ) {
    await new Promise((r) => setTimeout(r, 5));
    quiet = world.pending ? 0 : quiet + 1;
  }
}

const google = (call: Call, host: string, path: string, method = "GET") => call.host === host && call.path === path && call.method === method;
const zeroQuota = () =>
  Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com'.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "0" } }] } }, { status: 429 });
const denied = (reason = "PERMISSION_DENIED", message = "The caller does not have permission") =>
  Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] } }, { status: 403 });

const location = (id: string, title: string, over: Row = {}) => ({
  name: `locations/${id}`, title, storefrontAddress: { addressLines: ["12 Main St"], locality: "Radford", administrativeArea: "VA", postalCode: "24141" },
  metadata: { placeId: `place-${id}`, newReviewUri: `https://search.google.com/local/writereview?placeid=place-${id}`, mapsUri: `https://maps.google.com/?cid=${id}`, hasVoiceOfMerchant: true }, ...over,
});
/** Google's account list and its locations: `{ "accounts/1": [location, …] }`. */
const accountsOf = (accounts: Record<string, Row[]>) => (call: Call) => {
  if (google(call, "mybusinessaccountmanagement.googleapis.com", "/v1/accounts")) return { accounts: Object.keys(accounts).map((name) => ({ name, accountName: `Account ${name.slice(9)}` })) };
  const match = /^\/v1\/(accounts\/[^/]+)\/locations$/.exec(call.path);
  if (call.host === "mybusinessbusinessinformation.googleapis.com" && match) return { locations: accounts[match[1]!] ?? [] };
  return undefined;
};
const review = (id: string, over: Row = {}) => ({
  reviewId: id, name: `${PARENT}/reviews/${id}`, reviewer: { displayName: `Reviewer ${id}`, profilePhotoUrl: `https://lh3.googleusercontent.com/${id}`, isAnonymous: false },
  starRating: "FIVE", comment: `Great work (${id})`, createTime: "2026-10-01T12:00:00Z", updateTime: "2026-10-01T12:00:00Z", ...over,
});
const isReviews = (call: Call) => call.host === "mybusiness.googleapis.com" && call.path === `/v4/${PARENT}/reviews`;

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: USER, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
const request = (path: string, init: { method?: string; body?: unknown; company?: string } = {}) =>
  app.request(`/api${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "X-Company-Id": init.company ?? CO, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }, env);

const companyRow = (settings: Row = {}) => ({ id: CO, name: "Radford Lawn Care", phone: "540-555-0100", email: "office@radford.example", timezone: "America/New_York", settings: { marketing: { enabled: true }, ...settings } });
const secretRow = async (company = CO, secret: Row = { access_token: "gbp-token", refresh_token: "gbp-refresh", expires_at: Date.now() + 3_600_000 }) =>
  ({ company_id: company, provider: "google_business", ciphertext: await encryptJson(env, secret) });
/** A company connected to its location, as after picking it. */
async function connected(over: { sync?: Row; settings?: Row; company?: Row; tables?: Record<string, Row[]> } = {}) {
  return {
    companies: [companyRow(over.company)],
    integrations: [{ company_id: CO, provider: "google_business", status: "connected", account_label: "Radford Lawn Care", last_error: null, settings: { account: "accounts/1", location: LOCATION, title: "Radford Lawn Care", ...over.settings } }],
    integration_secrets: [await secretRow()],
    review_syncs: [{ company_id: CO, account: "accounts/1", location_id: LOCATION, claim: null, locked_until: null, full_seen: 0, failures: 0, first_synced_at: "2026-09-01T00:00:00Z", full_synced_at: now(), ...over.sync }],
    ...over.tables,
  };
}
const sync = (w: World) => w.tables.review_syncs!.find((s) => s.company_id === CO)!;
const integration = (w: World) => w.tables.integrations!.find((r) => r.provider === "google_business")!;
const rpcs = (w: World, fn: string) => w.calls.filter((c) => c.path === `/rest/v1/rpc/${fn}`).map((c) => c.body);
const run = (w: World, options = {}) => syncCompany(env, adminClient(env), CO, options).finally(() => settle(w));

beforeEach(() => {
  complete.mockClear();
  sendEmail.mockClear();
  sendPush.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------

describe("signing in", () => {
  it("asks Google for the one Business Profile scope, offline, with consent and the account chooser, and comes back to its own address", async () => {
    serve({ tables: { companies: [companyRow()] } });
    const res = await request("/apps/google_business/connect", { method: "POST" });
    const url = new URL(((await res.json()) as { authorization_url: string }).authorization_url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: env.GOOGLE_CLIENT_ID, scope: "https://www.googleapis.com/auth/business.manage", access_type: "offline", prompt: "select_account consent",
      redirect_uri: "https://ops.example.com/api/apps/google_business/callback",
    });
  });

  it("signs in with the company's own Google app when it saved one", async () => {
    serve({ tables: { companies: [companyRow()], integration_secrets: [await secretRow(CO, { extra: { client_id: "555555555555-own.apps.googleusercontent.com", client_secret: "own-secret" } })] } });
    const res = await request("/apps/google_business/connect", { method: "POST" });
    expect(new URL(((await res.json()) as { authorization_url: string }).authorization_url).searchParams.get("client_id")).toBe("555555555555-own.apps.googleusercontent.com");
  });

  const callback = async (w: World) => {
    const state = await signToken(env, { company: CO, user: USER, provider: "google_business", nonce: "nonce-1", exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await app.request(`/api/apps/google_business/callback?${new URLSearchParams({ state, code: "code-1" })}`, { headers: { Cookie: "crewtavo_oauth_nonce=nonce-1" } }, env);
    await settle(w);
    return new URL(res.headers.get("location")!);
  };
  const tokens = (call: Call) => (call.host === "oauth2.googleapis.com" && call.path === "/token" ? { access_token: "fresh-token", refresh_token: "fresh-refresh", expires_in: 3600 } : undefined);

  it("picks the location by itself when the account has only one", async () => {
    const w = serve({ tables: { companies: [companyRow({ marketing: { enabled: false } })] }, google: (c) => tokens(c) ?? accountsOf({ "accounts/1": [location("9", "Radford Lawn Care")] })(c) });
    const back = await callback(w);
    expect([back.pathname, back.searchParams.get("status"), back.searchParams.get("pending")]).toEqual(["/apps/google_business", "connected", null]);
    expect(w.calls.find((c) => c.host === "mybusinessbusinessinformation.googleapis.com")!.params.get("readMask")).toBe("name,title,storefrontAddress,metadata");
    expect(integration(w)).toMatchObject({
      status: "connected", account_label: "Radford Lawn Care",
      settings: { account: "accounts/1", location: LOCATION, title: "Radford Lawn Care", address: "12 Main St, Radford, VA 24141", place_id: "place-9", new_review_uri: "https://search.google.com/local/writereview?placeid=place-9" },
    });
    expect(rpcs(w, "set_review_location")).toEqual([{ p_company: CO, p_account: "accounts/1", p_location_id: LOCATION }]);
  });

  it("starts bringing reviews in right away while Marketing is installed", async () => {
    const w = serve({ tables: { companies: [companyRow()] }, google: (c) => tokens(c) ?? accountsOf({ "accounts/1": [location("9", "Radford Lawn Care")] })(c) ?? (isReviews(c) ? { reviews: [review("a")], totalReviewCount: 1, averageRating: 5 } : undefined) });
    await callback(w);
    expect(w.calls.some(isReviews)).toBe(true);
    expect(w.tables.reviews!.map((r) => r.review_id)).toEqual(["a"]);
  });

  it("leaves several locations to pick", async () => {
    const w = serve({ tables: { companies: [companyRow({ marketing: { enabled: false } })] }, google: (c) => tokens(c) ?? accountsOf({ "accounts/1": [location("9", "Radford"), location("10", "Blacksburg")], "accounts/2": [] })(c) });
    const back = await callback(w);
    expect(back.searchParams.get("pending")).toBe("pick");
    expect(sync(w)).toMatchObject({ problem: "pick", problem_detail: null, next_sync_at: null });
    expect(rpcs(w, "set_review_location")).toEqual([]);
    // The person who signed in picks: nobody is told.
    expect(rpcs(w, "note_review_access")).toEqual([]);
  });

  it("says when the Google account manages no Business Profile", async () => {
    const w = serve({ tables: { companies: [companyRow({ marketing: { enabled: false } })] }, google: (c) => tokens(c) ?? accountsOf({ "accounts/1": [] })(c) });
    const back = await callback(w);
    expect(back.searchParams.get("pending")).toBe("pick");
    expect(sync(w)).toMatchObject({ problem: "pick", problem_detail: "none" });
  });

  describe("again after Uninstall kept the reviews", () => {
    const stoppedAsk = { id: "rr-bob", company_id: CO, client_id: BOB, status: "sent", clicked_at: null, sent_at: "2026-10-26T15:00:00Z", reminders_sent: 0, last_reminder_at: null, next_reminder_at: null, reminder_note: REVIEW_STOP_NOTE };
    const uninstalled = () => ({
      companies: [companyRow({ marketing: { enabled: true, changed_at: "2026-01-01T00:00:00Z" } })],
      integrations: [{ company_id: CO, provider: "google_business", status: "disconnected", account_label: null, last_error: null, settings: {} }],
      review_syncs: [{ company_id: CO, account: "accounts/1", location_id: LOCATION, claim: null, locked_until: null, next_sync_at: null, problem: null, access_notice: null, full_seen: 0, failures: 0, first_synced_at: "2026-09-01T00:00:00Z" }],
      reviews: [{ id: "r-bob", company_id: CO, location_id: LOCATION, review_id: "bob", client_id: BOB, deleted_at: null }],
      review_requests: [{ ...stoppedAsk }],
    });
    const anyReviews = (c: Call) => (c.host === "mybusiness.googleapis.com" ? { reviews: [] } : undefined);

    it("a sign-in that can't reach their location asks for one, quietly, and picking it removes them and gives their clients' reminders back", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") });
      // The new account has one location, but taking it would remove the reviews kept: it's asked.
      const w = serve({ tables: uninstalled(), google: (c) => tokens(c) ?? accountsOf({ "accounts/2": [location("20", "Blacksburg Lawn Care")] })(c) ?? anyReviews(c) });
      const back = await callback(w);
      expect(back.searchParams.get("pending")).toBe("pick");
      expect(sync(w)).toMatchObject({ problem: "pick", location_id: LOCATION });
      expect(rpcs(w, "note_review_access")).toEqual([]);
      expect(rpcs(w, "set_review_location")).toEqual([]);
      expect(w.tables.reviews).toHaveLength(1);
      // The app page has a picker to show: no location in use, and the one the reviews came from.
      const listed = (await (await request("/apps")).json()) as { apps: Array<{ id: string; google_business?: Row }> };
      expect(listed.apps.find((a) => a.id === "google_business")!.google_business).toMatchObject({ location: null, kept_location: LOCATION, problem: "pick", progress: null });

      const res = await request("/apps/google_business/location", { method: "PUT", body: { account: "accounts/2", location: "locations/20" } });
      expect(await res.json()).toMatchObject({ removed: 1, syncing: true });
      await settle(w);
      expect(w.tables.reviews!.filter((r) => r.company_id === CO && r.location_id === LOCATION)).toEqual([]);
      expect(integration(w).settings).toMatchObject({ account: "accounts/2", location: "locations/20" });
      expect(w.tables.review_requests![0]).toMatchObject({ next_reminder_at: "2026-10-29T17:30:00.000Z", reminder_note: null });
    });

    it("a sign-in that still reaches their location takes it up again, reviews and all", async () => {
      const w = serve({ tables: uninstalled(), google: (c) => tokens(c) ?? accountsOf({ "accounts/1": [location("9", "Radford Lawn Care"), location("10", "Blacksburg")] })(c) ?? anyReviews(c) });
      const back = await callback(w);
      expect(back.searchParams.get("pending")).toBeNull();
      expect(integration(w).settings).toMatchObject({ location: LOCATION, title: "Radford Lawn Care" });
      expect(w.tables.reviews!.map((r) => r.id)).toEqual(["r-bob"]);
      expect(w.tables.review_requests![0]!.next_reminder_at).toBeNull();
    });
  });

  it("still connects while Google hasn't approved access, saying so, and tries again in 6 hours", async () => {
    const w = serve({ tables: { companies: [companyRow()] }, google: (c) => tokens(c) ?? (c.host === "mybusinessaccountmanagement.googleapis.com" ? zeroQuota() : undefined) });
    const back = await callback(w);
    expect([back.searchParams.get("status"), back.searchParams.get("pending")]).toEqual(["connected", "approval"]);
    expect(integration(w)).toMatchObject({ status: "connected", last_error: APPROVAL_MESSAGE });
    expect(sync(w).problem).toBe("approval");
    expect(Date.parse(sync(w).next_sync_at) - Date.now()).toBeGreaterThan(5.9 * 3_600_000);
    // Nothing tried to sync meanwhile.
    expect(w.calls.some(isReviews)).toBe(false);
  });

  it("says when Google turns the app's keys down", async () => {
    const w = serve({ tables: { companies: [companyRow()] }, google: (c) => (c.path === "/token" ? Response.json({ error: "invalid_client" }, { status: 401 }) : undefined) });
    const back = await callback(w);
    expect(back.searchParams.get("message")).toBe("Google Business Profile didn't accept the Client ID and secret. Check them on this page, then connect again.");
  });
});

describe("the location", () => {
  it("lists every account's locations, a page at a time, a service-area business without an address", async () => {
    const w = serve({
      tables: await connected({ sync: { location_id: null } }),
      google: (c) => {
        if (google(c, "mybusinessaccountmanagement.googleapis.com", "/v1/accounts")) {
          return c.params.get("pageToken") ? { accounts: [{ name: "accounts/2", accountName: "Second" }] } : { accounts: [{ name: "accounts/1", accountName: "First" }], nextPageToken: "acct-2" };
        }
        if (c.path === "/v1/accounts/1/locations") return c.params.get("pageToken") ? { locations: [location("10", "Blacksburg", { storefrontAddress: undefined })] } : { locations: [location("9", "Radford")], nextPageToken: "loc-2" };
        if (c.path === "/v1/accounts/2/locations") return { locations: [] };
        return undefined;
      },
    });
    const res = await request("/apps/google_business/locations");
    const body = (await res.json()) as { accounts: Array<{ name: string; locations: Array<{ name: string; address: string | null }> }>; problem: string | null };
    await settle(w);
    expect(body.problem).toBe("pick");
    expect(body.accounts.map((a) => [a.name, a.locations.map((l) => [l.name, l.address])])).toEqual([
      ["accounts/1", [["locations/9", "12 Main St, Radford, VA 24141"], ["locations/10", null]]],
      ["accounts/2", []],
    ]);
    const locationCalls = w.calls.filter((c) => c.host === "mybusinessbusinessinformation.googleapis.com");
    expect(locationCalls.every((c) => c.params.get("readMask") === "name,title,storefrontAddress,metadata" && c.params.get("pageSize") === "100")).toBe(true);
    expect(locationCalls.map((c) => c.params.get("pageToken"))).toEqual([null, "loc-2", null]);
  });

  it("is read again from Google when it's picked, offering Google's review link only when it would change the company's", async () => {
    const w = serve({ tables: await connected({ company: { marketing: { enabled: false }, review_url: "https://g.page/r/old/review" } }), google: accountsOf({ "accounts/1": [location("9", "Radford Lawn Care"), location("10", "Blacksburg Lawn Care")] }) });
    w.tables.reviews!.push({ id: "r-old", company_id: CO, location_id: LOCATION, review_id: "old", deleted_at: null });
    const res = await request("/apps/google_business/location", { method: "PUT", body: { account: "accounts/1", location: "locations/10", title: "Something else" } });
    const body = (await res.json()) as { removed: number; review_url: { current: string; suggested: string } };
    expect(res.status).toBe(200);
    // Marketing is off, so nothing's on its way yet.
    expect(body).toMatchObject({ removed: 1, syncing: false, review_url: { current: "https://g.page/r/old/review", suggested: "https://search.google.com/local/writereview?placeid=place-10" } });
    expect(integration(w)).toMatchObject({ account_label: "Blacksburg Lawn Care", settings: { location: "locations/10", title: "Blacksburg Lawn Care" } });
    expect(w.tables.reviews).toEqual([]);

    // The same link as the company's already: nothing to offer.
    const same = serve({ tables: await connected({ company: { marketing: { enabled: false }, review_url: "https://search.google.com/local/writereview?placeid=place-9" } }), google: accountsOf({ "accounts/1": [location("9", "Radford Lawn Care")] }) });
    const again = (await (await request("/apps/google_business/location", { method: "PUT", body: { account: "accounts/1", location: LOCATION } })).json()) as { review_url: { suggested: string | null } };
    expect(again.review_url.suggested).toBeNull();
    await settle(same);
  });

  it("doesn't start bringing reviews in for a location Google hasn't verified", async () => {
    const w = serve({ tables: await connected(), google: accountsOf({ "accounts/1": [location("9", "Radford Lawn Care", { metadata: { hasVoiceOfMerchant: false } })] }) });
    const res = await request("/apps/google_business/location", { method: "PUT", body: { account: "accounts/1", location: LOCATION } });
    expect(await res.json()).toMatchObject({ syncing: false });
    await settle(w);
    expect(sync(w)).toMatchObject({ problem: "location", problem_detail: "unverified", next_sync_at: null });
    expect(w.calls.some(isReviews)).toBe(false);
  });

  it("refuses a location that isn't in the account", async () => {
    serve({ tables: await connected(), google: accountsOf({ "accounts/1": [location("9", "Radford")] }) });
    const res = await request("/apps/google_business/location", { method: "PUT", body: { account: "accounts/1", location: "locations/77" } });
    expect([res.status, await res.json()]).toEqual([404, { error: "That location isn't in this Google account anymore." }]);
  });

  it("uses Google's review link when asked, and remembers when it's turned down", async () => {
    const offer = { new_review_uri: "https://search.google.com/local/writereview?placeid=place-9" };
    let w = serve({ tables: await connected({ settings: offer }) });
    expect(await (await request("/apps/google_business/review-link", { method: "POST", body: { use: true } })).json()).toEqual({ review_url: offer.new_review_uri });
    expect(w.tables.companies![0]!.settings).toMatchObject({ review_url: offer.new_review_uri, marketing: { enabled: true } });

    w = serve({ tables: await connected({ settings: offer }) });
    await request("/apps/google_business/review-link", { method: "POST", body: { use: false } });
    expect(integration(w).settings.review_link_declined).toBe(offer.new_review_uri);
    expect(w.tables.companies![0]!.settings.review_url).toBeUndefined();
    const listed = (await (await request("/apps")).json()) as { apps: Array<{ id: string; google_business?: { review_url: { suggested: string | null } } }> };
    expect(listed.apps.find((a) => a.id === "google_business")!.google_business!.review_url.suggested).toBeNull();
  });
});

describe("disconnecting", () => {
  const revokes = (w: World) => w.calls.filter((c) => c.host === "oauth2.googleapis.com" && c.path === "/revoke");

  it("signs out at Google and keeps the reviews already brought in", async () => {
    const w = serve({ tables: await connected() });
    w.tables.reviews!.push({ id: "r1", company_id: CO, location_id: LOCATION, review_id: "a" });
    const res = await request("/apps/google_business/disconnect", { method: "POST", body: {} });
    expect(await res.json()).toEqual({ provider: "google_business", status: "disconnected", removed: 0 });
    expect(revokes(w)).toHaveLength(1);
    expect(rpcs(w, "end_review_sync")).toEqual([{ p_company: CO, p_remove: false }]);
    expect(w.tables.reviews).toHaveLength(1);
    expect(integration(w)).toMatchObject({ status: "disconnected", settings: {} });
  });

  it("removes them too when asked, and the asks they stopped get their reminders back", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") });
    const w = serve({ tables: await connected({ company: { marketing: { enabled: true, changed_at: "2026-01-01T00:00:00Z" } } }) });
    w.tables.reviews!.push({ id: "r1", company_id: CO, location_id: LOCATION, review_id: "a", client_id: BOB, deleted_at: null });
    w.tables.review_requests = [{ id: "rr-bob", company_id: CO, client_id: BOB, status: "sent", clicked_at: null, sent_at: "2026-10-26T15:00:00Z", reminders_sent: 0, last_reminder_at: null, next_reminder_at: null, reminder_note: REVIEW_STOP_NOTE }];
    const res = await request("/apps/google_business/disconnect", { method: "POST", body: { remove_reviews: true } });
    expect(await res.json()).toMatchObject({ removed: 1 });
    expect(w.tables.reviews).toEqual([]);
    expect(w.tables.review_requests![0]).toMatchObject({ next_reminder_at: "2026-10-29T17:30:00.000Z", reminder_note: null });
  });

  it("doesn't sign Google Calendar out with it: both use the server's Google app, so the sign-in is left", async () => {
    const tables = await connected();
    tables.integrations.push({ company_id: CO, provider: "google_calendar", status: "connected", settings: {} } as never);
    const w = serve({ tables });
    const res = await request("/apps/google_business/disconnect", { method: "POST", body: {} });
    expect(await res.json()).toMatchObject({ revoked: false });
    expect(revokes(w)).toEqual([]);
    // And the other way round.
    const back = await connected();
    back.integrations.push({ company_id: CO, provider: "google_calendar", status: "connected", settings: {} } as never);
    back.integration_secrets.push({ ...(await secretRow()), provider: "google_calendar" });
    const v = serve({ tables: back });
    await request("/apps/google_calendar/disconnect", { method: "POST", body: {} });
    expect(revokes(v)).toEqual([]);
  });
});

describe("syncing", () => {
  it("asks for 50 at a time, newest changes first, and stops at the first review already here unchanged", async () => {
    const w = serve({
      tables: await connected(),
      google: (c) => (isReviews(c) ? (c.params.get("pageToken") ? { reviews: [review("old")] } : { reviews: [review("new-1"), review("kept")], nextPageToken: "p2", totalReviewCount: 3, averageRating: 4.7 }) : undefined),
    });
    w.tables.reviews!.push({ id: "r-kept", company_id: CO, location_id: LOCATION, ...{ review_id: "kept", rating: 5, comment: "Great work (kept)", reply_comment: null, reply_updated_at: null, google_updated_at: "2026-10-01T12:00:00Z" } });
    expect(await run(w)).toMatchObject({ result: "synced", counts: { new: 1, same: 1 } });
    const asked = w.calls.filter(isReviews);
    expect(asked).toHaveLength(1);
    expect([asked[0]!.params.get("pageSize"), asked[0]!.params.get("orderBy")]).toEqual(["50", "updateTime desc"]);
    expect(sync(w)).toMatchObject({ claim: null, locked_until: null, average_rating: 4.7, total_reviews: 3, problem: null });
    expect(Date.parse(sync(w).next_sync_at) - Date.now()).toBeGreaterThan(29 * 60_000);
  });

  it("brings all of them in the first time, in pieces, carrying on where it stopped, and quietly", async () => {
    const pages: Record<string, Row> = {
      "": { reviews: [review("a"), review("b")], nextPageToken: "t2", totalReviewCount: 5, averageRating: 4.6 },
      t2: { reviews: [review("c"), review("d")], nextPageToken: "t3" },
      t3: { reviews: [review("e")] },
    };
    const w = serve({ tables: await connected({ sync: { first_synced_at: null, full_synced_at: null } }), google: (c) => (isReviews(c) ? pages[c.params.get("pageToken") ?? ""] : undefined) });
    expect(await run(w, { pages: 2 })).toMatchObject({ result: "synced", counts: { new: 4 } });
    // Google's count is kept with the place as soon as it's heard, so the progress reads "4 of 5".
    expect(sync(w)).toMatchObject({ full_page_token: "t3", full_seen: 4, first_synced_at: null, total_reviews: 5, average_rating: 4.6 });
    expect(rpcs(w, "note_review_access").filter((b) => b.p_kind === "in")).toEqual([]);

    expect(await run(w, { pages: 2 })).toMatchObject({ result: "synced", counts: { new: 1 } });
    // The top first, for anything new meanwhile, then on from where it stopped.
    expect(w.calls.filter(isReviews).map((c) => c.params.get("pageToken"))).toEqual([null, "t2", null, "t3"]);
    expect(sync(w)).toMatchObject({ full_page_token: null, full_started_at: null });
    expect(rpcs(w, "note_review_access").filter((b) => b.p_kind === "in")).toEqual([
      expect.objectContaining({ p_title: "Your Google reviews are in: 5 reviews, 4.6 average", p_body: "See them, and reply, in Marketing → Reviews." }),
    ]);
    // None of the old reviews told anyone.
    expect(w.tables.notifications).toEqual([]);
  });

  it("saves Google's count with the last page of the first sync, so a location on one page reads 'of 30' until it's in", async () => {
    const reviews = Array.from({ length: 30 }, (_, i) => review(`one-${i}`));
    // What the sync row says at the moment the office is told the reviews are in, and the progress
    // the Reviews tab would read from it then.
    let atNotice: Row | null = null;
    const w = serve({
      tables: await connected({ sync: { first_synced_at: null, full_synced_at: null, total_reviews: null, average_rating: null } }),
      rpc: {
        note_review_access: (b, world) => {
          if (b.p_kind === "in") atNotice = { ...sync(world) };
          return functions().note_review_access!(b, world);
        },
      },
      google: (c) => (isReviews(c) ? { reviews, totalReviewCount: 30, averageRating: 4.9 } : undefined),
    });
    expect(await run(w)).toMatchObject({ result: "synced", counts: { new: 30 } });
    expect(atNotice).toMatchObject({ full_seen: 30, total_reviews: 30, average_rating: 4.9, first_synced_at: null });
    // The one write that ends the pass carries the count, not a write after the notice.
    const ended = w.calls.filter((c) => c.method === "PATCH" && c.path === "/rest/v1/review_syncs" && c.body?.full_synced_at);
    expect(ended).toEqual([expect.objectContaining({ body: expect.objectContaining({ full_seen: 30, total_reviews: 30, average_rating: 4.9 }) })]);
    expect(rpcs(w, "note_review_access").find((b) => b.p_kind === "in")).toMatchObject({ p_title: "Your Google reviews are in: 30 reviews, 4.9 average" });
  });

  it("tells the office the reviews are in on the next run when telling them failed as the first pass ended", async () => {
    let fail = true;
    const w = serve({
      tables: await connected({ sync: { first_synced_at: null, full_synced_at: null } }),
      rpc: {
        note_review_access: (b, world) => {
          if (b.p_kind === "in" && fail) {
            fail = false;
            return Response.json({ code: "57014", message: "canceling statement due to statement timeout" }, { status: 500 });
          }
          return functions().note_review_access!(b, world);
        },
      },
      google: (c) => (isReviews(c) ? { reviews: [review("a"), review("b")], totalReviewCount: 2, averageRating: 4.5 } : undefined),
    });
    expect(await run(w)).toMatchObject({ result: "problem" });
    expect(sync(w).first_synced_at).toBeFalsy();
    expect(sync(w).full_synced_at).toBeTruthy();

    // The next run is the quick pass from the top, not a full one, and it tells them.
    expect(await run(w)).toMatchObject({ result: "synced" });
    expect(w.calls.filter(isReviews).map((c) => c.params.get("pageToken"))).toEqual([null, null]);
    expect(rpcs(w, "note_review_access").filter((b) => b.p_kind === "in")).toEqual([
      expect.objectContaining({ p_title: "Your Google reviews are in: 2 reviews, 4.5 average" }),
      expect.objectContaining({ p_title: "Your Google reviews are in: 2 reviews, 4.5 average" }),
    ]);
    expect(sync(w).first_synced_at).toBeTruthy();
  });

  it("tells the office of a new review once, a low rating as review_low", async () => {
    let top: Row = { reviews: [review("fresh", { createTime: new Date(Date.now() - 86_400_000).toISOString(), updateTime: new Date(Date.now() - 86_400_000).toISOString(), starRating: "TWO" })] };
    const w = serve({ tables: await connected(), google: (c) => (isReviews(c) ? top : undefined) });
    expect(await run(w)).toMatchObject({ counts: { new: 1, told: 1 } });
    expect(w.tables.notifications!.map((n) => [n.kind, n.title])).toEqual([["review_low", "Reviewer fresh left a 2-star review"]]);
    expect(await run(w)).toMatchObject({ counts: { same: 1, told: 0 } });
    expect(w.tables.notifications).toHaveLength(1);
    top = { reviews: [] };
  });

  it("marks a review deleted only when Google says it's gone, after a pass that saw everything", async () => {
    const w = serve({
      tables: await connected({ sync: { full_synced_at: "2026-01-01T00:00:00Z" } }),
      google: (c) => {
        if (isReviews(c)) return { reviews: [review("live")] };
        if (c.path === `/v4/${PARENT}/reviews/gone`) return Response.json({ error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } }, { status: 404 });
        if (c.path === `/v4/${PARENT}/reviews/skipped`) return review("skipped");
        return undefined;
      },
    });
    for (const id of ["live", "gone", "skipped"]) {
      w.tables.reviews!.push({ id: `r-${id}`, company_id: CO, location_id: LOCATION, review_id: id, external_name: `${PARENT}/reviews/${id}`, rating: 5, comment: `Great work (${id})`, google_updated_at: "2026-10-01T12:00:00Z", seen_at: "2026-01-01T00:00:00Z", deleted_at: null });
    }
    expect(await run(w)).toMatchObject({ counts: { deleted: 1 } });
    expect(rpcs(w, "mark_deleted_reviews")).toEqual([expect.objectContaining({ p_ids: ["r-gone"], p_location_id: LOCATION })]);
    expect(w.tables.reviews!.filter((r) => r.deleted_at).map((r) => r.review_id)).toEqual(["gone"]);

    // A pass cut short marks nothing.
    const cut = serve({
      tables: await connected({ sync: { full_synced_at: "2026-01-01T00:00:00Z" } }),
      google: (c) => (isReviews(c) ? { reviews: [review("live")], nextPageToken: "more" } : undefined),
    });
    cut.tables.reviews!.push({ id: "r-gone", company_id: CO, location_id: LOCATION, review_id: "gone", external_name: `${PARENT}/reviews/gone`, seen_at: "2026-01-01T00:00:00Z", deleted_at: null });
    await run(cut, { pages: 1 });
    expect(rpcs(cut, "mark_deleted_reviews")).toEqual([]);
    expect(cut.calls.some((c) => c.path.endsWith("/reviews/gone"))).toBe(false);
  });

  it("gives the asks a deleted review stopped their reminders back", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") });
    const w = serve({
      tables: await connected({ company: { marketing: { enabled: true, changed_at: "2026-01-01T00:00:00Z" } }, sync: { full_synced_at: "2026-01-01T00:00:00Z" } }),
      google: (c) => (isReviews(c) ? { reviews: [] } : c.path === `/v4/${PARENT}/reviews/gone` ? Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 }) : undefined),
    });
    w.tables.reviews!.push({ id: "r-gone", company_id: CO, location_id: LOCATION, review_id: "gone", external_name: `${PARENT}/reviews/gone`, client_id: BOB, seen_at: "2026-01-01T00:00:00Z", deleted_at: null });
    w.tables.review_requests = [{ id: "rr-bob", company_id: CO, client_id: BOB, status: "sent", clicked_at: null, sent_at: "2026-10-26T15:00:00Z", reminders_sent: 0, last_reminder_at: null, next_reminder_at: null, reminder_note: REVIEW_STOP_NOTE }];
    expect(await run(w)).toMatchObject({ counts: { deleted: 1 } });
    expect(w.tables.review_requests![0]).toMatchObject({ next_reminder_at: "2026-10-29T17:30:00.000Z", reminder_note: null });
  });

  it("keeps a reply posted here while Google was giving an older page, and who wrote it", async () => {
    let written = "";
    const w = serve({
      tables: await connected(),
      google: (c) => {
        if (!isReviews(c)) return undefined;
        // Someone posts a reply after Google has answered with the page, before it's recorded.
        written = now();
        Object.assign(w.tables.reviews![0]!, { reply_comment: "Thanks, Ana!", reply_updated_at: "2026-10-31T12:00:00Z", replied_by: USER, reply_written_at: written });
        return { reviews: [review("kept")] };
      },
    });
    w.tables.reviews!.push({ id: "r-kept", company_id: CO, location_id: LOCATION, review_id: "kept", rating: 5, comment: "Great work (kept)", reply_comment: null, reply_updated_at: null, google_updated_at: "2026-10-01T12:00:00Z" });
    expect(await run(w)).toMatchObject({ result: "synced", counts: { same: 1 } });
    expect(w.tables.reviews![0]).toMatchObject({ reply_comment: "Thanks, Ana!", replied_by: USER });
    const recorded = rpcs(w, "record_reviews")[0]!;
    expect(Date.parse(recorded.p_fetched_at)).toBeLessThanOrEqual(Date.parse(written));
  });

  it("starts the pass again when Google turns down an old page token", async () => {
    const w = serve({
      tables: await connected({ sync: { full_started_at: "2026-10-30T00:00:00Z", full_page_token: "stale", full_seen: 50 } }),
      google: (c) => {
        if (!isReviews(c)) return undefined;
        if (c.params.get("pageToken") === "stale") return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid page token" } }, { status: 400 });
        return { reviews: [review("a")] };
      },
    });
    expect(await run(w)).toMatchObject({ result: "synced" });
    expect(sync(w)).toMatchObject({ full_page_token: null, full_started_at: null, full_seen: 1 });
  });

  it("tells owners and admins once Google lets Crewtavo in with a location still to pick", async () => {
    const w = serve({
      tables: await connected({ sync: { location_id: null, problem: "approval" }, settings: { location: undefined } }),
      google: accountsOf({ "accounts/1": [location("9", "Radford"), location("10", "Blacksburg")] }),
    });
    expect(await run(w)).toEqual({ result: "pick" });
    expect(sync(w)).toMatchObject({ problem: "pick", next_sync_at: null });
    expect(rpcs(w, "note_review_access")).toEqual([expect.objectContaining({ p_kind: "pick", p_title: "Pick the location for your Google reviews" })]);
    // With only one location it's picked, and nobody needs telling.
    const one = serve({ tables: await connected({ sync: { location_id: null, problem: "approval" }, settings: { location: undefined } }), google: (c) => accountsOf({ "accounts/1": [location("9", "Radford")] })(c) ?? (isReviews(c) ? { reviews: [] } : undefined) });
    expect(await run(one)).toMatchObject({ result: "synced" });
    expect(rpcs(one, "note_review_access").filter((b) => b.p_kind === "pick")).toEqual([]);
  });

  it("says how far the first sync has got only while reviews are coming in", async () => {
    const progressOf = async (over: Parameters<typeof connected>[0]) => {
      serve({ tables: await connected(over) });
      const state = (await (await request("/reviews/google")).json()) as Row;
      const listed = (await (await request("/apps")).json()) as { apps: Array<{ id: string; google_business?: Row }> };
      return [state.progress, listed.apps.find((a) => a.id === "google_business")!.google_business!.progress];
    };
    const first = { first_synced_at: null, full_seen: 120, total_reviews: 300 };
    expect(await progressOf({ sync: first })).toEqual([{ seen: 120, total: 300 }, { seen: 120, total: 300 }]);
    for (const problem of ["approval", "not_enabled", "location", "error"]) {
      expect(await progressOf({ sync: { ...first, problem } }), problem).toEqual([null, null]);
    }
    expect(await progressOf({ sync: first, company: { marketing: { enabled: false } } })).toEqual([null, null]);
  });

  it("leaves a company another worker is syncing alone", async () => {
    const w = serve({ tables: await connected({ sync: { locked_until: new Date(Date.now() + 60_000).toISOString() } }) });
    expect(await run(w)).toEqual({ result: "busy" });
    expect(w.calls.some((c) => c.host !== "example.supabase.co")).toBe(false);
  });

  it("brings nothing in while Marketing is uninstalled", async () => {
    const w = serve({ tables: await connected({ company: { marketing: { enabled: false } } }) });
    expect(await run(w)).toEqual({ result: "off" });
    expect(w.calls.some(isReviews)).toBe(false);
  });
});

describe("what's in the way", () => {
  const failing = async (answer: (c: Call) => unknown, over: Parameters<typeof connected>[0] = {}) => {
    const w = serve({ tables: await connected(over), google: answer });
    return { w, outcome: await run(w) };
  };

  it("zero quota is Google's approval: still connected, said plainly, and tried again in 6 hours", async () => {
    const { w, outcome } = await failing((c) => (isReviews(c) ? zeroQuota() : undefined));
    expect(outcome).toEqual({ result: "problem", problem: "approval" });
    expect(integration(w)).toMatchObject({ status: "connected", last_error: APPROVAL_MESSAGE });
    expect(Date.parse(sync(w).next_sync_at) - Date.now()).toBeGreaterThan(5.9 * 3_600_000);
  });

  it("the APIs not turned on say so", async () => {
    const { w, outcome } = await failing((c) => (isReviews(c) ? denied("SERVICE_DISABLED", "Google My Business API has not been used in project 123456789012 before or it is disabled.") : undefined));
    expect(outcome).toMatchObject({ problem: "not_enabled" });
    expect(integration(w).last_error).toBe("The Business Profile APIs aren't turned on in this server's Google Cloud project yet.");
  });

  it.each([
    ["a 401", () => Response.json({ error: { code: 401, status: "UNAUTHENTICATED", message: "Request had invalid authentication credentials." } }, { status: 401 })],
    ["a missing scope", () => denied("ACCESS_TOKEN_SCOPE_INSUFFICIENT", "Request had insufficient authentication scopes.")],
  ])("%s needs Reconnect: the app needs attention, nothing is retried, and someone who can fix it hears", async (_, answer) => {
    const { w, outcome } = await failing((c) => (isReviews(c) ? answer() : undefined));
    expect(outcome).toMatchObject({ problem: "signin" });
    expect(integration(w)).toMatchObject({ status: "error", last_error: SIGNIN_MESSAGE });
    expect(sync(w).next_sync_at).toBeNull();
    expect(rpcs(w, "note_review_access")).toEqual([expect.objectContaining({ p_kind: "signin", p_body: SIGNIN_MESSAGE })]);
  });

  it("a sign-in Google turned down (invalid_grant) needs Reconnect too", async () => {
    const tables = await connected();
    tables.integration_secrets = [await secretRow(CO, { access_token: "old", refresh_token: "revoked", expires_at: Date.now() - 1000 })];
    const w = serve({ tables, google: (c) => (c.path === "/token" ? Response.json({ error: "invalid_grant" }, { status: 400 }) : undefined) });
    expect(await run(w)).toMatchObject({ problem: "signin" });
    expect(integration(w).status).toBe("error");
  });

  it("access refused on the location is Google's approval while it's still listed, and a lost location once it isn't", async () => {
    let listed = true;
    const answer = (c: Call) => (isReviews(c) ? denied() : c.path === "/v1/accounts/1/locations" ? { locations: listed ? [location("9", "Radford")] : [] } : undefined);
    const first = await failing(answer);
    expect(first.outcome).toMatchObject({ problem: "approval" });
    listed = false;
    const second = await failing(answer);
    expect(second.outcome).toMatchObject({ problem: "location" });
    expect(sync(second.w)).toMatchObject({ problem_detail: "no_access", next_sync_at: null });
    expect(integration(second.w).last_error).toMatch(/can't manage this location anymore/);
  });

  it("a suspended Google Cloud project isn't a location problem: it's said, and tried again later", async () => {
    const { w, outcome } = await failing((c) => (isReviews(c) ? denied("CONSUMER_SUSPENDED", "Permission denied: Consumer 'projects/123456789012' has been suspended.") : undefined));
    expect(outcome).toMatchObject({ problem: "error" });
    expect(integration(w).last_error).toBe("Reviews couldn't be brought in: the Google Cloud project Crewtavo signs in with is suspended or was deleted. Its owner can see why in Google Cloud.");
    expect(sync(w).next_sync_at).not.toBeNull();
    expect(rpcs(w, "note_review_access").filter((b) => b.p_kind === "location")).toEqual([]);
  });

  it("counts failures over problems of one kind in a row: the first ordinary error after waiting on approval tries again in 30 minutes", async () => {
    const down = () => Response.json({ error: { code: 500, status: "INTERNAL", message: "Internal error encountered." } }, { status: 500 });
    const { w } = await failing((c) => (isReviews(c) ? down() : undefined), { sync: { problem: "approval", failures: 4 } });
    expect(sync(w)).toMatchObject({ problem: "error", failures: 1 });
    const wait = Date.parse(sync(w).next_sync_at) - Date.now();
    expect(wait).toBeGreaterThan(29 * 60_000);
    expect(wait).toBeLessThan(31 * 60_000);
    // The same kind again keeps counting.
    const again = await failing((c) => (isReviews(c) ? down() : undefined), { sync: { problem: "error", failures: 1 } });
    expect(sync(again.w).failures).toBe(2);
  });

  it("Google down is tried again, later each time; busy is tried again quietly", async () => {
    const down = () => Response.json({ error: { code: 500, status: "INTERNAL", message: "Internal error encountered." } }, { status: 500 });
    const { w, outcome } = await failing((c) => (isReviews(c) ? down() : undefined));
    expect(outcome).toMatchObject({ problem: "error" });
    // Google's own words stay in problem_detail; the office reads plain ones.
    expect(integration(w).last_error).toBe("Reviews couldn't be brought in from Google just now.");
    expect(sync(w).problem_detail).toBe("Internal error encountered.");
    const wait = Date.parse(sync(w).next_sync_at) - Date.now();
    expect(wait).toBeGreaterThan(29 * 60_000);
    expect(wait).toBeLessThan(31 * 60_000);
    sync(w).locked_until = null;
    await run(w);
    expect(Date.parse(sync(w).next_sync_at) - Date.now()).toBeGreaterThan(59 * 60_000);

    const busy = await failing((c) => (isReviews(c) ? Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Slow down", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", metadata: { quota_limit_value: "300" } }] } }, { status: 429 }) : undefined));
    expect(busy.outcome).toMatchObject({ problem: "busy" });
    expect([sync(busy.w).problem ?? null, integration(busy.w).last_error]).toEqual([null, null]);
  });

  it("are told apart by Google's own reasons", () => {
    const info = (reason: string, metadata = {}) => ({ error: { message: "x", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, metadata }] } });
    expect(googleProblem(429, info("RATE_LIMIT_EXCEEDED", { quota_limit_value: "0" })).kind).toBe("approval");
    expect(googleProblem(429, info("RATE_LIMIT_EXCEEDED", { quota_limit_value: "60" })).kind).toBe("busy");
    expect(googleProblem(403, info("SERVICE_DISABLED")).kind).toBe("not_enabled");
    expect(googleProblem(403, info("API_DISABLED")).kind).toBe("not_enabled");
    expect(googleProblem(403, info("ACCESS_TOKEN_SCOPE_INSUFFICIENT")).kind).toBe("signin");
    expect(googleProblem(401, {}).kind).toBe("signin");
    expect(googleProblem(403, info("PERMISSION_DENIED"), "list").kind).toBe("approval");
    expect(googleProblem(403, info("PERMISSION_DENIED"), "location").kind).toBe("denied");
    expect(googleProblem(404, {}, "location")).toMatchObject({ kind: "location", detail: "gone" });
    expect(googleProblem(400, { error: { message: "This location is suspended." } }, "location")).toMatchObject({ kind: "location", detail: "suspended" });
    // Only a call about the location says the location is suspended.
    expect(googleProblem(400, { error: { message: "This location is suspended." } }, "list").kind).toBe("error");
    // A suspended Google Cloud project is the project's problem, whatever was called.
    const project = { error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied: Consumer 'projects/123456789012' has been suspended.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "CONSUMER_SUSPENDED" }] } };
    for (const scope of ["list", "location"] as const) expect(googleProblem(403, project, scope)).toEqual({ kind: "error", message: PROJECT_SUSPENDED, detail: null });
    expect(googleProblem(403, { error: { message: "Permission denied: Consumer 'project:abc' has been suspended." } }, "location").kind).toBe("error");
    expect(googleProblem(400, { error: { message: "Invalid page token" } }, "location").kind).toBe("token");
    expect(googleProblem(500, "not json").kind).toBe("error");
  });
});

describe("replies", () => {
  const theReview = (over: Row = {}) => ({ id: "00000000-0000-4000-8000-0000000000f1", company_id: CO, location_id: LOCATION, review_id: "a", external_name: `${PARENT}/reviews/a`, reviewer_name: "Ana Smith", reviewer_anonymous: false, rating: 2, comment: "They missed the back yard.", reply_comment: null, first_replied_at: null, deleted_at: null, ...over });
  const ID = "00000000-0000-4000-8000-0000000000f1";

  it("post on Google and keep what was posted, edit with the same call, and delete", async () => {
    const tables = await connected();
    const w = serve({ tables: { ...tables, reviews: [theReview()] }, google: (c) => (c.path === `/v4/${PARENT}/reviews/a/reply` ? (c.method === "PUT" ? { comment: c.body.comment, updateTime: "2026-10-31T12:00:00Z" } : {}) : undefined) });
    let res = await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "  Thanks, Ana. We'll make it right.  " } });
    expect(res.status).toBe(200);
    expect(w.calls.find((c) => c.method === "PUT" && c.host === "mybusiness.googleapis.com")!.body).toEqual({ comment: "Thanks, Ana. We'll make it right." });
    expect(w.tables.reviews![0]).toMatchObject({ reply_comment: "Thanks, Ana. We'll make it right.", replied_by: USER, first_replied_at: "2026-10-31T12:00:00Z" });
    expect(w.tables.reviews![0]!.reply_written_at).toBeTruthy();
    res = await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "Thanks, Ana." } });
    expect(w.tables.reviews![0]).toMatchObject({ reply_comment: "Thanks, Ana.", first_replied_at: "2026-10-31T12:00:00Z" });
    res = await request(`/reviews/${ID}/reply`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(w.calls.some((c) => c.method === "DELETE" && c.path === `/v4/${PARENT}/reviews/a/reply`)).toBe(true);
    expect(w.tables.reviews![0]).toMatchObject({ reply_comment: null, first_replied_at: null, replied_by: null });
  });

  it("need words, and no more than Google takes", async () => {
    serve({ tables: { ...(await connected()), reviews: [theReview()] } });
    expect((await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "   " } })).status).toBe(400);
    expect((await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "x".repeat(4097) } })).status).toBe(400);
  });

  it("say plainly when Google doesn't take one, not in Google's own words", async () => {
    serve({ tables: { ...(await connected()), reviews: [theReview()] }, google: () => Response.json({ error: { code: 500, status: "INTERNAL", message: "Internal error encountered." } }, { status: 500 }) });
    const res = await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "Thanks!" } });
    expect([res.status, await res.json()]).toEqual([502, { error: "Google didn't take the reply. Try again in a minute." }]);
  });

  it("say what's in the way when Google refuses one on the location, not to try again in a minute", async () => {
    let listed = true;
    const answer = (c: Call) => (c.path === `/v4/${PARENT}/reviews/a/reply` ? denied() : c.path === "/v1/accounts/1/locations" ? { locations: listed ? [location("9", "Radford")] : [] } : undefined);
    serve({ tables: { ...(await connected()), reviews: [theReview()] }, google: answer });
    let res = await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "Thanks!" } });
    // Still listed: Google hasn't approved this server's access.
    expect([res.status, await res.json()]).toEqual([409, { error: APPROVAL_MESSAGE }]);
    listed = false;
    serve({ tables: { ...(await connected()), reviews: [theReview()] }, google: answer });
    res = await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "Thanks!" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/can't manage this location anymore/);
  });

  const notFound = () => Response.json({ error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } }, { status: 404 });

  it("to a review Google no longer has marks it removed, once Google says so for the review, and its client's reminders come back", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") });
    const tables = await connected({ company: { marketing: { enabled: true, changed_at: "2026-01-01T00:00:00Z" } } });
    const w = serve({
      tables: {
        ...tables, reviews: [theReview({ client_id: BOB })],
        // As the database leaves Bob once his only review is marked deleted.
        clients: [{ id: BOB, company_id: CO, reviewed_at: null }],
        review_requests: [{ id: "rr-bob", company_id: CO, client_id: BOB, status: "sent", clicked_at: null, sent_at: "2026-10-26T15:00:00Z", reminders_sent: 0, last_reminder_at: null, next_reminder_at: null, reminder_note: REVIEW_STOP_NOTE }],
      },
      google: notFound,
    });
    const res = await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "Thanks!" } });
    expect([res.status, await res.json()]).toEqual([404, { error: "This review was removed from Google." }]);
    expect(w.calls.some((c) => c.method === "GET" && c.path === `/v4/${PARENT}/reviews/a`)).toBe(true);
    expect(w.tables.reviews![0]!.deleted_at).toBeTruthy();
    expect(w.tables.review_requests![0]).toMatchObject({ next_reminder_at: "2026-10-29T17:30:00.000Z", reminder_note: null });
  });

  it("to a review that's still on Google mark nothing when the reply answers 404: deleting one Google no longer has clears it here", async () => {
    const answer = (c: Call) => (c.path === `/v4/${PARENT}/reviews/a` ? review("a") : c.path === `/v4/${PARENT}/reviews/a/reply` ? notFound() : undefined);
    const w = serve({ tables: { ...(await connected()), reviews: [theReview({ reply_comment: "Thanks, Ana.", replied_by: USER })] }, google: answer });
    const res = await request(`/reviews/${ID}/reply`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(w.tables.reviews![0]).toMatchObject({ deleted_at: null, reply_comment: null, replied_by: null });
    expect(w.tables.reviews![0]!.reply_written_at).toBeTruthy();

    const v = serve({ tables: { ...(await connected()), reviews: [theReview()] }, google: answer });
    const posted = await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "Thanks!" } });
    expect([posted.status, await posted.json()]).toEqual([502, { error: "Google didn't take the reply. Try again in a minute." }]);
    expect(v.tables.reviews![0]).toMatchObject({ deleted_at: null, reply_comment: null });
  });

  it("wait while Marketing is uninstalled, and never reach another business's review", async () => {
    serve({ tables: { ...(await connected({ company: { marketing: { enabled: false } } })), reviews: [theReview()] } });
    const off = await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "Thanks!" } });
    expect([off.status, await off.json()]).toEqual([409, { error: "Marketing is off, so replies can't be posted. An owner or admin can install it again in Apps." }]);
    const w = serve({ tables: { ...(await connected()), reviews: [theReview({ company_id: OTHER })] } });
    expect((await request(`/reviews/${ID}/reply`, { method: "PUT", body: { comment: "Thanks!" } })).status).toBe(404);
    expect(w.calls.some((c) => c.host === "mybusiness.googleapis.com")).toBe(false);
  });

  describe("Suggest a reply", () => {
    it("drafts with the company's own key, from the review's name, stars and words, and never more", async () => {
      const tables = await connected();
      tables.integration_secrets.push({ company_id: CO, provider: "anthropic", ciphertext: await encryptJson(env, { api_key: "sk-ant-radford" }) });
      serve({ tables: { ...tables, reviews: [theReview()] } });
      complete.mockResolvedValueOnce("Hi Ana, we're sorry we missed the back yard. Please call us at 540-555-0100 so we can make it right.");
      const res = await request(`/reviews/${ID}/suggest`, { method: "POST", body: {} });
      expect(await res.json()).toEqual({ text: "Hi Ana, we're sorry we missed the back yard. Please call us at 540-555-0100 so we can make it right." });
      const asked = complete.mock.calls[0]![1];
      expect(asked.apiKey).toBe("sk-ant-radford");
      expect(asked.prompt).toContain("Reviewer: Ana Smith");
      expect(asked.prompt).toContain("Stars: 2 out of 5");
      expect(asked.prompt).toContain("They missed the back yard.");
      expect(asked.system).toContain("Never add prices, dates, promises, offers, discounts, staff names or any detail that isn't in the review.");
      // The phone as the app shows it, since it may go out in a public reply.
      expect(asked.system).toContain("by phone at (540) 555-0100 or by email at office@radford.example");
      expect(asked.system).toContain("first name when their name looks like a person's first name");
      expect(asked.system).toContain("language of the original, not the translation");
    });

    it("gives Claude the phone as the app shows it, and another country's as Settings has it", () => {
      expect(["5405550100", "540.555.0100", "+1 540 555 0100", " +44 20 7946 0958 "].map(replyPhone)).toEqual([
        "(540) 555-0100", "(540) 555-0100", "(540) 555-0100", "+44 20 7946 0958",
      ]);
    });

    it("rewrites a draft, and gives no name for an anonymous reviewer", async () => {
      serve({ tables: { ...(await connected()), reviews: [theReview({ reviewer_anonymous: true, reviewer_name: "A Google User" })] } });
      complete.mockResolvedValueOnce("Thank you for the kind words.");
      await request(`/reviews/${ID}/suggest`, { method: "POST", body: { draft: "thx!!", instruction: "Make it warmer" } });
      const asked = complete.mock.calls[0]![1];
      expect(asked.prompt).toContain("Reviewer: Anonymous (don't use a name)");
      expect(asked.prompt).toContain("Their draft reply:\nthx!!");
      expect(asked.prompt).toContain("Rewrite it: Make it warmer.");
    });

    it("says AI isn't turned on without a key, and waits while Marketing is off", async () => {
      serve({ tables: { ...(await connected()), reviews: [theReview()] } });
      const res = await request(`/reviews/${ID}/suggest`, { method: "POST", body: {} });
      expect([res.status, await res.json()]).toEqual([501, { error: "AI isn't turned on yet. An admin can add a Claude key on the Apps page." }]);
      serve({ tables: { ...(await connected({ company: { marketing: { enabled: false } } })), reviews: [theReview()] } });
      expect((await request(`/reviews/${ID}/suggest`, { method: "POST", body: {} })).status).toBe(409);
    });
  });
});

describe("Sync now", () => {
  it("starts a sync, then waits a couple of minutes before another", async () => {
    const w = serve({ tables: await connected(), google: (c) => (isReviews(c) ? { reviews: [] } : undefined) });
    const first = await request("/reviews/google/sync", { method: "POST" });
    expect(first.status).toBe(202);
    await settle(w);
    expect(w.calls.some(isReviews)).toBe(true);
    const again = await request("/reviews/google/sync", { method: "POST" });
    expect([again.status, await again.json()]).toEqual([429, { error: "Google was checked a moment ago. Try again in a couple of minutes." }]);
    expect(rpcs(w, "rate_limit_hit")[0]).toEqual({ p_key: `review-sync:${CO}`, p_max: 1, p_window_seconds: 120 });
  });

  it("isn't offered while Google hasn't approved access: there's nothing to bring in", async () => {
    for (const problem of ["approval", "not_enabled"]) {
      const w = serve({ tables: await connected({ sync: { problem } }) });
      const res = await request("/reviews/google/sync", { method: "POST" });
      expect([res.status, await res.json()]).toEqual([409, { error: "Google isn't letting Crewtavo in yet, so there's nothing to bring in. Crewtavo checks again every 6 hours." }]);
      expect(rpcs(w, "rate_limit_hit")).toEqual([]);
      expect(w.calls.some(isReviews)).toBe(false);
    }
  });

  it("says a sign-in that expired needs Reconnect, not connecting first", async () => {
    const tables = await connected();
    tables.integrations[0]!.status = "error";
    serve({ tables });
    const res = await request("/reviews/google/sync", { method: "POST" });
    expect([res.status, await res.json()]).toEqual([409, { error: SIGNIN_MESSAGE }]);
    tables.integrations[0]!.status = "disconnected";
    serve({ tables });
    expect(await (await request("/reviews/google/sync", { method: "POST" })).json()).toEqual({ error: "Connect Google Business Profile in Apps first." });
  });

  it("waits while Marketing is off, and needs the marketing area", async () => {
    serve({ tables: await connected({ company: { marketing: { enabled: false } } }) });
    expect((await request("/reviews/google/sync", { method: "POST" })).status).toBe(409);
    serve({ tables: { ...(await connected()), memberships: [{ company_id: CO, user_id: USER, role: "office", role_id: "dispatch", subcontractor_id: null, active: true }], company_roles: [{ id: "dispatch", permissions: ["schedule"] }] } });
    expect((await request("/reviews/google/sync", { method: "POST" })).status).toBe(403);
  });

  it("tells the Reviews tab what's in the way, for office staff who can't read Apps", async () => {
    serve({ tables: { ...(await connected({ sync: { problem: "approval" } })), memberships: [{ company_id: CO, user_id: USER, role: "office", role_id: null, subcontractor_id: null, active: true }] } });
    const state = (await (await request("/reviews/google")).json()) as Row;
    expect(state).toMatchObject({ state: "approval", problem_message: APPROVAL_MESSAGE, can_connect: false, project_number: "123456789012", location: { id: LOCATION, title: "Radford Lawn Care" } });
  });
});

describe("matching by hand", () => {
  const ID = "00000000-0000-4000-8000-0000000000f2";
  it("lifts the stop on the client it was matched to: their newest stopped ask gets its next reminder back", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") });
    const sent = "2026-10-26T15:00:00Z";
    const w = serve({
      tables: {
        ...(await connected({ company: { marketing: { enabled: true, changed_at: "2026-01-01T00:00:00Z" } } })),
        reviews: [{ id: ID, company_id: CO, client_id: BOB, deleted_at: null }],
        review_requests: [
          { id: "rr-new", company_id: CO, client_id: BOB, status: "sent", clicked_at: null, sent_at: sent, reminders_sent: 0, last_reminder_at: null, next_reminder_at: null, reminder_note: REVIEW_STOP_NOTE },
          { id: "rr-old", company_id: CO, client_id: BOB, status: "sent", clicked_at: null, sent_at: "2026-03-01T15:00:00Z", reminders_sent: 0, last_reminder_at: null, next_reminder_at: null, reminder_note: REVIEW_STOP_NOTE },
        ],
      },
    });
    const res = await request(`/reviews/${ID}/client`, { method: "PUT", body: { client_id: null } });
    expect(await res.json()).toEqual({ client_id: null, lifted_client: BOB, reminders: 1 });
    expect(rpcs(w, "set_review_client")).toEqual([{ p_company: CO, p_review: ID, p_client: null, p_by: USER }]);
    // Three days after the ask, at 1:30pm in New York.
    expect(w.tables.review_requests!.map((r) => [r.id, r.next_reminder_at, r.reminder_note])).toEqual([
      ["rr-new", "2026-10-29T17:30:00.000Z", null],
      ["rr-old", null, "A newer ask replaced it"],
    ]);
  });

  it("leaves reminders stopped for an ask from before Marketing was installed again, or while it's off", async () => {
    const asks = () => [{ id: "rr-1", company_id: CO, client_id: BOB, status: "sent", clicked_at: null, sent_at: "2026-10-01T15:00:00Z", reminders_sent: 0, last_reminder_at: null, next_reminder_at: null, reminder_note: REVIEW_STOP_NOTE }];
    let w = serve({ tables: { ...(await connected({ company: { marketing: { enabled: true, changed_at: "2026-10-20T00:00:00Z" } } })), review_requests: asks() } });
    expect(await liftReviewStop(adminClient(env), CO, BOB)).toBe(0);
    expect(w.tables.review_requests![0]).toMatchObject({ next_reminder_at: null, reminder_note: "Marketing was uninstalled" });
    w = serve({ tables: { ...(await connected({ company: { marketing: { enabled: false } } })), review_requests: asks() } });
    expect(await liftReviewStop(adminClient(env), CO, BOB)).toBe(0);
    expect(w.tables.review_requests![0]!.next_reminder_at).toBeNull();
  });

  it("can't reach another business's review", async () => {
    serve({ tables: { ...(await connected()), reviews: [{ id: ID, company_id: OTHER, client_id: null }] } });
    const res = await request(`/reviews/${ID}/client`, { method: "PUT", body: { client_id: BOB } });
    expect(res.status).toBe(404);
  });
});

describe("review notifications", () => {
  const notice = (kind: string, title: string, id: string) => ({ id, company_id: CO, user_id: USER, kind, title, body: null, link: `/marketing?tab=reviews&review=${id}`, read_at: null });
  const world = (notices: Row[]) =>
    serve({
      tables: {
        companies: [companyRow()],
        notification_prefs: [{ company_id: CO, user_id: USER, email: ["reviews"], sms: [], push: ["reviews"] }],
        profiles: [{ user_id: USER, email: "mia@radford.example", phone: null, full_name: "Mia" }],
        push_subscriptions: [{ id: "phone-1", user_id: USER, endpoint: "https://push.example/1", p256dh: "k", auth: "a" }],
      },
      rpc: { claim_notifications: () => notices, sub_notice_contacts: () => [] },
    });

  it("go by push, and by email only for 1 and 2 stars, which come first", async () => {
    world([notice("review", "Lou left a 5-star review", "n1"), notice("review_low", "Max left a 1-star review", "n2")]);
    expect(await deliverNotifications({ ...env, RESEND_API_KEY: "re_test", EMAIL_FROM: "Crewtavo <noreply@example.com>" })).toMatchObject({ email: 1, push: 2 });
    expect(sendEmail.mock.calls[0]![1]).toMatchObject({ subject: "Max left a 1-star review" });
    expect(sendPush.mock.calls.map((c) => c[2].title)).toEqual(["Max left a 1-star review", "Lou left a 5-star review"]);
  });

  it("lead to Marketing → Reviews when there are many at once", async () => {
    world(["a", "b", "c", "d"].map((id) => notice("review", `Reviewer ${id} left a 5-star review`, id)));
    await deliverNotifications(env);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendPush.mock.calls[0]![2]).toMatchObject({ link: "/marketing?tab=reviews" });
  });
});

describe("names", () => {
  // packages/core/src/reviews.ts nameKey mirrors private.name_key: the same lists, in the same order.
  it("are folded with exactly the lists the database's private.name_key uses", () => {
    const migration = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261031000300_google_reviews.sql", import.meta.url)), "utf8");
    const sql = /translate\(\n.*\n\s*'((?:[^']|'')*)',\n\s*'([^']*)'\)/.exec(migration)!;
    expect(sql[1]!.replace(/''/g, "'")).toBe(NAME_FOLDS.from);
    expect(sql[2]).toBe(NAME_FOLDS.to);
    for (const [letter, plain] of NAME_FOLDS.pairs) expect(migration).toContain(`'${letter}', '${plain}'`);
    expect(migration).toContain("[^abcdefghijklmnopqrstuvwxyz0123456789]+");
    expect(migration).toContain("normalize(coalesce(p_name, ''), nfc)");
  });
});
