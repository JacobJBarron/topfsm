/**
 * No-account routes: the Client Hub (signed quote/invoice links), public booking forms, and the
 * Stripe webhooks. These use the admin client, so every query filters by the company in the link
 * or form, and responses include only client-facing fields (never costs or internal notes).
 */
import { contractValues, fillIn } from "@crewtavo/core/contracts";
import { pickTemplate, templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { hidesExactPrice, inRangeMode, isSiteAdjustment, optionsRange, priceRange, rangeSettings } from "@crewtavo/core/estimates";
import { marketingOn } from "@crewtavo/core/marketing";
import { chosenTotals, countsOn, optionBaseTotal, optionTotals, type OptionLine } from "@crewtavo/core/money";
import { isPackagePicturePath, packagePictureSrc } from "@crewtavo/core/presets";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { handleStripeEvent, hubPayment, stripeAccess, stripeCheckout, type WebhookRoute } from "../integrations/stripe";
import { kickAutomations, runInBackground } from "../lib/background";
import {
  addressLines,
  checkContract,
  contractFacts,
  contractInput,
  freezeContract,
  freezeOption,
  initialsImage,
  invoiceContract,
  invoiceFill,
  invoiceInput,
  isPriced,
  loadLibrary,
  loadOptions,
  optionTiers,
  packageFill,
  postedId,
  readFrozen,
  resolveContract,
  sectionsHashSchema,
  type FrozenOption,
  type OptionRow,
} from "../services/contracts";
import { geocodeAddress } from "../services/external";
import { LETTERHEAD_MAX_BYTES } from "../services/letterhead";
import { isDrawnPng, isPng, LOGO_MAX_BYTES, logoImage, logoOf } from "../services/logo";
import { PACKAGE_PICTURE_MAX_BYTES } from "../services/packagePictures";
import { isJpeg } from "../services/photos";
import { isRoofWork, quoteMeasurement, sitePriceSet } from "../services/roofPackages";
import { optionsFrom } from "../services/sales";
import { signatureImage } from "../services/signing";
import { firstName } from "../lib/email";
import { signToken, verifyToken } from "../lib/crypto";
import { appUrl, asJson, dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { clientLink, readClientLink, type LinkKind } from "../lib/links";
import { adminClient } from "../lib/supabase";
import { clientIp } from "../lib/visitor";
import { buildCalendar } from "../lib/ics";
import { bookingVisit } from "../services/analytics";
import { StripeError, verifyStripeSignature, type StripeEvent } from "../services/stripe";
import { UPLOAD_LIMIT } from "../services/uploads";

export const publicRoutes = new Hono<AppEnv>();

async function link(c: Parameters<typeof appUrl>[0], kinds: LinkKind[] = ["quote", "invoice", "client"]) {
  const payload = await readClientLink(c.env, c.req.param("token") ?? "");
  if (!payload || !kinds.includes(payload.t)) throw new HttpError(404, "This link has expired or isn't valid. Ask for a new one.");
  return payload;
}

/** Locate a new property in the background so routing and weather checks work for it. */
export function geocodeLater(c: Parameters<typeof appUrl>[0], propertyId: string, address: { line1: string; city?: string; postal_code?: string }) {
  runInBackground(
    c,
    (async () => {
      const hit = await geocodeAddress([address.line1, address.city, address.postal_code].filter(Boolean).join(", "), c.env.GOOGLE_MAPS_SERVER_KEY);
      if (hit) await adminClient(c.env).from("properties").update({ lat: hit.lat, lng: hit.lng }).eq("id", propertyId);
    })(),
  );
}

/**
 * Booking forms, referrals and "request work" each make a request and tell the office, and the
 * first two add a client and look up the address (a billed Google call). So a script can't send
 * them by the thousand: a few an hour from one visitor, and a hundred an hour for each company.
 */
async function limitSubmissions(c: Parameters<typeof appUrl>[0], kind: "form" | "referral" | "hub-request", companyId: string) {
  if (!(await allow(c.env, `${kind}:ip:${clientIp(c)}`, 10, 60 * 60)) || !(await allow(c.env, `${kind}:company:${companyId}`, 100, 60 * 60))) {
    throw new HttpError(429, "Too many requests. Try again later, or call us.");
  }
}

async function verifyTurnstile(c: Parameters<typeof appUrl>[0], token: string | undefined) {
  if (!c.env.TURNSTILE_SECRET_KEY) return;
  const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET_KEY, response: token ?? "" }),
  }).catch(() => null);
  const result = verify ? ((await verify.json()) as { success?: boolean }) : { success: false };
  if (!result.success) throw new HttpError(400, "Please complete the verification and try again.");
}

// The range settings (settings->roofing) and the trade are read here but never sent: the room on top
// is the business's own, and the trade only decides whether a preview shows a roofing range.
const BRANDING = "name, phone, email, website, timezone, address, trade_preset, settings->branding, settings->hub_tips, settings->roofing";

/** The company as its clients see it, with where its logo loads from (null without one). */
const withLogo = <T extends { branding?: unknown }>(companyId: string, company: T) => ({ ...company, logo: logoImage("", companyId, { branding: company.branding })?.src ?? null });

/** The business's address as it prints on a letterhead (services/contracts.ts). */
export { addressLines };

/**
 * The company for a Hub page (name, contact details, address lines, logo), and its range settings and
 * trade for the server's own use.
 */
async function hubCompany(admin: ReturnType<typeof adminClient>, companyId: string) {
  const { address, roofing, trade_preset: trade, ...row } = must(await admin.from("companies").select(BRANDING).eq("id", companyId).maybeSingle());
  return { company: withLogo(companyId, { ...row, address: addressLines(address) }), roofing, trade };
}

/**
 * The template a quote was signed with, kept in its approval (quotes.approval.template) so later
 * changes to the business's templates don't change the terms above the signatures. Null for a quote
 * signed before it was kept, or one the office marked approved without it.
 */
export function signedTemplate(approval: unknown): TemplateSettings | null {
  const a = approval && typeof approval === "object" && !Array.isArray(approval) ? (approval as Record<string, unknown>) : null;
  return a?.template && typeof a.template === "object" && !Array.isArray(a.template) ? templateSettings(a.template) : null;
}

/**
 * The estimate template a document prints with: a signed quote's own (pass its approval), else the
 * one it names, else the business's default (core documents.ts).
 */
async function hubTemplate(admin: ReturnType<typeof adminClient>, companyId: string, templateId: string | null, signedApproval?: unknown) {
  const kept = signedTemplate(signedApproval);
  if (kept) return kept;
  const { data } = await admin.from("document_templates").select("id, is_default, settings").eq("company_id", companyId);
  return pickTemplate(data ?? [], templateId);
}

/** A drawn signature, only when it's one a signature pad makes (logo.ts isDrawnPng), else null. */
const pngOrNull = (value: unknown) => (isDrawnPng(value) ? value : null);

/**
 * Who signed a quote, for the signed document: the client's name and signature, and the business's
 * when someone signed for it, with the option they chose, the contract as they signed it and their
 * initials (it's the client's own signed copy). Never the address the client signed from.
 */
export function publicApproval(raw: unknown, approvedAt: string | null) {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const co = a.company && typeof a.company === "object" && !Array.isArray(a.company) ? (a.company as Record<string, unknown>) : null;
  const companySignature = co ? pngOrNull(co.signature) : null;
  return {
    name: text(a.name) ?? "",
    signature: pngOrNull(a.signature),
    signed_at: text(a.signed_at) ?? approvedAt,
    // "manual": the office marked it approved, so nobody signed on the client's line.
    method: a.method === "manual" || a.method === "in_person" ? a.method : null,
    company: companySignature ? { name: text(co!.name) ?? "", signature: companySignature, signed_at: text(co!.signed_at) } : null,
    ...readFrozen(raw),
  };
}

/** The parts of a quote line the range reads: what's on it, the option it's on, and which line takes off the old roof. */
interface RangeLine { service_id: string | null; option_id?: string | null; name: string; unit: string; unit_price: number; formula: string | null; optional: boolean; selected: boolean }
/** A package's quick add, priced from the price list. */
interface RangeQuickAdd { service_id: string; name: string; unit: string; unit_price: number }

const TEAR_OFF = /tear|remov|dispos/i;
// "Each" and the like read as a plain price ("$650"); anything else as "$95 a sheet".
const perUnit = (unit: string) => (/^(ea|each|lump ?sum|job|flat)$/i.test(unit.trim()) ? null : unit.trim() || null);

/**
 * What the client sees with a price range: what's included (the lines on the estimate, without a
 * price set on site; with options, the shared lines and the shown option's), and up to three things
 * that could move the price: the package's quick adds for rotten decking and chimneys that aren't on
 * it already, and another layer of old shingles at the tear-off's price a square.
 */
