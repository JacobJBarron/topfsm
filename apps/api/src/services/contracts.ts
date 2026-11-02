/**
 * The contract on an estimate, on the server: the business's contract sections a quote prints
 * (always looked up in its own library), the facts their fill-ins come from, and the copy kept with
 * the approval when the homeowner signs, online (routes/public.ts) or on the salesperson's iPad
 * (services/signing.ts), or when it's approved without a signature (manualApproval: an assistant's
 * mark_quote, a quote turned into a job before it was signed); and an invoice's sections, filled in
 * for the Client Hub. The rules are core contracts.ts, which the browser runs too, so the words a
 * homeowner reads before signing are the words kept once they sign. The options a quote offers
 * (quote_options) are read here as well, since the option chosen decides the sections and is kept
 * with the signature.
 */
import { addressLines, contractInput, contractValues, fillIn, invoiceInput, resolveSections, sectionsHash, type ContractInput, type ContractSection, type LibrarySection } from "@crewtavo/core/contracts";
import { pickTemplate, type TemplateSettings } from "@crewtavo/core/documents";
import { optionBaseTotal, optionTierLabels, optionTotals, quoteTotals, type Amount, type OptionLine } from "@crewtavo/core/money";
import { isPackagePicturePath } from "@crewtavo/core/presets";
import { z } from "zod";
import { dbError, HttpError, must } from "../lib/http";
import type { Db } from "../lib/supabase";
import { isDrawnPng } from "./logo";

/**
 * Initials drawn on the screen once, to stamp on each section that asks: a small PNG data URL, up to
 * 60 KB, of a size a signature pad makes (logo.ts isDrawnPng).
 */
export const initialsImage = z.string().max(60 * 1024).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).refine(isDrawnPng);

/** The fingerprint of the terms a homeowner read (core sectionsHash): 16 hex digits. */
export const sectionsHashSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** A posted id (an option, an add-on) as the database writes it, so one sent in capitals still matches. */
export const postedId = z.uuid().transform((id) => id.toLowerCase());

// The fill-in facts live in core so the iPad builds exactly the facts this server freezes.
export { addressLines, contractInput, invoiceInput };

// ---------------------------------------------------------------------------------------------
// The options a quote offers
// ---------------------------------------------------------------------------------------------

/** The columns of an option the Client Hub shows and a signature keeps. */
export const OPTION_FIELDS = "id, name, tier, picture, picture_width, picture_height, style, highlights, warranty, section_ids, sort";

/** An option as it was offered (quote_options): a copy of the package it came from. */
export interface OptionRow {
  id: string;
  name: string;
  tier: string | null;
  picture: string | null;
  picture_width: number | null;
  picture_height: number | null;
  style: string;
  highlights: string[];
  warranty: string;
  section_ids: string[];
  sort: number;
}

/**
 * Whether an option has a price of its own: at least one line on it that isn't an add-on. One made
 * before the roof was measured, or whose package was gone when it was filled, has none yet, so it
 * can't be signed: it would come to the shared lines alone.
 */
export const isPriced = (option: Pick<OptionRow, "id">, lines: ReadonlyArray<{ option_id: string | null; optional: boolean | null }>) =>
  lines.some((l) => l.option_id === option.id && !l.optional);

/** A quote's options, in the order they're offered; none for a quote without options. */
export async function loadOptions(db: Db, companyId: string, quoteId: string): Promise<OptionRow[]> {
  const { data, error } = await db.from("quote_options").select(OPTION_FIELDS).eq("company_id", companyId).eq("quote_id", quoteId).order("sort");
  if (error) throw dbError(error);
  return [...(data ?? [])].sort((a, b) => a.sort - b.sort);
}

type TotalsOptions = Parameters<typeof quoteTotals>[1];

/**
 * The tier word on each option's card, as the Client Hub shows it: the option's own, or "Good",
 * "Better" and "Best" by each option's price before add-ons when none has one (core optionTierLabels).
 */
export function optionTiers(options: ReadonlyArray<Pick<OptionRow, "id" | "tier">>, lines: readonly OptionLine[], opts: TotalsOptions): Map<string, string> {
  return optionTierLabels(options.map((o) => ({ id: o.id, tier: o.tier, total: optionBaseTotal(lines, o.id, opts) })));
}

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

/**
 * The business's contract sections with these ids, as the library (core LibrarySection), in the
 * library's order (sort, then created_at, then id), which an option's and a quote's sections print in
 * (core resolveSections), as the browser reads it. Only ever the business's own: an id from another
 * business's library is left out, like a deleted one.
 */
