/**
 * What a Client Hub link loads (GET /api/hub/:token), and the estimate or invoice document built
 * from it: the business's template (EstimateDocument) is what prints, and what a signed estimate
 * shows. Quotes go through the same builder as the office and the iPad (documents/build.ts), so a
 * client's copy matches theirs. Also the steps of an open quote (choose an option, review the
 * agreement, sign), the contract filled in for the option picked, and the words the price range
 * page shows. No React here, so it's tested on its own.
 */
import type { ContractInput, LibrarySection } from "@crewtavo/core/contracts";
import { documentColor, templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { SITE_ADJUSTMENT_NAME } from "@crewtavo/core/estimates";
import { normalizePitch, pitchFactor } from "@crewtavo/core/geo";
import { chosenTotals, lineTotal, optionLabels, toCents, type Amount } from "@crewtavo/core/money";
import { dateIn, formatMoney, formatMoneyCents, formatNumber } from "@/lib/format";
import {
  hasContract,
  inkOn,
  invoiceDocument as buildInvoiceDocument,
  keptContract,
  licenseLine,
  liveContract,
  quoteDate,
  quoteDocument as buildQuoteDocument,
  type ApprovalContract,
  type ApprovalOption,
  type QuoteContract,
} from "../documents/build";
import type { DocumentCompany, DocumentData } from "../documents/types";

export interface HubLine {
  id?: string;
  /** The option it's on; null for a line on every option (and on a quote without options). */
  option_id?: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  taxable?: boolean;
  optional?: boolean;
  selected?: boolean;
  /** Optional lines that share a group are one choice (Good, Better, Best): the client picks one. */
  option_group?: string | null;
}
export interface HubCompany {
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  timezone?: string | null;
  branding?: { color?: string } | null;
  logo?: string | null;
  /** The letterhead's address lines: the street, then "City, ST 12345". */
  address?: string[];
}
/** A map drawing the office chose to show the client, with the sizes measured on it. */
export interface HubDrawing {
  id: string;
  title: string;
  has_picture: boolean;
  sections: Array<{ label: string; kind: string; value: number; unit: string; pitch?: string }>;
  total_area_sqft: number;
  total_length_ft: number;
  roofing_squares: number | null;
  roof_pitch: string | null;
  imagery: string | null;
  /** When it was measured. Servers that don't send it get a page without the date. */
  measured_at?: string | null;
}
/** A promo code on the quote or invoice; `min_subtotal` is the order it needs (0: none). Older servers don't send it. */
export type HubPromoInfo = { code: string; kind: string; value: number; description: string | null; min_subtotal?: number | string | null } | null;
/** Who signed a quote. "manual": the office marked it approved, so nobody signed on the client's line. */
export interface HubApproval {
  name: string;
  signature: string | null;
  signed_at: string | null;
  method?: "manual" | "in_person" | null;
  company: { name: string; signature: string; signed_at: string | null } | null;
  /** The option they chose, the contract and their initials, as they signed them. */
  option?: ApprovalOption | null;
  contract?: ApprovalContract | null;
  initials?: { image: string; signed_at: string | null } | null;
}
/** A roof estimate sent as a price range: the range, what's in it and what could move it. */
export interface HubRange {
  low: number;
  high: number;
  sent_at: string | null;
  accepted_at: string | null;
  included: string[];
  maybe: Array<{ name: string; price: number; per: string | null }>;
}
/**
 * One of the options a quote offers, as the homeowner sees its card: a copy of the package it came
 * from. Signed, only the option chosen, as it was signed.
 */
export interface HubOption {
  id: string;
  name: string;
  /** "Good", "Better", "Best", or the business's own word. */
  tier: string | null;
  picture: { src: string; width: number; height: number } | null;
  style: string;
  highlights: string[];
  warranty: string;
  /** The contract sections its package brings (in `contract.library`). */
  section_ids: string[];
  sort: number;
  /** With the exact price: what it comes to with none of its add-ons; null while it has no price of its own. */
  total: number | null;
  /** With a price range: its own range; null when it has none (added after the range went out). */
  range: { low: number; high: number } | null;
}
/**
 * The fill-in facts that don't depend on the option, as the server will fill in the signed copy.
 * Without options, {Option} and {Warranty} say the package it was priced from (optionName, warranty).
 */
export type HubContractFacts = Pick<ContractInput, "customerName" | "businessName" | "businessPhone" | "license" | "estimateNumber" | "date" | "timeZone" | "deposit" | "optionName" | "warranty"> & {
  customerAddress: string[];
  jobAddress: string[];
};
/**
 * The contract on a quote. Open: the library's sections as written for whatever option is picked,
 * with the facts to fill them in (hubContract). Signed: the copy kept with the approval, filled in.
 */
export type HubContract =
  | { kind: "live"; terms: string; library: LibrarySection[]; template_sections: string[]; quote_sections: string[]; facts: HubContractFacts }
  | { kind: "signed"; terms: string; sections: ApprovalContract["sections"]; initials: { image: string; signed_at: string | null } | null };
export interface QuoteView {
  kind: "quote";
  drawings?: HubDrawing[];
  preview?: boolean;
  home: string | null;
  company: HubCompany;
  /** The estimate template (core documents.ts); read through templateSettings(). */
  template?: unknown;
  /** Null with a price range (it would say the price), and from servers before contracts. */
  contract?: HubContract | null;
  quote: {
    id: string;
    number: number;
    status: string;
    title: string;
    message: string | null;
    change_order_for?: string | null;
    /** Null while the quote is out as a price range: the exact price isn't sent. */
    subtotal?: number | null;
    discount_amount: number | null;
    promo: HubPromoInfo;
    tax_rate: number;
    tax_amount?: number | null;
    total?: number | null;
    deposit_amount: number | null;
    valid_until: string | null;
    sent_at?: string | null;
    created_at?: string | null;
    approved_at: string | null;
    client: { display_name: string } | null;
    property: { line1: string; city: string | null; region?: string | null; postal_code?: string | null } | null;
    package?: { name: string } | null;
    approval?: HubApproval | null;
    /** A price agreed at the visit is in effect, so a promo code can't go on it (the server says so too). */
    site_priced?: boolean;
    range?: HubRange | null;
    /** The option shown (signed: the one chosen); null without options. */
    option_id?: string | null;
    section_ids?: string[];
    /** The options it offers, in order; none without options. */
    options?: HubOption[];
    lines: HubLine[];
  };
}
export interface InvoiceView {
  kind: "invoice";
  drawings?: HubDrawing[];
  preview?: boolean;
  home: string | null;
  company: HubCompany;
  template?: unknown;
  /** The template's terms and its invoice sections, filled in by the server. */
  contract?: { terms: string; sections: Array<{ id: string; title: string; body: string; place: "signatures" | "terms"; initials: boolean }> } | null;
  can_pay: boolean;
  /** A bank payment through Stripe is on its way; asking again would charge twice. */
  processing?: boolean;
  /** Made in Stripe, so it's paid exactly as billed there (no promo codes). */
  from_stripe?: boolean;
  tips: boolean;
  invoice: {
    id: string;
    number: number;
    status: string;
    subject: string | null;
    notes: string | null;
    issued_on: string;
    due_on: string | null;
    subtotal: number;
    discount_amount: number;
    /** Referral credits (an older server sends none). */
    credit_amount?: number;
    credits?: Array<{ amount: number; note: string }>;
    tax_amount: number;
    total: number;
    retainage_amount: number;
    amount_paid: number;
    balance_due: number;
    promo: HubPromoInfo;
    client: { display_name: string } | null;
    lines: HubLine[];
    payments: Array<{ amount: number; tip_amount: number; received_at: string }>;
  };
}

/** The template a Hub page prints with: the business's, or the built-in look from an older server. */
export const hubTemplate = (view: { template?: unknown }): TemplateSettings => templateSettings(view.template);

/** The letterhead: the business as its clients see it. */
export function hubLetterhead(company: HubCompany): DocumentCompany {
  return {
    name: company.name,
    phone: company.phone?.trim() || null,
    email: company.email?.trim() || null,
    website: company.website?.trim() || null,
    address: company.address ?? [],
    logo: company.logo ?? null,
    settings: { branding: company.branding ?? null },
  };
}

// ---------------------------------------------------------------------------------------------
// An open quote: choose an option, review the agreement, sign
// ---------------------------------------------------------------------------------------------

/** The steps of an open quote. */
export type HubStep = "choose" | "review" | "sign";

/**
 * The steps an open quote takes: choosing, when it offers two or three options; reviewing the
 * agreement, when there's a contract to read (a section, or the template's terms); then signing.
 */
export function hubSteps(optionCount: number, contract: QuoteContract | null): HubStep[] {
  return [...(optionCount >= 2 ? (["choose"] as const) : []), ...(hasContract(contract) ? (["review"] as const) : []), "sign"];
}

/** The option picked when the page opens: the one the business shows first, while it has a price; with one option, that one. */
export function firstOption(view: QuoteView): string | null {
  const options = view.quote.options ?? [];
  if (options.length === 1) return options[0]!.id;
  return options.find((o) => o.id === view.quote.option_id && o.total !== null)?.id ?? null;
}

/**
 * The option the page is on: the one the client picked, while the quote still offers it with a
 * price (it may have changed since the page loaded); else the one it opens with (firstOption).
 */
export function pickedOption(view: QuoteView, picked: string | null): string | null {
  return view.quote.options?.some((o) => o.id === picked && o.total !== null) ? picked : firstOption(view);
}

/** The total and the terms (core sectionsHash, from hubContract) the client goes on to sign for, as they reviewed them. */
export interface SignedFor {
  total: number;
  hash: string | null;
}

/**
 * What changed since the client reviewed what they're signing, in the words the server turns a
 * signature down with: the terms (they'd sign words they haven't read), else the price; null when
 * neither did, or they haven't gone on to sign.
 */
export function reviewChange(reviewed: SignedFor | null, now: SignedFor): string | null {
  if (!reviewed) return null;
  if (reviewed.hash !== now.hash) return "The terms changed. Please look them over again.";
  if (reviewed.total !== now.total) return "The price changed. Please look it over again.";
  return null;
}

/** The add-ons still picked once `optionId` is the option: the shared ones and that option's own. Another option's are dropped. */
export function keepPicks(lines: readonly HubLine[], picked: readonly string[], optionId: string | null): string[] {
  return picked.filter((id) => lines.some((l) => l.id === id && l.optional && (l.option_id == null || l.option_id === optionId)));
}

/**
 * The first group of add-ons (lines sharing an option group, one choice among them) with none of its
 * lines picked, by its name; null when every group has its pick. The quote can't be approved until
 * each has one.
 */
export function unpickedGroup(lines: readonly HubLine[], picked: readonly string[]): string | null {
  const groups = lines.filter((l) => l.optional && l.option_group);
  return groups.find((l) => !groups.some((g) => g.option_group === l.option_group && picked.includes(g.id ?? "")))?.option_group ?? null;
}

/**
 * Lines as the page lists them: a price set below the estimate on an option is booked as two "Price
 * adjustment" lines, the taxed part and the untaxed (core siteAdjustmentLines), and shows as the one
 * price adjustment it is, as the paper prints it (documents/build.ts documentLines).
 */
export function listedLines(lines: readonly HubLine[]): HubLine[] {
  const site = (l: HubLine | undefined) => Boolean(l) && l!.name === SITE_ADJUSTMENT_NAME && !l!.optional && Number(l!.quantity) === 1;
  const out: HubLine[] = [];
  lines.forEach((l, i) => {
    const last = out.at(-1);
    if (last && site(l) && site(lines[i - 1])) out[out.length - 1] = { ...last, unit_price: (toCents(last.unit_price) + toCents(lineTotal(l.quantity, l.unit_price))) / 100, description: last.description ?? l.description };
    else out.push(l);
  });
  return out;
}

/** The lines shown for an option: the shared ones and that option's own, in order. */
export const optionLinesOf = (lines: readonly HubLine[], optionId: string | null) => lines.filter((l) => l.option_id == null || l.option_id === optionId);

/**
 * What the quote comes to with this option and these add-ons, to the cent of what the database
 * stores once it's approved that way (core chosenTotals). Its total is the one sent with the
 * signature (expected_total): the approval is turned down if the quote has changed since.
 */
export function hubTotals(view: QuoteView, optionId: string | null, picked: readonly string[]) {
  const q = view.quote;
  const lines = q.lines.map((l) => ({ ...l, id: l.id ?? "", option_id: l.option_id ?? null }));
  return chosenTotals(lines, optionId, q.option_id ?? null, picked, { taxRate: q.tax_rate, discountAmount: q.discount_amount ?? 0, promo: q.promo });
}

/**
 * The order a promo code needs (promo_codes.min_subtotal) when what's chosen comes to less: the
 * charges (lines priced above zero) of the lines on it, the required ones and the add-ons ticked, as
 * the database checks it when they approve (approve_hub_quote, which turns the approval down then).
 * Null when it's met, or the code needs none.
 */
export function promoShortfall(promo: HubPromoInfo, lines: ReadonlyArray<Pick<HubLine, "id" | "quantity" | "unit_price" | "optional">>, chosen: readonly string[]): number | null {
  const minimum = Number(promo?.min_subtotal ?? 0);
  if (!(minimum > 0)) return null;
  const charges = lines
    .filter((l) => (!l.optional || chosen.includes(l.id ?? "")) && Number(l.unit_price) > 0)
    .reduce((sum, l) => sum + toCents(lineTotal(l.quantity, l.unit_price)), 0);
  return charges < toCents(minimum) ? minimum : null;
}

/** The deposit to book, never more than what they're choosing comes to (a cheaper option can come to less). */
export const depositToBook = (deposit: Amount | null | undefined, total: Amount) => Math.max(0, Math.min(Number(deposit ?? 0), Number(total)));

/** The "Good", "Better" and "Best" chips on the add-on groups, but not when the quote offers options (their tiers are the options'). */
export const groupTiers = (view: QuoteView) => ((view.quote.options?.length ?? 0) > 0 ? new Map<string, string>() : optionLabels(view.quote.lines));

/**
 * The contract for the option picked, filled in: open, from the library's words with the facts the
 * server sends and the total they'd sign for (`total`), exactly as the server fills in the copy it
 * keeps; signed, the copy it kept. Null with a price range, or from an older server.
 */
export function hubContract(view: QuoteView, optionId: string | null, total: Amount): QuoteContract | null {
  const c = view.contract;
  if (!c) return null;
  if (c.kind === "signed") return keptContract({ terms: c.terms, sections: c.sections }, c.initials);
  const options = view.quote.options ?? [];
  const option = options.find((o) => o.id === optionId) ?? null;
  return liveContract({
    template: { terms: c.terms, sections: c.template_sections, invoice_sections: [] },
    library: c.library,
    optionSectionIds: option?.section_ids,
    quoteSectionIds: c.quote_sections,
    // With options, the option picked says {Option} and {Warranty}; without, the facts say the package's.
    facts: { ...c.facts, total, ...(options.length ? { optionName: option?.name ?? null, warranty: option?.warranty ?? null } : {}) },
    // Its card as the server keeps it with the approval: the tier word the card shows.
    option: option && { name: option.name, tier: option.tier, warranty: option.warranty, highlights: option.highlights },
  });
}

/** The option a quote is signed for, as the strip of its paper says it ("Your choice: Better · Designer shingle"). */
export function hubChoice(view: QuoteView, optionId: string | null): { name: string; tier: string | null } | null {
  const option = view.quote.options?.find((o) => o.id === optionId);
  return option ? { name: option.name, tier: option.tier } : null;
}

/** How the paper of a quote is drawn while the client goes through it. */
export interface HubPaper {
  /** The option picked on the page; without it, the one shown. */
  optionId?: string | null;
  /** The add-ons ticked on the page (its amounts follow them, worked out to the cent); without them, as saved. */
  picked?: readonly string[];
  /** The copy being signed (from reviewing on): it says which option was chosen instead of comparing them. */
  signing?: boolean;
  /** The contract printed with it (hubContract). Left out, an open quote prints none and a signed one the copy kept with it. */
  contract?: QuoteContract | null;
}

/**
 * A quote as its template document, with both signatures once it's signed. With options, it prints
 * the shared lines and the picked option's, and compares the options until the copy being signed.
 */
export function quoteDocument(view: QuoteView, paper: HubPaper = {}): DocumentData {
  const q = view.quote;
  const tz = view.company.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const options = q.options ?? [];
  const optionId = paper.optionId !== undefined ? paper.optionId : q.option_id ?? null;
  const picked = paper.picked ? new Set(paper.picked) : null;
  // A line from an older server, without its option, is on every option.
  const saved = q.lines.map((l) => ({ ...l, option_id: l.option_id ?? null }));
  // Picked on the page: the option's required lines and the add-ons ticked; else as saved.
  const lines = picked ? saved.map((l) => (l.option_id === null || l.option_id === optionId ? { ...l, selected: !l.optional || picked.has(l.id ?? "") } : l)) : saved;
  const worked = picked ? hubTotals(view, optionId, [...picked]) : q.subtotal == null || q.total == null ? hubTotals(view, optionId, q.lines.filter((l) => l.optional && l.selected).map((l) => l.id ?? "")) : null;
  const amounts = worked
    ? { subtotal: worked.subtotal, discount_amount: worked.discount, tax_amount: worked.tax, total: worked.total }
    : { subtotal: q.subtotal ?? 0, discount_amount: q.discount_amount ?? 0, tax_amount: q.tax_amount ?? 0, total: q.total ?? 0 };
  const signed = q.status === "approved" || q.status === "converted";
  return buildQuoteDocument({ ...q, ...amounts, approval: signed ? q.approval : null }, lines, {
    // Dated the day it was sent where the business is, else the day it was made, as its {Date} says (an
    // open quote's facts say it when the server doesn't send the day it was made).
    date: quoteDate({ sent_at: q.sent_at, created_at: q.created_at ?? (view.contract?.kind === "live" ? view.contract.facts.date : null) }, tz),
    optionId,
    options: options.map((o) => ({ id: o.id, name: o.name, tier: o.tier, picture: o.picture, style: o.style, highlights: o.highlights, warranty: o.warranty, total: o.total })),
    choice: paper.signing || signed ? hubChoice(view, optionId) : null,
    ...(paper.contract !== undefined ? { contract: paper.contract ? { sections: paper.contract.sections } : null } : {}),
  });
}

/** An invoice's contract as the server filled it in (the template's terms and its invoice sections). */
export function hubInvoiceContract(view: InvoiceView): QuoteContract | null {
  const c = view.contract;
  if (!c) return null;
  return { terms: c.terms, sections: c.sections.map((s) => ({ id: s.id, title: s.title, html: s.body, place: s.place, initials: false })), hash: null };
}

/** An invoice as its template document: what was billed, what's been paid and refunded, what's left, and its contract. */
export function invoiceDocument(view: InvoiceView): DocumentData {
  const tz = view.company.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return buildInvoiceDocument(view.invoice, { timeZone: tz, contract: hubInvoiceContract(view) });
}

// ---------------------------------------------------------------------------------------------
// The price range page
// ---------------------------------------------------------------------------------------------

/** Whole dollars when the amount is whole ("$650"), else with cents ("$3.50"). */
export const priceText = (amount: number) => (Number.isInteger(Number(amount)) ? formatMoney(amount) : formatMoneyCents(amount));

const UNIT_WORDS: Record<string, string> = { ft: "foot", lf: "foot", "sq ft": "square foot", sqft: "square foot", sq: "square", yd: "yard", "sq yd": "square yard", hr: "hour", ea: "", each: "" };

/** What a "could change the price" item costs: "$95 a sheet", "$85 a square", "$650". */
export function maybePrice(item: { price: number; per: string | null }): string {
  const unit = (item.per ?? "").trim().toLowerCase();
  const word = unit in UNIT_WORDS ? UNIT_WORDS[unit]! : unit;
  return word ? `${priceText(item.price)} ${/^([aeiou]|hour)/.test(word) ? "an" : "a"} ${word}` : priceText(item.price);
}

/** The package as the homeowner reads it: "Architectural shingle" -> "Architectural shingle roof". */
export function packageLabel(name: string | null | undefined): string {
  const clean = (name ?? "").trim();
  return !clean || /\broof/i.test(clean) ? clean : `${clean} roof`;
}

/**
 * Whether the estimate is for a roof, so the page can talk about "your roof": it has a measured roof,
 * or its package is one. Anything else gets words that fit any job.
 */
export function isRoofJob(view: Pick<QuoteView, "drawings" | "quote">): boolean {
  return measuredRoof(view.drawings) !== null || /\b(roof|shingle)/i.test(view.quote.package?.name ?? "");
}

/** The words on the price range page, about a roof or about any job, and about one estimate or its options. */
export function rangeWords({ roof, options, first }: { roof: boolean; options: number; first: string | null }) {
  const choosing = options >= 2;
  const visit = roof ? "look at your roof" : "come out";
  return {
    /** Before the estimate's number at the top, and in the browser tab. */
    kind: roof ? "Roof estimate" : "Estimate",
    heading: roof ? (first ? `Your new roof, ${first}` : "Your new roof") : first ? `Your estimate, ${first}` : "Your estimate",
    /** Under the range: why it's a range. */
    why: `${choosing ? "The exact price of the option you pick" : "The exact price"} is set when we ${roof ? "look at your roof in person" : "see the job in person"}. It only moves toward the top if we find something hidden, like ${roof ? "soft wood under the shingles" : "damage we couldn't see from here"}.`,
    next: `Say yes and we'll call to set up a time to ${visit}.${choosing ? " You can tell us which option you're leaning toward, or decide when we're there." : ""} You'll see the exact price and sign only if you're happy with it.`,
    thanks: `We'll set up a time to ${visit}, usually within one business day.`,
    maybe: roof ? "If we find something on the roof" : "If we find something we couldn't see",
  };
}

/** The property on one line: "1482 Ridgeview Dr, Columbus, OH 43221". */
export function propertyLine(property: QuoteView["quote"]["property"]): string {
  if (!property) return "";
  const place = [property.region, property.postal_code].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return [property.line1, property.city, place].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
}

/** A phone number as a link: "tel:+16145550188" from "+1 (614) 555-0188". */
export const phoneHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

/** A link to the business's website, with https:// added when it was typed without it. */
export const websiteHref = (url: string) => (/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);

const INK = "#0f2a35";

/** How well a color reads on white, as a contrast ratio from 1 to 21. Anything that isn't a hex color counts as unreadable. */
export function contrastOnWhite(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r! + 0.7152 * g! + 0.0722 * b! + 0.05);
}

