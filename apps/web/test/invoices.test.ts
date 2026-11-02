import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { chargeInChunks, chargeOutcomeText, chargeSummary, chargeTotal } from "../src/features/invoices/charges";
import { ChargeCardsDialog } from "../src/features/invoices/InvoiceTools";
import { InvoicePage } from "../src/features/invoices/InvoicePage";
import { refundable, stripeCharge, stripeRefundable, stripeRefundToasts } from "../src/features/invoices/refunds";
import { settle } from "../src/features/invoices/settle";
import { creditRoom, creditsChangeable, takesCredit } from "../src/features/invoices/creditRules";
import { autopayBankNote, bankPayment, bankPaymentNote, paidInStripe, paymentAmount, RECORD_IN_STRIPE } from "../src/features/invoices/stripeInvoices";

// The invoice page draws as an office user with the invoices area sees it, from data already loaded.
vi.mock("../src/lib/session", () => ({
  useSession: () => ({
    role: "owner",
    permissions: ["invoices"],
    userId: "u-me",
    company: { id: "c1", name: "Radford Lawn Care", trade_preset: "lawn_exterior", timezone: "America/Chicago", settings: {} },
    config: { singleCompany: true, platform: "railway", features: { email: true, sms: true } },
    refresh: async () => undefined,
  }),
  hasRole: () => true,
  can: () => true,
  isSub: () => false,
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: { get: async () => ({}), put: async () => ({}), post: async () => ({}) },
  supabase: () => ({}),
}));

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

describe("refunds through Stripe", () => {
  const card = { amount: 45, tip_amount: 0, processor: "stripe", processor_ref: "pi_123" };
  // As integrations/stripe.ts books Stripe's refunds: named after the charge and its refunded total.
  const back = (ref: string, amount: number, tip = 0) => ({ amount: -amount, tip_amount: -tip, processor: "stripe", processor_ref: ref });

  it("can give back all of a charge, and what's left after a part of it", () => {
    expect(stripeRefundable(card, [card])).toBe(45);
    expect(stripeRefundable(card, [card, back("pi_123:refund:1500", 15)])).toBe(30);
    // Refunded twice more, in cents: the refunded total in the name grows each time.
    expect(stripeRefundable(card, [card, back("pi_123:refund:1500", 15), back("pi_123:refund:4499", 29.99)])).toBe(0.01);
    expect(stripeRefundable(card, [card, back("pi_123:refund:4500", 45)])).toBe(0);
  });

  it("counts the tip, which Stripe charged with it and gives back after the invoice part", () => {
    const tipped = { ...card, tip_amount: 6.75 };
    expect(stripeRefundable(tipped, [tipped])).toBe(51.75);
    expect(stripeRefundable(tipped, [tipped, back("pi_123:refund:4800", 45, 3)])).toBe(3.75);
    // A payment that was only a tip.
    const tipOnly = { amount: 0, tip_amount: 5, processor: "stripe", processor_ref: "pi_tip" };
    expect(stripeRefundable(tipOnly, [tipOnly])).toBe(5);
    expect(stripeRefundable(tipOnly, [tipOnly, back("pi_tip:refund:500", 0, 5)])).toBe(0);
  });

  it("takes off a dispute the client won from their bank, and never goes below nothing", () => {
    expect(stripeRefundable(card, [card, back("pi_123:dispute:dp_1", 20)])).toBe(25);
    expect(stripeRefundable(card, [card, back("pi_123:dispute:dp_1", 45), back("pi_123:refund:1000", 10)])).toBe(0);
  });

  it("leaves out what the client owed from before, other charges, and money recorded by hand", () => {
    const others = [
      // Owed from before in Stripe, paid with this charge: the client's, not the invoice's.
      back("pi_123:refund:6000:before", 15),
      back("pi_123:dispute:dp_1:before", 5),
      // Another charge's refund, and a check refunded here.
      back("pi_999:refund:4500", 45),
      { amount: -20, tip_amount: 0, processor: null, processor_ref: null },
    ];
    expect(stripeRefundable(card, [card, ...others])).toBe(45);
    expect(stripeRefundable({ ...card, processor_ref: null }, [card])).toBe(0);
  });

  it("is offered only for a payment Stripe took, with money in it", () => {
    expect(stripeCharge(card)).toBe(true);
    expect(stripeCharge({ ...card, amount: 0, tip_amount: 5 })).toBe(true);
    // Recorded by hand, booked from Stripe some other way, or itself a refund.
    expect(stripeCharge({ ...card, processor: null })).toBe(false);
    expect(stripeCharge({ ...card, processor_ref: "in_123:paid" })).toBe(false);
    expect(stripeCharge({ ...card, processor_ref: "ch_123" })).toBe(false);
    expect(stripeCharge({ ...card, processor_ref: null })).toBe(false);
    expect(stripeCharge(back("pi_123:refund:4500", 45))).toBe(false);
    expect(stripeCharge({ ...card, amount: -45 })).toBe(false);
  });

  it("works from what the invoice page reads, and sends the refund to the server rather than booking it", () => {
    const page = readFileSync(fileURLToPath(new URL("../src/features/invoices/InvoicePage.tsx", import.meta.url)), "utf8");
    expect(page).toMatch(/payments\([^)]*\bprocessor_ref\b/);
    expect(page).toMatch(/stripe:stripe_invoices\([^)]*\bcollection\b[^)]*\bpurpose\b/);
    // Its autopay charge (or Charge card's), and the card it's charged to (never its number: the brand and last four).
    expect(page).toMatch(/from\("autopay_charges"\)\s*\.select\("id, source, status, due_at, attempts, failures, last_error, decline_code, charged_at, approved_at, method:client_payment_methods!autopay_charges_method_fkey\(type, brand, last4, bank_name, wallet\)"\)\s*\.eq\("invoice_id", id\)/);
    expect(page).toContain("`/payments/${payment.id}/refund`, { amount: Math.round(value * 100) / 100, write_off: writeOff })");
    // The browser books only refunds recorded by hand: one insert of a negative payment, in RefundDialog.
    const stripeDialog = page.slice(page.indexOf("function StripeRefundDialog"));
    expect(stripeDialog).not.toContain('.from("payments")');
  });
});

