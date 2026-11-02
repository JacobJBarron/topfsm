/**
 * Settings → Hosting → Files storage: moving this Crewtavo's photos and files from the storage
 * service's Railway volume into a Railway bucket with one press, and back again.
 *
 * A bucket costs a tenth of a volume per GB and never fills up, but Railway's Limited Trial has no
 * buckets and Railway backs up volumes (on Pro) and not buckets, so the template keeps the volume
 * (.railway/railway.ts) and an owner who wants the bucket moves here. A move:
 *  1. finds or makes the bucket ("files") in the project, near the storage service, and reads its
 *     S3 keys (bucketS3Credentials);
 *  2. copies every file: reads it from Storage (its private address, with the service key) and
 *     streams it into the bucket at exactly the key Storage's S3 backend reads (below), a few at a
 *     time, skipping what's already there; then again for files added meanwhile;
 *  3. checks the bucket has every file at its size, and only then
 *  4. switches: sets the storage service's variables (STORAGE_BACKEND=s3 and the bucket's, as
 *     references to it) and restarts storage. Uploads are turned away meanwhile, for a minute or
 *     two (storageWritesPaused), and files that still land on the volume are copied until the
 *     restart takes;
 *  5. checks every file is in the bucket and a few read back through Storage.
 * Every step is saved (the integrations row "railway_storage"), so the page shows how far along it
 * is and a restart carries on from there. The volume is never changed: it keeps every file from
 * before the move, so moving back is the switch the other way plus copying back what was added
 * since. Anything Railway doesn't let Crewtavo do becomes steps to do in Railway (StorageByHand).
 *
 * Where Storage keeps each file (supabase/storage v1.82.1, the version the template runs):
 *  - storage.objects has a row per file: bucket_id, name, version, and metadata, which is what the
 *    backend reported after the upload (mimetype, cacheControl, contentEncoding, size).
 *  - Its key is `${TENANT_ID}/${bucket_id}/${name}/${version}`: TenantLocation.getKeyLocation in
 *    src/storage/locator.ts, with withOptionalVersion from src/storage/backend/adapter.ts, which
 *    joins the version with "/" (with "-$v-" when TUS_USE_FILE_VERSION_SEPARATOR=true) and leaves
 *    it off when it's null. TENANT_ID is "crewtavo" in the template (PROJECT_REF wins when set, and
 *    "storage-single-tenant" is the default; src/config.ts).
 *  - The file backend (src/storage/backend/file.ts) keeps it at
 *    `${FILE_STORAGE_BACKEND_PATH}/${STORAGE_S3_BUCKET || GLOBAL_S3_BUCKET}/${key}`, with the
 *    content type, cache control and content encoding as extended attributes
 *    (user.supabase.content-type, user.supabase.cache-control, user.supabase.content-encoding),
 *    read back as application/octet-stream and no-cache when missing. Its ETag is the MD5.
 *  - The S3 backend (src/storage/backend/s3/adapter.ts) keeps it in the bucket STORAGE_S3_BUCKET at
 *    the same key, with ContentType, CacheControl and ContentEncoding as the object's own headers
 *    (the same defaults on read). A single PUT's ETag is the MD5 too.
 * So a file PUT at that key with Content-Type = metadata.mimetype, Cache-Control =
 * metadata.cacheControl (and Content-Encoding, which Crewtavo never uses, so such a file is left
 * for a person rather than copied) reads back through Storage exactly as it did, and its row,
 * version and owner don't change. Storage picks one backend as it starts
 * (src/storage/backend/index.ts), so there's no per-file fallback; and the file backend's folder is
 * STORAGE_S3_BUCKET when that's set, so moving back sets it to the volume's folder again.
 *
 * Moving back writes files through Storage (nothing else reaches the volume), so each file copied
 * back gets a new version; its name, owner and contents stay. Crewtavo never writes over a stored
 * file (every upload has a new name and x-upsert false), so that can't overwrite a newer upload;
 * it still checks the row is there at the same version right before writing. Deleting carries on
 * meanwhile, and Storage's write makes a new row when it finds none (it has no "only replace"), so
 * a file deleted while its copy streamed would come back: the row is checked again after the write
 * (Storage keeps a row's id when it writes over it, so a new id is the copy's own row) and such a
 * copy is taken out again, or kept on the move's record (strays) until Storage lets Crewtavo.
 *
 * Moving back finishes only once storage's settings in Railway say the volume too: a move whose
 * undo couldn't reach Railway can leave them saying the bucket while storage still reads the volume,
 * and storage would go back to the bucket at its next restart.
 *
 * Which place Storage reads from is told by two small files in Storage's "files" bucket, under
 * MARKERS (no business can see them: they're under no business's folder): one written while on the
 * volume and never copied to the bucket, one written while on the bucket and never copied back.
 * Storage answers 200 for the one where it reads, and "not found" (S3) or an error (the volume) for
 * the other.
 */
import { FILES_BUCKET, storageMoving, type StorageBackend, type StorageByHand, type StorageMove, type StorageOverview } from "@crewtavo/core";
import { AwsClient } from "aws4fetch";
import postgres from "postgres";
import type { Env } from "../env";
import { randomId } from "../lib/crypto";
import { asJson, HttpError } from "../lib/http";
import { reportError } from "../lib/monitoring";
import { apiKey, stackServices } from "../lib/stack";
import type { Db } from "../lib/supabase";
import {
  bucketCredentials,
  bucketUsage,
  createBucket,
  deployBucket,
  projectBuckets,
  railwayPage,
  redeploy,
  RailwayError,
  serviceIdByName,
  serviceRegion,
  serviceVariables,
  setServiceVariables,
  volumeSizes,
  type BucketCredentials,
  type RailwayAccess,
  type RailwayBucket,
} from "../integrations/railway";
import { forgetHosting } from "./hosting";
import { railwayAccess } from "./railway";
import { forgetStorageFacts, keepStorageDefault, onRailway } from "./storageUsage";

/** The integrations row a move's progress is kept on (one per company; never shown on the Apps page). */
const PROVIDER = "railway_storage";
/** Storage's bucket for Crewtavo's files, where the markers go. */
const FILES = "files";
/** The two files that tell which place Storage reads from. Never copied either way. */
const MARKERS = "crewtavo-storage-check/";
const VOLUME_MARKER = `${MARKERS}volume.txt`;
const BUCKET_MARKER = `${MARKERS}bucket.txt`;

/** Files copied at once. */
const PARALLEL = 4;
/** storage.objects rows read at a time. */
const PAGE = 1000;
/** A move saves at least this often, so a move that stops saving is known to have died with its server. */
const HEARTBEAT_MS = 20_000;
const STALE_MS = 2 * 60_000;
/** How long uploads may wait while Crewtavo restarts storage itself. */
const PAUSE_MS = 5 * 60_000;
/** How long to wait for storage to come back reading from the new place: after Crewtavo restarts it, and after asking the owner to. */
const SWITCH_WAIT_MS = 15 * 60_000;
const HAND_WAIT_MS = 3 * 60 * 60_000;
/** Railway's reads for the page are kept this long; the move's own progress is always read fresh. */
const VIEW_MS = 30_000;
/** Files read back in full after a move are at most this big. */
const SAMPLE_MAX = 20 * 1024 * 1024;

