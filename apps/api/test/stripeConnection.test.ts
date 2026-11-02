/**
 * Connecting, switching and disconnecting Stripe, history imports on the server's key, Hub Pay,
 * the money Stripe reports (disputes, refunds, deposits, and customers' balances and credit notes
 * there), keeping Stripe invoices in step, and autopay (saving cards, charging them, tips on them,
 * refunds from Crewtavo and what the key can do), against an in-memory database and a fake Stripe
 * that keeps accounts (and test and live mode) apart the way Stripe does: one account's invoice is
 * "No such invoice" to another's key.
 */
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import {
  autopayStripeCheck,
  beginStripeImport,
  chargeInvoiceAutomatically,
  chargeTip,
  connectStripe,
  detachPaymentMethod,
  finishStripeSetup,
  handleStripeEvent,
  hubPayment,
  importFromStripe,
  PROCESSING_MESSAGE,
  reconcileAutopayProcessing,
  refreshStripeWebhook,
  refundStripePayment,
  SHARED_STRIPE_IMPORT,
  STRIPE_EVENTS,
  STRIPE_EVENTS_VERSION,
  stripeCapabilities,
  stripeCheckout,
  stripeSetupSession,
  syncStripeInvoice,
  type SavedMethod,
} from "../src/integrations/stripe";
import { loadSecret } from "../src/integrations/tokens";
import { NO_PASSWORD, WRONG_PASSWORD } from "../src/lib/auth";
import { forgetMailbox } from "../src/lib/notify";
import { clientLink } from "../src/lib/links";
import type { Db } from "../src/lib/supabase";

const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));

type Row = Record<string, any>;
const LIVE = ["creating", "open", "processing"];

// ---------------------------------------------------------------------------------------------
// The database: rows in memory, with the unique keys the code relies on
// ---------------------------------------------------------------------------------------------

const UPSERT_KEYS: Record<string, string[]> = {
  integrations: ["company_id", "provider"],
  integration_secrets: ["company_id", "provider"],
  sync_links: ["company_id", "provider", "entity", "local_id"],
};
const DEFAULTS: Record<string, Row> = {
  stripe_invoices: {
    stripe_id: null, status: "creating", hosted_url: null, number: null, tip_amount: 0, livemode: true, stripe_account: null, detached_at: null,
    collection: "send_invoice", purpose: "invoice",
  },
  payments: { tip_amount: 0, fee_amount: 0, payout_id: null },
  payouts: { itemized_at: null },
  client_payment_methods: {
    status: "active", is_default: false, source: "hub", saved_via: "client", removed_at: null, removed_reason: null, stripe_account: null, brand: null, wallet: null,
    last4: null, exp_month: null, exp_year: null, bank_name: null,
  },
};

function conflicts(table: string, rows: Row[], row: Row, self?: Row) {
  const others = rows.filter((r) => r !== self);
  if (table === "stripe_invoices") {
    if (row.stripe_id && others.some((r) => r.stripe_id === row.stripe_id)) return true;
    // stripe_invoices_live_idx and stripe_invoices_live_tip_idx: one live Stripe invoice per
    // invoice among the ones still followed, and one live tip.
    const live = (r: Row) => r.invoice_id && LIVE.includes(r.status) && !r.detached_at;
    if (live(row) && others.some((r) => live(r) && r.invoice_id === row.invoice_id && (r.purpose ?? "invoice") === (row.purpose ?? "invoice"))) return true;
  }
  if (table === "client_payment_methods") return others.some((r) => r.company_id === row.company_id && r.stripe_payment_method_id === row.stripe_payment_method_id);
  if ((table === "payments" || table === "payouts") && row.processor_ref) return others.some((r) => r.processor_ref === row.processor_ref);
  return false;
}

function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0;
  const rpcs: Array<{ fn: string; args: Row }> = [];
  const hits = new Map<string, number>();
  /** Runs after each row is inserted, the way a trigger would (see invoiceTriggers). */
  const hooks: { insert?: (table: string, row: Row) => void } = {};
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op = "select";
    let payload: any;
    let cols = "*";
    let head = false;
    let one: "single" | "maybe" | null = null;
    let order: [string, boolean] | null = null;
    let limit: number | null = null;
    const duplicate = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    const run = () => {
      const all = (tables[table] ??= []);
      let out: Row[];
      if (op === "insert") {
        out = [];
        for (const p of [payload].flat()) {
          const row = { id: crypto.randomUUID(), created_at: new Date(Date.now() + seq++).toISOString(), ...DEFAULTS[table], ...p };
          if (conflicts(table, all, row)) return duplicate;
          all.push(row);
          out.push(row);
          hooks.insert?.(table, row);
        }
      } else if (op === "upsert") {
        const keys = UPSERT_KEYS[table]!;
        const found = all.find((r) => keys.every((k) => r[k] === payload[k]));
        if (found) Object.assign(found, payload);
        else all.push({ ...payload });
        out = [found ?? all.at(-1)!];
      } else {
        const matched = all.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          if (matched.some((r) => conflicts(table, all, { ...r, ...payload }, r))) return duplicate;
          for (const r of matched) Object.assign(r, payload);
        } else if (op === "delete") tables[table] = all.filter((r) => !matched.includes(r));
        out = matched;
      }
      out = out.map((r) => {
        const copy = { ...r };
        // settings->hub_tips and the like.
        for (const part of cols.split(",").map((c) => c.trim()).filter((c) => c.includes("->"))) copy[part.split("->")[1]!] = r[part.split("->")[0]!]?.[part.split("->")[1]!];
        return copy;
      });
      if (order) {
        const [k, asc] = order;
        out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limit !== null) out = out.slice(0, limit);
      if (head) return { data: null, error: null, count: out.length };
      if (one) return one === "single" && out.length !== 1 ? { data: null, error: { message: "not one row" } } : { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };
    const q: any = {
      select: (c = "*", opts?: { head?: boolean }) => {
        if (op === "select") cols = c;
        head = Boolean(opts?.head);
        return q;
      },
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), q),
      lt: (k: string, v: any) => (filters.push((r) => r[k] < v), q),
      lte: (k: string, v: any) => (filters.push((r) => r[k] <= v), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      not: (k: string, _op: string, v: unknown) => (filters.push((r) => (r[k] ?? null) !== v), q),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
      gt: (k: string, v: any) => (filters.push((r) => r[k] > v), q),
      gte: (k: string, v: any) => (filters.push((r) => r[k] >= v), q),
      like: (k: string, p: string) => (filters.push((r) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`).test(String(r[k] ?? ""))), q),
      match: (m: Row) => {
        for (const [k, v] of Object.entries(m)) q.eq(k, v);
        return q;
      },
      order: (k: string, o?: { ascending?: boolean }) => ((order = [k, o?.ascending !== false]), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => ((one = "maybe"), q),
      single: () => ((one = "single"), q),
      insert: (p: unknown) => ((op = "insert"), (payload = p), q),
      update: (p: unknown) => ((op = "update"), (payload = p), q),
      upsert: (p: unknown) => ((op = "upsert"), (payload = p), q),
      delete: () => ((op = "delete"), q),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return q;
  };
  const db = {
    from,
    rpc: async (fn: string, args: Row) => {
      rpcs.push({ fn, args });
      if (fn === "rate_limit_hit") {
        const n = (hits.get(args.p_key) ?? 0) + 1;
        hits.set(args.p_key, n);
        return { data: n <= args.p_max, error: null };
      }
      if (fn === "autopay_save_payment_method") {
        // As the SQL: upsert by Stripe id, a removed one stays removed, make_default unsets the rest.
        const all = (tables.client_payment_methods ??= []);
        const { make_default, ...fields } = args.p_method as Row;
        let row = all.find((r) => r.company_id === args.p_company && r.stripe_payment_method_id === fields.stripe_payment_method_id);
        if (row?.status === "removed") return { data: row.id, error: null };
        if (make_default) for (const r of all) if (r.client_id === args.p_client) r.is_default = false;
        if (row) Object.assign(row, fields, make_default ? { is_default: true } : {});
        else {
          row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...DEFAULTS.client_payment_methods, company_id: args.p_company, client_id: args.p_client, ...fields, is_default: Boolean(make_default) };
          all.push(row);
        }
        return { data: row.id, error: null };
      }
      if (fn === "finish_autopay_charge") {
        // As the SQL for the webhook's calls (no claim): only this company's charge on its way, paid or bounced.
        const charge = (tables.autopay_charges ?? []).find((r) => r.id === args.p_id);
        const ok = charge && !args.p_token && args.p_company && charge.company_id === args.p_company && charge.status === "processing" && ["paid", "bank_failed"].includes(args.p_outcome);
        if (!ok) return { data: false, error: null };
        if (args.p_outcome === "paid") Object.assign(charge, { status: "paid", charged_amount: args.p_amount ?? charge.charged_amount });
        else charge.status = "needs_client";
        return { data: true, error: null };
      }
      return { data: null, error: null };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  current.db = db;
  return { db: db as unknown as Db, tables, rpcs, hooks };
}

// ---------------------------------------------------------------------------------------------
// Stripe: accounts with a test side and a live side, and keys that reach one of them
// ---------------------------------------------------------------------------------------------

interface Side {
  invoices: Map<string, Row>;
  webhooks: Map<string, Row>;
  customers: Row[];
  payouts: Row[];
  transactions: Row[];
  /** Autopay: Checkout Sessions in setup mode, their SetupIntents, saved payment methods, payments and refunds. */
  sessions: Map<string, Row>;
  setups: Map<string, Row>;
  methods: Map<string, Row>;
  intents: Map<string, Row>;
  charges: Map<string, Row>;
  refunds: Row[];
}
interface Key {
  account: string;
  live: boolean;
  webhooks: boolean;
  /** Checkout Sessions, SetupIntents and PaymentMethods (an older key has none of them). */
  autopay: boolean;
  refunds: boolean;
  /** The account's name in its Stripe dashboard, which its owner chooses. */
  name?: string;
}
/** A request as Stripe got it. */
interface Sent {
  key: string;
  method: string;
  path: string;
  body: URLSearchParams;
  query: URLSearchParams;
  idempotency?: string;
}
/** Make matching requests fail `times` times (Stripe's answer), or go through but never answer (`lose`). */
interface Trouble {
  when: (method: string, path: string) => boolean;
  times: number;
  status?: number;
  error?: Row;
  lose?: boolean;
}
const stripe = {
  sides: new Map<string, Side>(),
  keys: new Map<string, Key>(),
  calls: [] as string[],
  sent: [] as Sent[],
  n: 0,
  finalizing: null as (() => Promise<void>) | null,
  /** Stripe replays a request with the same idempotency key (one still being made too). */
  replays: new Map<string, Promise<{ call: string; status: number; body: string }>>(),
  trouble: [] as Trouble[],
  /** An ACH payment whose bounce came before the answer to /pay. */
  bounceFirst: false,
};

/** A key for `account` (live or test by its prefix). `webhooks: false` is a restricted key without that permission. */
function stripeKey(key: string, account: string, options: { webhooks?: boolean; autopay?: boolean; refunds?: boolean; name?: string } = {}) {
  stripe.keys.set(key, { account, live: key.includes("_live_"), webhooks: options.webhooks ?? true, autopay: options.autopay ?? true, refunds: options.refunds ?? true, name: options.name });
  return key;
}
function side(key: string): Side {
  const k = stripe.keys.get(key)!;
  const name = `${k.account}:${k.live ? "live" : "test"}`;
  if (!stripe.sides.has(name)) {
    stripe.sides.set(name, {
      invoices: new Map(), webhooks: new Map(), customers: [], payouts: [], transactions: [],
      sessions: new Map(), setups: new Map(), methods: new Map(), intents: new Map(), charges: new Map(), refunds: [],
    });
  }
  return stripe.sides.get(name)!;
}
/** The client pays a Stripe invoice (in whichever account it's in), with its own card unless they pick another (`pm`). */
function payInStripe(id: string, pm?: string) {
  for (const s of stripe.sides.values()) {
    const invoice = s.invoices.get(id);
    if (!invoice) continue;
    Object.assign(invoice, { status: "paid", amount_paid: invoice.amount_due, payment_intent: `pi_${id}`, status_transitions: { ...invoice.status_transitions, paid_at: 1_760_000_500 } });
    s.intents.set(`pi_${id}`, { id: `pi_${id}`, status: "succeeded", last_payment_error: null, payment_method: pm ?? invoice.default_payment_method });
  }
}
const stripeInvoice = (id: string) => [...stripe.sides.values()].find((s) => s.invoices.has(id))?.invoices.get(id);
/** What was sent to a path (newest last). */
const sentTo = (method: string, pattern: RegExp) => stripe.sent.filter((r) => r.method === method && pattern.test(r.path));
/** The form fields under a prefix, as an object: metadata[...] and the like. */
const fields = (body: URLSearchParams, prefix: string) =>
  Object.fromEntries([...body].filter(([name]) => name.startsWith(`${prefix}[`) && !name.slice(prefix.length + 1).includes("[")).map(([name, value]) => [name.slice(prefix.length + 1, -1), value]));

async function fakeStripe(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const path = url.pathname;
  const headers = init.headers as Record<string, string>;
  const key = headers.Authorization!.slice(7);
  const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
  const idempotency = headers["Idempotency-Key"];
  stripe.calls.push(`${key} ${method} ${path}`);
  stripe.sent.push({ key, method, path, body, query: url.searchParams, idempotency });
  const trouble = stripe.trouble.find((t) => t.times > 0 && t.when(method, path));
  if (trouble && !trouble.lose) {
    trouble.times--;
    return new Response(JSON.stringify({ error: trouble.error ?? { message: "Something went wrong on Stripe's end." } }), { status: trouble.status ?? 500 });
  }
  // Stripe replays a key only for the same request: the same endpoint and the same parameters.
  const call = `${key} ${method} ${path} ${body.toString()}`;
  let first = idempotency ? stripe.replays.get(idempotency) : undefined;
  const replayed = Boolean(first);
  if (!first) {
    first = answer(url, method, path, key, body).then(async (r) => ({ call, status: r.status, body: await r.text() }));
    if (idempotency) stripe.replays.set(idempotency, first);
  }
  const done = await first;
  const response = replayed && done.call !== call
    ? new Response(JSON.stringify({ error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } }), { status: 400 })
    : new Response(done.body, { status: done.status });
  if (trouble?.lose) {
    trouble.times--;
    throw new TypeError("fetch failed");
  }
  return response;
}

async function answer(url: URL, method: string, path: string, key: string, body: URLSearchParams): Promise<Response> {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const k = stripe.keys.get(key);
  if (!k) return json({ error: { message: "Invalid API Key provided" } }, 401);
  const s = side(key);
  const noInvoice = (id: string) => json({ error: { message: `No such invoice: '${id}'`, code: "resource_missing", param: "id" } }, 404);
  const refused = json({ error: { type: "permission_error", message: "The provided key does not have the required permissions for this endpoint" } }, 403);
  const expanded = (name: string) => [...url.searchParams.values()].includes(name);
  const withMethod = (si: Row) => ({ ...si, payment_method: si.payment_method && s.methods.has(si.payment_method) ? s.methods.get(si.payment_method) : si.payment_method });
  let m: RegExpMatchArray | null;

  if (path === "/v1/account") return json({ id: k.account, settings: { dashboard: { display_name: k.name ?? `Business ${k.account}` } } });
  if (path.startsWith("/v1/webhook_endpoints")) {
    if (!k.webhooks) return refused;
    if (method === "GET") return json({ data: [...s.webhooks.values()].map(({ id, url }) => ({ id, url })), has_more: false });
    const noEndpoint = json({ error: { message: "No such webhook endpoint", code: "resource_missing" } }, 404);
    const events = [...body].filter(([name]) => name.startsWith("enabled_events[")).map(([, value]) => value);
    if (path === "/v1/webhook_endpoints") {
      // Stripe allows 16 in each mode of an account.
      if (s.webhooks.size >= 16) return json({ error: { type: "invalid_request_error", message: "You have reached the maximum of 16 webhook endpoints." } }, 400);
      const id = `we_${++stripe.n}`;
      const endpoint = { id, url: body.get("url"), secret: `whsec_${id}`, enabled_events: events };
      s.webhooks.set(id, endpoint);
      return json(endpoint);
    }
    const id = path.split("/").pop()!;
    if (method === "POST") {
      // An update: it keeps its secret, and Stripe doesn't send it again.
      const endpoint = s.webhooks.get(id);
      if (!endpoint) return noEndpoint;
      endpoint.url = body.get("url") ?? endpoint.url;
      if (events.length) endpoint.enabled_events = events;
      return json({ id, url: endpoint.url });
    }
    return s.webhooks.delete(id) ? json({ id, deleted: true }) : noEndpoint;
  }

  // Autopay's permissions.
  if (/^\/v1\/(checkout\/sessions|setup_intents|payment_methods)/.test(path) && !k.autopay) return refused;
  if (path.startsWith("/v1/refunds") && !k.refunds) return refused;

  if (path === "/v1/checkout/sessions" && method === "POST") {
    if (!body.get("mode")) return json({ error: { type: "invalid_request_error", message: "Missing required param: mode.", param: "mode" } }, 400);
    const customer = body.get("customer");
    if (!s.customers.some((c) => c.id === customer)) return json({ error: { message: `No such customer: '${customer}'`, code: "resource_missing", param: "customer" } }, 400);
    const id = `cs_test_${++stripe.n}`;
    const si = `seti_${++stripe.n}`;
    s.setups.set(si, { id: si, status: "requires_payment_method", customer, payment_method: null, metadata: fields(body, "setup_intent_data[metadata]"), last_setup_error: null });
    s.sessions.set(id, {
      id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: body.get("mode"), status: "open", customer, setup_intent: si, metadata: fields(body, "metadata"),
      success_url: body.get("success_url"), cancel_url: body.get("cancel_url"), currency: body.get("currency"),
    });
    return json(s.sessions.get(id));
  }
  if ((m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
    const session = s.sessions.get(m[1]!);
    if (!session) return json({ error: { message: `No such checkout.session: '${m[1]}'`, code: "resource_missing", param: "session" } }, 404);
    return json(expanded("setup_intent.payment_method") ? { ...session, setup_intent: withMethod(s.setups.get(session.setup_intent)!) } : session);
  }
  if (path === "/v1/setup_intents") return json({ data: [], has_more: false });
  if ((m = path.match(/^\/v1\/setup_intents\/([^/]+)$/))) {
    const si = s.setups.get(m[1]!);
    if (!si) return json({ error: { message: `No such setupintent: '${m[1]}'`, code: "resource_missing", param: "intent" } }, 404);
    return json(expanded("payment_method") ? withMethod(si) : si);
  }
  if ((m = path.match(/^\/v1\/payment_methods\/([^/]+)\/detach$/))) {
    const pm = s.methods.get(m[1]!);
    if (!pm) return json({ error: { message: `No such PaymentMethod: '${m[1]}'`, code: "resource_missing", param: "payment_method" } }, 404);
    if (!pm.customer) return json({ error: { message: "The payment method you provided is not attached to a customer so detachment is impossible." } }, 400);
    pm.customer = null;
    return json(pm);
  }
  if ((m = path.match(/^\/v1\/payment_methods\/([^/]+)$/))) {
    const pm = s.methods.get(m[1]!);
    return pm ? json(pm) : json({ error: { message: `No such PaymentMethod: '${m[1]}'`, code: "resource_missing", param: "payment_method" } }, 404);
  }
  if (path === "/v1/payment_methods") {
    const list = [...s.methods.values()].filter((pm) => pm.customer === url.searchParams.get("customer") && pm.type === (url.searchParams.get("type") ?? pm.type));
    return json({ data: list.reverse().slice(0, Number(url.searchParams.get("limit") ?? 10)), has_more: false });
  }
  if (path === "/v1/payment_intents" || (m = path.match(/^\/v1\/payment_intents\/([^/]+)$/))) {
    const intent = m ? s.intents.get(m[1]!) : null;
    return intent ? json(intent) : json({ error: { message: "No such payment_intent", code: "resource_missing", param: "intent" } }, 404);
  }
  if (path === "/v1/refunds" && method === "POST") {
    const intent = body.get("payment_intent");
    const charge = [...s.charges.values()].find((c) => c.payment_intent === intent);
    if (!charge) return json({ error: { type: "invalid_request_error", message: `No such payment_intent: '${intent}'`, code: "resource_missing", param: "payment_intent" } }, 400);
    const amount = Number(body.get("amount") ?? charge.amount - charge.amount_refunded);
    if (amount > charge.amount - charge.amount_refunded) return json({ error: { type: "invalid_request_error", message: "Refund amount is greater than unrefunded amount on charge." } }, 400);
    charge.amount_refunded += amount;
    const refund = { id: `re_${++stripe.n}`, amount, charge: charge.id, payment_intent: intent, status: "succeeded" };
    s.refunds.push(refund);
    return json(refund);
  }
  if ((m = path.match(/^\/v1\/charges\/([^/]+)$/))) {
    const charge = s.charges.get(m[1]!);
    return charge ? json(charge) : json({ error: { message: "No such charge", code: "resource_missing" } }, 404);
  }

  if (path === "/v1/customers" && method === "GET") {
    const email = url.searchParams.get("email");
    const list = s.customers.filter((c) => email === null || c.email === email);
    return json({
      data: list.map((c) => ({
        livemode: k.live, ...c,
        invoice_settings: { default_payment_method: s.methods.get(c.invoice_settings?.default_payment_method) ?? c.invoice_settings?.default_payment_method ?? null },
      })),
      has_more: false,
    });
  }
  if (path === "/v1/customers") {
    const customer = { id: `cus_${++stripe.n}`, email: body.get("email") };
    s.customers.push(customer);
    return json(customer);
  }
  if ((m = path.match(/^\/v1\/customers\/([^/]+)$/))) {
    const customer = s.customers.find((c) => c.id === m![1]);
    if (!customer) return json({ error: { message: "No such customer", code: "resource_missing", param: "customer" } }, 404);
    if (body.get("invoice_settings[default_payment_method]")) customer.invoice_settings = { default_payment_method: body.get("invoice_settings[default_payment_method]") };
    return json(customer);
  }
  if (path === "/v1/invoices" && method === "POST") {
    if (!s.customers.some((c) => c.id === body.get("customer"))) return json({ error: { message: "No such customer", code: "resource_missing", param: "customer" } }, 400);
    // Stripe's own default; a due date only goes with invoices the client pays themselves.
    const collection = body.get("collection_method") ?? "charge_automatically";
    if (collection === "charge_automatically" && body.get("due_date")) return json({ error: { message: "You can not pass `due_date` when collection_method is charge_automatically.", param: "due_date" } }, 400);
    const id = `in_${++stripe.n}`;
    s.invoices.set(id, {
      id, status: "draft", livemode: k.live, customer: body.get("customer"), metadata: fields(body, "metadata"), number: null, hosted_invoice_url: null, amount_due: 0, amount_paid: 0, total: 0,
      paid_out_of_band: false, payment_intent: null, charge: null, status_transitions: { finalized_at: null, paid_at: null }, lines: { data: [], has_more: false },
      collection_method: collection, default_payment_method: body.get("default_payment_method"), items: [],
    });
    return json(s.invoices.get(id));
  }
  if (path === "/v1/invoiceitems") {
    const invoice = s.invoices.get(body.get("invoice")!);
    if (!invoice) return noInvoice(body.get("invoice")!);
    invoice.amount_due += Number(body.get("amount"));
    invoice.total += Number(body.get("amount"));
    invoice.items.push({ amount: Number(body.get("amount")), description: body.get("description") });
    return json({ id: `ii_${++stripe.n}` });
  }
  if ((m = path.match(/^\/v1\/invoices\/([^/]+)\/finalize$/))) {
    const invoice = s.invoices.get(m[1]!);
    if (!invoice) return noInvoice(m[1]!);
    // Something else happening while Stripe makes it.
    await stripe.finalizing?.();
    // The customer's balance goes on it: their credit comes off, and what they owed before is
    // added. Less than 50 cents left is marked paid without a charge, and goes on their next one.
    const customer = s.customers.find((c) => c.id === invoice.customer)!;
    const balance = customer.balance ?? 0;
    const applied = Math.max(balance, -invoice.total);
    customer.balance = balance - applied;
    let due = invoice.total + applied;
    if (due > 0 && due < 50) {
      customer.balance += due;
      due = 0;
    }
    Object.assign(invoice, {
      status: due ? "open" : "paid", amount_due: due, starting_balance: balance, number: `N-${m[1]}`,
      hosted_invoice_url: `https://invoice.stripe.com/i/${k.account}_${k.live ? "live" : "test"}_${m[1]}`,
      status_transitions: { finalized_at: 1_760_000_100, paid_at: due ? null : 1_760_000_100 },
    });
    return json(invoice);
  }
  if ((m = path.match(/^\/v1\/invoices\/([^/]+)\/pay$/))) {
    const invoice = s.invoices.get(m[1]!);
    if (!invoice) return noInvoice(m[1]!);
    if (invoice.status === "paid") return json({ error: { type: "invalid_request_error", message: "Invoice is already paid" } }, 400);
    if (invoice.status !== "open") return json({ error: { type: "invalid_request_error", message: `This invoice is ${invoice.status}, so it can't be paid.` } }, 400);
    const pm = body.get("payment_method") ?? invoice.default_payment_method;
    const pi = `pi_${invoice.id}`;
    invoice.payment_intent = pi;
    // Stripe's test cards and accounts: https://docs.stripe.com/testing
    if (pm === "pm_card_chargeDeclined") {
      const problem = { code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." };
      s.intents.set(pi, { id: pi, status: "requires_payment_method", last_payment_error: problem, payment_method: pm });
      return json({ error: { type: "card_error", ...problem, payment_intent: { id: pi, status: "requires_payment_method" } } }, 402);
    }
    if (pm === "pm_card_authenticationRequired") {
      s.intents.set(pi, { id: pi, status: "requires_action", last_payment_error: null, payment_method: pm });
      return json({ error: { type: "card_error", code: "authentication_required", message: "Your card was declined. This transaction requires authentication.", payment_intent: { id: pi, status: "requires_action" } } }, 402);
    }
    if (pm?.startsWith("pm_us_bank_account")) {
      s.intents.set(pi, stripe.bounceFirst
        ? { id: pi, status: "requires_payment_method", last_payment_error: { code: "account_closed", message: "The customer's bank account has been closed." }, payment_method: pm }
        : { id: pi, status: "processing", last_payment_error: null, payment_method: pm });
      return json(invoice);
    }
    const charge = {
      id: `ch_${invoice.id}`, object: "charge", payment_intent: pi, amount: invoice.amount_due, amount_refunded: 0, payment_method_details: { type: "card" },
      balance_transaction: { id: `txn_${invoice.id}`, fee: Math.round(invoice.amount_due * 0.029) + 30 },
    };
    s.charges.set(charge.id, charge);
    s.intents.set(pi, { id: pi, status: "succeeded", last_payment_error: null, payment_method: pm });
    Object.assign(invoice, { status: "paid", amount_paid: invoice.amount_due, charge, status_transitions: { ...invoice.status_transitions, paid_at: 1_760_000_500 } });
    return json(invoice);
  }
  if ((m = path.match(/^\/v1\/invoices\/([^/]+)\/void_invoice$/))) {
    const invoice = s.invoices.get(m[1]!);
    if (!invoice) return noInvoice(m[1]!);
    if (invoice.status !== "open") return json({ error: { message: `You can only void open invoices. This one is ${invoice.status}.` } }, 400);
    invoice.status = "void";
    return json(invoice);
  }
  if ((m = path.match(/^\/v1\/invoices\/([^/]+)\/mark_uncollectible$/))) {
    const invoice = s.invoices.get(m[1]!);
    if (!invoice) return noInvoice(m[1]!);
    if (invoice.status !== "open") return json({ error: { message: `You can only mark open invoices uncollectible. This one is ${invoice.status}.` } }, 400);
    Object.assign(invoice, { status: "uncollectible", status_transitions: { ...invoice.status_transitions, marked_uncollectible_at: 1_760_000_900 } });
    return json(invoice);
  }
  if ((m = path.match(/^\/v1\/invoices\/([^/]+)$/))) {
    const invoice = s.invoices.get(m[1]!);
    if (!invoice) return noInvoice(m[1]!);
    if (method === "DELETE") {
      if (invoice.status !== "draft") return json({ error: { message: "You can only delete draft invoices." } }, 400);
      s.invoices.delete(m[1]!);
    }
    return json(invoice);
  }
  if (path === "/v1/invoices") return json({ data: [...s.invoices.values()], has_more: false });
  if (path === "/v1/payouts") return json({ data: s.payouts, has_more: false });
  if ((m = path.match(/^\/v1\/payouts\/([^/]+)$/))) return json(s.payouts.find((p) => p.id === m![1]));
  if (path === "/v1/balance_transactions") return json({ data: s.transactions.filter((t) => t.payout === url.searchParams.get("payout")), has_more: false });
  throw new Error(`The fake Stripe doesn't know ${method} ${path}`);
}

// ---------------------------------------------------------------------------------------------
// A lawn company with one client and an invoice for $160
// ---------------------------------------------------------------------------------------------

const CO = "00000000-0000-4000-8000-000000000001";
const OTHER_CO = "00000000-0000-4000-8000-000000000002";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const INV = "00000000-0000-4000-8000-0000000000e1";
const INV2 = "00000000-0000-4000-8000-0000000000e2";
const USER = "00000000-0000-4000-8000-0000000000aa";
const BASE = "https://crew.example.com";
const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: BASE,
};

