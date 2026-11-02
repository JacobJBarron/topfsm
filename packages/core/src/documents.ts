/**
 * Estimate templates (document_templates): how a business's estimates, proposals and invoices look
 * on paper. The settings are free-form jsonb, so everything that reads them goes through
 * templateSettings(), which fills in the defaults and drops anything out of shape.
 *
 * A template prints Crewtavo's letterhead (the header style, logo and business details) or the
 * business's own: the top and bottom of its stationery, cut from a PDF or picture of it in the
 * template builder and kept as PNGs in the files bucket (<company>/letterhead/<uuid>.png).
 *
 * It also lists the contract sections from the business's library (contract_sections) that print
 * on every estimate and every invoice; contracts.ts puts them together with a package's and a
 * quote's own.
 */

export type HeaderStyle = "classic" | "centered" | "banner";
export type Lettering = "modern" | "classic";
/** Crewtavo's letterhead, or the business's own, uploaded. */
export type LetterheadKind = "built_in" | "custom";

/** A picture cut from the business's own letterhead: where it's kept, and its size in pixels. A type, not an interface, so a template still goes into jsonb as it is. */
export type LetterheadPicture = {
  path: string;
  width: number;
  height: number;
};

export interface TemplateSettings {
  /** Crewtavo's letterhead (header style, logo and details), or the business's own pictures below. */
  letterhead: LetterheadKind;
  /** The top of the business's own letterhead, printed in place of Crewtavo's on the first page. Kept when switching back. */
  letterhead_header: LetterheadPicture | null;
  /** The bottom of it, printed in place of the footer's words; null keeps the words. Kept when switching back. */
  letterhead_footer: LetterheadPicture | null;
  /** Logo and name on the left with the details on the right, all centered, or a band of color. */
  header: HeaderStyle;
  /** The document's color; null uses the business's brand color (Settings → Business). */
  color: string | null;
  /** Modern is the app's sans serif; classic is a serif. */
  font: Lettering;
  /** The line under the business's name, like "Roofing · Siding · Gutters". */
  tagline: string;
  license: string;
  insurer: string;
  show_license: boolean;
  show_insurer: boolean;
  /** Printed above the signatures. Line breaks are kept. */
  terms: string;
  /** Contract sections (contract_sections ids) on every estimate, in order, after the terms. */
  sections: string[];
  /** Contract sections on every invoice, in order. */
  invoice_sections: string[];
  customer_signs: boolean;
  customer_label: string;
  company_signs: boolean;
  /** Under the company's signature line; empty means "<business> representative". */
  company_label: string;
  sign_dates: boolean;
  footer: string;
  page_numbers: boolean;
}

export const TEMPLATE_LIMITS = { name: 80, tagline: 120, license: 60, insurer: 120, terms: 4000, label: 80, footer: 200, sections: 50 } as const;

export const DEFAULT_TERMS =
  "Payment: a deposit to get on the schedule, and the rest when the work is done.\n" +
  "Changes: anything not listed here is extra, and only with your OK.\n" +
  "Warranty: we stand behind our workmanship, plus the manufacturer's warranty on materials.";

/**
 * The starter terms printed above the signatures, by trade. DEFAULT_TERMS is paving's and roofing's
 * (unchanged). A lawn company bills after each visit, often to the card on file, and has no
 * deposits or materials warranty to speak of. The migration that brought these in
 * (20261101000100_autopay.sql) moved lawn templates still on the old starter to the lawn one.
 */
export const TRADE_TERMS: Record<string, string> = {
  lawn_exterior:
    "Payment: due after each visit, or charged to your card on file if you're on autopay.\n" +
    "Skipped visits: if we can't do a visit, we'll tell you, and you won't be charged for it.\n" +
    "Our work: if something isn't right, tell us within two days and we'll come back or refund the visit.",
  general:
    "Payment: due when the work is done, unless we agreed otherwise.\n" +
    "Changes: anything not listed here is extra, and only with your OK.\n" +
    "Warranty: we stand behind our workmanship.",
  paving: DEFAULT_TERMS,
  roofing_exteriors: DEFAULT_TERMS,
};

/** The starter terms for a trade; DEFAULT_TERMS when the trade isn't known (or isn't given). */
export const defaultTerms = (trade?: string | null) => (trade && TRADE_TERMS[trade]) || DEFAULT_TERMS;

export const DEFAULT_TEMPLATE: TemplateSettings = {
  letterhead: "built_in",
  letterhead_header: null,
  letterhead_footer: null,
  header: "classic",
  color: null,
  font: "modern",
  tagline: "",
  license: "",
  insurer: "",
  show_license: true,
  show_insurer: true,
  terms: DEFAULT_TERMS,
  sections: [],
  invoice_sections: [],
  customer_signs: true,
  customer_label: "Customer",
  company_signs: true,
  company_label: "",
  sign_dates: true,
  footer: "",
  page_numbers: true,
};

export const HEADER_STYLES: Array<{ id: HeaderStyle; label: string }> = [
  { id: "classic", label: "Classic" },
  { id: "centered", label: "Centered" },
  { id: "banner", label: "Banner" },
];