/** Waiting and the time it is, swapped out by the tests. */
export const moveClock = {
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------------------------
// Uploads are turned away during the switch
// ---------------------------------------------------------------------------------------------

let pausedUntil = 0;

/**
 * True while a move restarts storage to read from the other place (a few minutes at most): the
 * gateway answers uploads, copies and moves with STORAGE_PAUSED meanwhile (lib/gateway.ts,
 * storesFile), so none land in the place being left. Opening files, signing links, listing and
 * deleting carry on. Crewtavo's own copying talks to Storage directly and isn't held up.
 */
export const storageWritesPaused = (now = Date.now()) => pausedUntil > now;
export const STORAGE_PAUSED = "Files are moving to new storage. Try again in a minute.";

// ---------------------------------------------------------------------------------------------
// This instance: Storage's private address, the service key, and the database
// ---------------------------------------------------------------------------------------------

/** Settings an instance has that the app's Env doesn't name (lib/stack.ts, scripts/migrate.mjs). */
type InstanceEnv = Env & { SUPABASE_DB_URL?: string; DATABASE_URL?: string; JWT_SECRET?: string; SUPABASE_STORAGE_URL?: string };

interface Instance {
  storageUrl: string;
  serviceKey: string;
  dbUrl: string;
}

/** What a move needs from this instance, or why it can't move files. */
function instanceOf(env: Env): Instance | string {
  const vars = env as InstanceEnv;
  const stack = stackServices(vars as unknown as Record<string, string | undefined>);
  if (!stack) return "Moving files needs Crewtavo's own storage service, and this Crewtavo uses another one.";
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? (vars.JWT_SECRET ? apiKey(vars.JWT_SECRET, "service_role") : undefined);
  const dbUrl = vars.SUPABASE_DB_URL || vars.DATABASE_URL;
  if (!dbUrl || !serviceKey) return "Moving files needs the database's address (SUPABASE_DB_URL), which the Railway template sets on the crewtavo service. Put it back there, then try again.";
  return { storageUrl: stack.storage.replace(/\/$/, ""), serviceKey, dbUrl };
}

/** What the storage service's settings say about where it keeps files. */
interface Layout {
  /** Where storage is set to read from (it reads there once it has restarted with these settings). */
  backend: StorageBackend;
  tenant: string;
  /** Between a file's name and its version in a key. */
  separator: string;
  /** The file backend's folder on the volume. */
  folder: string | null;
  /** The S3 bucket storage is set to (STORAGE_S3_BUCKET), on the bucket. */
  s3Bucket: string | null;
  /** Storage serving several projects keeps files differently; Crewtavo's never does. */
  shared: boolean;
}

function layoutOf(vars: Record<string, string>): Layout {
  const backend = vars.STORAGE_BACKEND === "s3" ? "bucket" : "volume";
  return {
    backend,
    tenant: vars.PROJECT_REF || vars.TENANT_ID || "storage-single-tenant",
    separator: vars.TUS_USE_FILE_VERSION_SEPARATOR === "true" ? "-$v-" : "/",
    folder: backend === "volume" ? vars.STORAGE_S3_BUCKET || vars.GLOBAL_S3_BUCKET || null : vars.GLOBAL_S3_BUCKET || null,
    s3Bucket: backend === "bucket" ? vars.STORAGE_S3_BUCKET || vars.GLOBAL_S3_BUCKET || null : null,
    shared: vars.MULTI_TENANT === "true" || vars.IS_MULTITENANT === "true",
  };
}

/** Railway's bucket regions, by where the storage service runs (us-west2, us-east4-eqdc4a, europe-west4-drams3a, asia-southeast1-eqsg3a). */
function bucketRegion(region: string | null): string | null {
  if (!region) return null;
  if (region.startsWith("us-west")) return "sjc";
  if (region.startsWith("us-east")) return "iad";
  if (region.startsWith("europe")) return "ams";
  if (region.startsWith("asia")) return "sin";
  return null;
}

/** One path segment, encoded the way S3 signs it (RFC 3986), which Storage's routes decode too. */
const segment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const pathOf = (key: string) => key.split("/").map(segment).join("/");

const withScheme = (endpoint: string) => (/^https?:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`).replace(/\/+$/, "");

/** Long enough for a big file on a slow day: two minutes, plus a second for every 100 KB. */
const copyTimeout = (bytes: number | null) => AbortSignal.timeout(Math.min(120_000 + Math.ceil((bytes ?? 0) / 100_000) * 1000, 60 * 60_000));

/**
 * One file's copy: its download and upload share a signal, which ends both once the copy is over,
 * so a download whose upload stopped early doesn't hang on (or after `copyTimeout`).
 */
async function copying<T>(bytes: number | null, copy: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const done = new AbortController();
  try {
    return await copy(AbortSignal.any([done.signal, copyTimeout(bytes)]));
  } finally {
    done.abort();
  }
}

// ---------------------------------------------------------------------------------------------
// The bucket, over S3 (aws4fetch signs each request; bodies stream with their length)
// ---------------------------------------------------------------------------------------------

const unescapeXml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (_, name: string, dec?: string, hex?: string) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()]!,
  );

class BucketStore {
  private readonly aws: AwsClient;
  private readonly endpoint: URL;
  private readonly pathStyle: boolean;

  constructor(readonly credentials: BucketCredentials) {
    this.aws = new AwsClient({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, service: "s3", region: credentials.region || "auto", retries: 0 });
    this.endpoint = new URL(withScheme(credentials.endpoint));
    this.pathStyle = /path/i.test(credentials.urlStyle ?? "");
  }

  /** The bucket's address, or one object's in it. */
  private url(key: string | null, query?: Record<string, string>): URL {
    const url = new URL(this.endpoint);
    const prefix = url.pathname.replace(/\/+$/, "");
    const path = key === null ? "" : pathOf(key);
    if (this.pathStyle) url.pathname = `${prefix}/${segment(this.credentials.bucketName)}${key === null ? "" : `/${path}`}`;
    else {
      url.hostname = `${this.credentials.bucketName}.${url.hostname}`;
      url.pathname = `${prefix}/${path}`;
    }
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url;
  }

  /** Signs without the body (S3 takes an unsigned payload over HTTPS), then sends the body as a stream with its length. */
  private async send(method: string, url: URL, init: { headers?: Record<string, string>; body?: ReadableStream<Uint8Array>; length?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const signed = await this.aws.sign(url.toString(), { method, headers: init.headers ?? {} });
    const headers = new Headers(signed.headers);
    if (init.length !== undefined) headers.set("content-length", String(init.length));
    return fetch(signed.url, { method, headers, body: init.body, signal: init.signal ?? AbortSignal.timeout(60_000), ...(init.body ? { duplex: "half" } : {}) } as RequestInit);
  }

  /** Every key under `prefix`, with its size. */
  async list(prefix: string): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    let token: string | null = null;
    for (let page = 0; page < 100_000; page++) {
      const res = await this.send("GET", this.url(null, { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) }));
      const xml = await res.text();
      if (!res.ok) throw new Stop(`The bucket didn't list its files (${res.status}${/<Code>([^<]+)<\/Code>/.exec(xml)?.[1] ? `, ${/<Code>([^<]+)<\/Code>/.exec(xml)![1]}` : ""}). Check it's deployed in Railway, then try again.`);
      for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(item!)?.[1];
        const size = Number(/<Size>(\d+)<\/Size>/.exec(item!)?.[1]);
        if (key !== undefined && Number.isFinite(size)) found.set(unescapeXml(key), size);
      }
      const next = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
      if (!next) break;
      token = unescapeXml(next);
    }
    return found;
  }

  put(key: string, body: ReadableStream<Uint8Array>, length: number, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    return this.send("PUT", this.url(key), { headers, body, length, signal });
  }

  get(key: string, signal: AbortSignal): Promise<Response> {
    return this.send("GET", this.url(key), { signal });
  }
}

// ---------------------------------------------------------------------------------------------
// Storage itself, at its private address with the service key (not through the gateway, so the
// pause during a switch doesn't hold Crewtavo's own copying up)
// ---------------------------------------------------------------------------------------------

class StorageApi {
  constructor(private readonly base: string, private readonly key: string) {}

  private url(bucket: string, name: string) {
    return `${this.base}/object/${segment(bucket)}/${pathOf(name)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, apikey: this.key, ...extra };
  }

  read(bucket: string, name: string, init: { range?: string; signal?: AbortSignal } = {}): Promise<Response> {
    return fetch(this.url(bucket, name), { headers: this.headers(init.range ? { Range: init.range } : {}), signal: init.signal ?? AbortSignal.timeout(30_000) });
  }

  /** Stores a file at `name`; `replace` writes a new version over the one there (a move back), otherwise an existing file is left alone. */
  write(bucket: string, name: string, body: ReadableStream<Uint8Array> | string, init: { length: number; type: string; cache: string; replace: boolean; signal?: AbortSignal }): Promise<Response> {
    const headers = this.headers({ "Content-Type": init.type, "Cache-Control": init.cache, "Content-Length": String(init.length), "x-upsert": init.replace ? "true" : "false" });
    return fetch(this.url(bucket, name), { method: "POST", headers, body, signal: init.signal ?? AbortSignal.timeout(60_000), ...(typeof body === "string" ? {} : { duplex: "half" }) } as RequestInit);
  }

  /** Deletes the file at `name`: its row, and the file where storage reads. */
  remove(bucket: string, name: string): Promise<Response> {
    return fetch(this.url(bucket, name), { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(30_000) });
  }
}

/** Storage's "not found": the row is there but the place it reads from doesn't have the file (S3), or there's no row at all. */
async function notFound(res: Response): Promise<boolean> {
  if (res.status !== 400 && res.status !== 404) return false;
  const body = (await res.json().catch(() => ({}))) as { statusCode?: string; error?: string };
  return body.statusCode === "404" || /not.?found/i.test(body.error ?? "");
}

const drain = (res: Response | null | undefined) => res?.body?.cancel().catch(() => undefined);

// ---------------------------------------------------------------------------------------------
// storage.objects, read straight from Postgres (the crewtavo service's SUPABASE_DB_URL, as
// scripts/migrate.mjs connects): PostgREST doesn't serve the storage schema, and the version is
// part of each key.
// ---------------------------------------------------------------------------------------------

interface StoredObject {
  id: string;
  bucket: string;
  name: string;
  version: string | null;
  mimetype: string | null;
  cacheControl: string | null;
  contentEncoding: string | null;
  size: number | null;
}

interface ObjectRow {
  id: string;
  bucket_id: string;
  name: string;
  version: string | null;
  mimetype: string | null;
  cache_control: string | null;
  content_encoding: string | null;
  size: string | number | null;
}

function database(url: string) {
  // No TLS on Railway's private network or a compose network; anything else requires it (as migrate.mjs).
  const host = new URL(url).hostname;
  const local = !host.includes(".") || host === "127.0.0.1" || host.endsWith(".railway.internal") || /sslmode=disable/.test(url);
  return postgres(url, { max: 1, ssl: local ? false : "require", connect_timeout: 10, idle_timeout: 30, onnotice: () => undefined });
}

const isMarker = (o: Pick<StoredObject, "bucket" | "name">) => o.bucket === FILES && o.name.startsWith(MARKERS);

/** The current file at each name (not a versioned bucket's older versions or delete markers, which Crewtavo never makes), changed since `since` when given, in pages. */
async function* storedObjects(sql: postgres.Sql, since: string | null): AsyncGenerator<StoredObject[]> {
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    // archived_at and is_delete_marker came with Storage's object versioning; to_jsonb reads them
    // without failing on a Storage that's older.
    const rows = await sql<ObjectRow[]>`
      select o.id::text as id, o.bucket_id, o.name, o.version,
             o.metadata ->> 'mimetype' as mimetype,
             o.metadata ->> 'cacheControl' as cache_control,
             o.metadata ->> 'contentEncoding' as content_encoding,
             case when o.metadata ->> 'size' ~ '^[0-9]+$' then (o.metadata ->> 'size')::bigint end as size
        from storage.objects o
       where o.id > ${after}::uuid
         and (to_jsonb(o) ->> 'archived_at') is null
         and coalesce((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false
         and (${since}::timestamptz is null or greatest(o.created_at, o.updated_at) >= ${since}::timestamptz)
       order by o.id
       limit ${PAGE}`;
    if (!rows.length) return;
    yield rows.map((r) => ({
      id: r.id,
      bucket: r.bucket_id,
      name: r.name,
      version: r.version || null,
      mimetype: r.mimetype || null,
      cacheControl: r.cache_control || null,
      contentEncoding: r.content_encoding || null,
      size: r.size === null || r.size === undefined ? null : Number(r.size),
    }));
    if (rows.length < PAGE) return;
    after = rows[rows.length - 1]!.id;
  }
}

// ---------------------------------------------------------------------------------------------
// The move's record
// ---------------------------------------------------------------------------------------------

