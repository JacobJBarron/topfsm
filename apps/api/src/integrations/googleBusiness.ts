/**
 * Google Business Profile's APIs, signed in as the business (Apps → Google Business Profile): the
 * accounts and locations it manages (Account Management and Business Information v1), and a
 * location's reviews and the replies to them (the v4 API, which still holds reviews).
 *
 * Every Crewtavo instance's Google Cloud project needs Google's approval for these APIs. Until then
 * Google answers with zero quota, so the problem is told apart from the others (googleProblem): not
 * approved yet, the APIs not turned on, a sign-in that needs Reconnect, something about the location,
 * Google being busy, or another error.
 */
import type { LocationProblem } from "@crewtavo/core/reviews";
import type { Env } from "../env";
import type { Db } from "../lib/supabase";
import { IntegrationError } from "./registry";
import { accessToken, SignInRefused } from "./tokens";

const ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const V4 = "https://mybusiness.googleapis.com/v4";
const READ_MASK = "name,title,storefrontAddress,metadata";
/** A location picker shows at most this many. */
export const MAX_LOCATIONS = 200;

type GoogleJson = Record<string, any>;

/**
 * What went wrong with a call:
 *   approval     Google hasn't approved this project's access (zero quota, or access refused on a list)
 *   not_enabled  the Business Profile APIs aren't turned on in the project
 *   signin       the sign-in expired, was revoked or lacks the scope: Reconnect
 *   denied       access refused on one location: approval or a lost location, which a fresh list tells
 *   location     the location is gone, suspended or not verified (`detail`)
 *   token        Google turned down a page token: the pass starts again
 *   busy         a rate limit that isn't zero quota: tried again quietly
 *   error        anything else
 */
export type GoogleProblemKind = "approval" | "not_enabled" | "signin" | "denied" | "location" | "token" | "busy" | "error";

export class GoogleBusinessError extends IntegrationError {
  override name = "GoogleBusinessError";
  constructor(
    readonly kind: GoogleProblemKind,
    readonly status: number,
    message: string,
    readonly detail: LocationProblem | null = null,
  ) {
    super(message);
  }
}

/** Google's error details: each ErrorInfo's reason and metadata. */
function errorInfos(body: GoogleJson): Array<{ reason?: string; metadata?: Record<string, string> }> {
  const details = body?.error?.details;
  return Array.isArray(details) ? details.filter((d) => typeof d === "object" && d && String(d["@type"] ?? "").endsWith("ErrorInfo")) : [];
}

/** Google Cloud project problems (ErrorInfo reasons): the project itself, not the business's location. */
const PROJECT_REASONS = ["CONSUMER_SUSPENDED", "CONSUMER_INVALID"];
export const PROJECT_SUSPENDED = "the Google Cloud project Crewtavo signs in with is suspended or was deleted. Its owner can see why in Google Cloud.";

/**
 * Which problem an error is. `scope` is what was called: a list of accounts or locations, where a
 * refusal means the project isn't approved yet, or one location, where it may mean the location
 * was lost (the caller lists again to tell). Only a call about the location can say the location
 * is suspended: a suspended Google Cloud project ("Consumer 'projects/123' has been suspended") is
 * another error, tried again later.
 */
export function googleProblem(status: number, body: unknown, scope: "list" | "location" = "list"): { kind: GoogleProblemKind; message: string; detail: LocationProblem | null } {
  const json = (body && typeof body === "object" ? body : {}) as GoogleJson;
  const message = String(json.error?.message ?? "").slice(0, 300);
  const infos = errorInfos(json);
  const reasons = infos.map((i) => String(i.reason ?? ""));
  const words = `${message} ${String(json.error?.status ?? "")}`;
  const problem = (kind: GoogleProblemKind, detail: LocationProblem | null = null) => ({ kind, message: message || `Google answered ${status}`, detail });
  if (status === 401 || reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || /insufficient authentication scopes/i.test(message)) return problem("signin");
  if (reasons.some((r) => r === "SERVICE_DISABLED" || r === "API_DISABLED") || /has not been used in project|it is disabled/i.test(message)) return problem("not_enabled");
  if (reasons.some((r) => PROJECT_REASONS.includes(r)) || /\bconsumer\b.*\b(suspended|invalid)\b/i.test(message)) return { kind: "error", message: PROJECT_SUSPENDED, detail: null };
  if (status === 429 || /RESOURCE_EXHAUSTED/.test(words)) {
    return infos.some((i) => i.metadata?.quota_limit_value === "0") ? problem("approval") : problem("busy");
  }
  if (scope === "location" && /suspended/i.test(message)) return problem("location", "suspended");
  if (status === 403) return scope === "list" ? problem("approval") : problem("denied");
  if (status === 404 && scope === "location") return problem("location", "gone");
  if (status === 400 && /page ?token/i.test(message)) return problem("token");
  return problem("error");
}

