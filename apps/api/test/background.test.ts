import { addDays } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { runAccountingJob, SentButUnrecorded } from "../src/integrations/accounting";
import { accessToken } from "../src/integrations/tokens";
import { encryptJson } from "../src/lib/crypto";
import { readClientLink } from "../src/lib/links";
import type { Db } from "../src/lib/supabase";
import { processAutomations } from "../src/services/automations";
import { materializeJob, runTask } from "../src/tasks";

// The background tasks and the routes here make their own clients; they get the test's fake instead.
const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));
// Autopay invites are their own service (services/autopay.ts); here only the engine's part is tested.
const invites = vi.hoisted(() => ({
  send: null as null | ((input: Record<string, unknown>) => Promise<{ sent: boolean; detail: string }>),
  calls: [] as Array<Record<string, unknown>>,
  available: false,
}));
vi.mock("../src/services/autopay", async (original) => ({
  ...(await original<typeof import("../src/services/autopay")>()),
  sendAutopayInvite: async (_env: unknown, _admin: unknown, input: Record<string, unknown>) => {
    invites.calls.push(input);
    if (!invites.send) throw new Error("No invite expected.");
    return invites.send(input);
  },
  autopayAvailable: async () => invites.available,
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  QUICKBOOKS_CLIENT_ID: "qb-client",
  QUICKBOOKS_CLIENT_SECRET: "qb-secret",
  ZOHO_CLIENT_ID: "zoho-client",
  ZOHO_CLIENT_SECRET: "zoho-secret",
};
const COMPANY = "00000000-0000-4000-8000-000000000001";

/** One query the fake database was asked: its table and each builder call, in order. */
interface Query {
  table: string;
  calls: Array<[string, ...any[]]>;
}
type Answer = { data?: unknown; error?: { message: string } | null };

const call = (q: Query, name: string) => q.calls.find(([n]) => n === name);
const verb = (q: Query) => q.calls.find(([n]) => ["insert", "upsert", "update", "delete"].includes(n))?.[0] ?? "select";

/** Stands in for supabase-js: records every query and rpc, and answers each with the test's handlers. */
function fakeDb(answer: (q: Query) => Answer = () => ({}), rpc: (fn: string, args: Record<string, any>) => Answer = () => ({})) {
  const queries: Query[] = [];
  const rpcs: Array<{ fn: string; args: Record<string, any> }> = [];
  const chain = (q: Query): unknown =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                Promise.resolve()
                  .then(() => ({ data: null, error: null, ...answer(q) }))
                  .then(resolve, reject)
            : (...args: unknown[]) => {
                q.calls.push([String(name), ...args]);
                return chain(q);
              },
      },
    );
  const db = {
    from: (table: string) => {
      const q: Query = { table, calls: [] };
      queries.push(q);
      return chain(q);
    },
    rpc: async (fn: string, args: Record<string, any>) => {
      rpcs.push({ fn, args });
      return { data: null, error: null, ...rpc(fn, args) };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: "00000000-0000-4000-8000-0000000000aa" } }, error: null }) },
  };
  current.db = db;
  return { db: db as unknown as Db, queries, rpcs };
}

/** What Supabase's API does with a select: the range asked for, but never more than 1,000 rows. */
function upTo1000<T>(rows: T[], q: Query): Answer {
  const range = call(q, "range");
  const from = range?.[1] ?? 0;
  const to = Math.min(range?.[2] ?? Infinity, from + 999);
  return { data: rows.slice(from, to + 1) };
}

/** A query that answers every builder call with itself, and `then` with `rows` (or `single` for maybeSingle/single). */
function fakeChain(rows: unknown, single: { data: unknown } = { data: rows }): unknown {
  let one = false;
  const chain: unknown = new Proxy(
    {},
    {
      get: (_, name) =>
        name === "then"
          ? (resolve: (value: unknown) => unknown) => resolve({ error: null, ...(one ? single : { data: rows }) })
          : () => {
              if (name === "maybeSingle" || name === "single") one = true;
              return chain;
            },
    },
  );
  return chain;
}

const recurringJob = (id: string, rule: string, startsOn: string) => ({
  id,
  company_id: COMPANY,
  title: "Weekly mowing",
  property_id: null,
  starts_on: startsOn,
  ends_on: null,
  recurrence_rule: rule,
  active_months: null,
  visit_start_time: null,
  visit_duration_min: 60,
  default_crew_id: "crew-1",
  company: { timezone: "UTC" },
});

afterEach(() => {
  invites.send = null;
  invites.calls = [];
  invites.available = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recurring visits", () => {
  it("don't come back after someone deletes one", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T15:00:00Z") });
    const deleted = "2026-10-19";
    const { db, queries } = fakeDb((q) => (q.table === "recurrence_skips" ? { data: [{ recurrence_key: deleted }] } : { data: [] }));
    await materializeJob(db, recurringJob("job-1", "FREQ=DAILY", "2026-10-01"));

    const skips = queries.find((q) => q.table === "recurrence_skips")!;
    expect(skips.calls).toContainEqual(["eq", "job_id", "job-1"]);
    const upsert = queries.find((q) => verb(q) === "upsert")!;
    const keys = (call(upsert, "upsert")![1] as Array<{ recurrence_key: string }>).map((r) => r.recurrence_key);
    expect(keys).toContain("2026-10-18");
    expect(keys).toContain("2026-10-20");
    expect(keys).not.toContain(deleted);
    expect(keys).toHaveLength(60); // today and the next 60 days, less the deleted one
  });

  it("create nothing when every upcoming date was deleted", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T15:00:00Z") });
    const { db, queries } = fakeDb((q) => (q.table === "recurrence_skips" ? { data: [{ recurrence_key: "2026-10-20" }] } : { data: [] }));
    expect(await materializeJob(db, { ...recurringJob("job-1", "FREQ=DAILY", "2026-10-20"), ends_on: "2026-10-20" })).toEqual({ created: 0, removed: 0 });
    expect(queries.some((q) => verb(q) === "upsert")).toBe(false);
  });

  it("keep a visit that done job pay covers when the schedule drops it, and remove the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T15:00:00Z") });
    // A weekly schedule on Mondays now: the Tuesday and Wednesday visits are stale; job pay whose work is done covers the Tuesday's.
    const { db, queries } = fakeDb((q) =>
      q.table === "visits" && verb(q) === "select"
        ? { data: [{ id: "v-tue", recurrence_key: "2026-10-20" }, { id: "v-wed", recurrence_key: "2026-10-21" }] }
        : q.table === "job_pay_visits" ? { data: [{ visit_id: "v-tue", pay: { status: "done" } }] } : { data: [] },
    );
    expect(await materializeJob(db, recurringJob("job-1", "FREQ=WEEKLY;BYDAY=MO", "2026-10-19"), true)).toMatchObject({ removed: 1 });
    const covered = queries.find((q) => q.table === "job_pay_visits")!;
    expect(covered.calls).toContainEqual(["in", "visit_id", ["v-tue", "v-wed"]]);
    expect(covered.calls).toContainEqual(["in", "pay.status", ["done", "paid"]]);
    const removed = queries.find((q) => q.table === "visits" && verb(q) === "delete")!;
    expect(removed.calls).toContainEqual(["in", "id", ["v-wed"]]);
  });

  it("say so when removing stale visits fails, instead of counting them removed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T15:00:00Z") });
    const { db } = fakeDb((q) =>
      q.table === "visits" && verb(q) === "select" ? { data: [{ id: "v-wed", recurrence_key: "2026-10-21" }] }
        : q.table === "visits" && verb(q) === "delete" ? { error: { message: "This pay's work is done, so the visits it covers stay as they are." } } : { data: [] },
    );
    await expect(materializeJob(db, recurringJob("job-1", "FREQ=WEEKLY;BYDAY=MO", "2026-10-19"), true)).rejects.toThrow("visits it covers stay");
  });
});

