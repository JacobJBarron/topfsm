/**
 * Apps → Facebook & Instagram (docs/marketing-plan.md, phase E): signing in with the business's own
 * Meta app, picking the Page (and its Instagram account) posts go to, and checking it again.
 *
 * Sign-in keeps the long-lived user token (about 60 days), used only to list Pages and permissions.
 * Posting uses the Page's token, which doesn't expire, so a user token that ran out only means
 * "sign in again to change the Page", never that posting stopped. Signing in again keeps the Page
 * picked when the new sign-in still reaches it, with a fresh token, and asks for a Page otherwise.
 */
import type { Env } from "../env";
import {
  CREATE_CONTENT,
  exchangeMetaCode,
  grantedPermissions,
  listPages,
  longLivedToken,
  META_ADS_SCOPES,
  META_SCOPES,
  MetaError,
  metaMe,
  pageProbe,
  revokeMeta,
  tokenInfo,
  type MetaKeys,
  type MetaPage,
} from "../integrations/meta";
import { IntegrationError } from "../integrations/registry";
import { appKeysOf, loadSecret, saveSecret, type StoredSecret } from "../integrations/tokens";
import { HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";
import { SIGNIN_LOST, type MetaExtra, type MetaSettings } from "./social";

export const USER_SIGNIN_ENDED = "Meta's sign-in ran out. Sign in again to change the Page or its permissions. Posts keep going meanwhile.";

/** The permissions posting can't do without (business_management only reaches Pages in a portfolio). */
export const NEEDED_SCOPES = META_SCOPES.filter((s) => s !== "business_management");

async function current(env: Env, admin: Db, companyId: string) {
  const [{ data: row }, secret] = await Promise.all([
    admin.from("integrations").select("status, settings").match({ company_id: companyId, provider: "meta" }).maybeSingle(),
    loadSecret(env, admin, companyId, "meta").catch(() => null),
  ]);
  const keys = appKeysOf(secret?.extra);
  return { row, settings: (row?.settings ?? {}) as MetaSettings, secret, extra: (secret?.extra ?? {}) as MetaExtra, keys: keys.client_id ? (keys as unknown as MetaKeys) : null };
}

/** What integrations.settings keeps about the Page picked. */
function pageSettings(page: MetaPage, instagram: boolean): Partial<MetaSettings> {
  return {
    page_id: page.id,
    page_name: page.name,
    page_picture: page.picture,
    business_id: page.business?.id ?? null,
    page_instagram: page.instagram,
    ig_user_id: instagram && page.instagram ? page.instagram.id : undefined,
    ig_username: instagram && page.instagram ? page.instagram.username : undefined,
  };
}

const PAGE_FIELDS = ["page_id", "page_name", "page_picture", "business_id", "page_instagram", "ig_user_id", "ig_username"] as const;
const withoutPage = (settings: MetaSettings): MetaSettings => Object.fromEntries(Object.entries(settings).filter(([k]) => !(PAGE_FIELDS as readonly string[]).includes(k))) as MetaSettings;
const withoutPageExtra = (extra: MetaExtra): MetaExtra => {
  const { page_id: _p, page_token: _t, ig_user_id: _i, ...rest } = extra;
  return rest;
};

/**
 * Back from Meta's sign-in: the code swapped for a long-lived token, who signed in, what they granted
 * and the Pages they manage. The Page picked before stays when it's still listed (with a fresh token
 * and its Instagram account as it was), and the only Page there is is picked by itself; otherwise one
 * is left to pick. Says what's next: pick, permissions, no_pages, or nothing.
 */
export async function connectMeta(env: Env, admin: Db, companyId: string, userId: string, code: string, redirect: string): Promise<"pick" | "permissions" | "no_pages" | null> {
  const before = await current(env, admin, companyId);
  if (!before.keys) throw new IntegrationError("Add your Meta app's App ID and secret first.");
  const short = await exchangeMetaCode(env, before.keys, code, redirect);
  const long = await longLivedToken(env, before.keys, short.access_token);
  const [me, permissions, pages, info] = await Promise.all([
    metaMe(env, long.access_token),
    grantedPermissions(env, long.access_token),
    listPages(env, long.access_token),
    tokenInfo(env, before.keys, long.access_token).catch(() => null),
  ]);
  const kept = before.settings.page_id ? pages.find((p) => p.id === before.settings.page_id && p.tasks.includes(CREATE_CONTENT)) : undefined;
  const postable = pages.filter((p) => p.tasks.includes(CREATE_CONTENT));
  const page = kept ?? (pages.length === 1 && postable.length === 1 ? postable[0] : undefined);
  const instagram = Boolean(page?.instagram) && (kept ? Boolean(before.settings.ig_user_id) && page!.instagram!.id === before.settings.ig_user_id : true);
  const extra: MetaExtra = {
    ...withoutPageExtra(before.extra),
    ...(appKeysOf(before.secret?.extra) as MetaExtra),
    user_id: me.id,
    ...(page ? { page_id: page.id, page_token: page.access_token, ...(instagram ? { ig_user_id: page.instagram!.id } : {}) } : {}),
  };
  const settings: MetaSettings = {
    ...withoutPage(before.settings),
    user_id: me.id,
    user_name: me.name,
    granted: permissions.granted,
    declined: permissions.declined,
    pages: pages.length,
    data_access_expires_at: info?.data_access_expires_at ?? null,
    user_token_expired: false,
    ...(page ? pageSettings(page, instagram) : {}),
  };
  delete settings.access_notice;
  const { error } = await admin.from("integrations").upsert({
    company_id: companyId,
    provider: "meta",
    status: "connected",
    account_label: page?.name ?? null,
    external_account_id: me.id,
    connected_by: userId,
    connected_at: new Date().toISOString(),
    last_error: null,
    settings: settings as never,
  });
  if (error) throw new Error(error.message);
  const secret: StoredSecret = { access_token: long.access_token, expires_at: Date.now() + (long.expires_in ?? 60 * 86_400) * 1000, extra: extra as Record<string, string> };
  await saveSecret(env, admin, companyId, "meta", secret);
  if (!pages.length) return "no_pages";
  if (!page) return "pick";
  return NEEDED_SCOPES.some((s) => !permissions.granted.includes(s)) ? "permissions" : null;
}

/** The user's sign-in ran out: the page says so, and posting carries on with the Page's token. */
async function userSignInEnded(admin: Db, companyId: string, settings: MetaSettings) {
  await admin.from("integrations").update({ settings: { ...settings, user_token_expired: true } as never }).match({ company_id: companyId, provider: "meta" });
}

/** A call with the user's token, which says so (409) when that sign-in ran out, without touching posting. */
async function withUserToken<T>(admin: Db, companyId: string, settings: MetaSettings, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MetaError && error.kind === "signin") {
      await userSignInEnded(admin, companyId, settings);
      throw new HttpError(409, USER_SIGNIN_ENDED);
    }
    if (error instanceof MetaError) throw new HttpError(502, `Meta said: ${error.message}`);
    throw error;
  }
}

