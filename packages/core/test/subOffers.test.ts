import { describe, expect, it } from "vitest";
import {
  actionsForTrigger,
  amountWords,
  changeText,
  byEmail,
  DEFAULT_NOTIFICATION_PREFS,
  insuranceWarning,
  insuranceWarningItems,
  insuranceWarningText,
  isChangeOffer,
  moneyShort,
  notificationTopic,
  NOTIFICATION_TOPICS,
  REVIEW_ACCESS_HINT,
  reviewNoticesFor,
  offerClosedMessage,
  offerDate,
  offerDays,
  offerLine,
  offerOutcomeLabel,
  offerText,
  offerTimeWords,
  respondByProblem,
  triggerDef,
  TRIGGERS,
  validateRule,
  variablesForTrigger,
  type InsuranceWarningItem,
  type PaperworkStatus,
} from "../src";

describe("an offer in one line", () => {
  it("says money as a sub reads it, cents only when there are some", () => {
    expect(moneyShort(2040)).toBe("$2,040");
    expect(moneyShort("2040.00")).toBe("$2,040");
    expect(moneyShort(2040.5)).toBe("$2,040.50");
    expect(moneyShort(0.07)).toBe("$0.07");
    expect(moneyShort(1234567.891)).toBe("$1,234,567.89");
    expect(moneyShort(null)).toBe("$0");
  });

  it("says quantities as the database does", () => {
    expect(amountWords(24, "sq")).toBe("24 squares");
    expect(amountWords("24.000", "Squares")).toBe("24 squares");
    expect(amountWords(1, "sq")).toBe("1 square");
    expect(amountWords(1, "day")).toBe("1 day");
    expect(amountWords(3, "day")).toBe("3 days");
    expect(amountWords(120.5, "lf")).toBe("120.5 lf");
    expect(amountWords(2, null)).toBe("2 ea");
  });

  it("says the days of the work: one, or the first to the last", () => {
    expect(offerDate("2026-11-03")).toBe("Tue Nov 3");
    expect(offerDays(["2026-11-03"])).toBe("Tue Nov 3");
    expect(offerDays(["2026-11-05", null, "2026-11-03", "2026-11-03"])).toBe("Tue Nov 3 to Thu Nov 5");
    expect(offerDays([])).toBeNull();
  });

  it("puts the job, its days, its main quantity and the price in one line", () => {
    const roof = {
      title: "Smith roof",
      dates: ["2026-11-03"],
      lines: [
        { basis: "per_unit", unit: "lf", quantity: 0, amount: 0 },
        { basis: "per_job", unit: "job", quantity: 1, amount: 200 },
        { basis: "per_unit", unit: "sq", quantity: 24, amount: 2040 },
        { basis: "per_unit", unit: "lf", quantity: 30, amount: 90 },
      ],
      total: 2330,
    };
    expect(offerLine(roof)).toBe("Smith roof, Tue Nov 3, 24 squares, $2,330");
    expect(offerText(roof)).toBe("Smith roof, Tue Nov 3, 24 squares, $2,330. Open Crewtavo to accept or decline.");
    // Nothing per unit, and no dates yet: the job and the price.
    expect(offerLine({ title: "Jones gutters", dates: [], lines: [{ basis: "per_job", unit: "job", quantity: 1, amount: 600 }], total: 600 })).toBe("Jones gutters, $600");
    expect(changeText({ title: "Smith roof", total: 2210, agreed: "2040.00" })).toBe("New price for Smith roof: $2,210 (was $2,040). Open Crewtavo to accept or decline.");
  });

  it("says when to answer by, in the company's time zone, as the text carries it", () => {
    // 9 PM in UTC is 5 PM in New York, the day before Smith roof.
    expect(offerTimeWords("2026-11-02T22:00:00Z", "America/New_York")).toBe("Mon Nov 2, 5:00 PM");
    expect(offerTimeWords("2026-11-03T05:05:00Z", "America/New_York")).toBe("Tue Nov 3, 12:05 AM");
    expect(offerTimeWords(new Date("2026-11-03T05:05:00Z"), "America/Los_Angeles")).toBe("Mon Nov 2, 9:05 PM");
    const roof = { title: "Smith roof", dates: ["2026-11-03"], lines: [{ basis: "per_unit", unit: "sq", quantity: 24, amount: 2040 }], total: 2040 };
    expect(offerText(roof, { respondBy: "2026-11-02T22:00:00Z", timeZone: "America/New_York" }))
      .toBe("Smith roof, Tue Nov 3, 24 squares, $2,040. Answer by Mon Nov 2, 5:00 PM. Open Crewtavo to accept or decline.");
    expect(offerText(roof, { respondBy: null, timeZone: "America/New_York" })).toBe("Smith roof, Tue Nov 3, 24 squares, $2,040. Open Crewtavo to accept or decline.");
    expect(changeText({ title: "Smith roof", total: 2210, agreed: 2040 }, { respondBy: "2026-11-02T22:00:00Z", timeZone: "America/New_York" }))
      .toBe("New price for Smith roof: $2,210 (was $2,040). Answer by Mon Nov 2, 5:00 PM. Open Crewtavo to accept or decline.");
  });
});

