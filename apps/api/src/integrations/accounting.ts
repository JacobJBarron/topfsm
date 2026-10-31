import { lineTotal, toCents } from "@crewtavo/core";
import type { Db } from "../lib/supabase";
/**
 * Accounting sync: push clients, invoices and payments to QuickBooks Online or Zoho Books.
 * Called from the outbox task with the admin client; every query filters by company_id.
 *
 * QuickBooks item mapping lives in integrations.settings:
 *   { "environment": "production" | "sandbox", "item_map": { "<service uuid>": "<QBO Item Id>" }, "default_item_id": "1" }
 */
import type { Env } from "../env";
import { providerTimeout, zohoApiDomain, type Provider } from "./registry";
import { accessToken, IntegrationError } from "./tokens";

type Accounting = "quickbooks" | "zoho_books";
type Entity = "client" | "invoice" | "payment";

interface Ctx {
  env: Env;
  admin: Db;
  companyId: string;
  provider: Accounting;
  integration: { external_account_id: string | null; settings: Record<string, unknown> };
}

const QBO_BASE = { production: "https://quickbooks.api.intuit.com", sandbox: "https://sandbox-quickbooks.api.intuit.com" };
const QBO_MINOR_VERSION = "75";

async function one<R extends { data: unknown; error: { message: string } | null }>(query: PromiseLike<R>, what: string): Promise<NonNullable<R["data"]>> {
  const { data, error } = await query;
  if (error) throw new IntegrationError(error.message);
  if (!data) throw new IntegrationError(`${what} not found`);
  return data as NonNullable<R["data"]>;
}

/** A lookup that fails isn't "never sent": carrying on as if it were would send the record twice. */
async function linked(ctx: Ctx, entity: Entity, localId: string): Promise<string | null> {
  const { data, error } = await ctx.admin
    .from("sync_links")
    .select("external_id")
    .match({ company_id: ctx.companyId, provider: ctx.provider, entity, local_id: localId })
    .maybeSingle();
  if (error) throw new IntegrationError(error.message);
  return data?.external_id ?? null;
}

/** The provider took the record but the link to it wasn't saved. Retrying the job would send it again. */
export class SentButUnrecorded extends IntegrationError {
  override name = "SentButUnrecorded";
}

/**
 * Once the provider has the record, sending it again makes a copy in the books. So a link that
 * couldn't be saved is tried once more here, then fails the job for good (not to be retried),
 * naming the provider's record so it can be checked there.
 */
async function remember(ctx: Ctx, entity: Entity, localId: string, externalId: string, syncToken?: string) {
  const link = {
    company_id: ctx.companyId,
    provider: ctx.provider,
    entity,
    local_id: localId,
    external_id: externalId,
    sync_token: syncToken ?? null,
    synced_at: new Date().toISOString(),
  };
  let { error } = await ctx.admin.from("sync_links").upsert(link);
  if (error) ({ error } = await ctx.admin.from("sync_links").upsert(link));
  if (error) throw new SentButUnrecorded(`Sent ${entity} ${externalId} but couldn't record it: ${error.message}`);
}

/** The provider's record is already the copy of another of ours, so it isn't this one's. */
async function linkedElsewhere(ctx: Ctx, entity: Entity, externalId: string, localId: string): Promise<boolean> {
  const { data, error } = await ctx.admin
    .from("sync_links")
    .select("local_id")
    .match({ company_id: ctx.companyId, provider: ctx.provider, entity, external_id: externalId });
  if (error) throw new IntegrationError(error.message);
  return (data ?? []).some((link) => link.local_id !== localId);
}

// ---------------------------------------------------------------------------------------------
// Provider HTTP
// ---------------------------------------------------------------------------------------------
//
// A create we stopped waiting for (the timeout, or a dropped connection) may still go through at
// the provider, and the outbox then tries the job again. So before making an invoice or payment we
// look for the one we sent: the same customer, number or reference, date and amount. Our number
// alone isn't enough, since the books can have an invoice of their own with it. QuickBooks' request
// ids aren't used: a repeated one gets the first answer, which may be a refusal fixed since.

