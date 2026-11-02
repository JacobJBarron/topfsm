/** Campaigns (send, schedule, test, AI drafts), review requests and referral links. */
import { OFFICE, SALES } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { kickCampaign } from "../lib/background";
import { requireCompany, requireUser } from "../lib/auth";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { appUrl, dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { clientLink } from "../lib/links";
import { emailReady, sendEmail } from "../lib/notify";
import { adminClient } from "../lib/supabase";
import { renderTemplate } from "@crewtavo/core";
import { companyAnthropicKey, complete } from "../services/ai";
import { companyAddress } from "../services/automations";
import { logoImage } from "../services/logo";
import { sendReviewRequest } from "../services/reviews";

export const marketing = new Hono<AppEnv>();

const requireEmail = async (c: Parameters<typeof appUrl>[0]) => {
  if (!(await emailReady(c.env, c.var.companyId))) throw new HttpError(501, "Email isn't connected yet, so campaigns can't be sent. An admin can connect it in Settings → Email.");
};

async function loadCampaign(c: Parameters<typeof appUrl>[0]) {
  return must(
    await c.var.db.from("campaigns").select("id, status, name, subject, body, audience, scheduled_at").eq("id", param(c, "id")).eq("company_id", c.var.companyId).maybeSingle(),
    "Campaign not found.",
  );
}

/** Send now, or schedule: snapshots the audience so later edits to clients don't change who gets it. */
marketing.post("/campaigns/:id/send", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  await requireEmail(c);
  const body = await readJson(c, z.object({ scheduled_at: z.iso.datetime({ offset: true }).optional() }));
  const campaign = await loadCampaign(c);
  if (campaign.status !== "draft") throw new HttpError(409, "This campaign has already been sent or scheduled.");
  if (!campaign.subject.trim()) throw new HttpError(400, "Add a subject line first.");
  if (campaign.body.trim().length < 10) throw new HttpError(400, "Write the email before sending it.");
  if (body.scheduled_at && Date.parse(body.scheduled_at) < Date.now() - 60_000) throw new HttpError(400, "Pick a time in the future.");

  const audience = must(await c.var.db.rpc("campaign_audience", { p_company_id: c.var.companyId, p_audience: campaign.audience }));
  if (!audience.length) throw new HttpError(400, "No one matches this audience. Clients need an email address and must not have unsubscribed.");
  if (audience.length > 5000) throw new HttpError(400, "Campaigns are limited to 5,000 recipients. Narrow the audience.");

  const admin = adminClient(c.env);
  const { error } = await admin.from("campaign_recipients").upsert(
    audience.map((a) => ({ company_id: c.var.companyId, campaign_id: campaign.id, client_id: a.client_id, email: a.email, name: a.display_name })),
    { onConflict: "campaign_id,email", ignoreDuplicates: true },
  );
  if (error) throw dbError(error);
  const scheduled = Boolean(body.scheduled_at && Date.parse(body.scheduled_at) > Date.now() + 60_000);
  const { data: started, error: updateError } = await admin
    .from("campaigns")
    .update({
      status: scheduled ? "scheduled" : "sending",
      scheduled_at: scheduled ? body.scheduled_at : new Date().toISOString(),
      started_at: scheduled ? null : new Date().toISOString(),
      recipients_count: audience.length,
    })
    .eq("id", campaign.id)
    .eq("status", "draft")
    .select("id");
  if (updateError) throw dbError(updateError);
  // Only the request that moved it out of draft starts sending (a double-clicked Send doesn't).
  if (!started?.length) throw new HttpError(409, "This campaign has already been sent or scheduled.");
  if (!scheduled) kickCampaign(c, campaign.id);
  return c.json({ status: scheduled ? "scheduled" : "sending", recipients: audience.length });
});

marketing.post("/campaigns/:id/cancel", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const campaign = await loadCampaign(c);
  if (!["scheduled", "sending"].includes(campaign.status)) throw new HttpError(409, "Only scheduled or sending campaigns can be stopped.");
  const admin = adminClient(c.env);
  // A scheduled campaign goes back to draft so it can be edited; a sending one stops where it is.
  if (campaign.status === "scheduled") {
    await admin.from("campaign_recipients").delete().eq("campaign_id", campaign.id);
    await admin.from("campaigns").update({ status: "draft", scheduled_at: null, recipients_count: 0 }).eq("id", campaign.id);
    return c.json({ status: "draft" });
  }
  // Stopped first: a run partway through its batch checks this before each email.
  await admin.from("campaigns").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", campaign.id);
  await admin.from("campaign_recipients").update({ status: "skipped", error: "Campaign stopped" }).eq("campaign_id", campaign.id).in("status", ["pending", "sending"]);
  return c.json({ status: "cancelled" });
});

