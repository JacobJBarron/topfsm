/** Apps page: catalog with status, OAuth connect/callback/disconnect, API keys, and AI helpers. */
import { ADMINS } from "@crewtavo/core";
import { marketingOn } from "@crewtavo/core/marketing";
import { projectNumber } from "@crewtavo/core/reviews";
import { websiteOf } from "@crewtavo/core/website";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { randomId, signToken, verifyToken } from "../lib/crypto";
import { appUrl, asJson, dbError, HttpError, isoDate, must, readJson } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { companyAnthropicKey, complete } from "../services/ai";
import { analyticsSettings } from "../services/analytics";
import { AbcProblem, chooseAbcAccount, connectAbc, settingsOf as abcSettingsOf } from "../integrations/abcSupply";
import { describeAccount } from "../integrations/accounting";
import { deleteVisitsCalendar, describeGoogleAccount, pushUpcomingVisits } from "../integrations/calendars";
import { checkFalKey } from "../integrations/fal";
import { describeGoogleBusiness, findLocation, GoogleBusinessError } from "../integrations/googleBusiness";
import { CATALOG, catalogEntry, isCalendarApp, OAUTH, UntrustedServerError, zohoAccountsServer, type Provider } from "../integrations/registry";
import { beginStripeImport, canImportStripe, connectStripe, disconnectStripe, IMPORT_STALE_MS, importFromStripe, SHARED_STRIPE_IMPORT, stripeAccess, type ImportState } from "../integrations/stripe";
import { appKeysOf, exchangeCode, loadSecret, oauthClient, revoke, saveSecret, SignInRefused } from "../integrations/tokens";
import { checkSite, saveWebsite, WebsiteError } from "../integrations/website";
import { checkAccess, chooseLocation, endReviewSync, firstSyncProgress, problemMessage, reviewLinkOffer, syncCompany, type BusinessSettings } from "../services/googleReviews";

export const apps = new Hono<AppEnv>();

const STATE_COOKIE = "crewtavo_oauth_nonce";
const callbackUrl = (base: string, provider: string) => `${base}/api/apps/${provider}/callback`;

