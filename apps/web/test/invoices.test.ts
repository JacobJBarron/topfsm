import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { refundable } from "../src/features/invoices/refunds";
import { settle } from "../src/features/invoices/settle";
import { creditRoom, creditsChangeable, takesCredit } from "../src/features/invoices/creditRules";
import { bankPayment, bankPaymentNote, paidInStripe, paymentAmount, RECORD_IN_STRIPE } from "../src/features/invoices/stripeInvoices";

describe("refunds", () => {
  const check = { amount: 100, method: "check", processor: null };

  it("counts earlier refunds against the payment", () => {
    expect(refundable(check, [check])).toBe(100);
    expect(refundable(check, [check, { amount: -40, method: "check" }])).toBe(60);
    // A $100 payment refunded once can't be refunded again.
    expect(refundable(check, [check, { amount: -100, method: "check" }])).toBe(0);
  });

  it("keeps each way of paying separate, and never refunds more than was paid", () => {
    const cash = { amount: 50, method: "cash", processor: null };
    expect(refundable(cash, [check, cash, { amount: -100, method: "check" }])).toBe(50);
    expect(refundable(check, [check, cash, { amount: -100, method: "check" }])).toBe(0);
    expect(refundable(check, [check, { amount: -0.1, method: "check" }, { amount: -0.2, method: "check" }])).toBe(99.7);
  });
});

describe("payments on invoices in Stripe", () => {
  const made = (status: string, detached_at: string | null = null) => ({ origin: "stripe", status, detached_at });

  it("are recorded in Stripe while an invoice made there is open there", () => {
    expect(paidInStripe([made("open")])).toBe(true);
    expect(paidInStripe([made("processing")])).toBe(true);
    // Paid, voided or written off there, it no longer asks for money.
    expect(paidInStripe([made("paid")])).toBe(false);
    expect(paidInStripe([made("void")])).toBe(false);
  });

  it("but here for Crewtavo's own, and for one in a Stripe account Crewtavo left", () => {
    // Crewtavo's own Stripe invoice is redone for what's left after a payment here.
    expect(paidInStripe([{ origin: "crewtavo", status: "open", detached_at: null }])).toBe(false);
    expect(paidInStripe([made("open", "2026-10-01T00:00:00Z")])).toBe(false);
    expect(paidInStripe([])).toBe(false);
  });
});

describe("a bank payment on its way through Stripe", () => {
  const row = (status: string, detached_at: string | null = null) => ({ origin: "crewtavo", status, detached_at, amount_due: 160 });
  const now = Date.parse("2026-10-18T12:00:00Z");

  it("is the one still clearing, and says when it's in a Stripe account Crewtavo left", () => {
    expect(bankPayment([row("void"), row("processing")], now)).toMatchObject({ status: "processing", left: false, amount_due: 160 });
    expect(bankPayment([row("processing", "2026-10-10T00:00:00Z")], now)).toMatchObject({ left: true });
    expect(bankPayment([row("open")], now)).toBeNull();
  });

  it("stops counting a month after Crewtavo left its account: it cleared or bounced there by then", () => {
    expect(bankPayment([row("processing", "2026-09-17T00:00:00Z")], now)).toBeNull();
  });
});

describe("what the office reads about a bank payment on its way", () => {
  const bank = { amount_due: 160, processing_at: "2026-10-04T02:30:00Z", left: false };

  it("says how much, the day it started where the company is, and that another payment could be paid twice", () => {
    // 9:30 PM on Oct 3 in Chicago is Oct 4 in UTC.
    expect(bankPaymentNote(bank, "America/Chicago")).toBe(
      "A bank payment of $160.00 for this invoice is on its way through Stripe (started Oct 3). It usually clears in a few business days and shows up here when it does. If you record another payment, the client may end up paying twice.",
    );
    expect(bankPaymentNote({ ...bank, processing_at: null }, "America/Chicago")).toContain("on its way through Stripe. It usually clears");
  });

  it("says to record one still clearing in a Stripe account Crewtavo left once it clears", () => {
    expect(bankPaymentNote({ ...bank, left: true }, "America/Chicago")).toBe(
      "A bank payment of $160.00 was still clearing in the Stripe account Crewtavo used before, so it won't show up here on its own. Check it in that Stripe account, and record it here once it clears.",
    );
  });

  it("knows when it started because the invoice page reads it", () => {
    const page = readFileSync(fileURLToPath(new URL("../src/features/invoices/InvoicePage.tsx", import.meta.url)), "utf8");
    expect(page).toMatch(/stripe:stripe_invoices\([^)]*\bprocessing_at\b/);
  });
});

