/**
 * Crewtavo - Marketing (Apps → Crewtavo - Marketing): installing it (POST /marketing/enabled),
 * campaigns (send, schedule, test, AI drafts), automated campaigns (PUT /campaigns/automated/:key
 * edits each one's rule, POST …/test sends a test), review requests and when they're asked
 * automatically (PUT /reviews/asks edits the two starter rules), referral links, and asking for
 * referrals (POST /referrals/request by hand, PUT /referrals/asks switches the starter rule).
 */
import { addDays, ADMINS, localDate, OFFICE, SALES, type TablesInsert } from "@crewtavo/core";
import {
  AUTOMATED_CAMPAIGNS,
  AUTOMATED_KEYS,
  automatedDaysError,
  automatedRuleUpdate,
  HUB_HOME_BUTTON,
  inactiveDays,
  linkButton,
  readAutomatedRule,
  type AutomatedKey,
  type AutomatedRuleRow,
} from "@crewtavo/core/campaigns";
import {
  ASK_TEMPLATE_KEYS,
  askRuleUpdate,
  isReferralRule,
  marketingOn,
  MAX_RECURRING_VISITS,
  MAX_REMINDER_DAYS,
  readAskRule,
  REFERRAL_RULE,
  REFERRAL_RULE_KEY,
  referralsReady,
  REFERRALS_NOT_SET_UP,
  reviewSettings,
  type AskRule,
  type AskRuleKind,
} from "@crewtavo/core/marketing";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { kickCampaign } from "../lib/background";
import { requireCompany, requireUser } from "../lib/auth";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { appUrl, asJson, dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { clientLink } from "../lib/links";
import { emailReady, sendEmail } from "../lib/notify";
import { adminClient } from "../lib/supabase";
import { renderTemplate } from "@crewtavo/core";
import { companyAnthropicKey, complete } from "../services/ai";
import { companyAddress } from "../services/automations";
import { logoImage } from "../services/logo";
import { ReferralAskRefused, sendReferralAsk } from "../services/referrals";
import { rescheduleReminders, sendReviewRequest } from "../services/reviews";

export const marketing = new Hono<AppEnv>();

/** Install and Uninstall (owners and admins who connect apps), as Drive's. */
marketing.post("/marketing/enabled", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ enabled: z.boolean() }));
  const { error } = await c.var.db.rpc("marketing_set_enabled", { p_company: c.var.companyId, p_enabled: body.enabled });
  if (error) throw dbError(error);
  return c.json({ enabled: body.enabled });
});

type Ctx = Parameters<typeof appUrl>[0];

const requireEmail = async (c: Ctx) => {
  if (!(await emailReady(c.env, c.var.companyId))) throw new HttpError(501, "Email isn't connected yet, so campaigns can't be sent. An admin can connect it in Settings → Email.");
};

/** Uninstalled, Marketing sends clients nothing, so no campaign goes out (or starts, or is tested). */
const requireMarketing = async (c: Ctx) => {
  const company = must(await c.var.db.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle());
  if (!marketingOn(company.settings as Record<string, unknown> | null)) {
    throw new HttpError(409, "Marketing is off, so campaigns can't be sent. An owner or admin can install it again in Apps.");
  }
};

/** A one-off campaign: an automated one is changed on Marketing → Campaigns, through its rule. */
async function loadCampaign(c: Ctx) {
  const campaign = must(
    await c.var.db.from("campaigns").select("id, kind, status, name, subject, body, audience, scheduled_at").eq("id", param(c, "id")).eq("company_id", c.var.companyId).maybeSingle(),
    "Campaign not found.",
  );
  if (campaign.kind === "automated") throw new HttpError(409, "This campaign sends by itself. Change it in Marketing → Campaigns.");
  return campaign;
}

/**
 * Sends the signed-in person (or `to`) a test copy, with "[Test]" in the subject: no tracking, and
 * an unsubscribe link that goes nowhere when the real one would have one.
 */