export function rangeDetails(lines: readonly RangeLine[], quickAdds: readonly RangeQuickAdd[], shownOptionId: string | null = null) {
  const counted = lines.filter((l) => countsOn(l, shownOptionId) && !isSiteAdjustment(l));
  const onIt = new Set(counted.map((l) => l.service_id).filter(Boolean));
  const offered = quickAdds.filter((q) => !onIt.has(q.service_id) && Number(q.unit_price) > 0);
  const item = (name: string, price: number, unit: string) => ({ name, price: Number(price), per: perUnit(unit) });
  const decking = offered.filter((q) => /deck/i.test(q.name)).map((q) => item(q.name, q.unit_price, q.unit));
  const chimney = offered.filter((q) => /chimney/i.test(q.name)).map((q) => item(q.name, q.unit_price, q.unit));
  const tearOff = counted.find((l) => l.formula && TEAR_OFF.test(l.name) && Number(l.unit_price) > 0);
  const layer = tearOff ? [item("Another layer of old shingles", tearOff.unit_price, tearOff.unit)] : [];
  return {
    included: [...new Set(counted.map((l) => l.name.trim()).filter(Boolean))],
    maybe: [...decking.slice(0, 1), ...layer, ...decking.slice(1), ...chimney].slice(0, 3),
  };
}

/** A roof package's quick adds, in the package's order, priced from the price list. */
async function packageQuickAdds(admin: ReturnType<typeof adminClient>, companyId: string, packageId: string): Promise<RangeQuickAdd[]> {
  const { data: items } = await admin.from("roof_package_items").select("service_id, sort").eq("company_id", companyId).eq("package_id", packageId).eq("kind", "quick").order("sort");
  const ids = (items ?? []).map((i) => i.service_id);
  if (!ids.length) return [];
  const { data: services } = await admin.from("services").select("id, name, unit, unit_price, active").eq("company_id", companyId).in("id", ids);
  const byId = new Map((services ?? []).filter((s) => s.active !== false).map((s) => [s.id, s]));
  return ids.flatMap((id) => {
    const s = byId.get(id);
    return s ? [{ service_id: s.id, name: s.name, unit: s.unit, unit_price: Number(s.unit_price) }] : [];
  });
}

/**
 * The lines a range was sent with (quotes.range_lines, core estimates.ts snapshotLines), as lines an
 * option's total is worked out from: the shared lines and each option's required lines, all counted.
 * Null when the range was sent before the lines were kept with it.
 */
function sentRangeLines(raw: unknown): OptionLine[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((s) => {
    if (!s || typeof s !== "object") return [];
    const line = s as Record<string, unknown>;
    return [{ option_id: typeof line.option_id === "string" ? line.option_id : null, quantity: Number(line.quantity ?? 0), unit_price: Number(line.unit_price ?? 0), taxable: line.taxable !== false, optional: false, selected: true }];
  });
}

/** A range kept inside another: an option's own range inside the range the homeowner was sent. */
function within(range: { low: number; high: number }, outer: { low: number; high: number }) {
  const low = Math.min(Math.max(range.low, outer.low), outer.high);
  return { low, high: Math.max(Math.min(range.high, outer.high), low) };
}

/** An option's card as it was signed (approval.option), with its picture where the Client Hub loads it. */
const signedCard = (o: FrozenOption) => ({
  id: o.id, name: o.name, tier: o.tier, picture: o.picture ? { src: packagePictureSrc(o.picture.path), width: o.picture.width, height: o.picture.height } : null,
  style: o.style, highlights: o.highlights, warranty: o.warranty,
});

/**
 * The business's signature on a quote the client signs online: the salesperson's saved one, when
 * the template has a line for the business and they're still on the team. Null leaves it to sign
 * later from the office.
 */
async function businessSignature(admin: ReturnType<typeof adminClient>, companyId: string, quote: { salesperson_id: string | null }, template: TemplateSettings) {
  if (!quote.salesperson_id || !template.company_signs) return null;
  const [saved, profile, member] = await Promise.all([
    admin.from("user_signatures").select("image").eq("company_id", companyId).eq("user_id", quote.salesperson_id).maybeSingle(),
    admin.from("profiles").select("full_name").eq("user_id", quote.salesperson_id).maybeSingle(),
    admin.from("memberships").select("user_id").eq("company_id", companyId).eq("user_id", quote.salesperson_id).eq("active", true).maybeSingle(),
  ]);
  const image = pngOrNull(saved.data?.image);
  if (!image || !member.data) return null;
  return { name: profile.data?.full_name?.trim() ?? "", user_id: quote.salesperson_id, signature: image, signed_at: new Date().toISOString() };
}

/**
 * Map drawings the office chose to show on this quote or invoice: the sizes, and whether there's a
 * picture (served by /hub/:token/drawings/:id, never as a storage link).
 */
async function hubDrawings(admin: ReturnType<typeof adminClient>, companyId: string, on: "quote_id" | "invoice_id", id: string) {
  const { data } = await admin
    .from("measurements")
    .select("id, title, sections, total_area_sqft, total_length_ft, roofing_squares, roof_pitch, snapshot_path, view, updated_at")
    .eq("company_id", companyId)
    .eq(on, id)
    .eq(on === "quote_id" ? "show_on_quote" : "show_on_invoice", true)
    .order("created_at");
  return (data ?? []).map((m) => ({
    id: m.id,
    title: m.title,
    has_picture: Boolean(m.snapshot_path),
    // A roof section's pitch, so one at another pitch (a porch) can say so.
    sections: ((m.sections ?? []) as Array<{ label: string; kind: string; value: number; unit: string; pitch?: string | null }>).map((s) => ({ label: s.label, kind: s.kind, value: s.value, unit: s.unit, ...(s.kind === "Area" && s.pitch ? { pitch: s.pitch } : {}) })),
    total_area_sqft: m.total_area_sqft,
    total_length_ft: m.total_length_ft,
    roofing_squares: m.roofing_squares,
    roof_pitch: m.roof_pitch,
    imagery: ((m.view ?? {}) as { attribution?: string }).attribution ?? null,
    // When the roof was last measured, for "Measured from aerial photos on …".
    measured_at: m.updated_at,
  }));
}

