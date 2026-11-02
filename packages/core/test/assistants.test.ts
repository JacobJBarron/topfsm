import { describe, expect, it } from "vitest";
import {
  agingBuckets,
  areasForRole,
  assistantRefusal,
  buildSimpleRule,
  clientStatus,
  entrySpan,
  jobProfit,
  laborRate,
  moneyFigures,
  paymentProblem,
  paySummary,
  planImport,
  recordsToClients,
  ruleDay,
  salesFigures,
  teamHours,
  timeEntryProblem,
  type CostedTime,
  describeAssistantAccess,
  markdownToGuide,
  mayChange,
  memberPermissions,
  normalizeChecklist,
  normalizeIntakeForm,
  toAssistantAccess,
} from "../src";

describe("assistant access", () => {
  it("only reads unless it's been given more", () => {
    expect(toAssistantAccess(null)).toEqual({ level: "read", areas: [] });
    expect(toAssistantAccess({ level: "nonsense", areas: ["prices"] })).toEqual({ level: "read", areas: [] });
    expect(mayChange(toAssistantAccess(null), "records")).toBe(false);
  });

  it("changes chosen areas, but doesn't delete", () => {
    const access = toAssistantAccess({ level: "areas", areas: ["prices", "crews", "unknown"] });
    expect(access.areas).toEqual(["prices", "crews"]);
    expect(mayChange(access, "prices")).toBe(true);
    expect(mayChange(access, "automations")).toBe(false);
    expect(mayChange(access, "prices", true)).toBe(false);
    expect(describeAssistantAccess(access)).toBe("Can change: Price list, Crews");
  });

  it("full access changes and deletes everything", () => {
    const access = toAssistantAccess({ level: "full", areas: [] });
    expect(mayChange(access, "guides", true)).toBe(true);
    expect(describeAssistantAccess(access)).toBe("Full access");
    expect(describeAssistantAccess({ level: "areas", areas: [] })).toBe("Read only");
  });

  it("offers only what the person's role can change", () => {
    expect(areasForRole("owner", memberPermissions("owner"))).toHaveLength(19);
    expect(areasForRole("office", memberPermissions("office"))).not.toContain("company");
    expect(areasForRole("office", memberPermissions("office"))).not.toContain("team");
    expect(areasForRole("estimator", memberPermissions("estimator"))).toEqual(["clients", "records", "jobs", "schedule", "time", "quotes"]);
    expect(areasForRole("crew_lead", memberPermissions("crew_lead"))).toEqual(["schedule", "time"]);
    expect(areasForRole("field_crew", memberPermissions("field_crew"))).toEqual(["time"]);
    // A custom office role without guides or money.
    expect(areasForRole("office", memberPermissions("office", ["settings", "automations"]))).toEqual(["clients", "records", "jobs", "schedule", "time", "prices", "templates", "crews", "checklists", "booking", "automations"]);
    // Marketing and promo codes go with the Marketing area of a role.
    expect(areasForRole("office", memberPermissions("office", ["marketing"]))).toEqual(["clients", "records", "jobs", "schedule", "time", "marketing", "promos"]);
  });

  it("full access without money changes and deletes everything else", () => {
    const access = toAssistantAccess({ level: "full_no_money", areas: ["ignored"] });
    expect(access).toEqual({ level: "full_no_money", areas: [] });
    expect(mayChange(access, "jobs", true)).toBe(true);
    expect(mayChange(access, "team")).toBe(true);
    for (const money of ["quotes", "invoices", "pay"] as const) expect(mayChange(access, money)).toBe(false);
    expect(describeAssistantAccess(access)).toBe("Full access, no money");
    expect(assistantRefusal("invoices", false, access)).toBe("This assistant can't change money: quotes, invoices, payments, pay or promo codes. To let it, give it Full access in Crewtavo, under Settings → AI assistants.");
    expect(assistantRefusal("prices", true, { level: "read", areas: [] })).toMatch(/^This assistant can't change the price list\./);
  });
});

describe("booking forms", () => {
  it("makes the link, keys and ZIP codes", () => {
    const form = normalizeIntakeForm({
      name: " Spring cleanup ",
      zips: ["24141", " 24141", "24073"],
      questions: [
        { type: "address", label: "Address", required: true },
        { label: " Yard size ", type: "choice", required: true, options: [" Small", "", "Large "] },
        { label: "Yard size", type: "text" },
      ],
    });
    expect(form).toEqual({
      name: "Spring cleanup",
      slug: "spring-cleanup",
      service_area_zips: ["24141", "24073"],
      questions: [
        { key: "yard_size", label: "Yard size", type: "choice", required: true, options: ["Small", "Large"] },
        { key: "yard_size_2", label: "Yard size", type: "text", required: false, options: undefined },
      ],
    });
  });

  it("says what's wrong", () => {
    const base = { name: "Quote", zips: [], questions: [] };
    expect(() => normalizeIntakeForm({ ...base, name: " " })).toThrow("Name the form.");
    expect(() => normalizeIntakeForm(base, ["quote"])).toThrow("Another form already uses that link.");
    expect(() => normalizeIntakeForm({ ...base, zips: ["2414"] })).toThrow("ZIP codes should be 5 digits: 2414");
    expect(() => normalizeIntakeForm({ ...base, questions: [{ label: "Pick", type: "choice" }] })).toThrow("Choice questions need options.");
    expect(() => normalizeIntakeForm({ ...base, questions: [{ label: "Pick", type: "dropdown" }] })).toThrow("Question types are");
  });
});

describe("checklists", () => {
  it("keeps keys unique and tidies items", () => {
    const list = normalizeChecklist({
      name: " Mower check ",
      job_type: " ",
      items: [
        { label: "Blades sharp", type: "check", required: true },
        { key: "blades_sharp", label: "Blades sharp (deck 2)", type: "check" },
        { label: "Oil level", type: "choice", options: ["Full ", " "] },
      ],
    });
    expect(list.name).toBe("Mower check");
    expect(list.job_type).toBeNull();
    expect(list.items.map((i) => i.key)).toEqual(["blades_sharp", "blades_sharp_deck_2", "oil_level"]);
    expect(list.items[2].options).toEqual(["Full"]);
  });

  it("says what's wrong", () => {
    expect(() => normalizeChecklist({ name: "A", items: [] })).toThrow("Add at least one item.");
    expect(() => normalizeChecklist({ name: "A", items: [{ label: " ", type: "check" }] })).toThrow("Every item needs a label.");
    expect(() => normalizeChecklist({ name: "A", items: Array.from({ length: 61 }, (_, i) => ({ label: `Item ${i}`, type: "check" })) })).toThrow("at most 60 items");
  });
});

describe("guides from Markdown", () => {
  it("makes the editor's HTML and plain text", () => {
    const { html, text } = markdownToGuide("# Fueling\n\nUse **non-ethanol** gas, see [the log](https://example.com/log?a=1&b=2).\n\n- Mower\n- Trimmer\n\n1. Shut off\n2. Fill\n\n> Never fuel a hot engine.\n\n---\n\n```\nfuel = 2 gal\n```");
    expect(html).toBe(
      '<h2>Fueling</h2><p>Use <strong>non-ethanol</strong> gas, see <a href="https://example.com/log?a=1&amp;b=2">the log</a>.</p>' +
        "<ul><li><p>Mower</p></li><li><p>Trimmer</p></li></ul><ol><li><p>Shut off</p></li><li><p>Fill</p></li></ol>" +
        "<blockquote><p>Never fuel a hot engine.</p></blockquote><hr><pre><code>fuel = 2 gal</code></pre>",
    );
    expect(text).toBe("Fueling\nUse non-ethanol gas, see the log.\nMower\nTrimmer\nShut off\nFill\nNever fuel a hot engine.\nfuel = 2 gal");
  });

  it("makes checklists and callouts like the editor's", () => {
    const { html, text } = markdownToGuide("- [ ] Cones out\n- [x] Blower fueled\n\n> [!WARNING]\n> Sealer is slippery when wet.\n\n> [!TIP] Start at the far end.");
    expect(html).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><div><p>Cones out</p></div></li><li data-type="taskItem" data-checked="true"><div><p>Blower fueled</p></div></li></ul>' +
        '<div data-callout="warning"><p>Sealer is slippery when wet.</p></div><div data-callout="tip"><p>Start at the far end.</p></div>',
    );
    expect(text).toBe("Cones out\nBlower fueled\nSealer is slippery when wet.\nStart at the far end.");
  });

  it("lets no markup through", () => {
    const { html } = markdownToGuide('<script>alert(1)</script> <img src=x onerror=alert(1)> [click](javascript:alert(1)) `<b>` *a* _b_');
    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; click) <code>&lt;b&gt;</code> <em>a</em> <em>b</em></p>");
  });
});

