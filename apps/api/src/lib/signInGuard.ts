/**
 * Password and code guessing, stopped at the instance's gateway (lib/gateway.ts). GoTrue only limits
 * sign-in attempts per address when told which header to trust (GOTRUE_RATE_LIMIT_HEADER, which an
 * instance doesn't set), so failures are counted per account instead. After 10 wrong passwords or
 * codes for an email in 15 minutes, password and code sign-in for that email pause for 15 minutes.
 * Successful sign-ins don't count, and an emailed sign-in link (a long token, not a code) still
 * works, so a stranger can't lock anyone out of their account.
 *
 * Counts are shared through Postgres (lib/limit.ts); each process remembers the accounts it has
 * seen paused, so a paused account's attempts never reach GoTrue.
 */
import type { Env } from "../env";
import { allow } from "./limit";

export const GUESSES = 10;
export const GUESS_WINDOW_SECONDS = 15 * 60;
/** A sign-in request is a few hundred bytes; anything far bigger isn't one. */
const MAX_BODY = 64 * 1024;

const paused = new Map<string, number>();
/** Attempts per account waiting for (or at) GoTrue, sent one after another. */
const queues = new Map<string, { tail: Promise<unknown>; waiting: number }>();
const MAX_WAITING = 5;

/** Requests that carry an email and a secret someone could guess: a password, or a 6-digit code. */
export function isGuessable(method: string, url: URL, prefix: string): boolean {
  if (method !== "POST") return false;
  const path = url.pathname.slice(prefix.length);
  return (path === "/token" && url.searchParams.get("grant_type") === "password") || path === "/verify";
}

export async function guardSignIn(env: Env, request: Request, send: (request: Request) => Promise<Response>): Promise<Response> {
  const body = await readUpTo(request, MAX_BODY);
  if (body === null) return Response.json({ code: 413, error_code: "request_too_large", msg: "That request is too large." }, { status: 413 });
  const fields = signInFields(body);
  if (!fields) return refuse("Sign in with your email address.");
  // GoTrue gets exactly what was checked here, in a body with one spelling of each field.
  const replay = new Request(request.url, { method: request.method, headers: request.headers, body: JSON.stringify(fields) });

  const email = typeof fields.email === "string" ? fields.email.trim().toLowerCase() : "";
  // A link's token_hash is long and random; only an email with a password or code can be guessed.
  if (!email) return typeof fields.token_hash === "string" && fields.token_hash ? send(replay) : refuse("Sign in with your email address.");

  const key = `sign-in-guess:${email}`;
  // An account's attempts go to GoTrue one at a time: failures are counted as GoTrue answers, so
  // guesses sent all at once would otherwise all get through before the count reached the limit.
  // A few waiting is normal (people sharing a sign-in, several tabs); a burst beyond that isn't.
  const queue = queues.get(key) ?? { tail: Promise.resolve(), waiting: 0 };
  if (queue.waiting >= MAX_WAITING) return tooMany(1000, "Too many sign-ins for this account at once. Try again in a moment.");
  queue.waiting++;
  queues.set(key, queue);
  const turn = queue.tail.then(() => attempt(env, key, replay, send));
  queue.tail = turn.catch(() => undefined);
  try {
    return await turn;
  } finally {
    if (--queue.waiting === 0) queues.delete(key);
  }
}

async function attempt(env: Env, key: string, request: Request, send: (request: Request) => Promise<Response>): Promise<Response> {
  const until = paused.get(key);
  if (until && until > Date.now()) return tooMany(until - Date.now());
  if (until) paused.delete(key);
  const response = await send(request);
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    if (!(await allow(env, key, GUESSES, GUESS_WINDOW_SECONDS))) {
      if (paused.size > 10_000) for (const [k, t] of paused) if (t <= Date.now()) paused.delete(k);
      paused.set(key, Date.now() + GUESS_WINDOW_SECONDS * 1000);
    }
  }
  return response;
}

/** What a password sign-in or a code check may carry (what supabase-js sends). */
const FIELDS = ["email", "password", "token", "token_hash", "type", "redirect_to", "gotrue_meta_security", "code_challenge", "code_challenge_method"];

/**
 * The request's fields, under their usual names. GoTrue reads JSON with Go, which matches names
 * whatever their case ("EMAIL" fills email; the last one wins), so this does the same: a guess
 * can't slip past under another spelling. Null when it isn't a JSON object, or signs in by phone
 * (turned off in an instance).
 */
function signInFields(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const fields: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const lower = name.toLowerCase();
    if (lower === "phone") return null;
    if (FIELDS.includes(lower)) fields[lower] = value;
  }
  return fields;
}

function refuse(msg: string): Response {
  return Response.json({ code: 400, error_code: "validation_failed", msg }, { status: 400 });
}

function tooMany(ms: number, msg = "Too many wrong attempts for this account. Wait 15 minutes, or sign in with an emailed link."): Response {
  const seconds = Math.ceil(ms / 1000);
  return Response.json(
    { code: 429, error_code: "over_request_rate_limit", msg },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

/** The body as text, or null once it passes `max` bytes (without reading the rest). */
export async function readUpTo(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
