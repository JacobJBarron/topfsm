/**
 * Marketing → Reviews' Google reviews (GoogleReviews.tsx), the parts worked out rather than drawn:
 * what GET /api/reviews/google says, when the numbers show, the list's filters and the query they
 * make, the words for what's in the way (who can do what about it differs: office staff can't open
 * Apps), how far the first sync has got, who replied, and the clients to suggest for a review. The
 * app page (apps/GoogleBusinessPanel.tsx) shares some.
 */
import { phoneDisplay } from "@crewtavo/core/phone";
import { nameMatch, SIGNIN_MESSAGE, type ReviewProblem } from "@crewtavo/core/reviews";
import { ApiError } from "@/lib/errors";
import { formatTime, timeAgo } from "@/lib/format";

export interface GoogleState {
  state: "not_connected" | "disconnected" | ReviewProblem | "ok";
  marketing_on: boolean;
  /** Owners and admins who connect apps: they can fix things in Apps. */
  can_connect: boolean;
  /** This server, or the company's own Google app, can sign in to Google. */
  available: boolean;
  location: { id: string; title: string | null; address: string | null; maps_uri: string | null } | null;
  problem_detail: string | null;
  problem_message: string | null;
  next_sync_at: string | null;
  last_synced_at: string | null;
  first_synced_at: string | null;
  syncing: boolean;
  progress: { seen: number; total: number | null } | null;
  google: { average_rating: number | null; total_reviews: number | null };
  /** Reviews here and still on Google. */
  reviews: number;
  review_link: { current: string | null; suggested: string | null };
  own_app: boolean;
  project_number: string | null;
}

/** Signed in (or once was, with reviews kept): the tab shows the reviews. */
export const hasReviews = (g: GoogleState | undefined) => Boolean(g && g.state !== "not_connected");

/**
 * The numbers across the top, once there's something to count: the first sync done, Google's own
 * count heard, or reviews here. Waiting on Google's approval they'd say 0, whatever is on Google.
 */
export const hasNumbers = (g: GoogleState | undefined) => Boolean(hasReviews(g) && (g!.first_synced_at || g!.google.total_reviews !== null || g!.reviews > 0));

/** Google hasn't approved access yet, or its APIs aren't on: nothing comes in, and nothing posts. */
export const waitingOnGoogle = (g: Pick<GoogleState, "state">) => g.state === "approval" || g.state === "not_enabled";

/**
 * Replies (and Suggest a reply) go through the sign-in to Google: not while it's disconnected, needs
 * reconnecting or Google isn't letting Crewtavo in yet.
 */
export const canReply = (g: Pick<GoogleState, "state">) => g.state !== "disconnected" && g.state !== "signin" && !waitingOnGoogle(g);

/** Sync now, when asking Google again could bring something in: signed in, and Google letting Crewtavo in. */
export const canSync = (g: Pick<GoogleState, "state">) => canReply(g);

/**
 * The review list, once there's something to list or reviews are on their way: not while it waits on
 * Google's approval with none here, when there'd be nothing to filter.
 */
export const showsList = (g: GoogleState | undefined) =>
  Boolean(hasReviews(g) && (g!.reviews > 0 || g!.first_synced_at || g!.progress || g!.state === "ok"));

/**
 * Sync now turned away because Google was asked a moment ago: news, not an error, so it's a toast
 * rather than the red line under the heading.
 */
export const tooSoon = (error: unknown) => error instanceof ApiError && error.status === 429;

/** What the Reviews count says under it: unmatched reviews, or where the count is from. */
export function countHint(g: Pick<GoogleState, "google">, unmatched: number): string {
  if (unmatched) return `${unmatched.toLocaleString("en-US")} not matched to a client`;
  return g.google.total_reviews !== null ? "On Google" : "Brought in from Google";
}

export interface ReviewFilters {
  needsReply: boolean;
  stars: number | null;
  matched: "all" | "matched" | "unmatched";
  /** One client's reviews (?client= from their page). */
  client: string | null;
}
export const NO_FILTERS: ReviewFilters = { needsReply: false, stars: null, matched: "all", client: null };
export const filtersOn = (f: ReviewFilters) => f.needsReply || f.stars !== null || f.matched !== "all" || f.client !== null;

