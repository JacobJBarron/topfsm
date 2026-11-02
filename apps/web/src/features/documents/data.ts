/**
 * The data a document needs in the staff app: the business's estimate templates, its letterhead
 * (name, address, phone, logo), the signed-in person's saved signature, and the contract a quote or
 * invoice prints (the sections from the business's library, filled in for it). The builders that
 * turn records into a document live in build.ts and are re-exported here.
 */
import { contractInput, invoiceInput, type LibrarySection } from "@crewtavo/core/contracts";
import { pickTemplate, type TemplateSettings } from "@crewtavo/core/documents";
import type { Amount } from "@crewtavo/core/money";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { documentCompany, invoiceContract, isSignedQuote, liveContract, readApproval, signedContract, signedTemplate, type QuoteContract, type TemplatedQuote } from "./build";
import type { DocumentCompany } from "./types";

export * from "./build";

/** A document_templates row. Its settings go through templateSettings() before they're used. */
export interface TemplateRow {
  id: string;
  name: string;
  is_default: boolean;
  settings: unknown;
}

export const templatesKey = (companyId: string) => ["document-templates", companyId] as const;

/** The business's estimate templates, the default first, then by name. */
export const templatesQuery = (companyId: string) =>
  queryOptions({
    queryKey: templatesKey(companyId),
    queryFn: async () => {
      const rows = unwrap(await supabase().from("document_templates").select("id, name, is_default, settings").eq("company_id", companyId).order("name")) as TemplateRow[];
      return [...rows].sort((a, b) => Number(b.is_default) - Number(a.is_default));
    },
  });

export function useTemplates() {
  const { company } = useSession();
  return useQuery(templatesQuery(company.id));
}

/**
 * The template a quote prints with: the one it names, else the default, else the built-in look, with
 * the business's trade's starter terms until it saves its own (as the Client Hub and the signed copy).
 */
export function useDocumentTemplate(templateId?: string | null): { template: TemplateSettings; isPending: boolean } {
  const { company } = useSession();
  const templates = useTemplates();
  return { template: pickTemplate(templates.data ?? [], templateId, company.trade_preset), isPending: templates.isPending };
}

/**
 * The template a quote prints with, once it's signed too: a signed quote keeps the template saved
 * with its approval, whatever happened to the business's templates since. Before that (or for a
 * quote signed before approvals saved it), the same as useDocumentTemplate(quote.template_id).
 */
export function useQuoteTemplate(quote: TemplatedQuote): { template: TemplateSettings; isPending: boolean } {
  const live = useDocumentTemplate(quote.template_id);
  const signed = signedTemplate(quote);
  return signed ? { template: signed, isPending: false } : live;
}

export const letterheadKey = (companyId: string) => ["letterhead", companyId] as const;

/**
 * The business at the top of every document. It starts from the signed-in session (name, address,
 * logo, brand color), so a document shows straight away, then fills in the phone, email and website.
 */
export function useLetterhead() {
  const { company } = useSession();
  return useQuery({
    queryKey: letterheadKey(company.id),
    queryFn: async (): Promise<DocumentCompany> =>
      documentCompany(unwrap(await supabase().from("companies").select("name, phone, email, website, address, settings").eq("id", company.id).single())),
    placeholderData: () => documentCompany(company),
  });
}

export const mySignatureKey = (companyId: string, userId: string) => ["my-signature", companyId, userId] as const;

/** The signed-in person's saved signature (a PNG data URL), or null when they haven't saved one. */
export function useMySignature(options: { enabled?: boolean } = {}) {
  const { company, userId } = useSession();
  return useQuery({
    queryKey: mySignatureKey(company.id, userId),
    queryFn: async () => (await api.get<{ image: string | null }>("/me/signature")).image,
    enabled: options.enabled ?? true,
    staleTime: 5 * 60_000,
  });
}

/** Saves the signed-in person's signature for every estimate they sign after. The saved signature showing in place of the pad says it worked. */
export function useSaveMySignature() {
  const { company, userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inline: true },
    mutationFn: async (image: string) => (await api.put<{ image: string }>("/me/signature", { image })).image,
    onSuccess: (image) => queryClient.setQueryData(mySignatureKey(company.id, userId), image),
  });
}

