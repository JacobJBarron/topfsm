/**
 * Two runners at once with a slow mail server: a batch outlasts its claim, another run claims what's
 * left, and every email still goes out exactly once. The database here keeps its rows in memory and
 * claims, renews, records and puts back rows the way 20261019001020_send_claims.sql does (which
 * supabase/tests/send_claims_test.sql tests against Postgres); time is the test's clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { SendResult } from "../src/lib/notify";
import { processAutomations } from "../src/services/automations";
import { processCampaigns } from "../src/services/campaigns";

const current = vi.hoisted(() => ({ db: null as unknown, mailer: null as unknown as (message: { to: string; subject: string }) => Promise<SendResult> }));
vi.mock("../src/lib/supabase", async (original) => ({ ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => current.db }));
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  emailReady: async () => true,
  sendEmail: (_env: Env, message: { to: string; subject: string }) => current.mailer(message),
}));
vi.mock("../src/lib/links", async (original) => ({
  ...(await original<typeof import("../src/lib/links")>()),
  clientLink: async (_env: Env, baseUrl: string, link: { id: string }) => `${baseUrl}/u/${link.id}`,
}));

const env: Env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://ops.example.com" };
const MINUTE = 60_000;
const CLAIM_MS = 5 * MINUTE; // how long a claim lasts, as in the migration

type Row = Record<string, any>;

/** The parts of supabase-js the senders use, over rows in memory. */
function memoryDb(tables: Record<string, Row[]>, failRpc: (fn: string, args: Row) => boolean = () => false) {
  const now = () => Date.now();
  let claims = 0;
  const by = (table: string, ids: number[]) => tables[table]!.filter((r) => ids.includes(r.id));
  const expired = (r: Row) => r.locked_until !== null && r.locked_until < now();
  // A column, or a column of an embedded row with a json path ("company.settings->marketing->>enabled").
  const valueAt = (r: Row, column: string) => {
    const [path, ...keys] = column.split(/->>?/);
    let value = path!.split(".").reduce<any>((row, key) => row?.[key], r);
    for (const key of keys) value = value?.[key];
    return column.includes("->>") && value != null ? String(value) : value;
  };

  const rpcs: Record<string, (a: Row) => unknown> = {
    claim_campaign_recipients: ({ p_campaign, p_limit }) => {
      const token = `claim-${++claims}`;
      return tables.campaign_recipients!
        .filter((r) => r.campaign_id === p_campaign && (r.status === "pending" || (r.status === "sending" && expired(r))))
        .sort((a, b) => a.id - b.id)
        .slice(0, p_limit)
        .map((r) => ({ ...Object.assign(r, { status: "sending", locked_until: now() + CLAIM_MS, claim_token: token }) }));
    },
    renew_campaign_recipient: ({ p_id, p_token }) => {
      const r = by("campaign_recipients", [p_id]).find((x) => x.status === "sending" && x.claim_token === p_token);
      if (r) r.locked_until = now() + CLAIM_MS;
      return Boolean(r);
    },
    finish_campaign_recipients: ({ p_token, p_ids, p_status, p_error }) => {
      const rows = by("campaign_recipients", p_ids).filter((r) => r.claim_token === p_token && ["sending", "skipped"].includes(r.status));
      for (const r of rows) Object.assign(r, { status: p_status, error: p_status === "sent" ? null : p_error, sent_at: p_status === "sent" ? now() : r.sent_at, locked_until: null, claim_token: null });
      return rows.length;
    },
    release_campaign_recipients: ({ p_token, p_ids }) => {
      const rows = by("campaign_recipients", p_ids).filter((r) => r.status === "sending" && r.claim_token === p_token);
      for (const r of rows) Object.assign(r, { status: "pending", locked_until: null, claim_token: null });
      return rows.length;
    },
    claim_automation_runs: ({ p_limit, p_company }) => {
      for (const r of tables.automation_runs!) {
        if (r.status === "running" && expired(r) && r.attempts >= 3) Object.assign(r, { status: "failed", locked_until: null, claim_token: null, error: "Stopped after 3 attempts" });
      }
      const token = `claim-${++claims}`;
      return tables.automation_runs!
        .filter((r) => ((r.status === "pending" && Date.parse(r.run_after) <= now()) || (r.status === "running" && expired(r))) && (!p_company || r.company_id === p_company))
        .slice(0, p_limit)
        .map((r) => ({ ...Object.assign(r, { status: "running", locked_until: now() + CLAIM_MS, claim_token: token }) }));
    },
    start_automation_run: ({ p_id, p_token }) => {
      const r = by("automation_runs", [p_id]).find((x) => x.status === "running" && x.claim_token === p_token);
      if (r) Object.assign(r, { locked_until: now() + CLAIM_MS, attempts: r.attempts + 1 });
      return Boolean(r);
    },
    renew_automation_run: ({ p_id, p_token, p_result }) => {
      const r = by("automation_runs", [p_id]).find((x) => x.status === "running" && x.claim_token === p_token);
      if (r) Object.assign(r, { locked_until: now() + CLAIM_MS, result: structuredClone(p_result) });
      return Boolean(r);
    },
    finish_automation_run: ({ p_id, p_token, p_status, p_result, p_error }) => {
      const r = by("automation_runs", [p_id]).find((x) => x.status === "running" && x.claim_token === p_token);
      if (r) Object.assign(r, { status: p_status, result: structuredClone(p_result), error: p_error ?? null, locked_until: null, claim_token: null });
      return Boolean(r);
    },
    release_automation_runs: ({ p_token, p_ids }) => {
      const rows = by("automation_runs", p_ids).filter((r) => r.status === "running" && r.claim_token === p_token);
      for (const r of rows) Object.assign(r, { status: "pending", locked_until: null, claim_token: null });
      return rows.length;
    },
  };

  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: { kind: "select" | "update" | "insert"; values?: Row | Row[]; head?: boolean } = { kind: "select" };
    let single = false;
    let limit = Infinity;
    const run = () => {
      const rows = (tables[table] ??= []);
      if (op.kind === "insert") {
        rows.push(...[op.values as Row | Row[]].flat());
        return { data: null, error: null };
      }
      const matching = rows.filter((r) => filters.every((f) => f(r))).slice(0, limit);
      if (op.kind === "update") {
        for (const r of matching) Object.assign(r, op.values);
        return { data: null, error: null };
      }
      if (op.head) return { data: null, error: null, count: matching.length };
      const data = matching.map((r) => ({ ...r }));
      return { data: single ? (data[0] ?? null) : data, error: null };
    };
    const builder: any = {
      select: (_columns?: string, options?: { head?: boolean }) => ((op = op.kind === "select" ? { kind: "select", head: options?.head } : op), builder),
      update: (values: Row) => ((op = { kind: "update", values }), builder),
      insert: (values: Row | Row[]) => ((op = { kind: "insert", values }), builder),
      eq: (column: string, value: unknown) => (filters.push((r) => valueAt(r, column) === value), builder),
      in: (column: string, values: unknown[]) => (filters.push((r) => values.includes(r[column])), builder),
      lte: (column: string, value: string) => (filters.push((r) => r[column] != null && r[column] <= value), builder),
      limit: (n: number) => ((limit = n), builder),
      maybeSingle: () => ((single = true), builder),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }

  current.db = {
    from: query,
    rpc: async (fn: string, args: Row) => {
      await Promise.resolve();
      if (failRpc(fn, args)) return { data: null, error: { message: "The database didn't answer." } };
      return { data: rpcs[fn]!(args), error: null };
    },
  };
}