/**
 * The color the range page is drawn in: the estimate template's (documentColor), so the link
 * matches the paper the homeowner signs later. `text` is that color for words on white, or ink when
 * it's too light to read at body size; `on` is the color of words on a button filled with it.
 */
export function hubAccent(view: { template?: unknown; company: Pick<HubCompany, "branding"> }): { color: string; text: string; on: string } {
  const color = documentColor(hubTemplate(view), { branding: view.company.branding ?? null });
  return { color, text: contrastOnWhite(color) >= 4.5 ? color : INK, on: inkOn(color) };
}

/** "2026-10-23" -> "October 23, 2026", or "October 23" without the year. */
export function dayText(date: string, withYear = true): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", withYear ? { month: "long", day: "numeric", year: "numeric" } : { month: "long", day: "numeric" });
}

/**
 * The dates under the title, on the business's calendar: the day the range was sent ("October 23,
 * 2026") and the day it's good until ("November 22", with the year when it's another year). Null
 * for what isn't known, like the sent date on a preview. `today` is today where the business is.
 */
export function rangeDates(view: Pick<QuoteView, "company" | "quote">, today: string): { sent: string | null; goodUntil: string | null; expired: boolean } {
  const q = view.quote;
  const tz = view.company.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sentAt = q.range?.sent_at ?? q.sent_at ?? null;
  const sentOn = sentAt ? dateIn(sentAt, tz) : null;
  const until = q.valid_until ? q.valid_until.slice(0, 10) : null;
  return {
    sent: sentOn ? dayText(sentOn) : null,
    goodUntil: until ? dayText(until, until.slice(0, 4) !== (sentOn ?? today).slice(0, 4)) : null,
    expired: Boolean(until && until < today),
  };
}

