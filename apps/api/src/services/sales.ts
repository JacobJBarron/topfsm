/**
 * Sending quotes and invoices to clients, starting a quote from a request, turning a quote into a
 * job, invoicing many jobs and payment reminders: the steps with side effects (email, texts, Stripe).
 * The sales routes (routes/sales.ts) and AI assistants' tools (assistant-tools/quotes.ts, invoices.ts)
 * both use these, with the person's own client. Also how a quote that offers options is priced before
 * the client chooses, and the most its deposit can be.
 */
import { hidesExactPrice, inRangeMode, optionsIntroText, rangeIntroText } from "@crewtavo/core/estimates";
import { optionBaseTotal, toCents, type Amount, type OptionLine, type TotalsPromo } from "@crewtavo/core/money";
import { z } from "zod";
import type { Env } from "../env";
import { syncStripeInvoice } from "../integrations/stripe";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { asJson, dbError, HttpError, must } from "../lib/http";
import { clientLink } from "../lib/links";
import { sendEmail, sendSms } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { materializeJob, recurringJob } from "../tasks";
import { companyAddress } from "./automations";
import { loadOptions, manualApproval } from "./contracts";
import { logoImage } from "./logo";

/** Who's sending, from where: the person's client, their company, and the address client links use. */
export interface SalesScope {
  db: Db;
  env: Env;
  companyId: string;
  baseUrl: string;
}

export const sendSchema = z.object({
  channel: z.enum(["email", "sms", "link"]).default("email"),
  to: z.string().trim().max(200).optional(), // defaults to the client's email or phone
  subject: z.string().trim().max(200).optional(),
  message: z.string().max(4000).optional(),
});
export type SendBody = z.infer<typeof sendSchema>;

type Deliverable = { id: string; number: number | null; client_id: string; total?: number; balance_due?: number; recurrence_rule?: string | null; client: { display_name: string; email: string | null; phone: string | null } | null };

/**
 * What a send says when the person didn't write their own message or subject: a roof estimate's
 * price range goes out with its own words (rangeMessage), not the quote's total.
 */
export interface DeliverDefaults {
  intro?: string;
  subject?: string;
}

/**
 * The words a price range goes out with when the person didn't write their own, in whole dollars
 * (core rangeIntroText, the same words the office's send dialog shows). With two or three options
 * (`optionCount`) the range runs across them.
 */
export function rangeMessage(company: { name: string; currency: string | null }, low: number, high: number, optionCount = 0): Required<DeliverDefaults> {
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: company.currency || "USD", maximumFractionDigits: 0 });
  return {
    intro: rangeIntroText(money.format(low), money.format(high), optionCount),
    subject: `Your roof estimate from ${company.name}`,
  };
}

/**
 * Each option's price before its add-ons, for the options that have one (core optionBaseTotal): what
 * the Client Hub shows on the option cards and what the price range is made from. An option with no
 * lines of its own yet has no price, so it isn't counted or quoted.
 */
export function optionPrices(quote: {
  tax_rate: number;
  discount_amount: number;
  promo: TotalsPromo | null;
  lines: readonly OptionLine[];
  options: ReadonlyArray<{ id: string }>;
}): number[] {
  const opts = { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo };
  return quote.options.map((o) => optionBaseTotal(quote.lines, o.id, opts)).filter((total): total is number => total !== null);
}

/**
 * The words a quote that offers options goes out with when the person didn't write their own (core
 * optionsIntroText): how many options have a price (`prices`, from optionPrices) and the lowest of
 * them. Null with fewer than two, when the quote's own total says it.
 */
export function optionsMessage(currency: string | null, prices: readonly number[]): DeliverDefaults | null {
  if (prices.length < 2) return null;
  return { intro: optionsIntroText(prices.length, new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(Math.min(...prices))) };
}

