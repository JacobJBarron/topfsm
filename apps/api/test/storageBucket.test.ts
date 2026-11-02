/**
 * Moving photos and files between the storage service's volume and a Railway bucket
 * (services/storageBucket.ts), against a stand-in instance: Railway's GraphQL API, Storage (which
 * reads the volume or the bucket by the variables it was last deployed with), the bucket over S3,
 * and PostgREST are stubbed through fetch, and storage.objects through a mock of the postgres
 * package. Files sit at the keys storage-api v1.82.1 uses (tenant/bucket/name/version), and the
 * volume under its folder (GLOBAL_S3_BUCKET), so a move that gets either wrong loses them here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { adminClient } from "../src/lib/supabase";
import { railwayAccess } from "../src/services/railway";
import { bucketForDrive, moveClock, startStorageMove, storageMoveSettled, storageOverview, storageWritesPaused } from "../src/services/storageBucket";
import { forgetStorageFacts } from "../src/services/storageUsage";

interface Row {
  id: string;
  bucket_id: string;
  name: string;
  version: string | null;
  mimetype: string;
  cache_control: string;
  size: number;
  changed: number;
}
interface Stored {
  body: Uint8Array;
  type: string;
  cache: string;
}

/** The stand-in instance. */
const world = vi.hoisted(() => ({
  rows: [] as Row[],
  /** The volume, by `${folder}/${key}`. */
  volume: new Map<string, { body: Uint8Array; type: string; cache: string }>(),
  /** The bucket, by key. */
  s3: new Map<string, { body: Uint8Array; type: string; cache: string }>(),
  /** Database time, in ms. */
  now: Date.parse("2026-10-28T12:00:00Z"),
  versions: 0,
  /** Row ids made so far: a row made after another was deleted never gets that one's id. */
  ids: 0,
}));

// storage.objects, as Postgres answers the queries the move makes.
vi.mock("postgres", () => ({
  default: () => {
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      const since = (v: unknown) => (v ? Date.parse(String(v)) : null);
      const live = (from: number | null) => world.rows.filter((r) => from === null || r.changed >= from);
      if (text.includes("select now()")) return [{ now: new Date(world.now) }];
      if (text.includes("order by o.id")) {
        const [after, from, , limit] = values as [string, string | null, unknown, number];
        return live(since(from))
          .filter((r) => r.id > after)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((r) => ({ id: r.id, bucket_id: r.bucket_id, name: r.name, version: r.version, mimetype: r.mimetype, cache_control: r.cache_control, content_encoding: null, size: String(r.size) }));
      }
      if (text.includes("count(*)")) {
        const rows = live(since(values[2])).filter((r) => !r.name.startsWith("crewtavo-storage-check/"));
        return [{ files: String(rows.length), bytes: String(rows.reduce((sum, r) => sum + r.size, 0)) }];
      }
      if (text.includes("select name from storage.objects")) return world.rows.filter((r) => r.name.startsWith(String(values[1]).replace("%", ""))).map((r) => ({ name: r.name }));
      if (text.includes("as older")) return [{ older: (world.rows.find((r) => r.id === values[1])?.changed ?? Infinity) < Date.parse(String(values[0])) }];
      if (text.includes("as id, o.version")) return world.rows.filter((r) => r.bucket_id === values[0] && r.name === values[1]).map((r) => ({ id: r.id, version: r.version }));
      throw new Error(`unexpected query: ${text}`);
    };
    return Object.assign(sql, { end: async () => {} });
  },
}));

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://app.greenlawn.com",
  RAILWAY_PROJECT_ID: "proj-1",
  RAILWAY_ENVIRONMENT_ID: "env-1",
  RAILWAY_SERVICE_ID: "svc-crewtavo",
  RAILWAY_PUBLIC_DOMAIN: "crewtavo-production.up.railway.app",
  CREWTAVO_SINGLE_COMPANY: "1",
  JWT_SECRET: "a-test-secret-that-is-long-enough-for-hs256",
  SUPABASE_STORAGE_URL: "http://storage.railway.internal:5000",
  SUPABASE_DB_URL: "postgres://postgres:pw@db.railway.internal:5432/postgres",
} as Env;

const STORAGE = "storage.railway.internal:5000";
const CREDENTIALS = { accessKeyId: "AKID", secretAccessKey: "SECRET", endpoint: "https://t3.storageapi.dev", bucketName: "files-a1b2c3", region: "auto", urlStyle: "virtual-hosted" };
const S3_HOST = `${CREDENTIALS.bucketName}.t3.storageapi.dev`;
const BUCKET_VARS: Record<string, string> = { BUCKET: CREDENTIALS.bucketName, ENDPOINT: CREDENTIALS.endpoint, REGION: CREDENTIALS.region, ACCESS_KEY_ID: CREDENTIALS.accessKeyId, SECRET_ACCESS_KEY: CREDENTIALS.secretAccessKey };
const TEMPLATE_VARS = { STORAGE_BACKEND: "file", FILE_STORAGE_BACKEND_PATH: "/var/lib/storage", TENANT_ID: "crewtavo", REGION: "local", GLOBAL_S3_BUCKET: "crewtavo", FILE_SIZE_LIMIT: "209715200" };

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined) => (data ? new TextDecoder().decode(data) : undefined);
const keyOf = (r: Pick<Row, "bucket_id" | "name" | "version">, tenant = "crewtavo") => `${tenant}/${r.bucket_id}/${r.version ? `${r.name}/${r.version}` : r.name}`;

interface Options {
  /** Railway mutations and queries (by their first field) that answer "Not Authorized". */
  refuse?: string[];
  /** The project has the files bucket already, deployed here. */
  bucket?: boolean;
  /** Bucket references on a service render empty (a Railway quirk seen in the wild). */
  emptyReferences?: boolean;
  /** Storage restarts but never reads from its new settings. */
  stuck?: boolean;
  /** S3 keys whose PUT fails. */
  failPut?: string[];
  /** The storage service's volume was deleted in Railway. */
  noVolume?: boolean;
  /** Connected with Login with Railway, its hour-long token having this long left (rather than a project token). */
  oauth?: { leftMs: number };
  /** Something else refreshes the Login with Railway token just as the move makes this call, so Railway refuses the old one. */
  rotateAt?: string;
  /** Runs before the bucket takes each file. */
  beforePut?: () => Promise<void> | void;
  /** Railway calls that don't reach it, as `field#n` (the nth call of that field, from 1). */
  unreachable?: string[];
  /** Storage answers 503 to everything until the move's clock passes this (it's restarting). */
  storageDownUntil?: number;
  /** Runs while Storage takes a file's body, before it saves it (a delete landing mid-copy, say). */
  duringWrite?: (name: string) => void;
  /** Storage turns down this many deletes (500) before it takes them. */
  failDeletes?: number;
  /** Another server refreshes the Login with Railway token just before this one asks to. */
  refreshedElsewhere?: boolean;
}