/** The roof as measured, for "Your roof, measured". */
export interface MeasuredRoof {
  /** The drawings the roof is on, whose pictures go on the page. */
  drawings: HubDrawing[];
  /** The roof's surface at its pitch, without waste: the roof itself, not what's ordered for it. */
  areaSqft: number;
  /** The same in roofing squares (100 sq ft each). */
  squares: number;
  /** The pitch most of the roof is at ("6/12", or "Flat"), and whether some of it is at another. */
  pitch: string | null;
  mixed: boolean;
}

const slopeFactor = (pitch: string | null | undefined) => {
  try {
    return pitchFactor(pitch);
  } catch {
    return 1;
  }
};
const pitchName = (pitch: string | null | undefined) => {
  try {
    const rise = normalizePitch(pitch);
    return rise === "0/12" ? "Flat" : rise || null;
  } catch {
    return null;
  }
};

/**
 * The roof from the drawings shown on the quote: each area at its own pitch, added up, without the
 * waste the saved squares include. Null when none of them is a roof (no squares on it).
 */
export function measuredRoof(drawings: HubDrawing[] | undefined): MeasuredRoof | null {
  const roofs = (drawings ?? []).filter((d) => Number(d.roofing_squares) > 0);
  if (!roofs.length) return null;
  let area = 0;
  const byPitch = new Map<string, number>();
  for (const d of roofs) {
    const areas = d.sections.filter((s) => s.kind === "Area" && Number(s.value) > 0);
    // A drawing without its areas listed: its whole area at its pitch.
    const parts = areas.length ? areas.map((s) => ({ plan: Number(s.value), pitch: s.pitch || d.roof_pitch })) : [{ plan: Number(d.total_area_sqft) || 0, pitch: d.roof_pitch }];
    for (const part of parts) {
      const surface = part.plan * slopeFactor(part.pitch);
      area += surface;
      const name = pitchName(part.pitch);
      if (name) byPitch.set(name, (byPitch.get(name) ?? 0) + surface);
    }
  }
  // Nothing to work it out from: the saved squares, waste and all, are closer than nothing.
  if (!(area > 0)) area = roofs.reduce((sum, d) => sum + Number(d.roofing_squares) * 100, 0);
  const main = [...byPitch].sort((a, b) => b[1] - a[1])[0];
  return { drawings: roofs, areaSqft: area, squares: area / 100, pitch: main ? main[0] : null, mixed: byPitch.size > 1 };
}

