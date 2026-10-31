/**
 * Facebook & Instagram through the business's own Meta app (docs/marketing-plan.md, phase E): the
 * business makes an app at developers.facebook.com with Facebook Login for Business and pastes its
 * App ID and secret on the app's page. Its admin signs in, the short-lived token is swapped for a
 * long-lived one (about 60 days), and the Page picked gives a Page token that doesn't expire, which
 * every post uses, Instagram's included (the Instagram account is the one linked to the Page).
 *
 * Meta's API can't say whether an app is Live, and posts made while it's in Development mode are
 * seen only by people with a role on the app, so the app page asks the person to confirm it.
 *
 * Calls give up after 20 seconds, 30 for the ones that publish. A send that may have reached Meta (a
 * timeout or a dropped connection after sending, or for a call that publishes, a server error or
 * Meta's "unknown error", which Meta sometimes gives for a post it made) throws MaySent, never a plain
 * failure: it's checked, not sent again (services/social.ts).
 */
import type { Env } from "../env";
import { SentButUnrecorded } from "./accounting";
import { DIALOG, GRAPH_VERSION, META_ADS_SCOPES, META_SCOPES } from "./metaConfig";
import { IntegrationError } from "./registry";

export { DIALOG, GRAPH_VERSION, META_ADS_SCOPES, META_SCOPES };
const graphBase = (env: Env) => (env.META_GRAPH_URL ?? "https://graph.facebook.com").replace(/\/$/, "");

/** The Page task a person needs to post as the Page. */
export const CREATE_CONTENT = "CREATE_CONTENT";

/**
 * What went wrong with a call to Meta:
 *   signin      the token expired, was revoked, or the person lost their role on the Page (190, 492…)
 *   permission  a permission wasn't granted (10, 200–299): `permission` names it when Meta does
 *   rate        too many calls (4, 17, 32, 341, 613, 80001…): tried again later
 *   limit       Instagram's daily publishing limit
 *   duplicate   Facebook turned the post down as a duplicate (506)
 *   image       Meta couldn't fetch or use the picture
 *   other       anything else; `retry` says whether it's worth trying again (-1, 1, 2, 368, a 5xx)
 */
export type MetaProblemKind = "signin" | "permission" | "rate" | "limit" | "duplicate" | "image" | "other";

export class MetaError extends IntegrationError {
  override name = "MetaError";
  constructor(
    readonly kind: MetaProblemKind,
    readonly status: number,
    readonly code: number | null,
    readonly subcode: number | null,
    message: string,
    readonly permission: string | null = null,
    readonly retry = false,
  ) {
    super(message);
  }
}

/** A send that may have reached Meta: never sent again by itself. */
export class MaySent extends SentButUnrecorded {
  override name = "MaySent";
}

const SIGNIN_SUBCODES = [458, 459, 460, 463, 464, 467, 492];
const RATE_CODES = [4, 17, 32, 341, 613, 80001];
const IMAGE_SUBCODES = [2207004, 2207005, 2207009, 2207026, 2207052];
const PERMISSION_NAME = /\b(pages_[a-z_]+|instagram_[a-z_]+|business_management|ads_management|ads_read|publish_to_groups)\b/;

/** Which problem Meta's error is (its error handling guide's codes). */
export function metaProblem(status: number, body: unknown): MetaError {
  const error = ((body && typeof body === "object" ? (body as { error?: unknown }).error : null) ?? {}) as Record<string, unknown>;
  const code = Number.isFinite(Number(error.code)) ? Number(error.code) : null;
  const subcode = Number.isFinite(Number(error.error_subcode)) ? Number(error.error_subcode) : null;
  const message = String(error.error_user_msg ?? error.message ?? `Meta answered ${status}`).slice(0, 300);
  const make = (kind: MetaProblemKind, retry = false, permission: string | null = null) => new MetaError(kind, status, code, subcode, message, permission, retry);
  if (code === 190 || code === 102 || (subcode !== null && SIGNIN_SUBCODES.includes(subcode))) return make("signin");
  if (subcode === 2207042) return make("limit", true);
  if (code !== null && (RATE_CODES.includes(code) || (code >= 80000 && code <= 80014))) return make("rate", true);
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return make("permission", false, PERMISSION_NAME.exec(message)?.[1] ?? null);
  if (code === 506) return make("duplicate");
  if ((subcode !== null && IMAGE_SUBCODES.includes(subcode)) || code === 324) return make("image");
  if (code === -1 || code === 1 || code === 2 || code === 368 || status >= 500 || status === 0) return make("other", true);
  return make("other");
}