/** Forgets the signed-in person's saved signature. Estimates already signed keep theirs. */
export function useRemoveMySignature() {
  const { company, userId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ ok: true }>("/me/signature"),
    onSuccess: () => queryClient.setQueryData(mySignatureKey(company.id, userId), null),
  });
}

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

/** Settings → Contract terms keeps the library under this key too, so a change there reaches the paper. */
const librarySectionsKey = (companyId: string, ids: readonly string[]) => ["contract-sections", companyId, "by-id", ids] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The business's contract sections with these ids, in the library's order, with their words as written (before fill-ins).
 * Only ever its own: an id from another business, like a deleted one, is left out (core
 * resolveSections drops it).
 */
function useLibrary(ids: readonly string[], enabled: boolean) {
  const { company } = useSession();
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))].filter((id) => UUID.test(id)).sort();
  return useQuery({
    queryKey: librarySectionsKey(company.id, wanted),
    enabled,
    queryFn: async (): Promise<LibrarySection[]> =>
      wanted.length ? unwrap(await supabase().from("contract_sections").select("id, title, body, place, initials").eq("company_id", company.id).in("id", wanted).order("sort").order("created_at").order("id")) : [],
  });
}

/** The business as a contract's fill-ins name it: its name and phone, and its time zone for {Date}. */
export interface ContractCompany {
  name: string;
  phone: string | null;
  timezone: string | null;
}

function useContractCompany() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["contract-company", company.id],
    queryFn: async (): Promise<ContractCompany> => unwrap(await supabase().from("companies").select("name, phone, timezone").eq("id", company.id).single()),
    staleTime: 5 * 60_000,
  });
}

/** What a quote's contract is filled in from, as the server fills in the copy it keeps (core contractInput). */
export interface QuoteContractInput {
  quote: {
    status: string;
    number: number | null;
    sent_at: string | null;
    created_at: string;
    deposit_amount: Amount;
    /** The sections added to this job (quotes.section_ids). */
    section_ids?: readonly string[] | null;
    /** A signed quote prints the contract kept with it. */
    approval?: unknown;
  };
  /** The template it prints with (useQuoteTemplate). */
  template: TemplateSettings;
  /**
   * The option it's for (the one shown, or picked), with the sections its package brings, and its
   * card as the customer sees it (the tier word on it, as core optionTierLabels words it, and its
   * highlights), which the fingerprint sent with a signature covers; null without options.
   */
  option: { name: string; warranty: string | null; section_ids?: readonly string[] | null; tier?: string | null; highlights?: readonly string[] | null } | null;
  /** Without options: what {Option} and {Warranty} say, the package it was priced from (as the server fills them in); null without one. */
  fill?: { name: string; warranty: string | null } | null;
  /** What it comes to with that option and the add-ons picked: the total being signed, for {Total}. */
  total: Amount;
  client: { display_name?: string | null; billing_address?: unknown } | null;
  /** The job's address (quotes.property: line1, city, region, postal_code). */
  property: unknown;
}

/**
 * The contract a quote prints, filled in (build.ts QuoteContract), from what it's filled in from, the
 * business and the library's sections it names: for an open quote, the template's sections, the
 * option's and the quote's own, with the facts the server fills the signed copy in with (core
 * contractInput), so the words the customer signs are the words kept; for a signed one, the copy
 * kept with its approval (or, signed before that was kept, the template's terms filled in as they
 * are today, as the Client Hub shows it). What useQuoteContract shows, once it's loaded.
 */
export function quoteContract(input: QuoteContractInput, company: ContractCompany, library: readonly LibrarySection[]): QuoteContract {
  const signed = isSignedQuote(input.quote.status);
  const kept = signed ? signedContract(readApproval(input.quote.approval)) : null;
  if (kept) return kept;
  const { option } = input;
  const facts = contractInput({ ...input.quote, total: input.total }, input.client, input.property, company, input.template, option ?? input.fill ?? null);
  const card = option && { name: option.name, tier: option.tier ?? null, warranty: option.warranty, highlights: option.highlights ?? [] };
  return liveContract({ template: input.template, library: signed ? [] : library, optionSectionIds: option?.section_ids, quoteSectionIds: input.quote.section_ids, facts, option: card });
}

/** A contract being loaded: null until it's in, or when there's nothing to load yet; `refetch` tries again after an error. */
export interface LoadingContract {
  contract: QuoteContract | null;
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
}

