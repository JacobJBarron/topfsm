/**
 * Google review requests, Jobber's way (docs/marketing-plan.md): a short message with a tracked link
 * that redirects to the company's review page (settings.review_url), by email, text or both, and up
 * to two reminders for anyone who hasn't opened it. Clicks are recorded so Marketing can show what
 * works, and a click stops the reminders.
 *
 * An ask sent by an automation (`automatic`) holds to more than one sent by hand: it skips clients
 * asked in the last 6 months, and between 9pm and 9am in the company's time zone it goes by email
 * only, or waits for 9am when a text is the only way (WaitUntil: the engine puts the run back). Asks
 * by hand go right away. Neither goes to clients who opted out or are archived, and nothing goes
 * while Marketing is uninstalled. A link copied by hand isn't an ask until it's opened.
 *
 * Reminders (sendDueReminders, every five minutes) go at 1:30pm on the chosen days, by the ask's own
 * channels, with the same tracked link. Each one lands in the client's messages like the ask. When
 * the days change, the reminders still to come move to them (rescheduleReminders).
 */
import { renderTemplate } from "@crewtavo/core";
import {
  askChannels,
  DEFAULT_REVIEW_MESSAGE,
  inQuietHours,
  marketingOn,
  nextReminder,
  notAsked,
  quietHoursEnd,
  reachOf,
  REVIEW_GAP_DAYS,
  reminderPlan,
  rescheduledReminder,
  reviewSettings,
  textsOff,
  textsOffReason,
  type AskChannel,
  type SendChannel,
} from "@crewtavo/core/marketing";
import type { Env } from "../env";
import { companyFooter, firstName } from "../lib/email";
import { clientLink } from "../lib/links";
import { reportError } from "../lib/monitoring";
import { emailReady, sendSms, smsConfigured, type SendResult } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { emailClient } from "./marketingEmail";
import { noteRefusedText } from "./textsOff";

/** An action that can't happen yet: the automation run waits until then, with the message saying why. */
export class WaitUntil extends Error {
  override name = "WaitUntil";
  constructor(
    readonly until: Date,
    message: string,
  ) {
    super(message);
  }
}

export interface ReviewClient {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  status?: string | null;
  review_opt_out?: boolean | null;
  marketing_opt_out?: boolean | null;
  sms_opt_out_at?: string | null;
}

interface ReviewArgs {
  companyId: string;
  client: ReviewClient;
  jobId?: string | null;
  channel: AskChannel | "link";
  baseUrl: string | null;
  /** Sent by an automation, not by someone. */
  automatic?: boolean;
  /** Doesn't ask a client who was asked within this many days (automations: REVIEW_GAP_DAYS). */
  skipIfRecentDays?: number;
  createdBy: string | null;
}

export interface ReviewResult {
  sent: boolean;
  link: string;
  detail: string;
  id: string;
  /** Nothing was sent, and that's as it should be (the detail says why). */
  skipped?: true;
}

interface Company {
  name: string;
  phone: string | null;
  email: string | null;
  timezone: string | null;
  settings: unknown;
  /** Its postal address, in a review ask's footer as every marketing email has it. */
  address?: unknown;
}

const recentlyAsked = (days: number) => `Already asked in the last ${days === REVIEW_GAP_DAYS ? "6 months" : `${days} days`}`;
const channelWords = (channels: SendChannel[]) => (channels.length === 2 ? "text and email" : channels[0] === "sms" ? "text" : "email");
const vars = (company: Company, client: ReviewClient, link: string) => ({
  client: { first_name: firstName(client.display_name), name: client.display_name },
  company: { name: company.name, phone: company.phone ?? "" },
  link,
});

/**
 * Sends the message by each channel, recording each one sent in the client's messages. An email
 * carries one-click unsubscribe (marketing_opt_out stops review asks too), as campaigns do
 * (marketingEmail.ts).
 */