interface Filterable<T> {
  eq(column: string, value: string | number): T;
  is(column: string, value: null): T;
  not(column: string, operator: string, value: null): T;
}

/** The review list's query with the filters on it, through row-level security. */
export function filterReviews<T extends Filterable<T>>(query: T, f: ReviewFilters): T {
  let q = query;
  if (f.needsReply) q = q.is("reply_comment", null);
  if (f.stars !== null) q = q.eq("rating", f.stars);
  if (f.matched === "matched") q = q.not("client_id", "is", null);
  if (f.matched === "unmatched") q = q.is("client_id", null);
  if (f.client) q = q.eq("client_id", f.client);
  return q;
}

export interface ProblemCopy {
  tone: "warning" | "danger" | "info";
  title: string;
  body: string;
  /** For owners and admins who connect apps: the words of a link to Apps → Google Business Profile. */
  link: string | null;
}

/**
 * What the tab says about what's in the way: what it is, and what to do, worded for who's looking.
 * Owners and admins who connect apps are told the steps, with a link to them; everyone else, that
 * someone who can is.
 */
export function problemCopy(g: GoogleState, timeZone: string): ProblemCopy | null {
  const message = g.problem_message ?? "";
  const admin = g.can_connect;
  const link = (words: string) => (admin ? words : null);
  switch (g.state) {
    case "approval":
      return {
        tone: "warning",
        title: message,
        body: admin
          ? `Whoever owns ${g.own_app ? "your Google app's" : "this server's"} Google Cloud project asks Google for access with Google's form, using an email that manages your Business Profile. The profile needs to have been verified for 60 days or more, and Google takes about 2 weeks. Review asks keep working meanwhile, and Crewtavo checks again every 6 hours.`
          : "Review asks keep working meanwhile. An owner or admin can request access in Apps.",
        link: link("Open in Apps"),
      };
    case "not_enabled":
      return {
        tone: "warning",
        title: message,
        body: admin
          ? "Turn on the My Business Account Management, Business Information and Google My Business APIs in the Google Cloud project, then Check again in Apps."
          : "Review asks keep working meanwhile. An owner or admin can fix this in Apps.",
        link: link("Open in Apps"),
      };
    case "signin":
      return { tone: "danger", title: SIGNIN_MESSAGE.split(".")[0] + ".", body: admin ? "Reconnect it in Apps to keep bringing reviews in." : "An owner or admin can reconnect it in Apps.", link: link("Open in Apps") };
    case "pick":
      // A Google account that manages no Business Profile has nothing to pick: another one signs in.
      if (g.problem_detail === "none") {
        return {
          tone: "warning",
          title: message || "The Google account signed in doesn't manage a Business Profile.",
          body: admin ? "Sign in with the Google account that manages it, in Apps → Google Business Profile." : "An owner or admin can sign in with the Google account that manages it, in Apps.",
          link: link("Open in Apps"),
        };
      }
      return { tone: "info", title: message || "Pick the location whose reviews come in.", body: admin ? "Pick it in Apps → Google Business Profile." : "An owner or admin can pick it in Apps.", link: link("Open in Apps") };
    case "location":
      return { tone: "warning", title: message, body: admin ? "" : "An owner or admin can fix this in Apps.", link: link("Open in Apps") };
    case "error":
      return { tone: "warning", title: message, body: g.next_sync_at ? `Crewtavo tries again at ${formatTime(g.next_sync_at, timeZone)}.` : "Crewtavo tries again soon.", link: null };
    case "disconnected":
      return {
        tone: "info",
        title: "Google Business Profile is disconnected, so new reviews don't come in.",
        body: `The reviews already here stay, and keep their clients from being asked again.${admin ? "" : " Ask an owner or admin to connect it in Apps."}`,
        link: link("Connect Google Business Profile"),
      };
    default:
      return null;
  }
}

/**
 * "Bringing in your reviews: 250 of 1,240", or "…: 250 so far" if Google hasn't said how many. Before
 * the first page is in there's nothing to count yet: "Bringing in your reviews", or "Bringing in your
 * 1,240 reviews" when Google's count is known from before, never "0 so far".
 */