publicRoutes.get("/hub/:token", async (c) => {
  const l = await link(c);
  const admin = adminClient(c.env);
  const { company, roofing, trade } = await hubCompany(admin, l.c);
  if (l.t === "client") return c.json(await clientHome(c, admin, l.c, l.id, company));
  if (l.t === "quote") {
    const quote = must(
      await admin
        .from("quotes")
        .select(
          "id, number, status, title, message, subtotal, discount_amount, tax_rate, tax_amount, total, deposit_amount, valid_until, sent_at, created_at, approved_at, approval, client_id, change_order_for, template_id, roof_package_id, option_id, section_ids, range_low, range_high, range_sent_at, range_lines, range_accepted_at, priced_on_site_at, exact_sent_at, promo_code_id, promo:promo_codes(code, kind, value, description, min_subtotal), client:clients(display_name, billing_address), property:properties(line1, city, region, postal_code)",
        )
        .eq("company_id", l.c)
        .eq("id", l.id)
        .maybeSingle(),
      "Quote not found.",
    );
    if (quote.status === "draft" && !l.pv) throw new HttpError(404, "This quote isn't ready yet.");
    const signed = quote.status === "approved" || quote.status === "converted";
    const [lineRows, options, drawings, template, roofPackage, home] = await Promise.all([
      // The formula only tells the server which line is the tear-off; it's never sent.
      admin.from("quote_line_items").select("id, option_id, service_id, name, description, quantity, unit, unit_price, taxable, optional, selected, option_group, sort, formula").eq("company_id", l.c).eq("quote_id", quote.id).order("sort"),
      loadOptions(admin, l.c, quote.id),
      hubDrawings(admin, l.c, "quote_id", quote.id),
      // Signed, it prints with the template it was signed with.
      hubTemplate(admin, l.c, quote.template_id, signed ? quote.approval : null),
      quote.roof_package_id ? admin.from("roof_packages").select("name, warranty").eq("company_id", l.c).eq("id", quote.roof_package_id).maybeSingle() : null,
      l.pv ? null : homeLink(c, l.c, quote.client_id),
    ]);
    const lines = [...must(lineRows)].sort((a, b) => a.sort - b.sort);
    const shown = quote.option_id;
    const money = { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo };
    // Each option's price before add-ons: what its range and its tier word come from.
    const bases = new Map(options.map((o) => [o.id, optionBaseTotal(lines, o.id, money)]));
    const priced = [...bases.values()].filter((total): total is number => total !== null);
    const tiers = optionTiers(options, lines, money);
    const settings = rangeSettings({ roofing });

    // Sent as a price range: the client sees the range, never the exact price, until the salesperson
    // prices it on site or the office sends the exact price instead. The office's preview of a
    // roofing estimate not sent yet shows the range it would get (from the cheapest option to the
    // priciest), once there's something on it to price and, with options, once one of them has a
    // price (a range can't be sent before); one already sent at its exact price previews as the
    // client sees it. Roof work is a roofer's, or a roof another trade measured (roofPackages.ts
    // isRoofWork), which Roofing sends as a range too; other work never goes out as one, so it
    // previews the price.
    const draftPreview = Boolean(l.pv) && quote.status === "draft" && quote.range_low === null;
    const roofWork = trade === "roofing_exteriors" || (draftPreview && isRoofWork(trade, await quoteMeasurement(admin, l.c, quote.id)));
    const previewRange =
      draftPreview && roofWork && (quote.roof_package_id !== null || options.length > 0) && (!options.length || priced.length > 0) &&
      quote.priced_on_site_at === null && Number(quote.total) > 0;
    let range = null;
    let between: { low: number; high: number } | null = null;
    if (inRangeMode(quote) || previewRange) {
      between = previewRange ? (options.length ? optionsRange(priced, settings) : priceRange(quote.total, settings)) : { low: Number(quote.range_low), high: Number(quote.range_high) };
      const quickAdds = quote.roof_package_id ? await packageQuickAdds(admin, l.c, quote.roof_package_id) : [];
      range = { ...between, sent_at: quote.range_sent_at, accepted_at: quote.range_accepted_at, ...rangeDetails(lines, quickAdds, shown) };
    }
    // Each option's own range. A range that was sent keeps the lines it was sent with, so editing the
    // estimate after doesn't move an option's range away from the range the homeowner got (an option
    // added since has none), and it stays inside that range.
    const sentWith = between && !previewRange ? sentRangeLines(quote.range_lines) : null;
    const optionRange = (id: string) => {
      const base = sentWith ? optionBaseTotal(sentWith, id, money) : (bases.get(id) ?? null);
      if (!between || base === null) return null;
      return previewRange ? priceRange(base, settings) : within(priceRange(base, settings), between);
    };
    // A range marked lost or archived no longer shows the range, but its exact price stays hidden too:
    // the client never saw one.
    const exact = range === null && !hidesExactPrice(quote);
    // Once signed, the option they chose as it was signed, and its lines; before, every option, each
    // with its own lines.
    const kept = signed ? readFrozen(quote.approval) : null;
    const chosen = kept?.option?.id ?? shown;
    const sent = exact ? lines.filter((line) => !signed || line.option_id === null || line.option_id === chosen) : [];
    const liveCard = (o: OptionRow) => ({
      id: o.id, name: o.name, tier: tiers.get(o.id) ?? null,
      picture: o.picture && isPackagePicturePath(o.picture) && o.picture_width && o.picture_height ? { src: packagePictureSrc(o.picture), width: o.picture_width, height: o.picture_height } : null,
      style: o.style, highlights: o.highlights, warranty: o.warranty, section_ids: o.section_ids, sort: o.sort,
    });
    // Each option's card. With the exact price, its total as if it were picked with none of its
    // add-ons (signed: the total signed, on the option as it was signed); with a range, its own range
    // and never a price.
    const cards = signed
      ? kept?.option
        ? // Its sections are in the contract kept with the approval.
          [{ ...signedCard(kept.option), section_ids: [] as string[], sort: 0, total: exact ? quote.total : null, range: null }]
        : options.filter((o) => o.id === shown).map((o) => ({ ...liveCard(o), total: exact ? quote.total : null, range: null }))
      : options.map((o) => ({ ...liveCard(o), total: exact && bases.get(o.id) != null ? optionTotals(lines, o.id, null, money).total : null, range: optionRange(o.id) }));

    // The contract, never with a range (it would say the price). Open, it's the library's words as
    // written for every section any option could print, with the facts for the fill-ins, so the page
    // fills in whichever option is picked exactly as the server will when it's signed. Signed, it's
    // the copy kept with the approval.
    let contract = null;
    if (exact) {
      // Without options, {Option} and {Warranty} say the package it was priced from; with them, the
      // option picked does.
      const fill = options.length || !roofPackage?.data ? null : { name: roofPackage.data.name, warranty: roofPackage.data.warranty ?? "" };
      const facts = contractInput(quote, quote.client, quote.property, company, template, fill);
      contract = kept
        ? kept.contract
          ? { kind: "signed" as const, terms: kept.contract.terms, sections: kept.contract.sections, initials: kept.initials }
          : // Signed before the contract was kept with it: the terms it was signed under, filled in as they are today.
            { kind: "signed" as const, terms: fillIn(template.terms, contractValues(facts), { text: true }), sections: [], initials: null }
        : {
            kind: "live" as const,
            terms: template.terms,
            library: await loadLibrary(admin, l.c, [...template.sections, ...options.flatMap((o) => o.section_ids), ...quote.section_ids]),
            template_sections: template.sections,
            quote_sections: quote.section_ids,
            facts: contractFacts(facts),
          };
    }
    return c.json({
      kind: "quote",
      company,
      template,
      contract,
      quote: {
        id: quote.id, number: quote.number, status: quote.status, title: quote.title, message: quote.message,
        subtotal: exact ? quote.subtotal : null,
        discount_amount: exact ? quote.discount_amount : null,
        tax_rate: quote.tax_rate,
        tax_amount: exact ? quote.tax_amount : null,
        total: exact ? quote.total : null,
        deposit_amount: exact ? quote.deposit_amount : null,
        valid_until: quote.valid_until, sent_at: quote.sent_at, created_at: quote.created_at, approved_at: quote.approved_at, client_id: quote.client_id, change_order_for: quote.change_order_for,
        promo: quote.promo, client: quote.client ? { display_name: quote.client.display_name } : null, property: quote.property,
        package: roofPackage?.data ? { name: roofPackage.data.name } : null,
        approval: signed ? publicApproval(quote.approval, quote.approved_at) : null,
        // A price agreed on site is in effect, so a promo code can't go on it (the promo route says so).
        site_priced: sitePriceSet(quote, lines),
        option_id: chosen,
        section_ids: quote.section_ids,
        options: cards,
        range,
        lines: sent.map((line) => ({
          id: line.id, option_id: line.option_id, name: line.name, description: line.description, quantity: line.quantity, unit: line.unit, unit_price: line.unit_price,
          taxable: line.taxable, optional: line.optional, selected: line.selected, option_group: line.option_group, sort: line.sort,
        })),
      },
      drawings,
      preview: Boolean(l.pv),
      home,
    });
  }
  const invoice = must(
    await admin
      .from("invoices")
      .select(
        "id, number, status, subject, notes, issued_on, due_on, subtotal, discount_amount, tax_amount, total, retainage_amount, amount_paid, balance_due, client_id, promo:promo_codes(code, kind, value, description), client:clients(display_name, billing_address), job:jobs(property:properties(line1, city, region, postal_code), quote:quotes!jobs_company_id_quote_id_fkey(approval, option_id, roof_package_id, option:quote_options!quotes_option_fkey(name, warranty))), lines:invoice_line_items(name, description, quantity, unit, unit_price, sort), payments(amount, tip_amount, received_at)",
      )
      .eq("company_id", l.c)
      .eq("id", l.id)
      .maybeSingle(),
    "Invoice not found.",
  );
  if ((invoice.status === "draft" && !l.pv) || invoice.status === "void") throw new HttpError(404, invoice.status === "void" ? "This invoice was cancelled. Contact us with any questions." : "This invoice isn't ready yet.");
  (invoice.lines as Array<{ sort: number }>).sort((a, b) => a.sort - b.sort);
  // The Hub lists what was paid and refunded against the total. A payment that was only a tip (or
  // the refund of one) doesn't change what's owed, so it isn't among them.
  invoice.payments = invoice.payments.filter((p) => Number(p.amount) !== 0);
  const [online, template, drawings] = await Promise.all([hubPayment(c.env, admin, l.c, invoice.id), hubTemplate(admin, l.c, null), hubDrawings(admin, l.c, "invoice_id", invoice.id)]);
  // Invoices made in Stripe are paid exactly as Stripe billed them, so no tip.
  const tips = (company as { hub_tips?: unknown }).hub_tips === true && !online.imported;
  // The template's terms and invoice sections, filled in with the invoice's facts (the customer's
  // billing address and the job's address only go into the words, never out on their own). Its
  // {Option} and {Warranty} are those of the estimate the job came from (contracts.ts invoiceFill).
  const { client, job, ...billed } = invoice;
  const fill = await invoiceFill(admin, l.c, job?.quote);
  const facts = invoiceInput(invoice, client, job?.property ?? null, company, template, fill);
  const contract = await invoiceContract(admin, l.c, template, facts);
  return c.json({
    kind: "invoice", company, template, contract, invoice: { ...billed, client: client ? { display_name: client.display_name } : null }, preview: Boolean(l.pv), tips,
    drawings,
    can_pay: !l.pv && online.enabled && !online.processing && Number(invoice.balance_due) > 0,
    processing: online.processing,
    from_stripe: online.imported,
    home: l.pv ? null : await homeLink(c, l.c, invoice.client_id),
  });
});

