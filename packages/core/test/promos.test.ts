import { describe, expect, it } from "vitest";
import { contractDiscountNote, givenBackWords, goneInvoiceWords, jobDiscountWords, promoCodeOf, promoRuleWords, quotePromoRule, removedPromoWords, repeatChoices, visitPrice, wordsText, type JobDiscount } from "../src/promos";

const discount = (changes: Partial<JobDiscount> = {}): JobDiscount => ({
  key: "q1", name: "Promo code WEEKLY25", billing: "once", amount: 25, placed: 0, left: 25, invoices: [], ...changes,
});
const said = (d: JobDiscount) => {
  const { rule, where } = jobDiscountWords(d);
  return [`${d.name} ${rule}`, where && wordsText(where)].filter(Boolean).join(" ");
};

describe("the promo code form's example", () => {
  it("says what each choice does with the code's own value", () => {
    expect(repeatChoices("amount", "25")).toEqual({
      once: "Comes off once per job. On weekly mowing, a $25 code takes $25 off the first mowing's invoice, and later mowings are full price.",
      everyVisit: "Comes off every visit's invoice. On weekly mowing, a $25 code takes $25 off every mowing.",
    });
    expect(repeatChoices("amount", 12.5).everyVisit).toContain("a $12.50 code takes $12.50 off every mowing");
    expect(repeatChoices("percent", "15").once).toContain("a 15% code takes 15% off the first mowing's invoice");
  });

  it("uses $25, or 10% for a percent code, until a value is typed", () => {
    expect(repeatChoices("amount", "").once).toContain("a $25 code takes $25 off");
    expect(repeatChoices("percent", "").everyVisit).toContain("a 10% code takes 10% off every mowing");
    expect(repeatChoices("percent", "150").everyVisit).toContain("a 10% code");
    expect(repeatChoices("amount", 1500).once).toContain("a $1,500 code");
  });
});

describe("a quote's promo code line", () => {
  it("says it comes off once, or every visit", () => {
    expect(promoRuleWords(false)).toBe("one-time discount");
    expect(promoRuleWords(true)).toBe("off every visit");
  });

  it("follows the code while the quote is open, and keeps the rule it was approved with", () => {
    expect(quotePromoRule({ status: "sent", promo: { every_visit: false } })).toBe(false);
    expect(quotePromoRule({ status: "draft", promo: { every_visit: true } })).toBe(true);
    // Signed: the code switched since, or its job switched on its page, doesn't change what it says.
    expect(quotePromoRule({ status: "approved", promo_every_visit: true, promo: { every_visit: false } })).toBe(true);
    expect(quotePromoRule({ status: "converted", promo_every_visit: false, promo: { every_visit: true } })).toBe(false);
  });

  it("says nothing on a quote approved before quotes said it, or with no code", () => {
    expect(quotePromoRule({ status: "converted", promo: { every_visit: false } })).toBeNull();
    expect(quotePromoRule({ status: "approved", promo: { every_visit: true } })).toBeNull();
    expect(quotePromoRule({ status: "sent", promo_every_visit: false, promo: null })).toBeNull();
    expect(quotePromoRule({ status: "sent", promo: {} })).toBeNull();
  });
});

