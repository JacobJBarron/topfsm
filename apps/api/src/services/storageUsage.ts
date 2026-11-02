/**
 * Settings → Storage from the server's side (packages/core/src/storage.ts; the database's part is
 * supabase/migrations/20261028000400_storage_limits.sql):
 *  - the default company limit, kept current from Railway (keepStorageDefault): 90% of the storage
 *    service's volume, or what the Railway plan allows a bucket. It's read again when Settings →
 *    Hosting or Settings → Storage read Railway, by the "hosting" and "storage" tasks, and when a
 *    storage move finishes, and written with storage_set_default (the server's alone), which keeps
 *    every other setting as it is. Off Railway, or once Railway isn't connected, there's no default
 *    (one Railway gave earlier no longer says anything true); the same when Railway answers but
 *    what it says gives no default (a plan Crewtavo doesn't know). Only while Railway can't be
 *    reached for a moment does the last default stay.
 *  - GET /api/storage's overview (storageOverviewFor): storage_overview as the person sees it, plus,
 *    for owners and admins on Railway, where files live and what a GB of them costs a month.
 *  - the "storage" task's warnings (checkStorage): owners and admins hear (the bell, plus email and
 *    push by their notification settings: the "hosting" topic on Railway, "alerts" elsewhere, where
 *    "hosting" isn't shown) when the company's files reach 80% and 95% of its limit, once each
 *    time; what was sent is kept in companies.settings.storage.warned and cleared when use drops
 *    back under, so the next time it's crossed they hear again.
 */
import { ADMINS, RAILWAY_PLANS, type RailwayPlan, type StorageBackend } from "@crewtavo/core";
import { defaultStorageLimit, formatBytes, STORAGE_WARN_AT, storagePricePerGb } from "@crewtavo/core/storage";
import type { Env } from "../env";
import { platformOf } from "../lib/address";
import { asJson, dbError } from "../lib/http";
import { forgetStorageReadings } from "../lib/storageLimits";
import type { Db } from "../lib/supabase";
import { projectDetails, RailwayError, serviceVariables, volumeSizes, type RailwayAccess } from "../integrations/railway";
import { railwayAccess } from "./railway";

/** Where this Crewtavo's files live on Railway, for the default limit and what it costs. */
export interface RailwayStorage {
  backend: StorageBackend | null;
  plan: RailwayPlan | null;
  /** The storage service's volume, in bytes (it keeps it after files move to a bucket). */
  volumeBytes: number | null;
  /** What Railway charges a month to keep a GB where files live now. */
  pricePerGbMonth: number | null;
}

/** What a caller already read from Railway: undefined is "not read", null is "Railway didn't say". */
export interface StorageFactsHint {
  backend?: StorageBackend | null;
  plan?: RailwayPlan | null;
  volumeBytes?: number | null;
  /** The storage service's id in the Railway project. */
  storageId?: string | null;
}

/** Railway is read again for the default after this long; "Check again", the tasks and a finished move don't wait. */
const FACTS_MS = 5 * 60_000;

export const onRailway = (env: Env) => env.CREWTAVO_SINGLE_COMPANY === "1" && platformOf(env) === "railway";

const planOf = (plan: string | null | undefined): RailwayPlan | null => {
  const name = (plan ?? "").toLowerCase();
  return name in RAILWAY_PLANS ? (name as RailwayPlan) : null;
};

/**
 * The storage service's backend, plan and volume, from Railway: only the parts the hint doesn't
 * have. `answered`: Railway gave every part the default needs, so a part that's missing is missing
 * (no storage service, a plan Crewtavo doesn't know), not just unread for now (Railway refused or
 * didn't answer, here or in the caller's own read: a null in the hint).
 */
