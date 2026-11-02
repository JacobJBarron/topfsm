/**
 * Background tasks, run by server.ts's built-in scheduler (or by hand: GET/POST /api/cron/:task
 * with CRON_SECRET). Each is safe to run twice.
 */
import { addDays, jobWeatherRules, localDate, occurrenceDates, weatherRisks, zonedTimeToUtc } from "@crewtavo/core";
import type { Env } from "./env";
import { runAccountingJob, SentButUnrecorded } from "./integrations/accounting";
import { runCalendarJob, syncDueCalendars } from "./integrations/calendars";
import { reconcileAutopayProcessing, syncStripeInvoice } from "./integrations/stripe";
import { reportError } from "./lib/monitoring";
import { emailConfigured, smsConfigured } from "./lib/notify";
import { adminClient, type Db } from "./lib/supabase";
import { runAddressTask } from "./services/address";
import { rollUpVisits } from "./services/analytics";
import { chargeDueAutopay, runAutopayJob } from "./services/autopay";
import { checkHosting } from "./services/hosting";
import { purgeTrash, tidyApplicantFiles, tidyPlanFiles, tidySubFiles, tidyUnrecordedFiles } from "./services/planFiles";
import { keepRailwayAlive } from "./services/railway";
import { checkStorage } from "./services/storageUsage";
import { emitInactiveClients } from "./services/automatedCampaigns";
import { processAutomations } from "./services/automations";
import { processCampaigns } from "./services/campaigns";
import { syncDueReviews } from "./services/googleReviews";
import { checkMetaAccess, postDueSocial, tidySocialImages } from "./services/social";
import { sendDueReminders } from "./services/reviews";
import { deliverNotifications } from "./services/delivery";
import { remindSubs } from "./services/subs";
import { dailyOutlook } from "./services/external";
import { autoRoutes } from "./services/routes";

export const TASKS = ["automations", "campaigns", "notify", "outbox", "autopay", "calendars", "recurrence", "followups", "weather", "address", "railway", "hosting", "plans", "trash", "storage", "routes", "website", "reviews", "inactive", "review_sync", "social"] as const;
export type TaskName = (typeof TASKS)[number];

/** Cron expressions -> tasks, run by server.ts's scheduler. */
export const CRON_TASKS: Record<string, TaskName[]> = {
  // Social posts whose time has come (services/social.ts), one claim at a time.
  "* * * * *": ["automations", "campaigns", "notify", "social"],
  "*/2 * * * *": ["address"],
  // Review reminders go at 1:30pm in each company's time zone (services/reviews.ts). Autopay charges
  // what's due (services/autopay.ts); its receipts and notices go out through the outbox.
  "*/5 * * * *": ["outbox", "reviews", "autopay"],
  "*/15 * * * *": ["calendars"],
  // Google reviews come in every 30 minutes for each company with Google Business Profile connected
  // (services/googleReviews.ts); review_syncs_due says which are due.
  "12,42 * * * *": ["review_sync"],
  "0 * * * *": ["followups"],
  // Clients who haven't had a visit in a while: hourly, so each company's own 10am is met; at most
  // 100 a day for each rule (services/automatedCampaigns.ts). The automations task sends them.
  "5 * * * *": ["inactive"],
  "0 */6 * * *": ["weather"],
  "30 * * * *": ["routes"],
  "10 * * * *": ["website"],
  "15 6 * * *": ["recurrence"],
  "40 5 * * *": ["railway"],
  "45 2,14 * * *": ["hosting"],
  "20 4 * * *": ["plans"],
  // Deletes for good what has been in the Trash for 30 days (services/planFiles.ts).
  "35 4 * * *": ["trash"],
  // Warns owners and admins as files near the storage limit, on Railway or not (services/storageUsage.ts).
  "50 */6 * * *": ["storage"],
};

export async function runTask(name: TaskName, env: Env): Promise<Record<string, unknown>> {
  switch (name) {
    case "automations":
      return processAutomations(env, { limit: 50 });
    case "campaigns":
      return processCampaigns(env);
    case "notify":
      return deliverNotifications(env);
    case "outbox":
      return drainOutbox(env);
    case "autopay":
      return chargeDueAutopay(env);
    case "calendars":
      return syncDueCalendars(env, adminClient(env));
    case "recurrence":
      return materializeRecurringVisits(env);
    case "followups":
      return hourlyUpkeep(env);
    case "weather":
      return weatherHolds(env);
    case "address":
      return runAddressTask(env, adminClient(env));
    case "railway":
      return keepRailwayAlive(env, adminClient(env));
    case "hosting":
      return checkHosting(env, adminClient(env));
    case "plans": {
      const admin = adminClient(env);
      return {
        ...(await tidyPlanFiles(admin)),
        subs: await tidySubFiles(admin),
        applicants: await tidyApplicantFiles(admin),
        // Guide covers, and quote and visit photos, uploaded for a save that failed.
        photos: await tidyUnrecordedFiles(admin),
        // Social posts' pictures whose links ran out, and each Page's sign-in, read from Meta.
        social: await tidySocialImages(admin),
        meta: await checkMetaAccess(env, admin),
      };
    }
    case "trash":
      return purgeTrash(adminClient(env));
    case "storage":
      return checkStorage(env, adminClient(env));
    case "routes":
      return autoRoutes(env);
    case "website":
      return rollUpVisits(adminClient(env));
    case "reviews":
      return sendDueReminders(env);
    case "inactive":
      return emitInactiveClients(env);
    case "review_sync":
      return syncDueReviews(env);
    case "social":
      return postDueSocial(env);
  }
}