const invoiceRow = (id: string, number: number) => ({
  id, company_id: CO, number, status: "sent", subject: "May mowing", notes: null, client_id: CLIENT, due_on: null,
  subtotal: 160, discount_amount: 0, tax_rate: 0, tax_amount: 0, retainage_pct: 0, retainage_amount: 0, amount_paid: 0, balance_due: 160, promo: null,
  lines: [{ name: "Weekly mowing", quantity: 4, unit: "visit", unit_price: 40, sort: 1 }],
});

/**
 * Supabase Auth, for the password changing Stripe asks for (a throwaway sign-in, then signed out:
 * lib/auth.ts confirmPassword), and Resend, for the owners' emails. Anything else is Stripe.
 */
const others = { password: "correct horse battery", signIns: [] as Row[], signOuts: 0, emails: [] as Row[] };
async function fakeServices(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input);
  if (url.startsWith(`${env.SUPABASE_URL}/auth/v1/token`)) {
    const body = JSON.parse(String(init.body));
    others.signIns.push(body);
    if (body.password !== others.password) return Response.json({ code: "invalid_credentials", error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
    return Response.json({ access_token: "throwaway", refresh_token: "throwaway", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: USER, aud: "authenticated", email: body.email } });
  }
  if (url.startsWith(`${env.SUPABASE_URL}/auth/v1/logout`)) {
    others.signOuts++;
    return new Response(null, { status: 204 });
  }
  if (url === "https://api.resend.com/emails") {
    others.emails.push(JSON.parse(String(init.body)));
    return Response.json({ id: `email_${others.emails.length}` });
  }
  return fakeStripe(input, init);
}

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  stripe.sides.clear();
  stripe.keys.clear();
  stripe.calls.length = 0;
  stripe.sent.length = 0;
  stripe.n = 0;
  stripe.finalizing = null;
  stripe.replays.clear();
  stripe.trouble.length = 0;
  stripe.bounceFirst = false;
  db = fakeDb({
    companies: [{ id: CO, name: "Green Lawn", timezone: "America/Chicago", currency: "USD", settings: { hub_tips: true } }],
    memberships: [{ company_id: CO, user_id: USER, role: "owner", role_id: null, active: true }],
    clients: [{ id: CLIENT, company_id: CO, display_name: "Pat Client", email: "pat@example.com", phone: null }],
    invoices: [invoiceRow(INV, 42), invoiceRow(INV2, 43)],
    profiles: [{ user_id: USER, email: "pat@greenlawn.example", full_name: "Pat Owner" }],
  });
  Object.assign(others, { signIns: [], signOuts: 0, emails: [] });
  vi.stubGlobal("fetch", vi.fn(fakeServices));
});
afterEach(() => vi.unstubAllGlobals());

async function connect(key: string, e: Env = env) {
  const done = await connectStripe(e, db.db, { companyId: CO, userId: USER, key, baseUrl: BASE });
  await done.settled;
  return done;
}
const rowsFor = (invoiceId: string) => db.tables.stripe_invoices!.filter((r) => r.invoice_id === invoiceId);
const owe = (invoiceId: string, balance: number) => Object.assign(db.tables.invoices!.find((i) => i.id === invoiceId)!, { balance_due: balance, amount_paid: 160 - balance, status: "partially_paid" });
const headers = { Authorization: "Bearer token", "X-Company-Id": CO, "Content-Type": "application/json" };

// ---------------------------------------------------------------------------------------------

describe("replacing the Stripe key", () => {
  it("keeps the working webhook when the new key can't add one", async () => {
    const old = stripeKey("sk_live_OLD", "acct_A");
    stripeKey("rk_live_NEW", "acct_A", { webhooks: false });
    await connect(old);
    const [working] = side(old).webhooks.keys();
    stripe.calls.length = 0;

    const res = await app.request("/api/apps/stripe/key", { method: "PUT", headers, body: JSON.stringify({ api_key: "rk_live_NEW", password: others.password }) }, env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "That key can't add a webhook. Make a new one with Get a key from Stripe, which gives it everything Crewtavo needs. Stripe stays connected as it was.",
    );
    // Nothing was taken out, and the old key and its webhook are still the ones in use.
    expect(stripe.calls.filter((c) => c.includes("DELETE"))).toEqual([]);
    expect([...side(old).webhooks.keys()]).toEqual([working]);
    expect(await loadSecret(env, db.db, CO, "stripe")).toMatchObject({ api_key: old, extra: { webhook_id: working, webhook_secret: `whsec_${working}` } });
    expect(db.tables.integrations![0]).toMatchObject({ status: "connected", external_account_id: "acct_A", settings: { webhook: true } });
  });

  it("takes the old webhook out only once the new one is in and saved", async () => {
    const a = stripeKey("sk_live_A", "acct_A");
    const b = stripeKey("sk_live_B", "acct_B");
    await connect(a);
    const [old] = side(a).webhooks.keys();
    stripe.calls.length = 0;
    await connect(b);
    const added = stripe.calls.indexOf("sk_live_B POST /v1/webhook_endpoints");
    const removed = stripe.calls.indexOf(`sk_live_A DELETE /v1/webhook_endpoints/${old}`);
    expect(added).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThan(added);
    expect(side(a).webhooks.size).toBe(0);
    const [now] = side(b).webhooks.keys();
    expect(await loadSecret(env, db.db, CO, "stripe")).toMatchObject({ api_key: b, extra: { webhook_id: now, account_id: "acct_B" } });
  });
});

describe("switching to another Stripe account", () => {
  it("from a test key to a live one: the test invoices are voided with the test key, and clients get live pages", async () => {
    const test = stripeKey("sk_test_A", "acct_A");
    const live = stripeKey("sk_live_A", "acct_A");
    await connect(test);
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    const [made] = rowsFor(INV);
    expect(made).toMatchObject({ status: "open", livemode: false, stripe_account: "acct_A" });

    stripe.calls.length = 0;
    await connect(live);
    expect(stripe.calls).toContain(`sk_test_A POST /v1/invoices/${made!.stripe_id}/void_invoice`);
    expect(stripeInvoice(made!.stripe_id)!.status).toBe("void");
    expect(rowsFor(INV)[0]).toMatchObject({ status: "void", detached_at: expect.any(String) });

    const url = await stripeCheckout(env, db.db, CO, INV, 0);
    expect(url).toContain("acct_A_live_");
    // A check comes in: the live Stripe invoice is replaced, nothing tries the test one.
    owe(INV, 120);
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    expect(stripe.calls.filter((c) => c.startsWith("sk_live_A") && c.includes(made!.stripe_id))).toEqual([]);
  });

  it("leaves a bank payment that's still clearing alone, tells the office, and records one that was paid", async () => {
    const a = stripeKey("sk_live_A", "acct_A");
    const b = stripeKey("sk_live_B", "acct_B");
    await connect(a);
    await syncStripeInvoice(env, db.db, CO, INV);
    await syncStripeInvoice(env, db.db, CO, INV2);
    const [clearing] = rowsFor(INV);
    const [paid] = rowsFor(INV2);
    clearing!.status = "processing";
    payInStripe(paid!.stripe_id);

    await connect(b);
    expect(stripeInvoice(clearing!.stripe_id)!.status).toBe("open");
    expect(db.tables.messages).toEqual([
      expect.objectContaining({ client_id: CLIENT, related_id: INV, subject: "Bank payment still clearing", body: expect.stringContaining("record the payment here once it clears") }),
    ]);
    // The client isn't asked to pay again while it might still clear.
    expect((await hubPayment(env, db.db, CO, INV)).processing).toBe(true);
    await expect(stripeCheckout(env, db.db, CO, INV, 0)).rejects.toMatchObject({ status: 409, message: PROCESSING_MESSAGE });
    // The one paid in the old account meanwhile is recorded.
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV2, amount: 160, processor_ref: `pi_${paid!.stripe_id}` })]);

    // Crewtavo doesn't hear if it bounces there. Long after any bank payment clears, the client
    // can pay online again (the office was told to record it once it cleared).
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("busy");
    clearing!.detached_at = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    expect((await hubPayment(env, db.db, CO, INV)).processing).toBe(false);
    expect(await stripeCheckout(env, db.db, CO, INV, 0)).toContain("acct_B_live_");
  });

  it("checks Stripe invoices from before accounts were noted, and doesn't fail on one this key can't find", async () => {
    const b = stripeKey("sk_live_B", "acct_B");
    const c = stripeKey("sk_live_C", "acct_C");
    // Made with account C's key before this change, and connected to B since.
    const old = { stripe_id: "in_c1", status: "open", amount_due: 160, hosted_url: "https://invoice.stripe.com/i/acct_C_live_in_c1", livemode: true, stripe_account: null };
    side(c).invoices.set("in_c1", { id: "in_c1", status: "open" });
    side(c).invoices.set("in_c2", { id: "in_c2", status: "open" });
    db.tables.stripe_invoices = [
      { id: crypto.randomUUID(), company_id: CO, invoice_id: INV, origin: "crewtavo", tip_amount: 0, detached_at: null, created_at: new Date(0).toISOString(), ...DEFAULTS.stripe_invoices, ...old },
      { id: crypto.randomUUID(), company_id: CO, invoice_id: INV2, origin: "crewtavo", tip_amount: 0, detached_at: null, created_at: new Date(0).toISOString(), ...DEFAULTS.stripe_invoices, ...old, stripe_id: "in_c2" },
    ];
    await connect(b);

    // The Hub doesn't hand out account C's page.
    const url = await stripeCheckout(env, db.db, CO, INV, 0);
    expect(url).toContain("acct_B_live_");
    expect(rowsFor(INV).find((r) => r.stripe_id === "in_c1")).toMatchObject({ detached_at: expect.any(String) });
    // The outbox job for a balance change goes through instead of failing on "No such invoice".
    owe(INV2, 120);
    expect(await syncStripeInvoice(env, db.db, CO, INV2)).toBe("created");
    expect(rowsFor(INV2).find((r) => r.stripe_id === "in_c2")).toMatchObject({ detached_at: expect.any(String) });
    expect(rowsFor(INV2).find((r) => r.status === "open" && !r.detached_at)).toMatchObject({ stripe_account: "acct_B", amount_due: 120 });
  });

  it("doesn't take a payment on an invoice the office wrote off", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    Object.assign(db.tables.invoices!.find((i) => i.id === INV)!, { status: "written_off" });
    await expect(stripeCheckout(env, db.db, CO, INV, 0)).rejects.toMatchObject({ status: 409, message: "This invoice isn't owed anymore." });
  });

  it("keeps the invoices when the new key is for the same account", async () => {
    const a = stripeKey("sk_live_A", "acct_A");
    const rolled = stripeKey("sk_live_A2", "acct_A");
    await connect(a);
    await syncStripeInvoice(env, db.db, CO, INV);
    const url = await stripeCheckout(env, db.db, CO, INV, 0);
    stripe.calls.length = 0;
    await connect(rolled);
    expect(stripe.calls.filter((c) => c.includes("/v1/invoices"))).toEqual([]);
    expect(await stripeCheckout(env, db.db, CO, INV, 0)).toBe(url);
    // One webhook at Crewtavo's address: the new one.
    expect([...side(a).webhooks.values()]).toEqual([expect.objectContaining({ id: (await loadSecret(env, db.db, CO, "stripe"))!.extra!.webhook_id })]);
  });

  it("keeps the webhook in use for a key rolled in the same account when Stripe has no room for another", async () => {
    const a = stripeKey("sk_live_A", "acct_A");
    const rolled = stripeKey("sk_live_A2", "acct_A");
    const other = stripeKey("sk_live_B", "acct_B");
    await connect(a);
    const [working] = side(a).webhooks.keys();
    // The business has 15 webhooks of its own, so the account is at Stripe's limit.
    for (let i = 0; i < 15; i++) side(a).webhooks.set(`we_own_${i}`, { id: `we_own_${i}`, url: `https://elsewhere.example.com/${i}`, secret: "whsec_own" });
    for (let i = 0; i < 16; i++) side(other).webhooks.set(`we_b_${i}`, { id: `we_b_${i}`, url: `https://elsewhere.example.com/${i}`, secret: "whsec_b" });

    // A key for another account at its limit still can't take over.
    const refused = await connectStripe(env, db.db, { companyId: CO, userId: USER, key: other, baseUrl: BASE }).catch((error: Error) => error);
    expect(refused).toMatchObject({ status: 400, message: "Stripe wouldn't add the webhook: You have reached the maximum of 16 webhook endpoints. Stripe stays connected as it was." });
    // (It asks Stripe about the webhook in use, which isn't in its account.)
    expect(stripe.calls).toContain(`sk_live_B POST /v1/webhook_endpoints/${working}`);
    expect(await loadSecret(env, db.db, CO, "stripe")).toMatchObject({ api_key: a, extra: { webhook_id: working } });
    expect(side(other).webhooks.size).toBe(16);

    // The rolled key takes over the webhook in use, which keeps its secret.
    expect(await connect(rolled)).toMatchObject({ webhook: true });
    expect(stripe.calls).toContain(`sk_live_A2 POST /v1/webhook_endpoints/${working}`);
    expect(await loadSecret(env, db.db, CO, "stripe")).toMatchObject({ api_key: rolled, extra: { webhook_id: working, webhook_secret: `whsec_${working}`, account_id: "acct_A" } });
    expect(side(a).webhooks.has(working!)).toBe(true);
    expect(side(a).webhooks.size).toBe(16);
  });

  it("disconnecting voids the open invoices with the company's key, and the server's account takes over", async () => {
    const own = stripeKey("sk_live_A", "acct_A");
    const server = stripeKey("sk_live_SERVER", "acct_S");
    const e = { ...env, STRIPE_SECRET_KEY: server };
    await connect(own, e);
    await syncStripeInvoice(e, db.db, CO, INV);
    const [made] = rowsFor(INV);

    const res = await app.request("/api/apps/stripe/disconnect", { method: "POST", headers, body: JSON.stringify({ password: others.password }) }, e);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(stripeInvoice(made!.stripe_id)!.status).toBe("void"));
    expect(side(own).webhooks.size).toBe(0);
    expect(await stripeCheckout(e, db.db, CO, INV, 0)).toContain("acct_S_live_");
  });
});