interface MoveRecord extends StorageMove {
  run: string;
  /** Whichever server is doing the move; one that stops saving is taken over (STALE_MS). */
  lease: string;
  bucket: RailwayBucket | null;
  /** The volume's folder storage used (STORAGE_S3_BUCKET or GLOBAL_S3_BUCKET), to point it back there. */
  folder: string | null;
  /** From when (database time) files may be only in the bucket: moving back copies what changed since. */
  since: string | null;
  /** The storage variables Crewtavo changed, as they were, to put back if the switch doesn't take. */
  undo: Record<string, string> | null;
  /** Keys whose file was already missing where it was copied from (so they aren't counted as left behind). */
  skipped: string[];
  /** Copies moving back wrote after their file was deleted, which Storage didn't let Crewtavo take out yet: tried again on the next run. */
  strays?: Stray[];
}

/** A row Storage made for a copy written after its file was deleted (Crewtavo never reuses a name, so it's the copy's own). */
interface Stray {
  bucket: string;
  name: string;
  id: string;
}

const toPublic = (r: MoveRecord | null): StorageMove | null =>
  r && {
    direction: r.direction,
    step: r.step,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    finishedAt: r.finishedAt,
    files: r.files,
    copied: r.copied,
    bytes: r.bytes,
    copiedBytes: r.copiedBytes,
    missing: r.missing,
    problems: r.problems,
    stranded: r.stranded,
    switchedAt: r.switchedAt,
    byHand: r.byHand,
    error: r.error,
  };

async function readRecord(admin: Db, companyId: string): Promise<MoveRecord | null> {
  const { data, error } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: PROVIDER }).maybeSingle();
  if (error) throw new Error(error.message);
  return ((data?.settings ?? null) as { move?: MoveRecord } | null)?.move ?? null;
}

/** Saves `next` if the move is still `lease`'s (or nobody's, for a first move); false when someone else got there first. */
async function claim(admin: Db, companyId: string, next: MoveRecord, lease: string | null): Promise<boolean> {
  const match = { company_id: companyId, provider: PROVIDER };
  const update = admin.from("integrations").update({ settings: asJson({ move: next }) }).match(match);
  const { data, error } = await (lease ? update.eq("settings->move->>lease", lease) : update.is("settings->move->>lease", null)).select("company_id");
  if (error) throw new Error(error.message);
  if (data?.length) return true;
  if (lease) return false;
  // The first move: the row isn't there yet. Two at once: one insert wins.
  const { error: insertError } = await admin.from("integrations").insert({ ...match, status: "disconnected", settings: asJson({ move: next }) });
  if (insertError && insertError.code !== "23505") throw new Error(insertError.message);
  return !insertError;
}

const stale = (r: MoveRecord, now = Date.now()) => now - Date.parse(r.updatedAt) > STALE_MS;

/** A move waiting for the owner to press Carry on, which nothing runs meanwhile. */
const parked = (r: MoveRecord) => r.step === "by_hand";

/** A plain sentence for the page: the move stops with it. */
class Stop extends Error {}
/** Crewtavo has no Railway access any more (removed, or Login with Railway lapsed). */
class NoAccess extends Stop {}
const NO_ACCESS = "Crewtavo lost its Railway connection. Connect Railway again in Settings → Hosting, then try again.";
/** The move waits for the owner (by hand): saved, and nothing more to do now. */
class Parked extends Error {}
/** Another server took the move over. */
class LostLease extends Error {}
/** Storage didn't come back reading from the new place in time. */
class TimedOut extends Error {}
/** A copy written after its file was deleted that Storage didn't let Crewtavo take out; the message says so, for the page. */
class Unremoved extends Error {}

