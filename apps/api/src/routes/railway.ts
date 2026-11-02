/**
 * Crewtavo's connection to its own Railway project (services/railway.ts), made in setup or from
 * Settings → Web address or Hosting.
 *   POST   /api/railway/connect   Login with Railway: returns Railway's consent page
 *   GET    /api/railway/callback  Railway sends the browser back here
 *   POST   /api/railway/token     or a project token instead
 *   DELETE /api/railway           forget the access
 *   POST   /api/railway/setup     the setup step is done or skipped
 *   POST   /api/railway/later     "Ask me tomorrow" about connecting
 *   GET    /api/railway/usage     what Railway charges, for Settings → Hosting (?fresh=1 to ask Railway now)
 *   GET    /api/railway/uploads   the largest file the storage service takes
 *   POST   /api/railway/uploads   raise it to 200 MB and restart storage
 *   GET    /api/railway/storage   where photos and files are kept (the volume or a bucket), and a move's progress (?fresh=1 to ask Railway now)
 *   POST   /api/railway/storage/move       move them into a Railway bucket, or carry on with a move waiting on Railway
 *   POST   /api/railway/storage/move-back  move them back to the volume
 * Only owners and admins, only in an instance on Railway.
 */
import { ADMINS } from "@crewtavo/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../env";
import { platformOf } from "../lib/address";
import { requireCompany, requireUser } from "../lib/auth";
import { randomId, signToken, verifyToken } from "../lib/crypto";
import { appUrl, HttpError, readJson } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { authorizationUrl, exchangeCode, pkce, RailwayError } from "../integrations/railway";
import { addressOverview, adoptRailway, stopAutomatic } from "../services/address";
import { forgetHosting, hostingOverview } from "../services/hosting";
import { connectRailwayLater, forgetRailway, forgetRefusedClient, noteRailwayError, railwayClient, saveRailwayAccess, setRailwaySetup } from "../services/railway";
import { startStorageMove, storageOverview } from "../services/storageBucket";
import { keepStorageDefault } from "../services/storageUsage";
import { raiseUploadLimit, uploadLimit } from "../services/uploads";

export const railway = new Hono<AppEnv>();

const COOKIE = "crewtavo_railway";
const COOKIE_PATH = "/api/railway";
const callbackUrl = (base: string) => `${base}${COOKIE_PATH}/callback`;

const onRailway = createMiddleware<AppEnv>(async (c, next) => {
  if (c.env.CREWTAVO_SINGLE_COMPANY !== "1" || platformOf(c.env) !== "railway") throw new HttpError(404, "This Crewtavo doesn't run on Railway.");
  await next();
});
const admins = [onRailway, requireUser, requireCompany(ADMINS, "settings")] as const;

/** Where the browser goes back to: the setup step, Settings → Web address, or Settings → Hosting. */
const RETURNS = { setup: "/", settings: "/settings?tab=address", hosting: "/settings?tab=hosting" } as const;
type ReturnTo = keyof typeof RETURNS;

/** Step 1: Railway's consent page. The signed state names who asked; the cookie holds the PKCE verifier. */
railway.post("/railway/connect", ...admins, async (c) => {
  const { return_to } = await readJson(c, z.object({ return_to: z.enum(["setup", "settings", "hosting"]).default("settings") }));
  const admin = adminClient(c.env);
  const { data: company } = await admin.from("companies").select("name").eq("id", c.var.companyId).maybeSingle();
  const client = await railwayClient(c.env, admin, c.var.companyId, callbackUrl(appUrl(c)), `Crewtavo for ${company?.name ?? "your business"}`).catch(plain);
  const { verifier, challenge } = await pkce();
  const nonce = randomId();
  const state = await signToken(c.env, { company: c.var.companyId, user: c.var.userId, purpose: "railway", return_to, nonce, exp: Math.floor(Date.now() / 1000) + 600 });
  setCookie(c, COOKIE, `${nonce}.${verifier}`, { httpOnly: true, secure: true, sameSite: "Lax", path: COOKIE_PATH, maxAge: 600 });
  return c.json({ authorization_url: authorizationUrl(client, state, challenge) });
});