async function sendTest(c: Ctx, d: { to?: string; subject: string; body: string; vars: Record<string, unknown>; unsubscribe: boolean; button: string }) {
  const me = must(await c.var.db.from("profiles").select("email, full_name").eq("user_id", c.var.userId).maybeSingle());
  const to = d.to ?? me.email;
  if (!to || !isEmail(to)) throw new HttpError(400, "Add an email address to send the test to.");
  const company = must(await c.var.db.from("companies").select("name, phone, email, website, address, settings").eq("id", c.var.companyId).maybeSingle());
  // {{title}} is the client's name for an email about a client (Re-engage), as the engine has it.
  const vars = {
    client: { first_name: firstName(me.full_name), name: me.full_name, email: to, phone: "" },
    company: { name: company.name, phone: company.phone ?? "", email: company.email ?? "", website: company.website ?? "" },
    link: appUrl(c),
    title: me.full_name ?? "",
    ...d.vars,
  } as Parameters<typeof renderTemplate>[1];
  const email = renderEmail({
    companyName: company.name,
    logo: logoImage(appUrl(c), c.var.companyId, company.settings),
    text: renderTemplate(d.body, vars),
    footer: [company.name, companyAddress(company.address as Record<string, string>)].filter(Boolean).join(" · "),
    unsubscribeUrl: d.unsubscribe ? `${appUrl(c)}/u/test` : null,
    // {{link}} on its own line is the same button the real email has.
    buttons: { [String(vars.link)]: d.button },
  });
  const result = await sendEmail(c.env, { to, subject: `[Test] ${renderTemplate(d.subject, vars)}`, ...email, fromName: company.name }, c.var.companyId);
  if (!result.sent) throw new HttpError(502, result.reason ?? "The test email wasn't sent.");
  return c.json({ sent: true, to });
}

/** Send now, or schedule: snapshots the audience so later edits to clients don't change who gets it. */
marketing.post("/campaigns/:id/send", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  await requireMarketing(c);
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
    { onConflict: "campaign_id,email,send_key", ignoreDuplicates: true },
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
  await requireMarketing(c);
  await requireEmail(c);
  const body = await readJson(c, z.object({ to: z.email().optional() }));
  const campaign = await loadCampaign(c);
  return sendTest(c, { to: body.to, subject: campaign.subject, body: campaign.body, vars: {}, unsubscribe: true, button: HUB_HOME_BUTTON });
});

// ---------------------------------------------------------------------------------------------
// Automated campaigns
// ---------------------------------------------------------------------------------------------

const AUTOMATED_RULE_FIELDS = "id, name, description, template_key, trigger, enabled, delay_minutes, conditions, actions";

function automatedKey(c: Ctx): AutomatedKey {
  const key = c.req.param("key") as AutomatedKey;
  if (!AUTOMATED_KEYS.includes(key)) throw new HttpError(404, "There's no automated campaign by that name.");
  return key;
}

/**
 * Marketing → Campaigns' automated campaigns: the switch (`enabled`, saved at once), and Edit
 * email's days, subject and message (saved without touching the switch). The rule stays where the
 * campaign is set, so it still shows in Automations: one shaped the way the card writes it is
 * changed, one that's gone is put back, and one someone changed into something the card can't show
 * keeps its shape and is named in `kept`, with only the switch turning it on or off.
 *
 * Turning Re-engage past clients on says what to do with the clients who already qualify: `backlog:
 * "skip"` marks them as done, so only those who reach it from now on are emailed, and "send" emails
 * them too, 100 a day, a backlog let go before included. Without it, turning it on is refused (409)
 * while any qualify, so nobody's past clients are emailed without being asked. Turning a campaign on
 * needs email connected, and Marketing installed for the two marketing ones. Off always goes through.
 */
