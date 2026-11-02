/**
 * A letter-size estimate or invoice on the business's template: the pages that print, that "Print
 * or save PDF" makes, and that the homeowner's link shows once it's signed, with both signatures on
 * their lines. Page 1 has Crewtavo's letterhead or the business's own picture of it; later pages a
 * slim running header; every page the footer (the template's words or the business's own picture)
 * and "Page 2 of 3". Three ways to show it:
 *   - EstimateDocument: the pages themselves, 816 px wide (8.5 in), laid out as it's told.
 *   - DocumentSheet: the pages scaled down to fit their column, as sheets of paper on screen.
 *   - PrintableDocument: nothing on screen, and the only thing on the page when it's printed.
 *
 * The body is a list of blocks (the parties, each line row, the totals, each paragraph of a contract
 * section...). DocumentSheet and PrintableDocument measure them in a hidden copy (usePaper) and
 * paginate.ts decides which go on which page; paper.ts has the page's measurements, the same on
 * screen and in print, so the pages on screen are the pages that print. A block too tall for the
 * room left is cut between two of its lines, and each page draws only its part's own words.
 */
import { companySignatureLabel, documentColor, letterheadSrc, ownLetterhead, type LetterheadPicture, type TemplateSettings } from "@crewtavo/core/documents";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { formatMoneyCents } from "@/lib/format";
import { contractBlocks, type ContractBlock } from "@/lib/html";
import { initials, inkOn, licenseLine, longDate, quantityLabel, readableOnWhite, shortDate, websiteLabel } from "./build";
import styles from "./EstimateDocument.module.css";
import { paginate, type PaperBlock, type PaperLayout } from "./paginate";
import { cutWords, isWebKit, lineCuts, nextFrames, PAGE_WIDTH, PAPER_VARS, paperSettled, paperSpace, stackHeight, WEBKIT_PAGE_MARGIN, WEBKIT_PRINT_SCALE, type PaperWords } from "./paper";
import type { DocumentCompany, DocumentData, DocumentLayout, DocumentLine, DocumentOption, DocumentSection, DocumentSignature, EstimateDocumentProps, PaperPart } from "./types";

export { PAGE_HEIGHT, PAGE_WIDTH } from "./paper";

export const CLASSIC_FONT = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/** No layout effects on the server (they'd only warn); the pages are measured in the browser. */
const useIsoLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

// ---------------------------------------------------------------------------------------------
// The blocks of the body
// ---------------------------------------------------------------------------------------------

/** Between the body's parts (the parties, the strip, the lines, the totals...). */
const GAP = 20;
/** Above a contract section's title, and between its paragraphs. */
const TITLE_GAP = 18;
const CLAUSE_GAP = 8;
/** Between the items of a list. */
const ITEM_GAP = 3;
/** A blank line between paragraphs of the notes (12 px, 1.6 apart) and of the template's terms (11 px). */
const NOTES_LINE = 19.2;
const TERMS_LINE = 17.6;

/** One block of the body, and what paginate.ts needs to know about it. */
interface Piece {
  key: string;
  /** All of it, its words that may be cut between their lines marked `data-split` (paper.ts). */
  node: ReactNode;
  /**
   * Part of it, cut between two of its lines: the words of each `data-split` box in that part.
   * Without it the block is never cut between its lines: it moves to the next page whole.
   */
  part?: (cut: PaperPart) => ReactNode;
  /** Room above it, unless it starts a page. */
  space: number;
  keepWithNext?: boolean;
  breakBefore?: boolean;
  pinBottom?: boolean;
  /** Moves whole, and is cut between its lines only when it's taller than a page. */
  whole?: boolean;
  /** Part of a table: its head (`head`) or one of its rows. The node is table rows. */
  table?: string;
  head?: boolean;
}

/** A table whose rows are blocks: drawn the same way on every page it's on, its head over its rows. */
interface PieceTable {
  className: string;
  cols: ReactNode;
  head: ReactNode | null;
  headKey: string | null;
}

/** A document taken apart for the pages: its look, the parts of a page, and the blocks of the body. */
interface Paper {
  label: string;
  vars: CSSProperties;
  letterhead: ReactNode;
  running: ReactNode;
  footer: (page: number, pages: number) => ReactNode;
  pieces: Piece[];
  tables: Record<string, PieceTable>;
}

/** A part's words of `text` (characters `from` to `to`), without the spaces and line breaks at either end. */
const wordsOf = (text: string, words: PaperWords | undefined) => (words ? text.slice(words.from, words.to).trim() : "");

/** A data attribute that's there when `on`. */
const flag = (on: boolean | undefined) => (on ? "" : undefined);

