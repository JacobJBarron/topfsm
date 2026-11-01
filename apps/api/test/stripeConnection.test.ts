/**
 * Connecting, switching and disconnecting Stripe, history imports on the server's key, Hub Pay,
 * the money Stripe reports (disputes, refunds, deposits, and customers' balances and credit notes
 * there) and keeping Stripe invoices in step, against an in-memory database and a fake Stripe that
 * keeps accounts (and test and live mode) apart the way Stripe does: one account's invoice is
 * "No such invoice" to another's key.
 */
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import {
  beginStripeImport,
  connectStripe,
  handleStripeEvent,
  hubPayment,
  importFromStripe,
  PROCESSING_MESSAGE,
  SHARED_STRIPE_IMPORT,
  stripeCheckout,
  syncStripeInvoice,
} from "../src/integrations/stripe";
import { loadSecret } from "../src/integrations/tokens";
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
  stripe_invoices: { stripe_id: null, status: "creating", hosted_url: null, number: null, tip_amount: 0, livemode: true, stripe_account: null, detached_at: null },
  payments: { tip_amount: 0, fee_amount: 0, payout_id: null },
  payouts: { itemized_at: null },
};

function conflicts(table: string, rows: Row[], row: Row, self?: Row) {
  const others = rows.filter((r) => r !== self);
  if (table === "stripe_invoices") {
    if (row.stripe_id && others.some((r) => r.stripe_id === row.stripe_id)) return true;
    // stripe_invoices_live_idx: one live Stripe invoice per invoice among the ones still followed.
    const live = (r: Row) => r.invoice_id && LIVE.includes(r.status) && !r.detached_at;
    if (live(row) && others.some((r) => live(r) && r.invoice_id === row.invoice_id)) return true;
  }
  if ((table === "payments" || table === "payouts") && row.processor_ref) return others.some((r) => r.processor_ref === row.processor_ref);
  return false;
}

function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0;
  const rpcs: Array<{ fn: string; args: Row }> = [];
  const hits = new Map<string, number>();
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
      return { data: null, error: null };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  current.db = db;
  return { db: db as unknown as Db, tables, rpcs };
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
}
interface Key {
  account: string;
  live: boolean;
  webhooks: boolean;
}
const stripe = { sides: new Map<string, Side>(), keys: new Map<string, Key>(), calls: [] as string[], posts: [] as Array<{ path: string; body: URLSearchParams }>, n: 0, finalizing: null as (() => Promise<void>) | null };

/** A key for `account` (live or test by its prefix). `webhooks: false` is a restricted key without that permission. */
function stripeKey(key: string, account: string, options: { webhooks?: boolean } = {}) {
  stripe.keys.set(key, { account, live: key.includes("_live_"), webhooks: options.webhooks ?? true });
  return key;
}
function side(key: string): Side {
  const k = stripe.keys.get(key)!;
  const name = `${k.account}:${k.live ? "live" : "test"}`;
  if (!stripe.sides.has(name)) stripe.sides.set(name, { invoices: new Map(), webhooks: new Map(), customers: [], payouts: [], transactions: [] });
  return stripe.sides.get(name)!;
}
/** The client pays a Stripe invoice (in whichever account it's in). */
function payInStripe(id: string) {
  for (const s of stripe.sides.values()) {
    const invoice = s.invoices.get(id);
    if (invoice) Object.assign(invoice, { status: "paid", amount_paid: invoice.amount_due, payment_intent: `pi_${id}`, status_transitions: { ...invoice.status_transitions, paid_at: 1_760_000_500 } });
  }
}
const stripeInvoice = (id: string) => [...stripe.sides.values()].find((s) => s.invoices.has(id))?.invoices.get(id);