describe("what the office is told after a refund through Stripe", () => {
  const done = { refunded: 100, recorded: true, written_off: true, still_owed: 0 };

  it("is the usual toast when it was booked and taken off, or wasn't to be", () => {
    expect(stripeRefundToasts(done, true)).toEqual({ success: "Refund sent to Stripe", note: null });
    expect(stripeRefundToasts({ ...done, written_off: false }, false)).toEqual({ success: "Refund sent to Stripe", note: null });
    // A tip-only refund, or an invoice written off already: nothing was left to take off, so nothing to say.
    expect(stripeRefundToasts({ ...done, written_off: false }, true)).toEqual({ success: "Refund sent to Stripe", note: null });
    // An older server says nothing about what's still owed.
    expect(stripeRefundToasts({ refunded: 100, recorded: true, written_off: false }, true).note).toBeNull();
  });

  it("says the balance wasn't written off, and how much is still asked for, when other money is still owed", () => {
    // $100 of a $200 invoice refunded with "Take it off the invoice too" ticked: $200 is owed again.
    const owed = stripeRefundToasts({ ...done, written_off: false, still_owed: 200 }, true);
    expect(owed.success).toBeNull();
    expect(owed.note).toEqual({
      title: "Refunded. The balance wasn't written off",
      description: "$200.00 is still owed on this invoice, including the refunded part. Write it off from the invoice menu if you don't want it collected.",
    });
  });

  it("says Stripe will confirm one not booked yet, beside the usual toast", () => {
    expect(stripeRefundToasts({ ...done, recorded: false, written_off: false }, true)).toEqual({
      success: "Refund sent to Stripe",
      note: { title: "Stripe will confirm it in a minute", description: "Write the balance off from the invoice menu if you don't want it collected." },
    });
    expect(stripeRefundToasts({ ...done, recorded: false, written_off: false }, false).note).toEqual({ title: "Stripe will confirm it in a minute", description: undefined });
  });

  it("is what the refund dialog shows, from the server's answer", () => {
    const page = readFileSync(fileURLToPath(new URL("../src/features/invoices/InvoicePage.tsx", import.meta.url)), "utf8");
    const dialog = page.slice(page.indexOf("function StripeRefundDialog"));
    expect(dialog).toContain("success: (result: StripeRefundResult) => stripeRefundToasts(result, writeOff).success");
    expect(dialog).toContain("const { note } = stripeRefundToasts(result, writeOff);");
    expect(dialog).toContain("api.post<StripeRefundResult>(");
  });
});