describe("changing the Stripe key: the password, the record and the owners", () => {
  const SAM = "00000000-0000-4000-8000-0000000000ab";
  const ALEX = "00000000-0000-4000-8000-0000000000ac";
  const LEFT = "00000000-0000-4000-8000-0000000000ad";
  // Email by the server's Resend account.
  const mailing: Env = { ...env, RESEND_API_KEY: "re_test", EMAIL_FROM: "Crewtavo <hello@crewtavo.example>" };
  beforeEach(() => {
    // Another owner, an admin, and an owner who left: only the two owners hear about it.
    db.tables.memberships!.push(
      { company_id: CO, user_id: SAM, role: "owner", role_id: null, active: true },
      { company_id: CO, user_id: ALEX, role: "admin", role_id: null, active: true },
      { company_id: CO, user_id: LEFT, role: "owner", role_id: null, active: false },
    );
    db.tables.profiles!.push(
      { user_id: SAM, email: "sam@greenlawn.example", full_name: "Sam Owner" },
      { user_id: ALEX, email: "alex@greenlawn.example", full_name: "Alex Admin" },
      { user_id: LEFT, email: "lee@greenlawn.example", full_name: "Lee Gone" },
    );
  });
  const putKey = (key: string, password?: string, e: Env = mailing) =>
    app.request("/api/apps/stripe/key", { method: "PUT", headers, body: JSON.stringify({ api_key: key, ...(password === undefined ? {} : { password }) }) }, e);
  const disconnect = (password?: string, e: Env = mailing) =>
    app.request("/api/apps/stripe/disconnect", { method: "POST", headers, body: JSON.stringify(password === undefined ? {} : { password }) }, e);
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

  it("refuses a wrong or missing password before anything reaches Stripe, and keeps the key in use", async () => {
    stripeKey("sk_live_Aqzx9", "acct_A");
    const wrong = await putKey("sk_live_Aqzx9", "guess");
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe("That password isn't right.");
    const missing = await putKey("sk_live_Aqzx9");
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toBe("Password is required.");
    expect(stripe.calls).toEqual([]);
    expect(db.tables.integration_secrets ?? []).toEqual([]);
    // The check signs in as the person whose session it is.
    expect(others.signIns.map((b) => b.email)).toEqual(["pat@greenlawn.example"]);

    await connect("sk_live_Aqzx9");
    const refused = await disconnect("guess");
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toBe("That password isn't right.");
    expect(await loadSecret(env, db.db, CO, "stripe")).toMatchObject({ api_key: "sk_live_Aqzx9" });
    expect(db.tables.integrations![0]).toMatchObject({ status: "connected" });
    expect(db.tables.activity ?? []).toEqual([]);
  });

  /** The requests that follow come from the sign-in `session_id`. */
  const signedIn = (session_id: string) => ((db.db as unknown as { auth: { getClaims: unknown } }).auth.getClaims = async () => ({ data: { claims: { sub: USER, session_id } }, error: null }));

  it("counts the tries for each sign-in, so a stolen one's guesses don't lock the owner out", async () => {
    stripeKey("sk_live_Aqzx9", "acct_A");
    signedIn("stolen");
    for (let i = 0; i < 10; i++) expect((await putKey("sk_live_Aqzx9", "guess")).status).toBe(400);
    expect((await putKey("sk_live_Aqzx9", others.password)).status).toBe(429);
    expect(others.signIns).toHaveLength(10);
    signedIn("owner");
    expect((await putKey("sk_live_Aqzx9", others.password)).status).toBe(200);
    await vi.waitFor(() => expect(others.emails).toHaveLength(2));
    // Each try counts for the sign-in and for the person; the 11th stopped at the sign-in's.
    expect(db.rpcs.filter((r) => r.fn === "rate_limit_hit").map((r) => r.args.p_key)).toEqual([
      ...Array(10).fill([`stripe-key:${USER}:stolen`, `stripe-key:${USER}`]).flat(),
      `stripe-key:${USER}:stolen`,
      `stripe-key:${USER}:owner`,
      `stripe-key:${USER}`,
    ]);
  });

  it("and stops one person's guesses at 50 an hour, however many sign-ins make them", async () => {
    stripeKey("sk_live_Aqzx9", "acct_A");
    for (let s = 0; s < 5; s++) {
      signedIn(`s${s}`);
      for (let i = 0; i < 10; i++) expect((await putKey("sk_live_Aqzx9", "guess")).status).toBe(400);
    }
    signedIn("s5");
    expect((await putKey("sk_live_Aqzx9", others.password)).status).toBe(429);
    expect(others.signIns).toHaveLength(50);
  });

  it("tells someone who signs in with Google how to set a password", async () => {
    (db.db as unknown as { auth: { getClaims: unknown } }).auth.getClaims = async () => ({ data: { claims: { sub: USER, app_metadata: { provider: "google", providers: ["google"] } } }, error: null });
    const res = await putKey(stripeKey("sk_live_Aqzx9", "acct_A"), "anything");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(NO_PASSWORD);
    expect(NO_PASSWORD).toContain("Settings → Profile → Change password");
  });

  it("records connecting, switching and disconnecting, and tells every owner, never with the key", async () => {
    const a = stripeKey("sk_live_Aqzx9", "acct_A");
    const b = stripeKey("rk_live_Bwvk7", "acct_B");
    expect((await putKey(a, others.password)).status).toBe(200);
    // The throwaway session is ended.
    expect(others.signOuts).toBe(1);
    await vi.waitFor(() => expect(others.emails).toHaveLength(2));
    expect(db.tables.activity).toEqual([
      expect.objectContaining({ company_id: CO, actor_id: USER, verb: "stripe.connected", subject_type: "app", summary: "Pat Owner connected Stripe (Business acct_A (acct_A))" }),
    ]);
    expect(db.tables.notifications!.map((n) => [n.user_id, n.kind, n.title, n.link])).toEqual([
      [USER, "security", "Stripe was connected", "/apps/stripe"],
      [SAM, "security", "Stripe was connected", "/apps/stripe"],
    ]);
    const [first] = others.emails;
    expect(others.emails.map((m) => m.to)).toEqual([["pat@greenlawn.example"], ["sam@greenlawn.example"]]);
    expect(first).toMatchObject({ subject: "Stripe was connected for Green Lawn" });
    expect(first!.text).toContain("Who: Pat Owner (pat@greenlawn.example)");
    expect(first!.text).toContain("Stripe account: Business acct_A (acct_A)");
    expect(first!.text).toMatch(/When: \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M C[DS]T/);
    expect(first!.text).toContain("If this wasn't you, sign in, disconnect Stripe on the Apps page, change your password, and delete the Crewtavo key in your Stripe dashboard.");
    expect(first!.text).toContain(`${BASE}/apps/stripe`);

    expect((await putKey(b, others.password)).status).toBe(200);
    await vi.waitFor(() => expect(others.emails).toHaveLength(4));
    expect(db.tables.activity!.at(-1)).toMatchObject({ verb: "stripe.switched", summary: "Pat Owner switched Stripe from Business acct_A (acct_A) to Business acct_B (acct_B)" });
    expect(others.emails.at(-1)!.text).toContain("Stripe account: Business acct_B (acct_B) (was Business acct_A (acct_A))");

    expect((await disconnect(others.password)).status).toBe(200);
    await vi.waitFor(() => expect(others.emails).toHaveLength(6));
    expect(db.tables.activity!.at(-1)).toMatchObject({ verb: "stripe.disconnected", summary: "Pat Owner disconnected Stripe (Business acct_B (acct_B))" });
    expect(others.emails.at(-1)).toMatchObject({ subject: "Stripe was disconnected for Green Lawn" });
    expect(others.emails.at(-1)!.text).toContain("Stripe account: Business acct_B (acct_B)");
    // Never any part of a key, in the record, on the bell or in the email.
    const told = JSON.stringify([db.tables.activity, db.tables.notifications, others.emails]);
    for (const key of [a, b]) expect(told).not.toContain(key.slice(-4));
    expect(told).not.toMatch(/[sr]k_(live|test)_/);
  });

  it("says a key rolled in the same account was replaced", async () => {
    await connect(stripeKey("sk_live_Aqzx9", "acct_A"));
    expect((await putKey(stripeKey("rk_live_Ayvk2", "acct_A"), others.password)).status).toBe(200);
    await vi.waitFor(() => expect(db.tables.activity).toEqual([expect.objectContaining({ verb: "stripe.switched", summary: "Pat Owner replaced the Stripe key (Business acct_A (acct_A))" })]));
  });

  it("goes by the account, not its name: another account named like the business is a switch", async () => {
    await connect(stripeKey("sk_live_Aqzx9", "acct_A", { name: "Green Lawn" }));
    const theirs = stripeKey("rk_live_Ewvk7", "acct_E", { name: "Green Lawn" });
    expect(await connect(theirs)).toMatchObject({ change: { from: "acct_A", to: "acct_E", moved: true } });
    // Through the page, back to the business's own key.
    expect((await putKey(stripeKey("sk_live_Aqzx9", "acct_A", { name: "Green Lawn" }), others.password)).status).toBe(200);
    await vi.waitFor(() => expect(others.emails).toHaveLength(2));
    expect(db.tables.activity).toEqual([expect.objectContaining({ verb: "stripe.switched", summary: "Pat Owner switched Stripe from Green Lawn (acct_E) to Green Lawn (acct_A)" })]);
    expect(db.tables.notifications![0]).toMatchObject({ title: "Stripe was switched to another account" });
    expect(others.emails[0]!.text).toContain("Stripe account: Green Lawn (acct_A) (was Green Lawn (acct_E))");
  });

  it("says a key whose account it can't tell may be for a different account", async () => {
    await connect(stripeKey("sk_live_Aqzx9", "acct_A"));
    // A restricted key that can't read its account, and nothing made with the old key to look for.
    stripe.trouble.push({ when: (_method, path) => path === "/v1/account", times: 1, status: 403, error: { type: "permission_error", message: "The provided key does not have the required permissions for this endpoint" } });
    expect((await putKey(stripeKey("rk_live_Qwvk7", "acct_Q"), others.password)).status).toBe(200);
    await vi.waitFor(() => expect(others.emails).toHaveLength(2));
    expect(db.tables.activity).toEqual([
      expect.objectContaining({ verb: "stripe.switched", summary: "Pat Owner replaced the Stripe key with one that may be for a different Stripe account (Stripe account (ID unknown), was Business acct_A (acct_A))" }),
    ]);
    expect(db.tables.notifications![0]).toMatchObject({ title: "The Stripe key was replaced, maybe with a different account" });
    expect(others.emails[0]!.text).toContain("Stripe account: Stripe account (ID unknown) (was Business acct_A (acct_A)), which may be a different Stripe account");
  });

  it("still changes the key when email isn't set up", async () => {
    const res = await putKey(stripeKey("sk_live_Aqzx9", "acct_A"), others.password, env);
    expect(res.status).toBe(200);
    expect(await loadSecret(env, db.db, CO, "stripe")).toMatchObject({ api_key: "sk_live_Aqzx9" });
    await vi.waitFor(() => expect(db.tables.notifications).toHaveLength(2));
    expect(others.emails).toEqual([]);
  });

  it("tells the Stripe page when the owners can't be emailed, and only then", async () => {
    forgetMailbox(CO);
    const stripeRow = async (e: Env) => ((await (await app.request("/api/apps", { headers }, e)).json()) as { apps: Array<Row> }).apps.find((a) => a.id === "stripe")!;
    expect(await stripeRow(env)).toMatchObject({ owners_emailed: false });
    expect(await stripeRow(mailing)).toMatchObject({ owners_emailed: true });
    // Only for Stripe.
    const { apps } = (await (await app.request("/api/apps", { headers }, env)).json()) as { apps: Array<Row> };
    expect(apps.filter((a) => "owners_emailed" in a).map((a) => a.id)).toEqual(["stripe"]);
  });

  it("asks nothing more of the other apps' keys", async () => {
    const res = await app.request("/api/apps/anthropic/key", { method: "PUT", headers, body: JSON.stringify({ api_key: "sk-ant-api03-test-key" }) }, env);
    expect(res.status).toBe(200);
    expect(others.signIns).toEqual([]);
  });
});

describe("the company's email: the password and the owners", () => {
  const SAM = "00000000-0000-4000-8000-0000000000ab";
  beforeEach(() => {
    forgetMailbox(CO);
    db.tables.memberships!.push({ company_id: CO, user_id: SAM, role: "owner", role_id: null, active: true });
    db.tables.profiles!.push({ user_id: SAM, email: "sam@greenlawn.example", full_name: "Sam Owner" });
  });
  const resend = (from: string, password?: string) =>
    app.request("/api/email", { method: "PUT", headers, body: JSON.stringify({ preset: "resend", api_key: "re_company_key", from_email: from, ...(password === undefined ? {} : { current_password: password }) }) }, env);
  const remove = (password?: string) => app.request("/api/email", { method: "DELETE", headers, body: JSON.stringify(password === undefined ? {} : { current_password: password }) }, env);
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
  const mailbox = () => (db.tables.integrations ?? []).find((r) => r.provider === "email");

  it("connecting or changing it needs the person's password, and every owner hears about it", async () => {
    const missing = await resend("office@greenlawn.example");
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toBe("Current password is required.");
    const wrong = await resend("office@greenlawn.example", "guess");
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe(WRONG_PASSWORD);
    // Nothing saved, and no test email.
    expect(mailbox()).toBeUndefined();
    expect(others.emails).toEqual([]);

    expect((await resend("office@greenlawn.example", others.password)).status).toBe(200);
    expect(mailbox()).toMatchObject({ status: "connected", account_label: "office@greenlawn.example" });
    await vi.waitFor(() => expect(db.tables.notifications).toHaveLength(2));
    expect(db.tables.activity).toEqual([expect.objectContaining({ actor_id: USER, verb: "email.connected", summary: "Pat Owner connected the company's email (office@greenlawn.example)" })]);
    expect(db.tables.notifications!.map((n) => [n.user_id, n.kind, n.title, n.link])).toEqual([
      [USER, "security", "The company's email was connected", "/settings?tab=email"],
      [SAM, "security", "The company's email was connected", "/settings?tab=email"],
    ]);

    expect((await resend("billing@greenlawn.example", others.password)).status).toBe(200);
    await vi.waitFor(() => expect(db.tables.notifications).toHaveLength(4));
    expect(db.tables.activity!.at(-1)).toMatchObject({ verb: "email.changed", summary: "Pat Owner changed the company's email (billing@greenlawn.example, was office@greenlawn.example)" });
    expect(db.tables.notifications!.at(-1)).toMatchObject({ title: "The company's email was changed", body: expect.stringContaining("If this wasn't you") });
    // Never the key.
    expect(JSON.stringify([db.tables.activity, db.tables.notifications])).not.toContain("re_company_key");
  });

  it("disconnecting it needs the password too, and nowhere else takes it away", async () => {
    expect((await resend("office@greenlawn.example", others.password)).status).toBe(200);
    await vi.waitFor(() => expect(db.tables.activity).toHaveLength(1));

    expect((await remove()).status).toBe(400);
    expect(await errorOf(await remove("guess"))).toBe(WRONG_PASSWORD);
    // The Apps page's disconnect is for its own apps.
    const sideDoor = await app.request("/api/apps/email/disconnect", { method: "POST", headers, body: "{}" }, env);
    expect(sideDoor.status).toBe(400);
    expect(mailbox()).toMatchObject({ status: "connected" });
    expect(db.tables.integration_secrets!.some((r) => r.provider === "email")).toBe(true);

    expect((await remove(others.password)).status).toBe(200);
    expect(mailbox()).toBeUndefined();
    await vi.waitFor(() => expect(db.tables.activity).toHaveLength(2));
    expect(db.tables.activity!.at(-1)).toMatchObject({ verb: "email.disconnected", summary: "Pat Owner disconnected the company's email (office@greenlawn.example)" });
    expect(db.tables.notifications!.slice(-2).map((n) => [n.user_id, n.title])).toEqual([
      [USER, "The company's email was disconnected"],
      [SAM, "The company's email was disconnected"],
    ]);
    // Each password tried counts (a missing one isn't a try).
    expect(db.rpcs.filter((r) => r.fn === "rate_limit_hit").map((r) => r.args.p_key)).toEqual(Array(3).fill([`mailbox:${USER}:`, `mailbox:${USER}`]).flat());
  });
});

describe("a full secret key", () => {
  it("is noted when connected, and the Apps page warns about it on live keys only", async () => {
    const stripeOf = async () => ((await (await app.request("/api/apps", { headers }, env)).json()) as { apps: Array<{ id: string; stripe?: Row }> }).apps.find((a) => a.id === "stripe")!.stripe!;
    await connect(stripeKey("sk_live_Aqzx9", "acct_A"));
    expect(db.tables.integrations![0]!.settings).toMatchObject({ key_kind: "secret" });
    expect(await stripeOf()).toMatchObject({ own: true, full_key: true });
    await connect(stripeKey("rk_live_Bwvk7", "acct_B"));
    expect(db.tables.integrations![0]!.settings).toMatchObject({ key_kind: "restricted" });
    expect(await stripeOf()).toMatchObject({ full_key: false });
    // A test-mode secret key moves no real money.
    await connect(stripeKey("sk_test_C", "acct_C"));
    expect(await stripeOf()).toMatchObject({ livemode: false, full_key: false });
    // The page never carries the key.
    expect(JSON.stringify(await stripeOf())).not.toMatch(/_C\b|sk_|rk_/);
  });

  it("connected before its kind was noted is noted the first time the Apps page asks", async () => {
    await connect(stripeKey("sk_live_Aqzx9", "acct_A"));
    delete db.tables.integrations![0]!.settings.key_kind;
    const res = await app.request("/api/apps", { headers }, env);
    const { apps } = (await res.json()) as { apps: Array<{ id: string; stripe?: Row }> };
    expect(apps.find((a) => a.id === "stripe")!.stripe).toMatchObject({ full_key: true });
    expect(db.tables.integrations![0]!.settings).toMatchObject({ key_kind: "secret" });
  });
});

describe("importing Stripe history", () => {
  it("on the server's shared key, only for the instance's only company", async () => {
    const shared = stripeKey("sk_live_SHARED", "acct_S");
    side(shared).payouts.push({ id: "po_1", amount: 485, currency: "usd", arrival_date: 1_760_400_000, status: "paid", automatic: false, failure_message: null });
    const e = { ...env, STRIPE_SECRET_KEY: shared };
    db.tables.companies!.push({ id: OTHER_CO, name: "Other Co", timezone: "UTC", currency: "USD", settings: {} });

    const res = await app.request("/api/apps/stripe/import", { method: "POST", headers, body: JSON.stringify({ since: null }) }, e);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(SHARED_STRIPE_IMPORT);
    // Run anyway (an import started before this), it stops before reading anything.
    db.tables.integrations = [{ company_id: CO, provider: "stripe", status: "disconnected", settings: {} }];
    await expect(importFromStripe(e, db.db, CO, await beginStripeImport(db.db, CO, null))).rejects.toThrow(SHARED_STRIPE_IMPORT);
    expect(db.tables.payouts ?? []).toEqual([]);
    expect(stripe.calls).toEqual([]);

    // With one company, the server's account is that company's.
    db.tables.companies = db.tables.companies!.filter((c) => c.id === CO);
    await importFromStripe(e, db.db, CO, await beginStripeImport(db.db, CO, null));
    expect(db.tables.payouts).toEqual([expect.objectContaining({ company_id: CO, processor_ref: "po_1" })]);
  });
});

