/**
 * Estimate documents (features/documents): the words and numbers printed on the page, a quote turned
 * into a document with its signatures, and the pages themselves on each template style, laid out on
 * pages the way the browser measures them (here by hand: paginate.test.ts tests the measuring's maths).
 * Without a browser a contract section is one block of its words, so the tests that need it split as
 * a browser splits it say so (asInBrowser).
 */
import { contractInput, contractValues, resolveSections, sectionsHash } from "@crewtavo/core/contracts";
import { DEFAULT_TEMPLATE, templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { SITE_ADJUSTMENT_NAME } from "@crewtavo/core/estimates";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addressLines,
  approvalContract,
  approvalSignatures,
  awaitingInitials,
  choiceFact,
  choiceLabel,
  contractTemplate,
  countedLine,
  documentCompany,
  documentLines,
  documentOptions,
  hasContract,
  initials,
  initialSection,
  inkOn,
  invoiceContract,
  invoiceDocument,
  licenseLine,
  liveContract,
  longDate,
  quantityLabel,
  quoteDate,
  quoteDocument,
  quoteTemplate,
  readableOnWhite,
  readApproval,
  SAMPLE_DOCUMENT,
  SAMPLE_GENERAL_DOCUMENT,
  sampleDocument,
  signedTemplate,
  stillInitialed,
  websiteLabel,
  withInitials,
} from "../src/features/documents/build";
import { invoiceFill } from "../src/features/documents/data";
import { documentBlocks, EstimateDocument } from "../src/features/documents/EstimateDocument";
import styles from "../src/features/documents/EstimateDocument.module.css";
import type { DocumentCompany, DocumentData, DocumentLayout, DocumentOption, DocumentSection, PaperPart } from "../src/features/documents/types";
import { logoUrl } from "../src/lib/files";
import { contractBlocks, contractTable, sanitizeContractHtml, type ContractBlock } from "../src/lib/html";

vi.mock("../src/lib/html", async (importOriginal) => {
  const html = await importOriginal<typeof import("../src/lib/html")>();
  return { ...html, contractBlocks: vi.fn(html.contractBlocks) };
});
const { contractBlocks: blocksWithoutBrowser } = await vi.importActual<typeof import("../src/lib/html")>("../src/lib/html");

/** Contract sections split as a browser splits them: each section's HTML to its blocks. */
const asInBrowser = (blocks: Record<string, ContractBlock[]>) => vi.mocked(contractBlocks).mockImplementation((html) => blocks[html] ?? blocksWithoutBrowser(html));
afterEach(() => {
  vi.mocked(contractBlocks).mockImplementation(blocksWithoutBrowser);
});

const INK = `data:image/png;base64,${"A".repeat(40)}=`;
const MIKE = `data:image/png;base64,${"B".repeat(40)}=`;

const company: DocumentCompany = {
  name: "Ridgeline Roofing Co.",
  phone: "(614) 555-0188",
  email: "office@ridgeline.example",
  website: "https://ridgeline.example/",
  address: ["2290 Harper Rd", "Columbus, OH 43204"],
  logo: null,
  settings: { branding: { color: "#3b7d23" } },
};

const page = (template: Partial<TemplateSettings>, data: DocumentData = SAMPLE_DOCUMENT, layout?: DocumentLayout, firstPageOnly?: boolean, headingLevel?: number) =>
  renderToStaticMarkup(createElement(EstimateDocument, { template: { ...DEFAULT_TEMPLATE, ...template }, company, data, layout, firstPageOnly, headingLevel }));

/** A layout by hand: the document's blocks in order, a new page at each of `starts`. */
function pagesAt(template: Partial<TemplateSettings>, data: DocumentData, starts: string[]): DocumentLayout {
  const pages: DocumentLayout = [];
  for (const { key } of documentBlocks({ ...DEFAULT_TEMPLATE, ...template }, company, data)) {
    if (!pages.length || starts.includes(key)) pages.push({ fragments: [], repeatHead: null, pinFrom: null });
    pages[pages.length - 1]!.fragments.push({ key, offset: 0, height: 0 });
  }
  return pages;
}

/** Each page's markup, in order. */
const pagesOf = (html: string) => html.split('data-page="').slice(1);

/**
 * Block `key` cut between pages, as the browser would cut it: its first part ends page `at`, the rest
 * starts the next one. `first` and `rest` are the words of each of its boxes of words in each part.
 */
function cutAcross(layout: DocumentLayout, at: number, key: string, first: PaperPart["words"], rest: PaperPart["words"]) {
  layout[at]!.fragments.push({ key, offset: 0, height: 40, part: true, cut: { words: first, carried: false, carries: true } });
  const next = layout[at + 1]!.fragments;
  const i = next.findIndex((f) => f.key === key);
  next[i] = { key, offset: 40, height: 60, part: true, cut: { words: rest, carried: true, carries: false } };
}

