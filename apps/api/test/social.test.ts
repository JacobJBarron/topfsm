/**
 * Social posting (integrations/meta.ts, services/metaConnect.ts, services/social.ts, routes/social.ts,
 * the Facebook & Instagram parts of routes/apps.ts and the public picture route): signing in with
 * the business's own Meta app (its keys, a Configuration ID, the long-lived token, the Page and its
 * Instagram account, signing in again, signing out), posting to Facebook (one photo, several, words
 * alone), Instagram (one photo, a carousel, a container still being made, the daily limit) and Google,
 * each network posted at most once (a partial failure retried, a send that may have gone checked by
 * its caption and never repeated, settled by a person), sign-ins that stopped working (the Page's,
 * which stops posting, and the person's, which doesn't), the app not Live, scheduling with a fake
 * clock, Marketing uninstalled, the routes' checks, the pictures' public links, and Suggest a caption.
 *
 * PostgREST and Storage are stand-ins kept in memory, with the database's functions acted out as
 * simply as they're needed (what they really do is in supabase/tests/social_posts_test.sql). Meta and
 * Google answer over a stubbed fetch, and Claude is mocked: nothing reaches them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { DEFAULT_REVIEW_CAPTION, postStatusOf } from "@crewtavo/core/social";
import { encode } from "jpeg-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson, signToken } from "../src/lib/crypto";

vi.mock("../src/services/ai", async (original) => {
  const real = await original<typeof import("../src/services/ai")>();
  return { ...real, complete: vi.fn(real.complete) };
});

const ai = await import("../src/services/ai");
const { app } = await import("../src/app");
const { adminClient } = await import("../src/lib/supabase");
const { postDueSocial, reviewGoneWords, tidySocialImages, timing } = await import("../src/services/social");
const { loadSecret } = await import("../src/integrations/tokens");
const { metaProblem, GRAPH_VERSION } = await import("../src/integrations/meta");
const complete = vi.mocked(ai.complete);

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};
const CO = "00000000-0000-4000-8000-0000000000c1";
const USER = "00000000-0000-4000-8000-0000000000e1";
const ANA = "00000000-0000-4000-8000-0000000000a1";
const BEA = "00000000-0000-4000-8000-0000000000a2";
const JOB = "00000000-0000-4000-8000-0000000000f1";
const PAGE = "111";
const IG = "222";
const G = `/${GRAPH_VERSION}`;

type Row = Record<string, any>;
interface Call {
  method: string;
  host: string;
  path: string;
  params: URLSearchParams;
  body: any;
  auth: string | null;
}
interface World {
  tables: Record<string, Row[]>;
  files: Map<string, Uint8Array>;
  rpc: Record<string, (body: any, world: World) => unknown>;
  outside: (call: Call) => unknown;
  calls: Call[];
  pending: number;
}

const now = () => new Date().toISOString();
const KEYS: Record<string, string[]> = { integrations: ["company_id", "provider"], integration_secrets: ["company_id", "provider"], review_syncs: ["company_id"], social_post_networks: ["post_id", "network"] };
const NOT_FILTERS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns", "or"]);

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
    if (filter.startsWith("gt.") && !(value != null && String(value) > filter.slice(3))) return false;
    if (filter.startsWith("gte.") && !(value != null && Number(value) >= Number(filter.slice(4)))) return false;
    if (filter.startsWith("ov.{") && !(Array.isArray(value) && filter.slice(4, -1).split(",").some((v) => value.includes(v)))) return false;
  }
  return true;
}

const marketingOn = (w: World, company: string) => w.tables.companies!.find((c) => c.id === company)?.settings?.marketing?.enabled === true;

/** The database's functions, as simply as the API needs them to act. */
function functions(): World["rpc"] {
  const postOf = (w: World, id: string) => w.tables.social_posts!.find((p) => p.id === id);
  const netsOf = (w: World, id: string) => w.tables.social_post_networks!.filter((n) => n.post_id === id);
  const finish = (w: World, p: Row) => {
    const status = postStatusOf(netsOf(w, p.id) as Array<{ status: string; error_kind?: string | null }>);
    if (!status || status === "posting") return status;
    Object.assign(p, { status, finished_at: now(), claim: null, locked_until: null });
    for (const img of w.tables.social_post_images!.filter((i) => i.post_id === p.id)) {
      img.expires_at = new Date(Math.min(Date.parse(img.expires_at), Date.now() + 7 * 86_400_000)).toISOString();
    }
    if (["failed", "partly_posted", "check"].includes(status) && marketingOn(w, p.company_id)) w.tables.notifications!.push({ company_id: p.company_id, user_id: p.created_by ?? USER, kind: "social_failed", title: status });
    return status;
  };
  const lapsed = (p: Row) => !p.locked_until || Date.parse(p.locked_until) < Date.now();
  return {
    rate_limit_hit: () => true,
    social_photo_facts: (b, w) => w.tables.attachments!.filter((a) => a.company_id === b.p_company && b.p_ids.includes(a.id)).map((a) => {
      const client = w.tables.clients!.find((c) => c.id === a.client_id);
      const problem = !/^image\/(jpe?g|png)$/.test(a.content_type) ? "format" : !client ? "no_client" : client.social_photos_opt_out ? "client_opt_out" : null;
      return { id: a.id, path: a.path, content_type: a.content_type, shareable: a.shareable, client_id: a.client_id ?? null, job_id: a.job_id ?? null, problem };
    }),
    social_photos: (b, w) => w.tables.attachments!.filter((a) => a.company_id === b.p_company && a.shareable).map((a) => ({ id: a.id, path: a.path, created_at: a.created_at, job_id: a.job_id, job_number: 12, job_title: "Cleanup", visit_on: null, client_ref: "abc" })),
    claim_social_posts: (b, w) => {
      for (const p of w.tables.social_posts!) {
        if (p.status !== "posting" || !lapsed(p) || (b.p_post && p.id !== b.p_post)) continue;
        const sending = netsOf(w, p.id).filter((n) => n.status === "sending");
        if (!sending.length) continue;
        for (const n of sending) Object.assign(n, { status: "unknown", error: "Crewtavo stopped partway, so it may have posted.", error_kind: null });
        Object.assign(p, { claim: null, locked_until: null });
        finish(w, p);
      }
      const out: Row[] = [];
      for (const p of [...w.tables.social_posts!].sort((a, c) => String(a.scheduled_for ?? a.created_at).localeCompare(String(c.scheduled_for ?? c.created_at)))) {
        if (out.length >= (b.p_limit ?? 1)) break;
        if (b.p_post && p.id !== b.p_post) continue;
        if (!marketingOn(w, p.company_id) || p.stop_kind) continue;
        const due = (p.status === "scheduled" && Date.parse(p.scheduled_for) <= Date.now())
          || (p.status === "posting" && lapsed(p) && netsOf(w, p.id).some((n) => (n.status === "waiting" || n.status === "retry") && (!n.next_attempt_at || Date.parse(n.next_attempt_at) <= Date.now())));
        if (!due) continue;
        Object.assign(p, { status: "posting", started_at: p.started_at ?? now(), claim: crypto.randomUUID(), locked_until: new Date(Date.now() + (b.p_hold_seconds ?? 300) * 1000).toISOString() });
        for (const network of p.networks) {
          if (!netsOf(w, p.id).some((n) => n.network === network)) w.tables.social_post_networks!.push({ post_id: p.id, company_id: p.company_id, network, status: "waiting", attempts: 0, tries: 0, first_tried_at: null, next_attempt_at: null, steps: {}, sending_at: null, external_id: null, permalink: null, error: null, error_kind: null });
        }
        out.push({ id: p.id, company_id: p.company_id, claim: p.claim });
      }
      return out;
    },
    save_social_steps: (b, w) => {
      const p = postOf(w, b.p_post);
      if (!p || p.claim !== b.p_claim || p.stop_kind) return false;
      const n = netsOf(w, p.id).find((x) => x.network === b.p_network);
      if (!n || (n.status !== "waiting" && n.status !== "retry")) return false;
      n.steps = b.p_steps;
      return true;
    },
    begin_social_network: (b, w) => {
      const p = postOf(w, b.p_post);
      if (!p || p.claim !== b.p_claim || p.status !== "posting" || p.stop_kind || !marketingOn(w, p.company_id)) return false;
      const n = netsOf(w, p.id).find((x) => x.network === b.p_network);
      if (!n || (n.status !== "waiting" && n.status !== "retry")) return false;
      Object.assign(n, { status: "sending", attempts: n.attempts + 1, sending_at: now() });
      return true;
    },
    end_social_network: (b, w) => {
      const p = postOf(w, b.p_post);
      const n = p && netsOf(w, p.id).find((x) => x.network === b.p_network);
      if (!p || !n) return null;
      const late = b.p_status === "posted" && b.p_external_id && (n.status === "sending" || n.status === "unknown");
      if (!late && p.claim !== b.p_claim) return null;
      if (b.p_status === "posted" && !late && n.status !== "sending") return null;
      if (b.p_status === "unknown" && n.status !== "sending") return null;
      if (["retry", "failed", "skipped"].includes(b.p_status) && !["waiting", "retry", "sending"].includes(n.status)) return null;
      // A post someone stopped: what would try again is skipped.
      if (b.p_status === "retry" && p.stop_kind) Object.assign(b, { p_status: "skipped", p_kind: p.stop_kind, p_error: p.stop_kind === "cancelled" ? "Cancelled" : "Marketing was uninstalled" });
      Object.assign(n, {
        status: b.p_status,
        external_id: b.p_status === "posted" ? b.p_external_id : n.external_id,
        permalink: b.p_status === "posted" ? b.p_permalink : n.permalink,
        error: b.p_status === "posted" ? null : b.p_error,
        error_kind: b.p_status === "posted" || b.p_status === "unknown" ? null : b.p_kind,
        next_attempt_at: b.p_status === "retry" ? b.p_retry_at : null,
        tries: b.p_status === "retry" ? n.tries + 1 : n.tries,
        first_tried_at: b.p_status === "retry" ? (n.first_tried_at ?? now()) : n.first_tried_at,
        steps: b.p_steps ?? n.steps,
      });
      if (netsOf(w, p.id).some((x) => ["waiting", "sending", "retry"].includes(x.status))) return "posting";
      return finish(w, p);
    },
    release_social_post: (b, w) => {
      const p = postOf(w, b.p_post);
      if (p && p.claim === b.p_claim) Object.assign(p, { claim: null, locked_until: null });
      return true;
    },
    cancel_social_post: (b, w) => {
      const p = postOf(w, b.p_post);
      if (!p) return null;
      if (p.status === "scheduled") return (p.status = "cancelled");
      if (p.status !== "posting") return null;
      for (const n of netsOf(w, p.id)) if (n.status === "waiting" || n.status === "retry") Object.assign(n, { status: "skipped", error_kind: "cancelled" });
      p.stop_kind = "cancelled";
      return finish(w, p);
    },
    retry_social_post: (b, w) => {
      const p = postOf(w, b.p_post);
      if (!p || !["failed", "partly_posted", "check"].includes(p.status) || !marketingOn(w, p.company_id)) return 0;
      const again = netsOf(w, p.id).filter((n) => n.status === "failed" || n.status === "skipped");
      for (const n of again) Object.assign(n, { status: "waiting", next_attempt_at: now(), tries: 0, first_tried_at: null, error: null, error_kind: null, steps: {} });
      if (again.length) Object.assign(p, { status: "posting", finished_at: null, claim: null, locked_until: null, stop_kind: null });
      return again.length;
    },
    resolve_social_network: (b, w) => {
      const p = postOf(w, b.p_post);
      const n = p && netsOf(w, p.id).find((x) => x.network === b.p_network && x.status === "unknown");
      if (!p || !n) return null;
      if (b.p_posted) {
        Object.assign(n, { status: "posted", permalink: b.p_permalink });
        return finish(w, p);
      }
      if (!marketingOn(w, p.company_id)) return null;
      Object.assign(n, { status: "waiting", next_attempt_at: now() });
      Object.assign(p, { status: "posting", finished_at: null, stop_kind: null });
      return "posting";
    },
    social_set_auto: (b, w) => {
      const company = w.tables.companies!.find((c) => c.id === b.p_company)!;
      company.settings = { ...company.settings, social: { auto: { enabled: b.p_enabled, networks: b.p_networks } } };
      let cancelled = 0;
      if (!b.p_enabled) for (const p of w.tables.social_posts!) if (p.company_id === b.p_company && p.automatic && p.status === "scheduled") (p.status = "cancelled"), cancelled++;
      return { enabled: b.p_enabled, networks: b.p_networks, cancelled };
    },
    note_meta_access: (b, w) => {
      (w.tables.access ??= []).push(b);
      const row = w.tables.integrations!.find((i) => i.company_id === b.p_company && i.provider === "meta");
      if (!row) return false;
      if (b.p_kind === "ok") {
        const { access_notice: _, ...rest } = row.settings ?? {};
        row.settings = rest;
        return false;
      }
      if (!marketingOn(w, b.p_company) || row.settings?.access_notice === b.p_kind) return false;
      row.settings = { ...row.settings, access_notice: b.p_kind };
      return true;
    },
  };
}

