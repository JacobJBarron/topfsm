/**
 * Social posts (docs/marketing-plan.md, phase E): Marketing → Social posts photos OK to share, a
 * 4 or 5-star Google review as a card (lib/reviewCard.ts), or words alone, to the business's own
 * Facebook Page and Instagram account (integrations/meta.ts) and Google Business Profile
 * (integrations/googleBusiness.ts), now or at a time it picks. Automatic 5-star posts are scheduled
 * by the database (private.auto_review_post) and post here like any other.
 *
 * The social task runs every minute and claims one post at a time (claim_social_posts), posting its
 * networks in turn. Each network is posted at most once: begin_social_network marks it sending just
 * before the call that can't be taken back, so a worker that stops partway leaves it "unknown" for a
 * person to check, and a timeout after sending is checked once (read only, by caption, made after the
 * send, never another post's), then "unknown". So is a server error or an unknown error from the
 * call that publishes: the post may have been made all the same. What's safe to make again
 * (Facebook's unpublished photos, Instagram's containers) is kept between tries, for the pictures it
 * was made from. Other failures wait and try again (2, 4, 8, 16, then 32 minutes), Instagram's daily
 * limit an hour at a time for up to a day.
 *
 * Meta and Google fetch the pictures from /api/public/social/<token>.jpg (routes/public.ts): made
 * when it posts, from the photos as they are then, without EXIF, and gone 7 days after it finishes.
 */
import type { Tables } from "@crewtavo/core";
import { marketingOn } from "@crewtavo/core/marketing";
import {
  brandColor,
  cardColors,
  cardSupported,
  cardText,
  FACEBOOK_POST_SCOPES,
  firstNameLastInitial,
  hasWords,
  INSTAGRAM_POST_SCOPES,
  mentionsClient,
  NETWORK_NAMES,
  NETWORKS,
  padColor,
  socialSettings,
  type Network,
} from "@crewtavo/core/social";
import type { Env } from "../env";
import { createLocalPost, GoogleBusinessError, GoogleMaySent, googleToken, recentLocalPosts } from "../integrations/googleBusiness";
import {
  CREATE_CONTENT,
  createIgCarousel,
  createIgContainer,
  facebookPermalink,
  igContainerStatus,
  igPermalink,
  igPublish,
  igPublishingLimit,
  MaySent,
  META_ADS_SCOPES,
  MetaError,
  postFacebookFeed,
  postFacebookPhoto,
  recentFacebookPosts,
  recentIgMedia,
  tokenInfo,
  uploadUnpublished,
  type MetaKeys,
  type RecentPost,
} from "../integrations/meta";
import { appKeysOf, loadSecret, type StoredSecret } from "../integrations/tokens";
import { randomId } from "../lib/crypto";
import { HttpError } from "../lib/http";
import { reportError } from "../lib/monitoring";
import { privateHost } from "../lib/publicHttp";
import { renderReviewCard, type CardInput } from "../lib/reviewCard";
import { shareJpeg, ShareImageError } from "../lib/shareImage";
import { storedFile } from "../lib/storedFile";
import { adminClient, type Db } from "../lib/supabase";
import { complete } from "./ai";
import { LOGO_MAX_BYTES, logoOf, pngSize } from "./logo";
import { storageWritesPaused } from "./storageBucket";

type Post = Tables<"social_posts">;
type NetworkRow = Tables<"social_post_networks">;
type ImageRow = Tables<"social_post_images">;
export type Claimed = { id: string; company_id: string; claim: string };

/** Times a network waits and tries again before it's failed (2, 4, 8, 16 and 32 minutes). */
export const MAX_TRIES = 5;
/** Instagram's daily limit and a container still being made wait this long at most. */
export const WAIT_HOURS = 24;
/** The largest photo read to post: anything bigger in a visit's folder didn't come from the app. */
const PHOTO_MAX_BYTES = 40_000_000;
/** A picture's link stays usable this long while a post is still going; finishing makes it 7 days. */
const IMAGE_HOLD_DAYS = 30;
/** Unpublished photos and Instagram containers are made again after this long (containers last 24 hours). */
const STEPS_FRESH_HOURS = 20;
/** Instagram's container is checked this often, for up to a minute. */
export const timing = { pollMs: 5_000, waitMs: 60_000 };

export const MARKETING_OFF_POSTS = "Marketing is off, so nothing posts. An owner or admin can install it again in Apps.";
export const SIGNIN_LOST = "Sign-in expired. Reconnect Facebook & Instagram in Apps.";
export const MAY_HAVE_POSTED = "It may have posted. Check before posting it again.";
const APP_URL_PRIVATE = "Crewtavo's address isn't public, so Meta and Google can't fetch the photos.";
/** Said before a post of pictures is scheduled, rather than when it fails. */
export const PRIVATE_ADDRESS_POSTS = "Crewtavo's address isn't public, so Meta and Google can't fetch the pictures. Save it as a draft, or use Share elsewhere.";

const minutesFromNow = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

/** Whether Meta and Google can fetch a post's pictures here: APP_URL is https, and not a private address. */
export function imagesPublic(env: Env): boolean {
  try {
    const base = env.APP_URL ? new URL(env.APP_URL) : null;
    return Boolean(base && base.protocol === "https:" && !privateHost(base));
  } catch {
    return false;
  }
}

/**
 * The permissions a network posts with that Meta wasn't given, from what sign-in recorded. None when
 * nothing was recorded, so a connection made before Crewtavo kept them isn't held up.
 */
export function metaMissing(settings: MetaSettings | null | undefined, network: "facebook" | "instagram"): string[] {
  const granted = settings?.granted;
  if (!Array.isArray(granted)) return [];
  const needed: readonly string[] = network === "facebook" ? FACEBOOK_POST_SCOPES : INSTAGRAM_POST_SCOPES;
  return needed.filter((s) => !granted.includes(s));
}

// ---------------------------------------------------------------------------------------------
// Where a post can go
// ---------------------------------------------------------------------------------------------

/** What integrations.settings keeps for Facebook & Instagram (nothing secret). */
export interface MetaSettings {
  user_id?: string;
  user_name?: string | null;
  page_id?: string;
  page_name?: string;
  page_picture?: string | null;
  ig_user_id?: string;
  ig_username?: string | null;
  /** The business portfolio the Page is in, when it's in one. */
  business_id?: string | null;
  /** Instagram on the Page, whether or not it's used. */
  page_instagram?: { id: string; username: string | null } | null;
  granted?: string[];
  declined?: string[];
  pages?: number;
  live_confirmed_at?: string | null;
  access_notice?: "signin" | "expiring";
  /** When Meta asks for a new sign-in (Unix seconds). */
  data_access_expires_at?: number | null;
  /** The 60-day sign-in ran out: the Page still posts, but changing it needs a new sign-in. */
  user_token_expired?: boolean;
}