/**
 * Push queued accounting changes and visit changes for Google Calendar, keep Stripe invoices in
 * step, and send autopay's receipts, notices and copies of agreements (services/autopay.ts);
 * failures retry with exponential backoff, up to 8 attempts.
 */
async function drainOutbox(env: Env) {
  const admin = adminClient(env);
  // A rain day can move dozens of visits at once; they should reach Google in one run.
  const { data: rows, error } = await admin.rpc("claim_outbox", { p_limit: 100 });
  if (error) throw new Error(error.message);
  let done = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    const calendar = row.topic.startsWith("calendar.");
    const stripe = row.topic.startsWith("stripe.");
    const autopay = row.topic.startsWith("autopay.");
    try {
      const job = { ...row, payload: row.payload as Record<string, string> };
      if (stripe) await syncStripeInvoice(env, admin, row.company_id, job.payload.invoice_id!);
      else if (autopay) await runAutopayJob(env, admin, { company_id: row.company_id, topic: row.topic, payload: job.payload });
      else await (calendar ? runCalendarJob(env, admin, job) : runAccountingJob(env, admin, job));
      await admin.from("outbox").update({ done_at: new Date().toISOString(), locked_until: null, last_error: null }).eq("id", row.id);
      done++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      // Sent but not recorded: another try would put a second copy in the books.
      const giveUp = row.attempts >= 8 || err instanceof SentButUnrecorded;
      await admin
        .from("outbox")
        .update({
          locked_until: null,
          last_error: message.slice(0, 1000),
          run_after: new Date(Date.now() + 2 ** row.attempts * 60_000).toISOString(),
          dead_at: giveUp ? new Date().toISOString() : null,
        })
        .eq("id", row.id);
      // One record that never goes through shows on the Apps page, but the app stays connected so
      // everything else keeps syncing (a refused sign-in marks it in integrations/tokens.ts).
      if (giveUp) {
        const providers = calendar ? ["google_calendar"] : stripe || autopay ? ["stripe"] : ["quickbooks", "zoho_books"];
        await admin.from("integrations").update({ last_error: message.slice(0, 500) }).eq("company_id", row.company_id).in("provider", providers).eq("status", "connected");
      }
    }
  }
  return { claimed: rows?.length ?? 0, done, failed };
}

type RecurringJobRow = {
  id: string;
  company_id: string;
  title: string;
  property_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
  recurrence_rule: string | null;
  active_months: number[] | null;
  visit_start_time: string | null;
  visit_duration_min: number;
  visit_time_fixed?: boolean;
  default_crew_id: string | null;
  company: unknown;
};

const RECURRING_FIELDS =
  "id, company_id, title, property_id, starts_on, ends_on, recurrence_rule, active_months, visit_start_time, visit_duration_min, visit_time_fixed, default_crew_id, company:companies(timezone)";

/**
 * Bring one recurring job's visits in line with its schedule for the next 60 days: add missing
 * visits, and (when `prune`) remove untouched future visits the schedule no longer includes.
 */
