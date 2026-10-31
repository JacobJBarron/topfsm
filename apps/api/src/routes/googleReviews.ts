/**
 * Google reviews on Marketing → Reviews (services/googleReviews.ts), for owners, admins and office
 * staff with the marketing area: whether Google Business Profile is connected and what's in the way
 * (GET /reviews/google, since only owners and admins read integrations), Sync now, replying (posted
 * publicly on Google), Suggest a reply with the company's Claude key, and matching a review to a
 * client by hand or undoing it. Replies, suggestions and syncing wait while Marketing is uninstalled.
 */
import { ADMINS, OFFICE } from "@crewtavo/core";
import { marketingOn } from "@crewtavo/core/marketing";
import { projectNumber, REPLY_MAX, type ReviewProblem } from "@crewtavo/core/reviews";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { catalogEntry } from "../integrations/registry";
import { appKeysOf, loadSecret } from "../integrations/tokens";
import { requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient } from "../lib/supabase";
import { companyAnthropicKey } from "../services/ai";
import {
  checkAccess,
  firstSyncProgress,
  liftReviewStop,
  loadReview,
  postReply,
  problemMessage,
  removeReply,
  reviewLinkOffer,
  suggestReply,
  syncCompany,
  type BusinessSettings,
} from "../services/googleReviews";

export const googleReviews = new Hono<AppEnv>();

type Ctx = Parameters<typeof param>[0];

const MARKETING_OFF_REPLIES = "Marketing is off, so replies can't be posted. An owner or admin can install it again in Apps.";

async function companySettings(c: Ctx) {
  const company = must(await c.var.db.from("companies").select("name, phone, email, settings").eq("id", c.var.companyId).maybeSingle());
  return { ...company, settings: (company.settings ?? {}) as Record<string, unknown> };
}

/** Uninstalled, Marketing posts nothing to Google and drafts nothing. */
async function requireMarketing(c: Ctx, message = MARKETING_OFF_REPLIES) {
  const company = await companySettings(c);
  if (!marketingOn(company.settings)) throw new HttpError(409, message);
  return company;
}

/**
 * The Reviews tab's view of Google: `state` is not_connected, disconnected (reviews kept), pick
 * (a location to pick), the problem in the way (approval, not_enabled, signin, location, error), or
 * ok. With the location, how far the first sync has got (only while it's coming in: nothing in the
 * way and Marketing on), Google's own average and count, and the review link Google gives, for
 * owners and admins to use.
 */
googleReviews.get("/reviews/google", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const admin = adminClient(c.env);
  const [row, sync, kept, company] = await Promise.all([
    admin.from("integrations").select("status, settings").match({ company_id: c.var.companyId, provider: "google_business" }).maybeSingle(),
    admin.from("review_syncs").select("*").eq("company_id", c.var.companyId).maybeSingle(),
    admin.from("reviews").select("id", { count: "exact", head: true }).eq("company_id", c.var.companyId).is("deleted_at", null),
    companySettings(c),
  ]);
  if (row.error) throw dbError(row.error);
  const integration = row.data;
  const s = sync.data;
  const business = (integration?.settings ?? {}) as BusinessSettings;
  const reviews = kept.count ?? 0;
  const secret = await loadSecret(c.env, admin, c.var.companyId, "google_business").catch(() => null);
  const own = appKeysOf(secret?.extra).client_id ?? null;
  const connected = integration?.status === "connected" || integration?.status === "error";
  let state: "not_connected" | "disconnected" | ReviewProblem | "ok";
  if (!connected) state = reviews ? "disconnected" : "not_connected";
  else if (integration!.status === "error") state = "signin";
  else if (s?.problem) state = s.problem as ReviewProblem;
  else state = s?.location_id && business.location === s.location_id ? "ok" : "pick";
  const problem = state !== "ok" && state !== "not_connected" && state !== "disconnected" ? state : null;
  const on = marketingOn(company.settings);
  return c.json({
    state,
    marketing_on: on,
    can_connect: ADMINS.includes(c.var.role) && c.var.permissions.includes("apps"),
    available: Boolean(catalogEntry("google_business")?.available(c.env) || own),
    location: connected && s?.location_id && business.location === s.location_id
      ? { id: s.location_id, title: business.title ?? null, address: business.address ?? null, maps_uri: business.maps_uri ?? null }
      : null,
    problem_detail: problem ? (s?.problem_detail ?? null) : null,
    problem_message: problem ? problemMessage(problem, s?.problem_detail ?? null, Boolean(own)) : null,
    next_sync_at: s?.next_sync_at ?? null,
    last_synced_at: s?.last_synced_at ?? null,
    first_synced_at: s?.first_synced_at ?? null,
    syncing: Boolean(s?.locked_until && Date.parse(s.locked_until) > Date.now()),
    progress: integration?.status === "connected" && on ? firstSyncProgress(s, business) : null,
    google: { average_rating: s?.average_rating ?? null, total_reviews: s?.total_reviews ?? null },
    reviews,
    review_link: connected ? reviewLinkOffer(company.settings, business) : { current: null, suggested: null },
    own_app: Boolean(own),
    project_number: projectNumber(own ?? c.env.GOOGLE_CLIENT_ID),
  });
});

