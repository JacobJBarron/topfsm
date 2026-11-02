/**
 * Estimates that offer two or three options (quote_options, supabase/migrations/
 * 20261025000100_contracts_and_options.sql): each option a copy of the package it came from (its
 * name, tier, picture, highlights, warranty and contract sections) with lines of its own. The lines
 * are worked out here from the packages (roofPackages.ts packageLines) and everything is checked
 * before anything is written; then one locked database step puts them on the quote
 * (apply_quote_options). Also: filling in options offered before the roof was measured, taking an
 * option off (remove_quote_option) and copying a quote with its options (duplicate_quote). A
 * cheaper option can lower what the deposit may be (sales.ts keepDepositInCap). Renaming an option,
 * changing its tier or words, and showing another one first are plain writes from the browser.
 * Routes: routes/packages.ts.
 */
import { isSiteAdjustment, siteAdjustmentLines } from "@crewtavo/core/estimates";
import { optionBaseTotal, optionTierLabels, optionTierOrder, quoteTotals, toCents, type OptionLine } from "@crewtavo/core/money";
import { asJson, dbError, HttpError, must } from "../lib/http";
import type { Db } from "../lib/supabase";
import { measurementVariables } from "./measurements";
import {
  companyTrade,
  EDITABLE,
  isRoofWork,
  loadPackages,
  lockedMessage,
  measureFirst,
  pricedLines,
  putQuotePackage,
  quoteMeasurement,
  saveFollowedPrices,
  showMeasurement,
  type PackageLine,
  type PricedPackage,
} from "./roofPackages";
import { keepDepositInCap } from "./sales";

/** One option on a quote, as the options bar and the Client Hub read it. */
export interface QuoteOption {
  id: string;
  package_id: string | null;
  name: string;
  tier: string | null;
  /** The package's picture when it was offered (<company>/packages/<uuid>.jpg), else its drawing (`style`). */
  picture: string | null;
  picture_width: number | null;
  picture_height: number | null;
  style: string;
  highlights: string[];
  warranty: string;
  section_ids: string[];
  sort: number;
}

/** A package's line left off an option, and why (nothing of it on this job, or a formula that can't be worked out). */
export interface SkippedLine {
  package: string;
  name: string;
  reason: string;
}

export interface OptionsResult {
  options: QuoteOption[];
  skipped: SkippedLine[];
  /**
   * The deposit asked for, when the options brought it down: it was more than the cheapest option's
   * price (sales.ts keepDepositInCap). Left out when it didn't change.
   */
  deposit_amount?: number;
}

/** The deposit, when a cheaper option or package brought it down (OptionsResult.deposit_amount). */
async function depositAfter(db: Db, companyId: string, quoteId: string) {
  const lowered = await keepDepositInCap(db, companyId, quoteId);
  return lowered === null ? {} : { deposit_amount: lowered };
}

const QUOTE_FIELDS =
  "id, status, option_id, roof_package_id, promo_code_id, tax_rate, discount_amount, priced_on_site_at, range_accepted_at, promo:promo_codes(kind, value), lines:quote_line_items(id, option_id, name, service_id, formula, quantity, unit_price, taxable, optional, selected, sort), options:quote_options!quote_options_quote_fkey(id, name, tier, sort, package_id)";

const QUOTE_NOT_FOUND = "That estimate wasn't found.";
const CHANGED = "Lines were added to this estimate meanwhile. Look it over, then add the package again.";

/** The quote, while its options can still change. */
async function openQuote(db: Db, companyId: string, quoteId: string) {
  const quote = must(await db.from("quotes").select(QUOTE_FIELDS).eq("id", quoteId).eq("company_id", companyId).maybeSingle(), QUOTE_NOT_FOUND);
  if (!EDITABLE.includes(quote.status)) throw new HttpError(409, lockedMessage(quote.status));
  return { ...quote, options: [...quote.options].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id)) };
}

/** What the database functions return: the quote's options, in order. */
const toOptions = (data: unknown): QuoteOption[] =>
  ((data ?? []) as QuoteOption[]).map((o) => ({
    id: o.id,
    package_id: o.package_id,
    name: o.name,
    tier: o.tier,
    picture: o.picture,
    picture_width: o.picture_width,
    picture_height: o.picture_height,
    style: o.style,
    highlights: o.highlights,
    warranty: o.warranty,
    section_ids: o.section_ids,
    sort: o.sort,
  }));

