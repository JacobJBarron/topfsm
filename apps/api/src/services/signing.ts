/**
 * Signatures on estimates: each person's saved signature (one per business they work for), an
 * estimate the homeowner signs in person on the salesperson's iPad, the business's signature added
 * after (an estimate signed online, before anyone signed for the business), and the signed copy sent
 * to the client as a long-lived link to the Client Hub, which shows the signed document.
 *
 * Everything runs with the person's own client, so row-level security applies: only people who sell
 * (SALES with the sales area) change quotes, and a person only ever reads or writes their own saved
 * signature. The contract signed with it (the option chosen, the sections and the homeowner's
 * initials) is checked and kept the same way as online, by services/contracts.ts.
 */
import { pickTemplate } from "@crewtavo/core/documents";
import { countsOn } from "@crewtavo/core/money";
import { z } from "zod";
import type { Env } from "../env";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { asJson, dbError, HttpError, must } from "../lib/http";
import { clientLinks, sentToClient } from "../lib/links";
import { reportError } from "../lib/monitoring";
import { sendEmail, sendSms } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { companyAddress } from "./automations";
import { checkContract, contractInput, freezeContract, freezeOption, initialsImage, isPriced, loadOptions, optionTiers, packageFill, postedId, resolveContract, sectionsHashSchema, type OptionRow } from "./contracts";
import { isDrawnPng, logoImage } from "./logo";
import { noteRefusedText, textsOffRefusal, textsOffTo } from "./textsOff";

/** Who's signing, where: the person's client, their company and user, and the address links use. */
export interface SigningScope {
  db: Db;
  env: Env;
  companyId: string;
  userId: string;
  baseUrl: string;
}

/**
 * A drawn signature: a PNG data URL, as SignaturePad makes it (a few to a few hundred KB), of a size a
 * signature pad makes (logo.ts isDrawnPng). Online (routes/public.ts) and on the iPad alike.
 */
export const signatureImage = z.string().max(300_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).refine(isDrawnPng);

export const saveSignatureSchema = z.object({ image: signatureImage });

export const signSchema = z.object({
  /** The customer's printed name. */
  name: z.string().trim().min(2).max(120),
  signature: signatureImage,
  /** The salesperson's signature for the business, drawn now; else their saved one is used. */
  company_signature: signatureImage.optional(),
  save_signature: z.boolean().optional(),
  email_copy: z.boolean().optional(),
  /** Where to email the copy; the client's email when left out. */
  to: z.string().trim().max(200).optional(),
  /** The option they chose (the one shown on the visit page): required when the quote offers options. */
  option_id: postedId.optional(),
  /** The total on the paper they signed: it's only signed while the quote still comes to it. */
  expected_total: z.number().min(0).max(100_000_000).optional(),
  /** The terms on the paper (core sectionsHash), and the homeowner's initials for the sections that ask. */
  sections_hash: sectionsHashSchema.optional(),
  initials: initialsImage.optional(),
});
export type SignBody = z.infer<typeof signSchema>;

export const countersignSchema = z.object({ signature: signatureImage.optional(), save_signature: z.boolean().optional() });
export type CountersignBody = z.infer<typeof countersignSchema>;

export const copySchema = z.object({ channel: z.enum(["email", "sms"]), to: z.string().trim().max(200).optional() });
export type CopyBody = z.infer<typeof copySchema>;

/** Statuses a quote can be signed from, and the ones that mean it's signed. */
const OPEN = ["draft", "sent", "changes_requested"];
const SIGNED = ["approved", "converted"];
/** How long the link in the signed copy works: a year, so the client can find it again. */
const COPY_DAYS = 365;

/** What changed when the database won't sign: the option shown, or the total, isn't what was on the paper. */
const CHANGED = "The option or the price changed. Check it again.";

const QUOTE_FIELDS =
  "id, number, status, title, client_id, template_id, salesperson_id, option_id, section_ids, roof_package_id, sent_at, created_at, subtotal, discount_amount, tax_rate, tax_amount, total, deposit_amount, approval, promo:promo_codes(kind, value), client:clients(display_name, email, phone, billing_address), property:properties(line1, city, region, postal_code), lines:quote_line_items(id, option_id, quantity, unit_price, taxable, optional, selected)";