/**
 * Which QuickBooks the keys work with. A company's own Intuit keys say so themselves (development
 * keys only reach sandbox companies); the server's follow the settings, then QUICKBOOKS_ENVIRONMENT.
 */
export function qboEnvironment(env: Env, settings: Record<string, unknown>, extra?: Record<string, string>): keyof typeof QBO_BASE {
  if (extra?.client_id) return extra.environment === "sandbox" ? "sandbox" : "production";
  return settings.environment === "sandbox" ? "sandbox" : (env.QUICKBOOKS_ENVIRONMENT ?? "production");
}

async function qbo(ctx: Ctx, method: "GET" | "POST", path: string, body?: unknown) {
  const realm = ctx.integration.external_account_id;
  if (!realm) throw new IntegrationError("QuickBooks company (realm) ID is missing; reconnect QuickBooks.");
  const { token, secret } = await accessToken(ctx.env, ctx.admin, ctx.companyId, "quickbooks");
  const env = qboEnvironment(ctx.env, ctx.integration.settings, secret.extra);
  const url = `${QBO_BASE[env]}/v3/company/${realm}/${path}${path.includes("?") ? "&" : "?"}minorversion=${QBO_MINOR_VERSION}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: providerTimeout(),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    const detail = json.Fault?.Error?.[0];
    throw new IntegrationError(`QuickBooks ${path}: ${response.status} ${detail?.Message ?? ""} ${detail?.Detail ?? ""}`.trim());
  }
  return json;
}

async function zoho(ctx: Ctx, method: "GET" | "POST", path: string, body?: unknown) {
  const { token, secret } = await accessToken(ctx.env, ctx.admin, ctx.companyId, "zoho_books");
  const org = ctx.integration.external_account_id;
  if (!org) throw new IntegrationError("Zoho Books organization ID is missing; reconnect Zoho Books.");
  // Checked here too: tokens saved before only Zoho's servers were accepted may name another.
  const apiDomain = zohoApiDomain(secret.extra?.api_domain);
  const response = await fetch(`${apiDomain}/books/v3/${path}${path.includes("?") ? "&" : "?"}organization_id=${org}`, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: providerTimeout(),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || (json.code !== undefined && json.code !== 0)) {
    throw new IntegrationError(`Zoho Books ${path}: ${response.status} ${json.message ?? ""}`.trim());
  }
  return json;
}

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

async function pushClient(ctx: Ctx, clientId: string): Promise<string> {
  const existing = await linked(ctx, "client", clientId);
  if (existing) return existing;
  const client = await one(
    ctx.admin.from("clients").select("id, display_name, company_name, email, phone").eq("company_id", ctx.companyId).eq("id", clientId).maybeSingle(),
    "Client",
  );

  if (ctx.provider === "quickbooks") {
    const name = String(client.display_name).slice(0, 100);
    // DisplayName must be unique in QuickBooks; reuse a customer that already has it.
    const query = encodeURIComponent(`select Id, SyncToken from Customer where DisplayName = '${name.replace(/'/g, "\\'")}'`);
    const found = (await qbo(ctx, "GET", `query?query=${query}`)).QueryResponse?.Customer?.[0];
    const customer = found ?? (await qbo(ctx, "POST", "customer", {
      DisplayName: name,
      CompanyName: client.company_name ?? undefined,
      PrimaryEmailAddr: client.email ? { Address: client.email } : undefined,
      PrimaryPhone: client.phone ? { FreeFormNumber: client.phone } : undefined,
    })).Customer;
    await remember(ctx, "client", clientId, customer.Id, customer.SyncToken);
    return customer.Id;
  }

  const contact = (await zoho(ctx, "POST", "contacts", {
    contact_name: client.display_name,
    company_name: client.company_name ?? undefined,
    contact_type: "customer",
    contact_persons: client.email || client.phone ? [{ email: client.email ?? undefined, phone: client.phone ?? undefined, is_primary_contact: true }] : undefined,
  })).contact;
  await remember(ctx, "client", clientId, contact.contact_id);
  return contact.contact_id;
}

