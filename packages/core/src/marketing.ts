/**
 * Crewtavo - Marketing (Apps → Crewtavo - Marketing, docs/marketing-plan.md): its switch, and how
 * review asks go, Jobber's way. Shared by the API (services/reviews.ts sends asks and reminders, the
 * Twilio webhook reads STOP) and Marketing → Reviews, which edits the two starter rules
 * (review_after_job and review_recurring) so the rules stay the one place asking is set.
 *
 *   settings.marketing   {enabled}: installed or not (supabase/migrations/20261030000200_marketing_app.sql).
 *   settings.reviews     {recurring_after_visits, reminders: [{days}], reminder_message}.
 *   settings.review_url and settings.review_message stay where they always were.
 */
import { triggerDef, type Action, type Condition } from "./automations";
import { addDays, localDate, localTime, zonedTimeToUtc } from "./time";

type Settings = Record<string, unknown> | null | undefined;

/** Marketing is installed. Like every built-in app, a company without the switch has it off. */
export const marketingOn = (settings: Settings) => (settings?.marketing as { enabled?: unknown } | undefined)?.enabled === true;

/** An automatic ask goes to a client at most once in this many days (about 6 months), as Jobber's. */
export const REVIEW_GAP_DAYS = 182;

/** What clients get until the business writes its own (settings.review_message). */
export const DEFAULT_REVIEW_MESSAGE =
  "Hi {{client.first_name}}, thank you for choosing {{company.name}}! If you have a minute, would you leave us a quick review? It really helps a small business like ours.\n\n{{link}}";

/** A reminder, until the business writes its own (settings.reviews.reminder_message). */
export const DEFAULT_REMINDER_MESSAGE =
  "Hi {{client.first_name}}, just a friendly reminder from {{company.name}}. If you have a minute, a quick review would mean a lot to a small business like ours.\n\n{{link}}";

/** Jobber's: two reminders, 3 and 5 days after the ask. */
export const DEFAULT_REMINDER_DAYS: readonly number[] = [3, 5];
export const DEFAULT_RECURRING_VISITS = 3;
export const MAX_RECURRING_VISITS = 20;
export const MAX_REMINDER_DAYS = 30;
/** Reminders go at this time of day, in the company's time zone. */
export const REMINDER_TIME = "13:30";

export interface ReviewSettings {
  /** The recurring job's visit to ask after: 1 to 20. */
  recurringAfterVisits: number;
  /** Days after the ask for each reminder: none, one or two, each later than the one before. */
  reminderDays: number[];
  reminderMessage: string;
}

/** settings.reviews with its defaults, kept in range. The database reads the visit count the same way (private.review_visits). */
export function reviewSettings(settings: Settings): ReviewSettings {
  const reviews = (settings?.reviews ?? {}) as { recurring_after_visits?: unknown; reminders?: unknown; reminder_message?: unknown };
  const visits = reviews.recurring_after_visits;
  const recurringAfterVisits =
    typeof visits === "number" && Number.isFinite(visits) ? Math.max(1, Math.min(MAX_RECURRING_VISITS, Math.round(visits))) : DEFAULT_RECURRING_VISITS;
  let reminderDays = [...DEFAULT_REMINDER_DAYS];
  if (Array.isArray(reviews.reminders)) {
    reminderDays = [];
    for (const reminder of reviews.reminders) {
      const days = (reminder as { days?: unknown } | null)?.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_REMINDER_DAYS) continue;
      if (reminderDays.length && days <= reminderDays.at(-1)!) continue;
      reminderDays.push(days);
      if (reminderDays.length === 2) break;
    }
  }
  const message = typeof reviews.reminder_message === "string" && reviews.reminder_message.trim() ? reviews.reminder_message : DEFAULT_REMINDER_MESSAGE;
  return { recurringAfterVisits, reminderDays, reminderMessage: message };
}

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

// ---------------------------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------------------------

/** Between 9pm and 9am in the company's time zone, when an automatic first ask doesn't text. */
export function inQuietHours(at: Date, timeZone: string): boolean {
  const time = localTime(at, timeZone);
  return time >= "21:00" || time < "09:00";
}

/** The next 9am in the company's time zone. */
export function quietHoursEnd(at: Date, timeZone: string): Date {
  const day = localDate(at, timeZone);
  return zonedTimeToUtc(localTime(at, timeZone) < "09:00" ? day : addDays(day, 1), "09:00", timeZone);
}

