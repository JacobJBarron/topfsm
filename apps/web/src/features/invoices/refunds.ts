import { toCents } from "@crewtavo/core/money";
import { formatMoneyCents } from "@/lib/format";

interface Paid {
  amount: number;
  method: string;
  processor?: string | null;
}

/**
 * What's left to refund on a payment. A refund is a negative payment on the invoice with the
 * payment's method but no link to the payment itself, so the most it can still give back is the
 * smallest of: the payment, what's still paid that way on the invoice, and what's still paid at all.
 * A $100 check refunded once has nothing left.
 */
export function refundable(payment: Paid, payments: Paid[]): number {
  const net = (list: Paid[]) => list.reduce((sum, p) => sum + toCents(p.amount), 0);
  const sameWay = payments.filter((p) => !p.processor && p.method === payment.method);
  return Math.max(0, Math.min(toCents(payment.amount), net(sameWay), net(payments))) / 100;
}

interface StripePaid {
  amount: number;
  tip_amount: number;
  processor_ref: string | null;
}

/**
 * What's left to refund through Stripe on a card or bank payment, tip included (Stripe refunds the
 * charge, and the tip was part of it). Stripe's refunds and lost disputes of the charge are booked as
 * negative payments named after it (`<payment intent>:refund:<total>`, `<payment intent>:dispute:<id>`,
 * as integrations/stripe.ts writes them), so they're what comes off. What the client owed from
 * before and paid with it (`:before`) is theirs, not the invoice's, and isn't counted here.
 */
export function stripeRefundable(payment: StripePaid, payments: StripePaid[]): number {
  const ref = payment.processor_ref;
  if (!ref) return 0;
  const back = payments.filter((p) => {
    const r = p.processor_ref ?? "";
    return (r.startsWith(`${ref}:refund:`) || r.startsWith(`${ref}:dispute:`)) && !r.endsWith(":before");
  });
  const paid = toCents(payment.amount) + toCents(payment.tip_amount);
  // The rows are negative: what went back is minus their sum.
  const taken = -back.reduce((sum, p) => sum + toCents(p.amount) + toCents(p.tip_amount), 0);
  return Math.max(0, paid - taken) / 100;
}

/**
 * A payment Stripe took (its PaymentIntent, `pi_...`) with money in it, which Refund on the invoice
 * page sends back through Stripe. Ones booked from Stripe in other ways (marked paid there, account
 * credit, the refunds and disputes themselves, which all carry a `:`) aren't refunded from here.
 */
export function stripeCharge(p: { amount: number; tip_amount: number; processor: string | null; processor_ref: string | null }): boolean {
  return p.processor === "stripe" && toCents(p.amount) + toCents(p.tip_amount) > 0 && Boolean(p.processor_ref?.startsWith("pi_")) && !p.processor_ref!.includes(":");
}

/** What POST /payments/:id/refund answers: dollars refunded, whether it's booked yet, and what's still owed when it wasn't written off. */
export interface StripeRefundResult {
  refunded: number;
  recorded: boolean;
  written_off: boolean;
  /**
   * Over 0 only when "Take it off the invoice too" was ticked, the refund was booked, and other money
   * is still owed, so nothing was written off: the client is asked for this, the refunded part with
   * it. An older server leaves it out.
   */
  still_owed?: number;
}

/**
 * What the office is told after a refund through Stripe: `success` is the usual "Refund sent to
 * Stripe" (or null, when the note says it all), and `note` is said beside it. Ticked to come off the
 * invoice but other money still owed: the balance wasn't written off, and how much is still asked
 * for. Not booked yet: Stripe's report of it books it shortly.
 */
export function stripeRefundToasts(result: StripeRefundResult, writeOff: boolean): { success: string | null; note: { title: string; description?: string } | null } {
  const owed = result.still_owed ?? 0;
  if (writeOff && owed > 0) {
    return {
      success: null,
      note: {
        title: "Refunded. The balance wasn't written off",
        description: `${formatMoneyCents(owed)} is still owed on this invoice, including the refunded part. Write it off from the invoice menu if you don't want it collected.`,
      },
    };
  }
  const note = result.recorded ? null : { title: "Stripe will confirm it in a minute", description: writeOff ? "Write the balance off from the invoice menu if you don't want it collected." : undefined };
  return { success: "Refund sent to Stripe", note };
}
