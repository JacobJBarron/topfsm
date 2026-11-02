/**
 * Crewtavo - Drive (Apps → Crewtavo - Drive): every file in one place. Drive's files are plan files
 * (supabase/migrations/20261028000300_drive.sql), each in a company folder or on a client's property,
 * request, quote or job, and the web app lists, uploads, moves, renames, attaches, trashes and
 * restores them itself, under row-level security. These routes do what the browser can't:
 *
 *   POST /api/drive/enabled                  Install and Uninstall (owners and admins who connect apps)
 *                                            (on Railway, Install makes the files bucket first)
 *   POST /api/drive/import                   files picked in Google Drive, brought into a folder or onto
 *                                            a client's property, request, quote or job
 *   POST /api/drive/trash/:id/to-drive       a file from elsewhere in Crewtavo (a visit photo, a
 *                                            guide's cover), out of the Trash and into Drive's
 *                                            "Restored files" folder, when what it was on is gone
 *                                            (never paperwork, résumés or receipts)
 *   POST /api/drive/trash/delete-forever     things in the Trash, deleted for good now (owners only)
 *
 * Importing: the web app signs the person in to Google with its file picker, which lets Crewtavo
 * read only the files they pick (the drive.file permission), and sends that sign-in here with the
 * files. It must be for this deployment's own Google app (GOOGLE_CLIENT_ID), and it's used for those
 * files and forgotten: never kept, never logged. Each file is downloaded whole (Google's own Docs,
 * Sheets, Slides and Drawings converted: packages/core/src/drive.ts), stored, then recorded as the
 * person, so the database's rules about who adds files where apply as they do in the browser.
 *
 * The Trash is the database's (drive_trash, drive_restore): nothing a person deletes is gone until
 * the nightly purge (services/planFiles.ts) or an owner's Delete forever here. The database decides
 * which stored files go (trash_delete_forever, trash_copied_to_drive): it deletes the rows first, then
 * hands over only the files nothing uses any more, and only those are removed.
 */
import { ADMINS, OFFICE, SALES, type Permission, type Role, type Tables } from "@crewtavo/core";
import { extensionFor, fileTitle, GOOGLE_EXPORTS } from "@crewtavo/core/drive";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, HttpError, must, param, readJson, requireEnv, uuid } from "../lib/http";
import { reportError } from "../lib/monitoring";
import { reserveStorage, snapshotsFrom } from "../lib/storageLimits";
import { adminClient, type Db } from "../lib/supabase";
import { inCompany, removeStored } from "../services/planFiles";
import { bucketForDrive } from "../services/storageBucket";
import { UPLOAD_LIMIT } from "../services/uploads";

export const drive = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;
type PlanFileRow = Tables<"plan_files">;

/** Who works with Drive: owners, admins, office staff and estimators (its place in the menu). */
const DRIVE_ROLES = SALES;
const OWNERS: readonly Role[] = ["owner"];

drive.post("/drive/enabled", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ enabled: z.boolean() }));
  // On Railway, Drive's files go in a bucket: made now, or Drive isn't installed (services/storageBucket.ts).
  if (body.enabled) await bucketForDrive(c.env, adminClient(c.env), c.var.companyId);
  const { error } = await c.var.db.rpc("drive_set_enabled", { p_company: c.var.companyId, p_enabled: body.enabled });
  if (error) throw dbError(error);
  return c.json({ enabled: body.enabled });
});

// ---------------------------------------------------------------------------------------------
// Import from Google Drive
// ---------------------------------------------------------------------------------------------

const TOKEN_INFO = "https://oauth2.googleapis.com/tokeninfo";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
/** Google's own kinds of file (Docs, Forms, Sites...): only those in GOOGLE_EXPORTS can be brought in. */
const GOOGLE_KIND = "application/vnd.google-apps.";
/** Google Drive's file ids: letters, digits, - and _. Anything else never goes into a Google address. */
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;
/** Each file, from asking Google about it to storing it: one that takes longer is left out. */
const FILE_TIMEOUT_MS = 120_000;
/** Most picked at once. */
const MOST_FILES = 20;

/** Where the files go: one of these. A folder of null is Company files, the top folder. */
const SLOTS = ["folder_id", "property_id", "request_id", "quote_id", "job_id"] as const;
type Slot = (typeof SLOTS)[number];
const RECORDS = { property_id: ["properties", "property"], request_id: ["requests", "request"], quote_id: ["quotes", "quote"], job_id: ["jobs", "job"] } as const;