/** 1:30pm, `days` days after the ask, in the company's time zone. */
export function reminderAt(sentAt: Date, days: number, timeZone: string): Date {
  return zonedTimeToUtc(addDays(localDate(sentAt, timeZone), days), REMINDER_TIME, timeZone);
}

/**
 * When the reminder after `sentCount` reminders is due, or null when there are no more. Never
 * before 1:30pm the day after `now`, so a reminder that went out late isn't followed minutes later
 * by the next one.
 */
export function nextReminder(sentAt: Date, sentCount: number, reminderDays: readonly number[], timeZone: string, now: Date = sentAt): Date | null {
  const days = reminderDays[sentCount];
  if (days === undefined) return null;
  const due = reminderAt(sentAt, days, timeZone);
  const soonest = reminderAt(now, 1, timeZone);
  return due > soonest ? due : soonest;
}

/** The next 1:30pm, for a reminder that came due during quiet hours. */
function nextReminderTime(now: Date, timeZone: string): Date {
  const today = localDate(now, timeZone);
  return zonedTimeToUtc(localTime(now, timeZone) < REMINDER_TIME ? today : addDays(today, 1), REMINDER_TIME, timeZone);
}

/**
 * When an ask still waiting on a reminder has it once the reminder days change in Marketing →
 * Reviews: on its day by the new days, or at the next 1:30pm when that day has gone by, and never
 * before 1:30pm the day after the last one (`lastAt`, the ask itself before any). Null when there
 * are no more.
 */
export function rescheduledReminder(sentAt: Date, sentCount: number, reminderDays: readonly number[], timeZone: string, now: Date, lastAt: Date = sentAt): Date | null {
  const days = reminderDays[sentCount];
  if (days === undefined) return null;
  const times = [reminderAt(sentAt, days, timeZone), nextReminderTime(now, timeZone), reminderAt(lastAt, 1, timeZone)];
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

// ---------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------

const isEmailAddress = (value: string | null | undefined) => Boolean(value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()));

export type AskChannel = "email" | "sms" | "both";
export type SendChannel = "email" | "sms";

/** What's known about reaching the client, and whether the company can send email. */
export interface Reach {
  name: string;
  hasEmail: boolean;
  hasPhone: boolean;
  /** They texted STOP (clients.sms_opt_out_at). */
  textsOff: boolean;
  /** The company has email connected (its own mailbox, or the server's). */
  emailReady: boolean;
  /** This Crewtavo can text (Twilio is set up). */
  smsReady: boolean;
}

/**
 * How an ask goes: `send` the channels to use; `wait` until quiet hours end (a text that has no
 * email to go by instead); or neither, with `skip` saying why. `setup` when that's the company's to
 * fix (email isn't connected) rather than the client's.
 */
export interface AskPlan {
  send: SendChannel[];
  wait?: true;
  skip?: string;
  setup?: true;
}

/** "Ana texted STOP, so texts to them are off." */
export const textsOffReason = (name: string) => `${name} texted STOP, so texts to them are off.`;
export const EMAIL_NOT_CONNECTED = "Email isn't connected yet, so review asks can't go by email. An admin can connect it in Settings → Email.";
export const TEXTS_NOT_SET_UP = "Texting isn't set up on this Crewtavo, so review asks can't go by text.";

/** A client who texted STOP gets no texts from Crewtavo. */
export const textsOff = (client: { sms_opt_out_at?: string | null } | null | undefined) => Boolean(client?.sms_opt_out_at);

/**
 * The channels a first ask goes by. Texting needs a phone number and the client not to have texted
 * STOP; email needs an address and email connected. In quiet hours (automatic asks only) it goes by
 * email alone, as Jobber's does, or waits until 9am when only a text would reach them.
 */
export function askChannels(requested: AskChannel, reach: Reach, quiet: boolean): AskPlan {
  const email = reach.hasEmail && reach.emailReady;
  const text = reach.hasPhone && !reach.textsOff && reach.smsReady;
  if (quiet) {
    if (email) return { send: ["email"] };
    if (requested !== "email" && text) return { send: [], wait: true };
  } else {
    const send: SendChannel[] = [];
    if (requested !== "sms" && email) send.push("email");
    if (requested !== "email" && text) send.push("sms");
    if (send.length) return { send };
  }
  return { send: [], ...whyNot(requested, reach) };
}