/**
 * What a quote that offers options costs before the client chooses: how many options have a price
 * and the lowest of them (optionPrices), as its email said it (optionsMessage), never the total of
 * whichever option is shown. Null once it's signed (its total is the option they chose), while its
 * exact price is hidden behind a range (the range says it), and with fewer than two priced options
 * (its own total says it, as the email did). The Client Hub's home page and automations' {{total}}
 * say it this way.
 */
export function optionsFrom(quote: Parameters<typeof optionPrices>[0] & { status: string; range_low: Amount; priced_on_site_at: string | null; exact_sent_at?: string | null }): { count: number; from: number } | null {
  if (quote.status === "approved" || quote.status === "converted" || hidesExactPrice(quote)) return null;
  const prices = optionPrices(quote);
  return prices.length >= 2 ? { count: prices.length, from: Math.min(...prices) } : null;
}

/**
 * The most a quote's deposit can be, as the office's deposit input caps it (web QuotePage
 * depositCap): the cheapest option's price before its add-ons, so it's never more than they'd pay
 * whichever option they choose; the quote's total without options. Null while there's no price to
 * hold it to yet: options none of which has lines of its own (offered before the roof was measured),
 * or a quote with no lines.
 */
export function depositCap(quote: Parameters<typeof optionPrices>[0] & { total: Amount }): number | null {
  const prices = optionPrices(quote);
  if (prices.length) return Math.min(...prices);
  return quote.options.length || !quote.lines.length ? null : Number(quote.total ?? 0);
}

/**
 * Keeps the deposit asked for within depositCap once the estimate's price can have gone down (a
 * cheaper option offered, options filled in once measured, lines or the discount changed by an
 * assistant): a deposit larger than that is lowered to it, so the Client Hub never asks for more
 * than the price they choose, the contract's {Deposit} never says more than its {Total}, and billing
 * the deposit works once it's a job. Returns the new deposit, or null when it was within it.
 */
export async function keepDepositInCap(db: Db, companyId: string, quoteId: string): Promise<number | null> {
  const quote = must(
    await db
      .from("quotes")
      .select("deposit_amount, total, tax_rate, discount_amount, promo:promo_codes(kind, value), lines:quote_line_items(option_id, quantity, unit_price, taxable, optional, selected), options:quote_options!quote_options_quote_fkey(id)")
      .eq("id", quoteId)
      .eq("company_id", companyId)
      .maybeSingle(),
    "Quote not found.",
  );
  const cap = depositCap(quote);
  if (cap === null || toCents(quote.deposit_amount) <= Math.max(toCents(cap), 0)) return null;
  const lowered = Math.max(toCents(cap), 0) / 100;
  // Only while it's still the deposit read, so one typed meanwhile on another screen stays.
  const { error } = await db.from("quotes").update({ deposit_amount: lowered }).eq("id", quoteId).eq("company_id", companyId).eq("deposit_amount", quote.deposit_amount);
  if (error) throw dbError(error);
  return lowered;
}

