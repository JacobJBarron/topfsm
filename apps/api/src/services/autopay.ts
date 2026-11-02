/**
 * Autopay (docs/autopay-plan.md): a client's saved card or bank account, charged on the server once
 * the work is done. The rules live in Postgres (supabase/migrations/20261031000100_autopay.sql: what
 * is queued, when it falls due, what may be charged without asking) and Stripe is spoken to in
 * integrations/stripe.ts. Here:
 *   - the 5-minute task that charges what's due (chargeDueAutopay), holding each row with a claim
 *     token, so two servers, or a run that overlaps the last, never charge one twice;
 *   - the emails the database queues in the outbox: the receipt, the notice of a failed charge and
 *     the client's copy of what they agreed to (runAutopayJob). They never go from the task itself;
 *   - invites to set it up (sendAutopayInvite), for the office and for automations;
 *   - the Client Hub's autopay facts and steps: setting up, agreeing, turning it off, and a tip on
 *     the saved card after an automatic charge;
 *   - what Settings → Payments shows (autopayStatus).
 * Uses the admin client, and every lookup filters by company. Crews never reach any of it.
 */
import { autopaySettings, autopayTimingText, methodExpiry, methodLabel, tipsAllowed, type AutopaySettings } from "@crewtavo/core/autopay";
import { isPlaceholderEmail } from "@crewtavo/core/email";
import type { Env } from "../env";
import {
  autopayStripeCheck,
  chargeInvoiceAutomatically,
  chargeTip,
  detachPaymentMethod,
  finishStripeSetup,
  hubPayment,
  stripeAccess,
  stripeCapabilities,
  stripeSetupSession,
  type SavedMethod,
  type SetupOutcome,
} from "../integrations/stripe";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { HttpError } from "../lib/http";
import { clientLinks } from "../lib/links";
import { reportError } from "../lib/monitoring";
import { emailReady, sendEmail, sendSms, smsConfigured } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { companyAddress } from "./automations";
import { logoImage } from "./logo";
import { stripeApi } from "./stripe";

// ---------------------------------------------------------------------------------------------
// Shapes other parts of the server and the web read
// ---------------------------------------------------------------------------------------------

/** The client home's autopay card and view (GET /hub/:token, kind client). */
export interface HubAutopay {
  /**
   * off: no agreement in force, and no card to agree to (or the client or office turned it off,
   *      which takes a fresh Stripe setup to undo). agree: a card saved since waits for the tick
   *      (on a link that isn't the client's own, only one saved through a link like it: confirmable).
   * active: an agreement in force and its card active. paused: the office paused it. pending: its
   * bank account is being verified. needs_update: its card can't be charged (declined twice,
   * bounced, removed in Stripe, expired).
   */
  status: "off" | "agree" | "active" | "paused" | "pending" | "needs_update";
  /** The agreement's card when there's one in force, else the newest one saved that's usable. */
  method: { id: string; type: string; label: string; exp: string | null } | null;
  /** The card came from Stripe, so confirming is one tap (only on the client's own link). */
  imported: boolean;
  /** When the agreement in force was made. */
  since: string | null;
  /** The words the client agrees to; the page shows `timing` under them, as the agreement keeps them. */
  terms: string;
  terms_version: string;
  /** "at the end of the day of each visit" (core autopayTimingText). */
  timing: string;
  /** When the charge waiting for the next finished visit goes. */
  next_charge: string | null;
  /** The price of a visit on the client's one recurring job that autopay charges, if just one. */
  per_visit: number | null;
  /** Tax goes on top of per_visit: a line is taxable and the rate the invoice uses is above 0. */
  per_visit_taxed: boolean;
  /**
   * False while the business can't take autopay (off in Settings, or its key can't charge cards):
   * only then for a client with an agreement in force, so they can still see it and turn it off.
   */
  available: boolean;
}

/** An invoice page's autopay facts (GET /hub/:token, kind invoice). */
export interface HubInvoiceAutopay {
  status: "charging" | "processing" | "paid" | "failed" | "needs_client";
  /** "Visa ending 4242". */
  method: string | null;
  charged_at: string | null;
}

/** GET /autopay/status for Settings → Payments and the screens that hide autopay when it's off. */
export interface AutopayStatus {
  connected: boolean;
  own: boolean;
  livemode: boolean;
  /** The company's own key, and one that can save and charge cards. */
  can_autopay: boolean;
  can_refund: boolean;
  webhook_current: boolean;
  /** core autopaySettings: the starter terms filled in for a company that never saved them. */
  settings: AutopaySettings;
  /** settings.hub_tips, the one switch for tips (Settings → Company). */
  tips: boolean;
  /** Clients with a card brought in from Stripe and no agreement yet. */
  stripe_cards: number;
}

/** What one run of the task did, by how each charge ended up. */
export type AutopayTaskResult = {
  claimed: number;
  charged: number;
  processing: number;
  needs_approval: number;
  called_off: number;
  failed: number;
  needs_client: number;
  busy: number;
  retry: number;
  lost: number;
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Where links in emails start, or "" when the server doesn't know (no links go out then). */
const appBase = (env: Env) => (env.APP_URL ?? "").replace(/\/$/, "");

/** "$45.00" in the company's currency. */
const money = (amount: number | string, currency: string | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(Number(amount));

/** "Oct 31" where the company is. */
const monthDay = (at: string, timeZone: string | null | undefined) =>
  new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timeZone || "UTC" });

/** Postgres raises its messages without a full stop; the Hub shows them as sentences. */
const sentence = (message: string) => (/[.?]$/.test(message) ? message : `${message}.`);

/** Stripe's reason, to sit inside one of our sentences ("Your card was declined"). */
const clause = (message: string | null | undefined) => (message ?? "").trim().replace(/[.\s]+$/, "");

/** An address we can really write to (not a sub's stand-in address). */
const reachable = (email: string | null | undefined): email is string => isEmail(email) && !isPlaceholderEmail(email);

/** Cards and Link settle at once, so a tip can go on them after the fact; a bank account can't. */
const TIPPABLE = ["card", "link"];

const METHOD_FIELDS = "id, client_id, type, brand, last4, bank_name, wallet, exp_month, exp_year, status, is_default, source, saved_via, created_at, stripe_payment_method_id, stripe_customer_id, livemode, stripe_account";
type Method = {
  id: string;
  client_id: string;
  type: string;
  brand: string | null;
  last4: string | null;
  bank_name: string | null;
  wallet: string | null;
  exp_month: number | null;
  exp_year: number | null;
  status: string;
  is_default: boolean;
  source: string;
  /** Which kind of Hub link it was saved through on Stripe's page: "client", "office" (the office's copy) or "legacy" (one from before the mark). */
  saved_via: string;
  created_at: string;
  stripe_payment_method_id: string;
  stripe_customer_id: string;
  livemode: boolean;
  stripe_account: string | null;
};

/** A saved method as the Stripe calls take it. */
const savedMethod = (m: Method): SavedMethod => ({
  id: m.id, stripe_payment_method_id: m.stripe_payment_method_id, stripe_customer_id: m.stripe_customer_id, livemode: m.livemode, stripe_account: m.stripe_account, type: m.type,
});

const COMPANY_FIELDS = "id, name, email, phone, address, currency, timezone, trade_preset, settings";
type Company = { id: string; name: string; email: string | null; phone: string | null; address: unknown; currency: string; timezone: string; trade_preset: string; settings: unknown };

