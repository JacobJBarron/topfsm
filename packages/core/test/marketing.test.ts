/**
 * Crewtavo - Marketing (src/marketing.ts): its switch, the review settings and their defaults, quiet
 * hours and reminder times in the company's time zone (across a daylight saving change), which
 * channels an ask goes by and who isn't asked, what a due reminder does, how Recent requests reads,
 * the starter rules the Reviews form reads and writes, STOP and START texts, and referrals: their
 * settings, credits worked out as the database works them, what the referral email says, who isn't
 * asked, the line under each referral, and the starter rule that asks a week after a job.
 */
import { describe, expect, it } from "vitest";
import {
  askChannels,
  askDescription,
  askError,
  askRefusal,
  askRuleUpdate,
  askStatus,
  askTiming,
  ASK_CONDITIONS,
  ASK_WHEN,
  DEFAULT_REMINDER_MESSAGE,
  inQuietHours,
  marketingOn,
  nextReminder,
  notAsked,
  ordinal,
  quietHoursEnd,
  readAskRule,
  reminderAt,
  reminderLines,
  reminderPlan,
  reminderStopNote,
  rescheduledReminder,
  reviewSettings,
  smsKeyword,
  textsOff,
  EMAIL_NOT_CONNECTED,
  TEXTS_NOT_SET_UP,
  creditLine,
  creditMoney,
  creditText,
  DEFAULT_REFERRAL_MESSAGE,
  isReferralRule,
  referralAskRefusal,
  referralCredit,
  referralPill,
  referralRewards,
  referralRewardWords,
  REFERRAL_RULE,
  referralRuleTiming,
  referralSettings,
  referralsReady,
  referrerLine,
  type CreditReferral,
  type AskRule,
  type Reach,
  type ReminderClient,
  type ReminderRequest,
} from "../src/marketing";

const NY = "America/New_York";
const at = (iso: string) => new Date(iso);

describe("the switch", () => {
  it("is on only when settings.marketing.enabled is true", () => {
    expect(marketingOn({ marketing: { enabled: true } })).toBe(true);
    for (const settings of [null, undefined, {}, { marketing: {} }, { marketing: { enabled: false } }, { marketing: { enabled: "true" } }, { marketing: true }]) {
      expect(marketingOn(settings as Record<string, unknown> | null | undefined), JSON.stringify(settings)).toBe(false);
    }
  });
});

describe("review settings", () => {
  it("asks after the 3rd visit and reminds 3 and 5 days later until changed", () => {
    expect(reviewSettings(null)).toEqual({ recurringAfterVisits: 3, reminderDays: [3, 5], reminderMessage: DEFAULT_REMINDER_MESSAGE });
    expect(reviewSettings({ reviews: {} }).reminderDays).toEqual([3, 5]);
  });

  it("keeps the visit count from 1 to 20, as the database does", () => {
    const visits = (v: unknown) => reviewSettings({ reviews: { recurring_after_visits: v } }).recurringAfterVisits;
    expect(visits(5)).toBe(5);
    expect(visits(0)).toBe(1);
    expect(visits(99)).toBe(20);
    expect(visits(2.6)).toBe(3);
    expect(visits("abc")).toBe(3);
    expect(visits(null)).toBe(3);
  });

  it("keeps up to two reminders, each later than the one before, and none means none", () => {
    const days = (reminders: unknown) => reviewSettings({ reviews: { reminders } }).reminderDays;
    expect(days([])).toEqual([]);
    expect(days([{ days: 4 }])).toEqual([4]);
    expect(days([{ days: 2 }, { days: 7 }, { days: 9 }])).toEqual([2, 7]);
    expect(days([{ days: 5 }, { days: 3 }])).toEqual([5]);
    expect(days([{ days: 0 }, { days: 31 }, { days: 2.5 }, { days: "3" }, null, { days: 6 }])).toEqual([6]);
  });

  it("uses the business's reminder message when it wrote one", () => {
    expect(reviewSettings({ reviews: { reminder_message: "Still there? {{link}}" } }).reminderMessage).toBe("Still there? {{link}}");
    expect(reviewSettings({ reviews: { reminder_message: "  " } }).reminderMessage).toBe(DEFAULT_REMINDER_MESSAGE);
  });

  it("names visits the way people say them", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  });
});