publicRoutes.post("/hub/:token/approve", async (c) => {
  const l = await link(c);
  if (l.t !== "quote") throw new HttpError(400, "Only quotes can be approved.");
  if (l.pv) throw new HttpError(400, "A preview can't approve the quote. Only the client's own link can.");
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(2).max(120),
      selected_line_ids: z.array(postedId).max(200).default([]),
      // Drawn on the screen (a small PNG of a size a signature pad makes); kept with the approval.
      signature: signatureImage.optional(),
      // The option they picked: required when the quote offers options.
      option_id: postedId.optional(),
      // The total they saw (core chosenTotals): the database turns the approval down if it's changed.
      expected_total: z.number().min(0).max(100_000_000).optional(),
      // The terms they read (core sectionsHash), and their initials for the sections that ask.
      sections_hash: sectionsHashSchema.optional(),
      initials: initialsImage.optional(),
    }),
  );
  const admin = adminClient(c.env);
  const quote = must(
    await admin
      .from("quotes")
      .select(
        "id, number, status, sent_at, created_at, total, deposit_amount, tax_rate, discount_amount, template_id, salesperson_id, option_id, section_ids, roof_package_id, range_low, priced_on_site_at, exact_sent_at, promo:promo_codes(kind, value), client:clients(display_name, billing_address), property:properties(line1, city, region, postal_code)",
      )
      .eq("company_id", l.c)
      .eq("id", l.id)
      .maybeSingle(),
    "Quote not found.",
  );
  if (!["sent", "changes_requested"].includes(quote.status)) throw new HttpError(409, "This quote can't be approved anymore.");
  // A price range isn't a price to sign: the client signs once the salesperson has set the exact one.
  if (inRangeMode(quote)) throw new HttpError(409, "This is a price range, not the final price. You'll sign once you've seen the exact price.");
  const [lineRows, options, business] = await Promise.all([
    admin.from("quote_line_items").select("id, option_id, quantity, unit_price, taxable, optional, selected, option_group").eq("company_id", l.c).eq("quote_id", l.id),
    loadOptions(admin, l.c, l.id),
    admin.from("companies").select("name, phone, timezone").eq("id", l.c).maybeSingle(),
  ]);
  const lines = must(lineRows);

  // The option they picked, when the quote offers options: one of this quote's, as it is now.
  let option: OptionRow | null = null;
  if (options.length || body.option_id) {
    if (!body.option_id) throw new HttpError(400, "Pick one of the options first.");
    option = options.find((o) => o.id === body.option_id) ?? null;
    if (!option) throw new HttpError(409, "The options on this estimate changed. Please look it over again.");
    if (!isPriced(option, lines)) throw new HttpError(409, "This option isn't priced yet. Pick another one, or ask us about it.");
  }
  // Add-ons only among the shared lines and the option's own; another option's are left off.
  const onIt = lines.filter((line) => line.option_id === null || line.option_id === option?.id);
  const picked = body.selected_line_ids.filter((id) => onIt.some((line) => line.id === id && line.optional));
  // Lines that share an option group ("Good", "Better" and "Best" roofs) are one choice: exactly one of them.
  const grouped = onIt.filter((line) => line.optional && line.option_group);
  for (const group of new Set(grouped.map((g) => g.option_group!))) {
    const count = grouped.filter((g) => g.option_group === group && picked.includes(g.id)).length;
    if (count !== 1) throw new HttpError(400, `Pick one of the choices for ${group}.`);
  }

  // The contract for the option they picked, from the business's own library, filled in as the page
  // showed it to them (the fingerprint it sent says so); then those words are kept with the approval,
  // with their initials.
  const template = await hubTemplate(admin, l.c, quote.template_id);
  const contract = await resolveContract(admin, l.c, { template, option, quoteSectionIds: quote.section_ids });
  const money = { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo };
  // {Total} says the price they agreed to: the total they saw, else what their choices come to.
  const total = body.expected_total ?? chosenTotals(lines, option?.id ?? null, quote.option_id, picked, money).total;
  // Without options, {Option} and {Warranty} say the package it was priced from, as the page showed them.
  const fill = option ?? (options.length ? null : await packageFill(admin, l.c, quote.roof_package_id));
  const facts = contractInput({ ...quote, total }, quote.client, quote.property, must(business, "Company not found."), template, fill);
  const tier = option ? optionTiers(options, lines, money).get(option.id) : null;
  checkContract(contract, body, { facts, option: option && freezeOption(option, tier) });
  const signedAt = new Date().toISOString();
  const kept = freezeContract({ contract, facts, option, tier, initials: body.initials ?? null, signedAt });

  // One step in the database (20261025000100_contracts_and_options.sql): it claims the quote while
  // it's still waiting for an answer, shows the option they picked, sets the add-ons to their
  // choices, checks the total still comes to what they saw, and records the approval with the
  // amounts they came to. So two approvals at once, or one racing a change by the office, record
  // one, and only that one picks the options. The business signs too when its salesperson has a
  // saved signature, so the signed estimate has both. The template is kept with the approval as it
  // is now, so the signed copy keeps the terms the client signed under.
  const company = await businessSignature(admin, l.c, quote, template);
  const { data: approved, error } = await admin.rpc("approve_hub_quote", {
    p_company: l.c,
    p_quote: l.id,
    p_selected: picked,
    p_approval: {
      name: body.name, selected_line_ids: picked, signature: body.signature ?? null, signed_at: signedAt, ip: clientIp(c),
      template: asJson(template),
      ...(company ? { company } : {}),
      option: asJson(kept.option),
      contract: asJson(kept.contract),
      initials: asJson(kept.initials),
    },
    ...(option ? { p_option: option.id } : {}),
    ...(body.expected_total !== undefined ? { p_expected_total: body.expected_total } : {}),
  });
  // A promo code whose minimum order their choices don't reach: nothing changed, and the message says what to do.
  if (error) throw error.code === "CX412" ? new HttpError(409, error.message) : dbError(error);
  if (!approved) {
    // Another approval got there first or the office closed it, else the total isn't the one they saw.
    const now = must(await admin.from("quotes").select("status").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "Quote not found.");
    const waiting = ["sent", "changes_requested"].includes(now.status);
    throw new HttpError(409, waiting && body.expected_total !== undefined ? "The price changed. Please look it over again." : "This quote can't be approved anymore.");
  }
  kickAutomations(c, l.c);
  return c.json({ status: "approved" });
});

publicRoutes.post("/hub/:token/request-changes", async (c) => {
  const l = await link(c);
  if (l.t !== "quote") throw new HttpError(400, "Only quotes can have changes requested.");
  if (l.pv) throw new HttpError(400, "A preview can't ask for changes. Only the client's own link can.");
  const body = await readJson(c, z.object({ message: z.string().trim().min(3).max(2000) }));
  const admin = adminClient(c.env);
  const quote = must(await admin.from("quotes").select("client_id, status").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "Quote not found.");
  if (quote.status !== "sent") throw new HttpError(409, "This quote isn't waiting for a response.");
  await admin.from("messages").insert({
    company_id: l.c, client_id: quote.client_id, channel: "note", direction: "in", status: "received",
    subject: "Changes requested", body: body.message, related_type: "quote", related_id: l.id, sent_by: null,
  });
  await admin.from("quotes").update({ status: "changes_requested" }).eq("id", l.id);
  kickAutomations(c, l.c);
  return c.json({ status: "changes_requested" });
});

/**
 * "Yes, send someone out": the client says yes to the price range, and the office is told to book
 * the site visit (the quote.range_accepted automation). It commits the client to nothing; they sign
 * once they've seen the exact price.
 */
publicRoutes.post("/hub/:token/accept-range", async (c) => {
  const l = await link(c);
  if (l.t !== "quote") throw new HttpError(400, "Only an estimate has a price range.");
  if (l.pv) throw new HttpError(400, "This is a preview, so nothing was sent.");
  // The option they're leaning toward, when the estimate offers options.
  const body = await readJson(c, z.object({ option_id: postedId.optional() }));
  if (!(await allow(c.env, `hub-range:${clientIp(c)}`, 20, 60 * 60))) throw new HttpError(429, "Too many tries. Try again later, or call us.");
  const admin = adminClient(c.env);
  if (body.option_id && !(await loadOptions(admin, l.c, l.id)).some((o) => o.id === body.option_id)) {
    throw new HttpError(409, "The options on this estimate changed. Please look it over again.");
  }
  // One step in the database (20261025000100_contracts_and_options.sql): only while the range is out
  // and nobody has priced it on site, and only once. The option they lean toward becomes the one
  // shown, and the office hears which.
  const { data: acceptedAt, error } = await admin.rpc("accept_hub_range", { p_company: l.c, p_quote: l.id, ...(body.option_id ? { p_option: body.option_id } : {}) });
  if (error) throw dbError(error);
  if (!acceptedAt) throw new HttpError(409, "This price range isn't waiting for an answer.");
  kickAutomations(c, l.c);
  return c.json({ accepted_at: acceptedAt });
});

// ---------------------------------------------------------------------------------------------
// Promo codes in the Client Hub: on a quote waiting for an answer, or an invoice not yet paid.
// ---------------------------------------------------------------------------------------------



async function hubDocument(c: Parameters<typeof appUrl>[0]) {
  const l = await link(c, ["quote", "invoice"]);
  if (l.pv) throw new HttpError(400, "Promo codes can't be added from a preview.");
  const admin = adminClient(c.env);
  const table = l.t === "quote" ? "quotes" : "invoices";
  must(await admin.from(table).select("id").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "This link isn't valid anymore.");
  return { l, admin, kind: l.t as "quote" | "invoice" };
}

