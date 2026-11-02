/**
 * Google reviews in Crewtavo (docs/marketing-plan.md, phase D): the Google Business Profile app
 * brings one location's reviews into Marketing → Reviews while Marketing is installed, every 30
 * minutes (the review_sync task) or when someone presses Sync now.
 *
 * A sync holds the company's claim (claim_review_sync), so two workers never sync it at once. It goes
 * from the top, newest changes first, and stops at the first review already here unchanged. Once a
 * day, and on the first sync, a full pass goes through every review (up to 10,000), a page at a time,
 * picking up where it left off if it's cut short: it finds replies made in Google's own app and the
 * reviews deleted there, each confirmed with Google before it's marked. The database matches each
 * review to a client and tells the office of new ones (record_reviews, claim_review_notices).
 *
 * What's in the way is kept on the sync (review_syncs.problem) and the app (integrations.last_error):
 * Google's approval and the APIs not turned on are tried again every 6 hours, a sign-in or location
 * problem waits for someone, and anything else backs off from 30 minutes to 6 hours.
 */
import type { Tables } from "@crewtavo/core";
import { marketingOn, rescheduledReminder, reviewSettings } from "@crewtavo/core/marketing";
import { phoneDisplay, phoneE164 } from "@crewtavo/core/phone";
import {
  APPROVAL_MESSAGE,
  LOCATION_PROBLEMS,
  NOT_ENABLED_MESSAGE,
  OWN_APP_APPROVAL_MESSAGE,
  REPLY_MAX,
  REVIEW_STOP_NOTE,
  SIGNIN_MESSAGE,
  starRating,
  type LocationProblem,
  type ReviewProblem,
} from "@crewtavo/core/reviews";
import type { Env } from "../env";
import {
  deleteReply,
  findLocation,
  getReview,
  GoogleBusinessError,
  listAccountsAndLocations,
  listReviewsPage,
  PROJECT_SUSPENDED,
  putReply,
  type GoogleLocation,
  type GoogleReview,
  type ReviewsPage,
} from "../integrations/googleBusiness";
import { appKeysOf, loadSecret, SignInRefused } from "../integrations/tokens";
import { asJson, HttpError } from "../lib/http";
import { reportError } from "../lib/monitoring";
import { adminClient, type Db } from "../lib/supabase";
import { complete } from "./ai";

export const SYNC_EVERY_MINUTES = 30;
export const SLOW_RETRY_HOURS = 6;
/** A full pass at most this often, to catch replies made on Google and reviews deleted there. */
export const FULL_PASS_HOURS = 24;
/** A full pass brings in at most this many. */
export const MAX_REVIEWS = 10_000;
/** Pages of 50 a run may read on a full pass: the whole of MAX_REVIEWS, so a pass runs in one go when it can. */
export const PAGES_PER_RUN = 200;
const TOP_PAGES = 20;
/** Reviews a full pass didn't see, checked with Google one by one, per run. */
const DELETION_CHECKS = 25;

type Sync = Tables<"review_syncs">;
type Counts = { new: number; changed: number; same: number; deleted: number; told: number };
export type SyncOutcome =
  | { result: "synced"; counts: Counts }
  | { result: "busy" | "off" | "disconnected" | "pick" }
  | { result: "problem"; problem: ReviewProblem | "busy" };

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

/** The claim was taken from this worker (another location picked, or disconnected): it stops, and nothing's wrong. */
class SyncStopped extends Error {
  override name = "SyncStopped";
}
const dbFailure = (error: { message: string; code?: string }) => (error.code === "55000" ? new SyncStopped(error.message) : new Error(error.message));