const NEVER_SENT = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"];

/** An answer to a call that publishes which doesn't say it wasn't made: a server error, or Meta's unknown error. */
const unclearAnswer = (error: MetaError) => error.kind === "other" && error.retry && error.code !== 368;

interface GraphOptions {
  method?: "GET" | "POST" | "DELETE";
  token?: string;
  params?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  /** The call publishes something that can't be taken back. */
  publishes?: boolean;
}

/**
 * A call to the Graph API. POST sends its params as a form. A failure Meta answers is a MetaError;
 * a POST or DELETE that may have reached Meta and got no answer is MaySent; one that never left
 * (the address didn't resolve, the connection was refused) is a MetaError to try again. A call that
 * publishes and gets an unclear answer is MaySent too: only a definite no is tried again.
 */
export async function graph<T = Record<string, any>>(env: Env, path: string, options: GraphOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const url = new URL(`${graphBase(env)}/${GRAPH_VERSION}/${path.replace(/^\//, "")}`);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined) continue;
    if (method === "GET") url.searchParams.set(key, String(value));
    else form.set(key, String(value));
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded";
  const sends = method !== "GET";
  let response: Response;
  let json: unknown;
  try {
    response = await fetch(url, { method, headers, body: sends ? form : undefined, signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
    json = await response.json().catch((error: unknown) => {
      if (sends && error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw error;
      return {};
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } })?.cause?.code;
    if (!sends || (cause && NEVER_SENT.includes(cause))) throw new MetaError("other", 0, null, null, "Couldn't reach Meta just now.", null, true);
    throw new MaySent("Meta didn't answer, so the post may have gone.");
  }
  if (!response.ok || (json && typeof json === "object" && "error" in json)) {
    const problem = metaProblem(response.status, json);
    if (options.publishes && unclearAnswer(problem)) throw new MaySent(`Meta answered "${problem.message}", so the post may have gone.`);
    throw problem;
  }
  return json as T;
}

// ---------------------------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------------------------

/** The business's own Meta app: its App ID and secret, and a Facebook Login for Business configuration if it made one. */
export interface MetaKeys {
  client_id: string;
  client_secret: string;
  config_id?: string;
}

/**
 * Meta's sign-in page. A configuration (config_id) says what's asked for when the business made one;
 * otherwise the permissions themselves. `ads` adds the two a Page in a business portfolio needs for
 * Instagram, and `again` asks again for permissions declined before.
 */
export function metaAuthorizeUrl(keys: MetaKeys, state: string, redirect: string, options: { ads?: boolean; again?: boolean } = {}): string {
  const params = new URLSearchParams({ client_id: keys.client_id, redirect_uri: redirect, state, response_type: "code" });
  if (keys.config_id && !options.ads) params.set("config_id", keys.config_id);
  else params.set("scope", [...META_SCOPES, ...(options.ads ? META_ADS_SCOPES : [])].join(","));
  if (options.again || options.ads) params.set("auth_type", "rerequest");
  return `${DIALOG}/${GRAPH_VERSION}/dialog/oauth?${params}`;
}

/** Meta turned the App ID or secret down (the secret pasted wrong, most likely). */
export const badKeys = (error: unknown) =>
  error instanceof MetaError && (error.code === 101 || error.code === 1 || error.code === 100) && /client|secret|application|app id/i.test(error.message);

/** The sign-in's code for a short-lived user token. */
export async function exchangeMetaCode(env: Env, keys: MetaKeys, code: string, redirect: string): Promise<{ access_token: string; expires_in?: number }> {
  return graph(env, "oauth/access_token", { params: { client_id: keys.client_id, client_secret: keys.client_secret, redirect_uri: redirect, code } });
}

/** A short-lived user token for one that lasts about 60 days. An expired token can't be swapped. */
export async function longLivedToken(env: Env, keys: MetaKeys, token: string): Promise<{ access_token: string; expires_in?: number }> {
  return graph(env, "oauth/access_token", { params: { grant_type: "fb_exchange_token", client_id: keys.client_id, client_secret: keys.client_secret, fb_exchange_token: token } });
}

/**
 * Signs the business out of its app at Meta: every permission the person gave it is taken back.
 * With the app's own token (App ID and secret) and the person's id, so it still works after their
 * 60-day sign-in has run out. Best effort: the tokens are forgotten here either way.
 */
export async function revokeMeta(env: Env, keys: MetaKeys | null, userId: string | undefined): Promise<boolean> {
  if (!keys?.client_id || !keys.client_secret || !userId) return false;
  try {
    await graph(env, `${encodeURIComponent(userId)}/permissions`, { method: "DELETE", token: `${keys.client_id}|${keys.client_secret}` });
    return true;
  } catch {
    return false;
  }
}

/** Who signed in. */
export async function metaMe(env: Env, token: string): Promise<{ id: string; name: string | null }> {
  const me = await graph<{ id?: string; name?: string }>(env, "me", { token, params: { fields: "id,name" } });
  return { id: String(me.id ?? ""), name: me.name ? String(me.name).slice(0, 200) : null };
}

/** The permissions the person granted the app, and the ones they declined. */
export async function grantedPermissions(env: Env, token: string): Promise<{ granted: string[]; declined: string[] }> {
  const json = await graph<{ data?: Array<{ permission?: string; status?: string }> }>(env, "me/permissions", { token });
  const rows = Array.isArray(json.data) ? json.data : [];
  return {
    granted: rows.filter((r) => r.status === "granted").map((r) => String(r.permission)),
    declined: rows.filter((r) => r.status === "declined").map((r) => String(r.permission)),
  };
}

/** What Meta says about a token: whether it works, and when Meta asks for a new sign-in. */
export async function tokenInfo(env: Env, keys: MetaKeys, token: string): Promise<{ is_valid: boolean; expires_at: number | null; data_access_expires_at: number | null }> {
  const json = await graph<{ data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number } }>(env, "debug_token", {
    token: `${keys.client_id}|${keys.client_secret}`,
    params: { input_token: token },
  });
  const data = json.data ?? {};
  return { is_valid: data.is_valid === true, expires_at: data.expires_at || null, data_access_expires_at: data.data_access_expires_at || null };
}