apps.get("/apps", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const [rows, calendars, stripeKey, company] = await Promise.all([
    c.var.db.from("integrations").select("provider, status, account_label, connected_at, last_sync_at, last_error, settings").eq("company_id", c.var.companyId),
    c.var.db.from("calendar_sources").select("app, last_error").eq("company_id", c.var.companyId),
    adminClient(c.env).from("integration_secrets").select("provider", { count: "exact", head: true }).match({ company_id: c.var.companyId, provider: "stripe" }),
    c.var.db.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle(),
  ]);
  // Apps the company can sign in to with its own app at the provider: which keys it saved, if any.
  const keyed = CATALOG.filter((entry) => entry.appKeys).map((entry) => entry.id as Provider);
  const saved = await Promise.all(keyed.map((provider) => loadSecret(c.env, adminClient(c.env), c.var.companyId, provider).catch(() => null)));
  const appKeys = new Map(keyed.map((provider, i) => [provider as string, appKeysOf(saved[i]?.extra)]));
  const integrations = must(rows);
  // Built-in apps are on or off in the company's settings (team chat: routes/chat.ts).
  const builtinOn: Record<string, boolean> = { team_chat: (company.data?.settings as { team_chat?: { enabled?: boolean } } | null)?.team_chat?.enabled === true };
  // The website's editor, by its address (integrations/website.ts).
  const website = websiteOf(company.data?.settings as Record<string, unknown> | null);
  const byProvider = new Map(integrations.map(({ settings, ...r }) => [r.provider, r]));
  // Website analytics, while it counts visits (routes/analytics.ts), website forms and careers
  // (routes/websiteForms.ts), Drive (routes/drive.ts) and Marketing (routes/marketing.ts).
  builtinOn.website_analytics = analyticsSettings(company.data?.settings).enabled === true;
  builtinOn.website_forms = (company.data?.settings as { website_forms?: { enabled?: boolean } } | null)?.website_forms?.enabled === true;
  builtinOn.careers = (company.data?.settings as { careers?: { enabled?: boolean } } | null)?.careers?.enabled === true;
  builtinOn.drive = (company.data?.settings as { drive?: { enabled?: boolean } } | null)?.drive?.enabled === true;
  builtinOn.marketing = marketingOn(company.data?.settings as Record<string, unknown> | null);
  const calendarRows = must(calendars);
  const ownKey = Boolean(stripeKey.count);
  const stripeSettings = (integrations.find((r) => r.provider === "stripe")?.settings ?? {}) as { webhook?: boolean; livemode?: boolean; import?: ImportState };
  // ABC Supply: the account and branch prices come from, and the others there are to pick.
  const abc = abcSettingsOf(integrations.find((r) => r.provider === "abc_supply" && r.status !== "disconnected")?.settings);
  // Google Business Profile: the location reviews come from, what's in the way, and Google's review link.
  const business = await googleBusinessState(c.env, c.var.companyId, integrations.find((r) => r.provider === "google_business"), company.data?.settings, appKeys.get("google_business"));
  // The deployment's own Stripe account, for companies that haven't added theirs.
  const serverStripe = !ownKey && Boolean(c.env.STRIPE_SECRET_KEY);
  if (serverStripe) byProvider.set("stripe", { provider: "stripe", status: "connected", account_label: "Set up for this server", connected_at: null, last_sync_at: null, last_error: null });
  const stripe = ownKey || serverStripe
    ? {
        own: ownKey,
        webhook: ownKey ? stripeSettings.webhook !== false : true,
        livemode: ownKey ? stripeSettings.livemode !== false : !c.env.STRIPE_SECRET_KEY?.includes("_test_"),
        import: stripeSettings.import ?? null,
      }
    : null;
  return c.json({
    mcp_url: `${appUrl(c)}/mcp`,
    apps: CATALOG.map(({ available, appKeys: takesKeys, ...entry }) => {
      const own = calendarRows.filter((s) => s.app === entry.id);
      const linked = isCalendarApp(entry.id) ? { calendars: own.length, calendar_errors: own.filter((s) => s.last_error).length } : {};
      const row = byProvider.get(entry.id);
      // The Client ID shows up in sign-in links anyway; the secret never leaves the server.
      const keys = appKeys.get(entry.id);
      const ownKeys = keys?.client_id ? { client_id: keys.client_id, sandbox: keys.environment === "sandbox", accounts_server: keys.accounts_server ?? null } : null;
      return {
        ...entry,
        available: available(c.env) || Boolean(ownKeys),
        redirect_uri: OAUTH[entry.id as Provider] ? callbackUrl(appUrl(c), entry.id) : null,
        ...(row ?? { status: (entry.auth === "link" && own.length) || builtinOn[entry.id] || (entry.auth === "site" && website) ? "connected" : "disconnected" }),
        ...linked,
        ...(entry.auth === "site" ? { website } : {}),
        ...(entry.id === "stripe" && stripe ? { stripe } : {}),
        ...(entry.id === "abc_supply" && abc ? { supplier: abc } : {}),
        ...(entry.id === "google_business" ? { google_business: business } : {}),
        ...(takesKeys ? { takes_app_keys: true, app_keys: ownKeys } : {}),
      };
    }),
  });
});

type IntegrationRow = { status: string; settings: unknown } | undefined;

/**
 * Google Business Profile on its app page: the location, the sync's state, the review link offer and
 * the project Google's form asks about. `kept_location` is the location the reviews here came from,
 * kept from before disconnecting too, so picking another says first that they're removed.
 */
