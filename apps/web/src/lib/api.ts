/**
 * Talking to the backend.
 *   - Supabase directly (supabase()) for reads and simple edits; row-level security protects data.
 *   - The Crewtavo API (api.get/post...) for business operations and anything needing a secret.
 * The SPA has no build-time settings: it loads /api/config at startup.
 */
import type { Database } from "@crewtavo/core/database";
import { createClient, isAuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { ApiError, friendlyDbError, isRestarting, OFFLINE, SESSION_EXPIRED } from "./errors";
import { startMonitoring, type MonitoringConfig } from "./monitoring";

export { ApiError } from "./errors";

export interface AppConfig {
  supabaseUrl: string;
  supabaseKey: string;
  /** One business per instance: no sign-up; the first person to open it creates the owner account. */
  singleCompany?: boolean;
  /** Where the instance runs: on Railway, setup offers to connect it (features/setup/RailwaySetupPage). */
  platform?: "railway" | "compose" | "server";
  mapsBrowserKey: string | null;
  turnstileSiteKey: string | null;
  /** Error reporting (Sentry or GlitchTip), when the deployment sets CREWTAVO_SENTRY_DSN. */
  sentry: MonitoringConfig | null;
  /**
   * `emailCodes`: a sub can get a sign-in code by email, since this Crewtavo sends email in some way
   * (its own sender or some company's mailbox). For the whole instance, never one business.
   */
  features: { ai: boolean; payments: boolean; email: boolean; sms: boolean; emailCodes?: boolean; roofInsights: boolean; devMail?: boolean; findPaving?: boolean };
  /**
   * Import from Google Drive (Drive's Google Picker), when the deployment sets GOOGLE_CLIENT_ID and
   * GOOGLE_PICKER_API_KEY: the OAuth client, the browser key and the Cloud project number. All public.
   * Optional because a copy of the config saved by an older Crewtavo doesn't have it.
   */
  googlePicker?: { clientId: string; apiKey: string; appId: string } | null;
}

/**
 * What's on for one business: the instance's own keys (config), or what the business set up itself.
 * Its own mailbox (Settings → Email) turns email on, its own Anthropic key (Apps → Claude) AI, and
 * its fal.ai key (Apps → fal.ai) Find paving on the measuring map.
 */
export function companyFeatures(features: AppConfig["features"], company: { email_connected?: boolean; ai_connected?: boolean; fal_connected?: boolean }): AppConfig["features"] {
  const ownMailbox = Boolean(company.email_connected);
  return { ...features, email: features.email || ownMailbox, devMail: !ownMailbox && Boolean(features.devMail), ai: features.ai || Boolean(company.ai_connected), findPaving: Boolean(company.fal_connected) };
}

// Kept across hot reloads in development so modules that re-import this one keep a live client.
let configPromise: Promise<AppConfig> | null = import.meta.hot?.data.configPromise ?? null;
let client: SupabaseClient<Database> | null = import.meta.hot?.data.client ?? null;
let activeCompanyId: string | null = import.meta.hot?.data.activeCompanyId ?? null;
import.meta.hot?.dispose((data) => Object.assign(data, { configPromise, client, activeCompanyId }));

const CONFIG_KEY = "crewtavo.config";

export function loadConfig(): Promise<AppConfig> {
  configPromise ??= fetch("/api/config")
    .then(async (res) => {
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(body.error ?? "Couldn't connect to Crewtavo. Try again in a moment.", res.status);
      }
      const config = (await res.json()) as AppConfig;
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      } catch {
        // Private mode: no offline start, that's all.
      }
      return config;
    })
    .catch((error) => {
      // No signal: start with the settings from last time, so the crew's saved day still opens.
      if (!(error instanceof ApiError)) {
        try {
          const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null") as AppConfig | null;
          if (saved) return saved;
        } catch {
          // Nothing saved.
        }
      }
      configPromise = null; // allow a retry
      throw error instanceof ApiError ? error : new ApiError(OFFLINE, 0, "network");
    })
    .then((config) => {
      // A Crewtavo instance serves Supabase from its own address (apps/api/src/lib/stack.ts).
      config.supabaseUrl ||= window.location.origin;
      startMonitoring(config.sentry);
      client ??= createClient<Database>(config.supabaseUrl, config.supabaseKey, { global: { fetch: signedInFetch(config) } });
      return config;
    });
  return configPromise;
}

/**
 * When someone's access token has expired and refreshing it doesn't get through (a flaky
 * reconnect), supabase-js sends database requests with the public key instead, as if nobody were
 * signed in: reads come back empty and saves are refused. Fail those like the network failure they
 * are, so screens keep what they showed and queued field actions wait instead of being refused.
 */
function signedInFetch(config: AppConfig): typeof fetch {
  // Where supabase-js keeps the sign-in (its default storage key).
  const storageKey = `sb-${new URL(config.supabaseUrl).hostname.split(".")[0]}-auth-token`;
  const signInStored = () => {
    try {
      return localStorage.getItem(storageKey) !== null;
    } catch {
      return false;
    }
  };
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const publicKeyOnly = new Headers(init?.headers).get("Authorization") === `Bearer ${config.supabaseKey}`;
    // Sign-in requests themselves always go with the public key.
    if (publicKeyOnly && !url.includes("/auth/v1/") && signInStored()) return Promise.reject(new TypeError("Failed to fetch"));
    return globalThis.fetch(input, init);
  };
}