async function readSync(admin: Db, companyId: string): Promise<Sync | null> {
  const { data, error } = await admin.from("review_syncs").select("*").eq("company_id", companyId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** A review as record_reviews takes it. */
function itemOf(review: GoogleReview) {
  return {
    review_id: review.reviewId,
    external_name: review.name,
    reviewer_name: review.reviewer?.displayName ?? null,
    reviewer_photo_url: review.reviewer?.profilePhotoUrl ?? null,
    reviewer_anonymous: Boolean(review.reviewer?.isAnonymous),
    rating: starRating(review.starRating),
    comment: review.comment ?? null,
    posted_at: review.createTime,
    google_updated_at: review.updateTime ?? review.createTime,
    reply_comment: review.reviewReply?.comment ?? null,
    reply_updated_at: review.reviewReply?.updateTime ?? null,
  };
}

/** What integrations.settings keeps for Google Business Profile: the location picked, as Google describes it. */
export interface BusinessSettings {
  account?: string;
  location?: string;
  title?: string;
  address?: string | null;
  place_id?: string | null;
  maps_uri?: string | null;
  new_review_uri?: string | null;
  /** Google's review link someone chose not to use ("Keep mine"). */
  review_link_declined?: string;
}

/** Google's review link for the location, offered when the company's own is empty or different, and wasn't turned down. */
export function reviewLinkOffer(companySettings: unknown, business: BusinessSettings) {
  const current = ((companySettings ?? {}) as { review_url?: string }).review_url ?? "";
  const google = business.new_review_uri ?? null;
  return { current: current || null, suggested: google && google !== current && business.review_link_declined !== google ? google : null };
}

/** The company signs in with its own Google app (Apps → Google Business Profile → its keys). */
async function ownApp(env: Env, admin: Db, companyId: string) {
  const secret = await loadSecret(env, admin, companyId, "google_business").catch(() => null);
  return Boolean(appKeysOf(secret?.extra).client_id);
}

/** Any other problem, a busy or broken Google included. Crewtavo tries again by itself. */
export const ERROR_MESSAGE = "Reviews couldn't be brought in from Google just now.";

/** What the app page and the Reviews tab say about a problem (integrations.last_error). */
export function problemMessage(problem: ReviewProblem, detail: string | null, own = false): string {
  switch (problem) {
    case "approval":
      return own ? OWN_APP_APPROVAL_MESSAGE : APPROVAL_MESSAGE;
    case "not_enabled":
      return own ? "The Business Profile APIs aren't turned on in your Google app's project yet." : NOT_ENABLED_MESSAGE;
    case "signin":
      return SIGNIN_MESSAGE;
    case "pick":
      return detail === "none" ? "The Google account signed in doesn't manage a Business Profile." : "Pick the location whose reviews come in.";
    case "location":
      return LOCATION_PROBLEMS[(detail as LocationProblem) ?? "gone"] ?? LOCATION_PROBLEMS.gone;
    default:
      // Google's own words (or a server error's) mean nothing to the office: they stay in problem_detail.
      return detail === PROJECT_SUSPENDED ? `Reviews couldn't be brought in: ${PROJECT_SUSPENDED}` : ERROR_MESSAGE;
  }
}

/**
 * The location picked: kept on the app (its title, address and Google's review link, read from
 * Google) and on the sync, which removes any other location's reviews (set_review_location) and
 * gives the asks they stopped their reminders back. A location Google doesn't count as verified
 * waits for that. Says how many reviews were removed.
 */
export async function chooseLocation(admin: Db, companyId: string, account: string, location: GoogleLocation): Promise<number> {
  const { data: row } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: "google_business" }).maybeSingle();
  const before = (row?.settings ?? {}) as BusinessSettings;
  const settings: BusinessSettings = {
    account,
    location: location.name,
    title: location.title,
    address: location.address,
    place_id: location.place_id,
    new_review_uri: location.new_review_uri,
    maps_uri: location.maps_uri,
    // "Keep mine" holds for the location it was said about.
    ...(before.location === location.name && before.review_link_declined ? { review_link_declined: before.review_link_declined } : {}),
  };
  const { error } = await admin.from("integrations").update({ settings: asJson(settings), account_label: location.title, last_error: null }).match({ company_id: companyId, provider: "google_business" });
  if (error) throw new Error(error.message);
  const { data: set, error: setError } = await admin.rpc("set_review_location", { p_company: companyId, p_account: account, p_location_id: location.name });
  if (setError) throw new Error(setError.message);
  if (!location.verified) {
    await admin.from("review_syncs").update({ problem: "location", problem_detail: "unverified", problem_since: new Date().toISOString(), next_sync_at: null }).eq("company_id", companyId);
    await admin.from("integrations").update({ last_error: LOCATION_PROBLEMS.unverified }).match({ company_id: companyId, provider: "google_business" });
  }
  return liftRemoved(admin, companyId, set, "removed");
}

type Accounts = Awaited<ReturnType<typeof listAccountsAndLocations>>;

/** The location in use: the one the sync keeps and the app was set to. One kept from before disconnecting isn't, until it's reached again. */
function inUse<T extends Pick<Sync, "location_id">>(sync: T | null, business: BusinessSettings): sync is T & { location_id: string } {
  return Boolean(sync?.location_id && business.location === sync.location_id);
}

/**
 * How far the first full pass has got, for a connected app while Marketing is on: only with the
 * location in use and nothing in the way (Google's approval, a location problem, a sign-in, errors
 * backing off), so a sync that's waiting doesn't say reviews are coming in. Null once it's done.
 */
export function firstSyncProgress(sync: Pick<Sync, "location_id" | "first_synced_at" | "problem" | "full_seen" | "total_reviews"> | null, business: BusinessSettings) {
  if (!sync || !inUse(sync, business) || sync.first_synced_at || sync.problem) return null;
  return { seen: sync.full_seen, total: sync.total_reviews };
}

/**
 * After a fresh sign-in, Check again or Sync now on a problem that waits for someone: whether Google
 * lets this sign-in in yet, and the location picked when there's only one (or the one picked before,
 * still there). Whatever was in the way before is cleared first, so a Reconnect starts syncing again.
 * A location kept from before disconnecting that this sign-in can't reach is a location to pick, not
 * a lost one: the person who signed in picks. `background` (the scheduled sync) tells owners and admins
 * who connect apps when a location is waiting to be picked, since nobody's looking then. Writes what's
 * in the way now and says it, with the accounts found.
 */