async function googleBusinessState(env: Env, companyId: string, row: IntegrationRow, companySettings: unknown, keys: Record<string, string> | undefined) {
  const own = Boolean(keys?.client_id);
  const projectOf = projectNumber(own ? keys!.client_id : env.GOOGLE_CLIENT_ID);
  // Never signed in: only what the setup steps need.
  if (!row) return { location: null, problem: null, review_count: 0, own_app: own, project_number: projectOf, marketing_on: marketingOn(companySettings as Record<string, unknown> | null) };
  const admin = adminClient(env);
  const settings = (row?.settings ?? {}) as BusinessSettings;
  const [sync, kept] = await Promise.all([
    admin.from("review_syncs").select("location_id, problem, problem_detail, last_synced_at, next_sync_at, first_synced_at, full_seen, total_reviews").eq("company_id", companyId).maybeSingle(),
    admin.from("reviews").select("id", { count: "exact", head: true }).eq("company_id", companyId).is("deleted_at", null),
  ]);
  const s = sync.data;
  const on = marketingOn(companySettings as Record<string, unknown> | null);
  return {
    location: s?.location_id && settings.location === s.location_id ? { id: s.location_id, title: settings.title ?? null, address: settings.address ?? null, maps_uri: settings.maps_uri ?? null } : null,
    kept_location: s?.location_id ?? null,
    problem: row?.status === "connected" || row?.status === "error" ? (s?.problem ?? null) : null,
    problem_detail: s?.problem_detail ?? null,
    problem_message: s?.problem ? problemMessage(s.problem as never, s.problem_detail, own) : null,
    last_synced_at: s?.last_synced_at ?? null,
    next_sync_at: s?.next_sync_at ?? null,
    first_synced_at: s?.first_synced_at ?? null,
    progress: row?.status === "connected" && on ? firstSyncProgress(s, settings) : null,
    review_count: kept.count ?? 0,
    review_url: reviewLinkOffer(companySettings, settings),
    own_app: own,
    project_number: projectOf,
    marketing_on: on,
  };
}

/**
 * Google revokes the whole sign-in a person gave one Google app (client ID), so signing out of one of
 * Google Calendar and Google Business Profile would sign out of the other too when both use the
 * server's app. Then the token is left, and the page says where to remove access in Google.
 */
async function sharesGoogleSignIn(env: Env, companyId: string, provider: Provider): Promise<boolean> {
  if (provider !== "google_calendar" && provider !== "google_business") return false;
  const admin = adminClient(env);
  const other: Provider = provider === "google_calendar" ? "google_business" : "google_calendar";
  const { data } = await admin.from("integrations").select("status").match({ company_id: companyId, provider: other }).maybeSingle();
  if (!data || data.status === "disconnected") return false;
  const [mine, theirs] = await Promise.all([provider, other].map((p) => loadSecret(env, admin, companyId, p).catch(() => null)));
  return !appKeysOf(mine?.extra).client_id && !appKeysOf(theirs?.extra).client_id;
}

/** Bring in past invoices, payments and deposits from Stripe. Runs in the background; GET /apps shows progress. */
apps.post("/apps/stripe/import", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ since: isoDate.nullable().default(null) }));
  const admin = adminClient(c.env);
  const access = await stripeAccess(c.env, admin, c.var.companyId);
  if (!access) throw new HttpError(400, "Connect Stripe first.");
  if (!(await canImportStripe(c.env, admin, c.var.companyId, access))) throw new HttpError(400, SHARED_STRIPE_IMPORT);
  const { data: row } = await admin.from("integrations").select("settings").match({ company_id: c.var.companyId, provider: "stripe" }).maybeSingle();
  const running = (row?.settings as { import?: ImportState } | undefined)?.import;
  if (running?.status === "running" && Date.now() - Date.parse(running.started_at) < IMPORT_STALE_MS) throw new HttpError(409, "An import is already running.");
  if (!row) {
    // Using the deployment's Stripe account: the import's progress needs somewhere to live.
    await admin.from("integrations").upsert({ company_id: c.var.companyId, provider: "stripe", status: "disconnected", account_label: "Set up for this server" });
  }
  const state = await beginStripeImport(admin, c.var.companyId, body.since);
  runInBackground(c, importFromStripe(c.env, admin, c.var.companyId, state));
  return c.json({ status: "running" }, 202);
});