async function fakeStripe(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const path = url.pathname;
  const key = (init.headers as Record<string, string>).Authorization!.slice(7);
  stripe.calls.push(`${key} ${method} ${path}`);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const k = stripe.keys.get(key);
  if (!k) return json({ error: { message: "Invalid API Key provided" } }, 401);
  const s = side(key);
  const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
  if (method === "POST") stripe.posts.push({ path, body });
  const noInvoice = (id: string) => json({ error: { message: `No such invoice: '${id}'`, code: "resource_missing", param: "id" } }, 404);
  let m: RegExpMatchArray | null;

  if (path === "/v1/account") return json({ id: k.account, settings: { dashboard: { display_name: `Business ${k.account}` } } });
  if (path.startsWith("/v1/webhook_endpoints")) {
    if (!k.webhooks) return json({ error: { type: "permission_error", message: "The provided key does not have the required permissions for this endpoint" } }, 403);
    if (method === "GET") return json({ data: [...s.webhooks.values()].map(({ id, url }) => ({ id, url })), has_more: false });
    const noEndpoint = json({ error: { message: "No such webhook endpoint", code: "resource_missing" } }, 404);
    if (path === "/v1/webhook_endpoints") {
      // Stripe allows 16 in each mode of an account.
      if (s.webhooks.size >= 16) return json({ error: { type: "invalid_request_error", message: "You have reached the maximum of 16 webhook endpoints." } }, 400);
      const id = `we_${++stripe.n}`;
      const endpoint = { id, url: body.get("url"), secret: `whsec_${id}` };
      s.webhooks.set(id, endpoint);
      return json(endpoint);
    }
    const id = path.split("/").pop()!;
    if (method === "POST") {
      // An update: it keeps its secret, and Stripe doesn't send it again.
      const endpoint = s.webhooks.get(id);
      if (!endpoint) return noEndpoint;
      endpoint.url = body.get("url") ?? endpoint.url;
      return json({ id, url: endpoint.url });
    }
    return s.webhooks.delete(id) ? json({ id, deleted: true }) : noEndpoint;
  }
  if (path === "/v1/customers" && method === "GET") return json({ data: s.customers.filter((c) => c.email === url.searchParams.get("email")), has_more: false });
  if (path === "/v1/customers") {
    const customer = { id: `cus_${++stripe.n}`, email: body.get("email") };
    s.customers.push(customer);
    return json(customer);
  }
  if (path === "/v1/invoices" && method === "POST") {
    if (!s.customers.some((c) => c.id === body.get("customer"))) return json({ error: { message: "No such customer", code: "resource_missing", param: "customer" } }, 400);
    const id = `in_${++stripe.n}`;
    const metadata = Object.fromEntries([...body].filter(([name]) => name.startsWith("metadata[")).map(([name, value]) => [name.slice(9, -1), value]));
    s.invoices.set(id, {
      id, status: "draft", livemode: k.live, customer: body.get("customer"), metadata, number: null, hosted_invoice_url: null, amount_due: 0, amount_paid: 0, total: 0,
      paid_out_of_band: false, payment_intent: null, charge: null, status_transitions: { finalized_at: null, paid_at: null }, lines: { data: [], has_more: false },
    });
    return json(s.invoices.get(id));
  }
  if (path === "/v1/invoiceitems") {
    const invoice = s.invoices.get(body.get("invoice")!);
    if (!invoice) return noInvoice(body.get("invoice")!);
    invoice.amount_due += Number(body.get("amount"));
    invoice.total += Number(body.get("amount"));
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
    if (method === "DELETE") s.invoices.delete(m[1]!);
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

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  stripe.sides.clear();
  stripe.keys.clear();
  stripe.calls.length = 0;
  stripe.posts.length = 0;
  stripe.n = 0;
  stripe.finalizing = null;
  db = fakeDb({
    companies: [{ id: CO, name: "Green Lawn", timezone: "America/Chicago", currency: "USD", settings: { hub_tips: true } }],
    memberships: [{ company_id: CO, user_id: USER, role: "owner", role_id: null, active: true }],
    clients: [{ id: CLIENT, company_id: CO, display_name: "Pat Client", email: "pat@example.com", phone: null }],
    invoices: [invoiceRow(INV, 42), invoiceRow(INV2, 43)],
  });
  vi.stubGlobal("fetch", vi.fn(fakeStripe));
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

    const res = await app.request("/api/apps/stripe/key", { method: "PUT", headers, body: JSON.stringify({ api_key: "rk_live_NEW" }) }, env);
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
      { id: crypto.randomUUID(), company_id: CO, invoice_id: INV, origin: "crewtavo", tip_amount: 0, detached_at: null, created_at: new Date(0).toISOString(), ...old },
      { id: crypto.randomUUID(), company_id: CO, invoice_id: INV2, origin: "crewtavo", tip_amount: 0, detached_at: null, created_at: new Date(0).toISOString(), ...old, stripe_id: "in_c2" },
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

    const res = await app.request("/api/apps/stripe/disconnect", { method: "POST", headers }, e);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(stripeInvoice(made!.stripe_id)!.status).toBe("void"));
    expect(side(own).webhooks.size).toBe(0);
    expect(await stripeCheckout(e, db.db, CO, INV, 0)).toContain("acct_S_live_");
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

describe("coupons on a customer in Stripe", () => {
  const event = (type: string, object: Row) => handleStripeEvent(env, db.db, { companyId: CO }, { id: `evt_${++stripe.n}`, type, data: { object } });

  it("never come off a Crewtavo invoice: it asks for no discounts, and its items take none", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    const made = stripe.posts.filter((p) => p.path === "/v1/invoices");
    expect(made).toHaveLength(1);
    // An empty string, Stripe's way of saying "don't inherit the customer's discount".
    expect(made[0]!.body.has("discounts")).toBe(true);
    expect(made[0]!.body.get("discounts")).toBe("");
    const items = stripe.posts.filter((p) => p.path === "/v1/invoiceitems");
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((p) => p.body.get("discountable"))).toEqual(items.map(() => "false"));
  });

  it("paid for less than was owed anyway, the rest stays owed and Pay asks for it", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    await syncStripeInvoice(env, db.db, CO, INV);
    const [made] = rowsFor(INV);
    // Say Stripe took $20 off all the same (a discount added to it in Stripe's dashboard).
    Object.assign(stripeInvoice(made!.stripe_id)!, { amount_due: 14000 });
    payInStripe(made!.stripe_id);
    await event("invoice.paid", { id: made!.stripe_id });
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV, amount: 140, processor: "stripe" })]);
    // The database's totals make it partly paid, with $20 owed (supabase/tests/rls_and_workflow.sql).
    owe(INV, 20);
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    const rest = rowsFor(INV).find((r) => r.status === "open")!;
    expect(rest).toMatchObject({ amount_due: 20 });
    expect(await stripeCheckout(env, db.db, CO, INV, 0)).toBe(rest.hosted_url);
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
      hosted_url: null, created_at: new Date().toISOString(), livemode: true, stripe_account: null, detached_at: null,
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