/** The secret's extra for Meta: the app's keys, the person, the Page's token and its Instagram account. */
export type MetaExtra = Partial<Record<"client_id" | "client_secret" | "config_id" | "user_id" | "page_id" | "page_token" | "ig_user_id", string>>;

export interface MetaConnection {
  row: { status: string; settings: MetaSettings; last_error: string | null } | null;
  secret: StoredSecret | null;
  keys: MetaKeys | null;
  pageToken: string | null;
  facebook: boolean;
  instagram: boolean;
}

/**
 * Facebook & Instagram as posting sees it, the same test as private.meta_ready plus the Page's token:
 * connected, with a Page picked and its token saved (and for Instagram, its account picked too).
 */
export async function metaConnection(env: Env, admin: Db, companyId: string): Promise<MetaConnection> {
  const { data } = await admin.from("integrations").select("status, settings, last_error").match({ company_id: companyId, provider: "meta" }).maybeSingle();
  const secret = await loadSecret(env, admin, companyId, "meta").catch(() => null);
  const extra = (secret?.extra ?? {}) as MetaExtra;
  const settings = (data?.settings ?? {}) as MetaSettings;
  const keys = appKeysOf(secret?.extra);
  const facebook = data?.status === "connected" && Boolean(settings.page_id) && Boolean(extra.page_token) && extra.page_id === settings.page_id;
  return {
    row: data ? { status: data.status, settings, last_error: data.last_error } : null,
    secret,
    keys: keys.client_id ? (keys as unknown as MetaKeys) : null,
    pageToken: facebook ? extra.page_token! : null,
    facebook,
    instagram: facebook && Boolean(settings.ig_user_id) && extra.ig_user_id === settings.ig_user_id,
  };
}

export type GoogleReason = "not_connected" | "approval" | "not_enabled" | "signin" | "pick" | "location" | "error";

/**
 * Google Business Profile as posting sees it: its location in use and nothing in the way but a
 * passing error (`ready`), with what's in the way, as phase D words it, and the location's v4 name.
 */
export async function googleConnection(admin: Db, companyId: string): Promise<{ ready: boolean; reason: GoogleReason | null; parent: string | null }> {
  const [row, sync] = await Promise.all([
    admin.from("integrations").select("status, settings").match({ company_id: companyId, provider: "google_business" }).maybeSingle(),
    admin.from("review_syncs").select("account, location_id, problem").eq("company_id", companyId).maybeSingle(),
  ]);
  const status = row.data?.status;
  if (!status || status === "disconnected") return { ready: false, reason: "not_connected", parent: null };
  if (status === "error") return { ready: false, reason: "signin", parent: null };
  const s = sync.data;
  const location = (row.data?.settings as { location?: string } | null)?.location;
  if (!s?.location_id || location !== s.location_id || !s.account) return { ready: false, reason: s?.problem === "approval" || s?.problem === "not_enabled" ? s.problem : "pick", parent: null };
  const parent = `${s.account}/${s.location_id}`;
  if (s.problem && s.problem !== "error") return { ready: false, reason: s.problem as GoogleReason, parent };
  return { ready: true, reason: s.problem === "error" ? "error" : null, parent };
}

/** What stops Google from being offered or posted to, in the words "Where it posts" and posting use. */
export const GOOGLE_REASONS: Record<GoogleReason, string> = {
  not_connected: "Google Business Profile isn't connected.",
  approval: "Google Business Profile isn't approved by Google yet.",
  not_enabled: "Google Business Profile isn't approved by Google yet.",
  signin: "Reconnect Google Business Profile in Apps.",
  pick: "Pick your location in Apps.",
  location: "Pick your location in Apps.",
  error: "Google isn't answering just now. Crewtavo tries again.",
};

/** The Reviews tab's view of where posts can go, for GET /social. */
export async function socialState(env: Env, admin: Db, companyId: string) {
  const [meta, google, company] = await Promise.all([
    metaConnection(env, admin, companyId),
    googleConnection(admin, companyId),
    admin.from("companies").select("settings, timezone").eq("id", companyId).maybeSingle(),
  ]);
  const settings = meta.row?.settings ?? {};
  const signedIn = meta.row && meta.row.status !== "disconnected";
  const metaProblem = !signedIn ? "not_connected" : meta.row!.status === "error" ? "signin" : !meta.facebook ? "pick" : null;
  // Instagram needs the Page's sign-in only when its account was picked; otherwise it says what it is.
  const instagramProblem = meta.instagram ? null
    : metaProblem === "signin" && settings.ig_user_id ? "signin"
    : metaProblem && metaProblem !== "signin" ? metaProblem
    : settings.page_instagram ? "off" : "not_linked";
  const adsMissing = META_ADS_SCOPES.filter((s) => !settings.granted?.includes(s));
  return {
    marketing_on: marketingOn(company.data?.settings as Record<string, unknown> | null),
    // Meta and Google fetch pictures from this server: on a private address only words alone can post.
    images_public: imagesPublic(env),
    networks: {
      facebook: {
        connected: meta.facebook,
        page_name: signedIn && settings.page_id ? (settings.page_name ?? null) : null,
        problem: metaProblem,
        live_confirmed: Boolean(settings.live_confirmed_at),
        missing: meta.facebook ? metaMissing(settings, "facebook") : [],
      },
      instagram: {
        connected: meta.instagram,
        username: meta.instagram || instagramProblem === "signin" ? (settings.ig_username ?? null) : null,
        problem: instagramProblem,
        missing: meta.instagram ? metaMissing(settings, "instagram") : [],
        // A Page in a business portfolio: Instagram needs the ads permissions too (Meta's content publishing guide).
        needs_business_permissions: meta.instagram && Boolean(settings.business_id) && adsMissing.length > 0,
      },
      google: { ready: google.ready, reason: google.reason, message: google.reason ? GOOGLE_REASONS[google.reason] : null },
    },
    auto: socialSettings(company.data?.settings).auto,
  };
}

// ---------------------------------------------------------------------------------------------
// What a post is made of
// ---------------------------------------------------------------------------------------------

interface Photo {
  id: string;
  path: string;
  client_id: string | null;
}