/** A call to Google as the company's sign-in, which gives up after 20 seconds. */
async function gbp(env: Env, admin: Db, companyId: string, url: string, init: { method?: "GET" | "PUT" | "DELETE"; body?: unknown; scope?: "list" | "location"; token?: string } = {}): Promise<GoogleJson | null> {
  let token = init.token;
  if (!token) {
    try {
      ({ token } = await accessToken(env, admin, companyId, "google_business"));
    } catch (error) {
      if (error instanceof SignInRefused || (error instanceof IntegrationError && /isn't connected|reconnected/.test(error.message))) {
        throw new GoogleBusinessError("signin", 401, error.message);
      }
      throw error;
    }
  }
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 204) return null;
  const json = (await response.json().catch(() => ({}))) as GoogleJson;
  if (!response.ok) {
    const problem = googleProblem(response.status, json, init.scope ?? "list");
    throw new GoogleBusinessError(problem.kind, response.status, problem.message, problem.detail);
  }
  return json;
}

export interface GoogleLocation {
  /** locations/123 */
  name: string;
  title: string;
  /** "12 Main St, Radford, VA 24141", or null for a service-area business with no storefront. */
  address: string | null;
  place_id: string | null;
  new_review_uri: string | null;
  maps_uri: string | null;
  /** Google knows the business manages it (metadata.hasVoiceOfMerchant). */
  verified: boolean;
}

export interface GoogleAccount {
  /** accounts/123 */
  name: string;
  title: string;
  locations: GoogleLocation[];
}

const httpsOnly = (value: unknown) => (typeof value === "string" && /^https:\/\/\S+$/.test(value) ? value.slice(0, 2000) : null);