async function pushInvoice(ctx: Ctx, invoiceId: string): Promise<string> {
  const existing = await linked(ctx, "invoice", invoiceId);
  if (existing) return existing;
  const invoice = await one(
    ctx.admin
      .from("invoices")
      .select("id, number, client_id, issued_on, due_on, subject, tax_rate, tax_amount, discount_amount, credit_amount, invoice_line_items(name, description, quantity, unit_price, taxable, service_id, sort)")
      .eq("company_id", ctx.companyId)
      .eq("id", invoiceId)
      .maybeSingle(),
    "Invoice",
  );
  const customerId = await pushClient(ctx, invoice.client_id);
  const lines = [...(invoice.invoice_line_items ?? [])].sort((a: any, b: any) => a.sort - b.sort);
  // Referral credits come off before tax with the discount, so the books see one discount for both.
  // A credit put on after the invoice was pushed isn't sent (automatic credits wait for one that
  // hasn't been: private.referral_credit_room).
  const discount = Math.round((Number(invoice.discount_amount ?? 0) + Number(invoice.credit_amount ?? 0)) * 100) / 100;
  // The lines' amounts in cents, before the discount and tax: with the date, what tells the one we
  // sent from an invoice of theirs with our number.
  const charged = lines.reduce((sum: number, line: any) => sum + toCents(lineTotal(line.quantity, line.unit_price)), 0);

  if (ctx.provider === "quickbooks") {
    // Sent already: QuickBooks has an invoice with our number for this customer, dated as ours and
    // with our lines' amounts (not our total: QuickBooks may work the tax out itself).
    const query = encodeURIComponent(`select * from Invoice where DocNumber = '${String(invoice.number).replace(/'/g, "\\'")}'`);
    const sent = ((await qbo(ctx, "GET", `query?query=${query}`)).QueryResponse?.Invoice ?? []).find(
      (i: any) =>
        i.CustomerRef?.value === customerId &&
        i.TxnDate === invoice.issued_on &&
        (i.Line ?? []).filter((l: any) => l.DetailType === "SalesItemLineDetail").reduce((sum: number, l: any) => sum + toCents(l.Amount), 0) === charged,
    );
    const itemMap = (ctx.integration.settings.item_map ?? {}) as Record<string, string>;
    const defaultItem = String(ctx.integration.settings.default_item_id ?? "1");
    const created = sent ?? (await qbo(ctx, "POST", "invoice", {
      CustomerRef: { value: customerId },
      DocNumber: String(invoice.number),
      TxnDate: invoice.issued_on,
      DueDate: invoice.due_on ?? undefined,
      Line: [
        ...lines.map((line: any) => ({
          DetailType: "SalesItemLineDetail",
          Amount: lineTotal(line.quantity, line.unit_price), // rounded as the invoice's own totals are
          Description: line.description || line.name,
          SalesItemLineDetail: {
            ItemRef: { value: (line.service_id && itemMap[line.service_id]) || defaultItem },
            Qty: Number(line.quantity),
            UnitPrice: Number(line.unit_price),
            TaxCodeRef: { value: line.taxable ? "TAX" : "NON" },
          },
        })),
        // Discounts (promo codes) and referral credits come off before tax, as they do here.
        ...(discount > 0 ? [{ DetailType: "DiscountLineDetail", Amount: discount, DiscountLineDetail: { PercentBased: false } }] : []),
      ],
      ApplyTaxAfterDiscount: true,
      ...(Number(invoice.tax_amount) > 0 ? { TxnTaxDetail: { TotalTax: Number(invoice.tax_amount) } } : {}),
    })).Invoice;
    await remember(ctx, "invoice", invoiceId, created.Id, created.SyncToken);
    return created.Id;
  }

  // Sent already: Zoho has an invoice for this customer with our number as its reference, dated as
  // ours and coming to what we send (no tax goes to Zoho, so the lines less the discount and credits).
  const reference = String(invoice.number);
  const sent = ((await zoho(ctx, "GET", `invoices?reference_number=${encodeURIComponent(reference)}&customer_id=${encodeURIComponent(customerId)}`)).invoices ?? [])
    .find((i: any) => i.reference_number === reference && i.customer_id === customerId && i.date === invoice.issued_on && toCents(i.total) === charged - toCents(discount));
  const created = sent ?? (await zoho(ctx, "POST", "invoices", {
    customer_id: customerId,
    reference_number: reference,
    date: invoice.issued_on,
    due_date: invoice.due_on ?? undefined,
    line_items: lines.map((line: any) => ({
      name: line.name,
      description: line.description ?? undefined,
      rate: Number(line.unit_price),
      quantity: Number(line.quantity),
    })),
    ...(discount > 0 ? { discount, discount_type: "entity_level", is_discount_before_tax: true } : {}),
  })).invoice;
  await remember(ctx, "invoice", invoiceId, created.invoice_id);
  return created.invoice_id;
}