interface Content {
  photos: Photo[];
  review: Tables<"reviews"> | null;
  /** Why nothing can post, for every network still to go. */
  failure?: { error: string; kind: "removed" | "image" };
}

/** Each photo's facts as they are now (social_photo_facts): only those still OK to share, of a client who hasn't said no. */
export async function photoFacts(admin: Db, companyId: string, ids: readonly string[]) {
  if (!ids.length) return [];
  const { data, error } = await admin.rpc("social_photo_facts", { p_company: companyId, p_ids: [...ids] });
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ id: string; path: string; content_type: string | null; shareable: boolean; client_id: string | null; job_id: string | null; problem: string | null }>;
}

/** The clients whose names and streets a post mustn't carry: the photos' clients and the review's matched one. */
export async function clientWords(admin: Db, companyId: string, clientIds: ReadonlyArray<string | null | undefined>) {
  const ids = [...new Set(clientIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return { names: [] as string[], addresses: [] as string[] };
  const [clients, properties] = await Promise.all([
    admin.from("clients").select("display_name, company_name, billing_address").eq("company_id", companyId).in("id", ids),
    admin.from("properties").select("line1").eq("company_id", companyId).in("client_id", ids),
  ]);
  const names = (clients.data ?? []).flatMap((c) => [c.display_name, c.company_name].filter((n): n is string => Boolean(n?.trim())));
  const billing = (clients.data ?? []).map((c) => (c.billing_address as { line1?: string } | null)?.line1).filter((l): l is string => Boolean(l?.trim()));
  return { names, addresses: [...(properties.data ?? []).map((p) => p.line1).filter(Boolean), ...billing] };
}

/**
 * A review post's review: by its row, or, when that row was removed (disconnected with the reviews
 * removed, or Change location away and back) and the review came in again, by its location and
 * review ids (review_key), linking the post to it again. Null when it isn't here.
 */
export async function postReview(admin: Db, post: Pick<Post, "id" | "company_id" | "review_id" | "review_key">): Promise<Tables<"reviews"> | null> {
  if (post.review_id) {
    const { data } = await admin.from("reviews").select("*").eq("company_id", post.company_id).eq("id", post.review_id).maybeSingle();
    if (data) return data;
  }
  const key = /^(locations\/[^/]+)\/(.+)$/.exec(post.review_key ?? "");
  if (!key) return null;
  const { data } = await admin.from("reviews").select("*").eq("company_id", post.company_id).eq("location_id", key[1]!).eq("review_id", key[2]!).maybeSingle();
  if (data && !post.review_id) await admin.from("social_posts").update({ review_id: data.id }).eq("id", post.id).is("review_id", null);
  return data ?? null;
}

/**
 * Why a review post's review isn't here, by where Google Business Profile is now: disconnected (with
 * the reviews removed), connecting it brings the review back; set to another location (Change
 * location away), that's why; still on the review's own location, only that it isn't here, since
 * telling someone already connected to connect would be wrong.
 */
export function reviewGoneWords(google: { status: string | null; location: string | null } | null, reviewKey: string | null): string {
  const gone = "The review isn't in Crewtavo anymore.";
  if (!google?.status || google.status === "disconnected") return `${gone} Connect Google Business Profile to bring it back.`;
  const from = /^(locations\/[^/]+)\//.exec(reviewKey ?? "")?.[1];
  if (from && google.location && google.location !== from) return `${gone} Google Business Profile is set to another location now.`;
  return gone;
}

/** The post's photos or review as they are now, or why it can't post anymore. */
async function loadContent(admin: Db, post: Post): Promise<Content> {
  const out: Content = { photos: [], review: null };
  if (post.source === "photos") {
    const facts = await photoFacts(admin, post.company_id, post.attachment_ids);
    out.photos = post.attachment_ids
      .map((id) => facts.find((f) => f.id === id))
      .filter((f): f is NonNullable<typeof f> => Boolean(f && f.shareable && !f.problem))
      .map((f) => ({ id: f.id, path: f.path, client_id: f.client_id }));
    if (!out.photos.length) return { ...out, failure: { error: "The photos aren't OK to share anymore.", kind: "removed" } };
    const left = post.attachment_ids.length - out.photos.length;
    if (left) await admin.from("social_posts").update({ note: `${left === 1 ? "1 photo was" : `${left} photos were`} left out: not OK to share anymore.` }).eq("id", post.id);
  }
  if (post.source === "review") {
    const data = await postReview(admin, post);
    if (!data) {
      const { data: google } = await admin.from("integrations").select("status, settings").match({ company_id: post.company_id, provider: "google_business" }).maybeSingle();
      const location = (google?.settings as { location?: string } | null)?.location ?? null;
      return { ...out, failure: { error: reviewGoneWords(google && { status: google.status, location }, post.review_key), kind: "removed" } };
    }
    if (data.deleted_at) return { ...out, failure: { error: "The review was removed from Google.", kind: "removed" } };
    if ((data.rating ?? 0) < (post.automatic ? 5 : 4)) return { ...out, failure: { error: `The review isn't ${post.automatic ? "5" : "4 or 5"} stars anymore.`, kind: "removed" } };
    if (!hasWords(data.comment) || !cardSupported(data.comment)) return { ...out, failure: { error: "This review has characters the card can't show yet.", kind: "image" } };
    out.review = data;
  }
  // Checked now, against whoever the photos and review are of now: a review is matched after it comes in.
  const words = await clientWords(admin, post.company_id, [...out.photos.map((p) => p.client_id), out.review?.client_id]);
  if (out.review && mentionsClient(out.review.comment ?? "", words).blocked.length) {
    return { ...out, failure: { error: "This review names the client or their street, so it wasn't posted.", kind: "removed" } };
  }
  if (mentionsClient(post.caption, words).blocked.length) return { ...out, failure: { error: "The caption names the client or their street, so it wasn't posted.", kind: "removed" } };
  return out;
}

/** The review card's makings: the company's name, logo and brand colour. */
export async function cardInput(admin: Db, companyId: string, review: Pick<Tables<"reviews">, "rating" | "comment" | "reviewer_name" | "reviewer_anonymous">): Promise<CardInput> {
  const { data: company } = await admin.from("companies").select("name, settings").eq("id", companyId).maybeSingle();
  const path = logoOf(company?.settings, companyId);
  const png = path ? await storedFile(admin, path, LOGO_MAX_BYTES) : null;
  const size = png && png.length > 24 ? pngSize(png) : null;
  return {
    stars: review.rating ?? 5,
    text: cardText(review.comment),
    name: review.reviewer_anonymous ? null : firstNameLastInitial(review.reviewer_name),
    business: company?.name ?? "",
    logo: png && size ? { png, width: size[0], height: size[1] } : null,
    colors: cardColors(brandColor(company?.settings)),
  };
}

// ---------------------------------------------------------------------------------------------
// The pictures, at their public links
// ---------------------------------------------------------------------------------------------

export interface PostImage {
  n: number;
  url: string;
}

/** Where Meta and Google fetch a picture. */
export const imageUrl = (env: Env, token: string) => `${(env.APP_URL ?? "").replace(/\/$/, "")}/api/public/social/${token}.jpg`;

/**
 * The post's pictures for the networks still to go, made from the photos (or the review's card) as
 * they are now: those still valid for an hour or more are used again, the rest are made with new
 * tokens. `feed` is the pictures as they are (Facebook and Google); `instagram` padded for Instagram.
 */
export async function ensureImages(env: Env, admin: Db, post: Post, content: Content, want: { feed: boolean; instagram: boolean }): Promise<{ feed: PostImage[]; instagram: PostImage[] }> {
  const { data: rows, error } = await admin.from("social_post_images").select("*").eq("post_id", post.id);
  if (error) throw new Error(error.message);
  const { data: company } = await admin.from("companies").select("settings").eq("id", post.company_id).maybeSingle();
  const pad = padColor(brandColor(company?.settings));
  const out = { feed: [] as PostImage[], instagram: [] as PostImage[] };
  const sources: Array<{ n: number; attachment: string | null; bytes: () => Promise<Uint8Array> }> = [];
  if (post.source === "review" && content.review) {
    const review = content.review;
    sources.push({ n: 0, attachment: null, bytes: async () => renderReviewCard(await cardInput(admin, post.company_id, review)) });
  }
  content.photos.forEach((photo, n) => {
    sources.push({
      n,
      attachment: photo.id,
      bytes: async () => {
        const bytes = await storedFile(admin, photo.path, PHOTO_MAX_BYTES);
        if (!bytes) throw new ShareImageError("broken", "A photo couldn't be read from storage.");
        return bytes;
      },
    });
  });
  const carousel = sources.length > 1;
  // The card is square already, so Instagram takes the same picture.
  const variants = post.source === "review" ? (want.feed || want.instagram ? (["feed"] as const) : []) : (["feed", "instagram"] as const).filter((v) => want[v]);
  const replaced = new Set<string>();
  const used = new Set<string>();
  for (const source of sources) {
    let raw: Uint8Array | null = null;
    for (const variant of variants) {
      const kept = (rows ?? []).find((r: ImageRow) => r.n === source.n && r.variant === variant);
      if (kept && kept.attachment_id === source.attachment && Date.parse(kept.expires_at) > Date.now() + 3_600_000) {
        out[variant].push({ n: source.n, url: imageUrl(env, kept.token) });
        used.add(kept.path);
        continue;
      }
      raw ??= await source.bytes();
      const made = post.source === "review"
        ? { body: raw, width: 1080, height: 1080 }
        : await shareJpeg(raw, variant === "instagram" ? { pad: carousel ? "square" : "instagram", padColor: pad } : {});
      const path = `${post.company_id}/social/${post.id}/${source.n}-${variant}.jpg`;
      const { error: upload } = await admin.storage.from("files").upload(path, made.body, { contentType: "image/jpeg", upsert: true });
      if (upload) throw new Error(`Couldn't save the picture: ${upload.message}`);
      used.add(path);
      const token = randomId(24);
      if (kept) {
        await admin.from("social_post_images").delete().eq("id", kept.id);
        replaced.add(kept.id);
      }
      const { error: insert } = await admin.from("social_post_images").insert({
        company_id: post.company_id, post_id: post.id, n: source.n, variant, attachment_id: source.attachment, path, token,
        width: made.width, height: made.height, bytes: made.body.length, expires_at: new Date(Date.now() + IMAGE_HOLD_DAYS * 86_400_000).toISOString(),
      });
      if (insert) throw new Error(insert.message);
      out[variant].push({ n: source.n, url: imageUrl(env, token) });
    }
  }
  // A photo left out since (not OK to share anymore, or its client said no) isn't served at all.
  const current = new Map(sources.map((source) => [source.n, source.attachment]));
  const stale = (rows ?? []).filter((r: ImageRow) => !replaced.has(r.id) && (!current.has(r.n) || current.get(r.n) !== r.attachment_id));
  if (stale.length) {
    const { error: gone } = await admin.from("social_post_images").delete().in("id", stale.map((r) => r.id));
    if (gone) throw new Error(gone.message);
    const files = stale.map((r) => r.path).filter((path) => !used.has(path));
    if (files.length) await admin.storage.from("files").remove(files);
  }
  if (post.source === "review") out.instagram = want.instagram ? [...out.feed] : [];
  if (!want.feed) out.feed = [];
  return out;
}

/** Pictures whose links ran out over a day ago: their files and rows go. Says how many. */
export async function tidySocialImages(admin: Db, now = new Date()): Promise<number> {
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const { data, error } = await admin.from("social_post_images").select("id, path").lt("expires_at", new Date(now.getTime() - 86_400_000).toISOString()).limit(100);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    const { error: gone } = await admin.storage.from("files").remove(data.map((r) => r.path));
    if (gone) throw new Error(gone.message);
    await admin.from("social_post_images").delete().in("id", data.map((r) => r.id));
    removed += data.length;
    if (data.length < 100) break;
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------

interface Ctx {
  env: Env;
  admin: Db;
  post: Post;
  claim: string;
  rows: Map<Network, NetworkRow>;
  meta?: MetaConnection;
  google?: Awaited<ReturnType<typeof googleConnection>>;
  /** The Page's sign-in stopped working this run: the other Meta network fails the same way. */
  signedOut?: boolean;
  /** When this run's last send began, to look for it by after a send that may have gone. */
  sentAt?: string;
}

type Ending = { status: "posted" | "retry" | "failed" | "unknown" | "skipped"; external_id?: string; permalink?: string | null; error?: string; kind?: string; retry_at?: string; steps?: Record<string, unknown> };

/** Records how a network went. A success that can't be recorded is tried once more, then left sending for the claim to mark unknown. */
async function end(ctx: Ctx, network: Network, ending: Ending): Promise<string | null> {
  const args = {
    p_post: ctx.post.id, p_claim: ctx.claim, p_network: network, p_status: ending.status, p_external_id: ending.external_id ?? null,
    p_permalink: ending.permalink ?? null, p_error: ending.error ?? null, p_kind: ending.kind ?? null, p_retry_at: ending.retry_at ?? null,
    p_steps: (ending.steps ?? null) as never,
  };
  let { data, error } = await ctx.admin.rpc("end_social_network", args as never);
  if (error && ending.status === "posted") ({ data, error } = await ctx.admin.rpc("end_social_network", args as never));
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

async function begin(ctx: Ctx, network: Network): Promise<boolean> {
  const at = new Date().toISOString();
  const { data, error } = await ctx.admin.rpc("begin_social_network", { p_post: ctx.post.id, p_claim: ctx.claim, p_network: network });
  if (error) throw new Error(error.message);
  if (data === true) ctx.sentAt = at;
  return data === true;
}

async function saveSteps(ctx: Ctx, network: Network, steps: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await ctx.admin.rpc("save_social_steps", { p_post: ctx.post.id, p_claim: ctx.claim, p_network: network, p_steps: steps as never });
  if (error) throw new Error(error.message);
  return data === true;
}

/** Waits and tries again (2, 4, 8, 16, then 32 minutes), or fails once it has waited MAX_TRIES times. */
function retryOrFail(row: NetworkRow, error: string, kind: string, steps?: Record<string, unknown>): Ending {
  if (row.tries >= MAX_TRIES) return { status: "failed", error, kind, steps };
  return { status: "retry", error, kind, retry_at: minutesFromNow(2 ** (row.tries + 1)), steps };
}

/** Waits an hour (Instagram's limit) or two minutes (a container still being made), for up to a day. */
function waitOrFail(row: NetworkRow, minutes: number, error: string, giveUp: string, kind: string, steps?: Record<string, unknown>): Ending {
  if (row.first_tried_at && Date.parse(row.first_tried_at) < Date.now() - WAIT_HOURS * 3_600_000) return { status: "failed", error: giveUp, kind, steps };
  return { status: "retry", error, kind, retry_at: minutesFromNow(minutes), steps };
}

/** The Page's sign-in stopped working: the app needs reconnecting, and owners and admins who connect apps hear once. */
async function metaSignedOut(ctx: Ctx) {
  ctx.signedOut = true;
  await ctx.admin.from("integrations").update({ status: "error", last_error: SIGNIN_LOST }).match({ company_id: ctx.post.company_id, provider: "meta" });
  await ctx.admin.rpc("note_meta_access", {
    p_company: ctx.post.company_id, p_kind: "signin", p_title: "Facebook & Instagram needs signing in again",
    p_body: "Posts to your Page and Instagram stop until someone reconnects it in Apps.",
  });
}

/** A failure from Meta or Google, as how the network ends. */
async function failureEnding(ctx: Ctx, network: Network, row: NetworkRow, error: unknown, steps?: Record<string, unknown>): Promise<Ending> {
  const name = NETWORK_NAMES[network];
  if (error instanceof MetaError) {
    switch (error.kind) {
      case "signin":
        await metaSignedOut(ctx);
        return { status: "failed", error: SIGNIN_LOST, kind: "signin" };
      case "permission": {
        const settings = ctx.meta?.row?.settings;
        const ads = network === "instagram" && settings?.business_id && META_ADS_SCOPES.some((s) => !settings.granted?.includes(s));
        if (ads) return { status: "failed", error: "Instagram needs the ads_management and ads_read permissions for a Page in a business portfolio. Reconnect with business Page permissions in Apps.", kind: "permission" };
        return { status: "failed", error: `${name} didn't allow it${error.permission ? `: the ${error.permission} permission wasn't granted` : ""}. Reconnect Facebook & Instagram in Apps.`, kind: "permission" };
      }
      case "limit":
        return waitOrFail(row, 60, "Instagram's daily limit is used up. Crewtavo tries again in an hour.", "Instagram's daily limit stayed used up for a day, so this didn't post.", "limit", steps);
      case "rate":
        return retryOrFail(row, `${name} asked Crewtavo to slow down. It tries again soon.`, "rate", steps);
      case "duplicate":
        return { status: "failed", error: "Facebook turned this down as the same as a recent post.", kind: "duplicate" };
      case "image":
        return { status: "failed", error: `${name} couldn't use the picture.`, kind: "image" };
      default:
        return error.retry ? retryOrFail(row, `${name} had a problem. Crewtavo tries again soon.`, "other", steps) : { status: "failed", error: `${name} turned it down: ${error.message}`, kind: "other" };
    }
  }
  if (error instanceof GoogleBusinessError) {
    if (error.kind === "busy" || error.kind === "error") return retryOrFail(row, "Google had a problem. Crewtavo tries again soon.", "other");
    if (error.kind === "signin") return { status: "failed", error: GOOGLE_REASONS.signin, kind: "not_connected" };
    if (error.kind === "approval" || error.kind === "not_enabled") return { status: "failed", error: GOOGLE_REASONS.approval, kind: "not_connected" };
    return { status: "failed", error: GOOGLE_REASONS.pick, kind: "not_connected" };
  }
  return retryOrFail(row, `${name} couldn't be reached. Crewtavo tries again soon.`, "other", steps);
}

/**
 * After a send that may have gone: one read-only look for it, by its caption, made since a minute
 * before the send and with as many pictures, and not another post's already. Exactly one found is
 * the post; none or more than one is "unknown", for a person.
 */
async function findSent(ctx: Ctx, network: Network, row: NetworkRow, recent: RecentPost[], media: number | null): Promise<RecentPost | null> {
  const since = (row.sending_at ? Date.parse(row.sending_at) : Date.now()) - 60_000;
  const caption = ctx.post.caption.trim();
  const fits = recent.filter((p) => p.id && p.created >= since && p.caption.trim() === caption && (media === null || p.media === media));
  if (!fits.length) return null;
  const { data: taken } = await ctx.admin.from("social_post_networks").select("external_id").eq("company_id", ctx.post.company_id).eq("network", network).in("external_id", fits.map((p) => p.id));
  const others = new Set((taken ?? []).map((t) => t.external_id));
  const left = fits.filter((p) => !others.has(p.id));
  return left.length === 1 ? left[0]! : null;
}

async function maySent(look: () => Promise<{ found: RecentPost | null }>): Promise<Ending> {
  try {
    const { found } = await look();
    if (found) return { status: "posted", external_id: found.id, permalink: found.permalink };
  } catch {
    // The look itself failed: a person checks.
  }
  return { status: "unknown", error: MAY_HAVE_POSTED };
}

const fresh = (made: unknown) => typeof made === "string" && Date.parse(made) > Date.now() - STEPS_FRESH_HOURS * 3_600_000;
/** Steps made from exactly these pictures, in this order: a photo taken out since means they're made again. */
const sameImages = (kept: unknown, images: readonly PostImage[]) =>
  Array.isArray(kept) && kept.length === images.length && images.every((image, i) => kept[i] === image.url);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function postFacebook(ctx: Ctx, row: NetworkRow, images: PostImage[]): Promise<Ending | "stop"> {
  const meta = ctx.meta!;
  const pageId = meta.row!.settings.page_id!;
  const token = meta.pageToken!;
  const caption = ctx.post.caption.trim();
  let steps = (row.steps ?? {}) as { media_fbids?: string[]; made_at?: string; images?: string[] };
  try {
    let id: string;
    if (!images.length) {
      if (!(await begin(ctx, "facebook"))) return "stop";
      id = (await postFacebookFeed(ctx.env, pageId, token, caption)).id;
    } else if (images.length === 1) {
      if (!(await begin(ctx, "facebook"))) return "stop";
      id = (await postFacebookPhoto(ctx.env, pageId, token, images[0]!.url, caption)).post_id;
    } else {
      // Unpublished photos first, kept between tries: making them again is harmless, but slow.
      if (!fresh(steps.made_at) || !sameImages(steps.images, images)) steps = { media_fbids: [], made_at: new Date().toISOString(), images: images.map((i) => i.url) };
      const ids = steps.media_fbids ?? [];
      for (let i = 0; i < images.length; i++) {
        if (ids[i]) continue;
        ids[i] = await uploadUnpublished(ctx.env, pageId, token, images[i]!.url);
        steps = { ...steps, media_fbids: ids };
        if (!(await saveSteps(ctx, "facebook", steps))) return "stop";
      }
      if (!(await begin(ctx, "facebook"))) return "stop";
      id = (await postFacebookFeed(ctx.env, pageId, token, caption, ids)).id;
    }
    return { status: "posted", external_id: id, permalink: await facebookPermalink(ctx.env, id, token), steps: {} };
  } catch (error) {
    if (error instanceof MaySent) {
      return maySent(async () => ({ found: await findSent(ctx, "facebook", { ...row, sending_at: ctx.sentAt ?? new Date().toISOString() }, await recentFacebookPosts(ctx.env, pageId, token, new Date(Date.now() - 3_600_000)), images.length) }));
    }
    return failureEnding(ctx, "facebook", row, error, steps);
  }
}

async function postInstagram(ctx: Ctx, row: NetworkRow, images: PostImage[]): Promise<Ending | "stop"> {
  const meta = ctx.meta!;
  const igId = meta.row!.settings.ig_user_id!;
  const token = meta.pageToken!;
  const caption = ctx.post.caption.trim();
  let steps = (row.steps ?? {}) as { items?: string[]; container?: string; made_at?: string; images?: string[] };
  try {
    const limit = await igPublishingLimit(ctx.env, igId, token);
    if (limit.used >= limit.total) {
      return waitOrFail(row, 60, `Instagram's daily limit of ${limit.total} posts is used up. Crewtavo tries again in an hour.`, `Instagram's daily limit of ${limit.total} posts stayed used up for a day, so this didn't post.`, "limit", steps);
    }
    // Containers hold the pictures they were made with: made from others (a photo taken out since), or too long ago, they're made again.
    if (!fresh(steps.made_at) || !sameImages(steps.images, images)) steps = { made_at: new Date().toISOString(), images: images.map((i) => i.url) };
    if (!steps.container) {
      if (images.length === 1) {
        steps = { ...steps, container: await createIgContainer(ctx.env, igId, token, { image_url: images[0]!.url, caption }) };
      } else {
        const items = steps.items ?? [];
        for (let i = 0; i < images.length; i++) {
          if (items[i]) continue;
          items[i] = await createIgContainer(ctx.env, igId, token, { image_url: images[i]!.url, is_carousel_item: true });
          steps = { ...steps, items };
          if (!(await saveSteps(ctx, "instagram", steps))) return "stop";
        }
        steps = { ...steps, container: await createIgCarousel(ctx.env, igId, token, items, caption) };
      }
      if (!(await saveSteps(ctx, "instagram", steps))) return "stop";
    }
    // Instagram fetches and checks the pictures first: wait for it, a minute at most.
    let status = await igContainerStatus(ctx.env, steps.container!, token);
    for (let waited = 0; status === "IN_PROGRESS" && waited < timing.waitMs; waited += timing.pollMs) {
      await sleep(timing.pollMs);
      status = await igContainerStatus(ctx.env, steps.container!, token);
    }
    if (status === "IN_PROGRESS") return waitOrFail(row, 2, "Instagram is still getting the photos ready. Crewtavo checks again in a couple of minutes.", "Instagram never finished getting the photos ready, so this didn't post.", "other", steps);
    if (status === "EXPIRED") return retryOrFail(row, "Instagram let the post's photos expire. Crewtavo makes them again.", "other", {});
    // A container Instagram turned down is never used again: Post again makes a new one.
    if (status === "ERROR") return { status: "failed", error: "Instagram couldn't use the photos.", kind: "image", steps: {} };
    if (status === "PUBLISHED") {
      // Instagram says it went up already (a try that heard back unclearly, or one a person sent again): it's recorded as posted, never published twice.
      if (!(await begin(ctx, "instagram"))) return "stop";
      const found = await recentIgMedia(ctx.env, igId, token)
        .then((recent) => findSent(ctx, "instagram", { ...row, sending_at: row.sending_at ?? steps.made_at ?? null }, recent, images.length))
        .catch(() => null);
      return { status: "posted", external_id: found?.id, permalink: found?.permalink ?? null, steps: {} };
    }
    if (!(await begin(ctx, "instagram"))) return "stop";
    const { id } = await igPublish(ctx.env, igId, token, steps.container!);
    return { status: "posted", external_id: id, permalink: await igPermalink(ctx.env, id, token), steps: {} };
  } catch (error) {
    if (error instanceof MaySent) {
      return maySent(async () => ({ found: await findSent(ctx, "instagram", { ...row, sending_at: ctx.sentAt ?? new Date().toISOString() }, await recentIgMedia(ctx.env, igId, token), images.length) }));
    }
    return failureEnding(ctx, "instagram", row, error, steps);
  }
}

async function postGoogle(ctx: Ctx, row: NetworkRow, images: PostImage[]): Promise<Ending | "stop"> {
  const parent = ctx.google!.parent!;
  const caption = ctx.post.caption.trim();
  let token: string | undefined;
  try {
    // The sign-in first: a refresh that goes wrong is a plain failure, before anything is sent.
    token = await googleToken(ctx.env, ctx.admin, ctx.post.company_id);
    if (!(await begin(ctx, "google"))) return "stop";
    const made = await createLocalPost(ctx.env, ctx.admin, ctx.post.company_id, parent, { summary: caption, photoUrl: images[0]?.url ?? null }, token);
    if (made.state === "REJECTED") return { status: "failed", error: "Google took this post down. Google removes posts with phone numbers.", kind: "rejected" };
    return { status: "posted", external_id: made.name, permalink: made.searchUrl };
  } catch (error) {
    if (error instanceof GoogleMaySent) {
      return maySent(async () => {
        const recent = (await recentLocalPosts(ctx.env, ctx.admin, ctx.post.company_id, parent, token)).map((p) => ({ id: p.name, caption: p.summary, created: p.createTime, permalink: p.searchUrl, media: 0 }));
        return { found: await findSent(ctx, "google", { ...row, sending_at: ctx.sentAt ?? new Date().toISOString() }, recent, null) };
      });
    }
    return failureEnding(ctx, "google", row, error);
  }
}

/** Whether a network can go now, or how it ends without trying. */
async function readiness(ctx: Ctx, network: Network): Promise<Ending | null> {
  if (network === "google") {
    ctx.google ??= await googleConnection(ctx.admin, ctx.post.company_id);
    const reason = ctx.google.reason;
    if (ctx.google.ready) return null;
    if (reason === "not_connected") return { status: "skipped", error: "Google Business Profile was disconnected.", kind: "not_connected" };
    return { status: "failed", error: GOOGLE_REASONS[reason ?? "pick"], kind: "not_connected" };
  }
  ctx.meta ??= await metaConnection(ctx.env, ctx.admin, ctx.post.company_id);
  const meta = ctx.meta;
  if (ctx.signedOut || meta.row?.status === "error") return { status: "failed", error: SIGNIN_LOST, kind: "signin" };
  if (!meta.facebook) return { status: "skipped", error: "Facebook & Instagram was disconnected.", kind: "not_connected" };
  if (network === "instagram" && !meta.instagram) return { status: "failed", error: "Your Instagram account isn't linked to the Page anymore. Link it, then pick it in Apps.", kind: "not_linked" };
  return null;
}

async function loadRows(admin: Db, postId: string): Promise<Map<Network, NetworkRow>> {
  const { data, error } = await admin.from("social_post_networks").select("*").eq("post_id", postId);
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((r) => [r.network as Network, r]));
}

/**
 * One claimed post: its photos or review checked as they are now, its pictures made, then each
 * network still to go, in turn (Facebook, Instagram, Google). Stops when the claim isn't the worker's
 * anymore, the post was cancelled or Marketing was uninstalled (begin_social_network refuses), or
 * nothing is left to send, and lets the post go after.
 */
export async function postOne(env: Env, admin: Db, claimed: Claimed): Promise<void> {
  const { data: post, error } = await admin.from("social_posts").select("*").eq("id", claimed.id).maybeSingle();
  if (error || !post) throw new Error(error?.message ?? "That post isn't here.");
  const ctx: Ctx = { env, admin, post, claim: claimed.claim, rows: await loadRows(admin, post.id) };
  const todo = NETWORKS.filter((n) => {
    const row = ctx.rows.get(n);
    return row && (row.status === "waiting" || row.status === "retry") && (!row.next_attempt_at || Date.parse(row.next_attempt_at) <= Date.now() + 1_000);
  });
  try {
    if (!todo.length) return;
    const content = await loadContent(admin, post);
    if (content.failure) {
      for (const n of todo) if ((await end(ctx, n, { status: "failed", error: content.failure.error, kind: content.failure.kind })) === null) return;
      return;
    }
    const needsImages = post.source !== "text";
    let images = { feed: [] as PostImage[], instagram: [] as PostImage[] };
    if (needsImages) {
      if (!imagesPublic(env)) {
        for (const n of todo) if ((await end(ctx, n, { status: "failed", error: APP_URL_PRIVATE, kind: "other" })) === null) return;
        return;
      }
      if (storageWritesPaused()) {
        for (const n of todo) await end(ctx, n, retryOrFail(ctx.rows.get(n)!, "Files are being moved. Crewtavo tries again in a few minutes.", "other"));
        return;
      }
      try {
        images = await ensureImages(env, admin, post, content, { feed: todo.includes("facebook") || todo.includes("google"), instagram: todo.includes("instagram") });
      } catch (failure) {
        const ending: (n: Network) => Ending = (n) => failure instanceof ShareImageError
          ? { status: "failed", error: failure.message, kind: "image" }
          : retryOrFail(ctx.rows.get(n)!, "The photos couldn't be made ready. Crewtavo tries again soon.", "other");
        for (const n of todo) if ((await end(ctx, n, ending(n))) === null) return;
        if (!(failure instanceof ShareImageError)) reportError(failure, { feature: "social posts", post: post.id });
        return;
      }
    }
    for (const network of todo) {
      const row = ctx.rows.get(network)!;
      const ready = await readiness(ctx, network);
      let ending: Ending | "stop";
      if (ready) ending = ready;
      else if (network === "facebook") ending = await postFacebook(ctx, row, images.feed);
      else if (network === "instagram") ending = await postInstagram(ctx, row, images.instagram);
      else ending = await postGoogle(ctx, row, images.feed);
      if (ending === "stop") return;
      // Anything but "posting" means nothing's left to send (a cancel may have skipped the rest).
      if ((await end(ctx, network, ending)) !== "posting") return;
    }
  } finally {
    await admin.rpc("release_social_post", { p_post: claimed.id, p_claim: claimed.claim });
  }
}

/** The social task: posts whose time has come, one claim at a time, so no claim runs out while it waits. */
export async function postDueSocial(env: Env, options: { limit?: number } = {}) {
  const admin = adminClient(env);
  const tally = { claimed: 0, errors: 0 };
  for (let i = 0; i < (options.limit ?? 10); i++) {
    const { data, error } = await admin.rpc("claim_social_posts", { p_limit: 1, p_hold_seconds: 300 });
    if (error) throw new Error(error.message);
    const claimed = ((data ?? []) as Claimed[])[0];
    if (!claimed) break;
    tally.claimed++;
    try {
      await postOne(env, admin, claimed);
    } catch (failure) {
      // One post's trouble doesn't hold up the rest.
      console.error("A social post didn't finish", failure);
      reportError(failure, { feature: "social posts", post: claimed.id });
      tally.errors++;
    }
  }
  return tally;
}

/** Post now: that post alone, claimed and posted by this request's worker. */
export async function postNow(env: Env, admin: Db, postId: string): Promise<void> {
  const { data, error } = await admin.rpc("claim_social_posts", { p_limit: 1, p_hold_seconds: 300, p_post: postId });
  if (error) throw new Error(error.message);
  const claimed = ((data ?? []) as Claimed[])[0];
  if (claimed) await postOne(env, admin, claimed).catch((failure) => reportError(failure, { feature: "social posts", post: postId }));
}

// ---------------------------------------------------------------------------------------------
// Facebook & Instagram's sign-in, checked daily
// ---------------------------------------------------------------------------------------------

/**
 * Each company's Page sign-in, read from Meta with the Page's own token: one that stopped working
 * marks the app and tells owners and admins who connect apps; one Meta asks to renew within 7 days
 * tells them once, while there's time.
 */
export async function checkMetaAccess(env: Env, admin: Db): Promise<{ checked: number; signin: number; expiring: number }> {
  const out = { checked: 0, signin: 0, expiring: 0 };
  const { data } = await admin.from("integrations").select("company_id, settings").eq("provider", "meta").eq("status", "connected");
  for (const row of data ?? []) {
    try {
      const meta = await metaConnection(env, admin, row.company_id);
      if (!meta.pageToken || !meta.keys) continue;
      out.checked++;
      const info = await tokenInfo(env, meta.keys, meta.pageToken);
      if (!info.is_valid) {
        await admin.from("integrations").update({ status: "error", last_error: SIGNIN_LOST }).match({ company_id: row.company_id, provider: "meta" });
        await admin.rpc("note_meta_access", { p_company: row.company_id, p_kind: "signin", p_title: "Facebook & Instagram needs signing in again", p_body: "Posts to your Page and Instagram stop until someone reconnects it in Apps." });
        out.signin++;
        continue;
      }
      const settings = (row.settings ?? {}) as MetaSettings;
      const expires = info.data_access_expires_at;
      if (expires && expires !== settings.data_access_expires_at) {
        await admin.from("integrations").update({ settings: { ...settings, data_access_expires_at: expires } as never }).match({ company_id: row.company_id, provider: "meta" });
      }
      if (expires && expires * 1000 < Date.now() + 7 * 86_400_000) {
        const by = new Date(expires * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const told = await admin.rpc("note_meta_access", { p_company: row.company_id, p_kind: "expiring", p_title: `Reconnect Facebook & Instagram by ${by} so posts keep going`, p_body: "Meta asks for a new sign-in every few months. Reconnect it in Apps." });
        if (told.data) out.expiring++;
      }
    } catch (failure) {
      reportError(failure, { feature: "social posts", company: row.company_id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Suggest a caption
// ---------------------------------------------------------------------------------------------

/** The system prompt for Suggest a caption and Rewrite. */
export function captionPrompt(company: string): string {
  return [
    `You write a short, friendly caption for ${company}'s own Facebook Page, Instagram account and Google Business Profile. ${company} is a home-services business (lawn care, paving, roofing and the like). Return only the caption, with no preamble and no quotation marks.`,
    "Keep it to 1 to 3 sentences. Use at most 3 hashtags, or none.",
    "Never name a client or a reviewer, and never mention an address, street, house number or town where the work was done.",
    "Never add prices, dates, offers, discounts, promises or details that weren't given to you.",
    "Write in the language the review was written in when there's a review; otherwise in English.",
  ].join("\n");
}

/**
 * A caption drafted with the company's Claude key (or the server's), as Suggest a reply does. One
 * that names a client is asked for again once; if it still does, it comes back with a warning.
 */
export async function suggestCaption(env: Env, input: {
  apiKey: string | null;
  company: string;
  source: "photos" | "review" | "text";
  review?: { rating: number | null; comment: string | null } | null;
  services?: readonly string[];
  draft?: string;
  instruction?: string;
  clients: { names: readonly string[]; addresses: readonly string[] };
}): Promise<{ text: string; warning: string | null }> {
  const lines = [`Business: ${input.company}`];
  if (input.source === "photos") lines.push(`The post shows photos of finished work${input.services?.length ? `: ${input.services.slice(0, 8).join(", ")}` : ""}.`);
  if (input.source === "review" && input.review) lines.push(`The post shows a ${input.review.rating ?? 5}-star Google review from a client:\n${cardText(input.review.comment)}`);
  if (input.source === "text") lines.push("The post is words alone, an update from the business.");
  if (input.draft?.trim()) lines.push(`\nTheir draft caption:\n${input.draft.trim()}\n\nRewrite it: ${input.instruction?.trim() || "make it clear, warm and short"}.`);
  const ask = (extra = "") => complete(env, { apiKey: input.apiKey, system: captionPrompt(input.company), prompt: lines.join("\n") + extra, effort: "low", maxTokens: 600 });
  let text = (await ask()).slice(0, 2200);
  if (mentionsClient(text, input.clients).blocked.length) {
    text = (await ask("\n\nYour last caption named the client or their street. Write it again without any name or address.")).slice(0, 2200);
    if (mentionsClient(text, input.clients).blocked.length) return { text, warning: "Check the caption: it may name the client or their street." };
  }
  return { text, warning: null };
}

/** The services on the photos' jobs, by their line items' names (never a job's title, which can hold a client's name). */
export async function jobServices(admin: Db, companyId: string, jobIds: ReadonlyArray<string | null>): Promise<string[]> {
  const ids = [...new Set(jobIds.filter((id): id is string => Boolean(id)))];
  if (!ids.length) return [];
  const { data } = await admin.from("job_line_items").select("name").eq("company_id", companyId).in("job_id", ids).limit(50);
  return [...new Set((data ?? []).map((l) => l.name.trim()).filter(Boolean))].slice(0, 8);
}

/** A page reason a person can act on, for a network's error. */
export function marketingOffError(): HttpError {
  return new HttpError(409, MARKETING_OFF_POSTS);
}

export { CREATE_CONTENT };