// ---------------------------------------------------------------------------------------------
// Saved signatures
// ---------------------------------------------------------------------------------------------

/** The person's saved signature in this business, or null. */
export async function savedSignature(db: Db, companyId: string, userId: string): Promise<string | null> {
  const { data, error } = await db.from("user_signatures").select("image").eq("company_id", companyId).eq("user_id", userId).maybeSingle();
  if (error) throw dbError(error);
  return data?.image ?? null;
}

export async function saveSignature(db: Db, companyId: string, userId: string, image: string): Promise<void> {
  const { error } = await db.from("user_signatures").upsert({ company_id: companyId, user_id: userId, image }, { onConflict: "company_id,user_id" });
  if (error) throw dbError(error);
}

export async function removeSignature(db: Db, companyId: string, userId: string): Promise<void> {
  const { error } = await db.from("user_signatures").delete().eq("company_id", companyId).eq("user_id", userId);
  if (error) throw dbError(error);
}

/** Keeps a signature drawn while signing for next time. Signing already worked, so a failure here only gets reported. */
async function keepSignature(s: SigningScope, image: string) {
  try {
    await saveSignature(s.db, s.companyId, s.userId, image);
  } catch (error) {
    console.error("Couldn't save the signature", error);
    reportError(error, { feature: "signatures" });
  }
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

async function loadQuote(s: SigningScope, id: string) {
  return must(await s.db.from("quotes").select(QUOTE_FIELDS).eq("id", id).eq("company_id", s.companyId).maybeSingle(), "We couldn't find that estimate. It may have been deleted.");
}

type Quote = Awaited<ReturnType<typeof loadQuote>>;

async function loadCompany(s: SigningScope) {
  return must(await s.db.from("companies").select("name, email, phone, timezone, address, settings, trade_preset").eq("id", s.companyId).maybeSingle(), "Company not found.");
}

type Company = Awaited<ReturnType<typeof loadCompany>>;

/** The signer's name as it prints under the business's line. */
async function signerName(s: SigningScope): Promise<string> {
  const { data, error } = await s.db.from("profiles").select("full_name").eq("user_id", s.userId).maybeSingle();
  if (error) throw dbError(error);
  return data?.full_name?.trim() ?? "";
}

/** Why a quote that isn't open can't be signed, in words. */
function notOpen(status: string): HttpError {
  if (SIGNED.includes(status)) return new HttpError(409, "This estimate was already signed.");
  const word = status === "lost" ? "marked lost" : status === "archived" ? "archived" : status;
  return new HttpError(409, `This estimate is ${word}, so it can't be signed. Reopen it as a draft first.`);
}

/**
 * The homeowner signs on the salesperson's iPad: the quote is approved with both signatures (the
 * business's drawn now or the salesperson's saved one), for the option they chose and the contract
 * on the paper, initialed where it asks. The salesperson becomes its salesperson if it had none, and
 * the client can be emailed a copy.
 */
export async function signQuote(s: SigningScope, id: string, body: SignBody) {
  const quote = await loadQuote(s, id);
  if (!OPEN.includes(quote.status)) throw notOpen(quote.status);
  const [company, templates, saved, signer, options] = await Promise.all([
    loadCompany(s),
    s.db.from("document_templates").select("id, is_default, settings").eq("company_id", s.companyId),
    savedSignature(s.db, s.companyId, s.userId),
    signerName(s),
    loadOptions(s.db, s.companyId, id),
  ]);
  if (templates.error) throw dbError(templates.error);
  // The trade's starter terms when the business never saved its own, as the Hub and the printout show them.
  const template = pickTemplate(templates.data ?? [], quote.template_id, company.trade_preset);
  const companySignature = body.company_signature ?? saved;
  if (!companySignature && template.company_signs) throw new HttpError(400, `Sign for ${company.name} too.`);

  // The option they chose is the one shown on the visit page, and it has to be the one on the paper.
  let option: OptionRow | null = null;
  if (options.length || body.option_id) {
    if (!body.option_id) throw new HttpError(400, "Pick one of the options first.");
    option = options.find((o) => o.id === body.option_id && o.id === quote.option_id) ?? null;
    if (!option) throw new HttpError(409, CHANGED);
    if (!isPriced(option, quote.lines ?? [])) throw new HttpError(409, "This option isn't priced yet. Add its lines, or pick another one.");
  }
  // The contract for that option, from the business's own library, filled in as the paper showed it
  // (the fingerprint it sent says so); then those words are kept with the approval, with the
  // homeowner's initials.
  const contract = await resolveContract(s.db, s.companyId, { template, option, quoteSectionIds: quote.section_ids });
  const lines = quote.lines ?? [];
  const money = { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo };
  // Without options, {Option} and {Warranty} say the package it was priced from.
  const fill = option ?? (options.length ? null : await packageFill(s.db, s.companyId, quote.roof_package_id));
  const facts = contractInput({ ...quote, total: body.expected_total ?? quote.total }, quote.client, quote.property, company, template, fill);
  const tier = option ? optionTiers(options, lines, money).get(option.id) : null;
  checkContract(contract, body, { facts, option: option && freezeOption(option, tier) });
  const now = new Date().toISOString();
  const kept = freezeContract({ contract, facts, option, tier, initials: body.initials ?? null, signedAt: now });

  const approval = {
    name: body.name,
    signature: body.signature,
    signed_at: now,
    method: "in_person" as const,
    selected_line_ids: lines.filter((l) => l.optional && countsOn(l, quote.option_id)).map((l) => l.id),
    company: companySignature ? { name: signer || company.name, user_id: s.userId, signature: companySignature, signed_at: now } : null,
    // The template as it was signed, so later changes to it (or another default) don't change the terms above the signatures.
    template,
    ...kept,
  };
  // One step in the database (sign_quote): it claims the quote while it's still open, still shows
  // the option they chose and still comes to the total on the paper, then approves it with the
  // amounts. So two people signing at once can't both win, and an office change in between isn't
  // signed by mistake.
  const { data: amounts, error } = await s.db.rpc("sign_quote", {
    p_quote: id,
    p_approval: asJson(approval),
    ...(option ? { p_option: option.id } : {}),
    ...(body.expected_total !== undefined ? { p_expected_total: body.expected_total } : {}),
  });
  if (error) throw dbError(error);
  if (!amounts) {
    const current = must(await s.db.from("quotes").select("status").eq("id", id).eq("company_id", s.companyId).maybeSingle(), "We couldn't find that estimate. It may have been deleted.");
    throw OPEN.includes(current.status) ? new HttpError(409, CHANGED) : notOpen(current.status);
  }
  if (body.save_signature && body.company_signature) await keepSignature(s, body.company_signature);

  // The person signed in gets the office's copy of the link; only a copy that goes out to the client's own email is theirs.
  const links = await clientLinks(s.env, s.baseUrl, { c: s.companyId, t: "quote", id }, COPY_DAYS);
  if (!body.email_copy) return { status: "approved" as const, emailed: false, link: links.office };
  const copy = await deliverCopy(s, quote, company, links, { channel: "email", to: body.to });
  return { status: "approved" as const, emailed: copy.sent, ...(copy.sent ? {} : { email_reason: copy.reason }), link: links.office };
}

/** Signs for the business on a quote that's already signed (online, say), with a drawn or saved signature. */
export async function countersignQuote(s: SigningScope, id: string, body: CountersignBody) {
  const quote = await loadQuote(s, id);
  if (!SIGNED.includes(quote.status)) throw new HttpError(409, "This estimate isn't signed yet.");
  const company = await loadCompany(s);
  const approval = quote.approval && typeof quote.approval === "object" && !Array.isArray(quote.approval) ? (quote.approval as Record<string, unknown>) : {};
  if (approval.company) throw new HttpError(409, `This estimate was already signed for ${company.name}.`);
  const image = body.signature ?? (await savedSignature(s.db, s.companyId, s.userId));
  if (!image) throw new HttpError(400, "Draw your signature first.");
  const signer = await signerName(s);
  const merged = { ...approval, company: { name: signer || company.name, user_id: s.userId, signature: image, signed_at: new Date().toISOString() } };
  // Only while nobody has signed for the business yet (->> reads a missing key and a JSON null alike).
  const updated = await s.db
    .from("quotes")
    .update({ approval: asJson(merged) })
    .eq("id", id)
    .eq("company_id", s.companyId)
    .in("status", SIGNED)
    .is("approval->>company", null)
    .select("id");
  if (updated.error) throw dbError(updated.error);
  if (!updated.data?.length) throw new HttpError(409, `This estimate was already signed for ${company.name}.`);
  if (body.save_signature && body.signature) await keepSignature(s, body.signature);
  return { ok: true as const };
}

/**
 * Emails or texts the client their signed estimate: a link that works for a year. The person
 * sending it gets the office's copy of the link back (lib/links clientLinks).
 */
export async function sendSignedCopy(s: SigningScope, id: string, body: CopyBody) {
  const quote = await loadQuote(s, id);
  if (!SIGNED.includes(quote.status)) throw new HttpError(409, "This estimate isn't signed yet.");
  const company = await loadCompany(s);
  const links = await clientLinks(s.env, s.baseUrl, { c: s.companyId, t: "quote", id }, COPY_DAYS);
  const result = await deliverCopy(s, quote, company, links, body);
  return { sent: result.sent, ...(result.sent ? {} : { reason: result.reason }), link: links.office };
}

/**
 * The signed copy itself. Problems a person can fix (no email on file, email not set up) come back
 * as a reason instead of an error, so the estimate stays signed and the screen can say what to do.
 * An email or text to the client's own email or phone on file carries their own link (`links.own`;
 * lib/links sentToClient); one typed to any other address, and the copy kept on their timeline,
 * carry the office's (`links.office`).
 */
async function deliverCopy(s: SigningScope, quote: Quote, company: Company, links: { own: string; office: string }, body: CopyBody): Promise<{ sent: boolean; reason?: string }> {
  const client = quote.client as { display_name: string; email: string | null; phone: string | null } | null;
  const who = client?.display_name || "this client";
  const intro = `Here's your signed estimate from ${company.name}. You can view, print or save it any time:`;
  const email = (link: string) => `Hi ${firstName(client?.display_name)},\n\n${intro}\n\n${link}\n\nThanks,\n${company.name}`;
  const sms = (link: string) => `${company.name}: Here's your signed estimate. You can view, print or save it any time: ${link}`;
  const linkFor = (channel: "email" | "sms", to: string) => (sentToClient(channel, to, client) ? links.own : links.office);
  const subject = `Your signed estimate from ${company.name}`;
  let result: { sent: boolean; reason?: string; id?: string };
  try {
    if (body.channel === "email") {
      const to = body.to || client?.email;
      if (!to) return { sent: false, reason: `Add an email address for ${who} first.` };
      if (!isEmail(to)) return { sent: false, reason: "That email address doesn't look right." };
      const footer = [company.name, companyAddress(company.address as Record<string, string>), company.phone].filter(Boolean).join(" · ");
      const text = email(linkFor("email", to));
      result = await sendEmail(
        s.env,
        { to, subject, ...renderEmail({ companyName: company.name, logo: logoImage(s.baseUrl, s.companyId, company.settings), text, footer }), replyTo: company.email ?? undefined, fromName: company.name },
        s.companyId,
      );
    } else {
      const to = body.to || client?.phone;
      if (!to) return { sent: false, reason: `Add a phone number for ${who} first.` };
      // Not to their own phone after they texted STOP; another number is the office's to text.
      const { data: texted } = await s.db.from("clients").select("id, phone, sms_opt_out_at").eq("id", quote.client_id).maybeSingle();
      if (texted && textsOffTo(texted, to)) return { sent: false, reason: textsOffRefusal(who) };
      result = await sendSms(s.env, { to, body: sms(linkFor("sms", to)) });
      if (texted) await noteRefusedText(adminClient(s.env), texted, to, result);
    }
  } catch (error) {
    console.error("Couldn't send the signed copy", error);
    reportError(error, { feature: "signed copy" });
    return { sent: false, reason: "Couldn't send it just now. Try again in a minute." };
  }
  if (result.sent) {
    const logged = await s.db.from("messages").insert({
      company_id: s.companyId,
      client_id: quote.client_id,
      channel: body.channel,
      subject: body.channel === "email" ? subject : `Signed estimate #${quote.number}`,
      body: body.channel === "email" ? email(links.office) : sms(links.office),
      related_type: "quote",
      related_id: quote.id,
      external_id: result.id ?? null,
    });
    if (logged.error) console.error("Couldn't log the signed copy", logged.error);
  }
  return { sent: result.sent, reason: result.reason };
}