publicRoutes.post("/hub/:token/promo", async (c) => {
  if (!(await allow(c.env, `promo:${clientIp(c)}`, 10, 10 * 60))) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
  const body = await readJson(
    c,
    z.object({
      code: z.string().trim().min(1, "Enter a promo code.").max(40),
      // On an estimate, what the client is choosing (the option they picked and the add-ons they
      // ticked), so the code's minimum order is checked against that rather than the option shown.
      option_id: postedId.optional(),
      selected_line_ids: z.array(postedId).max(200).optional(),
    }),
  );
  const { l, admin, kind } = await hubDocument(c);
  let choice = {};
  if (kind === "quote") {
    const quote = must(await admin.from("quotes").select("status, range_low, priced_on_site_at, exact_sent_at, option_id, promo_code_id, discount_amount").eq("company_id", l.c).eq("id", l.id).maybeSingle());
    if (!["sent", "changes_requested"].includes(quote.status)) throw new HttpError(409, "This quote isn't waiting for a response.");
    // The answer has the new total, and a range doesn't show the exact price yet.
    if (inRangeMode(quote)) throw new HttpError(409, "A promo code goes on the exact price. Mention it at the visit.");
    // A price agreed on site already has its discount in it (roofPackages.ts sitePriceSet).
    const lines = must(await admin.from("quote_line_items").select("option_id, name, service_id, formula, optional, selected").eq("company_id", l.c).eq("quote_id", l.id));
    if (sitePriceSet(quote, lines)) throw new HttpError(409, "Your price was set with you at the visit, so a promo code can't go on it. Give us a call about the code.");
    if (body.option_id && !(await loadOptions(admin, l.c, l.id)).some((o) => o.id === body.option_id)) {
      throw new HttpError(409, "The options on this estimate changed. Please look it over again.");
    }
    choice = { ...(body.option_id ? { p_option: body.option_id } : {}), ...(body.selected_line_ids ? { p_selected: body.selected_line_ids } : {}) };
  }
  const { data, error } = await admin.rpc("apply_promo_code", { p_kind: kind, p_id: l.id, p_code: body.code, ...choice });
  if (error) throw dbError(error);
  return c.json(data as Record<string, unknown>);
});

publicRoutes.delete("/hub/:token/promo", async (c) => {
  // Like putting one on: each change to what's owed is a new Stripe invoice for an invoice.
  if (!(await allow(c.env, `promo:${clientIp(c)}`, 10, 10 * 60))) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
  const { l, admin, kind } = await hubDocument(c);
  const { error } = await admin.rpc("remove_promo_code", { p_kind: kind, p_id: l.id });
  if (error) throw dbError(error);
  return c.json({ ok: true });
});

/** Pay from the Client Hub: Stripe's page for this invoice, which a client can only pay once. */
publicRoutes.post("/hub/:token/pay", async (c) => {
  const l = await link(c);
  if (l.t !== "invoice" || l.pv) throw new HttpError(400, "Only invoices can be paid.");
  // Each try can void a Stripe invoice and make another, so a script can't keep at it.
  if (!(await allow(c.env, `pay:ip:${clientIp(c)}`, 20, 10 * 60)) || !(await allow(c.env, `pay:invoice:${l.id}`, 10, 10 * 60))) {
    throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
  }
  const body = await readJson(c, z.object({ tip: z.number().min(0).max(100_000).default(0) }).default({ tip: 0 }));
  const admin = adminClient(c.env);
  const company = must(await admin.from("companies").select("settings->hub_tips").eq("id", l.c).maybeSingle());
  const online = await hubPayment(c.env, admin, l.c, l.id);
  const tipCents = (company as { hub_tips?: unknown }).hub_tips === true && !online.imported ? Math.round(body.tip * 100) : 0;
  try {
    return c.json({ url: await stripeCheckout(c.env, admin, l.c, l.id, tipCents) });
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
    console.error("Stripe checkout failed", error);
    throw new HttpError(502, "Online payments aren't working right now. Try again in a few minutes, or contact us to pay.");
  }
});

// ---------------------------------------------------------------------------------------------
// Public booking forms: /book/:company/:form in the web app
// ---------------------------------------------------------------------------------------------

async function findForm(c: Parameters<typeof appUrl>[0]) {
  const admin = adminClient(c.env);
  const company = must(await admin.from("companies").select("id, name, phone, timezone").eq("slug", c.req.param("company") ?? "").maybeSingle(), "Form not found.");
  const form = must(
    await admin
      .from("intake_forms")
      .select("id, name, kind, questions, service_area_zips, lead_time_days, slot_minutes")
      .eq("company_id", company.id)
      .eq("slug", c.req.param("form") ?? "")
      .eq("active", true)
      .maybeSingle(),
    "Form not found.",
  );
  return { admin, company, form };
}

publicRoutes.post("/public/forms/:company/:form/promo", async (c) => {
  if (!(await allow(c.env, `promo:${clientIp(c)}`, 10, 10 * 60))) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
  const { code } = await readJson(c, z.object({ code: z.string().trim().min(1, "Enter a promo code.").max(40) }));
  const { admin, company } = await findForm(c);
  const { data, error } = await admin.rpc("check_promo_code", { p_company: company.id, p_code: code });
  if (error) throw dbError(error);
  return c.json({ code: code.toUpperCase().replace(/\s/g, ""), offer: data });
});

publicRoutes.get("/public/forms/:company/:form", async (c) => {
  const { company, form } = await findForm(c);
  return c.json({ company: { name: company.name, phone: company.phone }, form: { name: form.name, kind: form.kind, questions: form.questions } });
});

// Answers to a form's questions: text, or the options picked. Sized well past what a form asks (up
// to 30 questions, 4,000 characters for a long answer), so a script can't store megabytes with each.
const formAnswers = z
  .record(z.string().max(100), z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(500)).max(50)]))
  .refine((answers) => Object.keys(answers).length <= 50 && JSON.stringify(answers).length <= 50_000, "Too many answers.");

// Files sent with a request (a "Files" or "Photos" question): what the visitor picked, before uploading.
const MAX_FORM_FILES = 10;
const formFiles = z
  .array(z.object({ question: z.string().max(100), name: z.string().trim().min(1).max(255), size: z.number().int().positive().max(UPLOAD_LIMIT), type: z.string().max(150).optional() }))
  .max(MAX_FORM_FILES, `Send up to ${MAX_FORM_FILES} files with a request.`)
  .default([]);
interface FilesToken { purpose: "form-files"; c: string; r: string; f: Array<{ path: string; name: string; type?: string }>; exp: number }
const fileExtension = (name: string) => name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? "bin";
const fileTitle = (name: string) => name.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "File";

publicRoutes.post("/public/forms/:company/:form", async (c) => {
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(2).max(120),
      email: z.email().optional(),
      phone: z.string().trim().min(7).max(30).optional(),
      address: z.object({ line1: z.string().trim().min(3).max(200), city: z.string().max(100).optional(), postal_code: z.string().max(12).optional() }),
      answers: formAnswers.default({}),
      files: formFiles,
      promo_code: z.string().trim().max(40).optional(),
      turnstile_token: z.string().optional(),
    }),
  );
  if (!body.email && !body.phone) throw new HttpError(400, "Add an email or phone number so we can reach you.");

  await verifyTurnstile(c, body.turnstile_token);

  const { admin, company, form } = await findForm(c);
  await limitSubmissions(c, "form", company.id);
  const zips = (form.service_area_zips ?? []) as string[];
  // A code that doesn't check out is dropped rather than blocking the request.
  let promo: string | null = null;
  if (body.promo_code) {
    const { error } = await admin.rpc("check_promo_code", { p_company: company.id, p_code: body.promo_code });
    if (!error) promo = body.promo_code.toUpperCase().replace(/\s/g, "");
  }
  if (zips.length && !zips.includes((body.address.postal_code ?? "").slice(0, 5))) {
    throw new HttpError(400, `Sorry, ${company.name} doesn't serve that area yet.`);
  }
  // Files only for this form's file questions.
  const fileQuestions = new Set(((form.questions ?? []) as Array<{ key: string; type: string }>).filter((q) => q.type === "files" || q.type === "photos").map((q) => q.key));
  if (body.files.some((f) => !fileQuestions.has(f.question))) throw new HttpError(400, "This form doesn't take files.");

  const client = must(
    await admin
      .from("clients")
      .insert({ company_id: company.id, status: "lead", display_name: body.name, email: body.email, phone: body.phone, lead_source: "Website form" })
      .select("id")
      .single(),
  );
  const property = must(
    await admin
      .from("properties")
      .insert({ company_id: company.id, client_id: client.id, line1: body.address.line1, city: body.address.city, postal_code: body.address.postal_code })
      .select("id")
      .single(),
  );
  // The website visit that brought them in, when the business counts its website's visits (Apps).
  const visit = await bookingVisit(c, company.id);
  const request = must(
    await admin
      .from("requests")
      .insert({
        company_id: company.id, client_id: client.id, property_id: property.id, intake_form_id: form.id,
        source: "web_form", title: form.name, answers: asJson(body.answers), promo_code: promo, created_by: null, web_visit: visit,
      })
      .select("id, number")
      .single(),
  );
  geocodeLater(c, property.id, body.address);
  kickAutomations(c, company.id);
  if (!body.files.length) return c.json({ ok: true, reference: request.number }, 201);

  // The request is in. Each file goes straight to Storage on a link that works once (and is
  // checked against Storage's size limit there); /files then records the ones that arrived.
  const uploads = await Promise.all(
    body.files.map(async (f) => {
      const path = `${company.id}/plans/${crypto.randomUUID()}.${fileExtension(f.name)}`;
      const { data, error } = await admin.storage.from("files").createSignedUploadUrl(path);
      if (error || !data) return null;
      return { name: f.name, type: f.type, path, token: data.token };
    }),
  );
  const ready = uploads.filter((u): u is NonNullable<typeof u> => Boolean(u));
  const filesToken = await signToken(c.env, {
    purpose: "form-files", c: company.id, r: request.id, f: ready.map(({ path, name, type }) => ({ path, name, type })), exp: Math.floor(Date.now() / 1000) + 3 * 60 * 60,
  } satisfies FilesToken);
  // In the order the files were sent, null where Storage couldn't make a link.
  return c.json({ ok: true, reference: request.number, uploads: uploads.map((u) => u && { name: u.name, path: u.path, token: u.token }), files_token: filesToken }, 201);
});