async function deliver(
  env: Env,
  admin: Db,
  d: { companyId: string; company: Company; client: ReviewClient; channels: SendChannel[]; text: string; subject: string; record: string; requestId: string; sentBy: string | null; baseUrl: string },
): Promise<{ sent: SendChannel[]; errors: string[] }> {
  const sent: SendChannel[] = [];
  const errors: string[] = [];
  for (const channel of d.channels) {
    let result: SendResult;
    if (channel === "email") {
      result = await emailClient(env, { companyId: d.companyId, company: d.company, client: d.client, subject: d.subject, text: d.text, baseUrl: d.baseUrl, footer: companyFooter(d.company) });
    } else {
      result = await sendSms(env, { to: d.client.phone!, body: d.text });
      await noteRefusedText(admin, d.client, d.client.phone!, result);
    }
    if (!result.sent) {
      errors.push(result.reason ?? (channel === "sms" ? "The text wasn't sent." : "The email wasn't sent."));
      continue;
    }
    sent.push(channel);
    await admin.from("messages").insert({
      company_id: d.companyId, client_id: d.client.id, channel, direction: "out", subject: channel === "email" ? d.record : null, body: d.text,
      related_type: "review", related_id: d.requestId, external_id: result.id ?? null, sent_by: d.sentBy,
    });
  }
  return { sent, errors };
}

export async function sendReviewRequest(env: Env, admin: Db, args: ReviewArgs): Promise<ReviewResult> {
  const automatic = args.automatic === true;
  const { client } = args;
  const name = client.display_name;
  const skipped = (detail: string): ReviewResult => ({ sent: false, link: "", detail, id: "", skipped: true });
  const { data: company } = await admin.from("companies").select("name, phone, email, address, timezone, settings").eq("id", args.companyId).maybeSingle();
  if (!company) throw new Error("Company not found.");
  const settings = (company.settings ?? {}) as Record<string, unknown> & { review_url?: string; review_message?: string };

  // Uninstalled, Marketing sends clients nothing. Links already sent still work (routes/public.ts).
  if (!marketingOn(settings)) {
    if (automatic) return skipped("Marketing is off");
    throw new Error("Marketing is off, so review requests can't be sent. An owner or admin can install it again in Apps.");
  }
  // Opted out or archived: someone asking by hand is told why, as the pages that offer it say.
  const refusal = notAsked(client);
  if (refusal) {
    if (!automatic) throw new Error(refusal);
    return skipped(client.review_opt_out ? `${name} asked not to get review requests` : client.marketing_opt_out ? `${name} unsubscribed from marketing` : `${name} is archived`);
  }
  const timeZone = company.timezone || "UTC";
  const now = new Date();
  // Asked lately: skipped first, so the run isn't held for quiet hours only to be skipped at 9am.
  // begin_review_request holds to it again, for two workers asking at the same moment.
  if (args.skipIfRecentDays) {
    const { data: last, error } = await admin.rpc("last_review_ask", { p_company: args.companyId, p_client: client.id });
    if (error) throw new Error(error.message);
    if (last && Date.parse(last) > now.getTime() - args.skipIfRecentDays * 86_400_000) return skipped(recentlyAsked(args.skipIfRecentDays));
  }
  if (!settings.review_url) throw new Error("Add your Google review link in Marketing → Reviews first.");
  if (!args.baseUrl) throw new Error("APP_URL isn't set, so a review link can't be built.");

  const quiet = automatic && inQuietHours(now, timeZone);
  let channels: SendChannel[] = [];
  if (args.channel !== "link") {
    if (!automatic && args.channel === "sms" && client.phone && textsOff(client)) throw new Error(`${textsOffReason(name)} Ask by email instead.`);
    const reach = reachOf(client, { email: await emailReady(env, args.companyId), sms: smsConfigured(env) });
    const plan = askChannels(args.channel, reach, quiet);
    // Quiet hours text no one: with no email to go by instead, the ask waits for 9am.
    if (plan.wait) throw new WaitUntil(quietHoursEnd(now, timeZone), `Quiet hours: waits until 9am to text, since ${reach.hasEmail ? "email isn't connected" : `${name} has no email`}`);
    if (!plan.send.length) {
      // The client's reason skips an automatic ask; the business's (email or texting isn't set up) fails it, to be fixed.
      if (automatic && !plan.setup) return skipped(plan.skip!.replace(/\.$/, ""));
      throw new Error(plan.skip);
    }
    channels = plan.send;
  }

  // Recorded first, by the database, which also holds to the gap: two workers asking one client
  // at the same moment ask once.
  const { data: id, error } = await admin.rpc("begin_review_request", {
    p_company: args.companyId,
    p_client: client.id,
    p_job: args.jobId ?? undefined,
    p_channel: args.channel === "link" ? "link" : channels.length === 2 ? "both" : channels[0]!,
    p_gap_days: args.skipIfRecentDays ?? undefined,
    p_created_by: args.createdBy ?? undefined,
  });
  if (error) throw new Error(error.message);
  if (!id) return skipped(recentlyAsked(args.skipIfRecentDays ?? REVIEW_GAP_DAYS));

  const link = await clientLink(env, args.baseUrl, { c: args.companyId, t: "review", id });
  if (args.channel === "link") return { sent: false, link, detail: "Link created", id };

  const text = renderTemplate(settings.review_message || DEFAULT_REVIEW_MESSAGE, vars(company, client, link));
  const outcome = await deliver(env, admin, {
    companyId: args.companyId, company, client, channels, text, subject: `How did we do? A quick favor from ${company.name}`, record: "Review request",
    requestId: id, sentBy: args.createdBy, baseUrl: args.baseUrl,
  });
  if (!outcome.sent.length) {
    await admin.from("review_requests").update({ status: "failed", error: outcome.errors[0] ?? null }).eq("id", id);
    throw new Error(outcome.errors[0] ?? "The review request wasn't sent.");
  }
  // By the channels that worked (one that didn't says why), with the first reminder's time.
  const next = nextReminder(now, 0, reviewSettings(settings).reminderDays, timeZone, now);
  await admin
    .from("review_requests")
    .update({ channel: outcome.sent.length === 2 ? "both" : outcome.sent[0]!, error: outcome.errors[0] ?? null, next_reminder_at: next?.toISOString() ?? null })
    .eq("id", id);
  // One series of reminders at a time: a newer ask stops the older ones'.
  await admin
    .from("review_requests")
    .update({ next_reminder_at: null, reminder_note: "A newer ask replaced it" })
    .eq("company_id", args.companyId)
    .eq("client_id", client.id)
    .neq("id", id)
    .not("next_reminder_at", "is", null);
  const emailForText = quiet && args.channel !== "email" && outcome.sent.length === 1 && outcome.sent[0] === "email";
  return { sent: true, link, detail: emailForText ? "Asked for a review by email: it's quiet hours (9pm to 9am), so no text" : `Asked for a review by ${channelWords(outcome.sent)}`, id };
}

