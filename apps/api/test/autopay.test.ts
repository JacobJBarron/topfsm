/**
 * Autopay's server side (services/autopay.ts, routes/autopay.ts) against an in-memory database, with
 * Stripe stubbed (integrations/stripe.ts is tested on its own in stripe.test.ts and
 * stripeConnection.test.ts) and email and texts caught. The database functions answer from `rpc`
 * handlers here; what they do is tested in supabase/tests/autopay_test.sql.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { starterAutopayTerms } from "@crewtavo/core/autopay";
import type { Env } from "../src/env";
import { readClientLink } from "../src/lib/links";
import type { Db } from "../src/lib/supabase";

const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));

// Stripe, email, texts and error reports: stubs the tests set and look at.
const m = vi.hoisted(() => ({
  stripeCapabilities: vi.fn(),
  refreshStripeWebhook: vi.fn(),
  stripeSetupSession: vi.fn(),
  finishStripeSetup: vi.fn(),
  chargeInvoiceAutomatically: vi.fn(),
  autopayStripeCheck: vi.fn(),
  chargeTip: vi.fn(),
  refundStripePayment: vi.fn(),
  detachPaymentMethod: vi.fn(),
  hubPayment: vi.fn(),
  stripeAccess: vi.fn(),
  sendEmail: vi.fn(),
  sendSms: vi.fn(),
  emailReady: vi.fn(),
  smsConfigured: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock("../src/integrations/stripe", async (original) => ({
  ...(await original<typeof import("../src/integrations/stripe")>()),
  stripeCapabilities: m.stripeCapabilities,
  refreshStripeWebhook: m.refreshStripeWebhook,
  stripeSetupSession: m.stripeSetupSession,
  finishStripeSetup: m.finishStripeSetup,
  chargeInvoiceAutomatically: m.chargeInvoiceAutomatically,
  autopayStripeCheck: m.autopayStripeCheck,
  chargeTip: m.chargeTip,
  refundStripePayment: m.refundStripePayment,
  detachPaymentMethod: m.detachPaymentMethod,
  hubPayment: m.hubPayment,
  stripeAccess: m.stripeAccess,
}));
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendEmail: m.sendEmail,
  sendSms: m.sendSms,
  emailReady: m.emailReady,
  smsConfigured: m.smsConfigured,
}));
vi.mock("../src/lib/monitoring", async (original) => ({ ...(await original<typeof import("../src/lib/monitoring")>()), reportError: m.reportError }));

const { app } = await import("../src/app");
const {
  autopayAvailable,
  autopayInviteText,
  autopayOffered,
  autopayStatus,
  chargeDueAutopay,
  confirmAutopay,
  hubAutopay,
  hubInvoiceAutopay,
  runAutopayJob,
  sendAutopayAgreed,
  sendAutopayInvite,
  sendAutopayNotice,
  sendAutopayReceipt,
  startAutopaySetup,
  tipOnSavedCard,
  turnOffAutopay,
} = await import("../src/services/autopay");

type Row = Record<string, any>;

// ---------------------------------------------------------------------------------------------
// The database: rows in memory, the filters the code uses, and database functions from `rpc`
// ---------------------------------------------------------------------------------------------

type Rpc = (args: Row) => { data?: unknown; error?: { code?: string; message: string } | null };

function fakeDb(tables: Record<string, Row[]>) {
  const rpcs: Array<{ fn: string; args: Row }> = [];
  const handlers: Record<string, Rpc> = {};
  const hits = new Map<string, number>();
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op = "select";
    let payload: any;
    let cols = "*";
    let one: "single" | "maybe" | null = null;
    let order: Array<[string, boolean]> = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;
    const run = () => {
      const all = (tables[table] ??= []);
      let out: Row[];
      if (op === "insert") {
        out = [];
        for (const p of [payload].flat()) {
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...p };
          all.push(row);
          out.push(row);
        }
      } else {
        const matched = all.filter((r) => filters.every((f) => f(r)));
        if (op === "update") for (const r of matched) Object.assign(r, payload);
        else if (op === "delete") tables[table] = all.filter((r) => !matched.includes(r));
        out = matched;
      }
      out = out.map((r) => {
        const copy = { ...r };
        // settings->autopay and the like.
        for (const part of cols.split(",").map((c) => c.trim()).filter((c) => c.includes("->"))) copy[part.split("->")[1]!] = r[part.split("->")[0]!]?.[part.split("->")[1]!];
        return copy;
      });
      for (const [k, asc] of [...order].reverse()) out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      if (one) return one === "single" && out.length !== 1 ? { data: null, error: { message: "not one row" } } : { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };
    const q: any = {
      select: (c = "*") => {
        if (op === "select") cols = c;
        return q;
      },
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      not: (k: string, _op: string, v: unknown) => (filters.push((r) => (r[k] ?? null) !== v), q),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
      gt: (k: string, v: any) => (filters.push((r) => r[k] > v), q),
      gte: (k: string, v: any) => (filters.push((r) => r[k] >= v), q),
      lt: (k: string, v: any) => (filters.push((r) => r[k] < v), q),
      lte: (k: string, v: any) => (filters.push((r) => r[k] <= v), q),
      like: (k: string, p: string) => (filters.push((r) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`).test(String(r[k] ?? ""))), q),
      order: (k: string, o?: { ascending?: boolean }) => (order.push([k, o?.ascending !== false]), q),
      limit: (n: number) => ((limit = n), q),
      range: (a: number, b: number) => ((range = [a, b]), q),
      maybeSingle: () => ((one = "maybe"), q),
      single: () => ((one = "single"), q),
      insert: (p: unknown) => ((op = "insert"), (payload = p), q),
      update: (p: unknown) => ((op = "update"), (payload = p), q),
      delete: () => ((op = "delete"), q),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return q;
  };
  const db = {
    from,
    rpc: async (fn: string, args: Row) => {
      rpcs.push({ fn, args });
      if (handlers[fn]) return { data: null, error: null, ...handlers[fn]!(args) };
      if (fn === "rate_limit_hit") {
        const n = (hits.get(args.p_key) ?? 0) + 1;
        hits.set(args.p_key, n);
        return { data: n <= args.p_max, error: null };
      }
      return { data: null, error: null };
    },
    // The bearer token is the user's id here.
    auth: { getClaims: async (token: string) => ({ data: { claims: { sub: token } }, error: null }) },
  };
  current.db = db;
  return { db: db as unknown as Db, tables, rpcs, handlers, hits, called: (fn: string) => rpcs.filter((r) => r.fn === fn).map((r) => r.args) };
}

// ---------------------------------------------------------------------------------------------
// A lawn company with a client on autopay
// ---------------------------------------------------------------------------------------------

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CO = id(1);
const OTHER = id(2);
const PAT = id(10);
const SAM = id(11);
const STRANGER = id(12);
const ROBIN = id(13);
const DREW = id(14);
const CARD = id(20);
const BANK = id(21);
const IMPORTED = id(22);
const NEW_CARD = id(23);
const AGREEMENT = id(30);
const CHARGE = id(40);
const INVOICE = id(50);
const JOB = id(60);
const PAYMENT = id(70);

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};

/** What a Hub link in a message says about itself (lib/links), from the line it's on. */
const payloadOf = (url: string) => readClientLink(env, url.split("/hub/")[1]!.split("?")[0]!);
/** Every Hub link in a message, in order. */
const hubLinks = (text: string) => text.match(/https:\/\/\S+\/hub\/\S+/g) ?? [];

const TERMS = "We charge the card on file after each visit is done. You'll get a receipt each time. Turn it off anytime from your client page or by calling us.";
const autopaySetting = (values: Row = {}) => ({
  enabled: true, terms: TERMS, terms_version: "2026-10-31T14:05:09", timing: "end_of_day", days: null, max_amount: 500, receipts: true, jobs_default: true,
  card_required: false, changed_at: "2026-10-31T14:05:09.123Z", changed_by: null, ...values,
});
const card = (rowId: string, client: string, values: Row = {}) => ({
  id: rowId, company_id: CO, client_id: client, type: "card", brand: "visa", last4: "4242", bank_name: null, wallet: null, exp_month: 8, exp_year: 2028,
  status: "active", is_default: true, source: "hub", saved_via: "client", created_at: "2026-10-31T14:00:00Z", stripe_payment_method_id: `pm_${rowId.slice(-4)}`,
  stripe_customer_id: "cus_pat", livemode: true, stripe_account: "acct_1", ...values,
});

function world(options: { settings?: Row; tables?: Record<string, Row[]> } = {}) {
  const tables: Record<string, Row[]> = {
    companies: [
      {
        id: CO, name: "Radford Lawn Care", email: "office@radford.example", phone: "540-555-0100", address: { line1: "1 Main St", city: "Radford", region: "VA", postal_code: "24141" },
        currency: "USD", timezone: "America/New_York", trade_preset: "lawn_exterior", settings: { hub_tips: true, autopay: autopaySetting(), ...options.settings },
      },
      { id: OTHER, name: "Someone Else Mowing", email: null, phone: null, address: {}, currency: "USD", timezone: "UTC", trade_preset: "lawn_exterior", settings: { autopay: autopaySetting() } },
    ],
    clients: [
      { id: PAT, company_id: CO, display_name: "Pat Lee", email: "pat@example.com", phone: "+15405550101" },
      { id: SAM, company_id: CO, display_name: "Sam Ortiz", email: null, phone: "+15405550102" },
      { id: ROBIN, company_id: CO, display_name: "Robin Hale", email: "robin@example.com", phone: null },
      { id: DREW, company_id: CO, display_name: "Drew Park", email: "drew@example.com", phone: null },
      { id: STRANGER, company_id: OTHER, display_name: "Someone Else", email: "else@example.com", phone: null },
    ],
    client_payment_methods: [card(CARD, PAT)],
    autopay_authorizations: [
      {
        id: AGREEMENT, company_id: CO, client_id: PAT, payment_method_id: CARD, terms: `${TERMS} We charge at the end of the day of each visit.`, terms_version: "2026-10-31T14:05:09",
        accepted_at: "2026-10-31T14:10:00Z", source: "hub", revoked_at: null, revoked_via: null, paused_at: null,
      },
    ],
    jobs: [{ id: JOB, company_id: CO, client_id: PAT, title: "Weekly mow", kind: "recurring", billing_mode: "per_visit", status: "active", autopay: true }],
    job_line_items: [{ company_id: CO, job_id: JOB, quantity: 1, unit_price: 45 }],
    invoices: [{ id: INVOICE, company_id: CO, client_id: PAT, job_id: JOB, number: 2, total: 45, balance_due: 0, status: "paid" }],
    autopay_charges: [
      {
        id: CHARGE, company_id: CO, client_id: PAT, job_id: JOB, invoice_id: INVOICE, payment_method_id: CARD, status: "paid", failures: 0, due_at: "2026-11-01T04:00:00Z",
        last_error: null, decline_code: null, charged_amount: 45, charged_at: "2026-11-01T04:02:00Z", created_at: "2026-10-31T20:00:00Z",
      },
    ],
    stripe_invoices: [{ id: id(80), company_id: CO, invoice_id: INVOICE, origin: "crewtavo", purpose: "invoice", collection: "charge_automatically", status: "paid", amount_due: 45 }],
    payments: [],
    messages: [],
    memberships: [
      ["owner-1", "owner"], ["admin-1", "admin"], ["office-1", "office"], ["estimator-1", "estimator"], ["crew-1", "field_crew"], ["lead-1", "crew_lead"],
    ].map(([user, role]) => ({ company_id: CO, user_id: user, role, role_id: null, subcontractor_id: null, active: true })),
    ...options.tables,
  };
  return fakeDb(tables);
}

const CAPS = { connected: true, own: true, livemode: true, autopay: true, refunds: true, webhook_current: true };
const emails = () => m.sendEmail.mock.calls.map(([, message]) => message as { to: string; subject: string; text: string; html: string });
const texts = () => m.sendSms.mock.calls.map(([, message]) => message as { to: string; body: string });
const stripeCalls: Array<{ method: string; url: string; body: string; key: string | null }> = [];