/** The Pages to pick from, read from Meta again. */
export async function metaPages(env: Env, admin: Db, companyId: string) {
  const now = await current(env, admin, companyId);
  if (!now.row || now.row.status === "disconnected" || !now.secret?.access_token) throw new HttpError(409, "Sign in to Facebook first.");
  const pages = await withUserToken(admin, companyId, now.settings, () => listPages(env, now.secret!.access_token!));
  return pages.map((p) => ({ id: p.id, name: p.name, picture: p.picture, can_post: p.tasks.includes(CREATE_CONTENT), instagram: p.instagram, business: Boolean(p.business) }));
}

/**
 * The Page posts go to, and whether its Instagram account is used, read from Meta again with the
 * user's sign-in (nothing the browser sends about it is kept). A Page the person can't post as is
 * refused. Says whether Instagram needs the business Page permissions too.
 */
export async function chooseMetaPage(env: Env, admin: Db, companyId: string, pageId: string, instagram: boolean) {
  const now = await current(env, admin, companyId);
  if (!now.row || now.row.status === "disconnected" || !now.secret?.access_token) throw new HttpError(409, "Sign in to Facebook first.");
  const pages = await withUserToken(admin, companyId, now.settings, () => listPages(env, now.secret!.access_token!));
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new HttpError(404, "That Page isn't one you manage anymore.");
  if (!page.tasks.includes(CREATE_CONTENT)) throw new HttpError(409, "You can't post as this Page. Ask its admin to give you full control of it, then sign in again.");
  const useInstagram = instagram && Boolean(page.instagram);
  const extra: MetaExtra = { ...withoutPageExtra(now.extra), page_id: page.id, page_token: page.access_token, ...(useInstagram ? { ig_user_id: page.instagram!.id } : {}) };
  await saveSecret(env, admin, companyId, "meta", { ...now.secret, extra: extra as Record<string, string> });
  const settings: MetaSettings = { ...withoutPage(now.settings), ...pageSettings(page, useInstagram), pages: pages.length };
  const { error } = await admin.from("integrations").update({ settings: settings as never, account_label: page.name, status: "connected", last_error: null }).match({ company_id: companyId, provider: "meta" });
  if (error) throw new Error(error.message);
  return {
    page: { id: page.id, name: page.name },
    instagram: useInstagram ? page.instagram : null,
    needs_business_permissions: useInstagram && Boolean(page.business) && META_ADS_SCOPES.some((s) => !settings.granted?.includes(s)),
  };
}

