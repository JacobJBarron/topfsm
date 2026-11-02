/**
 * Marketing (Apps → Crewtavo - Marketing): email campaigns, asking clients for reviews and
 * referrals, replying to Google reviews, social posts, and promo codes. Each runs the checks the
 * Marketing screens run (services/campaigns.ts, reviews.ts, referrals.ts, googleReviews.ts,
 * social.ts), with the same roles. Nothing here takes or charges a payment: a promo code is a
 * discount on a quote or job, in an area of its own that "Full access, no money" leaves out.
 */
import { audienceKeys, marketingOn, OFFICE, REPLY_MAX, SALES } from "@crewtavo/core";
import { z } from "zod";
import { adminClient } from "../lib/supabase";
import { startCampaign, stopCampaign } from "../services/campaigns";
import { postReply, removeReply } from "../services/googleReviews";
import { sendReferralAsk } from "../services/referrals";
import { sendReviewRequest } from "../services/reviews";
import { checkPost, MARKETING_OFF_POSTS, postBody } from "../services/social";
import { changed, companyArg, friendly, one, requireRole, rows, tool, type ToolContext } from "./tool";

/** The Marketing screens are the office's, with the Marketing area of their role. */
const marketer = (ctx: ToolContext) => requireRole(ctx, OFFICE, "marketing");
const baseUrl = (ctx: ToolContext) => (ctx.env.APP_URL ?? ctx.origin).replace(/\/$/, "");

/** Uninstalled, Marketing sends, posts and replies nothing. */
async function requireOn(ctx: ToolContext, message: string) {
  const company = await one(ctx.db.from("companies").select("settings").eq("id", ctx.companyId).maybeSingle(), "The company");
  if (!marketingOn(company.settings as Record<string, unknown> | null)) throw new Error(message);
}

const audience = z
  .object({
    statuses: z.array(z.enum(["lead", "active", "archived"])).optional().describe("Client statuses; any status when left out."),
    tags_any: z.array(z.string().max(60)).max(20).optional().describe("Clients with any of these tags."),
    tags_none: z.array(z.string().max(60)).max(20).optional().describe("Leaves out clients with any of these tags."),
    no_visit_days: z.number().int().min(1).max(3650).nullable().optional().describe("Only clients with no visit in this many days."),
    cities: z.array(z.string().max(100)).max(50).optional(),
    services: z.array(z.string().max(120)).max(50).optional().describe("Services on their past jobs, as named on the price list."),
    recurring: z.enum(["yes", "no"]).optional().describe("Has an active recurring job, or doesn't."),
    recurring_ending: z.boolean().optional().describe("An active recurring job ends in the next 30 days."),
  })
  .describe("Who gets it. Clients without an email address, or who unsubscribed, never do.");

const CAMPAIGN_FIELDS = "id, kind, name, status, subject, scheduled_at, started_at, finished_at, recipients_count, sent_count, failed_count, created_at";