async function readFacts(env: Env, access: RailwayAccess, hint: StorageFactsHint): Promise<Omit<RailwayStorage, "pricePerGbMonth"> & { answered: boolean }> {
  let { backend, plan, volumeBytes, storageId } = hint;
  let failed = false;
  /** null: Railway didn't give that part (refused, or didn't answer). Anything else is a bug, and is thrown. */
  const optional = async <T>(work: Promise<T>): Promise<T | null> => {
    try {
      return await work;
    } catch (error) {
      if (!(error instanceof RailwayError)) throw error;
      failed = true;
      return null;
    }
  };
  const needsId = storageId === undefined && (backend === undefined || volumeBytes === undefined);
  if (plan === undefined || needsId) {
    const project = await optional(projectDetails(env, access));
    if (plan === undefined) plan = planOf(project?.plan);
    if (storageId === undefined) storageId = project?.services.find((s) => s.name === "storage")?.id ?? null;
  }
  if (backend === undefined) {
    const vars = storageId ? await optional(serviceVariables(env, access, storageId)) : null;
    backend = vars ? (vars.STORAGE_BACKEND === "s3" ? "bucket" : "volume") : null;
  }
  // The volume matters while files are on it (a bucket's default comes from the plan).
  if (volumeBytes === undefined && backend === "volume") {
    const volumes = storageId ? await optional(volumeSizes(env, access)) : null;
    const volume = volumes?.find((v) => v.serviceId === storageId);
    volumeBytes = volume?.sizeMb ? volume.sizeMb * 1_000_000 : null;
  }
  const unsaid =
    hint.backend === null ||
    (hint.storageId === null && (backend == null || (backend === "volume" && volumeBytes == null))) ||
    (backend === "bucket" && hint.plan === null) ||
    (backend === "volume" && hint.volumeBytes === null);
  return { backend: backend ?? null, plan: plan ?? null, volumeBytes: volumeBytes ?? null, answered: !failed && !unsaid };
}

/** Railway isn't connected for the company (never was, disconnected, or its sign-in stopped working); false when that can't be read. */
async function notConnected(admin: Db, companyId: string): Promise<boolean> {
  const { data, error } = await admin.from("integrations").select("status").match({ company_id: companyId, provider: "railway" }).maybeSingle();
  return !error && data?.status !== "connected";
}

/**
 * No default limit for the company: storage_set_default with nothing, which changes nothing when
 * there's none already. A looser limit needs nothing more: the gateway reads the numbers again
 * before it refuses anything.
 */
async function clearDefault(admin: Db, companyId: string) {
  // The generated types don't know a function's arguments can be null; this one's can.
  const { error } = await admin.rpc("storage_set_default", { p_company: companyId, p_bytes: null, p_basis: null } as never);
  if (error) console.warn("Couldn't clear the default storage limit:", error.message);
}

const facts = new Map<string, { at: number; storage: RailwayStorage }>();
const reading = new Map<string, Promise<RailwayStorage | null>>();
/** Forgets what Railway said (a move finished, or in tests). */
export function forgetStorageFacts(companyId?: string) {
  if (companyId) facts.delete(companyId);
  else facts.clear();
}

/**
 * Reads where this Crewtavo's files live from Railway (what the hint doesn't already say) and keeps
 * the company's default limit to match. Null when it isn't on Railway or Railway isn't connected,
 * and then there's no default limit: one Railway gave before is cleared. Never throws: Settings and
 * the tasks carry on without it.
 */