/** A package's lines as apply_quote_options takes them, numbered after the quote's own lines. */
const optionLines = (lines: readonly PackageLine[], after: number) =>
  lines.map((l) => ({ service_id: l.service_id, name: l.name, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, unit_cost: l.unit_cost, taxable: l.taxable, formula: l.formula, sort: after + l.sort }));

const skippedOf = (p: PricedPackage, skipped: ReadonlyArray<{ name: string; reason: string }>): SkippedLine[] => skipped.map((s) => ({ package: p.pkg.name, ...s }));

/** The estimate's own lines while it becomes option 1, for pricing the options against each other. */
const CURRENT = "current";

type Priced = { id: string; tier: string | null; total: number | null };

/**
 * The tier word of each option: its own, and for those without one Good, Better and Best by price,
 * cheapest first, when none has a word of its own or those that do carry exactly those words in that
 * order (else none, as core optionTierLabels has it, so the words never run against the prices).
 * Not while an option has no price yet: Roofing names them once the roof is measured (fillOptions).
 */
function tierWords(options: readonly Priced[]): Map<string, string> {
  const named = new Map(options.flatMap((o) => (o.tier?.trim() ? [[o.id, o.tier.trim()] as const] : [])));
  if (options.some((o) => o.total === null)) return named;
  const ranked = optionTierLabels(options.map((o) => ({ ...o, tier: null })));
  return [...named].every(([id, tier]) => ranked.get(id) === tier) ? new Map([...ranked, ...named]) : named;
}

/**
 * Offer packages on an estimate (POST /quotes/:id/options). One package on an estimate with no
 * lines and no options is the classic single-package estimate: its lines go on the quote, shared.
 * Otherwise each package becomes an option with its own lines. Adding to an estimate that has lines
 * and no options first makes the estimate as it is option 1 (keeping `shared_line_ids` on every
 * option). New options are ordered by their price before add-ons and named Good, Better and Best
 * when their packages have no tier of their own. `replace` starts over from the packages: every
 * option, line and price set before goes. A roof's options can be offered before it's measured:
 * their lines come once it is (fillOptions).
 */