function serve(over: Partial<World> = {}): World {
  const world: World = {
    tables: {
      memberships: [{ company_id: CO, user_id: USER, role: "owner", role_id: null, subcontractor_id: null, active: true }],
      company_roles: [], companies: [], integrations: [], integration_secrets: [], reviews: [], review_syncs: [], social_posts: [], social_post_networks: [],
      social_post_images: [], notifications: [], attachments: [], clients: [], properties: [], job_line_items: [],
      ...over.tables,
    },
    files: over.files ?? new Map(),
    rpc: { ...functions(), ...over.rpc },
    outside: over.outside ?? (() => undefined),
    calls: [],
    pending: 0,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    world.pending++;
    try {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const raw = init?.body;
      const text = typeof raw === "string" ? raw : raw instanceof URLSearchParams ? raw.toString() : "";
      let body: any;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = Object.fromEntries(new URLSearchParams(text));
      }
      const call: Call = { method, host: url.host, path: url.pathname, params: url.searchParams, body, auth: headers.get("authorization") };
      world.calls.push(call);
      if (url.host !== "example.supabase.co") {
        const out = await world.outside(call);
        if (out === undefined) throw new Error(`Nothing answers ${method} ${url}`);
        return out instanceof Response ? out : Response.json(out);
      }
      if (url.pathname === "/auth/v1/user") return Response.json({ id: USER, aud: "authenticated", role: "authenticated" });
      if (url.pathname.startsWith("/storage/v1/")) {
        const rest = url.pathname.replace("/storage/v1/", "");
        if (rest === "object/sign/files") return Response.json((body.paths as string[]).map((path) => ({ path, signedURL: `/object/sign/files/${path}?token=t`, error: null })));
        if (rest === "object/files" && method === "DELETE") {
          for (const path of body.prefixes as string[]) world.files.delete(path);
          return Response.json([]);
        }
        const path = decodeURIComponent(rest.replace(/^object\/files\//, ""));
        if (method === "POST" || method === "PUT") {
          world.files.set(path, raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(await new Response(raw as BodyInit).arrayBuffer()));
          return Response.json({ Key: `files/${path}`, Id: path });
        }
        const file = world.files.get(path);
        return file ? new Response(file) : Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 });
      }
      const path = url.pathname.replace(/^\/rest\/v1\//, "");
      if (path.startsWith("rpc/")) {
        const fn = world.rpc[path.slice(4)];
        if (!fn) throw new Error(`No stand-in for ${path}`);
        const out = fn(body, world);
        return out instanceof Response ? out : Response.json(out ?? null);
      }
      const rows = (world.tables[path] ??= []);
      const single = headers.get("accept")?.includes("vnd.pgrst.object");
      const select = url.searchParams.get("select") ?? "";
      const embed = (r: Row) => (path === "social_posts" && select.includes("results:social_post_networks") ? { ...r, results: world.tables.social_post_networks!.filter((n) => n.post_id === r.id) } : r);
      const reply = (data: Row[]) => (single ? (data[0] ? Response.json(embed(data[0])) : Response.json({ message: "No rows" }, { status: 406 })) : Response.json(data.map(embed)));
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
          Object.assign(existing, item);
          out.push(existing);
        } else {
          const row = { id: crypto.randomUUID(), created_at: now(), ...item };
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

async function settle(world: World) {
  for (let quiet = 0; quiet < 3; ) {
    await new Promise((r) => setTimeout(r, 5));
    quiet = world.pending ? 0 : quiet + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Meta and Google, faked
// ---------------------------------------------------------------------------------------------

interface Fake {
  pages: Row[];
  permissions: Array<{ permission: string; status: string }>;
  limit: { used: number; total: number };
  status: string[];
  recentFb: Row[];
  recentIg: Row[];
  counter: number;
  /** Answers a call first, when it returns something. */
  override?: (call: Call) => unknown;
}
const ALL = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management", "instagram_basic", "instagram_content_publish"];
const page = (id: string, name: string, over: Row = {}) => ({ id, name, access_token: `page-token-${id}`, tasks: ["CREATE_CONTENT", "MANAGE"], picture: { data: { url: `https://scontent.example/${id}.jpg` } }, instagram_business_account: { id: IG, username: "radfordlawn" }, ...over });
function fake(over: Partial<Fake> = {}): Fake {
  return { pages: [page(PAGE, "Radford Lawn Care")], permissions: ALL.map((permission) => ({ permission, status: "granted" })), limit: { used: 3, total: 50 }, status: ["FINISHED"], recentFb: [], recentIg: [], counter: 0, ...over };
}
const graphError = (code: number, subcode?: number, message = "An error", status = 400) =>
  Response.json({ error: { message, type: "OAuthException", code, ...(subcode ? { error_subcode: subcode } : {}) } }, { status });

function graph(f: Fake) {
  return (call: Call) => {
    const first = f.override?.(call);
    if (first !== undefined) return first;
    if (call.host === "mybusiness.googleapis.com" && call.method === "POST" && call.path.endsWith("/localPosts")) {
      return { name: "accounts/1/locations/9/localPosts/lp1", searchUrl: "https://local.google.com/place?id=9&use=posts&lpsid=lp1", state: "LIVE", summary: call.body.summary };
    }
    if (call.host === "mybusiness.googleapis.com" && call.method === "GET" && call.path.endsWith("/localPosts")) return { localPosts: [] };
    if (call.host !== "graph.facebook.com") return undefined;
    const p = call.path.replace(G, "");
    const form = call.body ?? {};
    if (p === "/oauth/access_token" && call.params.get("code")) return { access_token: "short-token", token_type: "bearer", expires_in: 3600 };
    if (p === "/oauth/access_token" && call.params.get("grant_type") === "fb_exchange_token") return { access_token: "long-token", token_type: "bearer", expires_in: 5_184_000 };
    if (p === "/me") return { id: "u1", name: "Mia Owner" };
    if (p === "/me/permissions") return { data: f.permissions };
    if (p === "/me/accounts") return { data: f.pages };
    if (p === "/debug_token") return { data: { is_valid: true, data_access_expires_at: Math.floor(Date.now() / 1000) + 90 * 86_400 } };
    if (p === "/u1/permissions" && call.method === "DELETE") return { success: true };
    if (p === `/${PAGE}` && call.method === "GET") return { id: PAGE, name: "Radford Lawn Care" };
    if (p === `/${PAGE}/photos` && call.method === "POST") return form.published === "false" ? { id: `unpub${++f.counter}` } : { id: "photo1", post_id: `${PAGE}_post1` };
    if (p === `/${PAGE}/feed` && call.method === "POST") return { id: `${PAGE}_feed1` };
    if (p === `/${PAGE}/posts`) return { data: f.recentFb };
    if (p === `/${IG}/content_publishing_limit`) return { data: [{ quota_usage: f.limit.used, config: { quota_total: f.limit.total, quota_duration: 86_400 } }] };
    if (p === `/${IG}/media` && call.method === "POST") return { id: `container${++f.counter}` };
    if (p === `/${IG}/media` && call.method === "GET") return { data: f.recentIg };
    if (p === `/${IG}/media_publish`) return { id: "igmedia1" };
    if (call.params.get("fields") === "status_code") return { status_code: f.status.length > 1 ? f.status.shift() : f.status[0] };
    if (call.params.get("fields") === "permalink_url") return { permalink_url: `https://www.facebook.com/${p.slice(1)}` };
    if (call.params.get("fields") === "permalink") return { permalink: "https://www.instagram.com/p/abc123/" };
    return undefined;
  };
}
const graphCalls = (w: World, path: string, method?: string) => w.calls.filter((c) => c.host === "graph.facebook.com" && c.path === `${G}${path}` && (!method || c.method === method));

// ---------------------------------------------------------------------------------------------
// The business
// ---------------------------------------------------------------------------------------------

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: USER, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 30 * 86_400 })}.c2ln`;
const request = (path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(`/api${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "X-Company-Id": CO, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }, env);

/** A JPEG straight from a phone: EXIF with GPS. */
function phoneJpeg(): Uint8Array {
  const data = new Uint8Array(40 * 30 * 4).fill(180);
  const plain = new Uint8Array(encode({ data, width: 40, height: 30 }, 90).data);
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, ...[..."GPSLatitude37.12N"].map((c) => c.charCodeAt(0))];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, exif.length + 2, ...exif, ...plain.subarray(2)]);
}

const companyRow = (settings: Row = {}) => ({ id: CO, name: "Radford Lawn Care", timezone: "America/New_York", website: "radfordlawn.example", settings: { marketing: { enabled: true }, ...settings } });
const keys = { client_id: "1234567890123", client_secret: "abcdefabcdefabcdefabcdefabcdef12" };
async function metaSecret(extra: Row = {}, access_token = "long-token") {
  return { company_id: CO, provider: "meta", ciphertext: await encryptJson(env, { access_token, expires_at: Date.now() + 50 * 86_400_000, extra: { ...keys, user_id: "u1", page_id: PAGE, page_token: `page-token-${PAGE}`, ig_user_id: IG, ...extra } }) };
}
const metaRow = (settings: Row = {}, status = "connected") => ({ company_id: CO, provider: "meta", status, account_label: "Radford Lawn Care", last_error: null, settings: { user_id: "u1", page_id: PAGE, page_name: "Radford Lawn Care", ig_user_id: IG, ig_username: "radfordlawn", granted: ALL, live_confirmed_at: "2026-10-30T00:00:00Z", ...settings } });
const photo = (id: string, over: Row = {}) => ({ id, company_id: CO, owner_type: "visit", path: `${CO}/visit/v1/${id}.jpg`, content_type: "image/jpeg", shareable: true, client_id: ANA, job_id: JOB, created_at: now(), ...over });