export async function checkAccess(env: Env, admin: Db, companyId: string, found?: { accounts: Accounts | null; problem: GoogleBusinessError | null }, options: { background?: boolean } = {}): Promise<{ accounts: Accounts | null; problem: ReviewProblem | null }> {
  const { accounts, problem } = found ?? (await listAccountsAndLocations(env, admin, companyId).then(
    (a) => ({ accounts: a, problem: null }),
    (e: unknown) => {
      if (e instanceof GoogleBusinessError) return { accounts: null, problem: e };
      throw e;
    },
  ));
  await admin.from("review_syncs").upsert({ company_id: companyId }, { onConflict: "company_id", ignoreDuplicates: true });
  // As it was, so a problem still in the way keeps when it started and how often it has failed.
  const before = await readSync(admin, companyId);
  await admin.from("review_syncs").update({ problem: null, problem_detail: null, problem_since: null, failures: 0, next_sync_at: new Date().toISOString() }).eq("company_id", companyId);
  const sync = before && { ...before, problem: null };
  if (problem) {
    const kind = await recordProblem(env, admin, companyId, null, problem, before);
    return { accounts: null, problem: kind === "busy" ? "error" : kind };
  }
  const { data: row } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: "google_business" }).maybeSingle();
  const using = inUse(sync, (row?.settings ?? {}) as BusinessSettings);
  const all = accounts!.flatMap((a) => a.locations.map((location) => ({ account: a.name, location })));
  let picked = sync?.location_id ? all.find((x) => x.location.name === sync.location_id) : undefined;
  if (!picked && !using && all.length === 1) {
    // The only one is picked by itself, unless that would remove reviews kept from another.
    const kept = sync?.location_id
      ? (await admin.from("reviews").select("id", { count: "exact", head: true }).eq("company_id", companyId).neq("location_id", all[0]!.location.name)).count
      : 0;
    if (!kept) picked = all[0];
  }
  if (picked) {
    await chooseLocation(admin, companyId, picked.account, picked.location);
    return { accounts, problem: picked.location.verified ? null : "location" };
  }
  if (using) {
    await recordProblem(env, admin, companyId, null, new GoogleBusinessError("location", 404, "gone", "gone"), sync);
    return { accounts, problem: "location" };
  }
  const detail = all.length ? null : "none";
  await admin.from("review_syncs").update({ problem: "pick", problem_detail: detail, problem_since: new Date().toISOString(), next_sync_at: null }).eq("company_id", companyId);
  await admin.from("integrations").update({ last_error: null }).match({ company_id: companyId, provider: "google_business" });
  if (options.background) {
    await admin.rpc("note_review_access", {
      p_company: companyId, p_claim: crypto.randomUUID(), p_kind: "pick",
      p_title: detail === "none" ? "Google reviews need another Google account" : "Pick the location for your Google reviews",
      p_body: detail === "none"
        ? `${problemMessage("pick", detail)} Sign in with the one that does in Apps → Google Business Profile.`
        : "Google lets Crewtavo in now. Pick the location whose reviews come in, in Apps → Google Business Profile.",
    });
  }
  return { accounts, problem: "pick" };
}

/** How many problems of this kind in a row, this one included: another kind before it starts the count again. */
export const consecutiveFailures = (sync: { problem?: string | null; failures?: number | null } | null, kind: string) => (sync?.problem === kind ? (sync.failures ?? 0) + 1 : 1);

/**
 * Writes what went wrong: on the sync (with when to try again) and the app, telling the people who
 * can fix a sign-in or a location once. `claim` keeps it to the sync this worker still holds (null
 * from a route that holds none). A busy Google is tried again quietly. Says which problem it was.
 */
async function recordProblem(env: Env, admin: Db, companyId: string, claim: string | null, error: unknown, sync: Sync | null): Promise<ReviewProblem | "busy"> {
  let kind: ReviewProblem;
  let detail: string | null = null;
  if (error instanceof GoogleBusinessError) {
    if (error.kind === "denied") {
      // Refused on the location: still listed means Google hasn't approved access; gone, it's lost.
      try {
        const still = sync?.account && sync.location_id ? await findLocation(env, admin, companyId, sync.account, sync.location_id) : null;
        kind = still ? "approval" : "location";
        detail = still ? null : "no_access";
      } catch (again) {
        const k = again instanceof GoogleBusinessError ? again.kind : "error";
        kind = k === "approval" || k === "not_enabled" || k === "signin" ? k : "approval";
      }
    } else if (error.kind === "busy") {
      await admin.from("review_syncs").update({ next_sync_at: minutes(SYNC_EVERY_MINUTES) }).eq("company_id", companyId).match(claim ? { claim } : {});
      return "busy";
    } else if (error.kind === "location") {
      kind = "location";
      detail = error.detail ?? "gone";
    } else if (error.kind === "approval" || error.kind === "not_enabled" || error.kind === "signin") {
      kind = error.kind;
    } else {
      kind = "error";
      detail = error.message.slice(0, 300);
    }
  } else if (error instanceof SignInRefused) {
    kind = "signin";
  } else {
    kind = "error";
    detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }
  // Counted over problems of the same kind in a row: waiting on Google's approval raises it every 6
  // hours, and the first ordinary error after that still tries again in 30 minutes.
  const failures = consecutiveFailures(sync, kind);
  const next = kind === "approval" || kind === "not_enabled"
    ? minutes(SLOW_RETRY_HOURS * 60)
    : kind === "error" ? minutes(Math.min(SYNC_EVERY_MINUTES * 2 ** (failures - 1), SLOW_RETRY_HOURS * 60)) : null;
  const update = admin.from("review_syncs").update({
    problem: kind, problem_detail: detail, problem_since: sync?.problem === kind ? sync.problem_since : new Date().toISOString(), failures, next_sync_at: next,
  }).eq("company_id", companyId);
  const { error: writeError } = await (claim ? update.eq("claim", claim) : update);
  if (writeError) throw new Error(writeError.message);
  const message = problemMessage(kind, detail, kind === "approval" || kind === "not_enabled" ? await ownApp(env, admin, companyId) : false);
  await admin.from("integrations").update({ last_error: message, ...(kind === "signin" ? { status: "error" } : {}) }).match({ company_id: companyId, provider: "google_business" });
  if (kind === "signin" || kind === "location") {
    await admin.rpc("note_review_access", {
      p_company: companyId, p_claim: claim ?? crypto.randomUUID(), p_kind: kind,
      p_title: kind === "signin" ? "Google sign-in expired for your reviews" : "Google reviews can't reach your location",
      p_body: message,
    });
  }
  return kind;
}