interface Sent {
  /** With the token each call was made with. */
  railway: Array<{ query: string; variables: Record<string, any>; token: string }>;
  s3: Array<{ method: string; key: string; headers: Headers; length?: number }>;
  storage: Array<{ method: string; name: string }>;
  pausedAtRedeploy: boolean[];
  /** Refresh tokens Login with Railway was asked to swap. */
  refreshes: string[];
}

/** Login with Railway, as Railway sees it: which access tokens it takes until when, and the refresh token it takes now. */
interface Login {
  issued: number;
  refresh: string;
  expires: Map<string, number>;
}

/** Crewtavo's stored Railway access (integration_secrets), encrypted. */
const vault = { ciphertext: "" };
/** The Railway connection's status (integrations), which a refused refresh marks "error". */
let railwayStatus = "connected";
const CLIENT = { client_id: "client-1", client_secret: "client-secret", redirect_uri: "https://app.greenlawn.com/api/railway/callback" };

let state: {
  vars: Record<string, string>;
  /** What storage was last started with, references resolved. */
  deployed: Record<string, string>;
  buckets: Array<{ id: string; name: string; deployed: boolean }>;
  row: { settings: Record<string, any> } | null;
};

const resolve = (vars: Record<string, string>, empty = false) =>
  Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.replace(/\$\{\{files\.(\w+)\}\}/g, (_, name: string) => (empty ? "" : (BUCKET_VARS[name] ?? "")))]));

/** Where storage reads now, by what it was deployed with. */
function storageReads(row: Row): Stored | undefined {
  const d = state.deployed;
  if (d.STORAGE_BACKEND === "s3") return d.STORAGE_S3_BUCKET === CREDENTIALS.bucketName ? world.s3.get(keyOf(row, d.TENANT_ID)) : undefined;
  return world.volume.get(`${d.STORAGE_S3_BUCKET || d.GLOBAL_S3_BUCKET}/${keyOf(row, d.TENANT_ID)}`);
}

function storageWrites(row: Row, stored: Stored) {
  const d = state.deployed;
  if (d.STORAGE_BACKEND === "s3") world.s3.set(keyOf(row, d.TENANT_ID), stored);
  else world.volume.set(`${d.STORAGE_S3_BUCKET || d.GLOBAL_S3_BUCKET}/${keyOf(row, d.TENANT_ID)}`, stored);
}

const nextId = () => `00000000-0000-4000-8000-${String(++world.ids).padStart(12, "0")}`;
const nextVersion = () => `v-${++world.versions}`;

/** A file uploaded through storage, wherever it reads now. */
function upload(name: string, content: string, type = "image/jpeg", cache = "max-age=3600") {
  const row: Row = { id: nextId(), bucket_id: "files", name, version: nextVersion(), mimetype: type, cache_control: cache, size: bytes(content).length, changed: world.now };
  world.rows.push(row);
  storageWrites(row, { body: bytes(content), type, cache });
  return row;
}

const oauthSecret = (token: string, refresh: string, expiresAt: number) => ({ access_token: token, refresh_token: refresh, expires_at: expiresAt, extra: { method: "oauth", ...CLIENT } });

async function serve(options: Options = {}): Promise<Sent> {
  const login: Login = { issued: 1, refresh: "refresh-1", expires: new Map() };
  railwayStatus = "connected";
  if (options.oauth) {
    login.expires.set("token-1", Date.now() + options.oauth.leftMs);
    vault.ciphertext = await encryptJson(env, oauthSecret("token-1", "refresh-1", Date.now() + options.oauth.leftMs));
  } else vault.ciphertext = await encryptJson(env, { api_key: "project-token", extra: { method: "token" } });
  const sent: Sent = { railway: [], s3: [], storage: [], pausedAtRedeploy: [], refreshes: [] };
  const calls = new Map<string, number>();
  let deletesTurnedDown = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    if (url.host === "backboard.railway.com" && url.pathname === "/oauth/token") return oauthToken(new URLSearchParams(String(init?.body)), headers, options, login, sent);
    if (url.host === "backboard.railway.com") {
      const body = JSON.parse(String(init?.body));
      const field = body.query.match(/\{\s*(\w+)/)?.[1] ?? "";
      const n = (calls.get(field) ?? 0) + 1;
      calls.set(field, n);
      if (options.unreachable?.includes(`${field}#${n}`)) throw new TypeError("fetch failed");
      return railway(body, headers, options, login, sent);
    }
    if (url.host === STORAGE) {
      if (options.storageDownUntil !== undefined && virtual < options.storageDownUntil) {
        sent.storage.push({ method, name: "(down)" });
        return Response.json({ message: "Application failed to respond" }, { status: 503 });
      }
      if (method === "DELETE" && deletesTurnedDown < (options.failDeletes ?? 0)) {
        deletesTurnedDown++;
        sent.storage.push({ method, name: "(turned down)" });
        return Response.json({ statusCode: "500", error: "Internal" }, { status: 500 });
      }
      return storage(url, method, headers, init?.body, options, sent);
    }
    if (url.host === S3_HOST) return s3(url, method, headers, init?.body, options, sent);
    if (url.host === "example.supabase.co") return postgrest(url, method, init?.body);
    throw new Error(`unexpected request to ${url}`);
  });
  return sent;
}

/** Login with Railway's token endpoint: swaps the current refresh token for a new hour-long token, and a new refresh token. */
async function oauthToken(form: URLSearchParams, headers: Headers, options: Options, login: Login, sent: Sent): Promise<Response> {
  expect(headers.get("authorization")).toBe(`Basic ${btoa(`${CLIENT.client_id}:${CLIENT.client_secret}`)}`);
  sent.refreshes.push(form.get("refresh_token") ?? "");
  if (options.refreshedElsewhere && login.issued === 1) {
    // Another server sent refresh-1 a moment before, and saved what it got.
    login.issued = 2;
    login.refresh = "refresh-2";
    login.expires.set("token-2", Date.now() + 3600_000);
    vault.ciphertext = await encryptJson(env, oauthSecret("token-2", "refresh-2", Date.now() + 3600_000));
  }
  if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== login.refresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
  const token = `token-${++login.issued}`;
  login.refresh = `refresh-${login.issued}`;
  login.expires.set(token, Date.now() + 3600_000);
  return Response.json({ access_token: token, refresh_token: login.refresh, expires_in: 3600, token_type: "Bearer" });
}