describe("times", () => {
  it("has quiet hours from 9pm to 9am in the company's time zone", () => {
    // Daylight time: New York is UTC-4.
    expect(inQuietHours(at("2026-10-30T00:59:00Z"), NY)).toBe(false); // 8:59pm
    expect(inQuietHours(at("2026-10-30T01:00:00Z"), NY)).toBe(true); // 9:00pm
    expect(inQuietHours(at("2026-10-30T12:59:00Z"), NY)).toBe(true); // 8:59am
    expect(inQuietHours(at("2026-10-30T13:00:00Z"), NY)).toBe(false); // 9:00am
    // Standard time: UTC-5.
    expect(inQuietHours(at("2026-11-05T01:59:00Z"), NY)).toBe(false); // 8:59pm
    expect(inQuietHours(at("2026-11-05T02:00:00Z"), NY)).toBe(true); // 9:00pm
    expect(inQuietHours(at("2026-11-05T14:00:00Z"), NY)).toBe(false); // 9:00am
  });

  it("ends quiet hours at the next 9am, across the change back to standard time", () => {
    expect(quietHoursEnd(at("2026-10-30T02:30:00Z"), NY).toISOString()).toBe("2026-10-30T13:00:00.000Z"); // 10:30pm EDT → 9am EDT
    expect(quietHoursEnd(at("2026-10-30T10:00:00Z"), NY).toISOString()).toBe("2026-10-30T13:00:00.000Z"); // 6am → 9am the same day
    expect(quietHoursEnd(at("2026-11-01T02:30:00Z"), NY).toISOString()).toBe("2026-11-01T14:00:00.000Z"); // Oct 31 10:30pm EDT → Nov 1 9am EST
    expect(quietHoursEnd(at("2026-11-05T03:30:00Z"), NY).toISOString()).toBe("2026-11-05T14:00:00.000Z");
  });

  it("sends reminders at 1:30pm on the chosen days after the ask", () => {
    const asked = at("2026-10-29T15:00:00Z"); // 11am EDT, Thursday
    expect(reminderAt(asked, 3, NY).toISOString()).toBe("2026-11-01T18:30:00.000Z"); // Sunday, now EST
    expect(nextReminder(asked, 0, [3, 5], NY)?.toISOString()).toBe("2026-11-01T18:30:00.000Z");
    expect(nextReminder(asked, 1, [3, 5], NY, at("2026-11-01T18:31:00Z"))?.toISOString()).toBe("2026-11-03T18:30:00.000Z");
    expect(nextReminder(asked, 2, [3, 5], NY, at("2026-11-03T18:31:00Z"))).toBeNull();
    expect(nextReminder(asked, 0, [], NY)).toBeNull();
  });

  it("never sends the second reminder right after a first that went out late", () => {
    const asked = at("2026-10-29T15:00:00Z");
    // The first went on day 6 instead of day 3: the second is day 7, not day 5 (already past).
    expect(nextReminder(asked, 1, [3, 5], NY, at("2026-11-04T18:30:00Z"))?.toISOString()).toBe("2026-11-05T18:30:00.000Z");
  });

  it("moves a reminder still to come when the days change", () => {
    const asked = at("2026-10-26T15:00:00Z"); // Monday, 11am EDT
    const now = at("2026-10-27T15:00:00Z"); // Tuesday, 11am
    // To its day by the new days: a week after the ask, now in standard time.
    expect(rescheduledReminder(asked, 0, [7], NY, now)?.toISOString()).toBe("2026-11-02T18:30:00.000Z");
    // Its day has gone by: the next 1:30pm, today before then, tomorrow after.
    expect(rescheduledReminder(at("2026-10-25T15:00:00Z"), 0, [1, 5], NY, now)?.toISOString()).toBe("2026-10-27T17:30:00.000Z");
    expect(rescheduledReminder(at("2026-10-25T15:00:00Z"), 0, [1, 5], NY, at("2026-10-27T18:00:00Z"))?.toISOString()).toBe("2026-10-28T17:30:00.000Z");
    // Never the same day as the last one, which went at 10am after an outage.
    expect(rescheduledReminder(at("2026-10-20T15:00:00Z"), 1, [3, 4], NY, now, at("2026-10-27T14:00:00Z"))?.toISOString()).toBe("2026-10-28T17:30:00.000Z");
    // None left.
    expect(rescheduledReminder(asked, 1, [7], NY, now)).toBeNull();
    expect(rescheduledReminder(asked, 0, [], NY, now)).toBeNull();
  });
});

describe("channels for a first ask", () => {
  const reach = (over: Partial<Reach> = {}): Reach => ({ name: "Ana", hasEmail: true, hasPhone: true, textsOff: false, emailReady: true, smsReady: true, ...over });

  it.each([
    // requested, client, quiet hours, what happens
    ["email", {}, false, { send: ["email"] }],
    ["sms", {}, false, { send: ["sms"] }],
    ["both", {}, false, { send: ["email", "sms"] }],
    ["both", { textsOff: true }, false, { send: ["email"] }],
    ["both", { hasPhone: false }, false, { send: ["email"] }],
    ["both", { hasEmail: false }, false, { send: ["sms"] }],
    ["both", { emailReady: false }, false, { send: ["sms"] }],
    ["both", { smsReady: false }, false, { send: ["email"] }],
    ["sms", {}, true, { send: ["email"] }],
    ["both", {}, true, { send: ["email"] }],
    ["email", {}, true, { send: ["email"] }],
    ["sms", { hasEmail: false }, true, { send: [], wait: true }],
    ["sms", { emailReady: false }, true, { send: [], wait: true }],
    ["both", { hasEmail: false }, true, { send: [], wait: true }],
    ["sms", { hasEmail: false, smsReady: false }, true, { send: [], skip: TEXTS_NOT_SET_UP, setup: true }],
  ] as const)("%s to %j, quiet %s", (requested, over, quiet, expected) => {
    expect(askChannels(requested, reach(over), quiet)).toEqual(expected);
  });

  it("says why when nothing can go", () => {
    expect(askChannels("sms", reach({ textsOff: true }), false)).toEqual({ send: [], skip: "Ana texted STOP, so texts to them are off." });
    expect(askChannels("sms", reach({ hasPhone: false }), false).skip).toBe("Ana has no phone number.");
    expect(askChannels("email", reach({ hasEmail: false }), false).skip).toBe("Ana has no email address.");
    expect(askChannels("email", reach({ emailReady: false }), false)).toMatchObject({ send: [], setup: true });
    expect(askChannels("both", reach({ hasEmail: false, hasPhone: false }), false).skip).toBe("Ana has no email address or phone number.");
    expect(askChannels("both", reach({ hasEmail: false, textsOff: true }), true).skip).toBe("Ana texted STOP, so texts to them are off.");
    expect(askChannels("email", reach({ hasEmail: false }), true).skip).toBe("Ana has no email address.");
    expect(askChannels("sms", reach({ smsReady: false }), false)).toEqual({ send: [], skip: TEXTS_NOT_SET_UP, setup: true });
  });

  it("by both, gives what the business can fix when the client has an email address", () => {
    // Dan texted STOP, and email isn't connected: connecting email would reach him, so that's why.
    expect(askChannels("both", reach({ textsOff: true, emailReady: false }), false)).toEqual({ send: [], skip: EMAIL_NOT_CONNECTED, setup: true });
    expect(askChannels("both", reach({ smsReady: false, emailReady: false }), false)).toEqual({ send: [], skip: EMAIL_NOT_CONNECTED, setup: true });
    // With no address, the text's reason.
    expect(askChannels("both", reach({ hasEmail: false, textsOff: true }), false).skip).toBe("Ana texted STOP, so texts to them are off.");
    expect(askChannels("both", reach({ hasEmail: false, smsReady: false }), false)).toEqual({ send: [], skip: TEXTS_NOT_SET_UP, setup: true });
  });

  it("knows a client who texted STOP", () => {
    expect(textsOff({ sms_opt_out_at: "2026-10-01T00:00:00Z" })).toBe(true);
    expect(textsOff({ sms_opt_out_at: null })).toBe(false);
    expect(textsOff(null)).toBe(false);
  });
});