/**
 * A page of reviews recorded, counted into `counts`. Reviews missing an id or a date are left out.
 * `fetchedAt` is when Google was asked for it: a reply written here since is newer than the page's.
 */
async function recordPage(admin: Db, companyId: string, claim: string, locationId: string, reviews: GoogleReview[], counts: Counts, fetchedAt: string): Promise<string[]> {
  const items = reviews.filter((r) => r.reviewId && r.name && r.createTime).map(itemOf);
  if (!items.length) return [];
  const { data, error } = await admin.rpc("record_reviews", { p_company: companyId, p_claim: claim, p_location_id: locationId, p_reviews: items, p_fetched_at: fetchedAt });
  if (error) throw dbFailure(error);
  for (const status of data ?? []) if (status === "new" || status === "changed" || status === "same") counts[status]++;
  return data ?? [];
}

/**
 * Reviews a complete pass didn't see, asked about one by one: only Google's 404 means deleted, so a
 * review the list skipped as it shifted isn't marked, and its client isn't asked again by mistake.
 * A client a deleted review stopped gets their reminders back.
 */
async function confirmDeletions(env: Env, admin: Db, companyId: string, claim: string, locationId: string, since: string, counts: Counts): Promise<number> {
  const { data: unseen, error } = await admin
    .from("reviews")
    .select("id, external_name")
    .eq("company_id", companyId)
    .eq("location_id", locationId)
    .is("deleted_at", null)
    .lt("seen_at", since)
    .order("seen_at")
    .limit(DELETION_CHECKS);
  if (error) throw new Error(error.message);
  const gone: string[] = [];
  for (const review of unseen ?? []) {
    try {
      const asked = new Date().toISOString();
      await recordPage(admin, companyId, claim, locationId, [await getReview(env, admin, companyId, review.external_name)], counts, asked);
    } catch (problem) {
      if (problem instanceof GoogleBusinessError && problem.status === 404) gone.push(review.id);
      else break;
    }
  }
  if (!gone.length) return 0;
  const { data: marked, error: markError } = await admin.rpc("mark_deleted_reviews", { p_company: companyId, p_claim: claim, p_location_id: locationId, p_ids: gone });
  if (markError) throw dbFailure(markError);
  return liftRemoved(admin, companyId, marked, "marked");
}

