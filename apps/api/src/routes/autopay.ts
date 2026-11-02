/**
 * Autopay for the office (docs/autopay-plan.md): Settings → Payments, invites to clients, pausing a
 * client's autopay, taking a card off, the owner's "These clients agreed", approving or calling off
 * a charge, Charge card (one invoice or many), and refunding a Stripe payment from the invoice page. Only the office with the invoices
 * area (owners alone for vouching). Calls that check roles in SQL go through the person's own
 * client, as routes/sales.ts does; the rest use the admin client and look every client, card,
 * charge and payment up by company, so an id in the body is never taken to be this company's.
 */
import { ADMINS, OFFICE } from "@crewtavo/core";
import { AUTOPAY_TERMS_MAX, autopaySettings } from "@crewtavo/core/autopay";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { detachPaymentMethod, refreshStripeWebhook, refundStripePayment, stripeCapabilities } from "../integrations/stripe";
import { requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { appUrl, asJson, dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient } from "../lib/supabase";
import { autopayStatus, chargeDueAutopay, INVITE_LIMIT_DETAIL, sendAutopayInvite } from "../services/autopay";
import { cents } from "../services/stripe";

export const autopay = new Hono<AppEnv>();

/** Invites a company can send in an hour, one client or many. */
const INVITES_PER_HOUR = 200;
const inviteKey = (companyId: string) => `autopay-invite:${companyId}`;
/** What only the company can fix, so a bulk invite stops at the first client rather than failing each. */
const COMPANY_PROBLEMS = ["Turn on autopay in Settings → Payments first.", "Update your Stripe key on the Apps page.", "Set APP_URL so links can go out."];

/** sendAutopayInvite's refusals (no email, texting off...) as a 409 the screen shows. */
async function invited<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, error instanceof Error ? error.message : "The invite wasn't sent.");
  }
}

/** The client, if it's this company's (through the person's own client, so RLS has its say too). */
async function ownClient(c: Context<AppEnv>, clientId: string) {
  return must(await c.var.db.from("clients").select("id").eq("company_id", c.var.companyId).eq("id", clientId).maybeSingle(), "Client not found.");
}

// ---------------------------------------------------------------------------------------------
// Settings → Payments
// ---------------------------------------------------------------------------------------------

/** What the key can do, the autopay settings (starter terms filled in), tips, and cards brought in from Stripe. */
autopay.get("/autopay/status", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  return c.json(await autopayStatus(c.env, adminClient(c.env), c.var.companyId));
});

const settingsBody = z.object({
  enabled: z.boolean(),
  terms: z.string().trim().min(1, "Write the terms clients agree to.").max(AUTOPAY_TERMS_MAX),
  timing: z.enum(["now", "end_of_day", "days"]),
  days: z.number().int().min(1).max(14).nullable(),
  max_amount: z.number().positive().max(1_000_000).nullable(),
  receipts: z.boolean(),
  jobs_default: z.boolean(),
});

/**
 * Save the autopay settings (owners and admins with the invoices area; autopay_set_settings checks
 * the same and bumps terms_version when the words or the timing change). Turning it on needs a key
 * that can save cards, and brings Crewtavo's webhook up to date with the events autopay listens for.
 */
autopay.put("/autopay/settings", requireUser, requireCompany(ADMINS, "invoices"), async (c) => {
  const body = await readJson(c, settingsBody);
  if (body.timing === "days" && body.days === null) throw new HttpError(400, "Choose 1 to 14 days.");
  const companyId = c.var.companyId;
  const admin = adminClient(c.env);
  const [caps, saved] = await Promise.all([
    stripeCapabilities(c.env, admin, companyId),
    admin.from("companies").select("trade_preset, settings->autopay").eq("id", companyId).maybeSingle(),
  ]);
  const company = must(saved) as { trade_preset?: string; autopay?: unknown };
  const trade = company.trade_preset;
  const before = autopaySettings({ autopay: company.autopay }, trade);
  if (body.enabled && !(caps.own && caps.autopay)) throw new HttpError(409, "Update your Stripe key on the Apps page to turn on autopay.");
  const { data, error } = await c.var.db.rpc("autopay_set_settings", {
    p_company: companyId,
    p_settings: asJson({ ...body, days: body.timing === "days" ? body.days : null }),
  });
  if (error) throw dbError(error);
  if (body.enabled && !before.enabled) await refreshStripeWebhook(c.env, admin, companyId);
  return c.json({ settings: autopaySettings({ autopay: data }, trade) });
});