/** Email or text the client their link to a quote or invoice (or just make the link), and log it on their timeline. */
export async function deliver(s: SalesScope, kind: "quote" | "invoice", record: Deliverable, body: SendBody, defaults: DeliverDefaults = {}) {
  const company = must(await s.db.from("companies").select("name, email, phone, address, currency, settings").eq("id", s.companyId).maybeSingle());
  const link = await clientLink(s.env, s.baseUrl, { c: s.companyId, t: kind, id: record.id });
  const label = `${kind === "quote" ? "Quote" : "Invoice"} #${record.number}`;
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: company.currency || "USD" }).format(Number(kind === "quote" ? record.total ?? 0 : record.balance_due ?? 0));
  const amount = record.recurrence_rule ? `${money} per visit` : money;
  const greeting = `Hi ${firstName(record.client?.display_name)},`;
  const intro =
    body.message?.trim() ||
    defaults.intro ||
    (kind === "quote" ? `Thanks for the opportunity. Here's your quote (${amount}). You can review the details, choose any options and approve it online:` : `Here's your invoice for ${amount}. You can view and pay it online:`);
  const text = `${greeting}\n\n${intro}\n\n${link}\n\nThanks,\n${company.name}`;
  let result: { sent: boolean; reason?: string; id?: string } = { sent: false, reason: "Link only" };
  if (body.channel === "email") {
    const to = body.to || record.client?.email;
    if (!to || !isEmail(to)) throw new HttpError(400, "Add a valid email address for this client first.");
    const subject = body.subject || defaults.subject || `${label} from ${company.name}`;
    const footer = [company.name, companyAddress(company.address as Record<string, string>), company.phone].filter(Boolean).join(" · ");
    result = await sendEmail(s.env, { to, subject, ...renderEmail({ companyName: company.name, logo: logoImage(s.baseUrl, s.companyId, company.settings), text, footer }), replyTo: company.email ?? undefined, fromName: company.name }, s.companyId);
  } else if (body.channel === "sms") {
    const to = body.to || record.client?.phone;
    if (!to) throw new HttpError(400, "This client has no phone number.");
    result = await sendSms(s.env, { to, body: `${company.name}: ${intro} ${link}` });
  }
  if (result.sent) {
    await s.db.from("messages").insert({
      company_id: s.companyId,
      client_id: record.client_id,
      channel: body.channel,
      subject: body.channel === "email" ? body.subject || defaults.subject || label : label,
      body: text,
      related_type: kind,
      related_id: record.id,
      external_id: result.id ?? null,
    });
  }
  return { link, ...result };
}

/** Start a draft quote from a request, carrying over the client, property and any measurement. */
export async function quoteFromRequest(s: SalesScope, requestId: string) {
  const request = must(await s.db.from("requests").select("id, client_id, property_id, title, details").eq("id", requestId).eq("company_id", s.companyId).maybeSingle(), "Request not found.");
  const company = must(await s.db.from("companies").select("settings").eq("id", s.companyId).maybeSingle());
  const taxRate = Number((company.settings as { default_tax_rate?: number } | null)?.default_tax_rate ?? 0);
  const quote = must(
    await s.db
      .from("quotes")
      .insert({ company_id: s.companyId, client_id: request.client_id, property_id: request.property_id, request_id: request.id, title: request.title, tax_rate: taxRate })
      .select("id, number")
      .single(),
  );
  await Promise.all([
    s.db.from("requests").update({ status: "quoted" }).eq("id", requestId),
    s.db.from("measurements").update({ quote_id: quote.id }).eq("request_id", requestId).is("quote_id", null),
  ]);
  return quote;
}

/**
 * Send a quote (or take its link to share): it's then with the client. A roof estimate that's out as
 * a price range goes out with the range's words, so the message never gives away the exact total
 * its link hides. A quote that offers options says so, with the lowest price, rather than the total
 * of whichever option is shown.
 */
export async function sendQuote(s: SalesScope, id: string, body: SendBody) {
  const quote = must(
    await s.db
      .from("quotes")
      .select(
        "id, number, status, total, tax_rate, discount_amount, client_id, range_low, range_high, priced_on_site_at, exact_sent_at, recurrence_rule, client:clients(display_name, email, phone), promo:promo_codes(kind, value), lines:quote_line_items(id, option_id, quantity, unit_price, taxable, optional, selected), options:quote_options!quote_options_quote_fkey(id)",
      )
      .eq("id", id)
      .eq("company_id", s.companyId)
      .maybeSingle(),
    "Quote not found.",
  );
  if (["converted", "lost", "archived"].includes(quote.status)) throw new HttpError(400, `This quote is ${quote.status}, so it can't be sent.`);
  if (!quote.lines.length) throw new HttpError(400, "Add at least one line item before sending.");
  let defaults: DeliverDefaults = {};
  const prices = optionPrices(quote);
  if (inRangeMode(quote) || prices.length >= 2) {
    const company = must(await s.db.from("companies").select("name, currency").eq("id", s.companyId).maybeSingle());
    defaults = inRangeMode(quote) ? rangeMessage(company, Number(quote.range_low), Number(quote.range_high), prices.length) : (optionsMessage(company.currency, prices) ?? {});
  }
  const result = await deliver(s, "quote", quote, body, defaults);
  // Sent, or the office took the link to share themselves: the quote is now with the client.
  if (result.sent || body.channel === "link") {
    await s.db.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id).in("status", ["draft", "changes_requested"]);
  }
  return result;
}