export async function loadLibrary(db: Db, companyId: string, ids: readonly string[]): Promise<LibrarySection[]> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => z.uuid().safeParse(id).success);
  if (!wanted.length) return [];
  const { data, error } = await db.from("contract_sections").select("id, title, body, place, initials").eq("company_id", companyId).in("id", wanted).order("sort").order("created_at").order("id");
  if (error) throw dbError(error);
  return data ?? [];
}

/** The contract on an estimate for one option: the template's terms and sections as written (before fill-ins). */
export interface Contract {
  terms: string;
  sections: ContractSection[];
}

/**
 * The contract a homeowner signs: the template's sections, then the chosen option's, then the ones
 * added to this quote (core resolveSections), from the business's own library.
 */
export async function resolveContract(
  db: Db,
  companyId: string,
  input: { template: Pick<TemplateSettings, "terms" | "sections" | "invoice_sections">; option: Pick<OptionRow, "section_ids"> | null; quoteSectionIds: readonly string[] | null },
): Promise<Contract> {
  const optionIds = input.option?.section_ids ?? [];
  const quoteIds = input.quoteSectionIds ?? [];
  const library = await loadLibrary(db, companyId, [...input.template.sections, ...optionIds, ...quoteIds]);
  const sections = resolveSections({ kind: "estimate", template: input.template, optionSectionIds: optionIds, quoteSectionIds: quoteIds, library });
  return { terms: input.template.terms, sections };
}

/**
 * The fingerprint of the contract as the copy kept with the signature says it (core sectionsHash):
 * the terms and sections filled in from `facts`, and the option's card as the approval keeps it
 * (freezeOption; null without options). The Client Hub and the iPad send it from the paper they showed.
 */
export function contractHash(contract: Contract, facts: ContractInput, option: Pick<FrozenOption, "name" | "tier" | "warranty" | "highlights"> | null): string {
  const card = option && { name: option.name, tier: option.tier, warranty: option.warranty, highlights: option.highlights };
  return sectionsHash(contract.sections, { terms: contract.terms, values: contractValues(facts), option: card });
}

/**
 * Whether the contract can be signed as it was posted: the paper the homeowner read says what the copy
 * kept will say (contractHash of `kept`, the facts and option card it's frozen with, when the page sent
 * its fingerprint), and their initials came with it when a section asks.
 */
export function checkContract(contract: Contract, posted: { sections_hash?: string; initials?: string | null }, kept: { facts: ContractInput; option: FrozenOption | null }) {
  if (posted.sections_hash !== undefined && posted.sections_hash !== contractHash(contract, kept.facts, kept.option)) throw new HttpError(409, "The terms changed. Please look them over again.");
  if (!posted.initials && contract.sections.some((s) => s.initials)) throw new HttpError(400, "Add your initials where the terms ask for them.");
}

export interface InvoiceContract {
  terms: string;
  sections: ContractSection[];
}

/**
 * The contract an invoice prints: the template's terms and its invoice sections, from the business's
 * own library, with the fill-ins filled. An invoice offers no options and isn't signed, so it's
 * worked out once, here, and the Client Hub prints it as it comes.
 */
export async function invoiceContract(db: Db, companyId: string, template: Pick<TemplateSettings, "terms" | "sections" | "invoice_sections">, facts: ContractInput): Promise<InvoiceContract> {
  const library = await loadLibrary(db, companyId, template.invoice_sections);
  const values = contractValues(facts);
  return {
    terms: fillIn(template.terms, values, { text: true }),
    sections: resolveSections({ kind: "invoice", template, library }).map((s) => ({ ...s, body: fillIn(s.body, values) })),
  };
}

/**
 * The facts that don't depend on the option, as the Client Hub sends them: the browser adds the total,
 * option and warranty of the option picked, so it fills in exactly what the server keeps. An estimate
 * without options says its package's name and warranty (packageFill) here instead, as `optionName`
 * and `warranty`; with options they're null, and the option picked says them.
 */
export function contractFacts(input: ContractInput) {
  return {
    customerName: input.customerName ?? "",
    customerAddress: input.customerAddress ?? [],
    jobAddress: input.jobAddress ?? [],
    businessName: input.businessName ?? "",
    businessPhone: input.businessPhone ?? null,
    license: input.license ?? "",
    estimateNumber: input.estimateNumber ?? null,
    date: input.date ?? null,
    timeZone: input.timeZone ?? null,
    deposit: input.deposit === null || input.deposit === undefined ? null : Number(input.deposit),
    optionName: input.optionName ?? null,
    warranty: input.warranty ?? null,
  };
}