/** A business connected to Facebook & Instagram (and Google, with `google`), with photos OK to share. */
async function connected(over: { company?: Row; meta?: Row; metaStatus?: string; extra?: Row; google?: boolean | string; tables?: Record<string, Row[]> } = {}) {
  const ids = ["1", "2", "3"].map((n) => `00000000-0000-4000-8000-00000000aa0${n}`);
  const files = new Map<string, Uint8Array>(ids.map((id) => [`${CO}/visit/v1/${id}.jpg`, phoneJpeg()]));
  return {
    files,
    ids,
    tables: {
      companies: [companyRow(over.company)],
      integrations: [
        metaRow(over.meta, over.metaStatus),
        ...(over.google ? [{ company_id: CO, provider: "google_business", status: "connected", settings: { location: "locations/9" } }] : []),
      ],
      integration_secrets: [await metaSecret(over.extra), ...(over.google ? [{ company_id: CO, provider: "google_business", ciphertext: await encryptJson(env, { access_token: "gbp-token", refresh_token: "r", expires_at: Date.now() + 3_600_000 }) }] : [])],
      review_syncs: over.google ? [{ company_id: CO, account: "accounts/1", location_id: "locations/9", problem: typeof over.google === "string" ? over.google : null }] : [],
      attachments: ids.map((id) => photo(id)),
      clients: [{ id: ANA, company_id: CO, display_name: "Ana Green", company_name: null, billing_address: null, social_photos_opt_out: false }, { id: BEA, company_id: CO, display_name: "Bea Stone", company_name: null, billing_address: null, social_photos_opt_out: true }],
      properties: [{ company_id: CO, client_id: ANA, line1: "14 Oak St" }],
      job_line_items: [{ company_id: CO, job_id: JOB, name: "Spring cleanup" }],
      ...over.tables,
    },
  };
}

/** A post due now, as the routes save one. */
const due = (over: Row = {}) => ({
  id: crypto.randomUUID(), company_id: CO, source: "photos", attachment_ids: [] as string[], caption: "Fresh mulch and crisp edges", caption_by: "person",
  networks: ["facebook"], status: "scheduled", scheduled_for: new Date(Date.now() - 60_000).toISOString(), automatic: false, created_by: USER, created_at: now(), ...over,
});
const net = (w: World, post: string, network: string) => w.tables.social_post_networks!.find((n) => n.post_id === post && n.network === network)!;
const postRow = (w: World, id: string) => w.tables.social_posts!.find((p) => p.id === id)!;
const run = async (w: World) => {
  await postDueSocial(env);
  await settle(w);
};

beforeEach(() => {
  complete.mockReset();
  timing.pollMs = 0;
  timing.waitMs = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------

describe("signing in with the business's own Meta app", () => {
  const callback = async (w: World) => {
    const state = await signToken(env, { company: CO, user: USER, provider: "meta", nonce: "n1", exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await app.request(`/api/apps/meta/callback?${new URLSearchParams({ state, code: "code-1" })}`, { headers: { Cookie: "crewtavo_oauth_nonce=n1" } }, env);
    await settle(w);
    return new URL(res.headers.get("location")!);
  };
  const keysOnly = async (extra: Row = {}) => ({
    companies: [companyRow()],
    integrations: [{ company_id: CO, provider: "meta", status: "disconnected", settings: {} }],
    integration_secrets: [{ company_id: CO, provider: "meta", ciphertext: await encryptJson(env, { extra: { ...keys, ...extra } }) }],
  });

  it("saves the app's keys with a Configuration ID, and sign-in uses it", async () => {
    const w = serve({ tables: { companies: [companyRow()] } });
    const res = await request("/apps/meta/app-keys", { method: "PUT", body: { ...keys, config_id: "987654321" } });
    expect(res.status).toBe(200);
    expect((await loadSecret(env, adminClient(env), CO, "meta"))?.extra).toEqual({ ...keys, config_id: "987654321" });
    const connect = new URL(((await (await request("/apps/meta/connect", { method: "POST" })).json()) as { authorization_url: string }).authorization_url);
    expect(connect.origin + connect.pathname).toBe(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    expect(connect.searchParams.get("config_id")).toBe("987654321");
    expect(connect.searchParams.get("scope")).toBeNull();
    expect(connect.searchParams.get("client_id")).toBe(keys.client_id);
    expect(connect.searchParams.get("redirect_uri")).toBe("https://ops.example.com/api/apps/meta/callback");
    void w;
  });

  it("asks for the permissions itself without one, and for the business Page ones on Reconnect", async () => {
    serve({ tables: await keysOnly() });
    const plain = new URL(((await (await request("/apps/meta/connect", { method: "POST" })).json()) as { authorization_url: string }).authorization_url);
    expect(plain.searchParams.get("scope")).toBe(ALL.join(","));
    const ads = new URL(((await (await request("/apps/meta/connect?ads=1", { method: "POST" })).json()) as { authorization_url: string }).authorization_url);
    expect(ads.searchParams.get("scope")).toBe([...ALL, "ads_management", "ads_read"].join(","));
    expect(ads.searchParams.get("auth_type")).toBe("rerequest");
  });

  it("swaps the code for a long-lived token and picks the only Page, with its Instagram account", async () => {
    const f = fake();
    const w = serve({ tables: await keysOnly(), outside: graph(f) });
    const back = await callback(w);
    expect([back.pathname, back.searchParams.get("status"), back.searchParams.get("pending")]).toEqual(["/apps/meta", "connected", null]);
    const code = graphCalls(w, "/oauth/access_token").find((c) => c.params.get("code"))!;
    expect(code.params.get("client_secret")).toBe(keys.client_secret);
    const exchange = graphCalls(w, "/oauth/access_token").find((c) => c.params.get("grant_type") === "fb_exchange_token")!;
    expect(Object.fromEntries(exchange.params)).toMatchObject({ client_id: keys.client_id, client_secret: keys.client_secret, fb_exchange_token: "short-token" });
    const secret = await loadSecret(env, adminClient(env), CO, "meta");
    expect(secret).toMatchObject({ access_token: "long-token", extra: { ...keys, user_id: "u1", page_id: PAGE, page_token: `page-token-${PAGE}`, ig_user_id: IG } });
    expect(w.tables.integrations![0]).toMatchObject({ status: "connected", account_label: "Radford Lawn Care", settings: { page_id: PAGE, ig_user_id: IG, ig_username: "radfordlawn", granted: ALL, pages: 1 } });
  });

  it("names a permission not granted, and leaves two Pages to pick", async () => {
    const f = fake({ permissions: ALL.map((permission) => ({ permission, status: permission === "pages_manage_posts" ? "declined" : "granted" })) });
    const w = serve({ tables: await keysOnly(), outside: graph(f) });
    expect((await callback(w)).searchParams.get("pending")).toBe("permissions");
    const apps = (await (await request("/apps")).json()) as { apps: Array<{ id: string; meta?: Row }> };
    expect(apps.apps.find((a) => a.id === "meta")!.meta).toMatchObject({ missing: ["pages_manage_posts"], problem: "permissions" });

    const two = fake({ pages: [page(PAGE, "Radford Lawn Care"), page("333", "Blacksburg Lawn Care")] });
    const w2 = serve({ tables: await keysOnly(), outside: graph(two) });
    expect((await callback(w2)).searchParams.get("pending")).toBe("pick");
    expect(w2.tables.integrations![0]!.settings.page_id).toBeUndefined();
    expect((await loadSecret(env, adminClient(env), CO, "meta"))?.extra?.page_token).toBeUndefined();
  });

  it("keeps the Page picked when signing in again still reaches it, with a fresh token, and asks again when it doesn't", async () => {
    const f = fake({ pages: [page("333", "Blacksburg"), page(PAGE, "Radford Lawn Care", { access_token: "fresh-page-token" })] });
    const w = serve({ tables: { companies: [companyRow()], integrations: [metaRow()], integration_secrets: [await metaSecret()] }, outside: graph(f) });
    expect((await callback(w)).searchParams.get("pending")).toBeNull();
    expect((await loadSecret(env, adminClient(env), CO, "meta"))?.extra).toMatchObject({ page_id: PAGE, page_token: "fresh-page-token", ig_user_id: IG });
    expect(w.tables.integrations![0]!.settings.live_confirmed_at).toBe("2026-10-30T00:00:00Z");

    const gone = fake({ pages: [page("333", "Blacksburg"), page("444", "Christiansburg")] });
    const w2 = serve({ tables: { companies: [companyRow()], integrations: [metaRow()], integration_secrets: [await metaSecret()] }, outside: graph(gone) });
    expect((await callback(w2)).searchParams.get("pending")).toBe("pick");
    expect(w2.tables.integrations![0]!.settings.page_id).toBeUndefined();
    expect((await loadSecret(env, adminClient(env), CO, "meta"))?.extra).not.toHaveProperty("page_token");
  });

  it("says when Meta turns the App ID and secret down", async () => {
    const f = fake({ override: (c) => (c.path === `${G}/oauth/access_token` ? graphError(101, undefined, "Error validating client secret.") : undefined) });
    const w = serve({ tables: await keysOnly(), outside: graph(f) });
    const back = await callback(w);
    expect(back.searchParams.get("status")).toBe("error");
    expect(back.searchParams.get("message")).toBe("Meta didn't accept the App ID and secret. Check them on this page, then connect again.");
  });

  it("picks the Page from Meta's own list, never from what the browser says, and refuses one it can't post as", async () => {
    const f = fake({ pages: [page(PAGE, "Radford Lawn Care", { access_token: "from-meta" }), page("333", "Fan page", { tasks: ["ANALYZE"] })] });
    const w = serve({ tables: { companies: [companyRow()], integrations: [metaRow({ page_id: undefined })], integration_secrets: [await metaSecret({ page_id: undefined, page_token: undefined })] }, outside: graph(f) });
    const pages = (await (await request("/apps/meta/pages")).json()) as { pages: Row[] };
    expect(pages.pages.map((p) => [p.id, p.can_post])).toEqual([[PAGE, true], ["333", false]]);
    const res = await request("/apps/meta/page", { method: "PUT", body: { page_id: PAGE, instagram: false, page_token: "from-the-browser" } });
    expect(res.status).toBe(200);
    expect((await loadSecret(env, adminClient(env), CO, "meta"))?.extra).toMatchObject({ page_id: PAGE, page_token: "from-meta" });
    expect((await loadSecret(env, adminClient(env), CO, "meta"))?.extra).not.toHaveProperty("ig_user_id");
    expect(w.tables.integrations![0]!.settings).toMatchObject({ page_id: PAGE, page_instagram: { id: IG, username: "radfordlawn" } });
    expect(w.tables.integrations![0]!.settings.ig_user_id).toBeUndefined();
    expect((await request("/apps/meta/page", { method: "PUT", body: { page_id: "333", instagram: false } })).status).toBe(409);
  });

  it("asks for the business Page permissions when a Page in a portfolio posts to Instagram", async () => {
    const f = fake({ pages: [page(PAGE, "Radford Lawn Care", { business: { id: "b1", name: "Radford Holdings" } })] });
    serve({ tables: { companies: [companyRow()], integrations: [metaRow()], integration_secrets: [await metaSecret()] }, outside: graph(f) });
    const res = (await (await request("/apps/meta/page", { method: "PUT", body: { page_id: PAGE, instagram: true } })).json()) as Row;
    expect(res.needs_business_permissions).toBe(true);
  });

  it("signs out at Meta with the app's own token on disconnect, keeping the app's keys", async () => {
    const f = fake();
    const w = serve({ tables: { companies: [companyRow()], integrations: [metaRow()], integration_secrets: [await metaSecret({}, "expired-user-token")] }, outside: graph(f) });
    await request("/apps/meta/disconnect", { method: "POST" });
    const revoke = graphCalls(w, "/u1/permissions", "DELETE");
    expect(revoke).toHaveLength(1);
    expect(revoke[0]!.auth).toBe(`Bearer ${keys.client_id}|${keys.client_secret}`);
    expect((await loadSecret(env, adminClient(env), CO, "meta"))?.extra).toEqual(keys);
    // The same app is still Live, so connecting again doesn't ask for it again.
    expect(w.tables.integrations![0]).toMatchObject({ status: "disconnected" });
    expect(w.tables.integrations![0]!.settings).toEqual({ live_confirmed_at: "2026-10-30T00:00:00Z" });
  });

  it("starts a new Meta app from nothing: signed out, no Page, not Live", async () => {
    const f = fake();
    const w = serve({ tables: { companies: [companyRow()], integrations: [metaRow()], integration_secrets: [await metaSecret()] }, outside: graph(f) });
    await request("/apps/meta/app-keys", { method: "PUT", body: { client_id: "999999999999", client_secret: "ffffffffffffffffffffffffffffffff" } });
    expect(graphCalls(w, "/u1/permissions", "DELETE")).toHaveLength(1);
    expect(w.tables.integrations![0]).toMatchObject({ status: "disconnected" });
    expect(w.tables.integrations![0]!.settings).toEqual({});
    // The same App ID with its secret pasted again is the same app, still Live.
    const same = serve({ tables: { companies: [companyRow()], integrations: [metaRow()], integration_secrets: [await metaSecret()] }, outside: graph(fake()) });
    await request("/apps/meta/app-keys", { method: "PUT", body: { client_id: keys.client_id, client_secret: "ffffffffffffffffffffffffffffffff" } });
    expect(same.tables.integrations![0]!.settings).toEqual({ live_confirmed_at: "2026-10-30T00:00:00Z" });
  });

  it("says what's wrong with a Configuration ID in its own words", async () => {
    serve({ tables: { companies: [companyRow()] } });
    const res = await request("/apps/meta/app-keys", { method: "PUT", body: { ...keys, config_id: "abc-config" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("A Configuration ID is all digits.");
    const spaced = await request("/apps/meta/app-keys", { method: "PUT", body: { ...keys, client_secret: "abc def ghi jkl" } });
    expect(((await spaced.json()) as { error: string }).error).toBe("Paste it without spaces.");
  });
});

describe("the Meta app not Live yet", () => {
  it("is said on the app page and the Social tab until someone says it is", async () => {
    const f = fake();
    const c = await connected({ meta: { live_confirmed_at: null } });
    serve({ tables: c.tables, files: c.files, outside: graph(f) });
    const apps = (await (await request("/apps")).json()) as { apps: Array<{ id: string; meta?: Row }> };
    expect(apps.apps.find((a) => a.id === "meta")!.meta).toMatchObject({ live_confirmed_at: null, page: { id: PAGE } });
    expect(((await (await request("/social")).json()) as Row).networks.facebook.live_confirmed).toBe(false);
    await request("/apps/meta/live", { method: "POST", body: { confirmed: true } });
    expect(((await (await request("/social")).json()) as Row).networks.facebook.live_confirmed).toBe(true);
  });
});

describe("the two sign-ins", () => {
  it("a person's sign-in that ran out only asks for a new one to change the Page: posting goes on", async () => {
    const f = fake({ override: (call) => (call.path === `${G}/me/accounts` ? graphError(190, 463, "Session has expired") : undefined) });
    const c = await connected();
    const w = serve({ tables: c.tables, files: c.files, outside: graph(f) });
    const res = await request("/apps/meta/pages");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Sign in again to change the Page");
    expect(w.tables.integrations![0]).toMatchObject({ status: "connected", settings: { user_token_expired: true } });
    expect(w.tables.access ?? []).toEqual([]);
  });

  it("the Page's sign-in stopping marks the app, tells owners and admins once, and fails Facebook and Instagram", async () => {
    const f = fake({ override: (call) => (call.method === "POST" && call.path.startsWith(`${G}/${PAGE}/`) ? graphError(190, 460, "The session has been invalidated") : call.path === `${G}/${IG}/content_publishing_limit` ? graphError(190, 460) : undefined) });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["facebook", "instagram"] }), due({ id: "00000000-0000-4000-8000-0000000000d2", attachment_ids: [c.ids[1]] })] }, files: c.files, outside: graph(f) });
    await postDueSocial(env, { limit: 1 });
    await settle(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "failed", error_kind: "signin", error: "Sign-in expired. Reconnect Facebook & Instagram in Apps." });
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "failed", error_kind: "signin" });
    expect(w.tables.integrations![0]).toMatchObject({ status: "error", last_error: "Sign-in expired. Reconnect Facebook & Instagram in Apps." });
    expect((w.tables.access ?? []).filter((a) => a.p_kind === "signin")).toHaveLength(1);
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d2", "facebook")).toMatchObject({ status: "failed", error_kind: "signin" });
    expect((w.tables.access ?? []).filter((a) => a.p_kind === "signin")).toHaveLength(1);
  });

  it("Check again reads the Page's own token, and a person's sign-in that ran out doesn't stop posting", async () => {
    const f = fake({ override: (call) => (call.path === `${G}/me/permissions` ? graphError(190, 463) : undefined) });
    const c = await connected();
    const w = serve({ tables: c.tables, files: c.files, outside: graph(f) });
    const res = (await (await request("/apps/meta/check", { method: "POST" })).json()) as Row;
    expect(res.user_sign_in).toBe(false);
    expect(graphCalls(w, `/${PAGE}`, "GET")[0]!.auth).toBe(`Bearer page-token-${PAGE}`);
    expect(w.tables.integrations![0]!.status).toBe("connected");
  });

  it("Check again says when Instagram is linked to the Page but posts don't go to it yet", async () => {
    const f = fake();
    const c = await connected({ meta: { ig_user_id: undefined, ig_username: undefined, page_instagram: null }, extra: { ig_user_id: undefined } });
    serve({ tables: c.tables, files: c.files, outside: graph(f) });
    const res = (await (await request("/apps/meta/check", { method: "POST" })).json()) as Row;
    expect(res).toMatchObject({ user_sign_in: true, missing: [], instagram_linked: true, instagram_used: false, instagram_username: "radfordlawn" });
  });
});

