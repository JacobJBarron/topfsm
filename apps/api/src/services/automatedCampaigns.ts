/**
 * Automated campaigns, Jobber's way (docs/marketing-plan.md, phase C): Re-engage past clients, Win
 * back lost quotes and Close pending quotes, each an automation rule whose email the engine sends
 * here (services/automations.ts performAction), recorded as a recipient of the company's automated
 * campaign for it, with tracked links and a pixel, so its results read like a one-off campaign's.
 *
 * Re-engage and Win back are marketing: one-click unsubscribe and the company's address, nothing
 * while Marketing is uninstalled or to clients who opted out (the engine skips those runs), and a
 * client gets at most one re-engage email every 6 months and one win-back email for each quote
 * (begin_campaign_send holds to both, even at the same moment). Close pending quotes is the
 * quote_followup rule, a follow-up to a quote the client asked for: it keeps going while Marketing
 * is off and to clients who unsubscribed from marketing, with no unsubscribe link, as it always has,
 * and is only tracked.
 *
 * Clients who haven't had a visit in a while: the hourly "inactive" task (tasks.ts) asks the
 * database to queue each company's client.inactive runs (emit_inactive_clients), from 10am in its
 * time zone, at most 100 a day for each rule, those who passed N most recently first.
 */
import { renderTemplate, type Action } from "@crewtavo/core";
import { AUTOMATED_CAMPAIGNS, campaignKeyOf, linkButton, REENGAGE_DAILY_CAP, REENGAGE_GAP_DAYS, trackableLinks, winBackSkip, type AutomatedCampaign } from "@crewtavo/core/campaigns";
import type { Env } from "../env";
import { isEmail } from "../lib/email";
import { emailReady } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { companyFooter, Skip, type RunContext } from "./automations";
import { emailClient } from "./marketingEmail";
import { WaitUntil } from "./reviews";

export const CAMPAIGN_EMAIL_NOT_CONNECTED = "Email isn't connected yet, so campaign emails can't be sent. An admin can connect it in Settings → Email.";
/** How long a campaign email's Client Hub link lasts: a year, as a review link does, since campaign emails are kept. */
export const CAMPAIGN_LINK_DAYS = 365;

/** The automated campaign a rule sends as (any rule on client.inactive is Re-engage past clients), or null. */
export function campaignRuleOf(rule: { template_key?: string | null; trigger: string }): AutomatedCampaign | null {
  const key = campaignKeyOf(rule);
  return key ? AUTOMATED_CAMPAIGNS[key] : null;
}

/** Where a recipient's links go (its own tracked links) and its pixel. A link that isn't tracked goes as it is. */
export function trackedLinks(baseUrl: string, token: string, links: readonly string[]) {
  const base = baseUrl.replace(/\/$/, "");
  return {
    href: (url: string) => {
      const n = links.indexOf(url);
      return n < 0 ? url : `${base}/api/public/c/${token}/${n}`;
    },
    pixel: `${base}/api/public/o/${token}`,
  };
}

/**
 * Queues today's client.inactive runs, company by company. A company whose emails can't go yet
 * (email isn't connected, or APP_URL isn't set) waits: its runs would only fail and use up each
 * client's stretch without a visit. The database holds to Marketing, the time and the cap.
 */
export async function emitInactiveClients(env: Env) {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("automation_rules")
    .select("company_id, company:companies!inner(id)")
    .eq("trigger", "client.inactive")
    .eq("enabled", true)
    .eq("company.settings->marketing->>enabled", "true")
    .limit(1000);
  if (error) throw new Error(error.message);
  const companies = [...new Set((data ?? []).map((r) => r.company_id))];
  let queued = 0;
  let waiting = 0;
  for (const company of companies) {
    if (!env.APP_URL || !(await emailReady(env, company))) {
      waiting++;
      continue;
    }
    const { data: n, error: emitError } = await admin.rpc("emit_inactive_clients", { p_now: new Date().toISOString(), p_cap: REENGAGE_DAILY_CAP, p_company: company });
    if (emitError) throw new Error(emitError.message);
    queued += n ?? 0;
  }
  return { companies: companies.length, queued, waiting };
}

/** A client.inactive run's stretch without a visit is let go, so the client is emailed once what stopped it is fixed. */
export async function letStretchGo(admin: Db, runId: number) {
  const { error } = await admin.from("inactive_client_marks").delete().eq("run_id", runId);
  if (error) console.error("Stretch not let go", runId, error.message);
}