describe("Hub Pay", () => {
  // From a visitor at `ip`, with nothing in front of the server (lib/visitor.ts).
  const from = (ip: string) => ({ ...env, incoming: { socket: { remoteAddress: ip } } as unknown as IncomingMessage });
  const pay = async (token: string, tip: number, ip = "203.0.113.7") =>
    app.request(`/api/hub/${token}/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tip }) }, from(ip));
  const token = async () => (await clientLink(env, BASE, { c: CO, t: "invoice", id: INV })).split("/hub/")[1]!;

  it("is limited per link and per visitor", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    const t = await token();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await pay(t, 0)).status);
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
    expect(db.rpcs.filter((r) => r.fn === "rate_limit_hit").map((r) => r.args.p_key)).toEqual(expect.arrayContaining(["pay:ip:203.0.113.7", `pay:invoice:${INV}`]));
  });

  it("makes a new Stripe invoice for a new tip only a few times an hour", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    const t = await token();
    // A client trying a few tips is fine.
    for (const tip of [0, 5, 10, 15, 20]) expect((await pay(t, tip)).status).toBe(200);
    const res = await pay(t, 25);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("You've changed the tip a few times already. Pay with the tip you chose before, or try another in an hour.");
    // The last one still works, and nothing more was made in Stripe.
    const last = (await (await pay(t, 20)).json()) as { url: string };
    expect(last.url).toBe(rowsFor(INV).find((r) => r.status === "open")!.hosted_url);
    expect(side(key).invoices.size).toBe(5);
  });

  it("counts every Stripe invoice made in the hour, whatever changed, and limits taking a promo code off", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    const t = await token();
    // A promo code put on and taken off between tries changes what's owed each time.
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      Object.assign(db.tables.invoices!.find((inv) => inv.id === INV)!, { balance_due: i % 2 ? 144 : 160 });
      statuses.push((await pay(t, i)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
    expect(side(key).invoices.size).toBe(5);
    const res = await pay(t, 0);
    expect(((await res.json()) as { error: string }).error).toBe("This invoice just changed, so its payment page is being updated. Try again in a few minutes.");

    for (let i = 0; i < 11; i++) await app.request(`/api/hub/${t}/promo`, { method: "DELETE" }, from("203.0.113.9"));
    expect(db.rpcs.filter((r) => r.fn === "remove_promo_code")).toHaveLength(10);
  });

  it("lists what was paid against the total, not a payment that was only a tip", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    // Pat's credit in Stripe paid the invoice, and Stripe charged the $15 tip, then refunded it.
    Object.assign(db.tables.invoices!.find((i) => i.id === INV)!, {
      status: "paid", amount_paid: 160, balance_due: 0, issued_on: "2026-10-01", total: 160,
      payments: [
        { amount: 160, tip_amount: 0, received_at: "2026-10-03T15:00:00Z" },
        { amount: 0, tip_amount: 15, received_at: "2026-10-03T15:00:00Z" },
        { amount: 0, tip_amount: -15, received_at: "2026-10-05T15:00:00Z" },
      ],
    });
    const res = await app.request(`/api/hub/${await token()}`, {}, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { invoice: { payments: unknown[] } }).invoice.payments).toEqual([{ amount: 160, tip_amount: 0, received_at: "2026-10-03T15:00:00Z" }]);
  });
});

describe("money Stripe reports", () => {
  const event = (type: string, object: Row) => handleStripeEvent(env, db.db, { companyId: CO }, { id: `evt_${++stripe.n}`, type, data: { object } });
  const dispute = (intent: string, amount: number, status: string, id = "dp_1") => ({ id, amount, charge: `ch_${intent}`, payment_intent: intent, status, reason: "fraudulent", evidence_details: { due_by: null } });
  const paidIn = (invoiceId: string | null) => db.tables.payments!.filter((p) => p.invoice_id === invoiceId);

  it("takes a lost dispute off the invoice first, then the tip, like a refund", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    // Both invoices are paid through the Hub with a $15 tip: $175 in Stripe.
    for (const id of [INV, INV2]) {
      await stripeCheckout(env, db.db, CO, id, 1500);
      payInStripe(rowsFor(id)[0]!.stripe_id);
      await event("invoice.paid", { id: rowsFor(id)[0]!.stripe_id });
    }
    expect(db.tables.payments).toEqual([
      expect.objectContaining({ invoice_id: INV, amount: 160, tip_amount: 15 }),
      expect.objectContaining({ invoice_id: INV2, amount: 160, tip_amount: 15 }),
    ]);
    const [one, two] = db.tables.payments!.map((p) => p.processor_ref as string);

    // The client disputes all of the first one, and the bank sides with them.
    await event("charge.dispute.created", dispute(one!, 17500, "needs_response"));
    await event("charge.dispute.closed", dispute(one!, 17500, "lost"));
    expect(paidIn(INV).filter((p) => p.amount < 0)).toEqual([expect.objectContaining({ amount: -160, tip_amount: -15, processor_ref: `${one}:dispute:dp_1`, notes: "Dispute lost in Stripe" })]);
    expect(db.tables.messages).toContainEqual(expect.objectContaining({ subject: "Payment disputed", related_type: "invoice", related_id: INV, external_id: "dp_1:opened" }));

    // $50 of the second was refunded first, so the bank takes back what's left: $110, and the tip.
    await event("charge.refunded", { id: `ch_${two}`, payment_intent: two, amount_refunded: 5000 });
    await event("charge.dispute.closed", dispute(two!, 12500, "lost", "dp_2"));
    expect(paidIn(INV2).filter((p) => p.amount < 0).map((p) => [p.amount, p.notes])).toEqual([[-50, "Refunded in Stripe"], [-110, "Dispute lost in Stripe"]]);
    expect(paidIn(INV2).find((p) => p.notes === "Dispute lost in Stripe")).toMatchObject({ tip_amount: -15 });
    // Stripe repeating itself changes nothing.
    await event("charge.dispute.closed", dispute(two!, 12500, "lost", "dp_2"));
    expect(paidIn(INV2)).toHaveLength(3);
  });

  it("notes a dispute on a payment with no invoice the way only the office reads it", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    // Paid after its invoice was voided, so it's the client's (20261018000800_review_fixes.sql's
    // messages_read keeps internal notes with an external_id and no related_type to the office).
    db.tables.payments = [{ id: crypto.randomUUID(), company_id: CO, client_id: CLIENT, invoice_id: null, method: "card", amount: 160, tip_amount: 0, processor: "stripe", processor_ref: "pi_loose" }];
    await event("charge.dispute.created", dispute("pi_loose", 16000, "needs_response", "dp_3"));
    expect(db.tables.messages).toEqual([
      expect.objectContaining({ channel: "note", direction: "internal", related_type: null, external_id: "dp_3:opened", body: expect.stringContaining("$160.00") }),
    ]);
  });

  it("doesn't bill Stripe for less than it can charge", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    const [made] = rowsFor(INV);
    // A $159.60 check leaves 40 cents: the Stripe invoice is voided, and none is made for the rest.
    owe(INV, 0.4);
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("too small for Stripe");
    expect(stripeInvoice(made!.stripe_id)!.status).toBe("void");
    expect(side(key).invoices.size).toBe(1);
    expect(rowsFor(INV).filter((r) => LIVE.includes(r.status))).toEqual([]);
    // Nor can the client pay it online, unless a tip makes it enough.
    await expect(stripeCheckout(env, db.db, CO, INV, 0)).rejects.toMatchObject({ status: 409, message: "What's left on this invoice is too small to pay online. Contact us to pay it." });
    expect(await stripeCheckout(env, db.db, CO, INV, 100)).toContain("acct_A_live_");
    expect(rowsFor(INV).find((r) => r.status === "open")).toMatchObject({ amount_due: 1.4, tip_amount: 1 });
  });

  it("books only the invoice's own money to it when Stripe adds the client's balance there", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    // Pat owed $25 in Stripe from before Crewtavo, so Stripe adds it to the next invoice.
    side(key).customers.push({ id: "cus_pat", email: "pat@example.com", balance: 2500 });
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    const [made] = rowsFor(INV);
    expect(stripeInvoice(made!.stripe_id)).toMatchObject({ amount_due: 18500, starting_balance: 2500 });
    expect(made).toMatchObject({ status: "open", amount_due: 160 });
    payInStripe(made!.stripe_id);
    await event("invoice.paid", { id: made!.stripe_id });
    expect(db.tables.payments).toEqual([
      expect.objectContaining({ invoice_id: INV, amount: 160, processor: "stripe", processor_ref: `pi_${made!.stripe_id}` }),
      expect.objectContaining({ invoice_id: null, client_id: CLIENT, amount: 25, processor: "stripe", notes: "Owed from before in Stripe, paid with invoice #42" }),
    ]);

    // Later Stripe holds $40 of credit for them, which pays part of the next one.
    side(key).customers.find((c) => c.id === "cus_pat")!.balance = -4000;
    expect(await syncStripeInvoice(env, db.db, CO, INV2)).toBe("created");
    const [next] = rowsFor(INV2);
    expect(stripeInvoice(next!.stripe_id)).toMatchObject({ amount_due: 12000 });
    payInStripe(next!.stripe_id);
    await event("invoice.paid", { id: next!.stripe_id });
    expect(paidIn(INV2)).toEqual([
      expect.objectContaining({ amount: 120, method: "card", processor: "stripe" }),
      expect.objectContaining({ amount: 40, method: "other", processor: null, notes: "Account credit in Stripe" }),
    ]);
  });

  it("books credit that pays it all, or all but a few cents, as only the credit there was", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    side(key).customers.push({ id: "cus_pat", email: "pat@example.com", balance: -15980 });
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    const [made] = rowsFor(INV);
    // Stripe used $159.80 of credit, and marked it paid with the last 20 cents put on Pat's next one.
    expect(stripeInvoice(made!.stripe_id)).toMatchObject({ status: "paid", amount_due: 0, amount_paid: 0 });
    expect(made).toMatchObject({ status: "paid" });
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV, amount: 159.8, method: "other", notes: "Account credit in Stripe" })]);
    // Stripe's webhook for it changes nothing more.
    await event("invoice.paid", { id: made!.stripe_id });
    expect(db.tables.payments).toHaveLength(1);
  });

  it("takes what was owed from before back with the rest of its charge, and puts it in the charge's deposit", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    // Pat owed $25 in Stripe from before each time, so Stripe charged $185 for each $160 invoice.
    const pat = { id: "cus_pat", email: "pat@example.com", balance: 0 };
    side(key).customers.push(pat);
    for (const id of [INV, INV2]) {
      pat.balance = 2500;
      await syncStripeInvoice(env, db.db, CO, id);
      payInStripe(rowsFor(id)[0]!.stripe_id);
      await event("invoice.paid", { id: rowsFor(id)[0]!.stripe_id });
    }
    const [one, two] = [INV, INV2].map((id) => `pi_${rowsFor(id)[0]!.stripe_id}`);
    expect(db.tables.payments!.map((p) => [p.invoice_id, p.amount])).toEqual([[INV, 160], [null, 25], [INV2, 160], [null, 25]]);

    // The first charge reaches the bank: its deposit has both parts of it, and its fee.
    side(key).payouts.push({ id: "po_1", amount: 17933, currency: "usd", arrival_date: 1_760_400_000, status: "paid", automatic: true, failure_message: null });
    side(key).transactions.push({ id: "txn_1", payout: "po_1", type: "charge", amount: 18500, fee: 567, net: 17933, source: { id: "ch_1", object: "charge", payment_intent: one } });
    await event("payout.paid", { id: "po_1" });
    const deposit = db.tables.payouts![0]!.id;
    expect(db.tables.payments!.filter((p) => p.payout_id === deposit).map((p) => [p.amount, p.fee_amount])).toEqual([[160, 5.67], [25, 0]]);

    // It's refunded in two goes: $170 is the invoice's $160 and $10 of what was owed, then the last $15.
    await event("charge.refunded", { id: "ch_1", payment_intent: one, amount_refunded: 17000 });
    await event("charge.refunded", { id: "ch_1", payment_intent: one, amount_refunded: 18500 });
    // The second is lost in a dispute (and Stripe says so twice).
    await event("charge.dispute.closed", dispute(two!, 18500, "lost"));
    await event("charge.dispute.closed", dispute(two!, 18500, "lost"));
    expect(paidIn(INV).map((p) => p.amount)).toEqual([160, -160]);
    expect(paidIn(INV2).map((p) => p.amount)).toEqual([160, -160]);
    expect(paidIn(null).map((p) => [p.amount, p.processor_ref])).toEqual([
      [25, `${one}:before`], [25, `${two}:before`], [-10, `${one}:refund:17000:before`], [-15, `${one}:refund:18500:before`], [-25, `${two}:dispute:dp_1:before`],
    ]);
    // Pat got back all they paid, and so is recorded as paying nothing.
    expect(db.tables.payments!.reduce((sum, p) => sum + p.amount, 0)).toBe(0);
  });

  it("refunds what a lost dispute left of a charge, not what the bank already took back", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    // The first is paid in the Hub with a $15 tip ($175). For the second, Pat owed $25 in Stripe
    // from before ($185).
    await stripeCheckout(env, db.db, CO, INV, 1500);
    side(key).customers.find((c) => c.email === "pat@example.com")!.balance = 2500;
    await syncStripeInvoice(env, db.db, CO, INV2);
    for (const id of [INV, INV2]) {
      payInStripe(rowsFor(id)[0]!.stripe_id);
      await event("invoice.paid", { id: rowsFor(id)[0]!.stripe_id });
    }
    const [tipped, owing] = [INV, INV2].map((id) => `pi_${rowsFor(id)[0]!.stripe_id}`);

    // The bank takes back $100 of each, and the rest is refunded.
    for (const [intent, rest] of [[tipped!, 7500], [owing!, 8500]] as const) {
      await event("charge.dispute.closed", dispute(intent, 10000, "lost", `dp_${intent}`));
      await event("charge.refunded", { id: `ch_${intent}`, payment_intent: intent, amount_refunded: rest });
    }
    const sum = (rows: Row[], k: string) => Math.round(rows.reduce((s, p) => s + Number(p[k]) * 100, 0)) / 100;
    // Nothing's left paid on either, the tip went back too, and so did what was owed from before.
    expect(paidIn(INV).map((p) => [p.amount, p.tip_amount || 0])).toEqual([[160, 15], [-100, 0], [-60, -15]]);
    expect(paidIn(INV2).map((p) => p.amount)).toEqual([160, -100, -60]);
    expect(paidIn(null).map((p) => [p.amount, p.processor_ref])).toEqual([[25, `${owing}:before`], [-25, `${owing}:refund:8500:before`]]);
    expect([sum(paidIn(INV), "amount"), sum(paidIn(INV), "tip_amount"), sum(paidIn(INV2), "amount"), sum(paidIn(null), "amount")]).toEqual([0, 0, 0, 0]);
  });

  it("records a charge of only the tip when the client's credit in Stripe paid the invoice, with its deposit and refunds", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    // Pat has $160 of credit in Stripe, all the invoice, and adds a $15 tip in the Hub.
    side(key).customers.push({ id: "cus_pat", email: "pat@example.com", balance: -16000 });
    await stripeCheckout(env, db.db, CO, INV, 1500);
    const [made] = rowsFor(INV);
    expect(stripeInvoice(made!.stripe_id)).toMatchObject({ status: "open", total: 17500, amount_due: 1500 });
    payInStripe(made!.stripe_id);
    await event("invoice.paid", { id: made!.stripe_id });
    const intent = `pi_${made!.stripe_id}`;
    expect(paidIn(INV)).toEqual([
      expect.objectContaining({ amount: 0, tip_amount: 15, method: "card", processor: "stripe", processor_ref: intent }),
      expect.objectContaining({ amount: 160, tip_amount: 0, method: "other", processor: null, notes: "Account credit in Stripe" }),
    ]);

    // The $15 reaches the bank: it's in the deposit, with its fee.
    side(key).payouts.push({ id: "po_1", amount: 1426, currency: "usd", arrival_date: 1_760_400_000, status: "paid", automatic: true, failure_message: null });
    side(key).transactions.push({ id: "txn_1", payout: "po_1", type: "charge", amount: 1500, fee: 74, net: 1426, source: { id: "ch_1", object: "charge", payment_intent: intent } });
    await event("payout.paid", { id: "po_1" });
    expect(paidIn(INV).find((p) => p.processor_ref === intent)).toMatchObject({ fee_amount: 0.74, payout_id: db.tables.payouts![0]!.id });

    // Refunded in two goes (and Stripe says the last twice), it's the tip that goes back.
    for (const refunded of [500, 1500, 1500]) await event("charge.refunded", { id: "ch_1", payment_intent: intent, amount_refunded: refunded });
    expect(paidIn(INV).filter((p) => p.amount <= 0 && p.tip_amount < 0).map((p) => [p.amount || 0, p.tip_amount, p.notes])).toEqual([[0, -5, "Refunded in Stripe"], [0, -10, "Refunded in Stripe"]]);
  });

  it("takes a lost dispute of a charge of only the tip back from the tip", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    side(key).customers.push({ id: "cus_pat", email: "pat@example.com", balance: -16000 });
    await stripeCheckout(env, db.db, CO, INV, 1500);
    payInStripe(rowsFor(INV)[0]!.stripe_id);
    await event("invoice.paid", { id: rowsFor(INV)[0]!.stripe_id });
    const intent = `pi_${rowsFor(INV)[0]!.stripe_id}`;
    // Stripe says so twice.
    await event("charge.dispute.closed", dispute(intent, 1500, "lost"));
    await event("charge.dispute.closed", dispute(intent, 1500, "lost"));
    expect(paidIn(INV).filter((p) => p.notes === "Dispute lost in Stripe").map((p) => [p.amount || 0, p.tip_amount, p.processor_ref])).toEqual([[0, -15, `${intent}:dispute:dp_1`]]);
    expect(db.tables.messages).toContainEqual(expect.objectContaining({ subject: "Dispute lost", body: expect.stringContaining("It was a tip, so the invoice is still paid.") }));
  });

  it("books the part of the tip Stripe's credit paid with the credit", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    // $170 of credit pays the $160 invoice and $10 of the $15 tip, so the card pays $5.
    const pat = { id: "cus_pat", email: "pat@example.com", balance: -17000 };
    side(key).customers.push(pat);
    await stripeCheckout(env, db.db, CO, INV, 1500);
    payInStripe(rowsFor(INV)[0]!.stripe_id);
    await event("invoice.paid", { id: rowsFor(INV)[0]!.stripe_id });
    expect(paidIn(INV).map((p) => [p.amount, p.tip_amount, p.method])).toEqual([[0, 5, "card"], [160, 10, "other"]]);
    // $200 pays it all, so Stripe charges nothing and marks it paid at once.
    pat.balance = -20000;
    await stripeCheckout(env, db.db, CO, INV2, 1500);
    expect(stripeInvoice(rowsFor(INV2)[0]!.stripe_id)).toMatchObject({ status: "paid", amount_paid: 0 });
    expect(paidIn(INV2).map((p) => [p.amount, p.tip_amount, p.notes])).toEqual([[160, 15, "Account credit in Stripe"]]);
  });

  it("books a credit note on an invoice made in Stripe, which is how the office records part of a payment there", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    // Made in Stripe for $160: the office took a $50 check off with a credit note, and Pat paid the rest there.
    side(key).invoices.set("in_made", {
      id: "in_made", status: "paid", livemode: true, customer: "cus_pat", customer_name: "Pat Client", customer_email: "pat@example.com", customer_phone: null, customer_address: null,
      metadata: {}, number: "S-0001", hosted_invoice_url: null, description: null, currency: "usd", total: 16000, amount_due: 11000, amount_paid: 11000, starting_balance: 0,
      pre_payment_credit_notes_amount: 5000, tax: null, total_discount_amounts: [], due_date: null, created: 1_760_000_000, paid_out_of_band: false, payment_intent: "pi_made", charge: null,
      status_transitions: { finalized_at: 1_760_000_000, paid_at: 1_760_000_500 }, lines: { data: [{ id: "il_1", amount: 16000, description: "Spring cleanup", quantity: 1 }], has_more: false },
    });
    await event("invoice.paid", { id: "in_made" });
    // supabase/tests/stripe_office_test.sql covers what the database makes of it.
    expect(db.rpcs.find((r) => r.fn === "stripe_import_invoice")!.args.p_data.payment).toMatchObject({ amount: 110, processor_ref: "pi_made", credited: 50 });
  });

  it("books a credit note issued in Stripe before it was paid", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    for (const id of [INV, INV2]) await syncStripeInvoice(env, db.db, CO, id);
    const [card, check] = [INV, INV2].map((id) => stripeInvoice(rowsFor(id)[0]!.stripe_id)!);
    // The office takes $20 off each in Stripe. One is paid there, the other marked paid for a check.
    for (const invoice of [card!, check!]) Object.assign(invoice, { amount_due: 14000, pre_payment_credit_notes_amount: 2000 });
    payInStripe(card!.id);
    Object.assign(check!, { status: "paid", paid_out_of_band: true });
    for (const invoice of [card!, check!]) await event("invoice.paid", { id: invoice.id });
    expect(paidIn(INV).map((p) => [p.amount, p.method, p.notes ?? null])).toEqual([[140, "card", null], [20, "other", "Credit note in Stripe"]]);
    expect(paidIn(INV2).map((p) => [p.amount, p.method, p.notes ?? null])).toEqual([[140, "other", "Marked paid in Stripe"], [20, "other", "Credit note in Stripe"]]);
  });
});

describe("keeping Stripe in step", () => {
  const event = (type: string, object: Row) => handleStripeEvent(env, db.db, { companyId: CO }, { id: `evt_${++stripe.n}`, type, data: { object } });
  const toDraft = (id: string) => (db.tables.invoices!.find((i) => i.id === id)!.status = "draft");

  it("tries again when the invoice changed while its Stripe invoice was being made", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    // The client presses Pay in the Hub, and the outbox's sync runs while Stripe makes the invoice:
    // first with nothing changed, then once the office has moved it back to draft.
    const synced: string[] = [];
    stripe.finalizing = async () => {
      synced.push(await syncStripeInvoice(env, db.db, CO, INV));
      toDraft(INV);
      synced.push(await syncStripeInvoice(env, db.db, CO, INV).catch((error: Error) => `failed: ${error.message}`));
    };
    await stripeCheckout(env, db.db, CO, INV, 0);
    stripe.finalizing = null;
    // The second failed, so the outbox runs it again, and then the Stripe invoice is voided.
    expect(synced).toEqual(["busy", "failed: Stripe's invoice for this was still being made. Trying again in a few minutes."]);
    const [made] = rowsFor(INV);
    expect(made).toMatchObject({ status: "open" });
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("voided");
    expect(stripeInvoice(made!.stripe_id)!.status).toBe("void");
  });

  it("notes when a bank payment started, for the office", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    await syncStripeInvoice(env, db.db, CO, INV);
    const [made] = rowsFor(INV);
    // Stripe's event says when it happened (Oct 3, 10am in Chicago).
    await handleStripeEvent(env, db.db, { companyId: CO }, { id: "evt_bank", type: "payment_intent.processing", created: 1_791_039_600, data: { object: { id: "pi_bank", invoice: made!.stripe_id } } });
    expect(rowsFor(INV)[0]).toMatchObject({ status: "processing", processing_at: "2026-10-03T15:00:00.000Z" });
  });

  it("catches up once a bank payment it waited for bounces", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    await syncStripeInvoice(env, db.db, CO, INV);
    const [made] = rowsFor(INV);
    // A bank payment is on its way, so the sync leaves the Stripe invoice be when the office moves
    // the invoice back to draft.
    await event("payment_intent.processing", { id: "pi_bank", invoice: made!.stripe_id });
    toDraft(INV);
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("busy");
    // It bounces: the Stripe invoice isn't left open for the client to pay.
    await event("invoice.payment_failed", { id: made!.stripe_id });
    expect(stripeInvoice(made!.stripe_id)!.status).toBe("void");
    expect(rowsFor(INV)[0]).toMatchObject({ status: "void" });
  });

  it("writes an invoice made in Stripe off there when it's written off here, and voids Crewtavo's own payment page", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    await syncStripeInvoice(env, db.db, CO, INV);
    const [ours] = rowsFor(INV);
    // INV2 was made in Stripe.
    side(key).invoices.set("in_made", { id: "in_made", status: "open", livemode: true, metadata: {}, status_transitions: { finalized_at: 1_760_000_000, paid_at: null } });
    db.tables.stripe_invoices!.push({
      id: crypto.randomUUID(), company_id: CO, invoice_id: INV2, stripe_id: "in_made", origin: "stripe", status: "open", amount_due: 160, tip_amount: 0,
      hosted_url: null, created_at: new Date().toISOString(), livemode: true, stripe_account: null, detached_at: null, collection: "send_invoice", purpose: "invoice",
    });
    for (const id of [INV, INV2]) db.tables.invoices!.find((i) => i.id === id)!.status = "written_off";

    // Stripe keeps the books for one made there, so it's written off there too.
    expect(await syncStripeInvoice(env, db.db, CO, INV2)).toBe("written off");
    expect(stripeInvoice("in_made")!.status).toBe("uncollectible");
    expect(rowsFor(INV2)[0]).toMatchObject({ status: "uncollectible" });
    expect(await syncStripeInvoice(env, db.db, CO, INV2)).toBe("nothing to do");
    // Crewtavo's own Stripe invoice is only the client's payment page: it goes, as when nothing is owed.
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("voided");
    expect(stripeInvoice(ours!.stripe_id)!.status).toBe("void");
  });

  it("writes the invoice off here when it's written off in the Stripe dashboard, once", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    await syncStripeInvoice(env, db.db, CO, INV);
    const [made] = rowsFor(INV);
    // Marked uncollectible in Stripe on Oct 3, 10am in Chicago.
    Object.assign(stripeInvoice(made!.stripe_id)!, { status: "uncollectible", status_transitions: { finalized_at: 1_760_000_100, paid_at: null, marked_uncollectible_at: 1_791_039_600 } });
    await event("invoice.marked_uncollectible", { id: made!.stripe_id });
    const invoice = db.tables.invoices!.find((i) => i.id === INV)!;
    expect(invoice).toMatchObject({ status: "written_off", written_off_at: "2026-10-03T15:00:00.000Z" });
    expect(rowsFor(INV)[0]).toMatchObject({ status: "uncollectible" });
    // The office undoes it here; Stripe sending the event again doesn't write it off again.
    invoice.status = "sent";
    await event("invoice.marked_uncollectible", { id: made!.stripe_id });
    expect(invoice.status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------------------------
// Autopay
// ---------------------------------------------------------------------------------------------

const METHOD = "00000000-0000-4000-8000-0000000000f1";
const CHARGE = "00000000-0000-4000-8000-0000000000f2";
const TOKEN = "00000000-0000-4000-8000-0000000000f3";
const event = (type: string, object: Row, route: { companyId?: string } = { companyId: CO }, e: Env = env) =>
  handleStripeEvent(e, db.db, route, { id: `evt_${++stripe.n}`, type, data: { object } });

/** A card (or bank account, by its id) saved with Pat's Stripe customer, in Stripe and here. */
function saveCard(key: string, pm = "pm_card_visa", patch: Row = {}): SavedMethod {
  if (!side(key).customers.some((c) => c.id === "cus_pat")) side(key).customers.push({ id: "cus_pat", email: "pat@example.com", balance: 0 });
  const type = pm.startsWith("pm_us_bank_account") ? "us_bank_account" : "card";
  side(key).methods.set(pm, {
    id: pm, type, customer: "cus_pat", livemode: true,
    card: type === "card" ? { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2028, wallet: null } : null,
    us_bank_account: type === "card" ? null : { bank_name: "Chase", last4: "6789" },
  });
  const row = {
    ...DEFAULTS.client_payment_methods, id: METHOD, company_id: CO, client_id: CLIENT, stripe_payment_method_id: pm, stripe_customer_id: "cus_pat", stripe_account: "acct_A",
    livemode: true, type, status: "active", is_default: true, ...patch,
  };
  (db.tables.client_payment_methods ??= []).push(row);
  return { id: row.id, stripe_payment_method_id: pm, stripe_customer_id: "cus_pat", livemode: true, stripe_account: "acct_A", type };
}

/** INV is billed by an autopay charge the task holds: a draft until it's charged. */
async function autopayInvoice(pm = "pm_card_visa") {
  const key = stripeKey("sk_live_A", "acct_A");
  await connect(key);
  const method = saveCard(key, pm);
  db.tables.invoices!.find((i) => i.id === INV)!.status = "draft";
  db.tables.autopay_charges = [{ id: CHARGE, company_id: CO, client_id: CLIENT, invoice_id: INV, payment_method_id: METHOD, status: "charging", claim_token: TOKEN, attempts: 1 }];
  return { key, method };
}

/** autopay_mark_sent as the database does it: only for exactly what's owed. */
const marked: number[] = [];
const markSent = (ok = true) => async (amountCents: number) => {
  marked.push(amountCents);
  const invoice = db.tables.invoices!.find((i) => i.id === INV)!;
  if (!ok || Math.round(invoice.balance_due * 100) !== amountCents) return false;
  if (invoice.status === "draft") invoice.status = "sent";
  return true;
};
const charge = (method: SavedMethod, options: { attempt?: number; markSent?: (amountCents: number) => Promise<boolean> } = {}) =>
  chargeInvoiceAutomatically(env, db.db, CO, { chargeId: CHARGE, attempt: options.attempt ?? 1, invoiceId: INV, method, markSent: options.markSent ?? markSent() });
const onPay = (m: string, p: string) => m === "POST" && p.endsWith("/pay");
const paidInvoice = () => Object.assign(db.tables.invoices!.find((i) => i.id === INV)!, { status: "paid", balance_due: 0, amount_paid: 160, total: 160 });

/**
 * What booking a payment does in the database, as far as autopay goes: the invoice turns paid once
 * nothing's owed (touch_parent and invoice_totals), and private.autopay_invoice_changed moves its
 * charge. When autopay's own Stripe invoice is marked paid (autopay_paid_by_charge), one on its way
 * or still to be made is paid; otherwise one on its way is left for the webhook, and one still to be
 * made is called off. A void, draft or already paid invoice doesn't turn paid, so nothing moves.
 * Returns the status the charge_automatically Stripe row had as each payment was booked.
 */
function invoiceTriggers() {
  const seen: string[] = [];
  db.hooks.insert = (table, row) => {
    if (table !== "payments" || !row.invoice_id) return;
    const invoice = db.tables.invoices!.find((i) => i.id === row.invoice_id)!;
    const own = rowsFor(invoice.id).find((r) => r.collection === "charge_automatically" && r.purpose === "invoice");
    seen.push(own?.status);
    Object.assign(invoice, { amount_paid: invoice.amount_paid + row.amount, balance_due: invoice.balance_due - row.amount });
    if (invoice.balance_due > 0 || !["sent", "partially_paid", "overdue"].includes(invoice.status)) return;
    invoice.status = "paid";
    const byCharge = own?.status === "paid";
    for (const charge of db.tables.autopay_charges ?? []) {
      if (charge.invoice_id !== invoice.id) continue;
      if (charge.status === "processing" && byCharge) charge.status = "paid";
      else if (["failed", "needs_client", "waiting", "needs_approval"].includes(charge.status)) {
        Object.assign(charge, byCharge ? { status: "paid", last_error: null } : { status: "called_off", last_error: "Paid another way" });
      }
    }
  };
  return seen;
}
/** The next insert into `table` (after `skip` that go through) fails, as a database blip would, and writes nothing. */
function failNextInsert(table: string, skip = 0) {
  const from = db.db.from.bind(db.db);
  let armed = true;
  let left = skip;
  (db.db as unknown as { from: (name: string) => any }).from = (name: string) => {
    const q = from(name as never) as any;
    if (name !== table || !armed) return q;
    const insert = q.insert;
    q.insert = (p: unknown) => {
      if (left > 0) {
        left--;
        return insert(p);
      }
      armed = false;
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: "08006", message: "connection failure" } }).then(resolve);
      return q;
    };
    return q;
  };
}

/** The charge the task held, now let go of in this status (as finish_autopay_charge leaves it). */
const chargeNow = (patch: Row) => Object.assign(db.tables.autopay_charges![0]!, { claim_token: null, ...patch });
const finishes = () => db.rpcs.filter((r) => r.fn === "finish_autopay_charge").map((r) => r.args);

describe("autopay charges", () => {
  beforeEach(() => void (marked.length = 0));

  it("makes a charge_automatically Stripe invoice, sends the invoice, pays it once and books the payment with its fee", async () => {
    const { method } = await autopayInvoice();
    expect(await charge(method)).toEqual({ outcome: "paid", amountCents: 16000 });
    const [made] = rowsFor(INV);
    expect(made).toMatchObject({ collection: "charge_automatically", purpose: "invoice", status: "paid", tip_amount: 0 });
    expect(stripeInvoice(made!.stripe_id)).toMatchObject({
      collection_method: "charge_automatically", default_payment_method: "pm_card_visa", customer: "cus_pat",
      metadata: expect.objectContaining({ crewtavo_autopay: CHARGE, crewtavo_invoice_id: INV, tip_cents: "0" }),
    });
    // No due date (Stripe refuses one on these), and Stripe sends nothing itself.
    expect(sentTo("POST", /^\/v1\/invoices$/)[0]!.body.get("due_date")).toBeNull();
    expect(marked).toEqual([16000]);
    expect(db.tables.invoices!.find((i) => i.id === INV)!.status).toBe("sent");
    // The key carries the claim's attempt and the card; the charge comes back with its fee.
    const pays = sentTo("POST", /\/pay$/);
    expect(pays.map((r) => r.idempotency)).toEqual([`crewtavo-autopay-${CHARGE}-1-pm_card_visa`]);
    expect(Object.fromEntries(pays[0]!.body)).toEqual({ off_session: "true", payment_method: "pm_card_visa", "expand[0]": "charge.balance_transaction" });
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV, amount: 160, method: "card", processor: "stripe", processor_ref: `pi_${made!.stripe_id}`, fee_amount: 4.94 })]);
  });

  it("asks Stripe before charging again when the answer was lost, so there's never a second invoice or payment", async () => {
    const { key, method } = await autopayInvoice();
    // Stripe charged it, but none of the three tries heard back.
    stripe.trouble.push({ when: onPay, times: 3, lose: true });
    expect(await charge(method)).toMatchObject({ outcome: "retry" });
    expect(db.tables.payments ?? []).toEqual([]);
    // The next try finds it paid in Stripe, and books it.
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "paid", amountCents: 16000 });
    expect(side(key).invoices.size).toBe(1);
    expect(sentTo("POST", /\/pay$/)).toHaveLength(3);
    expect(db.tables.payments).toHaveLength(1);
  });

  it("books a charge that went through before its worker stopped, on the 6th claim's check", async () => {
    const { method } = await autopayInvoice();
    stripe.trouble.push({ when: onPay, times: 3, lose: true });
    await charge(method);
    expect(await autopayStripeCheck(env, db.db, CO, INV, CHARGE)).toBe("paid");
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV, amount: 160 })]);
    expect(rowsFor(INV)[0]).toMatchObject({ status: "paid" });
    // Nothing made or still open: none.
    expect(await autopayStripeCheck(env, db.db, CO, INV2, CHARGE)).toBe("none");
  });

  it("on the 6th claim's check, never counts an earlier charge's paid Stripe invoice as this charge's", async () => {
    const { method } = await autopayInvoice();
    expect(await charge(method)).toMatchObject({ outcome: "paid" });
    // Refunded since, owed again, and charged again: the new charge's 6th claim finds only the old one.
    expect(await autopayStripeCheck(env, db.db, CO, INV, "00000000-0000-4000-8000-0000000000f9")).toBe("none");
  });

  it("on the 6th claim's check, says paid another way when its own Stripe invoice was paid with another card", async () => {
    const { method } = await autopayInvoice("pm_card_chargeDeclined");
    expect(await charge(method)).toMatchObject({ outcome: "declined" });
    payInStripe(rowsFor(INV)[0]!.stripe_id, "pm_card_mastercard");
    expect(await autopayStripeCheck(env, db.db, CO, INV, CHARGE)).toBe("other");
  });

  it("says a bank payment is on its way on the 6th claim's check, and open when it isn't paid", async () => {
    const { method } = await autopayInvoice("pm_card_chargeDeclined");
    await charge(method);
    expect(await autopayStripeCheck(env, db.db, CO, INV, CHARGE)).toBe("open");
  });

  it("tries again on Stripe being down, sends the Pay link on another refusal, and keeps the one Stripe invoice", async () => {
    const { key, method } = await autopayInvoice();
    stripe.trouble.push({ when: onPay, times: 3, status: 500 });
    expect(await charge(method)).toEqual({ outcome: "retry", message: "Something went wrong on Stripe's end" });
    stripe.trouble.push({ when: onPay, times: 3, status: 429, error: { message: "Too many requests" } });
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "retry", message: "Too many requests" });
    stripe.trouble.push({ when: onPay, times: 1, status: 400, error: { type: "invalid_request_error", message: "The PaymentMethod provided does not belong to the Customer." } });
    expect(await charge(method, { attempt: 3 })).toEqual({ outcome: "needs_client", code: null, message: "The PaymentMethod provided does not belong to the Customer" });
    expect(await charge(method, { attempt: 4 })).toMatchObject({ outcome: "paid" });
    expect(side(key).invoices.size).toBe(1);
    // A new key for each claim; the same one for stripeApi's own tries.
    expect(sentTo("POST", /\/pay$/).map((r) => r.idempotency!.replace(`crewtavo-autopay-${CHARGE}-`, "").split("-")[0])).toEqual(["1", "1", "1", "2", "2", "2", "3", "4"]);
  });

  it("answers declined with the bank's reason, and leaves the invoice owed with its Stripe page", async () => {
    const { method } = await autopayInvoice("pm_card_chargeDeclined");
    expect(await charge(method)).toEqual({ outcome: "declined", code: "insufficient_funds", message: "Your card has insufficient funds" });
    expect(rowsFor(INV)[0]).toMatchObject({ status: "open", collection: "charge_automatically" });
    expect(db.tables.invoices!.find((i) => i.id === INV)!.status).toBe("sent");
  });

  it("never charges the card again while the client's bank payment on its Stripe page clears: the next try is busy", async () => {
    const { key, method } = await autopayInvoice("pm_card_chargeDeclined");
    expect(await charge(method)).toMatchObject({ outcome: "declined" });
    const pays = sentTo("POST", /\/pay$/).length;
    // The client pays the declined charge's Stripe invoice by bank on Stripe's page.
    const [row] = rowsFor(INV);
    row!.status = "processing";
    Object.assign(side(key).intents.get(`pi_${row!.stripe_id}`)!, { status: "processing", payment_method: "pm_us_bank_account_theirs" });
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "busy", message: PROCESSING_MESSAGE });
    expect(sentTo("POST", /\/pay$/).length).toBe(pays);
  });

  it("follows its own bank payment whose answer was lost as on its way, not as busy, and never presents it again", async () => {
    const { method } = await autopayInvoice("pm_us_bank_account");
    // Stripe started the bank payment, but none of the three tries heard back.
    stripe.trouble.push({ when: onPay, times: 3, lose: true });
    expect(await charge(method)).toMatchObject({ outcome: "retry" });
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    await event("payment_intent.processing", { invoice: stripeId });
    expect(rowsFor(INV)[0]).toMatchObject({ status: "processing" });
    // The next claim takes it as this charge's bank payment on its way.
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "processing", amountCents: 16000 });
    expect(sentTo("POST", /\/pay$/)).toHaveLength(3);
  });

  it("books a charge whose booking failed on the next claim, without a second Stripe invoice or payment", async () => {
    invoiceTriggers();
    const { method } = await autopayInvoice();
    failNextInsert("payments");
    await expect(charge(method)).rejects.toThrow("connection failure");
    expect(rowsFor(INV)[0]).toMatchObject({ status: "paid" });
    expect(db.tables.payments ?? []).toEqual([]);
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "paid", amountCents: 16000 });
    expect(sentTo("POST", /^\/v1\/invoices$/)).toHaveLength(1);
    expect(sentTo("POST", /\/pay$/)).toHaveLength(1);
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV, amount: 160, processor: "stripe" })]);
  });

  it("never charges again when the client paid on Stripe's page but booking it failed: books it, paid another way", async () => {
    invoiceTriggers();
    const { key, method } = await autopayInvoice("pm_card_chargeDeclined");
    expect(await charge(method)).toMatchObject({ outcome: "declined" });
    chargeNow({ status: "failed", failures: 1 });
    // The declined charge's Stripe invoice made way for one the client pays on Stripe's page.
    const [auto] = rowsFor(INV);
    auto!.status = "void";
    side(key).invoices.get(auto!.stripe_id)!.status = "void";
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    const page = rowsFor(INV).find((r) => r.collection === "send_invoice")!;
    payInStripe(page.stripe_id, "pm_card_mastercard");
    failNextInsert("payments");
    await expect(event("invoice.paid", { id: page.stripe_id })).rejects.toThrow("connection failure");
    expect(page.status).toBe("paid");
    expect(db.tables.payments ?? []).toEqual([]);
    const made = sentTo("POST", /^\/v1\/invoices$/).length;
    const pays = sentTo("POST", /\/pay$/).length;
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "unusable", message: "Paid another way" });
    expect(sentTo("POST", /^\/v1\/invoices$/)).toHaveLength(made);
    expect(sentTo("POST", /\/pay$/)).toHaveLength(pays);
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV, amount: 160, processor: "stripe" })]);
  });

  it("never charges what's left again when only part of a payment was booked (the card's, not the credit's)", async () => {
    invoiceTriggers();
    const { key, method } = await autopayInvoice();
    side(key).customers.find((c) => c.id === "cus_pat")!.balance = -2000;
    failNextInsert("payments", 1);
    await expect(charge(method)).rejects.toThrow("connection failure");
    expect(db.tables.payments).toEqual([expect.objectContaining({ amount: 140, processor: "stripe" })]);
    expect(await charge(method, { attempt: 2 })).toMatchObject({ outcome: "paid" });
    expect(sentTo("POST", /^\/v1\/invoices$/)).toHaveLength(1);
    expect(sentTo("POST", /\/pay$/)).toHaveLength(1);
    expect(db.tables.payments!.map((p) => p.amount)).toEqual([140, 20]);
  });

  it("takes its own Stripe invoice paid wholly from credit as autopay's when booking it failed: sent, then paid, never charged", async () => {
    invoiceTriggers();
    const { key, method } = await autopayInvoice();
    side(key).customers.find((c) => c.id === "cus_pat")!.balance = -20000;
    failNextInsert("payments");
    await expect(charge(method)).rejects.toThrow("connection failure");
    expect(db.tables.payments ?? []).toEqual([]);
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "paid", amountCents: 0 });
    expect(sentTo("POST", /\/pay$/)).toEqual([]);
    expect(db.tables.payments).toEqual([expect.objectContaining({ amount: 160, notes: "Account credit in Stripe" })]);
    expect(db.tables.invoices!.find((i) => i.id === INV)!.status).toBe("paid");
  });

  it("calls a charge waiting between tries off as paid another way when the client pays its Stripe page with another card", async () => {
    invoiceTriggers();
    const { method } = await autopayInvoice("pm_card_chargeDeclined");
    expect(await charge(method)).toMatchObject({ outcome: "declined" });
    // Its next try hit a Stripe hiccup, so it waits ten minutes, claim let go.
    chargeNow({ status: "charging", failures: 1 });
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    payInStripe(stripeId, "pm_card_mastercard");
    expect(await event("invoice.paid", { id: stripeId })).toBe(CO);
    expect(db.tables.autopay_charges![0]).toMatchObject({ status: "called_off", last_error: "Paid another way" });
    expect(db.tables.invoices!.find((i) => i.id === INV)!.status).toBe("paid");
  });

  it("leaves a charge waiting between tries alone when Stripe credit paid its own Stripe invoice: that's autopay's", async () => {
    invoiceTriggers();
    const { key, method } = await autopayInvoice();
    side(key).customers.find((c) => c.id === "cus_pat")!.balance = -20000;
    failNextInsert("payments");
    await expect(charge(method)).rejects.toThrow("connection failure");
    chargeNow({ status: "charging" });
    expect(await event("invoice.paid", { id: rowsFor(INV)[0]!.stripe_id })).toBe(CO);
    expect(db.tables.autopay_charges![0]!.status).toBe("charging");
    expect(db.tables.payments).toEqual([expect.objectContaining({ amount: 160, notes: "Account credit in Stripe" })]);
  });

  it("calls its own Stripe invoice paid with another card off as paid another way when the webhook didn't get to say so", async () => {
    invoiceTriggers();
    const { method } = await autopayInvoice("pm_card_chargeDeclined");
    expect(await charge(method)).toMatchObject({ outcome: "declined" });
    chargeNow({ status: "failed", failures: 1 });
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    payInStripe(stripeId, "pm_card_mastercard");
    // The webhook marks the row paid, then can't read which card paid it.
    stripe.trouble.push({ when: (m: string, p: string) => m === "GET" && p.startsWith("/v1/payment_intents/"), times: 3, status: 500 });
    await expect(event("invoice.paid", { id: stripeId })).rejects.toThrow();
    expect(rowsFor(INV)[0]).toMatchObject({ status: "paid" });
    const pays = sentTo("POST", /\/pay$/).length;
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "unusable", message: "Paid another way" });
    expect(sentTo("POST", /\/pay$/)).toHaveLength(pays);
    expect(db.tables.payments).toHaveLength(1);
  });

  it("sends the invoice before booking credit in Stripe that paid it all, and charges the card nothing", async () => {
    invoiceTriggers();
    const { key, method } = await autopayInvoice();
    side(key).customers.find((c) => c.id === "cus_pat")!.balance = -20000;
    expect(await charge(method)).toEqual({ outcome: "paid", amountCents: 0 });
    expect(marked).toEqual([16000]);
    expect(sentTo("POST", /\/pay$/)).toEqual([]);
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV, amount: 160, method: "other", notes: "Account credit in Stripe" })]);
    // Sent, so booking it turned it paid: never a draft carrying a payment.
    expect(db.tables.invoices!.find((i) => i.id === INV)!.status).toBe("paid");
  });

  it("calls a declined charge off as paid another way when the client pays its Stripe page with another card", async () => {
    invoiceTriggers();
    const { method } = await autopayInvoice("pm_card_chargeDeclined");
    expect(await charge(method)).toMatchObject({ outcome: "declined" });
    chargeNow({ status: "failed", failures: 1 });
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    payInStripe(stripeId, "pm_card_mastercard");
    expect(await event("invoice.paid", { id: stripeId })).toBe(CO);
    expect(db.tables.autopay_charges![0]).toMatchObject({ status: "called_off", last_error: "Paid another way" });
    expect(db.tables.invoices!.find((i) => i.id === INV)!.status).toBe("paid");
    expect(db.tables.payments).toHaveLength(1);
  });

  it("calls the retry off as paid another way when the client paid with another card before Stripe said so", async () => {
    const { method } = await autopayInvoice("pm_card_chargeDeclined");
    expect(await charge(method)).toMatchObject({ outcome: "declined" });
    const pays = sentTo("POST", /\/pay$/).length;
    payInStripe(rowsFor(INV)[0]!.stripe_id, "pm_card_mastercard");
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "unusable", message: "Paid another way" });
    expect(sentTo("POST", /\/pay$/)).toHaveLength(pays);
    expect(db.tables.payments).toHaveLength(1);
  });

  it("needs the client when their bank wants to confirm the payment", async () => {
    const { method } = await autopayInvoice("pm_card_authenticationRequired");
    expect(await charge(method)).toEqual({ outcome: "needs_client", code: "authentication_required", message: "Their bank wants them to confirm the payment" });
  });

  it("marks a bank payment on its way, unless its bounce came first", async () => {
    const { method } = await autopayInvoice("pm_us_bank_account");
    expect(await charge(method)).toEqual({ outcome: "processing", amountCents: 16000 });
    expect(rowsFor(INV)[0]).toMatchObject({ status: "processing", processing_at: expect.any(String) });

    db.tables.stripe_invoices = [];
    db.tables.invoices!.find((i) => i.id === INV)!.status = "draft";
    stripe.bounceFirst = true;
    expect(await charge(method, { attempt: 2 })).toEqual({ outcome: "bank_failed", code: "account_closed", message: "The customer's bank account has been closed" });
    expect(rowsFor(INV)[0]).toMatchObject({ status: "open" });
  });

  it("voids the Pay-link Stripe invoice first", async () => {
    const { method } = await autopayInvoice();
    // An earlier send made one the client pays on Stripe's page.
    db.tables.invoices!.find((i) => i.id === INV)!.status = "sent";
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    const [payLink] = rowsFor(INV);
    expect(await charge(method)).toMatchObject({ outcome: "paid" });
    expect(stripeInvoice(payLink!.stripe_id)!.status).toBe("void");
    expect(rowsFor(INV).map((r) => [r.collection, r.status])).toEqual([["send_invoice", "void"], ["charge_automatically", "paid"]]);
  });

  it("never takes the Pay link the client paid on Stripe's page just before as the saved card's charge", async () => {
    const { method } = await autopayInvoice();
    db.tables.invoices!.find((i) => i.id === INV)!.status = "sent";
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    // Paid there as Charge card is pressed: voiding it finds it paid, and books it.
    payInStripe(rowsFor(INV)[0]!.stripe_id, "pm_card_mastercard");
    expect(await charge(method)).toEqual({ outcome: "unusable", message: "Paid another way" });
    expect(sentTo("POST", /\/pay$/)).toEqual([]);
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV, amount: 160, processor: "stripe" })]);
  });

  it("never takes its own Stripe invoice paid there with another card, as the retry sends it, as the saved card's", async () => {
    const { method } = await autopayInvoice("pm_card_chargeDeclined");
    expect(await charge(method)).toMatchObject({ outcome: "declined" });
    const own = rowsFor(INV)[0]!.stripe_id;
    const pays = sentTo("POST", /\/pay$/).length;
    const meanwhile = async () => {
      payInStripe(own, "pm_card_mastercard");
      return false;
    };
    expect(await charge(method, { attempt: 2, markSent: meanwhile })).toEqual({ outcome: "unusable", message: "Paid another way" });
    expect(sentTo("POST", /\/pay$/)).toHaveLength(pays);
  });

  // An earlier charge's worker stopped after making its Stripe invoice, before sending it.
  const OLD_CHARGE = "00000000-0000-4000-8000-0000000000f9";
  const leftByEarlierCharge = async (method: SavedMethod) => {
    const stop = async () => {
      throw new Error("worker stopped");
    };
    await expect(chargeInvoiceAutomatically(env, db.db, CO, { chargeId: OLD_CHARGE, attempt: 1, invoiceId: INV, method, markSent: stop })).rejects.toThrow("worker stopped");
    const [old] = rowsFor(INV);
    expect(stripeInvoice(old!.stripe_id)).toMatchObject({ status: "open", metadata: expect.objectContaining({ crewtavo_autopay: OLD_CHARGE }) });
    return old!;
  };

  it("never reuses a Stripe invoice an earlier charge left open: voids it and charges one of its own", async () => {
    const { method } = await autopayInvoice();
    const old = await leftByEarlierCharge(method);
    expect(await charge(method)).toEqual({ outcome: "paid", amountCents: 16000 });
    expect(stripeInvoice(old.stripe_id)!.status).toBe("void");
    const paid = rowsFor(INV).find((r) => r.status === "paid")!;
    expect(stripeInvoice(paid.stripe_id)!.metadata).toMatchObject({ crewtavo_autopay: CHARGE });
    expect(sentTo("POST", /\/pay$/)).toHaveLength(1);
  });

  it("never takes a Stripe invoice an earlier charge left, paid meanwhile with the saved card, as this charge's", async () => {
    const { method } = await autopayInvoice();
    const old = await leftByEarlierCharge(method);
    payInStripe(old.stripe_id, "pm_card_visa");
    expect(await charge(method)).toEqual({ outcome: "unusable", message: "Paid another way" });
    expect(sentTo("POST", /\/pay$/)).toEqual([]);
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV, amount: 160, processor: "stripe" })]);
  });

  it("leaves less than Stripe can charge alone", async () => {
    const { method } = await autopayInvoice();
    Object.assign(db.tables.invoices!.find((i) => i.id === INV)!, { balance_due: 0.4 });
    expect(await charge(method)).toEqual({ outcome: "too_small" });
    expect(sentTo("POST", /^\/v1\/invoices/)).toEqual([]);
  });

  it("won't charge more than the invoice when the client owes from before in Stripe", async () => {
    const { key, method } = await autopayInvoice();
    side(key).customers.find((c) => c.id === "cus_pat")!.balance = 2500;
    expect(await charge(method)).toEqual({ outcome: "unusable", message: "Their balance in Stripe would change the charge. Send it the usual way" });
    expect(stripeInvoice(rowsFor(INV)[0]!.stripe_id)).toMatchObject({ status: "void", amount_due: 18500 });
    expect(marked).toEqual([]);
    expect(sentTo("POST", /\/pay$/)).toEqual([]);
  });

  it("voids the Stripe invoice and tries again later when the invoice changed before it was sent", async () => {
    const { method } = await autopayInvoice();
    expect(await charge(method, { markSent: markSent(false) })).toEqual({ outcome: "retry", message: "The invoice changed while it was being charged" });
    expect(stripeInvoice(rowsFor(INV)[0]!.stripe_id)!.status).toBe("void");
    expect(sentTo("POST", /\/pay$/)).toEqual([]);
  });

  it("stops using a key Stripe turns down, and tells the office once a day", async () => {
    const { method } = await autopayInvoice();
    stripe.trouble.push({ when: onPay, times: 2, status: 403, error: { type: "permission_error", message: "The provided key does not have the required permissions for this endpoint" } });
    const unusable = { outcome: "unusable", message: "Your Stripe key can't charge saved cards anymore. Update it on the Apps page." };
    expect(await charge(method)).toEqual(unusable);
    expect(db.tables.integrations![0]!.settings).toMatchObject({ autopay: false, refunds: true, key_alerted_at: expect.any(String) });
    expect(db.tables.notifications).toEqual([
      expect.objectContaining({ user_id: USER, kind: "autopay", title: "Your Stripe key can't charge saved cards anymore", body: "Update it on the Apps page. Until then, invoices go out with the Pay link.", link: "/apps/stripe" }),
    ]);
    expect(await charge(method, { attempt: 2 })).toEqual(unusable);
    expect(db.tables.notifications).toHaveLength(1);
    expect((await stripeCapabilities(env, db.db, CO, { cached: true })).autopay).toBe(false);
  });

  it("calls it off with a card that isn't in Stripe anymore, which is taken off here", async () => {
    const { key, method } = await autopayInvoice();
    side(key).customers.splice(0);
    expect(await charge(method)).toEqual({ outcome: "unusable", message: "The saved card isn't in Stripe anymore" });
    expect(db.tables.client_payment_methods![0]).toMatchObject({ status: "removed", removed_reason: "stripe", is_default: false });
  });

  it("lets the outbox's sync be while the task makes it, and is in step with it once sent", async () => {
    const { method } = await autopayInvoice();
    const synced: string[] = [];
    stripe.finalizing = async () => void synced.push(await syncStripeInvoice(env, db.db, CO, INV));
    const send = markSent();
    const sent = async (amountCents: number) => {
      const ok = await send(amountCents);
      synced.push(await syncStripeInvoice(env, db.db, CO, INV));
      return ok;
    };
    expect(await charge(method, { markSent: sent })).toMatchObject({ outcome: "paid" });
    expect(synced).toEqual(["busy", "in step"]);
  });

  it("reads back a bank payment the webhook never settled", async () => {
    const { key, method } = await autopayInvoice("pm_us_bank_account");
    await charge(method);
    db.tables.autopay_charges![0]!.status = "processing";
    db.tables.autopay_charges![0]!.updated_at = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    // Two days on, Stripe says it bounced.
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    Object.assign(side(key).intents.get(`pi_${stripeId}`)!, { status: "requires_payment_method", last_payment_error: { code: "insufficient_funds", message: "Not enough money" } });
    expect(await reconcileAutopayProcessing(env, db.db)).toBe(1);
    expect(db.rpcs.find((r) => r.fn === "finish_autopay_charge")!.args).toEqual({
      p_id: CHARGE, p_outcome: "bank_failed", p_company: CO, p_error: "The bank payment didn't go through", p_decline: "insufficient_funds",
    });
    expect(rowsFor(INV)[0]).toMatchObject({ status: "open" });
  });

  it("marks autopay's Stripe invoice paid before booking its payment, so a charge the client confirmed there counts as paid by autopay", async () => {
    const seen = invoiceTriggers();
    const { method } = await autopayInvoice("pm_card_authenticationRequired");
    expect(await charge(method)).toMatchObject({ outcome: "needs_client" });
    chargeNow({ status: "needs_client" });
    // The client opens the invoice and confirms with their bank on the same Stripe page.
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    payInStripe(stripeId);
    expect(await event("invoice.paid", { id: stripeId })).toBe(CO);
    expect(seen).toEqual(["paid"]);
    expect(db.tables.autopay_charges![0]).toMatchObject({ status: "paid", last_error: null });
    expect(db.tables.invoices!.find((i) => i.id === INV)!.status).toBe("paid");
    // Stripe sending it again books nothing more.
    await event("invoice.payment_succeeded", { id: stripeId });
    expect(db.tables.payments).toHaveLength(1);
    expect(finishes()).toEqual([]);
  });

  it("settles a bank payment through the invoice turning paid, when that's how it ends", async () => {
    invoiceTriggers();
    const { method } = await autopayInvoice("pm_us_bank_account");
    await charge(method);
    chargeNow({ status: "processing", charged_amount: 160 });
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    payInStripe(stripeId);
    await event("invoice.paid", { id: stripeId });
    expect(db.tables.autopay_charges![0]).toMatchObject({ status: "paid" });
    // The trigger did it, so there was nothing left to finish.
    expect(finishes()).toEqual([]);
  });

  it("finishes a bank payment that settles after its invoice was voided or moved back to draft, with what Stripe took", async () => {
    invoiceTriggers();
    for (const status of ["void", "draft"]) {
      db.tables.payments = [];
      db.rpcs.length = 0;
      const { method } = await autopayInvoice("pm_us_bank_account");
      db.tables.stripe_invoices = [];
      await charge(method);
      chargeNow({ status: "processing", charged_amount: 150 });
      // The office voids it (or moves it back to draft) while the payment is on its way.
      db.tables.invoices!.find((i) => i.id === INV)!.status = status;
      const stripeId = rowsFor(INV)[0]!.stripe_id;
      payInStripe(stripeId);
      expect(await event("invoice.paid", { id: stripeId })).toBe(CO);
      expect(finishes()).toEqual([{ p_id: CHARGE, p_outcome: "paid", p_company: CO, p_amount: 160 }]);
      expect(db.tables.autopay_charges![0]).toMatchObject({ status: "paid", charged_amount: 160 });
      expect(rowsFor(INV)[0]).toMatchObject({ status: "paid" });
      // A void invoice stays void, so the money is the client's.
      expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: status === "void" ? null : INV, amount: 160 })]);
      expect(db.tables.invoices!.find((i) => i.id === INV)!.status).toBe(status);
    }
  });

  it("finishes a bank payment it reads back that settled on a void invoice before settling finished charges", async () => {
    const { method } = await autopayInvoice("pm_us_bank_account");
    await charge(method);
    db.tables.invoices!.find((i) => i.id === INV)!.status = "void";
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    payInStripe(stripeId);
    // Its webhook came before: the payment is booked and the Stripe row paid, but the charge was left on its way.
    rowsFor(INV)[0]!.status = "paid";
    db.tables.payments = [{ id: crypto.randomUUID(), company_id: CO, invoice_id: null, client_id: CLIENT, amount: 160, tip_amount: 0, processor: "stripe", processor_ref: `pi_${stripeId}` }];
    chargeNow({ status: "processing", updated_at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() });
    expect(await reconcileAutopayProcessing(env, db.db)).toBe(1);
    expect(db.tables.autopay_charges![0]).toMatchObject({ status: "paid", charged_amount: 160 });
    expect(db.tables.payments).toHaveLength(1);
    // Nothing's left for the next hour.
    expect(await reconcileAutopayProcessing(env, db.db)).toBe(0);
  });

  it("calls off a bank payment in a Stripe account Crewtavo left once it has cleared or bounced there, rather than keep it on its way for good", async () => {
    const { method } = await autopayInvoice("pm_us_bank_account");
    await charge(method);
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000).toISOString();
    // The company switched Stripe accounts: autopay's Stripe invoice isn't followed any more.
    rowsFor(INV)[0]!.detached_at = days(3);
    chargeNow({ status: "processing", updated_at: days(3) });
    // It may still clear there: left as it is (the office was told to check it there), and never
    // read back with the new account's key.
    const calls = stripe.calls.length;
    expect(await reconcileAutopayProcessing(env, db.db)).toBe(0);
    expect(db.tables.autopay_charges![0]).toMatchObject({ status: "processing" });
    expect(stripe.calls).toHaveLength(calls);
    // Past the days one can take, it's called off, as leaving the account does for an older one.
    chargeNow({ status: "processing", updated_at: days(31) });
    expect(await reconcileAutopayProcessing(env, db.db)).toBe(1);
    expect(db.tables.autopay_charges![0]).toMatchObject({ status: "called_off", last_error: "The Stripe account it was in was switched away from. Check it there" });
    expect(await reconcileAutopayProcessing(env, db.db)).toBe(0);
    // Stripe disconnected altogether: the same.
    rowsFor(INV)[0]!.detached_at = null;
    chargeNow({ status: "processing", last_error: null, updated_at: days(31) });
    db.tables.integration_secrets = [];
    expect(await reconcileAutopayProcessing(env, db.db)).toBe(1);
    expect(db.tables.autopay_charges![0]).toMatchObject({ status: "called_off" });
  });
});

describe("Stripe invoices with a tip, or left by autopay", () => {
  it("voids a payment page with a tip once tips are turned off, and makes one without it", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    await stripeCheckout(env, db.db, CO, INV, 1500);
    const [tipped] = rowsFor(INV);
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("in step");
    db.tables.companies![0]!.settings = { hub_tips: false };
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    expect(stripeInvoice(tipped!.stripe_id)!.status).toBe("void");
    const now = rowsFor(INV).find((r) => r.status === "open")!;
    expect(now).toMatchObject({ tip_amount: 0, amount_due: 160, collection: "send_invoice" });
    expect(stripeInvoice(now.stripe_id)).toMatchObject({ amount_due: 16000, metadata: expect.objectContaining({ tip_cents: "0" }) });
    expect(stripeInvoice(now.stripe_id)!.items.map((i: Row) => i.description)).not.toContain("Tip for the crew");
  });

  it("pays without the tip at once when tips were turned off, past the hourly limit", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    for (const tip of [500, 1000, 1500, 2000, 2500]) await stripeCheckout(env, db.db, CO, INV, tip);
    await expect(stripeCheckout(env, db.db, CO, INV, 3000)).rejects.toMatchObject({ status: 429 });
    db.tables.companies![0]!.settings = { hub_tips: false };
    const url = await stripeCheckout(env, db.db, CO, INV, 0);
    expect(rowsFor(INV).find((r) => r.status === "open")).toMatchObject({ hosted_url: url, tip_amount: 0, amount_due: 160 });
    expect(side(key).invoices.size).toBe(6);
    // And no tip goes on it now, whoever asks.
    await expect(stripeCheckout(env, db.db, CO, INV, 500)).rejects.toMatchObject({ status: 409, message: "Tips aren't offered here anymore. Check the amount and pay again." });
    expect(side(key).invoices.size).toBe(6);
  });

  it("replaces an autopay Stripe invoice that nothing will charge with a Pay link", async () => {
    const { method } = await autopayInvoice("pm_card_chargeDeclined");
    await charge(method);
    // Declined once: the retry in 3 days charges this one.
    Object.assign(db.tables.autopay_charges![0]!, { status: "failed", claim_token: null });
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("in step");
    // The office calls it off.
    db.tables.autopay_charges![0]!.status = "called_off";
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    expect(rowsFor(INV).map((r) => [r.collection, r.status])).toEqual([["charge_automatically", "void"], ["send_invoice", "open"]]);
  });

  it("voids a Stripe invoice with a tip when tips were turned off while it was being made", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    // The invoice was sent, so its Stripe invoice without a tip is there.
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    // The client pays with a tip, and the owner turns tips off while Stripe makes that one.
    stripe.finalizing = async () => void (db.tables.companies![0]!.settings = { hub_tips: false });
    await expect(stripeCheckout(env, db.db, CO, INV, 900)).rejects.toMatchObject({ status: 409, message: "Tips aren't offered here anymore. Check the amount and pay again." });
    const tipped = rowsFor(INV).find((r) => r.tip_amount === 9)!;
    expect(tipped).toMatchObject({ status: "void", amount_due: 169 });
    expect(stripeInvoice(tipped.stripe_id)!.status).toBe("void");
    expect(rowsFor(INV).filter((r) => LIVE.includes(r.status))).toEqual([]);
    // Paying without it works.
    stripe.finalizing = null;
    const url = await stripeCheckout(env, db.db, CO, INV, 0);
    expect(rowsFor(INV).find((r) => r.status === "open")).toMatchObject({ hosted_url: url, tip_amount: 0, amount_due: 160 });
  });

  it("with tips off, the Hub's Pay makes a Stripe invoice with no tip", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    db.tables.companies![0]!.settings = { hub_tips: false };
    const token = (await clientLink(env, BASE, { c: CO, t: "invoice", id: INV })).split("/hub/")[1]!;
    const res = await app.request(`/api/hub/${token}/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tip: 0 }) }, env);
    expect(res.status).toBe(200);
    const [made] = rowsFor(INV);
    expect(made).toMatchObject({ tip_amount: 0, amount_due: 160 });
    expect(stripeInvoice(made!.stripe_id)).toMatchObject({ metadata: expect.objectContaining({ tip_cents: "0" }) });
    expect(stripeInvoice(made!.stripe_id)!.items).toEqual([{ amount: 16000, description: "Weekly mowing (4 visit × $40.00)" }]);
  });
});