describe("recording a payment on an invoice made in Stripe", () => {
  it("is explained up front the way the database refuses one", () => {
    const migration = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261019001010_stripe_office.sql", import.meta.url)), "utf8");
    expect(RECORD_IN_STRIPE).toMatch(/mark it paid in Stripe.*credit note in Stripe/);
    // The database's message is the same, without the last full stop.
    expect(migration).toContain(`raise exception '${RECORD_IN_STRIPE.replace(/\.$/, "").replace(/'/g, "''")}' using errcode = '22023'`);
  });
});

describe("a payment in the invoice's list", () => {
  it("that was only a tip reads as the tip", () => {
    expect(paymentAmount({ amount: 0, tip_amount: 15 })).toEqual({ amount: "Tip $15.00", tip: null, back: false });
    // And the refund of one gives the tip back.
    expect(paymentAmount({ amount: 0, tip_amount: -15 })).toEqual({ amount: "Tip -$15.00", tip: null, back: true });
  });

  it("with an amount reads as before", () => {
    expect(paymentAmount({ amount: 160, tip_amount: 15 })).toEqual({ amount: "$160.00", tip: "+ $15.00 tip", back: false });
    expect(paymentAmount({ amount: -160, tip_amount: -15 })).toEqual({ amount: "-$160.00", tip: null, back: true });
  });
});

describe("taking a payment off an invoice while its Undo is offered", () => {
  const today = "2026-10-16";
  const invoice = { status: "paid", total: 1000, retainage_amount: 0, due_on: "2026-10-30", lines: [{}], payments: [{ id: "a", amount: 600 }, { id: "b", amount: 400 }], amount_paid: 1000, balance_due: 0 };

  it("puts the balance back up and works out the status as the database does", () => {
    expect(settle(invoice, [invoice.payments[0]!], today)).toMatchObject({ amount_paid: 600, balance_due: 400, status: "partially_paid" });
    expect(settle(invoice, [], today)).toMatchObject({ amount_paid: 0, balance_due: 1000, status: "sent" });
    // Past its due date it's past due again.
    expect(settle({ ...invoice, due_on: "2026-10-01" }, [], today)).toMatchObject({ status: "overdue" });
    // Put back, it's paid again.
    expect(settle({ ...invoice, status: "partially_paid" }, invoice.payments, today)).toMatchObject({ balance_due: 0, status: "paid" });
  });

  it("leaves drafts, voided and written-off invoices as they are", () => {
    expect(settle({ ...invoice, status: "draft" }, [], today).status).toBe("draft");
    expect(settle({ ...invoice, status: "void" }, [], today).status).toBe("void");
    expect(settle({ ...invoice, status: "written_off" }, [], today).status).toBe("written_off");
  });
});