// ---------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------

const channel = z.enum(["email", "sms"]);

/** Send one client the link to set up (or confirm) autopay. */
autopay.post("/clients/:id/autopay/invite", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const clientId = param(c, "id");
  const body = await readJson(c, z.object({ channel }));
  const companyId = c.var.companyId;
  const result = await invited(
    sendAutopayInvite(c.env, adminClient(c.env), {
      companyId, clientId, channel: body.channel, baseUrl: appUrl(c), createdBy: c.var.userId,
      allowSend: () => allow(c.env, inviteKey(companyId), INVITES_PER_HOUR, 3600),
    }),
  );
  if (result.detail === INVITE_LIMIT_DETAIL) throw new HttpError(429, "That's a lot of invites this hour. Try again later.");
  return c.json(result);
});

/**
 * Invite many clients (the Clients list, Settings → Payments' cards from Stripe). One count of the
 * hourly limit per client actually sent; once it runs out, the rest are skipped. Clients invited in
 * the last week, or already on autopay, are skipped.
 */
autopay.post("/clients/autopay/invite", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const body = await readJson(c, z.object({ client_ids: z.array(uuid).min(1).max(200), channel }));
  const companyId = c.var.companyId;
  const admin = adminClient(c.env);
  const details: Array<{ client_id: string; detail: string }> = [];
  let sent = 0;
  let limited = false;
  for (const clientId of new Set(body.client_ids)) {
    if (limited) {
      details.push({ client_id: clientId, detail: INVITE_LIMIT_DETAIL });
      continue;
    }
    try {
      const result = await sendAutopayInvite(c.env, admin, {
        companyId, clientId, channel: body.channel, baseUrl: appUrl(c), createdBy: c.var.userId, skipIfRecentDays: 7,
        allowSend: () => allow(c.env, inviteKey(companyId), INVITES_PER_HOUR, 3600),
      });
      if (result.sent) sent++;
      limited = result.detail === INVITE_LIMIT_DETAIL;
      details.push({ client_id: clientId, detail: result.detail });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The invite wasn't sent.";
      // Nothing more would go: say so once.
      if (COMPANY_PROBLEMS.includes(message)) throw new HttpError(409, message);
      details.push({ client_id: clientId, detail: message });
    }
  }
  return c.json({ sent, skipped: details.length - sent, details });
});

/** Pause or resume a client's autopay; their agreement stays (autopay_pause). */
autopay.post("/clients/:id/autopay/pause", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const clientId = param(c, "id");
  const body = await readJson(c, z.object({ paused: z.boolean() }));
  await ownClient(c, clientId);
  const { error } = await c.var.db.rpc("autopay_pause", { p_client: clientId, p_paused: body.paused });
  if (error) throw dbError(error);
  return c.json({ ok: true });
});

/**
 * Take a client's card off: here, and in Stripe when Crewtavo saved it. When it's the card their
 * agreement names, autopay is turned off too (in the office's name).
 */
autopay.post("/clients/:id/autopay/remove-card", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const clientId = param(c, "id");
  const body = await readJson(c, z.object({ payment_method_id: uuid }));
  const companyId = c.var.companyId;
  const admin = adminClient(c.env);
  const method = must(
    await admin.from("client_payment_methods").select("id").eq("company_id", companyId).eq("client_id", clientId).eq("id", body.payment_method_id).maybeSingle(),
    "Card not found.",
  );
  const { data: agreement } = await admin.from("autopay_authorizations").select("id, payment_method_id").eq("company_id", companyId).eq("client_id", clientId).is("revoked_at", null).maybeSingle();
  await detachPaymentMethod(c.env, admin, companyId, method.id, "office");
  if (agreement?.payment_method_id === method.id) {
    const { error } = await admin.rpc("autopay_revoke", { p_company: companyId, p_client: clientId, p_via: "office", p_by: c.var.userId });
    if (error) throw dbError(error);
  }
  return c.json({ ok: true });
});