/** Step 1: returns the provider's sign-in URL. The signed state is also bound to an httpOnly cookie. */
apps.post("/apps/:provider/connect", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const provider = c.req.param("provider") as Provider;
  const entry = catalogEntry(provider);
  const config = OAUTH[provider];
  // The company's own app at the provider when it saved one, otherwise the server's.
  const keys = entry?.appKeys ? appKeysOf((await loadSecret(c.env, adminClient(c.env), c.var.companyId, provider).catch(() => null))?.extra) : {};
  const client = config ? oauthClient(c.env, provider, keys) : null;
  if (!entry || !config || entry.auth !== "oauth" || !client) throw new HttpError(400, "That app isn't available yet.");

  const nonce = randomId();
  const state = await signToken(c.env, {
    company: c.var.companyId,
    user: c.var.userId,
    provider,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  setCookie(c, STATE_COOKIE, nonce, { httpOnly: true, secure: true, sameSite: "Lax", path: "/api/apps", maxAge: 600 });

  const params = new URLSearchParams({
    client_id: client.id,
    response_type: "code",
    scope: config.scope,
    redirect_uri: callbackUrl(appUrl(c), provider),
    state,
    ...config.extraParams,
  });
  return c.json({ authorization_url: `${config.authorizeUrl(c.env, keys)}?${params}` });
});

/** Step 2: the provider redirects the browser here. No bearer token; identity comes from the signed state. */
apps.get("/apps/:provider/callback", async (c) => {
  const provider = c.req.param("provider") as Provider;
  const query = c.req.query();
  // Back to the app's own page, which says how it went.
  const done = (status: "connected" | "error", message?: string, more: Record<string, string> = {}) =>
    c.redirect(`${appUrl(c)}/apps/${catalogEntry(provider) ? provider : ""}?${new URLSearchParams({ status, ...(message ? { message } : {}), ...more })}`);

  const state = query.state ? await verifyToken<{ company: string; user: string; provider: string; nonce: string; exp: number }>(c.env, query.state) : null;
  const nonce = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/apps" });
  if (!state || state.provider !== provider || !nonce || nonce !== state.nonce) return done("error", "The sign-in link expired. Try connecting again.");
  if (query.error || !query.code) return done("error", query.error_description ?? query.error ?? "Sign-in was cancelled.");

  const admin = adminClient(c.env);
  const entry = catalogEntry(provider);
  try {
    // Signing in with the company's own app: its keys get the tokens, and stay with them.
    const saved = entry?.appKeys ? await loadSecret(c.env, admin, state.company, provider).catch(() => null) : null;
    const secret = await exchangeCode(c.env, provider, query.code, callbackUrl(appUrl(c), provider), { query }, saved?.extra);
    // Google Business Profile names itself after the location once one is picked.
    const account = provider === "google_calendar"
      ? await describeGoogleAccount(secret.access_token!)
      : provider === "google_business"
        ? { account_label: null, external_account_id: null }
        : await describeAccount(c.env, provider, secret.access_token!, query, secret.extra);
    // The integrations row must exist before its secret (foreign key).
    const { error } = await admin.from("integrations").upsert({
      company_id: state.company,
      provider,
      status: "connected",
      ...(account.account_label ? { account_label: account.account_label } : {}),
      external_account_id: account.external_account_id,
      connected_by: state.user,
      connected_at: new Date().toISOString(),
      last_error: null,
    });
    if (error) throw new Error(error.message);
    await saveSecret(c.env, admin, state.company, provider, secret);
    // Reconnected while visits go to Google: changes made while it needed reconnecting weren't
    // queued, so bring the visits calendar in line again (visits cancelled or deleted meanwhile
    // come off it too).
    if (provider === "google_calendar") runInBackground(c, pushUpcomingVisits(c.env, admin, state.company));
    // Google Business Profile: signed in, whether or not Google lets it in yet. What's in the way
    // (Google's approval, most often, or a location to pick) goes back to the page to say so.
    if (provider === "google_business") {
      const access = await checkAccess(c.env, admin, state.company, await describeGoogleBusiness(c.env, admin, state.company, secret.access_token!));
      const company = await admin.from("companies").select("settings").eq("id", state.company).maybeSingle();
      if (!access.problem && marketingOn(company.data?.settings as Record<string, unknown> | null)) runInBackground(c, syncCompany(c.env, admin, state.company));
      return done("connected", undefined, access.problem ? { pending: access.problem } : {});
    }
    return done("connected");
  } catch (error) {
    console.error("OAuth callback failed", provider, error);
    // Refusing a server that isn't the provider's says so, and so do keys the provider turned down
    // (a secret pasted wrong, most likely). Other failures stay general.
    if (error instanceof UntrustedServerError) return done("error", error.message);
    if (error instanceof SignInRefused && /invalid_client|unauthorized_client/.test(error.message)) {
      return done("error", `${entry?.name ?? "The app"} didn't accept the Client ID and secret. Check them on this page, then connect again.`);
    }
    return done("error", "Couldn't finish connecting. Check the app's settings and try again.");
  }
});

apps.post("/apps/:provider/disconnect", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const provider = c.req.param("provider") as Provider;
  const admin = adminClient(c.env);
  const body = (await c.req.json().catch(() => ({}))) as { remove_reviews?: unknown };
  let removed = 0;
  // Google Business Profile: syncing stops, and the reviews stay unless the person said to remove them.
  if (provider === "google_business") removed = await endReviewSync(admin, c.var.companyId, body.remove_reviews === true);
  const shared = await sharesGoogleSignIn(c.env, c.var.companyId, provider);
  if (provider === "google_calendar") {
    // Take the visits calendar out of the Google account while we still can, and stop showing
    // its calendars on the schedule. Calendars added by link stay.
    const { data } = await admin.from("integrations").select("settings").eq("company_id", c.var.companyId).eq("provider", provider).maybeSingle();
    const pushId = (data?.settings as { push_calendar_id?: string } | null)?.push_calendar_id;
    if (pushId) await deleteVisitsCalendar(c.env, admin, c.var.companyId, pushId).catch((error) => console.error("Couldn't remove the visits calendar", error));
    await admin.from("calendar_sources").delete().match({ company_id: c.var.companyId, kind: "google" });
    await admin.from("outbox").update({ done_at: new Date().toISOString() }).match({ company_id: c.var.companyId, topic: "calendar.visit" }).is("done_at", null);
  }
  const secret = await loadSecret(c.env, admin, c.var.companyId, provider).catch(() => null);
  // Stripe's open invoices are voided with the old key, which can finish after the response.
  if (secret && provider === "stripe") runInBackground(c, (await disconnectStripe(c.env, admin, c.var.companyId, secret)).settled);
  else if (secret && !shared) await revoke(c.env, provider, secret);
  // The company's own app keys stay, so connecting again is one click.
  const keys = catalogEntry(provider)?.appKeys ? appKeysOf(secret?.extra) : {};
  if (keys.client_id) await saveSecret(c.env, admin, c.var.companyId, provider, { extra: keys });
  else await admin.from("integration_secrets").delete().match({ company_id: c.var.companyId, provider });
  const { error } = await admin
    .from("integrations")
    .update({ status: "disconnected", account_label: null, last_error: null, ...(provider === "google_calendar" || provider === "google_business" ? { settings: {} } : {}) })
    .match({ company_id: c.var.companyId, provider });
  if (error) throw dbError(error);
  return c.json({ provider, status: "disconnected", ...(provider === "google_business" ? { removed } : {}), ...(shared ? { revoked: false } : {}) });
});

