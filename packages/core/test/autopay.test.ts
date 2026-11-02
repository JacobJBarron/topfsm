import { describe, expect, it } from "vitest";
import {
  actionsForTrigger,
  AUTOPAY_STATUS_TEXT,
  AUTOPAY_TERMS_MAX,
  autopayAllowed,
  autopayDueText,
  autopaySettings,
  autopayTimingText,
  checkCondition,
  DEFAULT_TERMS,
  defaultTerms,
  describeAction,
  describeRuleSentence,
  fieldsFor,
  isAutopayTrigger,
  methodExpiry,
  methodLabel,
  pickTemplate,
  starterAutopayTerms,
  taskVars,
  templateSettings,
  tipsAllowed,
  TRADE_TERMS,
  triggerAllowed,
  triggerDef,
  validateRule,
  variablesForTrigger,
  type Action,
} from "../src";

const LAWN = "We charge the card on file after each visit is done, and for other invoices we send you. You'll get a receipt each time. Turn it off anytime from your client page or by calling us.";

describe("autopay settings", () => {
  it("start from the trade's starter terms, the end of the day, a $500 cap and receipts, with autopay off", () => {
    expect(autopaySettings({}, "lawn_exterior")).toEqual({
      enabled: false, terms: LAWN, terms_version: "starter-lawn_exterior-1", timing: "end_of_day", days: null,
      max_amount: 500, receipts: true, jobs_default: true, changed_at: null, changed_by: null,
    });
    // Only lawn companies get autopay on for new recurring jobs by default.
    for (const trade of ["general", "paving", "roofing_exteriors"]) expect(autopaySettings({}, trade).jobs_default).toBe(false);
  });

  it("have starter terms for every trade that cover other invoices too (Charge card), and the general ones for a trade they don't know", () => {
    expect(starterAutopayTerms("lawn_exterior")).toBe(LAWN);
    expect(starterAutopayTerms("general")).toBe("We charge the card on file when each visit or job is done, and for other invoices we send you. You'll get a receipt each time. Turn it off anytime from your client page or by calling us.");
    const bigJobs = "We charge the card on file when the work on your job is done, and for other invoices we send you. Charges over the amount we agreed wait until we've talked with you. You'll get a receipt each time. Turn it off anytime from your client page or by calling us.";
    expect(starterAutopayTerms("paving")).toBe(bigJobs);
    expect(starterAutopayTerms("roofing_exteriors")).toBe(bigJobs);
    expect(starterAutopayTerms("snow")).toBe(starterAutopayTerms("general"));
    expect(starterAutopayTerms(null)).toBe(starterAutopayTerms("general"));
    expect(autopaySettings(null).terms_version).toBe("starter-general-1");
    expect(autopaySettings(null, "snow")).toMatchObject({ terms: starterAutopayTerms("general"), terms_version: "starter-snow-1" });
  });

  it("read what autopay_set_settings saved", () => {
    const saved = {
      enabled: true, terms: "Charged after each mow.", terms_version: "2026-10-31T14:05:09", timing: "days", days: 3, max_amount: null,
      receipts: false, jobs_default: false, changed_at: "2026-10-31T14:05:09.123Z", changed_by: "00000000-0000-4000-8000-000000000001",
    };
    expect(autopaySettings({ hub_tips: true, autopay: saved }, "lawn_exterior")).toEqual(saved);
  });

  it("keep no limit only when it was saved that way", () => {
    expect(autopaySettings({ autopay: { max_amount: null } }).max_amount).toBeNull();
    expect(autopaySettings({ autopay: {} }).max_amount).toBe(500);
    expect(autopaySettings({ autopay: { max_amount: 250.5 } }).max_amount).toBe(250.5);
    for (const bad of [0, -5, 2_000_000, "300", Number.NaN, true]) expect(autopaySettings({ autopay: { max_amount: bad } }).max_amount).toBe(500);
  });

  it("read days as the database does, and only with timing 'days'", () => {
    const days = (timing: unknown, value: unknown) => autopaySettings({ autopay: { timing, days: value } }).days;
    expect(days("days", 7)).toBe(7);
    expect(days("days", 0)).toBe(1);
    expect(days("days", 30)).toBe(14);
    expect(days("days", 2.4)).toBe(2);
    expect(days("days", "3")).toBe(1);
    expect(days("days", undefined)).toBe(1);
    expect(days("end_of_day", 7)).toBeNull();
    expect(days("now", 7)).toBeNull();
  });

  it("never throw on what's stored, whatever its shape", () => {
    const starter = autopaySettings({}, "general");
    for (const settings of [null, undefined, "on", 7, [], { autopay: [] }, { autopay: "on" }, { autopay: null }]) {
      expect(autopaySettings(settings, "general")).toEqual(starter);
    }
    const bad = autopaySettings({ autopay: { enabled: "true", terms: "   ", timing: "weekly", receipts: "no", jobs_default: 1, changed_at: 5, terms_version: "" } }, "lawn_exterior");
    expect(bad).toMatchObject({ enabled: false, terms: LAWN, timing: "end_of_day", receipts: true, jobs_default: true, changed_at: null, terms_version: "starter-lawn_exterior-1" });
    expect(autopaySettings({ autopay: { terms: "x".repeat(AUTOPAY_TERMS_MAX + 50) } }).terms).toHaveLength(AUTOPAY_TERMS_MAX);
  });

  it("are for recurring jobs billed per visit and one-off jobs billed when the work is done", () => {
    expect(autopayAllowed("recurring", "per_visit")).toBe(true);
    expect(autopayAllowed("one_off", "on_completion")).toBe(true);
    for (const [kind, mode] of [["recurring", "on_completion"], ["recurring", "fixed_schedule"], ["one_off", "per_visit"], ["one_off", "progress"], [null, null], [undefined, "per_visit"]] as const) {
      expect(autopayAllowed(kind, mode)).toBe(false);
    }
  });
});

