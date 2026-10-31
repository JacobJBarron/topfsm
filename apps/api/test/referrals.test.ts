/**
 * Asking clients for referrals (services/referrals.ts), Jobber's way: what an automatic ask skips
 * (Marketing off, no credit or offer, opted out, archived, no email, asked in the last 6 months) and
 * waits for (review reminders still to go), the email itself, the automation engine, the event's
 * tokens for a credit earned, and the routes for Marketing → Referrals. PostgREST is a stand-in
 * answering over fetch, and sending is mocked. What the database does (the 6 months, the credits)
 * is in supabase/tests/referral_credits_test.sql.
 */
import { REFERRAL_GAP_DAYS, REFERRAL_RULE } from "@crewtavo/core/marketing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  emailReady: vi.fn(async () => true),
  sendEmail: vi.fn(async () => ({ sent: true, id: "email-1" })),
  sendSms: vi.fn(async () => ({ sent: true, id: "sms-1" })),
}));

const notify = await import("../src/lib/notify");
const { sendReferralAsk } = await import("../src/services/referrals");
const { WaitUntil } = await import("../src/services/reviews");
const { executeRun, loadContext, withEvent } = await import("../src/services/automations");
const { adminClient } = await import("../src/lib/supabase");
const { readClientLink } = await import("../src/lib/links");
const { app } = await import("../src/app");
const sendEmail = vi.mocked(notify.sendEmail);
const emailReady = vi.mocked(notify.emailReady);

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};
const CO = "00000000-0000-4000-8000-0000000000c1";
const ANA_ID = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000e1";

type Row = Record<string, any>;
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: any;
}

const ANA: Row = {
  id: ANA_ID, company_id: CO, display_name: "Ana Smith", email: "ana@example.com", phone: "+15405550100", tags: [], status: "active", lead_source: null,
  review_opt_out: false, marketing_opt_out: false, sms_opt_out_at: null,
};
const REFERRALS = { reward: { kind: "amount", value: 50 }, offer: "10% off your first mow" };
const companyRow = (settings: Row = {}): Row => ({
  id: CO, name: "Acme Lawn", phone: "555-0100", email: "office@acme.example", website: null, timezone: "America/New_York", currency: "USD", trade_preset: "lawn_care", address: {},
  settings: { marketing: { enabled: true }, referrals: REFERRALS, ...settings },
});

/**
 * PostgREST over fetch: GETs answer from `tables`, filtered by eq. on the row's own columns;
 * functions answer from `rpc` (true when not given). Every call is kept.
 */
function serve(world: { tables?: Record<string, Row[]>; rpc?: Record<string, (body: any) => unknown> } = {}) {
  const calls: Call[] = [];
  const tables = world.tables ?? {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path, params: url.searchParams, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    if (path === "/auth/v1/user") return Response.json({ id: USER, aud: "authenticated", role: "authenticated" });
    if (path.startsWith("rpc/")) {
      const fn = world.rpc?.[path.slice(4)];
      return Response.json(fn ? (fn(call.body) ?? null) : true);
    }
    if (call.method === "GET") {
      let rows = tables[path] ?? [];
      for (const [column, filter] of url.searchParams) {
        if (!rows.some((r) => column in r)) continue;
        if (filter.startsWith("eq.")) rows = rows.filter((r) => String(r[column]) === filter.slice(3));
      }
      return Response.json(rows);
    }
    if (call.method === "POST") {
      // An insert that asks for its row back gets it, with an id.
      const row = { id: "rule-new", ...(Array.isArray(call.body) ? call.body[0] : call.body) };
      return Response.json(new Headers(init?.headers).get("Accept")?.includes("vnd.pgrst.object") ? row : [row], { status: 201 });
    }
    return Response.json([]);
  });
  return calls;
}