export async function materializeJob(admin: Db, job: RecurringJobRow, prune = false): Promise<{ created: number; removed: number }> {
  if (!job.recurrence_rule || !job.starts_on) return { created: 0, removed: 0 };
  const tz = (job.company as { timezone?: string } | null)?.timezone ?? "UTC";
  const today = localDate(new Date(), tz);
  const horizon = addDays(today, 60);
  const dates = occurrenceDates({ ...job, starts_on: job.starts_on, recurrence_rule: job.recurrence_rule }, today, horizon);
  let removed = 0;
  if (prune) {
    const { data: stale } = await admin
      .from("visits")
      .select("id, recurrence_key")
      .eq("job_id", job.id)
      .eq("status", "scheduled")
      .not("recurrence_key", "is", null)
      .gte("scheduled_on", today);
    let drop = (stale ?? []).filter((v) => !dates.includes(v.recurrence_key!)).map((v) => v.id);
    if (drop.length) {
      // A visit that job pay whose work is done (or paid) covers stays: that pay's visits are kept as
      // they were (20261025003001_job_pay.sql), so deleting it would be refused, and the rest with it.
      const { data: kept, error: keptError } = await admin.from("job_pay_visits").select("visit_id, pay:job_pay!inner(status)").in("visit_id", drop).in("pay.status", ["done", "paid"]);
      if (keptError) throw new Error(keptError.message);
      const keep = new Set((kept ?? []).map((k) => k.visit_id));
      drop = drop.filter((id) => !keep.has(id));
    }
    if (drop.length) {
      const { error: dropError } = await admin.from("visits").delete().in("id", drop);
      if (dropError) throw new Error(dropError.message);
      removed = drop.length;
    }
  }
  if (!dates.length) return { created: 0, removed };
  // A date whose visit someone deleted stays deleted (the database remembers it in recurrence_skips).
  const { data: skips, error: skipError } = await admin.from("recurrence_skips").select("recurrence_key").eq("job_id", job.id).gte("recurrence_key", today);
  if (skipError) throw new Error(skipError.message);
  const skipped = new Set((skips ?? []).map((s) => s.recurrence_key));
  const wanted = dates.filter((date) => !skipped.has(date));
  if (!wanted.length) return { created: 0, removed };
  const rows = wanted.map((date) => {
    const start = job.visit_start_time ? zonedTimeToUtc(date, job.visit_start_time, tz) : null;
    return {
      company_id: job.company_id,
      job_id: job.id,
      property_id: job.property_id,
      title: job.title,
      recurrence_key: date,
      scheduled_on: date,
      starts_at: start?.toISOString() ?? null,
      ends_at: start ? new Date(start.getTime() + job.visit_duration_min * 60_000).toISOString() : null,
      time_fixed: Boolean(start && job.visit_time_fixed),
      crew_id: job.default_crew_id,
    };
  });
  const { data, error } = await admin.from("visits").upsert(rows, { onConflict: "job_id,recurrence_key", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(error.message);
  return { created: data?.length ?? 0, removed };
}

export async function recurringJob(admin: Db, jobId: string) {
  const { data } = await admin.from("jobs").select(RECURRING_FIELDS).eq("id", jobId).maybeSingle();
  return data as RecurringJobRow | null;
}

/** Create visits for active recurring jobs, 60 days ahead. recurrence_key prevents duplicates. */
async function materializeRecurringVisits(env: Env) {
  const admin = adminClient(env);
  // Supabase returns at most 1,000 rows per request, so read a page at a time.
  const jobs: RecurringJobRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("jobs")
      .select(RECURRING_FIELDS)
      .eq("kind", "recurring")
      .eq("status", "active")
      .not("recurrence_rule", "is", null)
      .not("starts_on", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    jobs.push(...(data as RecurringJobRow[]));
    if (data.length < 1000) break;
  }

  let created = 0;
  const problems: string[] = [];
  for (const job of jobs) {
    try {
      created += (await materializeJob(admin, job)).created;
    } catch (err) {
      problems.push(`${job.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { jobs: jobs.length, created, problems };
}

/**
 * Hourly upkeep: invoices past their due date flip to overdue (which fires "invoice past due"
 * automations), day-before visit reminder events are emitted for companies that use them, job offers
 * to subs past their time to answer by run out, subs' certificates running out are flagged, saved
 * cards expiring next month are flagged and autopay's bank payments on their way are read back from
 * Stripe, forgotten clocks get a reminder or are stopped, and old sign-in codes are cleared.
 */
async function hourlyUpkeep(env: Env) {
  const admin = adminClient(env);
  // Each step runs on its own: one that fails is reported, and the others still run.
  const problems: string[] = [];
  const step = async <T>(name: string, run: PromiseLike<{ data: T | null; error: { message: string } | null }>) => {
    const { data, error } = await run;
    if (!error) return data;
    problems.push(`${name}: ${error.message}`);
    console.error(`Upkeep step ${name} failed`, error.message);
    reportError(new Error(`${name} failed: ${error.message}`), { task: "followups", step: name });
    return null;
  };
  // Due dates are compared with each company's local date.
  const overdue = await step("mark_overdue_invoices", admin.rpc("mark_overdue_invoices"));
  const reminders = await step("emit_visit_reminders", admin.rpc("emit_visit_reminders"));
  // Maintenance coming due or overdue: one notification per change, to the people who look after it.
  const equipment = await step("emit_equipment_alerts", admin.rpc("emit_equipment_alerts"));
  // Offers to subs left unanswered past their time to answer by: they run out (a new price leaves the
  // agreed one), and the office hears.
  const offers = await step("expire_sub_offers", admin.rpc("expire_sub_offers"));
  // Subs' insurance running out: the office hears 30 days before, 7 days before and on the day, and
  // so does the sub (by email or text, with their link), each once, from 8 in the morning.
  // The sub is only promised a link when there's a way to send it (the company's own mailbox counts too).
  const links = Boolean(env.APP_URL);
  const subAlerts = await step(
    "emit_sub_document_alerts",
    admin.rpc("emit_sub_document_alerts", { p_can_text: links && smsConfigured(env), p_can_email: links && emailConfigured(env) }),
  );
  let reminded = null;
  try {
    reminded = await remindSubs(env, admin, subAlerts ?? []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(`remind_subs: ${message}`);
    reportError(err, { task: "followups", step: "remind_subs" });
  }
  // Autopay cards expiring next month: one payment_method.expiring event each, once per expiry, from
  // 8 in the morning where the company is (for the "A saved card expires next month" automations).
  const cards = await step("emit_card_expiry_alerts", admin.rpc("emit_card_expiry_alerts"));
  // Autopay bank payments on their way for over a day: what Stripe says now is applied (paid, or a
  // bounce the webhook never brought). Stripe is asked, so it's caught like the steps above.
  let autopayProcessing = 0;
  try {
    autopayProcessing = await reconcileAutopayProcessing(env, admin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(`reconcile_autopay_processing: ${message}`);
    console.error("Upkeep step reconcile_autopay_processing failed", message);
    reportError(err, { task: "followups", step: "reconcile_autopay_processing" });
  }
  // Clocks left running: remind after 10 hours, stop after 16 (per-company limits in settings.clock).
  const clocks = await step("clock_upkeep", admin.rpc("clock_upkeep"));
  // Sign-in codes texted to subs over a day ago (services/signInCodes.ts): long run out, kept until now
  // for looking into a run of requests.
  const codes = await step("tidy_sign_in_codes", admin.rpc("tidy_sign_in_codes"));
  return {
    overdue: overdue ?? 0, reminders: reminders ?? 0, equipment: equipment ?? 0, offers: offers ?? 0, subs: { alerts: subAlerts?.length ?? 0, reminded },
    cards: cards ?? 0, autopay_processing: autopayProcessing, clocks, codes: codes ?? 0, problems,
  };
}

const WEATHER_FIELDS =
  "id, scheduled_on, hold_reason, job:jobs(weather_rules, lines:job_line_items(name, service:services(name))), company:companies(weather_rules:settings->weather_rules), property:properties(lat, lng)";

/**
 * Flag tomorrow's visits whose weather rules fail (rain, cold for asphalt, sealcoat dry time): the
 * job's own rules, or else the company's rules for the services on the job.
 */
async function weatherHolds(env: Env) {
  const admin = adminClient(env);
  const from = new Date().toISOString().slice(0, 10);
  // A page at a time, in a fixed order: PostgREST answers with at most 1000 rows.
  const visits = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await admin
      .from("visits")
      .select(WEATHER_FIELDS)
      .eq("status", "scheduled")
      .gte("scheduled_on", from)
      .lte("scheduled_on", addDays(from, 2))
      .order("id")
      .range(start, start + 999);
    if (error) throw new Error(error.message);
    visits.push(...data);
    if (data.length < 1000) break;
  }

  // null: the forecast couldn't be fetched (an outage or rate limit), which isn't a clear sky.
  const outlooks = new Map<string, Awaited<ReturnType<typeof dailyOutlook>> | null>();
  let flagged = 0;
  let unknown = 0;
  for (const v of visits) {
    const services = (v.job?.lines ?? []).flatMap((l) => [l.name, l.service?.name ?? ""]);
    const rules = v.job ? jobWeatherRules(v.job.weather_rules, v.company?.weather_rules, services) : [];
    const p = v.property as { lat: number | null; lng: number | null } | null;
    if (!rules.length || !v.scheduled_on || p?.lat == null || p?.lng == null) continue;
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    if (!outlooks.has(key)) outlooks.set(key, await dailyOutlook(p.lat, p.lng, 4).catch(() => null));
    const outlook = outlooks.get(key);
    // Without a forecast, leave the visit's hold as it is; the next run checks again.
    if (!outlook) {
      unknown++;
      continue;
    }
    const reasons = weatherRisks(rules, v.scheduled_on, outlook);
    const holdReason = reasons.length ? reasons.join("; ") : null;
    if (holdReason !== v.hold_reason) {
      await admin.from("visits").update({ hold_reason: holdReason }).eq("id", v.id);
      if (holdReason) flagged++;
    }
  }
  return { checked: visits.length, flagged, unknown };
}