describe("tips", () => {
  it("are allowed only when the company has them on and the invoice wasn't made in Stripe", () => {
    expect(tipsAllowed(true, false)).toBe(true);
    expect(tipsAllowed(true, true)).toBe(false);
    expect(tipsAllowed(false, false)).toBe(false);
    expect(tipsAllowed(false, true)).toBe(false);
    // Only a real true turns them on: a missing setting, or one stored as text, is off.
    for (const value of [undefined, null, "true", 1, {}]) expect(tipsAllowed(value, false)).toBe(false);
  });
});

describe("a saved card's name", () => {
  it("reads as the card, the bank or Link, as private.method_label says it", () => {
    expect(methodLabel({ type: "card", brand: "visa", last4: "4242" })).toBe("Visa ending 4242");
    expect(methodLabel({ type: "card", brand: "amex", last4: "0005" })).toBe("American Express ending 0005");
    expect(methodLabel({ type: "card", brand: "mastercard", last4: "4444" })).toBe("Mastercard ending 4444");
    expect(methodLabel({ type: "card", brand: "discover", last4: "1117" })).toBe("Discover ending 1117");
    // Postgres's initcap() capitalizes after every character that isn't a letter or digit.
    expect(methodLabel({ type: "card", brand: "eftpos_au", last4: "0001" })).toBe("Eftpos_Au ending 0001");
    // A wallet saves the card underneath, so Apple Pay reads as that card.
    expect(methodLabel({ type: "card", brand: "visa", last4: "4242", wallet: "apple_pay" })).toBe("Visa ending 4242");
    expect(methodLabel({ type: "us_bank_account", bank_name: "Chase", last4: "6789" })).toBe("Chase ending 6789");
    expect(methodLabel({ type: "us_bank_account", bank_name: null, last4: "6789" })).toBe("Bank account ending 6789");
    expect(methodLabel({ type: "link" })).toBe("Link");
    expect(methodLabel({ type: "sepa_debit", last4: "3000" })).toBe("Sepa Debit ending 3000");
    expect(methodLabel({ type: "cashapp" })).toBe("Cashapp");
  });

  it("says what it can when Stripe didn't give the brand or last four", () => {
    expect(methodLabel({ type: "card", brand: null, last4: "4242" })).toBe("Card ending 4242");
    expect(methodLabel({ type: "card", brand: "visa", last4: null })).toBe("Visa");
    expect(methodLabel({ type: "us_bank_account" })).toBe("Bank account");
  });

  it("has an expiry like 08/28, or none", () => {
    expect(methodExpiry({ exp_month: 8, exp_year: 2028 })).toBe("08/28");
    expect(methodExpiry({ exp_month: 12, exp_year: 2031 })).toBe("12/31");
    expect(methodExpiry({ exp_month: null, exp_year: 2028 })).toBeNull();
    expect(methodExpiry({})).toBeNull();
  });
});