/** I switched my app to Live, or not: Meta's API can't tell. */
export async function confirmMetaLive(admin: Db, companyId: string, confirmed: boolean) {
  const { data } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: "meta" }).maybeSingle();
  if (!data) throw new HttpError(409, "Sign in to Facebook first.");
  const settings = { ...((data.settings ?? {}) as MetaSettings), live_confirmed_at: confirmed ? new Date().toISOString() : null };
  const { error } = await admin.from("integrations").update({ settings: settings as never }).match({ company_id: companyId, provider: "meta" });
  if (error) throw new Error(error.message);
  return settings.live_confirmed_at;
}

/**
 * Check again: the Page's own token first (only a Page token that stopped working means posting
 * stopped, and the app needs reconnecting), then the permissions and the Instagram link with the
 * user's sign-in, which may have run out on its own (the page says to sign in again to change things).
 */
export async function checkMeta(env: Env, admin: Db, companyId: string) {
  const now = await current(env, admin, companyId);
  if (!now.row || now.row.status === "disconnected") throw new HttpError(409, "Sign in to Facebook first.");
  const settings = { ...now.settings };
  if (now.extra.page_token && settings.page_id && now.keys) {
    try {
      await pageProbe(env, settings.page_id, now.extra.page_token);
      const info = await tokenInfo(env, now.keys, now.extra.page_token).catch(() => null);
      if (info?.data_access_expires_at) settings.data_access_expires_at = info.data_access_expires_at;
      if (now.row.status === "error") {
        await admin.from("integrations").update({ status: "connected", last_error: null }).match({ company_id: companyId, provider: "meta" });
        await admin.rpc("note_meta_access", { p_company: companyId, p_kind: "ok" });
      }
    } catch (error) {
      if (error instanceof MetaError && error.kind === "signin") {
        await admin.from("integrations").update({ status: "error", last_error: SIGNIN_LOST }).match({ company_id: companyId, provider: "meta" });
        throw new HttpError(409, SIGNIN_LOST);
      }
      throw error instanceof MetaError ? new HttpError(502, `Meta said: ${error.message}`) : error;
    }
  }
  let userSignIn = true;
  if (now.secret?.access_token) {
    try {
      const permissions = await grantedPermissions(env, now.secret.access_token);
      settings.granted = permissions.granted;
      settings.declined = permissions.declined;
      const pages = await listPages(env, now.secret.access_token);
      const page = pages.find((p) => p.id === settings.page_id);
      if (page) {
        settings.page_instagram = page.instagram;
        settings.business_id = page.business?.id ?? null;
        // The Instagram account picked isn't linked to the Page anymore: it isn't used.
        if (settings.ig_user_id && page.instagram?.id !== settings.ig_user_id) {
          delete settings.ig_user_id;
          delete settings.ig_username;
        }
      }
      settings.user_token_expired = false;
    } catch (error) {
      if (!(error instanceof MetaError && error.kind === "signin")) throw error instanceof MetaError ? new HttpError(502, `Meta said: ${error.message}`) : error;
      settings.user_token_expired = true;
      userSignIn = false;
    }
  }
  const { error } = await admin.from("integrations").update({ settings: settings as never }).match({ company_id: companyId, provider: "meta" });
  if (error) throw new Error(error.message);
  return {
    user_sign_in: userSignIn,
    missing: NEEDED_SCOPES.filter((s) => !settings.granted?.includes(s)),
    // Linked to the Page, and whether posts go to it: linked but not used is picked with Change Page.
    instagram_linked: Boolean(settings.page_instagram),
    instagram_used: Boolean(settings.ig_user_id),
    instagram_username: settings.page_instagram?.username ?? null,
  };
}

