/**
 * Stripe over its REST API (no SDK, so it runs anywhere). Every request pins an API version, so
 * the objects we read have the same shape whatever the account's default version is; the webhook
 * endpoints we create are pinned to it too. Amounts are in cents, as Stripe sends them.
 *
 * The rest of this file turns invoices into Stripe line items and back. It's pure, so it's tested
 * directly (apps/api/test/stripe.test.ts).
 */
import { taxPercent } from "@crewtavo/core";
import { providerTimeout } from "../integrations/registry";
import { hmacSha256Hex, safeEqual } from "../lib/crypto";

export const STRIPE_VERSION = "2024-06-20";

/**
 * What Stripe said went wrong. A declined card also says why (`declineCode`), and an error from
 * paying an invoice names its PaymentIntent and how far it got (`paymentIntentStatus`), which is
 * how a charge that needs the client to confirm it is told from one that was declined.
 */
export class StripeError extends Error {
  override name = "StripeError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly param?: string,
    readonly declineCode?: string,
    readonly type?: string,
    readonly paymentIntent?: string,
    readonly paymentIntentStatus?: string,
  ) {
    super(message);
  }
}

type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

/** Stripe's form encoding: nested objects as a[b]=1 and arrays as a[0]=x. Empty values are left out. */
export function stripeForm(params: Record<string, Param>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) stripeForm(item, `${name}[${i}]`, out);
        else if (item !== undefined && item !== null) out.append(`${name}[${i}]`, String(item));
      });
    } else if (typeof value === "object") stripeForm(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

/**
 * One API call, given up on after the time other providers get. Rate limits, Stripe's own errors
 * and no answer (or none in time) are retried twice for reads and for writes that carry an
 * idempotency key (Stripe replays the first result instead of doing it again). Other writes aren't
 * sent again, since Stripe may have done them anyway.
 */
export async function stripeApi<T>(
  key: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, Param> = {},
  options: { idempotencyKey?: string } = {},
): Promise<T> {
  const form = stripeForm(params).toString();
  const url = `https://api.stripe.com${path}${method !== "POST" && form ? `?${form}` : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  const repeatable = method === "GET" || Boolean(options.idempotencyKey);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, { method, headers, body: method === "POST" ? form : undefined, signal: providerTimeout() });
      text = await response.text();
    } catch (error) {
      // Stripe couldn't be reached, or stopped answering partway: the same as Stripe being down.
      if (!repeatable || attempt >= 2) throw new StripeError(`Stripe didn't answer (${error instanceof Error ? error.message : String(error)})`, 0);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    const json = readJson(text) as {
      error?: { message?: string; code?: string; param?: string; decline_code?: string; type?: string; payment_intent?: { id?: string; status?: string } | null };
    };
    if (response.ok) return json as T;
    const retry = (response.status === 429 || response.status >= 500) && attempt < 2 && repeatable;
    if (!retry) {
      const e = json.error;
      throw new StripeError(e?.message ?? `Stripe returned ${response.status}`, response.status, e?.code, e?.param, e?.decline_code, e?.type, e?.payment_intent?.id, e?.payment_intent?.status);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}

/** A body that isn't JSON (a proxy's error page, say) reads as empty. */
function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Every item of a list endpoint, 100 at a time. */
export async function* stripeList<T extends { id: string }>(key: string, path: string, params: Record<string, Param> = {}): AsyncGenerator<T> {
  let after: string | undefined;
  for (;;) {
    const page = await stripeApi<{ data: T[]; has_more: boolean }>(key, "GET", path, { ...params, limit: 100, starting_after: after });
    yield* page.data;
    if (!page.has_more || !page.data.length) return;
    after = page.data.at(-1)!.id;
  }
}

/** Verify a Stripe-Signature header (t=..., v1=...) and a 5-minute tolerance. */
export async function verifyStripeSignature(payload: string, header: string | undefined, secret: string, toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  const signatures = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((sig) => safeEqual(sig, expected));
}

// ---------------------------------------------------------------------------------------------
// The objects we read (API version 2024-06-20; only the fields we use)
// ---------------------------------------------------------------------------------------------

export interface StripeEvent {
  id: string;
  type: string;
  /** When it happened (seconds). */
  created?: number;
  data: { object: Record<string, any> };
}

export interface StripeAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

export interface StripeBalanceTransaction {
  id: string;
  type: string;
  amount: number;
  fee: number;
  net: number;
  source: string | { id: string; object: string; payment_intent?: string | null; charge?: string | null } | null;
}

export interface StripeCharge {
  id: string;
  object: "charge";
  payment_intent: string | null;
  amount_refunded: number;
  payment_method_details: { type?: string } | null;
  balance_transaction: string | StripeBalanceTransaction | null;
}

export interface StripeInvoiceLine {
  id: string;
  amount: number;
  description: string | null;
  quantity: number | null;
}

export interface StripeInvoice {
  id: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  number: string | null;
  livemode: boolean;
  customer: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: StripeAddress | null;
  hosted_invoice_url: string | null;
  description: string | null;
  currency: string;
  total: number;
  amount_due: number;
  amount_paid: number;
  /** The customer's balance in Stripe when it was finalized: credit (negative) or owed from before. */
  starting_balance: number;
  /** Credit notes issued while it was open, which took that much off amount_due. */
  pre_payment_credit_notes_amount: number;
  tax: number | null;
  total_discount_amounts: Array<{ amount: number }> | null;
  due_date: number | null;
  created: number;
  paid_out_of_band: boolean;
  /**
   * Always the id: recordPayment keeps it as the payment's processor_ref, which refunds and
   * disputes match on. Never expand it.
   */
  payment_intent: string | null;
  charge: string | StripeCharge | null;
  metadata: Record<string, string> | null;
  status_transitions: { finalized_at: number | null; paid_at: number | null; marked_uncollectible_at?: number | null };
  lines: { data: StripeInvoiceLine[]; has_more: boolean };
  /** send_invoice: the client pays it on Stripe's page. charge_automatically: autopay charges the saved method. */
  collection_method: "send_invoice" | "charge_automatically";
  default_payment_method: string | null;
}

/** How far a payment got (an invoice's, read when paying it leaves it open). */
export interface StripePaymentIntent {
  id: string;
  status: "requires_payment_method" | "requires_confirmation" | "requires_action" | "processing" | "requires_capture" | "canceled" | "succeeded";
  last_payment_error: { code?: string | null; decline_code?: string | null; message?: string | null } | null;
}

/** A card or bank account saved with a Stripe customer. */
export interface StripePaymentMethod {
  id: string;
  type: string;
  customer: string | null;
  livemode: boolean;
  card?: {
    brand: string | null;
    last4: string | null;
    exp_month: number | null;
    exp_year: number | null;
    wallet?: { type: string } | null;
    checks?: { cvc_check: string | null; address_postal_code_check: string | null } | null;
  } | null;
  us_bank_account?: { bank_name: string | null; last4: string | null } | null;
  link?: Record<string, unknown> | null;
}

/** Saving a payment method for later: what Checkout's setup mode makes. */
export interface StripeSetupIntent {
  id: string;
  status: "requires_payment_method" | "requires_confirmation" | "requires_action" | "processing" | "canceled" | "succeeded";
  customer: string | null;
  payment_method: string | StripePaymentMethod | null;
  metadata: Record<string, string> | null;
  /** Why it failed; a bank account that failed verification is named here, no longer on payment_method. */
  last_setup_error: { code?: string | null; message?: string | null; payment_method?: { id: string } | null } | null;
}

/** Stripe's hosted page (setup mode, for autopay). */
export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  mode: "payment" | "setup" | "subscription";
  status: "open" | "complete" | "expired" | null;
  customer: string | null;
  setup_intent: string | StripeSetupIntent | null;
  metadata: Record<string, string> | null;
}

