/**
 * Marketing → Social's data (apps/api/src/routes/social.ts) and the words its screens use, kept
 * apart from the screens so they can be tested: which networks a post can choose and why not, when a
 * post goes or went, and each network's line, in the StatusPill glossary's words.
 */
import { autoPostWhen, missingPermissionWords, NETWORK_NAMES, networkWords, type Network } from "@crewtavo/core/social";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { statusText } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { useSession } from "@/lib/session";

export type Source = "photos" | "review" | "text";

export interface SocialState {
  marketing_on: boolean;
  can_connect: boolean;
  ai: boolean;
  /** Meta and Google can fetch pictures from this server: off on a private address, where only words alone post. */
  images_public: boolean;
  networks: {
    /** `missing`: permissions it posts with that Meta wasn't given. */
    facebook: { connected: boolean; page_name: string | null; problem: "not_connected" | "signin" | "pick" | null; live_confirmed: boolean; missing: string[] };
    instagram: { connected: boolean; username: string | null; problem: "not_connected" | "signin" | "pick" | "not_linked" | "off" | null; missing: string[]; needs_business_permissions: boolean };
    google: { ready: boolean; reason: string | null; message: string | null };
  };
  auto: { enabled: boolean; networks: Network[] };
}

export interface NetworkResult {
  network: Network;
  status: string;
  external_id: string | null;
  permalink: string | null;
  error: string | null;
  error_kind: string | null;
  attempts: number;
  next_attempt_at: string | null;
  posted_at: string | null;
}

export interface SocialPost {
  id: string;
  source: Source;
  review_id: string | null;
  attachment_ids: string[];
  caption: string;
  caption_by: string;
  networks: Network[];
  status: string;
  scheduled_for: string | null;
  automatic: boolean;
  note: string | null;
  started_at: string | null;
  finished_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  created_by: string | null;
  results: NetworkResult[];
  /** The first photo's path, and its link, signed here. */
  thumb_path: string | null;
  thumb: string | null;
  /** A review's post: who wrote it ("Ana S.", or null for "A Google user"), its stars and its first words. */
  review: { name: string | null; rating: number | null; words: string } | null;
}

export interface SharePhoto {
  id: string;
  path: string;
  created_at: string;
  job_id: string | null;
  job_number: number | null;
  job_title: string | null;
  visit_on: string | null;
  client_ref: string;
  url: string | null;
}

/** A photo a post picked, as GET /social/photos/picked says it is now. */
export interface PickedPhoto {
  id: string;
  path: string | null;
  url: string | null;
  /** Why it can't be posted anymore, when it can't. */
  problem: PickedProblem | null;
}
export type PickedProblem = "not_shared" | "client_opt_out" | "format" | "no_client" | "gone";

const PICKED_WORDS: Record<PickedProblem, string> = {
  not_shared: "not marked OK to share anymore",
  client_opt_out: "the client asked us not to post photos of their property",
  format: "only JPEG and PNG photos can be posted",
  no_client: "not on a job, visit or client anymore",
  gone: "not here anymore",
};

/** Why photos a post had picked were taken out: "1 photo was taken out: not marked OK to share anymore." */
export function pickedNote(problems: readonly PickedProblem[]): string | null {
  if (!problems.length) return null;
  const kinds = [...new Set(problems)];
  const why = kinds.length === 1 ? PICKED_WORDS[kinds[0]!] : "they can't be posted anymore";
  return `${problems.length === 1 ? "1 photo was" : `${problems.length} photos were`} taken out: ${why}.`;
}