export async function addOptions(
  db: Db,
  companyId: string,
  quoteId: string,
  body: { package_ids: readonly string[]; replace: boolean; shared_line_ids: readonly string[] },
): Promise<OptionsResult> {
  if (!body.package_ids.length) throw new HttpError(400, "Pick at least one package to offer.");
  const quote = await openQuote(db, companyId, quoteId);
  const existing = body.replace ? [] : quote.options;
  const lines = body.replace ? [] : quote.lines;
  const convert = !existing.length && lines.length > 0;
  // A package that's already on the estimate isn't offered twice: an option's, and the estimate's own
  // package as it becomes option 1.
  const offered = new Set([...existing.map((o) => o.package_id), convert ? quote.roof_package_id : null].filter(Boolean));
  const ids = [...new Set(body.package_ids)].filter((id) => !offered.has(id));
  if (!ids.length) throw new HttpError(400, "That package is already on this estimate. Pick another one to offer.");
  if (existing.length + Number(convert) + ids.length > 3) throw new HttpError(400, "A quote offers up to 3 options.");

  const [trade, measurement] = await Promise.all([companyTrade(db, companyId), quoteMeasurement(db, companyId, quoteId)]);
  const roofing = isRoofWork(trade, measurement);
  const packages = await loadPackages(db, companyId, ids, roofing);
  // Only a roof's options wait for the measurement: Roofing fills them in once the roof is measured.
  const waits = (p: PricedPackage) => p.measured && !measurement;
  if (!roofing && packages.some(waits)) throw new HttpError(409, measureFirst(false));
  const vars = measurement ? measurementVariables(measurement) : null;
  const built = packages.map((p) => (waits(p) ? null : pricedLines(p, vars, roofing)));
  const skipped = packages.flatMap((p, i) => skippedOf(p, built[i]?.skipped ?? []));
  const priced = packages.filter((_, i) => built[i]);
  const measured = Boolean(measurement) && priced.some((p) => p.measured);

  if (!existing.length && !convert && ids.length === 1) {
    if (!(await putPackage(db, quote, packages[0]!, built[0]?.lines ?? null, body.replace))) throw new HttpError(409, CHANGED);
    await saveFollowedPrices(db, companyId, priced);
    if (measured) await showMeasurement(db, companyId, quoteId, measurement!.id);
    return { options: [], skipped, ...(await depositAfter(db, companyId, quoteId)) };
  }

  // The estimate as it is becomes option 1 with every line not asked to stay on every option. A price
  // set on site before there were options stays with it (private.quote_option_added): its adjustment
  // line goes onto option 1 whatever's asked, and a discount it set becomes lines there too, off
  // option 1 alone: a taxed and an untaxed one, split as the discount came off (core
  // siteAdjustmentLines), so its total doesn't move.
  const shared = new Set(convert ? body.shared_line_ids : []);
  const sitePriced = convert && quote.priced_on_site_at !== null;
  const onCurrent = (l: (typeof lines)[number]) => convert && (!shared.has(l.id) || (sitePriced && isSiteAdjustment(l)));
  if (convert && !lines.some(onCurrent)) throw new HttpError(400, "Leave at least one line on the estimate as it is, or start over from the packages.");
  const moved = sitePriced && !quote.promo_code_id && toCents(quote.discount_amount) > 0;
  const siteDiscount = moved ? Math.min(toCents(quote.discount_amount), Math.max(toCents(quoteTotals(lines, { taxRate: 0 }).subtotal), 0)) / 100 : 0;

  // Every option priced before add-ons, the way the price range prices them, to put them in order.
  const opts = { taxRate: quote.tax_rate, discountAmount: (body.replace && !quote.promo_code_id) || moved ? 0 : quote.discount_amount, promo: quote.promo };
  const key = (i: number) => `new:${i}`;
  const all: OptionLine[] = [
    ...lines.map((l) => ({ ...l, option_id: onCurrent(l) ? CURRENT : l.option_id })),
    ...siteAdjustmentLines(-siteDiscount, lines).map((l) => ({ option_id: CURRENT, quantity: 1, unit_price: l.unit_price, taxable: l.taxable, optional: false, selected: true })),
    ...built.flatMap((b, i) => (b?.lines ?? []).map((l) => ({ option_id: key(i), quantity: l.quantity, unit_price: l.unit_price, taxable: l.taxable, optional: false, selected: true }))),
  ];
  const fresh: Priced[] = packages.map((p, i) => ({ id: key(i), tier: p.pkg.tier, total: optionBaseTotal(all, key(i), opts) }));
  const known: Priced[] = existing.map((o) => ({ id: o.id, tier: o.tier, total: optionBaseTotal(all, o.id, opts) }));
  const own = convert && quote.roof_package_id ? (await db.from("roof_packages").select("tier").eq("id", quote.roof_package_id).eq("company_id", companyId).maybeSingle()).data : null;
  const made: Priced[] = [...(convert ? [{ id: CURRENT, tier: own?.tier ?? null, total: optionBaseTotal(all, CURRENT, opts) }] : []), ...fresh];
  // An option already offered keeps its words, so new ones are named only beside options that have theirs.
  const words = known.every((o) => o.tier?.trim()) ? tierWords([...known, ...made]) : tierWords(made.map((o) => ({ ...o, total: null })));
  // Cheapest first; new ones go after the options offered already.
  const first = existing.length ? Math.max(...existing.map((o) => o.sort)) + 1 : 0;
  const sortOf = new Map(optionTierOrder(made).map((id, i) => [id, first + i]));
  const current = convert ? { tier: words.get(CURRENT) ?? null, sort: sortOf.get(CURRENT)! } : null;

  const after = lines.reduce((max, l) => Math.max(max, l.sort), -1) + 1;
  // In order, so the first one made is the first one shown (when the estimate isn't option 1).
  const entries = packages.map(({ pkg }, i) => ({
    package_id: pkg.id,
    name: pkg.name,
    tier: words.get(key(i)) ?? null,
    picture: pkg.picture,
    picture_width: pkg.picture_width,
    picture_height: pkg.picture_height,
    style: pkg.style,
    highlights: pkg.highlights,
    warranty: pkg.warranty,
    section_ids: pkg.section_ids,
    sort: sortOf.get(key(i))!,
    lines: optionLines(built[i]?.lines ?? [], after),
  })).sort((a, b) => a.sort - b.sort);
  const { data, error } = await db.rpc("apply_quote_options", {
    p_quote: quoteId,
    p_options: asJson(entries),
    p_mode: body.replace ? "replace" : "add",
    p_shared: lines.filter((l) => convert && !onCurrent(l)).map((l) => l.id),
    ...(current ? { p_current: asJson(current) } : {}),
  });
  if (error) throw dbError(error);
  await saveFollowedPrices(db, companyId, priced);
  if (measured) await showMeasurement(db, companyId, quoteId, measurement!.id);
  return { options: toOptions(data), skipped, ...(await depositAfter(db, companyId, quoteId)) };
}