export interface StripeRefund {
  id: string;
  amount: number;
  charge: string | null;
  payment_intent: string | null;
  status: string;
}

export interface StripePayout {
  id: string;
  amount: number;
  currency: string;
  arrival_date: number;
  status: "pending" | "in_transit" | "paid" | "failed" | "canceled";
  automatic: boolean;
  failure_message: string | null;
}

// ---------------------------------------------------------------------------------------------
// Money in both directions
// ---------------------------------------------------------------------------------------------

/** Dollars (numeric columns arrive as numbers or strings) to cents. */
export const cents = (amount: number | string | null | undefined) => Math.round(Number(amount ?? 0) * 100);

/**
 * The least Stripe charges, in cents (50 in most currencies). Stripe marks an invoice for less as
 * paid without charging anything, and adds the amount to the customer's next invoice there.
 */
const MINIMUM_CHARGE: Record<string, number> = { aed: 200, bgn: 100, czk: 1500, dkk: 250, gbp: 30, hkd: 400, huf: 17500, mxn: 1000, myr: 200, nok: 300, pln: 200, ron: 200, sek: 300, thb: 1000 };
export const minimumCharge = (currency: string) => MINIMUM_CHARGE[currency.toLowerCase()] ?? 50;

/** How the client paid, in our payment methods. */
export function paymentMethod(charge: StripeCharge | null | undefined): "card" | "ach" | "other" {
  const type = charge?.payment_method_details?.type;
  if (type === "us_bank_account" || type === "ach_debit" || type === "ach_credit_transfer") return "ach";
  if (type === "card" || type === "card_present" || type === "link") return "card";
  return type ? "other" : "card";
}