describe("lists past 1,000 rows", () => {
  it("schedule every recurring job, not just the first 1,000", async () => {
    const jobs = Array.from({ length: 2500 }, (_, i) => recurringJob(`job-${String(i).padStart(4, "0")}`, "FREQ=WEEKLY", addDays("2026-10-01", i % 7)));
    const { queries } = fakeDb((q) => (q.table === "jobs" ? upTo1000(jobs, q) : { data: [] }));
    const result = await runTask("recurrence", env);

    expect(result).toMatchObject({ jobs: 2500, problems: [] });
    const scheduled = new Set(queries.filter((q) => verb(q) === "upsert").map((q) => (call(q, "upsert")![1] as Array<{ job_id: string }>)[0]!.job_id));
    expect(scheduled.size).toBe(2500);
    for (const q of queries.filter((q) => q.table === "jobs")) expect(q.calls).toContainEqual(["order", "id"]);
  });

  it("show a busy month's whole schedule", async () => {
    const visits = Array.from({ length: 1500 }, (_, i) => ({ id: `visit-${String(i).padStart(4, "0")}`, scheduled_on: addDays("2026-11-01", i % 42) }));
    const { queries } = fakeDb((q) => {
      if (q.table === "memberships") return { data: { role: "office", role_id: null } };
      if (q.table === "visits" && call(q, "gte")) return upTo1000(visits, q);
      return { data: [] };
    });
    const res = await app.request("/api/schedule?from=2026-11-01&to=2026-12-12", { headers: { Authorization: "Bearer token", "X-Company-Id": COMPANY } }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { visits: Array<{ id: string }> };
    expect(body.visits.map((v) => v.id)).toEqual(visits.map((v) => v.id));
    const pages = queries.filter((q) => q.table === "visits" && call(q, "gte"));
    expect(pages.map((q) => call(q, "range")!.slice(1))).toEqual([[0, 999], [1000, 1999]]);
    for (const q of pages) expect(q.calls.at(-2)).toEqual(["order", "id"]); // ties broken the same way on every page
  });
});

describe("accounting sync", () => {
  const expiring = () => encryptJson(env, { access_token: "old", refresh_token: "refresh-1", expires_at: Date.now() + 60_000 });
  const integrationWrites = (queries: Query[]) => queries.filter((q) => q.table === "integrations" && verb(q) === "update").map((q) => call(q, "update")![1]);

  it.each([
    ["an outage", () => Response.json({ error: "temporarily_unavailable" }, { status: 503 })],
    ["a timeout", () => Promise.reject(new TypeError("fetch failed"))],
  ])("keeps the app connected when refreshing its sign-in hits %s", async (_, response) => {
    const ciphertext = await expiring();
    const { db, queries } = fakeDb((q) => (q.table === "integration_secrets" ? { data: { ciphertext } } : {}));
    vi.stubGlobal("fetch", async () => response());
    await expect(accessToken(env, db, COMPANY, "quickbooks")).rejects.toThrow();
    expect(integrationWrites(queries)).toEqual([]);
  });

  it.each([
    ["quickbooks", 400, "invalid_grant"],
    ["zoho_books", 200, "invalid_code"], // Zoho refuses with a 200
  ] as const)("asks for a reconnect when %s refuses the sign-in", async (provider, status, error) => {
    const ciphertext = await expiring();
    const { db, queries } = fakeDb((q) => (q.table === "integration_secrets" ? { data: { ciphertext } } : {}));
    vi.stubGlobal("fetch", async () => Response.json({ error }, { status }));
    await expect(accessToken(env, db, COMPANY, provider)).rejects.toThrow(error);
    expect(integrationWrites(queries)).toEqual([{ status: "error", last_error: "Sign-in expired. Reconnect on the Apps page." }]);
  });

  it("retries changes queued while the app isn't connected instead of dropping them", async () => {
    const row = { id: 7, company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-1" }, attempts: 1 };
    const { queries } = fakeDb(
      () => ({ data: null }),
      (fn) => (fn === "claim_outbox" ? { data: [row] } : {}),
    );
    expect(await runTask("outbox", env)).toEqual({ claimed: 1, done: 0, failed: 1 });
    const update = call(queries.find((q) => q.table === "outbox")!, "update")![1];
    expect(update).not.toHaveProperty("done_at");
    expect(update).toMatchObject({ last_error: expect.stringContaining("isn't connected"), dead_at: null });
  });

  it("keeps the app connected when one record never goes through", async () => {
    const row = { id: 8, company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-gone" }, attempts: 8 };
    const { queries } = fakeDb(
      (q) => (q.table === "integrations" && verb(q) === "select" ? { data: { provider: "quickbooks", external_account_id: "realm-1", settings: {} } } : { data: null }),
      (fn) => (fn === "claim_outbox" ? { data: [row] } : {}),
    );
    expect(await runTask("outbox", env)).toEqual({ claimed: 1, done: 0, failed: 1 });
    expect(call(queries.find((q) => q.table === "outbox")!, "update")![1].dead_at).toEqual(expect.any(String));
    const marked = queries.find((q) => q.table === "integrations" && verb(q) === "update")!;
    expect(call(marked, "update")![1]).toEqual({ last_error: "Invoice not found" });
    expect(marked.calls).toContainEqual(["eq", "status", "connected"]);
  });

  it("keeps that note after the next record syncs", async () => {
    const rows = [
      { id: 8, company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-gone" }, attempts: 8 },
      { id: 9, company_id: COMPANY, topic: "accounting.payment", payload: { payment_id: "refund-1" }, attempts: 1 },
    ];
    const { queries } = fakeDb(
      (q) => {
        if (q.table === "integrations" && verb(q) === "select") return { data: { provider: "quickbooks", external_account_id: "realm-1", settings: {} } };
        // A refund goes through without calling QuickBooks (they're entered by hand for now).
        if (q.table === "payments") return { data: { id: "refund-1", client_id: "client-1", invoice_id: null, amount: -20, method: "card", received_at: "2026-10-17T15:00:00Z" } };
        return { data: null };
      },
      (fn) => (fn === "claim_outbox" ? { data: rows } : {}),
    );
    expect(await runTask("outbox", env)).toEqual({ claimed: 2, done: 1, failed: 1 });
    expect(integrationWrites(queries)).toEqual([{ last_error: "Invoice not found" }, { last_sync_at: expect.any(String), status: "connected" }]);
  });

  it.each(["quickbooks", "zoho_books"])("sends %s nothing for a payment that was only a tip", async (provider) => {
    // The client's credit in Stripe paid the invoice, and Stripe charged only the tip. Tips aren't
    // sent (they aren't on the invoice in the books), and a payment of nothing is refused there.
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { db, queries } = fakeDb((q) => {
      if (q.table === "integrations" && verb(q) === "select") return { data: { provider, external_account_id: "books-1", settings: {} } };
      if (q.table === "payments") return { data: { id: "tip-1", client_id: "client-1", invoice_id: "inv-1", amount: 0, tip_amount: 15, method: "card", received_at: "2026-10-17T15:00:00Z" } };
      return { data: null };
    });
    await runAccountingJob(env, db, { company_id: COMPANY, topic: "accounting.payment", payload: { payment_id: "tip-1" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(queries.filter((q) => q.table === "sync_links" && verb(q) === "upsert")).toEqual([]);
    expect(integrationWrites(queries)).toEqual([{ last_sync_at: expect.any(String), status: "connected" }]);
  });

  describe("sending an invoice", () => {
    const connected = { provider: "quickbooks", external_account_id: "realm-1", settings: {} };
    const invoice = {
      id: "inv-1", number: 1042, client_id: "client-1", issued_on: "2026-10-17", due_on: null, subject: null, tax_rate: 0, tax_amount: 0, discount_amount: 0,
      invoice_line_items: [{ name: "Mowing", description: null, quantity: 1, unit_price: 45, taxable: false, service_id: null, sort: 0 }],
    };
    const answers = (ciphertext: string, links: (entity: string) => Answer, saveLink: () => Answer) => (q: Query): Answer => {
      if (q.table === "integrations") return verb(q) === "select" ? { data: connected } : {};
      if (q.table === "integration_secrets") return { data: { ciphertext } };
      if (q.table === "invoices") return { data: invoice };
      if (q.table === "sync_links") return verb(q) === "upsert" ? saveLink() : links(call(q, "match")![1].entity);
      return { data: null };
    };
    const clientLinked = (entity: string): Answer => ({ data: entity === "client" ? { external_id: "cust-1" } : null });
    const quickbooksTakesIt = () => {
      const sent: string[] = [];
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (init?.method !== "POST") return Response.json({ QueryResponse: {} }); // not sent before
        sent.push(url);
        return Response.json({ Invoice: { Id: "qbo-77", SyncToken: "0" } });
      });
      return sent;
    };
    const saves = (queries: Query[]) => queries.filter((q) => q.table === "sync_links" && verb(q) === "upsert").length;

    it("fails for good when QuickBooks took it but the link couldn't be saved", async () => {
      const ciphertext = await encryptJson(env, { access_token: "token", refresh_token: "refresh-1", expires_at: Date.now() + 3_600_000 });
      const sent = quickbooksTakesIt();
      const { db, queries } = fakeDb(answers(ciphertext, clientLinked, () => ({ error: { message: "connection reset" } })));
      const job = runAccountingJob(env, db, { company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-1" } });
      await expect(job).rejects.toThrow("Sent invoice qbo-77 but couldn't record it: connection reset");
      await expect(job).rejects.toBeInstanceOf(SentButUnrecorded);
      expect(sent).toHaveLength(1);
      expect(saves(queries)).toBe(2); // tried once more first
    });

    it("saves the link on a second try rather than sending the invoice again", async () => {
      const ciphertext = await encryptJson(env, { access_token: "token", expires_at: Date.now() + 3_600_000 });
      const sent = quickbooksTakesIt();
      let tries = 0;
      const { db, queries } = fakeDb(answers(ciphertext, clientLinked, () => (++tries === 1 ? { error: { message: "connection reset" } } : {})));
      await runAccountingJob(env, db, { company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-1" } });
      expect(sent).toHaveLength(1);
      expect(saves(queries)).toBe(2);
    });

    it("isn't retried once QuickBooks took it, so the books don't get a copy", async () => {
      const ciphertext = await encryptJson(env, { access_token: "token", expires_at: Date.now() + 3_600_000 });
      const sent = quickbooksTakesIt();
      const row = { id: 10, company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-1" }, attempts: 1 };
      const { queries } = fakeDb(
        answers(ciphertext, clientLinked, () => ({ error: { message: "connection reset" } })),
        (fn) => (fn === "claim_outbox" ? { data: [row] } : {}),
      );
      expect(await runTask("outbox", env)).toEqual({ claimed: 1, done: 0, failed: 1 });
      expect(sent).toHaveLength(1);
      expect(call(queries.find((q) => q.table === "outbox")!, "update")![1]).toMatchObject({ dead_at: expect.any(String), last_error: expect.stringContaining("Sent invoice qbo-77") });
      expect(integrationWrites(queries)).toEqual([{ last_error: "Sent invoice qbo-77 but couldn't record it: connection reset" }]);
    });

    it("doesn't send it when it can't tell whether it was sent already", async () => {
      const ciphertext = await encryptJson(env, { access_token: "token", expires_at: Date.now() + 3_600_000 });
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const { db } = fakeDb(answers(ciphertext, () => ({ error: { message: "connection reset" } }), () => ({})));
      await expect(runAccountingJob(env, db, { company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-1" } })).rejects.toThrow("connection reset");
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // The provider can finish a create after we stopped waiting for it (providerTimeout), and the
  // outbox then runs the job again.
  describe("a create that goes through after we stop waiting", () => {
    const invoice = {
      id: "inv-1", number: 1042, client_id: "client-1", issued_on: "2026-10-17", due_on: null, subject: null, tax_rate: 0, tax_amount: 0, discount_amount: 0,
      invoice_line_items: [{ name: "Mowing", description: null, quantity: 1, unit_price: 45, taxable: false, service_id: null, sort: 0 }],
    };
    const payment = { id: "pay-1", client_id: "client-1", invoice_id: "inv-1", amount: 45, method: "card", received_at: "2026-10-17T15:00:00Z" };
    const invoiceJob = { company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-1" } };
    const paymentJob = { company_id: COMPANY, topic: "accounting.payment", payload: { payment_id: "pay-1" } };

    /**
     * Our side: the client (and maybe the invoice) sent before, and the links saved since. `others`
     * are other records' links, which the provider's id finds.
     */
    async function ours(provider: "quickbooks" | "zoho_books", linked: Record<string, string>, others: Array<{ entity: string; local_id: string; external_id: string }> = [], sent: Record<string, unknown> = invoice) {
      const ciphertext = await encryptJson(env, { access_token: "token", expires_at: Date.now() + 3_600_000 });
      const links = new Map(Object.entries(linked));
      const { db } = fakeDb((q) => {
        if (q.table === "integrations") return verb(q) === "select" ? { data: { provider, external_account_id: "books-1", settings: {} } } : {};
        if (q.table === "integration_secrets") return { data: { ciphertext } };
        if (q.table === "invoices") return { data: sent };
        if (q.table === "payments") return { data: payment };
        if (q.table === "sync_links") {
          if (verb(q) === "upsert") links.set(call(q, "upsert")![1].entity, call(q, "upsert")![1].external_id);
          const match = call(q, "match")?.[1];
          if (match?.external_id) return { data: others.filter((l) => l.entity === match.entity && l.external_id === match.external_id) };
          const id = links.get(match?.entity);
          return { data: id ? { external_id: id } : null };
        }
        return { data: null };
      });
      return { db, links };
    }

    /**
     * The provider: it makes every record it's sent and finds them the way its API does. The first
     * create it answers only after we've stopped waiting (first: "late", the default), or turns
     * down ("refused"), or answers as usual ("answered"). With requestIds it answers a repeated
     * request id with whatever it answered first, a refusal included (QuickBooks doesn't say it won't).
     */
    function provider(options: {
      find: (url: URL, made: Array<Record<string, any>>) => unknown;
      answer: (record: Record<string, any>) => unknown;
      first?: "late" | "refused" | "answered";
      requestIds?: boolean;
      made?: Array<Record<string, any>>;
    }) {
      const made = options.made ?? [];
      const posts: URL[] = [];
      const answered = new Map<string, () => Response>();
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (init?.method !== "POST") return Response.json(options.find(url, made));
        posts.push(url);
        const requestId = url.searchParams.get("requestid");
        if (options.requestIds && requestId && answered.has(requestId)) return answered.get(requestId)!();
        const first = posts.length === 1 ? (options.first ?? "late") : "answered";
        let reply: () => Response;
        if (first === "refused") {
          reply = () => Response.json({ Fault: { Error: [{ Message: "The transaction date is in a closed period" }] } }, { status: 400 });
        } else {
          const record = { ...JSON.parse(String(init.body)), kind: url.pathname.split("/").at(-1), id: `made-${made.length + 1}` };
          made.push(record);
          reply = () => Response.json(options.answer(record));
        }
        if (requestId) answered.set(requestId, reply);
        if (first === "late") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        return reply();
      });
      return { made, posts };
    }

    type Options = { first?: "late" | "refused" | "answered"; requestIds?: boolean; made?: Array<Record<string, any>> };

    const quickbooks = (options: Options = {}) =>
      provider({
        ...options,
        // query?query=select * from Invoice where DocNumber = '1042'
        // query?query=select * from Payment where CustomerRef = 'cust-1' and TxnDate = '2026-10-17'
        find: (url, made) => {
          const query = url.searchParams.get("query") ?? "";
          const value = (field: string) => new RegExp(`${field} = '([^']*)'`).exec(query)?.[1];
          const [entity, found] = query.includes("from Invoice")
            ? ["Invoice", made.filter((r) => r.kind === "invoice" && r.DocNumber === value("DocNumber"))]
            : ["Payment", made.filter((r) => r.kind === "payment" && r.CustomerRef?.value === value("CustomerRef") && r.TxnDate === value("TxnDate"))];
          return { QueryResponse: { [entity as string]: (found as Array<Record<string, any>>).map((r) => ({ ...r, Id: r.id, SyncToken: "0" })) } };
        },
        answer: (r) => ({ [r.kind === "invoice" ? "Invoice" : "Payment"]: { Id: r.id, SyncToken: "0" } }),
      });

    const zoho = (options: Options = {}) =>
      provider({
        ...options,
        // invoices?reference_number=...&customer_id=... and customerpayments?reference_number=...
        find: (url, made) => {
          const kind = url.pathname.split("/").at(-1);
          const hits = made.filter((r) => r.kind === kind && r.reference_number === url.searchParams.get("reference_number"));
          // Zoho works out an invoice's total; nothing of ours sends it tax.
          const total = (r: Record<string, any>) => r.total ?? r.line_items.reduce((sum: number, l: any) => sum + l.rate * l.quantity, 0) - (r.discount ?? 0);
          return kind === "invoices"
            ? { code: 0, invoices: hits.filter((r) => r.customer_id === url.searchParams.get("customer_id")).map((r) => ({ ...r, invoice_id: r.id, total: total(r) })) }
            : { code: 0, customerpayments: hits.map((r) => ({ ...r, payment_id: r.id })) };
        },
        answer: (r) => (r.kind === "invoices" ? { code: 0, invoice: { invoice_id: r.id } } : { code: 0, payment: { payment_id: r.id } }),
      });

    it("doesn't put a second invoice in QuickBooks", async () => {
      const { db, links } = await ours("quickbooks", { client: "cust-1" });
      const qbo = quickbooks();
      await expect(runAccountingJob(env, db, invoiceJob)).rejects.toThrow("timeout");
      await runAccountingJob(env, db, invoiceJob); // the outbox's retry
      expect(qbo.made).toHaveLength(1);
      expect(qbo.posts).toHaveLength(1); // found by its number instead
      expect(links.get("invoice")).toBe("made-1");
    });

    // Our numbers start at 1 and the customer may already be in QuickBooks (found by name), with
    // invoices of its own, or ones from an earlier Crewtavo company.
    it("doesn't take an invoice of theirs with our number for ours", async () => {
      const { db, links } = await ours("quickbooks", { client: "cust-1" });
      const line = (amount: number) => [{ DetailType: "SalesItemLineDetail", Amount: amount }];
      const qbo = quickbooks({
        first: "answered",
        made: [
          { kind: "invoice", id: "old-2019", DocNumber: "1042", CustomerRef: { value: "cust-1" }, TxnDate: "2019-03-02", Line: line(45), TotalAmt: 45 },
          { kind: "invoice", id: "same-day", DocNumber: "1042", CustomerRef: { value: "cust-1" }, TxnDate: "2026-10-17", Line: line(990), TotalAmt: 990 },
        ],
      });
      await runAccountingJob(env, db, invoiceJob);
      expect(qbo.posts).toHaveLength(1);
      expect(links.get("invoice")).toBe("made-3");
    });

    // QuickBooks says a repeated request id gets "the same response" as the first; if that's a
    // refusal, the invoice could never go through once its cause (here a closed period) is fixed.
    it("sends an invoice QuickBooks turned down again as a new request", async () => {
      const { db, links } = await ours("quickbooks", { client: "cust-1" });
      const qbo = quickbooks({ first: "refused", requestIds: true });
      await expect(runAccountingJob(env, db, invoiceJob)).rejects.toThrow("closed period");
      await runAccountingJob(env, db, invoiceJob); // after someone reopened the period
      expect(qbo.made).toHaveLength(1);
      expect(links.get("invoice")).toBe("made-1");
      expect(qbo.posts.map((url) => url.searchParams.get("requestid"))).toEqual([null, null]);
    });

    it("still sends an invoice when the one in QuickBooks with that number is another customer's", async () => {
      const { db, links } = await ours("quickbooks", { client: "cust-1" });
      const qbo = quickbooks({ made: [{ kind: "invoice", id: "theirs", DocNumber: "1042", CustomerRef: { value: "cust-9" } }] });
      await expect(runAccountingJob(env, db, invoiceJob)).rejects.toThrow("timeout");
      await runAccountingJob(env, db, invoiceJob);
      expect(qbo.made.map((r) => r.id)).toEqual(["theirs", "made-2"]);
      expect(links.get("invoice")).toBe("made-2");
    });

    it("doesn't put a second payment in QuickBooks", async () => {
      const { db, links } = await ours("quickbooks", { client: "cust-1", invoice: "qbo-inv-1" });
      const qbo = quickbooks();
      await expect(runAccountingJob(env, db, paymentJob)).rejects.toThrow("timeout");
      await runAccountingJob(env, db, paymentJob);
      expect(qbo.made).toMatchObject([{ TotalAmt: 45, TxnDate: "2026-10-17", Line: [{ LinkedTxn: [{ TxnId: "qbo-inv-1" }] }] }]);
      expect(qbo.posts).toHaveLength(1); // found from the customer, day, amount and invoice instead
      expect(links.get("payment")).toBe("made-1");
    });

    it("sends a payment like one QuickBooks has that day when that one's another of ours, or another amount", async () => {
      const { db, links } = await ours("quickbooks", { client: "cust-1", invoice: "qbo-inv-1" }, [{ entity: "payment", local_id: "pay-0", external_id: "made-1" }]);
      const paid = (id: string, amount: number) => ({
        kind: "payment", id, CustomerRef: { value: "cust-1" }, TotalAmt: amount, TxnDate: "2026-10-17", Line: [{ Amount: amount, LinkedTxn: [{ TxnId: "qbo-inv-1", TxnType: "Invoice" }] }],
      });
      const qbo = quickbooks({ first: "answered", made: [paid("made-1", 45), paid("made-2", 20)] });
      await runAccountingJob(env, db, paymentJob);
      expect(qbo.posts).toHaveLength(1);
      expect(links.get("payment")).toBe("made-3");
    });

    it("doesn't put a second invoice in Zoho Books", async () => {
      const { db, links } = await ours("zoho_books", { client: "contact-1" });
      const books = zoho();
      await expect(runAccountingJob(env, db, invoiceJob)).rejects.toThrow("timeout");
      await runAccountingJob(env, db, invoiceJob);
      expect(books.made).toHaveLength(1);
      expect(books.posts).toHaveLength(1);
      expect(links.get("invoice")).toBe("made-1");
    });

    it("doesn't take a Zoho invoice of theirs with our number as its reference for ours", async () => {
      const { db, links } = await ours("zoho_books", { client: "contact-1" });
      const books = zoho({
        first: "answered",
        made: [
          { kind: "invoices", id: "old-2019", reference_number: "1042", customer_id: "contact-1", date: "2019-03-02", total: 45 },
          { kind: "invoices", id: "same-day", reference_number: "1042", customer_id: "contact-1", date: "2026-10-17", total: 990 },
        ],
      });
      await runAccountingJob(env, db, invoiceJob);
      expect(books.posts).toHaveLength(1);
      expect(links.get("invoice")).toBe("made-3");
    });

    // $200 of mowing, a $20 promo and $50 of referral credits: the books get one $70 discount before tax.
    const credited = { ...invoice, discount_amount: 20, credit_amount: 50, invoice_line_items: [{ ...invoice.invoice_line_items[0]!, unit_price: 200 }] };

    it("sends QuickBooks referral credits in its one discount line, before tax", async () => {
      const { db } = await ours("quickbooks", { client: "cust-1" }, [], credited);
      const qbo = quickbooks({ first: "answered" });
      await runAccountingJob(env, db, invoiceJob);
      expect(qbo.made).toHaveLength(1);
      expect(qbo.made[0]!.Line).toEqual(expect.arrayContaining([{ DetailType: "DiscountLineDetail", Amount: 70, DiscountLineDetail: { PercentBased: false } }]));
      expect(qbo.made[0]!.Line.filter((l: { DetailType: string }) => l.DetailType === "DiscountLineDetail")).toHaveLength(1);
      expect(qbo.made[0]!.ApplyTaxAfterDiscount).toBe(true);
    });

    it("sends Zoho Books referral credits in its discount, and finds the one it sent by its total less them", async () => {
      const { db, links } = await ours("zoho_books", { client: "contact-1" }, [], credited);
      const books = zoho();
      await expect(runAccountingJob(env, db, invoiceJob)).rejects.toThrow("timeout");
      await runAccountingJob(env, db, invoiceJob); // the outbox's retry finds the $130 invoice it sent
      expect(books.made).toMatchObject([{ discount: 70, discount_type: "entity_level", is_discount_before_tax: true }]);
      expect(books.posts).toHaveLength(1);
      expect(links.get("invoice")).toBe("made-1");
    });

    it("doesn't put a second payment in Zoho Books", async () => {
      const { db, links } = await ours("zoho_books", { client: "contact-1", invoice: "zoho-inv-1" });
      const books = zoho();
      await expect(runAccountingJob(env, db, paymentJob)).rejects.toThrow("timeout");
      await runAccountingJob(env, db, paymentJob);
      expect(books.made).toMatchObject([{ reference_number: "pay-1", invoices: [{ invoice_id: "zoho-inv-1", amount_applied: 45 }] }]);
      expect(books.posts).toHaveLength(1);
      expect(links.get("payment")).toBe("made-1");
    });
  });
});

describe("automation runs", () => {
  const run = (id: number) => ({
    id, company_id: COMPANY, rule_id: `rule-${id}`, subject_type: "client", subject_id: "client-1", result: [], status: "running", attempts: 1, locked_until: "2026-10-17T15:05:00.123456+00:00", claim_token: "claim-1",
  });

  it("are skipped once another worker has claimed them", async () => {
    const runs = [run(1), run(2)];
    // The batch took so long that, by run 2, another worker had claimed it.
    const { queries, rpcs } = fakeDb(
      () => ({ data: null }), // the rule is gone, so a run that goes ahead is skipped
      (fn, args) =>
        fn === "claim_automation_runs" ? { data: runs } : fn === "start_automation_run" ? { data: args.p_id === 1 } : fn === "finish_automation_run" ? { data: true } : {},
    );
    expect(await processAutomations(env, { limit: 50 })).toEqual({ claimed: 2, done: 0, skipped: 1, failed: 0, waiting: 0, lost: 1 });

    expect(rpcs.filter((r) => r.fn === "start_automation_run").map((r) => r.args)).toEqual([
      { p_id: 1, p_token: "claim-1" },
      { p_id: 2, p_token: "claim-1" },
    ]);
    expect(queries.filter((q) => q.table === "automation_rules").map((q) => call(q, "eq"))).toEqual([["eq", "id", "rule-1"]]);
    // Finished with the claim's token, so it's recorded only while this worker still holds the run.
    expect(rpcs.filter((r) => r.fn === "finish_automation_run").map((r) => r.args)).toEqual([
      { p_id: 1, p_token: "claim-1", p_status: "skipped", p_result: [], p_error: "The rule was turned off or deleted." },
    ]);
    expect(rpcs.some((r) => r.fn === "release_automation_runs")).toBe(false);
  });

  it("aren't done, or quietly skipped, when the claim can't be checked", async () => {
    const { queries, rpcs } = fakeDb(
      () => ({ data: null }),
      (fn) =>
        fn === "claim_automation_runs"
          ? { data: [run(1), run(2)] }
          : fn === "start_automation_run"
            ? { error: { message: "Could not find the function public.start_automation_run in the schema cache" } }
            : {},
    );
    await expect(processAutomations(env, { limit: 50 })).rejects.toThrow("schema cache");
    expect(queries.filter((q) => q.table === "automation_rules")).toEqual([]);
    // The runs it didn't start are free for the next batch now, not in five minutes.
    expect(rpcs.filter((r) => r.fn === "release_automation_runs").map((r) => r.args)).toEqual([{ p_token: "claim-1", p_ids: [1, 2] }]);
  });

  it("aren't recorded or counted by a worker whose claim has gone", async () => {
    const rows: Record<string, unknown> = {
      automation_rules: { id: "rule-1", name: "Thank them", enabled: true, conditions: [], actions: [], run_count: 4 },
      companies: { id: COMPANY, name: "Acme", timezone: "UTC", currency: "USD", settings: {}, address: {} },
      clients: { id: "client-1", display_name: "Ana Smith", email: null, phone: null, tags: [], status: "active", lead_source: null },
    };
    const { queries, rpcs } = fakeDb(
      (q) => ({ data: verb(q) === "select" ? (rows[q.table] ?? null) : null }),
      // By the time it's done, another worker has claimed the run.
      (fn) => (fn === "claim_automation_runs" ? { data: [run(1)] } : fn === "start_automation_run" ? { data: true } : { data: false }),
    );
    expect(await processAutomations(env, { limit: 50 })).toEqual({ claimed: 1, done: 0, skipped: 0, failed: 0, waiting: 0, lost: 1 });
    expect(rpcs.filter((r) => r.fn === "finish_automation_run").map((r) => r.args.p_status)).toEqual(["done"]);
    expect(queries.filter((q) => q.table === "automation_rules" && verb(q) === "update")).toEqual([]);
  });

  it("know the sub, their price and their reason when a sub turns an offer down", async () => {
    const rows: Record<string, unknown> = {
      automation_rules: {
        id: "rule-1", name: "Tell me", trigger: "sub_offer.declined", enabled: true, conditions: [], run_count: 0,
        actions: [{ type: "notify", roles: ["owner"], title: "{{sub.name}} turned down {{title}} at {{sub.price}}", body: "They said: {{sub.reason}}" }],
      },
      companies: { id: COMPANY, name: "Romeo Roofing", timezone: "America/New_York", currency: "USD", settings: {}, address: {} },
      jobs: { number: 7, title: "Smith roof", status: "active", kind: "one_off", financials: { contract_total: 10800 }, client_id: null, property_id: null, property: null, lines: [] },
      activity: { data: { job_pay_id: "pay-1", sub_name: "Apex Roofing", total: 2210, was: 2040, change: true, reason: "Same roof, same price" } },
      memberships: [{ user_id: "owner-1", role: "owner" }],
    };
    const { queries } = fakeDb(
      (q) => ({ data: verb(q) === "select" ? (rows[q.table] ?? null) : null }),
      (fn) =>
        fn === "claim_automation_runs"
          ? { data: [{ ...run(1), subject_type: "job", subject_id: "job-1", activity_id: 99 }] }
          : fn === "start_automation_run" || fn === "finish_automation_run" ? { data: true } : {},
    );
    expect(await processAutomations(env, { limit: 50 })).toMatchObject({ done: 1 });
    // The event's own data, read from the activity that queued the run.
    expect(queries.filter((q) => q.table === "activity").map((q) => q.calls.filter(([n]) => n === "eq"))).toEqual([[["eq", "company_id", COMPANY], ["eq", "id", 99]]]);
    const sent = call(queries.find((q) => q.table === "notifications" && verb(q) === "insert")!, "insert")![1];
    expect(sent).toEqual([expect.objectContaining({ user_id: "owner-1", title: "Apex Roofing turned down Smith roof at $2,210.00", body: "They said: Same roof, same price", link: "/jobs/job-1" })]);
  });

  /** A sub_offer.declined rule's run on the Smith roof job, as the database would queue it. */
  const offerRun = (actions: unknown[], memberships: unknown[], roles: Record<string, string[]> = {}) => {
    const rows: Record<string, unknown> = {
      automation_rules: { id: "rule-1", name: "Tell me", trigger: "sub_offer.declined", enabled: true, conditions: [], run_count: 0, actions },
      companies: { id: COMPANY, name: "Romeo Roofing", timezone: "America/New_York", currency: "USD", settings: {}, address: {} },
      jobs: { number: 7, title: "Smith roof", status: "active", kind: "one_off", financials: { contract_total: 10800 }, client_id: "client-1", property_id: null, property: null, lines: [] },
      clients: { id: "client-1", display_name: "Ann Client", email: "ann@example.com", phone: "+15405550111", tags: [], status: "active", lead_source: null },
      activity: { data: { job_pay_id: "pay-1", sub_name: "Apex Roofing", total: 2210, reason: "Too far" } },
      memberships,
    };
    return fakeDb(
      (q) => {
        if (q.table === "company_roles") return { data: Object.entries(roles).map(([id, permissions]) => ({ id, permissions })) };
        return { data: verb(q) === "select" ? (rows[q.table] ?? null) : null };
      },
      (fn) =>
        fn === "claim_automation_runs"
          ? { data: [{ ...run(1), subject_type: "job", subject_id: "job-1", activity_id: 99 }] }
          : fn === "start_automation_run" || fn === "finish_automation_run" ? { data: true } : {},
    );
  };

  it("about a sub's offer tell only the office with the Subcontractors area, whoever the rule names", async () => {
    const memberships = [
      { user_id: "owner-1", role: "owner", role_id: null },
      { user_id: "office-1", role: "office", role_id: null },
      // An office person whose custom role has automations but not subs, and the crew.
      { user_id: "clerk-1", role: "office", role_id: "role-clerk" },
      { user_id: "lead-1", role: "crew_lead", role_id: null },
      { user_id: "crew-1", role: "field_crew", role_id: null },
    ];
    // Written straight to the database: crew levels and people by name.
    const { queries } = offerRun([{ type: "notify", roles: ["owner", "office", "crew_lead", "field_crew"], title: "{{sub.name}} asked {{sub.price}}" }], memberships, { "role-clerk": ["automations"] });
    expect(await processAutomations(env, { limit: 50 })).toMatchObject({ done: 1 });
    const sent = call(queries.find((q) => q.table === "notifications" && verb(q) === "insert")!, "insert")![1] as Array<{ user_id: string }>;
    expect(sent.map((n) => n.user_id).sort()).toEqual(["office-1", "owner-1"]);
  });

  it("about a sub's offer fail rather than tell someone without the area", async () => {
    const { queries, rpcs } = offerRun([{ type: "notify", user_ids: ["crew-1"], title: "{{sub.price}}" }], [{ user_id: "crew-1", role: "field_crew", role_id: null }]);
    expect(await processAutomations(env, { limit: 50 })).toMatchObject({ failed: 1 });
    expect(queries.some((q) => q.table === "notifications" && verb(q) === "insert")).toBe(false);
    expect(rpcs.find((r) => r.fn === "finish_automation_run")!.args.p_error).toMatch(/Only the office with the Subcontractors area/);
  });

  /** An autopay rule's run, as the database would queue it: a charge on invoice #2 failed, or a client was added. */
  const autopayRun = (trigger: string, actions: unknown[], memberships: unknown[] = [], roles: Record<string, string[]> = {}) => {
    const rows: Record<string, unknown> = {
      automation_rules: { id: "rule-1", name: "Autopay", trigger, enabled: true, conditions: [], run_count: 0, actions },
      companies: { id: COMPANY, name: "Radford Lawn Care", timezone: "America/New_York", currency: "USD", trade_preset: "lawn_exterior", settings: { autopay: { enabled: true } }, address: {} },
      invoices: { number: 2, subject: "Weekly mow", status: "sent", total: 45, balance_due: 45, client_id: "client-1", job_id: "job-1", lines: [{ name: "Mow" }] },
      clients: { id: "client-1", display_name: "Pat Lee", email: "pat@example.com", phone: "+15405550111", tags: [], status: "active", lead_source: null },
      activity: { data: { client_id: "client-1", card: "Visa ending 4242", reason: "Your card was declined.", status: "failed" } },
      autopay_charges: [{ id: "charge-1" }],
      memberships,
    };
    const subject = trigger === "autopay.failed" ? { subject_type: "invoice", subject_id: "invoice-1" } : { subject_type: "client", subject_id: "client-1" };
    return fakeDb(
      (q) => {
        if (q.table === "company_roles") return { data: Object.entries(roles).map(([id, permissions]) => ({ id, permissions })) };
        return { data: verb(q) === "select" ? (rows[q.table] ?? null) : null };
      },
      (fn) =>
        fn === "claim_automation_runs"
          ? { data: [{ ...run(1), ...subject, activity_id: 77 }] }
          : fn === "start_automation_run" || fn === "renew_automation_run" || fn === "finish_automation_run" ? { data: true } : {},
    );
  };
  const tokenOf = (link: string) => link.match(/\/hub\/([^?\s]+)/)![1]!;

  it("invite a client to autopay by the channel the rule says, skipping who's invited already", async () => {
    invites.send = async (input) => ({ sent: true, detail: input.channel === "sms" ? "Sent by text." : "Sent by email." });
    const { rpcs } = autopayRun("client.created", [{ type: "invite_autopay", channel: "sms" }]);
    expect(await processAutomations(env, { limit: 50, baseUrl: "https://app.test" })).toMatchObject({ done: 1 });
    expect(invites.calls).toEqual([{ companyId: COMPANY, clientId: "client-1", channel: "sms", baseUrl: "https://app.test", createdBy: null, skipIfRecentDays: 7 }]);
    expect(rpcs.find((r) => r.fn === "finish_automation_run")!.args.p_result).toEqual([{ type: "invite_autopay", ok: true, detail: "Sent by text." }]);

    // A skip is fine; a reason it can't go out fails the action.
    invites.send = async () => ({ sent: false, detail: "Skipped: already on autopay" });
    const skipped = autopayRun("client.created", [{ type: "invite_autopay", channel: "email" }]);
    expect(await processAutomations(env, { limit: 50, baseUrl: "https://app.test" })).toMatchObject({ done: 1 });
    expect(skipped.rpcs.find((r) => r.fn === "finish_automation_run")!.args.p_result).toEqual([{ type: "invite_autopay", ok: true, detail: "Skipped: already on autopay" }]);

    invites.send = async () => {
      throw new Error("Turn on autopay in Settings → Payments first.");
    };
    const refused = autopayRun("client.created", [{ type: "invite_autopay", channel: "email" }]);
    expect(await processAutomations(env, { limit: 50, baseUrl: "https://app.test" })).toMatchObject({ failed: 1 });
    expect(refused.rpcs.find((r) => r.fn === "finish_automation_run")!.args.p_error).toBe("Turn on autopay in Settings → Payments first.");
  });

  it("about a failed autopay charge tell the office the card and why, and keep them out of the task", async () => {
    const sent: Array<{ text: string; subject: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("resend")) sent.push(JSON.parse(String(init!.body)));
      return Response.json({ id: "email-1" });
    });
    const memberships = [
      { user_id: "owner-1", role: "owner", role_id: null },
      { user_id: "office-1", role: "office", role_id: null },
      // Office whose custom role has automations but not invoices, and the crew.
      { user_id: "clerk-1", role: "office", role_id: "role-clerk" },
      { user_id: "crew-1", role: "field_crew", role_id: null },
    ];
    const { queries, rpcs } = autopayRun(
      "autopay.failed",
      [
        // Written straight to the database: a crew level too.
        { type: "notify", roles: ["owner", "office", "field_crew"], title: "Autopay failed on {{autopay.card}}", body: "{{autopay.reason}} {{autopay.link}}" },
        { type: "send_email", subject: "We couldn't charge your {{autopay.card}}", body: "Hi {{client.first_name}}, {{autopay.reason}} Update it here:\n\n{{autopay.link}}" },
        { type: "create_task", title: "Call {{client.name}} about {{autopay.card}} ({{autopay.reason}}) {{autopay.link}}", days_from_now: 1 },
      ],
      memberships,
      { "role-clerk": ["automations"] },
    );
    const mailing = { ...env, RESEND_API_KEY: "re_test", EMAIL_FROM: "Crewtavo <hi@crewtavo.test>" };
    expect(await processAutomations(mailing, { limit: 50, baseUrl: "https://app.test" })).toMatchObject({ done: 1 });
    expect(rpcs.find((r) => r.fn === "finish_automation_run")!.args.p_result.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true]);

    // Only the office with the invoices area is told, with the card and the reason.
    const notices = call(queries.find((q) => q.table === "notifications" && verb(q) === "insert")!, "insert")![1] as Array<{ user_id: string; title: string; body: string }>;
    expect(notices.map((n) => n.user_id).sort()).toEqual(["office-1", "owner-1"]);
    expect(notices[0]!.title).toBe("Autopay failed on Visa ending 4242");
    expect(notices[0]!.body).toMatch(/^Your card was declined\. https:\/\/app\.test\/hub\/\S+\?view=autopay$/);
    // The office's notice carries the office's copy of the link, which can't confirm a card or add a tip.
    expect(await readClientLink(env, tokenOf(notices[0]!.body))).toMatchObject({ c: COMPANY, t: "client", id: "client-1", via: "office" });

    // The client's email has their own link, and is kept as an autopay message (only the money office reads those).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("We couldn't charge your Visa ending 4242");
    expect(sent[0]!.text).toContain("Hi Pat, Your card was declined. Update it here:");
    const own = await readClientLink(env, tokenOf(sent[0]!.text));
    expect(own).toMatchObject({ c: COMPANY, t: "client", id: "client-1", own: 1 });
    expect(own!.via).toBeUndefined();
    const message = call(queries.find((q) => q.table === "messages" && verb(q) === "insert")!, "insert")![1];
    expect(message).toMatchObject({ channel: "email", related_type: "autopay", related_id: "client-1", client_id: "client-1" });
    // The copy kept on the timeline has the office's copy of the link, in the same words.
    expect(message.body).toContain("Hi Pat, Your card was declined. Update it here:");
    expect(await readClientLink(env, tokenOf(message.body))).toMatchObject({ c: COMPANY, t: "client", id: "client-1", via: "office" });

    // The task is on the schedule, where the crew sees it: no card, reason or link.
    const task = call(queries.find((q) => q.table === "visits" && verb(q) === "insert")!, "insert")![1] as { title: string };
    expect(task.title).toBe("Call Pat Lee about  ()");
  });

  it("text the client their own links, and keep the office's copies of them on the timeline", async () => {
    const texts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("twilio")) texts.push(new URLSearchParams(String(init!.body)).get("Body")!);
      return Response.json({ sid: "SM1" });
    });
    const { queries, rpcs } = autopayRun("autopay.failed", [{ type: "send_sms", body: "Pay invoice #{{number}}: {{link}} Or update your card: {{autopay.link}}" }]);
    const texting = { ...env, TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15405550000" };
    expect(await processAutomations(texting, { limit: 50, baseUrl: "https://app.test" })).toMatchObject({ done: 1 });
    expect(rpcs.find((r) => r.fn === "finish_automation_run")!.args.p_result).toEqual([expect.objectContaining({ type: "send_sms", ok: true })]);

    const links = (text: string) => [...text.matchAll(/\/hub\/([^?\s]+)/g)].map((m) => m[1]!);
    expect(texts).toHaveLength(1);
    const sent = await Promise.all(links(texts[0]!).map((token) => readClientLink(env, token)));
    expect(sent).toMatchObject([{ t: "invoice", id: "invoice-1" }, { t: "client", id: "client-1" }]);
    for (const link of sent) expect(link!.via).toBeUndefined();
    for (const link of sent) expect(link).toMatchObject({ own: 1 });

    const message = call(queries.find((q) => q.table === "messages" && verb(q) === "insert")!, "insert")![1] as { channel: string; body: string };
    expect(message.channel).toBe("sms");
    expect(message.body).toMatch(/^Pay invoice #2: https:\/\/app\.test\/hub\/\S+ Or update your card: https:\/\/app\.test\/hub\/\S+\?view=autopay$/);
    const kept = await Promise.all(links(message.body).map((token) => readClientLink(env, token)));
    expect(kept).toMatchObject([{ t: "invoice", id: "invoice-1", via: "office" }, { t: "client", id: "client-1", via: "office" }]);
  });

  /** A quote.sent or invoice.sent rule's run, as the database would queue it: quote #7 or invoice #2, for Pat. */
  const sentRun = (subject: "quote" | "invoice", actions: unknown[]) => {
    const rows: Record<string, unknown> = {
      automation_rules: { id: "rule-1", name: "Follow up", trigger: `${subject}.sent`, enabled: true, conditions: [], run_count: 0, actions },
      companies: { id: COMPANY, name: "Radford Lawn Care", timezone: "America/New_York", currency: "USD", trade_preset: "lawn_exterior", settings: {}, address: {} },
      quotes: {
        number: 7, title: "Spring cleanup", status: "sent", total: 300, tax_rate: 0, discount_amount: 0, range_low: null, range_high: null, priced_on_site_at: null, exact_sent_at: null,
        roof_package_id: null, option_id: null, client_id: "client-1", property_id: null, property: null, promo: null, lines: [], options: [],
      },
      invoices: { number: 2, subject: "Weekly mow", status: "sent", total: 45, balance_due: 45, client_id: "client-1", job_id: "job-1", lines: [{ name: "Mow" }] },
      clients: { id: "client-1", display_name: "Pat Lee", email: "pat@example.com", phone: "+15405550111", tags: [], status: "active", lead_source: null },
      autopay_charges: [],
    };
    return fakeDb(
      (q) => ({ data: verb(q) === "select" ? (rows[q.table] ?? null) : null }),
      (fn) =>
        fn === "claim_automation_runs"
          ? { data: [{ ...run(1), subject_type: subject, subject_id: `${subject}-1` }] }
          : fn === "start_automation_run" || fn === "renew_automation_run" || fn === "finish_automation_run" ? { data: true } : {},
    );
  };

  it("put the office's copy of the client's link in the notes and tasks they add, where the team reads them", async () => {
    // A note on a sent quote: estimators and crews who see the client read it.
    const note = sentRun("quote", [{ type: "add_note", body: "Sent {{link}}" }]);
    expect(await processAutomations(env, { limit: 50, baseUrl: "https://app.test" })).toMatchObject({ done: 1 });
    const kept = call(note.queries.find((q) => q.table === "messages" && verb(q) === "insert")!, "insert")![1] as { channel: string; body: string };
    expect(kept.channel).toBe("note");
    expect(kept.body).toMatch(/^Sent https:\/\/app\.test\/hub\/\S+$/);
    const noted = await readClientLink(env, tokenOf(kept.body));
    expect(noted).toMatchObject({ c: COMPANY, t: "quote", id: "quote-1", via: "office" });
    expect(noted).not.toHaveProperty("own");

    // A task on a sent invoice: it's on the schedule, where the crew sees it.
    const task = sentRun("invoice", [{ type: "create_task", title: "Follow up on {{link}}", days_from_now: 2 }]);
    expect(await processAutomations(env, { limit: 50, baseUrl: "https://app.test" })).toMatchObject({ done: 1 });
    const visit = call(task.queries.find((q) => q.table === "visits" && verb(q) === "insert")!, "insert")![1] as { title: string };
    expect(visit.title).toMatch(/^Follow up on https:\/\/app\.test\/hub\/\S+$/);
    // A task's title stops at 200 characters, which cuts the link's signature, so what it was minted as is read straight from it.
    const tasked = JSON.parse(Buffer.from(tokenOf(visit.title).split(".")[0]!, "base64url").toString());
    expect(tasked).toMatchObject({ c: COMPANY, t: "invoice", id: "invoice-1", via: "office" });
    expect(tasked).not.toHaveProperty("own");
  });

  it("email the client their own link, marked as theirs, for a quote or invoice", async () => {
    const sent: Array<{ text: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("resend")) sent.push(JSON.parse(String(init!.body)));
      return Response.json({ id: "email-1" });
    });
    sentRun("invoice", [{ type: "send_email", subject: "Invoice #{{number}}", body: "Pay it here: {{link}}" }]);
    const mailing = { ...env, RESEND_API_KEY: "re_test", EMAIL_FROM: "Crewtavo <hi@crewtavo.test>" };
    expect(await processAutomations(mailing, { limit: 50, baseUrl: "https://app.test" })).toMatchObject({ done: 1 });
    expect(sent).toHaveLength(1);
    const own = await readClientLink(env, tokenOf(sent[0]!.text));
    expect(own).toMatchObject({ t: "invoice", id: "invoice-1", own: 1 });
    expect(own).not.toHaveProperty("via");
  });

  it("about autopay fail rather than tell someone without the invoices area, and never add a client note", async () => {
    const { queries, rpcs } = autopayRun(
      "payment_method.expiring",
      [{ type: "notify", user_ids: ["clerk-1"], title: "{{autopay.card}} expires" }, { type: "add_note", body: "{{autopay.card}}" }],
      [{ user_id: "clerk-1", role: "office", role_id: "role-clerk" }],
      { "role-clerk": ["automations"] },
    );
    expect(await processAutomations(env, { limit: 50, baseUrl: "https://app.test" })).toMatchObject({ failed: 1 });
    expect(queries.some((q) => q.table === "notifications" && verb(q) === "insert")).toBe(false);
    expect(queries.some((q) => q.table === "messages")).toBe(false);
    expect(rpcs.find((r) => r.fn === "finish_automation_run")!.args.p_result).toEqual([
      { type: "notify", ok: false, detail: "Only the office with the Invoices and payments area hears about autopay, and nobody this rule notifies has it." },
      { type: "add_note", ok: false, detail: "This action doesn't fit what starts this rule." },
    ]);
  });

  it("know whether the client and the invoice are on autopay, for the rule's conditions", async () => {
    const { loadContext } = await import("../src/services/automations");
    const { db, queries } = autopayRun("autopay.failed", []);
    expect((await loadContext(db, COMPANY, "invoice", "invoice-1"))?.facts.autopay).toBe("yes");
    const charges = queries.find((q) => q.table === "autopay_charges")!;
    expect(charges.calls).toEqual(expect.arrayContaining([["eq", "company_id", COMPANY], ["eq", "invoice_id", "invoice-1"], ["neq", "status", "called_off"]]));
    expect((await loadContext(db, COMPANY, "client", "client-1"))?.facts.autopay).toBe("no"); // no agreement row in this fake
    const agreements = queries.find((q) => q.table === "autopay_authorizations")!;
    expect(agreements.calls).toEqual(expect.arrayContaining([["eq", "client_id", "client-1"], ["is", "revoked_at", null], ["is", "paused_at", null]]));
  });

  it("about autopay preview with the event's card, the office's copy of the link, and a warning while autopay is off", async () => {
    autopayRun("autopay.failed", []);
    const db = current.db as { from: (table: string) => unknown };
    const from = db.from;
    // The person previewing is office staff; the latest autopay.failed event is on invoice #2.
    db.from = (table: string) => {
      if (table === "memberships") return fakeChain({ role: "office", role_id: null });
      if (table === "activity") return fakeChain([{ id: 77, subject_type: "invoice", subject_id: "invoice-1" }], { data: { data: { card: "Visa ending 4242", reason: "Your card was declined." } } });
      return from(table);
    };
    const preview = (actions: unknown[]) =>
      app.request(
        "/api/automations/preview",
        { method: "POST", headers: { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Failed", trigger: "autopay.failed", conditions: [], actions }) },
        { ...env, APP_URL: "https://app.test" },
      );
    const res = await preview([
      { type: "notify", roles: ["owner"], title: "{{autopay.card}}", body: "{{autopay.link}}" },
      { type: "invite_autopay", channel: "email" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { previews: Array<{ type: string; title?: string; body?: string; to?: string }>; warnings: string[] };
    expect(body.previews[0]).toMatchObject({ type: "notify", title: "Visa ending 4242" });
    expect(await readClientLink(env, tokenOf(body.previews[0]!.body!))).toMatchObject({ t: "client", id: "client-1", via: "office" });
    expect(body.previews[1]).toMatchObject({ type: "invite_autopay", to: "pat@example.com" });
    expect(body.previews[1]!.body).toContain("[autopay link]");
    expect(body.warnings).toContain("Autopay isn't on (Settings → Payments, and a Stripe key that can save cards), so invites won't go out until it is.");
    invites.available = true;
    const on = (await (await preview([{ type: "invite_autopay", channel: "email" }])).json()) as { warnings: string[] };
    expect(on.warnings.some((w) => w.startsWith("Autopay isn't on"))).toBe(false);

    // A task can't show the card, so the rule doesn't preview.
    expect((await preview([{ type: "create_task", title: "{{autopay.card}}", days_from_now: 1 }])).status).toBe(400);
  });

  it("about a sub's offer only notify and make tasks, and a task never shows their price or reason", async () => {
    const texts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => (texts.push(String(input)), Response.json({ sid: "SM1" })));
    const { queries, rpcs } = offerRun(
      [
        { type: "send_sms", body: "Apex wanted {{sub.price}}" },
        { type: "add_note", body: "{{sub.price}}" },
        { type: "create_task", title: "Call {{sub.name}} back about {{sub.price}} ({{sub.reason}})", days_from_now: 1 },
      ],
      [],
    );
    const texting = { ...env, TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15405550000" };
    expect(await processAutomations(texting, { limit: 50 })).toMatchObject({ failed: 1 });
    expect(texts.filter((u) => u.includes("twilio"))).toEqual([]);
    expect(queries.some((q) => q.table === "messages")).toBe(false);
    const task = call(queries.find((q) => q.table === "visits" && verb(q) === "insert")!, "insert")![1] as { title: string };
    expect(task.title).toBe("Call Apex Roofing back about  ()");
    expect(rpcs.find((r) => r.fn === "finish_automation_run")!.args.p_result).toEqual([
      { type: "send_sms", ok: false, detail: "This action doesn't fit what starts this rule." },
      { type: "add_note", ok: false, detail: "This action doesn't fit what starts this rule." },
      expect.objectContaining({ type: "create_task", ok: true }),
    ]);
  });
});