describe("who's asked by hand", () => {
  const ana = { display_name: "Ana", email: "ana@example.com", phone: "+15405550100", status: "active", review_opt_out: false, marketing_opt_out: false, sms_opt_out_at: null };
  const ready = { email: true, sms: true };

  it("not a client who opted out or is archived, whatever the channel", () => {
    expect(notAsked(ana)).toBeNull();
    expect(notAsked({ ...ana, review_opt_out: true })).toBe("Ana asked not to get review requests. You can change that on their page.");
    expect(notAsked({ ...ana, marketing_opt_out: true })).toBe("Ana unsubscribed from marketing, so they aren't asked for reviews.");
    expect(notAsked({ ...ana, status: "archived" })).toBe("Ana is archived. Restore them to ask for a review.");
    expect(askRefusal({ ...ana, review_opt_out: true }, "both", ready)).toBe(notAsked({ ...ana, review_opt_out: true }));
  });

  it("by a way that reaches them, right away", () => {
    expect(askRefusal(ana, "sms", ready)).toBeNull();
    expect(askRefusal(ana, "sms", { email: true, sms: false })).toBe(TEXTS_NOT_SET_UP);
    expect(askRefusal({ ...ana, sms_opt_out_at: "2026-10-01T00:00:00Z" }, "sms", ready)).toBe("Ana texted STOP, so texts to them are off.");
    expect(askRefusal({ ...ana, sms_opt_out_at: "2026-10-01T00:00:00Z" }, "both", ready)).toBeNull();
    expect(askRefusal({ ...ana, sms_opt_out_at: "2026-10-01T00:00:00Z" }, "both", { email: false, sms: true })).toBe(EMAIL_NOT_CONNECTED);
    expect(askRefusal({ ...ana, email: "not an address" }, "email", ready)).toBe("Ana has no email address.");
  });
});