/** The charge and its fee, when the invoice was fetched with expand[]=charge.balance_transaction. */
export function chargeOf(invoice: Pick<StripeInvoice, "charge">): { charge: StripeCharge | null; fee: number } {
  const charge = invoice.charge && typeof invoice.charge === "object" ? invoice.charge : null;
  const bt = charge?.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  return { charge, fee: bt?.fee ?? 0 };
}

export interface BillableInvoice {
  number: number | null;
  subject: string | null;
  subtotal: number;
  discount_amount: number;
  tax_rate: number;
  tax_amount: number;
  retainage_pct: number;
  retainage_amount: number;
  amount_paid: number;
  balance_due: number;
  promo?: { code: string } | null;
  lines: Array<{ name: string; quantity: number; unit: string; unit_price: number; sort: number }>;
}

/** Past this many lines, the Stripe invoice gets one summary line instead (each line is an API call). */
const MAX_LINES = 20;

/**
 * A Crewtavo invoice as Stripe invoice items. They add up to exactly what's owed plus the tip:
 * the lines, then the discount, tax, retainage held back and what was already paid, so the client
 * sees the same arithmetic in Stripe as in the Client Hub.
 */
export function stripeLineItems(invoice: BillableInvoice, tipCents = 0, currency = "USD"): Array<{ description: string; amount: number }> {
  const items: Array<{ description: string; amount: number }> = [];
  const lines = [...invoice.lines].sort((a, b) => a.sort - b.sort);
  if (lines.length <= MAX_LINES) {
    for (const line of lines) {
      const quantity = Number(line.quantity);
      const amount = cents(Math.round(quantity * Number(line.unit_price) * 100) / 100);
      if (!amount) continue;
      const each = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(line.unit_price));
      items.push({ description: (quantity === 1 ? line.name : `${line.name} (${quantity.toLocaleString("en-US")} ${line.unit} × ${each})`).slice(0, 500), amount });
    }
  } else if (cents(invoice.subtotal)) {
    items.push({ description: `Invoice #${invoice.number}${invoice.subject ? `: ${invoice.subject}` : ""} (${lines.length} items)`.slice(0, 500), amount: cents(invoice.subtotal) });
  }
  const discount = Math.min(Number(invoice.discount_amount), Math.max(Number(invoice.subtotal), 0));
  if (discount > 0) items.push({ description: invoice.promo?.code ? `Discount (${invoice.promo.code})` : "Discount", amount: -cents(discount) });
  if (cents(invoice.tax_amount)) items.push({ description: `Tax (${taxPercent(invoice.tax_rate)}%)`, amount: cents(invoice.tax_amount) });
  if (cents(invoice.retainage_amount)) items.push({ description: `Retainage held (${Number(invoice.retainage_pct)}%), billed later`, amount: -cents(invoice.retainage_amount) });
  if (cents(invoice.amount_paid)) items.push({ description: "Already paid", amount: -cents(invoice.amount_paid) });
  if (tipCents > 0) items.push({ description: "Tip for the crew", amount: tipCents });
  const off = cents(invoice.balance_due) + tipCents - items.reduce((sum, item) => sum + item.amount, 0);
  if (off) items.push({ description: "Rounding", amount: off });
  return items;
}

/**
 * A Stripe invoice's lines as Crewtavo line items that add up to what Stripe says is due: its
 * lines, then a line for discounts and tax, then one for account credit or an earlier balance.
 */
export function importedLines(invoice: Pick<StripeInvoice, "total" | "amount_due" | "tax" | "total_discount_amounts">, lines: StripeInvoiceLine[]) {
  const out = lines.map((line) => {
    const quantity = line.quantity && line.quantity > 1 && Number.isInteger(line.quantity) && line.amount % line.quantity === 0 ? line.quantity : 1;
    return { name: (line.description?.trim() || "Item").slice(0, 300), quantity, unit_price: line.amount / quantity / 100 };
  });
  const adjust = invoice.total - lines.reduce((sum, line) => sum + line.amount, 0);
  if (adjust) {
    const discount = (invoice.total_discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0);
    const tax = invoice.tax ?? 0;
    out.push({ name: discount && !tax ? "Discount" : tax && !discount ? "Tax" : "Discounts and tax", quantity: 1, unit_price: adjust / 100 });
  }
  const balance = invoice.amount_due - invoice.total;
  if (balance) out.push({ name: balance < 0 ? "Account credit applied" : "Earlier balance", quantity: 1, unit_price: balance / 100 });
  return out;
}

/** A Stripe timestamp as a date in the company's time zone. */
export function stripeDay(seconds: number, timeZone: string): string {
  return new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone });
}