describe("posting to Facebook", () => {
  it("posts one photo with its caption, fetched from a link that names nothing, without its EXIF", async () => {
    const f = fake();
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]] })] }, files: c.files, outside: graph(f) });
    await run(w);
    const photos = graphCalls(w, `/${PAGE}/photos`, "POST");
    expect(photos).toHaveLength(1);
    expect(photos[0]!.body).toMatchObject({ caption: "Fresh mulch and crisp edges", published: "true" });
    expect(photos[0]!.auth).toBe(`Bearer page-token-${PAGE}`);
    expect(photos[0]!.body.url).toMatch(/^https:\/\/ops\.example\.com\/api\/public\/social\/[A-Za-z0-9_-]{32}\.jpg$/);
    expect(photos[0]!.body.url).not.toContain(CO);
    expect(photos[0]!.body.url).not.toContain(c.ids[0]);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "posted", external_id: `${PAGE}_post1`, permalink: `https://www.facebook.com/${PAGE}_post1` });
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("posted");
    const image = w.tables.social_post_images![0]!;
    const stored = w.files.get(image.path)!;
    expect(Buffer.from(stored).includes("Exif")).toBe(false);
    expect(Buffer.from(stored).includes("GPSLatitude")).toBe(false);
    expect(Date.parse(image.expires_at)).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000 + 1000);
  });

  it("posts three photos as unpublished photos attached to one post", async () => {
    const f = fake();
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: c.ids })] }, files: c.files, outside: graph(f) });
    await run(w);
    const uploads = graphCalls(w, `/${PAGE}/photos`, "POST");
    expect(uploads.map((u) => u.body.published)).toEqual(["false", "false", "false"]);
    const feed = graphCalls(w, `/${PAGE}/feed`, "POST");
    expect(feed).toHaveLength(1);
    expect(feed[0]!.body).toMatchObject({ message: "Fresh mulch and crisp edges", "attached_media[0]": '{"media_fbid":"unpub1"}', "attached_media[2]": '{"media_fbid":"unpub3"}' });
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "posted", external_id: `${PAGE}_feed1` });
  });

  it("posts words alone to the Page's feed, and to Google with no picture", async () => {
    const f = fake();
    const c = await connected({ google: true });
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", source: "text", attachment_ids: [], caption: "Booking spring cleanups now", networks: ["facebook", "google"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(graphCalls(w, `/${PAGE}/feed`, "POST")[0]!.body).toEqual({ message: "Booking spring cleanups now" });
    const google = w.calls.find((x) => x.host === "mybusiness.googleapis.com" && x.method === "POST")!;
    expect(google.body).toEqual({ languageCode: "en", topicType: "STANDARD", summary: "Booking spring cleanups now" });
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("posted");
    expect(w.tables.social_post_images).toEqual([]);
  });
});

describe("posting to Instagram", () => {
  it("makes a container and publishes it", async () => {
    const f = fake();
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    const media = graphCalls(w, `/${IG}/media`, "POST");
    expect(media).toHaveLength(1);
    expect(media[0]!.body).toMatchObject({ caption: "Fresh mulch and crisp edges" });
    expect(media[0]!.body.image_url).toMatch(/\/api\/public\/social\/[A-Za-z0-9_-]{32}\.jpg$/);
    expect(graphCalls(w, `/${IG}/media_publish`)[0]!.body).toEqual({ creation_id: "container1" });
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "posted", external_id: "igmedia1", permalink: "https://www.instagram.com/p/abc123/" });
    // Instagram's copy is its own picture, padded into its shapes.
    expect(w.tables.social_post_images!.map((i) => i.variant)).toEqual(["instagram"]);
  });

  it("makes a carousel of three: three items, the carousel, then publishes it", async () => {
    const f = fake();
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: c.ids, networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    const media = graphCalls(w, `/${IG}/media`, "POST");
    expect(media.map((m) => m.body.is_carousel_item ?? m.body.media_type)).toEqual(["true", "true", "true", "CAROUSEL"]);
    expect(media[3]!.body).toMatchObject({ children: "container1,container2,container3", caption: "Fresh mulch and crisp edges" });
    expect(graphCalls(w, `/${IG}/media_publish`)[0]!.body).toEqual({ creation_id: "container4" });
    expect(w.tables.social_post_images!.every((i) => i.width === i.height)).toBe(true);
  });

  it("waits for a container still being made, keeping it, and publishes it next time", async () => {
    const f = fake({ status: ["IN_PROGRESS"] });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "retry", steps: { container: "container1" } });
    expect(graphCalls(w, `/${IG}/media_publish`)).toHaveLength(0);
    f.status = ["FINISHED"];
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 3 * 60_000) });
    await run(w);
    expect(graphCalls(w, `/${IG}/media`, "POST")).toHaveLength(1);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "posted" });
  });

  it("tries again in an hour when the daily limit is used up, saying the real limit", async () => {
    const f = fake({ limit: { used: 100, total: 100 } });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    const n = net(w, "00000000-0000-4000-8000-0000000000d1", "instagram");
    expect(n).toMatchObject({ status: "retry", error_kind: "limit", error: "Instagram's daily limit of 100 posts is used up. Crewtavo tries again in an hour." });
    expect(Date.parse(n.next_attempt_at) - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(graphCalls(w, `/${IG}/media`, "POST")).toHaveLength(0);
  });

  it("asks for the business Page permissions when Instagram refuses a Page in a portfolio", async () => {
    const f = fake({ override: (call) => (call.path === `${G}/${IG}/media` && call.method === "POST" ? graphError(200, undefined, "Requires ads_management permission") : undefined) });
    const c = await connected({ meta: { business_id: "b1", granted: ALL } });
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "failed", error_kind: "permission", error: "Instagram needs the ads_management and ads_read permissions for a Page in a business portfolio. Reconnect with business Page permissions in Apps." });
  });

  it("names the permission Meta says is missing", async () => {
    const f = fake({ override: (call) => (call.path === `${G}/${PAGE}/photos` ? graphError(200, undefined, "(#200) Requires pages_manage_posts permission to manage the object") : undefined) });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "failed", error_kind: "permission", error: "Facebook didn't allow it: the pages_manage_posts permission wasn't granted. Reconnect Facebook & Instagram in Apps." });
  });
});