async function pushPayment(ctx: Ctx, paymentId: string): Promise<string | null> {
  const existing = await linked(ctx, "payment", paymentId);
  if (existing) return existing;
  const payment = await one(
    ctx.admin.from("payments").select("id, client_id, invoice_id, amount, method, received_at").eq("company_id", ctx.companyId).eq("id", paymentId).maybeSingle(),
    "Payment",
  );
  // Refunds are recorded in the books by hand for now. Tips aren't sent: they aren't on the invoice
  // in the books, and sent with the payment they'd sit there as the customer's credit. So a payment
  // that was only a tip (Stripe charged just the tip) has nothing to send; QuickBooks and Zoho
  // refuse a payment of nothing anyway.
  if (Number(payment.amount) <= 0) return null;
  const customerId = await pushClient(ctx, payment.client_id);
  const invoiceExternal = payment.invoice_id ? await pushInvoice(ctx, payment.invoice_id) : null;
  const date = String(payment.received_at).slice(0, 10);

  if (ctx.provider === "quickbooks") {
    // Sent already: QuickBooks has a payment from this customer that day for our amount, on our
    // invoice (or none), that isn't the copy of another of ours: two the same can come in one day.
    // (Its reference number takes 21 characters, too few for our id.)
    const query = encodeURIComponent(`select * from Payment where CustomerRef = '${customerId.replace(/'/g, "\\'")}' and TxnDate = '${date}'`);
    const applied = (p: any) => (p.Line ?? []).flatMap((l: any) => l.LinkedTxn ?? []).map((t: any) => t.TxnId).join();
    let sent: any;
    for (const p of (await qbo(ctx, "GET", `query?query=${query}`)).QueryResponse?.Payment ?? []) {
      if (toCents(p.TotalAmt) !== toCents(payment.amount) || applied(p) !== (invoiceExternal ?? "")) continue;
      if (await linkedElsewhere(ctx, "payment", p.Id, paymentId)) continue;
      sent = p;
      break;
    }
    const created = sent ?? (await qbo(ctx, "POST", "payment", {
      CustomerRef: { value: customerId },
      TotalAmt: Number(payment.amount),
      TxnDate: date,
      Line: invoiceExternal ? [{ Amount: Number(payment.amount), LinkedTxn: [{ TxnId: invoiceExternal, TxnType: "Invoice" }] }] : [],
    })).Payment;
    await remember(ctx, "payment", paymentId, created.Id, created.SyncToken);
    return created.Id;
  }

  // Sent already: Zoho has a payment with our id as its reference.
  const sent = ((await zoho(ctx, "GET", `customerpayments?reference_number=${encodeURIComponent(paymentId)}`)).customerpayments ?? [])
    .find((p: any) => p.reference_number === paymentId);
  const created = sent ?? (await zoho(ctx, "POST", "customerpayments", {
    customer_id: customerId,
    payment_mode: payment.method === "ach" ? "Bank Transfer" : payment.method === "card" ? "Credit Card" : payment.method,
    amount: Number(payment.amount),
    date,
    reference_number: paymentId,
    invoices: invoiceExternal ? [{ invoice_id: invoiceExternal, amount_applied: Number(payment.amount) }] : [],
  })).payment;
  await remember(ctx, "payment", paymentId, created.payment_id);
  return created.payment_id;
}