beforeEach(() => {
  vi.resetAllMocks();
  m.stripeCapabilities.mockResolvedValue(CAPS);
  m.refreshStripeWebhook.mockResolvedValue(true);
  m.hubPayment.mockResolvedValue({ enabled: true, processing: false, imported: false });
  m.stripeAccess.mockResolvedValue({ key: "rk_live_own", own: true, account: "acct_1" });
  m.sendEmail.mockResolvedValue({ sent: true, id: "em_1" });
  m.sendSms.mockResolvedValue({ sent: true, id: "SM1" });
  m.emailReady.mockResolvedValue(true);
  m.smsConfigured.mockReturnValue(true);
  m.chargeTip.mockResolvedValue({ status: "paid" });
  m.detachPaymentMethod.mockResolvedValue(undefined);
  stripeCalls.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    stripeCalls.push({ method: init?.method ?? "GET", url: String(input), body: String(init?.body ?? ""), key: headers.get("idempotency-key") });
    return Response.json({ id: "cus_pat" });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------------------------

describe("charging what's due", () => {
  const TOKEN = id(99);
  const claimed = (values: Row = {}) => ({ id: CHARGE, company_id: CO, invoice_id: null, attempts: 1, failures: 0, claim_token: TOKEN, status: "charging", ...values });
  const METHOD = { id: CARD, stripe_payment_method_id: "pm_0020", stripe_customer_id: "cus_pat", livemode: true, stripe_account: "acct_1", type: "card" };
  const billed = { outcome: "charge", invoice_id: INVOICE, invoice_status: "draft", balance_due: 45, method: METHOD };

  function due(rows: Row[], bill: unknown = billed) {
    const db = world();
    db.handlers.claim_autopay_charges = () => ({ data: rows });
    db.handlers.autopay_bill = () => ({ data: bill });
    db.handlers.autopay_mark_sent = () => ({ data: true });
    db.handlers.finish_autopay_charge = () => ({ data: true });
    db.handlers.release_autopay_charges = (args) => ({ data: args.p_ids.length });
    return db;
  }

  it("claims, bills, marks the invoice sent for what Stripe charges, charges, and finishes paid", async () => {
    const db = due([claimed()]);
    m.chargeInvoiceAutomatically.mockImplementation(async (_env, _admin, _company, input) => {
      expect(await input.markSent(4500)).toBe(true);
      return { outcome: "paid", amountCents: 4500 };
    });
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ claimed: 1, charged: 1, lost: 0, retry: 0 });
    expect(db.called("claim_autopay_charges")).toEqual([{ p_limit: 25 }]);
    expect(db.called("autopay_bill")).toEqual([{ p_charge: CHARGE, p_token: TOKEN }]);
    expect(m.chargeInvoiceAutomatically).toHaveBeenCalledWith(env, db.db, CO, expect.objectContaining({ chargeId: CHARGE, attempt: 1, invoiceId: INVOICE, method: METHOD }));
    expect(db.called("autopay_mark_sent")).toEqual([{ p_charge: CHARGE, p_token: TOKEN, p_amount_cents: 4500 }]);
    expect(db.called("finish_autopay_charge")).toEqual([{ p_id: CHARGE, p_outcome: "paid", p_token: TOKEN, p_amount: 45 }]);
    // The receipt comes from the outbox, never from here.
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("keeps that the card was charged nothing when credit the client had in Stripe paid it all", async () => {
    const db = due([claimed()]);
    m.chargeInvoiceAutomatically.mockResolvedValue({ outcome: "paid", amountCents: 0 });
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ claimed: 1, charged: 1 });
    // chargeInvoiceAutomatically sent ours before booking the credit (and finish sends a draft): not again here.
    expect(db.called("autopay_mark_sent")).toEqual([]);
    expect(db.called("finish_autopay_charge")).toEqual([{ p_id: CHARGE, p_outcome: "paid", p_token: TOKEN, p_amount: 0 }]);
  });

  it("takes one company's charges when asked (Approve charge)", async () => {
    const db = due([]);
    await chargeDueAutopay(env, db.db, { companyId: CO, limit: 5 });
    expect(db.called("claim_autopay_charges")).toEqual([{ p_limit: 5, p_company: CO }]);
  });

  it("counts a first decline as failed and a second as needing the client, with the code", async () => {
    const db = due([claimed(), claimed({ id: id(41), failures: 1 })]);
    m.chargeInvoiceAutomatically.mockResolvedValue({ outcome: "declined", code: "insufficient_funds", message: "Your card has insufficient funds." });
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ claimed: 2, failed: 1, needs_client: 1 });
    expect(db.called("finish_autopay_charge")).toEqual([
      { p_id: CHARGE, p_outcome: "declined", p_token: TOKEN, p_error: "Your card has insufficient funds.", p_decline: "insufficient_funds" },
      { p_id: id(41), p_outcome: "declined", p_token: TOKEN, p_error: "Your card has insufficient funds.", p_decline: "insufficient_funds" },
    ]);
  });

  it("counts the office's Charge card declined as needing the client at once", async () => {
    const db = due([claimed({ source: "manual" })]);
    m.chargeInvoiceAutomatically.mockResolvedValue({ outcome: "declined", code: null, message: "Your card was declined." });
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ claimed: 1, failed: 0, needs_client: 1 });
    expect(db.called("finish_autopay_charge")).toEqual([{ p_id: CHARGE, p_outcome: "declined", p_token: TOKEN, p_error: "Your card was declined." }]);
  });

  it("asks the client when the bank wants them to confirm, and calls off what's too small to charge", async () => {
    const db = due([claimed(), claimed({ id: id(41) })]);
    m.chargeInvoiceAutomatically
      .mockResolvedValueOnce({ outcome: "needs_client", code: "authentication_required", message: "This payment needs to be confirmed." })
      .mockResolvedValueOnce({ outcome: "too_small" });
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ needs_client: 1, called_off: 1 });
    expect(db.called("finish_autopay_charge")).toEqual([
      { p_id: CHARGE, p_outcome: "needs_client", p_token: TOKEN, p_error: "This payment needs to be confirmed.", p_decline: "authentication_required" },
      { p_id: id(41), p_outcome: "called_off", p_token: TOKEN, p_error: "Less than Stripe can charge. Send it the usual way" },
    ]);
  });

  it("passes on bank payments on their way, a busy Stripe, a retry and a key that can't charge", async () => {
    const rows = [1, 2, 3, 4].map((n) => claimed({ id: id(40 + n) }));
    const db = due(rows);
    m.chargeInvoiceAutomatically
      .mockResolvedValueOnce({ outcome: "processing", amountCents: 4500 })
      .mockResolvedValueOnce({ outcome: "busy", message: "Stripe's invoice is still being made" })
      .mockResolvedValueOnce({ outcome: "retry", message: "Stripe is busy" })
      .mockResolvedValueOnce({ outcome: "unusable", message: "Your Stripe key can't charge saved cards anymore. Update it on the Apps page." });
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ processing: 1, busy: 1, retry: 1, called_off: 1 });
    expect(db.called("finish_autopay_charge").map((a) => [a.p_outcome, a.p_amount ?? a.p_error])).toEqual([
      ["processing", 45],
      ["busy", "Stripe's invoice is still being made"],
      ["retry", "Stripe is busy"],
      ["called_off", "Your Stripe key can't charge saved cards anymore. Update it on the Apps page."],
    ]);
  });

  it("counts what the database did without Stripe: asked first, called off, paid already, lost", async () => {
    const rows = [1, 2, 3, 4].map((n) => claimed({ id: id(40 + n) }));
    const db = due(rows);
    const outcomes = ["needs_approval", "called_off", "paid", "lost"];
    db.handlers.autopay_bill = () => ({ data: { outcome: outcomes.shift(), reason: null, invoice_id: INVOICE } });
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ claimed: 4, needs_approval: 1, called_off: 1, charged: 1, lost: 1 });
    expect(m.chargeInvoiceAutomatically).not.toHaveBeenCalled();
    expect(db.called("finish_autopay_charge")).toEqual([]);
  });

  it("turns a thrown error into a retry that keeps its try, and reports it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = due([claimed()]);
    const error = new Error("socket hang up");
    m.chargeInvoiceAutomatically.mockRejectedValue(error);
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ retry: 1 });
    // A retry, never a busy (which gives the try back): the stop at the sixth claim always comes.
    expect(db.called("finish_autopay_charge")).toEqual([{ p_id: CHARGE, p_outcome: "retry", p_token: TOKEN, p_error: "Something went wrong charging it. Trying again in 10 minutes" }]);
    expect(db.called("release_autopay_charges")).toEqual([]);
    expect(m.reportError).toHaveBeenCalledWith(error, { task: "autopay", charge: CHARGE });
  });

  it("counts a charge whose claim another run took over as lost", async () => {
    const db = due([claimed()]);
    db.handlers.finish_autopay_charge = () => ({ data: false });
    m.chargeInvoiceAutomatically.mockResolvedValue({ outcome: "paid", amountCents: 4500 });
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ charged: 0, lost: 1 });
  });

  it("asks Stripe on a sixth claim and books a charge that went through, rather than stopping it", async () => {
    const db = due([claimed({ attempts: 6, invoice_id: INVOICE }), claimed({ id: id(41), attempts: 6, invoice_id: id(51) }), claimed({ id: id(42), attempts: 6 })]);
    m.autopayStripeCheck.mockResolvedValueOnce("paid").mockResolvedValueOnce("open");
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ charged: 1, called_off: 2 });
    expect(m.autopayStripeCheck.mock.calls.map((c) => c.slice(2))).toEqual([[CO, INVOICE, CHARGE], [CO, id(51), id(41)]]);
    expect(db.called("autopay_bill")).toEqual([]);
    expect(m.chargeInvoiceAutomatically).not.toHaveBeenCalled();
    expect(db.called("finish_autopay_charge").map((a) => [a.p_id, a.p_outcome, a.p_error])).toEqual([
      [CHARGE, "paid", undefined],
      [id(41), "called_off", "Stopped after 5 tries. Check the invoice and Stripe"],
      [id(42), "called_off", "Stopped after 5 tries. Check the invoice and Stripe"],
    ]);
  });

  it("on a sixth claim, calls it off as paid another way when its Stripe invoice was paid with another card", async () => {
    const db = due([claimed({ attempts: 6, invoice_id: INVOICE })]);
    m.autopayStripeCheck.mockResolvedValueOnce("other");
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ charged: 0, called_off: 1 });
    expect(db.called("finish_autopay_charge").map((a) => [a.p_id, a.p_outcome, a.p_error])).toEqual([[CHARGE, "called_off", "Paid another way"]]);
  });

  it("on a sixth claim, leaves a bank payment on its way to clear rather than calling it off", async () => {
    const db = due([claimed({ attempts: 6, invoice_id: INVOICE })]);
    m.autopayStripeCheck.mockResolvedValueOnce("processing");
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ processing: 1, called_off: 0 });
    expect(db.called("finish_autopay_charge")).toEqual([{ p_id: CHARGE, p_outcome: "processing", p_token: TOKEN }]);
  });

  it("comes to the sixth-claim stop even when every try throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = due([claimed({ attempts: 5, invoice_id: INVOICE })]);
    m.chargeInvoiceAutomatically.mockRejectedValue(new Error("boom"));
    await chargeDueAutopay(env, db.db);
    expect(db.called("finish_autopay_charge").at(-1)).toMatchObject({ p_outcome: "retry" });
    // The next claim is the sixth.
    db.handlers.claim_autopay_charges = () => ({ data: [claimed({ attempts: 6, invoice_id: INVOICE })] });
    m.autopayStripeCheck.mockResolvedValue("none");
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ called_off: 1 });
    expect(m.chargeInvoiceAutomatically).toHaveBeenCalledTimes(1);
  });

  it("stops starting charges after 4 minutes and gives the rest back as they were", async () => {
    let clock = Date.parse("2026-11-01T04:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const rows = [1, 2, 3].map((n) => claimed({ id: id(40 + n) }));
    const db = due(rows);
    m.chargeInvoiceAutomatically.mockImplementation(async () => {
      clock += 5 * 60_000;
      return { outcome: "paid", amountCents: 4500 };
    });
    expect(await chargeDueAutopay(env, db.db)).toMatchObject({ claimed: 3, charged: 1 });
    expect(db.called("release_autopay_charges")).toEqual([{ p_token: TOKEN, p_ids: [id(42), id(43)] }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Receipts, notices and the copy of an agreement
// ---------------------------------------------------------------------------------------------

describe("the receipt", () => {
  const linkIn = (text: string, pattern: RegExp) => text.split("\n").find((line) => pattern.test(line));

  it("says what the card was charged, offers a tip when tips are on, and carries a fresh link to the client's page", async () => {
    const db = world();
    expect(await sendAutopayReceipt(env, db.db, CHARGE)).toBe("sent");
    const [mail] = emails();
    expect(mail).toMatchObject({ to: "pat@example.com", subject: "Receipt for invoice #2" });
    expect(mail!.text).toContain("Hi Pat,\n\nWe charged $45.00 to your Visa ending 4242 for Weekly mow (invoice #2). Thank you.");
    expect(mail!.text).toContain("Add a tip for the crew?");
    const tip = linkIn(mail!.text, /\?tip=1$/)!;
    // Marked as the client's own (own: 1), so the tip can go on the saved card from it.
    expect(await readClientLink(env, tip.split("/hub/")[1]!.split("?")[0]!)).toMatchObject({ c: CO, t: "invoice", id: INVOICE, own: 1 });
    const manage = linkIn(mail!.text, /\?view=autopay$/)!;
    const home = await readClientLink(env, manage.split("/hub/")[1]!.split("?")[0]!);
    expect(home).toMatchObject({ c: CO, t: "client", id: PAT, own: 1 });
    expect(home!.via).toBeUndefined();
    // Minted now, for the client page's full 120 days.
    expect(home!.exp * 1000).toBeGreaterThan(Date.now() + 119 * 86_400_000);
    expect(mail!.html).toContain(">Add a tip</a>");
    expect(mail!.html).toContain(">Manage autopay</a>");
    expect(db.tables.messages).toEqual([
      expect.objectContaining({ company_id: CO, client_id: PAT, channel: "email", direction: "out", status: "sent", sent_by: null, related_type: "invoice", related_id: INVOICE, external_id: `autopay:receipt:${CHARGE}` }),
    ]);
  });

  it("keeps the office's copies of its links on the timeline, so nobody there can tip on the card for the client", async () => {
    const db = world();
    await sendAutopayReceipt(env, db.db, CHARGE);
    const sent = hubLinks(emails()[0]!.text);
    const kept = hubLinks(db.tables.messages![0]!.body);
    expect(sent).toHaveLength(2);
    expect(kept).toHaveLength(2);
    for (const url of sent) { const link = await payloadOf(url); expect(link).toMatchObject({ own: 1 }); expect(link).not.toHaveProperty("via"); }
    expect(await payloadOf(kept[0]!)).toMatchObject({ c: CO, t: "invoice", id: INVOICE, via: "office" });
    expect(kept[0]).toMatch(/\?tip=1$/);
    expect(await payloadOf(kept[1]!)).toMatchObject({ c: CO, t: "client", id: PAT, via: "office" });
    expect(kept[1]).toMatch(/\?view=autopay$/);
    // The words are the same (the email adds the company's footer); only the links differ.
    expect(emails()[0]!.text.replace(/https:\/\/\S+/g, "")).toContain(db.tables.messages![0]!.body.replace(/https:\/\/\S+/g, ""));
  });

  it("leaves the tip out when tips are off, when the invoice came from Stripe, and for a bank account", async () => {
    for (const setup of [
      () => world({ settings: { hub_tips: false } }),
      () => world({ settings: { hub_tips: undefined } }),
      () => {
        const db = world();
        db.tables.stripe_invoices!.push({ id: id(81), company_id: CO, invoice_id: INVOICE, origin: "stripe", purpose: "invoice", collection: "send_invoice", status: "void", amount_due: 45 });
        return db;
      },
      () => world({ tables: { client_payment_methods: [card(CARD, PAT, { type: "us_bank_account", brand: null, bank_name: "Chase", last4: "6789" })] } }),
      () => {
        // A tip went on already.
        const db = world();
        db.tables.stripe_invoices!.push({ id: id(82), company_id: CO, invoice_id: INVOICE, origin: "crewtavo", purpose: "tip", collection: "charge_automatically", status: "paid", amount_due: 5 });
        return db;
      },
    ]) {
      m.sendEmail.mockClear();
      const db = setup();
      expect(await sendAutopayReceipt(env, db.db, CHARGE)).toBe("sent");
      const [mail] = emails();
      expect(mail!.text).not.toContain("Add a tip");
      expect(mail!.text).not.toContain("tip=1");
      expect(mail!.text).toContain("?view=autopay");
    }
  });

  it("says credit paid it when nothing was charged to the card, with no tip to add", async () => {
    const db = world();
    db.tables.autopay_charges![0]!.charged_amount = 0;
    expect(await sendAutopayReceipt(env, db.db, CHARGE)).toBe("sent");
    const text = emails()[0]!.text;
    expect(text).toContain("Hi Pat,\n\nInvoice #2 for Weekly mow was paid from your account credit, so nothing was charged to your Visa ending 4242. Thank you.");
    expect(text).not.toContain("We charged");
    expect(text).not.toContain("Add a tip");
    expect(text).not.toContain("tip=1");
    expect(text).toContain("?view=autopay");
  });

  it("reads an amount it wasn't given from what Stripe took on the card, never from what's owed (nothing, by then)", async () => {
    const db = world();
    db.tables.autopay_charges![0]!.charged_amount = null;
    // Credit paid part of it; the card the rest.
    db.tables.payments = [
      { company_id: CO, invoice_id: INVOICE, amount: 40, processor: "stripe", created_at: "2026-11-01T04:02:00Z" },
      { company_id: CO, invoice_id: INVOICE, amount: 5, processor: null, notes: "Account credit in Stripe", created_at: "2026-11-01T04:02:00Z" },
    ];
    await sendAutopayReceipt(env, db.db, CHARGE);
    expect(emails()[0]!.text).toContain("We charged $40.00 to your Visa ending 4242");
  });

  it("counts only what Stripe took since the charge was made, never an earlier charge's payment that was refunded", async () => {
    const db = world();
    db.tables.autopay_charges![0]!.charged_amount = null;
    // An earlier charge took $45, refunded before this one was queued (2026-10-31T20:00:00Z).
    db.tables.payments = [
      { company_id: CO, invoice_id: INVOICE, amount: 45, processor: "stripe", created_at: "2026-10-20T04:02:00Z" },
      { company_id: CO, invoice_id: INVOICE, amount: -45, processor: "stripe", created_at: "2026-10-25T10:00:00Z" },
      { company_id: CO, invoice_id: INVOICE, amount: 45, processor: "stripe", created_at: "2026-11-01T04:02:00Z" },
    ];
    await sendAutopayReceipt(env, db.db, CHARGE);
    expect(emails()[0]!.text).toContain("We charged $45.00 to your Visa ending 4242");
  });

  it("says credit paid it when it wasn't given an amount and Stripe took nothing on the card", async () => {
    const db = world();
    db.tables.autopay_charges![0]!.charged_amount = null;
    db.tables.payments = [{ company_id: CO, invoice_id: INVOICE, amount: 45, processor: null, notes: "Account credit in Stripe", created_at: "2026-11-01T04:02:00Z" }];
    await sendAutopayReceipt(env, db.db, CHARGE);
    const text = emails()[0]!.text;
    expect(text).toContain("was paid from your account credit, so nothing was charged to your Visa ending 4242");
    expect(text).not.toContain("We charged");
    expect(text).not.toContain("Add a tip");
  });

  it("goes once, only when receipts are on and the client has a real email address", async () => {
    let db = world();
    expect(await sendAutopayReceipt(env, db.db, CHARGE)).toBe("sent");
    expect(await sendAutopayReceipt(env, db.db, CHARGE)).toBe("skipped: already sent");
    expect(m.sendEmail).toHaveBeenCalledTimes(1);

    db = world({ settings: { autopay: autopaySetting({ receipts: false }) } });
    expect(await sendAutopayReceipt(env, db.db, CHARGE)).toBe("skipped: receipts are off");
    db = world();
    db.tables.clients![0]!.email = "pat-stand-in@sub.crewtavo.invalid";
    expect(await sendAutopayReceipt(env, db.db, CHARGE)).toBe("skipped: no email address");
    db = world();
    db.tables.autopay_charges![0]!.status = "called_off";
    expect(await sendAutopayReceipt(env, db.db, CHARGE)).toBe("skipped: the charge is called_off");
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("is sent from the outbox job, and a failed send is tried again", async () => {
    const db = world();
    m.sendEmail.mockResolvedValueOnce({ sent: false, reason: "Resend is having trouble right now. Try again in a few minutes." });
    await expect(runAutopayJob(env, db.db, { company_id: CO, topic: "autopay.receipt", payload: { charge_id: CHARGE } })).rejects.toThrow(/Resend is having trouble/);
    expect(db.tables.messages).toEqual([]);
    await runAutopayJob(env, db.db, { company_id: CO, topic: "autopay.receipt", payload: { charge_id: CHARGE } });
    expect(db.tables.messages).toHaveLength(1);
    await expect(runAutopayJob(env, db.db, { company_id: CO, topic: "autopay.other", payload: {} })).rejects.toThrow(/Unknown autopay job/);
  });
});

describe("the notice of a charge that didn't go through", () => {
  const failing = (values: Row = {}, invoice: Row = {}) => {
    const db = world();
    Object.assign(db.tables.autopay_charges![0]!, { status: "failed", failures: 1, charged_amount: null, charged_at: null, last_error: "Your card was declined.", decline_code: "card_declined", due_at: "2026-11-04T04:00:00Z", ...values });
    Object.assign(db.tables.invoices![0]!, { balance_due: 45, status: "sent", ...invoice });
    return db;
  };

  it("after a first decline: why, when it's tried again, and the Pay link with a way to update the card", async () => {
    const db = failing();
    expect(await sendAutopayNotice(env, db.db, CHARGE, "failed", 1)).toBe("sent");
    const [mail] = emails();
    expect(mail!.subject).toBe("We couldn't charge your card for invoice #2");
    expect(mail!.text).toContain(
      "We couldn't charge your Visa ending 4242 for invoice #2 ($45.00). Your bank said: Your card was declined. We'll try again on Nov 3. You can pay it now, or update your card:",
    );
    const links = mail!.text.split("\n").filter((line) => line.startsWith("https://"));
    expect(links).toHaveLength(2);
    expect(await readClientLink(env, links[0]!.split("/hub/")[1]!)).toMatchObject({ t: "invoice", id: INVOICE });
    expect(links[1]).toMatch(/\?view=autopay$/);
    expect(db.tables.messages![0]).toMatchObject({ related_type: "invoice", related_id: INVOICE, external_id: `autopay:notice:${CHARGE}:${CARD}:failed:1` });
    // The client's email has their own links; the timeline's copy has the office's.
    for (const url of links) { const link = await payloadOf(url); expect(link).toMatchObject({ own: 1 }); expect(link).not.toHaveProperty("via"); }
    const kept = hubLinks(db.tables.messages![0]!.body);
    expect(kept).toHaveLength(2);
    expect(await payloadOf(kept[0]!)).toMatchObject({ t: "invoice", id: INVOICE, via: "office" });
    expect(await payloadOf(kept[1]!)).toMatchObject({ t: "client", id: PAT, via: "office" });
    expect(await sendAutopayNotice(env, db.db, CHARGE, "failed", 1)).toBe("skipped: already sent");
    // A decline on another card the client agreed to since (its count starts again) is told.
    db.tables.client_payment_methods!.push(card(NEW_CARD, PAT, { brand: "mastercard", last4: "5555" }));
    db.tables.autopay_charges![0]!.payment_method_id = NEW_CARD;
    expect(await sendAutopayNotice(env, db.db, CHARGE, "failed", 1)).toBe("sent");
    expect(emails()[1]!.text).toContain("We couldn't charge your Mastercard ending 5555 for invoice #2");
  });

  it("after the office's Charge card was declined: why, and the Pay link with a way to update the card (never a retry date)", async () => {
    const db = failing({ status: "needs_client", failures: 1 });
    await sendAutopayNotice(env, db.db, CHARGE, "needs_client", 1);
    const [mail] = emails();
    expect(mail!.subject).toBe("We couldn't charge your card for invoice #2");
    expect(mail!.text).toContain("We couldn't charge your Visa ending 4242 for invoice #2 ($45.00): Your card was declined. You can pay it now, or update your card:");
    expect(mail!.text).not.toContain("try again");
    expect(mail!.text.split("\n").filter((line) => line.startsWith("https://"))).toHaveLength(2);
  });

  it("after a second decline: autopay is paused until the card is updated", async () => {
    const db = failing({ status: "needs_client", failures: 2 });
    await sendAutopayNotice(env, db.db, CHARGE, "needs_client", 2);
    expect(emails()[0]!.text).toContain("We couldn't charge your Visa ending 4242 for invoice #2 ($45.00) again, so autopay is paused until you update your card.");
  });

  it("when the bank wants the client to confirm it: open the invoice", async () => {
    const db = failing({ status: "needs_client", failures: 0, decline_code: "authentication_required", last_error: "This payment needs to be confirmed." });
    await sendAutopayNotice(env, db.db, CHARGE, "needs_client", 0);
    const [mail] = emails();
    expect(mail!.subject).toBe("Please confirm your payment for invoice #2");
    expect(mail!.text).toContain("Your bank asks you to confirm the payment of $45.00 for invoice #2. Open the invoice to confirm it:");
    expect(mail!.text).not.toContain("?view=autopay");
  });

  it("goes by text when there's no email address, and to nobody when there's no way", async () => {
    const db = failing();
    db.tables.clients![0]!.email = null;
    await sendAutopayNotice(env, db.db, CHARGE, "failed", 1);
    expect(m.sendEmail).not.toHaveBeenCalled();
    const [text] = texts();
    expect(text!.to).toBe("+15405550101");
    expect(text!.body).toMatch(/^Radford Lawn Care: We couldn't charge your Visa ending 4242 for invoice #2 \(\$45\.00\)\. We'll try again on Nov 3\. Pay it or update your card: https:\/\/ops\.example\.com\/hub\//);
    expect(await payloadOf(hubLinks(text!.body)[0]!)).toMatchObject({ own: 1 });
    expect(await payloadOf(hubLinks(text!.body)[0]!)).not.toHaveProperty("via");
    expect(db.tables.messages![0]).toMatchObject({ channel: "sms" });
    expect(await payloadOf(hubLinks(db.tables.messages![0]!.body)[0]!)).toMatchObject({ t: "invoice", id: INVOICE, via: "office" });

    const quiet = failing();
    quiet.tables.clients![0]!.email = null;
    m.smsConfigured.mockReturnValue(false);
    expect(await sendAutopayNotice(env, quiet.db, CHARGE, "failed", 1)).toBe("skipped: no way to reach them");
  });

  it("isn't sent once nothing is owed (paid another way meanwhile)", async () => {
    const db = failing({ status: "called_off" }, { balance_due: 0, status: "paid" });
    expect(await sendAutopayNotice(env, db.db, CHARGE, "failed", 1)).toBe("skipped: nothing is owed on it now");
    expect(m.sendEmail).not.toHaveBeenCalled();
  });
});

describe("the client's copy of their agreement", () => {
  it("has the card, when it's charged, the words in full and a link to turn it off, once", async () => {
    const db = world();
    expect(await sendAutopayAgreed(env, db.db, AGREEMENT)).toBe("sent");
    const [mail] = emails();
    expect(mail!.subject).toBe("Autopay is set up with Radford Lawn Care");
    expect(mail!.text).toContain("You set up autopay with Radford Lawn Care on Oct 31. We'll charge your Visa ending 4242 at the end of the day of each visit.");
    expect(mail!.text).toContain(`${TERMS} We charge at the end of the day of each visit.`);
    expect(mail!.text).toMatch(/Not you, or changed your mind\? Turn it off here:\n\nhttps:\/\/ops\.example\.com\/hub\/\S+\?view=autopay/);
    expect(db.tables.messages![0]).toMatchObject({ related_type: "autopay", related_id: PAT, external_id: `autopay:agreed:${AGREEMENT}` });
    // Their "Turn it off" link is their own; the timeline's copy is the office's.
    expect(await payloadOf(hubLinks(mail!.text)[0]!)).toMatchObject({ own: 1 });
    expect(await payloadOf(hubLinks(mail!.text)[0]!)).not.toHaveProperty("via");
    expect(await payloadOf(hubLinks(db.tables.messages![0]!.body)[0]!)).toMatchObject({ t: "client", id: PAT, via: "office" });
    expect(await sendAutopayAgreed(env, db.db, AGREEMENT)).toBe("skipped: already sent");
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("isn't sent for the owner's record that clients agreed", async () => {
    const db = world();
    db.tables.autopay_authorizations![0]!.source = "owner";
    expect(await sendAutopayAgreed(env, db.db, AGREEMENT)).toBe("skipped: recorded by the owner");
  });
});

// ---------------------------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------------------------

describe("autopay invites", () => {
  const invite = (db: ReturnType<typeof world>, values: Partial<Parameters<typeof sendAutopayInvite>[2]> = {}) =>
    sendAutopayInvite(env, db.db, { companyId: CO, clientId: ROBIN, channel: "email", baseUrl: "https://ops.example.com/", createdBy: "office-1", ...values });

  it("sends the setup link, and keeps the office's copy of it on the client's timeline", async () => {
    const db = world();
    expect(await invite(db)).toEqual({ sent: true, detail: "Sent by email." });
    const [mail] = emails();
    expect(mail!.subject).toBe("Set up autopay with Radford Lawn Care");
    const link = mail!.text.split("\n").find((line) => line.startsWith("https://"))!;
    // Then the company's footer.
    expect(mail!.text).toContain(
      "Hi Robin,\n\nThanks for choosing Radford Lawn Care. For your lawn care, we keep a card on file and charge it after each visit, so there's nothing to pay each time. Save yours securely with Stripe here (takes a minute):\n\n" +
        `${link}\n\nYou'll get a receipt after every visit. You can update your card or turn it off anytime.\n\nThanks,\nRadford Lawn Care`,
    );
    expect(link).toMatch(/^https:\/\/ops\.example\.com\/hub\/\S+\?view=autopay$/);
    // The button says what tapping it does; the link is the one receipts send.
    expect(mail!.html).toContain(">Save your card</a>");
    expect(mail!.html).not.toContain("Manage autopay");
    const own = await readClientLink(env, link.split("/hub/")[1]!.split("?")[0]!);
    expect(own).toMatchObject({ c: CO, t: "client", id: ROBIN, own: 1 });
    expect(own!.via).toBeUndefined();
    const [row] = db.tables.messages!;
    expect(row).toMatchObject({ client_id: ROBIN, channel: "email", related_type: "autopay", related_id: ROBIN, sent_by: "office-1" });
    // It opens their page, but not as the client: it can't confirm a card for them.
    const kept = hubLinks(row!.body);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/\?view=autopay$/);
    expect(await payloadOf(kept[0]!)).toMatchObject({ c: CO, t: "client", id: ROBIN, via: "office" });
  });

  it("asks a client with a card brought in from Stripe to confirm it", async () => {
    const db = world({ tables: { client_payment_methods: [card(CARD, PAT), card(IMPORTED, ROBIN, { source: "stripe_import", brand: "mastercard", last4: "5555" })] } });
    await invite(db);
    expect(emails()[0]!.subject).toBe("Confirm autopay with Radford Lawn Care");
    expect(emails()[0]!.html).toContain(">Confirm autopay</a>");
    expect(emails()[0]!.text).toMatch(/^Hi Robin,\n\nWe have your Mastercard ending 5555 on file\. Tap below to confirm we can charge it after each visit:\n\nhttps:\/\/\S+\n\nYou'll get a receipt after every visit\.\n\nThanks,\nRadford Lawn Care\n/);
  });

  it("says so for a lawn company, and the receipts line only while receipts go out", () => {
    const lawn = { name: "Radford Lawn Care", trade_preset: "lawn_exterior", settings: { autopay: autopaySetting() } };
    const quiet = { ...lawn, settings: { autopay: autopaySetting({ receipts: false }) } };
    const roofer = { name: "Top Roofs", trade_preset: "roofing_exteriors", settings: {} };
    expect(autopayInviteText(lawn, "Pat", "LINK").email).toContain("For your lawn care, we keep a card on file and charge it after each visit, so there's nothing to pay each time.");
    expect(autopayInviteText(quiet, "Pat", "LINK").email).toBe(
      "Hi Pat,\n\nThanks for choosing Radford Lawn Care. For your lawn care, we keep a card on file and charge it after each visit, so there's nothing to pay each time. Save yours securely with Stripe here (takes a minute):\n\nLINK\n\nYou can update your card or turn it off anytime.\n\nThanks,\nRadford Lawn Care",
    );
    expect(autopayInviteText(roofer, "Pat", "LINK").email).toContain("Thanks for choosing Top Roofs. We keep a card on file and charge it after each visit, so there's nothing to pay each time.");
    // Receipts are on until the company turns them off.
    expect(autopayInviteText(roofer, "Pat", "LINK").email).toContain("You'll get a receipt after every visit. You can update");
    expect(autopayInviteText(lawn, "Pat", "LINK").sms).toBe("Radford Lawn Care: thanks for choosing us. We keep a card on file and charge it after each visit. Save yours securely with Stripe: LINK");
    expect(autopayInviteText(quiet, "Pat", "LINK", "Visa ending 4242").email).not.toContain("receipt");
    expect(autopayInviteText(lawn, "Pat", "LINK", "Visa ending 4242").sms).toBe("Radford Lawn Care: We have your Visa ending 4242 on file. Tap below to confirm we can charge it after each visit: LINK");
    for (const words of [autopayInviteText(lawn, "Pat", "LINK"), autopayInviteText(roofer, "Pat", "LINK", "Visa ending 4242")]) {
      expect(words.email + words.sms).not.toContain("!");
    }
  });

  it("asks a client who turned autopay off to set it up again, as their page does, until a card from Stripe comes in after", async () => {
    const turnedOff = { id: id(31), company_id: CO, client_id: ROBIN, payment_method_id: IMPORTED, accepted_at: "2026-10-20T10:00:00Z", revoked_at: "2026-10-25T10:00:00Z", paused_at: null };
    for (const by of ["client", "office"]) {
      m.sendEmail.mockClear();
      const db = world({
        tables: {
          client_payment_methods: [card(IMPORTED, ROBIN, { source: "stripe_import", created_at: "2026-10-01T00:00:00Z" })],
          autopay_authorizations: [{ ...turnedOff, revoked_via: by }],
        },
      });
      await invite(db);
      expect(emails()[0]!.subject).toBe("Set up autopay with Radford Lawn Care");
      expect(emails()[0]!.text).not.toContain("We have your");
      // One brought in since is theirs to confirm.
      db.tables.client_payment_methods!.push(card(NEW_CARD, ROBIN, { source: "stripe_import", last4: "1881", created_at: "2026-10-26T00:00:00Z" }));
      await invite(db);
      expect(emails()[1]!.text).toContain("We have your Visa ending 1881 on file.");
    }
    // Ended some other way (its card was taken off in Stripe, say): a card on file still counts.
    const db = world({ tables: { client_payment_methods: [card(IMPORTED, ROBIN, { source: "stripe_import", created_at: "2026-10-01T00:00:00Z" })], autopay_authorizations: [{ ...turnedOff, revoked_via: "stripe" }] } });
    m.sendEmail.mockClear();
    await invite(db);
    expect(emails()[0]!.subject).toBe("Confirm autopay with Radford Lawn Care");
  });

  it("skips a client already on autopay, or invited in the last week", async () => {
    const db = world();
    expect(await invite(db, { clientId: PAT })).toEqual({ sent: false, detail: "Skipped: already on autopay" });
    db.tables.messages!.push({ company_id: CO, client_id: ROBIN, related_type: "autopay", direction: "out", external_id: "em_0", created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    expect(await invite(db, { skipIfRecentDays: 7 })).toEqual({ sent: false, detail: "Skipped: invited in the last 7 days" });
    // Without the automation's window, the office can send it again.
    expect((await invite(db)).sent).toBe(true);
    // The copy of an agreement they made isn't an invite.
    const fresh = world();
    fresh.tables.messages!.push({ company_id: CO, client_id: ROBIN, related_type: "autopay", direction: "out", external_id: "autopay:agreed:x", created_at: new Date().toISOString() });
    expect((await invite(fresh, { skipIfRecentDays: 7 })).sent).toBe(true);
    expect(m.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("says what's in the way", async () => {
    await expect(invite(world({ settings: { autopay: autopaySetting({ enabled: false }) } }))).rejects.toThrow("Turn on autopay in Settings → Payments first.");
    m.stripeCapabilities.mockResolvedValueOnce({ ...CAPS, autopay: false });
    await expect(invite(world())).rejects.toThrow("Update your Stripe key on the Apps page.");
    expect(m.stripeCapabilities).toHaveBeenLastCalledWith(env, expect.anything(), CO, { cached: true });
    await expect(invite(world(), { baseUrl: null })).rejects.toThrow("Set APP_URL so links can go out.");
    await expect(invite(world(), { clientId: SAM })).rejects.toThrow("This client has no email address.");
    await expect(invite(world(), { channel: "sms" })).rejects.toThrow("This client has no mobile number.");
    m.smsConfigured.mockReturnValue(false);
    await expect(invite(world(), { clientId: SAM, channel: "sms" })).rejects.toThrow("Texting isn't set up.");
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("sends by text, and never to another company's client", async () => {
    const db = world();
    expect(await invite(db, { clientId: SAM, channel: "sms" })).toEqual({ sent: true, detail: "Sent by text." });
    expect(texts()[0]!.body).toMatch(/^Radford Lawn Care: thanks for choosing us\. We keep a card on file and charge it after each visit\. Save yours securely with Stripe: https:\/\/ops\.example\.com\/hub\/\S+\?view=autopay$/);
    expect(await payloadOf(hubLinks(db.tables.messages![0]!.body)[0]!)).toMatchObject({ t: "client", id: SAM, via: "office" });
    expect(await invite(db, { clientId: STRANGER })).toEqual({ sent: false, detail: "Client not found." });
    expect(m.sendSms).toHaveBeenCalledTimes(1);
  });
  it("doesn't text a client who texted STOP, and keeps it when Twilio says they did", async () => {
    const db = world();
    db.tables.clients!.find((c) => c.id === SAM)!.sms_opt_out_at = "2026-10-01T12:00:00.000Z";
    expect(await invite(db, { clientId: SAM, channel: "sms" })).toEqual({ sent: false, detail: "Skipped: Sam Ortiz texted STOP, so texts to them are off." });
    expect(m.sendSms).not.toHaveBeenCalled();
    // Twilio refusing a number that texted STOP: the client is marked, so nothing texts them again.
    const fresh = world();
    m.sendSms.mockResolvedValueOnce({ sent: false, reason: "The text provider refused it (400).", code: 21610 });
    await expect(invite(fresh, { clientId: SAM, channel: "sms" })).rejects.toThrow("The text provider refused it (400).");
    expect(typeof fresh.tables.clients!.find((c) => c.id === SAM)!.sms_opt_out_at).toBe("string");
  });
});

// ---------------------------------------------------------------------------------------------
// The Client Hub
// ---------------------------------------------------------------------------------------------

describe("the Client Hub's autopay", () => {
  it("is only there when the company takes it: on in Settings and a key that can save cards", async () => {
    expect(await autopayAvailable(env, world().db, CO)).toBe(true);
    expect(await autopayAvailable(env, world({ settings: { autopay: autopaySetting({ enabled: false }) } }).db, CO)).toBe(false);
    expect(await hubAutopay(env, world({ settings: { autopay: undefined } }).db, CO, ROBIN)).toBeNull();
    m.stripeCapabilities.mockResolvedValue({ ...CAPS, own: false, autopay: false });
    expect(await autopayAvailable(env, world().db, CO)).toBe(false);
    expect(await hubAutopay(env, world().db, CO, ROBIN)).toBeNull();
    // Stored state only, never Stripe.
    for (const call of m.stripeCapabilities.mock.calls) expect(call[3]).toEqual({ cached: true });
  });

  it("still shows a client with an agreement in force their autopay while the business can't take it, so they can turn it off", async () => {
    const on = { status: "active", method: { id: CARD, label: "Visa ending 4242" }, since: "2026-10-31T14:10:00Z" };
    expect(await hubAutopay(env, world().db, CO, PAT)).toMatchObject({ ...on, available: true });
    // Switched off in Settings → Payments.
    expect(await hubAutopay(env, world({ settings: { autopay: autopaySetting({ enabled: false }) } }).db, CO, PAT)).toMatchObject({ ...on, available: false });
    // A key that can't charge cards any more.
    m.stripeCapabilities.mockResolvedValue({ ...CAPS, autopay: false });
    expect(await hubAutopay(env, world().db, CO, PAT)).toMatchObject({ ...on, available: false });
    // Paused by the office, it says so.
    const db = world();
    db.tables.autopay_authorizations![0]!.paused_at = "2026-11-02T12:00:00Z";
    expect(await hubAutopay(env, db.db, CO, PAT)).toMatchObject({ status: "paused", available: false });
    // Turned off: nothing to show then.
    Object.assign(db.tables.autopay_authorizations![0]!, { revoked_at: "2026-11-03T12:00:00Z", revoked_via: "client" });
    expect(await hubAutopay(env, db.db, CO, PAT)).toBeNull();
  });

  it("shows a client on autopay their card, since when, the price of a visit and the next charge", async () => {
    const db = world();
    db.tables.autopay_charges!.push({ id: id(45), company_id: CO, client_id: PAT, job_id: JOB, invoice_id: null, status: "waiting", due_at: "2026-11-08T05:00:00Z" });
    expect(await hubAutopay(env, db.db, CO, PAT)).toEqual({
      status: "active",
      method: { id: CARD, type: "card", label: "Visa ending 4242", exp: "08/28" },
      imported: false,
      since: "2026-10-31T14:10:00Z",
      terms: TERMS,
      terms_version: "2026-10-31T14:05:09",
      timing: "at the end of the day of each visit",
      next_charge: "2026-11-08T05:00:00Z",
      per_visit: 45,
      per_visit_taxed: false,
      available: true,
      card_required: false,
    });
    // A business that needs a card on file says so on the client's page.
    db.tables.companies![0]!.settings = { autopay: autopaySetting({ card_required: true }) };
    expect((await hubAutopay(env, db.db, CO, PAT))!.card_required).toBe(true);
  });

  it("says tax goes on top of the price of a visit when a line is taxable and the rate is above 0", async () => {
    const QUOTE = id(65);
    const taxed = async (lines: Row[], values: { rate?: unknown; quote?: Row | null } = {}) => {
      const db = world({ settings: values.rate === undefined ? {} : { default_tax_rate: values.rate }, tables: { job_line_items: lines.map((l) => ({ company_id: CO, job_id: JOB, quantity: 1, unit_price: 45, ...l })) } });
      if (values.quote) {
        db.tables.jobs![0]!.quote_id = QUOTE;
        db.tables.quotes = [{ id: QUOTE, company_id: CO, ...values.quote }];
      }
      return hubAutopay(env, db.db, CO, PAT);
    };
    // The company's rate, for a job without a quote.
    expect(await taxed([{ taxable: true }], { rate: 0.08 })).toMatchObject({ per_visit: 45, per_visit_taxed: true });
    expect(await taxed([{ taxable: true }], { rate: "0.0575" })).toMatchObject({ per_visit_taxed: true });
    expect(await taxed([{ taxable: true }], { rate: 0 })).toMatchObject({ per_visit: 45, per_visit_taxed: false });
    expect(await taxed([{ taxable: true }])).toMatchObject({ per_visit_taxed: false });
    expect(await taxed([{ taxable: false }], { rate: 0.08 })).toMatchObject({ per_visit_taxed: false });
    expect(await taxed([{ taxable: false }, { taxable: true, unit_price: 5 }], { rate: 0.08 })).toMatchObject({ per_visit: 50, per_visit_taxed: true });
    // The rate the client approved on the quote wins over the company's; a quote without one leaves it.
    expect(await taxed([{ taxable: true }], { rate: 0.08, quote: { tax_rate: 0 } })).toMatchObject({ per_visit_taxed: false });
    expect(await taxed([{ taxable: true }], { rate: 0, quote: { tax_rate: 0.07 } })).toMatchObject({ per_visit_taxed: true });
    expect(await taxed([{ taxable: true }], { rate: 0.08, quote: { tax_rate: null } })).toMatchObject({ per_visit_taxed: true });
    // No price, nothing to say tax about.
    expect(await taxed([], { rate: 0.08 })).toMatchObject({ per_visit: null, per_visit_taxed: false });
  });

  it("tells paused, a bank account being checked, and a card that needs updating apart", async () => {
    let db = world();
    db.tables.autopay_authorizations![0]!.paused_at = "2026-11-02T12:00:00Z";
    expect((await hubAutopay(env, db.db, CO, PAT))!.status).toBe("paused");
    db = world({ tables: { client_payment_methods: [card(CARD, PAT, { type: "us_bank_account", brand: null, bank_name: "Chase", last4: "6789", status: "pending" })] } });
    expect(await hubAutopay(env, db.db, CO, PAT)).toMatchObject({ status: "pending", method: { label: "Chase ending 6789" } });
    for (const status of ["needs_update", "removed"]) {
      db = world({ tables: { client_payment_methods: [card(CARD, PAT, { status })] } });
      expect(await hubAutopay(env, db.db, CO, PAT)).toMatchObject({ status: "needs_update", method: { label: "Visa ending 4242" } });
    }
  });

  it("is off after the client turned it off with the card still saved, until they save another", async () => {
    const db = world();
    Object.assign(db.tables.autopay_authorizations![0]!, { revoked_at: "2026-11-02T12:00:00Z", revoked_via: "client" });
    expect(await hubAutopay(env, db.db, CO, PAT)).toMatchObject({ status: "off", method: null, since: null });
    db.tables.client_payment_methods!.push(card(NEW_CARD, PAT, { is_default: false, last4: "1881", created_at: "2026-11-03T09:00:00Z" }));
    expect(await hubAutopay(env, db.db, CO, PAT)).toMatchObject({ status: "agree", method: { id: NEW_CARD, label: "Visa ending 1881" } });
    expect(await autopayOffered(env, db.db, CO, PAT)).toBe(true);
  });

  it("offers one-tap confirming of a card from Stripe, but not on a link the office copied", async () => {
    const db = world({ tables: { client_payment_methods: [card(IMPORTED, ROBIN, { source: "stripe_import" })] } });
    expect(await hubAutopay(env, db.db, CO, ROBIN)).toMatchObject({ status: "agree", imported: true, method: { id: IMPORTED } });
    // The office's copy can't say yes to it, so it isn't offered: it reads as off, and leads to Stripe's page.
    expect(await hubAutopay(env, db.db, CO, ROBIN, { trust: "office" })).toMatchObject({ status: "off", method: null, imported: false });
    // Its recurring job would be charged once they agree (jobs_default), so its price shows.
    expect(await hubAutopay(env, world().db, CO, ROBIN)).toMatchObject({ status: "off", method: null, per_visit: null });
    expect(await autopayOffered(env, db.db, CO, PAT)).toBe(false);
  });

  it("offers the office's copy of the link only a card saved on Stripe's page through an office copy", async () => {
    // Saved on the client's own link, and they left before agreeing.
    const db = world({ tables: { client_payment_methods: [card(NEW_CARD, ROBIN)] } });
    expect(await hubAutopay(env, db.db, CO, ROBIN)).toMatchObject({ status: "agree", method: { id: NEW_CARD } });
    expect(await hubAutopay(env, db.db, CO, ROBIN, { trust: "office" })).toMatchObject({ status: "off", method: null });
    // One saved through an office copy is offered there, ahead of the client's.
    db.tables.client_payment_methods!.push(card(CARD, ROBIN, { saved_via: "office", is_default: false, last4: "1881", created_at: "2026-10-30T09:00:00Z" }));
    expect(await hubAutopay(env, db.db, CO, ROBIN, { trust: "office" })).toMatchObject({ status: "agree", method: { id: CARD, label: "Visa ending 1881" } });
    // A card already agreed to shows as it is, whichever link it's seen on.
    expect(await hubAutopay(env, world().db, CO, PAT, { trust: "office" })).toMatchObject({ status: "active", method: { id: CARD } });
  });

  it("offers a link from before the mark a card saved through one like it or an office copy, and never offers the office's copy one saved through it", async () => {
    // Saved from an old invoice email's link, and they left Stripe's page before agreeing.
    const db = world({ tables: { client_payment_methods: [card(NEW_CARD, ROBIN, { saved_via: "legacy" })] } });
    expect(await hubAutopay(env, db.db, CO, ROBIN, { trust: "legacy" })).toMatchObject({ status: "agree", method: { id: NEW_CARD } });
    expect(await hubAutopay(env, db.db, CO, ROBIN, { trust: "office" })).toMatchObject({ status: "off", method: null });
    expect(await hubAutopay(env, db.db, CO, ROBIN)).toMatchObject({ status: "agree", method: { id: NEW_CARD } });
    // Saved through an office copy (or before old links were their own kind): an old link still can.
    const office = world({ tables: { client_payment_methods: [card(CARD, ROBIN, { saved_via: "office" })] } });
    expect(await hubAutopay(env, office.db, CO, ROBIN, { trust: "legacy" })).toMatchObject({ status: "agree", method: { id: CARD } });
    // One the client saved on their own link, or one from Stripe: not on an old link, and never one tap.
    const own = world({ tables: { client_payment_methods: [card(NEW_CARD, ROBIN), card(IMPORTED, ROBIN, { source: "stripe_import", is_default: false })] } });
    expect(await hubAutopay(env, own.db, CO, ROBIN, { trust: "legacy" })).toMatchObject({ status: "off", method: null, imported: false });
  });

  it("says on an invoice it was paid automatically, and offers the tip only when the tip would go through", async () => {
    const invoice = { id: INVOICE, client_id: PAT, balance_due: 0, status: "paid" };
    const options = { tips: true, preview: false, imported: false, trust: "client" as const };
    let db = world();
    expect(await hubInvoiceAutopay(env, db.db, CO, invoice, options)).toEqual({
      autopay: { status: "paid", method: "Visa ending 4242", charged_at: "2026-11-01T04:02:00Z" },
      save_card: false,
      tip_after: true,
      tip_method: "Visa ending 4242",
    });
    // Tips off (core tipsAllowed, worked out by the Hub route), a preview, a link that counts as the office's.
    for (const other of [{ tips: false }, { preview: true }, { trust: "office" as const }]) {
      expect(await hubInvoiceAutopay(env, db.db, CO, invoice, { ...options, ...other })).toMatchObject({ tip_after: false, tip_method: null });
    }
    // A tip already, autopay turned off since, a bank account.
    db.tables.payments!.push({ company_id: CO, invoice_id: INVOICE, amount: 0, tip_amount: 6.75, processor: "stripe" });
    expect((await hubInvoiceAutopay(env, db.db, CO, invoice, options)).tip_after).toBe(false);
    db = world();
    db.tables.autopay_authorizations![0]!.revoked_at = "2026-11-02T00:00:00Z";
    expect((await hubInvoiceAutopay(env, db.db, CO, invoice, options)).tip_after).toBe(false);
    db = world({ tables: { client_payment_methods: [card(CARD, PAT, { type: "us_bank_account", brand: null, bank_name: "Chase" })] } });
    expect((await hubInvoiceAutopay(env, db.db, CO, invoice, options)).tip_after).toBe(false);
  });

  it("doesn't name the card or offer a tip when credit the client had in Stripe paid it all", async () => {
    const db = world();
    db.tables.autopay_charges![0]!.charged_amount = 0;
    const options = { tips: true, preview: false, imported: false, trust: "client" as const };
    expect(await hubInvoiceAutopay(env, db.db, CO, { id: INVOICE, client_id: PAT, balance_due: 0, status: "paid" }, options)).toEqual({
      autopay: { status: "paid", method: null, charged_at: "2026-11-01T04:02:00Z" }, save_card: false, tip_after: false, tip_method: null,
    });
  });

  it("says nothing of a charge being tried again on the card the client agreed to since, as for one waiting", async () => {
    const db = world();
    Object.assign(db.tables.autopay_charges![0]!, { status: "failed", failures: 0, charged_amount: null, charged_at: null, payment_method_id: NEW_CARD });
    const options = { tips: true, preview: false, imported: false, trust: "client" as const };
    const invoice = { id: INVOICE, client_id: PAT, balance_due: 45, status: "sent" };
    expect((await hubInvoiceAutopay(env, db.db, CO, invoice, options)).autopay).toBeNull();
    // Declined on it: said as usual.
    db.tables.autopay_charges![0]!.failures = 1;
    expect((await hubInvoiceAutopay(env, db.db, CO, invoice, options)).autopay).toMatchObject({ status: "failed" });
  });

  it("no longer says an invoice was paid automatically once it's owed again (refunded, kept on it or written off)", async () => {
    const options = { tips: true, preview: false, imported: false, trust: "client" as const };
    for (const status of ["sent", "written_off"]) {
      const db = world();
      expect(await hubInvoiceAutopay(env, db.db, CO, { id: INVOICE, client_id: PAT, balance_due: 45, status }, options)).toEqual({ autopay: null, save_card: false, tip_after: false, tip_method: null });
    }
  });

  it("offers to save the card after paying by hand, to a client with none", async () => {
    const db = world({ tables: { client_payment_methods: [], autopay_authorizations: [], autopay_charges: [] } });
    const invoice = { id: INVOICE, client_id: ROBIN, balance_due: 0, status: "paid" };
    const options = { tips: true, preview: false, imported: false, trust: "client" as const };
    expect(await hubInvoiceAutopay(env, db.db, CO, invoice, options)).toEqual({ autopay: null, save_card: true, tip_after: false, tip_method: null });
    expect((await hubInvoiceAutopay(env, db.db, CO, invoice, { ...options, imported: true })).save_card).toBe(false);
    expect((await hubInvoiceAutopay(env, db.db, CO, invoice, { ...options, preview: true })).save_card).toBe(false);
    expect((await hubInvoiceAutopay(env, world().db, CO, { ...invoice, client_id: PAT }, options)).save_card).toBe(false);
  });

  it("sends the client to Stripe's page and back to their own autopay view", async () => {
    m.stripeSetupSession.mockResolvedValue("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(await startAutopaySetup(env, world().db, { companyId: CO, clientId: ROBIN, home: "https://ops.example.com/hub/tok", trust: "client" })).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const urls = { successUrl: "https://ops.example.com/hub/tok?view=autopay&session_id={CHECKOUT_SESSION_ID}", cancelUrl: "https://ops.example.com/hub/tok?view=autopay" };
    expect(m.stripeSetupSession).toHaveBeenCalledWith(env, expect.anything(), CO, ROBIN, urls, "client");
    // From a link that counts as the office's, the card is saved as one saved through it.
    await startAutopaySetup(env, world().db, { companyId: CO, clientId: ROBIN, home: "https://ops.example.com/hub/tok", trust: "office" });
    expect(m.stripeSetupSession).toHaveBeenLastCalledWith(env, expect.anything(), CO, ROBIN, urls, "office");
    // From a link from before the mark, as one saved through such a link.
    await startAutopaySetup(env, world().db, { companyId: CO, clientId: ROBIN, home: "https://ops.example.com/hub/tok", trust: "legacy" });
    expect(m.stripeSetupSession).toHaveBeenLastCalledWith(env, expect.anything(), CO, ROBIN, urls, "legacy");
    await expect(startAutopaySetup(env, world({ settings: { autopay: autopaySetting({ enabled: false }) } }).db, { companyId: CO, clientId: ROBIN, home: "x", trust: "client" })).rejects.toThrow(
      "Autopay isn't available right now. Contact us to set it up.",
    );
  });
});

describe("agreeing to autopay", () => {
  const confirm = (db: ReturnType<typeof world>, values: Partial<Parameters<typeof confirmAutopay>[2]> = {}) =>
    confirmAutopay(env, db.db, {
      companyId: CO, clientId: ROBIN, paymentMethodId: IMPORTED, termsVersion: "2026-10-31T14:05:09", ip: "203.0.113.7", userAgent: "Mozilla/5.0", linkKind: "client", via: "client", trust: "client", ...values,
    });

  it("records the agreement with how it was made, and makes the card Stripe's default for the customer", async () => {
    const db = world({ tables: { client_payment_methods: [card(IMPORTED, ROBIN, { source: "stripe_import", stripe_payment_method_id: "pm_imported", stripe_customer_id: "cus_robin" })] } });
    expect(await confirm(db)).toEqual({ status: "active", method: "Visa ending 4242" });
    expect(db.called("autopay_record_authorization")).toEqual([
      { p_company: CO, p_client: ROBIN, p_payment_method: IMPORTED, p_source: "confirmed", p_terms_version: "2026-10-31T14:05:09", p_ip: "203.0.113.7", p_user_agent: "Mozilla/5.0", p_link_kind: "client", p_link_via: "client" },
    ]);
    expect(stripeCalls).toEqual([
      { method: "POST", url: "https://api.stripe.com/v1/customers/cus_robin", body: "invoice_settings%5Bdefault_payment_method%5D=pm_imported", key: "crewtavo-default-pm_imported" },
    ]);
    expect(m.detachPaymentMethod).not.toHaveBeenCalled();
  });

  it("can't confirm a card from Stripe on a link the office copied", async () => {
    const db = world({ tables: { client_payment_methods: [card(IMPORTED, ROBIN, { source: "stripe_import" })] } });
    await expect(confirm(db, { via: "office", trust: "office" })).rejects.toMatchObject({ status: 403, message: "Use the autopay link we sent you to confirm." });
    expect(db.called("autopay_record_authorization")).toEqual([]);
    // A card saved on Stripe's page through an office copy is the client's own doing, so it's kept with the link's kind.
    db.tables.client_payment_methods!.push(card(NEW_CARD, ROBIN, { saved_via: "office" }));
    await confirm(db, { via: "office", trust: "office", paymentMethodId: NEW_CARD, linkKind: "quote" });
    expect(db.called("autopay_record_authorization")[0]).toMatchObject({ p_source: "hub", p_link_kind: "quote", p_link_via: "office" });
  });

  it("can't confirm on a link the office copied a card the client saved on their own link and never agreed to", async () => {
    // They saved it on Stripe's page and closed the tab before ticking the box.
    const db = world({ tables: { client_payment_methods: [card(NEW_CARD, ROBIN)] } });
    await expect(confirm(db, { via: "office", trust: "office", paymentMethodId: NEW_CARD })).rejects.toMatchObject({ status: 403, message: "Use the autopay link we sent you to confirm." });
    expect(db.called("autopay_record_authorization")).toEqual([]);
    expect(stripeCalls).toEqual([]);
    // Their own link still can.
    await confirm(db, { paymentMethodId: NEW_CARD });
    expect(db.called("autopay_record_authorization")).toEqual([expect.objectContaining({ p_payment_method: NEW_CARD, p_source: "hub", p_link_via: "client" })]);
  });

  it("on a link from before the client's own were marked, says yes only to a card saved through one like it, and records it as the client's", async () => {
    // A card from Stripe, or one saved on the client's own link: one tap from such a link isn't enough.
    const db = world({ tables: { client_payment_methods: [card(IMPORTED, ROBIN, { source: "stripe_import" }), card(CARD, ROBIN, { is_default: false })] } });
    await expect(confirm(db, { via: "client", trust: "legacy" })).rejects.toMatchObject({ status: 403, message: "Use the autopay link we sent you to confirm." });
    await expect(confirm(db, { via: "client", trust: "legacy", paymentMethodId: CARD })).rejects.toMatchObject({ status: 403 });
    expect(db.called("autopay_record_authorization")).toEqual([]);
    // Through Stripe's page it works as before (the card is saved as such a link saves it), kept as the client's link.
    db.tables.client_payment_methods!.push(card(NEW_CARD, ROBIN, { saved_via: "legacy" }));
    await confirm(db, { via: "client", trust: "legacy", paymentMethodId: NEW_CARD });
    expect(db.called("autopay_record_authorization")).toEqual([expect.objectContaining({ p_payment_method: NEW_CARD, p_source: "hub", p_link_via: "client" })]);
    // One saved through such a link before they were their own kind was kept as the office's: still fine.
    const before = world({ tables: { client_payment_methods: [card(NEW_CARD, ROBIN, { saved_via: "office" })] } });
    await confirm(before, { via: "client", trust: "legacy", paymentMethodId: NEW_CARD });
    expect(before.called("autopay_record_authorization")).toHaveLength(1);
  });

  it("can't confirm on a link the office copied a card the client saved on an old link and left before agreeing to", async () => {
    const db = world({ tables: { client_payment_methods: [card(NEW_CARD, ROBIN, { saved_via: "legacy" })] } });
    await expect(confirm(db, { via: "office", trust: "office", paymentMethodId: NEW_CARD })).rejects.toMatchObject({ status: 403, message: "Use the autopay link we sent you to confirm." });
    expect(db.called("autopay_record_authorization")).toEqual([]);
    expect(stripeCalls).toEqual([]);
    // The old link, and the client's own, can.
    await confirm(db, { via: "client", trust: "legacy", paymentMethodId: NEW_CARD });
    await confirm(db, { paymentMethodId: NEW_CARD });
    expect(db.called("autopay_record_authorization")).toHaveLength(2);
  });

  it("takes off the card it replaces, which detachPaymentMethod leaves in Stripe when it came from there", async () => {
    const db = world({ tables: { client_payment_methods: [card(IMPORTED, PAT, { source: "stripe_import" }), card(NEW_CARD, PAT, { is_default: false })] } });
    db.tables.autopay_authorizations![0]!.payment_method_id = IMPORTED;
    await confirm(db, { clientId: PAT, paymentMethodId: NEW_CARD });
    expect(m.detachPaymentMethod).toHaveBeenCalledWith(env, db.db, CO, IMPORTED, "replaced");
    // The only Stripe call made here is the customer's default; detaching is integrations/stripe.ts's.
    expect(stripeCalls.map((c) => c.url)).toEqual(["https://api.stripe.com/v1/customers/cus_pat"]);
  });

  it("answers the database's refusals as the client should read them", async () => {
    const db = world({ tables: { client_payment_methods: [card(NEW_CARD, ROBIN)] } });
    db.handlers.autopay_record_authorization = () => ({ error: { code: "22023", message: "The terms changed. Read them again and agree" } });
    await expect(confirm(db, { paymentMethodId: NEW_CARD })).rejects.toMatchObject({ status: 409, message: "The terms changed. Read them again and agree." });
    await expect(confirm(db, { paymentMethodId: CARD })).rejects.toMatchObject({ status: 404, message: "That card isn't saved anymore." });
    expect(stripeCalls).toEqual([]);
  });

  it("is turned off by the client from their page", async () => {
    const db = world();
    await turnOffAutopay(db.db, { companyId: CO, clientId: PAT, via: "client", userId: null });
    expect(db.called("autopay_revoke")).toEqual([{ p_company: CO, p_client: PAT, p_via: "client" }]);
  });
});

describe("a tip on the saved card", () => {
  const tip = (db: ReturnType<typeof world>, amount = 6.75) => tipOnSavedCard(env, db.db, { companyId: CO, invoiceId: INVOICE, tip: amount, ip: "203.0.113.7", userAgent: "Mozilla/5.0" });

  it("is refused when tips are off, before anything is charged", async () => {
    for (const settings of [{ hub_tips: false }, { hub_tips: undefined }]) {
      await expect(tip(world({ settings }))).rejects.toMatchObject({ status: 409, message: "Tips are turned off." });
    }
    m.hubPayment.mockResolvedValue({ enabled: true, processing: false, imported: true });
    await expect(tip(world())).rejects.toMatchObject({ status: 409, message: "Tips are turned off." });
    expect(m.chargeTip).not.toHaveBeenCalled();
    expect(stripeCalls).toEqual([]);
  });

  it("goes on the card that paid it, with the client's IP, and is noted on the invoice", async () => {
    const db = world();
    expect(await tip(db)).toEqual({ status: "paid", tip: 6.75 });
    expect(m.chargeTip).toHaveBeenCalledWith(env, db.db, CO, INVOICE, 675, { id: CARD, stripe_payment_method_id: "pm_0020", stripe_customer_id: "cus_pat", livemode: true, stripe_account: "acct_1", type: "card" }, {
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0",
    });
    expect(db.tables.messages![0]).toMatchObject({ channel: "note", related_type: "invoice", related_id: INVOICE, external_id: `autopay:tip:${INVOICE}`, body: "Tip of $6.75 added from the client page (IP 203.0.113.7)." });
  });

  it("is refused before it's paid, without a card that paid it, and once a tip is on", async () => {
    let db = world();
    Object.assign(db.tables.invoices![0]!, { balance_due: 45, status: "sent" });
    await expect(tip(db)).rejects.toMatchObject({ status: 409, message: "Pay the invoice first." });
    // Paid by check: no autopay charge paid it.
    db = world({ tables: { autopay_charges: [] } });
    await expect(tip(db)).rejects.toMatchObject({ status: 409, message: "There's no saved card to add a tip to." });
    // Autopay turned off, or paused, since.
    db = world();
    db.tables.autopay_authorizations![0]!.revoked_at = "2026-11-02T00:00:00Z";
    await expect(tip(db)).rejects.toMatchObject({ message: "There's no saved card to add a tip to." });
    db = world();
    db.tables.autopay_authorizations![0]!.paused_at = "2026-11-02T00:00:00Z";
    await expect(tip(db)).rejects.toMatchObject({ message: "There's no saved card to add a tip to." });
    db = world({ settings: { autopay: autopaySetting({ enabled: false }) } });
    await expect(tip(db)).rejects.toMatchObject({ message: "There's no saved card to add a tip to." });
    // A tip already going through, or one booked.
    db = world();
    db.tables.stripe_invoices!.push({ id: id(83), company_id: CO, invoice_id: INVOICE, purpose: "tip", status: "open" });
    await expect(tip(db)).rejects.toMatchObject({ status: 409, message: "A tip was already added. Thank you." });
    db = world();
    db.tables.payments!.push({ company_id: CO, invoice_id: INVOICE, amount: 0, tip_amount: 5, processor: "stripe" });
    await expect(tip(db)).rejects.toMatchObject({ message: "A tip was already added. Thank you." });
    // More than the invoice.
    await expect(tip(world(), 45.01)).rejects.toMatchObject({ status: 400, message: "A tip can be up to the invoice total." });
    expect(m.chargeTip).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Settings → Payments
// ---------------------------------------------------------------------------------------------

describe("the payments status", () => {
  it("says what the key can do, fills in the settings, and counts clients with a card from Stripe to bring over", async () => {
    const db = world({
      settings: { hub_tips: false, autopay: undefined },
      tables: {
        client_payment_methods: [
          card(CARD, PAT, { source: "stripe_import" }),
          card(IMPORTED, ROBIN, { source: "stripe_import" }),
          card(NEW_CARD, ROBIN, { source: "stripe_import", is_default: false }),
          card(BANK, DREW, { source: "stripe_import", status: "removed" }),
        ],
      },
    });
    m.stripeCapabilities.mockResolvedValue({ ...CAPS, refunds: false });
    const status = await autopayStatus(env, db.db, CO);
    expect(status).toMatchObject({ connected: true, own: true, can_autopay: true, can_refund: false, tips: false, stripe_cards: 1 });
    expect(status.settings).toMatchObject({ enabled: false, terms: starterAutopayTerms("lawn_exterior"), timing: "end_of_day", max_amount: 500, jobs_default: true });
    // Not the cached state: a new key's permissions show here.
    expect(m.stripeCapabilities).toHaveBeenCalledWith(env, db.db, CO);
  });
});

// ---------------------------------------------------------------------------------------------
// The office's routes
// ---------------------------------------------------------------------------------------------

describe("the office's autopay routes", () => {
  const request = (user: string, method: string, path: string, body?: unknown) =>
    app.request(
      `/api${path}`,
      { method, headers: { Authorization: `Bearer ${user}`, "X-Company-Id": CO, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      env,
    );
  const SETTINGS = { enabled: true, terms: TERMS, timing: "days", days: 2, max_amount: 250, receipts: true, jobs_default: false, card_required: true };

  it("are for the office with the invoices area; crews and estimators are turned away", async () => {
    const db = world();
    for (const user of ["estimator-1", "crew-1", "lead-1"]) {
      for (const [method, path, body] of [
        ["GET", "/autopay/status"],
        ["PUT", "/autopay/settings", SETTINGS],
        ["POST", `/clients/${ROBIN}/autopay/invite`, { channel: "email" }],
        ["POST", `/payments/${PAYMENT}/refund`, { amount: 10 }],
        ["POST", `/autopay/charges/${CHARGE}/approve`, {}],
        ["POST", "/invoices/charge", { invoice_ids: [INVOICE] }],
        ["GET", "/invoices/chargeable"],
        ["GET", `/invoices/${INVOICE}/charge`],
      ] as const) {
        expect((await request(user, method, path, body)).status).toBe(403);
      }
    }
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.refundStripePayment).not.toHaveBeenCalled();
    expect(db.called("request_manual_charges")).toEqual([]);
    expect((await request("office-1", "GET", "/autopay/status")).status).toBe(200);
    // Settings and vouching are for fewer.
    expect((await request("office-1", "PUT", "/autopay/settings", SETTINGS)).status).toBe(403);
    expect((await request("admin-1", "POST", "/clients/autopay/vouch", { client_ids: [ROBIN], terms_version: "v" })).status).toBe(403);
  });

  it("won't turn autopay on without a key that can save cards, and brings the webhook up to date when it does", async () => {
    let db = world({ settings: { autopay: autopaySetting({ enabled: false }) } });
    m.stripeCapabilities.mockResolvedValue({ ...CAPS, autopay: false });
    const refused = await request("admin-1", "PUT", "/autopay/settings", SETTINGS);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "Update your Stripe key on the Apps page to turn on autopay." });
    expect(db.called("autopay_set_settings")).toEqual([]);
    // Saving it off is fine.
    expect((await request("admin-1", "PUT", "/autopay/settings", { ...SETTINGS, enabled: false })).status).toBe(200);

    db = world({ settings: { autopay: autopaySetting({ enabled: false }) } });
    m.stripeCapabilities.mockResolvedValue(CAPS);
    db.handlers.autopay_set_settings = (args) => ({ data: { ...args.p_settings, terms_version: "2026-11-01T10:00:00", changed_at: "2026-11-01T10:00:00Z", changed_by: "admin-1" } });
    const res = await request("admin-1", "PUT", "/autopay/settings", SETTINGS);
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({ enabled: true, timing: "days", days: 2, max_amount: 250, terms_version: "2026-11-01T10:00:00" });
    expect(db.called("autopay_set_settings")).toEqual([{ p_company: CO, p_settings: SETTINGS }]);
    expect(m.refreshStripeWebhook).toHaveBeenCalledWith(env, expect.anything(), CO);
    // Days only go with "days after".
    await request("admin-1", "PUT", "/autopay/settings", { ...SETTINGS, timing: "now" });
    expect(db.called("autopay_set_settings").at(-1)!.p_settings).toMatchObject({ timing: "now", days: null });
    expect((await request("admin-1", "PUT", "/autopay/settings", { ...SETTINGS, days: null })).status).toBe(400);
    expect((await request("admin-1", "PUT", "/autopay/settings", { ...SETTINGS, max_amount: 0 })).status).toBe(400);
    expect((await request("admin-1", "PUT", "/autopay/settings", { ...SETTINGS, card_required: undefined })).status).toBe(400);
  });

  it("invites one client, and answers what's in the way as a 409", async () => {
    world();
    const res = await request("office-1", "POST", `/clients/${ROBIN}/autopay/invite`, { channel: "email" });
    expect(await res.json()).toEqual({ sent: true, detail: "Sent by email." });
    const missing = await request("office-1", "POST", `/clients/${SAM}/autopay/invite`, { channel: "email" });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "This client has no email address." });
  });

  it("invites many, never another company's clients, counting only those it sends against the hourly limit", async () => {
    const db = world();
    db.hits.set(`autopay-invite:${CO}`, 198);
    const res = await request("office-1", "POST", "/clients/autopay/invite", { client_ids: [PAT, STRANGER, ROBIN, DREW, SAM], channel: "email" });
    const body = await res.json();
    expect(body).toEqual({
      sent: 2,
      skipped: 3,
      details: [
        { client_id: PAT, detail: "Skipped: already on autopay" },
        { client_id: STRANGER, detail: "Client not found." },
        { client_id: ROBIN, detail: "Sent by email." },
        { client_id: DREW, detail: "Sent by email." },
        { client_id: SAM, detail: "This client has no email address." },
      ],
    });
    expect(emails().map((e) => e.to)).toEqual(["robin@example.com", "drew@example.com"]);
    expect(db.called("rate_limit_hit").filter((a) => a.p_key === `autopay-invite:${CO}`)).toHaveLength(2);

    // Past the limit, the rest are skipped and nothing more is counted.
    m.sendEmail.mockClear();
    const fresh = world();
    fresh.hits.set(`autopay-invite:${CO}`, 199);
    const limited = await (await request("office-1", "POST", "/clients/autopay/invite", { client_ids: [ROBIN, DREW, PAT], channel: "email" })).json();
    expect(limited).toEqual({
      sent: 1,
      skipped: 2,
      details: [
        { client_id: ROBIN, detail: "Sent by email." },
        { client_id: DREW, detail: "Skipped: too many invites this hour" },
        { client_id: PAT, detail: "Skipped: too many invites this hour" },
      ],
    });
    expect(fresh.called("rate_limit_hit").filter((a) => a.p_key === `autopay-invite:${CO}`)).toHaveLength(2);

    // What only the company can fix is said once.
    world({ settings: { autopay: autopaySetting({ enabled: false }) } });
    const off = await request("office-1", "POST", "/clients/autopay/invite", { client_ids: [ROBIN, DREW], channel: "email" });
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: "Turn on autopay in Settings → Payments first." });
  });

  it("removes a card, and turns autopay off when it's the card the agreement names", async () => {
    let db = world({ tables: { client_payment_methods: [card(CARD, PAT), card(NEW_CARD, PAT, { is_default: false })] } });
    expect((await request("office-1", "POST", `/clients/${PAT}/autopay/remove-card`, { payment_method_id: NEW_CARD })).status).toBe(200);
    expect(m.detachPaymentMethod).toHaveBeenLastCalledWith(env, db.db, CO, NEW_CARD, "office");
    expect(db.called("autopay_revoke")).toEqual([]);
    expect((await request("office-1", "POST", `/clients/${PAT}/autopay/remove-card`, { payment_method_id: CARD })).status).toBe(200);
    expect(db.called("autopay_revoke")).toEqual([{ p_company: CO, p_client: PAT, p_via: "office", p_by: "office-1" }]);
    // Only this client's cards, of this company.
    db = world();
    const wrong = await request("office-1", "POST", `/clients/${ROBIN}/autopay/remove-card`, { payment_method_id: CARD });
    expect(wrong.status).toBe(404);
    expect(await wrong.json()).toEqual({ error: "Card not found." });
    expect(m.detachPaymentMethod).toHaveBeenCalledTimes(2);
  });

  it("pauses, vouches, approves and calls off through the person's own client", async () => {
    const db = world();
    db.handlers.autopay_vouch = () => ({ data: 1 });
    expect((await request("office-1", "POST", `/clients/${PAT}/autopay/pause`, { paused: true })).status).toBe(200);
    expect(db.called("autopay_pause")).toEqual([{ p_client: PAT, p_paused: true }]);
    expect((await request("office-1", "POST", `/clients/${STRANGER}/autopay/pause`, { paused: true })).status).toBe(404);
    expect(await (await request("owner-1", "POST", "/clients/autopay/vouch", { client_ids: [ROBIN, ROBIN], terms_version: "2026-10-31T14:05:09" })).json()).toEqual({ recorded: 1 });
    expect(db.called("autopay_vouch")).toEqual([{ p_company: CO, p_clients: [ROBIN], p_terms_version: "2026-10-31T14:05:09" }]);
    db.handlers.claim_autopay_charges = () => ({ data: [] });
    expect((await request("office-1", "POST", `/autopay/charges/${CHARGE}/approve`, {})).status).toBe(200);
    expect(db.called("approve_autopay_charge")).toEqual([{ p_charge: CHARGE }]);
    await vi.waitFor(() => expect(db.called("claim_autopay_charges")).toEqual([{ p_limit: 25, p_company: CO }]));
    db.handlers.call_off_autopay_charge = () => ({ error: { code: "22023", message: "This charge can't be called off now" } });
    const late = await request("office-1", "POST", `/autopay/charges/${CHARGE}/call-off`, {});
    expect(late.status).toBe(400);
    expect(await late.json()).toEqual({ error: "This charge can't be called off now" });
    expect((await request("office-1", "POST", `/autopay/charges/${id(49)}/call-off`, {})).status).toBe(404);
  });

  describe("Charge card", () => {
    const SECOND = id(51);

    it("queues each invoice for the amount the office saw, through the person's own client, says what it did, and runs the task for the company", async () => {
      const db = world();
      db.handlers.request_manual_charges = (args) => ({
        data: [...new Set<string>(args.p_invoices)].map((invoice) => (invoice === INVOICE ? { invoice_id: invoice, outcome: "queued", reason: null } : { invoice_id: invoice, outcome: "changed", reason: "The amount changed to $60.00. Check it and try again" })),
      });
      db.handlers.claim_autopay_charges = () => ({ data: [] });
      const res = await request("office-1", "POST", "/invoices/charge", { invoices: [{ id: INVOICE, amount: 45 }, { id: SECOND, amount: 50.5 }, { id: INVOICE, amount: 45 }] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [
          { invoice_id: INVOICE, outcome: "queued", reason: null },
          { invoice_id: SECOND, outcome: "changed", reason: "The amount changed to $60.00. Check it and try again" },
        ],
      });
      // The database takes an invoice sent twice once, with its first amount.
      expect(db.called("request_manual_charges")).toEqual([{ p_company: CO, p_invoices: [INVOICE, SECOND, INVOICE], p_amounts: [45, 50.5, 45] }]);
      await vi.waitFor(() => expect(db.called("claim_autopay_charges")).toEqual([{ p_limit: 25, p_company: CO }]));
    });

    it("doesn't run the task when nothing was queued, and passes on the database's refusals", async () => {
      const db = world();
      db.handlers.request_manual_charges = (args) => ({ data: args.p_invoices.map((invoice: string) => ({ invoice_id: invoice, outcome: "in_progress", reason: "It's being charged now" })) });
      expect((await request("office-1", "POST", "/invoices/charge", { invoices: [{ id: INVOICE, amount: 45 }] })).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(db.called("claim_autopay_charges")).toEqual([]);
      db.handlers.request_manual_charges = () => ({ error: { code: "42501", message: "Only the office with the invoices area can do that" } });
      expect((await request("office-1", "POST", "/invoices/charge", { invoices: [{ id: INVOICE, amount: 45 }] })).status).toBe(403);
    });

    it("takes 1 to 50 invoices, each with the amount the office saw, and stops at the hourly limit", async () => {
      const db = world();
      db.handlers.request_manual_charges = () => ({ data: [] });
      for (const invoices of [[], [{ id: "nope", amount: 45 }], [{ id: INVOICE }], [{ id: INVOICE, amount: 0 }], [{ id: INVOICE, amount: "45" }], Array.from({ length: 51 }, (_, n) => ({ id: id(1000 + n), amount: 45 }))]) {
        expect((await request("office-1", "POST", "/invoices/charge", { invoices })).status).toBe(400);
      }
      // The old body, with no amounts, isn't taken.
      expect((await request("office-1", "POST", "/invoices/charge", { invoice_ids: [INVOICE] })).status).toBe(400);
      db.hits.set(`manual-charge:${CO}`, 300);
      const limited = await request("office-1", "POST", "/invoices/charge", { invoices: [{ id: INVOICE, amount: 45 }] });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: "That's a lot of charges this hour. Try again later." });
      expect(db.called("request_manual_charges")).toEqual([]);
    });

    it("lists what can be charged, and gives the invoice page the card to charge unless one is under way", async () => {
      const db = world();
      const row = { id: INVOICE, number: 2, client_id: PAT, client_name: "Pat Lee", balance_due: 45, due_on: "2026-11-15", status: "sent", card: "Visa ending 4242", in_progress: false, live_status: null as string | null, live_detail: null as string | null };
      db.handlers.chargeable_invoices = (args) => ({ data: args.p_invoice && args.p_invoice !== INVOICE ? [] : [row] });
      expect(await (await request("office-1", "GET", "/invoices/chargeable")).json()).toEqual({ invoices: [row] });
      expect(db.called("chargeable_invoices")).toEqual([{ p_company: CO }]);
      expect(await (await request("office-1", "GET", `/invoices/${INVOICE}/charge`)).json()).toEqual({ manual: { card: "Visa ending 4242" } });
      expect(db.called("chargeable_invoices").at(-1)).toEqual({ p_company: CO, p_invoice: INVOICE });
      expect(await (await request("office-1", "GET", `/invoices/${SECOND}/charge`)).json()).toEqual({ manual: null });
      Object.assign(row, { in_progress: true, live_status: "bank_clearing", live_detail: "A bank payment for it is on its way" });
      expect(await (await request("office-1", "GET", "/invoices/chargeable")).json()).toEqual({ invoices: [row] });
      expect(await (await request("office-1", "GET", `/invoices/${INVOICE}/charge`)).json()).toEqual({ manual: null });
      expect((await request("office-1", "GET", "/invoices/nope/charge")).status).toBe(404);
    });
  });

  describe("refunds", () => {
    // A $45 card payment on invoice #2, paid in full.
    const paid = (invoice: Row = {}) => {
      const db = world();
      db.tables.payments!.push({ id: PAYMENT, company_id: CO, invoice_id: INVOICE, client_id: PAT, amount: 45, tip_amount: 5, processor: "stripe", processor_ref: "pi_1" });
      Object.assign(db.tables.invoices![0]!, invoice);
      // What booking the refund does to the invoice: it's owed again by the invoice's part.
      m.refundStripePayment.mockImplementation(async (_env, _admin, _company, _payment, amountCents: number) => {
        const invoiceRow = db.tables.invoices![0]!;
        const back = Math.min(amountCents, 4500) / 100;
        invoiceRow.balance_due = Number(invoiceRow.balance_due) + back;
        invoiceRow.status = invoiceRow.balance_due > 0 ? "partially_paid" : "paid";
        db.tables.payments!.push({ company_id: CO, invoice_id: INVOICE, amount: -back, processor_ref: `pi_1:refund:${amountCents}` });
        return { refunded_cents: amountCents, recorded: true };
      });
      return db;
    };

    it("refunds, and takes what went back off the invoice so nobody asks the client for it", async () => {
      const db = paid();
      const res = await request("office-1", "POST", `/payments/${PAYMENT}/refund`, { amount: 20 });
      expect(await res.json()).toEqual({ refunded: 20, recorded: true, written_off: true, still_owed: 0 });
      expect(m.refundStripePayment).toHaveBeenCalledWith(env, expect.anything(), CO, PAYMENT, 2000);
      expect(db.tables.invoices![0]!.status).toBe("written_off");
    });

    it("leaves the balance owed when asked to, when other money is still owed, or when booking waits on Stripe", async () => {
      let db = paid();
      // Not asked to take it off: nothing to tell the office about.
      expect(await (await request("office-1", "POST", `/payments/${PAYMENT}/refund`, { amount: 20, write_off: false })).json()).toMatchObject({ written_off: false, still_owed: 0 });
      expect(db.tables.invoices![0]!.status).toBe("partially_paid");
      // $30 was still owed on top of what's refunded: the box did nothing, and the response says what's asked for now.
      db = paid({ total: 75, balance_due: 30, status: "partially_paid" });
      expect(await (await request("office-1", "POST", `/payments/${PAYMENT}/refund`, { amount: 45 })).json()).toEqual({ refunded: 45, recorded: true, written_off: false, still_owed: 75 });
      expect(db.tables.invoices![0]!.status).toBe("partially_paid");
      db = paid();
      m.refundStripePayment.mockResolvedValue({ refunded_cents: 2000, recorded: false });
      expect(await (await request("office-1", "POST", `/payments/${PAYMENT}/refund`, { amount: 20 })).json()).toEqual({ refunded: 20, recorded: false, written_off: false, still_owed: 0 });
      expect(db.tables.invoices![0]!.status).toBe("paid");
    });

    it("counts a refund of the tip, after the invoice's part went back, as nothing to write off", async () => {
      const db = paid();
      db.tables.payments!.push({ company_id: CO, invoice_id: INVOICE, amount: -45, tip_amount: 0, processor_ref: "pi_1:refund:4500" });
      Object.assign(db.tables.invoices![0]!, { balance_due: 0, status: "written_off" });
      m.refundStripePayment.mockResolvedValue({ refunded_cents: 500, recorded: true });
      expect(await (await request("office-1", "POST", `/payments/${PAYMENT}/refund`, { amount: 5 })).json()).toEqual({ refunded: 5, recorded: true, written_off: false, still_owed: 0 });
    });

    it("refuses what isn't a refund, and passes on Stripe's refusals", async () => {
      paid();
      for (const amount of [0, -5, 100_001, "10"]) expect((await request("office-1", "POST", `/payments/${PAYMENT}/refund`, { amount })).status).toBe(400);
      expect((await request("office-1", "POST", `/payments/${id(71)}/refund`, { amount: 5 })).status).toBe(404);
      const { HttpError } = await import("../src/lib/http");
      m.refundStripePayment.mockRejectedValue(new HttpError(400, "That's more than is left to refund."));
      const res = await request("office-1", "POST", `/payments/${PAYMENT}/refund`, { amount: 40 });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That's more than is left to refund." });
    });
  });

  it("makes the office's copy of a client's Hub link one that says so", async () => {
    world();
    const res = await request("estimator-1", "GET", `/clients/${PAT}/hub-link`);
    const { link } = await res.json();
    expect(await readClientLink(env, link.split("/hub/")[1])).toMatchObject({ c: CO, t: "client", id: PAT, via: "office" });
  });
});