const refused = (error: unknown) => error instanceof RailwayError && error.denied;

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
/** A file's name for the page, without the business's folder at the front. */
const shortName = (o: Pick<StoredObject, "name">) => o.name.replace(/^[0-9a-f-]{36}\//, "");

/** A file's copy: done (`copied` false when it was there already), or why not. */
type Copied = { ok: true; size: number; copied: boolean } | { ok: false; kind: "gone" | "missing" | "failed"; why: string };

// ---------------------------------------------------------------------------------------------
// A move
// ---------------------------------------------------------------------------------------------

/** Moves running in this server, by company. */
const running = new Map<string, Promise<void>>();

class Move {
  private sql: postgres.Sql | null = null;
  private store: BucketStore | null = null;
  private readonly storage: StorageApi;
  private storageId!: string;
  private layout!: Layout;
  private saving: Promise<void> = Promise.resolve();
  private lastSave = 0;
  private lost = false;
  private pausedHere = false;
  /** Bytes put this run, by key; a file that was already there is checked against its row's size. */
  private readonly sizes = new Map<string, number>();
  /** The bucket's keys and sizes as last listed, with what this run put since. */
  private inBucket = new Map<string, number>();
  /** Database time the last full pass began: later passes only look at files changed since. */
  private deltaFrom: string | null = null;
  /** Files copied back to the volume this run, to read a few back. */
  private readonly copiedBack: Array<{ o: StoredObject; size: number }> = [];
  private readonly skipped: Set<string>;
  private readonly problems = new Map<string, string>();
  private readonly strays: Map<string, Stray>;
  private volumeHints = 0;
  /** Where this run has set (or seen) storage's settings in Railway point. */
  private settledOn: StorageBackend | null = null;

  constructor(
    private readonly env: Env,
    private readonly admin: Db,
    private readonly companyId: string,
    private readonly instance: Instance,
    private readonly record: MoveRecord,
  ) {
    this.storage = new StorageApi(instance.storageUrl, instance.serviceKey);
    this.skipped = new Set(record.skipped);
    this.strays = new Map((record.strays ?? []).map((s) => [s.id, s]));
  }

  async run(): Promise<void> {
    const beat = setInterval(() => void this.save(true).catch(() => undefined), HEARTBEAT_MS);
    beat.unref?.();
    try {
      const storageId = await this.railway((access) => serviceIdByName(this.env, access, "storage"));
      if (!storageId) throw new Stop("Crewtavo can't find the storage service in this Railway project, so files have to be moved by hand.");
      this.storageId = storageId;
      this.layout = layoutOf(await this.railway((access) => serviceVariables(this.env, access, storageId)));
      if (this.layout.shared) throw new Stop("This storage service serves several projects, so Crewtavo can't move its files.");
      this.sql = database(this.instance.dbUrl);
      // Copies a move back couldn't take out last time go first.
      for (const stray of [...this.strays.values()]) await this.takeOutStray(stray);
      if (this.record.direction === "to_bucket") await this.toBucket();
      else await this.toVolume();
    } catch (error) {
      if (error instanceof LostLease || error instanceof Parked) return;
      await this.fail(error);
    } finally {
      clearInterval(beat);
      if (this.pausedHere) pausedUntil = 0;
      await this.saving.catch(() => undefined);
      await this.sql?.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  // --- volume → bucket ---------------------------------------------------------------------------

  private async toBucket() {
    const r = this.record;
    if (r.step === "switching" || r.step === "checking") {
      // Carrying on after a restart: the copying was done, but while nobody was watching (and with
      // uploads no longer turned away) files may have gone on landing on the volume. While storage
      // still reads it, every file the bucket doesn't have is copied and the bucket checked again,
      // as before the first try, so none is left behind by the switch. Steps the owner was given
      // meanwhile come down until then (the switch gives them again if they're still needed).
      // Storage may be restarting just then: until it says where it reads, nothing is switched.
      this.store = await this.bucketStore(r.bucket);
      if (r.step === "switching") {
        const reads = await this.whereStorageReads();
        if (!reads) {
          const back = await this.undo();
          throw new Stop(
            `Storage didn't answer for 15 minutes, so Crewtavo didn't switch over${back ? "" : "; put storage's settings back in Railway (see below)"}. Try again once storage is running.`,
          );
        }
        if (reads === "volume") {
          await this.update({ byHand: null });
          await this.copyUntilCaughtUp();
        }
        await this.switchTo("bucket");
      }
      return this.checkBucket();
    }
    if (this.layout.backend === "bucket") throw new Stop("Files are already in a bucket.");
    if (!this.layout.folder) throw new Stop("Crewtavo can't tell which folder on the volume storage keeps files in (GLOBAL_S3_BUCKET isn't set on it), so files have to be moved by hand.");
    await this.update({ step: "bucket", folder: this.layout.folder });
    const bucket = await findOrMakeBucket(this.env, (call) => this.railway(call), this.storageId, r.bucket, CARRY_ON);
    if (!("id" in bucket)) return this.park(bucket);
    await this.update({ bucket });
    this.store = await this.bucketStore(bucket);
    await this.update({ step: "copying" });
    await this.ensureMarker("volume");
    await this.copyUntilCaughtUp();
    await this.switchTo("bucket");
    await this.checkBucket();
  }

  /** The bucket's S3 keys: a new bucket can take a minute before Railway has them. */
  private async bucketStore(bucket: RailwayBucket | null): Promise<BucketStore> {
    if (!bucket) throw new Stop("Crewtavo lost track of which bucket it was moving files to. Try again.");
    for (let attempt = 1; ; attempt++) {
      const credentials = await this.railway((access) => bucketCredentials(this.env, access, bucket.id)).catch((error) => {
        if (refused(error)) {
          throw new Stop("Railway didn't let Crewtavo read the bucket's keys, which it needs to copy files into it. Log in with Railway again as someone who can change this project (Remove access, then Log in with Railway), then try again.");
        }
        throw error;
      });
      if (credentials) return new BucketStore(credentials);
      if (attempt >= 6) return this.park(DEPLOY_BUCKET(this.env));
      await moveClock.wait(10_000);
    }
  }

  /** Copies until a pass finds nothing new, then checks the bucket has every file that was there before that pass. */
  private async copyUntilCaughtUp() {
    for (let pass = 1; pass <= 6; pass++) {
      const { copied, failed } = await this.copyPass(false);
      if (copied === 0 && (failed === 0 || pass >= 3)) break;
    }
    // A file that wasn't on the volume gets one more try, a while later, before it's counted as missing.
    if (this.skipped.size) {
      this.skipped.clear();
      await this.copyPass(false);
    }
    await this.verifyBucket(this.deltaFrom!);
  }

  /**
   * Copies every file the bucket doesn't have yet. A full pass lists the bucket and every file; a
   * later (`delta`) one only the files changed since the last full one began, which is what the
   * switch runs every few seconds while the volume still takes uploads. A delta pass with no full
   * one before it in this run (carrying on after a restart: the last one went with its server, and
   * what was uploaded since isn't known) is a full one.
   */
  private async copyPass(delta: boolean): Promise<{ copied: number; failed: number }> {
    const full = !delta || !this.deltaFrom;
    if (full) {
      this.deltaFrom = await this.dbNow();
      this.inBucket = await this.store!.list(`${this.layout.tenant}/`);
    }
    const since = full ? null : this.deltaFrom;
    const totals = await this.totals(null);
    let done = full ? 0 : this.record.copied;
    let doneBytes = full ? 0 : this.record.copiedBytes;
    let copied = 0;
    let failed = 0;
    const report = (force: boolean) =>
      this.progress({ files: totals.files, bytes: totals.bytes, copied: Math.min(done, totals.files), copiedBytes: Math.min(doneBytes, totals.bytes || doneBytes) }, force);
    for await (const page of storedObjects(this.sql!, since)) {
      const todo: Array<{ o: StoredObject; key: string }> = [];
      for (const o of page) {
        if (isMarker(o)) continue;
        const key = this.keyOf(o);
        const there = this.inBucket.get(key);
        const expected = this.sizes.get(key) ?? o.size;
        if (there !== undefined && (expected === null || there === expected)) {
          if (full) {
            done++;
            doneBytes += there;
          }
        } else if (!this.skipped.has(key)) todo.push({ o, key });
      }
      await inParallel(todo, async ({ o, key }) => {
        const result = await this.attempt(() => this.copyToBucket(o, key));
        if (result.ok) {
          copied++;
          done++;
          doneBytes += result.size;
          this.sizes.set(key, result.size);
          this.inBucket.set(key, result.size);
          this.problems.delete(key);
        } else if (result.kind === "missing") this.skipped.add(key);
        else if (result.kind === "failed") {
          failed++;
          this.problems.set(key, `${shortName(o)}: ${result.why}`);
        }
        await report(false);
      });
    }
    await report(true);
    return { copied, failed };
  }

  /** Reads the file from Storage (on the volume) and streams it into the bucket at its key. */
  private copyToBucket(o: StoredObject, key: string): Promise<Copied> {
    return copying(o.size, (signal) => this.streamToBucket(o, key, signal));
  }

  private async streamToBucket(o: StoredObject, key: string, signal: AbortSignal): Promise<Copied> {
    const res = await this.storage.read(o.bucket, o.name, { signal });
    if (await notFound(res)) return { ok: false, kind: "gone", why: "it was deleted" };
    // The file backend answers a file that isn't on the volume with an error, not "not found".
    if (res.status === 500) {
      await drain(res);
      return { ok: false, kind: "missing", why: "it isn't on the volume" };
    }
    if (!res.ok || !res.body) {
      await drain(res);
      return { ok: false, kind: "failed", why: `Storage answered ${res.status}` };
    }
    const length = Number(res.headers.get("content-length"));
    const encoding = res.headers.get("content-encoding");
    if (o.contentEncoding || (encoding && encoding !== "identity")) {
      await drain(res);
      return { ok: false, kind: "failed", why: "it's stored compressed, which Crewtavo doesn't copy" };
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      await drain(res);
      return { ok: false, kind: "failed", why: "Storage didn't say how big it is" };
    }
    const put = await this.store!.put(key, res.body, length, { "Content-Type": o.mimetype ?? res.headers.get("content-type") ?? "application/octet-stream", "Cache-Control": o.cacheControl ?? "no-cache" }, signal);
    await drain(put);
    if (!put.ok) return { ok: false, kind: "failed", why: `the bucket answered ${put.status}` };
    return { ok: true, size: length, copied: true };
  }

  /**
   * Every file that was there before the last pass started is in the bucket, at its size. Files
   * added since are copied as storage switches over, and checked again after.
   */
  private async verifyBucket(from: string) {
    const inBucket = await this.store!.list(`${this.layout.tenant}/`);
    this.inBucket = inBucket;
    const short: string[] = [];
    for await (const page of storedObjects(this.sql!, null)) {
      for (const o of page) {
        if (isMarker(o)) continue;
        const key = this.keyOf(o);
        if (this.skipped.has(key)) continue;
        const there = inBucket.get(key);
        const expected = this.sizes.get(key) ?? o.size;
        if (there !== undefined && (expected === null || there === expected)) continue;
        // Added after the last pass began: the switch copies it.
        if (!this.problems.has(key) && !(await this.olderThan(o, from))) continue;
        short.push(this.problems.get(key) ?? shortName(o));
      }
    }
    if (short.length) {
      await this.progress({ problems: short.slice(0, 5) }, true);
      throw new Stop(`${plural(short.length, "file")} didn't copy to the bucket, so Crewtavo didn't switch over. Your files are all still on the volume, working as before. Try again in a few minutes.`);
    }
  }

  /** After the switch: every file is in the bucket, and a few read back through Storage. */
  private async checkBucket() {
    await this.update({ step: "checking" });
    const inBucket = await this.store!.list(`${this.layout.tenant}/`);
    let stranded = 0;
    const samples: Array<{ o: StoredObject; size: number }> = [];
    let seen = 0;
    for await (const page of storedObjects(this.sql!, null)) {
      for (const o of page) {
        if (isMarker(o)) continue;
        const key = this.keyOf(o);
        if (this.skipped.has(key)) continue;
        const there = inBucket.get(key);
        if (there === undefined) {
          stranded++;
          continue;
        }
        // A handful spread through the files, of a size that reads back quickly.
        if (there > SAMPLE_MAX) continue;
        seen++;
        if (samples.length < 5) samples.push({ o, size: there });
        else if (Math.random() < 5 / seen) samples[Math.floor(Math.random() * 5)] = { o, size: there };
      }
    }
    const unread = await this.readBack(samples);
    if (unread) {
      throw new Stop(
        `Storage switched to the bucket, but a file didn't read back from it (${unread}). Press Move back to the volume to go back: every file is still there.`,
      );
    }
    await this.finish({ stranded });
  }

  // --- bucket → volume ---------------------------------------------------------------------------

  private async toVolume() {
    const r = this.record;
    if (r.step !== "switching" && r.step !== "copying" && r.step !== "checking") {
      if (this.layout.backend === "volume") throw new Stop("Files are already on the volume.");
      if (!(await this.railway((access) => hasVolume(this.env, access, this.storageId)))) throw new Stop(NO_VOLUME);
      const folder = r.folder ?? this.layout.folder;
      if (!folder) throw new Stop("Crewtavo can't tell which folder on the volume storage kept files in, so this has to be done by hand.");
      const bucket = r.bucket ?? (await this.bucketInUse());
      await this.update({ step: "preparing", folder, bucket });
      this.store = await this.bucketStore(bucket);
      // Without the volume's marker (files went to the bucket some other way), the bucket's tells.
      if (!(await this.markers()).has(VOLUME_MARKER)) await this.ensureMarker("bucket");
    } else this.store = await this.bucketStore(r.bucket);
    if (r.step !== "copying" && r.step !== "checking") await this.switchTo("volume");
    if (r.step !== "checking") await this.copyBack();
    await this.checkVolume();
  }

  /** The bucket storage reads from: the one named in its settings. */
  private async bucketInUse(): Promise<RailwayBucket> {
    const buckets = await this.railway((access) => projectBuckets(this.env, access));
    // The usual one first.
    const ordered = [...buckets.filter((b) => b.name === FILES_BUCKET), ...buckets.filter((b) => b.name !== FILES_BUCKET)];
    for (const bucket of ordered) {
      const credentials = await this.railway((access) => bucketCredentials(this.env, access, bucket.id)).catch((error) => (error instanceof NoAccess ? Promise.reject(error) : null));
      if (credentials && credentials.bucketName === this.layout.s3Bucket) return bucket;
    }
    throw new Stop("Crewtavo can't find the bucket storage uses in this Railway project, so this has to be done by hand.");
  }

  /** Copies back what the volume doesn't have: files added or changed since the move to the bucket, or every file when that isn't known. */
  private async copyBack() {
    const r = this.record;
    await this.update({ step: "copying" });
    const totals = await this.totals(r.since);
    let done = 0;
    let doneBytes = 0;
    for await (const page of storedObjects(this.sql!, r.since)) {
      await inParallel(
        // Not a copy of a deleted file that's waiting to be taken out.
        page.filter((o) => !isMarker(o) && !this.strays.has(o.id)),
        async (o) => {
          const key = this.keyOf(o);
          const result = await this.attempt(() => this.copyToVolume(o, key));
          if (result.ok) {
            done++;
            doneBytes += result.size;
            this.problems.delete(key);
            if (result.copied && result.size <= SAMPLE_MAX && this.copiedBack.length < 5) this.copiedBack.push({ o, size: result.size });
          } else if (result.kind === "missing") this.skipped.add(key);
          else if (result.kind === "failed") this.problems.set(key, `${shortName(o)}: ${result.why}`);
          // Deleted meanwhile: nothing to copy.
          else done++;
          await this.progress({ files: totals.files, bytes: totals.bytes, copied: done, copiedBytes: doneBytes }, false);
        },
      );
    }
    await this.progress({ files: totals.files, bytes: totals.bytes, copied: done, copiedBytes: doneBytes }, true);
    if (this.problems.size) {
      throw new Stop(
        `Storage is back on the volume, but ${plural(this.problems.size, "file")} added while files were in the bucket didn't copy back yet. They're still in the bucket. Press Move back to the volume again to finish.`,
      );
    }
  }

  /** On the volume already (Storage reads it), or streamed from the bucket into Storage as a new version. */
  private async copyToVolume(o: StoredObject, key: string): Promise<Copied> {
    // Deleted meanwhile (and a copy an earlier try wrote taken out again), it isn't brought back.
    if (!(await this.current(o))) return { ok: false, kind: "gone", why: "it was deleted" };
    const there = await this.storage.read(o.bucket, o.name, { range: "bytes=0-0" });
    if (there.status === 200 || there.status === 206) {
      await drain(there);
      return { ok: true, size: o.size ?? 0, copied: false };
    }
    if (await notFound(there)) return { ok: false, kind: "gone", why: "it was deleted" };
    await drain(there);
    return copying(o.size, (signal) => this.streamToVolume(o, key, signal));
  }

  private async streamToVolume(o: StoredObject, key: string, signal: AbortSignal): Promise<Copied> {
    const res = await this.store!.get(key, signal);
    if (res.status === 404) {
      await drain(res);
      return { ok: false, kind: "missing", why: "it isn't in the bucket" };
    }
    if (!res.ok || !res.body) {
      await drain(res);
      return { ok: false, kind: "failed", why: `the bucket answered ${res.status}` };
    }
    const length = Number(res.headers.get("content-length"));
    const encoding = res.headers.get("content-encoding");
    if (o.contentEncoding || (encoding && encoding !== "identity") || !Number.isSafeInteger(length)) {
      await drain(res);
      return { ok: false, kind: "failed", why: "it's stored in a way Crewtavo doesn't copy" };
    }
    // Still the same file (not deleted or changed while this ran)?
    const before = await this.current(o);
    if (!before || (before.version || null) !== o.version) {
      await drain(res);
      return { ok: false, kind: "gone", why: "it changed meanwhile" };
    }
    const put = await this.storage.write(o.bucket, o.name, res.body, {
      length,
      type: o.mimetype ?? res.headers.get("content-type") ?? "application/octet-stream",
      cache: o.cacheControl ?? res.headers.get("cache-control") ?? "no-cache",
      replace: true,
      signal,
    });
    await drain(put);
    // Deleting carries on while files move back, and the write took as long as the file did to
    // stream: deleted meanwhile, Storage made a new row for the copy, which comes out again here.
    if (!(await this.current(o))) return { ok: false, kind: "gone", why: "it was deleted meanwhile" };
    if (!put.ok) return { ok: false, kind: "failed", why: `Storage answered ${put.status}` };
    return { ok: true, size: length, copied: true };
  }

  /**
   * The row at `o`'s name now, or null when the file was deleted. A row with another id is a copy
   * written after the delete (Storage keeps a row's id when a write replaces its file, and makes a
   * new row when it finds none; Crewtavo never reuses a name), which is taken out again, so a
   * deleted file never comes back.
   */
  private async current(o: StoredObject): Promise<{ id: string; version: string | null } | null> {
    const row = await this.rowAt(o.bucket, o.name);
    if (!row || row.id === o.id) return row;
    const stray = { bucket: o.bucket, name: o.name, id: row.id };
    if (!(await this.takeOut(stray))) throw new Unremoved("it was deleted while it copied back, and Storage didn't let Crewtavo take the copy out yet");
    return null;
  }

  /** The current row at a name, if there is one. */
  private async rowAt(bucket: string, name: string): Promise<{ id: string; version: string | null } | null> {
    const [row] = await this.sql!<Array<{ id: string; version: string | null }>>`
      select o.id::text as id, o.version from storage.objects o
       where o.bucket_id = ${bucket} and o.name = ${name} and (to_jsonb(o) ->> 'archived_at') is null`;
    return row ?? null;
  }

  /** Takes a stray copy out through Storage. Until it's out, it stays on the move's record, to be tried again. */
  private async takeOut(stray: Stray): Promise<boolean> {
    const res = await this.storage.remove(stray.bucket, stray.name).catch(() => null);
    const out = res ? res.ok || (await notFound(res)) : false;
    await drain(res);
    if (out) this.strays.delete(stray.id);
    else this.strays.set(stray.id, stray);
    await this.progress({}, true);
    return out;
  }

  /** A stray copy from an earlier run: taken out, unless it's gone already. One Storage still won't let go of is a problem the move stops on. */
  private async takeOutStray(stray: Stray) {
    const row = await this.rowAt(stray.bucket, stray.name);
    const problem = `stray:${stray.id}`;
    if (row?.id !== stray.id || (await this.takeOut(stray))) {
      this.strays.delete(stray.id);
      this.problems.delete(problem);
      return;
    }
    this.problems.set(problem, `${shortName(stray)}: it was deleted while it copied back, and Storage didn't let Crewtavo take the copy out yet`);
  }

  private async checkVolume() {
    await this.update({ step: "checking" });
    const unread = await this.readBack(this.copiedBack);
    if (unread) throw new Stop(`Storage is back on the volume, but a file copied back didn't read back whole (${unread}). The bucket still has it, as it was.`);
    // Never done while a file deleted as it copied back is still there.
    if (this.strays.size) {
      const one = this.strays.size === 1;
      throw new Stop(
        `Storage is back on the volume, but ${plural(this.strays.size, "file")} deleted while files moved back ${one ? "is" : "are"} still there: Storage didn't let Crewtavo take ${one ? "it" : "them"} out. Press Finish moving back to try again.`,
      );
    }
    // Never done while storage's settings would take it back to the bucket at its next restart.
    if (this.settledOn !== "volume") await this.settle("volume");
    await this.finish({ stranded: 0 });
  }

  // --- switching storage over --------------------------------------------------------------------

  /** What storage needs to read from the bucket: references to the bucket's own variables, so a new key there carries over. */
  private bucketVariables(): Record<string, string> {
    const name = this.record.bucket!.name;
    const ref = (variable: string) => `\${{${name}.${variable}}}`;
    return {
      STORAGE_BACKEND: "s3",
      STORAGE_S3_BUCKET: ref("BUCKET"),
      STORAGE_S3_ENDPOINT: ref("ENDPOINT"),
      STORAGE_S3_REGION: ref("REGION"),
      STORAGE_S3_FORCE_PATH_STYLE: /path/i.test(this.store!.credentials.urlStyle ?? "") ? "true" : "false",
      AWS_ACCESS_KEY_ID: ref("ACCESS_KEY_ID"),
      AWS_SECRET_ACCESS_KEY: ref("SECRET_ACCESS_KEY"),
      // Tags on resumable uploads' parts aren't something every S3 service takes.
      TUS_ALLOW_S3_TAGS: "false",
      // Checksums only where S3 requires them, which every S3-compatible service takes.
      STORAGE_S3_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
      STORAGE_S3_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED",
    };
  }

  /**
   * Points storage at `target`, restarts it, and waits until it reads from there. To the bucket,
   * uploads are turned away meanwhile and files that still land on the volume are copied across;
   * back to the volume, uploads carry on into the bucket and are copied back after.
   */
  private async switchTo(target: StorageBackend) {
    const r = this.record;
    await this.update({ step: "switching" });
    if ((await this.live()) === target) {
      // Storage reads from there already. Its settings in Railway can still say the other place (a
      // move that failed after changing them, whose undo couldn't reach Railway), which its next
      // restart would take it back to: they're put right too.
      await this.switched();
      return this.settle(target);
    }
    const variables = this.variablesFor(target);
    const undo =
      target === "bucket"
        ? { STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: r.folder! }
        : { STORAGE_BACKEND: "s3", STORAGE_S3_BUCKET: this.layout.s3Bucket ?? this.store!.credentials.bucketName };
    if (target === "bucket") {
      this.pause();
      // Files from now on may be only in the bucket (moving back copies them). Carrying on, the first time counts.
      if (!r.since) await this.update({ since: await this.dbNow() });
      // With no pass before it in this run (carrying on, and storage didn't say where it read until
      // now), this one goes through every file, and the bucket is checked after it as before a first
      // switch: storage isn't pointed at a bucket that's missing files the volume has.
      const full = !this.deltaFrom;
      await this.copyPass(true);
      if (full) await this.verifyBucket(this.deltaFrom!);
    }
    try {
      await this.railway((access) => setServiceVariables(this.env, access, this.storageId, variables));
    } catch (error) {
      if (!refused(error)) throw error;
      this.resume();
      return this.waitByHand(target, this.variablesByHand(target, variables));
    }
    this.settledOn = target;
    await this.update({ undo: r.undo ?? undo });
    if (target === "bucket" && !(await this.bucketSettingsTaken())) {
      await this.undo();
      throw new Stop("Railway didn't give storage the bucket's settings, so Crewtavo didn't switch over. Your files are all still on the volume. Try again in a few minutes.");
    }
    try {
      await this.railway((access) => redeploy(this.env, access, this.storageId));
    } catch (error) {
      if (!refused(error)) throw error;
      this.resume();
      return this.waitByHand(target, {
        title: "Restart storage in Railway",
        steps: [
          "Open the storage service in Railway.",
          "Press Deploy (or open Deployments and Redeploy the latest one). Storage is back in about a minute.",
          "Crewtavo notices when it is, and carries on by itself.",
        ],
        link: railwayPage(this.env, { id: this.storageId, tab: "deployments" }),
        watching: true,
      });
    }
    try {
      await this.watch(target, SWITCH_WAIT_MS);
    } catch (error) {
      if (!(error instanceof TimedOut)) throw error;
      const back = await this.undo();
      throw new Stop(
        `Storage didn't start reading from the ${target === "bucket" ? "bucket" : "volume"} within 15 minutes, so ${back ? "Crewtavo put its settings back" : "put storage's settings back in Railway (see below)"}. ${
          target === "bucket" ? "Your files are all still on the volume." : "Your files are all still in the bucket."
        } Try again later.`,
      );
    }
    return this.switched();
  }

  private async switched() {
    this.resume();
    forgetViews();
    forgetHosting();
    await this.update({ switchedAt: this.record.switchedAt ?? new Date().toISOString(), byHand: null });
  }

  /** What storage needs to read from `target`. The volume's folder goes back in STORAGE_S3_BUCKET: the file backend keeps files under it. */
  private variablesFor(target: StorageBackend): Record<string, string> {
    return target === "bucket" ? this.bucketVariables() : { STORAGE_BACKEND: "file", STORAGE_S3_BUCKET: this.record.folder! };
  }

  /** Whether storage's settings, as Railway shows them (references filled in), point at `target`: the volume's folder, or this bucket with its keys. */
  private says(target: StorageBackend, vars: Record<string, string>): boolean {
    if (target === "volume") {
      const layout = layoutOf(vars);
      return layout.backend === "volume" && layout.folder === this.record.folder;
    }
    const credentials = this.store!.credentials;
    return (
      vars.STORAGE_BACKEND === "s3" &&
      vars.STORAGE_S3_BUCKET === credentials.bucketName &&
      vars.AWS_ACCESS_KEY_ID === credentials.accessKeyId &&
      vars.AWS_SECRET_ACCESS_KEY === credentials.secretAccessKey &&
      Boolean(vars.STORAGE_S3_REGION) &&
      withScheme(vars.STORAGE_S3_ENDPOINT ?? "").toLowerCase() === withScheme(credentials.endpoint).toLowerCase()
    );
  }

  private storageVariables(): Promise<Record<string, string>> {
    return this.railway((access) => serviceVariables(this.env, access, this.storageId));
  }

  /** The bucket's references show its own values on storage; if Railway left them empty, the values themselves go in. False when they still don't. */
  private async bucketSettingsTaken(): Promise<boolean> {
    if (this.says("bucket", await this.storageVariables())) return true;
    const credentials = this.store!.credentials;
    await this.railway((access) =>
      setServiceVariables(this.env, access, this.storageId, {
        STORAGE_S3_BUCKET: credentials.bucketName,
        STORAGE_S3_ENDPOINT: withScheme(credentials.endpoint),
        STORAGE_S3_REGION: credentials.region || "auto",
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      }),
    );
    return this.says("bucket", await this.storageVariables());
  }

  /**
   * Makes storage's settings in Railway say `target`, where it reads from already, without restarting
   * it: otherwise its next restart (Raise upload limit, say, or Railway's own) takes it back to the
   * other place, which doesn't have what was added since. When Crewtavo can't, the owner gets the
   * lines, and the move stops until they're right (moving back doesn't finish before).
   */
  private async settle(target: StorageBackend) {
    const variables = this.variablesFor(target);
    let seen = false;
    try {
      let right = this.says(target, await this.storageVariables());
      seen = true;
      if (!right) {
        await this.railway((access) => setServiceVariables(this.env, access, this.storageId, variables));
        right = target === "volume" || (await this.bucketSettingsTaken());
      }
      if (right) {
        this.settledOn = target;
        if (this.record.byHand) await this.update({ byHand: null });
        return;
      }
    } catch (error) {
      if (!(error instanceof RailwayError) && !(error instanceof NoAccess)) throw error;
    }
    const place = target === "bucket" ? "the bucket" : "the volume";
    const other = target === "bucket" ? "the volume" : "the bucket";
    await this.update({
      byHand: {
        title: `Point storage at ${place} in Railway`,
        steps:
          target === "volume"
            ? [
                "Open the storage service in Railway, then Variables.",
                `Change STORAGE_BACKEND to file, and STORAGE_S3_BUCKET to ${this.record.folder} (the volume's folder). Storage reads from the volume already, so it doesn't need restarting.`,
                "Come back here and press Finish moving back.",
              ]
            : [
                "Open the storage service in Railway, then Variables, then Raw Editor.",
                "Add the lines below, and press Update Variables. Storage reads from the bucket already, so it doesn't need restarting.",
              ],
        lines: Object.entries(variables).map(([k, v]) => `${k}=${v}`),
        link: railwayPage(this.env, { id: this.storageId, tab: "variables" }),
        watching: false,
      },
    });
    throw new Stop(
      `Storage reads files from ${place} now, but ${seen ? `its settings in Railway still say ${other}, and Crewtavo couldn't change them` : "Crewtavo couldn't check its settings in Railway"}. Make sure they say ${place}, as below: until they do, storage would go back to ${other} the next time it restarts.`,
    );
  }

  /** Waits for the owner to make the change in Railway, carrying on by itself once storage reads from `target`. */
  private async waitByHand(target: StorageBackend, byHand: StorageByHand) {
    await this.update({ byHand });
    try {
      await this.watch(target, HAND_WAIT_MS);
    } catch (error) {
      if (!(error instanceof TimedOut)) throw error;
      const back = this.record.undo ? await this.undo() : true;
      throw new Stop(
        `Crewtavo stopped waiting for the change in Railway after 3 hours${back ? "" : "; put storage's variables back as they were"}. If you've made it since, press ${target === "bucket" ? "Move files" : "Move back"} again to carry on.`,
      );
    }
    return this.switched();
  }

  private variablesByHand(target: StorageBackend, variables: Record<string, string>): StorageByHand {
    const steps =
      target === "bucket"
        ? [
            "Open the storage service in Railway, then Variables, then Raw Editor.",
            "Add the lines below (they point storage at the bucket), and press Update Variables.",
            "Press Deploy. Storage restarts, which takes about a minute.",
            "Crewtavo notices the switch, copies anything added meanwhile and checks the files. You can leave this page.",
          ]
        : [
            "Open the storage service in Railway, then Variables.",
            `Change STORAGE_BACKEND to file, and STORAGE_S3_BUCKET to ${this.record.folder} (the volume's folder, where storage looks for files).`,
            "Press Deploy. Storage restarts, which takes about a minute.",
            "Crewtavo notices the switch and copies back the files added since the move. You can leave this page.",
          ];
    return { title: target === "bucket" ? "Switch storage to the bucket in Railway" : "Switch storage back to the volume in Railway", steps, lines: Object.entries(variables).map(([k, v]) => `${k}=${v}`), link: railwayPage(this.env, { id: this.storageId, tab: "variables" }), watching: true };
  }

  /** Until storage reads from `target`. While the volume still answers, files uploaded there are copied across. */
  private async watch(target: StorageBackend, ms: number) {
    const until = moveClock.now() + ms;
    for (;;) {
      const live = await this.live();
      if (live === target) return;
      if (moveClock.now() > until) throw new TimedOut();
      if (target === "bucket" && live === "volume") await this.copyPass(true);
      if (!storageWritesPaused()) this.resume();
      await this.progress({}, true);
      await moveClock.wait(5_000);
    }
  }

  /**
   * Puts storage's variables back as they were before this move changed them, and restarts it.
   * False when that didn't happen (Railway refused, or Crewtavo lost its access to Railway): the
   * owner gets the lines to put back by hand, since storage would otherwise switch at its next
   * restart without the last copies.
   */
  private async undo(): Promise<boolean> {
    const undo = this.record.undo;
    if (!undo) return true;
    try {
      // Without the storage service's id (Railway didn't give it as this run began), only by hand.
      if (this.storageId) {
        await this.railway((access) => setServiceVariables(this.env, access, this.storageId, undo));
        this.settledOn = null;
        await this.railway((access) => redeploy(this.env, access, this.storageId));
        await this.update({ undo: null });
        return true;
      }
    } catch (error) {
      if (error instanceof LostLease) throw error;
      if (!(error instanceof RailwayError) && !(error instanceof NoAccess)) {
        console.error("Putting storage's settings back failed", error);
        reportError(error, { task: "storage-move", step: "undo" });
      }
    }
    await this.update({
      byHand: {
        title: "Put storage's settings back in Railway",
        steps: ["Open the storage service in Railway, then Variables.", "Set these back as they were, then press Deploy."],
        lines: Object.entries(undo).map(([k, v]) => `${k}=${v}`),
        link: railwayPage(this.env, this.storageId ? { id: this.storageId, tab: "variables" } : undefined),
        watching: false,
      },
    });
    return false;
  }

  /** Where storage reads files from now, told by the markers; null while it's restarting or doesn't say. */
  private async live(): Promise<StorageBackend | null> {
    const markers = await this.markers();
    if (markers.has(VOLUME_MARKER)) {
      const res = await this.storage.read(FILES, VOLUME_MARKER).catch(() => null);
      if (!res) return null;
      if (res.status === 200) {
        await drain(res);
        return "volume";
      }
      // The row is there, and the place storage reads doesn't have it: the bucket.
      if (await notFound(res)) return "bucket";
      await drain(res);
      return null;
    }
    if (markers.has(BUCKET_MARKER)) {
      const res = await this.storage.read(FILES, BUCKET_MARKER).catch(() => null);
      const status = res?.status ?? 0;
      await drain(res);
      if (status === 200) {
        this.volumeHints = 0;
        return "bucket";
      }
      // The volume answers a file it doesn't have with an error: believed after three in a row.
      this.volumeHints = status === 500 ? this.volumeHints + 1 : 0;
      return this.volumeHints >= 3 ? "volume" : null;
    }
    return null;
  }

  /** Where storage reads from, waiting (up to SWITCH_WAIT_MS) while it doesn't say, as while it restarts. Null when it never did. */
  private async whereStorageReads(): Promise<StorageBackend | null> {
    const until = moveClock.now() + SWITCH_WAIT_MS;
    for (;;) {
      const live = await this.live();
      if (live || moveClock.now() > until) return live;
      await this.progress({}, true);
      await moveClock.wait(5_000);
    }
  }

  private async markers(): Promise<Set<string>> {
    const rows = await this.sql!<Array<{ name: string }>>`select name from storage.objects where bucket_id = ${FILES} and name like ${`${MARKERS}%`}`;
    return new Set(rows.map((r) => r.name));
  }

  /** Writes the marker for the place storage reads from now (it stays there, and is never copied). */
  private async ensureMarker(on: StorageBackend) {
    const name = on === "volume" ? VOLUME_MARKER : BUCKET_MARKER;
    const there = (await this.markers()).has(name);
    if (there) {
      const res = await this.storage.read(FILES, name);
      if (res.status === 200) return drain(res);
      const missing = await notFound(res);
      await drain(res);
      // "Not found" while storage's settings say the volume: it reads from a bucket, and its settings
      // were changed without a restart (by hand, or a move back whose undo couldn't reach Railway).
      // Restarting it now would hide every file added while it read the bucket.
      if (missing && on === "volume") {
        throw new Stop(
          "Storage reads files from a bucket, but its settings in Railway say the volume: they were changed without restarting it. Don't restart it like that, or files added while it read the bucket stop opening. Put its settings back to the bucket's in Railway; to go back to the volume, use Move back to the volume.",
        );
      }
    }
    const text = `Crewtavo tells where files are kept by this file (on the ${on}). Leave it here.\n`;
    const res = await this.storage.write(FILES, name, text, { length: new TextEncoder().encode(text).length, type: "text/plain", cache: "no-cache", replace: there });
    const status = res.status;
    await drain(res);
    if (!res.ok) throw new Stop(`Storage didn't take Crewtavo's check file (${status}), so it can't tell when storage has switched over. Try again in a few minutes.`);
  }

  // --- helpers -----------------------------------------------------------------------------------

  /**
   * A call to Railway with Crewtavo's access as it is now, not as it was when the move began: Login
   * with Railway's token lasts an hour and copying can take longer, so it's read again for every
   * call (railwayAccess refreshes it as it's about to run out). Refused with a token that something
   * else has replaced meanwhile (the daily task refreshing it, say), the call goes once more with the
   * new one; refused with the current one, it's a real refusal.
   */
  private async railway<T>(call: (access: RailwayAccess) => Promise<T>): Promise<T> {
    const access = await this.currentAccess();
    try {
      return await call(access);
    } catch (error) {
      if (!refused(error) || access.method !== "oauth") throw error;
      const again = await this.currentAccess().catch(() => null);
      if (!again || again.token === access.token) throw error;
      return call(again);
    }
  }

  private async currentAccess(): Promise<RailwayAccess> {
    const access = await railwayAccess(this.env, this.admin, this.companyId);
    if (!access) throw new NoAccess(NO_ACCESS);
    return access;
  }

  private keyOf(o: StoredObject): string {
    const { tenant, separator } = this.layout;
    return `${tenant}/${o.bucket}/${o.version ? `${o.name}${separator}${o.version}` : o.name}`;
  }

  /** Was the file there before `from` (database time)? */
  private async olderThan(o: StoredObject, from: string): Promise<boolean> {
    const [row] = await this.sql!<Array<{ older: boolean }>>`select greatest(created_at, updated_at) < ${from}::timestamptz as older from storage.objects where id = ${o.id}::uuid`;
    return Boolean(row?.older);
  }

  private async dbNow(): Promise<string> {
    const [row] = await this.sql!<Array<{ now: Date | string }>>`select now() as now`;
    return new Date(row!.now).toISOString();
  }

  private async totals(since: string | null): Promise<{ files: number; bytes: number }> {
    const [row] = await this.sql!<Array<{ files: string | number; bytes: string | number | null }>>`
      select count(*) as files, sum(case when o.metadata ->> 'size' ~ '^[0-9]+$' then (o.metadata ->> 'size')::bigint end) as bytes
        from storage.objects o
       where not (o.bucket_id = ${FILES} and o.name like ${`${MARKERS}%`})
         and (to_jsonb(o) ->> 'archived_at') is null
         and coalesce((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false
         and (${since}::timestamptz is null or greatest(o.created_at, o.updated_at) >= ${since}::timestamptz)`;
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  /** Up to three tries, a little apart. A file that's still missing after them is counted as missing. */
  private async attempt(copy: () => Promise<Copied>): Promise<Copied> {
    let last: Copied = { ok: false, kind: "failed", why: "it didn't copy" };
    for (let tries = 1; tries <= 3; tries++) {
      try {
        last = await copy();
      } catch (error) {
        if (error instanceof LostLease) throw error;
        last = {
          ok: false,
          kind: "failed",
          why: error instanceof Unremoved ? error.message : error instanceof Error && error.name === "TimeoutError" ? "it took too long" : "the connection dropped",
        };
      }
      if (last.ok || last.kind === "gone") return last;
      if (tries < 3) await moveClock.wait(tries * 2_000);
    }
    return last;
  }

  /** Reads each file in full through Storage; the first that doesn't come back whole, in words, or null. */
  private async readBack(samples: Array<{ o: StoredObject; size: number }>): Promise<string | null> {
    for (const { o, size } of samples) {
      const res = await this.storage.read(o.bucket, o.name, { signal: copyTimeout(size) }).catch(() => null);
      if (!res?.ok || !res.body) {
        await drain(res);
        return `${shortName(o)}: Storage answered ${res?.status ?? "nothing"}`;
      }
      let read = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) read += chunk.byteLength;
      if (read !== size) return `${shortName(o)}: ${read} of ${size} bytes`;
    }
    return null;
  }

  private pause() {
    pausedUntil = Date.now() + PAUSE_MS;
    this.pausedHere = true;
  }

  private resume() {
    if (this.pausedHere) pausedUntil = 0;
    this.pausedHere = false;
  }

  private async park(byHand: StorageByHand): Promise<never> {
    await this.update({ step: "by_hand", byHand });
    throw new Parked();
  }

  private async finish(patch: Partial<MoveRecord>) {
    await this.update({ ...patch, step: "done", byHand: null, error: null, undo: null, finishedAt: new Date().toISOString() });
    forgetViews();
    forgetHosting();
    // Settings → Storage's default limit goes with where files are now: the volume's size, or the plan's bucket (services/storageUsage.ts).
    forgetStorageFacts(this.companyId);
    const access = await this.currentAccess().catch(() => null);
    if (access) await keepStorageDefault(this.env, this.admin, this.companyId, { access, force: true, hint: { backend: this.record.direction === "to_bucket" ? "bucket" : "volume", storageId: this.storageId ?? undefined } });
  }

  private async fail(error: unknown) {
    this.resume();
    let message: string;
    if (error instanceof Stop || error instanceof RailwayError) message = error.message;
    else {
      console.error("Moving files failed", error);
      reportError(error, { task: "storage-move", direction: this.record.direction, step: this.record.step });
      message = "Something went wrong while moving files. Nothing was switched that wasn't checked first. Try again.";
    }
    // Storage was set to switch and hadn't yet: put it back, so a later restart doesn't switch without the last copies.
    if (this.record.undo && !this.record.switchedAt) await this.undo().catch(() => false);
    await this.update({ step: "failed", error: message, finishedAt: new Date().toISOString(), problems: this.problems.size ? [...this.problems.values()].slice(0, 5) : this.record.problems }).catch(() => undefined);
    forgetViews();
  }

  private progress(patch: Partial<MoveRecord>, force: boolean) {
    return this.update(
      { ...patch, missing: this.skipped.size, problems: patch.problems ?? [...this.problems.values()].slice(0, 5), skipped: [...this.skipped].slice(0, 500), strays: [...this.strays.values()] },
      force,
    );
  }

  private async update(patch: Partial<MoveRecord>, force = true) {
    Object.assign(this.record, patch);
    if (this.lost) throw new LostLease();
    if (!force && Date.now() - this.lastSave < 2_000) return;
    await this.save(force);
    if (this.lost) throw new LostLease();
  }

  /** One save at a time, in order; one that finds the move taken over marks this run as lost. A failed save doesn't stop the next. */
  private save(force: boolean): Promise<void> {
    this.saving = this.saving.catch(() => undefined).then(async () => {
      if (this.lost || (!force && Date.now() - this.lastSave < 2_000)) return;
      this.lastSave = Date.now();
      this.record.updatedAt = new Date().toISOString();
      const { data, error } = await this.admin
        .from("integrations")
        .update({ settings: asJson({ move: this.record }) })
        .match({ company_id: this.companyId, provider: PROVIDER })
        .eq("settings->move->>lease", this.record.lease)
        .select("company_id");
      if (error) throw new Error(error.message);
      if (!data?.length) this.lost = true;
    });
    return this.saving;
  }
}

const REGION_NAMES: Record<string, string> = { sjc: "US West", iad: "US East", ams: "EU West", sin: "Southeast Asia" };

/** The last step of the steps below, on Settings → Hosting. */
const CARRY_ON = "Come back here and press Carry on.";

const DEPLOY_BUCKET = (env: Env, then = CARRY_ON): StorageByHand => ({
  title: "Deploy the new bucket in Railway",
  steps: ["Open your project in Railway. The files bucket is waiting there to be deployed, maybe with other changes someone made.", "Check the changes, then press Deploy.", then],
  link: railwayPage(env),
  watching: false,
});

type RailwayCall = <T>(call: (access: RailwayAccess) => Promise<T>) => Promise<T>;

/**
 * The bucket a last move used (moving again after moving back), else one named FILES_BUCKET (made
 * by hand, say), else a new one put in this environment near storage; or the steps to do in
 * Railway when it doesn't let Crewtavo make or deploy it, ending with `then`.
 */
async function findOrMakeBucket(env: Env, railway: RailwayCall, storageId: string, known: RailwayBucket | null, then: string): Promise<RailwayBucket | StorageByHand> {
  const buckets = await railway((access) => projectBuckets(env, access)).catch((error) => (refused(error) ? null : Promise.reject(error)));
  const found = (known && (buckets ? buckets.find((b) => b.id === known.id) : known)) || buckets?.find((b) => b.name === FILES_BUCKET);
  if (found) return found;
  const region = bucketRegion(await railway((access) => serviceRegion(env, access, storageId)).catch((error) => (error instanceof NoAccess ? Promise.reject(error) : null)));
  let bucket: RailwayBucket;
  try {
    bucket = await railway((access) => createBucket(env, access, FILES_BUCKET));
  } catch (error) {
    if (!refused(error)) throw error;
    return {
      title: "Add a bucket in Railway",
      steps: [
        "Open your project in Railway.",
        `Press Create, choose Bucket, and name it ${FILES_BUCKET}${region ? ` (pick the ${REGION_NAMES[region]} region, where your services run)` : ""}.`,
        "Press Deploy to add it.",
        then,
      ],
      link: railwayPage(env),
      watching: false,
    };
  }
  let deployed: "deployed" | "staged";
  try {
    deployed = await railway((access) => deployBucket(env, access, bucket.id, region));
  } catch (error) {
    if (!refused(error)) throw error;
    deployed = "staged";
  }
  return deployed === "staged" ? DEPLOY_BUCKET(env, then) : bucket;
}

/** Runs `work` on each item, PARALLEL at a time. */
async function inParallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

function launch(env: Env, admin: Db, companyId: string, instance: Instance, record: MoveRecord) {
  if (running.has(companyId)) return;
  const work = new Move(env, admin, companyId, instance, record)
    .run()
    .catch((error) => {
      console.error("Moving files failed", error);
      reportError(error, { task: "storage-move" });
    })
    .finally(() => running.delete(companyId));
  running.set(companyId, work);
}

/** Resolves when this server's move for the company stops (finished, failed, waiting on the owner, or taken over). */
export const storageMoveSettled = (companyId: string) => running.get(companyId) ?? Promise.resolve();

// ---------------------------------------------------------------------------------------------
// GET and POST /api/railway/storage
// ---------------------------------------------------------------------------------------------

/** null: Railway didn't give that part (refused, or didn't answer). Anything else is a bug, and is thrown. */
async function optional<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof RailwayError) return null;
    throw error;
  }
}

