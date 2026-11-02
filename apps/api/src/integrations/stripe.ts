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
 *     the old account's invoices with the old key (leaveAccount);
 *   - autopay (docs/autopay-plan.md): clients save a card on Stripe's page, finished work is charged
 *     to it as a charge_automatically Stripe invoice, tips go on it after paying, and the office
 *     refunds from Crewtavo. Only with the company's own key.
 * Uses the admin client; every query filters by company.
 */
import { memberPermissions, OFFICE, type Role } from "@crewtavo/core";
import { methodExpiry, methodLabel, tipsAllowed } from "@crewtavo/core/autopay";
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
  stripeForm,
  stripeLineItems,
  stripeList,
  type BillableInvoice,
  type StripeBalanceTransaction,
  type StripeCharge,
  type StripeCheckoutSession,
  type StripeEvent,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripePaymentIntent,
  type StripePaymentMethod,
  type StripePayout,
  type StripeRefund,
  type StripeSetupIntent,
} from "../services/stripe";
import { IntegrationError, loadSecret, saveSecret, type StoredSecret } from "./tokens";

/** What the webhook listens for. Bump STRIPE_EVENTS_VERSION whenever this list changes. */
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
  // Autopay: cards and bank accounts saved, checked, changed or taken off in Stripe, and charges
  // that need the client to confirm them.
  "setup_intent.succeeded",
  "setup_intent.setup_failed",
  "payment_method.detached",
  "payment_method.automatically_updated",
  "invoice.payment_action_required",
  "mandate.updated",
];
/** Saved in integrations.settings.events_version: a webhook made from an older list is brought up to date. */
export const STRIPE_EVENTS_VERSION = 2;