async function railway(body: { query: string; variables: Record<string, any> }, headers: Headers, options: Options, login: Login, sent: Sent): Promise<Response> {
  const { query, variables } = body;
  const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? headers.get("project-access-token") ?? "";
  sent.railway.push({ ...body, token });
  const field = query.match(/\{\s*(\w+)/)?.[1] ?? "";
  // A Login with Railway token is taken until it runs out.
  if (login.expires.has(token) && login.expires.get(token)! <= Date.now()) return Response.json({ errors: [{ message: "Not Authorized" }] }, { status: 401 });
  if (options.rotateAt === field && token === "token-1") {
    // Refreshed elsewhere just now (and saved), which ends the old token.
    login.expires.set("token-1", 0);
    login.expires.set("token-2", Date.now() + 3600_000);
    login.issued = 2;
    login.refresh = "refresh-2";
    vault.ciphertext = await encryptJson(env, oauthSecret("token-2", "refresh-2", Date.now() + 3600_000));
    return Response.json({ errors: [{ message: "Not Authorized" }] }, { status: 401 });
  }
  if (options.refuse?.includes(field)) return Response.json({ errors: [{ message: "Not Authorized" }] });
  const data = (value: unknown) => Response.json({ data: value });
  if (query.includes("buckets(first")) return data({ project: { buckets: { edges: state.buckets.map(({ id, name }) => ({ node: { id, name } })) } } });
  if (query.includes("services(first")) {
    return data({ project: { name: "Crewtavo", subscriptionType: "hobby", createdAt: "2026-09-01T00:00:00Z", services: { edges: [{ node: { id: "svc-crewtavo", name: "crewtavo" } }, { node: { id: "svc-storage", name: "storage" } }] } } });
  }
  if (field === "variables") return data({ variables: resolve(state.vars, options.emptyReferences) });
  if (field === "variableCollectionUpsert") {
    expect(variables.input).toMatchObject({ projectId: "proj-1", environmentId: "env-1", serviceId: "svc-storage", skipDeploys: true });
    Object.assign(state.vars, variables.input.variables);
    return data({ variableCollectionUpsert: true });
  }
  if (field === "serviceInstanceRedeploy") {
    expect(variables.serviceId).toBe("svc-storage");
    sent.pausedAtRedeploy.push(storageWritesPaused());
    if (!options.stuck) state.deployed = resolve(state.vars, options.emptyReferences);
    return data({ serviceInstanceRedeploy: true });
  }
  if (field === "serviceInstance") return data({ serviceInstance: { region: "us-east4-eqdc4a" } });
  if (field === "bucketCreate") {
    state.buckets.push({ id: "bkt-new", name: variables.input.name, deployed: false });
    return data({ bucketCreate: { id: "bkt-new", name: variables.input.name } });
  }
  if (field === "environment") {
    const volumes = options.noVolume ? [] : [{ node: { serviceId: "svc-storage", currentSizeMB: 1200, sizeMB: 5000 } }];
    return data({ environment: { unmergedChangesCount: 0, volumeInstances: { edges: volumes } } });
  }
  if (field === "environmentPatchCommit") {
    for (const id of Object.keys(variables.patch.buckets)) state.buckets.find((b) => b.id === id)!.deployed = true;
    return data({ environmentPatchCommit: "patch-1" });
  }
  if (field === "bucketS3Credentials") return data({ bucketS3Credentials: state.buckets.find((b) => b.id === variables.bucketId)?.deployed ? [CREDENTIALS] : [] });
  if (field === "bucketInstanceDetails") return data({ bucketInstanceDetails: { sizeBytes: String([...world.s3.values()].reduce((n, o) => n + o.body.length, 0)), objectCount: String(world.s3.size) } });
  return Response.json({ errors: [{ message: `unexpected ${field}` }] });
}

const readAll = async (body: BodyInit | null | undefined) => new Uint8Array(await new Response(body ?? null).arrayBuffer());

async function storage(url: URL, method: string, headers: Headers, body: BodyInit | null | undefined, options: Options, sent: Sent): Promise<Response> {
  expect(headers.get("authorization")).toBe("Bearer service-key");
  const [, , bucket, ...rest] = url.pathname.split("/").map(decodeURIComponent);
  const name = rest.join("/");
  sent.storage.push({ method, name });
  let row = world.rows.find((r) => r.bucket_id === bucket && r.name === name);
  if (method === "DELETE") {
    if (!row) return Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 });
    world.rows = world.rows.filter((r) => r !== row);
    const d = state.deployed;
    if (d.STORAGE_BACKEND === "s3") world.s3.delete(keyOf(row, d.TENANT_ID));
    else world.volume.delete(`${d.STORAGE_S3_BUCKET || d.GLOBAL_S3_BUCKET}/${keyOf(row, d.TENANT_ID)}`);
    return Response.json({ message: "Successfully deleted" });
  }
  if (method === "GET") {
    if (!row) return Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 });
    const stored = storageReads(row);
    // The file backend errors on a file it doesn't have; S3 says NoSuchKey.
    if (!stored) return state.deployed.STORAGE_BACKEND === "s3" ? Response.json({ statusCode: "404", error: "Not found", code: "NoSuchKey" }, { status: 400 }) : Response.json({ statusCode: "500", error: "Internal" }, { status: 500 });
    const range = headers.get("range") === "bytes=0-0";
    const data = range ? stored.body.slice(0, 1) : stored.body;
    return new Response(data, { status: range ? 206 : 200, headers: { "content-type": stored.type, "cache-control": `${stored.cache}, stale-while-revalidate=30`, "content-length": String(data.length) } });
  }
  if (method === "POST") {
    const data = await readAll(body);
    expect(Number(headers.get("content-length"))).toBe(data.length);
    // Storage looks the row up again only once it has the whole body.
    if (options.duringWrite) {
      options.duringWrite(name);
      row = world.rows.find((r) => r.bucket_id === bucket && r.name === name);
    }
    if (row && headers.get("x-upsert") !== "true") return Response.json({ statusCode: "409", error: "Duplicate" }, { status: 400 });
    const next: Row = row ?? { id: nextId(), bucket_id: bucket!, name, version: null, mimetype: "", cache_control: "", size: 0, changed: 0 };
    Object.assign(next, { version: nextVersion(), mimetype: headers.get("content-type")!, cache_control: headers.get("cache-control")!, size: data.length, changed: world.now });
    if (!row) world.rows.push(next);
    storageWrites(next, { body: data, type: next.mimetype, cache: next.cache_control });
    return Response.json({ Key: `${bucket}/${name}` });
  }
  throw new Error(`unexpected storage ${method}`);
}

async function s3(url: URL, method: string, headers: Headers, body: BodyInit | null | undefined, options: Options, sent: Sent): Promise<Response> {
  // Signed with the bucket's keys, and the body not hashed (it streams).
  expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/);
  expect(headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
  const key = url.pathname.slice(1).split("/").map(decodeURIComponent).join("/");
  if (method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const items = [...world.s3].filter(([k]) => k.startsWith(prefix)).map(([k, o]) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${o.body.length}</Size></Contents>`);
    sent.s3.push({ method: "LIST", key: prefix, headers });
    return new Response(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items.join("")}</ListBucketResult>`);
  }
  if (method === "PUT") {
    await options.beforePut?.();
    const data = await readAll(body);
    sent.s3.push({ method, key, headers, length: data.length });
    expect(Number(headers.get("content-length"))).toBe(data.length);
    if (options.failPut?.includes(key)) return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
    world.s3.set(key, { body: data, type: headers.get("content-type")!, cache: headers.get("cache-control")! });
    return new Response(null, { headers: { etag: '"md5"' } });
  }
  if (method === "GET") {
    sent.s3.push({ method, key, headers });
    const stored = world.s3.get(key);
    if (!stored) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    return new Response(stored.body, { headers: { "content-type": stored.type, "cache-control": stored.cache, "content-length": String(stored.body.length) } });
  }
  throw new Error(`unexpected S3 ${method}`);
}