describe("words and numbers on the page", () => {
  it("writes quantities the way a roofer reads them", () => {
    expect(quantityLabel(24.2, "square")).toBe("24.2 sq");
    expect(quantityLabel(22, "square")).toBe("22 sq");
    expect(quantityLabel(210, "ft")).toBe("210 ft");
    expect(quantityLabel(1200, "sq ft")).toBe("1,200 sq ft");
    expect(quantityLabel(3, "ea")).toBe("3");
    expect(quantityLabel(1, "lump sum")).toBe("1");
    expect(quantityLabel("6", "sheet")).toBe("6 sheets");
    expect(quantityLabel(1, "sheet")).toBe("1 sheet");
    expect(quantityLabel(12, "panel")).toBe("12 panels");
    expect(quantityLabel(2, "box")).toBe("2 boxes");
    expect(quantityLabel(1.5, "hr")).toBe("1.5 hr");
    expect(quantityLabel(2, "hours")).toBe("2 hr");
    expect(quantityLabel(0.333, "visit")).toBe("0.33 visits");
  });

  it("prints the business's address, website, license and initials cleanly", () => {
    expect(addressLines({ line1: " 2290 Harper Rd ", city: "Columbus", region: "OH", postal_code: "43204" })).toEqual(["2290 Harper Rd", "Columbus, OH 43204"]);
    expect(addressLines({ line1: "PO Box 12", postal_code: "43204" })).toEqual(["PO Box 12", "43204"]);
    expect(addressLines(null)).toEqual([]);
    expect(websiteLabel("https://ridgeline.example/")).toBe("ridgeline.example");
    expect(licenseLine("#RC-104882")).toBe("License #RC-104882");
    expect(licenseLine("Lic. 55-1234")).toBe("Lic. 55-1234");
    expect(initials("Ridgeline Roofing Co.")).toBe("RR");
    expect(initials("The Gutter Guys, LLC")).toBe("GG");
    expect(initials("Bob")).toBe("B");
  });

  it("loads the logo from the public logo address", () => {
    const co = "00000000-0000-4000-8000-000000000001";
    expect(logoUrl({ branding: { logo: `${co}/logo/abc.png` } })).toBe(`/api/public/logo/${co}/abc.png`);
    expect(logoUrl({ branding: { color: "#000000" } })).toBeNull();
    expect(logoUrl(null)).toBeNull();
    expect(documentCompany({ name: "Ridgeline", phone: " ", email: "a@b.co", address: { line1: "1 Main" }, settings: { branding: { logo: `${co}/logo/abc.png` } } })).toMatchObject({
      phone: null,
      email: "a@b.co",
      website: null,
      address: ["1 Main"],
      logo: `/api/public/logo/${co}/abc.png`,
    });
  });

  it("keeps words readable on the template's color", () => {
    expect(inkOn("#1f4e79")).toBe("#ffffff");
    expect(inkOn("#f5c400")).toBe("#0f2a35");
    expect(readableOnWhite("#1f4e79")).toBe("#1f4e79");
    // A pale brand color still colors the rules, but the words go in ink.
    expect(readableOnWhite("#f5c400")).toBe("#0f2a35");
  });

  it("dates the page in words", () => {
    expect(longDate("2026-10-22")).toBe("October 22, 2026");
    expect(longDate(null)).toBe("");
  });

  it("dates a quote's paper the day its {Date} fill-in says: sent, else made, on the business's calendar", () => {
    const tz = "America/Chicago";
    expect(quoteDate({ sent_at: "2026-10-22T15:00:00Z", created_at: "2026-10-20T15:00:00Z" }, tz)).toBe("2026-10-22");
    // Made late on Oct 24 where the business is (Oct 25 in UTC), and never sent.
    expect(quoteDate({ sent_at: null, created_at: "2026-10-25T02:30:00Z" }, tz)).toBe("2026-10-24");
    expect(quoteDate({ sent_at: null, created_at: "2026-10-20" }, tz)).toBe("2026-10-20");
    expect(quoteDate({}, tz)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const values = contractValues(contractInput({ number: 1042, sent_at: null, created_at: "2026-10-25T02:30:00Z", total: 0, deposit_amount: 0 }, null, null, { name: "Ridgeline", phone: null, timezone: tz }, DEFAULT_TEMPLATE));
    expect(longDate(quoteDate({ sent_at: null, created_at: "2026-10-25T02:30:00Z" }, tz))).toBe(values.Date);
  });
});

describe("a quote as a document", () => {
  const hub = { name: "Alex Morgan", signature: INK, signed_at: "2026-10-20T15:00:00.000Z", ip: "203.0.113.9", selected_line_ids: [], total: 100 };

  it("reads every kind of approval", () => {
    expect(readApproval(null)).toBeNull();
    expect(readApproval(hub)).toEqual({ name: "Alex Morgan", signature: INK, signed_at: hub.signed_at, method: null, company: null, template: null, option: null, contract: null, initials: null });
    expect(readApproval({ name: "Sarah Lopez", method: "manual" })).toMatchObject({ name: "Sarah Lopez", signature: null, method: "manual" });
    const inPerson = readApproval({ ...hub, method: "in_person", company: { name: "Mike Torres", user_id: "u1", signature: MIKE, signed_at: "2026-10-24T18:14:00.000Z" } });
    expect(inPerson?.company).toEqual({ name: "Mike Torres", user_id: "u1", signature: MIKE, signed_at: "2026-10-24T18:14:00.000Z" });
    // Anything that isn't a drawn signature is left off.
    expect(readApproval({ name: "X", signature: "javascript:alert(1)", company: { name: "Y", signature: "https://evil.example/x.png" } })).toMatchObject({ signature: null, company: null });
  });

  it("keeps the template a quote was signed on, whatever the business's templates say now", () => {
    const rows = [
      { id: "t1", is_default: true, settings: { terms: "Today's default terms" } },
      { id: "t2", is_default: false, settings: { header: "banner", terms: "Metal roof terms" } },
    ];
    const saved = { ...DEFAULT_TEMPLATE, terms: "The terms Alex signed", company_signs: false };
    const signed = { ...hub, template: saved };
    expect(readApproval(signed)?.template).toEqual(saved);
    // Read like any template: anything out of shape falls back to the defaults.
    expect(readApproval({ ...hub, template: { header: "wavy", terms: 7 } })?.template).toEqual(DEFAULT_TEMPLATE);
    expect(readApproval({ ...hub, template: "classic" })?.template).toBeNull();

    expect(quoteTemplate(rows, { status: "approved", template_id: "t2", approval: signed })).toEqual(saved);
    expect(quoteTemplate(rows, { status: "converted", template_id: null, approval: signed }).terms).toBe("The terms Alex signed");
    // Signed before approvals kept their template: the one it names, else the default.
    expect(quoteTemplate(rows, { status: "approved", template_id: "t2", approval: hub }).terms).toBe("Metal roof terms");
    expect(quoteTemplate(rows, { status: "approved", template_id: null, approval: hub }).terms).toBe("Today's default terms");
    // Not signed (or reopened as a draft): it follows its template.
    expect(quoteTemplate(rows, { status: "draft", template_id: null, approval: signed }).terms).toBe("Today's default terms");
    expect(signedTemplate({ status: "sent", template_id: "t2", approval: signed })).toBeNull();
    // Without the status, a saved template means it was signed.
    expect(signedTemplate({ template_id: null, approval: signed })).toEqual(saved);
    expect(signedTemplate({ template_id: null, approval: null })).toBeNull();
  });

  it("puts each signature on its line, and leaves an office approval's customer line blank", () => {
    expect(approvalSignatures(hub)).toEqual({ customer: { name: "Alex Morgan", image: INK, date: hub.signed_at }, company: null });
    expect(approvalSignatures({ name: "Sarah Lopez", method: "manual" }, "2026-10-21T12:00:00Z")).toEqual({ customer: null, company: null });
    const both = approvalSignatures({ ...hub, signed_at: null, method: "in_person", company: { name: "Mike Torres", signature: MIKE, signed_at: "2026-10-24T18:14:00.000Z" } }, "2026-10-24T18:14:00.000Z");
    expect(both.customer?.date).toBe("2026-10-24T18:14:00.000Z");
    expect(both.company).toEqual({ name: "Mike Torres", image: MIKE, date: "2026-10-24T18:14:00.000Z" });
  });

  it("prints the lines that count, in order, with a price set on site as a normal line", () => {
    const lines = documentLines([
      { name: "Ridge vent", quantity: 48, unit: "ft", unit_price: 9, option_id: null, sort: 2 },
      { name: "Architectural shingle roof", description: " Installed ", quantity: 24.2, unit: "square", unit_price: 560, option_id: null, sort: 1 },
      { name: "Gutter guards", quantity: 120, unit: "ft", unit_price: 7, optional: true, selected: false, option_id: null, sort: 3 },
      { name: "Chimney cricket", quantity: 1, unit: "ea", unit_price: 450, optional: true, selected: true, option_id: null, sort: 4 },
      { name: SITE_ADJUSTMENT_NAME, quantity: 1, unit: "ea", unit_price: 220.5, option_id: null, sort: 5 },
    ]);
    expect(lines.map((l) => l.name)).toEqual(["Architectural shingle roof", "Ridge vent", "Chimney cricket", SITE_ADJUSTMENT_NAME]);
    expect(lines[0]).toEqual({ name: "Architectural shingle roof", description: "Installed", quantity: 24.2, unit: "square", unit_price: 560, total: 13552 });
    expect(lines[3]!.total).toBe(220.5);
  });

  it("prints a price set below the estimate on an option as the one adjustment it is, though it's booked as two lines", () => {
    const lines = documentLines(
      [
        { name: "Architectural shingle roof", quantity: 1, unit: "ea", unit_price: 10000, option_id: "o1", sort: 1 },
        { name: "Dumpster", quantity: 1, unit: "ea", unit_price: 500, option_id: null, sort: 2 },
        { name: SITE_ADJUSTMENT_NAME, description: "Matched their bid", quantity: 1, unit: "ea", unit_price: -952.38, option_id: "o1", sort: 3 },
        { name: SITE_ADJUSTMENT_NAME, description: "Matched their bid", quantity: 1, unit: "ea", unit_price: -47.62, option_id: "o1", sort: 4 },
      ],
      "o1",
    );
    expect(lines.map((l) => [l.name, l.total])).toEqual([["Architectural shingle roof", 10000], ["Dumpster", 500], [SITE_ADJUSTMENT_NAME, -1000]]);
    expect(lines[2]).toMatchObject({ quantity: 1, unit_price: -1000, description: "Matched their bid" });
    // A line from the price list that happens to be called that is a line of its own.
    expect(documentLines([{ name: SITE_ADJUSTMENT_NAME, quantity: 1, unit: "ea", unit_price: 50, option_id: null, service_id: "s1" }, { name: SITE_ADJUSTMENT_NAME, quantity: 1, unit: "ea", unit_price: 20, option_id: null }])).toHaveLength(2);
  });

  it("builds the whole estimate from the quote", () => {
    const doc = quoteDocument(
      {
        number: 1042, title: "New roof", message: " Thanks for having us out. ", subtotal: "18304.00", discount_amount: "250", tax_amount: 0, total: "18054.00", deposit_amount: 0,
        valid_until: "2026-11-21", sent_at: "2026-10-22T14:00:00Z", created_at: "2026-10-20T14:00:00Z", approved_at: null, approval: null,
        promo: { code: "SPRING" }, client: { display_name: "Alex Morgan" }, property: { line1: "1482 Maple Ave", city: "Springfield", region: "IL", postal_code: "62704" },
      },
      [{ name: "Architectural shingle roof", quantity: 24.2, unit: "square", unit_price: 560, option_id: null }],
    );
    expect(doc).toMatchObject({
      kind: "estimate", number: 1042, date: "2026-10-22T14:00:00Z", validUntil: "2026-11-21", facts: [],
      client: { name: "Alex Morgan", lines: ["1482 Maple Ave", "Springfield, IL 62704"] },
      subtotal: 18304, discount: 250, discountLabel: "Promo code SPRING", tax: 0, total: 18054, deposit: null, notes: "Thanks for having us out.",
      signatures: { customer: null, company: null },
    });
    // Nothing under the address but the address: not the project's name.
    expect(doc.title).toBeUndefined();
    // What a screen knows better wins.
    const custom = quoteDocument({ number: 7, subtotal: 0, discount_amount: 0, tax_amount: 0, total: 0, title: "Roof" }, [], { client: { name: "Dana", lines: [] }, date: "2026-10-24" });
    expect(custom).toMatchObject({ client: { name: "Dana", lines: [] }, date: "2026-10-24", discountLabel: undefined });
  });

  it("has believable samples whose totals add up", () => {
    expect(SAMPLE_DOCUMENT.total).toBe(18304);
    expect(SAMPLE_DOCUMENT.subtotal).toBe(SAMPLE_DOCUMENT.lines.reduce((s, l) => s + l.total, 0));
    expect(SAMPLE_GENERAL_DOCUMENT.total).toBe(2330);
    expect(sampleDocument("roofing_exteriors")).toBe(SAMPLE_DOCUMENT);
    expect(sampleDocument("lawn_exterior")).toBe(SAMPLE_GENERAL_DOCUMENT);
  });
});

describe("a quote that offers options, and its contract", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "aaaaaaaa-0000-4000-8000-000000000002";
  const C = "aaaaaaaa-0000-4000-8000-000000000003";
  // As the database keeps them with option A shown: B's and C's lines are left unselected.
  const lines = [
    { id: "s1", option_id: null, name: "Tear-off and disposal", quantity: 22, unit: "square", unit_price: 85, taxable: true, optional: false, selected: true, sort: 1 },
    { id: "s2", option_id: null, name: "Gutter guards", quantity: 100, unit: "ft", unit_price: 7, taxable: true, optional: true, selected: false, sort: 2 },
    { id: "a1", option_id: A, name: "Architectural shingle roof", quantity: 22, unit: "square", unit_price: 400, taxable: true, optional: false, selected: true, sort: 3 },
    { id: "a2", option_id: A, name: "Ridge vent upgrade", quantity: 1, unit: "ea", unit_price: 250, taxable: true, optional: true, selected: true, sort: 4 },
    { id: "b1", option_id: B, name: "Designer shingle roof", quantity: 22, unit: "square", unit_price: 520, taxable: true, optional: false, selected: false, sort: 5 },
    { id: "b2", option_id: B, name: "Skylight flashing", quantity: 1, unit: "ea", unit_price: 300, taxable: true, optional: true, selected: false, sort: 6 },
    { id: "c1", option_id: C, name: "Standing-seam metal roof", quantity: 22, unit: "square", unit_price: 900, taxable: true, optional: false, selected: false, sort: 7 },
  ];
  const money = { taxRate: 0.05, discountAmount: 0, promo: null };
  // What private.quote_totals stores with A shown: 1,870 + 8,800 + 250, and 5% tax.
  const shownA = { number: 1042, status: "sent", option_id: A, subtotal: 10920, discount_amount: 0, tax_amount: 546, total: 11466, approval: null };
  const rows = [
    { id: A, name: "Architectural shingle", tier: null, picture: null, picture_width: null, picture_height: null, style: "shingle", highlights: ["30-year shingles"], warranty: "10-year workmanship" },
    { id: B, name: "Designer shingle", tier: null, picture: "c0c0c0c0-0000-4000-8000-000000000000/packages/d0d0d0d0-0000-4000-8000-000000000000.jpg", picture_width: 1600, picture_height: 1200, style: "designer", highlights: [], warranty: "" },
    { id: C, name: "Standing-seam metal", tier: null, style: "metal" },
  ];

  it("prints the shared lines and the shown option's, never another option's required lines", () => {
    expect(documentLines(lines, A).map((l) => l.name)).toEqual(["Tear-off and disposal", "Architectural shingle roof", "Ridge vent upgrade"]);
    expect(documentLines(lines, B).map((l) => l.name)).toEqual(["Tear-off and disposal", "Designer shingle roof"]);
    // Their amounts add up to what the database stores with that option shown.
    expect(documentLines(lines, A).reduce((sum, l) => sum + l.total, 0)).toBe(shownA.subtotal);
    // Lines with no option (a quote without options) print as they always have: all but the add-ons left off.
    expect(documentLines(lines.map((l) => ({ ...l, option_id: null }))).map((l) => l.name)).toEqual(["Tear-off and disposal", "Architectural shingle roof", "Ridge vent upgrade", "Designer shingle roof", "Standing-seam metal roof"]);
    expect(countedLine({ option_id: B, optional: false, selected: false }, A)).toBe(false);
    expect(countedLine({ option_id: null, optional: true, selected: true }, A)).toBe(true);
  });

  it("follows the shown option, or the one the screen is on", () => {
    expect(quoteDocument(shownA, lines).lines.map((l) => l.name)).toContain("Architectural shingle roof");
    expect(quoteDocument(shownA, lines, { optionId: C }).lines.map((l) => l.name)).toEqual(["Tear-off and disposal", "Standing-seam metal roof"]);
  });

  it("compares two or three options while the customer decides, and says which on the copy being signed", () => {
    const offered = documentOptions(rows, lines, money);
    expect(offered.map((o) => [o.name, o.tier, o.total])).toEqual([
      ["Architectural shingle", "Good", 11203.5],
      ["Designer shingle", "Better", 13975.5],
      ["Standing-seam metal", "Best", 22753.5],
    ]);
    expect(offered[1]!.picture).toEqual({ src: "/api/public/package/c0c0c0c0-0000-4000-8000-000000000000/d0d0d0d0-0000-4000-8000-000000000000.jpg", width: 1600, height: 1200 });
    expect(offered[2]).toMatchObject({ picture: null, highlights: [], warranty: "" });

    const deciding = quoteDocument(shownA, lines, { options: offered });
    expect(deciding.options?.map((o) => [o.name, o.chosen])).toEqual([["Architectural shingle", true], ["Designer shingle", false], ["Standing-seam metal", false]]);
    expect(deciding.facts).toEqual([]);

    const signing = quoteDocument(shownA, lines, { options: offered, choice: { name: "Architectural shingle", tier: "Good" } });
    expect(signing.options).toBeUndefined();
    expect(signing.facts).toEqual(["Your choice: Good · Architectural shingle"]);
    expect(choiceFact({ name: " Designer shingle ", tier: null })).toBe("Your choice: Designer shingle");
    expect(choiceLabel({ name: "Designer shingle", tier: " Better " })).toBe("Better · Designer shingle");
    // One option, or more than three, isn't a comparison.
    expect(quoteDocument(shownA, lines, { options: offered.slice(0, 1) }).options).toBeUndefined();
  });

  it("prints a signed quote's chosen option and the contract kept with it, whatever the screen says", () => {
    const approval = {
      name: "Dana Whitfield", signature: INK, signed_at: "2026-10-25T18:00:00Z", method: "in_person",
      option: { id: B, name: "Designer shingle", tier: "Better", picture: null, style: "designer", highlights: [], warranty: "50 years" },
      contract: {
        terms: "Pay R&R Roofing.",
        sections: [
          { id: "k1", title: "Your right to cancel", body: "<p>Cancel within 3 days.</p>", place: "signatures", initials: true, initialed: true },
          { id: "k2", title: "Payment", body: "<p>Due on completion.</p>", place: "terms", initials: false, initialed: false },
        ],
      },
      initials: { image: MIKE, signed_at: "2026-10-25T18:00:00Z" },
      template: { ...DEFAULT_TEMPLATE, terms: "Pay {Business name}." },
    };
    // The database flipped the lines to B when it was signed.
    const signedLines = lines.map((l) => ({ ...l, selected: l.option_id === B ? !l.optional : l.option_id === A ? false : l.selected }));
    const doc = quoteDocument({ ...shownA, status: "approved", option_id: A, approval }, signedLines, { options: documentOptions(rows, lines, money) });
    expect(doc.lines.map((l) => l.name)).toEqual(["Tear-off and disposal", "Designer shingle roof"]);
    expect(doc.options).toBeUndefined();
    expect(doc.facts).toEqual(["Your choice: Better · Designer shingle"]);
    expect(doc.contract?.sections).toEqual([
      { id: "k1", title: "Your right to cancel", html: "<p>Cancel within 3 days.</p>", place: "signatures", initials: true, initialed: { image: MIKE, date: "2026-10-25T18:00:00Z" } },
      { id: "k2", title: "Payment", html: "<p>Due on completion.</p>", place: "terms", initials: false, initialed: null },
    ]);
    // Its template prints the terms as they were signed, filled in.
    expect(signedTemplate({ status: "approved", template_id: null, approval })?.terms).toBe("Pay R&R Roofing.");
    // Reopened as a draft, it's not signed: the shown option and no kept contract.
    const reopened = quoteDocument({ ...shownA, status: "draft", approval }, lines);
    expect(reopened.lines.map((l) => l.name)).toContain("Architectural shingle roof");
    expect(reopened.contract).toBeUndefined();
  });

  it("reads the option, the contract and the initials an approval kept, and nothing else", () => {
    const read = readApproval({
      name: "Dana",
      option: { id: B, name: "Designer shingle", tier: "Better", picture: { path: "c0c0c0c0-0000-4000-8000-000000000000/packages/d0d0d0d0-0000-4000-8000-000000000000.jpg", width: 1600, height: 1200 }, style: "designer", highlights: ["A", 7, "B"], warranty: "50 years" },
      contract: { terms: "Terms", sections: [{ id: "k1", title: "Cancel", body: "<p>x</p>", place: "signatures", initials: true, initialed: true }, { title: "No id" }, "junk"] },
      initials: { image: MIKE, signed_at: "2026-10-25T18:00:00Z" },
    });
    expect(read?.option).toEqual({ id: B, name: "Designer shingle", tier: "Better", picture: { path: "c0c0c0c0-0000-4000-8000-000000000000/packages/d0d0d0d0-0000-4000-8000-000000000000.jpg", width: 1600, height: 1200 }, style: "designer", highlights: ["A", "B"], warranty: "50 years" });
    expect(read?.contract).toEqual({ terms: "Terms", sections: [{ id: "k1", title: "Cancel", body: "<p>x</p>", place: "signatures", initials: true, initialed: true }] });
    expect(read?.initials).toEqual({ image: MIKE, signed_at: "2026-10-25T18:00:00Z" });
    // A picture from anywhere but the business's packages folder, or initials that aren't a drawing, are dropped.
    const odd = readApproval({ name: "X", option: { id: B, name: "Y", picture: { path: "https://evil.example/x.jpg", width: 1, height: 1 } }, initials: { image: "javascript:alert(1)" } });
    expect(odd?.option?.picture).toBeNull();
    expect(odd?.option?.style).toBe("other");
    expect(odd?.initials).toBeNull();
    expect(readApproval({ name: "X", option: { name: "No id" } })?.option).toBeNull();
  });

  it("fills in the contract for the option, in the order the server resolves it", () => {
    const library = [
      { id: "k3", title: "This job", body: "<p>Job at {Job address}.</p>", place: "terms", initials: null },
      { id: "k1", title: "Your right to cancel", body: "<p>{Customer name} may cancel.</p>", place: "signatures", initials: true },
      { id: "k2", title: "Warranty", body: "<p>{Warranty}, for {Total}.</p>", place: "terms", initials: false },
    ];
    const template = { ...DEFAULT_TEMPLATE, terms: "Pay {Business name} by check.", sections: ["k1"] };
    const facts = { customerName: "Dana & Lee", jobAddress: ["1482 Ridgeview Dr", "Springfield, IL 62704"], businessName: "R&R Roofing", total: 13975.5, warranty: "50 years" };
    const contract = liveContract({ template, library, optionSectionIds: ["k2", "k1"], quoteSectionIds: ["k3", "gone"], facts });
    expect(contract.sections.map((s) => [s.id, s.html, s.place, s.initials])).toEqual([
      ["k1", "<p>Dana &amp; Lee may cancel.</p>", "signatures", true],
      ["k2", "<p>50 years, for $13,975.50.</p>", "terms", false],
      ["k3", "<p>Job at 1482 Ridgeview Dr, Springfield, IL 62704.</p>", "terms", false],
    ]);
    // The terms are words, not HTML: React escapes them as it prints them.
    expect(contract.terms).toBe("Pay R&R Roofing by check.");
    // Fingerprinted as the server works it out: the words as they print, and the option's card when there is one.
    const resolved = resolveSections({ kind: "estimate", template, optionSectionIds: ["k2", "k1"], quoteSectionIds: ["k3"], library });
    expect(contract.hash).toBe(sectionsHash(resolved, { terms: template.terms, values: contractValues(facts), option: null }));
    const card = { name: "Designer shingle", tier: "Better", warranty: "50 years", highlights: ["Thicker shingles"] };
    const offered = liveContract({ template, library, optionSectionIds: ["k2", "k1"], quoteSectionIds: ["k3"], facts, option: card });
    expect(offered.hash).toBe(sectionsHash(resolved, { terms: template.terms, values: contractValues(facts), option: card }));
    expect(offered.hash).not.toBe(contract.hash);
    // Another total where the words print it is other words to sign.
    expect(liveContract({ template, library, optionSectionIds: ["k2", "k1"], quoteSectionIds: ["k3"], facts: { ...facts, total: 1 } }).hash).not.toBe(contract.hash);
    expect(contractTemplate(template, contract).terms).toBe("Pay R&R Roofing by check.");
    expect(contractTemplate(template, null)).toBe(template);
    expect(hasContract(contract)).toBe(true);
    expect(hasContract({ terms: "  ", sections: [], hash: null })).toBe(false);
    expect(hasContract(null)).toBe(false);
  });

  it("stamps the initials drawn once on the sections they're added to, and knows which still ask", () => {
    const contract = liveContract({
      template: { ...DEFAULT_TEMPLATE, sections: ["k1", "k2", "k3"] },
      library: [
        { id: "k1", title: "Cancel", body: "<p>a</p>", place: "signatures", initials: true },
        { id: "k2", title: "Decking", body: "<p>b</p>", place: "terms", initials: true },
        { id: "k3", title: "Payment", body: "<p>c</p>", place: "terms", initials: false },
      ],
      facts: {},
    });
    expect(awaitingInitials(contract, new Set()).map((s) => s.id)).toEqual(["k1", "k2"]);
    expect(awaitingInitials(contract, new Set(["k1"])).map((s) => s.id)).toEqual(["k2"]);
    const stamped = withInitials(contract, { image: MIKE, date: "2026-10-25T18:00:00Z" }, new Set(["k1", "k3"]));
    expect(stamped.sections.map((s) => s.initialed)).toEqual([{ image: MIKE, date: "2026-10-25T18:00:00Z" }, null, null]);
    // Nothing drawn, nothing stamped.
    expect(withInitials(contract, null, new Set(["k1"])).sections.every((s) => !s.initialed)).toBe(true);
    // Added to a section, they stay while its words are the ones initialed; only sections that ask take them.
    const [k1, k2, k3] = contract.sections as [DocumentSection, DocumentSection, DocumentSection];
    const added = initialSection(initialSection(initialSection(new Map(), k1, true), k2, true), k3, true);
    expect([...stillInitialed(contract, added)]).toEqual(["k1", "k2"]);
    expect([...stillInitialed(contract, initialSection(added, k2, false))]).toEqual(["k1"]);
    expect(stillInitialed(null, added).size).toBe(0);
    // The office's "Mark approved" keeps it with nobody's initials.
    expect(approvalContract(contract)).toEqual({
      terms: DEFAULT_TEMPLATE.terms,
      sections: [
        { id: "k1", title: "Cancel", body: "<p>a</p>", place: "signatures", initials: true, initialed: false },
        { id: "k2", title: "Decking", body: "<p>b</p>", place: "terms", initials: true, initialed: false },
        { id: "k3", title: "Payment", body: "<p>c</p>", place: "terms", initials: false, initialed: false },
      ],
    });
  });

  it("builds an invoice with its contract, its payments on the business's calendar", () => {
    const contract = invoiceContract({
      template: { ...DEFAULT_TEMPLATE, terms: "Thanks, {Customer name}.", invoice_sections: ["k9"], sections: ["k1"] },
      library: [{ id: "k9", title: "Late payments", body: "<p>Invoice {Estimate number} is due on receipt.</p>", place: "signatures", initials: true }],
      facts: { customerName: "Dana", estimateNumber: 77 },
    });
    expect(contract).toEqual({ terms: "Thanks, Dana.", sections: [{ id: "k9", title: "Late payments", html: "<p>Invoice 77 is due on receipt.</p>", place: "signatures", initials: false }], hash: null });
    const doc = invoiceDocument(
      {
        number: 77, issued_on: "2026-10-01", due_on: null, subject: "Roof", notes: " ", subtotal: 1000, discount_amount: 0, tax_amount: 0, total: 1000, retainage_amount: 0, balance_due: 500,
        client: { display_name: "Dana" }, lines: [{ name: "Roof", quantity: 1, unit: "ea", unit_price: 1000 }],
        // A tip on its own doesn't change what's owed; this one landed late at night in Chicago.
        payments: [{ amount: 500, received_at: "2026-10-06T03:00:00Z" }, { amount: 0, received_at: "2026-10-07T16:00:00Z" }],
      },
      { timeZone: "America/Chicago", contract },
    );
    expect(doc).toMatchObject({ kind: "invoice", number: 77, notes: null, balanceDue: 500, payments: [{ label: "Paid Oct 5, 2026", amount: 500 }] });
    expect(doc.contract?.sections.map((s) => s.id)).toEqual(["k9"]);
  });
});

