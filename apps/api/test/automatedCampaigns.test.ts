/**
 * Automated campaigns (services/automatedCampaigns.ts, docs/marketing-plan.md phase C): what the
 * engine skips and sends for Re-engage past clients, Win back lost quotes and Close pending quotes,
 * the email itself (unsubscribe, the company's address, tracked links and pixel), how each send is
 * recorded once, the days since a client's last visit, Marketing → Campaigns' routes, and the
 * starter rules core puts back word for word as the migration installs them. PostgREST
 * is a stand-in answering over fetch, and sending is mocked. What the database does (who
 * client.inactive picks, the 6 months, bookings) is in supabase/tests/automated_campaigns_test.sql.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Action } from "@crewtavo/core";
import { AUTOMATED_CAMPAIGNS, type AutomatedKey } from "@crewtavo/core/campaigns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  emailReady: vi.fn(async () => true),
  sendEmail: vi.fn(async () => ({ sent: true, id: "email-1" })),
  sendSms: vi.fn(async () => ({ sent: true, id: "sms-1" })),
}));

const notify = await import("../src/lib/notify");
const { BUSY_TRIES, busyWait, executeRun, loadContext, processAutomations } = await import("../src/services/automations");
const { adminClient } = await import("../src/lib/supabase");
const { readClientLink } = await import("../src/lib/links");
const { app } = await import("../src/app");
const sendEmail = vi.mocked(notify.sendEmail);
const sendSms = vi.mocked(notify.sendSms);
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
const QUOTE_ID = "00000000-0000-4000-8000-0000000000b1";
const USER = "00000000-0000-4000-8000-0000000000e1";
const TOKEN = "5f0c2b1e-0000-4000-8000-0000000000aa";

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
const companyRow = (settings: Row = {}): Row => ({
  id: CO, name: "Acme Lawn", phone: "555-0100", email: "office@acme.example", website: null, timezone: "America/New_York", currency: "USD", trade_preset: "lawn_care",
  address: { line1: "1 Main St", city: "Radford", region: "VA", postal_code: "24141" },
  settings: { marketing: { enabled: true }, ...settings },
});
/** A starter rule as the database has it. */
const ruleOf = (key: keyof typeof AUTOMATED_CAMPAIGNS, over: Row = {}): Row => {
  const { template_key, ...starter } = AUTOMATED_CAMPAIGNS[key].starter;
  return { id: `rule-${key}`, company_id: CO, template_key, ...starter, enabled: true, run_count: 0, ...over };
};
const visit = (completed_at: string): Row => ({ company_id: CO, status: "completed", kind: "job", completed_at });

/**
 * PostgREST over fetch: GETs answer from `tables`, filtered by eq. on the row's own columns;
 * functions answer from `rpc` (true when not given; a Response as it is). Every call is kept.
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
      const out = fn ? fn(call.body) : true;
      return out instanceof Response ? out : Response.json(out ?? null);
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
      const row = { id: "rule-new", ...(Array.isArray(call.body) ? call.body[0] : call.body) };
      return Response.json(new Headers(init?.headers).get("Accept")?.includes("vnd.pgrst.object") ? row : [row], { status: 201 });
    }
    return Response.json([]);
  });
  return calls;
}

const rpcCalls = (calls: Call[], fn: string) => calls.filter((c) => c.path === `rpc/${fn}`).map((c) => c.body);
const writes = (calls: Call[], method: string, table: string) => calls.filter((c) => c.method === method && c.path === table);
const finished = (calls: Call[]) => rpcCalls(calls, "finish_automation_run");
const sent = () => sendEmail.mock.calls.map((call) => call[1]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") });
  sendEmail.mockClear().mockImplementation(async () => ({ sent: true, id: "email-1" }));
  sendSms.mockClear();
  emailReady.mockClear().mockImplementation(async () => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const begun = (over: Row = {}) => () => [{ id: 501, track_token: TOKEN, already_sent: false, in_flight: false, ...over }];

// ---------------------------------------------------------------------------------------------

describe("the starter rules", () => {
  const migration = (file: string) => readFileSync(fileURLToPath(new URL(`../../../supabase/migrations/${file}`, import.meta.url)), "utf8");
  /** A string as the migrations write it: E'…' with '' for a quote and \n for a new line. */
  const sql = (text: string) => (text.includes("\n") ? `E'${text.replace(/'/g, "''").replace(/\n/g, "\\n")}'` : `'${text.replace(/'/g, "''")}'`);
  const email = (key: AutomatedKey) => AUTOMATED_CAMPAIGNS[key].starter.actions[0] as Extract<Action, { type: "send_email" }>;

  it("are the migration's, word for word, so a deleted one comes back as it was", () => {
    // The latest install_default_automations, the wording that reads well without a phone.
    const install = migration("20261031000510_credit_covered_invoices.sql");
    for (const key of ["reengage", "win_back"] as const) {
      const rule = AUTOMATED_CAMPAIGNS[key].starter;
      expect(install, key).toContain(`(p_company, '${rule.template_key}', ${sql(rule.name)},\n     ${sql(rule.description)}, '${rule.trigger}', ${rule.delay_minutes},`);
      expect(install, key).toContain(`'subject', ${sql(email(key).subject)},\n       'body', ${sql(email(key).body)})), false)`);
      expect(rule.enabled).toBe(false);
    }
    expect(install).toContain("jsonb_build_object('field', 'days_since_visit', 'op', 'gte', 'value', 365)");
    expect(install).toContain("jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'lost')");
    // Close pending quotes is quote_followup, as every business has had it.
    const original = migration("20261031000120_referral_asks.sql");
    const followup = AUTOMATED_CAMPAIGNS.close_quotes.starter;
    expect(original).toContain(`(p_company, 'quote_followup', ${sql(followup.name)},\n     ${sql(followup.description)}, 'quote.sent', 4320,`);
    expect(original).toContain(`'subject', ${sql(email("close_quotes").subject)},\n       'body', ${sql(email("close_quotes").body)})), true)`);
  });
});