export interface MetaPage {
  id: string;
  name: string;
  picture: string | null;
  access_token: string;
  tasks: string[];
  instagram: { id: string; username: string | null } | null;
  /** The business portfolio the Page is in, when it's in one. */
  business: { id: string; name: string | null } | null;
}

const httpsOnly = (value: unknown) => (typeof value === "string" && /^https:\/\/\S+$/.test(value) ? value.slice(0, 2000) : null);

function pageOf(raw: Record<string, any>): MetaPage {
  const ig = raw.instagram_business_account;
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? "").slice(0, 200) || "Your Page",
    picture: httpsOnly(raw.picture?.data?.url),
    access_token: String(raw.access_token ?? ""),
    tasks: Array.isArray(raw.tasks) ? raw.tasks.map(String) : [],
    instagram: ig?.id ? { id: String(ig.id), username: ig.username ? String(ig.username).slice(0, 100) : null } : null,
    business: raw.business?.id ? { id: String(raw.business.id), name: raw.business.name ? String(raw.business.name).slice(0, 200) : null } : null,
  };
}

/**
 * The Pages the person can manage, with their Page tokens and linked Instagram accounts, up to 200.
 * Without business_management, Pages reached through a business portfolio aren't listed, and the
 * Page's business can't be read: then it's listed without it.
 */
export async function listPages(env: Env, userToken: string): Promise<MetaPage[]> {
  const read = async (business: boolean) => {
    const fields = `id,name,access_token,tasks,picture{url},instagram_business_account{id,username}${business ? ",business{id,name}" : ""}`;
    const pages: MetaPage[] = [];
    let after: string | undefined;
    do {
      const json = await graph<{ data?: Array<Record<string, any>>; paging?: { cursors?: { after?: string }; next?: string } }>(env, "me/accounts", {
        token: userToken,
        params: { fields, limit: 100, after },
      });
      for (const raw of json.data ?? []) if (pages.length < 200) pages.push(pageOf(raw));
      after = json.paging?.next ? json.paging.cursors?.after : undefined;
    } while (after && pages.length < 200);
    return pages;
  };
  try {
    return await read(true);
  } catch (error) {
    if (error instanceof MetaError && error.kind === "permission") return read(false);
    throw error;
  }
}