describe("the page", () => {
  it("has the letterhead, the lines and the totals", () => {
    const html = page({ tagline: "Roofing · Siding · Gutters", license: "#RC-104882", insurer: "Hartwell Mutual" });
    for (const text of ["Ridgeline Roofing Co.", "Roofing · Siding · Gutters", "2290 Harper Rd", "(614) 555-0188 · office@ridgeline.example", "ridgeline.example", "License #RC-104882", "Insured by Hartwell Mutual", "Prepared for", "Alex Morgan", "No. 1042", "Good until", "24.2 sq", "$560.00", "$13,552.00", "$18,304.00", "Page 1 of 1"]) {
      expect(html, text).toContain(text);
    }
    // The business's initials stand in for a missing logo; the brand color colors the page.
    expect(html).toContain(">RR<");
    expect(html).toContain("--doc-color:#3b7d23");
  });

  it("leaves off what the template turns off", () => {
    const html = page({ license: "#RC-104882", show_license: false, insurer: "Hartwell", show_insurer: false, page_numbers: false, terms: "", customer_signs: false, company_signs: false });
    expect(html).not.toContain("RC-104882");
    expect(html).not.toContain("Hartwell");
    // No number printed (each page is still named "Page 1 of 1" to a screen reader).
    expect(html).not.toContain(">Page 1");
    expect(html).not.toContain("Customer");
    expect(html).not.toContain("representative");
  });

  it("draws the signature lines, with each signature on its line", () => {
    const blank = page({ customer_label: "Homeowner" });
    expect(blank).toContain("Homeowner");
    expect(blank).toContain("Ridgeline Roofing Co. representative");
    expect(blank).not.toContain("<img");

    const signed = page({ customer_label: "Homeowner", company_label: "Sales rep" }, { ...SAMPLE_DOCUMENT, signatures: { customer: { name: "Alex Morgan", image: INK, date: "2026-10-24T18:14:00Z" }, company: { name: "Mike Torres", image: MIKE, date: "2026-10-24T18:14:00Z" } } });
    expect(signed).toContain(`src="${INK}"`);
    expect(signed).toContain('alt="Signature of Alex Morgan"');
    expect(signed).toContain(`src="${MIKE}"`);
    expect(signed).toContain("Mike Torres");
    expect(signed).toContain("Sales rep");
    expect(signed).toContain("Oct 24, 2026");

    // A signature is never left off the copy, even if the template stopped asking for that line.
    expect(page({ company_signs: false }, { ...SAMPLE_DOCUMENT, signatures: { company: { name: "Mike Torres", image: MIKE, date: null } } })).toContain(`src="${MIKE}"`);
  });

  it("prints in each header style and lettering", () => {
    const logo = renderToStaticMarkup(createElement(EstimateDocument, { template: templateSettings({ header: "banner" }), company: { ...company, logo: "/api/public/logo/c/l.png" }, data: SAMPLE_DOCUMENT }));
    expect(logo).toContain('src="/api/public/logo/c/l.png"');
    expect(page({ header: "centered" })).toContain("2290 Harper Rd, Columbus, OH 43204 · (614) 555-0188");
    expect(page({ font: "classic" })).toContain("Palatino");
  });

  it("keeps the room for each printed name, so typing one doesn't move the page", () => {
    const blank = page({});
    expect(blank.split(`class="${styles.printed}"`).length - 1).toBe(2);
    expect(blank).toContain(`class="${styles.printed}"></div>`);
  });

  it("prints an invoice with what's been paid and what's left, and no signature lines", () => {
    const html = page({}, { ...SAMPLE_DOCUMENT, kind: "invoice", dueOn: "2026-11-21", payments: [{ label: "Paid Oct 30, 2026", amount: 5000 }, { label: "Refunded Nov 2, 2026", amount: -100 }], balanceDue: 13404, signatures: undefined });
    expect(html).toContain("Invoice");
    expect(html).toContain("Bill to");
    expect(html).toContain("Due November 21, 2026");
    expect(html).toContain("−$5,000.00");
    expect(html).toContain("+$100.00");
    expect(html).toContain("Balance due");
    expect(html).toContain("$13,404.00");
    expect(html).not.toContain("representative");
  });

  it("prints the template's own terms as always: no title, line breaks kept, on estimates and invoices", () => {
    const terms = "Payment: half to start.\nThe rest when it's done.\n\nWarranty: 10 years on workmanship.";
    for (const data of [SAMPLE_DOCUMENT, { ...SAMPLE_DOCUMENT, kind: "invoice" as const, signatures: undefined }]) {
      const html = page({ terms }, data);
      expect(html).toContain("Payment: half to start.\nThe rest when it&#x27;s done.");
      expect(html).toContain("Warranty: 10 years on workmanship.");
      expect(html).not.toContain("Terms and conditions");
      expect(html).not.toContain(">Terms<");
    }
  });
});