const importBody = z.object({
  accessToken: z.string().max(4096).default(""),
  files: z.array(z.object({ id: z.string().max(200), name: z.string().max(1000).optional(), mimeType: z.string().max(255).optional() })),
  target: z.object({
    folder_id: uuid.nullable().optional(),
    property_id: uuid.optional(),
    request_id: uuid.optional(),
    quote_id: uuid.optional(),
    job_id: uuid.optional(),
  }),
});
type Picked = z.infer<typeof importBody>["files"][number];
type Place = Partial<Record<Slot, string>>;

/** A picked file that isn't brought in, with why, in words for the person who picked it. `full`: a storage limit refused it. */
class Skipped extends Error {
  constructor(message: string, readonly full = false) {
    super(message);
  }
}

/**
 * Files held in memory at once, by everyone on this server: each is held whole (up to UPLOAD_LIMIT)
 * on its way to Storage, so a few big imports at the same moment take turns rather than run it out.
 */
const AT_ONCE = 2;
let busy = 0;
const waiting: Array<() => void> = [];
async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (busy < AT_ONCE) busy++;
  else await new Promise<void>((go) => waiting.push(go));
  try {
    return await work();
  } finally {
    // The next in line takes this turn over.
    const next = waiting.shift();
    if (next) next();
    else busy--;
  }
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
/** A file's name in a message: as picked, or "That file". */
const shown = (name: string | undefined) => name?.trim().slice(0, 120) || "That file";
const timedOut = (error: unknown) => ["TimeoutError", "AbortError"].includes(String((error as { name?: unknown } | null)?.name));

/** The place the files go, after checking the person can see it. */
async function placeOf(c: Ctx, target: z.infer<typeof importBody>["target"]): Promise<Place> {
  const chosen = SLOTS.filter((slot) => target[slot] !== undefined);
  if (chosen.length !== 1) throw new HttpError(400, "Choose one place for the files: a folder, or a client's property, request, quote or job.");
  const slot = chosen[0]!;
  const { db, companyId } = c.var;
  if (slot === "folder_id") {
    const id = target.folder_id ?? must(await db.rpc("drive_root", { p_company: companyId }));
    const folder = await db.from("drive_folders").select("id").eq("company_id", companyId).eq("id", id).maybeSingle();
    if (folder.error) throw dbError(folder.error);
    if (!folder.data) throw new HttpError(404, "That folder isn't here anymore. It may have been moved to the Trash.");
    return { folder_id: id };
  }
  const id = target[slot]!;
  const [table, word] = RECORDS[slot];
  const found = await db.from(table).select("id").eq("company_id", companyId).eq("id", id).maybeSingle();
  if (found.error) throw dbError(found.error);
  if (!found.data) throw new HttpError(404, `We couldn't find that ${word}. It may have been deleted.`);
  return { [slot]: id };
}

/**
 * The Google sign-in the web app sent must be for this deployment's own Google app: one made for
 * another app (a Google account's sign-in to something else) is refused, so it can't be used here.
 */
async function checkGoogleSignIn(clientId: string, accessToken: string): Promise<void> {
  let info: { aud?: unknown; azp?: unknown } | null = null;
  try {
    const response = await fetch(`${TOKEN_INFO}?${new URLSearchParams({ access_token: accessToken })}`, { signal: AbortSignal.timeout(15_000) });
    if (response.status >= 500) throw new HttpError(503, "Google didn't answer. Try again in a minute.");
    if (response.ok) info = (await response.json()) as { aud?: unknown; azp?: unknown };
  } catch (error) {
    // Never logged: the address holds the sign-in.
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "Google didn't answer. Try again in a minute.");
  }
  if (!info) throw new HttpError(400, "Google didn't accept that sign-in. Choose the files again.");
  const apps = [info.aud, info.azp].filter((party) => party !== undefined && party !== null && party !== "");
  if (!apps.length || apps.some((party) => party !== clientId)) {
    throw new HttpError(403, "That Google sign-in is for another app, so nothing was brought in. Choose the files again from Crewtavo.");
  }
}

/** Why Google refused, in Google's own words: its error's reason ("exportSizeLimitExceeded"). */
async function googleReason(response: Response): Promise<string> {
  const json = (await response.json().catch(() => null)) as { error?: { errors?: Array<{ reason?: string }>; status?: string } } | null;
  return String(json?.error?.errors?.[0]?.reason ?? json?.error?.status ?? "");
}