/** After the uploads: the files that arrived go on the request (and its property) in Plans and files. */
publicRoutes.post("/public/forms/:company/:form/files", async (c) => {
  if (!(await allow(c.env, `form-files:ip:${clientIp(c)}`, 30, 60 * 60))) throw new HttpError(429, "Too many requests. Try again later, or call us.");
  const body = await readJson(c, z.object({ files_token: z.string().max(12_000), uploaded: z.array(z.string().max(200)).max(MAX_FORM_FILES) }));
  const token = await verifyToken<FilesToken>(c.env, body.files_token);
  const { admin, company } = await findForm(c);
  if (!token || token.purpose !== "form-files" || token.c !== company.id) throw new HttpError(400, "That upload has run out. Send the files to us another way.");
  const rows = [];
  for (const f of token.f.filter((f) => body.uploaded.includes(f.path))) {
    // Only what's really there, at the size Storage took it.
    const { data: info } = await admin.storage.from("files").info(f.path);
    if (!info) continue;
    rows.push({
      company_id: company.id, request_id: token.r, title: fileTitle(f.name), path: f.path, file_name: f.name.slice(0, 255),
      content_type: (info.contentType ?? f.type ?? null)?.slice(0, 150) ?? null, size_bytes: info.size ?? null, crew_visible: true, created_by: null,
    });
  }
  if (rows.length) {
    const { error } = await admin.from("plan_files").upsert(rows, { onConflict: "path", ignoreDuplicates: true });
    if (error) throw dbError(error);
  }
  return c.json({ added: rows.length });
});

// ---------------------------------------------------------------------------------------------
// Stripe webhooks
// ---------------------------------------------------------------------------------------------

// Payments, refunds, disputes and deposits, and invoices made in Stripe (integrations/stripe.ts).
// A company with its own key has its own address and signing secret; STRIPE_WEBHOOK_SECRET is the
// deployment's.
async function stripeWebhook(c: Context<AppEnv>, route: WebhookRoute, secret: string | undefined) {
  if (!secret) throw new HttpError(501, "Stripe webhooks aren't configured.");
  const payload = await c.req.text();
  if (!(await verifyStripeSignature(payload, c.req.header("stripe-signature"), secret))) throw new HttpError(400, "Bad signature.");
  const admin = adminClient(c.env);
  const companyId = await handleStripeEvent(c.env, admin, route, JSON.parse(payload) as StripeEvent);
  if (companyId) kickAutomations(c, companyId);
  if (route.companyId) {
    await admin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_error: null }).match({ company_id: route.companyId, provider: "stripe" });
  }
  return c.json({ received: true });
}

publicRoutes.post("/webhooks/stripe", (c) => stripeWebhook(c, {}, c.env.STRIPE_WEBHOOK_SECRET));

publicRoutes.post("/webhooks/stripe/:company", async (c) => {
  const companyId = c.req.param("company");
  if (!uuid.safeParse(companyId).success) throw new HttpError(404, "Not found");
  const access = await stripeAccess(c.env, adminClient(c.env), companyId);
  return stripeWebhook(c, { companyId }, access?.own ? access.webhookSecret : undefined);
});

// ---------------------------------------------------------------------------------------------
// Client Hub home: a client's open quotes, invoices and upcoming visits, and "request work"
// ---------------------------------------------------------------------------------------------

const homeLink = (c: Parameters<typeof appUrl>[0], companyId: string, clientId: string) => clientLink(c.env, appUrl(c), { c: companyId, t: "client", id: clientId });
const firstNames = (rows: Array<{ user_id: string }>, names: Map<string, string>) => rows.map((r) => names.get(r.user_id)).filter(Boolean) as string[];

async function clientHome(c: Parameters<typeof appUrl>[0], admin: ReturnType<typeof adminClient>, companyId: string, clientId: string, company: unknown) {
  const client = must(await admin.from("clients").select("id, display_name, properties(id, line1, city)").eq("company_id", companyId).eq("id", clientId).maybeSingle(), "This link isn't valid anymore.");
  const settings = must(await admin.from("companies").select("timezone, settings").eq("id", companyId).maybeSingle());
  const today = new Date().toLocaleDateString("en-CA", { timeZone: settings.timezone || "UTC" });
  const [quotes, invoices, jobs, payments, requests, services] = await Promise.all([
    admin.from("quotes").select("id, number, title, status, total, tax_rate, discount_amount, valid_until, sent_at, approved_at, range_low, range_high, range_accepted_at, priced_on_site_at, exact_sent_at, promo:promo_codes(kind, value)").eq("company_id", companyId).eq("client_id", clientId).in("status", ["sent", "changes_requested", "approved", "converted"]).order("created_at", { ascending: false }).limit(20),
    admin.from("invoices").select("id, number, subject, status, total, balance_due, due_on, issued_on").eq("company_id", companyId).eq("client_id", clientId).in("status", ["sent", "partially_paid", "overdue", "paid"]).order("issued_on", { ascending: false }).limit(20),
    admin.from("jobs").select("id").eq("company_id", companyId).eq("client_id", clientId),
    admin.from("payments").select("amount, tip_amount, method, received_at, invoice:invoices(number)").eq("company_id", companyId).eq("client_id", clientId).gt("amount", 0).order("received_at", { ascending: false }).limit(5),
    admin.from("requests").select("number, title, status, created_at").eq("company_id", companyId).eq("client_id", clientId).in("status", ["new", "assessment_scheduled", "assessment_complete"]).order("created_at", { ascending: false }).limit(5),
    admin.from("services").select("category").eq("company_id", companyId).eq("active", true).not("category", "is", null).limit(200),
  ]);
  // The options and lines of the quotes still waiting for an answer that show a price: one that offers
  // options says how many and the lowest (services/sales.ts optionsFrom), not the option shown.
  const waiting = (quotes.data ?? []).filter((q) => !["approved", "converted"].includes(q.status) && !hidesExactPrice(q)).map((q) => q.id);
  const [optionRows, lineRows] = waiting.length
    ? await Promise.all([
        admin.from("quote_options").select("id, quote_id").eq("company_id", companyId).in("quote_id", waiting),
        admin.from("quote_line_items").select("quote_id, option_id, quantity, unit_price, taxable, optional, selected").eq("company_id", companyId).in("quote_id", waiting),
      ])
    : [{ data: [] }, { data: [] }];
  const offerOf = (q: NonNullable<typeof quotes.data>[number]) => {
    const options = (optionRows.data ?? []).filter((o) => o.quote_id === q.id);
    return options.length ? optionsFrom({ ...q, options, lines: (lineRows.data ?? []).filter((line) => line.quote_id === q.id) }) : null;
  };
  const jobIds = (jobs.data ?? []).map((j) => j.id);
  const visitFields = "id, title, scheduled_on, starts_at, ends_at, status, completed_at, property:properties(line1), assignees:visit_assignees(user_id)";
  const [upcoming, done] = jobIds.length
    ? await Promise.all([
        admin.from("visits").select(visitFields).eq("company_id", companyId).in("job_id", jobIds).in("status", ["scheduled", "en_route", "in_progress"]).gte("scheduled_on", today).order("scheduled_on").order("starts_at", { nullsFirst: false }).limit(10),
        admin.from("visits").select(visitFields).eq("company_id", companyId).in("job_id", jobIds).eq("status", "completed").order("completed_at", { ascending: false, nullsFirst: false }).limit(5),
      ])
    : [{ data: [] }, { data: [] }];
  // Crews by first name only. A sub is named from the office's record (their contact's first name),
  // never their profile, which they keep themselves; a sub with no contact name isn't named.
  const people = [...new Set([...(upcoming.data ?? []), ...(done.data ?? [])].flatMap((v) => (v.assignees as Array<{ user_id: string }>).map((a) => a.user_id)))];
  const names = new Map<string, string>();
  if (people.length) {
    const [profiles, subLogins] = await Promise.all([
      admin.from("profiles").select("user_id, full_name").in("user_id", people),
      admin.from("memberships").select("user_id, subcontractor_id").eq("company_id", companyId).in("user_id", people).not("subcontractor_id", "is", null),
    ]);
    const subOf = new Map((subLogins.data ?? []).map((m) => [m.user_id, m.subcontractor_id as string]));
    const subs = subOf.size
      ? (await admin.from("subcontractors").select("id, contact_name").eq("company_id", companyId).in("id", [...new Set(subOf.values())])).data ?? []
      : [];
    const contactOf = new Map(subs.map((x) => [x.id, x.contact_name]));
    for (const id of people) {
      const sub = subOf.get(id);
      const name = sub ? contactOf.get(sub) : (profiles.data ?? []).find((p) => p.user_id === id)?.full_name;
      const first = name?.trim().split(/\s+/)[0];
      if (first) names.set(id, first);
    }
  }
  const visit = (v: NonNullable<typeof upcoming.data>[number]) => ({
    id: v.id, title: v.title, scheduled_on: v.scheduled_on, starts_at: v.starts_at, ends_at: v.ends_at, status: v.status, completed_at: v.completed_at,
    address: (v.property as unknown as { line1: string } | null)?.line1 ?? null,
    crew: firstNames(v.assignees as Array<{ user_id: string }>, names),
  });

  const base = appUrl(c);
  const sign = (t: "quote" | "invoice", id: string) => clientLink(c.env, base, { c: companyId, t, id });
  const companySettings = (settings.settings ?? {}) as { referral_offer?: string; referral_reward?: { amount?: number } };
  // Referrals are Marketing's: uninstalled, the Hub stops offering them (links already shared still open).
  const referralOn = marketingOn(companySettings) && Boolean(companySettings.referral_offer || Number(companySettings.referral_reward?.amount ?? 0) > 0);
  return {
    kind: "client",
    company,
    client: { name: client.display_name, first_name: firstName(client.display_name), properties: client.properties },
    // A quote out as a price range shows the range, never its exact total. One that offers options
    // shows how many and the lowest price (`options`) until the client chooses, never as a total.
    quotes: await Promise.all(
      (quotes.data ?? []).map(async (q) => {
        const ranged = inRangeMode(q);
        const offer = offerOf(q);
        return {
          id: q.id, number: q.number, title: q.title, status: q.status, valid_until: q.valid_until, sent_at: q.sent_at, approved_at: q.approved_at,
          total: ranged || hidesExactPrice(q) || offer ? null : q.total,
          range: ranged ? { low: Number(q.range_low), high: Number(q.range_high), accepted_at: q.range_accepted_at } : null,
          options: offer,
          link: await sign("quote", q.id),
        };
      }),
    ),
    invoices: await Promise.all((invoices.data ?? []).map(async (i) => ({ ...i, link: await sign("invoice", i.id) }))),
    visits: (upcoming.data ?? []).map(visit),
    past_visits: (done.data ?? []).map(visit),
    payments: (payments.data ?? []).map((p) => ({ amount: p.amount, tip_amount: p.tip_amount, method: p.method, received_at: p.received_at, invoice: (p.invoice as unknown as { number: number } | null)?.number ?? null })),
    requests: requests.data ?? [],
    services: [...new Set((services.data ?? []).map((s) => s.category as string))].slice(0, 8),
    refer: referralOn ? { link: await clientLink(c.env, base, { c: companyId, t: "refer", id: clientId }), offer: companySettings.referral_offer ?? null } : null,
  };
}