/**
 * Google Business Profile: the accounts and locations the sign-in manages, to pick from. Also
 * Check again, while Google hasn't approved access: it asks again now, and syncing starts once it works.
 */
apps.get("/apps/google_business/locations", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const admin = adminClient(c.env);
  const { data: row } = await admin.from("integrations").select("status").match({ company_id: c.var.companyId, provider: "google_business" }).maybeSingle();
  if (!row || row.status === "disconnected") throw new HttpError(409, "Sign in with Google first.");
  const access = await checkAccess(c.env, admin, c.var.companyId);
  const company = must(await c.var.db.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle());
  const { data: sync } = await admin.from("review_syncs").select("location_id").eq("company_id", c.var.companyId).maybeSingle();
  if (!access.problem && sync?.location_id && marketingOn(company.settings as Record<string, unknown> | null)) runInBackground(c, syncCompany(c.env, admin, c.var.companyId));
  return c.json({ accounts: access.accounts ?? [], problem: access.problem ?? null });
});

/**
 * Google Business Profile: the location whose reviews come in. It's read again from Google, so
 * nothing the browser says about it is kept. Another location's reviews are removed. Answers with
 * whether reviews are on their way (not for a location Google hasn't verified, or while Marketing
 * is off) and Google's review link for it when it would change the company's.
 */