let refreshing: Promise<"ok" | "offline" | "expired"> | null = null;

/**
 * Turned away for the sign-in: the access token may only have expired (while the phone was
 * offline, say). Refresh it once before treating the person as signed out. "offline" means the
 * refresh didn't get through, which says nothing about the sign-in. Callers at the same moment share one refresh.
 */
export function refreshSignIn(): Promise<"ok" | "offline" | "expired"> {
  const auth = client?.auth;
  if (!auth) return Promise.resolve("expired");
  refreshing ??= (async () => {
    const { data, error } = await auth.refreshSession();
    if (data.session) return "ok" as const;
    if (isAuthRetryableFetchError(error)) return "offline" as const;
    // Another tab may have refreshed it in the meantime.
    const current = await auth.getSession();
    return current.data.session ? "ok" : isAuthRetryableFetchError(current.error) ? "offline" : "expired";
  })()
    .catch(() => "offline" as const)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** The Supabase client. Available once loadConfig() has resolved (SessionProvider waits for it). */
export function supabase(): SupabaseClient<Database> {
  if (!client) throw new Error("Still loading. Try again in a moment.");
  return client;
}

export function setActiveCompany(id: string | null) {
  activeCompanyId = id;
}
export const activeCompany = () => activeCompanyId;

export interface RequestOptions {
  /** Act in this company rather than the one on screen: a queued field action belongs to the company it was made in. */
  companyId?: string;
}

async function send(method: string, path: string, body: unknown, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (client) {
    const { data, error } = await client.auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
    // The sign-in needed refreshing and that didn't get through: without it the request would only be turned away.
    else if (isAuthRetryableFetchError(error)) throw new ApiError(OFFLINE, 0, "network");
  }
  const companyId = options.companyId ?? activeCompanyId;
  if (companyId) headers["X-Company-Id"] = companyId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(OFFLINE, 0, "network");
  }
}

async function request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  let res = await send(method, path, body, options);
  // The API answers 401 before doing anything, so after refreshing the sign-in the request can safely go again.
  if (res.status === 401 && client) {
    const signIn = await refreshSignIn();
    if (signIn === "offline") throw new ApiError(OFFLINE, 0, "network");
    if (signIn === "ok") res = await send(method, path, body, options);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    const fallback = res.status >= 500 ? "Something went wrong on our end. Try again in a moment." : "Something went wrong. Try again.";
    throw new ApiError(json.error ?? fallback, res.status, res.status === 401 ? SESSION_EXPIRED : undefined);
  }
  return json as T;
}

/** A file the API answers with (a picture), or null when there's none (404). */
async function requestBlob(path: string, options: RequestOptions = {}): Promise<Blob | null> {
  let res = await send("GET", path, undefined, options);
  if (res.status === 401 && client && (await refreshSignIn()) === "ok") res = await send("GET", path, undefined, options);
  if (res.status === 404) return null;
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(json.error ?? "Something went wrong. Try again.", res.status);
  }
  return res.blob();
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>("GET", path, undefined, options),
  blob: (path: string, options?: RequestOptions) => requestBlob(path, options),
  post: <T>(path: string, body: unknown = {}, options?: RequestOptions) => request<T>("POST", path, body, options),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>("PATCH", path, body, options),
  put: <T>(path: string, body: unknown, options?: RequestOptions) => request<T>("PUT", path, body, options),
  delete: <T>(path: string, options?: RequestOptions, body?: unknown) => request<T>("DELETE", path, body, options),
};

type DbResult = { data: unknown; error: { message: string; code?: string; details?: string | null; hint?: string | null } | null; status?: number };

/**
 * A failed database request as a friendly ApiError. One answered for the server while it restarts
 * keeps its 502, 503 or 504, so a queued field action waits for it instead of failing (lib/offline.ts).
 */
function dbFailure(result: DbResult): ApiError {
  // The server restarting isn't a database fault to report (a field action retries through it).
  if (isRestarting(result.status)) return new ApiError("Crewtavo is restarting. Try again in a moment.", result.status!, "restarting");
  return friendlyDbError(result.error!);
}

/** Unwrap a supabase-js result in a react-query function; errors become friendly ApiErrors. */
export function unwrap<R extends DbResult>(result: R): NonNullable<R["data"]> {
  if (result.error) throw dbFailure(result);
  return result.data as NonNullable<R["data"]>;
}

/** Like unwrap, but a missing row is an error ("not found") rather than null. */
export function unwrapOne<R extends DbResult>(result: R, what = "That record"): NonNullable<R["data"]> {
  if (result.error) throw dbFailure(result);
  if (result.data == null) throw new ApiError(`${what} wasn't found. It may have been deleted.`, 404, "PGRST116");
  return result.data as NonNullable<R["data"]>;
}

/** Strip characters that break PostgREST filter syntax from free-text search. */
export const searchTerm = (value: string) => value.replace(/[%,()*\\:."'#]/g, " ").replace(/\s+/g, " ").trim();