/** Settings → Storage's default limit, as the server saved it (storage_set_default). */
const defaultsSet: unknown[] = [];

async function postgrest(url: URL, method: string, body: BodyInit | null | undefined): Promise<Response> {
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  if (path === "rpc/storage_set_default") {
    defaultsSet.push(JSON.parse(String(body)));
    return new Response(null, { status: 204 });
  }
  const provider = url.searchParams.get("provider");
  if (path === "integration_secrets" && method === "POST") {
    const [row] = ([] as Array<{ provider: string; ciphertext: string }>).concat(JSON.parse(String(body)));
    if (row!.provider === "railway") vault.ciphertext = row!.ciphertext;
    return new Response(null, { status: 201 });
  }
  if (path === "integration_secrets") return Response.json(provider === "eq.railway" ? [{ ciphertext: vault.ciphertext }] : []);
  if (path !== "integrations") return Response.json([]);
  if (provider === "eq.railway") {
    if (method === "PATCH") railwayStatus = (JSON.parse(String(body)) as { status?: string }).status ?? railwayStatus;
    return Response.json([{ status: railwayStatus }]);
  }
  if (method === "GET") return Response.json(state.row ? [{ settings: state.row.settings }] : []);
  if (method === "PATCH") {
    const lease = url.searchParams.get("settings->move->>lease");
    const current = state.row?.settings.move?.lease ?? null;
    const matches = state.row && (lease === "is.null" ? current === null : lease === `eq.${current}`);
    if (!matches) return Response.json([]);
    state.row = { settings: JSON.parse(String(body)).settings };
    return Response.json([{ company_id: "co-1" }]);
  }
  if (method === "POST") {
    if (state.row) return Response.json({ code: "23505", message: "duplicate key", details: null, hint: null }, { status: 409 });
    state.row = { settings: JSON.parse(String(body)).settings };
    return new Response(null, { status: 201 });
  }
  return Response.json([]);
}