/**
 * The owner vouches that these clients agreed some other way (they're charged by hand in Stripe
 * today): each gets an agreement in the owner's name with today's terms (autopay_vouch decides who).
 */
autopay.post("/clients/autopay/vouch", requireUser, requireCompany(["owner"], "invoices"), async (c) => {
  const body = await readJson(c, z.object({ client_ids: z.array(uuid).min(1).max(500), terms_version: z.string().min(1).max(40) }));
  const { data, error } = await c.var.db.rpc("autopay_vouch", { p_company: c.var.companyId, p_clients: [...new Set(body.client_ids)], p_terms_version: body.terms_version });
  if (error) throw dbError(error);
  return c.json({ recorded: data ?? 0 });
});

// ---------------------------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------------------------

/** The charge, if it's this company's (through the person's own client). */
async function ownCharge(c: Context<AppEnv>, chargeId: string) {
  return must(await c.var.db.from("autopay_charges").select("id").eq("company_id", c.var.companyId).eq("id", chargeId).maybeSingle(), "Charge not found.");
}

/** Approve charge: one over the limit goes ahead now, and the task is run for the company straight away. */
autopay.post("/autopay/charges/:id/approve", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const id = param(c, "id");
  await ownCharge(c, id);
  const { error } = await c.var.db.rpc("approve_autopay_charge", { p_charge: id });
  if (error) throw dbError(error);
  runInBackground(c, chargeDueAutopay(c.env, adminClient(c.env), { companyId: c.var.companyId }));
  return c.json({ ok: true });
});

/** Call it off: the invoice is left for the office to send the usual way (or as it is). */
autopay.post("/autopay/charges/:id/call-off", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const id = param(c, "id");
  await ownCharge(c, id);
  const { error } = await c.var.db.rpc("call_off_autopay_charge", { p_charge: id });
  if (error) throw dbError(error);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Charge card
// ---------------------------------------------------------------------------------------------

/** Charge card presses a company can make in an hour, one invoice or 50 at a time. */
const CHARGES_PER_HOUR = 300;

/**
 * Charge card: charge unpaid invoices to each client's saved card now, from the invoice or the
 * Invoices list. Each comes with the amount the office confirmed (dollars, as the screen showed it).
 * request_manual_charges queues each for that amount and says what it did with it ({ invoice_id,
 * outcome, reason }; 'changed' when what's owed isn't that amount now); the task then runs for the
 * company straight away, as Approve charge does, and charges them the way it charges autopay's own.
 */
autopay.post("/invoices/charge", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const companyId = c.var.companyId;
  if (!(await allow(c.env, `manual-charge:${companyId}`, CHARGES_PER_HOUR, 3600))) throw new HttpError(429, "That's a lot of charges this hour. Try again later.");
  const body = await readJson(c, z.object({ invoices: z.array(z.object({ id: uuid, amount: z.number().positive() })).min(1).max(50) }));
  // An invoice sent twice counts once, with its first amount (the database does the same).
  const { data, error } = await c.var.db.rpc("request_manual_charges", { p_company: companyId, p_invoices: body.invoices.map((i) => i.id), p_amounts: body.invoices.map((i) => i.amount) });
  if (error) throw dbError(error);
  const results = data ?? [];
  if (results.some((r) => r.outcome === "queued")) runInBackground(c, chargeDueAutopay(c.env, adminClient(c.env), { companyId }));
  return c.json({ results });
});

/**
 * The Invoices list's Charge card: owed invoices whose client has a card they agreed to, newest
 * first, with what's collecting each already (live_status and live_detail, or null).
 */
