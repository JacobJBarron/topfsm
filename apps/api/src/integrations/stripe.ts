/**
 * Stripe for a company. A company connects its own key on the Apps page, usually a restricted key
 * from the form the page opens in Stripe (Crewtavo adds the webhook to its Stripe account), or a
 * deployment sets STRIPE_SECRET_KEY for everyone. Then:
 *   - a sent invoice gets a matching Stripe invoice, kept in step by the outbox (syncStripeInvoice)
 *     or made when the client goes to pay from the Client Hub (stripeCheckout);
 *   - webhooks record payments, bank payments on their way, refunds, disputes and deposits, and
 *     bring in invoices made in Stripe (handleStripeEvent);
 *   - importFromStripe brings in past invoices and deposits, quietly;
 *   - switching to a key for another Stripe account (or test to live), or disconnecting, settles
 *     the old account's invoices with the old key (leaveAccount).
 * Uses the admin client; every query filters by company.
 */
import type { Env } from "../env";
import { asJson, HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";
import {
  cents,
  chargeOf,
  importedLines,
  minimumCharge,
  paymentMethod,
  STRIPE_VERSION,
  stripeApi,
  stripeDay,
  StripeError,
  stripeLineItems,
  stripeList,
  type BillableInvoice,
  type StripeBalanceTransaction,
  type StripeCharge,
  type StripeEvent,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripePayout,
} from "../services/stripe";
import { IntegrationError, loadSecret, saveSecret, type StoredSecret } from "./tokens";

/** What the webhook Crewtavo adds to a Stripe account listens for. */
export const STRIPE_EVENTS = [
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "payment_intent.processing",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "payout.created",
  "payout.updated",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
  // Checkout pages opened before invoices went through Stripe can still be paid, and bank
  // payments made on them take days to clear.
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
];

const LIVE = ["creating", "open", "processing"];
const OWED = ["sent", "partially_paid", "overdue"];
export const PROCESSING_MESSAGE = "A bank payment for this invoice is already on its way. It usually clears in a few business days.";

export interface StripeAccess {
  key: string;
  /** The company's own key, from the Apps page (rather than the deployment's). */
  own: boolean;
  webhookSecret?: string;
  /** The Stripe account the key reaches (acct_...), when Crewtavo knows it. */
  account?: string | null;
}

export async function stripeAccess(env: Env, admin: Db, companyId: string): Promise<StripeAccess | null> {
  const secret = await loadSecret(env, admin, companyId, "stripe").catch(() => null);
  if (secret?.api_key) return { key: secret.api_key, own: true, webhookSecret: secret.extra?.webhook_secret, account: secret.extra?.account_id ?? null };
  return env.STRIPE_SECRET_KEY ? { key: env.STRIPE_SECRET_KEY, own: false } : null;
}

interface Ctx {
  admin: Db;
  companyId: string;
  key: string;
  own: boolean;
  /** The Stripe account the key reaches, when known, and whether it's live or test. */
  account: string | null;
  livemode: boolean;
  timezone: string;
  currency: string;
}

async function context(env: Env, admin: Db, companyId: string, access?: StripeAccess | null): Promise<Ctx | null> {
  const found = access ?? (await stripeAccess(env, admin, companyId));
  if (!found) return null;
  const { data: company } = await admin.from("companies").select("timezone, currency").eq("id", companyId).maybeSingle();
  if (!company) return null;
  let account = found.account ?? null;
  if (found.own && !account) {
    // Keys saved before the account was kept with them: the one noted when it was connected.
    const { data } = await admin.from("integrations").select("external_account_id").match({ company_id: companyId, provider: "stripe" }).maybeSingle();
    account = data?.external_account_id ?? null;
  }
  return {
    admin, companyId, key: found.key, own: found.own, account, livemode: found.key.includes("_live_"),
    timezone: company.timezone || "UTC", currency: (company.currency || "USD").toLowerCase(),
  };
}

function fail(error: { message: string } | null) {
  if (error) throw new IntegrationError(error.message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isoAt = (seconds: number | null | undefined) => new Date((seconds ?? Date.now() / 1000) * 1000).toISOString();

// ---------------------------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------------------------

interface StripeAccount {
  id: string;
  email?: string | null;
  business_profile?: { name?: string | null } | null;
  settings?: { dashboard?: { display_name?: string | null } | null } | null;
}

/** Stripe only sends webhooks to public https addresses. */
const reachable = (base: string) => /^https:\/\//.test(base) && !/^https:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(base);

/**
 * Check a secret key, add Crewtavo's webhook in that Stripe account, and store both encrypted.
 * Without a public address (local development) the key is saved without a webhook. A key that
 * replaces another only takes over once its webhook is in and saved, so one that can't add it
 * leaves Stripe working as it was. When the new key reaches another Stripe account (or test
 * instead of live), the old account's invoices are settled with the old key (`settled`, which can
 * finish after the response).
 */
export async function connectStripe(env: Env, admin: Db, input: { companyId: string; userId: string; key: string; baseUrl: string }) {
  const key = input.key.trim();
  if (!/^(sk|rk)_(live|test)_\w+$/.test(key)) {
    throw new HttpError(400, "That isn't a Stripe key. Use Get a key from Stripe on this page, then copy the key Stripe shows you.");
  }
  let account: StripeAccount | null = null;
  try {
    account = await stripeApi<StripeAccount>(key, "GET", "/v1/account");
  } catch (error) {
    if (error instanceof StripeError && error.status === 401) throw new HttpError(400, "Stripe didn't accept that key. Copy it again, or make a new one with Get a key from Stripe.");
    // A restricted key may not be allowed to read the account. Adding the webhook still tests it.
    if (!(error instanceof StripeError && error.status === 403)) throw error;
  }

  // What's in use now: the company's own key, or the server's.
  const previous = await loadSecret(env, admin, input.companyId, "stripe").catch(() => null);
  const before = await context(env, admin, input.companyId);
  const unchanged = previous?.api_key ? " Stripe stays connected as it was." : "";
  let webhook: { id: string; secret: string } | null = null;
  const url = `${input.baseUrl}/api/webhooks/stripe/${input.companyId}`;
  if (reachable(input.baseUrl)) {
    const endpoint = { url, enabled_events: STRIPE_EVENTS, description: "Crewtavo: invoices, payments and deposits", metadata: { crewtavo_company_id: input.companyId } };
    try {
      // Webhooks an earlier try left at this address go. The one in use stays until the new one is saved.
      for await (const found of stripeList<{ id: string; url: string }>(key, "/v1/webhook_endpoints")) {
        if (found.url === url && found.id !== previous?.extra?.webhook_id) await stripeApi(key, "DELETE", `/v1/webhook_endpoints/${found.id}`);
      }
      webhook = await stripeApi<{ id: string; secret: string }>(key, "POST", "/v1/webhook_endpoints", { ...endpoint, api_version: STRIPE_VERSION }).catch(async (error) => {
        // Stripe has no room for another (16 in an account), say: a key rolled in the same account
        // takes over the one in use instead, which keeps its secret. Another account's key can't reach it.
        const reused = await sameWebhook(key, previous, endpoint);
        if (!reused) throw error;
        return reused;
      });
    } catch (error) {
      if (error instanceof StripeError && (error.status === 401 || error.status === 403)) {
        throw new HttpError(400, `That key can't add a webhook. Make a new one with Get a key from Stripe, which gives it everything Crewtavo needs.${unchanged}`);
      }
      throw new HttpError(400, `Stripe wouldn't add the webhook: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")}.${unchanged}`);
    }
  }

  const label = account?.settings?.dashboard?.display_name || account?.business_profile?.name || account?.email || "Stripe account";
  try {
    const { data: existing } = await admin.from("integrations").select("settings, external_account_id").match({ company_id: input.companyId, provider: "stripe" }).maybeSingle();
    // The last import's summary belongs to the account it came from.
    const keep = existing?.external_account_id && existing.external_account_id === account?.id ? ((existing.settings ?? {}) as Record<string, unknown>) : {};
    const { error } = await admin.from("integrations").upsert({
      company_id: input.companyId,
      provider: "stripe",
      status: "connected",
      account_label: label,
      external_account_id: account?.id ?? null,
      settings: asJson({ ...keep, livemode: key.includes("_live_"), webhook: Boolean(webhook) }),
      connected_by: input.userId,
      connected_at: new Date().toISOString(),
      last_error: null,
    });
    fail(error);
    const extra: Record<string, string> = webhook ? { webhook_id: webhook.id, webhook_secret: webhook.secret } : {};
    if (account?.id) extra.account_id = account.id;
    await saveSecret(env, admin, input.companyId, "stripe", { api_key: key, extra });
  } catch (error) {
    // Not saved, so the old key and its webhook are still the ones in use: take the new webhook out.
    if (webhook && webhook.id !== previous?.extra?.webhook_id) await stripeApi(key, "DELETE", `/v1/webhook_endpoints/${webhook.id}`).catch(() => undefined);
    throw error;
  }

  const { settled } = before && (await movesAccount(before, key, account?.id ?? null)) ? await leaveAccount(before) : { settled: Promise.resolve() };
  // With the old key, or the new one when the old one was rolled in the same account.
  if (previous && previous.extra?.webhook_id !== webhook?.id) await removeStripeWebhook(previous, key);
  return { account_label: label, webhook: Boolean(webhook), settled };
}

/**
 * Before the company's own key is forgotten: settle its Stripe account's invoices (unless the
 * server's key, used from then on, reaches the same account) and take Crewtavo's webhook out.
 * `settled` can finish after the response.
 */
export async function disconnectStripe(env: Env, admin: Db, companyId: string, secret: StoredSecret): Promise<{ settled: Promise<void> }> {
  const before = secret.api_key ? await context(env, admin, companyId, { key: secret.api_key, own: true, account: secret.extra?.account_id ?? null }) : null;
  const left = before && (!env.STRIPE_SECRET_KEY || (await movesAccount(before, env.STRIPE_SECRET_KEY, null))) ? await leaveAccount(before) : { settled: Promise.resolve() };
  await removeStripeWebhook(secret);
  return left;
}

/**
 * The webhook in use, brought up to date with `key`, when `key` can reach it: Stripe only finds a
 * webhook with a key for its own account (and mode). Null otherwise.
 */
async function sameWebhook(key: string, previous: StoredSecret | null, endpoint: Record<string, string | string[] | Record<string, string>>) {
  const id = previous?.extra?.webhook_id;
  const secret = previous?.extra?.webhook_secret;
  if (!id || !secret) return null;
  return stripeApi(key, "POST", `/v1/webhook_endpoints/${id}`, endpoint).then(
    () => ({ id, secret }),
    () => null,
  );
}

/** Best effort: take Crewtavo's webhook out of the Stripe account (with `fallbackKey` if the secret's key no longer works). */
export async function removeStripeWebhook(secret: StoredSecret, fallbackKey?: string) {
  if (!secret.api_key || !secret.extra?.webhook_id) return;
  const path = `/v1/webhook_endpoints/${secret.extra.webhook_id}`;
  await stripeApi(secret.api_key, "DELETE", path)
    .catch(() => (fallbackKey ? stripeApi(fallbackKey, "DELETE", path) : undefined))
    .catch(() => undefined);
}

/** Whether `key` (on `account`, when known) reaches another Stripe account, or the other mode, than the one in use. */
async function movesAccount(before: Ctx, key: string, account: string | null): Promise<boolean> {
  if (before.key === key) return false;
  if (before.livemode !== key.includes("_live_")) return true;
  if (before.account && account) return before.account !== account;
  // The accounts can't be compared (a restricted key, or the server's): see whether the new key
  // finds an invoice made with the old one.
  const { data } = await before.admin.from("stripe_invoices").select(LINKED).eq("company_id", before.companyId).in("status", LIVE).is("detached_at", null).not("stripe_id", "is", null);
  const sample = (data ?? []).find((row) => inUse(before, row));
  if (!sample) return false;
  return stripeApi(key, "GET", `/v1/invoices/${sample.stripe_id}`).then(
    () => false,
    (error) => missing(error),
  );
}

/**
 * The key in use is being switched for another Stripe account's (or test for live), or
 * disconnected, and Crewtavo won't hear from that account again. Its invoices stop counting as live
 * here at once; then, with the old key: open ones Crewtavo made are voided there, so nobody pays
 * where nobody's listening (ones paid meanwhile are recorded instead), and a bank payment still
 * clearing is left alone, so the client isn't asked to pay twice, with a note telling the office to
 * record it once it clears. Invoices made in Stripe are the business's own and stay as they are.
 * Stripe errors are logged, not thrown: they don't hold up the switch.
 */
async function leaveAccount(old: Ctx): Promise<{ settled: Promise<void> }> {
  const { data, error } = await old.admin.from("stripe_invoices").select(`${LINKED}, invoice_id`).eq("company_id", old.companyId).in("status", LIVE).is("detached_at", null);
  fail(error);
  const rows = (data ?? []).filter((row) => inUse(old, row));
  await detach(old.admin, rows.map((row) => row.id));
  return { settled: settleLeft(old, rows) };
}

async function settleLeft(old: Ctx, rows: Array<Linked & { invoice_id: string | null }>) {
  for (const row of rows) {
    try {
      if (row.status === "open" && row.origin === "crewtavo") await voidStripeInvoice(old, row);
      else if (row.status === "processing") await stillClearing(old, row);
    } catch (error) {
      console.error("Couldn't settle a Stripe invoice in the account being left", row.stripe_id, error);
    }
  }
}

/** A bank payment on its way in a Stripe account Crewtavo is leaving: recorded if it's done, otherwise the office follows it. */
async function stillClearing(old: Ctx, row: Linked & { invoice_id: string | null }) {
  if (!row.stripe_id || !row.invoice_id) return;
  const current = await fetchInvoice(old.key, row.stripe_id);
  if (current.status !== "open") return applyInvoice(old, current);
  const { data: invoice } = await old.admin.from("invoices").select("id, number, client_id").eq("company_id", old.companyId).eq("id", row.invoice_id).maybeSingle();
  if (!invoice) return;
  await noteOnClient(old.admin, {
    company_id: old.companyId, client_id: invoice.client_id, invoice_id: invoice.id, key: `${row.stripe_id}:left`, subject: "Bank payment still clearing",
    body:
      `A bank payment for invoice #${invoice.number} was still clearing in the Stripe account Crewtavo used before, so it won't show up here on its own. Check it in that Stripe account, and record the payment here once it clears. ` +
      `The client can't pay this invoice online for the next ${CLEARING_DAYS} days while it might still clear; after that they can again, in case it bounced.`,
  });
}

// ---------------------------------------------------------------------------------------------
// Crewtavo invoices in Stripe
// ---------------------------------------------------------------------------------------------

type Billable = BillableInvoice & { id: string; status: string; notes: string | null; client_id: string; due_on: string | null };
const BILLABLE =
  "id, number, status, subject, notes, client_id, due_on, subtotal, discount_amount, credit_amount, tax_rate, tax_amount, retainage_pct, retainage_amount, amount_paid, balance_due, promo:promo_codes(code), credits:referral_credits(amount, note), lines:invoice_line_items(name, quantity, unit, unit_price, sort)";

async function billable(ctx: Ctx, invoiceId: string): Promise<Billable | null> {
  const { data, error } = await ctx.admin.from("invoices").select(BILLABLE).eq("company_id", ctx.companyId).eq("id", invoiceId).maybeSingle();
  fail(error);
  return data as unknown as Billable | null;
}

interface Linked {
  id: string;
  stripe_id: string | null;
  origin: string;
  status: string;
  amount_due: number;
  tip_amount: number;
  hosted_url: string | null;
  created_at: string;
  livemode: boolean;
  stripe_account: string | null;
  detached_at: string | null;
}
const LINKED = "id, stripe_id, origin, status, amount_due, tip_amount, hosted_url, created_at, livemode, stripe_account, detached_at";

/**
 * Whether a Stripe invoice is in the account (and mode) the key in use reaches, as far as Crewtavo
 * can tell. Ones made with a key since switched for another account's, or test for live, aren't:
 * this key can't void them, and Crewtavo no longer hears when they're paid.
 */
const inUse = (ctx: Ctx, row: Linked) =>
  !row.detached_at && row.livemode === ctx.livemode && (!row.stripe_account || !ctx.account || row.stripe_account === ctx.account);

/** Stop following Stripe invoices the key in use can't reach. They no longer count as live. */
async function detach(admin: Db, ids: string[]) {
  if (ids.length) fail((await admin.from("stripe_invoices").update({ detached_at: new Date().toISOString() }).in("id", ids).is("detached_at", null)).error);
}

/** Stripe can't find it with this key: it's in another Stripe account, or the other mode. */
const missing = (error: unknown) => error instanceof StripeError && error.status === 404 && error.code === "resource_missing";

/**
 * Past this, a bank payment has cleared or bounced (SEPA debits, the slowest, take up to 14
 * business days).
 */
const CLEARING_DAYS = 30;

/**
 * A bank payment on its way: don't ask for the money again. That holds for one in a Stripe account
 * Crewtavo has since left too, as it may still clear there, but only as long as one can take:
 * Crewtavo doesn't hear if it bounces there, and the office was told to record it if it clears
 * (stillClearing). Test money never holds up a live key.
 */
const waiting = (row: { status: string; livemode: boolean; detached_at: string | null }, livemode: boolean) =>
  row.status === "processing" && (row.livemode || !livemode) && (!row.detached_at || Date.now() - Date.parse(row.detached_at) < CLEARING_DAYS * 24 * 60 * 60_000);

/** An invoice's Stripe invoices, newest first, and the live one (if any). */
async function linkedTo(ctx: Ctx, invoiceId: string): Promise<{ linked: Linked[]; live: Linked | undefined }> {
  const { data, error } = await ctx.admin.from("stripe_invoices").select(LINKED).eq("company_id", ctx.companyId).eq("invoice_id", invoiceId).order("created_at", { ascending: false });
  fail(error);
  let linked = data ?? [];
  // Live ones from another Stripe account or mode (the key was switched) make way for this key's.
  const elsewhere = linked.filter((row) => LIVE.includes(row.status) && !row.detached_at && !inUse(ctx, row));
  if (elsewhere.length) {
    await detach(ctx.admin, elsewhere.map((row) => row.id));
    const now = new Date().toISOString();
    linked = linked.map((row) => (elsewhere.includes(row) ? { ...row, detached_at: now } : row));
  }
  const live = linked.find((row) => LIVE.includes(row.status) && inUse(ctx, row));
  // Still "creating" after two minutes: the server stopped partway. Clear it so it can be made again.
  if (live?.status === "creating" && Date.now() - Date.parse(live.created_at) > 2 * 60_000) {
    if (live.stripe_id) {
      await stripeApi(ctx.key, "DELETE", `/v1/invoices/${live.stripe_id}`).catch(() => stripeApi(ctx.key, "POST", `/v1/invoices/${live.stripe_id}/void_invoice`).catch(() => undefined));
    }
    await ctx.admin.from("stripe_invoices").delete().eq("id", live.id).eq("status", "creating");
    return { linked: linked.filter((row) => row.id !== live.id), live: undefined };
  }
  return { linked, live };
}

/** The client's Stripe customer: linked already, the customer with their email, or a new one. */
async function customerFor(ctx: Ctx, clientId: string, again = false): Promise<string> {
  const link = { company_id: ctx.companyId, provider: "stripe", entity: "client", local_id: clientId };
  if (!again) {
    const { data } = await ctx.admin.from("sync_links").select("external_id").match(link).maybeSingle();
    if (data) return data.external_id;
  }
  const { data: client, error } = await ctx.admin.from("clients").select("display_name, email, phone").eq("company_id", ctx.companyId).eq("id", clientId).maybeSingle();
  fail(error);
  if (!client) throw new IntegrationError("Client not found");
  // Businesses moving from Stripe invoicing already have their clients there.
  let id = client.email ? (await stripeApi<{ data: Array<{ id: string }> }>(ctx.key, "GET", "/v1/customers", { email: client.email, limit: 1 })).data[0]?.id : undefined;
  id ??= (await stripeApi<{ id: string }>(ctx.key, "POST", "/v1/customers", { name: client.display_name, email: client.email, phone: client.phone, metadata: { crewtavo_client_id: clientId } })).id;
  fail((await ctx.admin.from("sync_links").upsert({ ...link, external_id: id, synced_at: new Date().toISOString() })).error);
  return id;
}

/**
 * Make the Stripe invoice for what's owed now (plus a tip), finalized but not emailed by Stripe:
 * Crewtavo sends the invoice, and the Client Hub's Pay button opens Stripe's page for it.
 * Returns null when another request is already making one. Callers keep it to at least what
 * Stripe can charge (minimumCharge).
 */
async function createStripeInvoice(ctx: Ctx, invoice: Billable, tipCents: number): Promise<Linked | null> {
  const amount = cents(invoice.balance_due) + tipCents;
  const { data: row, error } = await ctx.admin
    .from("stripe_invoices")
    .insert({
      company_id: ctx.companyId, invoice_id: invoice.id, origin: "crewtavo", status: "creating", amount_due: amount / 100, tip_amount: tipCents / 100,
      livemode: ctx.livemode, stripe_account: ctx.account,
    })
    .select(LINKED)
    .single();
  if (error?.code === "23505") return null;
  fail(error);
  if (!row) return null;

  let stripeId: string | null = null;
  let final: StripeInvoice;
  let done: { status: string; number: string | null; hosted_url: string | null };
  try {
    const params = (customer: string) => ({
      customer,
      currency: ctx.currency,
      collection_method: "send_invoice",
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      // Stripe wants a due date in the future; one that has passed shows as due now.
      due_date: Math.max(invoice.due_on ? Math.floor(Date.parse(`${invoice.due_on}T23:00:00Z`) / 1000) : 0, Math.floor(Date.now() / 1000) + 3600),
      description: invoice.notes?.slice(0, 1500) || undefined,
      custom_fields: [{ name: "Invoice", value: `#${invoice.number}` }],
      metadata: { crewtavo_company_id: ctx.companyId, crewtavo_invoice_id: invoice.id, crewtavo_row: row.id, tip_cents: String(tipCents) },
    });
    let customer = await customerFor(ctx, invoice.client_id);
    let draft: StripeInvoice;
    try {
      draft = await stripeApi<StripeInvoice>(ctx.key, "POST", "/v1/invoices", params(customer), { idempotencyKey: `crewtavo-invoice-${row.id}` });
    } catch (error) {
      if (!(error instanceof StripeError && error.code === "resource_missing" && error.param === "customer")) throw error;
      // The customer was deleted in Stripe: make a new one.
      customer = await customerFor(ctx, invoice.client_id, true);
      draft = await stripeApi<StripeInvoice>(ctx.key, "POST", "/v1/invoices", params(customer), { idempotencyKey: `crewtavo-invoice-${row.id}-again` });
    }
    stripeId = draft.id;
    fail((await ctx.admin.from("stripe_invoices").update({ stripe_id: draft.id, livemode: draft.livemode }).eq("id", row.id)).error);
    for (const [i, item] of stripeLineItems(invoice, tipCents, ctx.currency.toUpperCase()).entries()) {
      await stripeApi(ctx.key, "POST", "/v1/invoiceitems", { customer, invoice: draft.id, currency: ctx.currency, amount: item.amount, description: item.description }, { idempotencyKey: `crewtavo-item-${row.id}-${i}` });
    }
    final = await stripeApi<StripeInvoice>(ctx.key, "POST", `/v1/invoices/${draft.id}/finalize`, { auto_advance: false }, { idempotencyKey: `crewtavo-finalize-${row.id}` });
    // Finalizing puts the client's balance in Stripe on it, so Stripe can ask for more or less than
    // was sent (recordPayment books each part where it belongs). Credit that covers it all, or leaves
    // less than Stripe charges, has it paid at once.
    done = { status: final.status === "paid" ? "paid" : "open", number: final.number, hosted_url: final.hosted_invoice_url };
    fail((await ctx.admin.from("stripe_invoices").update(done).eq("id", row.id)).error);
  } catch (error) {
    // Leave nothing half made. Drafts can be deleted outright.
    if (stripeId) await stripeApi(ctx.key, "DELETE", `/v1/invoices/${stripeId}`).catch(() => undefined);
    await ctx.admin.from("stripe_invoices").delete().eq("id", row.id);
    throw error;
  }
  if (final.status === "paid") await recordPayment(ctx, final);
  return { ...row, ...done, stripe_id: final.id };
}

const fetchInvoice = (key: string, id: string) => stripeApi<StripeInvoice>(key, "GET", `/v1/invoices/${id}`, { expand: ["charge.balance_transaction"] });

/**
 * Void an open Stripe invoice. False when it turns out to be paid (and that's recorded instead).
 * One this key can't find was made in another Stripe account (from before Crewtavo noted which):
 * there's nothing here to void, so it's let go of.
 */
async function voidStripeInvoice(ctx: Ctx, row: Linked): Promise<boolean> {
  if (!row.stripe_id) return false;
  try {
    await stripeApi(ctx.key, "POST", `/v1/invoices/${row.stripe_id}/void_invoice`);
  } catch (error) {
    if (missing(error)) {
      await detach(ctx.admin, [row.id]);
      return true;
    }
    const current = await fetchInvoice(ctx.key, row.stripe_id).catch(() => null);
    if (current?.status === "paid") {
      await applyInvoice(ctx, current);
      return false;
    }
    if (current?.status !== "void") throw error;
  }
  fail((await ctx.admin.from("stripe_invoices").update({ status: "void" }).eq("id", row.id)).error);
  return true;
}

/**
 * Write off an open Stripe invoice made in Stripe (its books are Stripe's), as it was here. False
 * when it turns out to be paid (and that's recorded instead).
 */
async function writeOffStripeInvoice(ctx: Ctx, row: Linked): Promise<boolean> {
  if (!row.stripe_id) return false;
  try {
    await stripeApi(ctx.key, "POST", `/v1/invoices/${row.stripe_id}/mark_uncollectible`);
  } catch (error) {
    if (missing(error)) {
      await detach(ctx.admin, [row.id]);
      return true;
    }
    const current = await fetchInvoice(ctx.key, row.stripe_id).catch(() => null);
    if (current?.status === "paid") {
      await applyInvoice(ctx, current);
      return false;
    }
    if (current?.status !== "uncollectible" && current?.status !== "void") throw error;
  }
  fail((await ctx.admin.from("stripe_invoices").update({ status: "uncollectible" }).eq("id", row.id)).error);
  return true;
}

/**
 * Bring an invoice's Stripe invoice in step with it (the outbox's stripe.invoice job). Ours are
 * replaced when the balance changes and voided once nothing is owed; ones made in Stripe are
 * voided there once they're paid or voided here, and written off there when they're written off
 * here.
 */
export async function syncStripeInvoice(env: Env, admin: Db, companyId: string, invoiceId: string): Promise<string> {
  const ctx = await context(env, admin, companyId);
  if (!ctx) return "Stripe isn't connected";
  const invoice = await billable(ctx, invoiceId);
  if (!invoice) return "invoice deleted";
  const { linked, live } = await linkedTo(ctx, invoiceId);
  const imported = linked.some((row) => row.origin === "stripe");
  const owed = OWED.includes(invoice.status) && cents(invoice.balance_due) > 0;

  // A bank payment on its way: leave it be.
  if (linked.some((row) => waiting(row, ctx.livemode))) return "busy";
  const stale = !owed || (!imported && cents(live?.amount_due) - cents(live?.tip_amount) !== cents(invoice.balance_due));
  if (live?.status === "creating") {
    // Another request is making it (the Hub's Pay button, say). If the invoice changed meanwhile
    // (back to draft, a check came in), the outbox tries again once it's made, to void or replace it.
    if (stale) throw new IntegrationError("Stripe's invoice for this was still being made. Trying again in a few minutes.");
    return "busy";
  }
  if (live && !stale) return "in step";
  if (live && imported && invoice.status === "written_off") return (await writeOffStripeInvoice(ctx, live)) ? "written off" : "paid in Stripe";
  if (live && !(await voidStripeInvoice(ctx, live))) return "paid in Stripe";
  // Ones made in Stripe stay Stripe's. Ours go to Stripe when sent, for companies with their own key.
  if (imported || !owed || !ctx.own) return live ? "voided" : "nothing to do";
  // A few cents left (after a check, say) are less than Stripe charges: Stripe would mark them paid
  // and put them on the client's next invoice there. They're paid some other way.
  if (cents(invoice.balance_due) < minimumCharge(ctx.currency)) return "too small for Stripe";
  await createStripeInvoice(ctx, invoice, 0);
  return "created";
}

/**
 * Before handing out a Stripe invoice's page: one whose account Crewtavo can't compare with the
 * key's (made before it noted accounts, or with a key that can't read its account) is looked up
 * with the key in use first, and let go of if Stripe can't find it there.
 */
async function stillThere(ctx: Ctx, row: Linked): Promise<boolean> {
  if (!row.stripe_id || (row.stripe_account && ctx.account)) return true;
  try {
    await stripeApi(ctx.key, "GET", `/v1/invoices/${row.stripe_id}`);
  } catch (error) {
    if (!missing(error)) throw error;
    await detach(ctx.admin, [row.id]);
    return false;
  }
  if (ctx.account) fail((await ctx.admin.from("stripe_invoices").update({ stripe_account: ctx.account }).eq("id", row.id)).error);
  return true;
}

/** Stripe invoices made for one invoice in an hour, past which the Client Hub doesn't make another. */
const STRIPE_INVOICES_PER_HOUR = 5;

/** The Stripe page where the client pays this invoice (plus an optional tip), made if needed. */
export async function stripeCheckout(env: Env, admin: Db, companyId: string, invoiceId: string, tipCents: number): Promise<string> {
  const ctx = await context(env, admin, companyId);
  if (!ctx) throw new HttpError(501, "Online payments aren't set up.");
  for (let attempt = 0; attempt < 6; attempt++) {
    const invoice = await billable(ctx, invoiceId);
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    if (invoice.status === "void") throw new HttpError(409, "This invoice was cancelled, so it can't be paid.");
    if (invoice.status === "draft") throw new HttpError(409, "This invoice isn't ready yet.");
    if (cents(invoice.balance_due) <= 0) throw new HttpError(409, "This invoice is already paid.");
    const { linked, live } = await linkedTo(ctx, invoiceId);
    if (linked.some((row) => waiting(row, ctx.livemode))) throw new HttpError(409, PROCESSING_MESSAGE);
    if (live?.status === "creating") {
      await sleep(1500);
      continue;
    }
    // Made in Stripe: pay it there, as long as it still asks for what's owed.
    if (linked.some((row) => row.origin === "stripe")) {
      if (live?.hosted_url && cents(live.amount_due) === cents(invoice.balance_due) && (await stillThere(ctx, live))) return live.hosted_url;
      throw new HttpError(409, "This invoice can't be paid online right now. Contact us to pay it.");
    }
    if (live?.hosted_url && cents(live.amount_due) === cents(invoice.balance_due) + tipCents) {
      if (await stillThere(ctx, live)) return live.hosted_url;
      continue;
    }
    // Less than Stripe charges (see syncStripeInvoice), unless the tip makes it enough.
    if (cents(invoice.balance_due) + tipCents < minimumCharge(ctx.currency)) throw new HttpError(409, "What's left on this invoice is too small to pay online. Contact us to pay it.");
    if (live) {
      // Each new tip (or promo code put on or taken off here) voids the Stripe invoice and makes
      // another, numbered in Stripe, so only a few an hour, counting the ones the sync made. When
      // what's owed changed, the sync replaces it within a few minutes anyway.
      const tipOnly = cents(live.amount_due) - cents(live.tip_amount) === cents(invoice.balance_due);
      const lastHour = linked.filter((row) => row.origin === "crewtavo" && Date.now() - Date.parse(row.created_at) < 60 * 60_000).length;
      if (lastHour >= STRIPE_INVOICES_PER_HOUR) {
        throw new HttpError(
          429,
          tipOnly
            ? "You've changed the tip a few times already. Pay with the tip you chose before, or try another in an hour."
            : "This invoice just changed, so its payment page is being updated. Try again in a few minutes.",
        );
      }
      if (!(await voidStripeInvoice(ctx, live))) throw new HttpError(409, "This invoice is already paid.");
    }
    const made = await createStripeInvoice(ctx, invoice, tipCents);
    if (made?.hosted_url) return made.hosted_url;
    await sleep(1500);
  }
  throw new HttpError(503, "Online payments are busy. Try again in a minute.");
}

/** For the Client Hub: can this invoice be paid online, and is a bank payment already on its way? */
export async function hubPayment(env: Env, admin: Db, companyId: string, invoiceId: string) {
  const [access, { data: linked }] = await Promise.all([
    stripeAccess(env, admin, companyId),
    admin.from("stripe_invoices").select("origin, status, livemode, detached_at").eq("company_id", companyId).eq("invoice_id", invoiceId),
  ]);
  const livemode = Boolean(access?.key.includes("_live_"));
  return {
    enabled: Boolean(access),
    processing: (linked ?? []).some((row) => waiting(row, livemode)),
    imported: (linked ?? []).some((row) => row.origin === "stripe"),
  };
}

// ---------------------------------------------------------------------------------------------
// Invoices paid, voided or made in Stripe
// ---------------------------------------------------------------------------------------------

async function applyInvoice(ctx: Ctx, invoice: StripeInvoice) {
  if (invoice.metadata?.crewtavo_invoice_id) return settleOwnInvoice(ctx, invoice);
  await importInvoice(ctx, invoice, false);
}

/** One of ours changed in Stripe: record the payment, or that it was voided or written off. */
async function settleOwnInvoice(ctx: Ctx, invoice: StripeInvoice) {
  const meta = invoice.metadata ?? {};
  if (meta.crewtavo_company_id !== ctx.companyId) return;
  let { data: row } = await ctx.admin.from("stripe_invoices").select("id, status, stripe_id").eq("stripe_id", invoice.id).maybeSingle();
  if (!row && meta.crewtavo_row) {
    row = (await ctx.admin.from("stripe_invoices").select("id, status, stripe_id").eq("company_id", ctx.companyId).eq("id", meta.crewtavo_row).maybeSingle()).data;
    if (row && !row.stripe_id) await ctx.admin.from("stripe_invoices").update({ stripe_id: invoice.id }).eq("id", row.id);
  }

  if (invoice.status === "paid") await recordPayment(ctx, invoice);
  // Written off in the Stripe dashboard: written off here too, once, so a write-off undone here
  // stays undone when Stripe repeats the event.
  if (invoice.status === "uncollectible" && row && row.status !== "uncollectible") {
    fail(
      (
        await ctx.admin
          .from("invoices")
          .update({ status: "written_off", written_off_at: isoAt(invoice.status_transitions.marked_uncollectible_at) })
          .eq("company_id", ctx.companyId)
          .eq("id", meta.crewtavo_invoice_id!)
          .in("status", OWED)
          .gt("balance_due", 0)
      ).error,
    );
  }
  const status = invoice.status === "paid" || invoice.status === "void" || invoice.status === "uncollectible" ? invoice.status : null;
  if (row && status && row.status !== status) await ctx.admin.from("stripe_invoices").update({ status }).eq("id", row.id);
}

/**
 * A payment on one of our Stripe invoices, as a Crewtavo payment (with its tip and fee). Stripe puts
 * the client's balance there on the invoice when it's finalized: credit they had pays part of it,
 * and what they owed from before is added to what they're charged. Only the invoice's own money is
 * booked to it; what was owed from before is the client's, without an invoice (`<charge>:before`,
 * so a refund or a lost dispute of the charge takes it back too). A credit note issued in Stripe
 * before it was paid took its amount off what Stripe asked for, so that's booked to it as well.
 *
 * Credit that pays all of the invoice goes on to the tip (Stripe puts the balance on all it asks
 * for): then only what's left of the tip is charged, so that payment is only a tip, and credit that
 * covers the tip too leaves nothing to charge. The credit and the charge each carry the part of the
 * tip they paid.
 */
async function recordPayment(ctx: Ctx, invoice: StripeInvoice) {
  const meta = invoice.metadata ?? {};
  const { data: target } = await ctx.admin.from("invoices").select("id, number, client_id, status").eq("company_id", ctx.companyId).eq("id", meta.crewtavo_invoice_id!).maybeSingle();
  if (!target) return;
  const tip = Math.max(0, Number(meta.tip_cents) || 0);
  const balance = invoice.starting_balance ?? 0;
  // Paid in Stripe, or marked paid in the Stripe dashboard for money that came some other way.
  const received = invoice.paid_out_of_band ? invoice.amount_due : invoice.amount_paid;
  const before = Math.min(Math.max(balance, 0), received);
  const credit = Math.min(Math.max(-balance, 0), invoice.total - tip);
  const creditTip = Math.min(Math.max(-balance - credit, 0), tip);
  const credited = Math.min(invoice.pre_payment_credit_notes_amount ?? 0, invoice.total - tip - credit);
  // What was received paid the rest of the tip, and the invoice.
  const receivedTip = Math.max(0, Math.min(tip - creditTip, received - before));
  const paid = received - before - receivedTip;
  const owedBefore = `Owed from before in Stripe, paid with invoice #${target.number}`;
  const payments: Array<{ amount: number; tip_amount?: number; method: string; processor: string | null; processor_ref: string; fee_amount?: number; notes?: string; invoice_id?: null }> = [];
  if (invoice.paid_out_of_band) {
    // Money that came some other way, so it stays editable.
    if (paid > 0) payments.push({ amount: paid / 100, method: "other", processor: null, processor_ref: `${invoice.id}:paid`, notes: "Marked paid in Stripe" });
    if (before > 0) payments.push({ amount: before / 100, method: "other", processor: null, processor_ref: `${invoice.id}:before`, invoice_id: null, notes: `Marked paid in Stripe. ${owedBefore}` });
  } else {
    const { charge, fee } = chargeOf(invoice);
    const ref = invoice.payment_intent ?? charge?.id ?? `${invoice.id}:paid`;
    if (paid > 0 || receivedTip > 0) {
      payments.push({
        amount: paid / 100, tip_amount: receivedTip / 100, method: paymentMethod(charge), processor: "stripe",
        processor_ref: ref, fee_amount: fee / 100,
      });
    }
    if (before > 0) payments.push({ amount: before / 100, method: paymentMethod(charge), processor: "stripe", processor_ref: `${ref}:before`, invoice_id: null, notes: owedBefore });
  }
  if (credit > 0) payments.push({ amount: credit / 100, tip_amount: creditTip / 100, method: "other", processor: null, processor_ref: `${invoice.id}:credit`, notes: "Account credit in Stripe" });
  if (credited > 0) payments.push({ amount: credited / 100, method: "other", processor: null, processor_ref: `${invoice.id}:credit_note`, notes: "Credit note in Stripe" });
  if (!payments.length) return;
  // Paid after it was voided here (a bank payment that was already on its way): a void invoice
  // stays void, so the money is the client's, with a note saying which invoice it was for. (What
  // was owed from before says so already.)
  const voided = target.status === "void";
  for (const payment of payments) {
    // processor_ref is unique, so Stripe repeating an event can't record a payment twice.
    const { error } = await ctx.admin.from("payments").insert({
      company_id: ctx.companyId, invoice_id: voided ? null : target.id, client_id: target.client_id, received_at: isoAt(invoice.status_transitions.paid_at), recorded_by: null, ...payment,
      ...(voided && payment.invoice_id !== null ? { notes: [payment.notes, `For invoice #${target.number}, which is void`].filter(Boolean).join(". ") } : {}),
    });
    if (error && error.code !== "23505") fail(error);
  }
}

/** A bank payment bounced (card declines don't count): it's owed again, and the office hears about it. */
async function bankPaymentFailed(env: Env, ctx: Ctx, invoice: StripeInvoice) {
  const { data: row } = await ctx.admin
    .from("stripe_invoices")
    .select("id, status, invoice_id, invoice:invoices(id, number, client_id)")
    .eq("company_id", ctx.companyId)
    .eq("stripe_id", invoice.id)
    .maybeSingle();
  if (row?.status !== "processing" && row?.status !== "open") return;
  const target = row.invoice as unknown as { id: string; number: number; client_id: string } | null;
  if (row.status === "processing") {
    await ctx.admin.from("stripe_invoices").update({ status: "open" }).eq("id", row.id);
    if (target) {
      await noteOnClient(ctx.admin, {
        company_id: ctx.companyId, client_id: target.client_id, invoice_id: target.id, key: `${invoice.id}:failed:${invoice.payment_intent ?? ""}`,
        subject: "Bank payment failed", body: `The bank payment for invoice #${target.number} didn't go through. The invoice is still owed.`,
      });
    }
  }
  // The Stripe sync waits while a bank payment is on its way, so catch up on what changed meanwhile
  // (the invoice went back to draft, or a check came in). Again if Stripe repeats the event.
  if (row.invoice_id) await syncStripeInvoice(env, ctx.admin, ctx.companyId, row.invoice_id);
}

/** An invoice made in Stripe, brought in or brought up to date. History comes in quietly. */
async function importInvoice(ctx: Ctx, invoice: StripeInvoice, quiet: boolean) {
  if (invoice.status === "draft" || (!invoice.total && !invoice.amount_due)) return;
  const lines = invoice.lines.has_more ? await allLines(ctx.key, invoice.id) : invoice.lines.data;
  const { charge, fee } = chargeOf(invoice);
  const paidAt = isoAt(invoice.status_transitions.paid_at);
  // A credit note issued there before it was paid is how part of a payment is recorded in Stripe
  // (see stripe_payment_guard), so it's booked too.
  const credited = (invoice.pre_payment_credit_notes_amount ?? 0) / 100;
  const payment =
    invoice.status !== "paid" ? null
    : invoice.paid_out_of_band ? { amount: invoice.amount_due / 100, method: "other", processor_ref: `${invoice.id}:paid`, received_at: paidAt, out_of_band: true, credited }
    : {
        amount: invoice.amount_paid / 100, method: paymentMethod(charge), processor_ref: invoice.payment_intent ?? charge?.id ?? `${invoice.id}:paid`,
        received_at: paidAt, fee: fee / 100, refunded: (charge?.amount_refunded ?? 0) / 100, credited,
      };
  const sent = invoice.status_transitions.finalized_at ?? invoice.created;
  const { error } = await ctx.admin.rpc("stripe_import_invoice", {
    p_company: ctx.companyId,
    p_quiet: quiet,
    p_data: asJson({
      stripe_id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      livemode: invoice.livemode,
      hosted_url: invoice.hosted_invoice_url,
      amount_due: invoice.amount_due / 100,
      issued_on: stripeDay(sent, ctx.timezone),
      due_on: invoice.due_date ? stripeDay(invoice.due_date, ctx.timezone) : null,
      sent_at: isoAt(sent),
      written_off_at: invoice.status_transitions.marked_uncollectible_at ? isoAt(invoice.status_transitions.marked_uncollectible_at) : null,
      subject: invoice.description?.split("\n")[0]?.trim().slice(0, 200) || `Stripe invoice ${invoice.number ?? ""}`.trim(),
      customer: { id: invoice.customer, name: invoice.customer_name, email: invoice.customer_email, phone: invoice.customer_phone, address: invoice.customer_address },
      lines: importedLines(invoice, lines),
      payment,
    }),
  });
  fail(error);
  // Which Stripe account it's in, when known.
  if (ctx.account) {
    fail((await ctx.admin.from("stripe_invoices").update({ stripe_account: ctx.account }).eq("company_id", ctx.companyId).eq("stripe_id", invoice.id).is("stripe_account", null)).error);
  }
}

async function allLines(key: string, invoiceId: string): Promise<StripeInvoiceLine[]> {
  const lines: StripeInvoiceLine[] = [];
  for await (const line of stripeList<StripeInvoiceLine>(key, `/v1/invoices/${invoiceId}/lines`)) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

/** Where an event came in: a company's own webhook, or the deployment's (STRIPE_WEBHOOK_SECRET). */
export type WebhookRoute = { companyId?: string };

/**
 * Handle one verified event. Objects are read back from Stripe at our pinned API version (the
 * event may be old, or rendered at another version). Returns the company whose automations should
 * run: one where the event recorded money or an invoice, if any.
 */
export async function handleStripeEvent(env: Env, admin: Db, route: WebhookRoute, event: StripeEvent): Promise<string | null> {
  const object = event.data.object;
  const access = route.companyId ? await stripeAccess(env, admin, route.companyId) : env.STRIPE_SECRET_KEY ? { key: env.STRIPE_SECRET_KEY, own: false } : null;
  const key = access?.key ?? null;
  if (event.type.startsWith("checkout.session.")) return checkoutSession(admin, route, event.type, object);
  if (event.type === "payment_intent.processing") return bankPaymentStarted(admin, route, object.invoice as string | null, event.created);
  if (event.type === "charge.refunded") return refunded(admin, route, object as StripeCharge);
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") return disputed(admin, route, event.type, object as Dispute);
  if (!key) return null;

  if (event.type.startsWith("invoice.")) {
    const invoice = await fetchInvoice(key, object.id as string);
    const companyId = await companyFor(env, admin, route, invoice.metadata?.crewtavo_company_id);
    const ctx = companyId ? await context(env, admin, companyId, access) : null;
    if (!ctx) return null;
    if (event.type === "invoice.payment_failed") await bankPaymentFailed(env, ctx, invoice);
    else await applyInvoice(ctx, invoice);
    return ctx.companyId;
  }
  if (event.type.startsWith("payout.")) {
    const companyId = await companyFor(env, admin, route);
    const ctx = companyId ? await context(env, admin, companyId, access) : null;
    if (!ctx) return null;
    await savePayout(ctx, await stripeApi<StripePayout>(key, "GET", `/v1/payouts/${object.id}`));
    return null;
  }
  return null;
}

/**
 * The company an event belongs to. A company's own webhook is only ever about that company. On the
 * deployment's, our metadata says, or (for invoices made in Stripe and deposits) the instance's
 * only company, as long as it hasn't connected a Stripe account of its own.
 */
async function companyFor(env: Env, admin: Db, route: WebhookRoute, fromMetadata?: string | null): Promise<string | null> {
  if (route.companyId) return !fromMetadata || fromMetadata === route.companyId ? route.companyId : null;
  if (fromMetadata) return fromMetadata;
  const { data } = await admin.from("companies").select("id").limit(2);
  if (data?.length !== 1) return null;
  const own = await loadSecret(env, admin, data[0]!.id, "stripe").catch(() => null);
  return own?.api_key ? null : data[0]!.id;
}

async function noteOnClient(admin: Db, note: { company_id: string; client_id: string; invoice_id: string | null; key: string; subject: string; body: string }) {
  const { data: noted } = await admin.from("messages").select("id").eq("company_id", note.company_id).eq("external_id", note.key).limit(1);
  if (noted?.length) return;
  await admin.from("messages").insert({
    company_id: note.company_id, client_id: note.client_id, channel: "note", direction: "internal", status: "received", subject: note.subject, body: note.body,
    related_type: note.invoice_id ? "invoice" : null, related_id: note.invoice_id, sent_by: null, external_id: note.key,
  });
}

/**
 * A bank (ACH) payment started on a Stripe invoice: it takes a few days, so say so instead of asking
 * again. The office sees when it started (`at`, the event's time), so nobody records it twice.
 */
async function bankPaymentStarted(admin: Db, route: WebhookRoute, stripeInvoiceId: string | null, at: number | undefined) {
  if (!stripeInvoiceId) return null;
  const { data: row } = await admin.from("stripe_invoices").select("id, company_id").eq("stripe_id", stripeInvoiceId).maybeSingle();
  if (!row || (route.companyId && row.company_id !== route.companyId)) return null;
  await admin.from("stripe_invoices").update({ status: "processing", processing_at: isoAt(at) }).eq("id", row.id).eq("status", "open");
  return null;
}

/** Checkout pages from before invoices went through Stripe: card payments, and bank payments days later. */
async function checkoutSession(admin: Db, route: WebhookRoute, type: string, object: Record<string, any>) {
  const { company_id, invoice_id, tip_cents } = (object.metadata ?? {}) as Record<string, string>;
  if (!company_id || !invoice_id || (route.companyId && company_id !== route.companyId)) return null;
  const { data: invoice } = await admin.from("invoices").select("client_id, number").eq("company_id", company_id).eq("id", invoice_id).maybeSingle();
  if (!invoice) return null;

  if ((type === "checkout.session.completed" && object.payment_status === "paid") || type === "checkout.session.async_payment_succeeded") {
    const tip = Math.max(0, Number(tip_cents ?? 0));
    const { error } = await admin.from("payments").insert({
      company_id, invoice_id, client_id: invoice.client_id,
      amount: (Number(object.amount_total) - tip) / 100, tip_amount: tip / 100,
      method: type === "checkout.session.async_payment_succeeded" ? "ach" : "card",
      processor: "stripe", processor_ref: object.payment_intent ?? object.id, recorded_by: null,
    });
    if (error && error.code !== "23505") fail(error);
    return company_id;
  }
  if (type === "checkout.session.async_payment_failed") {
    await noteOnClient(admin, {
      company_id, client_id: invoice.client_id, invoice_id, key: `${object.id}:failed`,
      subject: "Bank payment failed", body: `The bank payment for invoice #${invoice.number} didn't go through. The invoice is still owed.`,
    });
  }
  // A bank payment that has only started changes nothing yet.
  return null;
}

/** Refunds made in Stripe show up as negative payments. Each refunded total is recorded once. */
async function refunded(admin: Db, route: WebhookRoute, charge: StripeCharge) {
  if (!charge.payment_intent) return null;
  const { data: paid } = await admin.from("payments").select("company_id, client_id, invoice_id, method, amount, tip_amount").eq("processor_ref", charge.payment_intent).maybeSingle();
  if (!paid || (route.companyId && paid.company_id !== route.companyId)) return null;
  const { amount: paidAmount, tip_amount: paidTip, ...original } = paid;
  const prefix = `${charge.payment_intent}:refund:`;
  const { data: rows } = await admin.from("payments").select("amount, tip_amount, processor_ref").like("processor_ref", `${charge.payment_intent}:%`);
  const owed = (rows ?? []).find((p) => p.processor_ref === `${charge.payment_intent}:before`);
  // Everything taken back of the charge already: refunds, and disputes lost (see disputed).
  const earlier = (rows ?? []).filter((p) => p !== owed);
  const refunds = takenBack(earlier.filter((p) => p.processor_ref?.startsWith(prefix)));
  // Stripe's total includes the tip, which the payment keeps apart from what the invoice was
  // paid: a refund comes off the invoice first, then the tip (then what was owed from before), out
  // of what refunds and lost disputes left of each.
  const newly = Number(charge.amount_refunded ?? 0) - refunds.amount - refunds.tip - refunds.before;
  const { amount, tip, before } = splitBack(newly, { amount: paidAmount, tip_amount: paidTip }, cents(owed?.amount), takenBack(earlier));
  // A refund of only the tip (once the invoice part was all refunded, or of a payment that was only
  // a tip) gives back the tip and no amount.
  if (amount > 0 || tip > 0) {
    const { error } = await admin.from("payments").insert({
      ...original, amount: -amount / 100, tip_amount: -tip / 100, processor: "stripe", processor_ref: `${prefix}${charge.amount_refunded}`, notes: "Refunded in Stripe", recorded_by: null,
    });
    if (error && error.code !== "23505") fail(error);
  }
  if (before > 0) await takeBackBefore(admin, original, before, `${prefix}${charge.amount_refunded}:before`, "Refunded in Stripe");
  return paid.company_id;
}

/** Money already taken back of a charge (refunds, lost disputes): of its payment and tip, and of what was owed from before. */
function takenBack(rows: Array<{ amount: number; tip_amount: number; processor_ref: string | null }>) {
  const total = (list: typeof rows, key: "amount" | "tip_amount") => -list.reduce((sum, p) => sum + cents(p[key]), 0);
  const ofBefore = rows.filter((p) => p.processor_ref?.endsWith(":before"));
  const ofPayment = rows.filter((p) => !ofBefore.includes(p));
  return { amount: total(ofPayment, "amount"), tip: total(ofPayment, "tip_amount"), before: total(ofBefore, "amount") };
}

/**
 * Cents taken back of a charge, split: off the invoice first, then the tip, then what the client
 * owed from before (`owed`, the charge's `<charge>:before` payment; see recordPayment), out of what
 * was taken back of each already.
 */
function splitBack(taken: number, paid: { amount: number; tip_amount: number }, owed: number, back: ReturnType<typeof takenBack>) {
  const amount = Math.min(taken, cents(paid.amount) - back.amount);
  const tip = Math.max(0, Math.min(taken - amount, cents(paid.tip_amount) - back.tip));
  return { amount, tip, before: Math.max(0, Math.min(taken - amount - tip, owed - back.before)) };
}

/** What was owed from before goes back with its charge: from the client, on no invoice, like the payment of it. */
async function takeBackBefore(admin: Db, paid: { company_id: string; client_id: string; method: string }, amount: number, ref: string, notes: string) {
  const { error } = await admin.from("payments").insert({
    company_id: paid.company_id, client_id: paid.client_id, invoice_id: null, method: paid.method,
    amount: -amount / 100, processor: "stripe", processor_ref: ref, notes, recorded_by: null,
  });
  if (error && error.code !== "23505") fail(error);
}

interface Dispute {
  id: string;
  amount: number;
  charge: string;
  payment_intent: string | null;
  status: string;
  reason: string;
  evidence_details?: { due_by: number | null } | null;
}

/** A client disputed a card payment with their bank: tell the office, and take it back if it's lost. */
async function disputed(admin: Db, route: WebhookRoute, type: string, dispute: Dispute) {
  const ref = dispute.payment_intent ?? dispute.charge;
  const { data: original } = await admin.from("payments").select("company_id, client_id, invoice_id, method, amount, tip_amount, invoice:invoices(number)").eq("processor_ref", ref).maybeSingle();
  if (!original || (route.companyId && original.company_id !== route.companyId)) return null;
  const number = (original.invoice as unknown as { number: number } | null)?.number;
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(dispute.amount / 100);
  const on = number ? ` on invoice #${number}` : "";
  const note = (suffix: string, subject: string, body: string) =>
    noteOnClient(admin, { company_id: original.company_id, client_id: original.client_id, invoice_id: original.invoice_id, key: `${dispute.id}:${suffix}`, subject, body });

  if (type === "charge.dispute.created") {
    const due = dispute.evidence_details?.due_by ? ` by ${new Date(dispute.evidence_details.due_by * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : "";
    await note("opened", "Payment disputed", `The client disputed the ${amount} payment${on} with their bank (${dispute.reason.replace(/_/g, " ")}). Stripe holds the money until it's settled. Respond in Stripe${due} to keep it.`);
  } else if (dispute.status === "lost") {
    // Stripe's amount includes the tip, which the payment keeps apart: like a refund, what the bank
    // took back comes off the invoice first, then the tip (then what was owed from before), out of
    // what refunds left of the payment.
    const { data: rows } = await admin.from("payments").select("amount, tip_amount, processor_ref").like("processor_ref", `${ref}:%`);
    const owed = (rows ?? []).find((p) => p.processor_ref === `${ref}:before`);
    const back = takenBack((rows ?? []).filter((p) => p !== owed));
    // Less what this dispute recorded already (Stripe repeats events).
    const key = `${ref}:dispute:${dispute.id}`;
    const already = takenBack((rows ?? []).filter((p) => p.processor_ref === key || p.processor_ref === `${key}:before`));
    const { amount: fromInvoice, tip: fromTip, before } = splitBack(dispute.amount - already.amount - already.tip - already.before, original, cents(owed?.amount), back);
    // Or only the tip, of a payment that was only a tip (as with refunds).
    if (fromInvoice > 0 || fromTip > 0) {
      const { error } = await admin.from("payments").insert({
        company_id: original.company_id, client_id: original.client_id, invoice_id: original.invoice_id, method: original.method,
        amount: -fromInvoice / 100, tip_amount: -fromTip / 100, processor: "stripe", processor_ref: key, notes: "Dispute lost in Stripe", recorded_by: null,
      });
      if (error && error.code !== "23505") fail(error);
    }
    if (before > 0) await takeBackBefore(admin, original, before, `${key}:before`, "Dispute lost in Stripe");
    const outcome = cents(original.amount) ? "The invoice is owed again." : "It was a tip, so the invoice is still paid.";
    await note("lost", "Dispute lost", `The bank sided with the client on the ${amount} payment${on}, so that money went back to them. ${outcome}`);
  } else if (dispute.status === "won") {
    // Nothing was taken off when it was opened, so there's nothing to put back.
    await note("won", "Dispute won", `The bank sided with you on the ${amount} payment${on}. The money stays with you.`);
  }
  return original.company_id;
}

// ---------------------------------------------------------------------------------------------
// Deposits (payouts)
// ---------------------------------------------------------------------------------------------

/** Record a deposit (and match it to payments once it's paid). True when it's new here. */
async function savePayout(ctx: Ctx, payout: StripePayout): Promise<boolean> {
  const { data: existing } = await ctx.admin.from("payouts").select("id, company_id, itemized_at").eq("processor_ref", payout.id).maybeSingle();
  if (existing && existing.company_id !== ctx.companyId) return false;
  const values = {
    company_id: ctx.companyId, processor: "stripe", processor_ref: payout.id, amount: payout.amount / 100, currency: payout.currency,
    // Stripe gives the arrival day as midnight UTC.
    status: payout.status, arrival_on: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10), failure_message: payout.failure_message,
  };
  const { data: row, error } = existing
    ? await ctx.admin.from("payouts").update(values).eq("id", existing.id).select("id, itemized_at").single()
    : await ctx.admin.from("payouts").insert(values).select("id, itemized_at").single();
  fail(error);
  // Only automatic payouts can be broken down into the payments in them.
  if (row && payout.status === "paid" && payout.automatic && !row.itemized_at) await itemizePayout(ctx, row.id, payout.id);
  return !existing;
}

/** Match a deposit's transactions to payments: each gets its fee and the deposit it arrived in. */
async function itemizePayout(ctx: Ctx, payoutRowId: string, payoutId: string) {
  let gross = 0;
  let fees = 0;
  const charges = new Map<string, number>();
  const refunds = new Set<string>();
  for await (const bt of stripeList<StripeBalanceTransaction>(ctx.key, "/v1/balance_transactions", { payout: payoutId, expand: ["data.source"] })) {
    if (bt.type === "payout") continue;
    fees += bt.fee;
    const source = bt.source && typeof bt.source === "object" ? bt.source : null;
    if (bt.type === "charge" || bt.type === "payment") {
      gross += bt.amount;
      const ref = source?.payment_intent ?? source?.id;
      if (ref) charges.set(ref, (charges.get(ref) ?? 0) + bt.fee);
    } else if ((bt.type === "refund" || bt.type === "payment_refund") && source?.payment_intent) {
      refunds.add(source.payment_intent);
    }
  }
  for (const [ref, fee] of charges) {
    await ctx.admin.from("payments").update({ fee_amount: fee / 100, payout_id: payoutRowId }).eq("company_id", ctx.companyId).eq("processor_ref", ref);
    // What the client owed from before came in the same charge (see recordPayment).
    await ctx.admin.from("payments").update({ payout_id: payoutRowId }).eq("company_id", ctx.companyId).eq("processor_ref", `${ref}:before`);
  }
  for (const intent of refunds) {
    await ctx.admin.from("payments").update({ payout_id: payoutRowId }).eq("company_id", ctx.companyId).like("processor_ref", `${intent}:refund:%`);
  }
  fail((await ctx.admin.from("payouts").update({ gross_amount: gross / 100, fee_amount: fees / 100, itemized_at: new Date().toISOString() }).eq("id", payoutRowId)).error);
}

// ---------------------------------------------------------------------------------------------
// Importing history
// ---------------------------------------------------------------------------------------------

export interface ImportState {
  status: "running" | "done" | "failed";
  since: string | null;
  started_at: string;
  finished_at?: string;
  error?: string;
  counts: { invoices: number; payments: number; clients: number; payouts: number };
}

async function saveImportState(admin: Db, companyId: string, state: ImportState) {
  const { data } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: "stripe" }).maybeSingle();
  await admin.from("integrations").update({ settings: asJson({ ...((data?.settings ?? {}) as Record<string, unknown>), import: state }) }).match({ company_id: companyId, provider: "stripe" });
}

/** An import that hasn't reported in this long died with its server. */
export const IMPORT_STALE_MS = 30 * 60_000;

export const SHARED_STRIPE_IMPORT = "The Stripe account set up for this server is shared with other companies, so its history can't come into just one. Connect your own Stripe key to bring in yours.";

/**
 * Whether Stripe history can come into this company: always with its own key. The server's key
 * reaches an account shared by every company on the server, so only when its webhook would also
 * say this company (the instance's only one).
 */
export async function canImportStripe(env: Env, admin: Db, companyId: string, access: StripeAccess): Promise<boolean> {
  return access.own || (await companyFor(env, admin, {})) === companyId;
}

/** Mark an import as started before it runs in the background, so a second click is refused. */
export async function beginStripeImport(admin: Db, companyId: string, since: string | null): Promise<ImportState> {
  const state: ImportState = { status: "running", since, started_at: new Date().toISOString(), counts: { invoices: 0, payments: 0, clients: 0, payouts: 0 } };
  await saveImportState(admin, companyId, state);
  return state;
}

/**
 * Bring in invoices made in Stripe since a date (all of them without one), their customers and
 * payments, and the deposits since then. Safe to run again: anything already here is updated.
 * Progress is saved in the integration's settings for the Apps page.
 */
export async function importFromStripe(env: Env, admin: Db, companyId: string, state: ImportState) {
  const since = state.since;
  try {
    const ctx = await context(env, admin, companyId);
    if (!ctx) throw new IntegrationError("Stripe isn't connected");
    if (!(await canImportStripe(env, admin, companyId, ctx))) throw new IntegrationError(SHARED_STRIPE_IMPORT);
    const created = since ? { gte: Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) } : undefined;
    const invoices: StripeInvoice[] = [];
    for await (const invoice of stripeList<StripeInvoice>(ctx.key, "/v1/invoices", { created, expand: ["data.charge.balance_transaction"] })) {
      if (invoice.status !== "draft") invoices.push(invoice);
    }
    // Oldest first, so Crewtavo's invoice numbers follow the order they were sent.
    for (const invoice of invoices.reverse()) {
      if (invoice.metadata?.crewtavo_invoice_id) {
        // One of ours; catch up on a payment whose webhook never arrived.
        if (invoice.status === "paid") await settleOwnInvoice(ctx, invoice);
        continue;
      }
      if (!invoice.total && !invoice.amount_due) continue;
      // Count what's new: an invoice already brought in (by a webhook or an earlier import) is just updated.
      const { data: known } = await admin.from("stripe_invoices").select("status").eq("company_id", companyId).eq("stripe_id", invoice.id).maybeSingle();
      await importInvoice(ctx, invoice, true);
      if (!known) state.counts.invoices++;
      if (invoice.status === "paid" && known?.status !== "paid") state.counts.payments++;
      if (state.counts.invoices % 25 === 0) await saveImportState(admin, companyId, state);
    }
    for await (const payout of stripeList<StripePayout>(ctx.key, "/v1/payouts", { created })) {
      if (await savePayout(ctx, payout)) state.counts.payouts++;
    }
    const { count } = await admin.from("clients").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("lead_source", "Stripe").gte("created_at", state.started_at);
    state.counts.clients = count ?? 0;
    await saveImportState(admin, companyId, { ...state, status: "done", finished_at: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveImportState(admin, companyId, { ...state, status: "failed", finished_at: new Date().toISOString(), error: message.slice(0, 300) });
    throw error;
  }
}