/**
 * What {Option} and {Warranty} say on an estimate that doesn't offer options: the package it was
 * priced from (quotes.roof_package_id), its name and warranty as they are now. Null without one (a
 * quote made line by line, or one whose package was deleted). With options, pass the option chosen to
 * contractInput instead; this is only for a quote that has none.
 */
export async function packageFill(db: Db, companyId: string, packageId: string | null | undefined): Promise<{ name: string; warranty: string } | null> {
  if (!packageId) return null;
  const { data, error } = await db.from("roof_packages").select("name, warranty").eq("company_id", companyId).eq("id", packageId).maybeSingle();
  if (error) throw dbError(error);
  return data ? { name: data.name, warranty: data.warranty ?? "" } : null;
}

/**
 * What {Option} and {Warranty} say on an invoice for a job made from a quote: the option the client
 * chose as it was kept with the approval, else the option the quote shows (approved before options
 * were kept), else, for a quote without options, the package it was priced from (packageFill). Null
 * for an invoice whose job didn't come from a quote.
 */
export async function invoiceFill(
  db: Db,
  companyId: string,
  quote: { approval: unknown; option_id: string | null; roof_package_id: string | null; option?: { name: string; warranty: string | null } | null } | null | undefined,
): Promise<{ name: string; warranty: string } | null> {
  if (!quote) return null;
  const kept = readFrozen(quote.approval).option ?? quote.option;
  if (kept) return { name: kept.name, warranty: kept.warranty ?? "" };
  return quote.option_id ? null : packageFill(db, companyId, quote.roof_package_id);
}

// ---------------------------------------------------------------------------------------------
// The copy kept when it's signed
// ---------------------------------------------------------------------------------------------

/** The option chosen, as it was offered (approval.option). */
export interface FrozenOption {
  id: string;
  name: string;
  tier: string | null;
  picture: { path: string; width: number; height: number } | null;
  style: string;
  highlights: string[];
  warranty: string;
}

/** A section as it was signed: its fill-ins filled, and whether the homeowner initialed it. */
export interface FrozenSection extends ContractSection {
  initialed: boolean;
}

/** The contract as it was signed (approval.contract): the template's terms (plain text) and the sections (HTML), filled in. */
export interface FrozenContract {
  terms: string;
  sections: FrozenSection[];
}

/** The homeowner's initials (approval.initials), drawn once and stamped on each section that asks. */
export interface FrozenInitials {
  image: string;
  signed_at: string | null;
}

/** An option as the approval keeps it, with the tier word on its card. */
export function freezeOption(option: OptionRow, tier?: string | null): FrozenOption {
  const sized = option.picture && isPackagePicturePath(option.picture) && option.picture_width && option.picture_height;
  return {
    id: option.id,
    name: option.name,
    tier: tier ?? option.tier ?? null,
    picture: sized ? { path: option.picture!, width: option.picture_width!, height: option.picture_height! } : null,
    style: option.style,
    highlights: option.highlights ?? [],
    warranty: option.warranty ?? "",
  };
}

/**
 * What an approval keeps of the contract (its option, contract and initials keys): the option chosen
 * as it was offered, the template's terms and each section with the fill-ins filled in from `facts`,
 * and the homeowner's initials once, when a section asks for them. The signed copy prints from these,
 * never from today's library. Check the contract first (checkContract), with the same facts and card.
 */
export function freezeContract(input: { contract: Contract; facts: ContractInput; option: OptionRow | null; tier?: string | null; initials: string | null; signedAt: string }): {
  option: FrozenOption | null;
  contract: FrozenContract;
  initials: FrozenInitials | null;
} {
  const values = contractValues(input.facts);
  const initialed = Boolean(input.initials);
  const asks = input.contract.sections.some((s) => s.initials);
  return {
    option: input.option ? freezeOption(input.option, input.tier) : null,
    contract: {
      // The terms print as plain text (the paper escapes them), so the values go in as they are.
      terms: fillIn(input.contract.terms, values, { text: true }),
      sections: input.contract.sections.map((s) => ({ ...s, body: fillIn(s.body, values), initialed: s.initials && initialed })),
    },
    initials: input.initials && asks ? { image: input.initials, signed_at: input.signedAt } : null,
  };
}

const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" ? value : null);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/**
 * The option, contract and initials an approval kept (freezeContract), field by field, so only what
 * a signed copy prints gets out; null for any it doesn't have (signed before they were kept, or
 * marked approved by the office without them).
 */