function whyNot(requested: AskChannel, reach: Reach): { skip: string; setup?: true } {
  const byEmail = reach.hasEmail ? { skip: EMAIL_NOT_CONNECTED, setup: true as const } : { skip: `${reach.name} has no email address.` };
  const byText = !reach.hasPhone
    ? { skip: `${reach.name} has no phone number.` }
    : reach.textsOff
      ? { skip: textsOffReason(reach.name) }
      : { skip: TEXTS_NOT_SET_UP, setup: true as const };
  if (requested === "email") return byEmail;
  if (requested === "sms") return byText;
  if (!reach.hasEmail && !reach.hasPhone) return { skip: `${reach.name} has no email address or phone number.` };
  // Both: a client with an email address would get it once email is connected, so that's the reason.
  return reach.hasEmail ? byEmail : byText;
}

/** A client as review asks see them: how to reach them, and whether they want to be asked. */
export interface AskClient {
  display_name: string;
  email: string | null;
  phone: string | null;
  status?: string | null;
  review_opt_out?: boolean | null;
  marketing_opt_out?: boolean | null;
  sms_opt_out_at?: string | null;
}

/** Why a client isn't asked at all, by hand or automatically: they opted out, or they're archived. Null when they can be. */
export function notAsked(client: AskClient): string | null {
  const name = client.display_name;
  if (client.review_opt_out) return `${name} asked not to get review requests. You can change that on their page.`;
  if (client.marketing_opt_out) return `${name} unsubscribed from marketing, so they aren't asked for reviews.`;
  if (client.status === "archived") return `${name} is archived. Restore them to ask for a review.`;
  return null;
}

/** What askChannels needs to know about a client, with what this Crewtavo can send. */
export const reachOf = (client: AskClient, ready: { email: boolean; sms: boolean }): Reach => ({
  name: client.display_name,
  hasEmail: isEmailAddress(client.email),
  hasPhone: Boolean(client.phone),
  textsOff: textsOff(client),
  emailReady: ready.email,
  smsReady: ready.sms,
});

/** Why an ask by hand by `channel` can't go to the client, or null when it can (right away, whatever the time). */
export function askRefusal(client: AskClient, channel: AskChannel, ready: { email: boolean; sms: boolean }): string | null {
  const plan = askChannels(channel, reachOf(client, ready), false);
  return notAsked(client) ?? (plan.send.length ? null : plan.skip!);
}

/** The channels a recorded ask went by. */
export const sentChannels = (channel: string): SendChannel[] => (channel === "both" ? ["email", "sms"] : channel === "email" || channel === "sms" ? [channel] : []);

// ---------------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------------

export interface ReminderRequest {
  channel: string;
  status: string;
  clicked_at: string | null;
  sent_at: string;
  reminders_sent: number;
}

export interface ReminderClient {
  email: string | null;
  phone: string | null;
  status: string;
  review_opt_out: boolean;
  marketing_opt_out: boolean;
  sms_opt_out_at: string | null;
}

export type ReminderPlan =
  | { kind: "stop"; why: string }
  | { kind: "later"; until: Date }
  | { kind: "send"; channels: SendChannel[]; next: Date | null };

/**
 * What to do with a reminder that's due: send it by the ask's channels (and when the next is due),
 * wait for 1:30pm when it came due in quiet hours, or stop for good. Each reminder goes by the
 * settings at the time, so fewer reminders stops at the next one due. The client's stops have the
 * same notes as the database writes when they happen (private.client_stops_review_reminders).
 */