describe("saving a card", () => {
  const urls = { successUrl: `${BASE}/hub/t?view=autopay&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${BASE}/hub/t?view=autopay` };
  const card = (id: string, checks: Row = {}) => ({
    id, type: "card", card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2028, wallet: null, checks: { cvc_check: "pass", address_postal_code_check: "pass", ...checks } },
  });
  /** The client opens Stripe's page, from their own Hub link or the office's copy of it. */
  async function open(via: "client" | "office" | "legacy" = "client", links = urls) {
    const key = stripeKey("sk_live_A", "acct_A");
    if (!stripe.keys.has(key) || !db.tables.integrations?.length) await connect(key);
    const url = await stripeSetupSession(env, db.db, CO, CLIENT, links, via);
    const session = [...side(key).sessions.values()].at(-1)!;
    expect(url).toBe(session.url);
    return { key, session };
  }
  /** The client finishes on Stripe's page with this payment method. */
  function finishOnStripe(key: string, session: Row, pm: Row, status = "succeeded") {
    side(key).methods.set(pm.id, { customer: session.customer, livemode: true, ...pm });
    Object.assign(side(key).setups.get(session.setup_intent)!, { status, payment_method: pm.id });
    session.status = "complete";
  }
  const completed = (session: Row) => ({ id: session.id, mode: "setup", metadata: session.metadata });

  it("opens Stripe's page in setup mode for the client's customer, with Crewtavo's own metadata", async () => {
    const { key, session } = await open();
    const ours = { crewtavo_company_id: CO, crewtavo_client_id: CLIENT, crewtavo_kind: "autopay", crewtavo_via: "client" };
    expect(session).toMatchObject({ mode: "setup", currency: "usd", success_url: urls.successUrl, cancel_url: urls.cancelUrl, metadata: ours });
    expect(side(key).setups.get(session.setup_intent)!.metadata).toEqual(ours);
    const [sent] = sentTo("POST", /^\/v1\/checkout\/sessions$/).filter((r) => r.body.get("mode"));
    // The minute, and a digest of what's sent.
    expect(sent!.idempotency).toMatch(new RegExp(`^crewtavo-setup-${CLIENT}-\\d+-[0-9a-f]{16}$`));
    // Checkout offers whatever the business has turned on in Stripe.
    expect([...sent!.body.keys()].filter((name) => name.startsWith("payment_method_types"))).toEqual([]);
  });

  it("asks for a new key when the key can't make the page", async () => {
    await connect(stripeKey("rk_live_OLD", "acct_A", { autopay: false }));
    await expect(stripeSetupSession(env, db.db, CO, CLIENT, urls, "client")).rejects.toMatchObject({ status: 409, message: "This business needs to update its Stripe key before cards can be saved." });
  });

  it("saves the card once, from the return page and both webhooks", async () => {
    const { key, session } = await open();
    finishOnStripe(key, session, card("pm_new"));
    expect(await finishStripeSetup(env, db.db, CO, CLIENT, session.id)).toEqual({ status: "agree", method: { id: expect.any(String), label: "Visa ending 4242", type: "card", exp: "08/28" } });
    expect(await event("checkout.session.completed", completed(session))).toBe(CO);
    expect(await event("setup_intent.succeeded", { id: session.setup_intent, metadata: session.metadata })).toBe(CO);
    expect(await finishStripeSetup(env, db.db, CO, CLIENT, session.id)).toMatchObject({ status: "agree" });
    expect(db.tables.client_payment_methods).toEqual([
      expect.objectContaining({
        client_id: CLIENT, stripe_payment_method_id: "pm_new", stripe_customer_id: session.customer, stripe_account: "acct_A", livemode: true, type: "card", brand: "visa", last4: "4242",
        exp_month: 8, exp_year: 2028, status: "active", source: "hub", saved_via: "client", is_default: true,
      }),
    ]);
  });

  it("keeps which kind of Hub link the card was saved through, and counts a setup from before that as the client's", async () => {
    // From the office's copy of the client's link, finished by the webhook.
    const office = await open("office");
    expect(office.session.metadata).toMatchObject({ crewtavo_via: "office" });
    expect(side(office.key).setups.get(office.session.setup_intent)!.metadata).toMatchObject({ crewtavo_via: "office" });
    finishOnStripe(office.key, office.session, card("pm_office"));
    expect(await event("checkout.session.completed", completed(office.session))).toBe(CO);
    // From the client's own link, finished on the return page.
    const own = { successUrl: `${BASE}/hub/own?view=autopay&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${BASE}/hub/own?view=autopay` };
    const client = await open("client", own);
    finishOnStripe(client.key, client.session, card("pm_client"));
    await finishStripeSetup(env, db.db, CO, CLIENT, client.session.id);
    // One opened before Crewtavo kept which, finished by its SetupIntent's webhook.
    const before = { successUrl: `${BASE}/hub/old?view=autopay&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${BASE}/hub/old?view=autopay` };
    const old = await open("office", before);
    delete old.session.metadata.crewtavo_via;
    delete side(old.key).setups.get(old.session.setup_intent)!.metadata.crewtavo_via;
    finishOnStripe(old.key, old.session, card("pm_old"));
    expect(await event("setup_intent.succeeded", { id: old.session.setup_intent, metadata: old.session.metadata })).toBe(CO);
    // From a client link minted before own links were marked.
    const legacy = await open("legacy", { successUrl: `${BASE}/hub/legacy?view=autopay&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${BASE}/hub/legacy?view=autopay` });
    expect(legacy.session.metadata).toMatchObject({ crewtavo_via: "legacy" });
    finishOnStripe(legacy.key, legacy.session, card("pm_legacy"));
    expect(await event("checkout.session.completed", completed(legacy.session))).toBe(CO);

    const kept = [["pm_office", "office"], ["pm_client", "client"], ["pm_old", "client"], ["pm_legacy", "legacy"]];
    expect(db.rpcs.filter((r) => r.fn === "autopay_save_payment_method").map((r) => [r.args.p_method.stripe_payment_method_id, r.args.p_method.saved_via])).toEqual(kept);
    expect(db.tables.client_payment_methods!.map((m) => [m.stripe_payment_method_id, m.saved_via])).toEqual(kept);
  });

  it("gives each tap its own page (each sends its own return links), and Stripe's replay of one request the same page", async () => {
    const first = await open();
    // Back from Stripe's page and tapped again: the Hub link in the return links is signed afresh.
    const again = { successUrl: `${BASE}/hub/t2?view=autopay&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${BASE}/hub/t2?view=autopay` };
    const second = await open("client", again);
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session).toMatchObject({ success_url: again.successUrl, cancel_url: again.cancelUrl });
    // Stripe made it, but its answer was lost: stripeApi's own try gets the same page.
    const third = { successUrl: `${BASE}/hub/t3?view=autopay&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${BASE}/hub/t3?view=autopay` };
    stripe.trouble.push({ when: (m, p) => m === "POST" && p === "/v1/checkout/sessions", times: 1, lose: true });
    const url = await stripeSetupSession(env, db.db, CO, CLIENT, third, "client");
    expect(side(first.key).sessions.size).toBe(3);
    expect(url).toBe([...side(first.key).sessions.values()].at(-1)!.url);
    // (The key's probe sends one without a mode.)
    const keys = sentTo("POST", /^\/v1\/checkout\/sessions$/).filter((r) => r.body.get("mode")).map((r) => r.idempotency);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(3);
  });

  it("makes a new customer for one deleted in Stripe, and its page in the same minute", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    db.tables.sync_links = [{ company_id: CO, provider: "stripe", entity: "client", local_id: CLIENT, external_id: "cus_deleted" }];
    side(key).customers.length = 0;
    const url = await stripeSetupSession(env, db.db, CO, CLIENT, urls, "client");
    const [session] = [...side(key).sessions.values()];
    expect(url).toBe(session!.url);
    expect(session!.customer).not.toBe("cus_deleted");
    expect(db.tables.sync_links![0]!.external_id).toBe(session!.customer);
    const [refused, made] = sentTo("POST", /^\/v1\/checkout\/sessions$/).filter((r) => r.body.get("mode"));
    expect(made!.idempotency).not.toBe(refused!.idempotency);
  });

  it("asks for another try when Stripe is still busy with the last tap's page", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    const opening = (m: string, p: string) => m === "POST" && p === "/v1/checkout/sessions";
    const busy = { status: 503, message: "Stripe is still opening the last page. Try again in a moment." };
    stripe.trouble.push({ when: opening, times: 1, status: 409, error: { type: "invalid_request_error", code: "idempotency_key_in_use", message: "There is currently another in-progress request using this Idempotent Key." } });
    await expect(stripeSetupSession(env, db.db, CO, CLIENT, urls, "client")).rejects.toMatchObject(busy);
    stripe.trouble.push({ when: opening, times: 1, status: 400, error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } });
    await expect(stripeSetupSession(env, db.db, CO, CLIENT, urls, "client")).rejects.toMatchObject(busy);
    // Then it goes through.
    expect(await stripeSetupSession(env, db.db, CO, CLIENT, urls, "client")).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  });

  it("keeps the card a client agreed to as their default until they agree to the new one", async () => {
    const { key, session } = await open();
    saveCard(key, "pm_agreed");
    db.tables.autopay_authorizations = [{ id: crypto.randomUUID(), company_id: CO, client_id: CLIENT, payment_method_id: METHOD, revoked_at: null }];
    finishOnStripe(key, session, card("pm_new"));
    expect(await finishStripeSetup(env, db.db, CO, CLIENT, session.id)).toMatchObject({ status: "agree" });
    expect(db.tables.client_payment_methods!.map((m) => [m.stripe_payment_method_id, m.is_default])).toEqual([["pm_agreed", true], ["pm_new", false]]);
    expect(db.rpcs.find((r) => r.fn === "autopay_save_payment_method")!.args.p_method).toMatchObject({ make_default: false });
  });

  it("refuses a card whose security code didn't check out, takes it off in Stripe, and never brings it back", async () => {
    const { key, session } = await open();
    finishOnStripe(key, session, card("pm_bad", { cvc_check: "fail" }));
    expect(await finishStripeSetup(env, db.db, CO, CLIENT, session.id)).toEqual({
      status: "refused", reason: "Your bank couldn't confirm the card's security code or ZIP code. Try again or use another card.",
    });
    expect(side(key).methods.get("pm_bad")!.customer).toBeNull();
    expect(db.tables.client_payment_methods).toEqual([expect.objectContaining({ stripe_payment_method_id: "pm_bad", status: "removed", removed_reason: "checks", is_default: false })]);
    // Stripe repeating the webhook doesn't bring it back.
    expect(await event("setup_intent.succeeded", { id: session.setup_intent, metadata: session.metadata })).toBeNull();
    expect(db.tables.client_payment_methods).toEqual([expect.objectContaining({ status: "removed" })]);
  });

  it("never brings back a card taken off since", async () => {
    const { key, session } = await open();
    finishOnStripe(key, session, card("pm_new"));
    await finishStripeSetup(env, db.db, CO, CLIENT, session.id);
    Object.assign(db.tables.client_payment_methods![0]!, { status: "removed", removed_reason: "client" });
    expect(await finishStripeSetup(env, db.db, CO, CLIENT, session.id)).toEqual({ status: "refused", reason: "That card was removed. Add it again to use it." });
    expect(await event("checkout.session.completed", completed(session))).toBeNull();
    expect(db.tables.client_payment_methods![0]).toMatchObject({ status: "removed", removed_reason: "client" });
  });

  it("saves a bank account waiting on its small deposits as pending, and lets it go when they fail", async () => {
    const { key, session } = await open();
    finishOnStripe(key, session, { id: "pm_us_bank_account_1", type: "us_bank_account", us_bank_account: { bank_name: "Chase", last4: "6789" } }, "requires_action");
    expect(await finishStripeSetup(env, db.db, CO, CLIENT, session.id)).toEqual({ status: "pending", method: { id: expect.any(String), label: "Chase ending 6789", type: "us_bank_account", exp: null } });
    expect(db.tables.client_payment_methods![0]).toMatchObject({ status: "pending", bank_name: "Chase" });
    // The deposits didn't match: Stripe takes the account off the setup.
    Object.assign(side(key).setups.get(session.setup_intent)!, {
      status: "requires_payment_method", payment_method: null, last_setup_error: { code: "payment_method_microdeposit_verification_attempts_exceeded", payment_method: { id: "pm_us_bank_account_1" } },
    });
    expect(await event("setup_intent.setup_failed", { id: session.setup_intent, metadata: session.metadata })).toBe(CO);
    expect(db.tables.client_payment_methods![0]).toMatchObject({ status: "removed", removed_reason: "stripe" });
  });

  it("refuses another client's or company's setup, and the shared webhook does nothing", async () => {
    const { key, session } = await open();
    finishOnStripe(key, session, card("pm_new"));
    const someoneElse = "00000000-0000-4000-8000-0000000000c2";
    await expect(finishStripeSetup(env, db.db, CO, someoneElse, session.id)).rejects.toMatchObject({ status: 404, message: "That setup isn't for this client." });
    // Another company's setup in the same Stripe account.
    session.metadata = { ...session.metadata, crewtavo_company_id: OTHER_CO };
    side(key).setups.get(session.setup_intent)!.metadata = session.metadata;
    await expect(finishStripeSetup(env, db.db, CO, CLIENT, session.id)).rejects.toMatchObject({ status: 404 });
    expect(await event("checkout.session.completed", completed(session))).toBeNull();
    expect(await event("setup_intent.succeeded", { id: session.setup_intent, metadata: session.metadata })).toBeNull();
    // The deployment's webhook can't vouch for whose it is.
    session.metadata = { ...session.metadata, crewtavo_company_id: CO };
    const shared = { ...env, STRIPE_SECRET_KEY: key };
    expect(await event("checkout.session.completed", completed(session), {}, shared)).toBeNull();
    expect(await event("setup_intent.succeeded", { id: session.setup_intent, metadata: session.metadata }, {}, shared)).toBeNull();
    expect(db.tables.client_payment_methods ?? []).toEqual([]);
  });

  it("ignores the business's own setups in Stripe without asking Stripe about them", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    const before = stripe.calls.length;
    expect(await event("setup_intent.succeeded", { id: "seti_theirs", metadata: {} })).toBeNull();
    expect(await event("setup_intent.setup_failed", { id: "seti_theirs", metadata: { crewtavo_kind: "autopay" } })).toBeNull();
    expect(stripe.calls.length).toBe(before);
  });
});

