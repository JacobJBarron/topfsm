/**
 * Promo codes on recurring work (supabase/migrations/20261031000600_promo_once_per_job.sql): a code
 * comes off once per job, on its first invoice, unless it's set to come off every visit. The words
 * the screens use for it: Marketing → Promo codes, a quote's discount line, and the job page.
 */
import { lineTotal, toCents } from "./money";

/** How a promo code's discount comes off a job's invoices (job_line_items.discount_billing). */
export type DiscountBilling = "once" | "every_visit";

/** A job's promo discount as public.job_promo_discounts gives it. Placed, left and invoices are null without the Invoices area. */
export interface JobDiscount {
  key: string;
  name: string;
  billing: DiscountBilling;
  amount: number;
  placed: number | null;
  left: number | null;
  invoices: Array<{ id: string; number: number | null; amount: number }> | null;
}

/** A sentence in parts, so a screen can link each invoice ("#12"). */
export type Words = Array<string | { invoice: { id: string; number: number | null } }>;

const money = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
const cents = (amount: number | string | null | undefined) => Math.round(Number(amount ?? 0) * 100);

/** After the code on a quote: what it comes to on work that repeats. */
export const promoRuleWords = (everyVisit: boolean) => (everyVisit ? "off every visit" : "one-time discount");

/**
 * Whether a quote's code comes off every visit (true) or once (false), for its discount line, or null
 * when there's nothing to say. Once the client approves it, the rule it was approved with
 * (quotes.promo_every_visit): a signed quote keeps its words, whatever its code or job does later.
 * Before then, the code's own setting. A quote approved before quotes said this says nothing.
 */
export function quotePromoRule(quote: { status: string; promo_every_visit?: boolean | null; promo?: { every_visit?: boolean | null } | null }): boolean | null {
  if (!quote.promo) return null;
  if (quote.promo_every_visit != null) return quote.promo_every_visit;
  if (quote.status === "approved" || quote.status === "converted") return null;
  return quote.promo.every_visit ?? null;
}

/** The code in a promo discount line's name ("Promo code WEEKLY25"), or null for another discount. */
export function promoCodeOf(name: string): string | null {
  const match = /^Promo code (\S+)$/.exec(name.trim());
  return match ? match[1]! : null;
}

/** "a $25 code" with the code's own value, or $25 (10% for a percent code) until one is typed. */
function valueWords(kind: string, value: number | string | null | undefined): string {
  const n = Number(value);
  if (kind === "percent") return n > 0 && n <= 100 ? `${Number(n.toFixed(2))}%` : "10%";
  if (!(n > 0)) return "$25";
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : money(n);
}

/**
 * Under Marketing → Promo codes' switch: what each choice does, with the code's own value, so the form
 * says both whichever way the switch is.
 */
export function repeatChoices(kind: string, value: number | string | null | undefined): { once: string; everyVisit: string } {
  const v = valueWords(kind, value);
  return {
    once: `Comes off once per job. On weekly mowing, a ${v} code takes ${v} off the first mowing's invoice, and later mowings are full price.`,
    everyVisit: `Comes off every visit's invoice. On weekly mowing, a ${v} code takes ${v} off every mowing.`,
  };
}

/** "#3", "#3 and #4", "#3, #4 and #5", each a link. */
function invoiceList(invoices: ReadonlyArray<{ id: string; number: number | null }>): Words {
  const out: Words = [invoices.length === 1 ? "invoice " : "invoices "];
  invoices.forEach((inv, i) => {
    if (i > 0) out.push(i === invoices.length - 1 ? " and " : ", ");
    out.push({ invoice: { id: inv.id, number: inv.number } });
  });
  return out;
}

/**
 * The job page's note on one discount: the rule after its name ("comes off the first invoice only."),
 * then, for the office with the Invoices area, where it went: "It's on invoice #12.", "$15.00 is on
 * invoice #12, and $10.00 goes on the next invoice." or "It goes on the next invoice you make." A
 * once-per-job code on more invoices than it comes to was put there while it came off every visit
 * (before codes were once per job, or before the code or the job was switched), which it says.
 */
export function jobDiscountWords(d: JobDiscount): { rule: string; where: Words | null } {
  if (d.billing === "every_visit") return { rule: "comes off every visit.", where: null };
  const rule = "comes off the first invoice only.";
  if (d.placed === null || d.invoices === null) return { rule, where: null };
  const invoices = d.invoices.filter((inv) => cents(inv.amount) > 0);
  const left = cents(d.left);
  if (!invoices.length) return { rule, where: ["It goes on the next invoice you make."] };
  const end = cents(d.placed) > cents(d.amount) ? ", made while it came off every visit. Later invoices don't take it." : ".";
  const whole = invoices.every((inv) => cents(inv.amount) >= cents(d.amount));
  if (left <= 0 && whole) return { rule, where: ["It's on ", ...invoiceList(invoices), end] };
  const where: Words = [];
  invoices.forEach((inv, i) => {
    if (i > 0) where.push(i === invoices.length - 1 && left <= 0 ? " and " : ", ");
    where.push(`${money(cents(inv.amount) / 100)} ${i === 0 ? "is " : ""}on invoice `, { invoice: { id: inv.id, number: inv.number } });
  });
  where.push(left > 0 ? `, and ${money(left / 100)} goes on the next invoice.` : end);
  return { rule, where };
}

/** Words as plain text, invoices as "#12". */
export const wordsText = (words: Words) => words.map((w) => (typeof w === "string" ? w : `#${w.invoice.number ?? ""}`)).join("");

/**
 * Where a once-per-job discount went when an invoice gave it up, from the job's discounts just before
 * and after (public.job_promo_discounts): the invoices that hold more of it now ("WEEKLY25 moved to
 * invoice #12."), or, while some is still to go, that it waits for the next invoice. Null when it
 * didn't move, or the person can't see where it went.
 */
