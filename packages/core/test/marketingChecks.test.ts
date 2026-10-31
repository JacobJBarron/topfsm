/**
 * Follow-ups to Marketing from checking it end to end (docs/marketing-plan.md): a text review ask's
 * opt-out line, a referral ask's button, the pill for a friend who isn't a lead, Write with AI's link,
 * and the condition that keeps a credit-covered invoice from being told as paid.
 */
import { describe, expect, it } from "vitest";
import { CONDITION_FIELDS, describeCondition, evaluateConditions, fieldsFor } from "../src/automations";
import { withHubLink } from "../src/campaigns";
import { DEFAULT_REMINDER_MESSAGE, DEFAULT_REVIEW_MESSAGE, REFERRAL_LINK_BUTTON, referralPill, STOP_LINE, withStopLine } from "../src/marketing";

describe("a text review ask or reminder", () => {
  it("ends with how to opt out, once, unless the business's own words say STOP", () => {
    expect(STOP_LINE).toBe("Reply STOP to opt out.");
    expect(withStopLine("Hi Mia, a quick review?\n\nhttps://x.test/api/public/r/AbCdEf123456\n")).toBe("Hi Mia, a quick review?\n\nhttps://x.test/api/public/r/AbCdEf123456\n\nReply STOP to opt out.");
    expect(withStopLine("Review us: https://x.test/r. Text STOP to stop these.")).toBe("Review us: https://x.test/r. Text STOP to stop these.");
    // "stop by" isn't opt-out wording.
    expect(withStopLine("We'll stop by Tuesday. {{link}}")).toBe("We'll stop by Tuesday. {{link}}\n\nReply STOP to opt out.");
    expect(withStopLine(withStopLine("Hi"))).toBe("Hi\n\nReply STOP to opt out.");
  });

  it("fits the default ask and reminder in two segments with a short link", () => {
    const link = "https://crewtavo-mkt.test/api/public/r/AbCdEf123456";
    for (const message of [DEFAULT_REVIEW_MESSAGE, DEFAULT_REMINDER_MESSAGE]) {
      const text = withStopLine(message.replace("{{client.first_name}}", "Pete").replace("{{company.name}}", "Whole check Lawn Co").replace("{{link}}", link));
      // GSM-7 in several segments: 153 characters each.
      expect(text.length, message).toBeLessThanOrEqual(306);
    }
  });
});

describe("a referral ask's link", () => {
  it("is a button for the client, not the friend's Request a quote", () => {
    expect(REFERRAL_LINK_BUTTON).toBe("Your referral link");
  });
});

describe("a referral's pill", () => {
  it("says No credit for a friend who was the referrer or already a client, who isn't a lead", () => {
    expect(referralPill({ status: "new", reward_status: "none", no_reward_reason: "self" })).toEqual({ kind: "credit", status: "none" });
    expect(referralPill({ status: "new", reward_status: "none", no_reward_reason: "already_client" })).toEqual({ kind: "credit", status: "none" });
    // No credit by hand, or lost: the friend's progress still shows.
    expect(referralPill({ status: "quoted", reward_status: "none", no_reward_reason: "manual" })).toEqual({ kind: "referral", status: "quoted" });
    expect(referralPill({ status: "lost", reward_status: "none", no_reward_reason: "lost" })).toEqual({ kind: "referral", status: "lost" });
    expect(referralPill({ status: "won", reward_status: "earned", no_reward_reason: null })).toEqual({ kind: "credit", status: "earned" });
  });
});

describe("Write with AI's drafts", () => {
  it("get {{link}} on a line of its own before the sign-off, so clicks and bookings are counted", () => {
    expect(withHubLink("Hi {{client.first_name}},\n\nSpring spots are open.\n\nThanks,\n{{company.name}}")).toBe(
      "Hi {{client.first_name}},\n\nSpring spots are open.\n\n{{link}}\n\nThanks,\n{{company.name}}",
    );
    expect(withHubLink("Hi there,\n\nBook your aeration this month.")).toBe("Hi there,\n\nBook your aeration this month.\n\n{{link}}");
    // A draft that has it already is left as it is.
    const linked = "Hi,\n\nAsk for a visit:\n\n{{link}}\n\nThanks,\n{{company.name}}";
    expect(withHubLink(linked)).toBe(linked);
    expect(withHubLink("Hi,\n\nBest,\nThe team")).toBe("Hi,\n\n{{link}}\n\nBest,\nThe team");
  });
});

describe("an invoice's amount paid", () => {
  it("is a condition on invoice rules, so the paid notice skips one a credit covered whole", () => {
    expect(CONDITION_FIELDS.find((f) => f.field === "amount_paid")).toMatchObject({ kind: "money", ops: ["gte", "lte"], subjects: ["invoice"] });
    expect(fieldsFor("invoice").some((f) => f.field === "amount_paid")).toBe(true);
    expect(fieldsFor("quote").some((f) => f.field === "amount_paid")).toBe(false);
    const paidSomething = [{ field: "amount_paid", op: "gte" as const, value: 0.01 }];
    expect(evaluateConditions(paidSomething, { amount_paid: 15.8 }, "invoice").pass).toBe(true);
    expect(evaluateConditions(paidSomething, { amount_paid: 0 }, "invoice")).toEqual({ pass: false, failed: "Amount paid is at least $0.01" });
    expect(describeCondition(paidSomething[0]!, "invoice")).toBe("Amount paid is at least $0.01");
  });
});