describe("cards changing in Stripe", () => {
  it("takes off one removed in Stripe, updates one the bank renewed, and pauses a bank account whose mandate ended", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    // Pat's card expired, so two declines left it needing an update.
    saveCard(key, "pm_card_visa", { status: "needs_update", exp_month: 1, exp_year: 2025 });
    const bank = "00000000-0000-4000-8000-0000000000f4";
    saveCard(key, "pm_us_bank_account_2", { id: bank, is_default: false });
    // Another company's card with the same Stripe id isn't touched.
    db.tables.client_payment_methods!.push({ ...db.tables.client_payment_methods![0]!, id: crypto.randomUUID(), company_id: OTHER_CO });

    Object.assign(side(key).methods.get("pm_card_visa")!.card, { last4: "1881", exp_month: 9, exp_year: 2030 });
    expect(await event("payment_method.automatically_updated", { id: "pm_card_visa" })).toBeNull();
    expect(db.tables.client_payment_methods![0]).toMatchObject({ last4: "1881", exp_month: 9, exp_year: 2030, status: "active" });

    expect(await event("mandate.updated", { id: "mandate_1", status: "inactive", payment_method: "pm_us_bank_account_2" })).toBeNull();
    expect(db.tables.client_payment_methods!.find((m) => m.id === bank)).toMatchObject({ status: "needs_update" });

    await event("payment_method.detached", { id: "pm_card_visa" });
    expect(db.tables.client_payment_methods![0]).toMatchObject({ status: "removed", removed_reason: "stripe", is_default: false });
    const removedAt = db.tables.client_payment_methods![0]!.removed_at;
    await event("payment_method.detached", { id: "pm_card_visa" });
    expect(db.tables.client_payment_methods![0]!.removed_at).toBe(removedAt);
    expect(db.tables.client_payment_methods![2]).toMatchObject({ company_id: OTHER_CO, status: "needs_update", last4: null });
  });

  it("needs the client when an autopay bank payment bounces, and leaves its Stripe page to pay", async () => {
    const { key, method } = await autopayInvoice("pm_us_bank_account");
    await charge(method);
    db.tables.autopay_charges![0]!.status = "processing";
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    Object.assign(side(key).intents.get(`pi_${stripeId}`)!, { status: "requires_payment_method", last_payment_error: { code: "insufficient_funds" } });
    await event("invoice.payment_failed", { id: stripeId });
    expect(db.rpcs.filter((r) => r.fn === "finish_autopay_charge").map((r) => r.args)).toEqual([
      { p_id: CHARGE, p_outcome: "bank_failed", p_company: CO, p_error: "The bank payment didn't go through", p_decline: "insufficient_funds" },
    ]);
    expect(db.tables.autopay_charges![0]!.status).toBe("needs_client");
    expect(rowsFor(INV)[0]).toMatchObject({ status: "open" });
    expect(stripeInvoice(stripeId)!.status).toBe("open");
    // The office's note on the client says it's still owed.
    const number = db.tables.invoices!.find((i) => i.id === INV)!.number;
    expect(db.tables.messages).toContainEqual(expect.objectContaining({
      subject: "Bank payment failed", related_id: INV, body: `The bank payment for invoice #${number} didn't go through. The invoice is still owed.`,
    }));
  });

  it("still hears how an autopay bank payment ends when the invoice was paid another way meanwhile", async () => {
    invoiceTriggers();
    const { key, method } = await autopayInvoice("pm_us_bank_account");
    await charge(method);
    chargeNow({ status: "processing", charged_amount: 160 });
    // The client mailed a check too, and the office recorded it: the charge is still on its way.
    paidInvoice();
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    Object.assign(side(key).intents.get(`pi_${stripeId}`)!, { status: "requires_payment_method", last_payment_error: { code: "insufficient_funds" } });
    await event("invoice.payment_failed", { id: stripeId });
    // It bounced: the charge needs the client (and the bank account an update), and nothing's owed,
    // so its Stripe page goes.
    expect(finishes()).toEqual([{ p_id: CHARGE, p_outcome: "bank_failed", p_company: CO, p_error: "The bank payment didn't go through", p_decline: "insufficient_funds" }]);
    expect(db.tables.autopay_charges![0]!.status).toBe("needs_client");
    expect(stripeInvoice(stripeId)!.status).toBe("void");
    // The office's note doesn't say it's still owed.
    const number = db.tables.invoices!.find((i) => i.id === INV)!.number;
    expect(db.tables.messages).toContainEqual(expect.objectContaining({
      subject: "Bank payment failed", related_id: INV, body: `The bank payment for invoice #${number} didn't go through. It was paid another way meanwhile.`,
    }));
  });

  it("finishes an autopay bank payment that clears on an invoice paid another way meanwhile", async () => {
    const seen = invoiceTriggers();
    const { method } = await autopayInvoice("pm_us_bank_account");
    await charge(method);
    chargeNow({ status: "processing", charged_amount: 160 });
    paidInvoice();
    const stripeId = rowsFor(INV)[0]!.stripe_id;
    payInStripe(stripeId);
    await event("invoice.paid", { id: stripeId });
    // Booked to the invoice, which was paid already, so it doesn't turn paid again: settling finishes the charge.
    expect(seen).toEqual(["paid"]);
    expect(finishes()).toEqual([{ p_id: CHARGE, p_outcome: "paid", p_company: CO, p_amount: 160 }]);
    expect(db.tables.autopay_charges![0]!.status).toBe("paid");
  });
});