/** A request to Google Drive for one file. Anything but an answer is that file skipped, with why. */
async function fromGoogle(url: string, accessToken: string, signal: AbortSignal, name: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal });
  } catch (error) {
    throw new Skipped(timedOut(error) ? `${name} took too long to come from Google Drive. Try it again on its own.` : `Google Drive didn't answer about ${name}. Try again in a minute.`);
  }
  if (response.ok) return response;
  const reason = await googleReason(response);
  if (response.status === 401) throw new Skipped(`Google's sign-in ran out before ${name} came in. Import it again.`);
  if (reason === "exportSizeLimitExceeded") throw new Skipped(`${name} is too large for Google to convert (over 10 MB). Download it from Google Drive, then upload it here.`);
  if (reason === "cannotDownloadAbusiveFile") throw new Skipped(`Google flagged ${name} as harmful, so it can't be brought in.`);
  if (reason === "cannotDownloadFile") throw new Skipped(`The owner of ${name} doesn't allow downloading it.`);
  if (response.status === 429 || /rateLimit/i.test(reason)) throw new Skipped(`Google Drive is busy. Try ${name} again in a minute.`);
  if (response.status === 403 || response.status === 404) throw new Skipped(`Google Drive didn't let Crewtavo open ${name}. Choose it again.`);
  throw new Skipped(`Google Drive couldn't send ${name} (error ${response.status}). Try again in a minute.`);
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  capabilities?: { canDownload?: boolean };
  shortcutDetails?: { targetId?: string };
}

async function aboutFile(id: string, accessToken: string, signal: AbortSignal, name: string): Promise<DriveFile> {
  if (!DRIVE_ID.test(id)) throw new Skipped(`${name} isn't a file Google Drive knows. Choose it again.`);
  const params = new URLSearchParams({ fields: "id,name,mimeType,size,capabilities/canDownload,shortcutDetails", supportsAllDrives: "true" });
  const response = await fromGoogle(`${DRIVE_FILES}/${encodeURIComponent(id)}?${params}`, accessToken, signal, name);
  const json = (await response.json().catch(() => null)) as Partial<DriveFile> | null;
  if (!json || typeof json.id !== "string" || !DRIVE_ID.test(json.id)) throw new Skipped(`Google Drive didn't say what ${name} is. Choose it again.`);
  return { ...json, id: json.id, name: String(json.name ?? ""), mimeType: String(json.mimeType ?? "").toLowerCase() };
}

/** A download read whole, up to `max` bytes: null when it's larger (it stops reading there). */
async function readUpTo(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  // Its size said up front (and not compressed, which would make it the compressed size): read
  // straight into one buffer, so a big file is held once rather than twice.
  const encoding = (response.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (Number.isInteger(declared) && declared > 0 && encoding === "identity") {
    const bytes = new Uint8Array(declared);
    let at = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.byteLength > declared) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Google Drive sent more than it said it would.");
      }
      bytes.set(value, at);
      at += value.byteLength;
    }
    return at === declared ? bytes : bytes.slice(0, at);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** A file name the table takes (up to 255 characters), keeping its extension when it's cut short. */
function storedName(name: string, ext: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "").trim() || `Untitled.${ext}`;
  return clean.length <= 255 ? clean : `${clean.slice(0, 254 - ext.length).trimEnd()}.${ext}`;
}