// A message to the office from the portal (also used for "ask to change a visit").
publicRoutes.post("/hub/:token/message", async (c) => {
  if (!(await allow(c.env, `hub-message:${clientIp(c)}`, 20, 60 * 60))) throw new HttpError(429, "Too many messages. Try again later, or call us.");
  const l = await link(c);
  if (l.pv) throw new HttpError(400, "Messages can't be sent from a preview.");
  const body = await readJson(c, z.object({ message: z.string().trim().min(2, "Write a message first.").max(4000), visit_id: z.uuid().optional() }));
  const admin = adminClient(c.env);
  const clientId =
    l.t === "client"
      ? l.id
      : must(await admin.from(l.t === "quote" ? "quotes" : "invoices").select("client_id").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "This link isn't valid anymore.").client_id;
  must(await admin.from("clients").select("id").eq("company_id", l.c).eq("id", clientId).maybeSingle(), "This link isn't valid anymore.");
  let subject = "Message from the client portal";
  let related: { related_type: string; related_id: string } | Record<string, never> = l.t === "client" ? {} : { related_type: l.t, related_id: l.id };
  if (body.visit_id) {
    const visit = must(await admin.from("visits").select("id, title, scheduled_on, job:jobs(client_id)").eq("company_id", l.c).eq("id", body.visit_id).maybeSingle(), "Visit not found.");
    if ((visit.job as unknown as { client_id: string } | null)?.client_id !== clientId) throw new HttpError(404, "Visit not found.");
    subject = `Asked to change the visit on ${visit.scheduled_on ?? "an unscheduled day"}: ${visit.title}`;
    related = { related_type: "visit", related_id: visit.id };
  }
  const { error } = await admin.from("messages").insert({
    company_id: l.c, client_id: clientId, channel: "note", direction: "in", status: "received", subject, body: body.message, sent_by: null, ...related,
  });
  if (error) throw dbError(error);
  return c.json({ ok: true }, 201);
});

/**
 * A file from the files bucket, read only up to `max` bytes: null when it isn't there or is larger,
 * which is never read whole. These routes answer anyone, and the folders they read can hold what a
 * member uploads straight to Storage (up to its 200 MB limit), so a request never makes the server
 * hold more than a picture's worth.
 */
async function storedFile(admin: ReturnType<typeof adminClient>, path: string, max: number): Promise<Uint8Array | null> {
  const { data, error } = await admin.storage.from("files").download(path).asStream();
  if (error || !data) return null;
  const reader = data.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    // Storage stopped partway: as good as not there.
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** A map drawing's picture is a JPEG of the map (MeasurePage), a few hundred KB to a few MB. */
const DRAWING_MAX_BYTES = 20_000_000;

// The picture of a map drawing on a quote or invoice. Only drawings shown to the client, and only
// through the link to the quote or invoice they're on.
publicRoutes.get("/hub/:token/drawings/:file", async (c) => {
  const l = await link(c, ["quote", "invoice"]);
  const id = (c.req.param("file") ?? "").replace(/\.jpg$/i, "");
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "Drawing not found.");
  const admin = adminClient(c.env);
  const drawing = must(await admin.from("measurements").select("snapshot_path, show_on_quote, show_on_invoice, quote_id, invoice_id").eq("company_id", l.c).eq("id", id).maybeSingle(), "Drawing not found.");
  const shown = l.t === "quote" ? drawing.show_on_quote && drawing.quote_id === l.id : drawing.show_on_invoice && drawing.invoice_id === l.id;
  if (!shown || !drawing.snapshot_path) throw new HttpError(404, "Drawing not found.");
  // A member uploads it straight to Storage, so only a picture goes out, as the picture it is.
  const bytes = await storedFile(admin, drawing.snapshot_path, DRAWING_MAX_BYTES);
  const type = bytes && (isJpeg(bytes) ? "image/jpeg" : isPng(bytes) ? "image/png" : null);
  if (!bytes || !type) throw new HttpError(404, "Drawing not found.");
  return c.body(bytes, 200, { "Content-Type": type, "Cache-Control": "private, max-age=3600" });
});

// The company's logo (services/logo.ts), on the Client Hub and in emails. A logo's file name is
// never reused, so the current one is kept for good; an older one (in an email sent before the logo
// changed) gets the current logo.
publicRoutes.get("/public/logo/:company/:file", async (c) => {
  const companyId = c.req.param("company");
  const file = (c.req.param("file") ?? "").replace(/\.png$/i, "");
  if (!z.uuid().safeParse(companyId).success || !z.uuid().safeParse(file).success) throw new HttpError(404, "Logo not found.");
  const admin = adminClient(c.env);
  const { data: company } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  const path = company ? logoOf(company.settings, companyId) : null;
  if (!path) throw new HttpError(404, "Logo not found.");
  const bytes = await storedFile(admin, path, LOGO_MAX_BYTES);
  if (!bytes || !isPng(bytes)) throw new HttpError(404, "Logo not found.");
  const current = path === `${companyId}/logo/${file}.png`;
  return c.body(bytes, 200, { "Content-Type": "image/png", "Cache-Control": current ? "public, max-age=31536000, immutable" : "public, max-age=3600" });
});