export const marketingTools = {
  marketing_summary: tool({
    description: "How marketing is doing: whether Marketing is installed, campaigns, review requests and reviews, referrals and promo codes, as on the Marketing page.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      marketer(ctx);
      const [company, summary, reviews] = await Promise.all([
        one(ctx.db.from("companies").select("settings").eq("id", ctx.companyId).maybeSingle(), "The company"),
        ctx.db.rpc("marketing_summary", { p_company_id: ctx.companyId }),
        ctx.db.rpc("review_stats", { p_company: ctx.companyId }),
      ]);
      return { installed: marketingOn(company.settings as Record<string, unknown> | null), summary: summary.data, reviews: reviews.data };
    },
  }),

  // Campaigns --------------------------------------------------------------------------------

  list_campaigns: tool({
    description:
      "Email campaigns, newest first, with how each did (sent, opened, clicked, work booked). With campaign_id, that one in full: its subject, body and audience. Automated ones (kind automated) send by themselves and are changed in Crewtavo.",
    input: z.object({ campaign_id: z.uuid().optional(), ...companyArg }),
    run: async (ctx, a) => {
      marketer(ctx);
      const results = (await ctx.db.rpc("campaign_results", { p_company: ctx.companyId, ...(a.campaign_id && { p_campaign: a.campaign_id }) })).data;
      if (a.campaign_id) {
        const campaign = await one(ctx.db.from("campaigns").select(`${CAMPAIGN_FIELDS}, body, audience`).eq("id", a.campaign_id).eq("company_id", ctx.companyId).maybeSingle(), "That campaign");
        return { campaign, results };
      }
      return { campaigns: await rows(ctx.db.from("campaigns").select(CAMPAIGN_FIELDS).eq("company_id", ctx.companyId).order("created_at", { ascending: false }).limit(50)), results };
    },
  }),
  save_campaign: tool({
    description:
      "Write a campaign email as a draft (no campaign_id), or change a draft (with campaign_id; send only what changes, and the whole audience if it changes). The body is plain text with blank lines between paragraphs and may use {{client.first_name}}, {{company.name}}, {{company.phone}}, and {{link}} alone on its own line, which becomes a Request work button. Says how many clients the audience reaches now. Nothing is sent: send_campaign sends it.",
    input: z.object({
      campaign_id: z.uuid().optional(),
      name: z.string().trim().min(1).max(120).optional().describe('Only the office sees it. Default "Untitled campaign".'),
      subject: z.string().max(200).optional(),
      body: z.string().max(20000).optional(),
      audience: audience.optional(),
      ...companyArg,
    }),
    area: "marketing",
    run: async (ctx, a) => {
      marketer(ctx);
      const fields = { ...(a.name && { name: a.name }), ...(a.subject !== undefined && { subject: a.subject }), ...(a.body !== undefined && { body: a.body }), ...(a.audience && { audience: audienceKeys(a.audience) as never }) };
      const [saved] = a.campaign_id
        ? await rows(ctx.db.from("campaigns").update(fields).eq("id", a.campaign_id).eq("company_id", ctx.companyId).eq("status", "draft").neq("kind", "automated").select("id, audience"))
        : [await one(ctx.db.from("campaigns").insert({ name: "Untitled campaign", ...fields, company_id: ctx.companyId }).select("id, audience").single(), "The campaign")];
      if (!saved) throw new Error("Only a draft campaign can be changed (stop a scheduled one with cancel_campaign first). Automated campaigns are changed in Crewtavo.");
      const reach = await rows(ctx.db.rpc("campaign_audience", { p_company_id: ctx.companyId, p_audience: saved.audience }));
      return { campaign_id: saved.id, status: "draft", audience_count: reach.length };
    },
  }),
  send_campaign: tool({
    description:
      "Send a draft campaign to everyone in its audience now (it starts going out within a minute), or at scheduled_at. This emails clients: tell the person how many it reaches (save_campaign says) and confirm first. Up to 5,000 recipients.",
    input: z.object({ campaign_id: z.uuid(), scheduled_at: z.iso.datetime({ offset: true }).optional(), ...companyArg }),
    area: "marketing",
    run: async (ctx, a) => {
      marketer(ctx);
      return startCampaign(ctx.env, ctx.db, ctx.companyId, a.campaign_id, a.scheduled_at);
    },
  }),
  cancel_campaign: tool({
    description: "Stop a campaign: a scheduled one goes back to draft; one that's sending stops where it is (what's sent stays sent).",
    input: z.object({ campaign_id: z.uuid(), ...companyArg }),
    area: "marketing",
    run: async (ctx, a) => {
      marketer(ctx);
      return stopCampaign(ctx.env, ctx.db, ctx.companyId, a.campaign_id);
    },
  }),
  delete_campaign: tool({
    description: "Delete a draft, sent or stopped campaign and its results. Stop a scheduled or sending one first.",
    input: z.object({ campaign_id: z.uuid(), ...companyArg }),
    area: "marketing",
    destructive: true,
    run: async (ctx, a) => {
      marketer(ctx);
      const gone = await rows(ctx.db.from("campaigns").delete().eq("id", a.campaign_id).eq("company_id", ctx.companyId).in("status", ["draft", "sent", "cancelled"]).neq("kind", "automated").select("id"));
      if (!gone.length) throw new Error("That campaign isn't here, or it's scheduled, sending or automated. Stop a scheduled or sending one with cancel_campaign first.");
      return { deleted: true };
    },
  }),

  // Reviews and referrals ----------------------------------------------------------------------

  request_review: tool({
    description:
      "Ask a client for a review now by email, text or both, whenever they were last asked; channel link only makes their review link to share. Clients who opted out or are archived aren't asked. Confirm with the person first.",
    input: z.object({ client_id: z.uuid(), job_id: z.uuid().optional().describe("The job it's about."), channel: z.enum(["email", "sms", "both", "link"]).default("email"), ...companyArg }),
    area: "marketing",
    run: async (ctx, a) => {
      requireRole(ctx, SALES);
      const client = await one(
        ctx.db.from("clients").select("id, display_name, email, phone, status, review_opt_out, marketing_opt_out, sms_opt_out_at, reviewed_at").eq("id", a.client_id).eq("company_id", ctx.companyId).maybeSingle(),
        "That client",
      );
      return sendReviewRequest(ctx.env, adminClient(ctx.env), { companyId: ctx.companyId, client, jobId: a.job_id, channel: a.channel, baseUrl: baseUrl(ctx), automatic: false, createdBy: ctx.userId });
    },
  }),
  request_referral: tool({
    description: "Email a client asking them to refer friends, with their referral link and the business's reward. Clients who opted out of marketing or are archived aren't asked. Confirm with the person first.",
    input: z.object({ client_id: z.uuid(), ...companyArg }),
    area: "marketing",
    run: async (ctx, a) => {
      requireRole(ctx, SALES);
      const client = await one(ctx.db.from("clients").select("id, display_name, email, status, marketing_opt_out").eq("id", a.client_id).eq("company_id", ctx.companyId).maybeSingle(), "That client");
      return sendReferralAsk(ctx.env, adminClient(ctx.env), { companyId: ctx.companyId, client, baseUrl: baseUrl(ctx), automatic: false, createdBy: ctx.userId });
    },
  }),
  list_reviews: tool({
    description: "Google reviews of the business, newest first (25 at a time), with any reply and the client each is matched to. unanswered leaves out ones already replied to.",
    input: z.object({ unanswered: z.boolean().optional(), max_rating: z.number().int().min(1).max(5).optional().describe("Only reviews of this many stars or fewer."), offset: z.number().int().min(0).default(0), ...companyArg }),
    run: async (ctx, a) => {
      marketer(ctx);
      let query = ctx.db
        .from("reviews")
        .select("id, rating, reviewer_name, reviewer_anonymous, comment, posted_at, reply_comment, reply_updated_at, client_id")
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null);
      if (a.unanswered) query = query.is("reply_comment", null);
      if (a.max_rating) query = query.lte("rating", a.max_rating);
      return rows(query.order("posted_at", { ascending: false }).range(a.offset, a.offset + 24));
    },
  }),
  reply_to_review: tool({
    description: `Post a reply to a Google review, or replace the one there. It's public on Google: show the person the words and confirm first. Up to ${REPLY_MAX} characters.`,
    input: z.object({ review_id: z.uuid(), comment: z.string().trim().min(1).max(REPLY_MAX), ...companyArg }),
    area: "marketing",
    run: async (ctx, a) => {
      marketer(ctx);
      await requireOn(ctx, "Marketing is off, so replies can't be posted. An owner or admin can install it again in Apps.");
      const review = await postReply(ctx.env, adminClient(ctx.env), ctx.companyId, a.review_id, a.comment, ctx.userId);
      return { review_id: a.review_id, reply: review?.reply_comment ?? a.comment };
    },
  }),
  remove_review_reply: tool({
    description: "Take the business's reply off a Google review.",
    input: z.object({ review_id: z.uuid(), ...companyArg }),
    area: "marketing",
    destructive: true,
    run: async (ctx, a) => {
      marketer(ctx);
      await requireOn(ctx, "Marketing is off, so replies can't be changed. An owner or admin can install it again in Apps.");
      await removeReply(ctx.env, adminClient(ctx.env), ctx.companyId, a.review_id);
      return { removed: true };
    },
  }),

  // Social posts -----------------------------------------------------------------------------

  list_social_photos: tool({
    description: "Job photos marked OK to share, newest first (48), for a social post. job_id narrows them to one job's.",
    input: z.object({ job_id: z.uuid().optional(), ...companyArg }),
    run: async (ctx, a) => {
      marketer(ctx);
      return rows(ctx.db.rpc("social_photos", { p_company: ctx.companyId, p_limit: 48, ...(a.job_id && { p_job: a.job_id }) }));
    },
  }),
  list_social_posts: tool({
    description: "Social posts to Facebook, Instagram and Google: upcoming (drafts, scheduled, posting) or past (posted, failed, cancelled), with how each network went.",
    input: z.object({ list: z.enum(["upcoming", "past"]).default("upcoming"), ...companyArg }),
    run: async (ctx, a) => {
      marketer(ctx);
      return rows(
        ctx.db
          .from("social_posts")
          .select("id, source, review_id, attachment_ids, caption, networks, status, scheduled_for, automatic, note, finished_at, created_at, results:social_post_networks(network, status, permalink, error, posted_at)")
          .eq("company_id", ctx.companyId)
          .in("status", a.list === "upcoming" ? ["draft", "scheduled", "posting"] : ["posted", "partly_posted", "check", "failed", "cancelled"])
          .order(a.list === "upcoming" ? "scheduled_for" : "created_at", { ascending: a.list === "upcoming" })
          .limit(25),
      );
    },
  }),
  create_social_post: tool({
    description:
      "Make a social post: shared job photos (list_social_photos), a 4 or 5-star Google review as a picture card (list_reviews), or just words. when is draft, now (posts within a minute) or {at} 5 minutes to 90 days away. Posting is public: show the person the caption and confirm first. A caption can't name a client.",
    input: postBody.omit({ caption_by: true }).extend({ ...companyArg }),
    area: "marketing",
    run: async (ctx, { company_id: _, ...body }) => {
      marketer(ctx);
      await requireOn(ctx, MARKETING_OFF_POSTS);
      const post = { ...body, caption_by: "ai" as const };
      const { row, warnings } = await checkPost({ env: ctx.env, companyId: ctx.companyId }, post);
      // Only the server writes posts; a due one posts with the every-minute task.
      const made = await one(
        adminClient(ctx.env).from("social_posts").insert({ ...row, company_id: ctx.companyId, caption_by: "ai", created_by: ctx.userId, updated_by: ctx.userId }).select("id, status, scheduled_for").single(),
        "The post",
      );
      return { post: made, warnings };
    },
  }),
  cancel_social_post: tool({
    description: "Cancel a scheduled post, or what's still to go of one that's posting.",
    input: z.object({ post_id: z.uuid(), ...companyArg }),
    area: "marketing",
    run: async (ctx, a) => {
      marketer(ctx);
      const { data, error } = await adminClient(ctx.env).rpc("cancel_social_post", { p_company: ctx.companyId, p_post: a.post_id, p_by: ctx.userId });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("This post can't be cancelled now.");
      return { status: data };
    },
  }),
  delete_social_post: tool({
    description: "Delete a draft social post.",
    input: z.object({ post_id: z.uuid(), ...companyArg }),
    area: "marketing",
    destructive: true,
    run: async (ctx, a) => {
      marketer(ctx);
      const { data, error } = await adminClient(ctx.env).from("social_posts").delete().eq("company_id", ctx.companyId).eq("id", a.post_id).eq("status", "draft").select("id");
      if (error) throw new Error(error.message);
      if (!data?.length) throw new Error("Only drafts can be deleted. Cancel a scheduled post with cancel_social_post.");
      return { deleted: true };
    },
  }),

  // Promo codes --------------------------------------------------------------------------------

  list_promo_codes: tool({
    description: "Promo codes clients and the office can put on a quote or job, with how often each has been used and how much it took off.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      const [codes, usage] = await Promise.all([
        rows(ctx.db.from("promo_codes").select("*").eq("company_id", ctx.companyId).order("created_at", { ascending: false })),
        rows(ctx.db.rpc("promo_code_usage", { p_company: ctx.companyId })),
      ]);
      const used = new Map(usage.map((u) => [u.promo_code_id, u]));
      return codes.map((c) => ({ ...c, uses: used.get(c.id)?.uses ?? 0, discounted: used.get(c.id)?.discounted ?? 0 }));
    },
  }),
  save_promo_code: tool({
    description:
      "Make a promo code (no promo_code_id) or change one (with it; send only what changes). A percent or amount off, from a minimum subtotal, between dates, up to max_uses in all. Jobs already using a code keep the every_visit rule they started with. Set active false to pause it.",
    input: z.object({
      promo_code_id: z.uuid().optional(),
      code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,24}$/, "3 to 24 letters, numbers or dashes.").optional().describe("Needed for a new one."),
      description: z.string().trim().max(120).nullable().optional().describe('Shown to clients, like "Spring sealcoating special".'),
      kind: z.enum(["percent", "amount"]).optional().describe("Needed for a new one."),
      value: z.number().positive().max(1e6).optional().describe("Needed for a new one: the percent (up to 100) or the dollars off."),
      min_subtotal: z.number().min(0).max(1e8).optional(),
      starts_on: z.iso.date().nullable().optional(),
      ends_on: z.iso.date().nullable().optional(),
      max_uses: z.number().int().positive().nullable().optional(),
      once_per_client: z.boolean().optional().describe("Default true."),
      new_clients_only: z.boolean().optional(),
      every_visit: z.boolean().optional().describe("On recurring work: off every visit, not only the first invoice."),
      active: z.boolean().optional(),
      ...companyArg,
    }),
    area: "promos",
    run: async (ctx, { promo_code_id, company_id: _, ...a }) => {
      if (a.kind === "percent" && a.value !== undefined && a.value > 100) throw new Error("A percent off can't be more than 100.");
      const row = {
        ...a,
        ...(a.value !== undefined && { value: Math.round(a.value * 100) / 100 }),
        // New clients only means once each, as on the promo code form.
        ...(a.new_clients_only && { once_per_client: true }),
      };
      if (!promo_code_id && (!a.code || !a.kind || a.value === undefined)) throw new Error("A new promo code needs a code, a kind and a value.");
      const { data, error } = promo_code_id
        ? await ctx.db.from("promo_codes").update(row).eq("id", promo_code_id).eq("company_id", ctx.companyId).select("id")
        : await ctx.db.from("promo_codes").insert({ ...row, code: a.code!, kind: a.kind!, value: row.value!, company_id: ctx.companyId }).select("id");
      if (error?.code === "23505") throw new Error(`You already have a code called ${a.code}.`);
      if (error) throw new Error(friendly(error.message));
      if (!data?.length) throw new Error("That promo code isn't here (or you can't change it).");
      return { promo_code_id: data[0].id, saved: true };
    },
  }),
  delete_promo_code: tool({
    description: "Delete a promo code. To stop new uses but keep its history, save it with active false instead.",
    input: z.object({ promo_code_id: z.uuid(), ...companyArg }),
    area: "promos",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("promo_codes").delete().eq("id", a.promo_code_id).eq("company_id", ctx.companyId).select("id"), "That promo code");
      return { deleted: true };
    },
  }),
};
