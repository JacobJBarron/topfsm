/** Turn database, network and API failures into sentences people can act on. */
import { reportError } from "./monitoring";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    /** The form field the problem belongs to ("email", "phone", "slug", "name"), so it can show under that field. */
    public field?: string,
  ) {
    super(message);
  }
}

/** Said when Storage refused an upload for space but its own sentence didn't come through. */
export const STORAGE_FULL = "Crewtavo's storage is full. An owner or admin can raise the limit in Settings → Storage, or empty the Trash.";

/**
 * An upload turned away for space: the company's storage limit, or the person's own, is used up
 * (507 from the storage gateway). The message is the server's own sentence, which says who can raise
 * it, so it's shown as it is and never retried.
 */
export class StorageFullError extends ApiError {
  constructor(message = STORAGE_FULL) {
    super(message || STORAGE_FULL, 507, "storage_full");
  }
}

/** Refused for space: an upload's StorageFullError, or any 507 from the API (a Google Drive import). */
export const isStorageFull = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 507;

/** The message for a form field when the error is about that field, else null: <Field error={fieldError(save.error, "email")}>. */
export function fieldError(error: unknown, field: string): string | null {
  return error instanceof ApiError && error.field === field ? error.message : null;
}

interface DbErrorLike {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** Postgres / PostgREST error -> ApiError with a friendly message. */
export function friendlyDbError(error: DbErrorLike): ApiError {
  const code = error.code ?? "";
  const raw = error.message ?? "";
  if (code === "42501" || /row-level security/i.test(raw)) return new ApiError("You don't have permission to do that.", 403, code);
  if (code === "23505") {
    const field = duplicateField(error);
    return new ApiError(duplicateMessage(field), 409, code, field);
  }
  if (code === "23503") {
    return /update or delete/i.test(raw)
      ? new ApiError("It's still used by other records, so it can't be deleted. Archive it instead.", 409, code)
      : new ApiError("That refers to something that no longer exists. Refresh and try again.", 400, code);
  }
  if (code === "23502") return new ApiError("Fill in all the required fields.", 400, code);
  if (code === "23514") return new ApiError("One of the values isn't allowed. Check the form and try again.", 400, code);
  if (code === "22P02" || code === "22007" || code === "22008") return new ApiError("Something you entered doesn't look right. Check the form and try again.", 400, code);
  if (code === "22003") return new ApiError("A number is too large.", 400, code);
  if (code === "PGRST116") return new ApiError("We couldn't find that. It may have been deleted.", 404, code);
  if (code === "PGRST301" || code === "PGRST303" || /jwt expired/i.test(raw)) return new ApiError("Your session has expired. Sign in again.", 401, code);
  // Our own database functions raise readable messages (codes 22023, P0001, P0002).
  if (code === "22023" || code === "P0001" || code === "P0002") return new ApiError(raw, code === "P0002" ? 404 : 400, code);
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return new ApiError(OFFLINE, 0, "network");
  // Malformed requests won't succeed on retry.
  if (code.startsWith("PGRST") || code.startsWith("42")) {
    console.error("Database request failed", error);
    reportError(new Error(`Database request failed: ${code} ${raw}`));
    return new ApiError("Something went wrong. Refresh the page and try again.", 400, code);
  }
  reportError(new Error(`Database error${code ? ` ${code}` : ""}: ${raw}`));
  return new ApiError("Something went wrong. Try again.", 500, code);
}

/**
 * Which field clashed in a unique index, read from the columns in its details, as in
 * "Key (company_id, email)=(…) already exists." (the values after "=" are left out, since they can say anything),
 * or else from the index's name in the message.
 */
function duplicateField(error: DbErrorLike): string | undefined {
  const details = error.details ?? "";
  const columns = /^Key \((.*?)\)=\(/.exec(details)?.[1] ?? (details || /unique constraint "([^"]+)"/.exec(error.message ?? "")?.[1] || "");
  return ["email", "phone", "slug", "name"].find((field) => new RegExp(field, "i").test(columns));
}

function duplicateMessage(field: string | undefined): string {
  if (field === "email") return "Someone with that email already exists.";
  if (field === "phone") return "Someone with that phone number already exists.";
  if (field === "slug") return "That web address is taken. Try another.";
  if (field === "name") return "Something with that name already exists.";
  return "That already exists.";
}

export const OFFLINE = "No internet connection. Check your Wi-Fi or signal and try again.";

/** Messages meant for developers (stack traces, code errors, database internals) never reach people. */
const TECHNICAL = /undefined|null|NaN|\bTypeError\b|is not a function|is not defined|Cannot read|Unexpected token|JSON|syntax|status code|\bfetch\b|PGRST|violates|relation "|column "|constraint|\bjwt\b|\btoken\b|\[object|ECONN|ETIMEDOUT|\bHTTP\b/i;
export const looksTechnical = (message: string) => TECHNICAL.test(message) || message.length > 300;

/** Any thrown value -> a message for a toast or an inline error. */
export function errorMessage(error: unknown): string {
  if (!error) return "Something went wrong.";
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return OFFLINE;
  const raw = error instanceof Error ? error.message : typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : String(error);
  return looksTechnical(raw) ? "Something went wrong. Try again." : raw || "Something went wrong.";
}

export const isAuthError = (error: unknown) => error instanceof ApiError && error.status === 401;
/** Code of a 401 that stands after the sign-in was refreshed (or couldn't be): the person really is signed out. */
export const SESSION_EXPIRED = "session_expired";
/** The request never got an answer: no signal, or too little to carry it. */
export const isNetworkError = (error: unknown) => error instanceof ApiError && error.status === 0;
/**
 * Answered for the server rather than by it: 502, 503 or 504 from the proxy in front of it while it
 * restarts or deploys, or from the gateway while a part of it is still starting.
 */
export const isRestarting = (status?: number) => status === 502 || status === 503 || status === 504;
export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