describe("Re-engage past clients", () => {
  const run = (over: Row = {}) => ({ id: 41, company_id: CO, rule_id: "rule-reengage", subject_type: "client", subject_id: ANA_ID, activity_id: null, result: [], claim_token: "claim-1", ...over });
  const world = (o: { settings?: Row; client?: Row; rule?: Row; visits?: Row[]; begin?: (body: any) => unknown } = {}) =>
    serve({
      tables: { companies: [companyRow(o.settings)], automation_rules: [o.rule ?? ruleOf("reengage")], clients: [o.client ?? ANA], visits: o.visits ?? [visit("2025-09-01T15:00:00Z")] },
      rpc: { begin_campaign_send: o.begin ?? begun() },
    });

  it("knows the days since a client's last visit, in the company's own dates, and when it was", async () => {
    world();
    const ctx = await loadContext(adminClient(env), CO, "client", ANA_ID);
    expect(ctx!.facts).toMatchObject({ status: "active", days_since_visit: 421 });
    expect(ctx!.vars).toMatchObject({ title: "Ana Smith", last_visit: "September 1, 2025" });
    // Late on the 26th in New York is a day ago on the 27th, whatever UTC says.
    world({ visits: [visit("2026-10-27T03:30:00Z")] });
    expect((await loadContext(adminClient(env), CO, "client", ANA_ID))!.facts.days_since_visit).toBe(1);
    world({ visits: [] });
    expect((await loadContext(adminClient(env), CO, "client", ANA_ID))!.facts.days_since_visit).toBeNull();
  });

  it("runs a client.inactive run through its condition, and sends", async () => {
    const calls = world();
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(finished(calls)[0]).toMatchObject({ p_status: "done", p_result: [{ type: "send_email", ok: true, detail: "Emailed ana@example.com" }] });
    const visits = calls.filter((c) => c.method === "GET" && c.path === "visits");
    expect(visits.map((c) => [c.params.get("job.client_id") ?? c.params.get("request.client_id"), c.params.get("status"), c.params.get("kind")])).toEqual([
      [`eq.${ANA_ID}`, "eq.completed", "in.(job,assessment)"],
      [`eq.${ANA_ID}`, "eq.completed", "in.(job,assessment)"],
    ]);
  });

  it("doesn't send to a client who had a visit since: the condition is checked again", async () => {
    const calls = world({ visits: [visit("2026-07-19T15:00:00Z")] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_error).toBe("Conditions not met: days since their last visit is at least 365 days.");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("lets the stretch go when the client no longer meets a condition the business added, so they're emailed if they meet it again", async () => {
    const vip = ruleOf("reengage", { conditions: [...ruleOf("reengage").conditions, { field: "client.tags", op: "includes", value: ["vip"] }] });
    let calls = world({ rule: vip });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_error).toBe("Conditions not met: client tags include vip.");
    expect(writes(calls, "DELETE", "inactive_client_marks").map((c) => c.params.get("run_id"))).toEqual(["eq.41"]);
    calls = world({ rule: vip, client: { ...ANA, tags: ["VIP"] } });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(writes(calls, "DELETE", "inactive_client_marks")).toEqual([]);
  });

  it.each([
    ["Marketing is off", { settings: { marketing: { enabled: false } } }, "Marketing is off"],
    ["the client unsubscribed from marketing", { client: { ...ANA, marketing_opt_out: true } }, "Ana Smith unsubscribed from marketing"],
    ["the client is archived", { client: { ...ANA, status: "archived" } }, "Ana Smith is archived"],
  ])("skips the whole run when %s, a text the business added too", async (_, o, why) => {
    const rule = ruleOf("reengage", { actions: [...ruleOf("reengage").actions, { type: "send_sms", body: "Hi {{client.first_name}}" }] });
    const calls = world({ ...o, rule });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)).toEqual([{ p_id: 41, p_token: "claim-1", p_status: "skipped", p_result: [], p_error: why }]);
    expect(rpcCalls(calls, "begin_campaign_send")).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("lets the client's stretch go when a run it had claimed finds Marketing off or the rule turned off, so they're emailed once it's back", async () => {
    let calls = world({ settings: { marketing: { enabled: false } } });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(writes(calls, "DELETE", "inactive_client_marks").map((c) => c.params.get("run_id"))).toEqual(["eq.41"]);
    calls = world({ rule: ruleOf("reengage", { enabled: false }) });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_error).toBe("The rule was turned off or deleted.");
    expect(writes(calls, "DELETE", "inactive_client_marks").map((c) => c.params.get("run_id"))).toEqual(["eq.41"]);
    // A client who unsubscribed stays done for this stretch.
    calls = world({ client: { ...ANA, marketing_opt_out: true } });
    await executeRun(env, adminClient(env), run(), env.APP_URL!);
    expect(writes(calls, "DELETE", "inactive_client_marks")).toEqual([]);
  });

  it("records each email action of the run as its own send: a second re-engage email is refused, not reported sent", async () => {
    const twice = ruleOf("reengage", { actions: [...ruleOf("reengage").actions, { type: "send_email", subject: "One more thing", body: "Hi again {{link}}" }] });
    const calls = world({ rule: twice, begin: (body: { p_send_key: string }) => (body.p_send_key === "run:41" ? begun()() : []) });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(rpcCalls(calls, "begin_campaign_send").map((b) => b.p_send_key)).toEqual(["run:41", "run:41:1"]);
    expect(finished(calls)[0].p_result).toEqual([
      { type: "send_email", ok: true, detail: "Emailed ana@example.com" },
      { type: "send_email", ok: true, skipped: true, detail: "Already sent a re-engage email in the last 6 months" },
    ]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("tries again to record an email that went, and still reports it sent if it can't", async () => {
    let tries = 0;
    serve({
      tables: { companies: [companyRow()], automation_rules: [ruleOf("reengage")], clients: [ANA], visits: [visit("2025-09-01T15:00:00Z")] },
      rpc: { begin_campaign_send: begun(), finish_campaign_send: () => (++tries < 3 ? Response.json({ message: "Connection reset", code: "08006" }, { status: 503 }) : true) },
    });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(tries).toBe(3);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("skips a client with no email address", async () => {
    const calls = world({ client: { ...ANA, email: null } });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_result).toEqual([{ type: "send_email", ok: true, skipped: true, detail: "Ana Smith has no email address" }]);
  });

  it("skips a client the database says had one in the last 6 months", async () => {
    const calls = world({ begin: () => [] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_result).toEqual([{ type: "send_email", ok: true, skipped: true, detail: "Already sent a re-engage email in the last 6 months" }]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("records the send first, then emails it as marketing, tracked, with the company's address, into the client's messages", async () => {
    const calls = world();
    await executeRun(env, adminClient(env), run(), env.APP_URL!);
    const [begin] = rpcCalls(calls, "begin_campaign_send");
    expect(begin).toMatchObject({
      p_company: CO, p_key: "reengage_past_clients", p_client: ANA_ID, p_email: "ana@example.com", p_name: "Ana Smith", p_send_key: "run:41", p_gap_days: 182, p_once_per_subject: false,
    });
    expect(begin.p_subject).toBeUndefined();
    // {{link}} is their Client Hub home, where they can ask for work.
    expect(begin.p_links).toHaveLength(1);
    expect(await readClientLink(env, begin.p_links[0].split("/hub/")[1])).toMatchObject({ c: CO, t: "client", id: ANA_ID });

    const [message] = sent();
    expect(message!.to).toBe("ana@example.com");
    expect(message!.subject).toBe("It's been a while, Ana");
    expect(message!.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/ops\.example\.com\/api\/public\/unsubscribe\//);
    expect(message!.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(message!.html).toContain("Acme Lawn · 1 Main St, Radford, VA, 24141 · <a href=\"https://ops.example.com/u/");
    expect(message!.html).toContain(`<img src="https://ops.example.com/api/public/o/${TOKEN}"`);
    expect(message!.html).toContain(`<a href="https://ops.example.com/api/public/c/${TOKEN}/0" style="display:inline-block`);
    // {{link}} on its own line is the Hub's home, where they ask for work, as the Hub names it.
    expect(message!.html).toContain(">Request work</a>");
    expect(message!.html).not.toContain(begin.p_links[0]);
    // It lasts a year, as a review link does: campaign emails are kept.
    const hubLink = await readClientLink(env, begin.p_links[0].split("/hub/")[1]);
    expect(hubLink!.exp).toBe(Math.floor(Date.parse("2026-10-27T15:00:00Z") / 1000) + 365 * 86_400);
    expect(message!.text).toContain(`ask for a visit online:\n\nhttps://ops.example.com/api/public/c/${TOKEN}/0\n\n`);
    expect(message!.text).toContain("Acme Lawn · 1 Main St, Radford, VA, 24141");
    expect(rpcCalls(calls, "finish_campaign_send")).toEqual([{ p_id: 501, p_status: "sent" }]);
    expect(writes(calls, "POST", "messages").map((c) => [c.body.channel, c.body.subject, c.body.related_type, c.body.related_id])).toEqual([["email", "It's been a while, Ana", "client", ANA_ID]]);
  });

  it("doesn't email again for a retried run whose email went", async () => {
    const calls = world({ begin: begun({ already_sent: true }) });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(finished(calls)[0].p_result).toEqual([{ type: "send_email", ok: true, detail: "Emailed ana@example.com" }]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(writes(calls, "POST", "messages")).toEqual([]);
  });

  it("waits while the same email may still be on its way from another worker", async () => {
    const calls = world({ begin: begun({ in_flight: true }) });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("waiting");
    expect(rpcCalls(calls, "postpone_automation_run")[0]).toMatchObject({ p_until: "2026-10-27T15:16:00.000Z", p_note: "An email to them was already on its way" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("fails, and lets the client's stretch go, when email isn't connected: the business has that to fix", async () => {
    emailReady.mockImplementation(async () => false);
    const calls = world();
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("failed");
    expect(finished(calls)[0].p_error).toBe("Email isn't connected yet, so campaign emails can't be sent. An admin can connect it in Settings → Email.");
    expect(writes(calls, "DELETE", "inactive_client_marks").map((c) => c.params.get("run_id"))).toEqual(["eq.41"]);
    expect(rpcCalls(calls, "begin_campaign_send")).toEqual([]);
  });

  it("records a failed email as failed, saying why", async () => {
    sendEmail.mockImplementation(async () => ({ sent: false, reason: "The mail server said no." }));
    const calls = world();
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("failed");
    expect(rpcCalls(calls, "finish_campaign_send")).toEqual([{ p_id: 501, p_status: "failed", p_error: "The mail server said no." }]);
    expect(writes(calls, "POST", "messages")).toEqual([]);
  });

  it("treats a copy of the rule made in Automations as Re-engage too: unsubscribe, the 6 months, and nothing while Marketing is off", async () => {
    const copy = ruleOf("reengage", { id: "rule-copy", template_key: null, name: "Re-engage after 90 days", conditions: [{ field: "days_since_visit", op: "gte", value: 90 }] });
    let calls = world({ rule: copy });
    expect(await executeRun(env, adminClient(env), run({ rule_id: "rule-copy" }), env.APP_URL!)).toBe("done");
    expect(rpcCalls(calls, "begin_campaign_send")[0]).toMatchObject({ p_key: "reengage_past_clients", p_gap_days: 182 });
    expect(sent()[0]!.headers?.["List-Unsubscribe"]).toBeDefined();
    calls = world({ rule: copy, settings: { marketing: { enabled: false } } });
    expect(await executeRun(env, adminClient(env), run({ rule_id: "rule-copy" }), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_error).toBe("Marketing is off");
  });
});

describe("a busy email service", () => {
  const run = (over: Row = {}) => ({ id: 205, company_id: CO, rule_id: "rule-reengage", subject_type: "client", subject_id: ANA_ID, activity_id: null, result: [], claim_token: "claim-1", busy_tries: 0, ...over });
  const world = () =>
    serve({
      tables: { companies: [companyRow()], automation_rules: [ruleOf("reengage")], clients: [ANA], visits: [visit("2025-09-01T15:00:00Z")] },
      rpc: { begin_campaign_send: begun(), claim_automation_runs: () => [run(), run({ id: 206 })], start_automation_run: () => true },
    });
  const tooMany = async () => ({ sent: false, status: 429, reason: "Resend got too many emails at once. Try again in a minute." });

  it("puts a run Resend turned away for too many at once back to wait, longer each time, keeping the client queued", async () => {
    sendEmail.mockImplementation(tooMany);
    const calls = world();
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("waiting");
    // The send is recorded failed, so the next try sends it again rather than finding it on its way.
    expect(rpcCalls(calls, "finish_campaign_send")).toEqual([{ p_id: 501, p_status: "failed", p_error: "Resend got too many emails at once. Try again in a minute." }]);
    expect(rpcCalls(calls, "postpone_automation_run")).toEqual([
      { p_id: 205, p_token: "claim-1", p_until: "2026-10-27T15:01:00.000Z", p_result: [], p_note: "Resend got too many emails at once. It's tried again by itself in a minute.", p_busy: true },
    ]);
    expect(finished(calls)).toEqual([]);
    // The client's stretch keeps its run, so they're still counted and still emailed.
    expect(calls.some((c) => c.path === "inactive_client_marks")).toBe(false);
    expect(busyWait(0)).toBe(60_000);
    expect(busyWait(3)).toBe(480_000);
  });

  it("waits 4 minutes on its third try, and fails after the last, saying why", async () => {
    sendEmail.mockImplementation(tooMany);
    let calls = world();
    await executeRun(env, adminClient(env), run({ busy_tries: 2 }), env.APP_URL!);
    expect(rpcCalls(calls, "postpone_automation_run")[0]).toMatchObject({ p_until: "2026-10-27T15:04:00.000Z", p_busy: true });
    calls = world();
    expect(await executeRun(env, adminClient(env), run({ busy_tries: BUSY_TRIES }), env.APP_URL!)).toBe("failed");
    expect(finished(calls)[0]).toMatchObject({ p_status: "failed", p_error: "Resend got too many emails at once. Try again in a minute." });
  });

  it("treats Resend's own trouble (a 5xx) as busy too, and a plain refusal as a failure", async () => {
    sendEmail.mockImplementation(async () => ({ sent: false, status: 503, reason: "Resend is having trouble right now. Try again in a few minutes." }));
    let calls = world();
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("waiting");
    expect(rpcCalls(calls, "postpone_automation_run")[0]).toMatchObject({ p_busy: true });
    sendEmail.mockImplementation(async () => ({ sent: false, status: 422, reason: "That email address isn't valid, so Resend didn't send it." }));
    calls = world();
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("failed");
    // A daily sending limit isn't busy for now: trying again in a minute won't help.
    sendEmail.mockImplementation(async () => ({ sent: false, status: 429, reason: "This Resend account has reached its daily sending limit (100 emails on the free plan). Sending starts again after midnight UTC, or upgrade the Resend plan to send more." }));
    calls = world();
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("failed");
  });

  it("stops the batch at a busy answer, putting the rest back for the next pass instead of firing them at Resend", async () => {
    sendEmail.mockImplementation(tooMany);
    const calls = world();
    expect(await processAutomations(env, { limit: 25 })).toEqual({ claimed: 2, done: 0, skipped: 0, failed: 0, waiting: 1, lost: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(rpcCalls(calls, "release_automation_runs")).toEqual([{ p_token: "claim-1", p_ids: [206] }]);
  });
});

describe("Win back lost quotes", () => {
  const quote: Row = {
    id: QUOTE_ID, company_id: CO, number: 1042, title: "Patio", status: "lost", total: 1250, tax_rate: 0, discount_amount: 0, range_low: null, range_high: null,
    priced_on_site_at: null, exact_sent_at: null, roof_package_id: null, option_id: null, client_id: ANA_ID, property_id: null, property: null, promo: null,
    lines: [], options: [], updated_at: "2026-09-27T15:00:00Z", created_at: "2026-09-01T15:00:00Z",
  };
  const LOST = "2026-09-27T15:00:00Z";
  const run = { id: 52, company_id: CO, rule_id: "rule-win_back", subject_type: "quote", subject_id: QUOTE_ID, activity_id: 77, result: [], claim_token: "claim-1" };
  const world = (more: Record<string, Row[]> = {}, begin: () => unknown = begun()) =>
    serve({
      tables: {
        companies: [companyRow()], automation_rules: [ruleOf("win_back")], clients: [ANA], activity: [{ id: 77, company_id: CO, created_at: LOST }],
        ...more, quotes: [quote, ...(more.quotes ?? [])],
      },
      rpc: { begin_campaign_send: begin },
    });

  it.each([
    ["they approved another quote since", { quotes: [{ id: "q2", client_id: ANA_ID, company_id: CO, status: "approved", approved_at: "2026-10-01T15:00:00Z", converted_at: null, updated_at: "2026-10-01T15:00:00Z" }] }, "They approved another quote since"],
    ["another went straight to a job since", { quotes: [{ id: "q2", client_id: ANA_ID, company_id: CO, status: "converted", approved_at: null, converted_at: null, updated_at: "2026-10-02T15:00:00Z" }] }, "They approved another quote since"],
    ["they have an active job", { jobs: [{ client_id: ANA_ID, company_id: CO, status: "active", created_at: "2026-01-01T15:00:00Z" }] }, "They have an active job"],
    ["they've had a job since", { jobs: [{ client_id: ANA_ID, company_id: CO, status: "completed", created_at: "2026-10-03T15:00:00Z" }] }, "They have a newer job"],
    ["a newer quote is waiting on them", { quotes: [{ id: "q2", client_id: ANA_ID, company_id: CO, status: "sent", approved_at: null, converted_at: null, updated_at: "2026-10-05T15:00:00Z", created_at: "2026-10-04T15:00:00Z" }] }, "They have a newer quote"],
    ["they sent a request since", { requests: [{ client_id: ANA_ID, company_id: CO, created_at: "2026-10-06T15:00:00Z" }] }, "They sent a request since"],
  ])("skips when %s", async (_, more, why) => {
    const calls = world(more as Record<string, Row[]>);
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_result).toEqual([{ type: "send_email", ok: true, skipped: true, detail: why }]);
    expect(rpcCalls(calls, "begin_campaign_send")).toEqual([]);
  });

  it("sends once for the quote, linking to their Client Hub home, after an approval from before it was lost", async () => {
    const before = { id: "q0", client_id: ANA_ID, company_id: CO, status: "approved", approved_at: "2026-03-01T15:00:00Z", converted_at: null, updated_at: "2026-03-01T15:00:00Z" };
    const calls = world({ quotes: [before] });
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("done");
    const [begin] = rpcCalls(calls, "begin_campaign_send");
    expect(begin).toMatchObject({ p_key: "win_back_lost_quotes", p_subject: QUOTE_ID, p_once_per_subject: true, p_send_key: "run:52" });
    expect(begin.p_gap_days).toBeUndefined();
    expect(await readClientLink(env, begin.p_links[0].split("/hub/")[1])).toMatchObject({ t: "client", id: ANA_ID });
    expect(sent()[0]!.subject).toBe("Still thinking about Patio?");
    expect(sent()[0]!.headers?.["List-Unsubscribe"]).toBeDefined();
  });

  it("skips a second one for the same quote", async () => {
    const calls = world({}, () => []);
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_result[0].detail).toBe("Already sent a win-back email for this quote");
  });
});

describe("Close pending quotes", () => {
  const quote: Row = {
    id: QUOTE_ID, company_id: CO, number: 1042, title: "Patio", status: "sent", total: 1250, tax_rate: 0, discount_amount: 0, range_low: null, range_high: null,
    priced_on_site_at: null, exact_sent_at: null, roof_package_id: null, option_id: null, client_id: ANA_ID, property_id: null, property: null, promo: null, lines: [], options: [],
  };
  const run = { id: 63, company_id: CO, rule_id: "rule-close_quotes", subject_type: "quote", subject_id: QUOTE_ID, activity_id: null, result: [], claim_token: "claim-1" };
  const world = (o: { settings?: Row; client?: Row; rule?: Row } = {}) =>
    serve({
      tables: { companies: [companyRow(o.settings)], automation_rules: [o.rule ?? ruleOf("close_quotes")], clients: [o.client ?? ANA], quotes: [quote] },
      rpc: { begin_campaign_send: begun() },
    });

  it("isn't marketing: it goes while Marketing is off, to a client who unsubscribed from marketing, with no unsubscribe link, and is tracked", async () => {
    const calls = world({ settings: { marketing: { enabled: false } }, client: { ...ANA, marketing_opt_out: true } });
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("done");
    expect(finished(calls)[0].p_result).toEqual([{ type: "send_email", ok: true, detail: "Emailed ana@example.com" }]);
    const [begin] = rpcCalls(calls, "begin_campaign_send");
    expect(begin).toMatchObject({ p_key: "quote_followup", p_subject: QUOTE_ID, p_once_per_subject: false });
    expect(begin.p_gap_days).toBeUndefined();
    const [message] = sent();
    expect(message!.subject).toBe("Following up on your quote from Acme Lawn");
    expect(message!.headers).toBeUndefined();
    expect(message!.html).not.toContain("Unsubscribe");
    expect(message!.html).toContain(`/api/public/o/${TOKEN}`);
    expect(message!.html).toContain(`href="https://ops.example.com/api/public/c/${TOKEN}/0"`);
  });

  it("emails the client their own quote link, and keeps the office's copy on the quote's timeline", async () => {
    const calls = world();
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("done");
    const [begin] = rpcCalls(calls, "begin_campaign_send");
    expect(await readClientLink(env, begin.p_links[0].split("/hub/")[1])).toMatchObject({ t: "quote", id: QUOTE_ID, own: 1 });
    // Estimators and the office read the timeline: its copy can't confirm a card or add a tip.
    const [kept] = writes(calls, "POST", "messages").map((c) => c.body);
    expect(kept).toMatchObject({ related_type: "quote", related_id: QUOTE_ID, subject: "Following up on your quote from Acme Lawn" });
    const office = await readClientLink(env, kept.body.split("/hub/")[1].split(/\s/)[0]);
    expect(office).toMatchObject({ t: "quote", id: QUOTE_ID, via: "office" });
    expect(office).not.toHaveProperty("own");
  });

  it("sends both emails of a rule given a second one in Automations, each recorded as its own send", async () => {
    const twice = ruleOf("close_quotes", { actions: [...ruleOf("close_quotes").actions, { type: "send_email", subject: "Any questions?", body: "Happy to help: {{link}}" }] });
    const calls = world({ rule: twice });
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("done");
    expect(rpcCalls(calls, "begin_campaign_send").map((b) => b.p_send_key)).toEqual(["run:63", "run:63:1"]);
    expect(sent().map((m) => m!.subject)).toEqual(["Following up on your quote from Acme Lawn", "Any questions?"]);
    expect(finished(calls)[0].p_result.map((r: { detail: string }) => r.detail)).toEqual(["Emailed ana@example.com", "Emailed ana@example.com"]);
  });

  it("still fails for a client with no email, as it always has", async () => {
    const calls = world({ client: { ...ANA, email: null } });
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("failed");
    expect(finished(calls)[0].p_error).toBe("Ana Smith has no email address.");
  });

  it("goes untracked, as before, without APP_URL", async () => {
    const calls = world();
    expect(await executeRun(env, adminClient(env), run, null)).toBe("done");
    expect(rpcCalls(calls, "begin_campaign_send")).toEqual([]);
    expect(sent()[0]!.html).not.toContain("/api/public/o/");
  });

  it("leaves a rule of the business's own as it was", async () => {
    const own = ruleOf("close_quotes", { id: "rule-own", template_key: null, name: "Nudge after a week" });
    const calls = world({ rule: own });
    expect(await executeRun(env, adminClient(env), { ...run, rule_id: "rule-own" }, env.APP_URL!)).toBe("done");
    expect(rpcCalls(calls, "begin_campaign_send")).toEqual([]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Marketing → Campaigns' routes", () => {
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
  const routes = (rules: Row[], settings: Row = {}, more: Record<string, Row[]> = {}, waiting = 0) =>
    serve({
      tables: { memberships: [owner], automation_rules: rules, companies: [companyRow(settings)], ...more },
      rpc: { ensure_automated_campaign: () => "camp-1", skip_inactive_backlog: () => 3, release_inactive_backlog: () => 2, inactive_client_count: () => waiting },
    });

  it("turns a campaign on and off with its switch alone", async () => {
    let calls = routes([ruleOf("reengage", { enabled: false })]);
    let res = await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: true } });
    expect([res.status, await res.json()]).toEqual([200, { kept: [], rule_id: "rule-reengage", campaign_id: "camp-1" }]);
    expect(writes(calls, "PATCH", "automation_rules").map((c) => [c.params.get("id"), c.body])).toEqual([["eq.rule-reengage", { enabled: true }]]);
    expect(rpcCalls(calls, "ensure_automated_campaign")).toEqual([{ p_company: CO, p_key: "reengage_past_clients" }]);
    calls = routes([ruleOf("reengage")], { marketing: { enabled: false } });
    emailReady.mockImplementation(async () => false);
    res = await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: false } });
    expect(res.status).toBe(200);
    expect(writes(calls, "PATCH", "automation_rules").map((c) => c.body)).toEqual([{ enabled: false }]);
  });

  it("won't turn Re-engage on without a choice while past clients already qualify, counting at the rule's own days", async () => {
    let calls = routes([ruleOf("reengage", { enabled: false })], {}, {}, 12);
    let res = await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: true } });
    expect([res.status, await res.json()]).toEqual([409, { error: "12 past clients qualify already. Turn it on again to choose whether to email them too or only clients who reach it from now on." }]);
    expect(rpcCalls(calls, "inactive_client_count")).toEqual([{ p_company: CO, p_days: 365 }]);
    expect(writes(calls, "PATCH", "automation_rules")).toEqual([]);
    // One changed in Automations waits as long as its own condition says.
    const changed = ruleOf("reengage", { enabled: false, conditions: [{ field: "days_since_visit", op: "gte", value: 90 }, { field: "client.tags", op: "includes", value: ["VIP"] }] });
    calls = routes([changed], {}, {}, 4);
    res = await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: true } });
    expect(res.status).toBe(409);
    expect(rpcCalls(calls, "inactive_client_count")).toEqual([{ p_company: CO, p_days: 90 }]);
    // Nobody waiting: nothing to ask.
    calls = routes([ruleOf("reengage", { enabled: false })], {}, {}, 0);
    expect((await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: true } })).status).toBe(200);
    expect(writes(calls, "PATCH", "automation_rules").map((c) => c.body)).toEqual([{ enabled: true }]);
  });

  it("emails the backlog when asked, a backlog let go before included, before turning Re-engage on", async () => {
    const calls = routes([ruleOf("reengage", { enabled: false })], {}, {}, 12);
    const res = await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: true, backlog: "send" } });
    expect(res.status).toBe(200);
    const order = calls.filter((c) => c.path === "rpc/release_inactive_backlog" || (c.method === "PATCH" && c.path === "automation_rules")).map((c) => c.path);
    expect(order).toEqual(["rpc/release_inactive_backlog", "automation_rules"]);
    expect(rpcCalls(calls, "release_inactive_backlog")).toEqual([{ p_rule: "rule-reengage" }]);
    expect(rpcCalls(calls, "skip_inactive_backlog")).toEqual([]);
  });

  it("lets today's backlog go first, when asked, before turning Re-engage on", async () => {
    const calls = routes([ruleOf("reengage", { enabled: false })]);
    const res = await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: true, backlog: "skip" } });
    expect(res.status).toBe(200);
    const order = calls.filter((c) => c.path === "rpc/skip_inactive_backlog" || (c.method === "PATCH" && c.path === "automation_rules")).map((c) => c.path);
    expect(order).toEqual(["rpc/skip_inactive_backlog", "automation_rules"]);
    expect(rpcCalls(calls, "skip_inactive_backlog")).toEqual([{ p_rule: "rule-reengage" }]);
    expect(rpcCalls(calls, "release_inactive_backlog")).toEqual([]);
  });

  it("saves Edit email's days, subject and message without touching the switch, renaming only the starter's words", async () => {
    let calls = routes([ruleOf("reengage", { enabled: false })]);
    let res = await call("/campaigns/automated/reengage", { method: "PUT", body: { days: 90, subject: "We miss you", body: "Hi {{client.first_name}}, come back soon: {{link}}" } });
    expect(res.status).toBe(200);
    expect(writes(calls, "PATCH", "automation_rules").map((c) => c.body)).toEqual([{
      trigger: "client.inactive", conditions: [{ field: "days_since_visit", op: "gte", value: 90 }], delay_minutes: 0,
      actions: [{ type: "send_email", subject: "We miss you", body: "Hi {{client.first_name}}, come back soon: {{link}}" }],
      name: "Re-engage past clients", description: "Emails clients 3 months after their last visit, once each time they go quiet.",
    }]);
    calls = routes([ruleOf("close_quotes", { name: "Chase quotes", description: "Ours" })]);
    res = await call("/campaigns/automated/close_quotes", { method: "PUT", body: { days: 5 } });
    expect(writes(calls, "PATCH", "automation_rules").map((c) => [c.body.delay_minutes, c.body.name, c.body.description])).toEqual([[7200, undefined, undefined]]);
    calls = routes([ruleOf("close_quotes")]);
    res = await call("/campaigns/automated/close_quotes", { method: "PUT", body: { days: 5 } });
    expect(writes(calls, "PATCH", "automation_rules").map((c) => [c.body.delay_minutes, c.body.name, c.body.description])).toEqual([
      [7200, "Follow up on quotes after 5 days", "Emails the client if they haven't answered a quote 5 days after you send it."],
    ]);
  });

  it("keeps the shape of a rule changed in Automations, and only switches it", async () => {
    const changed = ruleOf("win_back", { enabled: false, name: "Win back big quotes", conditions: [{ field: "amount", op: "gte", value: 5000 }] });
    const calls = routes([changed]);
    const res = await call("/campaigns/automated/win_back", { method: "PUT", body: { enabled: true, days: 45, subject: "Ignored", body: "Ignored for this one" } });
    expect(await res.json()).toEqual({ kept: [{ id: "rule-win_back", name: "Win back big quotes" }], rule_id: "rule-win_back", campaign_id: "camp-1" });
    expect(writes(calls, "PATCH", "automation_rules").map((c) => c.body)).toEqual([{ enabled: true }]);
  });

  it("puts a deleted rule back as the starter rule, with the form", async () => {
    const calls = routes([]);
    const res = await call("/campaigns/automated/win_back", { method: "PUT", body: { enabled: true, days: 30 } });
    expect([res.status, (await res.json()).rule_id]).toEqual([200, "rule-new"]);
    const { template_key, ...starter } = AUTOMATED_CAMPAIGNS.win_back.starter;
    expect(writes(calls, "POST", "automation_rules").map((c) => c.body)).toEqual([{ ...starter, template_key, enabled: true, company_id: CO }]);
  });

  it("needs the Automations area, Marketing installed, email connected and days in range", async () => {
    serve({ tables: { memberships: [{ role: "admin", role_id: "role-1", subcontractor_id: null }], company_roles: [{ id: "role-1", permissions: ["marketing"] }], automation_rules: [ruleOf("reengage")], companies: [companyRow()] } });
    let res = await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: true } });
    expect([res.status, await res.json()]).toEqual([403, { error: "Changing automated campaigns needs the Automations area." }]);
    let calls = routes([ruleOf("reengage", { enabled: false })], { marketing: { enabled: false } });
    res = await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: true } });
    expect([res.status, await res.json()]).toEqual([409, { error: "Marketing is off, so automated campaigns can't be sent. An owner or admin can install it again in Apps." }]);
    expect(writes(calls, "PATCH", "automation_rules")).toEqual([]);
    // Close pending quotes isn't marketing, so it turns on while Marketing is off.
    routes([ruleOf("close_quotes", { enabled: false })], { marketing: { enabled: false } });
    expect((await call("/campaigns/automated/close_quotes", { method: "PUT", body: { enabled: true } })).status).toBe(200);
    emailReady.mockImplementation(async () => false);
    calls = routes([ruleOf("reengage", { enabled: false })]);
    res = await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: true } });
    expect([res.status, await res.json()]).toEqual([400, { error: "Connect your email first, so campaign emails can go out. An admin can connect it in Settings → Email." }]);
    calls = routes([ruleOf("reengage")]);
    res = await call("/campaigns/automated/reengage", { method: "PUT", body: { days: 20 } });
    expect([res.status, await res.json()]).toEqual([400, { error: "Pick from 30 to 730 days." }]);
    expect(writes(calls, "PATCH", "automation_rules")).toEqual([]);
    expect((await call("/campaigns/automated/newsletter", { method: "PUT", body: { enabled: false } })).status).toBe(404);
  });

  it("sends a test with made-up values, [Test] in the subject and nothing tracked", async () => {
    routes([], {}, { profiles: [{ user_id: USER, email: "mia@acme.example", full_name: "Mia Owner" }], companies: [companyRow()] });
    const res = await call("/campaigns/automated/win_back/test", {
      method: "POST", body: { subject: "Still thinking about {{title}}?", body: "Hi {{client.first_name}}, quote #{{number}} for {{total}}: {{link}}", days: 30 },
    });
    expect([res.status, await res.json()]).toEqual([200, { sent: true, to: "mia@acme.example" }]);
    const [message] = sent();
    expect(message!.subject).toBe("[Test] Still thinking about Spring cleanup?");
    expect(message!.text).toContain("Hi Mia, quote #1042 for $1,250.00: https://ops.example.com");
    expect(message!.html).toContain("/u/test");
    expect(message!.html).not.toContain("/api/public/");
    // {{link}} on a line of its own is the button the real email has.
    sendEmail.mockClear();
    routes([], {}, { profiles: [{ user_id: USER, email: "mia@acme.example", full_name: "Mia Owner" }], companies: [companyRow()] });
    await call("/campaigns/automated/win_back/test", { method: "POST", body: { subject: "Hello", body: "Ask for a fresh quote online:\n\n{{link}}\n\nThanks" } });
    expect(sent()[0]!.html).toContain(">Request work</a>");
    sendEmail.mockClear();
    routes([], {}, { profiles: [{ user_id: USER, email: "mia@acme.example", full_name: "Mia Owner" }], companies: [companyRow()] });
    await call("/campaigns/automated/close_quotes/test", { method: "POST", body: { subject: "Hello", body: "Review it here:\n\n{{link}}\n\nThanks" } });
    expect(sent()[0]!.html).toContain(">View online</a>");
    sendEmail.mockClear();
    routes([], {}, { profiles: [{ user_id: USER, email: "mia@acme.example", full_name: "Mia Owner" }] });
    await call("/campaigns/automated/close_quotes/test", { method: "POST", body: { subject: "Following up", body: "Hi {{client.first_name}}" } });
    expect(sent()[0]!.html).not.toContain("Unsubscribe");
    // Re-engage is about a client, so its {{title}} is their name, as the engine fills it in.
    sendEmail.mockClear();
    routes([], {}, { profiles: [{ user_id: USER, email: "mia@acme.example", full_name: "Mia Owner" }] });
    await call("/campaigns/automated/reengage/test", { method: "POST", body: { subject: "Hello {{title}}", body: "It's been a while, {{title}}." } });
    expect(sent()[0]!.subject).toBe("[Test] Hello Mia Owner");
  });

  it("leaves an automated campaign's row out of Send and Stop", async () => {
    const id = "00000000-0000-4000-8000-0000000000d1";
    serve({ tables: { memberships: [office], companies: [companyRow()], campaigns: [{ id, company_id: CO, kind: "automated", status: "automated", name: "Re-engage past clients", subject: "", body: "", audience: {} }] } });
    const res = await call(`/campaigns/${id}/send`, { method: "POST", body: {} });
    expect([res.status, await res.json()]).toEqual([409, { error: "This campaign sends by itself. Change it in Marketing → Campaigns." }]);
  });
});