export function reminderPlan(input: {
  request: ReminderRequest;
  client: ReminderClient | null;
  marketingOn: boolean;
  hasReviewUrl: boolean;
  emailReady: boolean;
  smsReady: boolean;
  settings: Settings;
  now: Date;
  timeZone: string;
}): ReminderPlan {
  const { request, client, now, timeZone } = input;
  if (request.clicked_at || request.status === "clicked") return { kind: "stop", why: "They opened the link" };
  if (request.status === "failed") return { kind: "stop", why: "The ask wasn't sent" };
  if (!client) return { kind: "stop", why: "The client was deleted" };
  if (client.status === "archived") return { kind: "stop", why: "The client was archived" };
  if (client.review_opt_out) return { kind: "stop", why: "They asked not to get review requests" };
  if (client.marketing_opt_out) return { kind: "stop", why: "They unsubscribed from marketing" };
  if (!input.marketingOn) return { kind: "stop", why: "Marketing was uninstalled" };
  if (!input.hasReviewUrl) return { kind: "stop", why: "The review link was removed" };
  const { reminderDays } = reviewSettings(input.settings);
  if (request.reminders_sent >= reminderDays.length) return { kind: "stop", why: "No more reminders are set" };

  const asked = sentChannels(request.channel);
  const hasEmail = isEmailAddress(client.email);
  const channels = asked.filter((c) => (c === "email" ? hasEmail && input.emailReady : Boolean(client.phone) && !textsOff(client) && input.smsReady));
  if (!channels.length) {
    const byEmail = hasEmail ? "Email isn't connected" : "Their email address was removed";
    const byText = !client.phone ? "Their phone number was removed" : textsOff(client) ? "They texted STOP" : "Texting isn't set up";
    // By both, as a first ask says: what the business can fix when there's an address, then the text's reason.
    const why = !asked.length
      ? "It was a link copied by hand"
      : asked.length === 1
        ? (asked[0] === "email" ? byEmail : byText)
        : hasEmail ? byEmail : client.phone ? byText : "Their email address and phone number were removed";
    return { kind: "stop", why };
  }
  if (inQuietHours(now, timeZone)) return { kind: "later", until: nextReminderTime(now, timeZone) };
  return { kind: "send", channels, next: nextReminder(new Date(request.sent_at), request.reminders_sent + 1, reminderDays, timeZone, now) };
}

/** An ask in Marketing → Reviews' Recent requests, with its reminders. */
export interface RecentAsk {
  channel: string;
  status: string;
  reminders_sent: number;
  reminders_failed?: number | null;
  next_reminder_at: string | null;
  reminder_note: string | null;
  reminder_error?: string | null;
}

/** "Reminders stopped: they texted STOP". A note that already speaks of reminders reads as it is. */
export function reminderStopNote(note: string): string {
  if (/reminder/i.test(note)) return note;
  // Marketing is the app's name, and STOP is what they texted.
  const reason = /^(Marketing|STOP)\b/.test(note) ? note : note.charAt(0).toLowerCase() + note.slice(1);
  return `Reminders stopped: ${reason}`;
}

/**
 * What Recent requests says about an ask's reminders: how many went, how many failed and why, and
 * when the next one is due or why there are no more. `remindersSet` is how many the business has
 * set now; `when` formats a time in the company's time zone.
 */
export function reminderLines(ask: RecentAsk, remindersSet: number, when: (iso: string) => string): string[] {
  const failed = Math.min(ask.reminders_failed ?? 0, ask.reminders_sent);
  const went = ask.reminders_sent - failed;
  const lines: string[] = [];
  if (went) lines.push(`${went} ${went === 1 ? "reminder" : "reminders"} sent`);
  if (failed) lines.push(`${failed === 1 ? "Reminder" : `${failed} reminders`} failed${ask.reminder_error ? `: ${ask.reminder_error}` : ""}`);
  if (ask.next_reminder_at && ask.status === "sent" && ask.reminders_sent < remindersSet) lines.push(`Next reminder ${when(ask.next_reminder_at)}`);
  else if (ask.reminder_note && ask.status === "sent") lines.push(reminderStopNote(ask.reminder_note));
  return lines;
}

/**
 * Why an ask failed, or for one by text and email that went one way only (its channel says which),
 * why the other didn't go.
 */
export function askError(ask: { channel: string; status: string; error: string | null }): string | null {
  if (!ask.error) return null;
  if (ask.status === "failed") return ask.error;
  return `By ${ask.channel === "sms" ? "text" : "email"} only: ${ask.error}`;
}

/** The pill for an ask: opened, failed, a copied link nobody opened yet, or sent. */
export function askStatus(ask: { channel: string; status: string }): { label: string; tone: "good" | "danger" | "muted" } {
  if (ask.status === "clicked") return { label: "Opened link", tone: "good" };
  if (ask.status === "failed") return { label: "Failed", tone: "danger" };
  return { label: ask.channel === "link" ? "Link copied" : "Sent", tone: "muted" };
}

// ---------------------------------------------------------------------------------------------
// The "Ask automatically" form: the starter rules it edits
// ---------------------------------------------------------------------------------------------

export type AskWhen = "job.completed" | "visit.completed" | "invoice.paid";
export type AskRuleKind = "after_job" | "recurring";
export const RECURRING_TRIGGER = "job.recurring_third_visit";

