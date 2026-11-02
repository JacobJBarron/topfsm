/**
 * Campaigns (src/campaigns.ts): the three automated campaigns' starter rules (apps/api/test/
 * automatedCampaigns.test.ts checks them word for word against the migration), how a card reads and
 * writes its rule, N for client.inactive as the database reads it, the days since a visit, the links
 * that are tracked, the results line, the backlog, win-back's reasons, the audience's newer keys,
 * and client.inactive in the rule builder.
 */
import { describe, expect, it } from "vitest";
import { describeRuleSentence, validateRule, type Action } from "../src/automations";
import {
  audienceKeys,
  AUTOMATED_CAMPAIGNS,
  automatedDaysError,
  automatedKeyOf,
  automatedRuleUpdate,
  backlogDays,
  backlogWords,
  HUB_HOME_BUTTON,
  linkButton,
  qualifyWords,
  campaignKeyOf,
  campaignRates,
  daysSinceVisit,
  hasTrackableLink,
  inactiveDays,
  inactiveLabel,
  MAX_TRACKED_LINKS,
  nextRecipientPage,
  readAutomatedRule,
  RECIPIENT_PAGE,
  recurringChoice,
  resultsLine,
  trackableLinks,
  winBackSkip,
  withRecurringChoice,
  type AutomatedKey,
} from "../src/campaigns";

const starter = (key: AutomatedKey) => {
  const { template_key: _key, ...rule } = AUTOMATED_CAMPAIGNS[key].starter;
  return rule;
};
const email = (key: AutomatedKey) => AUTOMATED_CAMPAIGNS[key].starter.actions[0] as Extract<Action, { type: "send_email" }>;

describe("the starter rules", () => {
  it("link to the client's Client Hub, so clicks and bookings can be counted", () => {
    for (const key of ["reengage", "win_back", "close_quotes"] as const) expect(hasTrackableLink(email(key).body), key).toBe(true);
  });

  it("read well for a business with no phone: it's under the name, not in a sentence", () => {
    for (const key of ["reengage", "win_back"] as const) {
      expect(email(key).body, key).not.toMatch(/call \{\{company\.phone\}\}/);
      expect(email(key).body.endsWith("Thanks,\n{{company.name}}\n{{company.phone}}"), key).toBe(true);
    }
  });

  it("name {{link}}'s button for where it goes: the Hub's home is Request work, a quote's page View online", () => {
    expect(linkButton("reengage")).toBe(HUB_HOME_BUTTON);
    expect(linkButton("win_back")).toBe("Request work");
    expect(linkButton("one_off")).toBe("Request work");
    expect(linkButton("close_quotes")).toBe("View online");
  });

  it("are found by their template key, and any rule on client.inactive is Re-engage", () => {
    expect(automatedKeyOf("quote_followup")).toBe("close_quotes");
    expect(automatedKeyOf("review_after_job")).toBeNull();
    expect(campaignKeyOf({ template_key: null, trigger: "client.inactive" })).toBe("reengage");
    expect(campaignKeyOf({ template_key: null, trigger: "quote.lost" })).toBeNull();
    expect(campaignKeyOf({ template_key: "win_back_lost_quotes", trigger: "quote.lost" })).toBe("win_back");
  });
});