async function companyOf(admin: Db, companyId: string): Promise<Company | null> {
  const { data, error } = await admin.from("companies").select(COMPANY_FIELDS).eq("id", companyId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Company | null;
}

/** settings.hub_tips, whatever else the settings hold. */
const hubTipsOf = (settings: unknown) => (settings && typeof settings === "object" ? (settings as { hub_tips?: unknown }).hub_tips : undefined);

/**
 * The client's agreement in force, if any (at most one isn't turned off). Paused still counts here:
 * it's kept, and the office turns it back on.
 */
async function agreementOf(admin: Db, companyId: string, clientId: string) {
  const { data, error } = await admin
    .from("autopay_authorizations")
    .select("id, payment_method_id, accepted_at, paused_at")
    .eq("company_id", companyId)
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * When the client or the office last turned autopay off, from the newest agreement: only a card
 * saved after that brings it back (an old link can't switch it on again with the card that was on
 * file; autopay_record_authorization).
 */
const turnedOffAt = (last: { revoked_at: string | null; revoked_via: string | null } | undefined) =>
  last && (last.revoked_via === "client" || last.revoked_via === "office") ? last.revoked_at : null;

/**
 * The card to charge a client now, or null: private.autopay_ready's rule, for code that runs as the
 * service role and can't call it (private isn't exposed). Autopay on in Settings, an agreement in
 * force that isn't paused, and the card it names saved for this client and active.
 */
async function readyMethod(admin: Db, companyId: string, clientId: string, settings: unknown): Promise<Method | null> {
  if (!autopaySettings(settings).enabled) return null;
  const agreement = await agreementOf(admin, companyId, clientId);
  if (!agreement?.payment_method_id || agreement.paused_at) return null;
  const { data } = await admin.from("client_payment_methods").select(METHOD_FIELDS).eq("company_id", companyId).eq("id", agreement.payment_method_id).maybeSingle();
  const method = data as Method | null;
  return method && method.client_id === clientId && method.status === "active" ? method : null;
}

/** Has a message with this key gone already? The receipts, notices and copies are sent once. */
async function alreadySent(admin: Db, companyId: string, key: string): Promise<boolean> {
  const { data, error } = await admin.from("messages").select("id").eq("company_id", companyId).eq("external_id", key).limit(1);
  if (error) throw new Error(error.message);
  return Boolean(data?.length);
}

/** The client's timeline gets what was sent. A failure here is logged: the email went, so it isn't sent again. */
async function logMessage(admin: Db, row: { company_id: string; client_id: string; channel: string; subject: string | null; body: string; related_type: string; related_id: string; external_id: string | null; sent_by?: string | null }) {
  const { error } = await admin.from("messages").insert({ ...row, direction: "out", status: "sent", sent_by: row.sent_by ?? null });
  if (error) {
    console.error("Couldn't log an autopay message", error.message);
    reportError(new Error(`Couldn't log an autopay message: ${error.message}`), { feature: "autopay" });
  }
}

/**
 * An email from the company to its client, the way the rest of the server sends them: its logo
 * (loaded from `base`, the app's address), address and reply-to. `button` labels its link buttons.
 */
function emailFrom(env: Env, company: Company, to: string, subject: string, text: string, base = appBase(env), button?: string) {
  const footer = [company.name, companyAddress(company.address as Record<string, string>), company.phone].filter(Boolean).join(" · ");
  return sendEmail(
    env,
    { to, subject, ...renderEmail({ companyName: company.name, logo: base ? logoImage(base, company.id, company.settings) : null, text, footer, button }), replyTo: company.email ?? undefined, fromName: company.name },
    company.id,
  );
}

/** Which of a pair of links (clientLinks): the client's own, for what goes out, or the office's copy, for the timeline. */
type Who = "own" | "office";

/**
 * A fresh link to the client's autopay page (120 days, as client links last), as a pair
 * (clientLinks): their own for the email or text, the office's copy for what's kept on the timeline.
 */
async function autopayLinks(env: Env, base: string, companyId: string, clientId: string): Promise<Record<Who, string>> {
  const links = await clientLinks(env, base, { c: companyId, t: "client", id: clientId }, 120);
  return { own: `${links.own}?view=autopay`, office: `${links.office}?view=autopay` };
}

/**
 * Who a Hub link counts as for saying yes to a card and tipping on one (routes/public.ts trustOf):
 * "client" for the client's own link, marked as theirs; "office" for the office's copies; "legacy"
 * for links minted before the mark (an old invoice email, a signed copy of a quote).
 */
type Trust = "client" | "office" | "legacy";

/**
 * Whether a link can say yes to this card. The client's own link can, for any card saved for them.
 * The others only for a card saved on Stripe's page through a link like it, which took the card in
 * hand: an office copy one saved through an office copy (saved_via "office"), an old link one saved
 * through an old link or an office copy. Never one brought in from Stripe, nor one the client saved
 * on another kind of link and left before agreeing to.
 */
const confirmable = (method: Pick<Method, "saved_via">, trust: Trust | undefined) =>
  trust === "office" ? method.saved_via === "office"
  : trust === "legacy" ? method.saved_via === "legacy" || method.saved_via === "office"
  : true;

// ---------------------------------------------------------------------------------------------
// The task: charge what's due
// ---------------------------------------------------------------------------------------------

/** A run stops taking new charges after this: the next run is due, and its claims run out at 5 minutes. */
const TASK_BUDGET_MS = 4 * 60_000;
const RETRY_MESSAGE = "Something went wrong charging it. Trying again in 10 minutes";
const STOPPED_MESSAGE = "Stopped after 5 tries. Check the invoice and Stripe";
const TOO_SMALL_MESSAGE = "Less than Stripe can charge. Send it the usual way";

/** A claimed row (claim_autopay_charges). `source` "manual" is the office's Charge card. */
type Claimed = { id: string; company_id: string; invoice_id: string | null; attempts: number; failures: number; claim_token: string | null; source?: string };
type Counted = Exclude<keyof AutopayTaskResult, "claimed">;
type Finish = "paid" | "processing" | "declined" | "bank_failed" | "needs_client" | "called_off" | "retry" | "busy";

/** What autopay_bill answers (see the migration). */
type Bill =
  | { outcome: "charge"; invoice_id: string; invoice_status: string; balance_due: number; method: SavedMethod }
  | { outcome: "paid" | "called_off" | "needs_approval" | "lost"; reason: string | null; invoice_id: string | null };

const BILLED: Record<Exclude<Bill["outcome"], "charge">, Counted> = { paid: "charged", called_off: "called_off", needs_approval: "needs_approval", lost: "lost" };

/** Say how a claimed charge went. False when this run no longer holds it (another took it over). */
async function finish(admin: Db, row: Claimed, outcome: Finish, extra: { error?: string | null; decline?: string | null; amount?: number | null } = {}): Promise<boolean> {
  const { data, error } = await admin.rpc("finish_autopay_charge", {
    p_id: row.id,
    p_outcome: outcome,
    p_token: row.claim_token ?? undefined,
    p_error: extra.error ? extra.error.slice(0, 1000) : undefined,
    p_decline: extra.decline ? extra.decline.slice(0, 100) : undefined,
    p_amount: extra.amount ?? undefined,
  });
  if (error) throw new Error(`finish_autopay_charge failed: ${error.message}`);
  return data === true;
}

/** One claimed charge, start to end. Returns what it counts as. */
async function chargeOne(env: Env, admin: Db, row: Claimed): Promise<Counted> {
  const held = (ok: boolean, counted: Counted): Counted => (ok ? counted : "lost");

  // Its sixth claim: something keeps going wrong. Ask Stripe first, so a charge that went through
  // before a crash is booked rather than stopped.
  if (row.attempts > 5) {
    const seen = row.invoice_id ? await autopayStripeCheck(env, admin, row.company_id, row.invoice_id, row.id) : "none";
    if (seen === "paid") return held(await finish(admin, row, "paid"), "charged");
    if (seen === "processing") return held(await finish(admin, row, "processing"), "processing");
    if (seen === "other") return held(await finish(admin, row, "called_off", { error: "Paid another way" }), "called_off");
    return held(await finish(admin, row, "called_off", { error: STOPPED_MESSAGE }), "called_off");
  }

  // Bill it (a draft invoice, made once), with every check made again on fresh data.
  const { data, error } = await admin.rpc("autopay_bill", { p_charge: row.id, p_token: row.claim_token! });
  if (error) throw new Error(`autopay_bill failed: ${error.message}`);
  const bill = data as unknown as Bill;
  if (bill.outcome !== "charge") return BILLED[bill.outcome] ?? "lost";

  // Charge it: the Stripe invoice is made while ours is a draft, ours is marked sent (no email),
  // then Stripe charges the saved card.
  const markSent = async (amountCents: number) => {
    const sent = await admin.rpc("autopay_mark_sent", { p_charge: row.id, p_token: row.claim_token!, p_amount_cents: amountCents });
    if (sent.error) throw new Error(`autopay_mark_sent failed: ${sent.error.message}`);
    return sent.data === true;
  };
  const result = await chargeInvoiceAutomatically(env, admin, row.company_id, { chargeId: row.id, attempt: row.attempts, invoiceId: bill.invoice_id, method: bill.method, markSent });
  switch (result.outcome) {
    case "paid":
      // 0 when credit the client had in Stripe paid it all: the card was charged nothing (the receipt
      // says so). chargeInvoiceAutomatically sent ours before booking that credit.
      return held(await finish(admin, row, "paid", { amount: result.amountCents / 100 }), "charged");
    case "processing":
      return held(await finish(admin, row, "processing", { amount: result.amountCents / 100 }), "processing");
    case "declined":
      // A second decline in a row pauses it until the client updates the card. One the office
      // pressed Charge card for isn't tried again: the client is asked at once.
      return held(await finish(admin, row, "declined", { error: result.message, decline: result.code }), row.source === "manual" || row.failures + 1 >= 2 ? "needs_client" : "failed");
    case "bank_failed":
      return held(await finish(admin, row, "bank_failed", { error: result.message, decline: result.code }), "needs_client");
    case "needs_client":
      return held(await finish(admin, row, "needs_client", { error: result.message, decline: result.code }), "needs_client");
    case "too_small":
      // Stripe can't charge it whatever the office says, so it isn't asked: it's sent the usual way.
      return held(await finish(admin, row, "called_off", { error: TOO_SMALL_MESSAGE }), "called_off");
    case "unusable":
      return held(await finish(admin, row, "called_off", { error: result.message }), "called_off");
    case "busy":
      return held(await finish(admin, row, "busy", { error: result.message }), "busy");
    case "retry":
      return held(await finish(admin, row, "retry", { error: result.message }), "retry");
    case "lost":
      return "lost";
  }
}

/** The 5-minute task: charge what's due. Safe to run twice and on two servers (claim tokens). */
export async function chargeDueAutopay(env: Env, admin: Db = adminClient(env), options: { limit?: number; companyId?: string } = {}): Promise<AutopayTaskResult> {
  const started = Date.now();
  const counts: AutopayTaskResult = { claimed: 0, charged: 0, processing: 0, needs_approval: 0, called_off: 0, failed: 0, needs_client: 0, busy: 0, retry: 0, lost: 0 };
  const { data, error } = await admin.rpc("claim_autopay_charges", { p_limit: options.limit ?? 25, p_company: options.companyId });
  if (error) throw new Error(`claim_autopay_charges failed: ${error.message}`);
  const rows = (data ?? []) as Claimed[];
  counts.claimed = rows.length;
  for (const [i, row] of rows.entries()) {
    // Out of time: the rest go back as they were, without using a try.
    if (Date.now() - started > TASK_BUDGET_MS) {
      await release(admin, rows.slice(i));
      break;
    }
    let counted: Counted;
    try {
      counted = await chargeOne(env, admin, row);
    } catch (thrown) {
      // A thrown error keeps the try it used, so the stop at the sixth claim always comes.
      console.error("Autopay charge failed", row.id, thrown);
      reportError(thrown, { task: "autopay", charge: row.id });
      counted = (await finish(admin, row, "retry", { error: RETRY_MESSAGE }).catch(() => false)) ? "retry" : "lost";
    }
    counts[counted]++;
  }
  return counts;
}

/** Claimed but never started: back as they were. One claim's rows share its token. */
async function release(admin: Db, rows: Claimed[]) {
  const byToken = new Map<string, string[]>();
  for (const row of rows) if (row.claim_token) byToken.set(row.claim_token, [...(byToken.get(row.claim_token) ?? []), row.id]);
  for (const [token, ids] of byToken) {
    const { error } = await admin.rpc("release_autopay_charges", { p_token: token, p_ids: ids });
    if (error) reportError(new Error(`release_autopay_charges failed: ${error.message}`), { task: "autopay" });
  }
}

// ---------------------------------------------------------------------------------------------
// The outbox: receipts, notices and the client's copy of their agreement
// ---------------------------------------------------------------------------------------------

/** Outbox jobs the autopay triggers queue: the receipt, the notice of a failed charge, and the client's copy of their agreement. */
export async function runAutopayJob(env: Env, admin: Db, row: { company_id: string; topic: string; payload: Record<string, unknown> }): Promise<void> {
  const p = row.payload ?? {};
  switch (row.topic) {
    case "autopay.receipt":
      await sendAutopayReceipt(env, admin, String(p.charge_id ?? ""));
      return;
    case "autopay.notice":
      await sendAutopayNotice(env, admin, String(p.charge_id ?? ""), p.status === "needs_client" ? "needs_client" : "failed", Number(p.failures ?? 0));
      return;
    case "autopay.agreed":
      await sendAutopayAgreed(env, admin, String(p.authorization_id ?? ""));
      return;
    default:
      throw new Error(`Unknown autopay job: ${row.topic}`);
  }
}

type ChargeRow = {
  id: string;
  company_id: string;
  client_id: string;
  job_id: string | null;
  invoice_id: string | null;
  payment_method_id: string | null;
  status: string;
  failures: number;
  due_at: string;
  last_error: string | null;
  decline_code: string | null;
  charged_amount: number | null;
  created_at: string;
};

/** A charge with what its emails say: the company (as it is now), the client, the invoice and the card. */
async function chargeFacts(admin: Db, chargeId: string) {
  const { data: charge, error } = await admin
    .from("autopay_charges")
    .select("id, company_id, client_id, job_id, invoice_id, payment_method_id, status, failures, due_at, last_error, decline_code, charged_amount, created_at")
    .eq("id", chargeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!charge) return null;
  const c = charge as ChargeRow;
  const [company, client, invoice, method, job] = await Promise.all([
    companyOf(admin, c.company_id),
    admin.from("clients").select("id, display_name, email, phone").eq("company_id", c.company_id).eq("id", c.client_id).maybeSingle(),
    c.invoice_id ? admin.from("invoices").select("id, number, total, balance_due, status").eq("company_id", c.company_id).eq("id", c.invoice_id).maybeSingle() : null,
    c.payment_method_id ? admin.from("client_payment_methods").select(METHOD_FIELDS).eq("company_id", c.company_id).eq("id", c.payment_method_id).maybeSingle() : null,
    c.job_id ? admin.from("jobs").select("title").eq("company_id", c.company_id).eq("id", c.job_id).maybeSingle() : null,
  ]);
  if (!company || !client.data) return null;
  return {
    charge: c,
    company,
    client: client.data,
    invoice: invoice?.data ?? null,
    method: (method?.data ?? null) as Method | null,
    jobTitle: job?.data?.title?.trim() || null,
  };
}

/**
 * The receipt after an automatic charge, by email, when the company sends them and the client has
 * an address. It carries a fresh link to the client's page (Hub links run out, and this way a
 * client on autopay always has one for changing their card or turning it off), and "Add a tip for
 * the crew?" only when tips are on (the one rule, core tipsAllowed) and the card can take one. The
 * copy on the timeline has the office's copies of those links, which can't tip on the card.
 */
export async function sendAutopayReceipt(env: Env, admin: Db, chargeId: string): Promise<string> {
  const facts = await chargeFacts(admin, chargeId);
  if (!facts) return "skipped: the charge isn't there";
  const { charge, company, client, invoice, method, jobTitle } = facts;
  if (charge.status !== "paid") return `skipped: the charge is ${charge.status}`;
  if (!invoice) return "skipped: the invoice isn't there";
  // The company's settings as they are now, not when the charge was queued.
  if (!autopaySettings(company.settings, company.trade_preset).receipts) return "skipped: receipts are off";
  if (!reachable(client.email)) return "skipped: no email address";
  const key = `autopay:receipt:${charge.id}`;
  if (await alreadySent(admin, company.id, key)) return "skipped: already sent";
  if (!(await emailReady(env, company.id))) return "skipped: email isn't set up";

  const { data: stripeRows, error } = await admin.from("stripe_invoices").select("origin, purpose, collection, status, amount_due").eq("company_id", company.id).eq("invoice_id", invoice.id);
  if (error) throw new Error(error.message);
  const rows = stripeRows ?? [];
  // What the card was charged, never what's owed now (nothing, by then). A charge finished without
  // an amount (the invoice trigger, or a try that went through before its worker stopped) is what
  // Stripe took on the card for the invoice since the charge was made: its Stripe payments, which
  // leave out any credit, and never one an earlier charge took before a refund.
  let amount: number | null = charge.charged_amount === null ? null : Number(charge.charged_amount);
  if (amount === null) {
    const { data: paid, error: paidError } = await admin.from("payments").select("amount").eq("company_id", company.id).eq("invoice_id", invoice.id).eq("processor", "stripe").gt("amount", 0).gte("created_at", charge.created_at);
    if (paidError) throw new Error(paidError.message);
    amount = (paid ?? []).reduce((sum, p) => sum + Number(p.amount), 0);
  }
  // Nothing on the card: credit the client had in Stripe paid it all, so there's no charge to tip on either.
  const fromCredit = amount === 0;
  const imported = rows.some((r) => r.origin === "stripe");
  const tipOffered = !fromCredit && tipsAllowed(hubTipsOf(company.settings), imported) && Boolean(method && TIPPABLE.includes(method.type)) && !rows.some((r) => r.purpose === "tip");

  const base = appBase(env);
  const card = method ? methodLabel(method) : null;
  const what = jobTitle ? `${jobTitle} (invoice #${invoice.number})` : `invoice #${invoice.number}`;
  const charged = amount !== null ? `We charged ${money(amount, company.currency)}${card ? ` to your ${card}` : ""}` : `We charged ${card ? `your ${card}` : "you"}`;
  const paid = fromCredit
    ? `Invoice #${invoice.number}${jobTitle ? ` for ${jobTitle}` : ""} was paid from your account credit, so nothing was charged${card ? ` to your ${card}` : ""}. Thank you.`
    : `${charged} for ${what}. Thank you.`;
  const tip = base && tipOffered ? await clientLinks(env, base, { c: company.id, t: "invoice", id: invoice.id }) : null;
  const home = base ? await autopayLinks(env, base, company.id, client.id) : null;
  // The same words with either set of links: the client's own to send, the office's to keep.
  const write = (who: Who) => {
    const parts = [`Hi ${firstName(client.display_name)},`, paid];
    if (tip) parts.push("Add a tip for the crew?", `${tip[who]}?tip=1`);
    if (home) parts.push("Change your card or turn off autopay any time:", home[who]);
    parts.push(`Thanks,\n${company.name}`);
    return parts.join("\n\n");
  };
  const subject = `Receipt for invoice #${invoice.number}`;

  const result = await emailFrom(env, company, client.email.trim(), subject, write("own"));
  if (!result.sent) throw new Error(result.reason ?? "The receipt wasn't sent.");
  await logMessage(admin, { company_id: company.id, client_id: client.id, channel: "email", subject, body: write("office"), related_type: "invoice", related_id: invoice.id, external_id: key });
  return "sent";
}

/** Decline codes that mean the bank wants the client there to confirm (3D Secure), not that the card failed. */
const CONFIRM_CODES = ["authentication_required", "invoice_payment_intent_requires_action", "requires_action", "card_action_required"];

/**
 * A charge that didn't go through, told to the client: by email, else a text when there's a number
 * and texting is set up, else nobody (the office was told anyway). The invoice is owed as usual, so
 * it carries the Pay link and a way to update the card: the client's own links in what goes out,
 * the office's copies in what's kept on the timeline.
 */
export async function sendAutopayNotice(env: Env, admin: Db, chargeId: string, status: "failed" | "needs_client", failures: number): Promise<string> {
  const facts = await chargeFacts(admin, chargeId);
  if (!facts) return "skipped: the charge isn't there";
  const { charge, company, client, invoice, method } = facts;
  if (!invoice) return "skipped: the invoice isn't there";
  // Paid another way, called off or voided before this went: there's nothing to ask for.
  if (["paid", "called_off"].includes(charge.status) || Number(invoice.balance_due) <= 0 || !["sent", "partially_paid", "overdue"].includes(invoice.status)) {
    return "skipped: nothing is owed on it now";
  }
  // The card is in the key: agreeing to another card starts the count again (failures back to 0).
  const key = `autopay:notice:${charge.id}:${charge.payment_method_id}:${status}:${failures}`;
  if (await alreadySent(admin, company.id, key)) return "skipped: already sent";

  const base = appBase(env);
  const card = method ? `your ${methodLabel(method)}` : "your card";
  const owed = money(invoice.balance_due, company.currency);
  const n = invoice.number;
  const reason = clause(charge.last_error);
  const bank = method?.type === "us_bank_account";
  // The bank wants the client there (3D Secure): no decline, so nothing about the card is wrong.
  const confirm = status === "needs_client" && !bank && failures < 2 && (!charge.decline_code || CONFIRM_CODES.includes(charge.decline_code));
  const said = reason ? ` Your bank said: ${reason}.` : "";
  const invoiceLink = base ? await clientLinks(env, base, { c: company.id, t: "invoice", id: invoice.id }) : null;

  // What happened (`lead`, and `brief` for a text), then what to do: open the invoice to pay or
  // confirm it, or, without the app's address for links, get in touch.
  let subject = `We couldn't charge your card for invoice #${n}`;
  let lead: string;
  let brief: string;
  let ask = "You can pay it now, or update your card:";
  let askBrief = "Pay it or update your card:";
  if (confirm) {
    subject = `Please confirm your payment for invoice #${n}`;
    lead = brief = `Your bank asks you to confirm the payment of ${owed} for invoice #${n}.`;
    ask = "Open the invoice to confirm it:";
    askBrief = "Confirm it here:";
  } else if (bank) {
    subject = `Your bank payment for invoice #${n} didn't go through`;
    lead = `The bank payment of ${owed} for invoice #${n} from ${card} didn't go through, so autopay is paused until you update it.${said}`;
    brief = `The bank payment of ${owed} for invoice #${n} didn't go through, so autopay is paused.`;
    ask = "You can pay it now, or update how you pay:";
    askBrief = "Pay it or update how you pay:";
  } else if (status === "needs_client" && failures >= 2) {
    lead = `We couldn't charge ${card} for invoice #${n} (${owed}) again, so autopay is paused until you update your card.${said}`;
    brief = `We couldn't charge ${card} for invoice #${n} (${owed}) again, so autopay is paused.`;
  } else if (status === "failed") {
    const again = ` We'll try again on ${monthDay(charge.due_at, company.timezone)}.`;
    lead = `We couldn't charge ${card} for invoice #${n} (${owed}).${said}${again}`;
    brief = `We couldn't charge ${card} for invoice #${n} (${owed}).${again}`;
  } else {
    lead = `We couldn't charge ${card} for invoice #${n} (${owed})${reason ? `: ${reason}` : ""}.`;
    brief = `We couldn't charge ${card} for invoice #${n} (${owed}).`;
  }
  if (!invoiceLink) ask = askBrief = "Contact us to pay it.";
  const message = `${lead} ${ask}`;
  const short = `${brief} ${askBrief}`;

  if (reachable(client.email) && (await emailReady(env, company.id))) {
    const home = base && !confirm ? await autopayLinks(env, base, company.id, client.id) : null;
    // The same words with either set of links: the client's own to send, the office's to keep.
    const write = (who: Who) => {
      const parts = [`Hi ${firstName(client.display_name)},`, message];
      if (invoiceLink) parts.push(invoiceLink[who]);
      if (home) parts.push(home[who]);
      parts.push(`Thanks,\n${company.name}`);
      return parts.join("\n\n");
    };
    const result = await emailFrom(env, company, client.email.trim(), subject, write("own"));
    if (!result.sent) throw new Error(result.reason ?? "The notice wasn't sent.");
    await logMessage(admin, { company_id: company.id, client_id: client.id, channel: "email", subject, body: write("office"), related_type: "invoice", related_id: invoice.id, external_id: key });
    return "sent";
  }
  if (client.phone && smsConfigured(env)) {
    const body = (who: Who) => `${company.name}: ${short}${invoiceLink ? ` ${invoiceLink[who]}` : ""}`;
    const result = await sendSms(env, { to: client.phone, body: body("own") });
    if (!result.sent) throw new Error(result.reason ?? "The notice wasn't sent.");
    await logMessage(admin, { company_id: company.id, client_id: client.id, channel: "sms", subject: null, body: body("office"), related_type: "invoice", related_id: invoice.id, external_id: key });
    return "sent";
  }
  return "skipped: no way to reach them";
}

/**
 * The client's copy of what they agreed to, right after they agreed (from their page, or by
 * confirming a card brought in from Stripe): the card, when it's charged, the words in full, and a
 * link to turn it off. A link the office copied can agree for them (to a card saved through it), so
 * this is how they'd find out. The copy on the timeline has the office's copy of the link.
 */
export async function sendAutopayAgreed(env: Env, admin: Db, authorizationId: string): Promise<string> {
  const { data: agreement, error } = await admin
    .from("autopay_authorizations")
    .select("id, company_id, client_id, payment_method_id, terms, accepted_at, source")
    .eq("id", authorizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!agreement) return "skipped: the agreement isn't there";
  // The owner's "These clients agreed" is the business's own record, not something the client did here.
  if (agreement.source === "owner") return "skipped: recorded by the owner";
  const key = `autopay:agreed:${agreement.id}`;
  if (await alreadySent(admin, agreement.company_id, key)) return "skipped: already sent";
  const [company, client, method] = await Promise.all([
    companyOf(admin, agreement.company_id),
    admin.from("clients").select("id, display_name, email, phone").eq("company_id", agreement.company_id).eq("id", agreement.client_id).maybeSingle(),
    agreement.payment_method_id ? admin.from("client_payment_methods").select(METHOD_FIELDS).eq("company_id", agreement.company_id).eq("id", agreement.payment_method_id).maybeSingle() : null,
  ]);
  if (!company || !client.data) return "skipped: the client isn't there";
  const who = client.data;

  const base = appBase(env);
  const timing = autopayTimingText(autopaySettings(company.settings, company.trade_preset));
  const card = method?.data ? `your ${methodLabel(method.data as Method)}` : "your saved card";
  const intro = `You set up autopay with ${company.name} on ${monthDay(agreement.accepted_at, company.timezone)}. We'll charge ${card} ${timing}.`;
  const links = base ? await autopayLinks(env, base, company.id, who.id) : null;
  const subject = `Autopay is set up with ${company.name}`;

  if (reachable(who.email) && (await emailReady(env, company.id))) {
    // The same words with either link: the client's own to send, the office's to keep.
    const write = (link: Who) => {
      const parts = [`Hi ${firstName(who.display_name)},`, intro, "What you agreed to:", agreement.terms];
      parts.push(links ? "Not you, or changed your mind? Turn it off here:" : "Not you, or changed your mind? Contact us to turn it off.");
      if (links) parts.push(links[link]);
      parts.push(`Thanks,\n${company.name}`);
      return parts.join("\n\n");
    };
    const result = await emailFrom(env, company, who.email.trim(), subject, write("own"));
    if (!result.sent) throw new Error(result.reason ?? "The copy of the agreement wasn't sent.");
    await logMessage(admin, { company_id: company.id, client_id: who.id, channel: "email", subject, body: write("office"), related_type: "autopay", related_id: who.id, external_id: key });
    return "sent";
  }
  if (who.phone && smsConfigured(env)) {
    const body = (link: Who) => `${company.name}: ${intro} Not you, or changed your mind? ${links ? `Turn it off here: ${links[link]}` : "Contact us to turn it off."}`;
    const result = await sendSms(env, { to: who.phone, body: body("own") });
    if (!result.sent) throw new Error(result.reason ?? "The copy of the agreement wasn't sent.");
    await logMessage(admin, { company_id: company.id, client_id: who.id, channel: "sms", subject: null, body: body("office"), related_type: "autopay", related_id: who.id, external_id: key });
    return "sent";
  }
  return "skipped: no way to reach them";
}

// ---------------------------------------------------------------------------------------------
// Whether the company takes autopay, and invites
// ---------------------------------------------------------------------------------------------

/** The company takes autopay now: on in Settings, its own Stripe key, and the key can save cards. */
export async function autopayAvailable(env: Env, admin: Db, companyId: string): Promise<boolean> {
  // Stored state only, never Stripe: this runs on every Client Hub view.
  const { data } = await admin.from("companies").select("settings->autopay").eq("id", companyId).maybeSingle();
  if (!autopaySettings({ autopay: (data as { autopay?: unknown } | null)?.autopay }).enabled) return false;
  const caps = await stripeCapabilities(env, admin, companyId, { cached: true });
  return caps.own && caps.autopay;
}

/**
 * What an invite says, by email and by text, around `link` (sendAutopayInvite, and the automations
 * preview with "[autopay link]"). With `card` (one brought in from Stripe, "Visa ending 4242") it
 * asks the client to confirm it; otherwise to save one. A lawn company says it's for their lawn
 * care, and the receipts line goes in only while the company sends receipts.
 */
export function autopayInviteText(
  company: { name: string; trade_preset: string | null; settings: unknown },
  first: string,
  link: string,
  card: string | null = null,
): { email: string; sms: string } {
  const receipts = autopaySettings(company.settings, company.trade_preset).receipts;
  if (card) {
    const ask = `We have your ${card} on file. Tap below to confirm we can charge it after each visit:`;
    return {
      email: [`Hi ${first},`, ask, link, ...(receipts ? ["You'll get a receipt after every visit."] : []), `Thanks,\n${company.name}`].join("\n\n"),
      sms: `${company.name}: ${ask} ${link}`,
    };
  }
  const lead = company.trade_preset === "lawn_exterior"
    ? "For your lawn care, we keep a card on file and charge it after each visit, so there's nothing to pay each time."
    : "We keep a card on file and charge it after each visit, so there's nothing to pay each time.";
  return {
    email: [
      `Hi ${first},`,
      `Thanks for choosing ${company.name}. ${lead} Save yours securely with Stripe here (takes a minute):`,
      link,
      `${receipts ? "You'll get a receipt after every visit. " : ""}You can update your card or turn it off anytime.`,
      `Thanks,\n${company.name}`,
    ].join("\n\n"),
    sms: `${company.name}: thanks for choosing us. We keep a card on file and charge it after each visit. Save yours securely with Stripe: ${link}`,
  };
}

/** What an invite says when the hourly limit stops it (the bulk route stops there). */
export const INVITE_LIMIT_DETAIL = "Skipped: too many invites this hour";

/**
 * Send one client the link to set up (or confirm) autopay. A client with a card brought in from
 * Stripe and no agreement is asked to confirm that card; anyone else to set it up. What's kept on
 * their timeline has the office's copy of the link (clientLinks), which opens their page but can't
 * confirm that card for them. `allowSend` (the bulk invite's hourly limit) is asked only once a
 * message is about to go.
 */
export async function sendAutopayInvite(
  env: Env,
  admin: Db,
  input: {
    companyId: string;
    clientId: string;
    channel: "email" | "sms";
    baseUrl: string | null;
    createdBy: string | null;
    skipIfRecentDays?: number;
    allowSend?: () => Promise<boolean>;
  },
): Promise<{ sent: boolean; detail: string }> {
  const { data: client } = await admin.from("clients").select("id, display_name, email, phone").eq("company_id", input.companyId).eq("id", input.clientId).maybeSingle();
  if (!client) return { sent: false, detail: "Client not found." };
  const company = await companyOf(admin, input.companyId);
  if (!company) return { sent: false, detail: "Client not found." };
  if (!autopaySettings(company.settings, company.trade_preset).enabled) throw new Error("Turn on autopay in Settings → Payments first.");
  const caps = await stripeCapabilities(env, admin, input.companyId, { cached: true });
  if (!caps.own || !caps.autopay) throw new Error("Update your Stripe key on the Apps page.");
  const base = (input.baseUrl ?? "").replace(/\/$/, "");
  if (!base) throw new Error("Set APP_URL so links can go out.");

  if (await agreementOf(admin, input.companyId, client.id)) return { sent: false, detail: "Skipped: already on autopay" };
  if (input.skipIfRecentDays) {
    const since = new Date(Date.now() - input.skipIfRecentDays * 86_400_000).toISOString();
    const { data: recent } = await admin
      .from("messages")
      .select("external_id")
      .eq("company_id", input.companyId)
      .eq("client_id", client.id)
      .eq("related_type", "autopay")
      .eq("direction", "out")
      .gte("created_at", since);
    // The copy of an agreement isn't an invite.
    if ((recent ?? []).some((m) => !m.external_id?.startsWith("autopay:agreed:"))) return { sent: false, detail: `Skipped: invited in the last ${input.skipIfRecentDays} days` };
  }
  if (input.channel === "email" && !reachable(client.email)) throw new Error("This client has no email address.");
  if (input.channel === "sms" && !client.phone) throw new Error("This client has no mobile number.");
  if (input.channel === "sms" && !smsConfigured(env)) throw new Error("Texting isn't set up.");

  // A card brought in from Stripe that they haven't agreed to: one tap confirms it. Not one saved
  // before they or the office last turned autopay off, which their page won't offer (turnedOffAt).
  const { data: last } = await admin
    .from("autopay_authorizations")
    .select("revoked_at, revoked_via")
    .eq("company_id", input.companyId)
    .eq("client_id", client.id)
    .order("accepted_at", { ascending: false })
    .limit(1);
  const after = turnedOffAt(last?.[0]);
  let cards = admin
    .from("client_payment_methods")
    .select(METHOD_FIELDS)
    .eq("company_id", input.companyId)
    .eq("client_id", client.id)
    .eq("source", "stripe_import")
    .eq("status", "active");
  if (after) cards = cards.gt("created_at", after);
  const { data: imported } = await cards.order("is_default", { ascending: false }).order("created_at", { ascending: false }).limit(1);
  const card = (imported?.[0] ?? null) as Method | null;
  const subject = card ? `Confirm autopay with ${company.name}` : `Set up autopay with ${company.name}`;
  if (input.allowSend && !(await input.allowSend())) return { sent: false, detail: INVITE_LIMIT_DETAIL };

  const links = await autopayLinks(env, base, input.companyId, client.id);
  const words = (url: string) => autopayInviteText(company, firstName(client.display_name), url, card ? methodLabel(card) : null);
  const text = (url: string) => words(url).email;
  const sms = (url: string) => words(url).sms;
  // The button says what tapping it does here; receipts and notices keep "Manage autopay".
  const button = card ? "Confirm autopay" : "Save your card";
  const result = input.channel === "email" ? await emailFrom(env, company, client.email!.trim(), subject, text(links.own), base, button) : await sendSms(env, { to: client.phone!, body: sms(links.own) });
  if (!result.sent) throw new Error(result.reason ?? "The invite wasn't sent.");
  await logMessage(admin, {
    company_id: input.companyId,
    client_id: client.id,
    channel: input.channel,
    subject: input.channel === "email" ? subject : null,
    // Whoever reads the timeline can open their page from it, but not as the client.
    body: input.channel === "email" ? text(links.office) : sms(links.office),
    related_type: "autopay",
    related_id: client.id,
    external_id: result.id ?? null,
    sent_by: input.createdBy,
  });
  return { sent: true, detail: input.channel === "email" ? "Sent by email." : "Sent by text." };
}

// ---------------------------------------------------------------------------------------------
// The Client Hub
// ---------------------------------------------------------------------------------------------
// hubAutopay, hubInvoiceAutopay and autopayOffered run on every Hub view, so they read stored state
// only and use only the plain filters (apps/api/test/hub.test.ts runs them against its stand-in).

/** The newest first, by a timestamp column. */
const newest = <T>(rows: T[], key: keyof T) => [...rows].sort((a, b) => String(b[key] ?? "").localeCompare(String(a[key] ?? "")));

const methodView = (m: Method) => ({ id: m.id, type: m.type, label: methodLabel(m), exp: methodExpiry(m) });

/**
 * The client home's autopay card and view (GET /hub/:token, kind client). Null when the company
 * doesn't take autopay, except for a client with an agreement in force: their terms say they can
 * turn it off from their page, so it shows (available false) while the business can't take it.
 */
export async function hubAutopay(env: Env, admin: Db, companyId: string, clientId: string, options: { trust?: Trust } = {}): Promise<HubAutopay | null> {
  const available = await autopayAvailable(env, admin, companyId);
  if (!available && !(await agreementOf(admin, companyId, clientId))) return null;
  const [company, agreements, methods, charges, jobs] = await Promise.all([
    admin.from("companies").select("trade_preset, settings->autopay, settings->default_tax_rate").eq("id", companyId).maybeSingle(),
    admin.from("autopay_authorizations").select("id, payment_method_id, accepted_at, paused_at, revoked_at, revoked_via").eq("company_id", companyId).eq("client_id", clientId),
    admin.from("client_payment_methods").select(METHOD_FIELDS).eq("company_id", companyId).eq("client_id", clientId),
    admin.from("autopay_charges").select("due_at").eq("company_id", companyId).eq("client_id", clientId).eq("status", "waiting"),
    admin.from("jobs").select("id, autopay, quote_id").eq("company_id", companyId).eq("client_id", clientId).eq("kind", "recurring").eq("billing_mode", "per_visit").eq("status", "active"),
  ]);
  const row = company.data as { trade_preset?: string; autopay?: unknown; default_tax_rate?: unknown } | null;
  const settings = autopaySettings({ autopay: row?.autopay }, row?.trade_preset);
  const all = (methods.data ?? []) as Method[];
  const usable = newest(all.filter((m) => m.status === "active" || m.status === "pending"), "created_at");
  const history = newest(agreements.data ?? [], "accepted_at");
  const live = history.find((a) => !a.revoked_at);

  let status: HubAutopay["status"];
  let method: Method | null;
  if (live) {
    method = all.find((m) => m.id === live.payment_method_id) ?? null;
    status = live.paused_at ? "paused" : method?.status === "active" ? "active" : method?.status === "pending" ? "pending" : "needs_update";
  } else {
    // Turned off by the client or the office: only a card saved after that brings it back
    // (turnedOffAt). Only cards this link can say yes to (confirmable), so a link that isn't the
    // client's own is never offered one the server would refuse: it reads as off, and leads to
    // Stripe's page.
    const after = turnedOffAt(history[0]);
    const candidates = (after ? usable.filter((m) => m.created_at > after) : usable).filter((m) => confirmable(m, options.trust));
    method = candidates.find((m) => m.is_default) ?? candidates[0] ?? null;
    status = method ? "agree" : "off";
  }

  // The price of a visit, when there's just one recurring job it would charge (the one with autopay
  // on, or, as agreeing turns it on for them, all of them). Before tax: whether tax goes on top is
  // create_invoice_for_job's rule, a taxable line and the job's quote's rate, else the company's.
  const charged = (jobs.data ?? []).filter((j) => j.autopay || (!live && settings.jobs_default));
  let perVisit: number | null = null;
  let taxed = false;
  if (charged.length === 1) {
    const job = charged[0]!;
    const { data: lines } = await admin.from("job_line_items").select("quantity, unit_price, taxable").eq("company_id", companyId).eq("job_id", job.id);
    const cents = (lines ?? []).reduce((sum, l) => sum + Math.round(Number(l.quantity) * Number(l.unit_price) * 100), 0);
    perVisit = lines?.length ? cents / 100 : null;
    if ((lines ?? []).some((l) => l.taxable)) {
      const quote = job.quote_id ? (await admin.from("quotes").select("tax_rate").eq("company_id", companyId).eq("id", job.quote_id).maybeSingle()).data : null;
      taxed = Number(quote?.tax_rate ?? row?.default_tax_rate ?? 0) > 0;
    }
  }
  const due = (charges.data ?? []).map((c) => c.due_at).sort()[0] ?? null;
  return {
    status,
    method: method ? methodView(method) : null,
    imported: Boolean(method && method.source === "stripe_import" && (options.trust ?? "client") === "client"),
    since: live?.accepted_at ?? null,
    terms: settings.terms,
    terms_version: settings.terms_version,
    timing: autopayTimingText(settings),
    next_charge: due,
    per_visit: perVisit,
    per_visit_taxed: perVisit !== null && taxed,
    available,
  };
}

/**
 * Is there a tip already on this invoice, or one going through? A tip invoice in Stripe, or a
 * tip-only payment booked (from a tip on the Pay screen paid after the invoice, or one added here).
 */
async function tipTaken(admin: Db, companyId: string, invoiceId: string): Promise<boolean> {
  const [tips, payments] = await Promise.all([
    admin.from("stripe_invoices").select("id").eq("company_id", companyId).eq("invoice_id", invoiceId).eq("purpose", "tip").in("status", ["creating", "open", "processing", "paid"]),
    admin.from("payments").select("amount, tip_amount").eq("company_id", companyId).eq("invoice_id", invoiceId).eq("processor", "stripe").gt("tip_amount", 0),
  ]);
  return Boolean(tips.data?.length) || (payments.data ?? []).some((p) => Number(p.amount) === 0);
}

/** The charge the client sees on an invoice: the newest one that got as far as Stripe. */
const SHOWN = ["charging", "processing", "paid", "failed", "needs_client"];

/**
 * A charge that needed the client, moved back to be tried on the card they agreed to since
 * (autopay_try_new_card: failed, with no failures on that card). Shown to them as one waiting is
 * (not at all), so nothing says the new card was declined.
 */
export const onNewCard = (charge: { status: string; failures: number }) => charge.status === "failed" && Number(charge.failures) === 0;

/**
 * An invoice page's autopay facts (GET /hub/:token, kind invoice): how it was (or is being)
 * charged, whether to offer saving the card after paying by hand, and whether a tip can go on the
 * card that paid it (the same checks POST /tip makes, so the button never leads to a refusal).
 */
export async function hubInvoiceAutopay(
  env: Env,
  admin: Db,
  companyId: string,
  invoice: { id: string; client_id: string; balance_due: number; status: string },
  options: { tips: boolean; preview: boolean; imported: boolean; trust: Trust },
): Promise<{ autopay: HubInvoiceAutopay | null; save_card: boolean; tip_after: boolean; tip_method: string | null }> {
  const [available, charges, company] = await Promise.all([
    autopayAvailable(env, admin, companyId),
    admin.from("autopay_charges").select("id, status, failures, payment_method_id, charged_at, charged_amount, created_at").eq("company_id", companyId).eq("invoice_id", invoice.id),
    admin.from("companies").select("settings->autopay").eq("id", companyId).maybeSingle(),
  ]);
  const all = charges.data ?? [];
  // A charge that paid it, refunded since (owed again, or written off), no longer says it's paid.
  const shown = newest(all.filter((c) => SHOWN.includes(c.status) && !onNewCard(c)), "created_at")[0];
  let autopay: HubInvoiceAutopay | null = null;
  let chargeMethod: Method | null = null;
  // Credit the client had in Stripe paid it all: the card was charged nothing, so it isn't named and takes no tip.
  const fromCredit = shown?.status === "paid" && shown.charged_amount !== null && Number(shown.charged_amount) === 0;
  if (shown && !(shown.status === "paid" && Number(invoice.balance_due) > 0)) {
    if (shown.payment_method_id && !fromCredit) {
      const { data } = await admin.from("client_payment_methods").select(METHOD_FIELDS).eq("company_id", companyId).eq("id", shown.payment_method_id).maybeSingle();
      chargeMethod = data as Method | null;
    }
    autopay = { status: shown.status as HubInvoiceAutopay["status"], method: chargeMethod ? methodLabel(chargeMethod) : null, charged_at: shown.charged_at };
  }

  let saveCard = false;
  if (!options.preview && available && !options.imported && !all.length) {
    const [agreement, methods] = await Promise.all([
      agreementOf(admin, companyId, invoice.client_id),
      admin.from("client_payment_methods").select("id").eq("company_id", companyId).eq("client_id", invoice.client_id).in("status", ["active", "pending"]),
    ]);
    saveCard = !agreement && !methods.data?.length;
  }

  let tipAfter = false;
  if (options.tips && !options.preview && options.trust === "client" && available && Number(invoice.balance_due) <= 0 && autopay?.status === "paid" && chargeMethod) {
    const settings = { autopay: (company.data as { autopay?: unknown } | null)?.autopay };
    const ready = await readyMethod(admin, companyId, invoice.client_id, settings);
    tipAfter = Boolean(ready && ready.id === chargeMethod.id && TIPPABLE.includes(ready.type)) && !(await tipTaken(admin, companyId, invoice.id));
  }
  return { autopay, save_card: saveCard, tip_after: tipAfter, tip_method: tipAfter && chargeMethod ? methodLabel(chargeMethod) : null };
}

/** For a quote's page: offer "Approve and set up autopay". */
export async function autopayOffered(env: Env, admin: Db, companyId: string, clientId: string): Promise<boolean> {
  if (!(await autopayAvailable(env, admin, companyId))) return false;
  return !(await agreementOf(admin, companyId, clientId));
}

/**
 * POST /hub/:token/autopay/setup: Stripe's page to save a card. `home` is the client's Hub link and
 * `trust` who that link counts as: the card is saved with it (saved_via), so a link that isn't the
 * client's own can later say yes only to a card saved through one like it (confirmable).
 */
export async function startAutopaySetup(env: Env, admin: Db, input: { companyId: string; clientId: string; home: string; trust: Trust }): Promise<{ url: string }> {
  if (!(await autopayAvailable(env, admin, input.companyId))) throw new HttpError(409, "Autopay isn't available right now. Contact us to set it up.");
  // Stripe fills in {CHECKOUT_SESSION_ID} itself, so it's put in as it is.
  const url = await stripeSetupSession(
    env,
    admin,
    input.companyId,
    input.clientId,
    { successUrl: `${input.home}?view=autopay&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${input.home}?view=autopay` },
    input.trust,
  );
  return { url };
}

/** POST /hub/:token/autopay/finish: back from Stripe's page. */
export async function finishAutopaySetup(env: Env, admin: Db, input: { companyId: string; clientId: string; sessionId: string }): Promise<SetupOutcome> {
  return finishStripeSetup(env, admin, input.companyId, input.clientId, input.sessionId);
}

/**
 * POST /hub/:token/autopay/confirm: the client ticks the box. Records the agreement with the words
 * as they are now (the page showed them as `termsVersion`), the IP, the browser and the link it was
 * agreed on (`via`, who it was made for); makes the card the Stripe customer's default; and takes
 * off a card it replaces. `trust` is who the link counts as for saying yes to this card.
 */
export async function confirmAutopay(
  env: Env,
  admin: Db,
  input: {
    companyId: string;
    clientId: string;
    paymentMethodId: string;
    termsVersion: string;
    ip: string | null;
    userAgent: string | null;
    linkKind: "client" | "quote" | "invoice";
    via: "client" | "office";
    trust: Trust;
  },
): Promise<{ status: "active" | "pending"; method: string }> {
  const { data } = await admin.from("client_payment_methods").select(METHOD_FIELDS).eq("company_id", input.companyId).eq("client_id", input.clientId).eq("id", input.paymentMethodId).maybeSingle();
  const method = data as Method | null;
  if (!method || !["active", "pending"].includes(method.status)) throw new HttpError(404, "That card isn't saved anymore.");
  // A copy of the client's link the office made, or a link from before the client's own were marked,
  // can go through Stripe's page (that takes the card in hand) and say yes to the card saved there,
  // but not to one the business already had or one the client saved on another kind of link and
  // left before agreeing to (confirmable).
  if (!confirmable(method, input.trust)) throw new HttpError(403, "Use the autopay link we sent you to confirm.");
  if (!(await autopayAvailable(env, admin, input.companyId))) throw new HttpError(409, "Autopay isn't available right now. Contact us to set it up.");

  const before = await agreementOf(admin, input.companyId, input.clientId);
  const { error } = await admin.rpc("autopay_record_authorization", {
    p_company: input.companyId,
    p_client: input.clientId,
    p_payment_method: method.id,
    p_source: method.source === "stripe_import" ? "confirmed" : "hub",
    p_terms_version: input.termsVersion,
    p_ip: input.ip ?? undefined,
    p_user_agent: input.userAgent ?? undefined,
    p_link_kind: input.linkKind,
    p_link_via: input.via,
  });
  if (error) {
    if (error.code === "22023") throw new HttpError(409, sentence(error.message));
    if (error.code === "P0002") throw new HttpError(404, sentence(error.message));
    throw new Error(`autopay_record_authorization failed: ${error.message}`);
  }

  // Stripe's own default for the customer, so its dashboard shows the card that's charged. Not
  // needed for the charge (that names the card), so a failure is only logged.
  try {
    const access = await stripeAccess(env, admin, input.companyId);
    if (access?.own) {
      await stripeApi(access.key, "POST", `/v1/customers/${method.stripe_customer_id}`, { invoice_settings: { default_payment_method: method.stripe_payment_method_id } }, {
        idempotencyKey: `crewtavo-default-${method.stripe_payment_method_id}`,
      });
    }
  } catch (thrown) {
    console.error("Couldn't make the card the Stripe customer's default", thrown);
    reportError(thrown, { feature: "autopay", step: "default_payment_method" });
  }
  // The card it replaces comes off; in Stripe only when Crewtavo saved it (detachPaymentMethod).
  if (before?.payment_method_id && before.payment_method_id !== method.id) {
    await detachPaymentMethod(env, admin, input.companyId, before.payment_method_id, "replaced").catch((thrown) => {
      console.error("Couldn't take off the card that was replaced", thrown);
      reportError(thrown, { feature: "autopay", step: "replaced" });
    });
  }
  return { status: method.status === "pending" ? "pending" : "active", method: methodLabel(method) };
}

/**
 * POST /hub/:token/autopay/off and the office's removal: turn off a client's autopay. The card stays
 * saved (and in Stripe); turning it back on takes a fresh Stripe setup.
 */
export async function turnOffAutopay(admin: Db, input: { companyId: string; clientId: string; via: "client" | "office"; userId: string | null }): Promise<void> {
  const { error } = await admin.rpc("autopay_revoke", { p_company: input.companyId, p_client: input.clientId, p_via: input.via, p_by: input.userId ?? undefined });
  if (error) throw new Error(`autopay_revoke failed: ${error.message}`);
}

/**
 * POST /hub/:token/tip: a tip on an invoice autopay paid, charged to the card that paid it. Tips
 * being on is checked first, before anything else and before Stripe (and chargeTip checks again).
 */
export async function tipOnSavedCard(
  env: Env,
  admin: Db,
  input: { companyId: string; invoiceId: string; tip: number; ip: string | null; userAgent: string | null },
): Promise<{ status: "paid"; tip: number }> {
  const [company, online] = await Promise.all([
    admin.from("companies").select("currency, settings").eq("id", input.companyId).maybeSingle(),
    hubPayment(env, admin, input.companyId, input.invoiceId),
  ]);
  if (!tipsAllowed(hubTipsOf(company.data?.settings), online.imported)) throw new HttpError(409, "Tips are turned off.");

  const { data: invoice } = await admin.from("invoices").select("id, client_id, number, total, balance_due, status").eq("company_id", input.companyId).eq("id", input.invoiceId).maybeSingle();
  if (!invoice) throw new HttpError(404, "Invoice not found.");
  if (Number(invoice.balance_due) > 0 || invoice.status === "draft" || invoice.status === "void") throw new HttpError(409, "Pay the invoice first.");

  const noCard = new HttpError(409, "There's no saved card to add a tip to.");
  const { data: paid } = await admin.from("autopay_charges").select("id, payment_method_id").eq("company_id", input.companyId).eq("invoice_id", invoice.id).eq("status", "paid");
  const charge = paid?.[0];
  if (!charge?.payment_method_id) throw noCard;
  // Still on autopay (not turned off or paused since), with the card that paid it.
  const ready = await readyMethod(admin, input.companyId, invoice.client_id, company.data?.settings);
  if (!ready || ready.id !== charge.payment_method_id || !TIPPABLE.includes(ready.type) || ready.client_id !== invoice.client_id) throw noCard;
  if (await tipTaken(admin, input.companyId, invoice.id)) throw new HttpError(409, "A tip was already added. Thank you.");
  if (input.tip > Number(invoice.total)) throw new HttpError(400, "A tip can be up to the invoice total.");

  await chargeTip(env, admin, input.companyId, invoice.id, Math.round(input.tip * 100), savedMethod(ready), { ip: input.ip, userAgent: input.userAgent });
  const tip = Math.round(input.tip * 100) / 100;
  const { error } = await admin.from("messages").insert({
    company_id: input.companyId,
    client_id: invoice.client_id,
    channel: "note",
    direction: "internal",
    status: "received",
    subject: "Tip added",
    body: `Tip of ${money(tip, company.data?.currency)} added from the client page${input.ip ? ` (IP ${input.ip})` : ""}.`,
    related_type: "invoice",
    related_id: invoice.id,
    sent_by: null,
    external_id: `autopay:tip:${invoice.id}`,
  });
  if (error) console.error("Couldn't note the tip", error.message);
  return { status: "paid", tip };
}

// ---------------------------------------------------------------------------------------------
// Settings → Payments
// ---------------------------------------------------------------------------------------------

/** Every row of a select, a page at a time (PostgREST answers with at most 1,000). */
async function allPages<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) return out;
  }
}