const LIVE = ["creating", "open", "processing"];
const OWED = ["sent", "partially_paid", "overdue"];
/** An autopay charge that may still pay its invoice: anything but paid or called off. */
const AUTOPAY_LIVE = ["waiting", "needs_approval", "charging", "processing", "failed", "needs_client"];
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
 * finish after the response). `change` says which account it was and is now (acct_ ids, when Stripe
 * says) and whether that's another one: null when it can't be told.
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
  // What this key can do for autopay and refunds (an older key's answers don't carry over).
  const can = await probeKey(key);
  try {
    const { data: existing } = await admin.from("integrations").select("settings, external_account_id").match({ company_id: input.companyId, provider: "stripe" }).maybeSingle();
    // The last import's summary belongs to the account it came from.
    const keep = existing?.external_account_id && existing.external_account_id === account?.id ? ((existing.settings ?? {}) as Record<string, unknown>) : {};
    const { autopay: _autopay, refunds: _refunds, key_alerted_at: _alerted, ...kept } = keep;
    const { error } = await admin.from("integrations").upsert({
      company_id: input.companyId,
      provider: "stripe",
      status: "connected",
      account_label: label,
      external_account_id: account?.id ?? null,
      settings: asJson({
        ...kept, livemode: key.includes("_live_"), key_kind: keyKind(key), webhook: Boolean(webhook), ...can, checked_at: new Date().toISOString(),
        // A new webhook listens for today's events.
        events_version: webhook ? STRIPE_EVENTS_VERSION : null,
      }),
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

  const moved = before ? await movesAccount(before, key, account?.id ?? null) : null;
  const { settled } = before && moved ? await leaveAccount(before) : { settled: Promise.resolve() };
  // With the old key, or the new one when the old one was rolled in the same account.
  if (previous && previous.extra?.webhook_id !== webhook?.id) await removeStripeWebhook(previous, key);
  return { account_label: label, webhook: Boolean(webhook), settled, change: { from: before?.account ?? null, to: account?.id ?? null, moved } };
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

/**
 * Whether `key` (on `account`, when known) reaches another Stripe account, or the other mode, than
 * the one in use. Null when it can't be told, which counts as the same account for its invoices.
 */
async function movesAccount(before: Ctx, key: string, account: string | null): Promise<boolean | null> {
  if (before.key === key) return false;
  if (before.livemode !== key.includes("_live_")) return true;
  if (before.account && account) return before.account !== account;
  // The accounts can't be compared (a restricted key, or the server's): see whether the new key
  // finds an invoice made with the old one.
  const { data } = await before.admin
    .from("stripe_invoices")
    .select(LINKED)
    .eq("company_id", before.companyId)
    .eq("purpose", "invoice")
    .in("status", LIVE)
    .is("detached_at", null)
    .not("stripe_id", "is", null);
  const sample = (data ?? []).find((row) => inUse(before, row));
  if (sample) {
    return stripeApi(key, "GET", `/v1/invoices/${sample.stripe_id}`).then(
      () => false,
      (error) => (missing(error) ? true : null),
    );
  }
  // No invoice to try: a card saved for autopay with the old key, if there's one.
  const { data: methods } = await before.admin
    .from("client_payment_methods")
    .select("stripe_payment_method_id, livemode, stripe_account")
    .eq("company_id", before.companyId)
    .neq("status", "removed")
    .eq("livemode", before.livemode)
    .limit(5);
  const card = (methods ?? []).find((m) => !m.stripe_account || !before.account || m.stripe_account === before.account);
  if (!card) return null;
  return stripeApi(key, "GET", `/v1/payment_methods/${card.stripe_payment_method_id}`).then(
    () => false,
    (error) => (missing(error) ? true : null),
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
  const { data, error } = await old.admin
    .from("stripe_invoices")
    .select(`${LINKED}, invoice_id`)
    .eq("company_id", old.companyId)
    .eq("purpose", "invoice")
    .in("status", LIVE)
    .is("detached_at", null);
  fail(error);
  const rows = (data ?? []).filter((row) => inUse(old, row));
  await detach(old.admin, rows.map((row) => row.id));
  // Cards saved in that account can't be charged with the new key: they go, their agreements end,
  // and the office hears which clients need to set autopay up again.
  const left = await old.admin.rpc("autopay_account_left", { p_company: old.companyId, p_livemode: old.livemode, ...(old.account ? { p_account: old.account } : {}) });
  if (left.error) console.error("Couldn't let go of the saved cards in the Stripe account being left", left.error.message);
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
  "id, number, status, subject, notes, client_id, due_on, subtotal, discount_amount, tax_rate, tax_amount, retainage_pct, retainage_amount, amount_paid, balance_due, promo:promo_codes(code), lines:invoice_line_items(name, quantity, unit, unit_price, sort)";

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
  /** send_invoice (the client pays on Stripe's page) or charge_automatically (autopay, and tips on a saved card). */
  collection: string;
  /** invoice, or tip: a tip added after paying, its own Stripe invoice, never voided as stale. */
  purpose: string;
}
const LINKED = "id, stripe_id, origin, status, amount_due, tip_amount, hosted_url, created_at, livemode, stripe_account, detached_at, collection, purpose";

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

/**
 * An invoice's Stripe invoices, newest first, and the live one (if any). Only the ones for the
 * invoice itself: a tip added after paying is its own, and isn't kept in step with the balance.
 */
async function linkedTo(ctx: Ctx, invoiceId: string): Promise<{ linked: Linked[]; live: Linked | undefined }> {
  const { data, error } = await ctx.admin
    .from("stripe_invoices")
    .select(LINKED)
    .eq("company_id", ctx.companyId)
    .eq("invoice_id", invoiceId)
    .eq("purpose", "invoice")
    .order("created_at", { ascending: false });
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
 *
 * charge_automatically (autopay): on the saved method's own customer, with the method as its
 * default and no due date. One that Stripe would charge more than the invoice (the client owes
 * from before in Stripe) is voided at once and comes back marked `owedBefore`: charging that
 * without asking isn't what the client agreed to.
 */
async function createStripeInvoice(
  ctx: Ctx,
  invoice: Billable,
  tipCents: number,
  options: { collection?: "send_invoice" | "charge_automatically"; paymentMethod?: string; customer?: string; autopayCharge?: string; purpose?: "invoice" | "tip" } = {},
): Promise<(Linked & { owedBefore?: boolean; stripe?: StripeInvoice }) | null> {
  const automatic = options.collection === "charge_automatically";
  const amount = cents(invoice.balance_due) + tipCents;
  const { data: row, error } = await ctx.admin
    .from("stripe_invoices")
    .insert({
      company_id: ctx.companyId, invoice_id: invoice.id, origin: "crewtavo", status: "creating", amount_due: amount / 100, tip_amount: tipCents / 100,
      livemode: ctx.livemode, stripe_account: ctx.account, collection: options.collection ?? "send_invoice", purpose: options.purpose ?? "invoice",
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
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      ...(automatic
        ? { collection_method: "charge_automatically", default_payment_method: options.paymentMethod }
        : {
            collection_method: "send_invoice",
            // Stripe wants a due date in the future; one that has passed shows as due now.
            due_date: Math.max(invoice.due_on ? Math.floor(Date.parse(`${invoice.due_on}T23:00:00Z`) / 1000) : 0, Math.floor(Date.now() / 1000) + 3600),
          }),
      description: invoice.notes?.slice(0, 1500) || undefined,
      custom_fields: [{ name: "Invoice", value: `#${invoice.number}` }],
      metadata: {
        crewtavo_company_id: ctx.companyId, crewtavo_invoice_id: invoice.id, crewtavo_row: row.id, tip_cents: String(tipCents),
        ...(options.autopayCharge ? { crewtavo_autopay: options.autopayCharge } : {}),
      },
    });
    // Autopay charges the method on the customer it was saved with, never another one.
    let customer = automatic && options.customer ? options.customer : await customerFor(ctx, invoice.client_id);
    let draft: StripeInvoice;
    try {
      draft = await stripeApi<StripeInvoice>(ctx.key, "POST", "/v1/invoices", params(customer), { idempotencyKey: `crewtavo-invoice-${row.id}` });
    } catch (error) {
      if (automatic || !(error instanceof StripeError && error.code === "resource_missing" && error.param === "customer")) throw error;
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
    // Leave nothing half made. Drafts can be deleted outright, and one finalized before the
    // failure is voided, so a charge_automatically one can't be charged later.
    if (stripeId) {
      await stripeApi(ctx.key, "DELETE", `/v1/invoices/${stripeId}`).catch(() => stripeApi(ctx.key, "POST", `/v1/invoices/${stripeId}/void_invoice`).catch(() => undefined));
    }
    await ctx.admin.from("stripe_invoices").delete().eq("id", row.id);
    throw error;
  }
  const made: Linked = { ...row, ...done, stripe_id: final.id };
  if (automatic && final.status === "open" && final.amount_due > final.total) {
    // They owe from before in Stripe, which it adds on: Stripe would charge more than this invoice.
    return (await voidStripeInvoice(ctx, made)) ? { ...made, status: "void", owedBefore: true } : { ...made, status: "paid" };
  }
  // Autopay's is booked once the invoice is sent (chargeInvoiceAutomatically), never on a draft.
  if (final.status === "paid" && !automatic) await recordPayment(ctx, final);
  return { ...made, stripe: final };
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
 *
 * Also replaced, without the tip and as one the client pays on Stripe's page: one the client made
 * with a tip once tips are turned off (the hub_tips_changed trigger queues this), and an autopay
 * one that nothing is left to charge (its charge was called off, or it was paid another way).
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
  let stale = !owed || (!imported && cents(live?.amount_due) - cents(live?.tip_amount) !== cents(invoice.balance_due));
  // A tip the client chose while tips were on stops being payable once they're off.
  if (!stale && live?.origin === "crewtavo" && cents(live.tip_amount) > 0) stale = !(await tipsOn(ctx, imported));
  if (live?.collection === "charge_automatically") {
    const { data: charges, error } = await admin.from("autopay_charges").select("status, claim_token").eq("company_id", companyId).eq("invoice_id", invoiceId).in("status", AUTOPAY_LIVE);
    fail(error);
    // The task is charging it right now (it marks the invoice sent just before it pays): it settles it.
    if (stale && (charges ?? []).some((charge) => charge.status === "charging" && charge.claim_token)) return "busy";
    stale ||= !(charges ?? []).length;
  }
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

/** Whether clients may add a tip now (settings.hub_tips, read fresh), for an invoice made here or in Stripe. */
async function tipsOn(ctx: Ctx, imported: boolean): Promise<boolean> {
  const { data, error } = await ctx.admin.from("companies").select("settings").eq("id", ctx.companyId).maybeSingle();
  fail(error);
  return tipsAllowed((data?.settings as { hub_tips?: unknown } | null)?.hub_tips, imported);
}

/** The Stripe page where the client pays this invoice (plus an optional tip), made if needed. */
export async function stripeCheckout(env: Env, admin: Db, companyId: string, invoiceId: string, tipCents: number): Promise<string> {
  const ctx = await context(env, admin, companyId);
  if (!ctx) throw new HttpError(501, "Online payments aren't set up.");
  for (let attempt = 0; attempt < 6; attempt++) {
    const invoice = await billable(ctx, invoiceId);
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    if (invoice.status === "void") throw new HttpError(409, "This invoice was cancelled, so it can't be paid.");
    // The office chose not to collect it, so the Hub shows it as not owed.
    if (invoice.status === "written_off") throw new HttpError(409, "This invoice isn't owed anymore.");
    if (invoice.status === "draft") throw new HttpError(409, "This invoice isn't ready yet.");
    if (cents(invoice.balance_due) <= 0) throw new HttpError(409, "This invoice is already paid.");
    const { linked, live } = await linkedTo(ctx, invoiceId);
    if (linked.some((row) => waiting(row, ctx.livemode))) throw new HttpError(409, PROCESSING_MESSAGE);
    // Asked again here (the Hub's Pay asks first): no tip is charged while tips are off.
    if (tipCents > 0 && !(await tipsOn(ctx, linked.some((row) => row.origin === "stripe")))) {
      throw new HttpError(409, "Tips aren't offered here anymore. Check the amount and pay again.");
    }
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
      // Tips were turned off since the client chose one: paying without it is never held up (the
      // limit's message would send them back to the page with the tip).
      const untip = tipCents === 0 && cents(live.tip_amount) > 0 && !(await tipsOn(ctx, false));
      if (lastHour >= STRIPE_INVOICES_PER_HOUR && !untip) {
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
    if (made?.hosted_url) {
      // Asked once more now it's made: tips turned off while it was being made couldn't find it
      // (hub_tips_changed only sees Stripe invoices with a tip that are there already), so it's
      // voided here instead of staying payable with the tip.
      if (tipCents > 0 && made.status === "open" && !(await tipsOn(ctx, false))) {
        if (!(await voidStripeInvoice(ctx, made))) throw new HttpError(409, "This invoice is already paid.");
        throw new HttpError(409, "Tips aren't offered here anymore. Check the amount and pay again.");
      }
      return made.hosted_url;
    }
    await sleep(1500);
  }
  throw new HttpError(503, "Online payments are busy. Try again in a minute.");
}

/** For the Client Hub: can this invoice be paid online, and is a bank payment already on its way? */
export async function hubPayment(env: Env, admin: Db, companyId: string, invoiceId: string) {
  const [access, { data: rows }] = await Promise.all([
    stripeAccess(env, admin, companyId),
    admin.from("stripe_invoices").select("origin, status, livemode, detached_at, purpose").eq("company_id", companyId).eq("invoice_id", invoiceId),
  ]);
  const livemode = Boolean(access?.key.includes("_live_"));
  // A tip added after paying is its own Stripe invoice, and says nothing about paying this one.
  const linked = (rows ?? []).filter((row) => (row.purpose ?? "invoice") === "invoice");
  return {
    enabled: Boolean(access),
    processing: linked.some((row) => waiting(row, livemode)),
    imported: linked.some((row) => row.origin === "stripe"),
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
  const columns = "id, status, stripe_id, invoice_id, collection, purpose";
  let { data: row } = await ctx.admin.from("stripe_invoices").select(columns).eq("stripe_id", invoice.id).maybeSingle();
  if (!row && meta.crewtavo_row) {
    row = (await ctx.admin.from("stripe_invoices").select(columns).eq("company_id", ctx.companyId).eq("id", meta.crewtavo_row).maybeSingle()).data;
    if (row && !row.stripe_id) await ctx.admin.from("stripe_invoices").update({ stripe_id: invoice.id }).eq("id", row.id);
  }

  if (invoice.status === "paid") {
    // Marked paid before the payment is booked: booking it can turn the invoice paid, and the
    // invoice trigger then tells an autopay charge paid by its own Stripe invoice
    // (autopay_paid_by_charge) from one paid another way. A booking that fails is made when Stripe
    // sends the event again (processor_ref is unique, so never twice).
    if (row && row.status !== "paid") {
      fail((await ctx.admin.from("stripe_invoices").update({ status: "paid" }).eq("id", row.id)).error);
      row = { ...row, status: "paid" };
    }
    if (row?.invoice_id && row.collection === "charge_automatically" && row.purpose === "invoice") await paidAnotherWay(ctx, row.invoice_id, invoice);
    await recordPayment(ctx, invoice);
    if (row?.invoice_id && row.collection === "charge_automatically" && row.purpose === "invoice") await autopaySettled(ctx, row.invoice_id, invoice);
  }
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

/** The card or bank account paying one of our Stripe invoices (its PaymentIntent's), or null for none (marked paid in Stripe). */
async function paidWith(ctx: Ctx, invoice: StripeInvoice): Promise<string | null> {
  if (invoice.paid_out_of_band || !invoice.payment_intent) return null;
  const intent = await stripeApi<StripePaymentIntent & { payment_method: string | null }>(ctx.key, "GET", `/v1/payment_intents/${invoice.payment_intent}`);
  return intent.payment_method;
}

/**
 * Whether a paid Stripe invoice of ours was paid by this saved method: by its PaymentIntent, or, with
 * none, wholly from the client's Stripe credit (nothing was charged, so nothing else paid it).
 */
async function paidBy(ctx: Ctx, invoice: StripeInvoice, pm: string): Promise<boolean> {
  if (invoice.payment_intent) return (await paidWith(ctx, invoice)) === pm;
  return !invoice.paid_out_of_band && invoice.amount_paid === 0;
}

const PAID_ANOTHER_WAY = "Paid another way";

/**
 * A declined autopay charge (or one waiting on the client) whose Stripe invoice the client paid on
 * Stripe's page with another card or bank account: paid another way, called off before the payment
 * is booked so the invoice turning paid doesn't count it as autopay's (nothing then names the card
 * that failed). With the same method (confirming with their bank there) it's autopay's. One waiting
 * between tries (charging, its claim let go) counts too; one a claim holds is the task's to settle.
 */
async function paidAnotherWay(ctx: Ctx, invoiceId: string, invoice: StripeInvoice) {
  const { data: rows, error } = await ctx.admin.from("autopay_charges").select("id, status, claim_token, payment_method_id").eq("company_id", ctx.companyId).eq("invoice_id", invoiceId).in("status", ["failed", "needs_client", "charging"]);
  fail(error);
  const charge = (rows ?? []).find((r) => r.status !== "charging" || r.claim_token === null);
  if (!charge) return;
  const { data: method } = charge.payment_method_id
    ? await ctx.admin.from("client_payment_methods").select("stripe_payment_method_id").eq("company_id", ctx.companyId).eq("id", charge.payment_method_id).maybeSingle()
    : { data: null };
  if (method && (await paidBy(ctx, invoice, method.stripe_payment_method_id))) return;
  const update = ctx.admin.from("autopay_charges").update({ status: "called_off", last_error: PAID_ANOTHER_WAY, claim_token: null, locked_until: null, busy_since: null }).eq("id", charge.id);
  // Only as it was: a claim taken meanwhile is the task's to settle.
  fail((await (charge.status === "charging" ? update.eq("status", "charging").is("claim_token", null) : update.in("status", ["failed", "needs_client"]))).error);
}

/**
 * An autopay bank payment Stripe settled, now booked: its charge is paid, with what Stripe took,
 * whatever the invoice here says. Usually the invoice trigger did that as the invoice turned paid.
 * This is for one that didn't turn paid then: voided while the payment was on its way (the money is
 * the client's then), moved back to draft, or paid another way meanwhile (a check). By the Stripe
 * row's invoice, never the event's metadata.
 */
async function autopaySettled(ctx: Ctx, invoiceId: string, invoice: StripeInvoice) {
  const { data: charge, error } = await ctx.admin.from("autopay_charges").select("id").eq("company_id", ctx.companyId).eq("invoice_id", invoiceId).eq("status", "processing").maybeSingle();
  fail(error);
  if (!charge) return;
  fail(
    (
      await ctx.admin.rpc("finish_autopay_charge", {
        p_id: charge.id, p_outcome: "paid", p_company: ctx.companyId, ...(invoice.paid_out_of_band ? {} : { p_amount: invoice.amount_paid / 100 }),
      })
    ).error,
  );
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

/** What's owed once a bank payment bounced, for the office's note: it may have been paid another way meanwhile. */
const afterBounce = (invoice: { status: string; balance_due: number }) =>
  OWED.includes(invoice.status) && Number(invoice.balance_due) > 0 ? "The invoice is still owed."
  : invoice.status === "paid" ? "It was paid another way meanwhile."
  : "Nothing is owed on it now.";

/**
 * A bank payment bounced (card declines don't count): it's owed again, and the office hears about
 * it (that it's still owed only when it is: it may have been paid another way meanwhile). An
 * autopay charge's bounce also ends autopay for that bank account until the client updates it
 * (never presented again: that breaks the bank rules and costs a fee). Autopay's card declines were
 * already handled by the task, which got Stripe's answer straight away.
 */
async function bankPaymentFailed(env: Env, ctx: Ctx, invoice: StripeInvoice) {
  const { data: row } = await ctx.admin
    .from("stripe_invoices")
    .select("id, status, invoice_id, collection, purpose")
    .eq("company_id", ctx.companyId)
    .eq("stripe_id", invoice.id)
    .maybeSingle();
  if (row?.status !== "processing" && row?.status !== "open") return;
  if (row.status === "processing") {
    await ctx.admin.from("stripe_invoices").update({ status: "open" }).eq("id", row.id);
    const { data: target } = row.invoice_id
      ? await ctx.admin.from("invoices").select("id, number, client_id, status, balance_due").eq("company_id", ctx.companyId).eq("id", row.invoice_id).maybeSingle()
      : { data: null };
    if (target) {
      await noteOnClient(ctx.admin, {
        company_id: ctx.companyId, client_id: target.client_id, invoice_id: target.id, key: `${invoice.id}:failed:${invoice.payment_intent ?? ""}`,
        subject: "Bank payment failed", body: `The bank payment for invoice #${target.number} didn't go through. ${afterBounce(target)}`,
      });
    }
    if (ctx.own && row.collection === "charge_automatically" && row.invoice_id) await autopayBounced(ctx, row.invoice_id, invoice.payment_intent);
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
  // Autopay is the company's own key only: the shared webhook can't vouch for whose setup it is.
  const autopayCompany = route.companyId && access?.own ? route.companyId : null;
  if (event.type === "checkout.session.completed" && object.mode === "setup" && object.metadata?.crewtavo_kind === "autopay") {
    if (!autopayCompany || object.metadata?.crewtavo_company_id !== autopayCompany) return null;
    return (await setupFinished(env, admin, autopayCompany, access!, { session: object.id as string })) ? autopayCompany : null;
  }
  if (event.type.startsWith("checkout.session.")) return checkoutSession(admin, route, event.type, object);
  if (event.type === "payment_intent.processing") return bankPaymentStarted(admin, route, object.invoice as string | null, event.created);
  if (event.type === "charge.refunded") return refunded(admin, route, object as StripeCharge);
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") return disputed(admin, route, event.type, object as Dispute);
  if (!key) return null;

  if (event.type === "setup_intent.succeeded" || event.type === "setup_intent.setup_failed") {
    // Other setups in the business's Stripe account are none of Crewtavo's.
    if (object.metadata?.crewtavo_kind !== "autopay" || !object.metadata?.crewtavo_client_id || !autopayCompany) return null;
    return (await setupFinished(env, admin, autopayCompany, access!, { setupIntent: object.id as string, object })) ? autopayCompany : null;
  }
  if (event.type === "payment_method.detached" || event.type === "payment_method.automatically_updated" || event.type === "mandate.updated") {
    if (!autopayCompany) return null;
    const ctx = await context(env, admin, autopayCompany, access);
    if (!ctx) return null;
    if (event.type === "payment_method.detached") await methodGone(ctx, object.id as string);
    else if (event.type === "payment_method.automatically_updated") await methodUpdated(ctx, object.id as string);
    else if (object.status === "inactive") await mandateInactive(ctx, typeof object.payment_method === "string" ? object.payment_method : object.payment_method?.id);
    return null;
  }

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
  /** Why saved cards couldn't be brought in (the rest of the import went on). */
  cards_error?: string;
  /** cards: clients' cards saved in Stripe brought in; cards_unmatched: customers with a card no one client matched. */
  counts: { invoices: number; payments: number; clients: number; payouts: number; cards: number; cards_unmatched: number };
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
  const state: ImportState = { status: "running", since, started_at: new Date().toISOString(), counts: { invoices: 0, payments: 0, clients: 0, payouts: 0, cards: 0, cards_unmatched: 0 } };
  await saveImportState(admin, companyId, state);
  return state;
}

/**
 * Bring in invoices made in Stripe since a date (all of them without one), their customers and
 * payments, the cards customers have saved there (for autopay, with a key that can use them), and
 * the deposits since then. Safe to run again: anything already here is updated. Progress is saved
 * in the integration's settings for the Apps page.
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
    if ((await stripeCapabilities(env, admin, companyId, { cached: true })).autopay) {
      // Its own pass: a problem with saved cards never stops the deposits coming in.
      try {
        await importCards(ctx, state);
      } catch (error) {
        state.cards_error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      }
      await saveImportState(admin, companyId, state);
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

// ---------------------------------------------------------------------------------------------
// Autopay (docs/autopay-plan.md)
// ---------------------------------------------------------------------------------------------

/** A saved method as the charge needs it (autopay_bill's "method"). */
export interface SavedMethod {
  id: string;
  stripe_payment_method_id: string;
  stripe_customer_id: string;
  livemode: boolean;
  stripe_account: string | null;
  type: string;
}

/** What the company's key can do, kept in integrations.settings (autopay, refunds, events_version). */
export interface StripeCapabilities {
  connected: boolean;
  own: boolean;
  livemode: boolean;
  autopay: boolean;
  refunds: boolean;
  webhook_current: boolean;
}

export type SetupOutcome =
  | { status: "agree" | "pending"; method: { id: string; label: string; type: string; exp: string | null } }
  | { status: "refused"; reason: string };

export type AutopayChargeResult =
  | { outcome: "paid" | "processing"; amountCents: number }
  | { outcome: "declined" | "needs_client" | "bank_failed"; code: string | null; message: string }
  | { outcome: "too_small" | "lost" }
  | { outcome: "busy" | "retry"; message: string }
  | { outcome: "unusable"; message: string };


const STILL_MAKING = "Stripe's invoice is still being made";
const CHANGED = "The invoice changed while it was being charged";
const KEY_REFUSED = "Your Stripe key can't charge saved cards anymore. Update it on the Apps page.";
const KEY_CANT = "Your Stripe key can't do that anymore. Update it on the Apps page.";
const NOT_SAVED = "Stripe couldn't save that card. Try another one.";
const GONE = "The saved card isn't in Stripe anymore";

/** Stripe's message as a reason in a sentence of ours (no full stop of its own). */
const reason = (error: { message: string }) => error.message.replace(/\.\s*$/, "");

// ---- What the key can do -------------------------------------------------------------------

/** The Stripe integration's settings Crewtavo keeps. */
interface StripeSettings {
  webhook?: boolean;
  livemode?: boolean;
  key_kind?: ReturnType<typeof keyKind>;
  autopay?: boolean;
  refunds?: boolean;
  events_version?: number | null;
  checked_at?: string;
  key_alerted_at?: string;
  import?: ImportState;
}

/**
 * The integration's settings, or null without a row. Only eq and maybeSingle, so the Hub test's
 * fake database can run it (the Hub asks on every view).
 */
async function stripeSettingsOf(admin: Db, companyId: string): Promise<StripeSettings | null> {
  const { data, error } = await admin.from("integrations").select("settings").eq("company_id", companyId).eq("provider", "stripe").maybeSingle();
  fail(error);
  if (!data) return null;
  const settings = data.settings;
  return settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as StripeSettings) : {};
}

/** Merged into the settings as they are now, so an import's progress saved meanwhile stays. */
async function saveStripeSettings(admin: Db, companyId: string, patch: Partial<StripeSettings>) {
  const current = (await stripeSettingsOf(admin, companyId)) ?? {};
  fail((await admin.from("integrations").update({ settings: asJson({ ...current, ...patch }) }).eq("company_id", companyId).eq("provider", "stripe")).error);
}

/** A full secret key (sk_) can do anything in the account, payouts included; a restricted one (rk_) only what it was given. */
const keyKind = (key: string) => (key.startsWith("sk_") ? "secret" : "restricted");

/** How long a probe that couldn't tell is left before it's tried again. */
const PROBE_EVERY_MS = 15 * 60_000;

/**
 * Whether a probe got past Stripe's permission check. The probes can't change anything (an empty
 * Checkout Session, a payment method and a payment that don't exist), so 400 and 404 mean
 * allowed, 401 and 403 not, and anything else can't tell (null).
 */
async function allowed(call: Promise<unknown>): Promise<boolean | null> {
  try {
    await call;
    return true;
  } catch (error) {
    if (!(error instanceof StripeError)) return null;
    if (error.status === 401 || error.status === 403) return false;
    if (error.status === 400 || error.status === 404) return true;
    return null;
  }
}

/**
 * What a key may do for autopay (save cards on Stripe's page, read the setups, take cards off) and
 * for refunds. A question Stripe didn't answer is left out, to be asked again later.
 */
async function probeKey(key: string): Promise<{ autopay?: boolean; refunds?: boolean }> {
  const [checkout, detach, refund, setups] = await Promise.all([
    allowed(stripeApi(key, "POST", "/v1/checkout/sessions", {})),
    allowed(stripeApi(key, "POST", "/v1/payment_methods/pm_crewtavo_probe/detach")),
    allowed(stripeApi(key, "POST", "/v1/refunds", { payment_intent: "pi_crewtavo_probe" })),
    allowed(stripeApi(key, "GET", "/v1/setup_intents", { limit: 1 })),
  ]);
  const answers = [checkout, detach, setups];
  const autopay = answers.includes(false) ? false : answers.includes(null) ? undefined : true;
  return { ...(autopay === undefined ? {} : { autopay }), ...(refund === null ? {} : { refunds: refund }) };
}

/**
 * What the company's key can do. `cached` never asks Stripe (a flag never saved reads false): the
 * Client Hub, the task and the webhook use it. Otherwise (Settings → Payments, the Apps page), a
 * webhook made from an older event list is brought up to date first, and a key whose answers aren't
 * known yet is probed (at most every 15 minutes), or always with `refresh`.
 */
export async function stripeCapabilities(env: Env, admin: Db, companyId: string, options: { refresh?: boolean; cached?: boolean } = {}): Promise<StripeCapabilities> {
  const access = await stripeAccess(env, admin, companyId);
  if (!access) return { connected: false, own: false, livemode: false, autopay: false, refunds: false, webhook_current: false };
  const livemode = access.key.includes("_live_");
  // The server's shared key: autopay and refunds from Crewtavo need the company's own.
  if (!access.own) return { connected: true, own: false, livemode, autopay: false, refunds: false, webhook_current: true };
  let settings = (await stripeSettingsOf(admin, companyId)) ?? {};
  const webhook = Boolean(access.webhookSecret) && settings.webhook !== false;
  if (!options.cached) {
    if (webhook && settings.events_version !== STRIPE_EVENTS_VERSION && (await refreshStripeWebhook(env, admin, companyId))) {
      settings = { ...settings, events_version: STRIPE_EVENTS_VERSION };
    }
    // A key saved before its kind was noted (the Apps page warns about a full secret key).
    if (settings.key_kind !== keyKind(access.key)) {
      await saveStripeSettings(admin, companyId, { key_kind: keyKind(access.key) });
      settings = { ...settings, key_kind: keyKind(access.key) };
    }
    const unknown = typeof settings.autopay !== "boolean" || typeof settings.refunds !== "boolean";
    const due = !settings.checked_at || Date.now() - Date.parse(settings.checked_at) > PROBE_EVERY_MS;
    if (options.refresh || (unknown && due)) {
      const patch = { ...(await probeKey(access.key)), checked_at: new Date().toISOString() };
      await saveStripeSettings(admin, companyId, patch);
      settings = { ...settings, ...patch };
    }
  }
  return {
    connected: true, own: true, livemode, autopay: settings.autopay === true, refunds: settings.refunds === true,
    webhook_current: webhook && settings.events_version === STRIPE_EVENTS_VERSION,
  };
}

/** Bring Crewtavo's webhook up to date with STRIPE_EVENTS without a new key. False when it can't. */
export async function refreshStripeWebhook(env: Env, admin: Db, companyId: string): Promise<boolean> {
  try {
    const secret = await loadSecret(env, admin, companyId, "stripe");
    const id = secret?.extra?.webhook_id;
    if (!secret?.api_key || !id) return false;
    await stripeApi(secret.api_key, "POST", `/v1/webhook_endpoints/${id}`, { enabled_events: STRIPE_EVENTS });
    await saveStripeSettings(admin, companyId, { events_version: STRIPE_EVENTS_VERSION });
    return true;
  } catch (error) {
    console.error("Couldn't bring the Stripe webhook up to date", companyId, error);
    return false;
  }
}

/** Stripe turned the key down: rolled (401), or narrowed so it can't do this anymore (403). */
const keyTurnedDown = (error: unknown) => error instanceof StripeError && (error.status === 401 || error.status === 403);

/**
 * The key was rolled or narrowed: what it can't do is off until the key is updated (a rolled key
 * can't do anything), and the people who look after money hear about autopay once a day. Never
 * throws: it's said while something else is already failing.
 */
async function keyRefused(ctx: Ctx, what: "autopay" | "refunds", error: StripeError) {
  try {
    const settings = (await stripeSettingsOf(ctx.admin, ctx.companyId)) ?? {};
    const off = error.status === 401 ? { autopay: false, refunds: false } : { [what]: false };
    const tell = "autopay" in off && (!settings.key_alerted_at || Date.now() - Date.parse(settings.key_alerted_at) > 24 * 60 * 60_000);
    await saveStripeSettings(ctx.admin, ctx.companyId, { ...off, ...(tell ? { key_alerted_at: new Date().toISOString() } : {}) });
    if (!tell) return;
    const people = await moneyOffice(ctx.admin, ctx.companyId);
    if (people.length) {
      fail(
        (
          await ctx.admin.from("notifications").insert(
            people.map((user_id) => ({
              company_id: ctx.companyId, user_id, kind: "autopay", title: "Your Stripe key can't charge saved cards anymore",
              body: "Update it on the Apps page. Until then, invoices go out with the Pay link.", link: "/apps/stripe",
            })),
          )
        ).error,
      );
    }
  } catch (problem) {
    console.error("Couldn't note that the Stripe key was turned down", ctx.companyId, problem);
  }
}

/** Owners, admins and office staff with the invoices area: who hears about autopay (private.money_office). */
async function moneyOffice(admin: Db, companyId: string): Promise<string[]> {
  const { data, error } = await admin.from("memberships").select("user_id, role, role_id").eq("company_id", companyId).eq("active", true).in("role", [...OFFICE]);
  fail(error);
  const roleIds = [...new Set((data ?? []).map((m) => m.role_id).filter((id): id is string => Boolean(id)))];
  const { data: roles } = roleIds.length ? await admin.from("company_roles").select("id, permissions").eq("company_id", companyId).in("id", roleIds) : { data: [] };
  const custom = new Map((roles ?? []).map((r) => [r.id, r.permissions as string[]]));
  // A custom role whose row can't be read counts as having no areas.
  return (data ?? []).filter((m) => memberPermissions(m.role as Role, m.role_id ? (custom.get(m.role_id) ?? []) : null).includes("invoices")).map((m) => m.user_id);
}

// ---- Saving a card --------------------------------------------------------------------------

/** A short SHA-256 of text, as hex. */
async function digest(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stripe's page where a client saves a card or bank account for autopay. Returns its URL. `via` is
 * who the Hub link it was opened from counts as (routes/public.ts trustOf), kept with the card it
 * saves (saved_via): an office copy of the client's link, or a link from before the client's own
 * were marked, only confirms a card saved through one like it.
 */
export async function stripeSetupSession(
  env: Env,
  admin: Db,
  companyId: string,
  clientId: string,
  urls: { successUrl: string; cancelUrl: string },
  via: SetupVia,
): Promise<string> {
  const ctx = await context(env, admin, companyId);
  if (!ctx?.own) throw new HttpError(501, "Autopay isn't set up for this business.");
  // Never company_id or invoice_id: the handler for old Checkout payments reads those.
  const metadata = { crewtavo_company_id: companyId, crewtavo_client_id: clientId, crewtavo_kind: "autopay", crewtavo_via: via };
  // What Checkout offers is what the business has turned on in Stripe that can be saved for later.
  const open = async (customer: string) => {
    const params = { mode: "setup", customer, currency: ctx.currency, success_url: urls.successUrl, cancel_url: urls.cancelUrl, metadata, setup_intent_data: { metadata } };
    // The key goes with what's sent, as Stripe refuses a key sent again with anything different:
    // stripeApi's own tries get the same page, and each tap its own (its return links carry a Hub
    // link signed afresh, and a new customer is another request).
    const sent = await digest(stripeForm(params).toString());
    return stripeApi<StripeCheckoutSession>(ctx.key, "POST", "/v1/checkout/sessions", params, {
      idempotencyKey: `crewtavo-setup-${clientId}-${Math.floor(Date.now() / 60_000)}-${sent}`,
    });
  };
  try {
    let session: StripeCheckoutSession;
    try {
      session = await open(await customerFor(ctx, clientId));
    } catch (error) {
      if (!(error instanceof StripeError && error.code === "resource_missing" && error.param === "customer")) throw error;
      // The customer was deleted in Stripe: make a new one.
      session = await open(await customerFor(ctx, clientId, true));
    }
    if (!session.url) throw new StripeError("Stripe didn't give a page to save the card on", 502);
    return session.url;
  } catch (error) {
    if (keyTurnedDown(error)) {
      await keyRefused(ctx, "autopay", error as StripeError);
      throw new HttpError(409, "This business needs to update its Stripe key before cards can be saved.");
    }
    // Stripe still making the page for a tap a moment ago (or a key it saw with other parameters):
    // a moment later it goes through.
    if (error instanceof StripeError && (error.status === 409 || error.code === "idempotency_error" || error.type === "idempotency_error")) {
      throw new HttpError(503, "Stripe is still opening the last page. Try again in a moment.");
    }
    throw error;
  }
}

/**
 * A setup the client finished on Stripe's page: check it's this client's, save the card (or bank
 * account), make it the customer's default. Idempotent: the return page and the webhook both call it.
 */
export async function finishStripeSetup(env: Env, admin: Db, companyId: string, clientId: string, sessionId: string): Promise<SetupOutcome> {
  const ctx = await context(env, admin, companyId);
  if (!ctx?.own) throw new HttpError(501, "Autopay isn't set up for this business.");
  let session: StripeCheckoutSession;
  try {
    session = await stripeApi<StripeCheckoutSession>(ctx.key, "GET", `/v1/checkout/sessions/${sessionId}`, { expand: ["setup_intent.payment_method"] });
  } catch (error) {
    if (missing(error)) throw new HttpError(404, "That setup isn't for this client.");
    if (keyTurnedDown(error)) {
      await keyRefused(ctx, "autopay", error as StripeError);
      throw new HttpError(409, "This business needs to update its Stripe key before cards can be saved.");
    }
    throw error;
  }
  if (session.mode !== "setup" || !setupFor(session.metadata, companyId) || session.metadata?.crewtavo_client_id !== clientId) {
    throw new HttpError(404, "That setup isn't for this client.");
  }
  const si = await setupIntentOf(ctx, session.setup_intent);
  if (!si) return { status: "refused", reason: NOT_SAVED };
  return saveSetup(ctx, clientId, si, setupVia(session.metadata));
}

/** Crewtavo's autopay metadata, for this company. */
const setupFor = (metadata: Record<string, string> | null | undefined, companyId: string) =>
  metadata?.crewtavo_kind === "autopay" && metadata.crewtavo_company_id === companyId && Boolean(metadata.crewtavo_client_id);

/** Who the Hub link a setup was opened from counts as (routes/public.ts trustOf), kept as the card's saved_via. */
type SetupVia = "client" | "office" | "legacy";

/** The kind of Hub link a setup was opened from (crewtavo_via). One opened before that was kept counts as the client's own. */
const setupVia = (metadata: Record<string, string> | null | undefined): SetupVia =>
  metadata?.crewtavo_via === "office" || metadata?.crewtavo_via === "legacy" ? metadata.crewtavo_via : "client";

/** A session's SetupIntent with its payment method, read back when it came as an id. */
async function setupIntentOf(ctx: Ctx, si: string | StripeSetupIntent | null): Promise<StripeSetupIntent | null> {
  if (!si) return null;
  if (typeof si === "object") return si;
  return stripeApi<StripeSetupIntent>(ctx.key, "GET", `/v1/setup_intents/${si}`, { expand: ["payment_method"] });
}

/** The columns a saved method keeps of Stripe's payment method. */
function methodFields(pm: StripePaymentMethod) {
  return {
    type: pm.type,
    brand: pm.card?.brand ?? null,
    wallet: pm.card?.wallet?.type ?? null,
    last4: pm.card?.last4 ?? pm.us_bank_account?.last4 ?? null,
    exp_month: pm.card?.exp_month ?? null,
    exp_year: pm.card?.exp_year ?? null,
    bank_name: pm.us_bank_account?.bank_name ?? null,
  };
}

/**
 * Save what a finished setup saved, for the return page and the webhooks alike. A card whose
 * security code or ZIP the bank couldn't confirm is taken off again and refused. A bank account
 * still waiting on its small deposits is saved `pending`. The new card becomes the client's default
 * only when they have no agreement for another one: a client changing card who stops before
 * agreeing is still charged to the one they agreed to (autopay_record_authorization makes it the
 * default when they agree). `via` is the kind of Hub link the setup was opened from, kept as the
 * card's saved_via.
 */
async function saveSetup(ctx: Ctx, clientId: string, si: StripeSetupIntent, via: SetupVia): Promise<SetupOutcome> {
  let pm = si.payment_method;
  if (typeof pm === "string") pm = await stripeApi<StripePaymentMethod>(ctx.key, "GET", `/v1/payment_methods/${pm}`);
  const waitsOnBank = (si.status === "requires_action" || si.status === "processing") && pm?.type !== "card";
  if (!pm || (si.status !== "succeeded" && !waitsOnBank)) return { status: "refused", reason: si.last_setup_error?.message ?? NOT_SAVED };
  const customer = pm.customer ?? si.customer;
  if (!customer) return { status: "refused", reason: NOT_SAVED };
  const fields = { ...methodFields(pm), stripe_payment_method_id: pm.id, stripe_customer_id: customer, stripe_account: ctx.account, livemode: pm.livemode };

  const checks = pm.card?.checks;
  if (checks?.cvc_check === "fail" || checks?.address_postal_code_check === "fail") {
    await detachInStripe(ctx, pm.id);
    // Kept as removed, so a late or repeated webhook for it can't bring it back.
    const removed = { status: "removed", removed_reason: "checks", removed_at: new Date().toISOString(), is_default: false };
    const { error } = await ctx.admin.from("client_payment_methods").insert({ company_id: ctx.companyId, client_id: clientId, source: "hub", ...fields, ...removed });
    if (error?.code === "23505") {
      fail((await ctx.admin.from("client_payment_methods").update(removed).eq("company_id", ctx.companyId).eq("stripe_payment_method_id", pm.id).neq("status", "removed")).error);
    } else fail(error);
    return { status: "refused", reason: "Your bank couldn't confirm the card's security code or ZIP code. Try again or use another card." };
  }

  const { data: agreement, error: agreementError } = await ctx.admin
    .from("autopay_authorizations")
    .select("payment_method_id")
    .eq("company_id", ctx.companyId)
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .maybeSingle();
  fail(agreementError);
  let makeDefault = !agreement?.payment_method_id;
  if (agreement?.payment_method_id) {
    const { data: agreed } = await ctx.admin.from("client_payment_methods").select("stripe_payment_method_id").eq("company_id", ctx.companyId).eq("id", agreement.payment_method_id).maybeSingle();
    makeDefault = agreed?.stripe_payment_method_id === pm.id;
  }
  const { data: id, error } = await ctx.admin.rpc("autopay_save_payment_method", {
    p_company: ctx.companyId, p_client: clientId,
    p_method: asJson({ ...fields, status: si.status === "succeeded" ? "active" : "pending", source: "hub", saved_via: via, make_default: makeDefault }),
  });
  fail(error);
  const { data: saved, error: readError } = await ctx.admin
    .from("client_payment_methods")
    .select("id, status, type, brand, last4, bank_name, wallet, exp_month, exp_year")
    .eq("company_id", ctx.companyId)
    .eq("id", id as string)
    .maybeSingle();
  fail(readError);
  // Taken off since (a repeated webhook, or the page opened again): a removed card never comes back.
  if (!saved || saved.status === "removed") return { status: "refused", reason: "That card was removed. Add it again to use it." };
  return {
    status: saved.status === "pending" ? "pending" : "agree",
    method: { id: saved.id, label: methodLabel(saved), type: saved.type, exp: methodExpiry(saved) },
  };
}

/**
 * A setup finished, from a webhook: the Checkout Session, or its SetupIntent (also how a bank
 * account checked by small deposits comes back days later, or fails). Read back from Stripe, and
 * only for a client of this company. True when something was saved or changed.
 */
async function setupFinished(
  env: Env,
  admin: Db,
  companyId: string,
  access: StripeAccess,
  from: { session?: string; setupIntent?: string; object?: Record<string, any> },
): Promise<boolean> {
  const ctx = await context(env, admin, companyId, access);
  if (!ctx) return false;
  let si: StripeSetupIntent | null;
  let clientId: string;
  let via: SetupVia;
  if (from.session) {
    const session = await stripeApi<StripeCheckoutSession>(ctx.key, "GET", `/v1/checkout/sessions/${from.session}`, { expand: ["setup_intent.payment_method"] });
    if (session.mode !== "setup" || !setupFor(session.metadata, companyId)) return false;
    clientId = session.metadata!.crewtavo_client_id!;
    via = setupVia(session.metadata);
    si = await setupIntentOf(ctx, session.setup_intent);
  } else {
    si = await stripeApi<StripeSetupIntent>(ctx.key, "GET", `/v1/setup_intents/${from.setupIntent}`, { expand: ["payment_method"] });
    if (!setupFor(si.metadata, companyId)) return false;
    clientId = si.metadata!.crewtavo_client_id!;
    via = setupVia(si.metadata);
  }
  if (!si) return false;
  const { data: client } = await admin.from("clients").select("id").eq("company_id", companyId).eq("id", clientId).maybeSingle();
  if (!client) return false;
  if (si.status === "succeeded" || si.status === "requires_action" || si.status === "processing") {
    return (await saveSetup(ctx, clientId, si, via)).status !== "refused";
  }
  // It failed (a bank account whose small deposits didn't check out): one saved as pending goes.
  const ids = [
    typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id,
    si.last_setup_error?.payment_method?.id,
    typeof from.object?.payment_method === "string" ? from.object.payment_method : from.object?.payment_method?.id,
    from.object?.last_setup_error?.payment_method?.id,
  ].filter((id): id is string => typeof id === "string");
  if (!ids.length) return false;
  const { error } = await admin
    .from("client_payment_methods")
    .update({ status: "removed", removed_reason: "stripe", removed_at: new Date().toISOString(), is_default: false })
    .eq("company_id", companyId)
    .eq("client_id", clientId)
    .in("stripe_payment_method_id", [...new Set(ids)])
    .eq("status", "pending");
  fail(error);
  return true;
}

/** Take a payment method off its customer in Stripe. Gone already counts as done. Never throws. */
async function detachInStripe(ctx: Ctx, stripeId: string) {
  try {
    await stripeApi(ctx.key, "POST", `/v1/payment_methods/${stripeId}/detach`);
  } catch (error) {
    if (missing(error) || (error instanceof StripeError && /not attached/i.test(error.message))) return;
    if (keyTurnedDown(error)) return keyRefused(ctx, "autopay", error as StripeError);
    console.error("Couldn't take a payment method off in Stripe", stripeId, error);
  }
}

/** Take a saved method off here, and in Stripe when Crewtavo saved it (the office's Remove card, or a client changing card). */
export async function detachPaymentMethod(env: Env, admin: Db, companyId: string, methodId: string, reason: "client" | "office" | "replaced"): Promise<void> {
  const { data: method, error } = await admin.from("client_payment_methods").select("id, stripe_payment_method_id, source, status").eq("company_id", companyId).eq("id", methodId).maybeSingle();
  fail(error);
  if (!method) throw new HttpError(404, "Card not found.");
  // Off here first, so Stripe's payment_method.detached for it finds it gone already (and doesn't
  // tell the office it was taken off in Stripe).
  if (method.status !== "removed") {
    fail(
      (
        await admin
          .from("client_payment_methods")
          .update({ status: "removed", removed_reason: reason, removed_at: new Date().toISOString(), is_default: false })
          .eq("company_id", companyId)
          .eq("id", method.id)
          .neq("status", "removed")
      ).error,
    );
  }
  // One brought in from Stripe stays there: the business may still charge it by hand, or use it
  // for something else, while it moves clients over.
  if (method.source !== "hub") return;
  const ctx = await context(env, admin, companyId);
  if (ctx?.own) await detachInStripe(ctx, method.stripe_payment_method_id);
}

/** Taken off in Stripe (or the customer deleted): never charged again. */
async function methodRemoved(ctx: Ctx, where: { id?: string; stripeId?: string }) {
  let query = ctx.admin
    .from("client_payment_methods")
    .update({ status: "removed", removed_reason: "stripe", removed_at: new Date().toISOString(), is_default: false })
    .eq("company_id", ctx.companyId)
    .neq("status", "removed");
  query = where.id ? query.eq("id", where.id) : query.eq("stripe_payment_method_id", where.stripeId!);
  fail((await query).error);
}

/** payment_method.detached: the card was taken off in Stripe. A no-op when it's off here already. */
async function methodGone(ctx: Ctx, stripeId: string) {
  await methodRemoved(ctx, { stripeId });
}

/**
 * payment_method.automatically_updated: the bank sent the card's new number or expiry. One that
 * needed updating because it had expired can be charged again.
 */
async function methodUpdated(ctx: Ctx, stripeId: string) {
  const { data: row, error } = await ctx.admin
    .from("client_payment_methods")
    .select("id, status, exp_month, exp_year")
    .eq("company_id", ctx.companyId)
    .eq("stripe_payment_method_id", stripeId)
    .maybeSingle();
  fail(error);
  if (!row || row.status === "removed") return;
  const pm = await stripeApi<StripePaymentMethod>(ctx.key, "GET", `/v1/payment_methods/${stripeId}`);
  const { brand, last4, exp_month, exp_year, wallet } = methodFields(pm);
  let status = row.status;
  if (row.status === "needs_update") {
    const { data: last } = await ctx.admin
      .from("autopay_charges")
      .select("decline_code")
      .eq("company_id", ctx.companyId)
      .eq("payment_method_id", row.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lapsed = Boolean(row.exp_year && row.exp_month && Date.UTC(row.exp_year, row.exp_month, 1) <= Date.now());
    if (last?.decline_code === "expired_card" || lapsed) status = "active";
  }
  fail(
    (
      await ctx.admin
        .from("client_payment_methods")
        .update({ brand, last4, exp_month, exp_year, wallet, status })
        .eq("company_id", ctx.companyId)
        .eq("id", row.id)
        .neq("status", "removed")
    ).error,
  );
}

/** mandate.updated, inactive: the bank account can't be debited until the client sets it up again. */
async function mandateInactive(ctx: Ctx, stripeId: string | undefined) {
  if (!stripeId) return;
  fail(
    (await ctx.admin.from("client_payment_methods").update({ status: "needs_update" }).eq("company_id", ctx.companyId).eq("stripe_payment_method_id", stripeId).eq("status", "active")).error,
  );
}

// ---- Charging -------------------------------------------------------------------------------

/** Stripe's answer can't be had right now (down, busy, a request still in flight): try again later. */
const transient = (error: StripeError) =>
  error.status === 0 || error.status === 409 || error.status === 429 || error.status >= 500 || error.code === "idempotency_error" || error.type === "idempotency_error";

/** The saved method, or its customer, isn't in Stripe anymore. */
const methodMissing = (error: StripeError) =>
  error.code === "resource_missing" && (["payment_method", "default_payment_method", "customer"].includes(error.param ?? "") || /PaymentMethod|payment method|customer/i.test(error.message));

/** The bank wants the client there to confirm it (3D Secure). */
const needsConfirming = (error: StripeError) =>
  error.code === "authentication_required" || error.declineCode === "authentication_required" || error.code === "invoice_payment_intent_requires_action" || error.paymentIntentStatus === "requires_action";

const CONFIRM = "Their bank wants them to confirm the payment";

/**
 * A Stripe invoice of ours that's no longer the one to charge: voided, or, when it turns out to be
 * paid meanwhile, that's booked and the paid invoice comes back.
 */
async function voidOrPaid(ctx: Ctx, row: Linked): Promise<StripeInvoice | null> {
  if (await voidStripeInvoice(ctx, row)) return null;
  return fetchInvoice(ctx.key, row.stripe_id!);
}

/**
 * A Stripe invoice voidOrPaid found paid: the saved method's charge only when it's this charge's own
 * (its crewtavo_autopay) and paid with that method or wholly from Stripe credit. Anything else (the
 * Pay link on Stripe's page, another card) was paid another way.
 */
async function paidHere(ctx: Ctx, paid: StripeInvoice, chargeId: string, pm: string): Promise<AutopayChargeResult> {
  if (paid.metadata?.crewtavo_autopay === chargeId && (await paidBy(ctx, paid, pm))) return { outcome: "paid", amountCents: paid.amount_paid };
  return { outcome: "unusable", message: PAID_ANOTHER_WAY };
}

/**
 * Charge a claimed autopay charge's invoice to the saved method, once. Makes (or reuses) its
 * charge_automatically Stripe invoice while the Crewtavo invoice is still a draft, has `markSent`
 * mark it sent, then pays it off session.
 */
export async function chargeInvoiceAutomatically(
  env: Env,
  admin: Db,
  companyId: string,
  input: { chargeId: string; attempt: number; invoiceId: string; method: SavedMethod; markSent: (amountCents: number) => Promise<boolean> },
): Promise<AutopayChargeResult> {
  const { method } = input;
  const ctx = await context(env, admin, companyId);
  if (!ctx?.own) return { outcome: "unusable", message: "Autopay needs this business's own Stripe account" };
  if (method.livemode !== ctx.livemode || (method.stripe_account && ctx.account && method.stripe_account !== ctx.account)) {
    return { outcome: "unusable", message: "The saved card is in another Stripe account" };
  }
  const invoice = await billable(ctx, input.invoiceId);
  if (!invoice) return { outcome: "retry", message: CHANGED };
  if (cents(invoice.balance_due) < minimumCharge(ctx.currency)) return { outcome: "too_small" };

  // Up to sending: the invoice is still a draft here, so a refusal leaves it for the office to send
  // the usual way (called off), never with a notice to the client.
  let row: Linked;
  let current: StripeInvoice;
  try {
    const { linked, live } = await linkedTo(ctx, invoice.id);
    const clearing = linked.filter((r) => waiting(r, ctx.livemode));
    if (clearing.length) {
      // This charge's own bank payment, on its way though its answer was lost: it's this charge's
      // to follow (the webhook settles or bounces it), not one the client made on Stripe's page.
      const own = clearing.find((r) => r.collection === "charge_automatically" && r.stripe_id && inUse(ctx, r));
      const found = own ? await fetchInvoice(ctx.key, own.stripe_id!) : null;
      if (found?.metadata?.crewtavo_autopay === input.chargeId && (await paidWith(ctx, found)) === method.stripe_payment_method_id) {
        return { outcome: "processing", amountCents: found.amount_due };
      }
      return { outcome: "busy", message: PROCESSING_MESSAGE };
    }
    if (live?.status === "creating") return { outcome: "busy", message: STILL_MAKING };
    if (linked.some((r) => r.origin === "stripe")) return { outcome: "unusable", message: "This invoice was made in Stripe. Charge it there" };
    // A Stripe invoice of this invoice's is paid, but booking it (or part of it) failed: it's booked
    // when Stripe sends the event again. Booked now (never twice: processor_ref is unique), and when
    // that takes anything off what's owed, the card is never charged a second time. Autopay's only
    // when it's this charge's own, paid with this card or wholly from Stripe credit; anything else
    // (Stripe's page, another card) was paid another way. One booked long ago (refunded since, so
    // owed again) takes nothing off, and is left alone.
    for (const done of linked.filter((r) => r.status === "paid" && r.stripe_id && inUse(ctx, r))) {
      const found = await fetchInvoice(ctx.key, done.stripe_id!);
      if (found.status !== "paid") continue;
      const own = done.collection === "charge_automatically" && found.metadata?.crewtavo_autopay === input.chargeId && (await paidBy(ctx, found, method.stripe_payment_method_id));
      // Sent first, should it still be a draft (credit paid it all before it was sent).
      if (own) await input.markSent(found.total);
      await settleOwnInvoice(ctx, found);
      const after = await billable(ctx, invoice.id);
      if (after && cents(after.balance_due) >= cents(invoice.balance_due)) continue;
      return own ? { outcome: "paid", amountCents: found.amount_paid } : { outcome: "unusable", message: PAID_ANOTHER_WAY };
    }
    let reuse: StripeInvoice | null = null;
    if (live) {
      // One a try before this made (the worker stopped partway) is charged only while it's still
      // exactly this charge: its own (crewtavo_autopay), the amount, the customer and the card. One an
      // earlier charge left is voided, as the database never counts it as this charge's.
      const found = live.collection === "charge_automatically" && live.stripe_id ? await fetchInvoice(ctx.key, live.stripe_id) : null;
      if (found?.status === "paid") {
        await settleOwnInvoice(ctx, found);
        // Paid on Stripe's page with another card or bank account while this waited to try again, or
        // an earlier charge's: paid another way.
        return paidHere(ctx, found, input.chargeId, method.stripe_payment_method_id);
      }
      const same =
        found?.status === "open" && found.metadata?.crewtavo_autopay === input.chargeId && cents(live.amount_due) - cents(live.tip_amount) === cents(invoice.balance_due) &&
        found.customer === method.stripe_customer_id && found.default_payment_method === method.stripe_payment_method_id;
      if (same) reuse = found;
      else {
        const paid = await voidOrPaid(ctx, live);
        if (paid?.status === "paid") return paidHere(ctx, paid, input.chargeId, method.stripe_payment_method_id);
      }
    }
    if (reuse) {
      row = live!;
      current = reuse;
    } else {
      const made = await createStripeInvoice(ctx, invoice, 0, {
        collection: "charge_automatically", paymentMethod: method.stripe_payment_method_id, customer: method.stripe_customer_id, autopayCharge: input.chargeId,
      });
      if (!made) return { outcome: "busy", message: STILL_MAKING };
      if (made.owedBefore) return { outcome: "unusable", message: "Their balance in Stripe would change the charge. Send it the usual way" };
      current = made.stripe ?? (await fetchInvoice(ctx.key, made.stripe_id!));
      row = made;
    }
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
    if (keyTurnedDown(error)) {
      await keyRefused(ctx, "autopay", error as StripeError);
      return { outcome: "unusable", message: KEY_REFUSED };
    }
    if (methodMissing(error)) {
      await methodRemoved(ctx, { id: method.id });
      return { outcome: "unusable", message: GONE };
    }
    if (transient(error)) return { outcome: "retry", message: reason(error) };
    return { outcome: "unusable", message: reason(error) };
  }

  // Sent now, without an email: the receipt goes once it's paid.
  if (!(await input.markSent(current.total))) {
    // The claim was lost, or the invoice was deleted, changed or paid meanwhile.
    const paid = await voidOrPaid(ctx, row);
    if (paid?.status === "paid") return paidHere(ctx, paid, input.chargeId, method.stripe_payment_method_id);
    return { outcome: "retry", message: CHANGED };
  }
  // Credit they had in Stripe paid it all: booked now it's sent, with nothing charged to the card.
  if (current.status === "paid") {
    await settleOwnInvoice(ctx, current);
    return { outcome: "paid", amountCents: current.amount_paid };
  }

  let paid: StripeInvoice;
  try {
    // The key changes with each claim (a try that timed out is safe to make again: a paid invoice
    // answers "already paid") and with the card (no clash after the client changes it). The charge
    // comes back with its fee for recordPayment; the PaymentIntent stays an id.
    paid = await stripeApi<StripeInvoice>(
      ctx.key, "POST", `/v1/invoices/${current.id}/pay`,
      { off_session: true, payment_method: method.stripe_payment_method_id, expand: ["charge.balance_transaction"] },
      { idempotencyKey: `crewtavo-autopay-${input.chargeId}-${input.attempt}-${method.stripe_payment_method_id}` },
    );
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
    if (error.code === "invoice_already_paid" || /already paid/i.test(error.message)) {
      const fresh = await fetchInvoice(ctx.key, current.id);
      await applyInvoice(ctx, fresh);
      return fresh.status === "paid" ? { outcome: "paid", amountCents: fresh.amount_paid } : { outcome: "retry", message: reason(error) };
    }
    if (keyTurnedDown(error)) {
      await keyRefused(ctx, "autopay", error as StripeError);
      return { outcome: "unusable", message: KEY_REFUSED };
    }
    if (needsConfirming(error)) return { outcome: "needs_client", code: "authentication_required", message: CONFIRM };
    if (error.status === 402) return { outcome: "declined", code: error.declineCode ?? error.code ?? null, message: reason(error) };
    if (methodMissing(error)) {
      await methodRemoved(ctx, { id: method.id });
      return { outcome: "needs_client", code: "resource_missing", message: GONE };
    }
    if (transient(error)) return { outcome: "retry", message: reason(error) };
    // Anything else (a card taken off whose webhook hasn't come, say): the invoice is sent by now,
    // so the client gets the Pay link.
    return { outcome: "needs_client", code: error.code ?? null, message: reason(error) };
  }
  if (paid.status === "paid") {
    await settleOwnInvoice(ctx, paid);
    return { outcome: "paid", amountCents: paid.amount_paid };
  }
  if (!paid.payment_intent) return { outcome: "needs_client", code: null, message: "Stripe couldn't finish the charge" };
  const intent = await stripeApi<StripePaymentIntent>(ctx.key, "GET", `/v1/payment_intents/${paid.payment_intent}`);
  if (intent.status === "processing") {
    // A bank payment, which takes a few days. A bounce that came first reopened the row already.
    fail((await ctx.admin.from("stripe_invoices").update({ status: "processing", processing_at: new Date().toISOString() }).eq("id", row.id).eq("status", "open")).error);
    return { outcome: "processing", amountCents: paid.amount_due };
  }
  if (intent.status === "succeeded") {
    const fresh = await fetchInvoice(ctx.key, current.id);
    await applyInvoice(ctx, fresh);
    return { outcome: "paid", amountCents: fresh.amount_paid };
  }
  if (intent.status === "requires_action") return { outcome: "needs_client", code: "authentication_required", message: CONFIRM };
  if (intent.status === "requires_payment_method") {
    const problem = intent.last_payment_error;
    const message = problem?.message ? problem.message.replace(/\.\s*$/, "") : method.type === "us_bank_account" ? "The bank payment didn't go through" : "The card was declined";
    return { outcome: method.type === "us_bank_account" ? "bank_failed" : "declined", code: problem?.decline_code ?? problem?.code ?? null, message };
  }
  return { outcome: "needs_client", code: null, message: "Stripe couldn't finish the charge" };
}

/** An invoice's newest charge_automatically Stripe invoice the key in use reaches, still live or paid. */
async function autopayRow(ctx: Ctx, invoiceId: string): Promise<Linked | undefined> {
  const { data, error } = await ctx.admin
    .from("stripe_invoices")
    .select(LINKED)
    .eq("company_id", ctx.companyId)
    .eq("invoice_id", invoiceId)
    .eq("purpose", "invoice")
    .eq("collection", "charge_automatically")
    .order("created_at", { ascending: false });
  fail(error);
  return (data ?? []).find((row) => row.stripe_id && inUse(ctx, row) && [...LIVE, "paid"].includes(row.status));
}

/**
 * For the task's 6th claim of a charge (3.3): what Stripe says about its charge_automatically
 * invoice, applied here first (a charge that went through before a crash is booked, not stopped).
 * Only this charge's own Stripe invoice counts: one an earlier charge made (paid, then refunded)
 * is 'none', and one paid with anything but the saved method is 'other' (paid another way).
 */
export async function autopayStripeCheck(env: Env, admin: Db, companyId: string, invoiceId: string, chargeId: string): Promise<"paid" | "processing" | "open" | "other" | "none"> {
  const ctx = await context(env, admin, companyId);
  if (!ctx?.own) return "none";
  const row = await autopayRow(ctx, invoiceId);
  if (!row) return "none";
  let current: StripeInvoice;
  try {
    current = await fetchInvoice(ctx.key, row.stripe_id!);
  } catch (error) {
    if (missing(error)) return "none";
    throw error;
  }
  if (current.metadata?.crewtavo_autopay !== chargeId) return "none";
  if (current.status !== "open") {
    await applyInvoice(ctx, current);
    if (current.status !== "paid") return "none";
    const { data: charge } = await ctx.admin.from("autopay_charges").select("payment_method_id").eq("company_id", ctx.companyId).eq("id", chargeId).maybeSingle();
    const { data: method } = charge?.payment_method_id
      ? await ctx.admin.from("client_payment_methods").select("stripe_payment_method_id").eq("company_id", ctx.companyId).eq("id", charge.payment_method_id).maybeSingle()
      : { data: null };
    return method && (await paidBy(ctx, current, method.stripe_payment_method_id)) ? "paid" : "other";
  }
  const intent = current.payment_intent ? await stripeApi<StripePaymentIntent>(ctx.key, "GET", `/v1/payment_intents/${current.payment_intent}`) : null;
  if (intent?.status === "processing") {
    fail((await ctx.admin.from("stripe_invoices").update({ status: "processing", processing_at: new Date().toISOString() }).eq("id", row.id).eq("status", "open")).error);
    return "processing";
  }
  return "open";
}

/** Why a bank payment in a Stripe account Crewtavo left is called off (as autopay_account_left says it). */
const LEFT_ACCOUNT = "The Stripe account it was in was switched away from. Check it there";

/**
 * Hourly: autopay charges 'processing' for more than a day are read back from Stripe and applied,
 * in case a webhook never came. A bank payment can take days, so a slow one is only looked at,
 * never called off. One whose Stripe invoice is marked paid here already (it settled on an invoice
 * voided meanwhile, before settling finished the charge) is applied again, which finishes it. One
 * in a Stripe account Crewtavo has since left (or with Stripe disconnected) can't be read back: once
 * past the days a bank payment can take, it has cleared or bounced there, so it's called off, as
 * leaving the account does for one older than that, rather than wait here for good (the office was
 * told to check it there). Returns how many changed.
 */
export async function reconcileAutopayProcessing(env: Env, admin: Db): Promise<number> {
  const { data, error } = await admin
    .from("autopay_charges")
    .select("id, company_id, invoice_id, updated_at")
    .eq("status", "processing")
    .lt("updated_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
    .not("invoice_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(50);
  fail(error);
  const contexts = new Map<string, Ctx | null>();
  let changed = 0;
  for (const charge of data ?? []) {
    try {
      if (!contexts.has(charge.company_id)) contexts.set(charge.company_id, await context(env, admin, charge.company_id));
      const ctx = contexts.get(charge.company_id);
      if (!charge.invoice_id) continue;
      const row = ctx?.own ? await autopayRow(ctx, charge.invoice_id) : undefined;
      if (!ctx || !row) {
        // Nothing to read it back from: called off once it has cleared or bounced there.
        if (Date.parse(charge.updated_at) > Date.now() - CLEARING_DAYS * 24 * 60 * 60_000) continue;
        const { data: off, error: offError } = await admin
          .from("autopay_charges")
          .update({ status: "called_off", last_error: LEFT_ACCOUNT, claim_token: null, locked_until: null, busy_since: null })
          .eq("id", charge.id)
          .eq("status", "processing")
          .select("id");
        fail(offError);
        if (off?.length) changed++;
        continue;
      }
      const current = await fetchInvoice(ctx.key, row.stripe_id!);
      if (current.status !== "open") {
        // Paid: settling it finishes the charge (or the invoice trigger did, as the invoice turned paid).
        await applyInvoice(ctx, current);
        changed++;
        continue;
      }
      const intent = current.payment_intent ? await stripeApi<StripePaymentIntent>(ctx.key, "GET", `/v1/payment_intents/${current.payment_intent}`) : null;
      if (intent?.status !== "requires_payment_method") continue;
      // It bounced and the webhook never said.
      if (row.status === "processing") fail((await ctx.admin.from("stripe_invoices").update({ status: "open" }).eq("id", row.id).eq("status", "processing")).error);
      const { data: done, error: finishError } = await admin.rpc("finish_autopay_charge", {
        p_id: charge.id, p_outcome: "bank_failed", p_company: charge.company_id, p_error: "The bank payment didn't go through", p_decline: intent.last_payment_error?.code ?? "bank_failed",
      });
      fail(finishError);
      if (done) changed++;
    } catch (problem) {
      console.error("Couldn't read back an autopay bank payment", charge.id, problem);
    }
  }
  return changed;
}

/** An autopay bank payment bounced (invoice.payment_failed on its processing row): the charge needs the client. */
async function autopayBounced(ctx: Ctx, invoiceId: string, paymentIntent: string | null) {
  // By this row's invoice, never the event's metadata.
  const { data: charge, error } = await ctx.admin.from("autopay_charges").select("id").eq("company_id", ctx.companyId).eq("invoice_id", invoiceId).eq("status", "processing").maybeSingle();
  fail(error);
  if (!charge) return;
  let decline = "bank_failed";
  if (paymentIntent) {
    const intent = await stripeApi<StripePaymentIntent>(ctx.key, "GET", `/v1/payment_intents/${paymentIntent}`).catch(() => null);
    decline = intent?.last_payment_error?.code ?? decline;
  }
  fail(
    (
      await ctx.admin.rpc("finish_autopay_charge", {
        p_id: charge.id, p_outcome: "bank_failed", p_company: ctx.companyId, p_error: "The bank payment didn't go through", p_decline: decline,
      })
    ).error,
  );
}

// ---- Tips on the saved card -----------------------------------------------------------------

const TIP_LATER = "The tip can't be added online right now. Contact us to add it.";

/**
 * A tip after an invoice was paid, charged to the saved card as its own small Stripe invoice. Tips
 * are asked about again here, before anything goes to Stripe. Never charges twice: when Stripe's
 * answer is lost, Stripe is asked how it went before anything is undone.
 */
export async function chargeTip(
  env: Env,
  admin: Db,
  companyId: string,
  invoiceId: string,
  tipCents: number,
  method: SavedMethod,
  who: { ip: string | null; userAgent: string | null },
): Promise<{ status: "paid" }> {
  const { data: rows, error: rowsError } = await admin.from("stripe_invoices").select("origin, purpose").eq("company_id", companyId).eq("invoice_id", invoiceId);
  fail(rowsError);
  const imported = (rows ?? []).some((r) => (r.purpose ?? "invoice") === "invoice" && r.origin === "stripe");
  const { data: company, error: companyError } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  fail(companyError);
  if (!tipsAllowed((company?.settings as { hub_tips?: unknown } | null)?.hub_tips, imported)) throw new HttpError(409, "Tips are turned off.");

  const ctx = await context(env, admin, companyId);
  if (!ctx?.own) throw new HttpError(501, "Autopay isn't set up for this business.");
  if (!Number.isInteger(tipCents) || tipCents < minimumCharge(ctx.currency)) throw new HttpError(400, "A tip has to be at least $0.50.");
  if (method.livemode !== ctx.livemode || (method.stripe_account && ctx.account && method.stripe_account !== ctx.account)) throw new HttpError(409, "There's no saved card to add a tip to.");
  const { data: invoice, error: invoiceError } = await admin.from("invoices").select("id, number").eq("company_id", companyId).eq("id", invoiceId).maybeSingle();
  fail(invoiceError);
  if (!invoice) throw new HttpError(404, "Invoice not found.");

  // One tip at a time for an invoice (stripe_invoices_live_tip_idx).
  const { data: row, error } = await admin
    .from("stripe_invoices")
    .insert({
      company_id: companyId, invoice_id: invoiceId, origin: "crewtavo", status: "creating", amount_due: tipCents / 100, tip_amount: tipCents / 100,
      livemode: ctx.livemode, stripe_account: ctx.account, collection: "charge_automatically", purpose: "tip",
    })
    .select("id")
    .single();
  if (error?.code === "23505") throw new HttpError(409, "A tip for this invoice is already going through.");
  fail(error);
  if (!row) throw new HttpError(409, "A tip for this invoice is already going through.");

  let stripeId: string | null = null;
  let paying = false;
  // Nothing left behind: the Stripe invoice deleted (a draft) or voided, and the row gone.
  const discard = async () => {
    if (stripeId) {
      const id = stripeId;
      await stripeApi(ctx.key, "DELETE", `/v1/invoices/${id}`).catch(() => stripeApi(ctx.key, "POST", `/v1/invoices/${id}/void_invoice`)).catch(() => undefined);
    }
    await admin.from("stripe_invoices").delete().eq("id", row.id);
  };
  const key = `crewtavo-tip-${row.id}`;
  const customer = method.stripe_customer_id;
  try {
    const draft = await stripeApi<StripeInvoice>(
      ctx.key, "POST", "/v1/invoices",
      {
        customer, currency: ctx.currency, collection_method: "charge_automatically", default_payment_method: method.stripe_payment_method_id, auto_advance: false,
        pending_invoice_items_behavior: "exclude", custom_fields: [{ name: "Invoice", value: `#${invoice.number}` }],
        metadata: {
          crewtavo_company_id: companyId, crewtavo_invoice_id: invoiceId, crewtavo_row: row.id, tip_cents: String(tipCents), crewtavo_tip: "1",
          crewtavo_ip: who.ip || undefined, crewtavo_user_agent: who.userAgent?.slice(0, 400) || undefined,
        },
      },
      { idempotencyKey: key },
    );
    stripeId = draft.id;
    fail((await admin.from("stripe_invoices").update({ stripe_id: draft.id, livemode: draft.livemode }).eq("id", row.id)).error);
    await stripeApi(ctx.key, "POST", "/v1/invoiceitems", { customer, invoice: draft.id, currency: ctx.currency, amount: tipCents, description: `Tip for the crew, invoice #${invoice.number}` }, { idempotencyKey: `${key}-item` });
    const final = await stripeApi<StripeInvoice>(ctx.key, "POST", `/v1/invoices/${draft.id}/finalize`, { auto_advance: false }, { idempotencyKey: `${key}-finalize` });
    fail((await admin.from("stripe_invoices").update({ status: final.status === "paid" ? "paid" : "open", number: final.number, hosted_url: final.hosted_invoice_url }).eq("id", row.id)).error);
    // Credit they had in Stripe paid the tip: booked as it is.
    if (final.status === "paid") {
      await recordPayment(ctx, final);
      return { status: "paid" };
    }
    // Their balance in Stripe would change what's charged.
    if (final.amount_due !== tipCents) {
      await discard();
      throw new HttpError(409, TIP_LATER);
    }
    paying = true;
    const paid = await stripeApi<StripeInvoice>(
      ctx.key, "POST", `/v1/invoices/${final.id}/pay`,
      { off_session: true, payment_method: method.stripe_payment_method_id, expand: ["charge.balance_transaction"] },
      { idempotencyKey: `${key}-pay` },
    );
    if (paid.status === "paid") {
      await settleOwnInvoice(ctx, paid);
      return { status: "paid" };
    }
    // Still open: the bank wants the client to confirm it, which a tip doesn't ask for.
    await discard();
    throw new HttpError(402, "Your card was declined, so the tip wasn't added.");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof StripeError && error.status === 402) {
      await discard();
      throw new HttpError(402, "Your card was declined, so the tip wasn't added.");
    }
    if (keyTurnedDown(error)) {
      await keyRefused(ctx, "autopay", error as StripeError);
      await discard();
      throw new HttpError(409, TIP_LATER);
    }
    // Never asked to pay: nothing was charged.
    if (!paying || !stripeId) {
      await discard();
      throw error;
    }
    // It may have been charged: ask Stripe before undoing anything.
    const current = await fetchInvoice(ctx.key, stripeId).catch(() => null);
    if (current?.status === "paid") {
      await applyInvoice(ctx, current);
      return { status: "paid" };
    }
    // The row stays (no second tip meanwhile); Stripe's webhook settles it.
    if (!current) throw new HttpError(409, "Your tip may have gone through. Check back in a minute.");
    await discard();
    throw error;
  }
}

// ---- Refunds --------------------------------------------------------------------------------

/** Refund a Stripe payment, all or part, and book it at once. */
export async function refundStripePayment(env: Env, admin: Db, companyId: string, paymentId: string, amountCents: number): Promise<{ refunded_cents: number; recorded: boolean }> {
  const { data: payment, error } = await admin.from("payments").select("id, amount, tip_amount, processor, processor_ref").eq("company_id", companyId).eq("id", paymentId).maybeSingle();
  fail(error);
  if (!payment) throw new HttpError(404, "Payment not found.");
  const ref = payment.processor_ref;
  // Only a whole card or bank payment of ours (not what was owed from before, a credit, or a refund).
  if (payment.processor !== "stripe" || !ref?.startsWith("pi_") || ref.includes(":")) throw new HttpError(409, "Refund this payment in Stripe.");
  const { data: rows, error: rowsError } = await admin.from("payments").select("amount, tip_amount, processor_ref").eq("company_id", companyId).like("processor_ref", `${ref}:%`);
  fail(rowsError);
  // What refunds and lost disputes took back of it already (see refunded).
  const back = takenBack((rows ?? []).filter((p) => p.processor_ref !== `${ref}:before`));
  const left = cents(payment.amount) + cents(payment.tip_amount) - back.amount - back.tip;
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > left) throw new HttpError(400, "That's more than is left to refund.");

  const ctx = await context(env, admin, companyId);
  const can = ctx?.own ? await stripeCapabilities(env, admin, companyId, { cached: true }) : null;
  if (!ctx || !can?.refunds) throw new HttpError(409, "Your Stripe key can't make refunds. Update it on the Apps page.");
  let refund: StripeRefund;
  try {
    // Two clicks at once ask for the same refund, which Stripe makes once.
    refund = await stripeApi<StripeRefund>(
      ctx.key, "POST", "/v1/refunds",
      { payment_intent: ref, amount: amountCents, metadata: { crewtavo_company_id: companyId, crewtavo_payment_id: paymentId } },
      { idempotencyKey: `crewtavo-refund-${paymentId}-${back.amount + back.tip + back.before}-${amountCents}` },
    );
  } catch (problem) {
    if (!(problem instanceof StripeError)) throw problem;
    if (problem.code === "resource_missing") throw new HttpError(409, "This payment was made in a Stripe account Crewtavo no longer uses. Refund it in that Stripe account.");
    if (keyTurnedDown(problem)) {
      await keyRefused(ctx, "refunds", problem);
      throw new HttpError(409, KEY_CANT);
    }
    if (problem.status === 400) throw new HttpError(409, problem.message);
    throw problem;
  }
  // Booked as Stripe's webhook books it (the same processor_ref), so never twice.
  let recorded = false;
  try {
    if (refund.charge) recorded = (await refunded(admin, { companyId }, await stripeApi<StripeCharge>(ctx.key, "GET", `/v1/charges/${refund.charge}`))) === companyId;
  } catch (problem) {
    console.error("Couldn't book a refund now; Stripe's webhook will", paymentId, problem);
  }
  return { refunded_cents: refund.amount, recorded };
}

// ---- Cards already in Stripe ----------------------------------------------------------------

interface StripeCustomer {
  id: string;
  email: string | null;
  livemode: boolean;
  invoice_settings?: { default_payment_method?: string | StripePaymentMethod | null } | null;
  default_source?: string | { id: string; object: string; brand?: string | null; last4?: string | null; exp_month?: number | null; exp_year?: number | null } | null;
}

/** A legacy card source's brand ("American Express") as a payment method's ("amex"). */
const SOURCE_BRANDS: Record<string, string> = { "american express": "amex", "diners club": "diners", mastercard: "mastercard", visa: "visa", discover: "discover", jcb: "jcb", unionpay: "unionpay" };

/** The card a customer pays with by default: their default payment method, else a card saved the older way (chargeable as one). */
function defaultCard(customer: StripeCustomer): StripePaymentMethod | null {
  const pm = customer.invoice_settings?.default_payment_method;
  if (pm && typeof pm === "object") return pm;
  const source = customer.default_source;
  if (source && typeof source === "object" && source.object === "card" && source.id.startsWith("card_")) {
    const brand = (source.brand ?? "").toLowerCase();
    return {
      id: source.id, type: "card", customer: customer.id, livemode: customer.livemode,
      card: { brand: SOURCE_BRANDS[brand] ?? (brand.replace(/\s+/g, "_") || null), last4: source.last4 ?? null, exp_month: source.exp_month ?? null, exp_year: source.exp_year ?? null, wallet: null, checks: null },
    };
  }
  return null;
}

/** At most this many customers have their cards listed one by one in an import. */
const CARD_LOOKUPS = 200;

/**
 * Cards customers saved in Stripe ("Bring in your Stripe history"), for autopay. A customer matches a
 * client by the link Crewtavo keeps, else by an email exactly one customer and one client have (a
 * shared household or office address matches nobody). Saved as brought in from Stripe; no
 * agreement is made, so nothing is charged until the client confirms or the owner records that they
 * agreed.
 */
async function importCards(ctx: Ctx, state: ImportState) {
  const { admin, companyId } = ctx;
  const customers: StripeCustomer[] = [];
  for await (const customer of stripeList<StripeCustomer>(ctx.key, "/v1/customers", { expand: ["data.invoice_settings.default_payment_method", "data.default_source"] })) customers.push(customer);
  if (!customers.length) return;
  const [links, clients, defaults, agreements] = await Promise.all([
    admin.from("sync_links").select("local_id, external_id").eq("company_id", companyId).eq("provider", "stripe").eq("entity", "client"),
    admin.from("clients").select("id, email").eq("company_id", companyId).not("email", "is", null),
    admin.from("client_payment_methods").select("client_id").eq("company_id", companyId).eq("status", "active").eq("is_default", true),
    admin.from("autopay_authorizations").select("client_id").eq("company_id", companyId).is("revoked_at", null),
  ]);
  for (const result of [links, clients, defaults, agreements]) fail(result.error);

  const emailOf = (email: string | null | undefined) => email?.trim().toLowerCase() || null;
  const byCustomer = new Map<string, string[]>();
  for (const link of links.data ?? []) byCustomer.set(link.external_id, [...(byCustomer.get(link.external_id) ?? []), link.local_id]);
  const linkedClients = new Set((links.data ?? []).map((link) => link.local_id));
  const clientsByEmail = new Map<string, string[]>();
  for (const client of clients.data ?? []) {
    const email = emailOf(client.email);
    if (email) clientsByEmail.set(email, [...(clientsByEmail.get(email) ?? []), client.id]);
  }
  const customersByEmail = new Map<string, number>();
  for (const customer of customers) {
    const email = emailOf(customer.email);
    if (email) customersByEmail.set(email, (customersByEmail.get(email) ?? 0) + 1);
  }
  const hasDefault = new Set((defaults.data ?? []).map((m) => m.client_id));
  const agreed = new Set((agreements.data ?? []).map((a) => a.client_id));

  let lookups = 0;
  for (const customer of customers) {
    const linked = byCustomer.get(customer.id);
    let clientId: string | null = linked?.length === 1 ? linked[0]! : null;
    let byEmail = false;
    if (!linked) {
      const email = emailOf(customer.email);
      const matches = email ? (clientsByEmail.get(email) ?? []) : [];
      // A client linked to another customer already keeps that one.
      if (email && customersByEmail.get(email) === 1 && matches.length === 1 && !linkedClients.has(matches[0]!)) {
        clientId = matches[0]!;
        byEmail = true;
      }
    }
    let card = defaultCard(customer);
    if (!card && clientId && lookups < CARD_LOOKUPS) {
      lookups++;
      card = (await stripeApi<{ data: StripePaymentMethod[] }>(ctx.key, "GET", "/v1/payment_methods", { customer: customer.id, type: "card", limit: 1 })).data[0] ?? null;
    }
    if (!card) continue;
    if (!clientId) {
      state.counts.cards_unmatched++;
      continue;
    }
    try {
      if (byEmail) {
        // customerFor uses the same customer from now on.
        fail((await admin.from("sync_links").upsert({ company_id: companyId, provider: "stripe", entity: "client", local_id: clientId, external_id: customer.id, synced_at: new Date().toISOString() })).error);
        linkedClients.add(clientId);
      }
      const makeDefault = !hasDefault.has(clientId) && !agreed.has(clientId);
      const { error } = await admin.rpc("autopay_save_payment_method", {
        p_company: companyId, p_client: clientId,
        p_method: asJson({
          ...methodFields(card), stripe_payment_method_id: card.id, stripe_customer_id: customer.id, stripe_account: ctx.account, livemode: card.livemode ?? customer.livemode,
          status: "active", source: "stripe_import", make_default: makeDefault,
        }),
      });
      fail(error);
      if (makeDefault) hasDefault.add(clientId);
      state.counts.cards++;
    } catch (problem) {
      console.error("Couldn't bring in a card saved in Stripe", customer.id, problem);
    }
  }
}