describe("posting to Google", () => {
  it("makes a STANDARD local post with the photo's link, and keeps its link", async () => {
    const f = fake();
    const c = await connected({ google: true });
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["google"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    const call = w.calls.find((x) => x.host === "mybusiness.googleapis.com" && x.method === "POST")!;
    expect(call.path).toBe("/v4/accounts/1/locations/9/localPosts");
    expect(call.body).toMatchObject({ topicType: "STANDARD", summary: "Fresh mulch and crisp edges", media: [{ mediaFormat: "PHOTO" }] });
    expect(call.body.media[0].sourceUrl).toMatch(/\/api\/public\/social\/[A-Za-z0-9_-]{32}\.jpg$/);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "google")).toMatchObject({ status: "posted", external_id: "accounts/1/locations/9/localPosts/lp1", permalink: "https://local.google.com/place?id=9&use=posts&lpsid=lp1" });
  });

  it("isn't posted while Google hasn't approved access, and Google being busy tries again", async () => {
    const f = fake();
    const c = await connected({ google: "approval" });
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["google"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "google")).toMatchObject({ status: "failed", error_kind: "not_connected", error: "Google Business Profile isn't approved by Google yet." });
    expect(((await (await request("/social")).json()) as Row).networks.google).toMatchObject({ ready: false, reason: "approval" });

    const c2 = await connected({ google: "error" });
    const f2 = fake({ override: (call) => (call.host === "mybusiness.googleapis.com" && call.method === "POST" ? Response.json({ error: { code: 429, message: "Too many requests", status: "RESOURCE_EXHAUSTED" } }, { status: 429 }) : undefined) });
    const w2 = serve({ tables: { ...c2.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d2", attachment_ids: [c2.ids[0]], networks: ["google"] })] }, files: c2.files, outside: graph(f2) });
    await run(w2);
    expect(net(w2, "00000000-0000-4000-8000-0000000000d2", "google")).toMatchObject({ status: "retry", tries: 1 });
  });

  it("takes a server error on the post for one that may have gone: looked for, never sent again", async () => {
    const f = fake({ override: (call) => (call.host === "mybusiness.googleapis.com" && call.method === "POST" ? Response.json({ error: { code: 500, message: "Backend Error", status: "INTERNAL" } }, { status: 500 }) : undefined) });
    const c = await connected({ google: true });
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["google"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "google")).toMatchObject({ status: "unknown" });
    expect(w.calls.some((x) => x.host === "mybusiness.googleapis.com" && x.method === "GET" && x.path.endsWith("/localPosts"))).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 60 * 60_000) });
    await run(w);
    expect(w.calls.filter((x) => x.host === "mybusiness.googleapis.com" && x.method === "POST")).toHaveLength(1);
  });

  it("gets its sign-in before the post goes, so a refresh that times out is tried again, not taken for a post", async () => {
    const f = fake({ override: (call) => (call.host === "oauth2.googleapis.com" ? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")) : undefined) });
    const c = await connected({ google: true });
    const secrets = c.tables.integration_secrets.filter((x) => x.provider !== "google_business");
    secrets.push({ company_id: CO, provider: "google_business", ciphertext: await encryptJson(env, { access_token: "old", refresh_token: "r", expires_at: Date.now() + 60_000 }) });
    const w = serve({ tables: { ...c.tables, integration_secrets: secrets, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["google"] })] }, files: c.files, outside: graph(f) });
    await postDueSocial({ ...env, GOOGLE_CLIENT_ID: "gid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret" });
    await settle(w);
    expect(w.calls.some((x) => x.host === "oauth2.googleapis.com")).toBe(true);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "google")).toMatchObject({ status: "retry", attempts: 0 });
    expect(w.calls.filter((x) => x.host === "mybusiness.googleapis.com" && x.method === "POST")).toHaveLength(0);
  });
});

describe("each network at most once", () => {
  it("retries only the network that failed: Facebook is posted once in all", async () => {
    let fails = true;
    const f = fake({ override: (call) => (fails && call.path === `${G}/${IG}/media` && call.method === "POST" ? Response.json({ error: { message: "Unknown error", code: 1 } }, { status: 500 }) : undefined) });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["facebook", "instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook").status).toBe("posted");
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "retry", tries: 1 });
    fails = false;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 3 * 60_000) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram").status).toBe("posted");
    expect(graphCalls(w, `/${PAGE}/photos`, "POST")).toHaveLength(1);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("posted");
  });

  it("gives up after five tries", async () => {
    const f = fake({ override: (call) => (call.path === `${G}/${PAGE}/photos` ? graphError(4, undefined, "Application request limit reached") : undefined) });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]] })] }, files: c.files, outside: graph(f) });
    let at = Date.now();
    for (let i = 0; i < 6; i++) {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(at) });
      await run(w);
      at += 40 * 60_000;
    }
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "failed", tries: 5 });
  });

  it("never posts again after a send that may have gone: it's checked, and left for a person", async () => {
    const f = fake({ override: (call) => (call.path === `${G}/${IG}/media_publish` ? Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")) : undefined) });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "unknown", error: "It may have posted. Check before posting it again." });
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("check");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 60 * 60_000) });
    await run(w);
    expect(graphCalls(w, `/${IG}/media_publish`)).toHaveLength(1);
    // Settled by a person both ways: it isn't there, so it posts; then it's on the Page.
    f.override = undefined;
    expect((await request("/social/posts/00000000-0000-4000-8000-0000000000d1/networks/instagram/resolve", { method: "POST", body: { posted: false } })).status).toBe(200);
    await settle(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram").status).toBe("posted");
    expect(graphCalls(w, `/${IG}/media_publish`)).toHaveLength(2);
  });

  it("finds a post that did go by its caption, made after the send", async () => {
    const f = fake();
    f.override = (call) => {
      if (call.path !== `${G}/${PAGE}/photos`) return undefined;
      f.recentFb = [{ id: `${PAGE}_found`, message: "Fresh mulch and crisp edges", created_time: new Date().toISOString(), permalink_url: "https://www.facebook.com/found", attachments: { data: [{ media_type: "photo" }] } }];
      return Promise.reject(new TypeError("other side closed"));
    };
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "posted", external_id: `${PAGE}_found`, permalink: "https://www.facebook.com/found" });
  });

  it("doesn't take an older automatic post with the same words, or one already recorded", async () => {
    const f = fake();
    const older = new Date(Date.now() - 86_400_000).toISOString();
    f.override = (call) => {
      if (call.path !== `${G}/${PAGE}/photos`) return undefined;
      f.recentFb = [
        { id: `${PAGE}_yesterday`, message: DEFAULT_REVIEW_CAPTION, created_time: older, attachments: { data: [{ media_type: "photo" }] } },
        { id: `${PAGE}_recorded`, message: DEFAULT_REVIEW_CAPTION, created_time: new Date().toISOString(), attachments: { data: [{ media_type: "photo" }] } },
      ];
      return Promise.reject(new DOMException("timeout", "TimeoutError"));
    };
    const c = await connected();
    const review = { id: "rev-1", company_id: CO, location_id: "locations/9", review_id: "r1", rating: 5, comment: "Wonderful work, very tidy", reviewer_name: "Cara Lee", reviewer_anonymous: false, client_id: null, deleted_at: null };
    const w = serve({
      tables: {
        ...c.tables, reviews: [review],
        social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", source: "review", review_id: "rev-1", review_key: "locations/9/r1", attachment_ids: [], caption: DEFAULT_REVIEW_CAPTION, automatic: true, created_by: null })],
        social_post_networks: [{ post_id: "00000000-0000-4000-8000-0000000000d5", company_id: CO, network: "facebook", status: "posted", external_id: `${PAGE}_recorded` }],
      },
      files: c.files, outside: graph(f),
    });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "unknown", error: "It may have posted. Check before posting it again." });
  });

  it("marks a send whose worker stopped as unknown when its claim runs out, and records a late success", async () => {
    const f = fake();
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], status: "posting", claim: "old", locked_until: new Date(Date.now() - 1000).toISOString() })], social_post_networks: [{ post_id: "00000000-0000-4000-8000-0000000000d1", company_id: CO, network: "facebook", status: "sending", attempts: 1, tries: 0, steps: {} }] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook").status).toBe("unknown");
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("check");
    expect(graphCalls(w, `/${PAGE}/photos`)).toHaveLength(0);
    await request("/social/posts/00000000-0000-4000-8000-0000000000d1/networks/facebook/resolve", { method: "POST", body: { posted: true, permalink: "https://www.facebook.com/x" } });
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "posted", permalink: "https://www.facebook.com/x" });
  });
});

describe("an unclear answer to the call that publishes", () => {
  it("is a post that may have gone, on Facebook and Instagram: looked for once, never sent again", async () => {
    const unknownError = () => Response.json({ error: { message: "An unknown error occurred", type: "OAuthException", code: 1 } }, { status: 500 });
    const f = fake({ override: (call) => (call.method === "POST" && (call.path === `${G}/${PAGE}/photos` || call.path === `${G}/${IG}/media_publish`) ? unknownError() : undefined) });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["facebook", "instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "unknown" });
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "unknown" });
    expect(graphCalls(w, `/${PAGE}/posts`)).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 60 * 60_000) });
    await run(w);
    expect(graphCalls(w, `/${PAGE}/photos`, "POST")).toHaveLength(1);
    expect(graphCalls(w, `/${IG}/media_publish`)).toHaveLength(1);
  });

  it("finds the post a 502 from Meta's edge made, by its caption", async () => {
    const f = fake();
    f.override = (call) => {
      if (call.path !== `${G}/${PAGE}/feed`) return undefined;
      f.recentFb = [{ id: `${PAGE}_made`, message: "Booking spring cleanups now", created_time: new Date().toISOString(), permalink_url: "https://www.facebook.com/made" }];
      return new Response("<html>Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } });
    };
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", source: "text", caption: "Booking spring cleanups now" })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "posted", external_id: `${PAGE}_made` });
  });
});