/** The contract a quote prints, filled in (quoteContract), loading the business and the library's sections it needs. */
export function useQuoteContract(input: QuoteContractInput | null): LoadingContract {
  const signed = input ? isSignedQuote(input.quote.status) : false;
  const kept = signed ? signedContract(readApproval(input!.quote.approval)) : null;
  const ids = input && !signed ? [...input.template.sections, ...(input.option?.section_ids ?? []), ...(input.quote.section_ids ?? [])] : [];
  const library = useLibrary(ids, Boolean(input) && !signed);
  const company = useContractCompany();
  const contract = useMemo(() => {
    if (!input) return null;
    if (kept) return kept;
    if (!company.data || (!signed && !library.data)) return null;
    return quoteContract(input, company.data, library.data ?? []);
  }, [input, kept, signed, company.data, library.data]);
  return { contract, isPending: Boolean(input) && !contract && !company.error && !library.error, error: company.error ?? library.error ?? null, refetch: () => void Promise.all([library.refetch(), company.refetch()]) };
}

/** What an invoice's contract is filled in from, as the Client Hub fills it in (core invoiceInput). */
export interface InvoiceContractInput {
  invoice: { number: number | null; issued_on: string; total: Amount };
  template: TemplateSettings;
  client: { display_name?: string | null; billing_address?: unknown } | null;
  /** The job's address. */
  property: unknown;
  /** What {Option} and {Warranty} say (invoiceFill); null for an invoice whose job didn't come from a quote. */
  fill?: { name: string; warranty: string | null } | null;
}

/** The quote an invoice's job was made from, as invoiceFill reads it (jobs → quotes, with its option and package). */
export interface InvoiceQuote {
  approval: unknown;
  option_id: string | null;
  option?: { name: string; warranty: string | null } | null;
  package?: { name: string; warranty: string | null } | null;
}

/**
 * What {Option} and {Warranty} say on an invoice for a job made from a quote, as the server fills
 * them in (services/contracts.ts invoiceFill): the option the client chose as it was kept with the
 * approval, else the option the quote shows, else, for a quote without options, the package it was
 * priced from. Null for an invoice whose job didn't come from a quote.
 */
export function invoiceFill(quote: InvoiceQuote | null | undefined): { name: string; warranty: string } | null {
  if (!quote) return null;
  const kept = readApproval(quote.approval)?.option ?? quote.option;
  if (kept) return { name: kept.name, warranty: kept.warranty ?? "" };
  return !quote.option_id && quote.package ? { name: quote.package.name, warranty: quote.package.warranty ?? "" } : null;
}

/** The contract an invoice prints, filled in: the template's terms and its invoice sections. Null until it's loaded. */
export function useInvoiceContract(input: InvoiceContractInput | null): LoadingContract {
  const library = useLibrary(input?.template.invoice_sections ?? [], Boolean(input));
  const company = useContractCompany();
  const contract = useMemo(() => {
    if (!input || !company.data || !library.data) return null;
    return invoiceContract({ template: input.template, library: library.data, facts: invoiceInput(input.invoice, input.client, input.property, company.data, input.template, input.fill ?? null) });
  }, [input, company.data, library.data]);
  return { contract, isPending: Boolean(input) && !contract && !company.error && !library.error, error: company.error ?? library.error ?? null, refetch: () => void Promise.all([library.refetch(), company.refetch()]) };
}

/** The most an initials picture can be, as a data URL: what the server takes (60 KB). */
export const INITIALS_MAX = 60 * 1024;

/**
 * Initials drawn on the screen, small enough to send with a signature: drawn again at a smaller size
 * until the picture is at most INITIALS_MAX characters (a big, dense scribble on a sharp screen can
 * be more). The same picture when it's already small enough.
 */
export async function smallInitials(dataUrl: string): Promise<string> {
  let image = dataUrl;
  for (let scale = 0.75; image.length > INITIALS_MAX && scale > 0.1; scale *= 0.75) {
    const picture = new Image();
    picture.src = dataUrl;
    await picture.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    canvas.getContext("2d")!.drawImage(picture, 0, 0, canvas.width, canvas.height);
    image = canvas.toDataURL("image/png");
  }
  return image;
}