autopay.get("/invoices/chargeable", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const { data, error } = await c.var.db.rpc("chargeable_invoices", { p_company: c.var.companyId });
  if (error) throw dbError(error);
  return c.json({ invoices: data ?? [] });
});

/**
 * The invoice page's Charge card button: the card it would charge, or null when there's nothing to
 * press (autopay off, nothing owed, no card the client agreed to, or a charge already under way,
 * which the page shows from its autopay charges).
 */
autopay.get("/invoices/:id/charge", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const { data, error } = await c.var.db.rpc("chargeable_invoices", { p_company: c.var.companyId, p_invoice: param(c, "id") });
  if (error) throw dbError(error);
  const row = data?.[0];
  return c.json({ manual: row && !row.in_progress ? { card: row.card } : null });
});

// ---------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------

const OWED = ["sent", "partially_paid", "overdue"];

/**
 * Refund a Stripe payment, all or part, from the invoice page. It's booked at once (a negative
 * payment, as Stripe's charge.refunded books it), so the invoice is owed again by what went back of
 * its own money. With `write_off` (the dialog's "Take it off the invoice too") that balance is
 * written off, through the person's own client so the usual write-off rules apply, but only when
 * all that's owed now came from this refund: other money still owed is still asked for. Then
 * `still_owed` says how much (dollars, the refunded part with it), so the dialog can say the box
 * didn't take it off; it's 0 otherwise.
 */
autopay.post("/payments/:id/refund", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const id = param(c, "id");
  const companyId = c.var.companyId;
  if (!(await allow(c.env, `refund:${companyId}`, 30, 3600))) throw new HttpError(429, "That's a lot of refunds this hour. Try again later.");
  const body = await readJson(c, z.object({ amount: z.number().positive().max(100_000), write_off: z.boolean().default(true) }));
  const admin = adminClient(c.env);
  const payment = must(await admin.from("payments").select("id, invoice_id, amount, processor_ref").eq("company_id", companyId).eq("id", id).maybeSingle(), "Payment not found.");

  // A refund comes off the invoice's part of the payment first, then the tip (integrations/stripe.ts
  // refunded): what's left of the invoice's part is what this refund can put back on the invoice.
  let invoiceLeft = cents(payment.amount);
  if (payment.processor_ref) {
    const { data: back } = await admin.from("payments").select("amount, processor_ref").eq("company_id", companyId).like("processor_ref", `${payment.processor_ref}:%`);
    for (const row of back ?? []) {
      if (row.processor_ref?.startsWith(`${payment.processor_ref}:refund:`) || row.processor_ref?.startsWith(`${payment.processor_ref}:dispute:`)) invoiceLeft += cents(row.amount);
    }
  }

  const result = await refundStripePayment(c.env, admin, companyId, id, Math.round(body.amount * 100));
  const fromInvoice = Math.min(result.refunded_cents, Math.max(0, invoiceLeft));
  let writtenOff = false;
  let stillOwed = 0;
  if (body.write_off && result.recorded && payment.invoice_id && fromInvoice > 0) {
    const { data: invoice } = await c.var.db.from("invoices").select("id, status, balance_due").eq("company_id", companyId).eq("id", payment.invoice_id).maybeSingle();
    const owed = cents(invoice?.balance_due);
    if (invoice && OWED.includes(invoice.status) && owed > 0 && owed <= fromInvoice) {
      const { error } = await c.var.db.from("invoices").update({ status: "written_off" }).eq("company_id", companyId).eq("id", invoice.id);
      // The money went back either way; the office can still write it off from the invoice menu.
      if (error) console.error("Couldn't write off the refunded balance", error.message);
      writtenOff = !error;
    } else if (invoice && OWED.includes(invoice.status) && owed > fromInvoice) {
      // Other money is still owed, so nothing was written off: the refunded part is asked for with it.
      stillOwed = owed;
    }
  }
  return c.json({ refunded: result.refunded_cents / 100, recorded: result.recorded, written_off: writtenOff, still_owed: stillOwed / 100 });
});
