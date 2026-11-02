/**
 * Autopay (docs/autopay-plan.md): a client saves a card or bank account once, agrees to be charged,
 * and each finished visit (or a one-off job's finished work) is billed and charged to it on the
 * server, after the company's wait. The rules live in Postgres
 * (supabase/migrations/20261031000100_autopay.sql); these are their words and their defaults, so
 * the screens, the emails and the database say the same thing: the company's settings with the
 * starter terms filled in, a saved card's name ("Visa ending 4242"), when a charge goes, and the
 * one rule for tips.
 */
import { localDate, localTime, addDays } from "./time";

export type AutopayTiming = "now" | "end_of_day" | "days";

/** settings.autopay, as autopay_set_settings writes it (every key, always). */
export interface AutopaySettings {
  enabled: boolean;
  /** The words clients agree to. The timing sentence is shown (and stored with the agreement) after them. */
  terms: string;
  /** Changes when the terms, timing or days change: the client agrees to when they're charged as well as the words. */
  terms_version: string;
  timing: AutopayTiming;
  /** 1 to 14 with timing "days", else null. */
  days: number | null;
  /** Dollars; a charge over it waits for the office's OK. Null is no limit. */
  max_amount: number | null;
  /** Email a receipt after each automatic charge. */
  receipts: boolean;
  /** New recurring per-visit jobs of a client on autopay start with it on, and a client who agrees has theirs switched on. */
  jobs_default: boolean;
  /** Every client needs a card on file: a quote asks for one when it's signed, and the client's page and the office say so. */
  card_required: boolean;
  changed_at: string | null;
  changed_by: string | null;
}

/** The longest terms autopay_set_settings takes. */
export const AUTOPAY_TERMS_MAX = 4000;
/** The most days after a visit a charge can wait. Mirrors autopay_set_settings and private.autopay_due(). */
export const AUTOPAY_DAYS_MAX = 14;
/** The highest "most to charge without asking", in dollars. Mirrors autopay_set_settings. */
export const AUTOPAY_MAX_AMOUNT = 1_000_000;
/** The cap a company starts with, in dollars. */
export const AUTOPAY_DEFAULT_MAX = 500;

/** The choices for when to charge, as Settings → Payments lists them. */
export const AUTOPAY_TIMINGS: Array<{ value: AutopayTiming; label: string }> = [
  { value: "now", label: "Right away" },
  { value: "end_of_day", label: "At the end of the day" },
  { value: "days", label: "Days after" },
];

/** The two job types autopay charges (autopay_job_guard holds to the same). */
export const autopayAllowed = (kind: string | null | undefined, billingMode: string | null | undefined) =>
  (kind === "recurring" && billingMode === "per_visit") || (kind === "one_off" && billingMode === "on_completion");

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

const TURN_OFF = "Turn it off anytime from your client page or by calling us.";
/** The office can charge the card for any invoice too (Charge card), so every trade's terms say so. */
const OTHER_INVOICES = "and for other invoices we send you";

/**
 * The starter terms for each trade (private.autopay_starter_terms has the same words). Paving and
 * roofing charge for big jobs, so theirs talk about the agreed amount.
 */
const STARTER_TERMS: Record<string, string> = {
  lawn_exterior: `We charge the card on file after each visit is done, ${OTHER_INVOICES}. You'll get a receipt each time. ${TURN_OFF}`,
  general: `We charge the card on file when each visit or job is done, ${OTHER_INVOICES}. You'll get a receipt each time. ${TURN_OFF}`,
  paving: `We charge the card on file when the work on your job is done, ${OTHER_INVOICES}. Charges over the amount we agreed wait until we've talked with you. You'll get a receipt each time. ${TURN_OFF}`,
  roofing_exteriors: `We charge the card on file when the work on your job is done, ${OTHER_INVOICES}. Charges over the amount we agreed wait until we've talked with you. You'll get a receipt each time. ${TURN_OFF}`,
};

/** The starter terms for a trade (docs/autopay-plan.md). A trade we don't know gets the general one. */
export function starterAutopayTerms(trade?: string | null): string {
  return (trade && STARTER_TERMS[trade]) || STARTER_TERMS.general!;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Days after a visit, read as private.autopay_due() reads them: a number, rounded and kept within
 * 1 to 14, else 1. So a page never says "0 days after" when the database charges after one.
 */
function daysOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(AUTOPAY_DAYS_MAX, Math.max(1, Math.round(value)));
}

/**
 * settings.autopay with the defaults filled in (never throws). Takes the company's whole settings
 * (companies.settings); a company that never turned autopay on gets its trade's starter terms, the
 * end of the day, a $500 cap and receipts, with autopay off.
 */