apps.put("/apps/google_business/location", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ account: z.string().regex(/^accounts\/[^/]+$/), location: z.string().regex(/^locations\/[^/]+$/) }));
  const admin = adminClient(c.env);
  let location;
  try {
    location = await findLocation(c.env, admin, c.var.companyId, body.account, body.location);
  } catch (error) {
    if (error instanceof GoogleBusinessError) throw new HttpError(error.kind === "busy" ? 429 : 409, problemMessage(error.kind === "approval" || error.kind === "not_enabled" || error.kind === "signin" ? error.kind : "error", error.message));
    throw error;
  }
  if (!location) throw new HttpError(404, "That location isn't in this Google account anymore.");
  const removed = await chooseLocation(admin, c.var.companyId, body.account, location);
  const company = must(await c.var.db.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle());
  const syncing = location.verified && marketingOn(company.settings as Record<string, unknown> | null);
  if (syncing) runInBackground(c, syncCompany(c.env, admin, c.var.companyId));
  return c.json({ removed, syncing, location, review_url: reviewLinkOffer(company.settings, { new_review_uri: location.new_review_uri }) });
});

/**
 * Google's review link for the location: used as the company's (settings.review_url), or turned
 * down so it isn't offered again for this location. Never changed without being asked.
 */
apps.post("/apps/google_business/review-link", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(c, z.object({ use: z.boolean() }));
  const admin = adminClient(c.env);
  const { data: row } = await admin.from("integrations").select("settings").match({ company_id: c.var.companyId, provider: "google_business" }).maybeSingle();
  const business = (row?.settings ?? {}) as BusinessSettings;
  if (!business.new_review_uri) throw new HttpError(409, "Google hasn't given a review link for this location.");
  if (body.use) {
    const { data, error: readError } = await admin.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle();
    if (readError) throw dbError(readError);
    const { error } = await admin.from("companies").update({ settings: asJson({ ...((data?.settings ?? {}) as Record<string, unknown>), review_url: business.new_review_uri }) }).eq("id", c.var.companyId);
    if (error) throw dbError(error);
  } else {
    const { error } = await admin.from("integrations").update({ settings: asJson({ ...business, review_link_declined: business.new_review_uri }) }).match({ company_id: c.var.companyId, provider: "google_business" });
    if (error) throw dbError(error);
  }
  return c.json({ review_url: body.use ? business.new_review_uri : null });
});

const appKey = z.string().trim().min(8, "That looks too short. Copy the whole thing.").max(300).regex(/^\S+$/, "Paste it without spaces.");

/**
 * The company's own app at Intuit or Zoho (its Client ID and secret), so QuickBooks and Zoho Books
 * work without anyone setting up the server. Tokens belong to the app that issued them, so new keys
 * sign out of the old app first; connecting again signs in with the new one.
 */