const views = new Map<string, { at: number; view: Omit<StorageOverview, "move" | "projectUrl"> }>();
const forgetViews = () => views.clear();

/** Where files are and what the bucket and volume hold, from Railway. */
async function railwayView(env: Env, access: RailwayAccess, companyId: string, known: RailwayBucket | null, fresh: boolean): Promise<Omit<StorageOverview, "move" | "projectUrl">> {
  const cached = views.get(companyId);
  if (!fresh && cached && Date.now() - cached.at < VIEW_MS) return cached.view;
  const storageId = await serviceIdByName(env, access, "storage").catch((error) => (error instanceof RailwayError ? undefined : Promise.reject(error)));
  const [vars, buckets, volumes] = await Promise.all([
    storageId ? optional(serviceVariables(env, access, storageId)) : null,
    optional(projectBuckets(env, access)),
    optional(volumeSizes(env, access)),
  ]);
  const layout = vars ? layoutOf(vars) : null;
  // The bucket a move made, else the usual one, else the only one there is.
  const bucket = (known && buckets?.find((b) => b.id === known.id)) ?? known ?? buckets?.find((b) => b.name === FILES_BUCKET) ?? (buckets?.length === 1 ? buckets[0]! : null);
  const usage = bucket ? await optional(bucketUsage(env, access, bucket.id)) : null;
  const volume = storageId ? volumes?.find((v) => v.serviceId === storageId) : undefined;
  const view: Omit<StorageOverview, "move" | "projectUrl"> = {
    backend: layout?.backend ?? null,
    bucket: bucket ? { id: bucket.id, name: bucket.name, usedGb: usage ? Math.round(usage.sizeBytes / 1e7) / 100 : null, objects: usage?.objects ?? null } : null,
    volume: volume ? { usedGb: Math.round(volume.usedMb / 10) / 100, sizeGb: Math.round(volume.sizeMb / 10) / 100 } : null,
    unavailable:
      storageId === null
        ? "Crewtavo can't find the storage service in this Railway project, so files have to be moved by hand."
        : layout?.shared
          ? "This storage service serves several projects, so Crewtavo can't move its files."
          : null,
  };
  views.set(companyId, { at: Date.now(), view });
  return view;
}