describe("when a charge goes", () => {
  it("is said the same way private.autopay_terms_shown says it", () => {
    expect(autopayTimingText({ timing: "now", days: null })).toBe("right after each visit");
    expect(autopayTimingText({ timing: "end_of_day", days: null })).toBe("at the end of the day of each visit");
    expect(autopayTimingText({ timing: "days", days: 1 })).toBe("1 day after each visit");
    expect(autopayTimingText({ timing: "days", days: 2 })).toBe("2 days after each visit");
    expect(autopayTimingText({ timing: "days", days: null })).toBe("1 day after each visit");
    expect(autopayTimingText({ timing: "days", days: 40 })).toBe("14 days after each visit");
  });

  it("reads tonight, tomorrow night or a date in the company's time zone", () => {
    const tz = "America/New_York";
    const now = new Date("2026-10-31T14:00:00Z"); // 10 AM in New York
    expect(autopayDueText("2026-10-31T13:00:00Z", tz, now)).toBe("right away");
    expect(autopayDueText("2026-10-31T14:00:00Z", tz, now)).toBe("right away");
    // Local midnight at the end of today and of tomorrow (clocks go back on November 1).
    expect(autopayDueText("2026-11-01T04:00:00Z", tz, now)).toBe("tonight");
    expect(autopayDueText("2026-11-02T05:00:00Z", tz, now)).toBe("tomorrow night");
    expect(autopayDueText("2026-11-04T05:00:00Z", tz, now)).toBe("on Nov 4");
    // A retry three days on, at the time it failed.
    expect(autopayDueText("2026-11-03T14:05:00Z", tz, now)).toBe("on Nov 3");
    expect(autopayDueText("2026-10-31T20:00:00Z", tz, now)).toBe("today");
    expect(autopayDueText("2026-11-01T18:00:00Z", tz, now)).toBe("tomorrow");
    // The same moment is New York's midnight but 9 PM in Los Angeles.
    expect(autopayDueText("2026-11-01T04:00:00Z", "America/Los_Angeles", now)).toBe("today");
    expect(autopayDueText("2026-11-01T00:00:00Z", "UTC", new Date("2026-10-31T23:30:00Z"))).toBe("tonight");
    expect(autopayDueText("not a date", tz, now)).toBe("right away");
  });

  it("has two words at most for each status, for the office", () => {
    expect(Object.keys(AUTOPAY_STATUS_TEXT).sort()).toEqual(["called_off", "charging", "failed", "needs_approval", "needs_client", "paid", "processing", "waiting"]);
    expect(AUTOPAY_STATUS_TEXT.needs_approval).toBe("Needs your OK");
    expect(AUTOPAY_STATUS_TEXT.processing).toBe("On its way");
  });
});

describe("document terms by trade", () => {
  const LAWN_TERMS =
    "Payment: due after each visit, or charged to your card on file if you're on autopay.\n" +
    "Skipped visits: if we can't do a visit, we'll tell you, and you won't be charged for it.\n" +
    "Our work: if something isn't right, tell us within two days and we'll come back or refund the visit.";

  it("start from the trade's starter, and paving's and roofing's stay as they were", () => {
    expect(defaultTerms("lawn_exterior")).toBe(LAWN_TERMS);
    expect(defaultTerms("general")).toBe("Payment: due when the work is done, unless we agreed otherwise.\nChanges: anything not listed here is extra, and only with your OK.\nWarranty: we stand behind our workmanship.");
    expect(defaultTerms("paving")).toBe(DEFAULT_TERMS);
    expect(defaultTerms("roofing_exteriors")).toBe(DEFAULT_TERMS);
    expect(defaultTerms("snow")).toBe(DEFAULT_TERMS);
    expect(defaultTerms(null)).toBe(DEFAULT_TERMS);
    expect(Object.keys(TRADE_TERMS).sort()).toEqual(["general", "lawn_exterior", "paving", "roofing_exteriors"]);
    expect(DEFAULT_TERMS).toBe("Payment: a deposit to get on the schedule, and the rest when the work is done.\nChanges: anything not listed here is extra, and only with your OK.\nWarranty: we stand behind our workmanship, plus the manufacturer's warranty on materials.");
  });

  it("fill in a template that has none, and keep the ones a business saved", () => {
    expect(templateSettings({}, "lawn_exterior").terms).toBe(LAWN_TERMS);
    expect(templateSettings(null, "lawn_exterior").terms).toBe(LAWN_TERMS);
    expect(templateSettings({}).terms).toBe(DEFAULT_TERMS);
    expect(templateSettings({ terms: "Our own words" }, "lawn_exterior").terms).toBe("Our own words");
    // Blank on purpose is the business's choice, not a missing setting.
    expect(templateSettings({ terms: "" }, "lawn_exterior").terms).toBe("");
  });

  it("are the same whichever document picks the template", () => {
    expect(pickTemplate([], null, "lawn_exterior").terms).toBe(LAWN_TERMS);
    const rows = [
      { id: "t1", is_default: true, settings: { header: "banner" } },
      { id: "t2", is_default: false, settings: { terms: "Mowing terms" } },
    ];
    expect(pickTemplate(rows, null, "lawn_exterior")).toMatchObject({ header: "banner", terms: LAWN_TERMS });
    expect(pickTemplate(rows, "t2", "lawn_exterior").terms).toBe("Mowing terms");
    expect(pickTemplate(rows, null).terms).toBe(DEFAULT_TERMS);
  });
});