describe("importing clients", () => {
  const records = [
    { source_id: "J-1", name: "Ana Diaz", email: "ANA@example.com", status: "Active", properties: [{ line1: "12 Oak St", city: "Radford" }] },
    // The same client again: her second property.
    { source_id: "J-1", name: "Ana Diaz", properties: [{ line1: "40 Elm Ave", city: "Radford" }, { line1: "12 Oak St.", city: "Radford" }] },
    { name: "Bo Kent", status: "Former", billing_address: { line1: "9 Main St", city: "Christiansburg" } },
    { first_name: "Cy", last_name: "Lane", email: "cy@example.com", status: "inactive" },
    { name: "", email: "nobody@example.com" },
    { name: "Dee", status: "maybe" },
  ];

  it("groups rows into clients, reads statuses and skips what it can't use", () => {
    const { clients, skipped } = recordsToClients(records);
    expect(clients.map((c) => [c.display_name, c.status, c.properties.map((p) => p.line1)])).toEqual([
      ["Ana Diaz", "active", ["12 Oak St", "40 Elm Ave"]],
      ["Bo Kent", "archived", ["9 Main St"]],
      ["Cy Lane", "archived", []],
    ]);
    expect(clients[0].email).toBe("ana@example.com");
    expect(skipped.map((s) => s.row)).toEqual([4, 5]);
    expect(clientStatus("Prospect")).toBe("lead");
    expect(clientStatus("whatever")).toBeNull();
  });

  it("finds clients already here by old-system ID, then email, then name, and changes only what's new", () => {
    const { clients } = recordsToClients(records);
    const existing = [
      { id: "c-ana", display_name: "Ana D.", email: null, status: "lead", source_id: "J-1" },
      { id: "c-bo", display_name: "Bo  Kent", email: null, status: "archived", source_id: null },
    ];
    const plan = planImport(clients, existing, new Map([["c-ana", ["12 Oak Street"]]]));
    const [ana, bo, cy] = plan.decisions;
    expect(ana).toMatchObject({ action: "match", matched_by: "source_id", client_id: "c-ana", status_change: { from: "lead", to: "active" } });
    expect(ana.add_properties.map((p) => p.line1)).toEqual(["40 Elm Ave"]);
    expect(ana.kept_properties).toBe(1);
    expect(bo).toMatchObject({ action: "match", matched_by: "name", status_change: null });
    expect(cy).toMatchObject({ action: "create", status: "archived" });
    expect(plan.totals).toEqual({ clients: 3, create: 1, match: 2, status_changes: 1, properties: 2, kept_properties: 1 });
  });
});