/** "Oct 30": the day of a photo's visit as written (a date, never moved by a time zone), or the day it was added in the company's time zone. */
export function photoDay(photo: Pick<SharePhoto, "visit_on" | "created_at">, timeZone: string): string {
  if (photo.visit_on) return new Date(`${photo.visit_on.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return new Date(photo.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

export interface ShareReview {
  id: string;
  rating: number;
  name: string | null;
  posted_at: string;
  comment: string | null;
  card_ok: boolean;
  /** The card leaves the review's emoji out: its font has none. */
  card_drops_emoji: boolean;
  mentions_client: boolean;
  posted_on: string | null;
}

export const socialKey = (companyId: string) => ["social", companyId] as const;

/**
 * Links for photos, signed here: the server sends paths, since the address it reaches Storage by
 * (127.0.0.1 on a self-hosted server) isn't one the browser can open.
 */
export async function withLinks<T>(rows: T[], pathOf: (row: T) => string | null): Promise<Array<T & { url: string | null }>> {
  const paths = rows.map(pathOf).filter((p): p is string => Boolean(p));
  const urls = await signedUrls(paths).catch(() => ({}) as Record<string, string>);
  return rows.map((row) => {
    const path = pathOf(row);
    return { ...row, url: path ? (urls[path] ?? null) : null };
  });
}

/** Where posts can go and automatic posts, as GET /social says. */
export function useSocialState() {
  const session = useSession();
  return useQuery({ queryKey: socialKey(session.company.id), queryFn: () => api.get<SocialState>("/social") });
}

/** Where the next page of posts starts: after the last one's times (its scheduled time too, for posts still to go). */
export function postsPage(list: "upcoming" | "done", after: { at: string; id: string; for: string | null } | null): string {
  const params = new URLSearchParams({ list });
  if (after) {
    params.set("before_at", after.at);
    params.set("before_id", after.id);
    if (list === "upcoming" && after.for) params.set("before_for", after.for);
  }
  return `/social/posts?${params}`;
}

/**
 * Whether a post that was posting has finished (or gone): it's no longer posting in the first page
 * of posts still to go, where posting ones come first. Then it's in the other list, read again.
 */
export function finishedPosting(before: ReadonlyArray<Pick<SocialPost, "id" | "status">>, firstPage: ReadonlyArray<Pick<SocialPost, "id" | "status">>): boolean {
  const now = new Map(firstPage.map((p) => [p.id, p.status]));
  return before.some((p) => p.status === "posting" && now.get(p.id) !== "posting");
}

type PostsPage = { posts: SocialPost[]; more: boolean };

/**
 * Posts still to go (posting and scheduled in the order they go, then drafts) or done, 25 at a time,
 * checked every 5 seconds while one is posting. A post that finishes moves to Posts: when the list
 * still to go sees one leave posting, Posts (and where things stand) are read again, so it shows
 * there without a reload.
 */
export function useSocialPosts(list: "upcoming" | "done") {
  const session = useSession();
  const queryClient = useQueryClient();
  const key = [...socialKey(session.company.id), "posts", list];
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as { at: string; id: string; for: string | null } | null,
    queryFn: async ({ pageParam }) => {
      const page = await api.get<{ posts: Array<Omit<SocialPost, "thumb">>; more: boolean }>(postsPage(list, pageParam));
      const posts = (await withLinks(page.posts, (p) => p.thumb_path)).map(({ url, ...post }) => ({ ...post, thumb: url }));
      if (list === "upcoming" && pageParam === null) {
        const before = queryClient.getQueryData<InfiniteData<PostsPage>>(key)?.pages.flatMap((p) => p.posts) ?? [];
        if (finishedPosting(before, posts)) {
          void queryClient.invalidateQueries({ queryKey: [...socialKey(session.company.id), "posts", "done"] });
          void queryClient.invalidateQueries({ queryKey: socialKey(session.company.id), exact: true });
        }
      }
      return { ...page, posts };
    },
    getNextPageParam: (last) => {
      const end = last.posts.at(-1);
      return last.more && end ? { at: end.created_at, id: end.id, for: end.scheduled_for } : undefined;
    },
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.posts.some((post) => post.status === "posting")) ? 5000 : false),
  });
}

export interface Choice {
  network: Network;
  label: string;
  enabled: boolean;
  /** Why it can't be chosen, when it can't. */
  reason: string | null;
}

/** Each network a post can choose, and why one can't be. Instagram needs a picture. */
export function networkChoices(state: SocialState, source: Source): Choice[] {
  const { facebook, instagram, google } = state.networks;
  const metaReason = facebook.problem === "signin" ? "Reconnect Facebook & Instagram in Apps." : facebook.problem === "pick" ? "Pick your Page in Apps." : "Facebook & Instagram isn't connected.";
  const facebookReason = !facebook.connected ? metaReason : facebook.missing.length ? missingPermissionWords("facebook", facebook.missing) : null;
  const instagramReason = source === "text"
    ? "Instagram needs a photo."
    : instagram.connected ? (instagram.missing.length ? missingPermissionWords("instagram", instagram.missing) : null)
    : instagram.problem === "not_linked" ? "Your Instagram account isn't linked to your Page."
    : instagram.problem === "off" ? "Instagram is off for your Page in Apps."
    : metaReason;
  return [
    { network: "facebook", label: NETWORK_NAMES.facebook, enabled: !facebookReason, reason: facebookReason },
    { network: "instagram", label: NETWORK_NAMES.instagram, enabled: !instagramReason, reason: instagramReason },
    { network: "google", label: NETWORK_NAMES.google, enabled: google.ready, reason: google.ready ? null : (google.message ?? "Google Business Profile isn't connected.") },
  ];
}

const dateWords = (at: Date, timeZone: string) => at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });

/** "Posts Nov 2 at 10 AM", "Posted Nov 1", "Not scheduled": in the company's time zone, as an automatic post's notification says it. */
export function whenWords(post: Pick<SocialPost, "status" | "scheduled_for" | "finished_at" | "cancelled_at" | "created_at">, timeZone: string, now = new Date()): string {
  if (post.status === "draft") return "Not scheduled";
  if (post.status === "posting") return "Posting now";
  if (post.status === "scheduled" && post.scheduled_for) return `Posts ${autoPostWhen(new Date(post.scheduled_for), timeZone, now)}`;
  const at = new Date(post.cancelled_at ?? post.finished_at ?? post.scheduled_for ?? post.created_at);
  if (post.status === "cancelled") return `Cancelled ${dateWords(at, timeZone)}`;
  if (post.status === "posted" || post.status === "partly_posted") return `Posted ${dateWords(at, timeZone)}`;
  return `Tried ${dateWords(at, timeZone)}`;
}

/** What a post is, in a few words: a review's by who wrote it, so automatic posts with the same caption are told apart. */
export function sourceWords(post: Pick<SocialPost, "source" | "attachment_ids"> & { review?: SocialPost["review"] }): string {
  if (post.source === "review") return post.review ? `Review from ${post.review.name ?? "a Google user"}` : "A Google review";
  if (post.source === "text") return "Words alone";
  const n = post.attachment_ids.length;
  return n === 1 ? "1 photo" : `${n} photos`;
}

/** A post's status and where it goes, in the glossary's words. */
export function postSummary(post: Pick<SocialPost, "status" | "networks">): { label: string; networks: string } {
  return { label: statusText("post", post.status), networks: networkWords(post.networks) };
}

/** Where to look for a post that may have gone, and the button that says it's there. */
export const CHECK_WORDS: Record<Network, { look: string; there: string }> = {
  facebook: { look: "May have posted. Check your Page.", there: "It's on the Page" },
  instagram: { look: "May have posted. Check your Instagram account.", there: "It's on Instagram" },
  google: { look: "May have posted. Check your Business Profile.", there: "It's on the profile" },
};

/** One network's line on a post: its pill and what to say. */
export function networkLine(n: Pick<NetworkResult, "network" | "status" | "error" | "permalink">): { label: string; text: string | null } {
  const label = statusText("network", n.status);
  const name = NETWORK_NAMES[n.network];
  if (n.status === "posted") return { label, text: n.permalink ? `View on ${name}` : `On ${name}` };
  if (n.status === "unknown") return { label, text: CHECK_WORDS[n.network].look };
  if (n.status === "failed" || n.status === "skipped" || n.status === "retry") return { label, text: n.error };
  return { label, text: null };
}

/** The last networks this person chose, remembered on this device. */
const CHOICE_KEY = "crewtavo.social.networks";
export function rememberedNetworks(): Network[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "null");
    return Array.isArray(value) ? value.filter((n): n is Network => n === "facebook" || n === "instagram" || n === "google") : null;
  } catch {
    return null;
  }
}
export function rememberNetworks(networks: readonly Network[]) {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(networks));
  } catch {
    // Private mode: it starts with every connected network next time.
  }
}

/**
 * The networks a new post starts with: the last chosen that can be, or else every one that can.
 * `choices` are a photo post's, so Instagram, which only words alone can't have, is kept when it
 * was chosen (effectiveNetworks leaves it off a words-alone post).
 */
export function startingNetworks(choices: readonly Choice[], remembered: readonly Network[] | null): Network[] {
  const open = choices.filter((c) => c.enabled).map((c) => c.network);
  const kept = remembered?.filter((n) => open.includes(n)) ?? [];
  return kept.length ? kept : open;
}

/**
 * Where a post goes: what the person ticked (`wanted`, which is remembered) that this kind of post
 * can go to. Switching to Just text leaves Instagram off, and back to Photos puts it back: the person
 * never chose to leave it off.
 */
export function effectiveNetworks(wanted: readonly Network[], choices: readonly Choice[]): Network[] {
  return wanted.filter((n) => choices.find((c) => c.network === n)?.enabled);
}

/**
 * Post now's confirm: where it posts publicly, and, until the Meta app is Live, that Facebook and
 * Instagram keep it hidden from the public, where only people with a role on the business's Meta app
 * see it (not "only you": office staff posting aren't usually on it).
 */
export function postNowWords(networks: readonly Network[], notLive: boolean): string {
  if (!notLive) return `This posts publicly on ${networkWords(networks)}.`;
  const meta = networks.filter((n) => n !== "google");
  const hidden = "it stays hidden from the public until your Meta app is Live: only people with a role on your Meta app can see it.";
  if (!networks.includes("google")) return `This posts to ${networkWords(meta)}, where ${hidden}`;
  return meta.length ? `This posts publicly on ${networkWords(["google"])}. On ${networkWords(meta)} ${hidden}` : `This posts publicly on ${networkWords(["google"])}.`;
}