describe("tips on the saved card", () => {
  const who = { ip: "203.0.113.7", userAgent: "Mozilla/5.0" };

  it("charges the tip as its own Stripe invoice and books a tip-only payment, which the sync leaves alone", async () => {
    const { method } = await autopayInvoice();
    await charge(method);
    paidInvoice();
    expect(await chargeTip(env, db.db, CO, INV, 675, method, who)).toEqual({ status: "paid" });
    const tip = rowsFor(INV).find((r) => r.purpose === "tip")!;
    expect(tip).toMatchObject({ collection: "charge_automatically", status: "paid", amount_due: 6.75, tip_amount: 6.75 });
    const inStripe = stripeInvoice(tip.stripe_id)!;
    expect(inStripe.items).toEqual([{ amount: 675, description: "Tip for the crew, invoice #42" }]);
    expect(inStripe.metadata).toEqual({
      crewtavo_company_id: CO, crewtavo_invoice_id: INV, crewtavo_row: tip.id, tip_cents: "675", crewtavo_tip: "1", crewtavo_ip: "203.0.113.7", crewtavo_user_agent: "Mozilla/5.0",
    });
    expect(stripe.sent.filter((r) => r.idempotency?.startsWith(`crewtavo-tip-${tip.id}`)).map((r) => r.idempotency)).toEqual(
      ["", "-item", "-finalize", "-pay"].map((end) => `crewtavo-tip-${tip.id}${end}`),
    );
    expect(db.tables.payments!.at(-1)).toMatchObject({ invoice_id: INV, amount: 0, tip_amount: 6.75, processor: "stripe", processor_ref: `pi_${tip.stripe_id}` });
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("nothing to do");
    expect(inStripe.status).toBe("paid");
  });

  it("leaves nothing behind when the card is declined", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    const method = saveCard(key, "pm_card_chargeDeclined");
    paidInvoice();
    await expect(chargeTip(env, db.db, CO, INV, 500, method, who)).rejects.toMatchObject({ status: 402, message: "Your card was declined, so the tip wasn't added." });
    expect(rowsFor(INV)).toEqual([]);
    expect([...side(key).invoices.values()].map((i) => i.status)).toEqual(["void"]);
  });

  it("books a tip whose answer was lost instead of charging it again, and keeps the row when Stripe can't be asked", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    const method = saveCard(key);
    paidInvoice();
    stripe.trouble.push({ when: onPay, times: 3, lose: true });
    expect(await chargeTip(env, db.db, CO, INV, 500, method, who)).toEqual({ status: "paid" });
    expect(db.tables.payments).toEqual([expect.objectContaining({ amount: 0, tip_amount: 5 })]);
    expect(rowsFor(INV)).toEqual([expect.objectContaining({ purpose: "tip", status: "paid" })]);

    INV2 && Object.assign(db.tables.invoices!.find((i) => i.id === INV2)!, { status: "paid", balance_due: 0, amount_paid: 160 });
    stripe.trouble.push({ when: onPay, times: 3, lose: true }, { when: (m, p) => m === "GET" && p.startsWith("/v1/invoices/"), times: 3, status: 503 });
    await expect(chargeTip(env, db.db, CO, INV2, 500, method, who)).rejects.toMatchObject({ status: 409, message: "Your tip may have gone through. Check back in a minute." });
    expect(rowsFor(INV2)).toEqual([expect.objectContaining({ purpose: "tip", status: "open" })]);
    await expect(chargeTip(env, db.db, CO, INV2, 500, method, who)).rejects.toMatchObject({ status: 409, message: "A tip for this invoice is already going through." });
  });

  it("is refused before Stripe is asked when tips are off, or the invoice was made in Stripe", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    const method = saveCard(key);
    paidInvoice();
    const before = stripe.calls.length;
    db.tables.companies![0]!.settings = { hub_tips: false };
    await expect(chargeTip(env, db.db, CO, INV, 500, method, who)).rejects.toMatchObject({ status: 409, message: "Tips are turned off." });
    db.tables.companies![0]!.settings = { hub_tips: true };
    db.tables.stripe_invoices = [{ ...DEFAULTS.stripe_invoices, id: crypto.randomUUID(), company_id: CO, invoice_id: INV, origin: "stripe", status: "paid" }];
    await expect(chargeTip(env, db.db, CO, INV, 500, method, who)).rejects.toMatchObject({ status: 409, message: "Tips are turned off." });
    expect(stripe.calls.length).toBe(before);
  });
});