export function readFrozen(approval: unknown): { option: FrozenOption | null; contract: FrozenContract | null; initials: FrozenInitials | null } {
  const a = record(approval) ?? {};
  const o = record(a.option);
  const picture = record(o?.picture);
  const path = text(picture?.path);
  const size = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  const option: FrozenOption | null =
    o && text(o.id) && text(o.name)
      ? {
          id: text(o.id)!,
          name: text(o.name)!,
          tier: text(o.tier),
          picture: path && isPackagePicturePath(path) && size(picture!.width) && size(picture!.height) ? { path, width: size(picture!.width)!, height: size(picture!.height)! } : null,
          style: text(o.style) ?? "other",
          highlights: strings(o.highlights),
          warranty: text(o.warranty) ?? "",
        }
      : null;
  const c = record(a.contract);
  const contract: FrozenContract | null = c
    ? {
        terms: text(c.terms) ?? "",
        sections: (Array.isArray(c.sections) ? c.sections : []).flatMap((raw) => {
          const s = record(raw);
          if (!s || !text(s.id) || text(s.title) === null) return [];
          return [{ id: text(s.id)!, title: text(s.title)!, body: text(s.body) ?? "", place: s.place === "signatures" ? ("signatures" as const) : ("terms" as const), initials: s.initials === true, initialed: s.initialed === true }];
        }),
      }
    : null;
  const i = record(a.initials);
  const image = text(i?.image);
  const initials = image && isDrawnPng(image) ? { image, signed_at: text(i!.signed_at) } : null;
  return { option, contract, initials };
}

// ---------------------------------------------------------------------------------------------
// The copy kept when nobody signs
// ---------------------------------------------------------------------------------------------

const MANUAL_FIELDS =
  "id, number, status, sent_at, created_at, total, deposit_amount, tax_rate, discount_amount, template_id, option_id, section_ids, roof_package_id, promo:promo_codes(kind, value), client:clients(display_name, billing_address), property:properties(line1, city, region, postal_code), lines:quote_line_items(id, option_id, quantity, unit_price, taxable, optional, selected)";

/** An approval kept without a signature (manualApproval), as the office's "Mark approved" keeps it in the browser. */
export interface ManualApproval {
  name: string;
  method: "manual";
  template: TemplateSettings;
  option: FrozenOption | null;
  contract: FrozenContract;
  initials: null;
}

/**
 * The approval kept when the client said yes another way and nobody signs: an assistant marks the
 * quote approved, or the office turns one that was only sent into a job. Like a signature's (the
 * Client Hub's approve, the iPad's signQuote), it keeps the template as it is now and the contract the
 * client was sent, filled in for the option they chose (`optionId`; null for a quote without options)
 * at what the quote comes to with it (the option's add-ons as they'd be once it's shown), so the
 * signed copy prints those words whatever the library or the template says later. Nobody initialed
 * anything. The web's "Mark approved" keeps the same in the browser (QuotePage officeApproval).
 */
export async function manualApproval(db: Db, companyId: string, quoteId: string, input: { name: string; optionId: string | null }): Promise<ManualApproval> {
  const [quoteResult, companyResult, templates, options] = await Promise.all([
    db.from("quotes").select(MANUAL_FIELDS).eq("id", quoteId).eq("company_id", companyId).maybeSingle(),
    db.from("companies").select("name, phone, timezone, trade_preset").eq("id", companyId).maybeSingle(),
    db.from("document_templates").select("id, is_default, settings").eq("company_id", companyId),
    loadOptions(db, companyId, quoteId),
  ]);
  const quote = must(quoteResult, "That quote wasn't found.");
  const company = must(companyResult, "Company not found.");
  if (templates.error) throw dbError(templates.error);
  const option = input.optionId ? (options.find((o) => o.id === input.optionId) ?? null) : null;
  if (input.optionId && !option) throw new HttpError(409, "That option isn't on this quote any more.");
  // The trade's starter terms when the business never saved its own, as the Hub and the printout show them.
  const template = pickTemplate(templates.data ?? [], quote.template_id, company.trade_preset);
  const lines = quote.lines ?? [];
  const money = { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo };
  const total = option ? optionTotals(lines, option.id, quote.option_id, money).total : quote.total;
  // Without options, {Option} and {Warranty} say the package it was priced from.
  const fill = option ?? (options.length ? null : await packageFill(db, companyId, quote.roof_package_id));
  const contract = await resolveContract(db, companyId, { template, option, quoteSectionIds: quote.section_ids });
  const kept = freezeContract({
    contract,
    facts: contractInput({ ...quote, total }, quote.client, quote.property, company, template, fill),
    option,
    tier: option ? optionTiers(options, lines, money).get(option.id) : null,
    initials: null,
    signedAt: new Date().toISOString(),
  });
  return { name: input.name, method: "manual", template, option: kept.option, contract: kept.contract, initials: null };
}