/** How many layers of old shingles come off, from the tear-off in what's included ("Tear-off and disposal (2 layers)"). Null without one. */
export function tearOffLayers(included: readonly string[]): number | null {
  const line = included.find((name) => /tear[\s-]?off/i.test(name));
  if (!line) return null;
  const layers = /\((\d+) layers?\)/i.exec(line);
  return layers ? Number(layers[1]) : 1;
}

/** The facts beside the roof's picture: its size in squares, its area, its pitch and the layers coming off. */
export function roofTiles(roof: MeasuredRoof, included: readonly string[] = []): Array<{ label: string; value: string }> {
  // Small roofs keep a decimal; an aerial measurement isn't closer than 10 sq ft on a whole house.
  const squares = roof.squares < 10 ? formatNumber(roof.squares, 1) : formatNumber(Math.round(roof.squares));
  const area = roof.areaSqft >= 1000 ? Math.round(roof.areaSqft / 10) * 10 : Math.round(roof.areaSqft);
  const layers = tearOffLayers(included);
  return [
    { label: "Roof size", value: `${squares} squares` },
    { label: "Roof area", value: `${formatNumber(area)} sq ft` },
    ...(roof.pitch ? [{ label: roof.mixed ? "Main pitch" : "Pitch", value: roof.pitch }] : []),
    ...(layers ? [{ label: "Tear-off", value: `${layers} ${layers === 1 ? "layer" : "layers"}` }] : []),
  ];
}

