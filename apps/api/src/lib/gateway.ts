/**
 * Gateway to the instance's Supabase services, in place of Supabase's own API gateway: the browser
 * and supabase-js use this server's address as the Supabase URL (server.ts mounts it in stack mode;
 * see lib/stack.ts).
 */
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { STORAGE_PAUSED, storageWritesPaused } from "../services/storageBucket";
import { guardAssistant, guardConsent } from "./assistants";
import { EMAILED_SIGN_INS, signedInWithin } from "./auth";
import { authMetadata, signsIdTokens, withoutOpenId } from "./authMetadata";
import { guardSignIn, isGuessable, readUpTo } from "./signInGuard";
import type { Stack } from "./stack";
import { guardStorage, routedPath, snapshotsFrom, verifiedClaims, type SnapshotSource } from "./storageLimits";
import { adminClient } from "./supabase";
import { connectionOf, visitorIp } from "./visitor";

type Gateway = { Bindings: HttpBindings };

/**
 * `storage`: where the storage limits' numbers come from (the database, unless a test says
 * otherwise). `jwtSecret`: what the instance's services sign tokens with (JWT_SECRET, which stack
 * mode always has), so the limits know who's really uploading.
 */
export function gateway(
  env: Env,
  stack: Stack,
  { storage = snapshotsFrom(() => adminClient(env)), jwtSecret = (env as Env & { JWT_SECRET?: string }).JWT_SECRET }: { storage?: SnapshotSource; jwtSecret?: string } = {},
) {
  const routes = new Hono<Gateway>();
  const visitor = (c: Context<Gateway>) => visitorIp(env, c.req.raw.headers, connectionOf(c.env));
  // Auth's discovery documents, fixed for AI assistants' connectors (lib/authMetadata.ts).
  for (const doc of ["oauth-authorization-server", "openid-configuration"]) {
    routes.get(`/auth/v1/.well-known/${doc}`, async (c) => {
      const issuer = `${(env.APP_URL ?? new URL(c.req.url).origin).replace(/\/$/, "")}/auth/v1`;
      const metadata = await authMetadata([`${stack.auth.replace(/\/$/, "")}/.well-known/${doc}`], stack.auth, issuer);
      if (!metadata) return c.json({ message: "This part of Crewtavo is still starting. Try again in a moment." }, 503);
      return c.json(metadata, 200, { "Cache-Control": "public, max-age=300" });
    });
  }
  // An AI assistant's token only reads here unless the person allowed it to change things, and never
  // changes their sign-in (lib/assistants.ts)...
  routes.all("/auth/v1/*", async (c) => {
    const address = visitor(c);
    const send = (request: Request) => forward(request, stack.auth, "/auth/v1", address);
    let incoming = c.req.raw;
    // A connector's sign-in asking for an ID token Auth can't sign goes ahead without one.
    const plain = c.req.method === "GET" && c.req.path === "/auth/v1/oauth/authorize" ? withoutOpenId(new URL(incoming.url)) : null;
    if (plain && !(await signsIdTokens(`${stack.auth.replace(/\/$/, "")}/.well-known/jwks.json`))) incoming = new Request(plain, incoming);
    // ...and only someone on a team connects one (a sub's sign-in can't).
    return guardConsent(env, incoming, "/auth/v1", (consented) =>
      guardAssistant(env, consented, "/auth/v1", (request) =>
        isGuessable(request.method, new URL(request.url), "/auth/v1") ? guardSignIn(env, request, send) : guardPasswordChange(request, jwtSecret, send),
      ),
    );
  });
  routes.all("/rest/v1/*", (c) => guardAssistant(env, c.req.raw, "/rest/v1", (request) => forward(request, stack.rest, "/rest/v1", visitor(c))));
  routes.all("/storage/v1/*", async (c) => {
    // While storage switches between the volume and a bucket, uploads are turned away for a minute
    // or two so none land in the place being left (services/storageBucket.ts). Opening files,
    // signing links to them, listing and deleting carry on.
    if (storageWritesPaused() && storesFile(c.req.raw)) {
      return c.json({ statusCode: "503", error: "Moving", message: STORAGE_PAUSED }, 503, { "Retry-After": "30" });
    }
    if (storesThroughS3(c.req.raw)) {
      return c.json({ statusCode: "403", error: "Forbidden", message: "Crewtavo doesn't take files through Storage's S3 address. Upload them in Crewtavo." }, 403);
    }
    if (copiesAsPerson(c.req.raw, jwtSecret)) {
      return c.json({ statusCode: "403", error: "Forbidden", message: "Crewtavo copies and moves stored files itself. Upload the file where you want it instead." }, 403);
    }
    if (unsizedUpload(c.req.raw)) {
      return c.json({ statusCode: "411", error: "Length Required", message: "Send the file's size (Content-Length) with the upload, or send it as a form." }, 411);
    }
    // The upload's size goes along: Storage checks a file sent as the bare body against
    // FILE_SIZE_LIMIT by it (a form's file it checks as it arrives).
    const request = c.req.raw;
    const send = (r: Request) => forward(r, stack.storage, "/storage/v1", visitor(c), { "x-forwarded-prefix": "/storage/v1" }, true);
    // A signed-in person's upload over the company's storage limit, or their own, is refused before
    // anything is stored (lib/storageLimits.ts).
    const res = await guardAssistant(env, request, "/storage/v1", (r) => (storesFile(r) ? guardStorage(storage, jwtSecret, r, send) : send(r)));
    return safeFile(request, res);
  });
  return routes;
}