/** The colors offered on the template, besides the business's own. */
export const TEMPLATE_COLORS: Array<{ name: string; hex: string }> = [
  { name: "Navy", hex: "#1f4e79" },
  { name: "Forest", hex: "#2f6b3a" },
  { name: "Brick", hex: "#a33a2b" },
  { name: "Copper", hex: "#9a5418" },
  { name: "Teal", hex: "#1d6b66" },
  { name: "Charcoal", hex: "#2b2f33" },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** The most pixels either way a letterhead picture can have: a letter page at 300 dpi. */
export const LETTERHEAD_MAX_PIXELS = 3300;

const LETTERHEAD_PATH = /^[0-9a-f-]{36}\/letterhead\/[0-9a-f-]{36}\.png$/;

/** A letterhead picture's path in the files bucket (<company>/letterhead/<uuid>.png). */
export const isLetterheadPath = (path: string) => LETTERHEAD_PATH.test(path);

/** Where a letterhead picture loads from (`base` is the app's address, or "" on its own pages). */
export const letterheadSrc = (path: string, base = "") => `${base}/api/public/letterhead/${path.replace("/letterhead/", "/")}`;

const text = (value: unknown, max: number, fallback: string) => (typeof value === "string" ? value.slice(0, max) : fallback);
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const pixels = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= LETTERHEAD_MAX_PIXELS;

function picture(value: unknown): LetterheadPicture | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  return typeof p.path === "string" && isLetterheadPath(p.path) && pixels(p.width) && pixels(p.height) ? { path: p.path, width: p.width as number, height: p.height as number } : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A list of ids: uuids only, each once, in order, up to the limit. */
function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const id of value) if (typeof id === "string" && UUID.test(id) && seen.size < TEMPLATE_LIMITS.sections) seen.add(id.toLowerCase());
  return [...seen];
}

/**
 * A template's settings with the defaults filled in. Anything of the wrong type or too long is
 * dropped or cut. Terms that were never saved are the trade's starter (defaultTerms); saved terms win.
 */
export function templateSettings(raw: unknown, trade?: string | null): TemplateSettings {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_TEMPLATE;
  return {
    letterhead: s.letterhead === "custom" ? "custom" : d.letterhead,
    letterhead_header: picture(s.letterhead_header),
    letterhead_footer: picture(s.letterhead_footer),
    header: s.header === "centered" || s.header === "banner" || s.header === "classic" ? s.header : d.header,
    color: typeof s.color === "string" && HEX.test(s.color) ? s.color.toLowerCase() : null,
    font: s.font === "classic" || s.font === "modern" ? s.font : d.font,
    tagline: text(s.tagline, TEMPLATE_LIMITS.tagline, d.tagline),
    license: text(s.license, TEMPLATE_LIMITS.license, d.license),
    insurer: text(s.insurer, TEMPLATE_LIMITS.insurer, d.insurer),
    show_license: flag(s.show_license, d.show_license),
    show_insurer: flag(s.show_insurer, d.show_insurer),
    terms: text(s.terms, TEMPLATE_LIMITS.terms, defaultTerms(trade)),
    sections: ids(s.sections),
    invoice_sections: ids(s.invoice_sections),
    customer_signs: flag(s.customer_signs, d.customer_signs),
    customer_label: text(s.customer_label, TEMPLATE_LIMITS.label, d.customer_label),
    company_signs: flag(s.company_signs, d.company_signs),
    company_label: text(s.company_label, TEMPLATE_LIMITS.label, d.company_label),
    sign_dates: flag(s.sign_dates, d.sign_dates),
    footer: text(s.footer, TEMPLATE_LIMITS.footer, d.footer),
    page_numbers: flag(s.page_numbers, d.page_numbers),
  };
}

/** The color a document prints in: the template's, else the business's brand color, else navy. */
export function documentColor(template: Pick<TemplateSettings, "color">, companySettings: unknown): string {
  if (template.color) return template.color;
  const branding = companySettings && typeof companySettings === "object" ? (companySettings as { branding?: { color?: unknown } }).branding : null;
  const brand = branding && typeof branding.color === "string" && HEX.test(branding.color) ? branding.color : null;
  return brand ?? "#1f4e79";
}

/**
 * The pictures of the business's own letterhead a document prints: none with Crewtavo's letterhead.
 * With its own, the header picture takes the place of Crewtavo's (which still prints without one, so
 * the top of the page is never blank) and the footer picture takes the place of the footer's words.
 */
export function ownLetterhead(template: Pick<TemplateSettings, "letterhead" | "letterhead_header" | "letterhead_footer">): { header: LetterheadPicture | null; footer: LetterheadPicture | null } {
  if (template.letterhead !== "custom") return { header: null, footer: null };
  return { header: template.letterhead_header, footer: template.letterhead_footer };
}

/** The words under the company's signature line. */
export const companySignatureLabel = (template: Pick<TemplateSettings, "company_label">, companyName: string) =>
  template.company_label.trim() || `${companyName} representative`;

/**
 * Which template a document uses: the one it names, else the business's default, else the built-in
 * defaults (a business that never opened the template builder still gets a clean document, with its
 * trade's starter terms). The office's printout, the Client Hub and the signed copy all pass the
 * company's trade, so they print the same terms.
 */
export function pickTemplate<T extends { id: string; is_default: boolean; settings: unknown }>(
  templates: readonly T[],
  id?: string | null,
  trade?: string | null,
): TemplateSettings {
  const chosen = (id ? templates.find((t) => t.id === id) : undefined) ?? templates.find((t) => t.is_default) ?? templates[0];
  return templateSettings(chosen?.settings, trade);
}