/**
 * GET /api/railway/storage: where files are, and the move in progress or the last one. A move whose
 * server stopped (a restart or a new version) carries on here.
 */
export async function storageOverview(env: Env, admin: Db, companyId: string, { fresh = false } = {}): Promise<StorageOverview> {
  const instance = instanceOf(env);
  let record = await readRecord(admin, companyId);
  if (record && typeof instance !== "string" && storageMoving(record) && !parked(record) && stale(record) && !running.has(companyId)) {
    const next = { ...record, lease: randomId() };
    if (await claim(admin, companyId, next, record.lease)) {
      launch(env, admin, companyId, instance, next);
      record = next;
    }
  }
  const access = await railwayAccess(env, admin, companyId);
  const projectUrl = railwayPage(env);
  if (!access) return { backend: null, bucket: null, volume: null, move: toPublic(record), unavailable: "Connect Railway first, here in Settings → Hosting.", projectUrl };
  const view = await railwayView(env, access, companyId, record?.bucket ?? null, fresh);
  // Settings → Storage's default limit follows where files are and the volume's size (services/storageUsage.ts).
  await keepStorageDefault(env, admin, companyId, { access, force: fresh, hint: { backend: view.backend, ...(view.volume ? { volumeBytes: view.volume.sizeGb * 1e9 } : {}) } });
  return { ...view, unavailable: typeof instance === "string" ? instance : view.unavailable, move: toPublic(record), projectUrl };
}