describe("referral credits on an invoice", () => {
  const inv = (over: Partial<Parameters<typeof takesCredit>[0]> = {}) => ({ status: "sent", kind: "standard", payments: [], stripe: [], ...over });

  it("can be put on and taken off a draft, or one awaiting payment or past due, before any payment", () => {
    for (const status of ["draft", "sent", "overdue"]) {
      expect(takesCredit(inv({ status })), status).toBe(true);
      expect(creditsChangeable(inv({ status })), status).toBe(true);
    }
  });

  it("stay as they are once it's paid, partly paid, void or written off, or while Stripe bills it", () => {
    for (const status of ["paid", "partially_paid", "void", "written_off"]) expect(creditsChangeable(inv({ status })), status).toBe(false);
    expect(creditsChangeable(inv({ payments: [{ id: "p1" }] }))).toBe(false);
    expect(creditsChangeable(inv({ stripe: [{ origin: "stripe", status: "open" }] }))).toBe(false);
    expect(creditsChangeable(inv({ stripe: [{ origin: "crewtavo", status: "processing" }] }))).toBe(false);
    expect(creditsChangeable(inv({ stripe: [{ origin: "crewtavo", status: "open" }] }))).toBe(true);
  });

  it("never go on a deposit or a retainage release, the money that secures the job", () => {
    expect(takesCredit(inv({ kind: "deposit" }))).toBe(false);
    expect(takesCredit(inv({ kind: "retainage" }))).toBe(false);
    expect(takesCredit(inv({ kind: "progress" }))).toBe(true);
    // One already on a deposit (from before) can still come off.
    expect(creditsChangeable(inv({ kind: "deposit" }))).toBe(true);
  });

  it("fit in what's left of the charges after the discount and the credits already on it", () => {
    expect(creditRoom({ subtotal: 200, discount_amount: 30, credit_amount: 50 })).toBe(120);
    // A promo or credits that cover it leave no room, and a discount bigger than the charges never makes room negative.
    expect(creditRoom({ subtotal: 40, discount_amount: 40, credit_amount: 0 })).toBe(0);
    expect(creditRoom({ subtotal: 40, discount_amount: 0, credit_amount: 40 })).toBe(0);
    expect(creditRoom({ subtotal: 40, discount_amount: 60, credit_amount: 0 })).toBe(0);
    expect(creditRoom({ subtotal: "100.10", discount_amount: "0.05", credit_amount: "0.05" })).toBe(100);
  });

  it("are offered by hand only on invoices with room, with words that follow Keep off invoices", () => {
    const tab = readFileSync(fileURLToPath(new URL("../src/features/marketing/Referrals.tsx", import.meta.url)), "utf8");
    expect(tab).toContain("takesCredit(i) && creditRoom(i) > 0");
    expect(tab).toContain("subtotal, discount_amount, credit_amount");
    expect(tab).toContain('r?.auto_apply ? "It goes on their next one."');
  });

  it("show on the invoice page after the discount, with the client's credits to apply", () => {
    const page = readFileSync(fileURLToPath(new URL("../src/features/invoices/InvoicePage.tsx", import.meta.url)), "utf8");
    expect(page).toContain("credits:referral_credits(id, amount, note, referral_id, created_at)");
    expect(page.indexOf("<ReferralCredits invoice={inv} onChanged={refresh} />")).toBeGreaterThan(page.indexOf("<DiscountRows"));
    const credits = readFileSync(fileURLToPath(new URL("../src/features/invoices/ReferralCredits.tsx", import.meta.url)), "utf8");
    expect(credits).toContain('rpc("referral_credits_for"');
    expect(credits).toContain("Credit taken off this invoice. It goes on their next one.");
    expect(credits).toContain("creditRoom(invoice) > 0");
    // A void invoice keeps the credit it was sent with, after the credit's row is given back.
    expect(credits).toContain("Given back when this invoice was voided");
    // The amount never breaks after its minus sign, however long the note beside it.
    expect(credits.match(/<span className="nowrap">−\{formatMoneyCents\(/g)).toHaveLength(2);
  });

  it("say how much of the credit each invoice takes in the apply dialog", () => {
    const tab = readFileSync(fileURLToPath(new URL("../src/features/marketing/Referrals.tsx", import.meta.url)), "utf8");
    expect(tab).toContain("creditRoom(i) >= left ? `Takes all ${formatMoneyCents(left)}` : `Takes ${formatMoneyCents(creditRoom(i))} of ${formatMoneyCents(left)}`");
  });
});
