/**
 * When referral credits on an invoice can change, as the database allows it (remove_referral_credit,
 * apply_referral_credit and private.referral_credit_room): while the invoice is a draft, awaiting
 * payment or past due, with no payments, and Stripe isn't billing it as it is (made in Stripe, or a
 * bank payment on its way). A deposit or a retainage release doesn't take one.
 */

export interface CreditInvoice {
  status: string;
  kind?: string | null;
  payments: readonly unknown[];
  stripe?: ReadonlyArray<{ origin: string; status: string }> | null;
}

/** A credit on it can be taken off. */
export const creditsChangeable = (inv: CreditInvoice) =>
  ["draft", "sent", "overdue"].includes(inv.status) && inv.payments.length === 0 && !(inv.stripe ?? []).some((s) => s.origin === "stripe" || s.status === "processing");

/** A credit can be put on it. */
export const takesCredit = (inv: CreditInvoice) => creditsChangeable(inv) && !["deposit", "retainage"].includes(inv.kind ?? "standard");

/** What's left of its charges after its discount and the credits on it, which is all the credit it can still take, in cents' accuracy. */
export const creditRoom = (inv: { subtotal: number | string; discount_amount: number | string; credit_amount: number | string }) => {
  const subtotal = Number(inv.subtotal);
  const room = subtotal - Math.min(Number(inv.discount_amount), Math.max(subtotal, 0)) - Number(inv.credit_amount);
  return Math.max(Math.round(room * 100) / 100, 0);
};

/** "QuickBooks" for an invoice already in an accounting app, which a credit put on by hand doesn't reach. */
export const BOOKS: Record<string, string> = { quickbooks: "QuickBooks", zoho_books: "Zoho Books" };

/**
 * What a paid invoice's callout says: paid in full (on the last payment's date), or, with nothing
 * paid, what settled it: a referral credit that covered it whole (what was owed, the credit paid),
 * or nothing to pay.
 */
export function paidWords(amountPaid: number, credit: number, lastPaidOn: string | null): string {
  if (amountPaid <= 0 && credit > 0) return "Covered by a referral credit.";
  if (amountPaid <= 0) return "Nothing to pay.";
  return `Paid in full${lastPaidOn ? ` on ${lastPaidOn}` : ""}.`;
}