function movedWords(was: JobDiscount | null, now: JobDiscount | null, invoiceId: string): { moved: string } | { waits: string } | null {
  if (!now || now.invoices === null || now.left === null) return null;
  const code = promoCodeOf(now.name) ?? "The discount";
  if (was?.invoices) {
    const had = new Map(was.invoices.map((inv) => [inv.id, cents(inv.amount)]));
    const moved = now.invoices.filter((inv) => inv.id !== invoiceId && cents(inv.amount) > (had.get(inv.id) ?? 0));
    if (moved.length) return { moved: `${code} moved to ${wordsText(invoiceList(moved))}.` };
  }
  return cents(now.left) > 0 ? { waits: `${code} goes on the job's next invoice.` } : null;
}

/**
 * What the toast says when a job's promo line is taken off a draft, from the job's discounts just
 * before and after (public.job_promo_discounts) and the draft's lines left: an every-visit code is off
 * this invoice only, unless more of it is still on it (a visits invoice has a copy for every visit,
 * and a code can have a taxed and an untaxed part); a once-per-job code names the invoice it moved
 * to, or on work that repeats says it waits for the next invoice and how to drop it. Null when there's
 * no more to say (the draft still takes it off, other invoices have it already, a one-off job has no
 * next invoice, or the person can't see where it went): the toast names the line.
 */
export function removedPromoWords(
  key: string,
  invoiceId: string,
  before: readonly JobDiscount[] | null,
  after: readonly JobDiscount[] | null,
  repeats: boolean,
  rest: ReadonlyArray<{ discount_quote_id?: string | null; quantity: number | string; unit_price: number | string }> = [],
): string | null {
  const was = before?.find((d) => d.key === key) ?? null;
  const now = after?.find((d) => d.key === key) ?? null;
  const d = now ?? was;
  if (!d) return null;
  const code = promoCodeOf(d.name) ?? "The discount";
  if (d.billing === "every_visit") {
    // A $0 copy (cut back so the draft isn't below $0) takes nothing off.
    if (rest.some((l) => l.discount_quote_id === key && lineTotal(l.quantity, l.unit_price) < 0)) return null;
    return `${code} is off this invoice only.${repeats ? " Later visits still get it." : ""}`;
  }
  const went = movedWords(was, now, invoiceId);
  if (!went) return null;
  if ("moved" in went) return went.moved;
  return repeats ? `${went.waits} To drop it, remove it from the job's line items.` : null;
}

/** The once-per-job discounts an invoice holds that voiding or deleting it would give back: what the job's other invoices don't make up. */
function givenBack(invoiceId: string, discounts: readonly JobDiscount[] | null): JobDiscount[] {
  return (discounts ?? []).filter((d) => {
    if (d.billing !== "once" || d.placed === null || !d.invoices) return false;
    const here = cents(d.invoices.find((inv) => inv.id === invoiceId)?.amount);
    return here > 0 && cents(d.amount) - (cents(d.placed) - here) > 0;
  });
}

/** In the question before voiding or deleting an invoice: "The WEEKLY25 discount goes on the job's next invoice." Null when it holds none to give back. */
export function givenBackWords(invoiceId: string, discounts: readonly JobDiscount[] | null): string | null {
  const back = givenBack(invoiceId, discounts);
  if (!back.length) return null;
  if (back.length > 1) return "Its promo code discounts go on the job's next invoice.";
  const code = promoCodeOf(back[0]!.name);
  return code ? `The ${code} discount goes on the job's next invoice.` : "Its one-time discount goes on the job's next invoice.";
}

/**
 * The toast after an invoice is voided or deleted, from the job's discounts just before and after:
 * where each once-per-job discount it gave back went ("WEEKLY25 moved to invoice #12."), or that it
 * goes on the job's next invoice. Null when it gave none back.
 */
export function goneInvoiceWords(invoiceId: string, before: readonly JobDiscount[] | null, after: readonly JobDiscount[] | null): string | null {
  const said = givenBack(invoiceId, before)
    .map((d) => movedWords(d, after?.find((a) => a.key === d.key) ?? null, invoiceId))
    .map((went) => (went ? ("moved" in went ? went.moved : went.waits) : null))
    .filter((w): w is string => Boolean(w));
  return said.length ? said.join(" ") : null;
}

/**
 * Under a recurring job's Contract, which still counts a once-per-job discount whole: "Includes the
 * one-time WEEKLY25 discount". Null when the job has none.
 */
export function contractDiscountNote(lines: ReadonlyArray<{ name: string; discount_billing?: string | null }>): string | null {
  const once = lines.filter((l) => l.discount_billing === "once");
  const names = [...new Set(once.map((l) => promoCodeOf(l.name) ?? ""))];
  if (!names.length) return null;
  if (names.length > 1) return "Includes one-time discounts";
  return names[0] ? `Includes the one-time ${names[0]} discount` : "Includes a one-time discount";
}

/**
 * What a visit of a recurring job costs: its contract total (every line, public.job_financials) with
 * the once-per-job discounts put back, as they come off the first invoice only. Weekly mowing at $45
 * with a $25 once-per-job code is $45.00 a visit, where the job's Contract is $20.00 and says it
 * includes the one-time discount (contractDiscountNote). Every-visit discounts stay off.
 */
export function visitPrice(
  contractTotal: number | string | null | undefined,
  lines: ReadonlyArray<{ quantity: number | string; unit_price: number | string; discount_billing?: string | null }>,
): number {
  const once = lines.filter((l) => l.discount_billing === "once").reduce((s, l) => s + toCents(lineTotal(l.quantity, l.unit_price)), 0);
  return (toCents(contractTotal) - once) / 100;
}