marketing.put("/campaigns/automated/:key", requireUser, requireCompany(ADMINS, "marketing"), async (c) => {
  if (!c.var.permissions.includes("automations")) throw new HttpError(403, "Changing automated campaigns needs the Automations area.");
  const key = automatedKey(c);
  const campaign = AUTOMATED_CAMPAIGNS[key];
  const body = await readJson(
    c,
    z.object({
      enabled: z.boolean().optional(),
      days: z.number().int().optional(),
      subject: z.string().trim().min(1).max(200).optional(),
      body: z.string().trim().min(10).max(20000).optional(),
      backlog: z.enum(["send", "skip"]).optional(),
    }),
  );
  if (body.days !== undefined) {
    const problem = automatedDaysError(key, body.days);
    if (problem) throw new HttpError(400, problem);
  }
  const { db, companyId } = c.var;
  if (body.enabled) {
    if (campaign.marketing) {
      const company = must(await db.from("companies").select("settings").eq("id", companyId).maybeSingle());
      if (!marketingOn(company.settings as Record<string, unknown> | null)) {
        throw new HttpError(409, "Marketing is off, so automated campaigns can't be sent. An owner or admin can install it again in Apps.");
      }
    }
    if (!(await emailReady(c.env, companyId))) throw new HttpError(400, "Connect your email first, so campaign emails can go out. An admin can connect it in Settings → Email.");
  }
  const { data: rule, error } = await db.from("automation_rules").select(AUTOMATED_RULE_FIELDS).eq("company_id", companyId).eq("template_key", campaign.templateKey).maybeSingle();
  if (error) throw dbError(error);
  const form = { days: body.days, subject: body.subject, body: body.body };
  const editing = Object.values(form).some((v) => v !== undefined);
  const admin = adminClient(c.env);
  const kept: Array<{ id: string; name: string }> = [];
  // The backlog is settled before the switch, so the hourly task never sees it on without it.
  const turningOn = key === "reengage" && body.enabled === true && !rule?.enabled;
  if (turningOn && !body.backlog) {
    // At the days it'll have: the form's, unless the rule keeps a shape of its own.
    const own = rule && (body.days === undefined || !readAutomatedRule(rule as unknown as AutomatedRuleRow, key));
    const days = own ? inactiveDays(rule.conditions) : (body.days ?? campaign.days.default);
    const { data: waiting, error: countError } = await db.rpc("inactive_client_count", { p_company: companyId, p_days: days });
    if (countError) throw dbError(countError);
    if (waiting) throw new HttpError(409, `${waiting.toLocaleString("en-US")} past ${waiting === 1 ? "client qualifies" : "clients qualify"} already. Turn it on again to choose whether to email them too or only clients who reach it from now on.`);
  }
  const skipBacklog = turningOn && body.backlog === "skip";
  let ruleId: string;
  let enabled = rule?.enabled ?? false;
  if (!rule) {
    const fresh = automatedRuleUpdate(null, key, { ...form, enabled: skipBacklog ? false : (body.enabled ?? false) });
    const added = must(
      await db
        .from("automation_rules")
        .insert({ ...fresh, conditions: asJson(fresh.conditions), actions: asJson(fresh.actions), company_id: companyId } as TablesInsert<"automation_rules">)
        .select("id")
        .single(),
    );
    ruleId = added.id;
    enabled = fresh.enabled ?? false;
  } else {
    ruleId = rule.id;
    if (!readAutomatedRule(rule as unknown as AutomatedRuleRow, key)) {
      kept.push({ id: rule.id, name: rule.name });
    } else if (editing) {
      const change = automatedRuleUpdate(rule as unknown as AutomatedRuleRow, key, form);
      const written = await db.from("automation_rules").update({ ...change, conditions: asJson(change.conditions), actions: asJson(change.actions) }).eq("id", rule.id);
      if (written.error) throw dbError(written.error);
    }
  }
  if (skipBacklog) {
    const { error: skipError } = await admin.rpc("skip_inactive_backlog", { p_rule: ruleId });
    if (skipError) throw dbError(skipError);
  } else if (turningOn && body.backlog === "send") {
    const { error: releaseError } = await admin.rpc("release_inactive_backlog", { p_rule: ruleId });
    if (releaseError) throw dbError(releaseError);
  }
  if (body.enabled !== undefined && body.enabled !== enabled) {
    const switched = await db.from("automation_rules").update({ enabled: body.enabled }).eq("id", ruleId);
    if (switched.error) throw dbError(switched.error);
  }
  const { data: campaignId, error: campaignError } = await admin.rpc("ensure_automated_campaign", { p_company: companyId, p_key: campaign.templateKey });
  if (campaignError) throw dbError(campaignError);
  return c.json({ kept, rule_id: ruleId, campaign_id: campaignId });
});