/** What a change to the signed-in person's account may carry (Auth's PUT /user). */
const USER_FIELDS = ["email", "password", "nonce", "data", "phone", "channel", "code_challenge", "code_challenge_method"];
/** How long after opening a reset, invitation or sign-in link a new password can be chosen. */
export const PASSWORD_LINK_SECONDS = 15 * 60;
export const PASSWORD_LINK_STALE = "That link was opened more than 15 minutes ago. Use Forgot password on the sign-in page to get a new one.";
export const EMAIL_CHANGE_STALE = "Sign in with a link or code sent to your email, then change it within 15 minutes.";

/**
 * A new password straight through Auth (PUT /auth/v1/user with a password) only within 15 minutes of
 * opening a reset, invitation or sign-in link (the app's "Choose a new password" screen). Anywhere
 * else it's changed in Crewtavo with the current one (POST /api/account/password), so a leftover or
 * stolen session can't set its own and then pass every password check (lib/auth.ts confirmPassword).
 * A new email or phone too: Auth takes one at once (MAILER_AUTOCONFIRM), and a sign-in link to it
 * would then let that session choose a password. Auth reads the body's names whatever their case,
 * so it gets exactly what was checked here, in a body with one spelling of each field, as the
 * sign-in guard does.
 */
async function guardPasswordChange(request: Request, secret: string | undefined, send: (request: Request) => Promise<Response>): Promise<Response> {
  let path = new URL(request.url).pathname.slice("/auth/v1".length);
  try {
    path = decodeURIComponent(path);
  } catch {
    // Auth turns away a path it can't read.
  }
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || path.replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase() !== "/user") return send(request);
  const text = await readUpTo(request, 64 * 1024);
  let parsed: unknown = null;
  try {
    parsed = text === null ? null : JSON.parse(text);
  } catch {
    // Not JSON: refused below.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Response.json({ code: 400, error_code: "bad_json", msg: "Send the change as JSON." }, { status: 400 });
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed)) if (USER_FIELDS.includes(name.toLowerCase())) fields[name.toLowerCase()] = value;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (["password", "email", "phone"].some((name) => name in fields) && !signedInWithin(verifiedClaims(token, secret), EMAILED_SIGN_INS, PASSWORD_LINK_SECONDS)) {
    return Response.json({ code: 403, error_code: "reauthentication_needed", msg: "password" in fields ? PASSWORD_LINK_STALE : EMAIL_CHANGE_STALE }, { status: 403 });
  }
  return send(new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(fields) }));
}

/**
 * The POSTs to Storage that only read: a signed link to one file (sign/<bucket>/<name>) or to
 * several (sign/<bucket>), and a folder's listing (list/<bucket>, list-v2/<bucket>). Exactly these
 * routes and only as POSTs: Storage's router takes anything else under them (a PUT, or a longer
 * path) as an upload into a bucket named "sign" or "list".
 */
const READS_BY_POST = /^\/storage\/v1\/object\/(?:sign\/[^/]+(?:\/.+)?|list\/[^/]+|list-v2\/[^/]+)$/;

/**
 * Whether a request to Storage can put a file where Storage keeps them: an upload (POST or PUT to
 * object/<bucket>/<name>), a signed upload (object/upload/sign/...), a resumable one
 * (upload/resumable), a copy or a move (object/copy, object/move), and anything else that isn't
 * known to only read or delete. These wait while storage switches over. Opening a file (GET),
 * checking one or a resumable upload's progress (HEAD), signing links and listing (the POSTs
 * above), and deleting carry on. The path is checked as it's forwarded, still encoded, so a
 * disguised one never passes as a read; and a method named in X-HTTP-Method-Override is checked
 * too (Storage goes by the request's own method, but this only has to be cautious).
 */
export function storesFile(request: Request): boolean {
  const path = new URL(request.url).pathname;
  const override = request.headers.get("x-http-method-override");
  return [request.method, ...(override ? [override] : [])].some((method) => {
    const verb = method.trim().toUpperCase();
    if (["GET", "HEAD", "OPTIONS", "DELETE"].includes(verb)) return false;
    return !(verb === "POST" && READS_BY_POST.test(path));
  });
}