apps.put("/apps/:provider/app-keys", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const provider = c.req.param("provider") as Provider;
  if (!catalogEntry(provider)?.appKeys) throw new HttpError(400, "That app doesn't take its own keys.");
  const body = await readJson(c, z.object({ client_id: appKey, client_secret: appKey, sandbox: z.boolean().default(false), accounts_server: z.string().max(100).optional() }));
  // Zoho: the data center the app was made in, where sign-in starts. Only Zoho's own servers.
  let accountsServer: string | undefined;
  if (provider === "zoho_books") {
    try {
      accountsServer = zohoAccountsServer(body.accounts_server ?? "https://accounts.zoho.com");
    } catch {
      throw new HttpError(400, "Pick where your Zoho account is.");
    }
  }
  const admin = adminClient(c.env);
  const previous = await loadSecret(c.env, admin, c.var.companyId, provider).catch(() => null);
  if (previous && !(await sharesGoogleSignIn(c.env, c.var.companyId, provider))) await revoke(c.env, provider, previous);
  // The integrations row must exist before its secret (foreign key).
  const { error } = await admin.from("integrations").upsert({ company_id: c.var.companyId, provider, status: "disconnected", account_label: null, last_error: null });
  if (error) throw dbError(error);
  await saveSecret(c.env, admin, c.var.companyId, provider, {
    extra: {
      client_id: body.client_id,
      client_secret: body.client_secret,
      ...(provider === "quickbooks" && body.sandbox ? { environment: "sandbox" } : {}),
      ...(accountsServer ? { accounts_server: accountsServer } : {}),
    },
  });
  return c.json({ provider, status: "disconnected" });
});

/** Forget the company's own app keys, signing out of that app first. The server's app is used again, if it has one. */
apps.delete("/apps/:provider/app-keys", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const provider = c.req.param("provider") as Provider;
  if (!catalogEntry(provider)?.appKeys) throw new HttpError(400, "That app doesn't take its own keys.");
  const admin = adminClient(c.env);
  const secret = await loadSecret(c.env, admin, c.var.companyId, provider).catch(() => null);
  if (secret && !(await sharesGoogleSignIn(c.env, c.var.companyId, provider))) await revoke(c.env, provider, secret);
  await admin.from("integration_secrets").delete().match({ company_id: c.var.companyId, provider });
  const { error } = await admin.from("integrations").update({ status: "disconnected", account_label: null, last_error: null }).match({ company_id: c.var.companyId, provider });
  if (error) throw dbError(error);
  return c.json({ provider, status: "disconnected" });
});

/** An ABC Supply problem as the answer: the keys or the account turned down say why. */
const abcAnswer = (error: unknown) => (error instanceof AbcProblem ? new HttpError(error.status === 401 ? 502 : error.status, error.message) : error);

/**
 * ABC Supply: the Client ID and secret of the business's own app in ABC's developer portal. They're
 * checked with ABC, which says which accounts and branches they price for; the first account's home
 * branch is where prices come from until someone picks another.
 */
apps.put("/apps/abc_supply/keys", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ client_id: appKey, client_secret: appKey, sandbox: z.boolean().default(false) }));
  try {
    const supplier = await connectAbc(c.env, adminClient(c.env), {
      companyId: c.var.companyId,
      userId: c.var.userId,
      keys: { client_id: body.client_id, client_secret: body.client_secret, environment: body.sandbox ? "sandbox" : "production" },
    });
    return c.json({ provider: "abc_supply", status: "connected", supplier });
  } catch (error) {
    throw abcAnswer(error);
  }
});

/** ABC Supply: the account and branch prices come from. */
apps.put("/apps/abc_supply/account", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ ship_to: z.string().trim().min(1).max(40), branch: z.string().trim().min(1).max(40) }));
  try {
    return c.json({ supplier: await chooseAbcAccount(c.env, adminClient(c.env), c.var.companyId, body) });
  } catch (error) {
    throw abcAnswer(error);
  }
});

/** API-key apps (a company's own Anthropic key, for example). The key is encrypted and never returned. */
apps.put("/apps/:provider/key", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const provider = c.req.param("provider") as Provider;
  const entry = catalogEntry(provider);
  if (!entry || entry.auth !== "api_key") throw new HttpError(400, "That app doesn't use a key.");
  if (provider === "abc_supply") throw new HttpError(400, "ABC Supply takes your app's Client ID and secret.");
  const body = await readJson(c, z.object({ api_key: z.string().trim().min(10).max(500) }));
  const admin = adminClient(c.env);
  if (provider === "stripe") {
    const { settled, ...connected } = await connectStripe(c.env, admin, { companyId: c.var.companyId, userId: c.var.userId, key: body.api_key, baseUrl: appUrl(c) });
    runInBackground(c, settled);
    return c.json({ provider, status: "connected", ...connected });
  }
  // fal.ai: checked against its free price list first, so a key pasted wrong says so now.
  if (provider === "fal") {
    const problem = await checkFalKey(body.api_key);
    if (problem) throw new HttpError(400, problem);
  }
  const { error } = await admin.from("integrations").upsert({
    company_id: c.var.companyId,
    provider,
    status: "connected",
    account_label: `Key ending ${body.api_key.slice(-4)}`,
    connected_by: c.var.userId,
    connected_at: new Date().toISOString(),
  });
  if (error) throw dbError(error);
  await saveSecret(c.env, admin, c.var.companyId, provider, { api_key: body.api_key });
  return c.json({ provider, status: "connected" });
});