export async function keepStorageDefault(
  env: Env,
  admin: Db,
  companyId: string,
  { access, hint = {}, force = false }: { access?: RailwayAccess | null; hint?: StorageFactsHint; force?: boolean } = {},
): Promise<RailwayStorage | null> {
  if (!onRailway(env)) {
    await clearDefault(admin, companyId);
    return null;
  }
  const known = facts.get(companyId);
  if (!force && known && Date.now() - known.at < FACTS_MS) return known.storage;
  const pending = reading.get(companyId);
  if (pending) return pending;
  const work = (async (): Promise<RailwayStorage | null> => {
    try {
      const railway = access === undefined ? await railwayAccess(env, admin, companyId) : access;
      if (!railway) {
        // Not connected (never, or not any more): nothing to follow, so no default. Unless the
        // connection couldn't be read just now.
        facts.delete(companyId);
        if (await notConnected(admin, companyId)) await clearDefault(admin, companyId);
        return null;
      }
      const { answered, ...read } = await readFacts(env, railway, hint);
      const storage: RailwayStorage = { ...read, pricePerGbMonth: storagePricePerGb(read.backend) };
      facts.set(companyId, { at: Date.now(), storage });
      const { bytes, basis } = defaultStorageLimit(read);
      if (bytes !== null) {
        const { error } = await admin.rpc("storage_set_default", { p_company: companyId, p_bytes: bytes, p_basis: basis ?? "" });
        if (error) console.warn("Couldn't save the default storage limit:", error.message);
        // The gateway reads the limit again at the next upload (uploads still arriving stay counted).
        else forgetStorageReadings();
      } else if (answered) {
        // Railway answered, and what it said gives no default (a plan Crewtavo doesn't know, say).
        await clearDefault(admin, companyId);
      }
      // Otherwise Railway couldn't be reached just now: the last default stays until it can.
      return storage;
    } catch (error) {
      console.warn("Couldn't read where files are kept on Railway:", error instanceof Error ? error.message : error);
      return null;
    } finally {
      reading.delete(companyId);
    }
  })();
  reading.set(companyId, work);
  return work;
}

// ---------------------------------------------------------------------------------------------
// GET /api/storage
// ---------------------------------------------------------------------------------------------

/**
 * Settings → Storage and Drive: storage_overview as this person sees it (their client, so the
 * database decides what they see), and for owners and admins on Railway, `railway`: where files live
 * and what a GB costs a month there, read with the default limit brought up to date first. `fresh`
 * reads Railway now rather than what it said in the last few minutes.
 */
export async function storageOverviewFor(env: Env, db: Db, admin: Db, companyId: string, { owners, fresh = false }: { owners: boolean; fresh?: boolean }): Promise<Record<string, unknown>> {
  const railway = owners ? await keepStorageDefault(env, admin, companyId, { force: fresh }) : null;
  const { data, error } = await db.rpc("storage_overview", { p_company: companyId });
  if (error) throw dbError(error);
  const overview = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  return { ...overview, railway };
}

// ---------------------------------------------------------------------------------------------
// The "storage" task: warnings at 80% and 95% of the limit
// ---------------------------------------------------------------------------------------------

/** storage_snapshot's company numbers don't depend on the person: this one is nobody. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/** Each warning's key in settings.storage.warned: "80", "95". */
const keyOf = (share: number) => String(Math.round(share * 100));

/**
 * The warning for reaching `share` of the limit: `used` of `limit` bytes. Once it's at or over the
 * limit (it was lowered under what's stored, or field photos went in since), it says it's full:
 * uploads are being turned away already.
 */
export function storageWarning(share: number, used: number, limit: number): { title: string; body: string } {
  const full = used >= limit;
  const percent = Math.floor((used / limit) * 100);
  const title = full ? "Crewtavo's storage is full" : share >= 0.95 ? `Crewtavo's storage is almost full (${percent}%)` : `Crewtavo's storage is ${percent}% full`;
  const refused = full
    ? "New files in Drive, plans, guides and chat are being turned away until there's room."
    : "When it's full, nobody can add files to Drive, plans, guides or chat.";
  return {
    title,
    body: `${formatBytes(used)} of the ${formatBytes(limit)} limit is used, counting the Trash. ${refused} Visit photos, quote photos, receipts and sub paperwork still go in, so crews can always finish a job. Raise the limit in Settings → Storage, or empty the Trash.`,
  };
}

/**
 * Every company's use against its limit: tells owners and admins once when it reaches 80% and again
 * at 95% (only the higher when both are new), and forgets a warning when use drops back under it.
 * On Railway, the default limit is brought up to date first. Safe to run twice.
 */