/** One picked file: asked about, downloaded (or converted), stored, then recorded as the person. */
async function bringIn(c: Ctx, accessToken: string, picked: Picked, place: Place): Promise<PlanFileRow> {
  const signal = AbortSignal.timeout(FILE_TIMEOUT_MS);
  let name = shown(picked.name);
  let file = await aboutFile(picked.id, accessToken, signal, name);
  // A shortcut: the file it points to (once; a shortcut to a shortcut isn't followed).
  if (file.mimeType === SHORTCUT) {
    const target = file.shortcutDetails?.targetId;
    if (!target) throw new Skipped(`${name} is a shortcut to something Crewtavo can't open. Choose the file itself.`);
    file = await aboutFile(target, accessToken, signal, name);
  }
  name = shown(file.name || picked.name);
  if (file.mimeType === FOLDER) throw new Skipped(`${name} is a folder. Open it and choose the files in it.`);
  if (file.mimeType === SHORTCUT) throw new Skipped(`${name} is a shortcut to something Crewtavo can't open. Choose the file itself.`);
  const exported = GOOGLE_EXPORTS[file.mimeType];
  if (!exported && file.mimeType.startsWith(GOOGLE_KIND)) throw new Skipped(`${name} is a kind of Google file that can't be downloaded.`);
  if (file.capabilities?.canDownload === false) throw new Skipped(`The owner of ${name} doesn't allow downloading it.`);
  const tooLarge = `${name} is larger than ${megabytes(UPLOAD_LIMIT)}, the most Crewtavo takes.`;
  if (!exported && Number(file.size) > UPLOAD_LIMIT) throw new Skipped(tooLarge);
  // The storage limits, as the gateway checks an upload from the browser (lib/storageLimits.ts): first
  // by the size Google gives, so a file that won't fit isn't downloaded at all...
  const { companyId, userId } = c.var;
  const limits = snapshotsFrom(() => adminClient(c.env));
  const upload = { company: companyId, user: userId, folder: "plans" };
  const early = await reserveStorage(limits, { ...upload, bytes: exported ? null : Number(file.size) || null });
  if (!early.ok) throw new Skipped(early.message, true);
  early.release();

  // Google's own documents are converted (Docs to Word, Sheets to Excel...); every other file comes as it is.
  const url = exported
    ? `${DRIVE_FILES}/${encodeURIComponent(file.id)}/export?${new URLSearchParams({ mimeType: exported.mime })}`
    : `${DRIVE_FILES}/${encodeURIComponent(file.id)}?${new URLSearchParams({ alt: "media", supportsAllDrives: "true" })}`;
  const response = await fromGoogle(url, accessToken, signal, name);
  let bytes: Uint8Array | null;
  try {
    bytes = await readUpTo(response, UPLOAD_LIMIT);
  } catch (error) {
    throw new Skipped(timedOut(error) ? `${name} took too long to come from Google Drive. Try it again on its own.` : `${name} stopped partway from Google Drive. Try it again.`);
  }
  if (!bytes) throw new Skipped(tooLarge);
  if (!bytes.byteLength) throw new Skipped(`${name} is empty.`);

  const ext = exported ? exported.ext : extensionFor(file.name, file.mimeType);
  const base = file.name.trim() || shown(picked.name);
  const fileName = storedName(exported && !base.toLowerCase().endsWith(`.${ext}`) ? `${base}.${ext}` : base, ext);
  const contentType = (exported ? exported.mime : file.mimeType || "application/octet-stream").slice(0, 150);

  // ...then by what came, which counts from here until the numbers are read again.
  const held = await reserveStorage(limits, { ...upload, bytes: bytes.byteLength });
  if (!held.ok) throw new Skipped(held.message, true);

  // Buffered, so it's sent with its length: a gateway refuses an upload without one.
  const { db } = c.var;
  const files = adminClient(c.env).storage.from("files");
  const path = `${companyId}/plans/${crypto.randomUUID()}.${ext}`;
  const stored = await files.upload(path, bytes, { contentType, upsert: false });
  if (stored.error) {
    held.release();
    const status = String((stored.error as { statusCode?: unknown }).statusCode ?? "");
    if (status === "413" || /maximum allowed size|too large/i.test(stored.error.message)) throw new Skipped(`${name} is larger than this Crewtavo's storage takes.`);
    console.warn(`Couldn't store a file from Google Drive: ${stored.error.message}`);
    throw new Skipped(`Crewtavo couldn't store ${name}. Try again in a minute.`);
  }

  // Recorded as the person: the database decides whether they can add files there, and they added it.
  const row = await db
    .from("plan_files")
    .insert({
      company_id: companyId,
      ...place,
      title: fileTitle(fileName),
      path,
      file_name: fileName,
      content_type: contentType,
      size_bytes: bytes.byteLength,
      // Company files are the office's until someone shows them to the crew; a job's are the crew's.
      crew_visible: !("folder_id" in place),
    })
    .select("*")
    .single();
  if (row.error) {
    held.release();
    await removeStored(files, [path]);
    throw new Skipped(`${name} wasn't added: ${dbError(row.error).message}`);
  }
  // Stored and kept: the next reading of the numbers has it.
  held.stored();
  return row.data;
}

