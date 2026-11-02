import { DEFAULT_TEMPLATE } from "@crewtavo/core/documents";
import { describe, expect, it } from "vitest";
import {
  autopayPayNote,
  depositToBook,
  firstOption,
  groupTiers,
  hubChoice,
  hubLetterhead,
  hubSteps,
  hubTemplate,
  hubTotals,
  invoiceAutopayLine,
  invoiceDocument,
  isRoofJob,
  keepPicks,
  listedLines,
  maybePrice,
  needsNewCard,
  optionLinesOf,
  pickedOption,
  promoShortfall,
  quoteDocument,
  rangeWords,
  reviewChange,
  unpickedGroup,
  waitingInvoices,
  type HubOption,
  type InvoiceView,
  type QuoteView,
} from "../src/features/hub/document";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const company: QuoteView["company"] = {
  name: "Summit Roofing", phone: "555-0100", email: "office@summit.example", website: "summit.example", timezone: "America/Chicago",
  branding: { color: "#1f4e79" }, logo: "/api/public/logo/c/l.png", address: ["200 Main St", "Springfield, IL 62704"],
};

function quoteView(quote: Partial<QuoteView["quote"]> = {}): QuoteView {
  return {
    kind: "quote", home: null, company, template: { header: "banner", license: "RC-104882" },
    drawings: [{ id: "d1", title: "Roof", has_picture: true, sections: [], total_area_sqft: 2000, total_length_ft: 0, roofing_squares: 22.4, roof_pitch: "6/12", imagery: null }],
    quote: {
      id: "q1", number: 1042, status: "sent", title: "New roof", message: "Thanks for having us out.", subtotal: 1400, discount_amount: 0, promo: null, tax_rate: 0.05,
      tax_amount: 70, total: 1470, deposit_amount: 0, valid_until: "2026-11-21", sent_at: "2026-10-22T15:00:00Z", approved_at: null,
      client: { display_name: "Dana Whitfield" }, property: { line1: "1482 Ridgeview Dr", city: "Springfield", region: "IL", postal_code: "62704" },
      package: { name: "Architectural shingle" }, approval: null, range: null,
      lines: [
        { id: "l1", name: "Roof", description: null, quantity: 2, unit: "square", unit_price: 500, optional: false, selected: true },
        { id: "l2", name: "Pipe boot", description: "Around the vent pipes", quantity: 3, unit: "ea", unit_price: 45, optional: false, selected: true },
        { id: "l3", name: "Ridge vent", description: null, quantity: 1, unit: "ea", unit_price: 265, optional: false, selected: true },
        { id: "l4", name: "Gutter guards", description: null, quantity: 100, unit: "ft", unit_price: 7, optional: true, selected: false },
      ],
      ...quote,
    },
  };
}