describe("the time to answer by", () => {
  const now = new Date("2026-10-25T15:00:00Z");
  it("is optional, still to come, and at most 90 days off", () => {
    expect(respondByProblem(null, now)).toBeNull();
    expect(respondByProblem("2026-10-27T21:00:00Z", now)).toBeNull();
    expect(respondByProblem("2026-10-25T14:59:00Z", now)).toBe("Pick a time to answer by that's still to come.");
    expect(respondByProblem("2027-02-01T00:00:00Z", now)).toBe("Give them at most 90 days to answer.");
    expect(respondByProblem("soon", now)).toBe("Pick a time to answer by.");
  });
});

describe("the insurance warning", () => {
  const status = (s: Partial<PaperworkStatus> & Pick<PaperworkStatus, "requirement" | "state">): PaperworkStatus => ({
    document_id: s.state === "missing" ? null : `doc-${s.requirement}`, kind: s.state === "missing" ? null : s.requirement, expires_on: null, days_left: null,
    verified: s.state === "missing" ? null : true, waiting: false, ...s,
  });

  it("finds what's missing, run out, ending before the work or not checked yet, and warns about nothing else", () => {
    const items = insuranceWarning(
      [
        status({ requirement: "w9", state: "missing" }),
        status({ requirement: "liability", state: "ok", expires_on: "2027-06-01", verified: false }),
        status({ requirement: "workers_comp", state: "expiring", expires_on: "2026-11-04" }),
      ],
      "2026-11-06",
    );
    expect(items).toEqual([
      { requirement: "liability", problem: "unverified", kind: "liability", document_id: "doc-liability", expires_on: "2027-06-01", work_until: "2026-11-06", waiting: false },
      { requirement: "workers_comp", problem: "ends_before_work", kind: "workers_comp", document_id: "doc-workers_comp", expires_on: "2026-11-04", work_until: "2026-11-06", waiting: false },
    ]);
    expect(insuranceWarning([status({ requirement: "liability", state: "expired", expires_on: "2026-10-01" }), status({ requirement: "workers_comp", state: "missing" })], null).map((i) => i.problem))
      .toEqual(["expired", "missing"]);
    // Ending later than the work (or with no dated work) is fine.
    expect(insuranceWarning([status({ requirement: "liability", state: "expiring", expires_on: "2026-11-10" })], "2026-11-06")).toEqual([]);
    expect(insuranceWarning([status({ requirement: "workers_comp", state: "expiring", expires_on: "2026-11-10" })], null)).toEqual([]);
  });

  it("says it to the sub as the database does, and to the office", () => {
    const item = (i: Partial<InsuranceWarningItem>): InsuranceWarningItem => ({
      requirement: "workers_comp", problem: "ends_before_work", kind: "workers_comp", document_id: "d", expires_on: "2026-11-01", work_until: "2026-11-05", waiting: false, ...i,
    });
    expect(insuranceWarningText(item({}), "sub")).toBe("Your workers' comp certificate on file ends before this job.");
    expect(insuranceWarningText(item({}), "office")).toBe("Their workers' comp certificate ends Nov 1, before the last day of work (Nov 5).");
    expect(insuranceWarningText(item({ waiting: true }), "sub")).toBe("Your workers' comp certificate on file ends before this job. We'll check the new one you sent.");
    expect(insuranceWarningText(item({ waiting: true }), "office")).toBe("Their workers' comp certificate ends Nov 1, before the last day of work (Nov 5). They've sent a new one to check.");
    expect(insuranceWarningText(item({ problem: "missing", kind: null }), "sub")).toBe("We don't have your workers' comp certificate or exemption on file.");
    expect(insuranceWarningText(item({ requirement: "liability", problem: "missing", kind: null }), "office")).toBe("No liability insurance on file.");
    expect(insuranceWarningText(item({ problem: "expired", kind: "wc_exemption", expires_on: "2026-10-01" }), "sub")).toBe("Your workers' comp exemption on file has run out.");
    expect(insuranceWarningText(item({ problem: "expired", kind: "wc_exemption", expires_on: "2026-10-01" }), "office")).toBe("Their workers' comp exemption ran out Oct 1.");
    expect(insuranceWarningText(item({ requirement: "liability", problem: "unverified", kind: "liability", waiting: true }), "sub")).toBe("We haven't checked the liability insurance you sent yet.");
    expect(insuranceWarningText(item({ requirement: "liability", problem: "unverified", kind: "liability" }), "office")).toBe("The liability insurance they sent hasn't been checked yet.");
  });

  it("reads the recorded warning safely", () => {
    expect(insuranceWarningItems(null)).toEqual([]);
    expect(insuranceWarningItems([{ requirement: "liability", problem: "missing" }, { problem: "odd" }, "x"])).toEqual([{ requirement: "liability", problem: "missing" }]);
  });
});