/**
 * The reminders that are due, sent (the "reviews" task, every five minutes). Each is claimed first,
 * so two workers never send one twice, decided with fresh reads (reminderPlan): a link opened, a
 * client who opted out or Marketing uninstalled stops them for good. It's counted right before it
 * goes (start_review_reminder), so one that went but wasn't recorded after can't go again.
 */
export async function sendDueReminders(env: Env) {
  const tally = { claimed: 0, sent: 0, failed: 0, stopped: 0, waiting: 0, lost: 0, errors: 0 };
  // Without the app's address there's no link to send.
  if (!env.APP_URL) return tally;
  const baseUrl = env.APP_URL;
  const admin = adminClient(env);
  const { data: rows, error } = await admin.rpc("claim_review_reminders", { p_limit: 50 });
  if (error) throw new Error(error.message);
  const claimed = rows ?? [];
  tally.claimed = claimed.length;
  if (!claimed.length) return tally;

  const [companies, clients] = await Promise.all([
    admin.from("companies").select("id, name, phone, email, address, timezone, settings").in("id", [...new Set(claimed.map((r) => r.company_id))]),
    admin.from("clients").select("id, display_name, email, phone, status, review_opt_out, marketing_opt_out, sms_opt_out_at").in("id", [...new Set(claimed.map((r) => r.client_id))]),
  ]);
  if (companies.error) throw new Error(companies.error.message);
  if (clients.error) throw new Error(clients.error.message);
  const companyById = new Map((companies.data ?? []).map((c) => [c.id, c]));
  const clientById = new Map((clients.data ?? []).map((c) => [c.id, c]));
  const ready = new Map<string, boolean>();

  const remind = async (row: (typeof claimed)[number]): Promise<"sent" | "failed" | "stopped" | "waiting" | "lost" | null> => {
    const finish = async (outcome: "sent" | "failed" | "stop" | "later", next: Date | null, note?: string) => {
      const { error: finishError } = await admin.rpc("finish_review_reminder", {
        p_id: row.id, p_token: row.reminder_claim!, p_outcome: outcome, p_next: next?.toISOString() ?? undefined, p_note: note,
      });
      if (finishError) throw new Error(finishError.message);
    };
    const company = companyById.get(row.company_id);
    const client = clientById.get(row.client_id) ?? null;
    if (!company) return null;
    const settings = (company.settings ?? {}) as Record<string, unknown> & { review_url?: string };
    const timeZone = company.timezone || "UTC";
    if (!ready.has(company.id)) ready.set(company.id, await emailReady(env, company.id));
    const plan = reminderPlan({
      request: row, client, marketingOn: marketingOn(settings), hasReviewUrl: Boolean(settings.review_url), emailReady: ready.get(company.id)!,
      smsReady: smsConfigured(env), settings, now: new Date(), timeZone,
    });
    if (plan.kind === "stop") {
      await finish("stop", null, plan.why);
      return "stopped";
    }
    if (plan.kind === "later") {
      await finish("later", plan.until);
      return "waiting";
    }
    // Right before sending, counted with when the next is due: this worker still holds it, nobody
    // opened the link since, and Uninstall or a newer ask didn't stop the reminders meanwhile.
    const { data: held, error: startError } = await admin.rpc("start_review_reminder", {
      p_id: row.id, p_token: row.reminder_claim!, p_next: plan.next?.toISOString() ?? undefined,
    });
    if (startError) throw new Error(startError.message);
    if (!held) return "lost";
    const link = await clientLink(env, baseUrl, { c: row.company_id, t: "review", id: row.id });
    const text = renderTemplate(reviewSettings(settings).reminderMessage, vars(company, client!, link));
    const outcome = await deliver(env, admin, {
      companyId: row.company_id, company, client: client!, channels: plan.channels, text, subject: `A quick reminder from ${company.name}`, record: "Review reminder",
      requestId: row.id, sentBy: null, baseUrl,
    });
    // A failed reminder counts too, so it can't go round again, and Recent requests says it failed
    // and why; the next one keeps its time.
    const sent = outcome.sent.length > 0;
    await finish(sent ? "sent" : "failed", null, sent ? undefined : outcome.errors[0]);
    return sent ? "sent" : "failed";
  };

  for (const row of claimed) {
    try {
      const outcome = await remind(row);
      if (outcome) tally[outcome]++;
    } catch (failure) {
      // One reminder's trouble doesn't hold up the rest. Its claim runs out and a later run has it,
      // unless it had started: then it's counted, and doesn't go again.
      console.error("A review reminder didn't finish", failure);
      reportError(failure, { feature: "review reminders", request: row.id });
      tally.errors++;
    }
  }
  return tally;
}