describe("a reminder that's due", () => {
  const request = (over: Partial<ReminderRequest> = {}): ReminderRequest => ({ channel: "both", status: "sent", clicked_at: null, sent_at: "2026-10-29T15:00:00Z", reminders_sent: 0, ...over });
  const client = (over: Partial<ReminderClient> = {}): ReminderClient => ({
    email: "ana@example.com", phone: "+15405550100", status: "active", review_opt_out: false, marketing_opt_out: false, sms_opt_out_at: null, ...over,
  });
  const plan = (over: Partial<Parameters<typeof reminderPlan>[0]> = {}) =>
    reminderPlan({ request: request(), client: client(), marketingOn: true, hasReviewUrl: true, emailReady: true, smsReady: true, settings: {}, now: at("2026-11-01T18:30:00Z"), timeZone: NY, ...over });

  it("goes by the ask's channels, with when the next one is due", () => {
    expect(plan()).toEqual({ kind: "send", channels: ["email", "sms"], next: at("2026-11-03T18:30:00Z") });
    expect(plan({ request: request({ channel: "sms" }) })).toMatchObject({ kind: "send", channels: ["sms"] });
    expect(plan({ request: request({ reminders_sent: 1 }), now: at("2026-11-03T18:30:00Z") })).toEqual({ kind: "send", channels: ["email", "sms"], next: null });
  });

  it("leaves out texts to a client who texted STOP since, and email that isn't connected", () => {
    expect(plan({ client: client({ sms_opt_out_at: "2026-10-30T00:00:00Z" }) })).toMatchObject({ kind: "send", channels: ["email"] });
    expect(plan({ emailReady: false })).toMatchObject({ kind: "send", channels: ["sms"] });
    expect(plan({ smsReady: false })).toMatchObject({ kind: "send", channels: ["email"] });
  });

  it.each([
    ["the link was opened", { request: request({ clicked_at: "2026-10-30T12:00:00Z", status: "clicked" }) }, "They opened the link"],
    ["the ask failed", { request: request({ status: "failed" }) }, "The ask wasn't sent"],
    ["the client is gone", { client: null }, "The client was deleted"],
    ["the client is archived", { client: client({ status: "archived" }) }, "The client was archived"],
    ["they don't want review asks", { client: client({ review_opt_out: true }) }, "They asked not to get review requests"],
    ["they unsubscribed from marketing", { client: client({ marketing_opt_out: true }) }, "They unsubscribed from marketing"],
    ["Marketing is off", { marketingOn: false }, "Marketing was uninstalled"],
    ["there's no review link", { hasReviewUrl: false }, "The review link was removed"],
    ["reminders were turned off", { settings: { reviews: { reminders: [] } } }, "No more reminders are set"],
    ["both were sent", { request: request({ reminders_sent: 2 }) }, "No more reminders are set"],
    ["a text, after they texted STOP", { request: request({ channel: "sms" }), client: client({ sms_opt_out_at: "2026-10-30T00:00:00Z" }) }, "They texted STOP"],
    ["a text, with the number removed", { request: request({ channel: "sms" }), client: client({ phone: null }) }, "Their phone number was removed"],
    ["an email, with the address removed", { request: request({ channel: "email" }), client: client({ email: null }) }, "Their email address was removed"],
    ["an email, with email disconnected", { request: request({ channel: "email" }), emailReady: false }, "Email isn't connected"],
    ["a text, with texting not set up", { request: request({ channel: "sms" }), smsReady: false }, "Texting isn't set up"],
    ["both, after they texted STOP, with email disconnected", { client: client({ sms_opt_out_at: "2026-10-30T00:00:00Z" }), emailReady: false }, "Email isn't connected"],
    ["both, with no address, after they texted STOP", { client: client({ email: null, sms_opt_out_at: "2026-10-30T00:00:00Z" }) }, "They texted STOP"],
    ["both, with neither left", { client: client({ email: null, phone: null }) }, "Their email address and phone number were removed"],
  ] as const)("stops for good when %s", (_, over, why) => {
    expect(plan(over as Partial<Parameters<typeof reminderPlan>[0]>)).toEqual({ kind: "stop", why });
  });

  it("waits for 1:30pm when it comes due in quiet hours", () => {
    // 10pm EDT: tomorrow at 1:30pm (now EST).
    expect(plan({ now: at("2026-11-01T02:00:00Z") })).toEqual({ kind: "later", until: at("2026-11-01T18:30:00Z") });
    // 7am: today at 1:30pm.
    expect(plan({ now: at("2026-11-02T12:00:00Z") })).toEqual({ kind: "later", until: at("2026-11-02T18:30:00Z") });
  });
});

describe("Recent requests", () => {
  const ask = (over: Partial<Parameters<typeof reminderLines>[0]> = {}) => ({
    channel: "email", status: "sent", reminders_sent: 0, reminders_failed: 0, next_reminder_at: null, reminder_note: null, reminder_error: null, ...over,
  });
  const when = (iso: string) => `at ${iso.slice(0, 10)}`;

  it("says how many reminders went, and when the next is due", () => {
    expect(reminderLines(ask({ next_reminder_at: "2026-11-01T18:30:00Z" }), 2, when)).toEqual(["Next reminder at 2026-11-01"]);
    expect(reminderLines(ask({ reminders_sent: 1, next_reminder_at: "2026-11-01T18:30:00Z" }), 2, when)).toEqual(["1 reminder sent", "Next reminder at 2026-11-01"]);
    expect(reminderLines(ask({ reminders_sent: 2 }), 2, when)).toEqual(["2 reminders sent"]);
  });

  it("says a reminder failed and why, not that it was sent", () => {
    const failed = ask({ channel: "sms", reminders_sent: 1, reminders_failed: 1, reminder_error: "Texting isn't set up on this Crewtavo yet.", next_reminder_at: "2026-11-01T18:30:00Z" });
    expect(reminderLines(failed, 2, when)).toEqual(["Reminder failed: Texting isn't set up on this Crewtavo yet.", "Next reminder at 2026-11-01"]);
    expect(reminderLines({ ...failed, reminders_sent: 2, next_reminder_at: null }, 2, when)).toEqual(["1 reminder sent", "Reminder failed: Texting isn't set up on this Crewtavo yet."]);
  });

  it("says reminders stopped, apart from the ask itself", () => {
    expect(reminderLines(ask({ reminder_note: "They texted STOP" }), 2, when)).toEqual(["Reminders stopped: they texted STOP"]);
    expect(reminderLines(ask({ reminder_note: "Marketing was uninstalled" }), 2, when)).toEqual(["Reminders stopped: Marketing was uninstalled"]);
    expect(reminderLines(ask({ reminders_sent: 1, reminder_note: "Reminders were turned off" }), 2, when)).toEqual(["1 reminder sent", "Reminders were turned off"]);
    expect(reminderStopNote("Email isn't connected")).toBe("Reminders stopped: email isn't connected");
    expect(reminderStopNote("No more reminders are set")).toBe("No more reminders are set");
    // Fewer reminders set now than this one is waiting on, before the task gets to it.
    expect(reminderLines(ask({ reminders_sent: 1, next_reminder_at: "2026-11-01T18:30:00Z" }), 1, when)).toEqual(["1 reminder sent"]);
    // An opened link has no reminder lines past what went.
    expect(reminderLines(ask({ status: "clicked", reminders_sent: 1, reminder_note: "They opened the link" }), 2, when)).toEqual(["1 reminder sent"]);
  });

  it("names a copied link apart from an ask that went, and says which way a half-sent ask went", () => {
    expect(askStatus({ channel: "link", status: "sent" })).toEqual({ label: "Link copied", tone: "muted" });
    expect(askStatus({ channel: "link", status: "clicked" })).toEqual({ label: "Opened link", tone: "good" });
    expect(askStatus({ channel: "both", status: "sent" })).toEqual({ label: "Sent", tone: "muted" });
    expect(askStatus({ channel: "sms", status: "failed" })).toEqual({ label: "Failed", tone: "danger" });
    expect(askError({ channel: "email", status: "sent", error: "The text provider refused it (400)." })).toBe("By email only: The text provider refused it (400).");
    expect(askError({ channel: "sms", status: "failed", error: "Ana has no phone number." })).toBe("Ana has no phone number.");
    expect(askError({ channel: "sms", status: "sent", error: null })).toBeNull();
  });
});