/**
 * POST /api/railway/storage/move and /move-back: starts moving files, or carries on with a move
 * waiting on a step in Railway (Carry on). One at a time.
 */
export async function startStorageMove(env: Env, admin: Db, companyId: string, direction: StorageMove["direction"]): Promise<StorageOverview> {
  const instance = instanceOf(env);
  if (typeof instance === "string") throw new HttpError(400, instance);
  const access = await railwayAccess(env, admin, companyId);
  if (!access) throw new HttpError(400, "Connect Crewtavo to Railway first, in Settings → Hosting. Then try again.");
  const previous = await readRecord(admin, companyId);
  const going = previous && storageMoving(previous) ? previous : null;
  if (going && (running.has(companyId) || (!parked(going) && !stale(going)))) throw new HttpError(409, "Files are already moving. Settings → Hosting shows how far along it is.");
  if (going && going.direction !== direction) {
    throw new HttpError(409, going.direction === "to_bucket" ? "Files are partway through moving to the bucket. Carry on with that first." : "Files are partway through moving back to the volume. Carry on with that first.");
  }
  // Storage went back to the volume but not every file was copied back (or its settings in Railway
  // still say the bucket): carry on copying. Lines left for the owner to do by hand stay up until
  // the move finds them done.
  const unfinished = !going && direction === "to_volume" && previous?.direction === "to_volume" && previous.step === "failed" && previous.switchedAt ? previous : null;
  if (unfinished) {
    const byHand = unfinished.byHand && !unfinished.byHand.watching ? unfinished.byHand : null;
    const record: MoveRecord = { ...unfinished, step: "copying", error: null, byHand, finishedAt: null, problems: [], lease: randomId() };
    if (!(await claim(admin, companyId, record, unfinished.lease))) throw new HttpError(409, "Files are already moving. Settings → Hosting shows how far along it is.");
    launch(env, admin, companyId, instance, record);
    return storageOverview(env, admin, companyId);
  }
  let layout: Layout | null = null;
  if (!going) {
    const storageId = await serviceIdByName(env, access, "storage").catch(rethrowPlain);
    if (!storageId) throw new HttpError(400, "Crewtavo can't find the storage service in this Railway project, so files have to be moved by hand.");
    layout = layoutOf(await serviceVariables(env, access, storageId).catch(rethrowPlain));
    if (direction === "to_bucket" && layout.backend === "bucket") throw new HttpError(409, "Files are already in a bucket.");
    if (direction === "to_volume" && layout.backend === "volume") throw new HttpError(409, "Files are already on the volume.");
    if (direction === "to_volume" && !(await hasVolume(env, access, storageId))) throw new HttpError(409, NO_VOLUME);
  }
  // A move that failed and couldn't put storage's settings back left the lines to do it by hand:
  // they stay up while storage's settings still need them (moving back puts them right itself).
  const handOver =
    previous?.step === "failed" && previous.undo && !previous.switchedAt && previous.byHand && layout && layoutOf(previous.undo).backend !== layout.backend ? previous.byHand : null;
  const now = new Date().toISOString();
  const record: MoveRecord = going
    ? // Carry on: from the start, which skips what's done (a stale one carries on where it was).
      { ...going, step: parked(going) ? "preparing" : going.step, byHand: null, error: null, lease: randomId() }
    : {
        direction,
        step: "preparing",
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        files: 0,
        copied: 0,
        bytes: 0,
        copiedBytes: 0,
        missing: 0,
        problems: [],
        stranded: 0,
        switchedAt: null,
        byHand: handOver,
        error: null,
        run: randomId(),
        lease: randomId(),
        // Moving back goes from the bucket the last move used, to the folder it left, copying what changed since.
        bucket: previous?.bucket ?? null,
        folder: previous?.folder ?? null,
        since: direction === "to_volume" ? (previous?.since ?? null) : null,
        undo: null,
        skipped: [],
        strays: previous?.strays ?? [],
      };
  if (!(await claim(admin, companyId, record, previous?.lease ?? null))) throw new HttpError(409, "Files are already moving. Settings → Hosting shows how far along it is.");
  launch(env, admin, companyId, instance, record);
  return storageOverview(env, admin, companyId);
}