/** The Page itself, with its own token: whether posting as it still works. */
export async function pageProbe(env: Env, pageId: string, pageToken: string): Promise<{ id: string; name: string | null }> {
  const json = await graph<{ id?: string; name?: string }>(env, encodeURIComponent(pageId), { token: pageToken, params: { fields: "id,name" } });
  return { id: String(json.id ?? pageId), name: json.name ? String(json.name) : null };
}

// ---------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------

const PUBLISH_TIMEOUT = 30_000;

/** One photo on the Page, published. Meta fetches it from `url`. */
export async function postFacebookPhoto(env: Env, pageId: string, pageToken: string, url: string, caption: string): Promise<{ id: string; post_id: string }> {
  const json = await graph<{ id?: string; post_id?: string }>(env, `${encodeURIComponent(pageId)}/photos`, {
    method: "POST", token: pageToken, params: { url, caption, published: true }, timeoutMs: PUBLISH_TIMEOUT, publishes: true,
  });
  return { id: String(json.id ?? ""), post_id: String(json.post_id ?? json.id ?? "") };
}

/** A photo on the Page, not published, to attach to a post of several. Safe to make again. */
export async function uploadUnpublished(env: Env, pageId: string, pageToken: string, url: string): Promise<string> {
  try {
    const json = await graph<{ id?: string }>(env, `${encodeURIComponent(pageId)}/photos`, { method: "POST", token: pageToken, params: { url, published: false }, timeoutMs: PUBLISH_TIMEOUT });
    return String(json.id ?? "");
  } catch (error) {
    // An unpublished photo nobody sees: making another is harmless.
    if (error instanceof MaySent) throw new MetaError("other", 0, null, null, "Meta didn't answer while a photo went up.", null, true);
    throw error;
  }
}

/** A post on the Page: words alone, or with photos uploaded unpublished. */
export async function postFacebookFeed(env: Env, pageId: string, pageToken: string, message: string, mediaIds: readonly string[] = []): Promise<{ id: string }> {
  const params: Record<string, string> = { message };
  mediaIds.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
  const json = await graph<{ id?: string }>(env, `${encodeURIComponent(pageId)}/feed`, { method: "POST", token: pageToken, params, timeoutMs: PUBLISH_TIMEOUT, publishes: true });
  return { id: String(json.id ?? "") };
}

/** A post's link on Facebook. */
export async function facebookPermalink(env: Env, postId: string, pageToken: string): Promise<string> {
  try {
    const json = await graph<{ permalink_url?: string }>(env, encodeURIComponent(postId), { token: pageToken, params: { fields: "permalink_url" } });
    return httpsOnly(json.permalink_url) ?? `https://www.facebook.com/${postId}`;
  } catch {
    return `https://www.facebook.com/${postId}`;
  }
}

/** An Instagram media container for a picture Instagram fetches from `image_url`. Not published, so safe to make again. */
export async function createIgContainer(env: Env, igId: string, token: string, item: { image_url: string; caption?: string; is_carousel_item?: boolean }): Promise<string> {
  try {
    const json = await graph<{ id?: string }>(env, `${encodeURIComponent(igId)}/media`, {
      method: "POST", token, params: { image_url: item.image_url, caption: item.caption, is_carousel_item: item.is_carousel_item ? true : undefined }, timeoutMs: PUBLISH_TIMEOUT,
    });
    return String(json.id ?? "");
  } catch (error) {
    if (error instanceof MaySent) throw new MetaError("other", 0, null, null, "Instagram didn't answer while a photo went up.", null, true);
    throw error;
  }
}