/**
 * Sync now: Google is asked again right away, at most once every two minutes. Not while Google
 * hasn't approved access, or its APIs aren't on: Check again in Apps asks about that.
 */
googleReviews.post("/reviews/google/sync", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  await requireMarketing(c, "Marketing is off, so reviews aren't brought in. An owner or admin can install it again in Apps.");
  const admin = adminClient(c.env);
  const [row, sync] = await Promise.all([
    admin.from("integrations").select("status").match({ company_id: c.var.companyId, provider: "google_business" }).maybeSingle(),
    admin.from("review_syncs").select("locked_until, problem").eq("company_id", c.var.companyId).maybeSingle(),
  ]);
  if (row.data?.status !== "connected") throw new HttpError(409, "Connect Google Business Profile in Apps first.");
  if (sync.data?.problem === "approval" || sync.data?.problem === "not_enabled") {
    throw new HttpError(409, "Google isn't letting Crewtavo in yet, so there's nothing to bring in. Crewtavo checks again every 6 hours.");
  }
  if (sync.data?.locked_until && Date.parse(sync.data.locked_until) > Date.now()) throw new HttpError(409, "Reviews are being brought in right now.");
  if (!(await allow(c.env, `review-sync:${c.var.companyId}`, 1, 120))) throw new HttpError(429, "Google was checked a moment ago. Try again in a couple of minutes.");
  // A problem that waits for someone (a location to pick or fix) is asked about again first.
  const waiting = sync.data?.problem === "location" || sync.data?.problem === "pick";
  runInBackground(c, (waiting ? checkAccess(c.env, admin, c.var.companyId) : Promise.resolve(null)).then(() => syncCompany(c.env, admin, c.var.companyId)));
  return c.json({ status: "running" }, 202);
});

const reply = z.object({ comment: z.string().trim().min(1, "Write a reply first.").max(REPLY_MAX, `Google takes replies of up to ${REPLY_MAX.toLocaleString("en-US")} characters.`) });

/** Posts or replaces the reply on Google, where everyone can read it. */
googleReviews.put("/reviews/:id/reply", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, reply);
  await requireMarketing(c);
  return c.json({ review: await postReply(c.env, adminClient(c.env), c.var.companyId, id, body.comment, c.var.userId) });
});

googleReviews.delete("/reviews/:id/reply", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  await requireMarketing(c);
  return c.json({ review: await removeReply(c.env, adminClient(c.env), c.var.companyId, id) });
});

/** Suggest a reply (or, with `draft`, Rewrite): a draft from Claude to read and change. Nothing is posted. */
googleReviews.post("/reviews/:id/suggest", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ draft: z.string().max(REPLY_MAX).optional(), instruction: z.string().max(300).optional() }));
  const company = await requireMarketing(c, "Marketing is off, so replies can't be drafted. An owner or admin can install it again in Apps.");
  const admin = adminClient(c.env);
  const review = await loadReview(admin, c.var.companyId, id);
  const text = await suggestReply(c.env, admin, {
    apiKey: await companyAnthropicKey(c.env, admin, c.var.companyId),
    company: { name: company.name, phone: company.phone, email: company.email },
    review,
    draft: body.draft,
    instruction: body.instruction,
  });
  return c.json({ text });
});

/**
 * Matches a review to a client by hand, or (client_id null) "Not this client". The client it was
 * matched to before can be asked again, so their stopped reminders come back where they still can.
 */
googleReviews.put("/reviews/:id/client", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ client_id: uuid.nullable() }));
  const admin = adminClient(c.env);
  const { data, error } = await admin.rpc("set_review_client", { p_company: c.var.companyId, p_review: id, p_client: body.client_id as string, p_by: c.var.userId });
  if (error) {
    if (error.code === "P0002") throw new HttpError(404, error.message.includes("client") ? "That client isn't here." : "That review isn't here. It may have been removed from Google.");
    throw dbError(error);
  }
  const lifted = (data as { lifted_client?: string | null } | null)?.lifted_client ?? null;
  const reminders = lifted ? await liftReviewStop(admin, c.var.companyId, lifted) : 0;
  return c.json({ client_id: body.client_id, lifted_client: lifted, reminders });
});