describe("answering", () => {
  it("knows a new price from a first offer", () => {
    expect(isChangeOffer({ status: "offered", accepted_snapshot: { total: 2040, lines: [] } })).toBe(true);
    expect(isChangeOffer({ status: "offered", accepted_snapshot: null })).toBe(false);
    expect(isChangeOffer({ status: "accepted", accepted_snapshot: { total: 2040, lines: [] } })).toBe(false);
    expect(offerOutcomeLabel("withdrawn", "sub")).toBe("Withdrawn by the office");
    expect(offerOutcomeLabel("declined")).toBe("Declined");
    expect(offerOutcomeLabel("withdrawn")).toBe("Withdrawn");
    expect(offerOutcomeLabel(null)).toBe("");
  });

  it("says why an answer didn't go through", () => {
    const offer = { status: "offered", outcome: null, can_answer: true, offer_round: 2 };
    expect(offerClosedMessage(null)).toBe("This offer isn't open any more.");
    expect(offerClosedMessage(offer, 1)).toBe("The office changed this offer. Have a look at it again.");
    expect(offerClosedMessage({ ...offer, can_answer: false }, 2)).toBe("This offer ran out. Call the office if you'd still like the work.");
    expect(offerClosedMessage({ ...offer, status: "expired", outcome: "expired", can_answer: false })).toBe("This offer ran out. Call the office if you'd still like the work.");
    expect(offerClosedMessage({ ...offer, status: "withdrawn", outcome: "withdrawn", can_answer: false })).toBe("The office withdrew this offer.");
    // Each offer is to one sub: taken already means it's theirs, not someone else's.
    expect(offerClosedMessage({ ...offer, status: "accepted", outcome: "accepted", can_answer: false })).toBe("You've already accepted this job. It's on My day.");
    // A new price turned down leaves the pay agreed.
    expect(offerClosedMessage({ ...offer, status: "accepted", outcome: "declined", can_answer: false })).toBe("This offer has already been declined.");
    expect(offerClosedMessage({ ...offer, status: "cancelled", outcome: null, can_answer: false })).toBe("This offer isn't open any more.");
  });
});