describe("taking a card off", () => {
  it("takes a card saved here off in Stripe too, but never one brought in from Stripe", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    saveCard(key, "pm_card_visa");
    await detachPaymentMethod(env, db.db, CO, METHOD, "office");
    expect(db.tables.client_payment_methods![0]).toMatchObject({ status: "removed", removed_reason: "office", is_default: false });
    expect(side(key).methods.get("pm_card_visa")!.customer).toBeNull();

    const imported = "00000000-0000-4000-8000-0000000000f5";
    saveCard(key, "pm_from_stripe", { id: imported, source: "stripe_import" });
    stripe.calls.length = 0;
    await detachPaymentMethod(env, db.db, CO, imported, "replaced");
    expect(db.tables.client_payment_methods![1]).toMatchObject({ status: "removed", removed_reason: "replaced" });
    expect(stripe.calls).toEqual([]);
    expect(side(key).methods.get("pm_from_stripe")!.customer).toBe("cus_pat");

    await expect(detachPaymentMethod(env, db.db, OTHER_CO, imported, "office")).rejects.toMatchObject({ status: 404, message: "Card not found." });
  });
});

describe("bringing in cards saved in Stripe", () => {
  const SAM = "00000000-0000-4000-8000-0000000000c3";
  const ALEX = "00000000-0000-4000-8000-0000000000c4";
  const LEE = "00000000-0000-4000-8000-0000000000c5";
  const KIT = "00000000-0000-4000-8000-0000000000c6";
  const visa = (id: string, customer: string) => ({ id, type: "card", customer, livemode: true, card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2028, wallet: null } });

  it("matches by link or an email only one client and one customer have, brings in older card sources, and agrees to nothing", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    db.tables.clients!.push(
      { id: SAM, company_id: CO, display_name: "Sam", email: "home@example.com" },
      { id: ALEX, company_id: CO, display_name: "Alex", email: "Home@example.com" },
      { id: LEE, company_id: CO, display_name: "Lee", email: "lee@example.com" },
      { id: KIT, company_id: CO, display_name: "Kit", email: "kit@example.com" },
    );
    db.tables.sync_links = [{ company_id: CO, provider: "stripe", entity: "client", local_id: CLIENT, external_id: "cus_pat" }];
    const s = side(key);
    s.methods.set("pm_pat", visa("pm_pat", "cus_pat"));
    s.methods.set("pm_home", visa("pm_home", "cus_home"));
    s.methods.set("pm_kit_old", visa("pm_kit_old", "cus_kit"));
    s.methods.set("pm_kit", visa("pm_kit", "cus_kit"));
    s.customers.push(
      { id: "cus_pat", email: "someone@example.com", invoice_settings: { default_payment_method: "pm_pat" } },
      // A household address two clients share matches neither.
      { id: "cus_home", email: "home@example.com", invoice_settings: { default_payment_method: "pm_home" } },
      { id: "cus_lee", email: "LEE@example.com", default_source: { id: "card_lee", object: "card", brand: "American Express", last4: "0005", exp_month: 1, exp_year: 2030 } },
      // No default: the newest card.
      { id: "cus_kit", email: "kit@example.com" },
      { id: "cus_nobody", email: "nobody@example.com", invoice_settings: { default_payment_method: "pm_home" } },
    );
    await importFromStripe(env, db.db, CO, await beginStripeImport(db.db, CO, null));
    const state = db.tables.integrations![0]!.settings.import;
    expect(state).toMatchObject({ status: "done", counts: expect.objectContaining({ cards: 3, cards_unmatched: 2 }) });
    expect(state.cards_error).toBeUndefined();
    expect(db.tables.client_payment_methods!.map((m) => [m.client_id, m.stripe_payment_method_id, m.brand, m.source, m.status, m.is_default])).toEqual([
      [CLIENT, "pm_pat", "visa", "stripe_import", "active", true],
      [LEE, "card_lee", "amex", "stripe_import", "active", true],
      [KIT, "pm_kit", "visa", "stripe_import", "active", true],
    ]);
    // An email match is kept, so invoices go to the same customer.
    expect(db.tables.sync_links!.map((l) => [l.local_id, l.external_id])).toEqual([[CLIENT, "cus_pat"], [LEE, "cus_lee"], [KIT, "cus_kit"]]);
    expect(db.tables.autopay_authorizations ?? []).toEqual([]);
  });

  it("finishes the rest of the import when the cards can't be read", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    side(key).payouts.push({ id: "po_1", amount: 485, currency: "usd", arrival_date: 1_760_400_000, status: "paid", automatic: false, failure_message: null });
    stripe.trouble.push({ when: (m, p) => m === "GET" && p === "/v1/customers", times: 1, status: 403, error: { type: "permission_error", message: "The provided key does not have the required permissions for this endpoint" } });
    await importFromStripe(env, db.db, CO, await beginStripeImport(db.db, CO, null));
    expect(db.tables.integrations![0]!.settings.import).toMatchObject({ status: "done", cards_error: "The provided key does not have the required permissions for this endpoint" });
    expect(db.tables.payouts).toEqual([expect.objectContaining({ processor_ref: "po_1" })]);
  });

  it("doesn't look for cards with a key that can't use them", async () => {
    await connect(stripeKey("rk_live_OLD", "acct_A", { autopay: false }));
    await importFromStripe(env, db.db, CO, await beginStripeImport(db.db, CO, null));
    expect(stripe.calls.filter((c) => c.includes("/v1/customers"))).toEqual([]);
  });
});

describe("refunds from Crewtavo", () => {
  /** INV paid automatically: $160 on Pat's card. */
  async function paidByCard() {
    const { key, method } = await autopayInvoice();
    await charge(method);
    const payment = db.tables.payments![0]!;
    return { key, payment, charge: `ch_${rowsFor(INV)[0]!.stripe_id}` };
  }
  const refunds = () => db.tables.payments!.filter((p) => p.amount < 0 || p.tip_amount < 0);

  it("refunds part, then the rest, booking each once even when Stripe's webhook says so too", async () => {
    const { payment, charge: ch } = await paidByCard();
    expect(await refundStripePayment(env, db.db, CO, payment.id, 5000)).toEqual({ refunded_cents: 5000, recorded: true });
    expect(refunds()).toEqual([expect.objectContaining({ invoice_id: INV, amount: -50, processor_ref: `${payment.processor_ref}:refund:5000`, notes: "Refunded in Stripe" })]);
    await event("charge.refunded", { id: ch, payment_intent: payment.processor_ref, amount_refunded: 5000 });
    expect(refunds()).toHaveLength(1);
    expect(sentTo("POST", /^\/v1\/refunds$/).at(-1)!.idempotency).toBe(`crewtavo-refund-${payment.id}-0-5000`);

    await expect(refundStripePayment(env, db.db, CO, payment.id, 11001)).rejects.toMatchObject({ status: 400, message: "That's more than is left to refund." });
    expect(await refundStripePayment(env, db.db, CO, payment.id, 11000)).toEqual({ refunded_cents: 11000, recorded: true });
    expect(sentTo("POST", /^\/v1\/refunds$/).at(-1)!.idempotency).toBe(`crewtavo-refund-${payment.id}-5000-11000`);
    expect(refunds().map((p) => p.amount)).toEqual([-50, -110]);
    await expect(refundStripePayment(env, db.db, CO, payment.id, 1)).rejects.toMatchObject({ status: 400 });
  });

  it("refunds once on a double click", async () => {
    const { key, payment } = await paidByCard();
    const both = await Promise.all([refundStripePayment(env, db.db, CO, payment.id, 5000), refundStripePayment(env, db.db, CO, payment.id, 5000)]);
    expect(both.map((r) => r.refunded_cents)).toEqual([5000, 5000]);
    expect(side(key).refunds).toHaveLength(1);
    expect(refunds()).toHaveLength(1);
  });

  it("says where to refund what Crewtavo can't", async () => {
    const { payment } = await paidByCard();
    // Made in a Stripe account Crewtavo has since left.
    db.tables.payments!.push({ ...payment, id: crypto.randomUUID(), processor_ref: "pi_elsewhere" });
    await expect(refundStripePayment(env, db.db, CO, db.tables.payments!.at(-1)!.id, 1000)).rejects.toMatchObject({
      status: 409, message: "This payment was made in a Stripe account Crewtavo no longer uses. Refund it in that Stripe account.",
    });
    // What was owed from before, or a payment marked paid in Stripe.
    db.tables.payments!.push({ ...payment, id: crypto.randomUUID(), processor_ref: `${payment.processor_ref}:before` });
    await expect(refundStripePayment(env, db.db, CO, db.tables.payments!.at(-1)!.id, 1000)).rejects.toMatchObject({ status: 409, message: "Refund this payment in Stripe." });
    await expect(refundStripePayment(env, db.db, OTHER_CO, payment.id, 1000)).rejects.toMatchObject({ status: 404 });
  });

  it("needs a key that can make refunds, and stops offering them when Stripe turns it down", async () => {
    const { payment } = await paidByCard();
    stripe.trouble.push({ when: (m, p) => p === "/v1/refunds", times: 1, status: 403, error: { type: "permission_error", message: "The provided key does not have the required permissions for this endpoint" } });
    await expect(refundStripePayment(env, db.db, CO, payment.id, 1000)).rejects.toMatchObject({ status: 409, message: "Your Stripe key can't do that anymore. Update it on the Apps page." });
    expect(db.tables.integrations![0]!.settings).toMatchObject({ refunds: false, autopay: true });
    await expect(refundStripePayment(env, db.db, CO, payment.id, 1000)).rejects.toMatchObject({ status: 409, message: "Your Stripe key can't make refunds. Update it on the Apps page." });
  });
});

describe("what the key can do", () => {
  it("probes a new key: 403 means it can't, 400 and 404 mean it can", async () => {
    await connect(stripeKey("rk_live_OLD", "acct_A", { autopay: false, refunds: false }));
    expect(db.tables.integrations![0]!.settings).toMatchObject({ autopay: false, refunds: false, events_version: STRIPE_EVENTS_VERSION, checked_at: expect.any(String) });
    await connect(stripeKey("rk_live_NEW", "acct_A"));
    expect(db.tables.integrations![0]!.settings).toMatchObject({ autopay: true, refunds: true });
    expect(await stripeCapabilities(env, db.db, CO, { cached: true })).toEqual({ connected: true, own: true, livemode: true, autopay: true, refunds: true, webhook_current: true });
    // The probes can't change anything in Stripe.
    expect(stripe.sent.filter((r) => r.method === "POST" && /checkout|refunds|payment_methods/.test(r.path)).map((r) => [r.path, Object.fromEntries(r.body)])).toEqual([
      ["/v1/checkout/sessions", {}], ["/v1/payment_methods/pm_crewtavo_probe/detach", {}], ["/v1/refunds", { payment_intent: "pi_crewtavo_probe" }],
      ["/v1/checkout/sessions", {}], ["/v1/payment_methods/pm_crewtavo_probe/detach", {}], ["/v1/refunds", { payment_intent: "pi_crewtavo_probe" }],
    ]);
  });

  it("never asks Stripe when cached, and waits 15 minutes after a probe that couldn't tell", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    stripe.trouble.push({ when: (m, p) => p === "/v1/checkout/sessions", times: 1, status: 500 });
    await connect(key);
    expect(db.tables.integrations![0]!.settings).toMatchObject({ refunds: true });
    expect(db.tables.integrations![0]!.settings.autopay).toBeUndefined();
    const calls = stripe.calls.length;
    expect(await stripeCapabilities(env, db.db, CO, { cached: true })).toMatchObject({ autopay: false, refunds: true });
    expect(await stripeCapabilities(env, db.db, CO)).toMatchObject({ autopay: false });
    expect(stripe.calls.length).toBe(calls);
    db.tables.integrations![0]!.settings.checked_at = new Date(Date.now() - 16 * 60_000).toISOString();
    expect(await stripeCapabilities(env, db.db, CO)).toMatchObject({ autopay: true, refunds: true });
    expect(await stripeCapabilities(env, db.db, CO, { refresh: true })).toMatchObject({ autopay: true });
  });

  it("brings a webhook made before autopay up to date without a new key", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    const [endpoint] = side(key).webhooks.values();
    expect(endpoint!.enabled_events).toEqual(STRIPE_EVENTS);
    Object.assign(endpoint!, { enabled_events: ["invoice.paid"] });
    db.tables.integrations![0]!.settings.events_version = 1;
    expect((await stripeCapabilities(env, db.db, CO, { cached: true })).webhook_current).toBe(false);
    expect((await stripeCapabilities(env, db.db, CO)).webhook_current).toBe(true);
    expect(endpoint!.enabled_events).toEqual(STRIPE_EVENTS);
    expect(db.tables.integrations![0]!.settings.events_version).toBe(STRIPE_EVENTS_VERSION);
    expect(STRIPE_EVENTS).toEqual(expect.arrayContaining(["setup_intent.succeeded", "setup_intent.setup_failed", "payment_method.detached", "payment_method.automatically_updated", "invoice.payment_action_required", "mandate.updated"]));
  });

  it("can't refresh a webhook it doesn't have, and the server's key does neither", async () => {
    expect(await refreshStripeWebhook(env, db.db, CO)).toBe(false);
    expect(await stripeCapabilities(env, db.db, CO)).toEqual({ connected: false, own: false, livemode: false, autopay: false, refunds: false, webhook_current: false });
    const shared = { ...env, STRIPE_SECRET_KEY: stripeKey("sk_live_SERVER", "acct_S") };
    expect(await stripeCapabilities(shared, db.db, CO)).toEqual({ connected: true, own: false, livemode: true, autopay: false, refunds: false, webhook_current: true });
    expect(stripe.calls).toEqual([]);
  });

  it("shows autopay and refunds on the Apps page", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    const res = await app.request("/api/apps", { headers }, env);
    expect(res.status).toBe(200);
    const { apps } = (await res.json()) as { apps: Array<{ id: string; stripe?: Row }> };
    expect(apps.find((a) => a.id === "stripe")!.stripe).toMatchObject({ own: true, autopay: true, refunds: true });
  });

  it("lets go of the cards saved in a Stripe account it switches away from", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    await connect(stripeKey("sk_live_B", "acct_B"));
    expect(db.rpcs.filter((r) => r.fn === "autopay_account_left").map((r) => r.args)).toEqual([{ p_company: CO, p_livemode: true, p_account: "acct_A" }]);
  });
});