/** Paragraphs of plain text: split at blank lines, line breaks in each kept. */
const paragraphs = (text: string | null | undefined) =>
  (text ?? "")
    .trim()
    .split(/\n[ \t]*\n\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

const LINE_COLS = (
  <colgroup>
    <col />
    <col className={styles.colQty} />
    <col className={styles.colPrice} />
    <col className={styles.colAmount} />
  </colgroup>
);

const LINE_HEAD = (
  <tr>
    <th scope="col">Description</th>
    <th scope="col" className={styles.num}>Qty</th>
    <th scope="col" className={styles.num}>Price</th>
    <th scope="col" className={styles.num}>Amount</th>
  </tr>
);

/**
 * The pages of a document, taken apart. `level` is the document's own heading level (its title,
 * "Estimate"); "Terms and conditions" and the sections above the signatures are a level under it,
 * the sections on the terms pages two.
 */
function paperOf(template: TemplateSettings, company: DocumentCompany, data: DocumentData, level = 2): Paper {
  const estimate = data.kind === "estimate";
  const kind = estimate ? "Estimate" : "Invoice";
  const color = documentColor(template, company.settings);
  const vars = {
    ...PAPER_VARS,
    "--doc-color": color,
    "--doc-on-color": inkOn(color),
    "--doc-text-color": readableOnWhite(color),
    fontFamily: template.font === "classic" ? CLASSIC_FONT : "var(--font)",
  } as CSSProperties;
  const own = ownLetterhead(template);
  const words = template.footer.trim();

  const pieces: Piece[] = [];
  const tables: Record<string, PieceTable> = {};
  const add = (piece: Piece) => pieces.push(piece);

  add({ key: "parties", node: <Parties data={data} level={level} />, space: 0 });
  if (data.title || (data.facts?.length ?? 0) > 0) {
    add({
      key: "strip",
      node: (
        <div className={styles.strip}>
          {data.title && <strong>{data.title}</strong>}
          {data.facts?.map((fact, i) => <span key={i}>{fact}</span>)}
        </div>
      ),
      space: GAP,
    });
  }
  // Still deciding between options: side by side. Screens leave them off the copy being signed (its strip says which).
  const options = estimate && (data.options?.length ?? 0) >= 2 ? data.options! : [];
  if (options.length) add({ key: "options", node: <Options options={options} />, space: GAP });

  tables.lines = { className: styles.lines, cols: LINE_COLS, head: LINE_HEAD, headKey: "lines-head" };
  add({ key: "lines-head", node: LINE_HEAD, table: "lines", head: true, space: GAP, keepWithNext: true });
  data.lines.forEach((line, i) => add({ key: `line-${i}`, node: <LineRow line={line} />, part: (cut) => <LineRow line={line} cut={cut} />, table: "lines", space: 0, whole: true }));
  if (!data.lines.length) {
    add({
      key: "line-none",
      node: (
        <tr>
          <td colSpan={4} className={styles.empty}>Nothing on it yet.</td>
        </tr>
      ),
      table: "lines",
      space: 0,
    });
  }

  add({ key: "totals", node: <Totals data={data} />, space: GAP });

  paragraphs(data.notes).forEach((text, i) => {
    // The label stays with the note's first line (paper.ts never cuts above it).
    const label = i === 0 && <div className={styles.eyebrow}>Notes</div>;
    add({
      key: `notes-${i}`,
      node: (
        <div className={styles.notes}>
          {label}
          <span data-split="">{text}</span>
        </div>
      ),
      part: ({ words: [words], carried }) => (
        <div className={styles.notes}>
          {!carried && label}
          <span>{wordsOf(text, words)}</span>
        </div>
      ),
      space: i ? NOTES_LINE : GAP,
    });
  });
  // The template's own terms, as they've always printed: no title, line breaks kept.
  paragraphs(template.terms).forEach((text, i) =>
    add({
      key: `terms-${i}`,
      node: <div className={cx(styles.terms, i === 0 && styles.termsFirst)} data-split="">{text}</div>,
      part: ({ words: [words], carried }) => <div className={cx(styles.terms, i === 0 && !carried && styles.termsFirst)}>{wordsOf(text, words)}</div>,
      space: i ? TERMS_LINE : GAP,
    }),
  );

  const sections = data.contract?.sections ?? [];
  // Invoices print every section after their notes; estimates put some above the signatures and the rest on the terms pages.
  const terms = estimate ? sections.filter((s) => s.place === "terms") : [];
  sections.forEach((section, n) => {
    if (!estimate || section.place !== "terms") sectionPieces(section, `s${n}`, level + 1, add, tables);
  });

  if (estimate && signsAnything(template, data.signatures)) {
    // The sentence and the signatures sit together at the bottom of their page.
    if (terms.length) add({ key: "accept", node: <p className={styles.accept}>By signing, you agree to this estimate and the terms on the pages that follow.</p>, space: GAP, keepWithNext: true, pinBottom: true });
    add({ key: "signatures", node: <Signatures template={template} company={company} signatures={data.signatures} />, space: terms.length ? 4 : GAP, pinBottom: !terms.length });
  }
  if (terms.length) {
    add({ key: "terms-heading", node: <h2 className={styles.termsHeading} aria-level={level + 1}>Terms and conditions</h2>, space: 0, breakBefore: true, keepWithNext: true });
    sections.forEach((section, n) => {
      if (section.place === "terms") sectionPieces(section, `s${n}`, level + 2, add, tables);
    });
  }

  const numbers = (page: number, pages: number) => (template.page_numbers ? `Page ${page} of ${pages}` : null);
  // Each page is named "Page 2 of 3" (EstimateDocument), so its number isn't read again; the running header
  // and the footer repeat on every page, so they're read once: the footer on the last page, the header never.
  const once = (page: number, pages: number) => (page === pages ? undefined : true);
  return {
    label: data.number ? `${kind} ${data.number}` : kind,
    vars,
    letterhead: own.header ? (
      <header className={styles.ownHeader}>
        <LetterheadImage picture={own.header} alt={company.name} />
      </header>
    ) : (
      <Letterhead template={template} company={company} />
    ),
    running: (
      <header className={styles.running} aria-hidden="true">
        <span>
          {company.name} · {kind}
          {data.number != null ? ` No. ${data.number}` : ""}
        </span>
        <span>continued</span>
      </header>
    ),
    footer: (page, pages) =>
      own.footer ? (
        <footer className={cx(styles.footer, styles.ownFooter)} aria-hidden={once(page, pages)}>
          {template.page_numbers && <span className={styles.ownPages} aria-hidden="true">{numbers(page, pages)}</span>}
          <LetterheadImage picture={own.footer} alt="" />
        </footer>
      ) : words || template.page_numbers ? (
        <footer className={styles.footer} aria-hidden={once(page, pages)}>
          <span>{words}</span>
          {template.page_numbers && <PageNumber text={numbers(page, pages)!} />}
        </footer>
      ) : null,
    pieces,
    tables,
  };
}

/** The widest "Page 2 of 3" a document could have. */
const WIDEST_PAGE_NUMBER = "Page 888 of 888";

/**
 * "Page 2 of 3" beside the footer's words, in a box as wide as the widest number could be, so the
 * words wrap the same on every page as they did when the footer was measured (as "Page 1 of 1").
 */
function PageNumber({ text }: { text: string }) {
  return (
    <span className={styles.pageNumber} aria-hidden="true">
      <span>{text}</span>
      <span className={styles.pageNumberRoom}>{WIDEST_PAGE_NUMBER}</span>
    </span>
  );
}

type ContractRowBlock = Extract<ContractBlock, { kind: "row" }>;

/**
 * A contract section's title (a heading of `level`), its body a paragraph (list item, row...) at a
 * time, and the box for the customer's initials.
 */
function sectionPieces(section: DocumentSection, id: string, level: number, add: (piece: Piece) => void, tables: Record<string, PieceTable>) {
  const blocks = contractBlocks(section.html);
  const title = section.title.trim();
  const own: Piece[] = [];
  const push = (piece: Piece) => {
    own.push(piece);
    add(piece);
  };
  /** The space above the next block: a section's own space when it's the first, a little under the title, else a paragraph's. */
  const gap = () => (!own.length ? TITLE_GAP : title && own.length === 1 ? 6 : CLAUSE_GAP);
  if (title) push({ key: `${id}-title`, node: <h3 className={styles.sectionTitle} aria-level={level}>{title}</h3>, space: TITLE_GAP, keepWithNext: blocks.length > 0 || section.initials });

  for (let n = 0; n < blocks.length; n++) {
    const b = blocks[n]!;
    const prev = blocks[n - 1];
    const key = `${id}-${n}`;
    if (b.kind === "row") {
      // The whole table at once: its head rows, then each row of its body.
      const rows: ContractRowBlock[] = [];
      while (n < blocks.length && blocks[n]!.kind === "row" && (blocks[n] as ContractRowBlock).table === b.table) rows.push(blocks[n++] as ContractRowBlock);
      n--;
      const table = `${id}-t${b.table}`;
      const headRows = rows.filter((r) => r.head);
      const head = headRows.length ? <>{headRows.map((r, i) => <ContractRow key={i} row={r} />)}</> : null;
      tables[table] = {
        className: styles.clauseTable,
        cols: (
          <colgroup>
            {Array.from({ length: b.columns }, (_, i) => (
              <col key={i} style={{ width: `${100 / b.columns}%` }} />
            ))}
          </colgroup>
        ),
        head,
        headKey: head ? `${table}-head` : null,
      };
      const space = gap();
      if (head) push({ key: `${table}-head`, node: head, table, head: true, space, keepWithNext: true });
      rows
        .filter((r) => !r.head)
        .forEach((r, i) => push({ key: `${table}-${i}`, node: <ContractRow row={r} />, part: (cut) => <ContractRow row={r} cut={cut} />, table, space: i === 0 && !head ? space : 0, whole: true }));
      continue;
    }
    if (b.kind === "h3" || b.kind === "h4") {
      const space = gap();
      push({ key, node: <h4 className={styles.clauseHeading} aria-level={title ? level + 1 : level} dangerouslySetInnerHTML={{ __html: b.html }} />, space: space === CLAUSE_GAP ? 12 : space, keepWithNext: true });
    } else if (b.kind === "hr") push({ key, node: <hr className={styles.clauseRule} />, space: 10 });
    else if (b.kind === "li") {
      // One item at a time, numbered on from the item before; a part carried on to another page has no number of its own.
      const list = (item: ReactNode) => (b.list === "ol" ? <ol className={styles.clauseList} start={b.number}>{item}</ol> : <ul className={styles.clauseList}>{item}</ul>);
      push({
        key,
        node: list(<li data-split="" dangerouslySetInnerHTML={{ __html: b.html }} />),
        part: ({ words: [words], carried }) => list(<li data-carried={flag(carried)} dangerouslySetInnerHTML={{ __html: words?.html ?? "" }} />),
        space: prev?.kind === "li" && b.number > 1 ? ITEM_GAP : gap(),
      });
    } else if (b.kind === "quote") {
      push({
        key,
        node: <blockquote className={styles.clauseQuote} data-split="" dangerouslySetInnerHTML={{ __html: b.html }} />,
        part: ({ words: [words], carried, carries }) => <blockquote className={styles.clauseQuote} data-carried={flag(carried)} data-carries={flag(carries)} dangerouslySetInnerHTML={{ __html: words?.html ?? "" }} />,
        space: prev?.kind === "quote" && prev.quote === b.quote ? 0 : gap(),
      });
    } else {
      const className = cx(styles.clause, b.kind === "text" && styles.plain);
      push({
        key,
        node: <div className={className} data-split="" dangerouslySetInnerHTML={{ __html: b.html }} />,
        part: ({ words: [words] }) => <div className={className} dangerouslySetInnerHTML={{ __html: words?.html ?? "" }} />,
        space: gap(),
      });
    }
  }

  if (section.initials) {
    // The initials stay with the end of what they're for.
    if (own.length) own[own.length - 1]!.keepWithNext = true;
    add({ key: `${id}-initials`, node: <Initials section={section} />, space: own.length ? CLAUSE_GAP : TITLE_GAP });
  }
}

/** A row of a contract's table: each cell's words, or (`cut`) the part of each on this page. */
function ContractRow({ row, cut }: { row: ContractRowBlock; cut?: PaperPart }) {
  return (
    <tr data-carried={flag(cut?.carried)} data-carries={flag(cut?.carries)}>
      {row.cells.map((cell, i) => {
        const Cell = cell.tag;
        return <Cell key={i} colSpan={cell.colSpan > 1 ? cell.colSpan : undefined} data-split={cut ? undefined : ""} dangerouslySetInnerHTML={{ __html: cut ? cut.words[i]?.html ?? "" : cell.html }} />;
      })}
    </tr>
  );
}

const PNG = /^data:image\/png;base64,/;

/** The customer's initials on a section, or the box they go in. */
function Initials({ section }: { section: DocumentSection }) {
  const done = section.initialed && PNG.test(section.initialed.image) ? section.initialed : null;
  return (
    <div className={styles.initials}>
      <span>
        Initials
        {done?.date ? ` · ${shortDate(done.date)}` : ""}
      </span>
      <span className={styles.initialsBox}>{done && <img className={styles.initialsImage} src={done.image} alt="Initials" />}</span>
    </div>
  );
}

function Parties({ data, level }: { data: DocumentData; level: number }) {
  const estimate = data.kind === "estimate";
  return (
    <div className={styles.parties}>
      <div>
        <div className={styles.eyebrow}>{estimate ? "Prepared for" : "Bill to"}</div>
        <div className={styles.clientName}>{data.client.name || " "}</div>
        {data.client.lines.length > 0 && <div className={styles.clientLines}>{data.client.lines.map((line, i) => <div key={i}>{line}</div>)}</div>}
      </div>
      <div className={styles.heading}>
        <div className={styles.kind} role="heading" aria-level={level}>{estimate ? "Estimate" : "Invoice"}</div>
        <div className={styles.meta}>
          {data.number != null && <div>No. {data.number}</div>}
          {data.date && <div>{longDate(data.date)}</div>}
          {estimate && data.validUntil && <div>Good until {longDate(data.validUntil)}</div>}
          {!estimate && data.dueOn && <div>Due {longDate(data.dueOn)}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * A line of the estimate. One too tall for a page (a long scope of work) is cut between the lines
 * of its words (`cut`): the amounts print with its first part, and the parts carried on have none.
 */
function LineRow({ line, cut }: { line: DocumentLine; cut?: PaperPart }) {
  const [name, description] = cut ? cut.words.map((w, i) => wordsOf(i ? line.description ?? "" : line.name, w)) : [line.name, line.description];
  return (
    <tr data-carried={flag(cut?.carried)} data-carries={flag(cut?.carries)} data-mark={line.mark}>
      <td>
        {(!cut || name) && <span data-split={flag(!cut)}>{name}</span>}
        {description && <span className={styles.lineDescription} data-split={flag(!cut)}>{description}</span>}
      </td>
      {cut?.carried ? (
        <>
          <td />
          <td />
          <td />
        </>
      ) : (
        <>
          <td className={cx(styles.num, styles.qty, styles.muted)}>{quantityLabel(line.quantity, line.unit)}</td>
          <td className={cx(styles.num, styles.muted)}>{formatMoneyCents(line.unit_price)}</td>
          <td className={cx(styles.num, styles.amount)}>{formatMoneyCents(line.total)}</td>
        </>
      )}
    </tr>
  );
}

/** A package's look when it has no picture: its roofing material's color and lines (as on the Packages page). */
const OPTION_ART: Record<string, string> = {
  shingle: "repeating-linear-gradient(0deg, #4a555d 0 2px, transparent 2px 10px) #5b6770",
  designer: "repeating-linear-gradient(0deg, #5c4a3d 0 2px, transparent 2px 12px) #6e5a4b",
  metal: "repeating-linear-gradient(90deg, #5f7889 0 2px, transparent 2px 12px) #3f5566",
  other: "repeating-linear-gradient(45deg, #5a676d 0 2px, transparent 2px 10px) #66747a",
};

/**
 * "Your options": each option the estimate offers, side by side, to compare. Its highlights and
 * warranty are cut short at a few lines each, so three options written to the most the packages
 * allow still fit on one page: it moves to the next whole, never cut through a line.
 */
function Options({ options }: { options: DocumentOption[] }) {
  return (
    <div className={styles.options}>
      <div className={styles.eyebrow}>Your options</div>
      <div className={styles.optionGrid} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <div key={o.id} className={styles.option} data-chosen={o.chosen || undefined}>
            {o.picture ? (
              <img className={styles.optionPicture} src={o.picture.src} width={o.picture.width} height={o.picture.height} alt="" />
            ) : (
              <span className={styles.optionPicture} style={{ background: OPTION_ART[o.style] ?? OPTION_ART.other }} aria-hidden="true" />
            )}
            <div className={styles.optionText}>
              {o.tier && <span className={styles.tier}>{o.tier}</span>}
              <strong className={styles.optionName}>{o.name}</strong>
              {o.highlights.length > 0 && (
                <ul className={styles.optionHighlights}>
                  {o.highlights.map((h, i) => (
                    <li key={i}>
                      <span className={styles.clamp}>{h}</span>
                    </li>
                  ))}
                </ul>
              )}
              {o.warranty.trim() && <div className={cx(styles.optionWarranty, styles.clamp)}>{o.warranty.trim()}</div>}
              {o.total != null && <div className={styles.optionPrice}>{formatMoneyCents(o.total)}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------------------------

type LaidPage = DocumentLayout[number];
type LaidFragment = LaidPage["fragments"][number];

/** Everything on one page: what there is before the pages are measured (on the server, in tests). */
const onePage = (pieces: readonly Piece[]): LaidPage => ({ fragments: pieces.map((p) => ({ key: p.key, offset: 0, height: 0 })), repeatHead: null, pinFrom: null });

/** Whether a layout is of these blocks: every one on a page, and nothing else. */
function fits(layout: DocumentLayout | null | undefined, pieces: readonly Piece[]): layout is DocumentLayout {
  if (!layout?.length) return false;
  const keys = new Set(pieces.map((p) => p.key));
  const placed = new Set<string>();
  for (const page of layout) for (const f of page.fragments) placed.add(f.key);
  return placed.size === keys.size && [...placed].every((k) => keys.has(k));
}

/**
 * A document's blocks in order (what the fragments of its layout name), with how each goes on the
 * pages: everything but its height, which only the browser can measure.
 */
export function documentBlocks(template: TemplateSettings, company: DocumentCompany, data: DocumentData) {
  return paperOf(template, company, data).pieces.map((p) => ({
    key: p.key,
    space: p.space,
    keepWithNext: Boolean(p.keepWithNext),
    breakBefore: Boolean(p.breakBefore),
    pinBottom: Boolean(p.pinBottom),
    /** Can be cut between its lines (only when taller than a page, for a `whole` one). */
    cuts: Boolean(p.part),
    whole: Boolean(p.whole),
    table: p.table ?? null,
    head: Boolean(p.head),
  }));
}

/**
 * The pages of an estimate or invoice, each 816 × 1056 px, one under the other. `layout` (from
 * DocumentSheet or PrintableDocument, which measure it) says what goes on each; without one,
 * everything is on one page.
 */
export function EstimateDocument({ template, company, data, className, layout, firstPageOnly = false, headingLevel = 2 }: EstimateDocumentProps) {
  const paper = paperOf(template, company, data, headingLevel);
  const pages = fits(layout, paper.pieces) ? layout : [onePage(paper.pieces)];
  return (
    <article className={cx(styles.doc, className)} style={paper.vars} aria-label={paper.label}>
      {(firstPageOnly ? pages.slice(0, 1) : pages).map((page, i) => (
        <section key={i} className={styles.page} data-page={i + 1} role="group" aria-label={`Page ${i + 1} of ${pages.length}`}>
          <div className={styles.box}>
            {i === 0 ? paper.letterhead : paper.running}
            <div className={styles.body}>{pageBody(paper, page)}</div>
            {paper.footer(i + 1, pages.length)}
          </div>
        </section>
      ))}
    </article>
  );
}

/**
 * The last resort for part of a block that can't be cut between lines (nothing in it is words that
 * may be, or one line is taller than a page): the block drawn through a window that height, moved
 * up to its offset. Every part holds all of the block's words, so only the first is read aloud.
 */
function Clip({ fragment, children }: { fragment: LaidFragment; children: ReactNode }) {
  return (
    <div className={styles.clip} style={{ height: fragment.height }} aria-hidden={fragment.offset > 0 || undefined}>
      <div className={styles.shift} style={fragment.offset ? { marginTop: -fragment.offset } : undefined}>
        {children}
      </div>
    </div>
  );
}

/** A block on a page: all of it, or the part of it a fragment is, with only that part's words. */
function drawn(piece: Piece, fragment: LaidFragment): ReactNode {
  if (!fragment.part) return piece.node;
  if (fragment.cut && piece.part) return piece.part(fragment.cut);
  return <Clip fragment={fragment}>{piece.node}</Clip>;
}

/** The body of one page: its blocks in the wrappers they were measured in, with their space above as margin. */
function pageBody(paper: Paper, page: LaidPage): ReactNode[] {
  const byKey = new Map(paper.pieces.map((p) => [p.key, p]));
  const out: ReactNode[] = [];
  const frags = page.fragments;
  for (let i = 0; i < frags.length; ) {
    const piece = byKey.get(frags[i]!.key)!;
    const style: CSSProperties | undefined = i === 0 ? undefined : i === page.pinFrom ? { marginTop: "auto" } : piece.space ? { marginTop: piece.space } : undefined;
    if (piece.table) {
      // The table's rows on this page, under its head.
      let j = i + 1;
      while (j < frags.length && j !== page.pinFrom && byKey.get(frags[j]!.key)!.table === piece.table) j++;
      out.push(
        <div key={`${i}-${piece.key}`} className={styles.block} style={style}>
          <TableRun table={paper.tables[piece.table]!} items={frags.slice(i, j).map((f) => [f, byKey.get(f.key)!])} repeat={i === 0 && page.repeatHead === piece.table} />
        </div>,
      );
      i = j;
      continue;
    }
    out.push(
      <div key={`${i}-${piece.key}`} className={styles.block} style={style}>
        {drawn(piece, frags[i]!)}
      </div>,
    );
    i++;
  }
  return out;
}

/** A table's head and rows on one page (a row that can't be cut between lines, cut anyway, in a window of its own). */
function TableRun({ table, items, repeat }: { table: PieceTable; items: Array<[LaidFragment, Piece]>; repeat: boolean }) {
  const parts: ReactNode[] = [];
  let head: ReactNode = repeat ? table.head : null;
  let rows: ReactNode[] = [];
  const close = () => {
    if (head || rows.length) {
      parts.push(
        <table key={parts.length} className={table.className}>
          {table.cols}
          {head && <thead>{head}</thead>}
          {rows.length > 0 && <tbody>{rows}</tbody>}
        </table>,
      );
    }
    head = null;
    rows = [];
  };
  for (const [frag, piece] of items) {
    if (piece.head) head = piece.node;
    else if (frag.part && !(frag.cut && piece.part)) {
      close();
      parts.push(
        <Clip key={parts.length} fragment={frag}>
          <table className={table.className}>
            {table.cols}
            <tbody>{piece.node}</tbody>
          </table>
        </Clip>,
      );
    } else rows.push(<Fragment key={piece.key}>{drawn(piece, frag)}</Fragment>);
  }
  close();
  return <>{parts}</>;
}

/**
 * A picture of the business's own letterhead, across the page. Its size is known before it loads,
 * so the page is laid out right away.
 */
function LetterheadImage({ picture, alt }: { picture: LetterheadPicture; alt: string }) {
  return <img className={styles.ownImage} src={letterheadSrc(picture.path)} width={picture.width} height={picture.height} alt={alt} />;
}

/** The business's name, logo and details, in the template's header style. */
function Letterhead({ template, company }: { template: TemplateSettings; company: DocumentCompany }) {
  const tagline = template.tagline.trim();
  const license = template.show_license && template.license.trim() ? licenseLine(template.license) : null;
  const insurer = template.show_insurer && template.insurer.trim() ? `Insured by ${template.insurer.trim()}` : null;
  const website = websiteLabel(company.website);
  const contact = [company.phone, company.email].filter(Boolean).join(" · ");
  const name = (
    <div>
      <div className={styles.name}>{company.name}</div>
      {tagline && <div className={styles.tagline}>{tagline}</div>}
    </div>
  );

  if (template.header === "centered") {
    const line = [company.address.join(", "), company.phone, company.email, website].filter(Boolean).join(" · ");
    return (
      <header className={styles.centered}>
        <Mark company={company} />
        <div className={styles.name}>{company.name}</div>
        {tagline && <div className={styles.tagline}>{tagline}</div>}
        {line && <div className={styles.detailsLine}>{line}</div>}
        {(license || insurer) && (
          <div className={styles.detailsLine} style={{ paddingTop: 0 }}>
            {license && <span className={styles.license}>{license}</span>}
            {license && insurer && " · "}
            {insurer}
          </div>
        )}
        <span className={styles.bar} aria-hidden="true" />
      </header>
    );
  }

  const details = (
    <div className={styles.details}>
      {company.address.map((line, i) => <div key={i}>{line}</div>)}
      {contact && <div>{contact}</div>}
      {website && <div>{website}</div>}
      {license && <div className={styles.license}>{license}</div>}
      {insurer && <div>{insurer}</div>}
    </div>
  );
  if (template.header === "banner") {
    return (
      <header className={styles.banner}>
        <div className={styles.brand}>
          <span className={styles.tile}>{company.logo ? <img className={styles.logo} src={company.logo} alt={company.name} /> : <span className={styles.tileInitials} aria-hidden="true">{initials(company.name)}</span>}</span>
          {name}
        </div>
        {details}
      </header>
    );
  }
  return (
    <header className={styles.classic}>
      <div className={styles.brand}>
        <Mark company={company} />
        {name}
      </div>
      {details}
    </header>
  );
}

/** The logo (in a box of its own height, so the page doesn't move when it loads), or the business's initials on its color. */
function Mark({ company }: { company: DocumentCompany }) {
  return company.logo ? (
    <span className={styles.logoBox}>
      <img className={styles.logo} src={company.logo} alt={company.name} />
    </span>
  ) : (
    <span className={styles.monogram} aria-hidden="true">{initials(company.name)}</span>
  );
}

function Totals({ data }: { data: DocumentData }) {
  const estimate = data.kind === "estimate";
  return (
    <dl className={styles.totals}>
      <dt>Subtotal</dt>
      <dd>{formatMoneyCents(data.subtotal)}</dd>
      {data.discount > 0 && (
        <>
          <dt>{data.discountLabel || "Discount"}</dt>
          <dd>−{formatMoneyCents(data.discount)}</dd>
        </>
      )}
      {data.credits?.map((c, i) => (
        <Fragment key={i}>
          <dt>{c.label}</dt>
          <dd>−{formatMoneyCents(c.amount)}</dd>
        </Fragment>
      ))}
      {data.tax > 0 && (
        <>
          <dt>Tax</dt>
          <dd>{formatMoneyCents(data.tax)}</dd>
        </>
      )}
      <dt className={styles.grand}>Total</dt>
      <dd className={styles.grand}>{formatMoneyCents(data.total)}</dd>
      {estimate && Number(data.deposit) > 0 && (
        <>
          <dt>Deposit to get on the schedule</dt>
          <dd>{formatMoneyCents(data.deposit)}</dd>
        </>
      )}
      {!estimate &&
        data.payments?.map((p, i) => (
          <PaymentRow key={i} label={p.label} amount={p.amount} />
        ))}
      {!estimate && data.balanceDue != null && (
        <>
          <dt className={styles.grand}>Balance due</dt>
          <dd className={styles.grand}>{formatMoneyCents(data.balanceDue)}</dd>
        </>
      )}
    </dl>
  );
}

function PaymentRow({ label, amount }: { label: string; amount: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{amount >= 0 ? `−${formatMoneyCents(amount)}` : `+${formatMoneyCents(-amount)}`}</dd>
    </>
  );
}

/** Whether there's any signature line to draw. */
const signsAnything = (template: TemplateSettings, signatures: DocumentData["signatures"]) =>
  template.customer_signs || template.company_signs || Boolean(signatures?.customer?.image) || Boolean(signatures?.company?.image);

/**
 * The signature lines the template asks for. A line someone already signed shows even if the
 * template no longer asks for it: a signature is never left off the copy.
 */
function Signatures({ template, company, signatures }: { template: TemplateSettings; company: DocumentCompany; signatures: DocumentData["signatures"] }) {
  const customer = signatures?.customer ?? null;
  const business = signatures?.company ?? null;
  const showCustomer = template.customer_signs || Boolean(customer?.image);
  const showCompany = template.company_signs || Boolean(business?.image);
  if (!showCustomer && !showCompany) return null;
  return (
    <div className={styles.signatures}>
      {showCustomer && <SignatureLine label={template.customer_label.trim() || "Customer"} signature={customer} dates={template.sign_dates} />}
      {showCompany && <SignatureLine label={companySignatureLabel(template, company.name)} signature={business} dates={template.sign_dates} />}
    </div>
  );
}

function SignatureLine({ label, signature, dates }: { label: string; signature: DocumentSignature | null; dates: boolean }) {
  return (
    <div className={styles.sign}>
      <div className={styles.signLine}>
        {signature?.image && <img className={styles.signImage} src={signature.image} alt={signature.name ? `Signature of ${signature.name}` : "Signature"} />}
        {dates && signature?.image && signature.date && <span className={styles.signDate}>{shortDate(signature.date)}</span>}
      </div>
      <div className={styles.signUnder}>
        <span>{label}</span>
        {dates && <span>Date</span>}
      </div>
      {/* Its room is always kept, so typing a name doesn't move the page. */}
      <div className={styles.printed}>{signature?.name ?? ""}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Measuring the pages
// ---------------------------------------------------------------------------------------------

/** What a measurement of the hidden copy found: the blocks with their heights, the room on a page, and each block's element. */
interface Measured {
  blocks: PaperBlock[];
  space: ReturnType<typeof paperSpace>;
  elements: Map<string, HTMLElement>;
  signature: string;
}

function measurePaper(root: HTMLElement, paper: Paper): Measured | null {
  const round = (n: number) => Math.round(n * 100) / 100;
  const heights = new Map<string, number>();
  const elements = new Map<string, HTMLElement>();
  // A table's rows are measured in one table, each from its top to the next one's, so they add up to the table.
  for (const table of Array.from(root.querySelectorAll<HTMLElement>("table[data-table]"))) {
    const parts = Array.from(table.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.block !== undefined);
    const tops = parts.map((p) => p.getBoundingClientRect().top);
    const bottom = table.getBoundingClientRect().bottom;
    parts.forEach((p, i) => {
      heights.set(p.dataset.block!, (tops[i + 1] ?? bottom) - tops[i]!);
      elements.set(p.dataset.block!, p);
    });
  }
  for (const block of Array.from(root.querySelectorAll<HTMLElement>("div[data-block]"))) {
    heights.set(block.dataset.block!, block.getBoundingClientRect().height);
    elements.set(block.dataset.block!, block);
  }
  const part = (name: string) => root.querySelector(`[data-part="${name}"]`)?.getBoundingClientRect().height ?? 0;
  const parts = { letterhead: part("letterhead"), running: part("running"), footer: part("footer") };
  // Nothing laid out (hidden while printing, say): not a measurement.
  if (![...heights.values(), parts.letterhead, parts.running].some((h) => h > 0)) return null;

  const headOf = (table: string) => {
    const key = paper.tables[table]?.headKey;
    return key ? heights.get(key) ?? 0 : 0;
  };
  const blocks = paper.pieces.map((p): PaperBlock => {
    const height = heights.get(p.key) ?? 0;
    const el = elements.get(p.key);
    // Only blocks that may be cut, and are tall enough to be: their lines.
    const cuts = p.part && el && height > (p.whole ? 300 : 30) ? lineCuts(el) : [];
    return {
      key: p.key,
      height: round(height),
      spaceBefore: p.space,
      keepWithNext: p.keepWithNext,
      breakBefore: p.breakBefore,
      pinBottom: p.pinBottom,
      table: p.table && !p.head ? { id: p.table, head: round(headOf(p.table)) } : undefined,
      cuts: cuts.length ? cuts : undefined,
      whole: p.whole,
    };
  });
  const space = paperSpace({ letterhead: round(parts.letterhead), running: round(parts.running), footer: round(parts.footer) });
  return { blocks, space, elements, signature: JSON.stringify([blocks, space]) };
}

/**
 * The pages with the words of each part of a block cut between two of its lines, cut in the hidden
 * copy (paper.ts cutWords). A part that doesn't start and end at its block's top, bottom or a line
 * (a block with no line to cut at) is left to be drawn through a window.
 */
function withWords(layout: PaperLayout, found: Measured, paper: Paper): DocumentLayout {
  const blocks = new Map(found.blocks.map((b) => [b.key, b]));
  const cuttable = new Set(paper.pieces.filter((p) => p.part).map((p) => p.key));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
  return layout.map((page) => ({
    ...page,
    fragments: page.fragments.map((f) => {
      const block = blocks.get(f.key);
      const el = found.elements.get(f.key);
      if (!f.part || !block || !el || !cuttable.has(f.key)) return f;
      const top = f.offset > 0.05 ? f.offset : null;
      const bottom = f.offset + f.height < block.height - 0.05 ? f.offset + f.height : null;
      const atLine = (y: number | null) => y === null || Boolean(block.cuts?.some((c) => near(c, y)));
      if (!atLine(top) || !atLine(bottom)) return f;
      return { ...f, cut: { words: cutWords(el, top, bottom), carried: top !== null, carries: bottom !== null } };
    }),
  }));
}

/** The hidden copy that's measured: each block alone in the wrapper it's drawn in, at the body's width. */
function PaperMeasure({ paper, rootRef }: { paper: Paper; rootRef: RefObject<HTMLDivElement> }) {
  const groups: Array<Piece | { table: string; pieces: Piece[] }> = [];
  for (const piece of paper.pieces) {
    const last = groups[groups.length - 1];
    if (piece.table && last && "pieces" in last && last.table === piece.table) last.pieces.push(piece);
    else groups.push(piece.table ? { table: piece.table, pieces: [piece] } : piece);
  }
  return createPortal(
    <div ref={rootRef} className={cx(styles.doc, styles.measure)} style={paper.vars} aria-hidden="true" data-paper-measure="">
      <div className={styles.block} data-part="letterhead">{paper.letterhead}</div>
      <div className={styles.block} data-part="running">{paper.running}</div>
      <div className={styles.block} data-part="footer">{paper.footer(1, 1)}</div>
      <div className={styles.measureBody}>
        {groups.map((g) =>
          "pieces" in g ? (
            <div key={g.pieces[0]!.key} className={styles.block}>
              <table className={paper.tables[g.table]!.className} data-table={g.table}>
                {paper.tables[g.table]!.cols}
                {g.pieces.map((p) =>
                  p.head ? (
                    <thead key={p.key} data-block={p.key}>{p.node}</thead>
                  ) : (
                    <tbody key={p.key} data-block={p.key}>{p.node}</tbody>
                  ),
                )}
              </table>
            </div>
          ) : (
            <div key={g.key} className={styles.block} data-block={g.key}>{g.node}</div>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Lays a document out on pages in the browser: renders a hidden copy of its blocks (`measurer`,
 * which the caller puts on the page), measures them and paginates. It measures again when the
 * document changes, when its lettering or a picture loads, and when the copy changes size; and only
 * sets the pages when they changed. `settled` says the pages are final: measured after the fonts
 * and every picture loaded (or failed), with no measuring waiting.
 */
function usePaper(template: TemplateSettings, company: DocumentCompany, data: DocumentData) {
  // Screens build the document on every render, so it's measured by what's in it, not by which object it is.
  const content = JSON.stringify([template, company, data]);
  const paper = useMemo(() => paperOf(template, company, data), [content]);
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ paper, content });
  latest.current = { paper, content };
  const measured = useRef<{ signature: string; layout: DocumentLayout } | null>(null);
  const fontsLoaded = useRef(false);
  const [state, setState] = useState<{ layout: DocumentLayout | null; settled: boolean }>({ layout: null, settled: false });

  const measure = useCallback(() => {
    const el = root.current;
    if (!el) return;
    const { paper, content } = latest.current;
    const found = measurePaper(el, paper);
    if (!found) return;
    // The same words measured the same: the same pages (and the same parts of any block cut between them).
    const signature = content + found.signature;
    if (measured.current?.signature !== signature) measured.current = { signature, layout: withWords(paginate(found.blocks, found.space), found, paper) };
    const layout = measured.current.layout;
    const settled = fontsLoaded.current && Array.from(el.querySelectorAll("img")).every((img) => img.complete);
    setState((s) => (s.layout === layout && s.settled === settled ? s : { layout, settled }));
  }, []);

  useIsoLayoutEffect(measure, [content, measure]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    let alive = true;
    // Batched to one measuring a frame, done before anything else runs (a print waiting on it, say).
    const later = () => {
      if (frame) return;
      setState((s) => (s.settled ? { ...s, settled: false } : s));
      frame = requestAnimationFrame(() => {
        frame = 0;
        flushSync(measure);
      });
    };
    el.addEventListener("load", later, true);
    el.addEventListener("error", later, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    observer?.observe(el);
    const fonts = document.fonts as FontFaceSet | undefined;
    fonts?.addEventListener?.("loadingdone", later);
    void (fonts?.ready ?? Promise.resolve()).then(() => {
      if (!alive) return;
      fontsLoaded.current = true;
      later();
    });
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      el.removeEventListener("load", later, true);
      el.removeEventListener("error", later, true);
      observer?.disconnect();
      fonts?.removeEventListener?.("loadingdone", later);
    };
  }, [measure]);

  return { layout: state.layout, settled: state.settled, measurer: typeof document === "undefined" ? null : <PaperMeasure paper={paper} rootRef={root} /> };
}

// ---------------------------------------------------------------------------------------------
// On screen
// ---------------------------------------------------------------------------------------------

export type DocumentSheetProps = Omit<EstimateDocumentProps, "layout"> & {
  /** Told how many pages the document has, whenever that changes. */
  onPages?: (pages: number) => void;
};

/**
 * The pages as sheets of paper, one under the other, scaled down to fit their column (never up).
 * `firstPageOnly` shows just the first, for a thumbnail.
 */
export function DocumentSheet({ className, template, company, data, firstPageOnly = false, headingLevel, onPages }: DocumentSheetProps) {
  const outer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const paper = usePaper(template, company, data);

  useIsoLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const fit = () => setWidth(el.clientWidth);
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pages = paper.layout?.length ?? 1;
  useEffect(() => {
    onPages?.(pages);
  }, [pages, onPages]);
  // Scaled as a picture is (not re-laid out smaller), so the words wrap exactly as they were measured.
  const scale = width > 0 ? Math.min(1, Math.max(0.2, width / PAGE_WIDTH)) : 1;
  const height = stackHeight(firstPageOnly ? 1 : pages);
  return (
    <div ref={outer} className={cx(styles.sheet, className)} data-pages={pages}>
      <div className={styles.frame} style={{ width: PAGE_WIDTH * scale, height: height * scale }}>
        <div className={styles.stack} style={{ transform: `scale(${scale})` }}>
          <EstimateDocument template={template} company={company} data={data} layout={paper.layout} firstPageOnly={firstPageOnly} headingLevel={headingLevel} />
        </div>
      </div>
      {paper.measurer}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// In print
// ---------------------------------------------------------------------------------------------

export type PrintableDocumentProps = Pick<EstimateDocumentProps, "template" | "company" | "data" | "className">;

/**
 * The document, hidden on screen, and the only thing on the page when this screen prints (the
 * browser's Print, or Save as PDF): the same pages as on screen, each on its own sheet of letter
 * paper inside 0.4 in margins. While it's mounted, printing anything on the screen prints the
 * document instead. Safari (so the iPad) prints inside its own margins as well as the @page one,
 * so there the @page margin is thin and each page is printed a little smaller
 * (WEBKIT_PRINT_SCALE), centered: the same pages, the same breaks.
 *
 * Marked `data-paginated` once its pages are final (usePaper's settled); printDocument waits for it.
 */
export function PrintableDocument({ template, company, data, className }: PrintableDocumentProps) {
  const paper = usePaper(template, company, data);
  const [webkit] = useState(isWebKit);
  if (typeof document === "undefined") return null;
  return (
    <>
      {createPortal(
        <div
          className={styles.printRoot}
          data-printable-document=""
          data-paginated={paper.settled ? "" : undefined}
          data-webkit={webkit ? "" : undefined}
          style={webkit ? ({ "--print-scale": WEBKIT_PRINT_SCALE } as CSSProperties) : undefined}
        >
          {/* Only while it's mounted: letter paper, and nothing else on the printed page. */}
          <style>{`@page { size: letter; margin: ${webkit ? WEBKIT_PAGE_MARGIN : "0.4in"}; }
@media print {
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
  body > :not(.${styles.printRoot}) { display: none !important; }
}`}</style>
          <EstimateDocument template={template} company={company} data={data} layout={paper.layout} className={className} />
        </div>,
        document.body,
      )}
      {paper.measurer}
    </>
  );
}

/**
 * Prints the PrintableDocument on this screen once its lettering and pictures (the logo and the
 * signatures) have loaded and its pages are laid out with them, so the copy is never missing any.
 * Gives up waiting after a few seconds.
 */
export async function printDocument(waitMs = 4000): Promise<void> {
  const images = Array.from(document.querySelectorAll<HTMLImageElement>("[data-printable-document] img, [data-paper-measure] img"));
  const loaded = images.map((img) =>
    img.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
  );
  await Promise.race([Promise.all([document.fonts?.ready, ...loaded]), new Promise((resolve) => setTimeout(resolve, waitMs))]);
  await nextFrames(2);
  await paperSettled();
  window.print();
}