export function progressWords(progress: GoogleState["progress"]): string | null {
  if (!progress) return null;
  const total = progress.total ? progress.total.toLocaleString("en-US") : null;
  if (!progress.seen) return total ? `Bringing in your ${total} ${progress.total === 1 ? "review" : "reviews"}` : "Bringing in your reviews";
  const seen = progress.seen.toLocaleString("en-US");
  return total ? `Bringing in your reviews: ${seen} of ${total}` : `Bringing in your reviews: ${seen} so far`;
}

/** "Location saved" on the app page, and that reviews are on their way only when they are: a verified location, with Marketing on. */
export const locationSavedWords = (res: { syncing?: boolean }) => (res.syncing ? "Location saved. Your reviews are on their way." : "Location saved.");

/** "Replied 2 days ago by Mia", or "Replied on Google 2 days ago" for a reply made in Google's own app. */
export function repliedWords(review: { reply_updated_at: string | null; replied_by: string | null }, names: ReadonlyMap<string, string>): string {
  const when = review.reply_updated_at ? timeAgo(review.reply_updated_at) : "";
  const who = review.replied_by ? names.get(review.replied_by) : null;
  if (!review.replied_by) return `Replied on Google ${when}`.trim();
  return `Replied ${when}${who ? ` by ${who}` : ""}`.trim();
}

/** "AS" for Ana Smith, for a reviewer with no photo. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return (words.length ? words.slice(0, 2).map((w) => w.charAt(0)) : ["?"]).join("").toUpperCase();
}

/** Clients to suggest for a review, best fit first: the whole name, then "Ana S.", then the rest as they came. */
export function rankSuggestions<C extends { display_name: string }>(reviewer: { name: string | null; anonymous: boolean }, clients: readonly C[]): C[] {
  const score = (c: C) => {
    const how = nameMatch(reviewer, c);
    return how === "full" ? 0 : how === "short" ? 1 : 2;
  };
  return [...clients].map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.c);
}

/** The first word of a reviewer's name, to find clients who might be them. */
export const firstNameOf = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}'-]/gu, "") ?? "";

/** A client suggested for a review, with what tells them apart from another of the same name. */
export interface SuggestedClient {
  id: string;
  display_name: string;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  properties?: ReadonlyArray<{ line1: string | null }> | null;
}

/** The line under a suggested client's name, as the client picker has it: their email, else phone, else address, else business. */
export function clientDetail(c: SuggestedClient): string | null {
  return c.email?.trim() || (c.phone?.trim() ? phoneDisplay(c.phone.trim()) : null) || c.properties?.find((p) => p.line1?.trim())?.line1?.trim() || c.company_name?.trim() || null;
}

/** Suggestions that share their name with another: picking one only selects it, so the office presses Match. */
export function sharedNames(clients: readonly SuggestedClient[]): Set<string> {
  const seen = new Map<string, number>();
  for (const c of clients) seen.set(c.display_name.trim().toLowerCase(), (seen.get(c.display_name.trim().toLowerCase()) ?? 0) + 1);
  return new Set(clients.filter((c) => (seen.get(c.display_name.trim().toLowerCase()) ?? 0) > 1).map((c) => c.id));
}

/** Change location's confirm: the reviews from the old location are removed, and asks start again for whoever they matched. */
export function changeLocationWords(count: number, from: string | null | undefined): string {
  const old = from ?? "the old location";
  return count === 1
    ? `The 1 review from ${old} is removed, and asks start again for any client it matched.`
    : `The ${count.toLocaleString("en-US")} reviews from ${old} are removed, and asks start again for any clients they matched.`;
}

/**
 * After "Last synced 2 minutes ago" on the app page: how many reviews are here, and where, for someone
 * who can open Marketing (`inMarketing`); otherwise only how many, since Marketing → Reviews isn't
 * theirs to open (or isn't there while Marketing is off).
 */
export function reviewCountWords(count: number, inMarketing: boolean): string {
  if (!count) return "";
  const n = `${count.toLocaleString("en-US")} ${count === 1 ? "review" : "reviews"}`;
  return inMarketing ? ` · ${n} in Marketing → Reviews` : ` · ${n} brought in`;
}