/** The move as it was saved last. */
const saved = () => state.row?.settings.move as Record<string, any>;
const railwayFields = (sent: Sent) => sent.railway.map((b) => b.query.match(/\{\s*(\w+)/)?.[1]);
const upserts = (sent: Sent) => sent.railway.filter((b) => b.query.includes("variableCollectionUpsert")).map((b) => b.variables.input.variables);

let virtual = 0;

beforeEach(() => {
  defaultsSet.length = 0;
  forgetStorageFacts();
  world.rows = [];
  world.volume = new Map();
  world.s3 = new Map();
  world.versions = 0;
  world.ids = 0;
  state ={ vars: { ...TEMPLATE_VARS }, deployed: { ...TEMPLATE_VARS }, buckets: [], row: null };
  virtual = 0;
  moveClock.wait = async (ms) => {
    virtual += ms;
  };
  moveClock.now = () => virtual;
});

afterEach(async () => {
  await storageMoveSettled("co-1");
  vi.unstubAllGlobals();
});

/** A volume with three files on it: a plan set, a visit photo and a résumé. */
function onTheVolume() {
  return [
    upload("11111111-1111-4111-8111-111111111111/plans/0b1c.pdf", "%PDF-1.7 plan set", "application/pdf", "no-cache"),
    upload("11111111-1111-4111-8111-111111111111/visit/9a/3f.jpg", "a visit photo"),
    upload("11111111-1111-4111-8111-111111111111/applicants/7c/1.docx", "a résumé", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
  ];
}

async function moveToBucket(options: Options = {}) {
  const sent = await serve(options);
  await startStorageMove(env, adminClient(env), "co-1", "to_bucket");
  await storageMoveSettled("co-1");
  return sent;
}

describe("moving files to a Railway bucket", () => {
  it("makes the bucket, copies every file to storage's own key with its type and caching, then switches storage over", async () => {
    const files = onTheVolume();
    const volumeBefore = new Map(world.volume);
    const sent = await moveToBucket();

    expect(saved()).toMatchObject({ direction: "to_bucket", step: "done", files: 3, copied: 3, missing: 0, stranded: 0, error: null, byHand: null, bucket: { id: "bkt-new", name: "files" }, folder: "crewtavo" });
    expect(saved().switchedAt).toEqual(expect.any(String));
    // The bucket: made in the project, then put in this environment near storage (us-east → iad).
    expect(railwayFields(sent)).toEqual(expect.arrayContaining(["bucketCreate", "environmentPatchCommit"]));
    expect(sent.railway.find((b) => b.query.includes("environmentPatchCommit"))!.variables.patch).toEqual({ buckets: { "bkt-new": { region: "iad", isCreated: true } } });
    // Every file at tenant/bucket/name/version, as it was, with the type and caching storage had for it.
    for (const f of files) {
      const copy = world.s3.get(keyOf(f));
      expect(text(copy?.body)).toBe(text(volumeBefore.get(`crewtavo/${keyOf(f)}`)!.body));
      expect(copy).toMatchObject({ type: f.mimetype, cache: f.cache_control });
    }
    // The check file stays on the volume only.
    expect([...world.s3.keys()].some((k) => k.includes("crewtavo-storage-check"))).toBe(false);
    // Storage reads from the bucket through references to it, with the volume left as it was.
    expect(upserts(sent)).toEqual([
      {
        STORAGE_BACKEND: "s3",
        STORAGE_S3_BUCKET: "${{files.BUCKET}}",
        STORAGE_S3_ENDPOINT: "${{files.ENDPOINT}}",
        STORAGE_S3_REGION: "${{files.REGION}}",
        STORAGE_S3_FORCE_PATH_STYLE: "false",
        AWS_ACCESS_KEY_ID: "${{files.ACCESS_KEY_ID}}",
        AWS_SECRET_ACCESS_KEY: "${{files.SECRET_ACCESS_KEY}}",
        TUS_ALLOW_S3_TAGS: "false",
        STORAGE_S3_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
        STORAGE_S3_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED",
      },
    ]);
    for (const [key, value] of volumeBefore) expect(world.volume.get(key)).toBe(value);
    // Uploads waited while Crewtavo restarted storage, and not after.
    expect(sent.pausedAtRedeploy).toEqual([true]);
    expect(storageWritesPaused()).toBe(false);
    // And files open from the bucket now.
    for (const f of files) expect(text(storageReads(f)?.body)).toBe(text(world.s3.get(keyOf(f))!.body));
  });

  it("skips files already in the bucket at their size, and copies one that's short again", async () => {
    const [plan, photo] = onTheVolume();
    world.s3.set(keyOf(plan!), { body: bytes("%PDF-1.7 plan set"), type: "application/pdf", cache: "no-cache" });
    world.s3.set(keyOf(photo!), { body: bytes("a visit"), type: "image/jpeg", cache: "max-age=3600" });
    const sent = await moveToBucket({ bucket: true });
    const puts = sent.s3.filter((r) => r.method === "PUT").map((r) => r.key);
    expect(puts).not.toContain(keyOf(plan!));
    expect(puts).toContain(keyOf(photo!));
    expect(text(world.s3.get(keyOf(photo!))?.body)).toBe("a visit photo");
    expect(saved()).toMatchObject({ step: "done", copied: 3 });
  });

  it("doesn't switch when a file didn't copy, and says which", async () => {
    const [plan] = onTheVolume();
    const sent = await moveToBucket({ failPut: [keyOf(plan!)] });
    expect(saved()).toMatchObject({ step: "failed", switchedAt: null });
    expect(saved().error).toContain("1 file didn't copy to the bucket, so Crewtavo didn't switch over");
    expect(saved().problems).toEqual(["plans/0b1c.pdf: the bucket answered 500"]);
    expect(upserts(sent)).toEqual([]);
    expect(state.deployed.STORAGE_BACKEND).toBe("file");
  });

  it("counts a file that was already gone from the volume, and moves the rest", async () => {
    const [, photo] = onTheVolume();
    world.volume.delete(`crewtavo/${keyOf(photo!)}`);
    await moveToBucket();
    expect(saved()).toMatchObject({ step: "done", missing: 1, stranded: 0, files: 3, copied: 2 });
  });

  it("puts storage's settings back when it doesn't come back reading from the bucket", async () => {
    onTheVolume();
    const sent = await moveToBucket({ stuck: true });
    expect(saved().step).toBe("failed");
    expect(saved().error).toContain("Storage didn't start reading from the bucket within 15 minutes, so Crewtavo put its settings back");
    expect(upserts(sent).at(-1)).toEqual({ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" });
    expect(sent.railway.filter((b) => b.query.includes("serviceInstanceRedeploy"))).toHaveLength(2);
    expect(storageWritesPaused()).toBe(false);
  });

  it("puts the bucket's own values in when Railway leaves the references empty", async () => {
    const files = onTheVolume();
    const sent = await moveToBucket({ emptyReferences: true });
    expect(upserts(sent)[1]).toEqual({ STORAGE_S3_BUCKET: "files-a1b2c3", STORAGE_S3_ENDPOINT: "https://t3.storageapi.dev", STORAGE_S3_REGION: "auto", AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "SECRET" });
    expect(saved().step).toBe("done");
    expect(text(storageReads(files[0]!)?.body)).toBe("%PDF-1.7 plan set");
  });
});

describe("what Railway doesn't let Crewtavo do", () => {
  it("asks the owner to add the bucket, then carries on from Carry on", async () => {
    onTheVolume();
    const sent = await moveToBucket({ refuse: ["bucketCreate"] });
    expect(saved()).toMatchObject({ step: "by_hand", byHand: { title: "Add a bucket in Railway", watching: false, link: "https://railway.com/project/proj-1?environmentId=env-1" } });
    expect(saved().byHand.steps.join(" ")).toContain("name it files (pick the US East region");
    expect(sent.s3).toEqual([]);

    // Added and deployed by hand.
    state.buckets.push({ id: "bkt-hand", name: "files", deployed: true });
    const again = await moveToBucket();
    expect(railwayFields(again)).not.toContain("bucketCreate");
    expect(saved()).toMatchObject({ step: "done", bucket: { id: "bkt-hand" } });
  });

  it("lists the variables when it can't set them, and finishes once storage has switched", async () => {
    const files = onTheVolume();
    // The owner pastes the lines and deploys while Crewtavo watches.
    let waits = 0;
    moveClock.wait = async (ms) => {
      virtual += ms;
      if (saved()?.byHand?.watching && ++waits === 2) {
        Object.assign(state.vars, Object.fromEntries((saved().byHand.lines as string[]).map((l) => l.split(/=(.*)/s).slice(0, 2))));
        state.deployed = resolve(state.vars);
      }
    };
    // A photo arrives on the volume while the owner is in Railway.
    const late = vi.fn(() => upload("11111111-1111-4111-8111-111111111111/visit/9a/late.jpg", "a late photo"));
    const sent = await serve({ refuse: ["variableCollectionUpsert"] });
    await startStorageMove(env, adminClient(env), "co-1", "to_bucket");
    for (let i = 0; i < 200 && saved()?.step !== "switching"; i++) await new Promise((r) => setTimeout(r, 1));
    late();
    await storageMoveSettled("co-1");
    expect(sent.pausedAtRedeploy).toEqual([]);
    expect(saved()).toMatchObject({ step: "done", byHand: null, stranded: 0 });
    expect(world.s3.has(keyOf(late.mock.results[0]!.value as Row))).toBe(true);
    for (const f of files) expect(storageReads(f)).toBeDefined();
  });
});

describe("Login with Railway's hour-long token", () => {
  it("is refreshed as it runs out during a long copy, so the switch isn't refused", async () => {
    const files = onTheVolume();
    const realNow = Date.now.bind(Date);
    let later = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + later);
    let begin = () => {};
    const begun = new Promise<void>((resolve) => (begin = resolve));
    try {
      // Ten minutes left on the token as the move starts, and the copy takes a quarter of an hour.
      const sent = await serve({
        oauth: { leftMs: 10 * 60_000 },
        beforePut: async () => {
          await begun;
          later = 15 * 60_000;
        },
      });
      await startStorageMove(env, adminClient(env), "co-1", "to_bucket");
      begin();
      await storageMoveSettled("co-1");

      expect(saved()).toMatchObject({ step: "done", byHand: null, error: null, stranded: 0 });
      // Refreshed once, as it ran out, and the switch went with the new token.
      expect(sent.refreshes).toEqual(["refresh-1"]);
      const switching = sent.railway.filter((b) => /variableCollectionUpsert|serviceInstanceRedeploy/.test(b.query));
      expect(switching.map((b) => b.token)).toEqual(["token-2", "token-2"]);
      expect(sent.pausedAtRedeploy).toEqual([true]);
      for (const f of files) expect(storageReads(f)).toBeDefined();
    } finally {
      begin();
      await storageMoveSettled("co-1");
      clock.mockRestore();
    }
  });

  it("goes again with the new token when something else refreshed it just as the switch was made", async () => {
    const files = onTheVolume();
    const sent = await moveToBucket({ oauth: { leftMs: 50 * 60_000 }, rotateAt: "variableCollectionUpsert" });
    expect(saved()).toMatchObject({ step: "done", byHand: null, error: null });
    expect(sent.railway.filter((b) => b.query.includes("variableCollectionUpsert")).map((b) => b.token)).toEqual(["token-1", "token-2"]);
    expect(sent.railway.filter((b) => b.query.includes("serviceInstanceRedeploy")).map((b) => b.token)).toEqual(["token-2"]);
    for (const f of files) expect(storageReads(f)).toBeDefined();
  });

  it("is refreshed once when the page and a move ask for it at the same moment, and stays connected", async () => {
    const sent = await serve({ oauth: { leftMs: 60_000 } });
    const admin = adminClient(env);
    const [a, b, page] = await Promise.all([railwayAccess(env, admin, "co-1"), railwayAccess(env, admin, "co-1"), storageOverview(env, admin, "co-1")]);
    expect(sent.refreshes).toEqual(["refresh-1"]);
    expect([a?.token, b?.token]).toEqual(["token-2", "token-2"]);
    expect(page.unavailable).toBeNull();
    expect(railwayStatus).toBe("connected");
  });

  it("isn't marked lapsed when another server refreshed it just before", async () => {
    const sent = await serve({ oauth: { leftMs: 60_000 }, refreshedElsewhere: true });
    const access = await railwayAccess(env, adminClient(env), "co-1");
    // Railway turned down refresh-1, which the other server had used: its new token is the one to use.
    expect(sent.refreshes).toEqual(["refresh-1"]);
    expect(access?.token).toBe("token-2");
    expect(railwayStatus).toBe("connected");
  });
});

describe("carrying on after the server stopped partway through the switch", () => {
  /** What storage is set to when Crewtavo has pointed it at the bucket. */
  const BUCKET_REFS = {
    STORAGE_BACKEND: "s3",
    STORAGE_S3_BUCKET: "${{files.BUCKET}}",
    STORAGE_S3_ENDPOINT: "${{files.ENDPOINT}}",
    STORAGE_S3_REGION: "${{files.REGION}}",
    STORAGE_S3_FORCE_PATH_STYLE: "false",
    AWS_ACCESS_KEY_ID: "${{files.ACCESS_KEY_ID}}",
    AWS_SECRET_ACCESS_KEY: "${{files.SECRET_ACCESS_KEY}}",
  };

  /**
   * Crewtavo had copied every file, pointed storage at the bucket and was about to restart it when
   * its server stopped, so storage still reads the volume. A photo came in after the last copy, and
   * nobody opened Settings → Hosting (which carries the move on) for a day.
   */
  function stoppedMidSwitch() {
    const files = onTheVolume();
    upload("crewtavo-storage-check/volume.txt", "Crewtavo tells where files are kept by this file (on the volume). Leave it here.\n", "text/plain", "no-cache");
    for (const f of files) world.s3.set(keyOf(f), { ...world.volume.get(`crewtavo/${keyOf(f)}`)! });
    const since = new Date(world.now).toISOString();
    world.now += 60_000;
    const late = upload("11111111-1111-4111-8111-111111111111/visit/9a/late.jpg", "a photo taken after the last copy");
    world.now += 24 * 60 * 60_000;
    state.buckets.push({ id: "bkt-1", name: "files", deployed: true });
    Object.assign(state.vars, BUCKET_REFS);
    state.row = {
      settings: {
        move: {
          direction: "to_bucket", step: "switching", startedAt: "2026-10-01T11:00:00Z", updatedAt: "2026-10-01T11:20:00Z", finishedAt: null,
          files: 3, copied: 3, bytes: 0, copiedBytes: 0, missing: 0, problems: [], stranded: 0, switchedAt: null, byHand: null, error: null,
          run: "run-1", lease: "old-server", bucket: { id: "bkt-1", name: "files" }, folder: "crewtavo", since,
          undo: { STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" }, skipped: [],
        },
      },
    };
    return { files, late };
  }

  it("copies what came in since the last copy before switching, so no file is left behind", async () => {
    const { files, late } = stoppedMidSwitch();
    const sent = await serve();
    await storageOverview(env, adminClient(env), "co-1");
    await storageMoveSettled("co-1");

    expect(saved()).toMatchObject({ direction: "to_bucket", step: "done", stranded: 0, error: null, run: "run-1" });
    expect(saved().lease).not.toBe("old-server");
    expect(text(world.s3.get(keyOf(late))?.body)).toBe("a photo taken after the last copy");
    expect(sent.pausedAtRedeploy).toEqual([true]);
    expect(state.deployed.STORAGE_BACKEND).toBe("s3");
    for (const f of [...files, late]) expect(storageReads(f)).toBeDefined();
  });

  it("doesn't switch when one of them doesn't copy, and puts storage's settings back", async () => {
    const { late } = stoppedMidSwitch();
    const sent = await serve({ failPut: [keyOf(late)] });
    await storageOverview(env, adminClient(env), "co-1");
    await storageMoveSettled("co-1");

    expect(saved()).toMatchObject({ step: "failed", switchedAt: null, undo: null, byHand: null });
    expect(saved().error).toContain("1 file didn't copy to the bucket, so Crewtavo didn't switch over");
    // Storage was pointed back at the volume and restarted there, so its next restart doesn't switch without the photo.
    expect(upserts(sent)).toEqual([{ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" }]);
    expect(state.deployed).toMatchObject({ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" });
    expect(text(storageReads(late)?.body)).toBe("a photo taken after the last copy");
  });

  it("waits for storage to answer when it's restarting, then copies what came in before switching", async () => {
    const { files, late } = stoppedMidSwitch();
    // Storage is restarting as the move is taken over, and answers again a minute later.
    const sent = await serve({ storageDownUntil: 60_000 });
    await storageOverview(env, adminClient(env), "co-1");
    await storageMoveSettled("co-1");

    expect(sent.storage.some((s) => s.name === "(down)")).toBe(true);
    expect(saved()).toMatchObject({ direction: "to_bucket", step: "done", stranded: 0, error: null });
    expect(text(world.s3.get(keyOf(late))?.body)).toBe("a photo taken after the last copy");
    expect(state.deployed.STORAGE_BACKEND).toBe("s3");
    for (const f of [...files, late]) expect(storageReads(f)).toBeDefined();
  });

  it("doesn't switch when storage doesn't answer at all, and puts its settings back", async () => {
    const { late } = stoppedMidSwitch();
    const sent = await serve({ storageDownUntil: Infinity });
    await storageOverview(env, adminClient(env), "co-1");
    await storageMoveSettled("co-1");

    expect(saved()).toMatchObject({ step: "failed", switchedAt: null, undo: null, byHand: null });
    expect(saved().error).toContain("Storage didn't answer for 15 minutes, so Crewtavo didn't switch over");
    expect(upserts(sent)).toEqual([{ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" }]);
    expect(state.deployed).toMatchObject({ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" });
    expect(world.s3.has(keyOf(late))).toBe(false);
  });

  it("moving back, copies back what was added in the bucket", async () => {
    onTheVolume();
    await moveToBucket();
    world.now += 60_000;
    const added = upload("11111111-1111-4111-8111-111111111111/plans/new.pdf", "%PDF a plan added in the bucket", "application/pdf", "no-cache");
    // Pointed back at the volume, and not restarted yet, when the server stopped.
    Object.assign(state.vars, { STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" });
    state.row!.settings.move = {
      ...saved(), direction: "to_volume", step: "switching", lease: "old-server", updatedAt: "2026-10-01T11:20:00Z", finishedAt: null, switchedAt: null, error: null, byHand: null,
      undo: { STORAGE_BACKEND: "s3", STORAGE_S3_BUCKET: CREDENTIALS.bucketName },
    };
    world.now += 24 * 60 * 60_000;
    await serve();
    await storageOverview(env, adminClient(env), "co-1");
    await storageMoveSettled("co-1");

    expect(saved()).toMatchObject({ direction: "to_volume", step: "done", error: null });
    expect(state.deployed).toMatchObject({ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" });
    const back = world.rows.find((r) => r.name === added.name)!;
    expect(text(storageReads(back)?.body)).toBe("%PDF a plan added in the bucket");
  });
});

describe("moving files back to the volume", () => {
  it("points storage at the volume's folder again and copies back what was added meanwhile, as new versions", async () => {
    const files = onTheVolume();
    await moveToBucket();
    world.now += 60_000;
    const added = upload("11111111-1111-4111-8111-111111111111/plans/new.pdf", "%PDF a plan added later", "application/pdf", "no-cache");
    const inBucket = keyOf(added);
    const addedVersion = added.version;
    expect(world.s3.has(inBucket)).toBe(true);
    const volumeBefore = new Map(world.volume);

    const sent = await serve();
    await startStorageMove(env, adminClient(env), "co-1", "to_volume");
    await storageMoveSettled("co-1");

    expect(saved()).toMatchObject({ direction: "to_volume", step: "done", error: null });
    // STORAGE_S3_BUCKET goes back to the volume's folder: left on the bucket's name, every file would be looked for in the wrong place.
    expect(upserts(sent)).toEqual([{ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" }]);
    expect(state.deployed).toMatchObject({ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" });
    // The file added in the bucket is back, with its type and caching, under a new version.
    const back = world.rows.find((r) => r.name === added.name)!;
    expect(back.version).not.toBe(addedVersion);
    expect(storageReads(back)).toMatchObject({ type: "application/pdf", cache: "no-cache" });
    expect(text(storageReads(back)?.body)).toBe("%PDF a plan added later");
    // Files from before the move weren't touched: same versions, read from the volume as they were.
    for (const f of files) {
      expect(world.rows.find((r) => r.id === f.id)!.version).toBe(f.version);
      expect(storageReads(f)).toBe(volumeBefore.get(`crewtavo/${keyOf(f)}`));
    }
    // Nothing was taken off the bucket either.
    expect(world.s3.has(inBucket)).toBe(true);
  });
});

describe("moving back after a move that couldn't put storage's settings back", () => {
  /** Files were copied and storage pointed at the bucket; then Railway couldn't be reached to restart storage, nor to put its settings back. */
  async function failedUndo() {
    const files = onTheVolume();
    await moveToBucket({ unreachable: ["serviceInstanceRedeploy#1", "variableCollectionUpsert#2"] });
    expect(saved()).toMatchObject({ direction: "to_bucket", step: "failed", switchedAt: null, byHand: { title: "Put storage's settings back in Railway" } });
    // Storage still reads the volume, but its settings say the bucket: the page offers Move back.
    expect(state.vars.STORAGE_BACKEND).toBe("s3");
    expect(state.deployed.STORAGE_BACKEND).toBe("file");
    return files;
  }

  it("points storage's settings at the volume before it says it's done", async () => {
    const files = await failedUndo();
    const sent = await serve();
    await startStorageMove(env, adminClient(env), "co-1", "to_volume");
    await storageMoveSettled("co-1");

    expect(saved()).toMatchObject({ direction: "to_volume", step: "done", byHand: null, error: null });
    expect(upserts(sent)).toEqual([{ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" }]);
    expect(state.vars).toMatchObject({ STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" });
    // It read the volume all along, so it isn't restarted.
    expect(railwayFields(sent)).not.toContain("serviceInstanceRedeploy");
    for (const f of files) expect(storageReads(f)).toBeDefined();
  });

  it("keeps the lines up, and doesn't finish, until storage's settings say the volume", async () => {
    await failedUndo();
    await serve({ refuse: ["variableCollectionUpsert"] });
    await startStorageMove(env, adminClient(env), "co-1", "to_volume");
    await storageMoveSettled("co-1");
    expect(saved()).toMatchObject({
      direction: "to_volume",
      step: "failed",
      byHand: { title: "Point storage at the volume in Railway", lines: ["STORAGE_BACKEND=file", "STORAGE_S3_BUCKET=crewtavo"], watching: false },
    });
    expect(saved().switchedAt).toEqual(expect.any(String));
    expect(saved().error).toContain("its settings in Railway still say the bucket");

    // Finish moving back, with Railway still refusing: still not done, and the lines stay.
    await serve({ refuse: ["variableCollectionUpsert"] });
    await startStorageMove(env, adminClient(env), "co-1", "to_volume");
    await storageMoveSettled("co-1");
    expect(saved()).toMatchObject({ step: "failed", byHand: { title: "Point storage at the volume in Railway" } });

    // The owner changes them in Railway; Finish moving back finishes.
    Object.assign(state.vars, { STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: "crewtavo" });
    const sent = await serve();
    await startStorageMove(env, adminClient(env), "co-1", "to_volume");
    await storageMoveSettled("co-1");
    expect(saved()).toMatchObject({ step: "done", byHand: null, error: null });
    expect(upserts(sent)).toEqual([]);
  });

  it("keeps the lines to put the settings back when moving back stops before it gets that far", async () => {
    await failedUndo();
    await serve({ unreachable: ["bucketS3Credentials#1"] });
    await startStorageMove(env, adminClient(env), "co-1", "to_volume");
    await storageMoveSettled("co-1");
    expect(saved()).toMatchObject({ direction: "to_volume", step: "failed", switchedAt: null, byHand: { title: "Put storage's settings back in Railway" } });
    expect(saved().byHand.lines).toEqual(["STORAGE_BACKEND=file", "STORAGE_S3_BUCKET=crewtavo"]);
  });
});

describe("a file deleted while it copies back", () => {
  /** A résumé uploaded while files were in the bucket. */
  async function addedInTheBucket() {
    onTheVolume();
    await moveToBucket();
    world.now += 60_000;
    return upload("11111111-1111-4111-8111-111111111111/applicants/7c/2.pdf", "%PDF a résumé sent while files were in the bucket", "application/pdf", "no-cache");
  }
  /** Delete forever, landing while the résumé streams into Storage. */
  const deletedMidCopy = (added: Row) => (name: string) => {
    if (name === added.name) world.rows = world.rows.filter((r) => r.name !== name);
  };
  const onVolume = (name: string) => [...world.volume.keys()].some((k) => k.includes(name));

  it("doesn't come back", async () => {
    const added = await addedInTheBucket();
    const sent = await serve({ duringWrite: deletedMidCopy(added) });
    await startStorageMove(env, adminClient(env), "co-1", "to_volume");
    await storageMoveSettled("co-1");

    expect(saved()).toMatchObject({ direction: "to_volume", step: "done", error: null, strays: [] });
    // Storage made a row for the copy as it found none; it was taken out again.
    expect(sent.storage).toContainEqual({ method: "DELETE", name: added.name });
    expect(world.rows.find((r) => r.name === added.name)).toBeUndefined();
    expect(onVolume(added.name)).toBe(false);
  });

  it("is taken out on the next try when Storage won't let go of it at first", async () => {
    const added = await addedInTheBucket();
    await serve({ duringWrite: deletedMidCopy(added), failDeletes: 3 });
    await startStorageMove(env, adminClient(env), "co-1", "to_volume");
    await storageMoveSettled("co-1");
    expect(saved()).toMatchObject({ direction: "to_volume", step: "failed", problems: ["applicants/7c/2.pdf: it was deleted while it copied back, and Storage didn't let Crewtavo take the copy out yet"] });
    expect(saved().strays).toHaveLength(1);
    expect(world.rows.filter((r) => r.name === added.name)).toHaveLength(1);

    // Finish moving back: the copy comes out first, and isn't counted as a file.
    await serve();
    await startStorageMove(env, adminClient(env), "co-1", "to_volume");
    await storageMoveSettled("co-1");
    expect(saved()).toMatchObject({ step: "done", error: null, strays: [] });
    expect(world.rows.find((r) => r.name === added.name)).toBeUndefined();
    expect(onVolume(added.name)).toBe(false);
  });
});

describe("moving back without a volume", () => {
  it("refuses, since storage would keep files where its next restart loses them", async () => {
    onTheVolume();
    await moveToBucket();
    const sent = await serve({ noVolume: true });
    await expect(startStorageMove(env, adminClient(env), "co-1", "to_volume")).rejects.toThrow("The storage service has no volume any more");
    expect(upserts(sent)).toEqual([]);
    expect(state.deployed.STORAGE_BACKEND).toBe("s3");
  });
});

describe("one move at a time", () => {
  it("refuses a second move while one runs, and says so", async () => {
    onTheVolume();
    await serve();
    await startStorageMove(env, adminClient(env), "co-1", "to_bucket");
    await expect(startStorageMove(env, adminClient(env), "co-1", "to_bucket")).rejects.toThrow("Files are already moving");
    await storageMoveSettled("co-1");
    await expect(startStorageMove(env, adminClient(env), "co-1", "to_bucket")).rejects.toThrow("Files are already in a bucket.");
  });

  it("carries on with a move whose server stopped, when the page asks", async () => {
    const files = onTheVolume();
    await serve();
    state.buckets.push({ id: "bkt-1", name: "files", deployed: true });
    state.row = {
      settings: {
        move: {
          direction: "to_bucket", step: "copying", startedAt: "2026-10-28T11:00:00Z", updatedAt: "2026-10-28T11:00:00Z", finishedAt: null,
          files: 3, copied: 1, bytes: 0, copiedBytes: 0, missing: 0, problems: [], stranded: 0, switchedAt: null, byHand: null, error: null,
          run: "run-1", lease: "old-server", bucket: { id: "bkt-1", name: "files" }, folder: "crewtavo", since: null, undo: null, skipped: [],
        },
      },
    };
    const overview = await storageOverview(env, adminClient(env), "co-1");
    expect(overview.move?.step).toBe("copying");
    await storageMoveSettled("co-1");
    expect(saved()).toMatchObject({ step: "done", run: "run-1" });
    expect(saved().lease).not.toBe("old-server");
    for (const f of files) expect(storageReads(f)).toBeDefined();
  });

  it("needs the instance's own storage and database", async () => {
    await serve();
    const { SUPABASE_DB_URL: _, ...withoutDb } = env as Env & { SUPABASE_DB_URL?: string };
    await expect(startStorageMove(withoutDb as Env, adminClient(env), "co-1", "to_bucket")).rejects.toThrow("Moving files needs the database's address (SUPABASE_DB_URL)");
  });
});

describe("the page", () => {
  it("keeps Settings → Storage's default limit with where files are: 90% of the volume, then the plan's bucket", async () => {
    onTheVolume();
    await serve();
    await storageOverview(env, adminClient(env), "co-1");
    expect(defaultsSet).toEqual([{ p_company: "co-1", p_bytes: 4.5e9, p_basis: "90% of your 5 GB volume" }]);
    await moveToBucket();
    expect(defaultsSet.at(-1)).toEqual({ p_company: "co-1", p_bytes: 900e9, p_basis: "Railway Hobby bucket" });
  });

  it("says where files are, what the volume and bucket hold, and how the last move went", async () => {
    onTheVolume();
    await moveToBucket();
    await serve();
    const overview = await storageOverview(env, adminClient(env), "co-1", { fresh: true });
    expect(overview).toMatchObject({ backend: "bucket", bucket: { id: "bkt-new", name: "files", objects: 3 }, volume: { usedGb: 1.2, sizeGb: 5 }, unavailable: null, move: { step: "done", direction: "to_bucket" } });
    // The record's own bookkeeping stays on the server.
    expect(overview.move).not.toHaveProperty("lease");
    expect(overview.move).not.toHaveProperty("undo");
  });
});

describe("installing Drive", () => {
  it("makes the bucket with the company's Railway connection, then moves files into it", async () => {
    const files = onTheVolume();
    const sent = await serve();
    await bucketForDrive(env, adminClient(env), "co-1");
    await storageMoveSettled("co-1");
    expect(railwayFields(sent).filter((f) => f === "bucketCreate")).toHaveLength(1);
    expect(saved()).toMatchObject({ direction: "to_bucket", step: "done", bucket: { id: "bkt-new", name: "files" } });
    for (const f of files) expect(text(storageReads(f)?.body)).toBe(text(world.s3.get(keyOf(f))!.body));
  });

  it("stops with what to do when Railway isn't connected or won't make the bucket, and moves nothing", async () => {
    onTheVolume();
    await serve();
    railwayStatus = "disconnected";
    await expect(bucketForDrive(env, adminClient(env), "co-1")).rejects.toThrow("Connect Railway in Settings → Hosting, then press Install again.");

    const sent = await serve({ refuse: ["bucketCreate"] });
    await expect(bucketForDrive(env, adminClient(env), "co-1")).rejects.toThrow(
      /^Drive keeps photos and files in a Railway bucket\. Add a bucket in Railway: Open your project in Railway\. .*name it files \(pick the US East region.* Then come back and press Install again\.$/,
    );
    expect(state.row).toBeNull();
    expect(sent.s3).toEqual([]);
    expect(state.deployed.STORAGE_BACKEND).toBe("file");
  });

  it("leaves files where they are when they're in a bucket already, or off Railway", async () => {
    state.vars.STORAGE_BACKEND = "s3";
    const sent = await serve();
    await bucketForDrive(env, adminClient(env), "co-1");
    expect(railwayFields(sent)).not.toContain("bucketCreate");
    expect(state.row).toBeNull();

    const { RAILWAY_PROJECT_ID: _, RAILWAY_PUBLIC_DOMAIN: __, ...elsewhere } = env;
    const offRailway = await serve();
    await bucketForDrive(elsewhere as Env, adminClient(env), "co-1");
    expect(offRailway.railway).toEqual([]);
  });
});