describe("hearing about offers", () => {
  it("gives a sub's job offers and pay a topic of their own, on by default, texts too", () => {
    expect(NOTIFICATION_TOPICS.map((t) => t.key)).toContain("jobs");
    expect(notificationTopic("jobs")).toBe("jobs");
    expect(notificationTopic("job")).toBe("alerts");
    expect(DEFAULT_NOTIFICATION_PREFS.sms).toEqual(["jobs"]);
    expect(DEFAULT_NOTIFICATION_PREFS.push).toContain("jobs");
    expect(DEFAULT_NOTIFICATION_PREFS.email).toContain("jobs");
  });

  it("gives Google reviews a topic, by push and email, where email carries only the low ratings", () => {
    expect(NOTIFICATION_TOPICS.find((t) => t.key === "reviews")).toEqual({ key: "reviews", label: "Google reviews", hint: "New reviews, low ratings first. Email only for 1 and 2 stars" });
    expect(["review", "review_low", "review_access"].map(notificationTopic)).toEqual(["reviews", "reviews", "reviews"]);
    expect(notificationTopic("reviewed")).toBe("alerts");
    expect(DEFAULT_NOTIFICATION_PREFS.email).toContain("reviews");
    expect(DEFAULT_NOTIFICATION_PREFS.push).toContain("reviews");
    expect(DEFAULT_NOTIFICATION_PREFS.sms).not.toContain("reviews");
    expect([byEmail("review"), byEmail("review_low"), byEmail("review_access"), byEmail("schedule")]).toEqual([false, true, true, true]);
  });

  // As private.marketing_office and private.apps_admins pick who gets them (supabase/tests/google_reviews_test.sql).
  it("offers Google reviews to everyone they reach: the marketing office, and owners and admins who connect apps", () => {
    const who = (role: string, permissions: string[] = []) => reviewNoticesFor({ role, permissions }, true);
    expect([who("owner"), who("admin", ["marketing"]), who("office", ["marketing"])]).toEqual(["reviews", "reviews", "reviews"]);
    // An admin without the marketing area still hears when Google Business Profile needs them.
    expect(who("admin", ["apps", "reports"])).toBe("access");
    expect([who("office", ["apps"]), who("admin", ["reports"]), who("estimator", ["marketing"]), who("field_crew", ["marketing", "apps"])]).toEqual([null, null, null, null]);
    // Nothing goes while Marketing is uninstalled.
    expect(reviewNoticesFor({ role: "owner", permissions: [] }, false)).toBeNull();
    expect(REVIEW_ACCESS_HINT).toBe("When Google Business Profile needs signing in again or a location picked");
  });

  it("lets automations react to offers, on the job", () => {
    const verbs = TRIGGERS.filter((t) => t.group === "Subcontractors").map((t) => t.verb);
    expect(verbs).toEqual(["sub_offer.sent", "sub_offer.accepted", "sub_offer.declined", "sub_offer.expired"]);
    expect(triggerDef("sub_offer.declined")).toMatchObject({ subject: "job", label: "A sub turns down a job offer" });
  });

  it("only notifies the office or makes a task, with the sub's name and price (not the client's total)", () => {
    for (const t of TRIGGERS.filter((x) => x.group === "Subcontractors")) {
      expect(actionsForTrigger(t.verb).map((a) => a.type), t.verb).toEqual(["notify", "create_task"]);
      const tokens = variablesForTrigger(t.verb).map((v) => v.token);
      expect(tokens).toEqual(expect.arrayContaining(["sub.name", "sub.price", "title", "client.name"]));
      expect(tokens).not.toContain("total");
    }
    expect(variablesForTrigger("sub_offer.declined").map((v) => v.token)).toContain("sub.reason");
    expect(variablesForTrigger("sub_offer.sent").map((v) => v.token)).not.toContain("sub.reason");
    // Other triggers are as they were.
    expect(actionsForTrigger("job.created").map((a) => a.type)).toContain("send_sms");
    expect(variablesForTrigger("job.created").map((v) => v.token)).toContain("total");
    const rule = { name: "Tell me", trigger: "sub_offer.declined", delay_minutes: 0, conditions: [] };
    expect(validateRule({ ...rule, actions: [{ type: "notify", roles: ["owner"], title: "{{sub.name}} said no to {{title}}" }] })).toEqual([]);
    expect(validateRule({ ...rule, actions: [{ type: "send_sms", body: "Sorry" }] })).toEqual(["Action 1: “Text the client” doesn't fit what starts this rule."]);
  });
});