describe("repeats", () => {
  it("builds a job's rule from every N weeks or months", () => {
    expect(buildSimpleRule({ freq: "WEEKLY", interval: 2, days: ["TU"], monthDay: 1 })).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU");
    expect(buildSimpleRule({ freq: "MONTHLY", interval: 1, days: [], monthDay: 15 })).toBe("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15");
    expect(ruleDay("2026-10-20")).toBe("TU");
    expect(ruleDay("2026-10-25")).toBe("SU");
  });
});

describe("figures", () => {
  it("ages unpaid invoices and sums money the way Finance does", () => {
    const open = [
      { balance_due: 100, due_on: "2026-10-25", client: { id: "a", display_name: "Ana" } },
      { balance_due: "50.5", due_on: "2026-10-01", client: { id: "a", display_name: "Ana" } },
      { balance_due: 20, due_on: "2026-06-01", client: { id: "b", display_name: "Bo" } },
    ];
    expect(agingBuckets(open, "2026-10-19").map((b) => [b.key, b.count, b.amount])).toEqual([["current", 1, 100], ["30", 1, 50.5], ["60", 0, 0], ["90", 0, 0], ["90+", 1, 20]]);
    const money = moneyFigures(
      { invoices: [{ total: 300, tax_amount: 15, issued_on: "2026-10-02" }], payments: [{ amount: 200, tip_amount: 10, fee_amount: 6.1, method: "card", received_at: "2026-10-03T12:00:00Z" }, { amount: 50, method: "check", received_at: "2026-10-04T12:00:00Z" }], open },
      "2026-10-19",
    );
    expect(money).toMatchObject({ invoiced: 300, collected: 250, tips: 10, card_fees: 6.1, sales_tax_billed: 15, outstanding_now: 170.5, past_due_now: 70.5, past_due_invoices: 2 });
    expect(money.by_method).toEqual([{ method: "card", amount: 200 }, { method: "check", amount: 50 }]);
    expect(money.client_balances[0]).toEqual({ client_id: "a", client: "Ana", invoices: 2, balance: 150.5, oldest_due: "2026-10-01" });
  });

  it("counts quotes won, lost and waiting by salesperson and lead source", () => {
    const sales = salesFigures(
      {
        quotes: [
          { status: "approved", total: 1000, sent_at: "2026-10-01T00:00:00Z", approved_at: "2026-10-03T00:00:00Z", salesperson_id: "u1", client: { lead_source: "Google" } },
          { status: "lost", total: 500, sent_at: "2026-10-02T00:00:00Z", lost_reason: "Price", salesperson_id: "u1", client: { lead_source: "Google" } },
          { status: "sent", total: 250, sent_at: "2026-10-05T00:00:00Z", created_by: "u2", client: null },
        ],
        clients: [{ lead_source: "Google" }, { lead_source: null }],
      },
      (id) => (id === "u1" ? "Sam" : "Pat"),
    );
    expect(sales).toMatchObject({ sent: 3, won: 1, won_value: 1000, lost: 1, awaiting_response: 1, conversion_percent: 33.3, average_days_to_approval: 2 });
    expect(sales.by_salesperson[0]).toEqual({ person: "Sam", sent: 2, won: 1, won_value: 1000, sent_value: 1500 });
    expect(sales.by_lead_source.find((s) => s.source === "Google")).toEqual({ source: "Google", new_clients: 1, quotes: 2, won: 1, won_value: 1000 });
    expect(sales.lost_reasons).toEqual([{ reason: "Price", count: 1 }]);
  });

  it("costs time not approved yet at the person's current rate, in job profit and team hours", () => {
    const time = [
      { id: "t1", job_id: "j1", user_id: "u1", started_at: "2026-10-05T12:00:00Z", ended_at: "2026-10-05T14:00:00Z", approved_at: "2026-10-06T00:00:00Z", category: "visit" },
      { id: "t2", job_id: "j1", user_id: "u1", started_at: "2026-10-06T12:00:00Z", ended_at: "2026-10-06T13:00:00Z", approved_at: null, category: "drive" },
    ];
    const rate = (e: CostedTime) => laborRate(e, { t1: 20 }, { u1: 25 });
    const profit = jobProfit([{ id: "j1", number: 7, title: "Seal", financials: { contract_total: 500 }, lines: [{ quantity: 2, unit_cost: 50 }] }], time, [{ job_id: "j1", amount: 35 }], rate, 60);
    expect(profit.jobs[0]).toMatchObject({ revenue: 500, labor: 65, expenses: 35, materials: 100, cost: 200, profit: 300, margin_percent: 60 });
    expect(profit.below_target).toEqual([]);
    const hours = teamHours(time, () => "Ana", rate, "short_paid");
    expect(hours).toMatchObject({ hours: 3, on_visits_hours: 2, awaiting_approval_hours: 1, labor_cost: 65 });
  });

  it("leaves unpaid breaks out of team hours and labor cost, as the company pays them", () => {
    const time = [
      { id: "t1", job_id: "j1", user_id: "u1", started_at: "2026-10-05T12:00:00Z", ended_at: "2026-10-05T16:00:00Z", approved_at: "x", category: "visit" },
      { id: "t2", job_id: null, user_id: "u1", started_at: "2026-10-05T16:00:00Z", ended_at: "2026-10-05T16:10:00Z", approved_at: "x", category: "break" },
      { id: "t3", job_id: null, user_id: "u1", started_at: "2026-10-05T17:00:00Z", ended_at: "2026-10-05T17:30:00Z", approved_at: "x", category: "break" },
    ];
    const lunch = teamHours(time, () => "Ana", () => 20, "short_paid");
    expect(lunch).toMatchObject({ unpaid_break_hours: 0.5, labor_cost: 83.33 });
    expect(lunch.hours).toBeCloseTo(4.17, 2);
    expect(lunch.by_category.find((c) => c.category === "break")?.hours).toBeCloseTo(0.67, 2);
    expect(teamHours(time, () => "Ana", () => 20, "paid")).toMatchObject({ hours: 4.67, unpaid_break_hours: 0 });
    expect(teamHours(time, () => "Ana", () => 20, "unpaid")).toMatchObject({ hours: 4, unpaid_break_hours: 0.67, labor_cost: 80 });
  });
});