/** The incremental pass, then the full pass when one is due or under way. */
async function bringIn(env: Env, admin: Db, companyId: string, claim: string, sync: Sync, pagesPerRun: number): Promise<Counts> {
  const counts: Counts = { new: 0, changed: 0, same: 0, deleted: 0, told: 0 };
  const locationId = sync.location_id!;
  const parent = `${sync.account}/${locationId}`;
  const mine = () => admin.from("review_syncs");
  const save = async (patch: Partial<Sync>) => {
    const { error } = await mine().update(patch).eq("company_id", companyId).eq("claim", claim);
    if (error) throw new Error(error.message);
  };
  // Google's own average and count, as the latest page that said them has them.
  const google = { averageRating: sync.average_rating, totalReviewCount: sync.total_reviews, heard: false };
  const heard = (got: ReviewsPage) => {
    google.averageRating = got.averageRating ?? google.averageRating;
    google.totalReviewCount = got.totalReviewCount ?? google.totalReviewCount;
    google.heard = true;
  };
  // Saved with every write of the full pass's place, the last page's too, so the first sync's
  // progress reads "250 of 1,240" (and "30 of 30" for a location whose reviews fit on one page).
  const googleCount = () => (google.heard ? { average_rating: google.averageRating, total_reviews: google.totalReviewCount } : {});
  // The office is told once the first full pass is done; until then its progress shows.
  const tellIn = async (seen: number) => {
    const total = google.totalReviewCount ?? seen;
    const average = google.averageRating;
    const title = total
      ? `Your Google reviews are in: ${total.toLocaleString("en-US")} ${total === 1 ? "review" : "reviews"}${average ? `, ${average.toFixed(1)} average` : ""}`
      : "Your Google reviews are connected";
    const { error } = await admin.rpc("note_review_access", {
      p_company: companyId, p_claim: claim, p_kind: "in", p_title: title,
      p_body: total ? "See them, and reply, in Marketing → Reviews." : "No reviews on Google yet. New ones show in Marketing → Reviews.",
    });
    if (error) throw new Error(error.message);
  };
  const fullDue = !sync.full_started_at && (!sync.full_synced_at || Date.parse(sync.full_synced_at) < Date.now() - FULL_PASS_HOURS * 3_600_000);

  // From the top, newest changes first, to the first review that's here unchanged. A full pass
  // starting now covers the top itself.
  if (!fullDue) {
    let token: string | null = null;
    for (let page = 0; page < TOP_PAGES; page++) {
      const asked = new Date().toISOString();
      const got = await listReviewsPage(env, admin, companyId, parent, token);
      heard(got);
      const statuses = await recordPage(admin, companyId, claim, locationId, got.reviews, counts, asked);
      if (statuses.includes("same") || !got.nextPageToken) break;
      token = got.nextPageToken;
    }
  }

  if (fullDue || sync.full_started_at) {
    let started = sync.full_started_at;
    let token = sync.full_page_token;
    let seen = sync.full_seen;
    const start = async () => {
      started = new Date().toISOString();
      token = null;
      seen = 0;
      await save({ full_started_at: started, full_page_token: null, full_seen: 0 });
    };
    if (!started) await start();
    let restarted = false;
    let pages = 0;
    let done = false;
    while (pages < pagesPerRun) {
      let got;
      const asked = new Date().toISOString();
      try {
        got = await listReviewsPage(env, admin, companyId, parent, token);
      } catch (error) {
        // A page token Google no longer takes (it has expired): the pass starts again, once.
        if (error instanceof GoogleBusinessError && error.kind === "token" && !restarted) {
          restarted = true;
          await start();
          continue;
        }
        throw error;
      }
      pages++;
      heard(got);
      await recordPage(admin, companyId, claim, locationId, got.reviews, counts, asked);
      seen += got.reviews.length;
      token = got.nextPageToken;
      if (!token || seen >= MAX_REVIEWS) {
        done = true;
        // Deletions only after a pass that saw everything.
        if (!token) counts.deleted = await confirmDeletions(env, admin, companyId, claim, locationId, started!, counts);
        break;
      }
      await save({ full_page_token: token, full_seen: seen, ...googleCount() });
    }
    if (done) {
      // With Google's count, before the office is told they're in: the progress shows until then.
      await save({ full_started_at: null, full_page_token: null, full_seen: seen, full_synced_at: new Date().toISOString(), ...googleCount() });
      if (!sync.first_synced_at) await tellIn(seen);
    } else {
      await save({ full_page_token: token, full_seen: seen, ...googleCount() });
    }
  } else {
    if (google.heard) await save(googleCount());
    // The first full pass ended but telling the office failed (a database blip): tell them now,
    // rather than showing its progress until tomorrow's full pass.
    if (sync.full_synced_at && !sync.first_synced_at) await tellIn(sync.full_seen);
  }
  return counts;
}

/**
 * Brings a company's reviews in, if Marketing is installed and Google Business Profile is
 * connected and nobody else is syncing it. With no location yet, it looks for one: picked when
 * there's only one. `pages` limits a full pass's pages this run (tests).
 */