/** The choices for Ask when, named as the triggers are everywhere else. */
export const ASK_WHEN: Array<{ verb: AskWhen; label: string }> = (["job.completed", "visit.completed", "invoice.paid"] as const).map((verb) => ({
  verb,
  label: triggerDef(verb)?.label ?? verb,
}));

const NOT_RECURRING: Condition = { field: "job_kind", op: "not_equals", value: "recurring" };

/**
 * The conditions the form writes for each choice. Recurring work waits for the recurring rule
 * instead (a first ask starts the 6 months), a recurring job marked complete at the end of its
 * season too, and a paid deposit or progress invoice comes before the work is done.
 */
export const ASK_CONDITIONS: Record<AskWhen, Condition[]> = {
  "job.completed": [{ field: "kind", op: "not_equals", value: "recurring" }],
  "visit.completed": [{ field: "kind", op: "equals", value: "job" }, NOT_RECURRING],
  "invoice.paid": [NOT_RECURRING, { field: "invoice_kind", op: "not_equals", value: "deposit" }, { field: "invoice_kind", op: "not_equals", value: "progress" }],
};

export const ASK_TEMPLATE_KEYS: Record<AskRuleKind, string> = { after_job: "review_after_job", recurring: "review_recurring" };

/** The rule's name for each choice. A name someone wrote themselves stays. */
export const ASK_NAMES: Record<AskWhen, string> = {
  "job.completed": "Ask for a Google review after a job",
  "visit.completed": "Ask for a Google review after a visit",
  "invoice.paid": "Ask for a Google review when an invoice is paid",
};
export const RECURRING_NAME = "Ask for a Google review on recurring work";

const STARTER_DESCRIPTIONS = {
  after_job: "Sends your review link a day after a job is completed.",
  recurring_old: "Sends your review link a day after a recurring job's third visit, once for each job.",
  recurring: "Sends your review link a day after a recurring job reaches the visit you chose in Marketing, once for each job.",
};

const AFTER_WHAT: Record<AskWhen, string> = {
  "job.completed": "a job is completed",
  "visit.completed": "a visit is completed, except on recurring work",
  "invoice.paid": "an invoice is paid in full, except deposits and recurring work",
};

/** "a day after", "2 hours after", "as soon as". */
function afterDelay(minutes: number) {
  if (!minutes) return "as soon as";
  if (minutes === 1440) return "a day after";
  if (minutes % 1440 === 0) return `${minutes / 1440} days after`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"} after`;
  return `${minutes} minutes after`;
}

/** The description the form writes for a rule. */
export function askDescription(kind: AskRuleKind, when: AskWhen, delayMinutes: number): string {
  if (kind === "recurring") return delayMinutes === 1440 ? STARTER_DESCRIPTIONS.recurring : `Sends your review link ${afterDelay(delayMinutes)} a recurring job reaches the visit you chose in Marketing, once for each job.`;
  if (when === "job.completed" && delayMinutes === 1440) return STARTER_DESCRIPTIONS.after_job;
  return `Sends your review link ${afterDelay(delayMinutes)} ${AFTER_WHAT[when]}.`;
}

/** When the form's rule sends its ask: "Goes out a day after a visit is completed." */
export function askTiming(kind: AskRuleKind, when: AskWhen, delayMinutes: number): string {
  const label = triggerDef(when)?.label ?? when;
  const what = kind === "recurring" ? "a recurring job reaches that visit" : label.charAt(0).toLowerCase() + label.slice(1);
  return `Goes out ${afterDelay(delayMinutes)} ${what}.`;
}

/** Descriptions the form (or the starter rules) wrote: the form replaces only these. */
export function isAskDescription(description: string | null | undefined, kind: AskRuleKind, delayMinutes: number): boolean {
  if (!description?.trim()) return true;
  const known =
    kind === "recurring"
      ? [STARTER_DESCRIPTIONS.recurring_old, STARTER_DESCRIPTIONS.recurring, askDescription("recurring", "job.completed", delayMinutes)]
      : [STARTER_DESCRIPTIONS.after_job, ...ASK_WHEN.map((w) => askDescription("after_job", w.verb, delayMinutes))];
  return known.includes(description.trim());
}

export interface AskRule {
  name: string;
  description?: string | null;
  trigger: string;
  enabled: boolean;
  delay_minutes: number;
  conditions: unknown;
  actions: unknown;
}

