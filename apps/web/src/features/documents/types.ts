/**
 * What an estimate or invoice document shows (EstimateDocument). Screens build one of these from
 * their own data: the staff app from Supabase, the Client Hub from its link's payload, Settings from a
 * sample. The look comes separately, from the business's estimate template (core documents.ts).
 */
import type { TemplateSettings } from "@crewtavo/core/documents";
import type { PaperFragment, PaperPage } from "./paginate";
import type { PaperWords } from "./paper";

/** The business at the top of the page. Address is already split into lines. */
export interface DocumentCompany {
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string[];
  /** The logo's URL (/api/public/logo/...), or null for the business's initials. */
  logo: string | null;
  /** companies.settings, for the brand color when the template has none (documentColor). */
  settings?: unknown;
}

export interface DocumentLine {
  name: string;
  description?: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  total: number;
  /** On screen only: the quote line it prints (its id), so the screen beside it can find it on the paper. */
  mark?: string;
}

export interface DocumentSignature {
  name: string;
  /** A PNG data URL; null leaves the line blank to sign by hand. */
  image: string | null;
  /** ISO timestamp, printed as the date beside the signature. */
  date: string | null;
}

/**
 * A section of the contract printed with an estimate or invoice (Settings → Contract terms): above
 * the signatures, or on the terms pages after them. Its HTML has its fill-ins filled already, and
 * is cleaned to what a contract may hold when it's drawn (sanitizeContractHtml).
 */
export interface DocumentSection {
  id: string;
  title: string;
  html: string;
  place: "signatures" | "terms";
  /** The customer initials it when signing. */
  initials: boolean;
  /** Their initials on it (a PNG data URL) and when, once they've initialed it. */
  initialed?: { image: string; date: string | null } | null;
}

export interface DocumentContract {
  sections: DocumentSection[];
}

/** One of the options an estimate offers (a package, like "Better · Designer shingle"), side by side under "Your options". */
export interface DocumentOption {
  id: string;
  name: string;
  /** "Good", "Better", "Best", or the business's own word. */
  tier: string | null;
  /** The package's picture; without one, a swatch of its style. */
  picture: { src: string; width: number; height: number } | null;
  style: string;
  highlights: string[];
  warranty: string;
  /** Its price; null leaves it off. */
  total: number | null;
  /** The one the estimate shows. */
  chosen: boolean;
}

export interface DocumentData {
  kind: "estimate" | "invoice";
  number: number | null;
  /** ISO date the document is dated. */
  date: string | null;
  /** Estimates: "Good until". */
  validUntil?: string | null;
  /** Invoices: "Due". */
  dueOn?: string | null;
  /** Invoices: the bold label on the strip under the address, its subject. */
  title?: string | null;
  /** The rest of the strip: on an estimate, only which option they chose ("Your choice: Better · Designer shingle"). */
  facts?: string[];
  client: { name: string; lines: string[] };
  lines: DocumentLine[];
  subtotal: number;
  discount: number;
  /** "Discount" unless given, like "Promo code SPRING". */
  discountLabel?: string;
  /** Invoices: referral credits after the discount, each under its note ("Referral credit: thanks for referring Maria"). */
  credits?: Array<{ label: string; amount: number }>;
  tax: number;
  total: number;
  /** Estimates: the deposit to get on the schedule. */
  deposit?: number | null;
  /** Estimates for recurring work: how often ("Every 2 weeks, Tuesday"). Its total is then per visit. */
  repeats?: string | null;
  /**
   * Invoices: payments and refunds so far, and what's left. A payment's amount is what was paid
   * (printed as "−$500.00"); a refund's is negative (printed as "+$50.00").
   */
  payments?: Array<{ label: string; amount: number }>;
  balanceDue?: number | null;
  /** A note under the lines (the quote's message, an invoice's notes). */
  notes?: string | null;
  signatures?: { customer?: DocumentSignature | null; company?: DocumentSignature | null };
  /** The contract's sections, after the template's own terms. */
  contract?: DocumentContract;
  /**
   * Estimates offering 2-3 options: all of them, compared under "Your options" whenever there are
   * two or more. Only while the customer is still deciding: leave it off the copy being signed, and
   * the signed copy (its strip says which they chose).
   */
  options?: DocumentOption[];
}

/**
 * Part of a block cut between pages: the words of each box of words in it, as the browser cut
 * them between two of its lines (paper.ts cutWords), and whether it carries on from the page
 * before and on to the next.
 */
export interface PaperPart {
  words: PaperWords[];
  carried: boolean;
  carries: boolean;
}

/** What goes on each page (paginate.ts), with the words of each part of a block cut between pages. */
export type DocumentLayout = Array<Omit<PaperPage, "fragments"> & { fragments: Array<PaperFragment & { cut?: PaperPart }> }>;

export interface EstimateDocumentProps {
  template: TemplateSettings;
  company: DocumentCompany;
  data: DocumentData;
  className?: string;
  /**
   * What goes on which page, measured in the browser (DocumentSheet and PrintableDocument do).
   * Without it everything is on one page, as on the server and in tests.
   */
  layout?: DocumentLayout | null;
  /** Only the first page, for a thumbnail. */
  firstPageOnly?: boolean;
  /**
   * The heading level of the document's title ("Estimate"), its terms and sections under it: one
   * under the screen's heading it's shown below (3 under an h2). 2 unless given.
   */
  headingLevel?: number;
}