describe("the Ask automatically form", () => {
  const rule = (over: Partial<AskRule> = {}): AskRule => ({
    name: "Ask for a Google review after a job",
    description: "Sends your review link a day after a job is completed.",
    trigger: "job.completed",
    enabled: false,
    delay_minutes: 1440,
    conditions: ASK_CONDITIONS["job.completed"],
    actions: [{ type: "request_review", channel: "email" }],
    ...over,
  });

  it("offers the triggers by the names they have in Automations", () => {
    expect(ASK_WHEN).toEqual([
      { verb: "job.completed", label: "A job is completed" },
      { verb: "visit.completed", label: "A visit is completed" },
      { verb: "invoice.paid", label: "An invoice is paid in full" },
    ]);
  });

  it("reads all four shapes, conditions in any order", () => {
    expect(readAskRule(rule(), "after_job")).toEqual({ when: "job.completed", channel: "email", enabled: false, delay: 1440 });
    const visit = rule({ trigger: "visit.completed", conditions: [...ASK_CONDITIONS["visit.completed"]].reverse(), actions: [{ type: "request_review", channel: "both" }], enabled: true });
    expect(readAskRule(visit, "after_job")).toEqual({ when: "visit.completed", channel: "both", enabled: true, delay: 1440 });
    const invoice = rule({ trigger: "invoice.paid", conditions: [ASK_CONDITIONS["invoice.paid"][2], ASK_CONDITIONS["invoice.paid"][0], ASK_CONDITIONS["invoice.paid"][1]] });
    expect(readAskRule(invoice, "after_job")?.when).toBe("invoice.paid");
    const recurring = rule({ trigger: "job.recurring_third_visit", conditions: [], actions: [{ type: "request_review", channel: "sms" }], delay_minutes: 60 });
    expect(readAskRule(recurring, "recurring")).toEqual({ when: "job.recurring_third_visit", channel: "sms", enabled: false, delay: 60 });
  });

  it("doesn't read a rule someone changed into something else", () => {
    expect(readAskRule(null, "after_job")).toBeNull();
    expect(readAskRule(rule({ actions: [{ type: "request_review", channel: "email" }, { type: "add_tag", tag: "Asked" }] }), "after_job")).toBeNull();
    expect(readAskRule(rule({ conditions: [{ field: "client.tags", op: "includes", value: ["VIP"] }] }), "after_job")).toBeNull();
    expect(readAskRule(rule({ trigger: "visit.completed", conditions: [{ field: "kind", op: "equals", value: "job" }] }), "after_job")).toBeNull();
    expect(readAskRule(rule({ trigger: "quote.approved" }), "after_job")).toBeNull();
    expect(readAskRule(rule({ actions: [{ type: "send_email", subject: "Hi", body: "Review us" }] }), "after_job")).toBeNull();
    expect(readAskRule(rule({ actions: [{ type: "request_review", channel: "link" }] }), "after_job")).toBeNull();
    expect(readAskRule(rule(), "recurring")).toBeNull();
  });

  it("leaves recurring work to the recurring rule whatever Ask when says", () => {
    for (const { verb } of ASK_WHEN) {
      const conditions = ASK_CONDITIONS[verb];
      expect(conditions.some((c) => c.op === "not_equals" && c.value === "recurring" && ["kind", "job_kind"].includes(c.field)), verb).toBe(true);
    }
    // A recurring job marked complete at the end of its season isn't asked after by this rule, so
    // one changed in Automations to ask then too is set up its own way.
    expect(readAskRule(rule({ conditions: [] }), "after_job")).toBeNull();
  });

  it("writes the shape for the choice, keeping the wait", () => {
    const update = askRuleUpdate(rule({ delay_minutes: 2880 }), "after_job", { when: "invoice.paid", channel: "both", enabled: true });
    expect(update).toMatchObject({
      trigger: "invoice.paid",
      conditions: ASK_CONDITIONS["invoice.paid"],
      actions: [{ type: "request_review", channel: "both" }],
      enabled: true,
      name: "Ask for a Google review when an invoice is paid",
    });
    expect(update).not.toHaveProperty("delay_minutes");
    expect(readAskRule({ ...rule({ delay_minutes: 2880 }), ...update }, "after_job")).toEqual({ when: "invoice.paid", channel: "both", enabled: true, delay: 2880 });
  });

  it("replaces a starter description and a name it wrote, and keeps ones someone wrote", () => {
    const starter = askRuleUpdate(rule(), "after_job", { when: "visit.completed", channel: "email", enabled: true });
    expect(starter.description).toBe("Sends your review link a day after a visit is completed, except on recurring work.");
    expect(starter.name).toBe("Ask for a Google review after a visit");
    const own = askRuleUpdate(rule({ name: "Reviews please", description: "Our own words." }), "after_job", { when: "visit.completed", channel: "email", enabled: true });
    expect(own).not.toHaveProperty("name");
    expect(own).not.toHaveProperty("description");
    // Back again: what it wrote for a visit is its own to replace.
    const back = askRuleUpdate(rule({ name: starter.name!, description: starter.description! }), "after_job", { when: "job.completed", channel: "email", enabled: true });
    expect(back).toMatchObject({ name: "Ask for a Google review after a job", description: "Sends your review link a day after a job is completed." });
    expect(back.conditions).toEqual(ASK_CONDITIONS["job.completed"]);
    const recurring = askRuleUpdate(
      rule({ name: "Ask for a Google review on recurring work", trigger: "job.recurring_third_visit", conditions: [], description: "Sends your review link a day after a recurring job's third visit, once for each job." }),
      "recurring",
      { when: "job.completed", channel: "sms", enabled: false },
    );
    expect(recurring).toMatchObject({ trigger: "job.recurring_third_visit", conditions: [], description: "Sends your review link a day after a recurring job reaches the visit you chose in Marketing, once for each job." });
  });

  it("says when the ask goes out, in a whole sentence", () => {
    expect(askTiming("after_job", "visit.completed", 1440)).toBe("Goes out a day after a visit is completed.");
    expect(askTiming("after_job", "job.completed", 0)).toBe("Goes out as soon as a job is completed.");
    expect(askTiming("after_job", "invoice.paid", 120)).toBe("Goes out 2 hours after an invoice is paid in full.");
    expect(askTiming("recurring", "job.completed", 2880)).toBe("Goes out 2 days after a recurring job reaches that visit.");
  });

  it("puts a deleted rule back whole", () => {
    expect(askRuleUpdate(null, "recurring", { when: "job.completed", channel: "email", enabled: true })).toEqual({
      template_key: "review_recurring",
      name: "Ask for a Google review on recurring work",
      description: askDescription("recurring", "job.completed", 1440),
      trigger: "job.recurring_third_visit",
      delay_minutes: 1440,
      conditions: [],
      actions: [{ type: "request_review", channel: "email" }],
      enabled: true,
    });
    expect(askRuleUpdate(null, "after_job", { when: "job.completed", channel: "sms", enabled: false })).toMatchObject({ template_key: "review_after_job", trigger: "job.completed" });
  });
});