describe("the toast when a promo line comes off a draft", () => {
  const onA = (amount: number, more: JobDiscount["invoices"] = []) => [discount({ placed: amount, left: 25 - amount, invoices: [{ id: "a", number: 11, amount }, ...(more ?? [])] })];

  it("names the invoice a once-per-job code moved to", () => {
    expect(removedPromoWords("q1", "a", onA(25), [discount({ placed: 25, left: 0, invoices: [{ id: "b", number: 12, amount: 25 }] })], true)).toBe("WEEKLY25 moved to invoice #12.");
    expect(removedPromoWords("q1", "a", onA(25), [discount({ placed: 25, left: 0, invoices: [{ id: "b", number: 12, amount: 15 }, { id: "c", number: 13, amount: 10 }] })], true)).toBe(
      "WEEKLY25 moved to invoices #12 and #13.",
    );
  });

  it("says it waits for the next invoice on work that repeats, and how to drop it", () => {
    expect(removedPromoWords("q1", "a", onA(25), [discount()], true)).toBe("WEEKLY25 goes on the job's next invoice. To drop it, remove it from the job's line items.");
    expect(removedPromoWords("q1", "a", [discount({ name: "Change order discount", placed: 10, left: 15, invoices: [{ id: "a", number: 11, amount: 10 }] })], [discount({ name: "Change order discount" })], true)).toBe(
      "The discount goes on the job's next invoice. To drop it, remove it from the job's line items.",
    );
  });

  it("says no more when nothing moves or waits", () => {
    // A one-off job's only final invoice: there's no next one.
    expect(removedPromoWords("q1", "a", onA(25), [discount()], false)).toBeNull();
    // A job from before codes were once per job, with the code on another invoice already.
    const both = [{ id: "a", number: 11, amount: 25 }, { id: "o", number: 9, amount: 25 }];
    expect(removedPromoWords("q1", "a", [discount({ placed: 50, left: 0, invoices: both })], [discount({ placed: 25, left: 0, invoices: [both[1]!] })], true)).toBeNull();
    // Without the Invoices area, or the job's discounts didn't load.
    expect(removedPromoWords("q1", "a", null, [discount({ placed: null, left: null, invoices: null })], true)).toBeNull();
    expect(removedPromoWords("q1", "a", null, null, true)).toBeNull();
    expect(removedPromoWords("other", "a", onA(25), [discount()], true)).toBeNull();
  });

  it("doesn't take an invoice that had it all along for one it moved to", () => {
    expect(removedPromoWords("q1", "a", null, [discount({ placed: 25, left: 0, invoices: [{ id: "o", number: 9, amount: 25 }] })], true)).toBeNull();
  });

  it("says an every-visit code is off this invoice only", () => {
    const every = [discount({ name: "Promo code EVERY5", billing: "every_visit", amount: 5, placed: 10, left: null, invoices: null })];
    expect(removedPromoWords("q1", "a", every, every, true)).toBe("EVERY5 is off this invoice only. Later visits still get it.");
    expect(removedPromoWords("q1", "a", every, every, false)).toBe("EVERY5 is off this invoice only.");
  });

  it("doesn't say an every-visit code is off a visits invoice that still has copies of it", () => {
    // Monthly invoice of weekly mowing: a copy for each of 4 visits, one taken off, 3 left.
    const every = [discount({ name: "Promo code WEEKLY25", billing: "every_visit", amount: 25, placed: 100, left: null, invoices: null })];
    const copy = { discount_quote_id: "q1", quantity: 1, unit_price: -25 };
    const mowing = { discount_quote_id: null, quantity: 1, unit_price: 45 };
    expect(removedPromoWords("q1", "a", every, every, true, [mowing, copy, mowing, copy, mowing, copy, mowing])).toBeNull();
    // A code's taxed and untaxed parts: the other part still comes off.
    expect(removedPromoWords("q1", "a", every, every, true, [mowing, { discount_quote_id: "q1", quantity: "1", unit_price: "-5.00" }])).toBeNull();
    // Copies cut back to $0 take nothing off; another code's lines aren't this one's.
    expect(removedPromoWords("q1", "a", every, every, true, [mowing, { ...copy, unit_price: 0 }, { ...copy, discount_quote_id: "q2" }])).toBe(
      "WEEKLY25 is off this invoice only. Later visits still get it.",
    );
    expect(removedPromoWords("q1", "a", every, every, true, [mowing])).toBe("WEEKLY25 is off this invoice only. Later visits still get it.");
  });
});

describe("voiding or deleting an invoice with the job's code", () => {
  const held = [discount({ placed: 25, left: 0, invoices: [{ id: "a", number: 11, amount: 25 }] })];

  it("says before that the code goes on the next invoice", () => {
    expect(givenBackWords("a", held)).toBe("The WEEKLY25 discount goes on the job's next invoice.");
    expect(givenBackWords("a", [discount({ name: "Discount", placed: 25, left: 0, invoices: [{ id: "a", number: 11, amount: 25 }] })])).toBe("Its one-time discount goes on the job's next invoice.");
    expect(givenBackWords("b", held)).toBeNull();
    // Other invoices hold all of it already (from before codes were once per job): nothing moves.
    expect(givenBackWords("a", [discount({ placed: 50, left: 0, invoices: [{ id: "a", number: 11, amount: 25 }, { id: "o", number: 9, amount: 25 }] })])).toBeNull();
    expect(givenBackWords("a", [discount({ billing: "every_visit", placed: null, left: null, invoices: null })])).toBeNull();
    expect(givenBackWords("a", null)).toBeNull();
  });

  it("says after where it went, or that it waits", () => {
    expect(goneInvoiceWords("a", held, [discount({ placed: 25, left: 0, invoices: [{ id: "b", number: 12, amount: 25 }] })])).toBe("WEEKLY25 moved to invoice #12.");
    expect(goneInvoiceWords("a", held, [discount()])).toBe("WEEKLY25 goes on the job's next invoice.");
    expect(goneInvoiceWords("a", held, null)).toBeNull();
    expect(goneInvoiceWords("b", held, [discount()])).toBeNull();
  });
});