describe("a card's rule", () => {
  it("reads the starter rules", () => {
    expect(readAutomatedRule(starter("reengage"), "reengage")).toEqual({ enabled: false, days: 365, subject: email("reengage").subject, body: email("reengage").body });
    expect(readAutomatedRule(starter("win_back"), "win_back")).toMatchObject({ days: 30 });
    expect(readAutomatedRule(starter("close_quotes"), "close_quotes")).toMatchObject({ enabled: true, days: 3 });
    expect(readAutomatedRule({ ...starter("reengage"), conditions: [{ field: "days_since_visit", op: "gte", value: "200" }] }, "reengage")).toMatchObject({ days: 200 });
  });

  it("is null when it was changed into something the card can't show", () => {
    const tag: Action = { type: "add_tag", tag: "Quiet" };
    expect(readAutomatedRule({ ...starter("reengage"), actions: [...starter("reengage").actions, tag] }, "reengage")).toBeNull();
    expect(readAutomatedRule({ ...starter("reengage"), actions: [tag] }, "reengage")).toBeNull();
    expect(readAutomatedRule({ ...starter("win_back"), trigger: "quote.sent" }, "win_back")).toBeNull();
    expect(readAutomatedRule({ ...starter("win_back"), conditions: [] }, "win_back")).toBeNull();
    expect(readAutomatedRule({ ...starter("reengage"), conditions: [...starter("reengage").conditions, { field: "client.tags", op: "includes", value: ["VIP"] }] }, "reengage")).toBeNull();
    expect(readAutomatedRule({ ...starter("close_quotes"), delay_minutes: 4320 + 60 }, "close_quotes")).toBeNull();
    expect(readAutomatedRule({ ...starter("close_quotes"), delay_minutes: 31 * 1440 }, "close_quotes")).toBeNull();
    expect(readAutomatedRule({ ...starter("close_quotes"), delay_minutes: 0 }, "close_quotes")).toBeNull();
    expect(readAutomatedRule({ ...starter("reengage"), delay_minutes: 1440 }, "reengage")).toBeNull();
    expect(readAutomatedRule({ ...starter("reengage"), conditions: [{ field: "days_since_visit", op: "gte", value: 1000 }] }, "reengage")).toBeNull();
    expect(readAutomatedRule(null, "reengage")).toBeNull();
  });

  it("writes the days where they live, and the name and description only while they're the starter's or the card's", () => {
    expect(automatedRuleUpdate(starter("close_quotes"), "close_quotes", { days: 5 })).toEqual({
      trigger: "quote.sent", conditions: [{ field: "status", op: "equals", value: "sent" }], delay_minutes: 7200, actions: [email("close_quotes")],
      name: "Follow up on quotes after 5 days", description: "Emails the client if they haven't answered a quote 5 days after you send it.",
    });
    const fiveDays = { ...starter("close_quotes"), name: "Follow up on quotes after 5 days", description: "Emails the client if they haven't answered a quote 5 days after you send it.", delay_minutes: 7200 };
    expect(automatedRuleUpdate(fiveDays, "close_quotes", { days: 1 })).toMatchObject({ name: "Follow up on quotes after 1 day", description: "Emails the client if they haven't answered a quote 1 day after you send it." });
    const theirs = { ...starter("close_quotes"), name: "Chase quotes", description: "Our own follow-up" };
    const kept = automatedRuleUpdate(theirs, "close_quotes", { days: 5, subject: "Any questions?" });
    expect(kept).not.toHaveProperty("name");
    expect(kept).not.toHaveProperty("description");
    expect(kept.actions).toEqual([{ type: "send_email", subject: "Any questions?", body: email("close_quotes").body }]);
    expect(automatedRuleUpdate(starter("reengage"), "reengage", { days: 90 })).toMatchObject({
      conditions: [{ field: "days_since_visit", op: "gte", value: 90 }], delay_minutes: 0, description: "Emails clients 3 months after their last visit, once each time they go quiet.",
    });
    expect(automatedRuleUpdate(starter("win_back"), "win_back", { days: 45 })).toMatchObject({ delay_minutes: 64800, description: "Emails the client 45 days after a quote is marked lost, if it still is." });
  });

  it("doesn't change the switch unless it's told to", () => {
    expect(automatedRuleUpdate(starter("win_back"), "win_back", { body: "Hi again, {{link}}" })).not.toHaveProperty("enabled");
    expect(automatedRuleUpdate(starter("win_back"), "win_back", { enabled: true })).toMatchObject({ enabled: true });
  });

  it("puts back a deleted rule as the starter rule, with the form", () => {
    expect(automatedRuleUpdate(null, "win_back", { enabled: true })).toEqual({ ...AUTOMATED_CAMPAIGNS.win_back.starter, enabled: true });
    expect(automatedRuleUpdate(null, "reengage", { days: 730 })).toMatchObject({
      template_key: "reengage_past_clients", name: "Re-engage past clients", description: "Emails clients 2 years after their last visit, once each time they go quiet.", enabled: false,
      conditions: [{ field: "days_since_visit", op: "gte", value: 730 }],
    });
  });

  it("keeps the days in range", () => {
    expect(automatedDaysError("reengage", 29)).toBe("Pick from 30 to 730 days.");
    expect(automatedDaysError("reengage", 730)).toBeNull();
    expect(automatedDaysError("win_back", 181)).toBe("Pick from 1 to 180 days.");
    expect(automatedDaysError("close_quotes", 2.5)).toBe("Pick from 1 to 30 days.");
    expect(inactiveLabel(365)).toBe("1 year");
    expect(inactiveLabel(182)).toBe("6 months");
    expect(inactiveLabel(200)).toBe("200 days");
  });
});