describe("Instagram's containers", () => {
  it("records one Instagram says it published already as posted, after a person said it wasn't there", async () => {
    let fail = true;
    const f = fake({ override: (call) => (call.path === `${G}/${IG}/media_publish` && fail ? Response.json({ error: { message: "Service temporarily unavailable", code: 2 } }, { status: 503 }) : undefined) });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram").status).toBe("unknown");
    // It went up after all: Instagram says so, and it's on the account.
    fail = false;
    f.status = ["PUBLISHED"];
    f.recentIg = [{ id: "igfound", caption: "Fresh mulch and crisp edges", timestamp: new Date().toISOString(), permalink: "https://www.instagram.com/p/found/", media_type: "IMAGE" }];
    expect((await request("/social/posts/00000000-0000-4000-8000-0000000000d1/networks/instagram/resolve", { method: "POST", body: { posted: false } })).status).toBe(200);
    await settle(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "posted", external_id: "igfound", permalink: "https://www.instagram.com/p/found/", steps: {} });
    expect(graphCalls(w, `/${IG}/media_publish`)).toHaveLength(1);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("posted");
    // And it isn't claimed again.
    const asked = graphCalls(w, `/container1`).length;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 5 * 60_000) });
    await run(w);
    expect(graphCalls(w, `/container1`)).toHaveLength(asked);
  });

  it("makes a new container on Post again after Instagram turned one down", async () => {
    const f = fake({ status: ["ERROR"] });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "failed", error_kind: "image", steps: {} });
    f.status = ["FINISHED"];
    expect((await request("/social/posts/00000000-0000-4000-8000-0000000000d1/retry", { method: "POST" })).status).toBe(200);
    await settle(w);
    expect(graphCalls(w, `/${IG}/media`, "POST")).toHaveLength(2);
    expect(graphCalls(w, `/${IG}/media_publish`)[0]!.body).toEqual({ creation_id: "container2" });
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram").status).toBe("posted");
  });

  it("never publishes a carousel made with a photo taken out since: it's made again from the photos left", async () => {
    const f = fake({ status: ["IN_PROGRESS"] });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: c.ids, networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram")).toMatchObject({ status: "retry", steps: { items: ["container1", "container2", "container3"], container: "container4" } });
    const dropped = w.tables.social_post_images!.find((i) => i.attachment_id === c.ids[1])!;
    // The office takes the middle photo off OK to share before Instagram is done.
    w.tables.attachments!.find((a) => a.id === c.ids[1])!.shareable = false;
    f.status = ["FINISHED"];
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 3 * 60_000) });
    await run(w);
    const media = graphCalls(w, `/${IG}/media`, "POST");
    expect(media.at(-1)!.body).toMatchObject({ media_type: "CAROUSEL", children: "container5,container6" });
    expect(graphCalls(w, `/${IG}/media_publish`).map((x) => x.body.creation_id)).toEqual(["container7"]);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").note).toBe("1 photo was left out: not OK to share anymore.");
    // Its picture isn't served anymore, under any link.
    expect(w.tables.social_post_images!.some((i) => i.attachment_id === c.ids[1])).toBe(false);
    expect((await app.request(`/api/public/social/${dropped.token}.jpg`, {}, env)).status).toBe(404);
  });

  it("makes a single post, not the old carousel, when only one photo is left", async () => {
    const f = fake({ status: ["IN_PROGRESS"] });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: c.ids.slice(0, 2), networks: ["instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    // The client asks not to be posted.
    w.tables.attachments!.find((a) => a.id === c.ids[0])!.client_id = BEA;
    f.status = ["FINISHED"];
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 3 * 60_000) });
    await run(w);
    const last = graphCalls(w, `/${IG}/media`, "POST").at(-1)!;
    expect(last.body.media_type).toBeUndefined();
    expect(last.body.caption).toBe("Fresh mulch and crisp edges");
    expect(graphCalls(w, `/${IG}/media_publish`).map((x) => x.body.creation_id)).toEqual(["container4"]);
  });
});

describe("Facebook's unpublished photos", () => {
  it("are uploaded again when a photo is taken out between tries", async () => {
    let uploads = 0;
    const f = fake({ override: (call) => (call.path === `${G}/${PAGE}/photos` && call.body?.published === "false" && ++uploads === 3 ? graphError(4, undefined, "Application request limit reached") : undefined) });
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: c.ids })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "retry", steps: { media_fbids: ["unpub1", "unpub2"] } });
    w.tables.attachments!.find((a) => a.id === c.ids[0])!.shareable = false;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 3 * 60_000) });
    await run(w);
    const feed = graphCalls(w, `/${PAGE}/feed`, "POST");
    expect(feed).toHaveLength(1);
    expect(feed[0]!.body).toMatchObject({ "attached_media[0]": '{"media_fbid":"unpub3"}', "attached_media[1]": '{"media_fbid":"unpub4"}' });
    expect(feed[0]!.body).not.toHaveProperty("attached_media[2]");
  });
});

describe("a post stopped while a network was sending", () => {
  it("cancelled: a send that comes back 'try again' is skipped, and never posts later", async () => {
    const id = "00000000-0000-4000-8000-0000000000d1";
    const f = fake();
    f.override = async (call) => {
      if (call.method !== "POST" || call.path !== `${G}/${PAGE}/photos`) return undefined;
      // The office cancels while Meta is answering.
      expect((await request(`/social/posts/${id}/cancel`, { method: "POST" })).status).toBe(200);
      return graphError(4, undefined, "Application request limit reached");
    };
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id, attachment_ids: [c.ids[0]], networks: ["facebook", "instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, id, "facebook")).toMatchObject({ status: "skipped", error_kind: "cancelled", error: "Cancelled" });
    expect(net(w, id, "instagram")).toMatchObject({ status: "skipped", error_kind: "cancelled" });
    expect(postRow(w, id).status).toBe("cancelled");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 10 * 60_000) });
    await run(w);
    expect(graphCalls(w, `/${PAGE}/photos`, "POST")).toHaveLength(1);
    expect(graphCalls(w, `/${IG}/media`, "POST")).toHaveLength(0);
  });

  it("Marketing uninstalled: the send is recorded as skipped, and installing again posts nothing", async () => {
    const id = "00000000-0000-4000-8000-0000000000d1";
    const f = fake();
    let w: World;
    f.override = (call) => {
      if (call.method !== "POST" || call.path !== `${G}/${PAGE}/photos`) return undefined;
      // As marketing_set_enabled does it.
      w.tables.companies![0]!.settings = { ...w.tables.companies![0]!.settings, marketing: { enabled: false } };
      postRow(w, id).stop_kind = "marketing_off";
      return Response.json({ error: { message: "Too many calls", code: 613 } }, { status: 400 });
    };
    const c = await connected();
    w = serve({ tables: { ...c.tables, social_posts: [due({ id, attachment_ids: [c.ids[0]] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, id, "facebook")).toMatchObject({ status: "skipped", error_kind: "marketing_off" });
    expect(postRow(w, id).status).toBe("failed");
    w.tables.companies![0]!.settings = { ...w.tables.companies![0]!.settings, marketing: { enabled: true } };
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 10 * 60_000) });
    await run(w);
    expect(graphCalls(w, `/${PAGE}/photos`, "POST")).toHaveLength(1);
  });
});

describe("what posts is checked when it posts", () => {
  it("drops photos no longer OK to share, and fails when none is left", async () => {
    const f = fake();
    const c = await connected();
    c.tables.attachments[0]!.shareable = false;
    c.tables.attachments[1]!.client_id = BEA;
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: c.ids.slice(0, 2) })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "failed", error_kind: "removed", error: "The photos aren't OK to share anymore." });
    expect(graphCalls(w, `/${PAGE}/photos`)).toHaveLength(0);
  });

  it("doesn't post a review whose words name its client's street, matched after it was scheduled", async () => {
    const f = fake();
    const c = await connected();
    const review = { id: "rev-1", company_id: CO, location_id: "locations/9", review_id: "r1", rating: 5, comment: "They redid the lawn at 14 Oak St and it looks great", reviewer_name: "Ana G.", reviewer_anonymous: false, client_id: ANA, deleted_at: null };
    const w = serve({ tables: { ...c.tables, reviews: [review], social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", source: "review", review_id: "rev-1", review_key: "locations/9/r1", attachment_ids: [], caption: DEFAULT_REVIEW_CAPTION, automatic: true })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "failed", error_kind: "removed", error: "This review names the client or their street, so it wasn't posted." });
  });

  it("posts a 5-star review as its card, to Facebook and Instagram alike", async () => {
    const f = fake();
    const c = await connected();
    const review = { id: "rev-1", company_id: CO, location_id: "locations/9", review_id: "r1", rating: 5, comment: "Wonderful crew, very tidy", reviewer_name: "Cara Lee", reviewer_anonymous: false, client_id: null, deleted_at: null };
    const w = serve({ tables: { ...c.tables, reviews: [review], social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", source: "review", review_id: "rev-1", review_key: "locations/9/r1", attachment_ids: [], networks: ["facebook", "instagram"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(w.tables.social_post_images!.map((i) => [i.variant, i.width, i.height])).toEqual([["feed", 1080, 1080]]);
    expect(graphCalls(w, `/${PAGE}/photos`)[0]!.body.url).toBe(graphCalls(w, `/${IG}/media`, "POST")[0]!.body.image_url);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("posted");
  });

  it("posts a review whose row was removed and brought in again, found by its location and review ids", async () => {
    const f = fake();
    const c = await connected();
    // Disconnected with the reviews removed, then connected again: the same review, a new row.
    const review = { id: "rev-2", company_id: CO, location_id: "locations/9", review_id: "r1", rating: 5, comment: "Wonderful crew, very tidy", reviewer_name: "Gail Park", reviewer_anonymous: false, client_id: null, deleted_at: null };
    const w = serve({ tables: { ...c.tables, reviews: [review], social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", source: "review", review_id: null, review_key: "locations/9/r1", attachment_ids: [], networks: ["facebook"], automatic: true, caption: DEFAULT_REVIEW_CAPTION })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1")).toMatchObject({ status: "posted", review_id: "rev-2" });
  });

  it("says a review that isn't in Crewtavo anymore as that, not as removed from Google, and says to connect only when it isn't", async () => {
    const gone = async (over: Parameters<typeof connected>[0], key = "locations/9/r1") => {
      const f = fake();
      const c = await connected(over);
      const w = serve({ tables: { ...c.tables, reviews: [], social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", source: "review", review_id: null, review_key: key, attachment_ids: [], networks: ["facebook"] })] }, files: c.files, outside: graph(f) });
      await run(w);
      const row = net(w, "00000000-0000-4000-8000-0000000000d1", "facebook");
      expect(row).toMatchObject({ status: "failed", error_kind: "removed" });
      return row.error as string;
    };
    // Disconnected with the reviews removed: connecting brings it back.
    expect(await gone({})).toBe("The review isn't in Crewtavo anymore. Connect Google Business Profile to bring it back.");
    // Connected, and moved to another location (Change location away): not "Connect".
    expect(await gone({ google: true }, "locations/7/r1")).toBe("The review isn't in Crewtavo anymore. Google Business Profile is set to another location now.");
    // Connected to the review's own location: only that it isn't here.
    expect(await gone({ google: true })).toBe("The review isn't in Crewtavo anymore.");
    expect(reviewGoneWords({ status: "disconnected", location: "locations/9" }, "locations/9/r1")).toBe("The review isn't in Crewtavo anymore. Connect Google Business Profile to bring it back.");
    expect(reviewGoneWords(null, null)).toBe("The review isn't in Crewtavo anymore. Connect Google Business Profile to bring it back.");
    expect(reviewGoneWords({ status: "error", location: "locations/9" }, null)).toBe("The review isn't in Crewtavo anymore.");
  });

  it("skips Facebook and Instagram once disconnected, and still posts to Google", async () => {
    const f = fake();
    const c = await connected({ metaStatus: "disconnected", google: true });
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["facebook", "google"] })] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "skipped", error_kind: "not_connected", error: "Facebook & Instagram was disconnected." });
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "google").status).toBe("posted");
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("partly_posted");
  });

  it("refuses to post photos when this server's address isn't public", async () => {
    const f = fake();
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]] })] }, files: c.files, outside: graph(f) });
    await postDueSocial({ ...env, APP_URL: "http://localhost:8787" });
    await settle(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "facebook")).toMatchObject({ status: "failed", error: "Crewtavo's address isn't public, so Meta and Google can't fetch the photos." });
  });
});