/** Quotes the client hasn't answered yet: what convertQuote keeps the contract of first. */
const UNSIGNED = ["draft", "sent", "changes_requested"];

/**
 * Turn a quote into a job (convert_quote_to_job), as the office's "Convert to job" and "Create the
 * job now" and the assistants do it. A quote the client never signed (the office heard yes another
 * way and converts it straight from sent) first gets the approval "Mark approved" would keep
 * (contracts.ts manualApproval, `by` its name): the template and the contract it was sent with,
 * filled in, so its signed copy prints those words and not today's. Only the approval is written,
 * not the status, so a change order still joins its job in the database's one step; and only while
 * it's unsigned, so a signature that came in meanwhile keeps its own. One that offers options is
 * approved with the option chosen first (the database refuses it otherwise). One that says how often
 * becomes a recurring job, and its next visits are made now. Returns the job's id.
 */
export async function convertQuote(s: Pick<SalesScope, "db" | "companyId" | "env">, quoteId: string, by: string): Promise<string> {
  const quote = must(await s.db.from("quotes").select("id, status, approval, recurrence_rule, change_order_for").eq("id", quoteId).eq("company_id", s.companyId).maybeSingle(), "Quote not found.");
  const before = quote.approval;
  const kept = UNSIGNED.includes(quote.status) && !(await loadOptions(s.db, s.companyId, quoteId)).length;
  if (kept) {
    const approval = await manualApproval(s.db, s.companyId, quoteId, { name: by, optionId: null });
    const { error } = await s.db.from("quotes").update({ approval: asJson(approval) }).eq("id", quoteId).eq("company_id", s.companyId).in("status", UNSIGNED);
    if (error) throw dbError(error);
  }
  const { data, error } = await s.db.rpc("convert_quote_to_job", { p_quote: quoteId });
  if (error) {
    // Not a job after all: it's still unsigned, so it goes back to the approval it had.
    if (kept) await s.db.from("quotes").update({ approval: before }).eq("id", quoteId).eq("company_id", s.companyId).in("status", UNSIGNED);
    throw dbError(error);
  }
  if (quote.recurrence_rule && !quote.change_order_for) {
    // The same visits the daily recurrence task would make (tasks.ts), so a role that sells but doesn't
    // dispatch still gets them now. The job is made either way: that task catches up if this fails.
    const admin = adminClient(s.env);
    try {
      const job = await recurringJob(admin, data);
      if (job) await materializeJob(admin, job);
    } catch (error) {
      console.error("Couldn't make the converted job's visits", error);
    }
  }
  return data;
}

/** Send an invoice (or take its link): a draft becomes sent, and goes to Stripe so the Pay button is ready. */
export async function sendInvoice(s: SalesScope, id: string, body: SendBody) {
  const invoice = must(
    await s.db.from("invoices").select("id, number, status, total, balance_due, client_id, client:clients(display_name, email, phone), lines:invoice_line_items(id)").eq("id", id).eq("company_id", s.companyId).maybeSingle(),
    "Invoice not found.",
  );
  if (invoice.status === "void") throw new HttpError(400, "This invoice is void.");
  if (!invoice.lines.length) throw new HttpError(400, "Add at least one line item before sending.");
  const result = await deliver(s, "invoice", invoice, body);
  if (invoice.status === "draft" && (result.sent || body.channel === "link")) {
    await s.db.from("invoices").update({ status: "sent" }).eq("id", id);
    // Put it in Stripe now rather than at the next outbox run, so the client's Pay button is ready.
    void syncStripeInvoice(s.env, adminClient(s.env), s.companyId, id).catch((error) => console.error("Stripe sync failed", error));
  }
  return result;
}