describe("automations about autopay", () => {
  const rule = (trigger: string, actions: Action[]) => ({ name: "Autopay", trigger, delay_minutes: 0, conditions: [], actions });

  it("have three triggers, in their own group, for the office with the invoices area", () => {
    for (const [verb, subject, delayable] of [["autopay.enabled", "client", true], ["autopay.failed", "invoice", false], ["payment_method.expiring", "client", true]] as const) {
      expect(triggerDef(verb)).toMatchObject({ group: "Autopay", subject, delayable, area: "invoices", notifyRoles: ["owner", "admin", "office"] });
      expect(isAutopayTrigger(verb)).toBe(true);
      expect(triggerAllowed(verb, (area) => area === "invoices")).toBe(true);
      expect(triggerAllowed(verb, (area) => area === "subs")).toBe(false);
    }
    expect(isAutopayTrigger("invoice.paid")).toBe(false);
    expect(isAutopayTrigger(undefined)).toBe(false);
    // Tokens can't have digits (the token pattern).
    for (const t of variablesForTrigger("autopay.failed")) expect(t.token).toMatch(/^[a-z_]+(\.[a-z_]+)?$/);
  });

  it("never add a client note, which crews read", () => {
    for (const verb of ["autopay.enabled", "autopay.failed", "payment_method.expiring"]) {
      const types = actionsForTrigger(verb).map((a) => a.type);
      expect(types).not.toContain("add_note");
      expect(types).toContain("invite_autopay");
      expect(types).toContain("send_email");
      expect(validateRule(rule(verb, [{ type: "add_note", body: "{{autopay.card}}" }]))).toEqual(["Action 1: “Add a note to the client” doesn't fit what starts this rule."]);
    }
  });

  it("tell only the office, and keep the card, the reason and the link out of tasks", () => {
    expect(validateRule(rule("autopay.failed", [{ type: "notify", roles: ["owner", "crew_lead"], title: "{{autopay.card}} failed" }]))).toEqual([
      "Action 1: only the office hears about this (owners, admins and office), never the crew.",
    ]);
    expect(validateRule(rule("autopay.failed", [{ type: "create_task", title: "Call about {{ autopay.reason }}", days_from_now: 1 }]))).toEqual([
      "Action 1: a task is on the schedule, where the crew sees it, so it can't show card or autopay details.",
    ]);
    // The expiry month isn't private.
    expect(validateRule(rule("payment_method.expiring", [{ type: "create_task", title: "Card expires {{autopay.expires}}", days_from_now: 1 }]))).toEqual([]);
    expect(variablesForTrigger("payment_method.expiring", true).map((v) => v.token)).not.toContain("autopay.card");
    expect(variablesForTrigger("payment_method.expiring", true).map((v) => v.token)).toContain("autopay.expires");
    expect(taskVars("autopay.failed", { title: "Invoice #2", autopay: { card: "Visa ending 4242", reason: "Declined", link: "https://x/hub/t?view=autopay", expires: "08/28" } })).toEqual({
      title: "Invoice #2", autopay: { card: "", reason: "", link: "", expires: "08/28" },
    });
  });

  it("invite a client by email or text", () => {
    expect(validateRule(rule("quote.approved", [{ type: "invite_autopay", channel: "sms" }]))).toEqual([]);
    expect(validateRule(rule("client.created", [{ type: "invite_autopay", channel: "fax" as "sms" }]))).toEqual(["Action 1: choose email or text."]);
    expect(describeAction({ type: "invite_autopay", channel: "sms" })).toBe("Invite to autopay by text");
    expect(describeAction({ type: "invite_autopay", channel: "email" })).toBe("Invite to autopay by email");
    expect(describeRuleSentence(rule("payment_method.expiring", [{ type: "invite_autopay", channel: "email" }]))).toBe(
      "When a saved card expires next month: invite to autopay by email.",
    );
  });

  it("can check whether a client, job or invoice is on autopay", () => {
    for (const subject of ["client", "job", "invoice"] as const) expect(fieldsFor(subject).map((f) => f.field)).toContain("autopay");
    for (const subject of ["request", "quote", "visit"] as const) expect(fieldsFor(subject).map((f) => f.field)).not.toContain("autopay");
    const on = { field: "autopay", op: "equals" as const, value: "yes" };
    expect(checkCondition(on, { autopay: "yes" })).toBe(true);
    expect(checkCondition(on, { autopay: "no" })).toBe(false);
    // When it can't be told, neither yes nor no holds.
    expect(checkCondition(on, { autopay: null })).toBe(false);
    expect(checkCondition({ ...on, value: "no" }, {})).toBe(false);
  });
});