/** A test of an automated campaign's email as it's being written, with a made-up quote and visit. */
marketing.post("/campaigns/automated/:key/test", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const key = automatedKey(c);
  const campaign = AUTOMATED_CAMPAIGNS[key];
  if (campaign.marketing) await requireMarketing(c);
  await requireEmail(c);
  const body = await readJson(
    c,
    z.object({ to: z.email().optional(), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000), days: z.number().int().min(0).max(1000).optional() }),
  );
  const company = must(await c.var.db.from("companies").select("timezone, currency").eq("id", c.var.companyId).maybeSingle());
  const tz = company.timezone || "UTC";
  const lastVisit = addDays(localDate(new Date(), tz), -(body.days ?? campaign.days.default));
  const vars = {
    number: 1042,
    ...(key === "reengage" ? {} : { title: "Spring cleanup" }),
    total: new Intl.NumberFormat("en-US", { style: "currency", currency: company.currency || "USD" }).format(1250),
    address: "12 Oak Street",
    status: key === "close_quotes" ? "Awaiting response" : key === "win_back" ? "Lost" : "Active",
    last_visit: new Date(`${lastVisit}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }),
  };
  return sendTest(c, { to: body.to, subject: body.subject, body: body.body, vars, unsubscribe: campaign.marketing, button: linkButton(key) });
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

/** Ask a client now: right away, whatever the time and however lately they were asked, unless they opted out or are archived. */
marketing.post("/reviews/request", requireUser, requireCompany(SALES), async (c) => {
  const body = await readJson(c, z.object({ client_id: uuid, job_id: uuid.optional(), channel: z.enum(["email", "sms", "both", "link"]).default("email") }));
  const client = must(
    await c.var.db
      .from("clients")
      .select("id, display_name, email, phone, status, review_opt_out, marketing_opt_out, sms_opt_out_at, reviewed_at")
      .eq("id", body.client_id)
      .eq("company_id", c.var.companyId)
      .maybeSingle(),
    "Client not found.",
  );
  try {
    const result = await sendReviewRequest(c.env, adminClient(c.env), {
      companyId: c.var.companyId, client, jobId: body.job_id, channel: body.channel, baseUrl: appUrl(c), automatic: false, createdBy: c.var.userId,
    });
    return c.json(result);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "The review request wasn't sent.");
  }
});

const ASK_RULE_FIELDS = "id, name, description, template_key, trigger, enabled, delay_minutes, conditions, actions";

/**
 * Marketing → Reviews' "Ask automatically": when the starter rules ask (review_after_job, and
 * review_recurring for recurring work), by which channels, after which recurring visit, and the
 * reminders. The rules stay where asking is set, so they still show in Automations: one shaped the
 * way the form writes them is changed, one that's gone is put back, and one someone changed into
 * something the form can't show keeps its shape and is named in `kept`, with only the switch
 * turning it on or off. New reminder days move the reminders still to come.
 */
marketing.put("/reviews/asks", requireUser, requireCompany(ADMINS, "marketing"), async (c) => {
  if (!c.var.permissions.includes("automations")) throw new HttpError(403, "Changing when reviews are asked needs the Automations area.");
  const body = await readJson(
    c,
    z
      .object({
        enabled: z.boolean(),
        when: z.enum(["job.completed", "visit.completed", "invoice.paid"]),
        channel: z.enum(["email", "sms", "both"]),
        recurring: z.boolean(),
        recurring_after_visits: z.number().int().min(1).max(MAX_RECURRING_VISITS),
        reminder_days: z.array(z.number().int().min(1).max(MAX_REMINDER_DAYS)).max(2),
      })
      .refine((b) => b.reminder_days.length < 2 || b.reminder_days[1]! > b.reminder_days[0]!, { message: "The second reminder comes after the first.", path: ["reminder_days"] }),
  );
  const { db, companyId } = c.var;
  const rules = must(await db.from("automation_rules").select(ASK_RULE_FIELDS).eq("company_id", companyId).in("template_key", Object.values(ASK_TEMPLATE_KEYS)));

  // Settings first, read fresh and merged, as saveWebsite does.
  const current = must(await db.from("companies").select("settings, timezone").eq("id", companyId).maybeSingle());
  const settings = (current.settings ?? {}) as Record<string, unknown>;
  const reviews = (settings.reviews ?? {}) as Record<string, unknown>;
  const next = { ...settings, reviews: { ...reviews, recurring_after_visits: body.recurring_after_visits, reminders: body.reminder_days.map((days) => ({ days })) } };
  const saved = await db.from("companies").update({ settings: asJson(next) }).eq("id", companyId);
  if (saved.error) throw dbError(saved.error);
  const days = reviewSettings(next).reminderDays;
  if (days.join() !== reviewSettings(settings).reminderDays.join()) {
    await rescheduleReminders(adminClient(c.env), companyId, current.timezone || "UTC", days);
  }

  const kept: Array<{ id: string; name: string }> = [];
  const forms: Record<AskRuleKind, { enabled: boolean }> = { after_job: { enabled: body.enabled }, recurring: { enabled: body.enabled && body.recurring } };
  for (const kind of Object.keys(forms) as AskRuleKind[]) {
    const rule = rules.find((r) => r.template_key === ASK_TEMPLATE_KEYS[kind]);
    if (rule && !readAskRule(rule as unknown as AskRule, kind)) {
      // Its shape is its own, but the switch still turns it on and off: asking off means nothing asks.
      kept.push({ id: rule.id, name: rule.name });
      if (rule.enabled !== forms[kind].enabled) {
        const switched = await db.from("automation_rules").update({ enabled: forms[kind].enabled }).eq("id", rule.id);
        if (switched.error) throw dbError(switched.error);
      }
      continue;
    }
    const change = askRuleUpdate(rule as unknown as AskRule | undefined, kind, { when: body.when, channel: body.channel, enabled: forms[kind].enabled });
    const row = { ...change, conditions: asJson(change.conditions), actions: asJson(change.actions) };
    const written = rule
      ? await db.from("automation_rules").update(row).eq("id", rule.id)
      : await db.from("automation_rules").insert({ ...row, company_id: companyId } as TablesInsert<"automation_rules">);
    if (written.error) throw dbError(written.error);
  }
  return c.json({ kept });
});

/** Ask for referrals by email: right away, however lately they were asked, unless they opted out of marketing or are archived. */
marketing.post("/referrals/request", requireUser, requireCompany(SALES), async (c) => {
  const body = await readJson(c, z.object({ client_id: uuid }));
  const client = must(
    await c.var.db.from("clients").select("id, display_name, email, status, marketing_opt_out").eq("id", body.client_id).eq("company_id", c.var.companyId).maybeSingle(),
    "Client not found.",
  );
  try {
    const result = await sendReferralAsk(c.env, adminClient(c.env), { companyId: c.var.companyId, client, baseUrl: appUrl(c), automatic: false, createdBy: c.var.userId });
    return c.json(result);
  } catch (error) {
    if (error instanceof ReferralAskRefused && error.marketingOff) throw new HttpError(409, error.message);
    throw new HttpError(400, error instanceof Error ? error.message : "The referral ask wasn't sent.");
  }
});

/**
 * Marketing → Referrals' "Ask automatically": the starter rule's switch (referral_after_job). One
 * that's gone is put back; one someone changed in Automations keeps its shape, named in `kept`.
 * Turning it on needs something to send and a way to send it: Marketing installed, a credit or an
 * offer, and email connected. Off always goes through.
 */
marketing.put("/referrals/asks", requireUser, requireCompany(ADMINS, "marketing"), async (c) => {
  if (!c.var.permissions.includes("automations")) throw new HttpError(403, "Changing when referrals are asked needs the Automations area.");
  const body = await readJson(c, z.object({ enabled: z.boolean() }));
  const { db, companyId } = c.var;
  if (body.enabled) {
    const company = must(await db.from("companies").select("settings").eq("id", companyId).maybeSingle());
    const settings = company.settings as Record<string, unknown> | null;
    if (!marketingOn(settings)) throw new HttpError(409, "Marketing is off, so referral asks can't be sent. An owner or admin can install it again in Apps.");
    if (!referralsReady(settings)) throw new HttpError(400, REFERRALS_NOT_SET_UP);
    if (!(await emailReady(c.env, companyId))) throw new HttpError(400, "Connect your email first, so referral asks can go out. An admin can connect it in Settings → Email.");
  }
  const { data: rule, error } = await db
    .from("automation_rules")
    .select("id, name, trigger, enabled, conditions, actions")
    .eq("company_id", companyId)
    .eq("template_key", REFERRAL_RULE_KEY)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!rule) {
    const added = must(
      await db
        .from("automation_rules")
        .insert({ ...REFERRAL_RULE, conditions: asJson(REFERRAL_RULE.conditions), actions: asJson(REFERRAL_RULE.actions), enabled: body.enabled, company_id: companyId } as TablesInsert<"automation_rules">)
        .select("id")
        .single(),
    );
    return c.json({ kept: [], rule_id: added.id });
  }
  if (rule.enabled !== body.enabled) {
    const switched = await db.from("automation_rules").update({ enabled: body.enabled }).eq("id", rule.id);
    if (switched.error) throw dbError(switched.error);
  }
  return c.json({ kept: isReferralRule(rule) ? [] : [{ id: rule.id, name: rule.name }], rule_id: rule.id });
});

marketing.get("/referrals/link/:id", requireUser, requireCompany(SALES), async (c) => {
  const client = must(await c.var.db.from("clients").select("id").eq("id", param(c, "id")).eq("company_id", c.var.companyId).maybeSingle(), "Client not found.");
  return c.json({ link: await clientLink(c.env, appUrl(c), { c: c.var.companyId, t: "refer", id: client.id }) });
});

/** The client's Hub home link: upcoming visits, open quotes, invoices and "request work". */
marketing.get("/clients/:id/hub-link", requireUser, requireCompany(SALES), async (c) => {
  const client = must(await c.var.db.from("clients").select("id").eq("id", param(c, "id")).eq("company_id", c.var.companyId).maybeSingle(), "Client not found.");
  return c.json({ link: await clientLink(c.env, appUrl(c), { c: c.var.companyId, t: "client", id: client.id }) });
});