describe("the job page's note", () => {
  it("says where a once-per-job code went", () => {
    expect(said(discount({ placed: 25, left: 0, invoices: [{ id: "i12", number: 12, amount: 25 }] }))).toBe("Promo code WEEKLY25 comes off the first invoice only. It's on invoice #12.");
    expect(said(discount({ placed: 15, left: 10, invoices: [{ id: "i12", number: 12, amount: 15 }] }))).toBe(
      "Promo code WEEKLY25 comes off the first invoice only. $15.00 is on invoice #12, and $10.00 goes on the next invoice.",
    );
    expect(said(discount({ placed: 25, left: 0, invoices: [{ id: "i12", number: 12, amount: 15 }, { id: "i13", number: 13, amount: 10 }] }))).toBe(
      "Promo code WEEKLY25 comes off the first invoice only. $15.00 is on invoice #12 and $10.00 on invoice #13.",
    );
    expect(said(discount({ placed: 20, left: 5, invoices: [{ id: "i12", number: 12, amount: 15 }, { id: "i13", number: 13, amount: 5 }] }))).toBe(
      "Promo code WEEKLY25 comes off the first invoice only. $15.00 is on invoice #12, $5.00 on invoice #13, and $5.00 goes on the next invoice.",
    );
    expect(said(discount())).toBe("Promo code WEEKLY25 comes off the first invoice only. It goes on the next invoice you make.");
  });

  it("names every invoice a code went on while it came off every visit, and says so", () => {
    const invoices = [3, 4, 5].map((n) => ({ id: `i${n}`, number: n, amount: 25 }));
    expect(said(discount({ placed: 75, left: 0, invoices }))).toBe(
      "Promo code WEEKLY25 comes off the first invoice only. It's on invoices #3, #4 and #5, made while it came off every visit. Later invoices don't take it.",
    );
    expect(said(discount({ placed: 45, left: 0, invoices: [{ id: "i3", number: 3, amount: 25 }, { id: "i4", number: 4, amount: 20 }] }))).toBe(
      "Promo code WEEKLY25 comes off the first invoice only. $25.00 is on invoice #3 and $20.00 on invoice #4, made while it came off every visit. Later invoices don't take it.",
    );
    const { where } = jobDiscountWords(discount({ placed: 75, left: 0, invoices }));
    expect(where!.filter((w) => typeof w !== "string")).toEqual(invoices.map((i) => ({ invoice: { id: i.id, number: i.number } })));
  });

  it("says only the rule to someone without the Invoices area, and for every visit", () => {
    expect(said(discount({ placed: null, left: null, invoices: null }))).toBe("Promo code WEEKLY25 comes off the first invoice only.");
    expect(said(discount({ billing: "every_visit", placed: 50, left: null, invoices: null }))).toBe("Promo code WEEKLY25 comes off every visit.");
  });

  it("explains a recurring job's Contract", () => {
    expect(contractDiscountNote([{ name: "Mowing" }, { name: "Promo code WEEKLY25", discount_billing: "once" }])).toBe("Includes the one-time WEEKLY25 discount");
    expect(contractDiscountNote([{ name: "Change order discount", discount_billing: "once" }])).toBe("Includes a one-time discount");
    expect(contractDiscountNote([{ name: "Promo code A", discount_billing: "once" }, { name: "Promo code B", discount_billing: "once" }])).toBe("Includes one-time discounts");
    expect(contractDiscountNote([{ name: "Promo code EVERY5", discount_billing: "every_visit" }, { name: "Discount" }])).toBeNull();
    expect(promoCodeOf("Promo code WEEKLY25")).toBe("WEEKLY25");
    expect(promoCodeOf("Discount")).toBeNull();
  });
});

describe("a recurring job's price for a visit", () => {
  const mowing = { quantity: 1, unit_price: 45, discount_billing: null };

  it("puts back a once-per-job code, which comes off the first invoice only", () => {
    // Weekly mowing at $45 with WEEKLY25: the first mowing's invoice is $20, every one after $45.
    expect(visitPrice(20, [mowing, { quantity: 1, unit_price: -25, discount_billing: "once" }])).toBe(45);
    // A code worth the visit: the Contract is $0, but every visit after the first is $40.
    expect(visitPrice("0.00", [{ ...mowing, unit_price: "40.00" }, { quantity: "1", unit_price: "-40.00", discount_billing: "once" }])).toBe(40);
    // Its taxed and untaxed parts, and a change order's code, all put back.
    expect(visitPrice(10, [mowing, { quantity: 1, unit_price: -15, discount_billing: "once" }, { quantity: 1, unit_price: -10, discount_billing: "once" }, { quantity: 1, unit_price: -10, discount_billing: "once" }])).toBe(45);
  });

  it("leaves off a code that comes off every visit, and a typed discount", () => {
    expect(visitPrice(40, [mowing, { quantity: 1, unit_price: -5, discount_billing: "every_visit" }])).toBe(40);
    expect(visitPrice(35, [mowing, { quantity: 1, unit_price: -10, discount_billing: null }])).toBe(35);
    expect(visitPrice(45, [mowing])).toBe(45);
    expect(visitPrice(null, [])).toBe(0);
  });

  it("rounds each line as the database does", () => {
    // 1.5 × -$10.01 is -$15.015, which the database rounds to -$15.02 (half away from zero).
    expect(visitPrice(15.01, [{ quantity: 1, unit_price: 30.03 }, { quantity: 1.5, unit_price: -10.01, discount_billing: "once" }])).toBe(30.03);
  });
});