/** Storage's S3 address (s3/...), as Storage's router reads the path. */
const S3 = /^\/storage\/v1\/s3(?:\/|$)/;

/**
 * A request that may store a file through Storage's S3 address. Storage takes those from anyone
 * signed in (their token as the S3 session token, with the public anon key), and they'd go in
 * past the storage limits (lib/storageLimits.ts), which only know Crewtavo's own ways of
 * uploading. Nothing in Crewtavo uploads that way, so here it's for reading only.
 */
export function storesThroughS3(request: Request): boolean {
  if (!storesFile(request)) return false;
  const path = routedPath(new URL(request.url).pathname);
  return path !== null && S3.test(path);
}

/** Storage's copy and move (object/copy, object/move), as its router reads the path. */
const COPY_OR_MOVE = /^\/storage\/v1\/object\/(?:copy|move)\/?$/;

/**
 * A copy or a move asked for by anyone but this server. Crewtavo copies and moves stored files only
 * as itself (Drive's restore from the Trash, for one), and a person's copy would put a file into a
 * folder the storage limits guard without the limits seeing it (lib/storageLimits.ts), so people
 * can't.
 */
export function copiesAsPerson(request: Request, secret: string | null | undefined): boolean {
  if (!storesFile(request)) return false;
  const path = routedPath(new URL(request.url).pathname);
  if (path === null || !COPY_OR_MOVE.test(path)) return false;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return verifiedClaims(token, secret)?.role !== "service_role";
}

/** Stored files a browser may show in place: PDFs and photos. Not SVG drawings, which can run scripts. */
const SHOWN_INLINE = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/gif"]);

/**
 * A stored file, as served from this server's own address (where the app and its sign-in live).
 * Storage serves a file with whatever type it was uploaded with, so a file someone uploaded as a web
 * page (a sub's "paperwork", say) would run as the app when the office opened it. Every file is
 * served as exactly its type (nosniff); anything but a PDF or a photo downloads instead of opening,
 * and if it's opened anyway it runs in a sandbox with nothing allowed. (PDFs aren't sandboxed:
 * Chrome won't show a PDF in a sandboxed page.)
 */
export function safeFile(request: Request, res: Response): Response {
  if (!["GET", "HEAD"].includes(request.method) || !new URL(request.url).pathname.startsWith("/storage/v1/object/")) return res;
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  const type = (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (res.ok && !SHOWN_INLINE.has(type)) {
    const named = headers.get("content-disposition")?.match(/;\s*filename\*?=.*$/i)?.[0] ?? "";
    headers.set("Content-Disposition", `attachment${named}`);
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * A file sent to Storage as the bare body, without saying how big it is (a chunked upload).
 * Storage would take it whatever its size, so it's refused here. Forms are fine without a length.
 */
export function unsizedUpload(request: Request): boolean {
  if (!["POST", "PUT", "PATCH"].includes(request.method) || !request.body) return false;
  if (request.headers.has("content-length")) return false;
  return !(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}

/** `keepLength`: pass the body's length on (only where the body is passed on untouched). */
async function forward(request: Request, upstream: string, prefix: string, visitor: string, extra: Record<string, string> = {}, keepLength = false): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(upstream);
  target.pathname = target.pathname.replace(/\/$/, "") + (incoming.pathname.slice(prefix.length) || "/");
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  // Hop-by-hop headers describe the browser's connection to this server, not the next one (fetch
  // refuses some of them outright, e.g. a chunked upload's transfer-encoding or expect: 100-continue).
  for (const name of ["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "expect", "proxy-authorization", "proxy-connection", "accept-encoding"]) headers.delete(name);
  // A guard may have put a different body in (the sign-in guard does), so the length goes along only
  // when asked; fetch then sends exactly that many bytes, or fails the request.
  if (!keepLength) headers.delete("content-length");
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", request.headers.get("x-forwarded-proto") ?? incoming.protocol.replace(":", ""));
  // The visitor's address as this deployment's proxy gave it, not whatever the visitor sent: Auth
  // records it with each sign-in (from the first X-Forwarded-For entry), and Storage logs it.
  headers.set("x-forwarded-for", visitor);
  headers.set("x-real-ip", visitor);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  const hasBody = !["GET", "HEAD"].includes(request.method);
  try {
    const res = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
    const out = new Headers(res.headers);
    // fetch already decoded the body.
    for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(name);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (error) {
    console.error(`Gateway: ${target.host} didn't answer`, (error as Error).message);
    return Response.json({ message: "This part of Crewtavo is still starting. Try again in a moment." }, { status: 503 });
  }
}