/**
 * Sveltia CMS: check the website's editor at the address typed, then keep it, which puts Website in
 * the menu. A page that opens but doesn't say Sveltia or Decap answers 422, and can be kept `anyway`
 * (an editor bundled into the site's own scripts).
 */
apps.put("/apps/sveltia/site", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ address: z.string().trim().min(3, "Type your website's address.").max(500), anyway: z.boolean().default(false) }));
  try {
    const site = await checkSite(body.address, appUrl(c), { anyway: body.anyway });
    await saveWebsite(adminClient(c.env), c.var.companyId, site);
    return c.json({ website: site });
  } catch (error) {
    if (error instanceof WebsiteError) throw new HttpError(error.code === "no_editor" ? 422 : 400, error.message);
    throw error;
  }
});

/** Uninstall: Website leaves the menu. The website and its editor aren't touched. */
apps.delete("/apps/sveltia/site", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  await saveWebsite(adminClient(c.env), c.var.companyId, null);
  return c.json({ website: null });
});

// ---------------------------------------------------------------------------------------------
// AI helpers (use the company's own Anthropic key when it has one)
// ---------------------------------------------------------------------------------------------

apps.post("/ai/rewrite", requireUser, requireCompany(), async (c) => {
  const body = await readJson(
    c,
    z.object({
      text: z.string().trim().min(1).max(4000),
      instruction: z.string().max(300).default("Make this clear, friendly and professional. Keep it about the same length."),
    }),
  );
  const text = await complete(c.env, {
    apiKey: await companyAnthropicKey(c.env, adminClient(c.env), c.var.companyId),
    system:
      "You edit short messages a home-services business sends to its customers. Return only the rewritten message, " +
      "with no preamble. Never add prices, dates or promises that aren't in the original.",
    prompt: `Instruction: ${body.instruction}\n\nMessage:\n${body.text}`,
    effort: "low",
    maxTokens: 1500,
  });
  return c.json({ text });
});

/** Answer a question using only the company's SOPs, with numbered citations. */
apps.post("/kb/ask", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ question: z.string().trim().min(3).max(500) }));
  // Guides with any of the question's words, best matches first: a whole question rarely has every word in one guide.
  const { data, error } = await c.var.db.rpc("search_sops", { p_company: c.var.companyId, p_query: body.question, p_limit: 4, p_any: true });
  if (error) throw dbError(error);
  const hits = (data ?? []) as Array<{ id: string; title: string; body_text: string }>;
  if (!hits.length) return c.json({ answer: "I couldn't find a guide that covers that. Try different words, or ask the office.", sources: [] });

  const excerpts = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.body_text.slice(0, 6000)}`).join("\n\n");
  const answer = await complete(c.env, {
    apiKey: await companyAnthropicKey(c.env, adminClient(c.env), c.var.companyId),
    system:
      "You answer questions for a field-service crew using only the SOP excerpts provided. Cite sources inline as [1], [2]. " +
      "If the excerpts don't answer the question, say so plainly. Keep answers short and practical; safety steps come first.",
    prompt: `SOP excerpts:\n${excerpts}\n\nQuestion: ${body.question}`,
    effort: "low",
    maxTokens: 1500,
  });
  return c.json({ answer, sources: hits.map((h) => ({ id: h.id, title: h.title })) });
});