export async function checkStorage(env: Env, admin: Db, now = new Date()): Promise<Record<string, unknown>> {
  const { data: companies, error } = await admin.from("companies").select("id").order("id").limit(1000);
  if (error) throw new Error(error.message);
  let sent = 0;
  let cleared = 0;
  for (const company of companies ?? []) {
    await keepStorageDefault(env, admin, company.id, { force: true });
    const { data: rows, error: readError } = await admin.rpc("storage_snapshot", { p_company: company.id, p_user: NOBODY });
    if (readError) throw new Error(readError.message);
    const row = Array.isArray(rows) ? rows[0] : rows;
    const used = Number(row?.company_used ?? 0);
    const limit = row?.company_limit === null || row?.company_limit === undefined ? null : Number(row.company_limit);

    const { data: fresh, error: settingsError } = await admin.from("companies").select("settings").eq("id", company.id).maybeSingle();
    if (settingsError) throw new Error(settingsError.message);
    const settings = (fresh?.settings ?? {}) as Record<string, unknown>;
    const storage = settings.storage && typeof settings.storage === "object" && !Array.isArray(settings.storage) ? (settings.storage as Record<string, unknown>) : {};
    const before = storage.warned && typeof storage.warned === "object" && !Array.isArray(storage.warned) ? (storage.warned as Record<string, string>) : {};

    const reached = limit && limit > 0 ? STORAGE_WARN_AT.filter((share) => used >= share * limit) : [];
    const after: Record<string, string> = {};
    for (const share of reached) after[keyOf(share)] = before[keyOf(share)] ?? now.toISOString();
    const fresher = reached.filter((share) => !before[keyOf(share)]);
    cleared += Object.keys(before).filter((key) => !(key in after)).length;
    if (fresher.length && limit) {
      // Straight past 80% to 95%: just the one that matters now.
      const top = Math.max(...fresher);
      if (await tellAdmins(env, admin, company.id, storageWarning(top, used, limit))) sent++;
    }
    if (JSON.stringify(after) !== JSON.stringify(before)) await rememberWarned(admin, company.id, after);
  }
  return { companies: companies?.length ?? 0, sent, cleared };
}

/**
 * The bell for every owner and admin; email and push by their notification settings, under the
 * "hosting" topic (packages/core/src/notifications.ts), which is emailed unless turned off. Settings →
 * Profile shows it to owners and admins everywhere: "Railway" on Railway, "Storage" elsewhere.
 */
async function tellAdmins(env: Env, admin: Db, companyId: string, warning: { title: string; body: string }): Promise<boolean> {
  const { data: people, error } = await admin.from("memberships").select("user_id").eq("company_id", companyId).eq("active", true).in("role", [...ADMINS]);
  if (error) throw new Error(error.message);
  if (!people?.length) return false;
  const rows = people.map((p) => ({ company_id: companyId, user_id: p.user_id, kind: "hosting", title: warning.title, body: warning.body, link: "/settings?tab=storage" }));
  const { error: sendError } = await admin.from("notifications").insert(rows);
  if (sendError) throw new Error(sendError.message);
  return true;
}

/** Read fresh, so a setting changed meanwhile isn't undone (the database keeps the limit itself as it is). */
async function rememberWarned(admin: Db, companyId: string, warned: Record<string, string>) {
  const { data, error } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  if (error) throw new Error(error.message);
  const settings = (data?.settings ?? {}) as Record<string, unknown>;
  const storage = settings.storage && typeof settings.storage === "object" && !Array.isArray(settings.storage) ? (settings.storage as Record<string, unknown>) : {};
  const { error: saveError } = await admin
    .from("companies")
    .update({ settings: asJson({ ...settings, storage: { ...storage, warned } }) })
    .eq("id", companyId);
  if (saveError) throw new Error(saveError.message);
}