describe("the Client Hub's documents", () => {
  it("prints a quote as saved: its lines, amounts and client", () => {
    const doc = quoteDocument(quoteView());
    // Nothing under the address: not the project's name, its package or the roof's size.
    expect(doc.title).toBeUndefined();
    expect(doc).toMatchObject({
      kind: "estimate", number: 1042, date: "2026-10-22", validUntil: "2026-11-21",
      facts: [],
      client: { name: "Dana Whitfield", lines: ["1482 Ridgeview Dr", "Springfield, IL 62704"] },
      subtotal: 1400, discount: 0, tax: 70, total: 1470, deposit: null, notes: "Thanks for having us out.",
      signatures: { customer: null, company: null },
    });
    expect(doc.lines.map((l) => [l.name, l.total])).toEqual([["Roof", 1000], ["Pipe boot", 135], ["Ridge vent", 265]]);
    expect(doc.lines[1]!.description).toBe("Around the vent pipes");
  });

  it("dates an estimate signed without being sent by the day it was made, as its {Date} says, every day it's opened", () => {
    // Made in the evening of Oct 24 in Chicago (Oct 25 in UTC), signed on the iPad, never sent.
    const signed = quoteView({ sent_at: null, created_at: "2026-10-25T02:30:00Z", status: "approved" });
    expect(quoteDocument(signed).date).toBe("2026-10-24");
    // From a server that doesn't send the day it was made: an open quote's facts say it.
    const open = quoteView({ sent_at: null });
    open.contract = { kind: "live", terms: "", library: [], template_sections: [], quote_sections: [], facts: { customerName: "Dana Whitfield", customerAddress: [], jobAddress: [], businessName: "Summit Roofing", businessPhone: null, license: "", estimateNumber: 1042, date: "2026-10-20T15:00:00Z", timeZone: "America/Chicago", deposit: 0 } };
    expect(quoteDocument(open).date).toBe("2026-10-20");
  });

  it("follows the options the client ticks, worked out to the cent", () => {
    const doc = quoteDocument(quoteView({ promo: { code: "SPRING", kind: "percent", value: 10, description: null } }), { picked: ["l4"] });
    expect(doc.lines.map((l) => l.name)).toContain("Gutter guards");
    expect(doc.subtotal).toBe(2100);
    expect(doc.discount).toBe(210);
    expect(doc.tax).toBe(94.5);
    expect(doc.total).toBe(1984.5);
    expect(doc.discountLabel).toBe("Promo code SPRING");
  });

  it("puts both signatures on a signed quote, and none on the client's line when the office approved it", () => {
    const signed = quoteDocument(quoteView({
      status: "approved", deposit_amount: 500,
      approval: { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", method: "in_person", company: { name: "Mike Torres", signature: PNG, signed_at: "2026-10-25T18:01:00Z" } },
    }));
    expect(signed.signatures).toEqual({
      customer: { name: "Dana Whitfield", image: PNG, date: "2026-10-25T18:00:00Z" },
      company: { name: "Mike Torres", image: PNG, date: "2026-10-25T18:01:00Z" },
    });
    expect(signed.deposit).toBe(500);
    const manual = quoteDocument(quoteView({ status: "approved", approved_at: "2026-10-25T18:00:00Z", approval: { name: "Sarah in the office", signature: null, signed_at: null, method: "manual", company: null } }));
    expect(manual.signatures).toEqual({ customer: null, company: null });
  });

  it("prints an invoice with what's been paid, refunded and held back", () => {
    const view: InvoiceView = {
      kind: "invoice", home: null, company, can_pay: true, tips: false,
      invoice: {
        id: "i1", number: 77, status: "partially_paid", subject: "Roof replacement", notes: null, issued_on: "2026-10-01", due_on: "2026-10-31",
        subtotal: 1000, discount_amount: 0, tax_amount: 0, total: 1000, retainage_amount: 100, amount_paid: 450, balance_due: 450, promo: null,
        client: { display_name: "Dana Whitfield" },
        lines: [{ name: "Roof", description: null, quantity: 1, unit: "ea", unit_price: 1000 }],
        payments: [{ amount: 500, tip_amount: 0, received_at: "2026-10-05T16:00:00Z" }, { amount: -50, tip_amount: 0, received_at: "2026-10-06T16:00:00Z" }],
      },
    };
    expect(invoiceDocument(view)).toMatchObject({
      kind: "invoice", number: 77, date: "2026-10-01", dueOn: "2026-10-31", title: "Roof replacement", total: 1000, balanceDue: 450,
      payments: [{ label: "Retainage (billed later)", amount: 100 }, { label: "Paid Oct 5, 2026", amount: 500 }, { label: "Refunded Oct 6, 2026", amount: -50 }],
    });
  });

  it("uses the business's letterhead and template, with the defaults for anything missing", () => {
    expect(hubLetterhead(company)).toEqual({
      name: "Summit Roofing", phone: "555-0100", email: "office@summit.example", website: "summit.example",
      address: ["200 Main St", "Springfield, IL 62704"], logo: "/api/public/logo/c/l.png", settings: { branding: { color: "#1f4e79" } },
    });
    expect(hubLetterhead({ ...company, address: undefined, logo: undefined }).address).toEqual([]);
    expect(hubTemplate({ template: { header: "banner" } })).toEqual({ ...DEFAULT_TEMPLATE, header: "banner" });
    expect(hubTemplate({})).toEqual(DEFAULT_TEMPLATE);
  });

  it("draws a signed quote on the template its link sends, the one it was signed on", () => {
    const view = quoteView({ status: "approved", approval: { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", method: "in_person", company: null } });
    view.template = { ...DEFAULT_TEMPLATE, terms: "The terms Dana signed", company_signs: false };
    expect(hubTemplate(view)).toEqual({ ...DEFAULT_TEMPLATE, terms: "The terms Dana signed", company_signs: false });
  });
});

describe("an open quote that offers options", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "aaaaaaaa-0000-4000-8000-000000000002";
  const option = (id: string, name: string, tier: string, total: number | null, sort: number): HubOption => ({
    id, name, tier, picture: null, style: "shingle", highlights: [], warranty: "", section_ids: [], sort, total, range: null,
  });
  // As the database keeps them with A shown.
  const offering = () =>
    quoteView({
      option_id: A,
      package: { name: "Architectural shingle" },
      options: [option(A, "Architectural shingle", "Good", 11203.5, 0), option(B, "Designer shingle", "Better", 13975.5, 1)],
      subtotal: 10920, tax_amount: 546, total: 11466,
      lines: [
        { id: "s1", option_id: null, name: "Tear-off and disposal", description: null, quantity: 22, unit: "square", unit_price: 85, optional: false, selected: true },
        { id: "s2", option_id: null, name: "Gutter guards", description: null, quantity: 100, unit: "ft", unit_price: 7, optional: true, selected: false },
        { id: "a1", option_id: A, name: "Architectural shingle roof", description: null, quantity: 22, unit: "square", unit_price: 400, optional: false, selected: true },
        { id: "a2", option_id: A, name: "Ridge vent upgrade", description: null, quantity: 1, unit: "ea", unit_price: 250, optional: true, selected: true },
        { id: "b1", option_id: B, name: "Designer shingle roof", description: null, quantity: 22, unit: "square", unit_price: 520, optional: false, selected: false },
        { id: "b2", option_id: B, name: "Skylight flashing", description: null, quantity: 1, unit: "ea", unit_price: 300, optional: true, selected: false, option_group: null },
      ],
    });

  it("goes choose, review, sign: each step only when there's something to do in it", () => {
    const terms = { terms: "Pay on completion.", sections: [], hash: null };
    const none = { terms: " ", sections: [], hash: null };
    expect(hubSteps(2, terms)).toEqual(["choose", "review", "sign"]);
    expect(hubSteps(3, none)).toEqual(["choose", "sign"]);
    expect(hubSteps(0, terms)).toEqual(["review", "sign"]);
    expect(hubSteps(0, null)).toEqual(["sign"]);
  });

  it("starts on the option the business shows first, while it has a price", () => {
    expect(firstOption(offering())).toBe(A);
    const unpriced = offering();
    unpriced.quote.options![0]!.total = null;
    expect(firstOption(unpriced)).toBeNull();
    expect(firstOption(quoteView())).toBeNull();
  });

  it("stays on the option picked while the quote still offers it with a price", () => {
    expect(pickedOption(offering(), B)).toBe(B);
    // Loaded again after the office took it off, or before it has a price: the one it opens with.
    expect(pickedOption(offering(), "aaaaaaaa-0000-4000-8000-00000000dead")).toBe(A);
    const unpriced = offering();
    unpriced.quote.options![1]!.total = null;
    expect(pickedOption(unpriced, B)).toBe(A);
    expect(pickedOption(quoteView(), null)).toBeNull();
  });

  it("sends them back to look it over when the terms or the price changed after they went on to sign", () => {
    const reviewed = { total: 14275.5, hash: "00000000000000aa" };
    expect(reviewChange(reviewed, { ...reviewed })).toBeNull();
    expect(reviewChange(reviewed, { total: 14275.5, hash: "00000000000000bb" })).toBe("The terms changed. Please look them over again.");
    expect(reviewChange(reviewed, { total: 14000, hash: reviewed.hash })).toBe("The price changed. Please look it over again.");
    expect(reviewChange(reviewed, { total: 14000, hash: null })).toBe("The terms changed. Please look them over again.");
    // Not signing yet: nothing to compare with.
    expect(reviewChange(null, reviewed)).toBeNull();
  });

  it("lists the shared lines and the option's own, and drops another option's add-ons when the pick changes", () => {
    const v = offering();
    expect(optionLinesOf(v.quote.lines, B).map((l) => l.id)).toEqual(["s1", "s2", "b1", "b2"]);
    expect(keepPicks(v.quote.lines, ["s2", "a2", "b2", "s1"], B)).toEqual(["s2", "b2"]);
    // With options, a line group doesn't say Good, Better or Best: the options do.
    expect(groupTiers(v).size).toBe(0);
  });

  it("knows a group of add-ons still waiting for its one pick", () => {
    const lines = [
      { id: "g1", name: "Tan", description: null, quantity: 1, unit: "ea", unit_price: 0, optional: true, option_group: "Shingle color" },
      { id: "g2", name: "Gray", description: null, quantity: 1, unit: "ea", unit_price: 0, optional: true, option_group: "Shingle color" },
      { id: "x", name: "Gutter guards", description: null, quantity: 1, unit: "ea", unit_price: 100, optional: true },
    ];
    expect(unpickedGroup(lines, ["x"])).toBe("Shingle color");
    expect(unpickedGroup(lines, ["g2"])).toBeNull();
    expect(unpickedGroup(lines.slice(2), [])).toBeNull();
  });

  it("prices an estimate saved before options as it was: a group's lines are add-ons that keep their pick", () => {
    // What the migration made of lines saved the old way (20261025000100_contracts_and_options.sql):
    // every line of a "pick one" group is an add-on, and the one picked stays picked.
    const v = quoteView({
      subtotal: 6000, tax_rate: 0, tax_amount: 0, total: 6000, package: null,
      lines: [
        { id: "r", name: "Tear-off", description: null, quantity: 1, unit: "ea", unit_price: 1000, optional: false, selected: true },
        { id: "g", name: "Architectural shingle", description: null, quantity: 1, unit: "ea", unit_price: 5000, optional: true, selected: true, option_group: "Roof" },
        { id: "m", name: "Standing-seam metal", description: null, quantity: 1, unit: "ea", unit_price: 9000, optional: true, selected: false, option_group: "Roof" },
      ],
    });
    const saved = v.quote.lines.filter((l) => l.optional && l.selected).map((l) => l.id!);
    expect(hubTotals(v, null, saved).total).toBe(6000);
    expect(unpickedGroup(v.quote.lines, saved)).toBeNull();
  });

  it("lists a price set below the estimate on an option as one line, though it's booked as two", () => {
    const adjustment = (id: string, unit_price: number) => ({ id, option_id: A, name: "Price adjustment", description: null, quantity: 1, unit: "ea", unit_price, optional: false, selected: true });
    const lines = [...optionLinesOf(offering().quote.lines, A), adjustment("x1", -952.38), adjustment("x2", -47.62)];
    const listed = listedLines(lines);
    expect(listed).toHaveLength(lines.length - 1);
    expect(listed.at(-1)).toMatchObject({ id: "x1", name: "Price adjustment", unit_price: -1000 });
  });

  it("warns while what's chosen comes to less than the promo code's minimum order, as approving checks it", () => {
    const v = offering();
    const lines = optionLinesOf(v.quote.lines, B);
    const charges = lines.filter((l) => !l.optional).reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
    const promo = { code: "SPRING", kind: "amount", value: 500, description: null, min_subtotal: String(charges + 1) };
    expect(promoShortfall(promo, lines, [])).toBe(charges + 1);
    // An add-on ticked counts toward it; one that isn't on these lines doesn't.
    const addOn = lines.find((l) => l.optional)!;
    expect(promoShortfall(promo, lines, [addOn.id!])).toBeNull();
    expect(promoShortfall(promo, lines, ["a2"])).toBe(charges + 1);
    // No minimum, or no code: nothing to warn about.
    expect(promoShortfall({ ...promo, min_subtotal: 0 }, lines, [])).toBeNull();
    expect(promoShortfall({ ...promo, min_subtotal: undefined }, lines, [])).toBeNull();
    expect(promoShortfall(null, lines, [])).toBeNull();
  });

  it("never asks for a deposit above what they're choosing", () => {
    expect(depositToBook(1000, 14290.5)).toBe(1000);
    expect(depositToBook("5000.00", 4200)).toBe(4200);
    expect(depositToBook(null, 4200)).toBe(0);
  });

  it("compares the options while choosing, then prints the copy being signed for the one picked", () => {
    const v = offering();
    const choosing = quoteDocument(v, { optionId: B, picked: ["b2"] });
    expect(choosing.options?.map((o) => [o.name, o.tier, o.total, o.chosen])).toEqual([["Architectural shingle", "Good", 11203.5, false], ["Designer shingle", "Better", 13975.5, true]]);
    expect(choosing.lines.map((l) => l.name)).toEqual(["Tear-off and disposal", "Designer shingle roof", "Skylight flashing"]);
    expect(choosing.facts).toEqual([]);
    expect(choosing.total).toBe(14290.5);
    const signing = quoteDocument(v, { optionId: B, picked: ["b2"], signing: true, contract: { terms: "", sections: [{ id: "k1", title: "Cancel", html: "<p>x</p>", place: "signatures", initials: true }], hash: "0" } });
    expect(signing.options).toBeUndefined();
    expect(signing.facts).toEqual(["Your choice: Better · Designer shingle"]);
    expect(signing.contract?.sections.map((s) => s.id)).toEqual(["k1"]);
    expect(hubChoice(v, B)).toEqual({ name: "Designer shingle", tier: "Better" });
    expect(hubChoice(v, null)).toBeNull();
  });

  it("prints a signed quote's chosen option, without the comparison", () => {
    const v = offering();
    v.quote.status = "approved";
    v.quote.option_id = B;
    v.quote.options = [{ ...option(B, "Designer shingle", "Better", 14290.5, 0) }];
    v.quote.lines = v.quote.lines.filter((l) => l.option_id !== A).map((l) => (l.option_id === B && !l.optional ? { ...l, selected: true } : l));
    const doc = quoteDocument(v);
    expect(doc.options).toBeUndefined();
    expect(doc.facts).toEqual(["Your choice: Better · Designer shingle"]);
    expect(doc.lines.map((l) => l.name)).toEqual(["Tear-off and disposal", "Designer shingle roof"]);
  });

  it("prints an invoice with the contract the server filled in, which nobody initials", () => {
    const view: InvoiceView = {
      kind: "invoice", home: null, company, can_pay: false, tips: false,
      contract: { terms: "Thanks, Dana.", sections: [{ id: "k9", title: "Late payments", body: "<p>Due on receipt.</p>", place: "signatures", initials: true }] },
      invoice: {
        id: "i1", number: 77, status: "sent", subject: null, notes: null, issued_on: "2026-10-01", due_on: null, subtotal: 100, discount_amount: 0, tax_amount: 0, total: 100,
        retainage_amount: 0, amount_paid: 0, balance_due: 100, promo: null, client: { display_name: "Dana" }, lines: [{ name: "Roof", description: null, quantity: 1, unit: "ea", unit_price: 100 }], payments: [],
      },
    };
    expect(invoiceDocument(view).contract).toEqual({ sections: [{ id: "k9", title: "Late payments", html: "<p>Due on receipt.</p>", place: "signatures", initials: false }] });
    expect(invoiceDocument({ ...view, contract: null }).contract).toBeUndefined();
  });
});

describe("the price range page", () => {
  it("talks about a roof only when the estimate is for one, and about the option they pick when it offers several", () => {
    expect(isRoofJob(quoteView())).toBe(true);
    expect(isRoofJob(quoteView({ package: { name: "Driveway sealcoat" } }))).toBe(true); // the roof was measured
    expect(isRoofJob({ ...quoteView({ package: { name: "Driveway sealcoat" } }), drawings: [] })).toBe(false);
    expect(isRoofJob({ ...quoteView({ package: { name: "Designer shingle" } }), drawings: [] })).toBe(true);

    const roof = rangeWords({ roof: true, options: 0, first: "Dana" });
    expect(roof).toMatchObject({ kind: "Roof estimate", heading: "Your new roof, Dana", maybe: "If we find something on the roof" });
    expect(roof.why).toBe("The exact price is set when we look at your roof in person. It only moves toward the top if we find something hidden, like soft wood under the shingles.");
    const job = rangeWords({ roof: false, options: 3, first: null });
    expect(job).toMatchObject({ kind: "Estimate", heading: "Your estimate", thanks: "We'll set up a time to come out, usually within one business day." });
    expect(job.why).toMatch(/^The exact price of the option you pick is set when we see the job in person\./);
    expect(job.next).toContain("which option you're leaning toward");
    expect(`${roof.why} ${roof.next} ${roof.thanks}`).not.toMatch(/option/);
  });

  it("says what could change the price in plain words", () => {
    expect(maybePrice({ price: 95, per: "sheet" })).toBe("$95 a sheet");
    expect(maybePrice({ price: 85, per: "square" })).toBe("$85 a square");
    expect(maybePrice({ price: 650, per: null })).toBe("$650");
    expect(maybePrice({ price: 3.5, per: "ft" })).toBe("$3.50 a foot");
    expect(maybePrice({ price: 120, per: "hr" })).toBe("$120 an hour");
    expect(maybePrice({ price: 40, per: "ea" })).toBe("$40");
  });
});

describe("autopay on the Client Hub's invoices", () => {
  const visa = (status: "charging" | "processing" | "paid" | "failed" | "needs_client", charged_at: string | null = null) => ({ status, method: "Visa ending 4242", charged_at });

  it("says under an invoice's heading that it was paid automatically, or is being charged", () => {
    // 9:30 PM in New York on Oct 27 is the 28th in UTC: the day is the business's.
    expect(invoiceAutopayLine(visa("paid", "2026-10-28T01:30:00Z"), "America/New_York", 0)).toBe("Paid automatically with Visa ending 4242 on Oct 27");
    expect(invoiceAutopayLine(visa("paid", "2026-10-28T01:30:00Z"), "UTC", 0)).toBe("Paid automatically with Visa ending 4242 on Oct 28");
    expect(invoiceAutopayLine({ status: "paid", method: null, charged_at: null }, "UTC", 0)).toBe("Paid automatically");
    expect(invoiceAutopayLine(visa("charging"), "UTC", 0)).toBe("Charging your Visa ending 4242 now");
    expect(invoiceAutopayLine({ status: "charging", method: null, charged_at: null }, "UTC", 0)).toBe("Charging your saved card now");
    expect(invoiceAutopayLine(visa("processing"), "UTC", 0)).toMatch(/^Your bank payment is on its way/);
    // A charge that didn't go through is said beside Pay instead.
    for (const status of ["failed", "needs_client"] as const) expect(invoiceAutopayLine(visa(status), "UTC", 0)).toBeNull();
    expect(invoiceAutopayLine(null, "UTC", 0)).toBeNull();
    expect(invoiceAutopayLine(undefined, "UTC", 0)).toBeNull();
  });

  it("says it was paid automatically only while nothing is owed", () => {
    // Refunded since: owed again, or written off with what's left. The charge stays paid.
    expect(invoiceAutopayLine(visa("paid", "2026-10-28T01:30:00Z"), "UTC", 45)).toBeNull();
    expect(invoiceAutopayLine(visa("paid", "2026-10-28T01:30:00Z"), "UTC", "45.00" as unknown as number)).toBeNull();
    expect(invoiceAutopayLine(visa("paid", "2026-10-28T01:30:00Z"), "UTC", -5)).toBe("Paid automatically with Visa ending 4242 on Oct 28");
    // Being charged, or on its way, is said whatever is owed.
    expect(invoiceAutopayLine(visa("charging"), "UTC", 45)).toBe("Charging your Visa ending 4242 now");
  });

  it("says beside Pay why it's there when the charge didn't go through", () => {
    expect(autopayPayNote(visa("failed"))).toBe("We couldn't charge your Visa ending 4242. We'll try again in a few days, or you can pay now.");
    expect(autopayPayNote(visa("needs_client"))).toBe("We couldn't charge your Visa ending 4242 automatically. Pay below, or update your card.");
    for (const status of ["charging", "processing", "paid"] as const) expect(autopayPayNote(visa(status))).toBeNull();
    expect(autopayPayNote(null)).toBeNull();
  });

  it("leaves what autopay is charging out of what's waiting on the client", () => {
    const invoices = [
      { id: "owed", status: "sent", balance_due: 45 },
      { id: "late", status: "overdue", balance_due: 45, autopay: null },
      { id: "charging", status: "sent", balance_due: 45, autopay: "charging" as const },
      { id: "bank", status: "sent", balance_due: 45, autopay: "processing" as const },
      { id: "failed", status: "sent", balance_due: 45, autopay: "failed" as const },
      { id: "confirm", status: "partially_paid", balance_due: 20, autopay: "needs_client" as const },
      { id: "paid", status: "paid", balance_due: 0, autopay: "paid" as const },
      // A numeric as Postgres writes it.
      { id: "text", status: "sent", balance_due: "0.00" as unknown as number },
    ];
    expect(waitingInvoices(invoices).map((i) => i.id)).toEqual(["owed", "late", "failed", "confirm"]);
    expect(invoices.filter(needsNewCard).map((i) => i.id)).toEqual(["failed", "confirm"]);
  });
});
