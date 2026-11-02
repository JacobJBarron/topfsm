import { formatMoneyCents } from "@/lib/format";

interface StripeInvoiceRow {
  origin: string;
  status: string;
  detached_at: string | null;
}

/**
 * Made in Stripe and still open there: Stripe asks the client for all of it, so a payment is
 * recorded by marking it paid in Stripe, not here (the database refuses one too). One in a Stripe
 * account Crewtavo has since left isn't followed any more, so it doesn't count.
 */
export const paidInStripe = (rows: StripeInvoiceRow[]) =>
  rows.some((s) => s.origin === "stripe" && ["creating", "open", "processing"].includes(s.status) && !s.detached_at);

/**
 * What to do instead, for an invoice made in Stripe: the database's refusal says the same
 * (private.stripe_payment_guard in 20261019001010_stripe_office.sql), and a credit note there is
 * booked here once the invoice is paid.
 */
export const RECORD_IN_STRIPE =
  "This invoice was made in Stripe, so record its payments there. If the client paid all of it, mark it paid in Stripe. If they paid part, issue a credit note in Stripe for what they paid, so Stripe asks for only the rest. Either way it shows up here once the invoice is paid there.";

/** Past this, a bank payment has cleared or bounced (as in the API's integrations/stripe.ts). */
const CLEARING_DAYS = 30;

/**
 * A bank payment on its way through Stripe, if any. `left` when it's in a Stripe account Crewtavo
 * has since left, so it won't show up here on its own; and past the days one can take, it has
 * cleared or bounced there, so it no longer counts (the Client Hub takes payments again).
 */
export function bankPayment<T extends StripeInvoiceRow>(rows: T[], now = Date.now()): (T & { left: boolean }) | null {
  const row = rows.find((s) => s.status === "processing" && (!s.detached_at || now - Date.parse(s.detached_at) < CLEARING_DAYS * 86_400_000));
  return row ? { ...row, left: Boolean(row.detached_at) } : null;
}

/**
 * What the office reads about a bank payment on its way, next to Record payment and before
 * recording one: how much, since when (in the company's time zone), and that another payment could
 * have the client pay twice. Recording one isn't refused: bank payments can bounce.
 */
export function bankPaymentNote(bank: { amount_due: number; processing_at?: string | null; left: boolean }, timeZone: string): string {
  const amount = formatMoneyCents(bank.amount_due);
  if (bank.left) {
    return `A bank payment of ${amount} was still clearing in the Stripe account Crewtavo used before, so it won't show up here on its own. Check it in that Stripe account, and record it here once it clears.`;
  }
  return `A bank payment of ${amount} for this invoice is on its way through Stripe${started(bank.processing_at, timeZone)}. It usually clears in a few business days and shows up here when it does. If you record another payment, the client may end up paying twice.`;
}

/**
 * What the office reads while autopay's own bank payment for the invoice is on its way (its charge
 * is 'processing'), beside a Record payment that waits until then. A payment recorded meanwhile
 * could have the client pay twice, so the database refuses one until the bank payment clears or
 * bounces. `bank` is the charge's Stripe invoice once that says so, for how much and since when.
 */
export function autopayBankNote(card: string, bank: { amount_due: number; processing_at?: string | null } | null, timeZone: string): string {
  const amount = bank ? ` of ${formatMoneyCents(bank.amount_due)}` : "";
  return `A bank payment${amount} from ${card} is on its way through Stripe${started(bank?.processing_at, timeZone)}. It usually clears in a few business days and shows up here when it does. Record any other payment once it clears or bounces.`;
}

/** " (started Oct 3)", the day where the company is, or nothing when it isn't known. */
const started = (at: string | null | undefined, timeZone: string) =>
  at ? ` (started ${new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone })})` : "";

/**
 * How a payment's amount reads in the invoice's payments. One that's only a tip (the client's
 * credit in Stripe paid the invoice, so Stripe charged just the tip they added), or the refund of
 * one, is the tip: "Tip $15.00". `back` when money went back to the client.
 */
export function paymentAmount(p: { amount: number; tip_amount: number }): { amount: string; tip: string | null; back: boolean } {
  const amount = Number(p.amount);
  const tip = Number(p.tip_amount);
  if (!amount) return { amount: `Tip ${formatMoneyCents(tip)}`, tip: null, back: tip < 0 };
  return { amount: formatMoneyCents(amount), tip: tip > 0 ? `+ ${formatMoneyCents(tip)} tip` : null, back: amount < 0 };
}