/** A carousel container of 2 to 10 item containers. */
export async function createIgCarousel(env: Env, igId: string, token: string, children: readonly string[], caption: string): Promise<string> {
  try {
    const json = await graph<{ id?: string }>(env, `${encodeURIComponent(igId)}/media`, {
      method: "POST", token, params: { media_type: "CAROUSEL", children: children.join(","), caption }, timeoutMs: PUBLISH_TIMEOUT,
    });
    return String(json.id ?? "");
  } catch (error) {
    if (error instanceof MaySent) throw new MetaError("other", 0, null, null, "Instagram didn't answer while the carousel was made.", null, true);
    throw error;
  }
}

/** A container's status: FINISHED, IN_PROGRESS, ERROR, EXPIRED or PUBLISHED. */
export async function igContainerStatus(env: Env, containerId: string, token: string): Promise<string> {
  const json = await graph<{ status_code?: string }>(env, encodeURIComponent(containerId), { token, params: { fields: "status_code" } });
  return String(json.status_code ?? "IN_PROGRESS");
}

/** Publishes a container: the post goes up on Instagram. */
export async function igPublish(env: Env, igId: string, token: string, creationId: string): Promise<{ id: string }> {
  const json = await graph<{ id?: string }>(env, `${encodeURIComponent(igId)}/media_publish`, { method: "POST", token, params: { creation_id: creationId }, timeoutMs: PUBLISH_TIMEOUT, publishes: true });
  return { id: String(json.id ?? "") };
}

/** A post's link on Instagram. */
export async function igPermalink(env: Env, mediaId: string, token: string): Promise<string | null> {
  try {
    const json = await graph<{ permalink?: string }>(env, encodeURIComponent(mediaId), { token, params: { fields: "permalink" } });
    return httpsOnly(json.permalink);
  } catch {
    return null;
  }
}

/** How much of Instagram's publishing limit is used, out of how many, over how many seconds (read each time: Meta's docs give two numbers). */
export async function igPublishingLimit(env: Env, igId: string, token: string): Promise<{ used: number; total: number; seconds: number }> {
  const json = await graph<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }> }>(env, `${encodeURIComponent(igId)}/content_publishing_limit`, {
    token, params: { fields: "quota_usage,config" },
  });
  const row = json.data?.[0] ?? {};
  return { used: Number(row.quota_usage ?? 0), total: Number(row.config?.quota_total ?? 50), seconds: Number(row.config?.quota_duration ?? 86_400) };
}

export interface RecentPost {
  id: string;
  caption: string;
  created: number;
  permalink: string | null;
  media: number;
}

/** The Page's latest posts, to find one that may have gone up after a timeout. Read only. */
export async function recentFacebookPosts(env: Env, pageId: string, pageToken: string, since: Date): Promise<RecentPost[]> {
  const json = await graph<{ data?: Array<Record<string, any>> }>(env, `${encodeURIComponent(pageId)}/posts`, {
    token: pageToken,
    params: { fields: "id,message,created_time,permalink_url,attachments{media_type,subattachments.limit(20){media_type}}", since: Math.floor(since.getTime() / 1000), limit: 25 },
  });
  return (json.data ?? []).map((p) => {
    const attachment = p.attachments?.data?.[0];
    const media = attachment?.subattachments?.data?.length ?? (attachment?.media_type === "photo" ? 1 : 0);
    return { id: String(p.id ?? ""), caption: String(p.message ?? ""), created: Date.parse(String(p.created_time ?? "")) || 0, permalink: httpsOnly(p.permalink_url), media };
  });
}

/** The Instagram account's latest posts, to find one that may have gone up after a timeout. Read only. */
export async function recentIgMedia(env: Env, igId: string, token: string): Promise<RecentPost[]> {
  const json = await graph<{ data?: Array<Record<string, any>> }>(env, `${encodeURIComponent(igId)}/media`, {
    token, params: { fields: "id,caption,timestamp,permalink,media_type,children{id}", limit: 25 },
  });
  return (json.data ?? []).map((m) => ({
    id: String(m.id ?? ""),
    caption: String(m.caption ?? ""),
    created: Date.parse(String(m.timestamp ?? "")) || 0,
    permalink: httpsOnly(m.permalink),
    media: m.media_type === "CAROUSEL_ALBUM" ? (m.children?.data?.length ?? 2) : 1,
  }));
}