/** A mail server that takes `ms` to accept each message, and remembers every one it was given. */
function slowMailer(ms: number) {
  const sent: string[] = [];
  current.mailer = async (message) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    sent.push(`${message.to} · ${message.subject}`);
    return { sent: true, id: `msg-${sent.length}` };
  };
  return sent;
}

const count = (items: string[]) => items.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date("2026-10-19T15:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("campaign emails with a slow mail server", () => {
  const company = { name: "Acme Lawn Care", email: null, phone: null, address: {}, settings: { marketing: { enabled: true } } };
  function campaignTables(people: number) {
    return {
      campaigns: [{ id: "camp-1", company_id: "co-1", status: "sending", subject: "Fall cleanup", body: "Hi {{client.first_name}}, leaves are coming.", company, sent_count: 0, failed_count: 0, finished_at: null }],
      clients: Array.from({ length: people }, (_, i) => ({ id: `client-${i + 1}`, marketing_opt_out: false })),
      campaign_recipients: Array.from({ length: people }, (_, i) => ({
        id: i + 1, campaign_id: "camp-1", company_id: "co-1", client_id: `client-${i + 1}`, email: `person${i + 1}@example.com`, name: `Person ${i + 1}`,
        status: "pending", error: null, sent_at: null, locked_until: null, claim_token: null,
      })),
    };
  }

  it("go out exactly once when the next run claims what a slow batch hasn't reached", async () => {
    const tables = campaignTables(12);
    memoryDb(tables);
    const sent = slowMailer(70_000); // over a minute per message

    // The first run claims all twelve; its claim on those it hasn't reached runs out after five
    // minutes, and the next run (another server's every-minute task) claims them.
    const first = processCampaigns(env);
    await vi.advanceTimersByTimeAsync(5.5 * MINUTE);
    const second = processCampaigns(env);
    await vi.runAllTimersAsync();
    const [a, b] = await Promise.all([first, second]);

    expect([...count(sent).values()].every((n) => n === 1)).toBe(true);
    expect(sent).toHaveLength(12);
    expect(a.sent + b.sent).toBe(12);
    expect(b.sent).toBeGreaterThan(0); // the second run did take over part of the batch
    expect(a.lost).toBe(b.sent); // and the first left those to it
    expect(tables.campaign_recipients.every((r) => r.status === "sent" && r.claim_token === null)).toBe(true);
    expect(tables.campaigns[0]).toMatchObject({ status: "sent", sent_count: 12 });
  });

  it("puts back the recipients a run didn't get to when it stops partway", async () => {
    const tables = campaignTables(6);
    memoryDb(tables);
    const sent = slowMailer(70_000);
    const mailer = current.mailer;
    current.mailer = async (message) => {
      if (message.to === "person3@example.com") throw new Error("The mail connection broke.");
      return mailer(message);
    };

    const first = processCampaigns(env).catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await first).toBeInstanceOf(Error);
    const byId = (id: number) => tables.campaign_recipients.find((r) => r.id === id)!;
    // Person 3's email may have gone, so it stays claimed until the claim runs out; the ones after
    // it are free for the next run now.
    expect(byId(3)).toMatchObject({ status: "sending" });
    expect([4, 5, 6].map((id) => byId(id))).toEqual([4, 5, 6].map(() => expect.objectContaining({ status: "pending", claim_token: null })));

    current.mailer = mailer;
    const next = processCampaigns(env);
    await vi.runAllTimersAsync();
    expect(await next).toMatchObject({ sent: 3 });
    expect(sent).toEqual([1, 2, 4, 5, 6].map((n) => `person${n}@example.com · Fall cleanup`));
  });
});