describe("texts from clients", () => {
  it("reads STOP and START as Twilio does", () => {
    for (const body of ["STOP", "stop ", "Stop.", "STOPALL", "unsubscribe", "Cancel!", "end", "QUIT", "opt out", "OPTOUT", "revoke", " stop!! "]) expect(smsKeyword(body), body).toBe("stop");
    for (const body of ["START", "unstop", "Yes", "yes!"]) expect(smsKeyword(body), body).toBe("start");
    for (const body of ["Please stop by Tuesday", "stop by", "Yes please, Tuesday works", "", null, "STOP STOP"]) expect(smsKeyword(body), String(body)).toBeNull();
  });

  // The same texts as supabase/tests/marketing_app_test.sql, which reads STOPs from before.
  it("reads emoji and symbols after the word, and nothing but ASCII as the word, as the database does", () => {
    const cases: Array<[string, "stop" | "start" | null]> = [
      ["STOP 🛑", "stop"], ["Stop ✋", "stop"], ["STOP🙏", "stop"], ["stop 👍", "stop"], ["STOP +", "stop"], ["Stop €", "stop"], ["Stop ❤️", "stop"],
      ["\nSTOP\n", "stop"], ["\tstop\r\n", "stop"], ["opt\tout", "stop"], ["quit…", "stop"], ["Yes 👍", "start"],
      ["STOP STOP", null], ["ſtop", null], ["¡STOP", null], ["stöp", null], ["stop2", null], ["OPT\u00a0OUT", null], ["\u00a0STOP", null], ["", null],
    ];
    for (const [body, word] of cases) expect(smsKeyword(body), JSON.stringify(body)).toBe(word);
  });
});