drive.post("/drive/import", requireUser, requireCompany(DRIVE_ROLES), async (c) => {
  const clientId = requireEnv(c.env, "GOOGLE_CLIENT_ID", "Importing from Google Drive");
  requireEnv(c.env, "GOOGLE_PICKER_API_KEY", "Importing from Google Drive");
  const body = await readJson(c, importBody);
  if (!body.files.length) throw new HttpError(400, "Choose at least one file in Google Drive.");
  if (body.files.length > MOST_FILES) throw new HttpError(400, `Choose up to ${MOST_FILES} files at a time.`);
  if (!body.accessToken) throw new HttpError(400, "Sign in to Google again, then choose the files.");
  const place = await placeOf(c, body.target);
  await checkGoogleSignIn(clientId, body.accessToken);

  const files: PlanFileRow[] = [];
  // `full`: refused by a storage limit (the reason says which), so the screen can point to Settings → Storage.
  const skipped: Array<{ name: string; reason: string; full?: true }> = [];
  for (const picked of body.files) {
    try {
      files.push(await inTurn(() => bringIn(c, body.accessToken, picked, place)));
    } catch (error) {
      if (!(error instanceof Skipped)) throw error;
      skipped.push({ name: shown(picked.name), reason: error.message, ...(error.full ? { full: true as const } : {}) });
    }
  }
  return c.json({ files, skipped });
});

// ---------------------------------------------------------------------------------------------
// The Trash
// ---------------------------------------------------------------------------------------------

/** The folder under Company files that files from elsewhere in Crewtavo are restored to. */
const RESTORED = "Restored files";

/** What a file from elsewhere is called when it came without a name of its own. */
const SOURCE_NAMES: Record<string, string> = {
  visit_photo: "Visit photo",
  quote_photo: "Quote photo",
  sub_document: "Paperwork",
  receipt: "Receipt",
  applicant_file: "Applicant file",
  kb_cover: "Guide cover",
  equipment_photo: "Equipment photo",
  ticket_photo: "Ticket photo",
};

/**
 * Files from elsewhere only some people may see (the Subs, Hiring and Job costs areas): they never go
 * into Company files, which the whole office opens. Where they were is gone, so they're downloaded
 * from the Trash instead (drive_restore says the same).
 */
const RESTRICTED = new Set(["sub_document", "applicant_file", "receipt"]);
const DOWNLOAD_INSTEAD = "This file can't go back where it was, because that was deleted. Download it from the Trash instead.";

/**
 * Whether this person sees a file from elsewhere in the Trash: the rules drive_trash() lists them by
 * (20261028000300_drive.sql). Hidden kinds (old map pictures, chat files) are never seen; receipts
 * are for whoever sees job costs, or deleted it; paperwork and applicants' files only for the office
 * people with Subs or Hiring. Everything else, for the office roles this route takes.
 */
function seesTrashed(trashed: { source: string; deleted_by: string | null }, who: { userId: string; role: Role; permissions: Permission[] }): boolean {
  switch (trashed.source) {
    case "measurement_snapshot":
    case "chat_file":
      return false;
    case "receipt":
      return trashed.deleted_by === who.userId || who.permissions.includes("job_costs");
    case "sub_document":
      return OFFICE.includes(who.role) && who.permissions.includes("subs");
    case "applicant_file":
      return OFFICE.includes(who.role) && who.permissions.includes("hiring");
    default:
      return true;
  }
}

/** Company files › Restored files, made the first time it's needed. */
async function restoredFolder(db: Db, companyId: string): Promise<string> {
  const root = must(await db.rpc("drive_root", { p_company: companyId }));
  const find = () => db.from("drive_folders").select("id").eq("company_id", companyId).eq("parent_id", root).ilike("name", RESTORED).limit(1).maybeSingle();
  const found = await find();
  if (found.error) throw dbError(found.error);
  if (found.data) return found.data.id;
  const made = await db.from("drive_folders").insert({ company_id: companyId, parent_id: root, name: RESTORED }).select("id").single();
  if (!made.error) return made.data.id;
  // Someone made it at the same moment: theirs.
  if (made.error.code === "23505") {
    const again = await find();
    if (again.data) return again.data.id;
  }
  throw dbError(made.error);
}

/**
 * Restoring a file from elsewhere whose place is gone (drive_restore answered needs_copy: the visit or
 * the quote was deleted, the guide or the machine has another picture now): a copy goes into Company
 * files › Restored files, office only, and the original leaves the Trash. Paperwork, résumés and
 * receipts never do (409): they're downloaded from the Trash instead.
 */