describe("scheduling", () => {
  it("posts at its time, not before", async () => {
    const f = fake();
    const c = await connected();
    const at = new Date(Date.now() + 2 * 3_600_000);
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], scheduled_for: at.toISOString() })] }, files: c.files, outside: graph(f) });
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(at.getTime() - 60_000) });
    await run(w);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("scheduled");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(at.getTime() + 30_000) });
    await run(w);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("posted");
  });

  it("posts nothing, and takes no new post, while Marketing is off, and links already given out still work", async () => {
    const f = fake();
    const c = await connected({ company: { marketing: { enabled: false } } });
    const image = { id: "img-1", company_id: CO, post_id: "old", n: 0, variant: "feed", path: `${CO}/social/old/0-feed.jpg`, token: "A".repeat(32), width: 40, height: 30, bytes: 10, expires_at: new Date(Date.now() + 86_400_000).toISOString() };
    c.files.set(image.path, phoneJpeg());
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]] })], social_post_images: [image] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d1").status).toBe("scheduled");
    const res = await request("/social/posts", { method: "POST", body: { source: "photos", attachment_ids: [c.ids[0]], caption: "Hi", networks: ["facebook"], when: "now" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("Marketing is off, so nothing posts. An owner or admin can install it again in Apps.");
    expect((await app.request(`/api/public/social/${"A".repeat(32)}.jpg`, {}, env)).status).toBe(200);
  });
});

describe("the routes", () => {
  const body = (over: Row) => ({ source: "photos", attachment_ids: [], caption: "Fresh mulch", networks: ["facebook"], when: { at: new Date(Date.now() + 86_400_000).toISOString() }, ...over });

  it("keeps a post to the rules: OK to share, a client who said no, 10 photos, captions, client names, times", async () => {
    const c = await connected();
    c.tables.attachments.push(photo("00000000-0000-4000-8000-0000000000b2", { client_id: BEA }));
    serve({ tables: c.tables, files: c.files, outside: graph(fake()) });
    const error = async (over: Row) => ((await (await request("/social/posts", { method: "POST", body: body(over) })).json()) as { error: string }).error;
    expect(await error({ attachment_ids: ["00000000-0000-4000-8000-0000000000b2"] })).toBe("This client asked us not to post photos of their property.");
    expect(await error({ attachment_ids: Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`) })).toBe("Pick up to 10 photos.");
    expect(await error({ attachment_ids: [c.ids[0]], caption: "x".repeat(2201), networks: ["instagram"] })).toBe("Caption is too long.");
    expect(await error({ attachment_ids: [c.ids[0]], caption: "Thanks Ana Green for having us!" })).toBe("Take out the client's name or address before posting.");
    expect(await error({ attachment_ids: [c.ids[0]], caption: "New sod at 14 Oak St" })).toBe("Take out the client's name or address before posting.");
    expect(await error({ attachment_ids: [c.ids[0]], when: { at: new Date(Date.now() - 60_000).toISOString() } })).toBe("Pick a time at least 5 minutes from now.");
    expect(await error({ source: "text", caption: "Spring is here", networks: ["instagram"] })).toBe("Instagram needs a photo.");
    expect(await error({ attachment_ids: [c.ids[0]], networks: ["google"] })).toContain("Google Business Profile isn't ready");
    const ok = await request("/social/posts", { method: "POST", body: body({ attachment_ids: [c.ids[0]], caption: "A green lawn, and the Green family's porch" }) });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { warnings: string[] }).warnings).toEqual(["Green"]);
  });

  it("checks a post before Post now's confirm, saving nothing, so a caption naming a client is said first", async () => {
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [] }, files: c.files, outside: graph(fake()) });
    const refused = await request("/social/posts/check", { method: "POST", body: body({ attachment_ids: [c.ids[0]], caption: "Thanks Ana Green for having us!", when: "now" }) });
    expect([refused.status, await refused.json()]).toEqual([400, { error: "Take out the client's name or address before posting." }]);
    const ok = await request("/social/posts/check", { method: "POST", body: body({ attachment_ids: [c.ids[0]], caption: "A green lawn, and the Green family's porch", when: "now" }) });
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true, warnings: ["Green"] }]);
    expect(w.tables.social_posts).toEqual([]);
  });

  it("changes a scheduled post, not one that started posting, and cancels it", async () => {
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d3", attachment_ids: [c.ids[0]], scheduled_for: new Date(Date.now() + 86_400_000).toISOString() }), due({ id: "00000000-0000-4000-8000-0000000000d4", attachment_ids: [c.ids[0]], status: "posting" })] }, files: c.files, outside: graph(fake()) });
    expect((await request("/social/posts/00000000-0000-4000-8000-0000000000d4", { method: "PATCH", body: { caption: "Changed" } })).status).toBe(409);
    const res = await request("/social/posts/00000000-0000-4000-8000-0000000000d3", { method: "PATCH", body: { caption: "Changed" } });
    expect(res.status).toBe(200);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d3")).toMatchObject({ caption: "Changed", caption_by: "person", status: "scheduled" });
    expect((await request("/social/posts/00000000-0000-4000-8000-0000000000d3/cancel", { method: "POST" })).status).toBe(200);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d3").status).toBe("cancelled");
    expect((await request("/social/posts/00000000-0000-4000-8000-0000000000d3", { method: "DELETE" })).status).toBe(409);
  });

  it("keeps an automatic post's review: another one is refused, not quietly dropped", async () => {
    const c = await connected();
    const reviews = ["r1", "r2"].map((id) => ({ id: `00000000-0000-4000-8000-0000000000${id === "r1" ? "e5" : "e6"}`, company_id: CO, location_id: "locations/9", review_id: id, rating: 5, comment: "Wonderful crew, very tidy", reviewer_name: "Cara Lee", reviewer_anonymous: false, client_id: null, deleted_at: null }));
    const w = serve({ tables: { ...c.tables, reviews, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d6", source: "review", review_id: "00000000-0000-4000-8000-0000000000e5", review_key: "locations/9/r1", attachment_ids: [], automatic: true, created_by: null, scheduled_for: new Date(Date.now() + 86_400_000).toISOString() })] }, files: c.files });
    const other = await request("/social/posts/00000000-0000-4000-8000-0000000000d6", { method: "PATCH", body: { source: "review", review_id: "00000000-0000-4000-8000-0000000000e6", caption: "Thanks!" } });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { error: string }).error).toBe("An automatic post keeps its review. Cancel it and make a new post to share another one.");
    expect((await request("/social/posts/00000000-0000-4000-8000-0000000000d6", { method: "PATCH", body: { source: "review", review_id: "00000000-0000-4000-8000-0000000000e5", caption: "Thanks!" } })).status).toBe(200);
    expect(postRow(w, "00000000-0000-4000-8000-0000000000d6")).toMatchObject({ review_id: "00000000-0000-4000-8000-0000000000e5", caption: "Thanks!" });
  });

  it("saves a draft to Google with no caption yet, and won't schedule it until it has one", async () => {
    const c = await connected({ google: true });
    serve({ tables: c.tables, files: c.files });
    expect((await request("/social/posts", { method: "POST", body: { source: "photos", attachment_ids: [c.ids[0]], caption: "", networks: ["google"], when: "draft" } })).status).toBe(201);
    const scheduled = await request("/social/posts", { method: "POST", body: { source: "photos", attachment_ids: [c.ids[0]], caption: " ", networks: ["google"], when: { at: new Date(Date.now() + 86_400_000).toISOString() } } });
    expect(((await scheduled.json()) as { error: string }).error).toBe("Google needs a caption.");
  });

  it("reads picked photos by id, saying which can't be posted anymore and why", async () => {
    const c = await connected();
    c.tables.attachments[1]!.shareable = false;
    c.tables.attachments[2]!.client_id = BEA;
    const w = serve({ tables: c.tables, files: c.files });
    const res = (await (await request(`/social/photos/picked?ids=${[...c.ids, "00000000-0000-4000-8000-0000000000ff", "not-an-id"].join(",")}`)).json()) as { photos: Row[] };
    expect(res.photos.map((p) => [p.id, p.problem])).toEqual([[c.ids[0], null], [c.ids[1], "not_shared"], [c.ids[2], "client_opt_out"], ["00000000-0000-4000-8000-0000000000ff", "gone"]]);
    // A path for the browser to sign, never a link made here.
    expect(res.photos[0]).toMatchObject({ path: `${CO}/visit/v1/${c.ids[0]}.jpg` });
    expect(res.photos[0]).not.toHaveProperty("url");
    expect(res.photos[3]!.path).toBeNull();
    expect(w.calls.some((call) => call.path.includes("/object/sign/"))).toBe(false);
  });

  it("sends photos as paths for the browser to sign: this server may reach Storage at an address the browser can't", async () => {
    const c = await connected();
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[1], c.ids[0]], status: "draft", scheduled_for: null })] }, files: c.files });
    const photos = (await (await request("/social/photos")).json()) as { photos: Row[] };
    expect(photos.photos.map((p) => p.path)).toEqual(c.ids.map((id) => `${CO}/visit/v1/${id}.jpg`));
    expect(photos.photos[0]).not.toHaveProperty("url");
    const posts = (await (await request("/social/posts?list=upcoming")).json()) as { posts: Row[] };
    expect(posts.posts[0]).toMatchObject({ thumb_path: `${CO}/visit/v1/${c.ids[1]}.jpg`, review: null });
    expect(posts.posts[0]).not.toHaveProperty("thumb");
    expect(w.calls.some((call) => call.path.includes("/object/sign/"))).toBe(false);
  });

  it("lists posts still to go in the order they go, then drafts, and says whose review each one is", async () => {
    const c = await connected();
    const review = { id: "00000000-0000-4000-8000-0000000000e5", company_id: CO, location_id: "locations/9", review_id: "r1", rating: 5, comment: "Wonderful crew 🌿 very tidy", reviewer_name: "Cara Lee", reviewer_anonymous: false, client_id: null, deleted_at: null };
    const w = serve({ tables: { ...c.tables, reviews: [review], social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d6", source: "review", review_id: review.id, review_key: "locations/9/r1", automatic: true, caption: DEFAULT_REVIEW_CAPTION, scheduled_for: new Date(Date.now() + 86_400_000).toISOString() })] }, files: c.files });
    const res = (await (await request("/social/posts?list=upcoming")).json()) as { posts: Row[] };
    expect(res.posts[0]).toMatchObject({ thumb_path: null, review: { name: "Cara L.", rating: 5, words: "Wonderful crew very tidy" } });
    const first = w.calls.filter((call) => call.path === "/rest/v1/social_posts" && call.method === "GET").at(-1)!;
    expect(first.params.get("order")).toBe("scheduled_for.asc.nullslast,created_at.desc,id.desc");
    // The next page starts after the last one's scheduled time; after a draft, only older drafts.
    await request("/social/posts?list=upcoming&before_at=2026-11-01T10:00:00.123456%2B00:00&before_id=00000000-0000-4000-8000-0000000000d6&before_for=2026-11-02T15:00:00%2B00:00");
    const next = w.calls.filter((call) => call.path === "/rest/v1/social_posts" && call.method === "GET").at(-1)!;
    expect(next.params.get("or")).toBe('(scheduled_for.gt."2026-11-02T15:00:00+00:00",scheduled_for.is.null,and(scheduled_for.eq."2026-11-02T15:00:00+00:00",or(created_at.lt."2026-11-01T10:00:00.123456+00:00",and(created_at.eq."2026-11-01T10:00:00.123456+00:00",id.lt.00000000-0000-4000-8000-0000000000d6))))');
    await request("/social/posts?list=upcoming&before_at=2026-11-01T10:00:00%2B00:00&before_id=00000000-0000-4000-8000-0000000000d6");
    const drafts = w.calls.filter((call) => call.path === "/rest/v1/social_posts" && call.method === "GET").at(-1)!;
    expect(drafts.params.get("scheduled_for")).toBe("is.null");
    await request("/social/posts?list=done");
    expect(w.calls.filter((call) => call.path === "/rest/v1/social_posts" && call.method === "GET").at(-1)!.params.get("order")).toBe("created_at.desc,id.desc");
  });

  it("says before posting when this server's address isn't public: pictures can't be fetched, words alone still post", async () => {
    const c = await connected();
    serve({ tables: c.tables, files: c.files, outside: graph(fake()) });
    const local = { ...env, APP_URL: "http://192.168.1.20:8787" };
    const post = (b: Row, path = "/social/posts", method = "POST") => app.request(`/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, "X-Company-Id": CO, "Content-Type": "application/json" }, body: JSON.stringify(b) }, local);
    const photos = await post(body({ attachment_ids: [c.ids[0]] }));
    expect(photos.status).toBe(409);
    expect(((await photos.json()) as { error: string }).error).toBe("Crewtavo's address isn't public, so Meta and Google can't fetch the pictures. Save it as a draft, or use Share elsewhere.");
    expect((await post(body({ attachment_ids: [c.ids[0]], when: "draft" }))).status).toBe(201);
    expect((await post(body({ source: "text", caption: "Booking spring cleanups now" }))).status).toBe(201);
    expect((await post({ auto: { enabled: true, networks: ["facebook"] } }, "/social/settings", "PUT")).status).toBe(409);
    const state = (await (await app.request("/api/social", { headers: { Authorization: `Bearer ${token}`, "X-Company-Id": CO } }, local)).json()) as Row;
    expect(state.images_public).toBe(false);
    expect(((await (await request("/social")).json()) as Row).images_public).toBe(true);
  });

  it("won't post to a network missing a permission it posts with, and says which where it posts", async () => {
    const c = await connected({ meta: { granted: ALL.filter((p) => p !== "pages_manage_posts") } });
    serve({ tables: c.tables, files: c.files, outside: graph(fake()) });
    const state = (await (await request("/social")).json()) as Row;
    expect(state.networks.facebook).toMatchObject({ connected: true, missing: ["pages_manage_posts"] });
    expect(state.networks.instagram).toMatchObject({ connected: true, missing: [] });
    const res = await request("/social/posts", { method: "POST", body: body({ attachment_ids: [c.ids[0]] }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("Facebook is missing the pages_manage_posts permission. Reconnect Facebook & Instagram in Apps and allow it.");
    expect((await request("/social/posts", { method: "POST", body: body({ attachment_ids: [c.ids[0]], networks: ["instagram"] }) })).status).toBe(201);
  });

  it("says Instagram needs attention too when the Page's sign-in stops, if its account was in use", async () => {
    const c = await connected({ metaStatus: "error" });
    serve({ tables: c.tables, files: c.files });
    const state = (await (await request("/social")).json()) as Row;
    expect(state.networks.facebook).toMatchObject({ connected: false, problem: "signin", page_name: "Radford Lawn Care" });
    expect(state.networks.instagram).toMatchObject({ connected: false, problem: "signin", username: "radfordlawn" });
    const unused = await connected({ metaStatus: "error", meta: { ig_user_id: undefined, page_instagram: { id: IG, username: "radfordlawn" } } });
    serve({ tables: unused.tables, files: unused.files });
    expect(((await (await request("/social")).json()) as Row).networks.instagram).toMatchObject({ problem: "off", username: null });
  });

  it("posts again only what failed", async () => {
    const f = fake();
    const c = await connected();
    const w = serve({
      tables: {
        ...c.tables,
        social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]], networks: ["facebook", "instagram"], status: "partly_posted" })],
        social_post_networks: [{ post_id: "00000000-0000-4000-8000-0000000000d1", company_id: CO, network: "facebook", status: "posted", external_id: "1_1", tries: 0, steps: {} }, { post_id: "00000000-0000-4000-8000-0000000000d1", company_id: CO, network: "instagram", status: "failed", tries: 5, attempts: 1, steps: {} }],
      },
      files: c.files, outside: graph(f),
    });
    expect((await request("/social/posts/00000000-0000-4000-8000-0000000000d1/retry", { method: "POST" })).status).toBe(200);
    await settle(w);
    expect(net(w, "00000000-0000-4000-8000-0000000000d1", "instagram").status).toBe("posted");
    expect(graphCalls(w, `/${PAGE}/photos`)).toHaveLength(0);
  });

  it("turns automatic posts off, cancelling the ones scheduled, and says how many", async () => {
    const c = await connected({ company: { social: { auto: { enabled: true, networks: ["facebook"] } } } });
    serve({ tables: { ...c.tables, social_posts: [due({ id: "a1", automatic: true, scheduled_for: new Date(Date.now() + 86_400_000).toISOString() }), due({ id: "a2", automatic: true, scheduled_for: new Date(Date.now() + 86_400_000).toISOString() })] }, files: c.files });
    const res = (await (await request("/social/settings", { method: "PUT", body: { auto: { enabled: false, networks: ["facebook"] } } })).json()) as Row;
    expect(res).toMatchObject({ enabled: false, cancelled: 2 });
  });
});