export async function syncCompany(env: Env, admin: Db, companyId: string, options: { pages?: number } = {}): Promise<SyncOutcome> {
  const { data: claimed, error: claimError } = await admin.rpc("claim_review_sync", { p_company: companyId, p_hold_seconds: 600 });
  if (claimError) throw new Error(claimError.message);
  if (!claimed) return { result: "busy" };
  let claim = claimed;
  const release = async () => {
    await admin.from("review_syncs").update({ claim: null, locked_until: null }).eq("company_id", companyId).eq("claim", claim);
  };
  let sync: Sync | null = null;
  try {
    const [company, integration] = await Promise.all([
      admin.from("companies").select("settings").eq("id", companyId).maybeSingle(),
      admin.from("integrations").select("status, settings").match({ company_id: companyId, provider: "google_business" }).maybeSingle(),
    ]);
    if (company.error) throw new Error(company.error.message);
    // Uninstalled, Marketing brings nothing in. The reviews already here stay.
    if (!marketingOn(company.data?.settings as Record<string, unknown> | null)) {
      await release();
      return { result: "off" };
    }
    if (integration.data?.status !== "connected") {
      await release();
      return { result: "disconnected" };
    }
    sync = await readSync(admin, companyId);
    if (!inUse(sync, (integration.data.settings ?? {}) as BusinessSettings)) {
      // checkAccess picks the only location, or the one kept from before disconnecting when it's
      // still there (which lets go of the claim), or says what's in the way.
      await release();
      const access = await checkAccess(env, admin, companyId, undefined, { background: true });
      if (access.problem) return access.problem === "pick" ? { result: "pick" } : { result: "problem", problem: access.problem };
      const again = await admin.rpc("claim_review_sync", { p_company: companyId, p_hold_seconds: 600 });
      if (!again.data) return { result: "busy" };
      claim = again.data;
      sync = await readSync(admin, companyId);
      if (!sync?.location_id) {
        await release();
        return { result: "pick" };
      }
    }
    const counts = await bringIn(env, admin, companyId, claim, sync, options.pages ?? PAGES_PER_RUN);
    const now = new Date().toISOString();
    await admin.from("review_syncs")
      .update({ problem: null, problem_detail: null, problem_since: null, failures: 0, last_synced_at: now, next_sync_at: minutes(SYNC_EVERY_MINUTES) })
      .eq("company_id", companyId).eq("claim", claim);
    await admin.from("integrations").update({ last_error: null, last_sync_at: now }).match({ company_id: companyId, provider: "google_business" });
    await admin.rpc("note_review_access", { p_company: companyId, p_claim: claim, p_kind: "ok" });
    // Marked told and the notifications made together (claim_review_notices).
    const { data: told, error: tellError } = await admin.rpc("claim_review_notices", { p_company: companyId, p_claim: claim });
    if (tellError) throw new Error(tellError.message);
    counts.told = told ?? 0;
    await release();
    return { result: "synced", counts };
  } catch (error) {
    if (error instanceof SyncStopped) return { result: "busy" };
    try {
      const problem = await recordProblem(env, admin, companyId, claim, error, sync);
      if (problem === "error") reportError(error, { feature: "google reviews", company: companyId });
      return { result: "problem", problem };
    } finally {
      await release();
    }
  }
}