export interface AskRuleForm {
  when: AskWhen;
  channel: AskChannel;
  enabled: boolean;
}

const conditionKey = (c: Condition) => `${c.field}|${c.op}|${Array.isArray(c.value) ? c.value.map((v) => String(v).trim().toLowerCase()).sort().join(",") : String(c.value).trim().toLowerCase()}`;

/** The same conditions, in any order. */
function sameConditions(actual: unknown, expected: Condition[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const have = (actual as Condition[]).map(conditionKey).sort();
  const want = expected.map(conditionKey).sort();
  return have.every((key, i) => key === want[i]);
}

/**
 * The form's view of a starter rule, or null when it was changed into something the form can't show
 * (other actions, other conditions, another trigger): then the form links to the rule instead.
 */
export function readAskRule(rule: AskRule | null | undefined, kind: AskRuleKind): { when: AskWhen | typeof RECURRING_TRIGGER; channel: AskChannel; enabled: boolean; delay: number } | null {
  if (!rule) return null;
  const actions = rule.actions as Action[] | null;
  if (!Array.isArray(actions) || actions.length !== 1) return null;
  const action = actions[0]!;
  if (action.type !== "request_review" || !["email", "sms", "both"].includes(action.channel)) return null;
  if (kind === "recurring") {
    if (rule.trigger !== RECURRING_TRIGGER || !sameConditions(rule.conditions, [])) return null;
    return { when: RECURRING_TRIGGER, channel: action.channel, enabled: rule.enabled, delay: rule.delay_minutes };
  }
  const when = ASK_WHEN.find((w) => w.verb === rule.trigger)?.verb;
  if (!when || !sameConditions(rule.conditions, ASK_CONDITIONS[when])) return null;
  return { when, channel: action.channel, enabled: rule.enabled, delay: rule.delay_minutes };
}

/**
 * The change the form makes to a starter rule: its trigger, conditions, the one review action and
 * whether it's on. The wait stays, and so do a name and description someone wrote themselves. With
 * no rule (it was deleted), the whole rule to put back.
 */
export function askRuleUpdate(rule: AskRule | null | undefined, kind: AskRuleKind, form: AskRuleForm) {
  const trigger = kind === "recurring" ? RECURRING_TRIGGER : form.when;
  const conditions = kind === "recurring" ? [] : ASK_CONDITIONS[form.when];
  const change = {
    trigger,
    conditions,
    actions: [{ type: "request_review", channel: form.channel }] as Action[],
    enabled: form.enabled,
  };
  const name = kind === "recurring" ? RECURRING_NAME : ASK_NAMES[form.when];
  if (!rule) {
    return { ...change, template_key: ASK_TEMPLATE_KEYS[kind], name, description: askDescription(kind, form.when, 1440), delay_minutes: 1440 };
  }
  const names = kind === "recurring" ? [RECURRING_NAME] : Object.values(ASK_NAMES);
  return {
    ...change,
    ...(names.includes(rule.name.trim()) ? { name } : {}),
    ...(isAskDescription(rule.description, kind, rule.delay_minutes) ? { description: askDescription(kind, form.when, rule.delay_minutes) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Texts from clients
// ---------------------------------------------------------------------------------------------

/** Twilio's opt-out words, the US carriers' and the FCC's (2025): the whole message is the word. */
export const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT OUT", "REVOKE"];
export const START_WORDS = ["START", "UNSTOP", "YES"];

/**
 * What a text from a client means: "stop" (texts off), "start" (back on) or null (an ordinary text).
 * Read as Twilio reads it: the whole message is the word, in any case, with spaces before it and
 * punctuation, symbols or emoji after it. Only ASCII letters, digits and spaces are read as such,
 * so the database reads old messages exactly the same way whatever its locale (private.sms_keyword,
 * supabase/migrations/20261030000500_marketing_stops.sql).
 */
export function smsKeyword(body: string | null | undefined): "stop" | "start" | null {
  const word = (body ?? "")
    .replace(/^[ \t\n\r\f\v]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "")
    .replace(/[ \t\n\r\f\v]+/g, " ")
    .replace(/[a-z]/g, (letter) => letter.toUpperCase());
  if (STOP_WORDS.includes(word)) return "stop";
  if (START_WORDS.includes(word)) return "start";
  return null;
}