async function letGo(admin: Db, ctx: RunContext) {
  if (ctx.campaign?.key === "reengage" && ctx.run) await letStretchGo(admin, ctx.run.id);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Records how a send went, trying a few times: an email that went has to be recorded sent, or the 6
 * months and its results wouldn't see it. One that still isn't counts against the limits as if it
 * went (begin_campaign_send), and its first open or click records it sent (track_campaign_open).
 */
async function recordSend(admin: Db, id: number, status: "sent" | "failed", reason: string | undefined) {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await pause(250 * attempt);
    try {
      const { error } = await admin.rpc("finish_campaign_send", { p_id: id, p_status: status, p_error: reason });
      if (!error) return;
      last = error.message;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  console.error("Campaign send not recorded", id, last);
}

/**
 * Why a win-back email isn't sent after all: since the quote was lost the client approved another
 * quote (or one went straight to a job), has active work or a newer job, has another quote waiting
 * on them, or sent a request. Null when it goes.
 */
async function winBackReason(admin: Db, ctx: RunContext): Promise<string | null> {
  const clientId = ctx.client!.id;
  const [activity, quote] = await Promise.all([
    ctx.run?.activity_id != null ? admin.from("activity").select("created_at").eq("id", ctx.run.activity_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    admin.from("quotes").select("updated_at").eq("id", ctx.id).maybeSingle(),
  ]);
  if (activity.error || quote.error) throw new Error((activity.error ?? quote.error)!.message);
  const lostAt = activity.data?.created_at ?? quote.data?.updated_at ?? new Date().toISOString();
  const after = (iso: string | null | undefined) => Boolean(iso && Date.parse(iso) > Date.parse(lostAt));
  const [quotes, jobs, requests] = await Promise.all([
    admin.from("quotes").select("id, status, approved_at, converted_at, updated_at, created_at").eq("company_id", ctx.company.id).eq("client_id", clientId).neq("id", ctx.id)
      .in("status", ["approved", "converted", "sent", "changes_requested"]).limit(200),
    admin.from("jobs").select("status, created_at").eq("company_id", ctx.company.id).eq("client_id", clientId).or(`status.eq.active,created_at.gt.${lostAt}`).limit(50),
    admin.from("requests").select("created_at").eq("company_id", ctx.company.id).eq("client_id", clientId).gt("created_at", lostAt).limit(1),
  ]);
  if (quotes.error || jobs.error || requests.error) throw new Error((quotes.error ?? jobs.error ?? requests.error)!.message);
  const others = (quotes.data ?? []).filter((q) => q.id !== ctx.id);
  return winBackSkip({
    approvedSince: others.some((q) => (q.status === "approved" || q.status === "converted") && after(q.approved_at ?? q.converted_at ?? q.updated_at)),
    activeJob: (jobs.data ?? []).some((j) => j.status === "active"),
    jobSince: (jobs.data ?? []).some((j) => after(j.created_at)),
    newerQuote: others.some((q) => (q.status === "sent" || q.status === "changes_requested") && after(q.created_at)),
    requestSince: (requests.data ?? []).some((r) => after(r.created_at)),
  });
}

const render = (template: string | undefined, ctx: RunContext) => renderTemplate(template ?? "", ctx.vars).trim();

/**
 * Sends an automated campaign's email for a run: recorded first (begin_campaign_send), with its
 * links tracked, then sent and recorded sent or failed, into the client's messages. Each email
 * action of the run is its own send. Returns what happened, a Skip when there was nothing to send,
 * throws with the reason, or throws WaitUntil while the same email may still be going out from
 * another worker.
 */
export async function sendCampaignEmail(
  env: Env,
  admin: Db,
  ctx: RunContext,
  action: Extract<Action, { type: "send_email" }>,
  baseUrl: string | null,
): Promise<string | Skip> {
  const campaign = ctx.campaign!;
  const client = ctx.client;
  if (!client) throw new Error("There's no client on this record.");
  if (!isEmail(client.email)) {
    if (campaign.marketing) return new Skip(`${client.display_name} has no email address`);
    throw new Error(`${client.display_name} has no email address.`);
  }
  if (campaign.key === "win_back") {
    const reason = await winBackReason(admin, ctx);
    if (reason) return new Skip(reason);
  }
  if (campaign.marketing) {
    // The business's to fix, so the run fails rather than skips.
    if (!(await emailReady(env, ctx.company.id))) {
      await letGo(admin, ctx);
      throw new Error(CAMPAIGN_EMAIL_NOT_CONNECTED);
    }
    if (!baseUrl) {
      await letGo(admin, ctx);
      throw new Error("APP_URL isn't set, so campaign links can't be built.");
    }
  }
  const email = client.email!.trim();
  const subject = render(action.subject, ctx);
  const text = render(action.body, ctx);
  const links = trackableLinks(text);
  const { data, error } = await admin.rpc("begin_campaign_send", {
    p_company: ctx.company.id,
    p_key: campaign.templateKey,
    p_client: client.id,
    p_email: email,
    p_name: client.display_name,
    // One email for each of the run's email actions: a second one on the rule is its own send.
    p_send_key: ctx.run!.action ? `run:${ctx.run!.id}:${ctx.run!.action}` : `run:${ctx.run!.id}`,
    p_subject: ctx.subject === "quote" ? ctx.id : undefined,
    p_gap_days: campaign.key === "reengage" ? REENGAGE_GAP_DAYS : undefined,
    p_once_per_subject: campaign.key === "win_back",
    p_links: links,
  });
  if (error) throw new Error(error.message);
  const row = data?.[0];
  if (!row) return new Skip(campaign.key === "reengage" ? "Already sent a re-engage email in the last 6 months" : "Already sent a win-back email for this quote");
  // A retried run whose email went already.
  if (row.already_sent) return `Emailed ${email}`;
  if (row.in_flight) throw new WaitUntil(new Date(Date.now() + 16 * 60_000), "An email to them was already on its way");

  const result = await emailClient(env, {
    companyId: ctx.company.id,
    company: ctx.company,
    client,
    subject,
    text,
    baseUrl: baseUrl!,
    footer: companyFooter(ctx.company),
    track: trackedLinks(baseUrl!, row.track_token, links),
    unsubscribe: campaign.marketing,
    // {{link}} on its own line is a button named for where it goes: the Hub's home, or the quote.
    buttons: typeof ctx.vars.link === "string" ? { [ctx.vars.link]: linkButton(campaign.key) } : undefined,
  });
  const reason = result.sent ? undefined : (result.reason ?? "The email wasn't sent.");
  await recordSend(admin, row.id, result.sent ? "sent" : "failed", reason);
  if (!result.sent) throw new Error(reason);
  await admin.from("messages").insert({
    company_id: ctx.company.id, client_id: client.id, channel: "email", direction: "out", subject, body: text,
    related_type: ctx.subject, related_id: ctx.id, external_id: result.id ?? null, sent_by: null,
  });
  return `Emailed ${email}`;
}