describe("automation emails with a slow mail server", () => {
  const steps = [1, 2, 3].map((n) => ({ type: "send_email", subject: `Step ${n}`, body: "Hi {{client.first_name}}" }));
  function automationTables(runs: number) {
    return {
      companies: [{ id: "co-1", name: "Acme Lawn Care", phone: null, email: null, website: null, timezone: "UTC", currency: "USD", settings: {}, address: {} }],
      clients: Array.from({ length: runs }, (_, i) => ({
        id: `client-${i + 1}`, company_id: "co-1", display_name: `Person ${i + 1}`, email: `person${i + 1}@example.com`, phone: null, tags: [], status: "active", lead_source: null,
      })),
      automation_rules: [{ id: "rule-1", company_id: "co-1", name: "Welcome", enabled: true, conditions: [], actions: steps, run_count: 0 }],
      automation_runs: Array.from({ length: runs }, (_, i) => ({
        id: i + 1, company_id: "co-1", rule_id: "rule-1", subject_type: "client", subject_id: `client-${i + 1}`, status: "pending",
        run_after: "2026-10-19T14:59:00.000Z", locked_until: null, claim_token: null, attempts: 0, result: [], error: null,
      })),
      messages: [] as Row[],
    };
  }

  it("go out exactly once when a run takes longer than its claim and another worker overlaps", async () => {
    const tables = automationTables(3);
    memoryDb(tables);
    const sent = slowMailer(2 * MINUTE); // three emails a run: six minutes, past the five-minute claim

    const first = processAutomations(env, { limit: 50 });
    await vi.advanceTimersByTimeAsync(5.5 * MINUTE);
    const second = processAutomations(env, { limit: 50 });
    await vi.runAllTimersAsync();
    const [a, b] = await Promise.all([first, second]);

    expect(sent).toHaveLength(9);
    expect([...count(sent).values()].every((n) => n === 1)).toBe(true);
    expect(a.done + b.done).toBe(3);
    expect(b.done).toBeGreaterThan(0);
    expect(tables.automation_runs.map((r) => [r.status, r.attempts, r.result.length])).toEqual([["done", 1, 3], ["done", 1, 3], ["done", 1, 3]]);
    expect(tables.messages).toHaveLength(9);
  });

  it("puts back runs a stopped batch didn't start, without using an attempt", async () => {
    const tables = automationTables(3);
    memoryDb(tables, (fn, args) => fn === "start_automation_run" && args.p_id === 2);
    slowMailer(1_000);

    const first = processAutomations(env, { limit: 50 }).catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await first).toBeInstanceOf(Error);
    expect(tables.automation_runs.map((r) => [r.status, r.attempts, r.claim_token])).toEqual([["done", 1, null], ["pending", 0, null], ["pending", 0, null]]);
  });
});