// A picture of the business's own letterhead (services/letterhead.ts), on its estimates and invoices
// on the Client Hub. Any it ever added, so a signed estimate keeps the letterhead it was signed on. A
// file name is never reused and the file never changes, so it's kept for good. Only as large as the
// server saves one: anything bigger in the folder never came from it.
publicRoutes.get("/public/letterhead/:company/:file", async (c) => {
  const companyId = c.req.param("company");
  const file = (c.req.param("file") ?? "").replace(/\.png$/i, "");
  if (!z.uuid().safeParse(companyId).success || !z.uuid().safeParse(file).success) throw new HttpError(404, "Letterhead not found.");
  const bytes = await storedFile(adminClient(c.env), `${companyId}/letterhead/${file}.png`, LETTERHEAD_MAX_BYTES);
  if (!bytes || !isPng(bytes)) throw new HttpError(404, "Letterhead not found.");
  return c.body(bytes, 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" });
});

// A package's picture (its own, or the one an option was offered with) on the Client Hub and the
// paper: any the business ever added, so a signed estimate keeps the picture it was offered with. A
// file name is never reused and the file never changes, so it's kept for good. Only as large as the
// server saves one (services/packagePictures.ts): anything bigger in the folder never came from it.
publicRoutes.get("/public/package/:company/:file", async (c) => {
  const companyId = c.req.param("company");
  const file = (c.req.param("file") ?? "").replace(/\.jpg$/i, "");
  if (!z.uuid().safeParse(companyId).success || !z.uuid().safeParse(file).success) throw new HttpError(404, "Picture not found.");
  const bytes = await storedFile(adminClient(c.env), `${companyId}/packages/${file}.jpg`, PACKAGE_PICTURE_MAX_BYTES);
  if (!bytes || !isJpeg(bytes)) throw new HttpError(404, "Picture not found.");
  return c.body(bytes, 200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" });
});

// A price list item's picture on the iPad's site visit, as a package's is: kept for good under a
// name never reused, and only as large as the server saves one.
publicRoutes.get("/public/service/:company/:file", async (c) => {
  const companyId = c.req.param("company");
  const file = (c.req.param("file") ?? "").replace(/\.jpg$/i, "");
  if (!z.uuid().safeParse(companyId).success || !z.uuid().safeParse(file).success) throw new HttpError(404, "Picture not found.");
  const bytes = await storedFile(adminClient(c.env), `${companyId}/services/${file}.jpg`, PACKAGE_PICTURE_MAX_BYTES);
  if (!bytes || !isJpeg(bytes)) throw new HttpError(404, "Picture not found.");
  return c.body(bytes, 200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" });
});

// "Add to calendar" for one of the client's visits.
publicRoutes.get("/hub/:token/visits/:file", async (c) => {
  const l = await link(c, ["client"]);
  const id = (c.req.param("file") ?? "").replace(/\.ics$/i, "");
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "Visit not found.");
  const admin = adminClient(c.env);
  const visit = must(
    await admin.from("visits").select("id, title, scheduled_on, starts_at, ends_at, status, job:jobs(client_id), property:properties(line1, city), company:companies(name)").eq("company_id", l.c).eq("id", id).maybeSingle(),
    "Visit not found.",
  );
  if ((visit.job as unknown as { client_id: string } | null)?.client_id !== l.id || !visit.scheduled_on) throw new HttpError(404, "Visit not found.");
  const place = visit.property as unknown as { line1: string; city: string | null } | null;
  const companyName = (visit.company as unknown as { name: string }).name;
  const ics = buildCalendar(companyName, [
    {
      uid: `${visit.id}@crewtavo`,
      title: `${companyName}: ${visit.title}`,
      ...(visit.starts_at && visit.ends_at ? { start: new Date(visit.starts_at), end: new Date(visit.ends_at) } : { date: visit.scheduled_on }),
      location: place ? [place.line1, place.city].filter(Boolean).join(", ") : null,
      cancelled: visit.status === "cancelled",
    },
  ]);
  return c.body(ics, 200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="visit.ics"' });
});

publicRoutes.post("/hub/:token/request", async (c) => {
  const l = await link(c, ["client"]);
  const body = await readJson(
    c,
    z.object({
      title: z.string().trim().min(3).max(200),
      details: z.string().trim().max(4000).optional(),
      property_id: z.uuid().optional(),
      timing: z.enum(["asap", "month", "flexible"]).optional(),
      promo_code: z.string().trim().max(40).optional(),
    }),
  );
  await limitSubmissions(c, "hub-request", l.c);
  const admin = adminClient(c.env);
  must(await admin.from("clients").select("id").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "This link isn't valid anymore.");
  if (body.property_id) {
    must(await admin.from("properties").select("id").eq("company_id", l.c).eq("client_id", l.id).eq("id", body.property_id).maybeSingle(), "That address isn't on your account.");
  }
  let promo: string | null = null;
  if (body.promo_code) {
    // The answer says whether a code is real, so this counts toward the same limit as checking one.
    if (!(await allow(c.env, `promo:${clientIp(c)}`, 10, 10 * 60))) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
    const { error } = await admin.rpc("check_promo_code", { p_company: l.c, p_code: body.promo_code });
    if (error) throw dbError(error);
    promo = body.promo_code.toUpperCase().replace(/\s/g, "");
  }
  const request = must(
    await admin
      .from("requests")
      .insert({
        company_id: l.c, client_id: l.id, property_id: body.property_id ?? null, source: "hub", title: body.title, details: body.details ?? null, created_by: null,
        answers: body.timing ? { when: { asap: "As soon as possible", month: "In the next month", flexible: "Flexible" }[body.timing] } : {},
        promo_code: promo,
      })
      .select("number")
      .single(),
  );
  kickAutomations(c, l.c);
  return c.json({ ok: true, reference: request.number }, 201);
});

// ---------------------------------------------------------------------------------------------
// Marketing: unsubscribe, review link clicks and referral pages
// ---------------------------------------------------------------------------------------------

publicRoutes.get("/public/unsubscribe/:token", async (c) => {
  const l = await link(c, ["unsub"]);
  const admin = adminClient(c.env);
  const [company, client] = await Promise.all([
    admin.from("companies").select("name").eq("id", l.c).maybeSingle(),
    admin.from("clients").select("marketing_opt_out").eq("company_id", l.c).eq("id", l.id).maybeSingle(),
  ]);
  if (!company.data || !client.data) throw new HttpError(404, "This link isn't valid anymore.");
  return c.json({ company: company.data.name, unsubscribed: client.data.marketing_opt_out });
});

publicRoutes.post("/public/unsubscribe/:token", async (c) => {
  const l = await link(c, ["unsub"]);
  const body = (await c.req.json().catch(() => null)) as { resubscribe?: unknown } | null;
  const resubscribe = body?.resubscribe === true;
  const { error } = await adminClient(c.env).from("clients").update({ marketing_opt_out: !resubscribe }).eq("company_id", l.c).eq("id", l.id);
  if (error) throw dbError(error);
  return c.json({ unsubscribed: !resubscribe });
});

/**
 * Tracked review link: record the click, which stops its reminders, then send the client to the
 * review page. It works with Marketing uninstalled too: the client asked for nothing.
 */
publicRoutes.get("/public/r/:token", async (c) => {
  const payload = await readClientLink(c.env, c.req.param("token") ?? "");
  if (!payload || payload.t !== "review") return c.text("This link has expired.", 404);
  const admin = adminClient(c.env);
  const { data: company } = await admin.from("companies").select("settings").eq("id", payload.c).maybeSingle();
  const url = (company?.settings as { review_url?: string } | null)?.review_url;
  if (!url || !/^https:\/\//.test(url)) return c.text("This business hasn't set up reviews yet.", 404);
  await admin
    .from("review_requests")
    .update({ status: "clicked", clicked_at: new Date().toISOString(), next_reminder_at: null })
    .eq("company_id", payload.c)
    .eq("id", payload.id)
    .is("clicked_at", null);
  return c.redirect(url, 302);
});

publicRoutes.get("/public/refer/:token", async (c) => {
  const l = await link(c, ["refer"]);
  const admin = adminClient(c.env);
  const [company, client] = await Promise.all([
    admin.from("companies").select("name, phone, website, settings").eq("id", l.c).maybeSingle(),
    admin.from("clients").select("display_name").eq("company_id", l.c).eq("id", l.id).maybeSingle(),
  ]);
  if (!company.data || !client.data) throw new HttpError(404, "This referral link isn't valid anymore.");
  const settings = (company.data.settings ?? {}) as { referral_offer?: string };
  return c.json({
    company: { name: company.data.name, phone: company.data.phone, website: company.data.website, logo: logoImage("", l.c, company.data.settings)?.src ?? null },
    referrer: firstName(client.data.display_name),
    offer: settings.referral_offer ?? null,
  });
});

publicRoutes.post("/public/refer/:token", async (c) => {
  const l = await link(c, ["refer"]);
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(2).max(120),
      email: z.email().optional(),
      phone: z.string().trim().min(7).max(30).optional(),
      address: z.object({ line1: z.string().trim().min(3).max(200), city: z.string().trim().max(100).optional(), postal_code: z.string().trim().max(12).optional() }),
      details: z.string().trim().max(4000).optional(),
      turnstile_token: z.string().optional(),
    }),
  );
  if (!body.email && !body.phone) throw new HttpError(400, "Add an email or phone number so we can reach you.");
  await verifyTurnstile(c, body.turnstile_token);
  await limitSubmissions(c, "referral", l.c);
  const admin = adminClient(c.env);
  const referrer = must(await admin.from("clients").select("id, display_name").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "This referral link isn't valid anymore.");
  const { data: company } = await admin.from("companies").select("settings").eq("id", l.c).maybeSingle();
  const reward = Number((company?.settings as { referral_reward?: { amount?: number } } | null)?.referral_reward?.amount ?? 0);

  const client = must(
    await admin
      .from("clients")
      .insert({ company_id: l.c, status: "lead", display_name: body.name, email: body.email, phone: body.phone, lead_source: "Referral", referred_by: referrer.id })
      .select("id")
      .single(),
  );
  const property = must(
    await admin.from("properties").insert({ company_id: l.c, client_id: client.id, line1: body.address.line1, city: body.address.city, postal_code: body.address.postal_code }).select("id").single(),
  );
  const request = must(
    await admin
      .from("requests")
      .insert({ company_id: l.c, client_id: client.id, property_id: property.id, source: "referral", title: `Referral from ${referrer.display_name}`, details: body.details ?? null, created_by: null })
      .select("id, number")
      .single(),
  );
  await admin.from("referrals").insert({
    company_id: l.c, referrer_client_id: referrer.id, referred_client_id: client.id, request_id: request.id, referred_name: body.name,
    reward_amount: Math.max(0, reward), reward_status: reward > 0 ? "pending" : "none",
  });
  geocodeLater(c, property.id, body.address);
  kickAutomations(c, l.c);
  return c.json({ ok: true, reference: request.number }, 201);
});