describe("the Autopay tag on a field visit", () => {
  const field = readFileSync(fileURLToPath(new URL("../src/features/field/FieldVisitPage.tsx", import.meta.url)), "utf8");

  it("is a yes or no from visit_autopay, kept on the phone with the visit, and not for subs", () => {
    expect(field).toContain('queryKey: ["field-visit", id, "autopay"]');
    expect(field).toContain('supabase().rpc("visit_autopay", { p_visit: id })');
    expect(field).toMatch(/\{!sub && autopay\.data && <span className="chip"[^>]*><Icon name="card" size=\{12\} \/>Autopay<\/span>\}/);
  });

  it("never reads a charge, a card or an amount", () => {
    for (const table of ["autopay_charges", "client_payment_methods", "autopay_authorizations", "invoices", "payments"]) expect(field).not.toContain(`from("${table}")`);
    expect(field).not.toMatch(/methodLabel|formatMoney/);
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

describe("what the office reads while autopay's bank payment is on its way", () => {
  it("says from which account, how much and since when, and to record any other payment once it clears or bounces", () => {
    expect(autopayBankNote("Chase ending 6789", { amount_due: 45, processing_at: "2026-10-04T02:30:00Z" }, "America/Chicago")).toBe(
      "A bank payment of $45.00 from Chase ending 6789 is on its way through Stripe (started Oct 3). It usually clears in a few business days and shows up here when it does. Record any other payment once it clears or bounces.",
    );
    // Before Stripe's invoice says so.
    expect(autopayBankNote("Chase ending 6789", null, "America/Chicago")).toBe(
      "A bank payment from Chase ending 6789 is on its way through Stripe. It usually clears in a few business days and shows up here when it does. Record any other payment once it clears or bounces.",
    );
  });
});

/**
 * Invoice #2 for a $45 weekly mow, sent and owed (or still a draft), with autopay's charge in `status`
 * when there is one, and why it's in that status. `bank`: the client's own bank payment from the Pay
 * link is on its way. `manual`: the card Charge card charges, as the server says (none by default).
 * `source`: 'manual' for a charge from Charge card; `visa`: it's on a Visa card, not Chase's bank account.
 */
function invoicePage(status: string | null, options: { draft?: boolean; last_error?: string | null; left?: boolean; bank?: boolean; failures?: number; approved?: boolean; manual?: { card: string } | null; source?: string; visa?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["invoice", "i1", "charge"], { manual: options.manual ?? null });
  client.setQueryData(["invoice", "i1"], {
    id: "i1", number: 2, status: options.draft ? "draft" : "sent", kind: "standard", subject: null, notes: null, issued_on: "2026-10-27", due_on: "2026-11-10", sent_at: options.draft ? null : "2026-10-27T23:00:00Z",
    subtotal: 45, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 45, retainage_amount: 0, retainage_pct: 0, amount_paid: 0, balance_due: 45, written_off_at: null,
    client_id: "cl1", promo: null, client: { id: "cl1", display_name: "Pat Lee", email: null, phone: null, billing_address: null }, job: null,
    lines: [{ id: "l1", name: "Weekly mow", description: null, quantity: 1, unit: "visit", unit_price: 45, taxable: false, sort: 0, service_id: null }],
    payments: [],
    stripe: status === "processing"
      ? [{ stripe_id: "in_1", origin: "crewtavo", status: "processing", number: "A-2", hosted_url: null, livemode: false, amount_due: 45, created_at: "2026-10-27T23:00:00Z", detached_at: options.left ? new Date().toISOString() : null, processing_at: "2026-10-27T23:05:00Z", collection: "charge_automatically", purpose: "invoice" }]
      : options.bank
        ? [{ stripe_id: "in_2", origin: "crewtavo", status: "processing", number: "A-3", hosted_url: null, livemode: false, amount_due: 45, created_at: "2026-10-29T15:00:00Z", detached_at: null, processing_at: "2026-10-29T15:05:00Z", collection: "send_invoice", purpose: "invoice" }]
        : [],
    autopay: status
      ? [{ id: "a1", source: options.source ?? "autopay", status, due_at: "2026-10-27T23:00:00Z", attempts: 1, failures: options.failures ?? (status === "failed" ? 1 : 0), last_error: options.last_error ?? null, decline_code: null, charged_at: null, approved_at: options.approved ? "2026-10-28T15:00:00Z" : null, method: options.visa ? { type: "card", brand: "visa", last4: "4242", bank_name: null, wallet: null } : { type: "us_bank_account", brand: null, last4: "6789", bank_name: "Chase", wallet: null } }]
      : [],
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: ["/invoices/i1"] }, createElement(Routes, null, createElement(Route, { path: "/invoices/:id", element: createElement(InvoicePage) }))),
    ),
  );
}
/** A button or menu item, by its label: its tag, so its disabled and title can be read. */
const control = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}</button>`))?.[0] ?? null;

describe("an invoice whose autopay bank payment is on its way", () => {
  it("waits to record a payment, and says why", () => {
    const html = invoicePage("processing");
    const record = control(html, "Record payment");
    expect(record).toMatch(/disabled=""/);
    expect(record).toContain('title="A bank payment of $45.00 from Chase ending 6789 is on its way through Stripe (started Oct 27). It usually clears in a few business days and shows up here when it does. Record any other payment once it clears or bounces."');
    // Said on the page too, once, and not the note about paying twice that a payment from the Pay link gets.
    expect(html.match(/Record any other payment once it clears or bounces\.<\/div>/g)).toHaveLength(1);
    expect(html).not.toContain("may end up paying twice");
  });

  it("can't be voided or moved back to draft until it clears or bounces", () => {
    const html = invoicePage("processing");
    expect(control(html, "Void invoice")).toBeNull();
    expect(control(html, "Move back to draft")).toBeNull();
    // Write off is there, but off: the bank payment may still pay it.
    expect(control(html, "Write off")).toMatch(/disabled=""/);
  });

  it("is the office's to follow once it's in a Stripe account Crewtavo left, as the database lets it be", () => {
    const html = invoicePage("processing", { left: true });
    expect(control(html, "Record payment")).not.toMatch(/disabled=""/);
    expect(control(html, "Void invoice")).not.toBeNull();
    expect(html).toContain("was still clearing in the Stripe account Crewtavo used before, so it won&#x27;t show up here on its own. Check it in that Stripe account, and record it here once it clears.");
    expect(html).not.toContain("Record any other payment once it clears or bounces.");
    const migration = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261101000100_autopay.sql", import.meta.url)), "utf8");
    expect(migration).toMatch(/s\.status = 'processing' and s\.detached_at is not null/);
  });

  it("is as before when nothing is on its way", () => {
    for (const status of [null, "failed"]) {
      const html = invoicePage(status);
      expect(control(html, "Record payment"), String(status)).not.toMatch(/disabled=""/);
      expect(control(html, "Void invoice"), String(status)).not.toBeNull();
      expect(control(html, "Move back to draft"), String(status)).not.toBeNull();
    }
  });
});

describe("a failed charge while the client's own bank payment is on its way", () => {
  it("says the bank payment is on its way, not that the card is tried again, and offers no reminder", () => {
    const html = invoicePage("failed", { bank: true });
    expect(html).toContain("A bank payment of $45.00 for this invoice is on its way through Stripe");
    expect(html).not.toContain("Autopay failed");
    expect(html).not.toContain("try again");
    expect(control(html, "Send a reminder")).toBeNull();
    // Without one, the failed charge says when it's tried again, with the reminder.
    const failed = invoicePage("failed");
    expect(failed).toContain("Autopay failed");
    expect(failed).toContain("try again");
    expect(control(failed, "Send a reminder")).not.toBeNull();
  });
});

describe("a charge moved back to be tried on a card the client agreed to since", () => {
  it("says it's charged to that card right away, not that it failed", () => {
    const html = invoicePage("failed", { failures: 0, last_error: "Your card was declined." });
    expect(html).toContain("Charged automatically to Chase ending 6789 right away.");
    expect(html).not.toContain("Autopay failed");
    expect(control(html, "Send a reminder")).toBeNull();
  });
});

describe("a charge waiting for the office's OK", () => {
  /** The callout's words: what's said before its Approve charge button. */
  const asked = (html: string) => html.match(/callout-warning">.*?<div class="grow">(.*?)<\/div>/)?.[1] ?? null;

  it("says why when the database said, for visits autopay didn't queue as for those from before it started", () => {
    expect(asked(invoicePage("needs_approval", { draft: true, last_error: "Includes visits autopay didn't queue (finished while it was off, or from a voided invoice)" }))).toBe(
      "It includes visits autopay didn&#x27;t queue (finished while it was off, or from a voided invoice), so it waits for your OK.",
    );
    expect(asked(invoicePage("needs_approval", { draft: true, last_error: "Includes visits from before autopay started" }))).toBe(
      "It includes visits from before autopay started, so it waits for your OK.",
    );
  });

  it("and otherwise that it waits, the database giving no reason for the limit", () => {
    // No limit set in this company's settings.
    expect(asked(invoicePage("needs_approval", { draft: true }))).toBe("It waits for your OK before it&#x27;s charged.");
  });

  it("reads the reasons the database gives", () => {
    const migration = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261101000100_autopay.sql", import.meta.url)), "utf8");
    expect(migration).toContain("then 'Includes visits from before autopay started'");
    expect(migration).toContain("then 'Includes visits autopay didn''t queue (finished while it was off, or from a voided invoice)'");
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
    expect(page).toContain('from("referral_credits").select("id, amount, note, referral_id, created_at")');
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

describe("Charge card on an invoice", () => {
  const visa = { card: "Visa ending 4242" };

  it("shows when the server says the client's card can be charged", () => {
    expect(control(invoicePage(null, { manual: visa }), "Charge card")).not.toBeNull();
    // Drafts too: the database marks one sent, without an email, as it charges it.
    expect(control(invoicePage(null, { manual: visa, draft: true }), "Charge card")).not.toBeNull();
    expect(control(invoicePage(null), "Charge card")).toBeNull();
  });

  it("doesn't while a charge is going or waiting on someone, or the client's bank payment is on its way", () => {
    for (const status of ["waiting", "needs_approval", "charging", "processing", "failed", "needs_client"]) {
      expect(control(invoicePage(status, { manual: visa }), "Charge card"), status).toBeNull();
    }
    expect(control(invoicePage(null, { manual: visa, bank: true }), "Charge card")).toBeNull();
    // A charge called off leaves it to be charged again.
    expect(control(invoicePage("called_off", { manual: visa }), "Charge card")).not.toBeNull();
  });

  it("then says it's charging the card, as for a charge the office approved", () => {
    expect(invoicePage("waiting", { approved: true })).toContain("Charging Chase ending 6789 in the next few minutes.");
  });

  it("when declined, says the client was sent the Pay link, not that autopay is paused", () => {
    const declined = invoicePage("needs_client", { source: "manual", failures: 1, visa: true, last_error: "Your card was declined." });
    expect(declined).toContain("Autopay needs Pat Lee: the card was declined, so they were sent the Pay link and a way to update their card.");
    expect(declined).not.toContain("declined twice");
    // Autopay's own second decline still says it's paused.
    expect(invoicePage("needs_client", { failures: 2, visa: true, last_error: "Your card was declined." })).toContain("the card was declined twice, so autopay is paused until they update it.");
  });

  it("asks first, sends one invoice, and can't be pressed twice", () => {
    const page = readFileSync(fileURLToPath(new URL("../src/features/invoices/InvoicePage.tsx", import.meta.url)), "utf8");
    // The server's GET /api/invoices/:id/charge says whether there's a card to press it for.
    expect(page).toContain("`/invoices/${id}/charge`");
    expect(page).toContain("title: `Charge ${amount} to ${card}?`");
    expect(page).toContain("confirmLabel: `Charge ${amount}`");
    // With the balance the confirm showed, so a line changed meanwhile can't raise it unasked.
    expect(page).toContain('api.post<{ results: ChargeResult[] }>("/invoices/charge", { invoices: [{ id, amount }] })');
    expect(page).toContain("if (ok) chargeCard.mutate(balance);");
    expect(page).toContain("loading={chargeCard.isPending}");
    // Once queued, the button goes until the server says otherwise.
    expect(page).toContain('queryClient.setQueryData(["invoice", id, "charge"], { manual: null });');
  });
});

describe("what happened to each invoice charged", () => {
  it("is said in plain words", () => {
    const said = (outcome: string, reason: string | null = null) => chargeOutcomeText({ outcome, reason });
    expect(said("queued")).toBe("Charging");
    expect(said("no_card")).toBe("No card on file");
    expect(said("not_owed")).toBe("Nothing owed");
    expect(said("in_progress")).toBe("Already on its way");
    expect(said("changed", "The amount changed to $50.00. Check it and try again")).toBe("The amount changed to $50.00. Check it and try again");
    expect(said("changed")).toBe("The amount changed. Check it and try again");
    expect(said("not_sent")).toBe("Not sent. Try again.");
    expect(said("autopay_off")).toBe("Charging saved cards is off in Settings → Payments");
    expect(said("too_small")).toBe("Too small for Stripe");
    // One this screen doesn't know yet says the server's reason.
    expect(said("something_new", "Stripe is down")).toBe("Stripe is down");
    // The server's reason says more than the outcome when it has one.
    expect(said("autopay_off", "Update your Stripe key on the Apps page")).toBe("Update your Stripe key on the Apps page");
    expect(said("no_card", "The client's card needs updating")).toBe("The client's card needs updating");
    expect(said("something_new")).toBe("Not charged");
  });

  it("counts one already on its way apart from those not charged", () => {
    expect(chargeSummary([{ outcome: "queued" }, { outcome: "queued" }])).toBe("2 charging. Each invoice shows when it's paid.");
    expect(chargeSummary([{ outcome: "queued" }, { outcome: "in_progress" }, { outcome: "no_card" }])).toBe("1 charging. 1 already on its way. 1 not charged. Each invoice shows when it's paid.");
    expect(chargeSummary([{ outcome: "in_progress" }, { outcome: "in_progress" }, { outcome: "not_sent" }])).toBe("0 charging. 2 already on their way. 1 not charged. Each invoice shows when it's paid.");
  });

  it("adds up in cents", () => {
    expect(chargeTotal([{ balance_due: 0.1 }, { balance_due: 0.2 }])).toBe(0.3);
    expect(chargeTotal([{ balance_due: 45 }, { balance_due: 62.5 }])).toBe(107.5);
    expect(chargeTotal([])).toBe(0);
  });
});

describe("Charge cards on the Invoices page", () => {
  type Live = "charging" | "waiting_on_client" | "retrying" | "needs_approval" | "bank_clearing";
  const row = (id: string, number: number, in_progress = false, live_status: Live | null = in_progress ? "charging" : null, live_detail: string | null = null) => ({
    id, number, client_id: `cl-${id}`, client_name: `Client ${number}`, balance_due: 45, due_on: "2026-10-20", status: "overdue", card: "Visa ending 4242", in_progress, live_status, live_detail,
  });
  const dialog = (invoices: ReturnType<typeof row>[]) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["invoices", "c1", "chargeable"], { invoices });
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ChargeCardsDialog, { onClose: () => undefined })));
  };

  it("lists each unpaid invoice with its client, number, amount, due date and card, none ticked to start", () => {
    const html = dialog([row("i1", 7), row("i2", 8, true)]);
    expect(html).toContain("Client 7");
    expect(html).toContain("#7 · ");
    expect(html).toContain("Due Oct 20");
    expect(html).toContain("Visa ending 4242");
    expect(html).toContain("$45.00");
    expect(html).not.toMatch(/checked=""/);
    // Select all counts only those it can tick, and the button waits for one.
    expect(html).toContain("Select all (1)");
    expect(control(html, "Charge invoices")).toMatch(/disabled=""/);
  });

  it("shows one already being charged, but it can't be ticked", () => {
    const html = dialog([row("i2", 8, true)]);
    expect(html).toContain("Charging now");
    expect(html.match(/<input type="checkbox"[^>]*disabled=""/g)).toHaveLength(2);
  });

  it("says what each charge under way is doing, and only one Stripe is charging says it's charging", () => {
    const html = dialog([row("i3", 9, true, "waiting_on_client"), row("i4", 10, true, "retrying"), row("i5", 11, true, "needs_approval"), row("i6", 12, true, "bank_clearing")]);
    expect(html).toContain("Waiting on the client");
    expect(html).toContain("Autopay will try it again");
    expect(html).toContain("Waiting for your OK");
    expect(html).toContain("Bank payment on its way");
    expect(html).not.toContain("Charging now");
    expect(html).not.toContain("Already charging");
    // The server's own words when it gives them, and a bank payment clearing can't be ticked even if it isn't a charge.
    expect(dialog([row("i7", 13, false, "bank_clearing", "A bank payment clears Nov 4")])).toContain("A bank payment clears Nov 4");
    expect(dialog([row("i7", 13, false, "bank_clearing")])).toContain("Select all (0)");
  });

  it("keeps what earlier chunks did when a later one fails, and says the rest weren't sent", async () => {
    const rows = Array.from({ length: 120 }, (_, n) => row(`i${n}`, n));
    const bodies: unknown[] = [];
    const post = async (body: { invoices: Array<{ id: string; amount: number }> }) => {
      bodies.push(body);
      if (bodies.length === 2) throw new Error("Couldn't reach Crewtavo");
      return { results: body.invoices.map((b) => ({ invoice_id: b.id, outcome: b.id === "i0" ? "in_progress" : "queued", reason: null })) };
    };
    const done = await chargeInChunks(rows, post);
    // Each with the balance the office saw; the third chunk isn't tried.
    expect(bodies).toHaveLength(2);
    expect((bodies[0] as { invoices: unknown[] }).invoices[0]).toEqual({ id: "i0", amount: 45 });
    expect(done.error).toBeInstanceOf(Error);
    expect(done.rows).toHaveLength(120);
    expect(done.rows.slice(0, 50).every((d) => d.result.outcome === "queued" || d.result.outcome === "in_progress")).toBe(true);
    expect(done.rows.slice(50).every((d) => chargeOutcomeText(d.result) === "Not sent. Try again.")).toBe(true);
    expect(chargeSummary(done.rows.map((d) => d.result))).toBe("49 charging. 1 already on its way. 70 not charged. Each invoice shows when it's paid.");
    // When the first fails nothing went, so the form says why and can be pressed again.
    await expect(chargeInChunks(rows.slice(0, 3), async () => { throw new Error("Couldn't reach Crewtavo"); })).rejects.toThrow("Couldn't reach Crewtavo");
  });

  it("says when there's nothing to charge", () => {
    expect(dialog([])).toContain("No saved cards to charge");
  });

  it("is in the Invoices menu only while charging saved cards is on, and sends 50 at a time", () => {
    const page = readFileSync(fileURLToPath(new URL("../src/features/invoices/InvoicesPage.tsx", import.meta.url)), "utf8");
    expect(page).toContain("const chargesCards = seesMoney && autopaySettings(company.settings, company.trade_preset).enabled;");
    expect(page).toContain('{ label: "Charge cards", icon: "card", onSelect: () => setCharging(true), hidden: !chargesCards }');
    const tools = readFileSync(fileURLToPath(new URL("../src/features/invoices/InvoiceTools.tsx", import.meta.url)), "utf8");
    expect(tools).toContain('chargeInChunks(batch, (body) => api.post<{ results: ChargeResult[] }>("/invoices/charge", body))');
    // Looked at again however it ends: a chunk that failed may have queued some.
    expect(tools).toMatch(/chargeInChunks\([^\n]*\),\n\s*onSettled: \(\) => \{\n\s*queryClient\.invalidateQueries\(\{ queryKey: \["invoices"\] \}\);\n\s*queryClient\.invalidateQueries\(\{ queryKey: \["invoice"\] \}\);\n\s*queryClient\.invalidateQueries\(\{ queryKey: \["dashboard"\] \}\);/);
    expect(tools).toContain('api.get<{ invoices: ChargeableInvoice[] }>("/invoices/chargeable")');
  });
});