describe("days without a visit", () => {
  it("waits for the largest days condition, never under 30, a year without one, as the database does", () => {
    expect(inactiveDays([])).toBe(365);
    expect(inactiveDays(null)).toBe(365);
    expect(inactiveDays([{ field: "days_since_visit", op: "gte", value: 90 }, { field: "days_since_visit", op: "gte", value: "200" }])).toBe(200);
    expect(inactiveDays([{ field: "days_since_visit", op: "gte", value: 5 }])).toBe(30);
    expect(inactiveDays([{ field: "days_since_visit", op: "gte", value: -5 }])).toBe(365);
    expect(inactiveDays([{ field: "status", op: "equals", value: "active" }])).toBe(365);
  });

  it("are counted in the company's own dates", () => {
    const now = new Date("2026-10-27T15:00:00Z");
    expect(daysSinceVisit(new Date("2025-09-01T15:00:00Z"), now, "America/New_York")).toBe(421);
    // 11:30pm on the 26th in New York is the 27th in UTC.
    expect(daysSinceVisit(new Date("2026-10-27T03:30:00Z"), now, "America/New_York")).toBe(1);
    expect(daysSinceVisit(new Date("2026-10-27T03:30:00Z"), now, "UTC")).toBe(0);
  });

  it("are a condition the rule builder asks for on client.inactive", () => {
    const rule = { name: "Re-engage", trigger: "client.inactive", delay_minutes: 0, conditions: [], actions: [email("reengage")] };
    expect(validateRule(rule)).toContain("Say how many days without a visit, from 30 to 730.");
    expect(validateRule({ ...rule, conditions: [{ field: "days_since_visit", op: "gte", value: 20 }] })).toContain("Say how many days without a visit, from 30 to 730.");
    expect(validateRule({ ...rule, conditions: [{ field: "days_since_visit", op: "gte", value: 365 }] })).toEqual([]);
    expect(describeRuleSentence({ ...rule, conditions: [{ field: "days_since_visit", op: "gte", value: 365 }] }))
      .toBe("When a client hasn't had a visit in a while, if days since their last visit is at least 365 days: email the client.");
  });
});

describe("tracked links", () => {
  it("are the email's web links, each once, in order, up to 50, without a sentence's last punctuation", () => {
    expect(trackableLinks("See https://a.example/x, then https://b.example/y?q=1. Again https://a.example/x! Write mailto:hi@a.example or ftp://a.example")).toEqual([
      "https://a.example/x", "https://b.example/y?q=1",
    ]);
    expect(trackableLinks("(http://a.example/p)")).toEqual(["http://a.example/p"]);
    const many = Array.from({ length: 60 }, (_, i) => `https://a.example/${i}`).join(" ");
    expect(trackableLinks(many)).toHaveLength(MAX_TRACKED_LINKS);
    expect(trackableLinks("No links here")).toEqual([]);
  });

  it("can be counted when the email has a link, or {{link}}", () => {
    expect(hasTrackableLink("Book at {{ link }}")).toBe(true);
    expect(hasTrackableLink("Call us")).toBe(false);
  });
});