/**
 * Installing Drive (routes/drive.ts) on Railway: Drive's files go in a bucket, never the volume,
 * which stops every upload once it's full. So this makes the bucket with the company's Railway
 * connection and starts moving files into it, as Settings → Hosting does; when it can't, it throws
 * what to do instead, and Drive isn't installed. Off Railway, or with storage that isn't Crewtavo's
 * own (no JWT_SECRET), there's no volume to leave.
 */
export async function bucketForDrive(env: Env, admin: Db, companyId: string): Promise<void> {
  if (!onRailway(env) || !stackServices(env as unknown as Record<string, string | undefined>)) return;
  const access = await railwayAccess(env, admin, companyId);
  if (!access) throw new HttpError(400, "Drive keeps photos and files in a Railway bucket, which Crewtavo makes with your Railway account. Connect Railway in Settings → Hosting, then press Install again.");
  const record = await readRecord(admin, companyId);
  if (record && storageMoving(record) && !parked(record)) {
    if (record.direction === "to_bucket") return;
    throw new HttpError(409, "Files are moving back to the volume. Once that's finished (Settings → Hosting shows how far along it is), press Install again.");
  }
  const storageId = await serviceIdByName(env, access, "storage").catch(rethrowPlain);
  if (!storageId) throw new HttpError(400, "Crewtavo can't find the storage service in this Railway project, so it can't make Drive's bucket. It's named storage in the template: put the name back in Railway, then press Install again.");
  if (layoutOf(await serviceVariables(env, access, storageId).catch(rethrowPlain)).backend === "bucket") return;
  const instance = instanceOf(env);
  if (typeof instance === "string") throw new HttpError(400, instance);
  const bucket = await findOrMakeBucket(env, (call) => call(access), storageId, record?.bucket ?? null, "Then come back and press Install again.").catch(rethrowPlain);
  if (!("id" in bucket)) throw new HttpError(409, `Drive keeps photos and files in a Railway bucket. ${bucket.title}: ${bucket.steps.join(" ")}`);
  // The move finds the bucket by its name and carries on from there.
  await startStorageMove(env, admin, companyId, "to_bucket");
}

const NO_VOLUME = "The storage service has no volume any more, so files can't move back to one: storage would keep them where they're lost at its next restart. Add a volume to it in Railway, mounted at /var/lib/storage, then try again.";

/** Whether the storage service still has its volume. True when Railway doesn't say: a volume is what the template makes. */
async function hasVolume(env: Env, access: RailwayAccess, storageId: string): Promise<boolean> {
  const volumes = await optional(volumeSizes(env, access));
  return !volumes || volumes.some((v) => v.serviceId === storageId);
}

function rethrowPlain(error: unknown): never {
  if (error instanceof RailwayError) throw new HttpError(400, error.message);
  throw error;
}