describe("referrals", () => {
  it("reads settings.referrals, kept in range as the database keeps a new referral's terms", () => {
    expect(referralSettings({ referrals: { reward: { kind: "amount", value: 50 }, offer: " 10% off ", message: "Hi {{link}}" } }))
      .toEqual({ reward: { kind: "amount", value: 50 }, offer: "10% off", message: "Hi {{link}}" });
    expect(referralSettings({ referrals: { reward: { kind: "percent", value: 12.5 } } }).reward).toEqual({ kind: "percent", value: 12.5 });
    // The same cases as supabase/tests/referral_credits_test.sql (private.referral_terms).
    expect(referralSettings({ referrals: { reward: { kind: "percent", value: 120 } } }).reward).toEqual({ kind: "percent", value: 0 });
    expect(referralSettings({ referrals: { reward: { kind: "percent", value: 0.5 } } }).reward).toEqual({ kind: "percent", value: 0 });
    expect(referralSettings({ referrals: { reward: { kind: "amount", value: 20_000 } } }).reward).toEqual({ kind: "amount", value: 0 });
    expect(referralSettings({ referrals: { reward: { kind: "gift", value: 50 } } }).reward).toEqual({ kind: "amount", value: 0 });
    expect(referralSettings({ referrals: { reward: { kind: "amount", value: "50" } } }).reward).toEqual({ kind: "amount", value: 0 });
    expect(referralSettings(null)).toEqual({ reward: { kind: "amount", value: 0 }, offer: null, message: DEFAULT_REFERRAL_MESSAGE });
    // The old keys were moved by a migration and aren't read.
    expect(referralSettings({ referral_reward: { amount: 50 }, referral_offer: "Old" })).toEqual({ reward: { kind: "amount", value: 0 }, offer: null, message: DEFAULT_REFERRAL_MESSAGE });
  });

  it("is ready with a credit or an offer", () => {
    expect(referralsReady({ referrals: { reward: { kind: "amount", value: 50 } } })).toBe(true);
    expect(referralsReady({ referrals: { offer: "A free edge trim" } })).toBe(true);
    expect(referralsReady({ referrals: { reward: { kind: "percent", value: 0 } } })).toBe(false);
    expect(referralsReady({})).toBe(false);
  });

  it("works a credit out to the cent, half away from zero, as the database does", () => {
    // 10% of $480.55 less a $30 promo: $45.055, which is $45.06.
    expect(referralCredit("percent", 10, 450.55)).toBe(45.06);
    expect(referralCredit("percent", 10, "450.55")).toBe(45.06);
    expect(referralCredit("percent", 12.5, 99.99)).toBe(12.5);
    expect(referralCredit("percent", 15, 0.1)).toBe(0.02);
    expect(referralCredit("percent", 10, 0)).toBe(0);
    expect(referralCredit("amount", 50, 12)).toBe(50);
  });

  it("says what each side gets", () => {
    expect(referralRewardWords({ kind: "amount", value: 50 })).toBe("a $50 credit");
    expect(referralRewardWords({ kind: "amount", value: 12.5 })).toBe("a $12.50 credit");
    expect(referralRewardWords({ kind: "percent", value: 10 })).toBe("10% of their first job back as a credit");
    expect(referralRewardWords({ kind: "amount", value: 0 })).toBe("");
    expect(referrerLine({ kind: "amount", value: 50 })).toBe("You'll get a $50 credit on your next invoice once they pay their first one.");
    expect(referrerLine({ kind: "percent", value: 12.5 })).toBe("You'll get 12.5% of their first job back as a credit on your next invoice.");
    expect(referrerLine({ kind: "percent", value: 0 })).toBe("");
    expect(creditMoney(1250)).toBe("$1,250");
    expect(creditMoney("45.06")).toBe("$45.06");
  });

  it("writes {{rewards}} as the friend's offer and the client's credit, each on its own line, or nothing", () => {
    const offer = "10% off your first service";
    expect(referralRewards({ referrals: { reward: { kind: "amount", value: 50 }, offer } }))
      .toBe("For your friends: “10% off your first service”\nYou'll get a $50 credit on your next invoice once they pay their first one.");
    expect(referralRewards({ referrals: { reward: { kind: "percent", value: 10 }, offer } }))
      .toBe("For your friends: “10% off your first service”\nYou'll get 10% of their first job back as a credit on your next invoice.");
    expect(referralRewards({ referrals: { reward: { kind: "amount", value: 50 } } })).toBe("You'll get a $50 credit on your next invoice once they pay their first one.");
    expect(referralRewards({ referrals: { offer } })).toBe("For your friends: “10% off your first service”");
    expect(referralRewards({})).toBe("");
    expect(DEFAULT_REFERRAL_MESSAGE).toContain("{{link}}");
    expect(DEFAULT_REFERRAL_MESSAGE).toContain("{{rewards}}");
  });

  it("says why a client isn't asked for referrals", () => {
    const ana = { display_name: "Ana Smith", email: "ana@example.com", status: "active", marketing_opt_out: false };
    expect(referralAskRefusal(ana)).toBeNull();
    expect(referralAskRefusal({ ...ana, marketing_opt_out: true })).toBe("Ana Smith unsubscribed from marketing, so they aren't asked for referrals.");
    expect(referralAskRefusal({ ...ana, status: "archived" })).toBe("Ana Smith is archived. Restore them to ask for a referral.");
    expect(referralAskRefusal({ ...ana, email: "not an address" })).toBe("Ana Smith has no email address.");
    expect(referralAskRefusal(ana, false)).toBe("Email isn't connected yet, so referral asks can't be sent. An admin can connect it in Settings → Email.");
    // The client's own reason comes first.
    expect(referralAskRefusal({ ...ana, email: null }, false)).toBe("Ana Smith has no email address.");
  });

  it("says what a referral's credit is and where it went", () => {
    const base: CreditReferral = { status: "won", reward_status: "earned", reward_kind: "amount", reward_value: 50, reward_amount: 50, given_amount: 0, no_reward_reason: null, auto_apply: true };
    const inv = (number: number, amount: number) => ({ amount, invoice: { id: `inv-${number}`, number } });
    const text = (r: Partial<CreditReferral>, credits: Parameters<typeof creditLine>[1] = []) => creditText(creditLine({ ...base, ...r }, credits));
    expect(text({ status: "new", reward_status: "pending", reward_amount: 0 })).toBe("$50 credit once they pay their first invoice");
    expect(text({ status: "quoted", reward_status: "pending", reward_kind: "percent", reward_value: 10, reward_amount: 0 })).toBe("10% of their first job, worked out when they pay their first invoice");
    expect(text({})).toBe("$50 credit, goes on their next invoice");
    expect(text({ auto_apply: false })).toBe("$50 credit, kept off invoices");
    expect(text({}, [inv(1042, 30)])).toBe("$30 of $50 on invoice #1042, $20 to go");
    expect(text({ reward_status: "applied" }, [inv(1042, 50)])).toBe("$50 credit on invoice #1042");
    expect(text({ reward_status: "applied", reward_amount: 45.06 }, [inv(1042, 20), inv(1050, 25.06)])).toBe("$45.06 credit on invoices #1042 and #1050");
    expect(text({ reward_status: "issued", given_amount: 50 })).toBe("$50 credit, given outside Crewtavo");
    expect(text({ reward_status: "issued", reward_amount: 80, given_amount: 50 }, [inv(7, 30)])).toBe("$30 on invoice #7, $50 given outside Crewtavo");
    // Marked given, then the part on an invoice came off: that part is owed again, the given part isn't.
    expect(text({ reward_amount: 80, given_amount: 50 })).toBe("$50 of $80 given outside Crewtavo, $30 to go");
    expect(text({ reward_amount: 80, given_amount: 50, auto_apply: false })).toBe("$50 of $80 given outside Crewtavo, $30 kept off invoices");
    expect(text({ reward_amount: 80, given_amount: 50 }, [inv(9, 10)])).toBe("$10 of $80 on invoice #9, $50 given outside Crewtavo, $20 to go");
    expect(text({ reward_status: "applied", reward_amount: 80, given_amount: 50 }, [inv(9, 30)])).toBe("$30 on invoice #9, $50 given outside Crewtavo");
    // Without the Invoices area, the invoice isn't named.
    expect(text({ reward_status: "applied" }, [{ amount: 50, invoice: null }])).toBe("$50 credit on an invoice");
    expect(text({ reward_status: "none", no_reward_reason: "self" })).toBe("No credit: they referred themselves");
    expect(text({ reward_status: "none", no_reward_reason: "already_client" })).toBe("No credit: they were already a client");
    expect(text({ status: "lost", reward_status: "none", no_reward_reason: "lost" })).toBe("No credit: the work was lost");
    expect(creditLine({ ...base, reward_status: "applied" }, [inv(1042, 50)])).toEqual(["$50 credit ", "on invoice ", { invoice: { id: "inv-1042", number: 1042 } }]);
  });

  it("shows one pill: the credit's once there is one, the referral's own otherwise", () => {
    expect(referralPill({ status: "new", reward_status: "pending" })).toEqual({ kind: "referral", status: "new" });
    expect(referralPill({ status: "won", reward_status: "pending" })).toEqual({ kind: "referral", status: "won" });
    expect(referralPill({ status: "won", reward_status: "earned" })).toEqual({ kind: "credit", status: "earned" });
    expect(referralPill({ status: "won", reward_status: "issued" })).toEqual({ kind: "credit", status: "issued" });
    expect(referralPill({ status: "lost", reward_status: "none" })).toEqual({ kind: "referral", status: "lost" });
    // With no credit (none was set, or they referred themselves), the friend's progress still shows.
    expect(referralPill({ status: "new", reward_status: "none" })).toEqual({ kind: "referral", status: "new" });
    expect(referralPill({ status: "quoted", reward_status: "none" })).toEqual({ kind: "referral", status: "quoted" });
    expect(referralPill({ status: "won", reward_status: "none" })).toEqual({ kind: "referral", status: "won" });
  });

  it("knows the starter rule that asks a week after a job, and says when it goes", () => {
    expect(REFERRAL_RULE).toMatchObject({ template_key: "referral_after_job", trigger: "job.completed", delay_minutes: 10080, actions: [{ type: "request_referral" }] });
    expect(isReferralRule(REFERRAL_RULE)).toBe(true);
    expect(isReferralRule({ ...REFERRAL_RULE, conditions: [] })).toBe(false);
    expect(isReferralRule({ ...REFERRAL_RULE, actions: [{ type: "request_referral" }, { type: "add_tag", tag: "Asked" }] })).toBe(false);
    expect(isReferralRule(null)).toBe(false);
    expect(referralRuleTiming(REFERRAL_RULE)).toBe("Goes out a week after a job is completed.");
    expect(referralRuleTiming({ ...REFERRAL_RULE, delay_minutes: 4320 })).toBe("Goes out 3 days after a job is completed.");
  });
});