/**
 * What signing out keeps of the settings while the Meta app stays: whether it's Live, which only the
 * person can say, so connecting again with the same app doesn't ask for it again.
 */
export async function metaKeptSettings(admin: Db, companyId: string): Promise<Pick<MetaSettings, "live_confirmed_at">> {
  const { data } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: "meta" }).maybeSingle();
  const live = (data?.settings as MetaSettings | null)?.live_confirmed_at;
  return live ? { live_confirmed_at: live } : {};
}

/** Signing out at Meta (with the app's own token, so it works after the user's sign-in ran out). */
export async function signOutMeta(env: Env, secret: StoredSecret | null): Promise<void> {
  const keys = appKeysOf(secret?.extra);
  await revokeMeta(env, keys.client_id ? (keys as unknown as MetaKeys) : null, (secret?.extra as MetaExtra | undefined)?.user_id);
}

/** Facebook & Instagram on its app page (GET /apps). */
export async function metaAppState(admin: Db, companyId: string, row: { status: string; settings: unknown } | undefined, marketingIsOn: boolean) {
  const settings = (row?.settings ?? {}) as MetaSettings;
  const signedIn = Boolean(row && row.status !== "disconnected");
  const missing = signedIn ? NEEDED_SCOPES.filter((s) => !settings.granted?.includes(s)) : [];
  // What Uninstall's confirm says won't go to Facebook or Instagram.
  const { count } = signedIn
    ? await admin.from("social_posts").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "scheduled").overlaps("networks", ["facebook", "instagram"])
    : { count: 0 };
  return {
    page: signedIn && settings.page_id ? { id: settings.page_id, name: settings.page_name ?? null, picture: settings.page_picture ?? null } : null,
    instagram: signedIn && settings.ig_user_id ? { id: settings.ig_user_id, username: settings.ig_username ?? null } : null,
    page_instagram: signedIn ? (settings.page_instagram ?? null) : null,
    pages: settings.pages ?? null,
    missing,
    problem: !signedIn ? null : row!.status === "error" ? "signin" : !settings.page_id ? "pick" : missing.length ? "permissions" : null,
    needs_business_permissions: signedIn && Boolean(settings.ig_user_id && settings.business_id) && META_ADS_SCOPES.some((s) => !settings.granted?.includes(s)),
    live_confirmed_at: settings.live_confirmed_at ?? null,
    data_access_expires_at: settings.data_access_expires_at ?? null,
    user_token_expired: Boolean(settings.user_token_expired),
    user_name: settings.user_name ?? null,
    scheduled_posts: count ?? 0,
    marketing_on: marketingIsOn,
  };
}