describe("pages", () => {
  const sections: DocumentSection[] = [
    { id: "a", title: "Payment", html: "<p>Half to start, the rest when it's done.</p>", place: "signatures", initials: false },
    { id: "b", title: "Your right to cancel", html: "<p>You may cancel within 3 business days.</p>", place: "terms", initials: true },
  ];
  const data: DocumentData = { ...SAMPLE_DOCUMENT, contract: { sections } };

  it("puts everything on one page until the browser has measured it", () => {
    const html = page({}, data);
    expect(pagesOf(html)).toHaveLength(1);
    expect(html).toContain("Page 1 of 1");
    expect(html).not.toContain("continued");
  });

  it("draws each page of a layout: the letterhead first, a running header after, the footer and page number on every one", () => {
    const layout = pagesAt({}, data, ["line-5", "terms-heading"]);
    // Page 2 carries on the lines under their head, and ends with the sentence and signatures at its bottom.
    layout[1]!.repeatHead = "lines";
    layout[1]!.pinFrom = layout[1]!.fragments.findIndex((f) => f.key === "accept");
    const [first, second, third] = pagesOf(page({ footer: "Thank you for your business" }, data, layout));
    expect([first, second, third].every(Boolean)).toBe(true);

    expect(first).toContain("2290 Harper Rd");
    expect(first).not.toContain("continued");
    expect(first).toContain("Description");
    expect(first).toContain("Page 1 of 3");

    expect(second).not.toContain("2290 Harper Rd");
    expect(second).toContain("Ridgeline Roofing Co. · Estimate No. 1042");
    expect(second).toContain("continued");
    // The head of the lines again, over the rows carried on.
    expect(second).toContain("Description");
    expect(second).toContain("Ridge vent");
    expect(second).toContain("Payment");
    expect(second).toContain("By signing, you agree to this estimate and the terms on the pages that follow.");
    expect(second).toContain("margin-top:auto");
    expect(second).toContain("Page 2 of 3");

    // The terms pages start a page of their own, with the initials box under what it's for.
    expect(third).toContain("Terms and conditions");
    expect(third).toContain("Your right to cancel");
    expect(third).toContain("You may cancel within 3 business days.");
    expect(third).toContain("Initials");
    expect(third).not.toContain("Description");
    expect(third).toContain("Page 3 of 3");
    for (const p of [first, second, third]) expect(p).toContain("Thank you for your business");
  });

  it("keeps the room for the widest page number beside the footer's words, so they wrap on every page as they were measured", () => {
    const layout = pagesAt({}, data, ["line-5", "terms-heading"]);
    const pages = pagesOf(page({ footer: "Licensed and insured · Family owned since 1998" }, data, layout));
    for (const [i, p] of pages.entries()) {
      expect(p).toContain(`<span>Page ${i + 1} of 3</span><span class="${styles.pageNumberRoom}">Page 888 of 888</span>`);
    }
  });

  it("reads each page once, in order, to a screen reader: named by its number, its running header and repeated footer left out", () => {
    const layout = pagesAt({}, data, ["line-5", "terms-heading"]);
    const html = page({ footer: "Licensed and insured" }, data, layout, false, 3);
    const [first, second, third] = pagesOf(html);
    expect(first).toMatch(/^1" role="group" aria-label="Page 1 of 3"/);
    expect(second).toMatch(/^2" role="group" aria-label="Page 2 of 3"/);
    expect(second).toContain(`<header class="${styles.running}" aria-hidden="true">`);
    // The footer's words are read once, on the last page; its page numbers never (each page is named by its number).
    expect(first).toContain(`<footer class="${styles.footer}" aria-hidden="true">`);
    expect(second).toContain(`<footer class="${styles.footer}" aria-hidden="true">`);
    expect(third).toContain(`<footer class="${styles.footer}"><span>Licensed and insured</span><span class="${styles.pageNumber}" aria-hidden="true">`);
    // Its headings go under the screen's: the estimate, then "Terms and conditions" and the sections above the signatures, then the terms' sections.
    expect(first).toContain('role="heading" aria-level="3">Estimate<');
    expect(second).toContain('aria-level="4">Payment</h3>');
    expect(third).toContain('aria-level="4">Terms and conditions</h2>');
    expect(third).toContain('aria-level="5">Your right to cancel</h3>');
    expect(page({}, data)).toContain('role="heading" aria-level="2">Estimate<');
  });

  it("draws each part of a block cut between pages with only its own words", () => {
    const notes = { ...data, notes: "A note long enough to go on over the page" };
    const layout = pagesAt({}, notes, ["notes-0"]);
    cutAcross(layout, 0, "notes-0", [{ from: 0, to: 19, html: "" }], [{ from: 19, to: 41, html: "" }]);
    const [first, second] = pagesOf(page({}, notes, layout));
    // The label stays with the note's first line.
    expect(first).toContain(">Notes<");
    expect(first).toContain("A note long enough</span>");
    expect(first).not.toContain("to go on over the page");
    expect(second).not.toContain(">Notes<");
    expect(second).toContain("<span>to go on over the page</span>");
    expect(second).not.toContain("A note long enough");
    // Nothing is drawn through a window: no page holds words it doesn't show.
    expect(first + second).not.toContain(styles.clip);
  });

  it("carries a long line on under the head of the lines, with the rest of its words and no amounts", () => {
    const long: DocumentData = { ...SAMPLE_DOCUMENT, lines: [{ name: "Scope of work", description: "First part of the words. Second part of the words.", quantity: 1, unit: "ea", unit_price: 100, total: 100 }] };
    const layout = pagesAt({}, long, ["line-0", "totals"]);
    layout[1]!.repeatHead = "lines";
    cutAcross(layout, 0, "line-0", [{ from: 0, to: 13, html: "" }, { from: 0, to: 25, html: "" }], [{ from: 13, to: 13, html: "" }, { from: 25, to: 50, html: "" }]);
    const [first, second] = pagesOf(page({}, long, layout));
    expect(first).toContain("<span>Scope of work</span>");
    expect(first).toContain(">First part of the words.</span>");
    expect(first).not.toContain("Second part");
    expect(first).toContain("$100.00");
    expect(first).toContain("data-carries");
    expect(second).toContain("Description");
    expect(second).toContain('<tr data-carried="">');
    expect(second).toContain(">Second part of the words.</span>");
    expect(second).not.toContain("Scope of work");
    expect(second).not.toContain("$100.00");
  });

  it("carries a list item on without its number, and a contract paragraph as the browser cut it", () => {
    const html = "<ol><li>Within 3 business days.</li></ol><p>In writing, to our office.</p>";
    asInBrowser({ [html]: [{ kind: "li", list: "ol", number: 1, html: "Within 3 business days." }, { kind: "p", html: "In writing, to our office." }] });
    const cancel = { ...data, contract: { sections: [{ ...sections[1]!, html }] } };
    const layout = pagesAt({}, cancel, ["s0-0", "s0-1"]);
    cutAcross(layout, 0, "s0-0", [{ from: 0, to: 10, html: "Within 3 " }], [{ from: 10, to: 23, html: "business days." }]);
    cutAcross(layout, 1, "s0-1", [{ from: 0, to: 11, html: "In <b>writing</b>," }], [{ from: 11, to: 26, html: "<b>to</b> our office." }]);
    const [first, second, third] = pagesOf(page({}, cancel, layout));
    expect(first).toContain('start="1"><li>Within 3 </li></ol>');
    expect(second).toContain('<li data-carried="">business days.</li>');
    expect(second).toContain("In <b>writing</b>,</div>");
    expect(third).toContain("<b>to</b> our office.</div>");
  });

  it("draws part of a block that can't be cut between its lines through a window onto it, as a last resort", () => {
    const layout = pagesAt({}, data, ["totals"]);
    layout[0]!.fragments.push({ key: "totals", offset: 0, height: 40, part: true });
    layout[1]!.fragments[0] = { key: "totals", offset: 40, height: 60, part: true };
    const [first, second] = pagesOf(page({}, data, layout));
    expect(first).toContain(`class="${styles.clip}" style="height:40px"><div`);
    expect(second).toContain(`class="${styles.shift}" style="margin-top:-40px"`);
    // Each window holds all of the block, so it's read only from the first.
    expect(second).toContain(`class="${styles.clip}" style="height:60px" aria-hidden="true">`);
  });

  it("falls back to one page when the layout is for other blocks (the document changed since)", () => {
    const layout = pagesAt({}, data, ["line-5"]);
    layout[1]!.fragments.pop();
    expect(pagesOf(page({}, data, layout))).toHaveLength(1);
    expect(pagesOf(page({}, data, [...pagesAt({}, data, []), { fragments: [{ key: "gone", offset: 0, height: 10 }], repeatHead: null, pinFrom: null }]))).toHaveLength(1);
  });

  it("shows only the first page for a thumbnail, numbered as one of all of them", () => {
    const html = page({}, data, pagesAt({}, data, ["line-5", "terms-heading"]), true);
    expect(pagesOf(html)).toHaveLength(1);
    expect(html).toContain("Page 1 of 3");
    expect(html).not.toContain("Terms and conditions");
  });

  it("puts sections above the signatures, or on terms pages after them, with the initials they ask for", () => {
    const initialed = { ...sections[1]!, initialed: { image: INK, date: "2026-10-24T18:14:00Z" } };
    const html = page({}, { ...data, contract: { sections: [sections[0]!, initialed] } });
    expect(html).toContain(`src="${INK}" alt="Initials"`);
    expect(html).toContain("Initials · Oct 24, 2026");
    const order = ["Payment", "By signing", "Ridgeline Roofing Co. representative", "Terms and conditions", "Your right to cancel"].map((t) => html.indexOf(t));
    expect(order.every((at, i) => at > (order[i - 1] ?? 0))).toBe(true);
    // Only above the signatures: no terms pages, and no sentence pointing at them.
    const above = page({}, { ...data, contract: { sections: [sections[0]!] } });
    expect(above).not.toContain("Terms and conditions");
    expect(above).not.toContain("By signing");
    // A picture that isn't a drawn PNG never prints: the box is left to initial by hand.
    expect(page({}, { ...data, contract: { sections: [{ ...initialed, initialed: { image: "https://evil.example/i.png", date: null } }] } })).not.toContain("evil.example");
  });

  it("prints an invoice's sections after its notes, with no terms pages", () => {
    const html = page({}, { ...data, kind: "invoice", notes: "Thanks!", signatures: undefined });
    expect(html).toContain("Your right to cancel");
    expect(html).not.toContain("Terms and conditions");
    expect(html.indexOf("Thanks!")).toBeLessThan(html.indexOf("Payment"));
  });

  it("compares the options an estimate offers when it offers two or more, on the copies the screen gives them to", () => {
    const options: DocumentOption[] = [
      { id: "o1", name: "Architectural shingle", tier: "Good", picture: null, style: "shingle", highlights: ["30-year shingles", "Ridge vent"], warranty: "10-year workmanship", total: 18304, chosen: true },
      { id: "o2", name: "Standing-seam metal", tier: "Best", picture: { src: "/api/public/package/c/p.jpg", width: 1600, height: 900 }, style: "metal", highlights: [], warranty: "", total: 31250, chosen: false },
    ];
    const html = page({}, { ...SAMPLE_DOCUMENT, options });
    for (const text of ["Your options", "Good", "Architectural shingle", "30-year shingles", "10-year workmanship", "$18,304.00", "Best", "$31,250.00", 'src="/api/public/package/c/p.jpg" width="1600" height="900"']) expect(html, text).toContain(text);
    expect(page({}, { ...SAMPLE_DOCUMENT, options: options.slice(0, 1) })).not.toContain("Your options");
    // Which copies compare them is the screen's to say (the copy being signed leaves them off): a signature doesn't change the page.
    expect(page({}, { ...SAMPLE_DOCUMENT, options, signatures: { customer: { name: "Alex Morgan", image: INK, date: null } } })).toContain("Your options");
    expect(page({}, { ...SAMPLE_DOCUMENT, options: undefined })).not.toContain("Your options");
  });

  it("keeps headings with what follows, the initials with their section, and the sentence with the signatures", () => {
    const terms = "<h3>Deposits</h3><p>Held until we start.</p>";
    const table = "<table>...</table>";
    asInBrowser({
      [terms]: [{ kind: "p", html: "Half to start." }, { kind: "h3", html: "Deposits" }, { kind: "p", html: "Held until we start." }],
      [table]: contractTable([{ thead: true, cells: [{ tag: "th", html: "Part", colSpan: 1, rowSpan: 1 }] }, { thead: false, cells: [{ tag: "td", html: "Shingles", colSpan: 1, rowSpan: 1 }] }], 1),
    });
    const contract = { sections: [{ ...sections[0]!, html: terms }, sections[1]!, { id: "c", title: "Warranty", html: table, place: "terms" as const, initials: false }] };
    const blocks = documentBlocks(DEFAULT_TEMPLATE, company, { ...SAMPLE_DOCUMENT, notes: "Thanks!", contract });
    const at = (key: string) => {
      const block = blocks.find((b) => b.key === key);
      expect(block, key).toBeDefined();
      return block!;
    };
    expect(blocks.map((b) => b.key)).toEqual([
      "parties", "lines-head", ...SAMPLE_DOCUMENT.lines.map((_, i) => `line-${i}`), "totals", "notes-0", "terms-0",
      "s0-title", "s0-0", "s0-1", "s0-2", "accept", "signatures", "terms-heading", "s1-title", "s1-0", "s1-initials", "s2-title", "s2-t1-head", "s2-t1-0",
    ]);
    // The head of the lines stays with the first row, and repeats over the rows on later pages; a row moves whole unless it's taller than a page.
    expect(at("lines-head")).toMatchObject({ keepWithNext: true, head: true, table: "lines", cuts: false });
    expect(at("line-0")).toMatchObject({ table: "lines", whole: true, cuts: true, keepWithNext: false });
    for (const key of ["parties", "totals", "signatures", "s1-initials"]) expect(at(key).cuts, key).toBe(false);
    for (const key of ["notes-0", "terms-0", "s0-0", "s1-0"]) expect(at(key).cuts, key).toBe(true);
    // Titles and headings never end a page alone.
    for (const key of ["s0-title", "s0-1", "s1-title", "s2-title", "terms-heading"]) expect(at(key).keepWithNext, key).toBe(true);
    expect(at("s0-0").keepWithNext).toBe(false);
    expect(at("s0-2").keepWithNext).toBe(false);
    // A section's last words stay with its initials.
    expect(at("s1-0").keepWithNext).toBe(true);
    expect(at("s1-initials").keepWithNext).toBe(false);
    // The sentence and the signatures sit at the bottom of their page together; the terms pages start a page.
    expect(at("accept")).toMatchObject({ keepWithNext: true, pinBottom: true });
    expect(at("signatures")).toMatchObject({ keepWithNext: false, pinBottom: false });
    expect(at("terms-heading")).toMatchObject({ breakBefore: true, keepWithNext: true });
    // A contract's table: its head stays with its first row and repeats; each row moves whole.
    expect(at("s2-t1-head")).toMatchObject({ head: true, keepWithNext: true, table: "s2-t1" });
    expect(at("s2-t1-0")).toMatchObject({ table: "s2-t1", whole: true, cuts: true });

    // With no terms pages, the signatures alone sit at the bottom of their page.
    const plain = documentBlocks(DEFAULT_TEMPLATE, company, SAMPLE_DOCUMENT);
    expect(plain.find((b) => b.key === "signatures")).toMatchObject({ pinBottom: true });
    expect(plain.some((b) => b.key === "accept")).toBe(false);
  });
});

describe("contract sections without a browser", () => {
  it("cleans a section to escaped plain words, never HTML", () => {
    const html = '<h3>Payment</h3><p>Half <b>now</b> &amp; half <a href="https://x.example">later</a>.</p><script>alert(1)</script><img src=x onerror=alert(1)>';
    expect(sanitizeContractHtml(html)).toBe("Payment\nHalf now &amp; half later.");
    expect(sanitizeContractHtml('<p>1 < 2 & "quoted" &#39;s</p>')).toBe("1 &lt; 2 &amp; &quot;quoted&quot; &#39;s");
    expect(sanitizeContractHtml("<p>Unclosed <img src=x onerror=alert(1)")).toBe("Unclosed");
    // Headings and boxes a contract doesn't use still end their line, so no words run together.
    expect(sanitizeContractHtml("<h2>Big heading</h2><div>div text</div><section>More</section>")).toBe("Big heading\ndiv text\nMore");
  });

  it("prints a section's body as one block of its words", () => {
    expect(contractBlocks("<p>Half to start.</p><ul><li>Cash</li><li>Check</li></ul>")).toEqual([{ kind: "text", html: "Half to start.\nCash\nCheck" }]);
    expect(contractBlocks("<p> </p>")).toEqual([]);
    const html = page({}, { ...SAMPLE_DOCUMENT, contract: { sections: [{ id: "x", title: "Changes", html: "<p>Only <script>alert(1)</script>with your OK.</p>", place: "signatures", initials: false }] } });
    expect(html).toContain("Only with your OK.");
    expect(html).not.toContain("<script");
  });
});

describe("a contract's table", () => {
  const cell = (html: string, more: { tag?: "td" | "th"; colSpan?: number; rowSpan?: number } = {}) => ({ tag: more.tag ?? "td", html, colSpan: more.colSpan ?? 1, rowSpan: more.rowSpan ?? 1 });

  it("prints each row on its own, a cell spanning rows over empty cells that keep the columns lined up", () => {
    const rows = contractTable(
      [
        { thead: true, cells: [cell("Part", { tag: "th" }), cell("Years", { tag: "th" }), cell("Covers", { tag: "th" })] },
        { thead: false, cells: [cell("Roof", { rowSpan: 2 }), cell("10"), cell("Labor")] },
        { thead: false, cells: [cell("25"), cell("Shingles")] },
        { thead: false, cells: [cell("Gutters", { colSpan: 2 }), cell("Both")] },
      ],
      3,
    );
    expect(rows.map((r) => r.cells.map((c) => c.html))).toEqual([["Part", "Years", "Covers"], ["Roof", "10", "Labor"], ["", "25", "Shingles"], ["Gutters", "Both"]]);
    expect(rows.every((r) => r.kind === "row" && r.table === 3 && r.columns === 3)).toBe(true);
    expect(rows[3]!.cells[0]).toEqual({ tag: "td", html: "Gutters", colSpan: 2 });
    // The head is the table's own head, or the rows of headings at its top; never every row.
    expect(rows.map((r) => r.head)).toEqual([true, false, false, false]);
    expect(contractTable([{ thead: false, cells: [cell("A", { tag: "th" })] }, { thead: false, cells: [cell("B", { tag: "th" })] }], 1).map((r) => r.head)).toEqual([true, false]);
    expect(contractTable([{ thead: false, cells: [cell("A")] }, { thead: true, cells: [cell("B")] }], 1).map((r) => r.head)).toEqual([false, false]);
  });

  it("keeps the columns of a short row under a cell spanning down further along", () => {
    const rows = contractTable([{ thead: false, cells: [cell("A"), cell("B"), cell("Note", { rowSpan: 2 })] }, { thead: false, cells: [cell("C")] }], 1);
    expect(rows[1]!.cells.map((c) => c.html)).toEqual(["C", "", ""]);
  });
});

describe("the business's own letterhead", () => {
  const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
  const top = { path: `${COMPANY_ID}/letterhead/11111111-1111-4111-8111-111111111111.png`, width: 1540, height: 300 };
  const bottom = { path: `${COMPANY_ID}/letterhead/22222222-2222-4222-8222-222222222222.png`, width: 1540, height: 120 };
  const own: Partial<TemplateSettings> = { letterhead: "custom", letterhead_header: top, letterhead_footer: bottom, footer: "Thank you for your business" };

  it("prints its pictures in place of Crewtavo's letterhead and the footer's words, on estimates and invoices", () => {
    for (const data of [SAMPLE_DOCUMENT, { ...SAMPLE_DOCUMENT, kind: "invoice" as const, signatures: undefined }]) {
      const html = page(own, data, pagesAt(own, data, ["totals"]));
      const [first, second] = pagesOf(html);
      // The top on the first page only; the bottom on every page, with its number above it.
      expect(first).toContain(`src="/api/public/letterhead/${COMPANY_ID}/11111111-1111-4111-8111-111111111111.png" width="1540" height="300" alt="Ridgeline Roofing Co."`);
      expect(second).not.toContain("11111111-1111-4111-8111-111111111111.png");
      for (const p of [first!, second!]) expect(p).toContain(`src="/api/public/letterhead/${COMPANY_ID}/22222222-2222-4222-8222-222222222222.png" width="1540" height="120"`);
      expect(second!.indexOf("Page 2 of 2")).toBeLessThan(second!.indexOf("22222222-2222-4222-8222-222222222222.png"));
      expect(first).toContain("Page 1 of 2");
      expect(html).not.toContain("2290 Harper Rd");
      expect(html).not.toContain("Thank you for your business");
    }
  });

  it("keeps Crewtavo's letterhead when the template uses it, or the picture is missing", () => {
    const builtIn = page({ ...own, letterhead: "built_in" });
    expect(builtIn).not.toContain("/api/public/letterhead/");
    expect(builtIn).toContain("2290 Harper Rd");
    expect(builtIn).toContain("Thank you for your business");
    // Only the bottom uploaded: Crewtavo's top (never a blank one), the picture along the bottom.
    const footerOnly = page({ ...own, letterhead_header: null });
    expect(footerOnly).toContain("2290 Harper Rd");
    expect(footerOnly).toContain("22222222-2222-4222-8222-222222222222.png");
    expect(footerOnly).not.toContain("Thank you for your business");
    // Only the top: the footer's words along the bottom.
    const headerOnly = page({ ...own, letterhead_footer: null });
    expect(headerOnly).not.toContain("2290 Harper Rd");
    expect(headerOnly).toContain("Thank you for your business");
  });

  it("leaves the page numbers off its footer picture when the template does", () => {
    const html = page({ ...own, page_numbers: false });
    expect(html).toContain("22222222-2222-4222-8222-222222222222.png");
    expect(html).not.toContain(">Page 1");
  });
});

describe("an invoice's {Option} and {Warranty}", () => {
  // As the Client Hub fills them in (services/contracts.ts invoiceFill), from the quote the job came from.
  const chose = { name: "Designer shingle", warranty: "50-year shingles" };
  it("say the option the client chose, as it was kept with the approval", () => {
    expect(invoiceFill({ approval: { name: "Dana", option: { id: "o1", name: "Designer shingle", tier: "Better", warranty: "50-year shingles", highlights: [] } }, option_id: "o1", option: { name: "Renamed since", warranty: "" } })).toEqual(chose);
  });

  it("say the option the quote shows when the approval didn't keep one, else the package it was priced from", () => {
    expect(invoiceFill({ approval: { name: "Office" }, option_id: "o1", option: chose, package: { name: "Architectural shingle", warranty: "25 years" } })).toEqual(chose);
    expect(invoiceFill({ approval: null, option_id: null, option: null, package: { name: "Architectural shingle", warranty: null } })).toEqual({ name: "Architectural shingle", warranty: "" });
    // An option that's gone says nothing, as the server's does; a job not made from a quote, nothing.
    expect(invoiceFill({ approval: null, option_id: "o1", option: null, package: { name: "Architectural shingle", warranty: "25 years" } })).toBeNull();
    expect(invoiceFill(null)).toBeNull();
  });
});