/** Send yourself a test copy. */
marketing.post("/campaigns/:id/test", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  await requireEmail(c);
  const body = await readJson(c, z.object({ to: z.email().optional() }));
  const campaign = await loadCampaign(c);
  const me = must(await c.var.db.from("profiles").select("email, full_name").eq("user_id", c.var.userId).maybeSingle());
  const to = body.to ?? me.email;
  if (!to || !isEmail(to)) throw new HttpError(400, "Add an email address to send the test to.");
  const company = must(await c.var.db.from("companies").select("name, phone, email, address, settings").eq("id", c.var.companyId).maybeSingle());
  const vars = { client: { first_name: firstName(me.full_name), name: me.full_name }, company: { name: company.name, phone: company.phone ?? "" } };
  const email = renderEmail({
    companyName: company.name,
    logo: logoImage(appUrl(c), c.var.companyId, company.settings),
    text: renderTemplate(campaign.body, vars),
    footer: [company.name, companyAddress(company.address as Record<string, string>)].filter(Boolean).join(" · "),
    unsubscribeUrl: `${appUrl(c)}/u/test`,
  });
  const result = await sendEmail(c.env, { to, subject: `[Test] ${renderTemplate(campaign.subject, vars)}`, ...email, fromName: company.name }, c.var.companyId);
  if (!result.sent) throw new HttpError(502, result.reason ?? "The test email wasn't sent.");
  return c.json({ sent: true, to });
});

/** Draft a campaign with Claude from a short goal. */
marketing.post("/campaigns/draft", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, z.object({ goal: z.string().trim().min(5).max(600), tone: z.enum(["friendly", "professional", "urgent"]).default("friendly") }));
  const company = must(await c.var.db.from("companies").select("name, trade_preset").eq("id", c.var.companyId).maybeSingle());
  const text = await complete(c.env, {
    apiKey: await companyAnthropicKey(c.env, adminClient(c.env), c.var.companyId),
    system:
      "You write short marketing emails for local service businesses (lawn care, paving, roofing and similar). " +
      "Write plainly, like the owner would, with no hype, no emoji and no placeholders other than {{client.first_name}} and {{company.name}}. " +
      'Reply with JSON only: {"subject": "...", "body": "..."}. The body is plain text with blank lines between short paragraphs and ends with a clear next step.',
    prompt: `Business: ${company.name} (${company.trade_preset.replace(/_/g, " ")}).\nTone: ${body.tone}.\nGoal of this email: ${body.goal}`,
    effort: "low",
    maxTokens: 1200,
  });
  const match = text.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : text) as { subject?: string; body?: string };
    if (!parsed.subject || !parsed.body) throw new Error("incomplete");
    return c.json({ subject: parsed.subject.slice(0, 200), body: parsed.body.slice(0, 8000) });
  } catch {
    throw new HttpError(502, "The AI's draft came back in an unexpected shape. Try again.");
  }
});

// ---------------------------------------------------------------------------------------------
// Reviews and referrals
// ---------------------------------------------------------------------------------------------

marketing.post("/reviews/request", requireUser, requireCompany(SALES), async (c) => {
  const body = await readJson(c, z.object({ client_id: uuid, job_id: uuid.optional(), channel: z.enum(["email", "sms", "link"]).default("email") }));
  const client = must(
    await c.var.db.from("clients").select("id, display_name, email, phone").eq("id", body.client_id).eq("company_id", c.var.companyId).maybeSingle(),
    "Client not found.",
  );
  try {
    const result = await sendReviewRequest(c.env, adminClient(c.env), { companyId: c.var.companyId, client, jobId: body.job_id, channel: body.channel, baseUrl: appUrl(c), createdBy: c.var.userId });
    return c.json(result);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "The review request wasn't sent.");
  }
});

marketing.get("/referrals/link/:id", requireUser, requireCompany(SALES), async (c) => {
  const client = must(await c.var.db.from("clients").select("id").eq("id", param(c, "id")).eq("company_id", c.var.companyId).maybeSingle(), "Client not found.");
  return c.json({ link: await clientLink(c.env, appUrl(c), { c: c.var.companyId, t: "refer", id: client.id }) });
});

/**
 * The client's Hub home link: upcoming visits, open quotes, invoices and "request work". It's the
 * office's copy (`via: "office"`): it works as the client's own, but can only say yes to a card
 * saved on Stripe's page through an office copy, never one brought in from Stripe or one the client
 * saved themselves, and can't add a tip to a saved card (lib/links.ts).
 */
marketing.get("/clients/:id/hub-link", requireUser, requireCompany(SALES), async (c) => {
  const client = must(await c.var.db.from("clients").select("id").eq("id", param(c, "id")).eq("company_id", c.var.companyId).maybeSingle(), "Client not found.");
  return c.json({ link: await clientLink(c.env, appUrl(c), { c: c.var.companyId, t: "client", id: client.id, via: "office" }) });
});