describe("time and pay", () => {
  const tz = "America/New_York";
  it("checks a time entry before it's saved", () => {
    const now = new Date("2026-10-19T20:00:00Z");
    const span = entrySpan("2026-10-19", "08:00", "12:00", tz)!;
    expect(timeEntryProblem(span, [], now)).toBeNull();
    expect(timeEntryProblem(entrySpan("2026-10-20", "08:00", "12:00", tz)!, [], now)).toBe("You can't add time in the future.");
    expect(timeEntryProblem({ startAt: span.startAt, endAt: new Date(span.startAt.getTime() + 17 * 3_600_000) }, [], new Date("2026-10-21T00:00:00Z"))).toMatch(/between a minute and 16 hours/);
    expect(timeEntryProblem(span, [{ started_at: "2026-10-19T15:00:00Z", ended_at: "2026-10-19T17:00:00Z" }], now)).toMatch(/overlaps/);
    expect(timeEntryProblem(span, [{ started_at: "2026-10-19T16:00:00Z", ended_at: "2026-10-19T17:00:00Z" }], now)).toBeNull();
  });

  it("sums a pay period: approved hours at their rates, unpaid breaks apart, hours over 40 a week flagged", () => {
    const entries = [
      // Monday to Friday, 9 approved hours a day: 45 hours, 5 over 40.
      ...[19, 20, 21, 22, 23].map((d, i) => ({ id: `w${i}`, user_id: "u1", started_at: `2026-10-${d}T12:00:00Z`, ended_at: `2026-10-${d}T21:00:00Z`, category: "visit", approved_at: "x" })),
      { id: "b", user_id: "u1", started_at: "2026-10-19T21:00:00Z", ended_at: "2026-10-19T21:30:00Z", category: "break", approved_at: "x" },
      { id: "p", user_id: "u2", started_at: "2026-10-19T12:00:00Z", ended_at: "2026-10-19T14:00:00Z", category: "shop", approved_at: null },
      { id: "r", user_id: "u2", started_at: "2026-10-20T12:00:00Z", ended_at: null, category: "visit", approved_at: null },
    ];
    const pay = paySummary(entries, () => 20, (id) => (id === "u1" ? "Ana" : "Bo"), tz, "short_paid");
    expect(pay.people).toEqual([
      { user_id: "u1", name: "Ana", hours: 45, break_hours: 0.5, overtime_hours: 5, hourly_amount: 900, piece_amount: 0, amount: 900, unapproved_hours: 0, running: false },
      { user_id: "u2", name: "Bo", hours: 0, break_hours: 0, overtime_hours: 0, hourly_amount: 0, piece_amount: 0, amount: 0, unapproved_hours: 2, running: true },
    ]);
    expect(pay).toMatchObject({ hours: 45, amount: 900, piece_amount: 0, overtime_hours: 5, unapproved_hours: 2, running_clocks: 1, overtime_note: null });
  });

  it("pays breaks as the company pays them: short ones under the federal rule, all, or none", () => {
    const day = [
      { id: "w", user_id: "u1", started_at: "2026-10-19T12:00:00Z", ended_at: "2026-10-19T20:00:00Z", category: "visit", approved_at: "x" },
      { id: "rest", user_id: "u1", started_at: "2026-10-19T14:00:00Z", ended_at: "2026-10-19T14:15:00Z", category: "break", approved_at: "x" },
      { id: "lunch", user_id: "u1", started_at: "2026-10-19T16:00:00Z", ended_at: "2026-10-19T16:30:00Z", category: "break", approved_at: "x" },
    ];
    const ana = (breaks: "short_paid" | "paid" | "unpaid") => paySummary(day, () => 20, () => "Ana", tz, breaks).people[0];
    expect(ana("short_paid")).toMatchObject({ hours: 8.25, break_hours: 0.5, amount: 165 });
    expect(ana("paid")).toMatchObject({ hours: 8.75, break_hours: 0, amount: 175 });
    expect(ana("unpaid")).toMatchObject({ hours: 8, break_hours: 0.75, amount: 160 });
  });

  it("checks a payment against the balance", () => {
    expect(paymentProblem(50, 100)).toBeNull();
    expect(paymentProblem(100.004, 100)).toBeNull();
    expect(paymentProblem(0, 100)).toBe("Enter an amount greater than zero.");
    expect(paymentProblem(150, 100)).toBe("That's more than the $100.00 balance.");
  });
});