/** Run one outbox row. Throws on failure so the caller can schedule a retry. */
export async function runAccountingJob(env: Env, admin: Db, row: { company_id: string; topic: string; payload: Record<string, string> }) {
  const { data: integration, error } = await admin
    .from("integrations")
    .select("provider, external_account_id, settings")
    .eq("company_id", row.company_id)
    .in("provider", ["quickbooks", "zoho_books"])
    .eq("status", "connected")
    .limit(1)
    .maybeSingle();
  if (error) throw new IntegrationError(error.message);
  // Disconnected or waiting to be reconnected since it was queued: fail, so it's retried rather than dropped.
  if (!integration) throw new IntegrationError("The accounting app isn't connected. Reconnect it on the Apps page.");

  const ctx: Ctx = {
    env,
    admin,
    companyId: row.company_id,
    provider: integration.provider as Accounting,
    integration: { external_account_id: integration.external_account_id, settings: (integration.settings ?? {}) as Record<string, unknown> },
  };
  if (row.topic === "accounting.invoice") await pushInvoice(ctx, row.payload.invoice_id);
  else if (row.topic === "accounting.payment") await pushPayment(ctx, row.payload.payment_id);
  else throw new IntegrationError(`Unknown topic ${row.topic}`);

  // last_error stays: it's about a change that never went through (see drainOutbox in tasks.ts),
  // which this one going through doesn't fix. Reconnecting or disconnecting clears it.
  await admin
    .from("integrations")
    .update({ last_sync_at: new Date().toISOString(), status: "connected" })
    .match({ company_id: row.company_id, provider: integration.provider });
}

/** After connecting: find the QuickBooks company name or the Zoho organization. */
export async function describeAccount(env: Env, provider: Provider, token: string, query: Record<string, string>, extra?: Record<string, string>) {
  if (provider === "quickbooks") {
    const realm = query.realmId;
    if (!realm) throw new IntegrationError("QuickBooks didn't return a company ID.");
    const base = QBO_BASE[qboEnvironment(env, {}, extra)];
    const response = await fetch(`${base}/v3/company/${realm}/companyinfo/${realm}?minorversion=${QBO_MINOR_VERSION}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: providerTimeout(),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, any>;
    return { external_account_id: realm, account_label: json.CompanyInfo?.CompanyName ?? `QuickBooks ${realm}` };
  }
  if (provider === "zoho_books") {
    const apiDomain = zohoApiDomain(extra?.api_domain);
    const response = await fetch(`${apiDomain}/books/v3/organizations`, { headers: { Authorization: `Zoho-oauthtoken ${token}` }, signal: providerTimeout() });
    const json = (await response.json().catch(() => ({}))) as Record<string, any>;
    const org = json.organizations?.find((o: any) => o.is_default_org) ?? json.organizations?.[0];
    if (!org) throw new IntegrationError("No Zoho Books organization found for that account.");
    return { external_account_id: String(org.organization_id), account_label: org.name as string };
  }
  return { external_account_id: null, account_label: null };
}
