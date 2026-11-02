/**
 * Turning the app's records into a document (types.ts), and the words and numbers printed on it.
 * Plain functions with no data loading, so the Client Hub, the office, the iPad and Settings all
 * print a quote the same way, and tests can check them without a browser.
 *
 * A quote that offers options prints the shared lines and the lines of one option (the one shown,
 * the one the customer picked, or the one it was signed for), as core money.ts countsOn decides.
 * Its contract is the template's terms and the sections from the business's library (core
 * contracts.ts) with their fill-ins filled; a signed quote prints the copy kept with its approval.
 * data.ts loads the library for the staff app; the Client Hub gets it with its link.
 */
import { addressLines, contractValues, fillIn, resolveSections, sectionsHash, type ContractInput, type ContractOption, type LibrarySection } from "@crewtavo/core/contracts";
import { pickTemplate, templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { promoRuleWords } from "@crewtavo/core/promos";
import { countsOn, lineTotal, optionBaseTotal, optionTierLabels, optionTotals, quoteTotals, toCents, type Amount, type OptionLine } from "@crewtavo/core/money";
import { SITE_ADJUSTMENT_NAME } from "@crewtavo/core/estimates";
import { isPackagePicturePath, packagePictureSrc } from "@crewtavo/core/presets";
import { isIsoDate } from "@crewtavo/core/time";
import { dateIn, formatDate, todayIn } from "@/lib/format";
import { scheduleText } from "../jobs/repeatText";
import type { DocumentCompany, DocumentContract, DocumentData, DocumentLine, DocumentOption, DocumentSection, DocumentSignature } from "./types";

// ---------------------------------------------------------------------------------------------
// The business
// ---------------------------------------------------------------------------------------------

type Address = { line1?: string | null; line2?: string | null; city?: string | null; region?: string | null; postal_code?: string | null } | null | undefined;

/**
 * An address as printed: the street, then "City, ST 12345". Empty parts are left out. The same
 * lines a contract's {Customer address} and {Job address} fill in with (core contracts.ts).
 */
export { addressLines };

/** Where the business's logo loads from (the public logo route), or null when it has none. */
export function logoUrl(settings: unknown): string | null {
  const branding = settings && typeof settings === "object" ? (settings as { branding?: { logo?: unknown } }).branding : null;
  const path = branding?.logo;
  return typeof path === "string" && path.includes("/logo/") ? `/api/public/logo/${path.replace("/logo/", "/")}` : null;
}

/** "Ridgeline Roofing Co." -> "RR", for a business with no logo. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s&]/gu, " ").split(/\s+/).filter((w) => w && !/^(co|inc|llc|ltd|the|and|&)$/i.test(w));
  return (words.length ? words : [name]).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

/** A website as people read it: no "https://", no trailing slash. */
export const websiteLabel = (url: string | null | undefined) => (url ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");

/** The license line: "License #RC-104882", unless they typed the word themselves. */
export const licenseLine = (license: string) => (/^lic/i.test(license.trim()) ? license.trim() : `License ${license.trim()}`);

// ---------------------------------------------------------------------------------------------
// Colors on paper
// ---------------------------------------------------------------------------------------------

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const INK = "#0f2a35";

/** The text color that reads best on a band of `hex`: white, or ink on a light color. */
export function inkOn(hex: string): string {
  const l = luminance(hex);
  if (l === null) return "#ffffff";
  return 1.05 / (l + 0.05) >= (l + 0.05) / (luminance(INK)! + 0.05) ? "#ffffff" : INK;
}

/** The color for words on white paper: the document's color, or ink when it's too light to read. */
export function readableOnWhite(hex: string): string {
  const l = luminance(hex);
  return l !== null && 1.05 / (l + 0.05) >= 3 ? hex : INK;
}

// ---------------------------------------------------------------------------------------------
// Words and numbers on the page
// ---------------------------------------------------------------------------------------------

const BARE = new Set(["", "ea", "each", "lump sum", "ls", "lot"]);
const SHORT: Record<string, string> = { square: "sq", squares: "sq", sq: "sq", hour: "hr", hours: "hr", hrs: "hr", foot: "ft", feet: "ft", "linear ft": "ft", "lin ft": "ft", lf: "ft", sqft: "sq ft", "square feet": "sq ft" };
const ABBREVIATED = new Set(["sq", "ft", "sq ft", "sq yd", "yd", "cu yd", "cy", "hr", "sf", "in", "lb", "lbs", "gal", "mo", "wk", "km", "m", "m2", "sq m", "kg", "l"]);

function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** A quantity as written on the page: "24.2 sq", "210 ft", "6 sheets", or just "3" for each. */
export function quantityLabel(quantity: Amount, unit: string | null | undefined): string {
  const q = Number(quantity ?? 0);
  const number = q.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const u = (unit ?? "").trim().toLowerCase();
  if (BARE.has(u)) return number;
  const short = SHORT[u] ?? u;
  if (ABBREVIATED.has(short) || q === 1 || /\s/.test(short) || /s$/.test(short)) return `${number} ${short}`;
  return `${number} ${plural(short)}`;
}

/** "2026-10-22" or a timestamp -> "October 22, 2026". */
export function longDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** "2026-10-24T18:14:00Z" -> "Oct 24, 2026", for the date beside a signature. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------------------------
// A quote as a document
// ---------------------------------------------------------------------------------------------

/** The business's signature on an approval (quotes.approval.company). */
export interface CompanyApproval {
  name: string;
  user_id: string | null;
  signature: string;
  signed_at: string;
}

/** The option a quote was signed for, as it was offered then (approval.option). */
export interface ApprovalOption {
  id: string;
  name: string;
  /** The tier word on its card ("Better"). */
  tier: string | null;
  /** Its package's picture, in the files bucket (packagePictureSrc for where it loads from). */
  picture: { path: string; width: number; height: number } | null;
  style: string;
  highlights: string[];
  warranty: string;
}

/** A contract section as it was signed: filled in, and whether the customer initialed it. */
export interface ApprovalSection {
  id: string;
  title: string;
  /** HTML, with its fill-ins filled. */
  body: string;
  place: "signatures" | "terms";
  initials: boolean;
  initialed: boolean;
}

/** The contract as it was signed (approval.contract): the template's terms (plain text) and the sections (HTML), filled in. */
export interface ApprovalContract {
  terms: string;
  sections: ApprovalSection[];
}

/** quotes.approval as the app reads it, whichever way the quote was approved. */
export interface QuoteApproval {
  /** The customer's printed name; for an office "Mark approved", the office person's. */
  name: string;
  signature: string | null;
  signed_at: string | null;
  /** Online approvals have none; "manual" is the office marking it approved; "in_person" is signed on site. */
  method: "manual" | "in_person" | null;
  company: CompanyApproval | null;
  /**
   * The template it was signed (or marked approved) on, saved with the approval so later edits to
   * the business's templates never change the terms above a signature. Older approvals have none.
   */
  template?: TemplateSettings | null;
  /** The option they chose, when the quote offered options. */
  option?: ApprovalOption | null;
  /** The contract as they signed it. Approvals from before it was kept have none. */
  contract?: ApprovalContract | null;
  /** Their initials, drawn once and stamped on each section that asked (ApprovalSection.initialed). */
  initials?: { image: string; signed_at: string | null } | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const PNG = /^data:image\/png;base64,/;

/** approval.option, field by field (the API's services/contracts.ts readFrozen reads it the same way). */
function readOption(raw: unknown): ApprovalOption | null {
  const o = record(raw);
  if (!o || !str(o.id) || !str(o.name)) return null;
  const picture = record(o.picture);
  const path = str(picture?.path);
  const size = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  return {
    id: str(o.id)!,
    name: str(o.name)!,
    tier: str(o.tier),
    picture: path && isPackagePicturePath(path) && size(picture!.width) && size(picture!.height) ? { path, width: size(picture!.width)!, height: size(picture!.height)! } : null,
    style: str(o.style) ?? "other",
    highlights: strings(o.highlights),
    warranty: str(o.warranty) ?? "",
  };
}

/** approval.contract, field by field. */
function readContract(raw: unknown): ApprovalContract | null {
  const c = record(raw);
  if (!c) return null;
  const sections = (Array.isArray(c.sections) ? c.sections : []).flatMap((raw): ApprovalSection[] => {
    const s = record(raw);
    if (!s || !str(s.id) || str(s.title) === null) return [];
    return [{ id: str(s.id)!, title: str(s.title)!, body: str(s.body) ?? "", place: s.place === "signatures" ? "signatures" : "terms", initials: s.initials === true, initialed: s.initialed === true }];
  });
  return { terms: str(c.terms) ?? "", sections };
}

/** Reads quotes.approval (free-form jsonb) into its known shape; null when there's none. */
export function readApproval(raw: unknown): QuoteApproval | null {
  const a = record(raw);
  if (!a) return null;
  const c = record(a.company);
  const companySignature = str(c?.signature);
  const i = record(a.initials);
  const initials = str(i?.image);
  return {
    name: str(a.name)?.trim() ?? "",
    signature: str(a.signature) && PNG.test(str(a.signature)!) ? str(a.signature) : null,
    signed_at: str(a.signed_at),
    method: a.method === "manual" || a.method === "in_person" ? a.method : null,
    company: c && companySignature && PNG.test(companySignature) ? { name: str(c.name)?.trim() ?? "", user_id: str(c.user_id), signature: companySignature, signed_at: str(c.signed_at) ?? "" } : null,
    template: record(a.template) ? templateSettings(a.template) : null,
    option: readOption(a.option),
    contract: readContract(a.contract),
    initials: initials && PNG.test(initials) ? { image: initials, signed_at: str(i!.signed_at) } : null,
  };
}

/** A quote the customer has said yes to: its look and its signatures are settled. */
export const isSignedQuote = (status: string) => status === "approved" || status === "converted";

/** The quote fields that decide which template it prints with. */
export interface TemplatedQuote {
  template_id: string | null;
  approval: unknown;
  /** Without it, an approval that saved its template counts as signed. */
  status?: string;
}

/**
 * The template a signed quote keeps: the one saved with its approval, with its terms as they were
 * signed (their fill-ins filled in). Null for a quote that isn't signed, or was signed before
 * approvals saved their template.
 */
export function signedTemplate(quote: TemplatedQuote): TemplateSettings | null {
  if (quote.status !== undefined && !isSignedQuote(quote.status)) return null;
  const approval = readApproval(quote.approval);
  if (!approval?.template) return null;
  return approval.contract ? { ...approval.template, terms: approval.contract.terms } : approval.template;
}

/**
 * The template a quote prints with: the one it was signed on, else the one it names, else the
 * business's default, else the built-in look. `trade` (the company's trade_preset) picks the starter
 * terms for a business that never saved its own.
 */
export function quoteTemplate<T extends { id: string; is_default: boolean; settings: unknown }>(templates: readonly T[], quote: TemplatedQuote, trade?: string | null): TemplateSettings {
  return signedTemplate(quote) ?? pickTemplate(templates, quote.template_id, trade);
}

/**
 * The signatures an approval puts on the document. An office "Mark approved" isn't the customer's
 * signature, so their line stays blank to sign by hand.
 */
export function approvalSignatures(raw: unknown, approvedAt?: string | null): NonNullable<DocumentData["signatures"]> {
  const approval = readApproval(raw);
  const customer: DocumentSignature | null =
    approval && approval.method !== "manual" && (approval.signature || approval.name) ? { name: approval.name, image: approval.signature, date: approval.signed_at ?? approvedAt ?? null } : null;
  const company: DocumentSignature | null = approval?.company ? { name: approval.company.name, image: approval.company.signature, date: approval.company.signed_at || null } : null;
  return { customer, company };
}

/** The quote fields a document reads. Rows from Supabase, the estimate kit and the hub all fit. */
export interface DocumentQuote {
  number: number | null;
  /** Without it, a quote with an approval counts as signed. */
  status?: string;
  title?: string | null;
  message?: string | null;
  subtotal: Amount;
  discount_amount: Amount;
  tax_amount: Amount;
  total: Amount;
  deposit_amount?: Amount;
  valid_until?: string | null;
  /** How often, for recurring work; null for one time. */
  recurrence_rule?: string | null;
  active_months?: number[] | null;
  sent_at?: string | null;
  created_at?: string | null;
  approved_at?: string | null;
  approval?: unknown;
  /** The option shown (quotes.option_id), when it offers options. */
  option_id?: string | null;
  /** `every_visit`: whether it comes off every visit of recurring work or once (left out by older callers). */
  promo?: { code?: string | null; every_visit?: boolean | null } | null;
  client?: { display_name: string } | null;
  property?: Address;
}

export interface DocumentQuoteLine {
  name: string;
  description?: string | null;
  quantity: Amount;
  unit: string;
  unit_price: Amount;
  optional?: boolean | null;
  selected?: boolean | null;
  /**
   * The option it's on; null for a line on every option (and every line of a quote without options).
   * Required, so a screen that forgets to load it doesn't print every option's lines as shared.
   */
  option_id: string | null;
  sort?: number | null;
  /** A price set on site has none (core isSiteAdjustment); the Client Hub doesn't send them. */
  service_id?: string | null;
  formula?: string | null;
  /** Printed as the line's mark (DocumentLine.mark), for a screen that shows which line just changed. */
  mark?: string;
}

/**
 * The day a quote's paper is dated, on the business's calendar: the day it was sent, else the day it
 * was made, as its {Date} fill-in says it (core contractInput), so a copy signed on the iPad without
 * being sent never gives two dates. Today only for a quote with neither yet.
 */
export function quoteDate(quote: { sent_at?: string | null; created_at?: string | null }, timeZone: string): string {
  const at = quote.sent_at ?? quote.created_at;
  if (!at) return todayIn(timeZone);
  return isIsoDate(at) ? at : dateIn(at, timeZone);
}

/** An option as it's offered, for the "Your options" comparison (DocumentOption without which is shown). */
export type OfferedOption = Omit<DocumentOption, "chosen">;

/** What a screen knows beyond the quote: who it's for, its date. */
export interface DocumentExtras {
  client?: { name: string; lines: string[] };
  /** The date it's dated; else when it was sent, else when it was made. */
  date?: string | null;
  signatures?: DocumentData["signatures"];
  /**
   * The option it prints, with the shared lines: the one the customer picked on the page. Without
   * it, the quote's shown option (quotes.option_id); a signed quote always prints the one it was
   * signed for.
   */
  optionId?: string | null;
  /**
   * The options the quote offers, compared under "Your options" while the customer is still
   * deciding (two or three of them). Never on the copy being signed or a signed one.
   */
  options?: readonly OfferedOption[];
  /**
   * The copy being signed: the option chosen, said in the strip ("Your choice: Better · Designer
   * shingle") in place of the comparison. A signed quote says the one it was signed for.
   */
  choice?: { name: string; tier?: string | null } | null;
  /**
   * The contract's sections, filled in (liveContract, or useQuoteContract in data.ts); null prints
   * none. Left out, a signed quote prints the copy kept with its approval.
   */
  contract?: DocumentContract | null;
}

/**
 * Whether a line counts while `shownOptionId` is the option shown: it's shared or on that option,
 * and it isn't an add-on the customer left off (core countsOn). Lines of a quote without options
 * all count but those add-ons.
 */
export const countedLine = (l: { option_id?: string | null; optional?: boolean | null; selected?: boolean | null }, shownOptionId: string | null = null) => countsOn(l, shownOptionId);

/** A price set on site, as a line prints it: "Price adjustment", one of it, from no service. */
const siteLine = (l: DocumentQuoteLine) => l.name === SITE_ADJUSTMENT_NAME && l.service_id == null && !l.formula && Number(l.quantity) === 1;

/**
 * A quote's lines as printed: the ones that count with that option shown (none for a quote without
 * options), in order. A price set on site prints as a normal line; one set below the estimate on an
 * option is booked as two lines, the taxed part and the untaxed (core siteAdjustmentLines), and
 * prints as the one price adjustment it is.
 */
export function documentLines(lines: readonly DocumentQuoteLine[], shownOptionId: string | null = null): DocumentLine[] {
  const counted = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => countedLine(line, shownOptionId))
    .sort((a, b) => (a.line.sort ?? 0) - (b.line.sort ?? 0) || a.i - b.i)
    .map(({ line }) => line);
  const printed: DocumentLine[] = [];
  counted.forEach((line, i) => {
    const total = lineTotal(line.quantity, line.unit_price);
    const last = printed.at(-1);
    if (last && siteLine(line) && siteLine(counted[i - 1]!)) {
      const sum = (toCents(last.total) + toCents(total)) / 100;
      Object.assign(last, { unit_price: sum, total: sum, description: last.description ?? (line.description?.trim() || null) });
      return;
    }
    printed.push({ name: line.name, description: line.description?.trim() || null, quantity: Number(line.quantity ?? 0), unit: line.unit, unit_price: Number(line.unit_price ?? 0), total, ...(line.mark ? { mark: line.mark } : {}) });
  });
  return printed;
}

/** An option as it's named to the customer: "Better · Designer shingle", or just its name without a tier. */
export const choiceLabel = (choice: { name: string; tier?: string | null }) => `${choice.tier?.trim() ? `${choice.tier.trim()} · ` : ""}${choice.name.trim()}`;

/** "Your choice: Better · Designer shingle", in the strip of a copy being signed or signed. */
export const choiceFact = (choice: { name: string; tier?: string | null }) => `Your choice: ${choiceLabel(choice)}`;

/**
 * A quote as an estimate document, with its signatures once it's signed. With options, it prints
 * the shared lines and one option's (extras.optionId, else the one shown, else the one it was
 * signed for), and compares the options while the customer is still deciding.
 */
export function quoteDocument(quote: DocumentQuote, lines: readonly DocumentQuoteLine[], extras: DocumentExtras = {}): DocumentData {
  const discount = Number(quote.discount_amount ?? 0);
  // Never more than the total being signed: a cheaper option or a price set on site can come to less (as {Deposit} says).
  const deposit = Math.min(Number(quote.deposit_amount ?? 0), Math.max(Number(quote.total ?? 0), 0));
  const approval = quote.status === undefined || isSignedQuote(quote.status) ? readApproval(quote.approval) : null;
  const shown = approval?.option?.id ?? (extras.optionId !== undefined ? extras.optionId : quote.option_id ?? null);
  const choice = approval?.option ?? extras.choice ?? null;
  const count = extras.options?.length ?? 0;
  const options = !approval && !choice && count >= 2 && count <= 3 ? extras.options!.map((o) => ({ ...o, chosen: o.id === shown })) : null;
  const contract = extras.contract !== undefined ? extras.contract : signedContract(approval);
  return {
    kind: "estimate",
    number: quote.number,
    date: extras.date ?? quote.sent_at ?? quote.created_at ?? null,
    validUntil: quote.valid_until ?? null,
    // No project name, package or roof size under the address: only, signing for an option, which one.
    facts: choice ? [choiceFact(choice)] : [],
    client: extras.client ?? { name: quote.client?.display_name ?? "", lines: addressLines(quote.property) },
    lines: documentLines(lines, shown),
    subtotal: Number(quote.subtotal ?? 0),
    discount,
    discountLabel: discount > 0 && quote.promo?.code ? `Promo code ${quote.promo.code}${quote.promo.every_visit != null ? ` · ${promoRuleWords(quote.promo.every_visit)}` : ""}` : undefined,
    tax: Number(quote.tax_amount ?? 0),
    total: Number(quote.total ?? 0),
    deposit: deposit > 0 ? deposit : null,
    repeats: quote.recurrence_rule ? scheduleText(quote.recurrence_rule, quote.active_months) : null,
    notes: quote.message?.trim() || null,
    signatures: extras.signatures ?? approvalSignatures(quote.approval, quote.approved_at),
    ...(contract ? { contract: { sections: contract.sections } } : {}),
    ...(options ? { options } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The options a quote offers
// ---------------------------------------------------------------------------------------------

type TotalsOptions = Parameters<typeof quoteTotals>[1];

/** An option a quote offers (quote_options): the fields the paper and its tier word read. The office's option rows fit. */
export interface OptionOffer {
  id: string;
  name: string;
  tier: string | null;
  picture?: string | null;
  picture_width?: number | null;
  picture_height?: number | null;
  style?: string | null;
  highlights?: readonly string[] | null;
  warranty?: string | null;
}

/**
 * The tier word on each option's card: its own, or "Good", "Better" and "Best" by its price before
 * add-ons when none has one (core optionTierLabels), as the Client Hub and the signed copy word it.
 */
export function optionTiers(options: ReadonlyArray<Pick<OptionOffer, "id" | "tier">>, lines: readonly OptionLine[], money: TotalsOptions): Map<string, string> {
  return optionTierLabels(options.map((o) => ({ id: o.id, tier: o.tier, total: optionBaseTotal(lines, o.id, money) })));
}

/**
 * A quote's options as the paper compares them: each with its picture, tier word and its price with
 * none of its add-ons (core optionTotals, as the Client Hub shows it), or no price while it has no
 * lines of its own.
 */
export function documentOptions(options: readonly OptionOffer[], lines: readonly OptionLine[], money: TotalsOptions): OfferedOption[] {
  const tiers = optionTiers(options, lines, money);
  return options.map((o) => ({
    id: o.id,
    name: o.name,
    tier: tiers.get(o.id) ?? null,
    picture: o.picture && isPackagePicturePath(o.picture) && o.picture_width && o.picture_height ? { src: packagePictureSrc(o.picture), width: o.picture_width, height: o.picture_height } : null,
    style: o.style ?? "other",
    highlights: [...(o.highlights ?? [])],
    warranty: o.warranty ?? "",
    total: optionBaseTotal(lines, o.id, money) === null ? null : optionTotals(lines, o.id, null, money).total,
  }));
}

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

/**
 * A contract as the paper prints it: the template's terms (plain text, printed in place of the
 * template's own: contractTemplate) and the sections, each with its fill-ins filled.
 */
export interface QuoteContract {
  terms: string;
  sections: DocumentSection[];
  /**
   * core sectionsHash of the terms and sections as they print (fill-ins filled) and the option's
   * card: what's sent with a signature, so the server can tell when what they read changed. Null for
   * a signed copy, and an invoice.
   */
  hash: string | null;
}

/**
 * A contract to print when it didn't load: no terms and no sections, rather than the template's own
 * with their fill-ins unfilled ("I, {Customer name}, agree…"). The office's paper, an invoice's and
 * the iPad's use it.
 */
export const NO_CONTRACT: QuoteContract = { terms: "", sections: [], hash: null };

/**
 * An estimate's contract for one option, filled in: the template's sections, then the option's, then
 * the quote's own (core resolveSections), from the business's library. The server fills in the copy
 * it keeps from the same facts (core contractInput), so the words match, and fingerprints them with
 * the option's card as it keeps it (`option`: its name, the tier word on its card, its warranty and
 * highlights; null without options).
 */
export function liveContract(input: {
  template: Pick<TemplateSettings, "terms" | "sections" | "invoice_sections">;
  library: readonly LibrarySection[];
  optionSectionIds?: readonly string[] | null;
  quoteSectionIds?: readonly string[] | null;
  facts: ContractInput;
  option?: ContractOption | null;
}): QuoteContract {
  const resolved = resolveSections({ kind: "estimate", template: input.template, optionSectionIds: input.optionSectionIds, quoteSectionIds: input.quoteSectionIds, library: input.library });
  const values = contractValues(input.facts);
  return {
    // Plain text: the paper prints the terms as words, never as HTML.
    terms: fillIn(input.template.terms, values, { text: true }),
    sections: resolved.map((s) => ({ id: s.id, title: s.title, html: fillIn(s.body, values), place: s.place, initials: s.initials })),
    hash: sectionsHash(resolved, { terms: input.template.terms, values, option: input.option ?? null }),
  };
}

/**
 * An invoice's contract, filled in: the template's terms and its invoice sections (core
 * invoiceInput for the facts), as the Client Hub prints them. Nobody initials an invoice.
 */
export function invoiceContract(input: { template: Pick<TemplateSettings, "terms" | "sections" | "invoice_sections">; library: readonly LibrarySection[]; facts: ContractInput }): QuoteContract {
  const values = contractValues(input.facts);
  return {
    terms: fillIn(input.template.terms, values, { text: true }),
    sections: resolveSections({ kind: "invoice", template: input.template, library: input.library }).map((s) => ({ id: s.id, title: s.title, html: fillIn(s.body, values), place: s.place, initials: false })),
    hash: null,
  };
}

/** The contract kept with an approval, as it prints: initialed where the customer initialed it. Null when none was kept. */
export function signedContract(approval: QuoteApproval | null | undefined): QuoteContract | null {
  return approval?.contract ? keptContract(approval.contract, approval.initials ?? null) : null;
}

/** A contract as it was signed (approval.contract), with the customer's initials (approval.initials) on the sections they initialed. */
export function keptContract(contract: ApprovalContract, stamp: { image: string; signed_at: string | null } | null): QuoteContract {
  return {
    terms: contract.terms,
    sections: contract.sections.map((s) => ({
      id: s.id,
      title: s.title,
      html: s.body,
      place: s.place,
      initials: s.initials,
      initialed: s.initials && s.initialed && stamp ? { image: stamp.image, date: stamp.signed_at } : null,
    })),
    hash: null,
  };
}

/** Whether there's a contract to read before signing: a section, or the template's own terms. */
export const hasContract = (contract: QuoteContract | null | undefined) => Boolean(contract && (contract.sections.length > 0 || contract.terms.trim()));

/** The template with the contract's terms (filled in) in place of its own; as it is without a contract. */
export const contractTemplate = <T extends Pick<TemplateSettings, "terms">>(template: T, contract: QuoteContract | null | undefined): T => (contract ? { ...template, terms: contract.terms } : template);

/**
 * The sections a customer has added their initials to, each with its words (its filled-in HTML) as
 * they were then. Another option, another total or new terms change a section's words, and then it
 * isn't initialed anymore (stillInitialed): they initial what they read.
 */
export type InitialedSections = ReadonlyMap<string, string>;

/** `initialed` with the customer's initials added to this section, as its words are now, or taken off it. */
export function initialSection(initialed: InitialedSections, section: Pick<DocumentSection, "id" | "html">, on: boolean): Map<string, string> {
  const next = new Map(initialed);
  if (on) next.set(section.id, section.html);
  else next.delete(section.id);
  return next;
}

/** The sections still initialed: the ones that ask, whose words are the ones the customer initialed. */
export const stillInitialed = (contract: QuoteContract | null | undefined, initialed: InitialedSections): Set<string> =>
  new Set((contract?.sections ?? []).filter((s) => s.initials && initialed.get(s.id) === s.html).map((s) => s.id));

/** The sections that ask for the customer's initials and don't have them yet. */
export const awaitingInitials = (contract: QuoteContract | null | undefined, initialed: ReadonlySet<string>) =>
  (contract?.sections ?? []).filter((s) => s.initials && !initialed.has(s.id));

/**
 * The contract with the customer's initials (drawn once) stamped on the sections they've confirmed,
 * as the copy being signed shows them.
 */
export function withInitials(contract: QuoteContract, initials: { image: string; date: string | null } | null, initialed: ReadonlySet<string>): QuoteContract {
  return { ...contract, sections: contract.sections.map((s) => ({ ...s, initialed: s.initials && initials && initialed.has(s.id) ? initials : null })) };
}

/**
 * The contract as an approval keeps it (approval.contract), for an approval made in the office, where
 * nobody initials anything.
 */
export function approvalContract(contract: QuoteContract): ApprovalContract {
  return { terms: contract.terms, sections: contract.sections.map((s) => ({ id: s.id, title: s.title, body: s.html, place: s.place, initials: s.initials, initialed: false })) };
}

// ---------------------------------------------------------------------------------------------
// An invoice as a document
// ---------------------------------------------------------------------------------------------

/** The invoice fields a document reads: the staff app's invoice row and the Client Hub's both fit. */
export interface DocumentInvoice {
  number: number | null;
  issued_on: string;
  due_on: string | null;
  subject: string | null;
  notes: string | null;
  subtotal: Amount;
  discount_amount: Amount;
  /** Referral credits: what the invoice takes of them (credit_amount), each with its note. */
  credit_amount?: Amount;
  credits?: ReadonlyArray<{ amount: Amount; note: string }> | null;
  tax_amount: Amount;
  total: Amount;
  retainage_amount: Amount;
  balance_due: Amount;
  promo?: { code?: string | null } | null;
  client?: { display_name: string } | null;
  /** An invoice offers no options: every line is on it. */
  lines: ReadonlyArray<Omit<DocumentQuoteLine, "option_id">>;
  payments: ReadonlyArray<{ amount: Amount; received_at: string }>;
}

/**
 * Each credit as much of it as the invoice takes, in the order they went on, so they add up to
 * credit_amount. A void invoice keeps the credit it was sent with after the credits are given
 * back, so what no credit accounts for is one "Referral credit" line.
 */
function invoiceCredits(credits: ReadonlyArray<{ amount: Amount; note: string }>, total: number) {
  let left = Math.round(total * 100);
  const lines: Array<{ label: string; amount: number }> = [];
  for (const c of credits) {
    const cents = Math.min(Math.round(Number(c.amount) * 100), left);
    if (cents <= 0) break;
    lines.push({ label: c.note, amount: cents / 100 });
    left -= cents;
  }
  if (left > 0) lines.push({ label: "Referral credit", amount: left / 100 });
  return lines;
}

/**
 * An invoice as its template document: what was billed, what's been paid and refunded (on the
 * business's calendar, `timeZone`), and what's left, with its contract sections after its notes.
 */
export function invoiceDocument(inv: DocumentInvoice, extras: { timeZone: string; contract?: DocumentContract | null }): DocumentData {
  // Printed as deductions from the total ("−$500.00"); a refund's negative amount adds back. A
  // payment that was only a tip doesn't change what's owed, so it isn't among them.
  const payments = inv.payments
    .filter((p) => Number(p.amount) !== 0)
    .map((p) => ({ label: `${Number(p.amount) > 0 ? "Paid" : "Refunded"} ${formatDate(dateIn(p.received_at, extras.timeZone))}`, amount: Number(p.amount) }));
  if (Number(inv.retainage_amount) > 0) payments.unshift({ label: "Retainage (billed later)", amount: Number(inv.retainage_amount) });
  const discount = Math.min(Number(inv.discount_amount), Math.max(Number(inv.subtotal), 0));
  return {
    kind: "invoice",
    ...(inv.credits?.length || Number(inv.credit_amount ?? 0) > 0 ? { credits: invoiceCredits(inv.credits ?? [], Number(inv.credit_amount ?? 0)) } : {}),
    number: inv.number,
    date: inv.issued_on,
    dueOn: inv.due_on,
    title: inv.subject,
    client: { name: inv.client?.display_name ?? "", lines: [] },
    lines: documentLines(inv.lines.map((l) => ({ ...l, option_id: null }))),
    subtotal: Number(inv.subtotal),
    discount,
    discountLabel: discount > 0 && inv.promo?.code ? `Promo code ${inv.promo.code}` : undefined,
    tax: Number(inv.tax_amount),
    total: Number(inv.total),
    payments,
    balanceDue: Number(inv.balance_due),
    notes: inv.notes?.trim() || null,
    ...(extras.contract ? { contract: { sections: extras.contract.sections } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Samples for the template builder
// ---------------------------------------------------------------------------------------------

function sample(lines: Array<[name: string, quantity: number, unit: string, price: number, description?: string]>, rest: Omit<DocumentData, "kind" | "lines" | "subtotal" | "discount" | "tax" | "total" | "number" | "date" | "validUntil">): DocumentData {
  const docLines = lines.map(([name, quantity, unit, unit_price, description]) => ({ name, description: description ?? null, quantity, unit, unit_price, total: lineTotal(quantity, unit_price) }));
  const subtotal = docLines.reduce((sum, l) => sum + toCents(l.total), 0) / 100;
  const today = new Date();
  const until = new Date(today.getTime() + 30 * 86_400_000);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { kind: "estimate", number: 1042, date: iso(today), validUntil: iso(until), lines: docLines, subtotal, discount: 0, tax: 0, total: subtotal, ...rest };
}

/** A believable roof estimate, for the live preview and "Print a sample". */
export const SAMPLE_DOCUMENT: DocumentData = sample(
  [
    ["Architectural shingle roof", 24.2, "square", 560, "Installed, with 10% for waste"],
    ["Tear-off and disposal", 22, "square", 85, "One layer"],
    ["Drip edge", 210, "ft", 3.5, "Eaves and rakes"],
    ["Ridge cap", 64, "ft", 9, "Ridges and hips"],
    ["Valley flashing", 38, "ft", 8],
    ["Ridge vent", 48, "ft", 9],
    ["Pipe boot", 3, "ea", 45],
    ["Dumpster", 1, "ea", 450, "And cleanup"],
    ["Building permit", 1, "ea", 250],
  ],
  { client: { name: "Alex Morgan", lines: ["1482 Maple Ave", "Springfield, IL 62704"] }, deposit: null },
);

/** A plain estimate for any other trade. */
export const SAMPLE_GENERAL_DOCUMENT: DocumentData = sample(
  [
    ["Labor, two-person crew", 12, "hr", 95],
    ["Materials", 1, "ea", 860, "Everything the job needs, delivered"],
    ["Equipment rental", 1, "ea", 180],
    ["Cleanup and haul away", 1, "ea", 150],
  ],
  { client: { name: "Alex Morgan", lines: ["1482 Maple Ave", "Springfield, IL 62704"] }, deposit: null },
);

/** The sample that looks like the business's own work. */
export const sampleDocument = (trade: string | null | undefined) => (trade === "roofing_exteriors" ? SAMPLE_DOCUMENT : SAMPLE_GENERAL_DOCUMENT);

/** A business as printed, from what the app already knows (session company, or a companies row). */
export function documentCompany(row: { name: string; phone?: string | null; email?: string | null; website?: string | null; address?: unknown; settings?: unknown }): DocumentCompany {
  return {
    name: row.name,
    phone: row.phone?.trim() || null,
    email: row.email?.trim() || null,
    website: row.website?.trim() || null,
    address: addressLines(row.address),
    logo: logoUrl(row.settings),
    settings: row.settings ?? {},
  };
}