/**
 * One package on an estimate that doesn't offer options: the quote remembers it and its lines go on
 * the quote, shared (null `lines`: a roof that isn't measured yet, priced once it is), in one locked
 * step. Starting over takes every option and line off first, and the price set before with them.
 * Returns false when the quote got lines meanwhile on another screen: it keeps them, and gets none.
 */
async function putPackage(db: Db, quote: Awaited<ReturnType<typeof openQuote>>, p: PricedPackage, lines: readonly PackageLine[] | null, replace: boolean) {
  // Its contract sections come with it (the old package's go), worked out on the locked quote.
  return putQuotePackage(db, quote.id, p.pkg.id, lines ?? [], replace);
}

/**
 * Fill in the options that have no lines yet, from their packages (POST /quotes/:id/options/fill):
 * Roofing calls it once the roof is measured, for options offered before. An option whose package
 * was deleted is left for the office to fill by hand. An estimate without options gets the lines of
 * the package it remembers, when it has none yet (fillPackage), so it's the one call to make after
 * measuring either way.
 */
export async function fillOptions(db: Db, companyId: string, quoteId: string): Promise<OptionsResult> {
  const quote = await openQuote(db, companyId, quoteId);
  if (!quote.options.length) return fillPackage(db, companyId, quote);
  const empty = quote.options.filter((o) => !quote.lines.some((l) => l.option_id === o.id));
  const skipped: SkippedLine[] = empty.filter((o) => !o.package_id).map((o) => ({ package: o.name, name: o.name, reason: "Its package was deleted, so add its lines by hand." }));
  const filling = empty.filter((o) => o.package_id);

  const [trade, measurement] = await Promise.all([companyTrade(db, companyId), quoteMeasurement(db, companyId, quoteId)]);
  const roofing = isRoofWork(trade, measurement);
  const packages = await loadPackages(db, companyId, filling.map((o) => o.package_id!), roofing);
  if (packages.some((p) => p.measured) && !measurement) throw new HttpError(409, measureFirst(roofing));
  const vars = measurement ? measurementVariables(measurement) : null;
  const built = new Map(packages.map((p) => [p.pkg.id, pricedLines(p, vars, roofing)]));
  for (const p of packages) skipped.push(...skippedOf(p, built.get(p.pkg.id)!.skipped));

  const after = quote.lines.reduce((max, l) => Math.max(max, l.sort), -1) + 1;
  const entries = filling.map((o) => ({ id: o.id, lines: optionLines(built.get(o.package_id!)!.lines, after) }));
  const { data, error } = await db.rpc("apply_quote_options", { p_quote: quoteId, p_options: asJson(entries), p_mode: "fill" });
  if (error) throw dbError(error);
  await saveFollowedPrices(db, companyId, packages);
  if (measurement && packages.some((p) => p.measured)) await showMeasurement(db, companyId, quoteId, measurement.id);
  let options = toOptions(data);
  // Offered before anything was measured, the options waited for their prices to be put in order and
  // named Good, Better and Best; now they have them.
  if (entries.length && empty.length === quote.options.length) options = await orderOptions(db, companyId, quote, options, entries);
  return { options, skipped, ...(entries.length ? await depositAfter(db, companyId, quoteId) : {}) };
}

/**
 * A single package remembered before the roof was measured (roof_package_id, no lines): its lines,
 * now that it is. An estimate with lines keeps them; nothing changes.
 */