/** GET /autopay/status for Settings → Payments and the screens that hide autopay when it's off. */
export async function autopayStatus(env: Env, admin: Db, companyId: string): Promise<AutopayStatus> {
  // Not the cached state: this page is where a new key's permissions show up.
  const [caps, company, imported, agreed] = await Promise.all([
    stripeCapabilities(env, admin, companyId),
    companyOf(admin, companyId),
    allPages((from, to) =>
      admin.from("client_payment_methods").select("client_id").eq("company_id", companyId).eq("source", "stripe_import").eq("status", "active").order("id").range(from, to),
    ),
    allPages((from, to) => admin.from("autopay_authorizations").select("client_id").eq("company_id", companyId).is("revoked_at", null).order("id").range(from, to)),
  ]);
  const on = new Set(agreed.map((a) => a.client_id));
  const cards = new Set(imported.map((m) => m.client_id).filter((id) => !on.has(id)));
  return {
    connected: caps.connected,
    own: caps.own,
    livemode: caps.livemode,
    can_autopay: caps.own && caps.autopay,
    can_refund: caps.own && caps.refunds,
    webhook_current: caps.webhook_current,
    settings: autopaySettings(company?.settings, company?.trade_preset),
    tips: hubTipsOf(company?.settings) === true,
    stripe_cards: cards.size,
  };
}