/** One invoice per finished job (completed visits for per-visit jobs), and optionally email each. Each job succeeds or fails on its own. */
export async function invoiceJobs(s: SalesScope, jobIds: readonly string[], send: boolean) {
  const jobs = must(await s.db.from("jobs").select("id, number, title, kind, billing_mode").eq("company_id", s.companyId).in("id", [...jobIds]));
  const results: Array<{ job_id: string; number: number | null; ok: boolean; invoice_id?: string; sent?: boolean; error?: string }> = [];
  for (const job of jobs) {
    const kind = job.billing_mode === "per_visit" || job.kind === "recurring" ? "visits" : "standard";
    const created = await s.db.rpc("create_invoice_for_job", { p_job: job.id, p_kind: kind });
    if (created.error) {
      results.push({ job_id: job.id, number: job.number, ok: false, error: dbError(created.error).message });
      continue;
    }
    const invoiceId = created.data as string;
    let sent = false;
    let error: string | undefined;
    if (send) {
      const invoice = must(await s.db.from("invoices").select("id, number, status, total, balance_due, client_id, client:clients(display_name, email, phone)").eq("id", invoiceId).maybeSingle());
      try {
        const result = await deliver(s, "invoice", invoice, { channel: "email" });
        sent = result.sent;
        if (sent) await s.db.from("invoices").update({ status: "sent" }).eq("id", invoiceId);
        else error = result.reason ?? "Not sent";
      } catch (e) {
        error = e instanceof HttpError ? e.message : "Couldn't send it";
      }
    }
    results.push({ job_id: job.id, number: job.number, ok: true, invoice_id: invoiceId, sent, error });
  }
  return { results };
}

/** Friendly reminders for unpaid invoices, by email; not while a bank payment is on its way. */
export async function remindInvoices(s: SalesScope, invoiceIds: readonly string[]) {
  const company = must(await s.db.from("companies").select("name, currency").eq("id", s.companyId).maybeSingle());
  const invoices = must(
    await s.db
      .from("invoices")
      .select("id, number, status, total, balance_due, due_on, client_id, client:clients(display_name, email, phone)")
      .eq("company_id", s.companyId)
      .in("id", [...invoiceIds])
      .in("status", ["sent", "partially_paid", "overdue"]),
  );
  let sent = 0;
  const skipped: Array<{ number: number | null; reason: string }> = [];
  // Don't ask again while a bank payment is on its way.
  const { data: paying } = await s.db.from("stripe_invoices").select("invoice_id").eq("company_id", s.companyId).eq("status", "processing").in("invoice_id", invoices.map((i) => i.id));
  const processing = new Set((paying ?? []).map((row) => row.invoice_id));
  for (const invoice of invoices) {
    if (Number(invoice.balance_due) <= 0) continue;
    if (processing.has(invoice.id)) {
      skipped.push({ number: invoice.number, reason: "A bank payment is on its way" });
      continue;
    }
    const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: company.currency || "USD" }).format(Number(invoice.balance_due));
    const due = invoice.due_on ? new Date(`${invoice.due_on}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : null;
    try {
      const result = await deliver(s, "invoice", invoice, {
        channel: "email",
        subject: `Reminder: invoice #${invoice.number} from ${company.name}`,
        message: `A friendly reminder that ${amount} is still owed on invoice #${invoice.number}${due ? `, which was due ${due}` : ""}. You can view and pay it online:`,
      });
      if (result.sent) sent++;
      else skipped.push({ number: invoice.number, reason: result.reason ?? "Not sent" });
    } catch (e) {
      skipped.push({ number: invoice.number, reason: e instanceof HttpError ? e.message : "Couldn't send it" });
    }
  }
  return { sent, skipped };
}