async function fillPackage(db: Db, companyId: string, quote: Awaited<ReturnType<typeof openQuote>>): Promise<OptionsResult> {
  if (!quote.roof_package_id || quote.lines.length) return { options: [], skipped: [] };
  const [trade, measurement] = await Promise.all([companyTrade(db, companyId), quoteMeasurement(db, companyId, quote.id)]);
  const roofing = isRoofWork(trade, measurement);
  const p = (await loadPackages(db, companyId, [quote.roof_package_id], roofing))[0]!;
  if (p.measured && !measurement) throw new HttpError(409, measureFirst(roofing));
  const built = pricedLines(p, measurement ? measurementVariables(measurement) : null, roofing);
  if (!(await putPackage(db, quote, p, built.lines, false))) return { options: [], skipped: [] };
  await saveFollowedPrices(db, companyId, [p]);
  if (measurement && p.measured) await showMeasurement(db, companyId, quote.id, measurement.id);
  return { options: [], skipped: skippedOf(p, built.skipped), ...(await depositAfter(db, companyId, quote.id)) };
}

/**
 * Options offered before they had prices, in order by price now, with their tier words. The
 * cheapest is shown first, as it's offered, unless someone chose one already: a price set on site
 * for it, or the homeowner's lean when they said yes to the range.
 */
async function orderOptions(
  db: Db,
  companyId: string,
  quote: Awaited<ReturnType<typeof openQuote>>,
  options: QuoteOption[],
  filled: ReadonlyArray<{ id: string; lines: ReadonlyArray<{ quantity: number; unit_price: number; taxable: boolean }> }>,
) {
  const all: OptionLine[] = [...quote.lines, ...filled.flatMap((o) => o.lines.map((l) => ({ ...l, option_id: o.id, optional: false, selected: true })))];
  const opts = { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo };
  const priced = options.map((o) => ({ id: o.id, tier: o.tier, total: optionBaseTotal(all, o.id, opts) }));
  const words = tierWords(priced);
  const order = optionTierOrder(priced);
  const next = options.map((o) => ({ ...o, tier: o.tier ?? words.get(o.id) ?? null, sort: order.indexOf(o.id) }));
  for (const [i, o] of next.entries()) {
    if (o.tier === options[i]!.tier && o.sort === options[i]!.sort) continue;
    const { error } = await db.from("quote_options").update({ tier: o.tier, sort: o.sort }).eq("id", o.id).eq("company_id", companyId);
    if (error) throw dbError(error);
  }
  const ordered = next.sort((a, b) => a.sort - b.sort);
  const first = ordered[0]!.id;
  if (quote.option_id && quote.option_id !== first && !quote.priced_on_site_at && !quote.range_accepted_at) {
    // On its own, and only while the option shown is still the one read.
    const { error } = await db.from("quotes").update({ option_id: first }).eq("id", quote.id).eq("company_id", companyId).eq("option_id", quote.option_id);
    if (error) throw dbError(error);
  }
  return ordered;
}

/**
 * Take an option off an estimate, with its lines (DELETE /quotes/:id/options/:optionId). When one
 * would be left, the estimate goes back to a single one: that option's lines go on the quote, and
 * there are no options any more.
 */
export async function removeOption(db: Db, companyId: string, quoteId: string, optionId: string): Promise<{ options: QuoteOption[] }> {
  await openQuote(db, companyId, quoteId);
  const { data, error } = await db.rpc("remove_quote_option", { p_quote: quoteId, p_option: optionId });
  if (error) throw dbError(error);
  return { options: toOptions(data) };
}

/**
 * "Copy as new draft" (POST /quotes/:id/duplicate): a new draft for the same client with the same
 * lines, its options copied with new ids and the same option shown, and how often it repeats.
 * Returns the copy's id.
 */
export async function duplicateQuote(db: Db, companyId: string, quoteId: string): Promise<{ id: string }> {
  const { recurrence_rule, active_months, starts_on, ends_on } = must(
    await db.from("quotes").select("id, recurrence_rule, active_months, starts_on, ends_on").eq("id", quoteId).eq("company_id", companyId).maybeSingle(),
    QUOTE_NOT_FOUND,
  );
  const { data, error } = await db.rpc("duplicate_quote", { p_quote: quoteId });
  if (error) throw dbError(error);
  if (!data) throw new HttpError(404, QUOTE_NOT_FOUND);
  if (recurrence_rule) {
    const copied = await db.from("quotes").update({ recurrence_rule, active_months, starts_on, ends_on }).eq("id", data);
    if (copied.error) throw dbError(copied.error);
  }
  return { id: data };
}