drive.post("/drive/trash/:id/to-drive", requireUser, requireCompany(DRIVE_ROLES), async (c) => {
  const id = param(c, "id");
  const { db, companyId } = c.var;
  const admin = adminClient(c.env);
  const found = await admin
    .from("trashed_files")
    .select("id, company_id, path, file_name, content_type, size_bytes, source, label, deleted_by")
    .eq("company_id", companyId)
    .eq("id", id)
    .maybeSingle();
  if (found.error) throw dbError(found.error);
  const trashed = found.data;
  if (!trashed || !inCompany(companyId, trashed.path) || !seesTrashed(trashed, c.var)) throw new HttpError(404, "That isn't in the Trash anymore.");
  if (RESTRICTED.has(trashed.source)) throw new HttpError(409, DOWNLOAD_INSTEAD);

  const folderId = await restoredFolder(db, companyId);
  const files = admin.storage.from("files");
  const ext = extensionFor(trashed.path, trashed.content_type);
  const path = `${companyId}/plans/${crypto.randomUUID()}.${ext}`;
  const copied = await files.copy(trashed.path, path);
  if (copied.error) {
    const status = String((copied.error as { statusCode?: unknown }).statusCode ?? "");
    if (status === "404" || /not.?found/i.test(copied.error.message)) throw new HttpError(404, "That file is gone from storage, so it can't be restored.");
    console.warn(`Couldn't copy a file out of the Trash: ${copied.error.message}`);
    throw new HttpError(503, "Crewtavo couldn't copy that file. Try again in a minute.");
  }
  const fileName = storedName(trashed.file_name?.trim() || `${SOURCE_NAMES[trashed.source] ?? "File"}.${ext}`, ext);
  const row = await db
    .from("plan_files")
    .insert({
      company_id: companyId,
      folder_id: folderId,
      title: fileTitle(fileName),
      notes: trashed.label ? `Restored from the Trash. It was: ${trashed.label}`.slice(0, 2000) : "Restored from the Trash.",
      path,
      file_name: fileName,
      content_type: trashed.content_type?.slice(0, 150) ?? null,
      size_bytes: trashed.size_bytes,
      crew_visible: false,
    })
    .select("*")
    .single();
  if (row.error) {
    await removeStored(files, [path]);
    throw dbError(row.error);
  }

  // The copy is in Drive: the original leaves the Trash, and its stored file goes too unless
  // something else uses it (the database says). One Storage won't remove is left behind.
  const original = await admin.rpc("trash_copied_to_drive", { p_company: companyId, p_id: trashed.id });
  if (original.error) reportError(new Error(`Couldn't take a restored file out of the Trash: ${original.error.message}`), { route: "/api/drive/trash/:id/to-drive" });
  else if (original.data && inCompany(companyId, original.data)) await removeStored(files, [original.data]);
  return c.json({ file: row.data }, 201);
});

const TRASH_KINDS = ["file", "version", "folder", "other"] as const;

/**
 * Delete forever, before the 30 days are up: owners only. The database deletes what's still in the
 * Trash (trash_delete_forever: a file with its versions, a version, a folder with what went with it,
 * a file from elsewhere; anything else asked for is left out) and hands over the stored files nothing
 * uses any more, which are removed here; one Storage won't remove is left behind. Says how many of the
 * things asked for are gone.
 */
drive.post("/drive/trash/delete-forever", requireUser, requireCompany(OWNERS), async (c) => {
  const body = await readJson(c, z.object({ items: z.array(z.object({ kind: z.enum(TRASH_KINDS), id: uuid })) }));
  if (!body.items.length) throw new HttpError(400, "Choose what to delete.");
  if (body.items.length > 200) throw new HttpError(400, "Delete up to 200 at a time.");
  const { db, companyId } = c.var;
  const items = [...new Map(body.items.map((i) => [`${i.kind}:${i.id}`, i])).values()];
  // As the person: the database checks they're an owner too. A row for each thing it deleted, with
  // its files (a folder's can be thousands, so never a row a file: PostgREST answers 1000 at most).
  const rows = must(await db.rpc("trash_delete_forever", { p_company: companyId, p_items: items }));
  const paths = rows.flatMap((r) => (r.paths ?? []).filter((path) => inCompany(companyId, path)));
  await removeStored(adminClient(c.env).storage.from("files"), paths);
  return c.json({ removed: rows.length });
});