/**
 * After the reminder days change in Marketing → Reviews: asks still waiting on a reminder have it
 * when the new days say, or none when there are no more. Says how many changed.
 */
export async function rescheduleReminders(admin: Db, companyId: string, timeZone: string, reminderDays: readonly number[], now = new Date()) {
  const { data: open, error } = await admin
    .from("review_requests")
    .select("id, sent_at, reminders_sent, last_reminder_at, next_reminder_at")
    .eq("company_id", companyId)
    .eq("status", "sent")
    .is("clicked_at", null)
    .not("next_reminder_at", "is", null)
    .limit(5000);
  if (error) throw new Error(error.message);
  let changed = 0;
  for (const row of open ?? []) {
    const next = rescheduledReminder(new Date(row.sent_at), row.reminders_sent, reminderDays, timeZone, now, new Date(row.last_reminder_at ?? row.sent_at));
    if (next && next.getTime() === Date.parse(row.next_reminder_at!)) continue;
    // Only while it's still waiting: one stopped meanwhile stays stopped.
    const { error: updateError } = await admin
      .from("review_requests")
      .update(next ? { next_reminder_at: next.toISOString() } : { next_reminder_at: null, reminder_note: reminderDays.length ? "No more reminders are set" : "Reminders were turned off" })
      .eq("id", row.id)
      .not("next_reminder_at", "is", null);
    if (updateError) throw new Error(updateError.message);
    changed++;
  }
  return changed;
}