describe("results", () => {
  it("read as a line, in whole percents", () => {
    expect(campaignRates({ sent: 120, opened: 55, clicked: 11 })).toEqual({ opened: 46, clicked: 9 });
    expect(resultsLine({ sent: 120, opened: 55, clicked: 11 })).toBe("120 sent · 46% opened · 9% clicked");
    expect(campaignRates({ sent: 0, opened: 0, clicked: 0 })).toEqual({ opened: 0, clicked: 0 });
    expect(resultsLine({ sent: 0, opened: 0, clicked: 0 })).toBe("Nothing sent yet");
    expect(resultsLine(null)).toBe("Nothing sent yet");
  });

  it("page through every recipient, past the 500 one page can hold", () => {
    expect(nextRecipientPage(0, 2000)).toEqual({ p_limit: 50, p_offset: 0 });
    expect(nextRecipientPage(500, 2000)).toEqual({ p_limit: 50, p_offset: 500 });
    expect(nextRecipientPage(1950, 2000)).toEqual({ p_limit: 50, p_offset: 1950 });
    expect(nextRecipientPage(2000, 2000)).toBeNull();
    expect(RECIPIENT_PAGE).toBeLessThanOrEqual(500);
  });

  it("say how long a re-engage backlog takes, 100 a day", () => {
    expect(backlogDays(0)).toBe(0);
    expect(backlogDays(100)).toBe(1);
    expect(backlogDays(142)).toBe(2);
    expect(backlogWords(142)).toBe("100 a day over the next 2 days");
    expect(backlogWords(50)).toBe("within a day");
    expect(backlogWords(100)).toBe("within a day");
    expect(backlogWords(1400)).toBe("100 a day over about 2 weeks");
    expect(backlogWords(2000)).toBe("100 a day over about 3 weeks");
    expect(qualifyWords(1)).toBe("1 past client qualifies now");
    expect(qualifyWords(1200)).toBe("1,200 past clients qualify now");
  });

  it("say why a win-back email isn't sent after all", () => {
    expect(winBackSkip({})).toBeNull();
    expect(winBackSkip({ approvedSince: true, activeJob: true })).toBe("They approved another quote since");
    expect(winBackSkip({ activeJob: true })).toBe("They have an active job");
    expect(winBackSkip({ jobSince: true })).toBe("They have a newer job");
    expect(winBackSkip({ newerQuote: true })).toBe("They have a newer quote");
    expect(winBackSkip({ requestSince: true })).toBe("They sent a request since");
  });
});

describe("audiences", () => {
  it("keep the newer keys in the shape the database reads, leaving empty ones out", () => {
    expect(audienceKeys({ statuses: ["active"], cities: [" Blacksburg ", "blacksburg", ""], services: ["Aeration"], recurring: "yes" })).toEqual({
      statuses: ["active"], cities: ["Blacksburg"], services: ["Aeration"], recurring: "yes",
    });
    // Each once in any case, kept as written, so a sent campaign reads as it was picked.
    expect(audienceKeys({ cities: ["St. Louis", "st. louis", "McKinney"] }).cities).toEqual(["St. Louis", "McKinney"]);
    expect(audienceKeys({ cities: [], recurring_ending: false })).toEqual({});
    // Ending soon is an active recurring job, so it stands alone.
    expect(audienceKeys({ recurring: "no", recurring_ending: true })).toEqual({ recurring_ending: true });
  });

  it("pick recurring work in one choice, so none matches nobody", () => {
    expect(recurringChoice({})).toBe("any");
    expect(recurringChoice({ recurring: "yes" })).toBe("has");
    expect(recurringChoice({ recurring: "no" })).toBe("none");
    expect(recurringChoice({ recurring_ending: true })).toBe("ending");
    expect(withRecurringChoice({ statuses: ["active"], recurring: "yes" }, "ending")).toEqual({ statuses: ["active"], recurring_ending: true });
    expect(withRecurringChoice({ recurring_ending: true }, "none")).toEqual({ recurring: "no" });
    expect(withRecurringChoice({ recurring: "no" }, "any")).toEqual({});
  });
});