const rpcCalls = (calls: Call[], fn: string) => calls.filter((c) => c.path === `rpc/${fn}`).map((c) => c.body);
const writes = (calls: Call[], method: string, table: string) => calls.filter((c) => c.method === method && c.path === table);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") });
  sendEmail.mockClear().mockImplementation(async () => ({ sent: true, id: "email-1" }));
  emailReady.mockClear().mockImplementation(async () => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function ask(over: Partial<Parameters<typeof sendReferralAsk>[2]> = {}) {
  return sendReferralAsk(env, adminClient(env), {
    companyId: CO, client: ANA as never, baseUrl: "https://ops.example.com", automatic: true, skipIfRecentDays: REFERRAL_GAP_DAYS, createdBy: null, ...over,
  });
}
/** A company to ask for; `last` is when the client was last asked for referrals. */
const asking = (settings: Row = {}, begin: string | null = "ra-1", last: string | null = null, more: Record<string, Row[]> = {}) =>
  serve({ tables: { companies: [companyRow(settings)], ...more }, rpc: { begin_referral_ask: () => begin, last_referral_ask: () => last } });

// ---------------------------------------------------------------------------------------------

describe("an automatic referral ask", () => {
  it.each([
    ["Marketing is off", { marketing: { enabled: false } }, ANA, "Marketing is off"],
    ["Referrals have no credit or offer", { referrals: { reward: { kind: "amount", value: 0 } } }, ANA, "Referrals aren't set up: there's no credit or offer"],
    ["the client unsubscribed from marketing", {}, { ...ANA, marketing_opt_out: true }, "Ana Smith unsubscribed from marketing"],
    ["the client is archived", {}, { ...ANA, status: "archived" }, "Ana Smith is archived"],
    ["the client has no email", {}, { ...ANA, email: null }, "Ana Smith has no email address"],
  ])("skips when %s, with nothing recorded or sent", async (_, settings, client, detail) => {
    const calls = asking(settings);
    expect(await ask({ client: client as never })).toEqual({ sent: false, skipped: true, detail, id: "" });
    expect(rpcCalls(calls, "begin_referral_ask")).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a client asked in the last 6 months before recording anything", async () => {
    const calls = asking({}, "ra-1", "2026-06-01T12:00:00Z");
    expect(await ask()).toMatchObject({ skipped: true, detail: "Already asked for referrals in the last 6 months" });
    expect(rpcCalls(calls, "last_referral_ask")).toEqual([{ p_company: CO, p_client: ANA_ID }]);
    expect(rpcCalls(calls, "begin_referral_ask")).toEqual([]);
  });

  it("asks the database to hold to 6 months too, and skips when it says another ask just went", async () => {
    const calls = asking({}, null);
    expect(await ask()).toMatchObject({ skipped: true, detail: "Already asked for referrals in the last 6 months" });
    expect(rpcCalls(calls, "begin_referral_ask")).toEqual([{ p_company: CO, p_client: ANA_ID, p_automatic: true, p_gap_days: REFERRAL_GAP_DAYS }]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("waits for review reminders still to go out, until the day after the next one", async () => {
    asking({}, "ra-1", null, { review_requests: [{ company_id: CO, client_id: ANA_ID, next_reminder_at: "2026-10-29T17:30:00Z" }] });
    const waiting = await ask().catch((e: unknown) => e);
    expect(waiting).toBeInstanceOf(WaitUntil);
    expect((waiting as InstanceType<typeof WaitUntil>).until.toISOString()).toBe("2026-10-30T17:30:00.000Z");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("fails rather than skips when email isn't connected: the business has that to fix", async () => {
    asking();
    emailReady.mockImplementation(async () => false);
    await expect(ask()).rejects.toThrow("Email isn't connected yet, so referral asks can't be sent.");
  });

  it("emails the client's own link with what they and their friend get, and one-click unsubscribe, into their messages", async () => {
    const calls = asking();
    expect(await ask()).toEqual({ sent: true, detail: "Asked for referrals by email", id: "ra-1" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = sendEmail.mock.calls[0]![1];
    expect(message.to).toBe("ana@example.com");
    expect(message.subject).toBe("Know someone who could use Acme Lawn?");
    const token = /https:\/\/ops\.example\.com\/refer\/(\S+)/.exec(message.text)![1]!;
    expect(await readClientLink(env, token)).toMatchObject({ c: CO, t: "refer", id: ANA_ID });
    expect(message.text).toContain("Hi Ana, thank you for choosing Acme Lawn!");
    expect(message.text).toContain("For your friends: “10% off your first mow”\nYou'll get a $50 credit on your next invoice once they pay their first one.");
    expect(message.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/ops\.example\.com\/api\/public\/unsubscribe\//);
    expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(writes(calls, "POST", "messages").map((c) => [c.body.channel, c.body.subject, c.body.related_type, c.body.related_id])).toEqual([["email", "Referral ask", "referral_ask", "ra-1"]]);
    expect(writes(calls, "PATCH", "referral_asks")).toEqual([]);
  });

  it("uses the business's own email, and leaves {{rewards}} out when only an offer is set", async () => {
    asking({ referrals: { reward: { kind: "amount", value: 0 }, offer: "A free edge trim", message: "Hey {{client.first_name}}: {{link}}\n\n{{rewards}}" } });
    await ask();
    const text = sendEmail.mock.calls[0]![1].text;
    expect(text).toMatch(/^Hey Ana: https:\/\/ops\.example\.com\/refer\/\S+\n\nFor your friends: “A free edge trim”/);
    expect(text).not.toContain("You'll get");
  });

  it("marks the ask failed, saying why, when the email doesn't go", async () => {
    const calls = asking();
    sendEmail.mockImplementation(async () => ({ sent: false, reason: "The mail server said no." }));
    await expect(ask()).rejects.toThrow("The mail server said no.");
    expect(writes(calls, "PATCH", "referral_asks").map((c) => [c.params.get("id"), c.body])).toEqual([["eq.ra-1", { status: "failed", error: "The mail server said no." }]]);
    expect(writes(calls, "POST", "messages")).toEqual([]);
  });
});

describe("an ask by hand", () => {
  it("isn't held to the 6 months", async () => {
    const calls = asking({}, "ra-2", "2026-10-20T12:00:00Z");
    expect(await ask({ automatic: false, skipIfRecentDays: undefined, createdBy: USER })).toMatchObject({ sent: true, id: "ra-2" });
    expect(rpcCalls(calls, "last_referral_ask")).toEqual([]);
    expect(rpcCalls(calls, "begin_referral_ask")).toEqual([{ p_company: CO, p_client: ANA_ID, p_automatic: false, p_created_by: USER }]);
  });

  it("says why it can't go", async () => {
    asking();
    await expect(ask({ automatic: false, client: { ...ANA, marketing_opt_out: true } as never })).rejects.toThrow("Ana Smith unsubscribed from marketing, so they aren't asked for referrals.");
    asking({ marketing: { enabled: false } });
    await expect(ask({ automatic: false })).rejects.toThrow("Marketing is off, so referral asks can't be sent.");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the automation engine", () => {
  const run = (over: Row = {}) => ({ id: 9, company_id: CO, rule_id: "rule-1", subject_type: "job", subject_id: "job-1", activity_id: null, result: [], claim_token: "claim-1", ...over });
  const rule = (over: Row = {}) => ({ id: "rule-1", company_id: CO, name: "Ask for referrals after a job", trigger: "job.completed", enabled: true, conditions: [], actions: [{ type: "request_referral" }], run_count: 2, ...over });
  const job = { id: "job-1", company_id: CO, number: 12, title: "Spring cleanup", status: "completed", kind: "one_off", financials: { contract_total: 400 }, client_id: ANA_ID, property_id: null, property: null, lines: [] };
  const engine = (settings: Row = {}, more: Record<string, Row[]> = {}) =>
    serve({
      tables: { companies: [companyRow(settings)], automation_rules: [rule()], jobs: [job], clients: [ANA], ...more },
      rpc: { begin_referral_ask: () => "ra-1", last_referral_ask: () => null },
    });
  const finished = (calls: Call[]) => rpcCalls(calls, "finish_automation_run");

  it("skips a referral ask while Marketing is off: the run is skipped and isn't counted", async () => {
    const calls = engine({ marketing: { enabled: false } });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)).toEqual([{ p_id: 9, p_token: "claim-1", p_status: "skipped", p_result: [{ type: "request_referral", ok: true, skipped: true, detail: "Marketing is off" }] }]);
    expect(writes(calls, "PATCH", "automation_rules")).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("asks once every 6 months at most, and sends", async () => {
    const calls = engine();
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(rpcCalls(calls, "begin_referral_ask")[0]).toMatchObject({ p_automatic: true, p_gap_days: REFERRAL_GAP_DAYS });
    expect(finished(calls)[0].p_result).toEqual([{ type: "request_referral", ok: true, detail: "Asked for referrals by email" }]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("puts the run back while the client's review reminders are still going out", async () => {
    const calls = engine({}, { review_requests: [{ company_id: CO, client_id: ANA_ID, next_reminder_at: "2026-10-29T17:30:00Z" }] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("waiting");
    expect(rpcCalls(calls, "postpone_automation_run")[0]).toMatchObject({ p_until: "2026-10-30T17:30:00.000Z", p_note: "Waits for their review reminders to go out first" });
  });

  it("gives a thank-you rule the friend, the credit and the invoice it went on", async () => {
    serve({ tables: { companies: [companyRow()], clients: [ANA], activity: [{ id: 31, company_id: CO, data: { friend_name: "Maria Lopez", credit: 50, applied: 50, friend_invoice_id: "inv-f", invoice_id: "inv-a", invoice_number: 1042 } }] } });
    const ctx = await loadContext(adminClient(env), CO, "client", ANA_ID);
    expect((await withEvent(adminClient(env), ctx!, "referral.earned", 31)).vars.referral).toEqual({ name: "Maria", credit: "$50.00", invoice: "#1042" });
    serve({ tables: { companies: [companyRow()], clients: [ANA], activity: [{ id: 32, company_id: CO, data: { friend_name: "Maria Lopez", credit: 45.06, invoice_number: null } }] } });
    expect((await withEvent(adminClient(env), ctx!, "referral.earned", 32)).vars.referral).toEqual({ name: "Maria", credit: "$45.06", invoice: "" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("Marketing → Referrals' routes", () => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: USER, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(`/api${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "X-Company-Id": CO, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }, env);
  const owner = { role: "owner", role_id: null, subcontractor_id: null };
  const office = { role: "office", role_id: null, subcontractor_id: null };
  const starter = (over: Row = {}): Row => ({ id: "rule-ref", company_id: CO, ...REFERRAL_RULE, enabled: false, ...over });

  it("asks by hand, however lately they were asked", async () => {
    const calls = serve({
      tables: { memberships: [office], clients: [ANA], companies: [companyRow()] },
      rpc: { begin_referral_ask: () => "ra-3", last_referral_ask: () => "2026-10-26T12:00:00Z" },
    });
    const res = await call("/referrals/request", { method: "POST", body: { client_id: ANA_ID } });
    expect([res.status, await res.json()]).toEqual([200, { sent: true, detail: "Asked for referrals by email", id: "ra-3" }]);
    expect(rpcCalls(calls, "begin_referral_ask")).toEqual([{ p_company: CO, p_client: ANA_ID, p_automatic: false, p_created_by: USER }]);
  });

  it("is a friendly 409 while Marketing is off, and a 400 with the reason for a client who opted out", async () => {
    serve({ tables: { memberships: [office], clients: [ANA], companies: [companyRow({ marketing: { enabled: false } })] } });
    const off = await call("/referrals/request", { method: "POST", body: { client_id: ANA_ID } });
    expect([off.status, await off.json()]).toEqual([409, { error: "Marketing is off, so referral asks can't be sent. An owner or admin can install it again in Apps." }]);
    serve({ tables: { memberships: [office], clients: [{ ...ANA, marketing_opt_out: true }], companies: [companyRow()] } });
    const out = await call("/referrals/request", { method: "POST", body: { client_id: ANA_ID } });
    expect([out.status, await out.json()]).toEqual([400, { error: "Ana Smith unsubscribed from marketing, so they aren't asked for referrals." }]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("turns the starter rule on and off", async () => {
    let calls = serve({ tables: { memberships: [owner], automation_rules: [starter()], companies: [companyRow()] } });
    let res = await call("/referrals/asks", { method: "PUT", body: { enabled: true } });
    expect([res.status, await res.json()]).toEqual([200, { kept: [], rule_id: "rule-ref" }]);
    expect(writes(calls, "PATCH", "automation_rules").map((c) => [c.params.get("id"), c.body])).toEqual([["eq.rule-ref", { enabled: true }]]);
    calls = serve({ tables: { memberships: [owner], automation_rules: [starter({ enabled: true })], companies: [companyRow()] } });
    res = await call("/referrals/asks", { method: "PUT", body: { enabled: false } });
    expect(res.status).toBe(200);
    expect(writes(calls, "PATCH", "automation_rules").map((c) => c.body)).toEqual([{ enabled: false }]);
  });

  it("puts a deleted rule back, as the starter rule comes", async () => {
    const calls = serve({ tables: { memberships: [owner], automation_rules: [], companies: [companyRow()] } });
    const res = await call("/referrals/asks", { method: "PUT", body: { enabled: true } });
    expect([res.status, await res.json()]).toEqual([200, { kept: [], rule_id: "rule-new" }]);
    expect(writes(calls, "POST", "automation_rules").map((c) => c.body)).toEqual([{ ...REFERRAL_RULE, enabled: true, company_id: CO }]);
  });

  it("keeps the shape of a rule changed in Automations, and only switches it", async () => {
    const changed = starter({ name: "Referrals after big jobs", conditions: [{ field: "amount", op: "gte", value: 1000 }] });
    const calls = serve({ tables: { memberships: [owner], automation_rules: [changed], companies: [companyRow()] } });
    const res = await call("/referrals/asks", { method: "PUT", body: { enabled: true } });
    expect(await res.json()).toEqual({ kept: [{ id: "rule-ref", name: "Referrals after big jobs" }], rule_id: "rule-ref" });
    expect(writes(calls, "PATCH", "automation_rules").map((c) => c.body)).toEqual([{ enabled: true }]);
  });

  it("needs the Automations area, and something to tell clients", async () => {
    serve({ tables: { memberships: [{ role: "admin", role_id: "role-1", subcontractor_id: null }], company_roles: [{ id: "role-1", permissions: ["marketing"] }], automation_rules: [starter()], companies: [companyRow()] } });
    const res = await call("/referrals/asks", { method: "PUT", body: { enabled: true } });
    expect([res.status, await res.json()]).toEqual([403, { error: "Changing when referrals are asked needs the Automations area." }]);
    const calls = serve({ tables: { memberships: [owner], automation_rules: [starter()], companies: [companyRow({ referrals: { reward: { kind: "amount", value: 0 } } })] } });
    const unset = await call("/referrals/asks", { method: "PUT", body: { enabled: true } });
    expect([unset.status, await unset.json()]).toEqual([400, { error: "Add a credit or an offer first." }]);
    expect(writes(calls, "PATCH", "automation_rules")).toEqual([]);
  });

  it("doesn't turn on while Marketing is off or email isn't connected, but always turns off", async () => {
    const offCalls = serve({ tables: { memberships: [owner], automation_rules: [starter()], companies: [companyRow({ marketing: { enabled: false } })] } });
    const off = await call("/referrals/asks", { method: "PUT", body: { enabled: true } });
    expect([off.status, await off.json()]).toEqual([409, { error: "Marketing is off, so referral asks can't be sent. An owner or admin can install it again in Apps." }]);
    expect(writes(offCalls, "PATCH", "automation_rules")).toEqual([]);
    emailReady.mockImplementation(async () => false);
    const noEmailCalls = serve({ tables: { memberships: [owner], automation_rules: [starter()], companies: [companyRow()] } });
    const noEmail = await call("/referrals/asks", { method: "PUT", body: { enabled: true } });
    expect([noEmail.status, await noEmail.json()]).toEqual([400, { error: "Connect your email first, so referral asks can go out. An admin can connect it in Settings → Email." }]);
    expect(writes(noEmailCalls, "PATCH", "automation_rules")).toEqual([]);
    const onRule = serve({ tables: { memberships: [owner], automation_rules: [starter({ enabled: true })], companies: [companyRow({ marketing: { enabled: false } })] } });
    const turnedOff = await call("/referrals/asks", { method: "PUT", body: { enabled: false } });
    expect(turnedOff.status).toBe(200);
    expect(writes(onRule, "PATCH", "automation_rules").map((c) => c.body)).toEqual([{ enabled: false }]);
  });
});