/** Under the roof's facts: when it was measured (when the server says), and that it's checked on site. */
export function measuredLine(roof: MeasuredRoof, timeZone: string, today: string): string {
  const latest = roof.drawings.map((d) => d.measured_at).filter((at): at is string => Boolean(at)).sort().pop();
  const on = latest ? dateIn(latest, timeZone) : null;
  return `Measured from aerial photos${on ? ` on ${dayText(on, on.slice(0, 4) !== today.slice(0, 4))}` : ""}. We check every measurement on site.`;
}

export interface TrustBadge {
  kind: "license" | "insured";
  title: string;
  detail: string;
}

/** "Licensed" and "Fully insured" from the template, each only when it's filled in and shown. */
export function trustBadges(template: TemplateSettings): TrustBadge[] {
  const badges: TrustBadge[] = [];
  const license = template.license.trim();
  // "License #RC-104882" reads "Licensed · #RC-104882", not "Licensed · License #RC-104882".
  if (template.show_license && license) badges.push({ kind: "license", title: "Licensed", detail: license.replace(/^lic(?:ense)?(?:\.|\b(?=[\s#:]))\s*(?:(?:no|number)\b\.?)?\s*:?\s*/i, "") || license });
  const insurer = template.insurer.trim();
  if (template.show_insurer && insurer) badges.push({ kind: "insured", title: "Fully insured", detail: insurer });
  return badges;
}

/** The license and insurer for the foot of the page, worded as the document words them: "License #RC-104882 · Insured by Hartwell Mutual". */
export function credentialLine(template: TemplateSettings): string {
  return [
    template.show_license && template.license.trim() ? licenseLine(template.license) : null,
    template.show_insurer && template.insurer.trim() ? `Insured by ${template.insurer.trim()}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