/** The review_sync task: every company that's due, one at a time. */
export async function syncDueReviews(env: Env) {
  const tally = { due: 0, synced: 0, waiting: 0, problems: 0, errors: 0 };
  const admin = adminClient(env);
  const { data, error } = await admin.rpc("review_syncs_due", { p_limit: 25 });
  if (error) throw new Error(error.message);
  const due = (data ?? []) as string[];
  tally.due = due.length;
  for (const companyId of due) {
    try {
      const outcome = await syncCompany(env, admin, companyId);
      if (outcome.result === "synced") tally.synced++;
      else if (outcome.result === "problem") tally.problems++;
      else tally.waiting++;
    } catch (failure) {
      // One company's trouble doesn't hold up the rest.
      console.error("A Google review sync didn't finish", failure);
      reportError(failure, { feature: "google reviews", company: companyId });
      tally.errors++;
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------------------------

/** A review of the company's that's still on Google, or a 404. */
export async function loadReview(admin: Db, companyId: string, id: string) {
  const { data, error } = await admin.from("reviews").select("*").eq("company_id", companyId).eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new HttpError(404, "That review isn't here. It may have been removed from Google.");
  return data;
}

type ReplyTarget = Pick<Tables<"reviews">, "id" | "external_name" | "client_id">;

/** A review Google says is gone, marked so: hidden, and a client it stopped gets their reminders back. */
async function markGone(admin: Db, companyId: string, review: ReplyTarget) {
  const { error } = await admin.from("reviews").update({ deleted_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", review.id).is("deleted_at", null);
  if (error) throw new Error(error.message);
  if (!review.client_id) return;
  const { data: client } = await admin.from("clients").select("reviewed_at").eq("company_id", companyId).eq("id", review.client_id).maybeSingle();
  if (client && !client.reviewed_at) await liftReviewStops(admin, companyId, [review.client_id]);
}

/**
 * A Google problem with a reply, as the answer. Google's 404 for a reply isn't proof the review is
 * gone (a reply deleted in Google's own app has nothing to delete), so the review itself is asked
 * about: only a review Google no longer has is marked deleted. Deleting a reply Google doesn't have
 * any more says "no_reply", and it's cleared here too.
 */
function replyProblem(env: Env, admin: Db, companyId: string, review: ReplyTarget, error: unknown, deleting?: false): Promise<never>;
function replyProblem(env: Env, admin: Db, companyId: string, review: ReplyTarget, error: unknown, deleting: true): Promise<"no_reply">;
async function replyProblem(env: Env, admin: Db, companyId: string, review: ReplyTarget, error: unknown, deleting = false): Promise<"no_reply"> {
  if (error instanceof GoogleBusinessError) {
    if (error.status === 404) {
      const again = await getReview(env, admin, companyId, review.external_name).then(() => null, (failure: unknown) => failure);
      if (!again) {
        if (deleting) return "no_reply";
        throw new HttpError(502, "Google didn't take the reply. Try again in a minute.");
      }
      if (!(again instanceof GoogleBusinessError && again.status === 404)) return replyProblem(env, admin, companyId, review, again);
      await markGone(admin, companyId, review);
      throw new HttpError(404, "This review was removed from Google.");
    }
    if (error.kind === "approval" || error.kind === "not_enabled") throw new HttpError(409, problemMessage(error.kind, null, await ownApp(env, admin, companyId)));
    if (error.kind === "signin") throw new HttpError(409, SIGNIN_MESSAGE);
    if (error.kind === "busy") throw new HttpError(429, "Google is busy right now. Try again in a minute.");
    // Refused on the location, as a sync reads it (recordProblem): still listed, Google hasn't
    // approved access; not listed, the account can't manage it anymore. Trying again won't help.
    if (error.kind === "denied") throw new HttpError(409, await deniedReply(env, admin, companyId));
    throw new HttpError(502, error.message === PROJECT_SUSPENDED ? `Google didn't take the reply: ${PROJECT_SUSPENDED}` : "Google didn't take the reply. Try again in a minute.");
  }
  throw error;
}

/** What a reply Google refused on the location says: what's in the way, as a sync would find it. */
async function deniedReply(env: Env, admin: Db, companyId: string): Promise<string> {
  const { data: sync } = await admin.from("review_syncs").select("account, location_id").eq("company_id", companyId).maybeSingle();
  try {
    const still = sync?.account && sync.location_id ? await findLocation(env, admin, companyId, sync.account, sync.location_id) : null;
    return still ? problemMessage("approval", null, await ownApp(env, admin, companyId)) : LOCATION_PROBLEMS.no_access;
  } catch (again) {
    const kind = again instanceof GoogleBusinessError ? again.kind : "error";
    if (kind === "approval" || kind === "not_enabled") return problemMessage(kind, null, await ownApp(env, admin, companyId));
    if (kind === "signin") return SIGNIN_MESSAGE;
    return LOCATION_PROBLEMS.no_access;
  }
}

/**
 * Posts (or replaces) a reply on Google, publicly, and keeps what Google kept, with when it was
 * written here: a page of reviews Google gave before then doesn't put the old reply back.
 */
export async function postReply(env: Env, admin: Db, companyId: string, id: string, comment: string, userId: string) {
  const review = await loadReview(admin, companyId, id);
  const text = comment.trim().slice(0, REPLY_MAX);
  const reply = await putReply(env, admin, companyId, review.external_name, text).catch((error: unknown) => replyProblem(env, admin, companyId, review, error));
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("reviews")
    .update({
      reply_comment: reply.comment.slice(0, REPLY_MAX), reply_updated_at: reply.updateTime ?? now, replied_by: userId,
      first_replied_at: review.first_replied_at ?? reply.updateTime ?? now, reply_written_at: now,
    })
    .eq("id", review.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Deletes a reply on Google. One Google no longer has (deleted in Google's own app) is gone already. */
export async function removeReply(env: Env, admin: Db, companyId: string, id: string) {
  const review = await loadReview(admin, companyId, id);
  if (review.reply_comment) await deleteReply(env, admin, companyId, review.external_name).catch((error: unknown) => replyProblem(env, admin, companyId, review, error, true));
  const { data, error } = await admin
    .from("reviews")
    .update({ reply_comment: null, reply_updated_at: null, replied_by: null, first_replied_at: null, reply_written_at: new Date().toISOString() })
    .eq("id", review.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * The company's phone as the app shows it, "(540) 555-0100", since it may go out in a public reply.
 * Another country's number stays as Settings has it.
 */
export function replyPhone(phone: string): string {
  const e164 = phoneE164(phone);
  return e164?.startsWith("+1") ? phoneDisplay(e164) : phone.trim();
}

/**
 * The system prompt for Suggest a reply. Never more than the review says; thanks by first name only
 * when it looks like one; the review's own language; an apology and a way to get in touch for low
 * ratings, with the company's own phone or email when Settings has them, and none made up.
 */
export function replyPrompt(company: { name: string; phone: string | null; email: string | null }): string {
  const phone = company.phone?.trim() ? replyPhone(company.phone) : null;
  const ways = [phone && `by phone at ${phone}`, company.email?.trim() && `by email at ${company.email.trim()}`].filter(Boolean).join(" or ");
  return [
    `You write ${company.name}'s public reply to a Google review of the business, a home-services company. Return only the reply, with no preamble and no quotation marks.`,
    "Thank the reviewer by their first name when their name looks like a person's first name. When it's a business name, an initial, in capitals only, or the reviewer is anonymous, greet them without a name.",
    "Never add prices, dates, promises, offers, discounts, staff names or any detail that isn't in the review.",
    "Reply in the language the review was written in. If it includes Google's translation, reply in the language of the original, not the translation.",
    ways
      ? `For a review of 1 or 2 stars, apologize briefly and invite them to get in touch ${ways}.`
      : "For a review of 1 or 2 stars, apologize briefly and invite them to get in touch. Don't make up a phone number, email or address.",
    "Keep it to 2 to 4 sentences, warm and plain, with no emoji or hashtags.",
  ].join("\n");
}

/** Drafts a reply with the company's Claude key (or the server's), as /ai/rewrite does. Nothing is posted. */
export async function suggestReply(env: Env, admin: Db, input: {
  apiKey: string | null;
  company: { name: string; phone: string | null; email: string | null };
  review: { reviewer_name: string | null; reviewer_anonymous: boolean; rating: number | null; comment: string | null };
  draft?: string;
  instruction?: string;
}): Promise<string> {
  const { review } = input;
  const reviewer = review.reviewer_anonymous || !review.reviewer_name ? "Anonymous (don't use a name)" : review.reviewer_name;
  const lines = [
    `Reviewer: ${reviewer}`,
    `Stars: ${review.rating ? `${review.rating} out of 5` : "none given"}`,
    `Review:\n${review.comment?.trim() || "(No words, just the stars.)"}`,
  ];
  if (input.draft?.trim()) lines.push(`\nTheir draft reply:\n${input.draft.trim()}\n\nRewrite it: ${input.instruction?.trim() || "make it clear, warm and professional, about the same length"}.`);
  const text = await complete(env, { apiKey: input.apiKey, system: replyPrompt(input.company), prompt: lines.join("\n"), effort: "low", maxTokens: 800 });
  return text.slice(0, REPLY_MAX);
}

// ---------------------------------------------------------------------------------------------
// Matching by hand
// ---------------------------------------------------------------------------------------------

/**
 * A client no review stops anymore ("Not this client", a match moved to someone else, their review
 * deleted on Google, or removed with its location or on disconnecting) can be asked again, so their
 * newest ask that a review stopped gets its next reminder back, as rescheduleReminders would time it.
 * Not while Marketing is uninstalled, and not for an ask from before it was last installed:
 * uninstalling stops reminders for good. Says how many asks got a reminder back.
 */
export async function liftReviewStops(admin: Db, companyId: string, clientIds: readonly string[], now = new Date()): Promise<number> {
  const clients = [...new Set(clientIds)];
  if (!clients.length) return 0;
  const { data: company, error } = await admin.from("companies").select("timezone, settings").eq("id", companyId).maybeSingle();
  if (error) throw new Error(error.message);
  const settings = (company?.settings ?? {}) as Record<string, unknown> & { marketing?: { changed_at?: string } };
  const installedAt = settings.marketing?.changed_at ? Date.parse(settings.marketing.changed_at) : null;
  const note = async (ids: string[], text: string) => {
    const { error: noteError } = await admin.from("review_requests").update({ reminder_note: text }).in("id", ids).is("next_reminder_at", null);
    if (noteError) throw new Error(noteError.message);
  };
  let lifted = 0;
  // A hundred clients a read keeps the address short.
  for (let i = 0; i < clients.length; i += 100) {
    const { data: stopped, error: readError } = await admin
      .from("review_requests")
      .select("id, client_id, sent_at, reminders_sent, last_reminder_at")
      .eq("company_id", companyId)
      .in("client_id", clients.slice(i, i + 100))
      .eq("status", "sent")
      .is("clicked_at", null)
      .is("next_reminder_at", null)
      .eq("reminder_note", REVIEW_STOP_NOTE)
      .order("sent_at", { ascending: false });
    if (readError) throw new Error(readError.message);
    const newest = new Map<string, NonNullable<typeof stopped>[number]>();
    const older: string[] = [];
    for (const ask of stopped ?? []) {
      if (newest.has(ask.client_id)) older.push(ask.id);
      else newest.set(ask.client_id, ask);
    }
    if (older.length) await note(older, "A newer ask replaced it");
    for (const ask of newest.values()) {
      if (!marketingOn(settings) || (installedAt && Date.parse(ask.sent_at) < installedAt)) {
        await note([ask.id], "Marketing was uninstalled");
        continue;
      }
      const next = rescheduledReminder(new Date(ask.sent_at), ask.reminders_sent, reviewSettings(settings).reminderDays, company?.timezone || "UTC", now, new Date(ask.last_reminder_at ?? ask.sent_at));
      const { error: updateError } = await admin
        .from("review_requests")
        .update(next ? { next_reminder_at: next.toISOString(), reminder_note: null } : { reminder_note: "No more reminders are set" })
        .eq("id", ask.id)
        .is("next_reminder_at", null);
      if (updateError) throw new Error(updateError.message);
      if (next) lifted++;
    }
  }
  return lifted;
}

export const liftReviewStop = (admin: Db, companyId: string, clientId: string, now = new Date()) => liftReviewStops(admin, companyId, [clientId], now);

/** What removing or marking reviews did: how many, and whose stop it lifted, given their reminders back. */
async function liftRemoved(admin: Db, companyId: string, result: unknown, key: "removed" | "marked"): Promise<number> {
  const out = (result ?? {}) as { removed?: number; marked?: number; lifted_clients?: string[] };
  await liftReviewStops(admin, companyId, out.lifted_clients ?? []);
  return out[key] ?? 0;
}

/**
 * Disconnecting: syncing stops, and the reviews stay (still stopping their clients' asks) unless
 * `remove`, when the asks they stopped get their reminders back. Says how many were removed.
 */
export async function endReviewSync(admin: Db, companyId: string, remove: boolean): Promise<number> {
  const { data, error } = await admin.rpc("end_review_sync", { p_company: companyId, p_remove: remove });
  if (error) throw new Error(error.message);
  return liftRemoved(admin, companyId, data, "removed");
}