function locationOf(raw: GoogleJson): GoogleLocation {
  const a = raw.storefrontAddress as GoogleJson | undefined;
  const street = Array.isArray(a?.addressLines) ? a!.addressLines.filter(Boolean).join(", ") : "";
  const area = [a?.locality, [a?.administrativeArea, a?.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const address = [street, area].filter(Boolean).join(", ");
  return {
    name: String(raw.name ?? ""),
    title: String(raw.title ?? "").slice(0, 200) || "Your business",
    address: address || null,
    place_id: typeof raw.metadata?.placeId === "string" ? raw.metadata.placeId : null,
    new_review_uri: httpsOnly(raw.metadata?.newReviewUri),
    maps_uri: httpsOnly(raw.metadata?.mapsUri),
    verified: raw.metadata?.hasVoiceOfMerchant !== false,
  };
}

/** One account's locations, a page at a time, up to `limit`. */
async function accountLocations(env: Env, admin: Db, companyId: string, account: string, limit: number, token?: string): Promise<GoogleLocation[]> {
  const out: GoogleLocation[] = [];
  let page: string | undefined;
  do {
    const params = new URLSearchParams({ readMask: READ_MASK, pageSize: "100" });
    if (page) params.set("pageToken", page);
    const json = (await gbp(env, admin, companyId, `${INFO}/${account}/locations?${params}`, { token }))!;
    for (const raw of json.locations ?? []) if (out.length < limit) out.push(locationOf(raw));
    page = json.nextPageToken;
  } while (page && out.length < limit);
  return out;
}

/**
 * The accounts the sign-in manages and their locations, up to MAX_LOCATIONS in all, for picking the
 * one whose reviews come in. `token` is a fresh sign-in's own, before it's saved.
 */
export async function listAccountsAndLocations(env: Env, admin: Db, companyId: string, token?: string): Promise<GoogleAccount[]> {
  const accounts: GoogleAccount[] = [];
  let page: string | undefined;
  let total = 0;
  do {
    const params = new URLSearchParams({ pageSize: "20" });
    if (page) params.set("pageToken", page);
    const json = (await gbp(env, admin, companyId, `${ACCOUNTS}/accounts?${params}`, { token }))!;
    for (const raw of json.accounts ?? []) {
      if (total >= MAX_LOCATIONS) break;
      const name = String(raw.name ?? "");
      const locations = await accountLocations(env, admin, companyId, name, MAX_LOCATIONS - total, token);
      total += locations.length;
      accounts.push({ name, title: String(raw.accountName ?? "Google account").slice(0, 200), locations });
    }
    page = json.nextPageToken;
  } while (page && total < MAX_LOCATIONS);
  return accounts;
}

/** One location of an account, read from Google (never from the browser), or null when it isn't the account's. */
export async function findLocation(env: Env, admin: Db, companyId: string, account: string, location: string): Promise<GoogleLocation | null> {
  const all = await accountLocations(env, admin, companyId, account, 1000);
  return all.find((l) => l.name === location) ?? null;
}

/** One location by its name (locations/123). */
export async function getLocation(env: Env, admin: Db, companyId: string, location: string): Promise<GoogleLocation> {
  return locationOf((await gbp(env, admin, companyId, `${INFO}/${location}?readMask=${READ_MASK}`, { scope: "location" }))!);
}

/** A review as the v4 API sends it. */
export interface GoogleReview {
  reviewId?: string;
  name?: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

export interface ReviewsPage {
  reviews: GoogleReview[];
  averageRating: number | null;
  totalReviewCount: number | null;
  nextPageToken: string | null;
}

/** A page of a location's reviews, most recently changed first. `parent` is accounts/…/locations/…. */
export async function listReviewsPage(env: Env, admin: Db, companyId: string, parent: string, pageToken?: string | null): Promise<ReviewsPage> {
  const params = new URLSearchParams({ pageSize: "50", orderBy: "updateTime desc" });
  if (pageToken) params.set("pageToken", pageToken);
  const json = (await gbp(env, admin, companyId, `${V4}/${parent}/reviews?${params}`, { scope: "location" }))!;
  return {
    reviews: Array.isArray(json.reviews) ? json.reviews : [],
    averageRating: typeof json.averageRating === "number" ? json.averageRating : null,
    totalReviewCount: typeof json.totalReviewCount === "number" ? json.totalReviewCount : null,
    nextPageToken: typeof json.nextPageToken === "string" && json.nextPageToken ? json.nextPageToken : null,
  };
}

/** One review by its name, to tell whether one a full pass didn't see is really gone (a 404). */
export async function getReview(env: Env, admin: Db, companyId: string, name: string): Promise<GoogleReview> {
  return (await gbp(env, admin, companyId, `${V4}/${name}`, { scope: "location" }))! as GoogleReview;
}

/** Posts or replaces the reply to a review, publicly. Google answers with the reply as it keeps it. */
export async function putReply(env: Env, admin: Db, companyId: string, name: string, comment: string): Promise<{ comment: string; updateTime: string | null }> {
  const json = await gbp(env, admin, companyId, `${V4}/${name}/reply`, { method: "PUT", body: { comment }, scope: "location" });
  return { comment: typeof json?.comment === "string" ? json.comment : comment, updateTime: typeof json?.updateTime === "string" ? json.updateTime : null };
}

export async function deleteReply(env: Env, admin: Db, companyId: string, name: string): Promise<void> {
  await gbp(env, admin, companyId, `${V4}/${name}/reply`, { method: "DELETE", scope: "location" });
}

/**
 * What a fresh sign-in can reach: its accounts and locations, or the problem in the way (Google's
 * approval, most often). Never throws for Google's answer, so connecting still finishes.
 */
export async function describeGoogleBusiness(env: Env, admin: Db, companyId: string, token: string): Promise<{ accounts: GoogleAccount[] | null; problem: GoogleBusinessError | null }> {
  try {
    return { accounts: await listAccountsAndLocations(env, admin, companyId, token), problem: null };
  } catch (error) {
    if (error instanceof GoogleBusinessError) return { accounts: null, problem: error };
    return { accounts: null, problem: new GoogleBusinessError("error", 0, error instanceof Error ? error.message : String(error)) };
  }
}