describe("the pictures' public links", () => {
  it("serve a JPEG by its random token until it expires, the same 404 for an unknown one, and are tidied up after", async () => {
    const c = await connected();
    const live = { id: "img-1", company_id: CO, post_id: "p", n: 0, variant: "feed", path: `${CO}/social/p/0-feed.jpg`, token: "Live_live-".padEnd(32, "x"), width: 40, height: 30, bytes: 10, expires_at: new Date(Date.now() + 86_400_000).toISOString() };
    const old = { ...live, id: "img-2", path: `${CO}/social/p/1-feed.jpg`, token: "Old".padEnd(32, "y"), expires_at: new Date(Date.now() - 2 * 86_400_000).toISOString() };
    c.files.set(live.path, phoneJpeg());
    c.files.set(old.path, phoneJpeg());
    const w = serve({ tables: { ...c.tables, social_post_images: [live, old] }, files: c.files });
    const get = await app.request(`/api/public/social/${live.token}.jpg`, {}, env);
    expect([get.status, get.headers.get("content-type"), get.headers.get("x-robots-tag")]).toEqual([200, "image/jpeg", "noindex"]);
    const head = await app.request(`/api/public/social/${live.token}.jpg`, { method: "HEAD" }, env);
    expect([head.status, head.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
    for (const path of [`${old.token}.jpg`, `${"z".repeat(32)}.jpg`, `${live.token}.png`, "short.jpg"]) {
      expect((await app.request(`/api/public/social/${path}`, {}, env)).status, path).toBe(404);
    }
    expect(await tidySocialImages(adminClient(env))).toBe(1);
    expect(w.files.has(old.path)).toBe(false);
    expect(w.files.has(live.path)).toBe(true);
  });

  it("are made again with new tokens when a post goes again after they expired", async () => {
    const f = fake();
    const c = await connected();
    const expired = { id: "img-1", company_id: CO, post_id: "00000000-0000-4000-8000-0000000000d1", n: 0, variant: "feed", attachment_id: c.ids[0], path: `${CO}/social/00000000-0000-4000-8000-0000000000d1/0-feed.jpg`, token: "E".repeat(32), width: 40, height: 30, bytes: 10, expires_at: new Date(Date.now() - 1000).toISOString() };
    const w = serve({ tables: { ...c.tables, social_posts: [due({ id: "00000000-0000-4000-8000-0000000000d1", attachment_ids: [c.ids[0]] })], social_post_images: [expired] }, files: c.files, outside: graph(f) });
    await run(w);
    expect(w.tables.social_post_images).toHaveLength(1);
    expect(w.tables.social_post_images![0]!.token).not.toBe("E".repeat(32));
    expect(w.tables.social_post_images![0]!.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("Suggest a caption", () => {
  it("needs a Claude key, and says where to add one", async () => {
    const c = await connected();
    serve({ tables: c.tables, files: c.files });
    complete.mockRejectedValueOnce(new (await import("../src/lib/http")).HttpError(501, "AI isn't turned on yet."));
    const res = await request("/social/caption", { method: "POST", body: { source: "photos", attachment_ids: [c.ids[0]] } });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toBe("Suggest a caption needs a Claude key. An owner or admin can add one in Apps → Claude.");
  });

  it("drafts from the jobs' services, never their titles, and asks again when it names the client", async () => {
    const c = await connected();
    serve({ tables: c.tables, files: c.files });
    complete.mockResolvedValueOnce("Thanks Ana Green for trusting us!").mockResolvedValueOnce("Thanks Ana Green again!");
    const res = (await (await request("/social/caption", { method: "POST", body: { source: "photos", attachment_ids: [c.ids[0]] } })).json()) as Row;
    expect(res.warning).toBe("Check the caption: it may name the client or their street.");
    const prompt = complete.mock.calls[0]![1].prompt;
    expect(prompt).toContain("Spring cleanup");
    expect(complete.mock.calls[0]![1].system).toContain("Never name a client or a reviewer");
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe("the words", () => {
  it("are the same automatic caption here and in the database", () => {
    const sql = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261031000420_automatic_review_posts.sql", import.meta.url)), "utf8");
    expect(sql).toContain(`select '${DEFAULT_REVIEW_CAPTION}'::text`);
  });

  it("tell Meta's errors apart", () => {
    expect(metaProblem(400, { error: { code: 190, error_subcode: 463 } }).kind).toBe("signin");
    expect(metaProblem(400, { error: { code: 10, message: "Requires instagram_content_publish" } })).toMatchObject({ kind: "permission", permission: "instagram_content_publish" });
    expect(metaProblem(400, { error: { code: 9, error_subcode: 2207042 } }).kind).toBe("limit");
    expect(metaProblem(400, { error: { code: 4 } })).toMatchObject({ kind: "rate", retry: true });
    expect(metaProblem(400, { error: { code: 506 } }).kind).toBe("duplicate");
    expect(metaProblem(500, { error: { code: 2 } })).toMatchObject({ kind: "other", retry: true });
    expect(metaProblem(400, { error: { code: 100, message: "Invalid parameter" } })).toMatchObject({ kind: "other", retry: false });
  });
});