export function autopaySettings(settings: unknown, trade?: string | null): AutopaySettings {
  const a = isObject(settings) && isObject(settings.autopay) ? settings.autopay : {};
  const timing: AutopayTiming = a.timing === "now" || a.timing === "days" || a.timing === "end_of_day" ? a.timing : "end_of_day";
  const terms = typeof a.terms === "string" && a.terms.trim() ? a.terms.slice(0, AUTOPAY_TERMS_MAX) : starterAutopayTerms(trade);
  const cap = a.max_amount;
  return {
    enabled: a.enabled === true,
    terms,
    terms_version: typeof a.terms_version === "string" && a.terms_version ? a.terms_version : `starter-${trade || "general"}-1`,
    timing,
    days: timing === "days" ? daysOf(a.days) : null,
    // Null is "no limit" only when it was saved that way; a missing or broken cap is the starter one.
    max_amount: "max_amount" in a && cap === null ? null
      : typeof cap === "number" && Number.isFinite(cap) && cap > 0 && cap <= AUTOPAY_MAX_AMOUNT ? cap : AUTOPAY_DEFAULT_MAX,
    receipts: typeof a.receipts === "boolean" ? a.receipts : true,
    jobs_default: typeof a.jobs_default === "boolean" ? a.jobs_default : trade === "lawn_exterior",
    card_required: a.card_required === true,
    changed_at: typeof a.changed_at === "string" ? a.changed_at : null,
    changed_by: typeof a.changed_by === "string" ? a.changed_by : null,
  };
}

/**
 * The one rule for tips: the company has them on (settings.hub_tips, Settings → Company), and the
 * invoice wasn't made in Stripe. The Pay screen, the receipt, the tip on a saved card and the
 * server's checks all ask this.
 */
export const tipsAllowed = (hubTips: unknown, imported: boolean) => hubTips === true && !imported;

// ---------------------------------------------------------------------------------------------
// Saved cards and bank accounts
// ---------------------------------------------------------------------------------------------

/** Card brands Postgres's initcap would spell differently from how people write them. */
const BRANDS: Record<string, string> = { amex: "American Express", mastercard: "Mastercard" };

/** Postgres's initcap(): the first letter of each run of letters and digits upper case, the rest lower. */
function initcap(value: string): string {
  return value.toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (_, before: string, letter: string) => before + letter.toUpperCase());
}

/** " ending 4242", or nothing when the last four aren't known. */
const ending = (last4: string | null | undefined) => (last4 ? ` ending ${last4}` : "");

/**
 * "Visa ending 4242", "Chase ending 6789", "Link". Same words as private.method_label in SQL. A
 * wallet (Apple Pay) saves the card underneath, so it reads as that card.
 */
export function methodLabel(m: { type: string; brand?: string | null; last4?: string | null; bank_name?: string | null; wallet?: string | null }): string {
  if (m.type === "card") {
    const brand = m.brand ? BRANDS[m.brand.toLowerCase()] ?? initcap(m.brand) : "Card";
    return `${brand}${ending(m.last4)}`;
  }
  if (m.type === "us_bank_account") return `${m.bank_name || "Bank account"}${ending(m.last4)}`;
  if (m.type === "link") return "Link";
  return `${initcap((m.type || "payment method").replace(/_/g, " "))}${ending(m.last4)}`;
}

/** "08/28", or null. */
export function methodExpiry(m: { exp_month?: number | null; exp_year?: number | null }): string | null {
  if (m.exp_month == null || m.exp_year == null) return null;
  return `${String(m.exp_month).padStart(2, "0")}/${String(m.exp_year).slice(-2)}`;
}

// ---------------------------------------------------------------------------------------------
// When a charge goes
// ---------------------------------------------------------------------------------------------

/**
 * "right after each visit" | "at the end of the day of each visit" | "2 days after each visit".
 * The same words as private.autopay_terms_shown's "We charge ..." sentence (tested on both sides).
 */
export function autopayTimingText(s: Pick<AutopaySettings, "timing" | "days">): string {
  if (s.timing === "now") return "right after each visit";
  if (s.timing === "days") {
    const days = daysOf(s.days);
    return `${days} ${days === 1 ? "day" : "days"} after each visit`;
  }
  return "at the end of the day of each visit";
}

const MONTH_DAY = new Map<string, Intl.DateTimeFormat>();
/** "Nov 3" in a time zone. */
function monthDay(at: Date, timeZone: string): string {
  let f = MONTH_DAY.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });
    MONTH_DAY.set(timeZone, f);
  }
  return f.format(at);
}

/**
 * When a waiting charge goes: "right away", "tonight", "tomorrow night", "on Nov 3", in the company's
 * time zone. A charge due at local midnight (the end of the day, private.autopay_due) goes on the
 * night before it; one due at another time (a retry 3 days on) is "today", "tomorrow" or its date.
 */
export function autopayDueText(dueAt: string, timeZone: string, now: Date = new Date()): string {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime()) || due.getTime() <= now.getTime()) return "right away";
  const today = localDate(now, timeZone);
  const day = localDate(due, timeZone);
  if (localTime(due, timeZone) === "00:00") {
    const night = addDays(day, -1);
    if (night === today) return "tonight";
    if (night === addDays(today, 1)) return "tomorrow night";
  } else {
    if (day === today) return "today";
    if (day === addDays(today, 1)) return "tomorrow";
  }
  return `on ${monthDay(due, timeZone)}`;
}

// ---------------------------------------------------------------------------------------------
// Office words
// ---------------------------------------------------------------------------------------------

/** Office words for a charge's status (two words at most). */
export const AUTOPAY_STATUS_TEXT: Record<string, string> = {
  waiting: "Waiting",
  needs_approval: "Needs your OK",
  charging: "Charging",
  processing: "On its way",
  paid: "Paid",
  failed: "Failed",
  needs_client: "Needs client",
  called_off: "Called off",
};