/** Step 2: Railway sends the browser back. No bearer token: who asked comes from the signed state. */
railway.get("/railway/callback", onRailway, async (c) => {
  const query = c.req.query();
  const state = query.state
    ? await verifyToken<{ company: string; user: string; purpose: string; return_to: ReturnTo; nonce: string; exp: number }>(c.env, query.state)
    : null;
  // Only a code goes in the address bar; the screen shows Railway's reason from GET /api/address.
  const back = (result: "connected" | "expired" | "cancelled" | "error") => {
    const path = RETURNS[state?.return_to ?? "settings"] ?? RETURNS.settings;
    return c.redirect(`${appUrl(c)}${path}${path.includes("?") ? "&" : "?"}railway=${result}`);
  };
  const [nonce, verifier] = (getCookie(c, COOKIE) ?? "").split(".");
  deleteCookie(c, COOKIE, { path: COOKIE_PATH });
  if (!state || state.purpose !== "railway" || !nonce || !verifier || nonce !== state.nonce) return back("expired");
  if (query.error || !query.code) return back("cancelled");

  const admin = adminClient(c.env);
  try {
    const client = await railwayClient(c.env, admin, state.company, callbackUrl(appUrl(c)), "Crewtavo");
    const access = await exchangeCode(client, query.code, verifier);
    await saveRailwayAccess(c.env, admin, state.company, state.user, access);
    forgetHosting();
    await adoptRailway(c.env, admin, state.company, access);
    return back("connected");
  } catch (error) {
    if (!(error instanceof RailwayError)) console.error("Railway sign-in failed", error);
    await forgetRefusedClient(admin, state.company, error).catch(() => undefined);
    await noteRailwayError(admin, state.company, error instanceof RailwayError ? error.message : "Railway sign-in didn't work. Try again.").catch(() => undefined);
    return back("error");
  }
});

railway.post("/railway/token", ...admins, async (c) => {
  const { token } = await readJson(c, z.object({ token: z.string().trim().min(10, "Paste the whole token.").max(400) }));
  const admin = adminClient(c.env);
  const access = { method: "token" as const, token };
  await saveRailwayAccess(c.env, admin, c.var.companyId, c.var.userId, access).catch(plain);
  forgetHosting();
  await adoptRailway(c.env, admin, c.var.companyId, access);
  return c.json(await addressOverview(c.env, admin, c.var.companyId));
});

railway.delete("/railway", ...admins, async (c) => {
  const admin = adminClient(c.env);
  await forgetRailway(c.env, admin, c.var.companyId);
  forgetHosting();
  // With Railway gone there's nothing to follow, so the default storage limit goes too.
  await keepStorageDefault(c.env, admin, c.var.companyId, { access: null, force: true });
  await stopAutomatic(admin, c.var.companyId);
  return c.json(await addressOverview(c.env, admin, c.var.companyId));
});

/** The largest file this Crewtavo takes, and raising it to 200 MB for plan sets (services/uploads.ts). */
railway.get("/railway/uploads", ...admins, async (c) => c.json(await uploadLimit(c.env, adminClient(c.env), c.var.companyId).catch(plain)));
railway.post("/railway/uploads", ...admins, async (c) => c.json(await raiseUploadLimit(c.env, adminClient(c.env), c.var.companyId).catch(plain)));

/** Settings → Hosting → Files storage: the volume or a Railway bucket, and moving between them (services/storageBucket.ts). */
railway.get("/railway/storage", ...admins, async (c) => c.json(await storageOverview(c.env, adminClient(c.env), c.var.companyId, { fresh: c.req.query("fresh") === "1" }).catch(plain)));
railway.post("/railway/storage/move", ...admins, async (c) => c.json(await startStorageMove(c.env, adminClient(c.env), c.var.companyId, "to_bucket").catch(plain)));
railway.post("/railway/storage/move-back", ...admins, async (c) => c.json(await startStorageMove(c.env, adminClient(c.env), c.var.companyId, "to_volume").catch(plain)));

/** The setup step after "Set up your business" is over, either way. */
railway.post("/railway/setup", ...admins, async (c) => {
  const { status } = await readJson(c, z.object({ status: z.enum(["done", "skipped"]) }));
  await setRailwaySetup(adminClient(c.env), c.var.companyId, status);
  return c.json({ ok: true });
});

/** The owner can't connect Railway right now: the app asks again tomorrow (services/railway.ts). */
railway.post("/railway/later", ...admins, async (c) => {
  await connectRailwayLater(adminClient(c.env), c.var.companyId);
  return c.json({ ok: true });
});

/** Settings → Hosting: this Crewtavo's Railway usage, plan and trial (services/hosting.ts). */
railway.get("/railway/usage", ...admins, async (c) =>
  c.json(await hostingOverview(c.env, adminClient(c.env), c.var.companyId, { fresh: c.req.query("fresh") === "1" }).catch(plain)),
);

/** Railway's reasons are written for people; anything else stays generic. */
function plain(error: unknown): never {
  if (error instanceof RailwayError) throw new HttpError(400, error.message);
  throw error;
}
