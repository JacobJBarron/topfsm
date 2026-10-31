/**
 * Review asks and their reminders (services/reviews.ts), Jobber's way: what an automatic ask skips
 * (Marketing off, opt-outs, 6 months before quiet hours, archived), quiet hours from 9pm to 9am in
 * the company's time zone, asks by text and email, texting that isn't set up, the reminder task, the
 * automation engine waiting for 9am and skipping, the routes for Marketing → Reviews and installing
 * Marketing, and texts to a client who texted STOP from the message center, quotes and invoices. PostgREST is a stand-in
 * answering over fetch, sending is mocked, and the clock is the test's. What the database itself does
 * (the 6-month window, claims, the guards) is in supabase/tests/marketing_app_test.sql.
 */
import { ASK_CONDITIONS, REVIEW_GAP_DAYS } from "@crewtavo/core/marketing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  emailReady: vi.fn(async () => true),
  sendEmail: vi.fn(async () => ({ sent: true, id: "email-1" })),
  sendSms: vi.fn(async () => ({ sent: true, id: "sms-1" })),
}));

const notify = await import("../src/lib/notify");
const { sendReviewRequest, WaitUntil } = await import("../src/services/reviews");
const { executeRun, loadContext } = await import("../src/services/automations");
const { adminClient } = await import("../src/lib/supabase");
const { readClientLink, clientLink } = await import("../src/lib/links");
const { runTask } = await import("../src/tasks");
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
  // Texting is set up (sending is mocked); `noTexting` is a Crewtavo without it.
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "twilio-token",
  TWILIO_FROM_NUMBER: "+15405550000",
};
const noTexting: Env = { ...env, TWILIO_ACCOUNT_SID: undefined };
const NY = "America/New_York";
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
const companyRow = (settings: Row = {}): Row => ({
  id: CO, name: "Acme Lawn", phone: "555-0100", email: "office@acme.example", website: null, timezone: NY, currency: "USD", trade_preset: "lawn_care", address: {},
  settings: { review_url: "https://g.page/r/acme/review", marketing: { enabled: true }, ...settings },
});

/**
 * PostgREST over fetch: GETs answer from `tables`, filtered by eq. and in. on the row's own columns;
 * functions answer from `rpc` (true when not given); `answer` can step in first. Every call is kept.
 */
function serve(world: { tables?: Record<string, Row[]>; rpc?: Record<string, (body: any) => unknown>; answer?: (call: Call) => unknown } = {}) {
  const calls: Call[] = [];
  const tables = world.tables ?? {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const text = typeof init?.body === "string" ? init.body : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // a form
    }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path, params: url.searchParams, body };
    calls.push(call);
    const own = world.answer?.(call);
    if (own !== undefined) return own instanceof Response ? own : Response.json(own);
    if (path === "/auth/v1/user") return Response.json({ id: USER, aud: "authenticated", role: "authenticated" });
    if (path.startsWith("rpc/")) {
      const fn = world.rpc?.[path.slice(4)];
      return Response.json(fn ? (fn(body) ?? null) : true);
    }
    if (call.method === "GET") {
      let rows = tables[path] ?? [];
      for (const [column, filter] of url.searchParams) {
        if (!rows.some((r) => column in r)) continue;
        if (filter.startsWith("eq.")) rows = rows.filter((r) => String(r[column]) === filter.slice(3));
        else if (filter.startsWith("in.(")) rows = rows.filter((r) => filter.slice(4, -1).split(",").includes(String(r[column])));
      }
      return Response.json(rows);
    }
    return Response.json([]);
  });
  return calls;
}

const rpcCalls = (calls: Call[], fn: string) => calls.filter((c) => c.path === `rpc/${fn}`).map((c) => c.body);
const writes = (calls: Call[], method: string, table: string) => calls.filter((c) => c.method === method && c.path === table);
const at = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") }); // 11am in New York
  sendEmail.mockClear().mockImplementation(async () => ({ sent: true, id: "email-1" }));
  sendSms.mockClear().mockImplementation(async () => ({ sent: true, id: "sms-1" }));
  emailReady.mockClear().mockImplementation(async () => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function ask(over: Partial<Parameters<typeof sendReviewRequest>[2]> = {}, on: Env = env) {
  return sendReviewRequest(on, adminClient(on), {
    companyId: CO, client: ANA as never, channel: "email", baseUrl: "https://ops.example.com", automatic: true, skipIfRecentDays: REVIEW_GAP_DAYS, createdBy: null, ...over,
  });
}
/** A company to ask for; `last` is when the client was last asked, as last_review_ask counts it. */
const asking = (settings: Row = {}, begin: string | null = "rr-1", last: string | null = null) =>
  serve({ tables: { companies: [companyRow(settings)] }, rpc: { begin_review_request: () => begin, last_review_ask: () => last } });

// ---------------------------------------------------------------------------------------------

describe("an automatic first ask", () => {
  it("skips everything while Marketing is off: nothing recorded or sent", async () => {
    const calls = asking({ marketing: { enabled: false } });
    expect(await ask()).toMatchObject({ sent: false, skipped: true, detail: "Marketing is off" });
    expect(rpcCalls(calls, "begin_review_request")).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("asks the database to hold to 6 months, and skips a client it says was asked", async () => {
    const calls = asking({}, null);
    expect(await ask()).toMatchObject({ sent: false, skipped: true, detail: "Already asked in the last 6 months" });
    expect(rpcCalls(calls, "last_review_ask")).toEqual([{ p_company: CO, p_client: ANA_ID }]);
    expect(rpcCalls(calls, "begin_review_request")).toEqual([{ p_company: CO, p_client: ANA_ID, p_channel: "email", p_gap_days: 182 }]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a client asked in the last 6 months before quiet hours, instead of waiting for 9am to skip them", async () => {
    at("2026-10-29T02:30:00Z");
    const calls = asking({}, "rr-1", "2026-10-29T02:15:00Z");
    expect(await ask({ channel: "sms", client: { ...ANA, email: null } as never })).toMatchObject({ skipped: true, detail: "Already asked in the last 6 months" });
    expect(rpcCalls(calls, "begin_review_request")).toEqual([]);
    // Asked over 6 months ago: on to quiet hours.
    asking({}, "rr-1", "2026-04-01T12:00:00Z");
    await expect(ask({ channel: "sms", client: { ...ANA, email: null } as never })).rejects.toBeInstanceOf(WaitUntil);
  });

  it.each([
    [{ review_opt_out: true }, "Ana Smith asked not to get review requests"],
    [{ marketing_opt_out: true }, "Ana Smith unsubscribed from marketing"],
    [{ status: "archived" }, "Ana Smith is archived"],
  ])("skips a client with %j", async (over, detail) => {
    const calls = asking();
    expect(await ask({ client: { ...ANA, ...over } as never })).toMatchObject({ sent: false, skipped: true, detail });
    expect(rpcCalls(calls, "begin_review_request")).toEqual([]);
  });

  it("doesn't text a client who texted STOP: a text ask is skipped, and both goes by email", async () => {
    asking();
    const stopped = { ...ANA, sms_opt_out_at: "2026-10-01T12:00:00Z" } as never;
    expect(await ask({ client: stopped, channel: "sms" })).toMatchObject({ skipped: true, detail: "Ana Smith texted STOP, so texts to them are off" });
    expect(sendSms).not.toHaveBeenCalled();
    const calls = asking();
    expect(await ask({ client: stopped, channel: "both" })).toMatchObject({ sent: true, detail: "Asked for a review by email" });
    expect(sendSms).not.toHaveBeenCalled();
    expect(rpcCalls(calls, "begin_review_request")[0]).toMatchObject({ p_channel: "email" });
  });

  it.each([
    ["8:59pm", "2026-10-29T00:59:00Z", "sms"],
    ["9:00pm", "2026-10-29T01:00:00Z", "email"],
    ["8:59am", "2026-10-29T12:59:00Z", "email"],
    ["9:00am", "2026-10-29T13:00:00Z", "sms"],
  ])("at %s a text ask goes by %s when the client has an email", async (_, now, by) => {
    at(now);
    asking();
    const result = await ask({ channel: "sms" });
    expect(sendSms).toHaveBeenCalledTimes(by === "sms" ? 1 : 0);
    expect(sendEmail).toHaveBeenCalledTimes(by === "email" ? 1 : 0);
    expect(result.detail).toBe(by === "sms" ? "Asked for a review by text" : "Asked for a review by email: it's quiet hours (9pm to 9am), so no text");
  });

  it.each([
    ["daylight time", "2026-10-29T02:30:00Z", "2026-10-29T13:00:00.000Z"],
    ["standard time", "2026-11-10T03:30:00Z", "2026-11-10T14:00:00.000Z"],
  ])("waits for 9am in %s when a text is the only way", async (_, now, nine) => {
    at(now);
    const calls = asking();
    const error = await ask({ channel: "sms", client: { ...ANA, email: null } as never }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitUntil);
    expect((error as InstanceType<typeof WaitUntil>).until.toISOString()).toBe(nine);
    expect((error as Error).message).toBe("Quiet hours: waits until 9am to text, since Ana Smith has no email");
    expect(rpcCalls(calls, "begin_review_request")).toEqual([]);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("waits for 9am overnight when email isn't connected, and by day sends both as a text", async () => {
    emailReady.mockImplementation(async () => false);
    at("2026-10-29T02:30:00Z");
    asking();
    const error = await ask({ channel: "sms" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitUntil);
    expect((error as Error).message).toBe("Quiet hours: waits until 9am to text, since email isn't connected");
    at("2026-10-29T15:00:00Z");
    asking();
    expect(await ask({ channel: "both" })).toMatchObject({ sent: true, detail: "Asked for a review by text" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("goes by email when texting isn't set up, and fails a text ask with why, for the business to fix", async () => {
    asking();
    expect(await ask({ channel: "both" }, noTexting)).toMatchObject({ sent: true, detail: "Asked for a review by email" });
    asking();
    await expect(ask({ channel: "sms" }, noTexting)).rejects.toThrow("Texting isn't set up on this Crewtavo, so review asks can't go by text.");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("fails an ask by both for a client who texted STOP when email isn't connected, saying email is why", async () => {
    emailReady.mockImplementation(async () => false);
    asking();
    await expect(ask({ channel: "both", client: { ...ANA, sms_opt_out_at: "2026-10-01T12:00:00Z" } as never })).rejects.toThrow(/^Email isn't connected yet/);
  });
});

describe("an ask by hand", () => {
  it("refuses while Marketing is off", async () => {
    asking({ marketing: { enabled: false } });
    await expect(ask({ automatic: false, skipIfRecentDays: undefined })).rejects.toThrow("Marketing is off, so review requests can't be sent. An owner or admin can install it again in Apps.");
  });

  it("isn't held to 6 months", async () => {
    const calls = asking({}, "rr-1", "2026-10-27T14:00:00Z");
    expect(await ask({ automatic: false, skipIfRecentDays: undefined, createdBy: USER })).toMatchObject({ sent: true });
    expect(rpcCalls(calls, "last_review_ask")).toEqual([]);
    expect(rpcCalls(calls, "begin_review_request")).toEqual([{ p_company: CO, p_client: ANA_ID, p_channel: "email", p_created_by: USER }]);
  });

  it.each([
    [{ review_opt_out: true }, "email", "Ana Smith asked not to get review requests. You can change that on their page."],
    [{ marketing_opt_out: true }, "email", "Ana Smith unsubscribed from marketing, so they aren't asked for reviews."],
    [{ sms_opt_out_at: "2026-10-01T12:00:00Z" }, "sms", "Ana Smith texted STOP, so texts to them are off. Ask by email instead."],
    [{ status: "archived" }, "email", "Ana Smith is archived. Restore them to ask for a review."],
    [{ marketing_opt_out: true }, "link", "Ana Smith unsubscribed from marketing, so they aren't asked for reviews."],
  ] as const)("refuses a client with %j", async (over, channel, message) => {
    asking();
    await expect(ask({ automatic: false, skipIfRecentDays: undefined, channel, client: { ...ANA, ...over } as never })).rejects.toThrow(message);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("texts right away at 10:30pm", async () => {
    at("2026-10-29T02:30:00Z");
    asking();
    expect(await ask({ automatic: false, skipIfRecentDays: undefined, channel: "sms" })).toMatchObject({ sent: true, detail: "Asked for a review by text" });
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("refuses a text when texting isn't set up, before anything is recorded", async () => {
    const calls = asking();
    await expect(ask({ automatic: false, skipIfRecentDays: undefined, channel: "sms" }, noTexting)).rejects.toThrow("Texting isn't set up on this Crewtavo, so review asks can't go by text.");
    expect(rpcCalls(calls, "begin_review_request")).toEqual([]);
  });
});

describe("an ask by text and email", () => {
  it("sends both, records both in the client's messages, and the ask as both", async () => {
    const calls = asking();
    expect(await ask({ channel: "both" })).toMatchObject({ sent: true, id: "rr-1", detail: "Asked for a review by text and email" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(writes(calls, "POST", "messages").map((c) => [c.body.channel, c.body.subject, c.body.related_type, c.body.related_id])).toEqual([
      ["email", "Review request", "review", "rr-1"],
      ["sms", null, "review", "rr-1"],
    ]);
    expect(rpcCalls(calls, "begin_review_request")[0]).toMatchObject({ p_channel: "both" });
    expect(writes(calls, "PATCH", "review_requests")[0]!.body).toMatchObject({ channel: "both", error: null });
  });

  it("records the channel that worked when the other didn't, with why", async () => {
    sendSms.mockImplementation(async () => ({ sent: false, reason: "The text provider refused it (400)." }));
    const calls = asking();
    expect(await ask({ channel: "both" })).toMatchObject({ sent: true, detail: "Asked for a review by email" });
    expect(writes(calls, "PATCH", "review_requests")[0]!.body).toMatchObject({ channel: "email", error: "The text provider refused it (400)." });
    expect(writes(calls, "POST", "messages")).toHaveLength(1);
  });

  it("marks the ask failed when nothing went", async () => {
    sendEmail.mockImplementation(async () => ({ sent: false, reason: "Email isn't set up." }));
    const calls = asking();
    await expect(ask()).rejects.toThrow("Email isn't set up.");
    expect(writes(calls, "PATCH", "review_requests")[0]!.body).toEqual({ status: "failed", error: "Email isn't set up." });
  });

  it("learns that a client texted STOP when Twilio says so", async () => {
    sendSms.mockImplementation(async () => ({ sent: false, reason: "The text provider refused it (400: Attempt to send to unsubscribed recipient).", code: 21610 }));
    const calls = asking();
    await ask({ channel: "both" });
    const marked = writes(calls, "PATCH", "clients")[0]!;
    expect(marked.params.get("id")).toBe(`eq.${ANA_ID}`);
    expect(marked.params.get("sms_opt_out_at")).toBe("is.null");
    expect(typeof marked.body.sms_opt_out_at).toBe("string");
  });

  it("carries one-click unsubscribe in the email", async () => {
    asking();
    await ask();
    const message = sendEmail.mock.calls[0]![1];
    expect(message.text).toMatch(/Unsubscribe: https:\/\/ops\.example\.com\/u\//);
    expect(message.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/ops\.example\.com\/api\/public\/unsubscribe\//);
    expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("the first reminder's time", () => {
  it("is 3 days after the ask at 1:30pm in the company's time zone", async () => {
    const calls = asking();
    await ask();
    expect(writes(calls, "PATCH", "review_requests")[0]!.body.next_reminder_at).toBe("2026-10-30T17:30:00.000Z");
  });

  it("is none when reminders are off, and for a link copied by hand", async () => {
    let calls = asking({ reviews: { reminders: [] } });
    await ask();
    expect(writes(calls, "PATCH", "review_requests")[0]!.body.next_reminder_at).toBeNull();
    calls = asking();
    expect(await ask({ automatic: false, channel: "link" })).toMatchObject({ sent: false, detail: "Link created", id: "rr-1" });
    expect(writes(calls, "PATCH", "review_requests")).toEqual([]);
  });

  it("stops the reminders of the client's older asks", async () => {
    const calls = asking();
    await ask();
    const older = writes(calls, "PATCH", "review_requests")[1]!;
    expect(older.body).toEqual({ next_reminder_at: null, reminder_note: "A newer ask replaced it" });
    expect([older.params.get("client_id"), older.params.get("id"), older.params.get("next_reminder_at")]).toEqual([`eq.${ANA_ID}`, "neq.rr-1", "not.is.null"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the automation engine", () => {
  const run = (over: Row = {}) => ({ id: 7, company_id: CO, rule_id: "rule-1", subject_type: "job", subject_id: "job-1", activity_id: null, result: [], claim_token: "claim-1", ...over });
  const rule = (over: Row = {}) => ({ id: "rule-1", company_id: CO, name: "Ask for a Google review after a job", trigger: "job.completed", enabled: true, conditions: [], actions: [{ type: "request_review", channel: "email" }], run_count: 4, ...over });
  const job = { id: "job-1", company_id: CO, number: 12, title: "Spring cleanup", status: "completed", kind: "one_off", financials: { contract_total: 400 }, client_id: ANA_ID, property_id: null, property: null, lines: [] };
  const engine = (over: { settings?: Row; rules?: Row[]; clients?: Row[]; tables?: Record<string, Row[]> } = {}) =>
    serve({
      tables: { companies: [companyRow(over.settings)], automation_rules: over.rules ?? [rule()], jobs: [job], clients: over.clients ?? [ANA], ...over.tables },
      rpc: { begin_review_request: () => "rr-1", last_review_ask: () => null },
    });
  const finished = (calls: Call[]) => rpcCalls(calls, "finish_automation_run");

  it("skips an ask while Marketing is off: the run is skipped, not done, and isn't counted", async () => {
    const calls = engine({ settings: { marketing: { enabled: false } } });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)).toEqual([{ p_id: 7, p_token: "claim-1", p_status: "skipped", p_result: [{ type: "request_review", ok: true, skipped: true, detail: "Marketing is off" }] }]);
    expect(writes(calls, "PATCH", "automation_rules")).toEqual([]);
  });

  it("puts a quiet-hours ask back until 9am with the actions before it, and does nothing after it", async () => {
    at("2026-10-29T02:30:00Z");
    const actions = [{ type: "add_note", body: "Asking for a review" }, { type: "request_review", channel: "sms" }, { type: "notify", roles: ["owner"], title: "Asked {{client.name}}" }];
    const calls = engine({ rules: [rule({ actions })], clients: [{ ...ANA, email: null }] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("waiting");
    expect(rpcCalls(calls, "postpone_automation_run")).toEqual([{
      p_id: 7, p_token: "claim-1", p_until: "2026-10-29T13:00:00.000Z", p_result: [{ type: "add_note", ok: true, detail: "Added a note" }],
      p_note: "Quiet hours: waits until 9am to text, since Ana Smith has no email",
    }]);
    expect(finished(calls)).toEqual([]);
    expect(writes(calls, "POST", "notifications")).toEqual([]);
    expect(writes(calls, "PATCH", "automation_rules")).toEqual([]);
    expect(sendSms).not.toHaveBeenCalled();

    // At 9am the run goes again: the note isn't added twice, and the ask is made, not skipped.
    at("2026-10-29T13:00:00Z");
    const again = engine({ rules: [rule({ actions })], clients: [{ ...ANA, email: null }], tables: { memberships: [{ user_id: USER, role: "owner", role_id: null }] } });
    const result = rpcCalls(calls, "postpone_automation_run")[0].p_result;
    expect(await executeRun(env, adminClient(env), run({ result }), env.APP_URL!)).toBe("done");
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(writes(again, "POST", "messages").map((c) => c.body.channel)).toEqual(["sms"]);
    expect(finished(again)[0].p_result.map((r: Row) => [r.type, r.ok, r.detail])).toEqual([
      ["add_note", true, "Added a note"],
      ["request_review", true, "Asked for a review by text"],
      ["notify", true, "Notified 1 person"],
    ]);
  });

  it("asks automatically at most once every 6 months", async () => {
    const calls = engine();
    await executeRun(env, adminClient(env), run(), env.APP_URL!);
    expect(rpcCalls(calls, "begin_review_request")[0]).toMatchObject({ p_gap_days: REVIEW_GAP_DAYS });
  });

  it("skips a client asked lately right away during quiet hours, rather than waiting until 9am", async () => {
    at("2026-10-29T02:30:00Z");
    const calls = serve({
      tables: { companies: [companyRow()], automation_rules: [rule({ actions: [{ type: "request_review", channel: "sms" }] })], jobs: [job], clients: [{ ...ANA, email: null }] },
      rpc: { last_review_ask: () => "2026-10-29T02:15:00Z" },
    });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(rpcCalls(calls, "postpone_automation_run")).toEqual([]);
    expect(finished(calls)[0].p_result).toEqual([{ type: "request_review", ok: true, skipped: true, detail: "Already asked in the last 6 months" }]);
  });

  it("doesn't text a client who texted STOP", async () => {
    const calls = engine({ rules: [rule({ trigger: "visit.en_route", actions: [{ type: "send_sms", body: "On our way" }] })], clients: [{ ...ANA, sms_opt_out_at: "2026-10-01T12:00:00Z" }] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_result).toEqual([{ type: "send_sms", ok: true, skipped: true, detail: "Ana Smith texted STOP, so texts to them are off" }]);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("knows the job a visit is on, so recurring work can be left out", async () => {
    const visit = { id: "visit-1", company_id: CO, title: "Mowing", kind: "job", status: "completed", scheduled_on: "2026-10-27", starts_at: null, job_id: "job-2", property_id: null, property: null, job: { client_id: ANA_ID, kind: "recurring" }, request: null };
    serve({ tables: { companies: [companyRow()], visits: [visit], clients: [ANA] } });
    expect((await loadContext(adminClient(env), CO, "visit", "visit-1"))?.facts).toMatchObject({ kind: "job", job_kind: "recurring" });
    serve({ tables: { companies: [companyRow()], jobs: [job], clients: [ANA] } });
    expect((await loadContext(adminClient(env), CO, "job", "job-1"))?.facts).toMatchObject({ kind: "one_off", job_kind: "one_off" });
  });

  it("leaves a recurring job marked complete to the recurring rule", async () => {
    const after = rule({ conditions: ASK_CONDITIONS["job.completed"] });
    const calls = engine({ rules: [after], tables: { jobs: [{ ...job, kind: "recurring" }] } });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_error).toMatch(/^Conditions not met/);
    expect(rpcCalls(calls, "begin_review_request")).toEqual([]);
    const oneOff = engine({ rules: [after] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(rpcCalls(oneOff, "begin_review_request")).toHaveLength(1);
  });

  it("doesn't ask when a deposit invoice is paid", async () => {
    const invoice = { id: "inv-1", company_id: CO, number: 88, subject: null, status: "paid", kind: "deposit", total: 500, balance_due: 0, client_id: ANA_ID, job_id: "job-1", job: { kind: "one_off" }, lines: [] };
    const calls = engine({ rules: [rule({ trigger: "invoice.paid", conditions: ASK_CONDITIONS["invoice.paid"] })], tables: { invoices: [invoice] } });
    expect(await executeRun(env, adminClient(env), run({ subject_type: "invoice", subject_id: "inv-1" }), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0].p_error).toBe("Conditions not met: invoice type is not Deposit.");
    expect(rpcCalls(calls, "begin_review_request")).toEqual([]);
    invoice.kind = "standard";
    const paid = engine({ rules: [rule({ trigger: "invoice.paid", conditions: ASK_CONDITIONS["invoice.paid"] })], tables: { invoices: [invoice] } });
    expect(await executeRun(env, adminClient(env), run({ subject_type: "invoice", subject_id: "inv-1" }), env.APP_URL!)).toBe("done");
    expect(rpcCalls(paid, "begin_review_request")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the reminder task", () => {
  const due = (over: Row = {}): Row => ({
    id: "rr-1", company_id: CO, client_id: ANA_ID, job_id: null, channel: "email", status: "sent", error: null, sent_at: "2026-10-27T15:00:00Z", clicked_at: null, created_by: null,
    reminders_sent: 0, next_reminder_at: "2026-10-30T17:30:00Z", last_reminder_at: null, reminder_note: null, reminder_claim: "claim-9", reminder_locked_until: null, ...over,
  });
  const remind = (rows: Row[], over: { settings?: Row; clients?: Row[]; start?: boolean; answer?: (call: Call) => unknown } = {}) =>
    serve({
      tables: { companies: [companyRow(over.settings)], clients: over.clients ?? [ANA] },
      rpc: { claim_review_reminders: () => rows, start_review_reminder: () => over.start ?? true },
      answer: over.answer,
    });
  const starts = (calls: Call[]) => rpcCalls(calls, "start_review_reminder");
  const finishes = (calls: Call[]) => rpcCalls(calls, "finish_review_reminder");
  const refused = (fn: string, id: string) => (call: Call) =>
    call.path === `rpc/${fn}` && call.body?.p_id === id ? Response.json({ message: "Connection reset", code: "08006" }, { status: 400 }) : undefined;

  it("sends a due reminder by the ask's channel, with the same tracked link, into the client's messages", async () => {
    at("2026-10-30T17:30:00Z");
    const calls = remind([due()]);
    expect(await runTask("reviews", env)).toEqual({ claimed: 1, sent: 1, failed: 0, stopped: 0, waiting: 0, lost: 0, errors: 0 });
    expect(rpcCalls(calls, "claim_review_reminders")).toEqual([{ p_limit: 50 }]);
    expect(sendSms).not.toHaveBeenCalled();
    const message = sendEmail.mock.calls[0]![1];
    expect(message.subject).toBe("A quick reminder from Acme Lawn");
    const token = /\/api\/public\/r\/(\S+)/.exec(message.text)![1]!;
    expect(await readClientLink(env, token)).toMatchObject({ c: CO, t: "review", id: "rr-1" });
    expect(message.text).toContain("just a friendly reminder from Acme Lawn");
    expect(message.text).toMatch(/Unsubscribe: https:\/\/ops\.example\.com\/u\//);
    expect(writes(calls, "POST", "messages").map((c) => [c.body.channel, c.body.subject, c.body.related_type, c.body.related_id])).toEqual([["email", "Review reminder", "review", "rr-1"]]);
    // Counted before it goes, with the second 5 days after the ask, at 1:30pm (standard time by then).
    expect(starts(calls)).toEqual([{ p_id: "rr-1", p_token: "claim-9", p_next: "2026-11-01T18:30:00.000Z" }]);
    expect(calls.findIndex((c) => c.path === "rpc/start_review_reminder")).toBeLessThan(calls.findIndex((c) => c.path === "messages"));
    expect(finishes(calls)).toEqual([{ p_id: "rr-1", p_token: "claim-9", p_outcome: "sent" }]);
  });

  it("has nothing after the second, and goes by both channels for an ask by both", async () => {
    at("2026-11-01T18:30:00Z");
    const calls = remind([due({ channel: "both", reminders_sent: 1 })], { settings: { reviews: { reminder_message: "Still have a minute? {{link}}" } } });
    await runTask("reviews", env);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendSms.mock.calls[0]![1].body).toMatch(/^Still have a minute\? https:\/\/ops\.example\.com\/api\/public\/r\//);
    expect(starts(calls)).toEqual([{ p_id: "rr-1", p_token: "claim-9" }]);
    expect(finishes(calls)).toEqual([{ p_id: "rr-1", p_token: "claim-9", p_outcome: "sent" }]);
  });

  it.each([
    ["the client opted out of reviews", { clients: [{ ...ANA, review_opt_out: true }] }, "They asked not to get review requests"],
    ["the client unsubscribed", { clients: [{ ...ANA, marketing_opt_out: true }] }, "They unsubscribed from marketing"],
    ["the client texted STOP (a text)", { clients: [{ ...ANA, sms_opt_out_at: "2026-10-28T00:00:00Z" }], channel: "sms" }, "They texted STOP"],
    ["the client is archived", { clients: [{ ...ANA, status: "archived" }] }, "The client was archived"],
    ["Marketing is off", { settings: { marketing: { enabled: false } } }, "Marketing was uninstalled"],
    ["the link was opened", { clicked_at: "2026-10-28T00:00:00Z" }, "They opened the link"],
    ["reminders were turned off", { settings: { reviews: { reminders: [] } } }, "No more reminders are set"],
  ] as const)("stops for good when %s, without sending", async (_, over, why) => {
    at("2026-10-30T17:30:00Z");
    const { clients, settings, ...row } = over as Row;
    const calls = remind([due(row)], { clients, settings });
    expect(await runTask("reviews", env)).toMatchObject({ stopped: 1, sent: 0 });
    expect(finishes(calls)).toEqual([{ p_id: "rr-1", p_token: "claim-9", p_outcome: "stop", p_note: why }]);
    expect(starts(calls)).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("stops a text reminder when texting isn't set up, and sends one by both by email", async () => {
    at("2026-10-30T17:30:00Z");
    let calls = remind([due({ channel: "sms" })]);
    expect(await runTask("reviews", noTexting)).toMatchObject({ stopped: 1, sent: 0 });
    expect(finishes(calls)).toEqual([{ p_id: "rr-1", p_token: "claim-9", p_outcome: "stop", p_note: "Texting isn't set up" }]);
    calls = remind([due({ channel: "both" })]);
    expect(await runTask("reviews", noTexting)).toMatchObject({ sent: 1 });
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("waits for 1:30pm the next day when it comes due at 10pm", async () => {
    at("2026-10-31T02:00:00Z");
    const calls = remind([due()]);
    expect(await runTask("reviews", env)).toMatchObject({ waiting: 1 });
    expect(finishes(calls)).toEqual([{ p_id: "rr-1", p_token: "claim-9", p_outcome: "later", p_next: "2026-10-31T17:30:00.000Z" }]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("counts a reminder that failed, keeping the next one's time", async () => {
    at("2026-10-30T17:30:00Z");
    sendEmail.mockImplementation(async () => ({ sent: false, reason: "The mail server said no." }));
    const calls = remind([due()]);
    expect(await runTask("reviews", env)).toMatchObject({ failed: 1 });
    expect(starts(calls)).toEqual([{ p_id: "rr-1", p_token: "claim-9", p_next: "2026-11-01T18:30:00.000Z" }]);
    expect(finishes(calls)).toEqual([{ p_id: "rr-1", p_token: "claim-9", p_outcome: "failed", p_note: "The mail server said no." }]);
  });

  it("sends nothing when another worker has it now, or Uninstall or a newer ask stopped it since the claim", async () => {
    at("2026-10-30T17:30:00Z");
    const calls = remind([due()], { start: false });
    expect(await runTask("reviews", env)).toMatchObject({ lost: 1, sent: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(finishes(calls)).toEqual([]);
  });

  it("goes on with the rest when one that went can't be recorded, which was counted before it went", async () => {
    at("2026-10-30T17:30:00Z");
    const calls = remind([due(), due({ id: "rr-2", reminder_claim: "claim-9" })], { answer: refused("finish_review_reminder", "rr-1") });
    expect(await runTask("reviews", env)).toMatchObject({ claimed: 2, sent: 1, errors: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(starts(calls).map((c) => c.p_id)).toEqual(["rr-1", "rr-2"]);
    expect(finishes(calls).map((c) => [c.p_id, c.p_outcome])).toEqual([["rr-1", "sent"], ["rr-2", "sent"]]);
  });

  it("goes on with the rest when one can't be started, sending that one nothing", async () => {
    at("2026-10-30T17:30:00Z");
    const calls = remind([due(), due({ id: "rr-2" })], { answer: refused("start_review_reminder", "rr-1") });
    expect(await runTask("reviews", env)).toMatchObject({ claimed: 2, sent: 1, errors: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(finishes(calls).map((c) => c.p_id)).toEqual(["rr-2"]);
  });

  it("claims nothing without the app's address", async () => {
    const calls = remind([due()]);
    expect(await runTask("reviews", { ...env, APP_URL: undefined })).toMatchObject({ claimed: 0 });
    expect(rpcCalls(calls, "claim_review_reminders")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Marketing's routes", () => {
  // A session Supabase Auth vouches for: getClaims asks /auth/v1/user about HS256 tokens.
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: USER, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(`/api${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "X-Company-Id": CO, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }, env);

  const starter = (over: Row = {}): Row => ({
    id: "rule-job", company_id: CO, template_key: "review_after_job", name: "Ask for a Google review after a job", description: "Sends your review link a day after a job is completed.",
    trigger: "job.completed", enabled: false, delay_minutes: 1440, conditions: ASK_CONDITIONS["job.completed"], actions: [{ type: "request_review", channel: "email" }], ...over,
  });
  const recurring = (over: Row = {}): Row => ({
    id: "rule-recurring", company_id: CO, template_key: "review_recurring", name: "Ask for a Google review on recurring work",
    description: "Sends your review link a day after a recurring job reaches the visit you chose in Marketing, once for each job.",
    trigger: "job.recurring_third_visit", enabled: false, delay_minutes: 1440, conditions: [], actions: [{ type: "request_review", channel: "email" }], ...over,
  });
  const asks = { enabled: true, when: "invoice.paid", channel: "both", recurring: true, recurring_after_visits: 4, reminder_days: [2, 6] };
  const office = (rules: Row[], member: Row = { role: "owner", role_id: null, subcontractor_id: null }, roles: Row[] = [], more: Record<string, Row[]> = {}) =>
    serve({ tables: { memberships: [member], company_roles: roles, automation_rules: rules, companies: [companyRow({ review_message: "Ours" })], ...more } });
  const owner = { role: "owner", role_id: null, subcontractor_id: null };

  it("changes the starter rules into the shape for the choice, and saves the settings with the rest kept", async () => {
    const calls = office([starter(), recurring()]);
    const res = await call("/reviews/asks", { method: "PUT", body: asks });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kept: [] });
    const [job, work] = writes(calls, "PATCH", "automation_rules");
    expect(job!.params.get("id")).toBe("eq.rule-job");
    expect(job!.body).toEqual({
      trigger: "invoice.paid",
      conditions: ASK_CONDITIONS["invoice.paid"],
      actions: [{ type: "request_review", channel: "both" }],
      enabled: true,
      name: "Ask for a Google review when an invoice is paid",
      description: "Sends your review link a day after an invoice is paid in full, except deposits and recurring work.",
    });
    expect(work!.params.get("id")).toBe("eq.rule-recurring");
    expect(work!.body).toMatchObject({ trigger: "job.recurring_third_visit", conditions: [], actions: [{ type: "request_review", channel: "both" }], enabled: true });
    expect(work!.body).not.toHaveProperty("delay_minutes");
    const settings = writes(calls, "PATCH", "companies")[0]!.body.settings;
    expect(settings).toMatchObject({ review_url: "https://g.page/r/acme/review", review_message: "Ours", marketing: { enabled: true } });
    expect(settings.reviews).toEqual({ recurring_after_visits: 4, reminders: [{ days: 2 }, { days: 6 }] });
  });

  it("turns recurring work off on its own, and both off with the switch", async () => {
    let calls = office([starter(), recurring({ enabled: true })]);
    await call("/reviews/asks", { method: "PUT", body: { ...asks, recurring: false } });
    expect(writes(calls, "PATCH", "automation_rules").map((c) => c.body.enabled)).toEqual([true, false]);
    calls = office([starter({ enabled: true }), recurring({ enabled: true })]);
    await call("/reviews/asks", { method: "PUT", body: { ...asks, enabled: false } });
    expect(writes(calls, "PATCH", "automation_rules").map((c) => c.body.enabled)).toEqual([false, false]);
  });

  it("keeps the shape of a rule someone changed in Automations, and says so, but the switch still turns it on and off", async () => {
    const custom = (enabled: boolean) => starter({ name: "Reviews for VIPs", enabled, conditions: [{ field: "client.tags", op: "includes", value: ["VIP"] }] });
    let calls = office([custom(false), recurring()]);
    const res = await call("/reviews/asks", { method: "PUT", body: asks });
    expect(await res.json()).toEqual({ kept: [{ id: "rule-job", name: "Reviews for VIPs" }] });
    expect(writes(calls, "PATCH", "automation_rules").map((c) => [c.params.get("id"), c.body.enabled, Object.keys(c.body).length > 1])).toEqual([
      ["eq.rule-job", true, false],
      ["eq.rule-recurring", true, true],
    ]);
    // Asking turned off: nothing asks, that rule included.
    calls = office([custom(true), recurring({ enabled: true })]);
    await call("/reviews/asks", { method: "PUT", body: { ...asks, enabled: false } });
    expect(writes(calls, "PATCH", "automation_rules").map((c) => [c.params.get("id"), c.body])).toEqual([
      ["eq.rule-job", { enabled: false }],
      ["eq.rule-recurring", expect.objectContaining({ enabled: false })],
    ]);
    // Already as the switch says: left alone.
    calls = office([custom(true), recurring()]);
    await call("/reviews/asks", { method: "PUT", body: asks });
    expect(writes(calls, "PATCH", "automation_rules").map((c) => c.params.get("id"))).toEqual(["eq.rule-recurring"]);
  });

  it("moves the reminders still to come when the days change, and stops them when there are none", async () => {
    // Tuesday 11am in New York: one ask from yesterday with no reminder yet, one from last Thursday with one sent.
    const open = () => [
      { id: "rr-a", company_id: CO, status: "sent", sent_at: "2026-10-26T15:00:00Z", reminders_sent: 0, last_reminder_at: null, next_reminder_at: "2026-10-29T17:30:00Z", clicked_at: null },
      { id: "rr-b", company_id: CO, status: "sent", sent_at: "2026-10-22T15:00:00Z", reminders_sent: 1, last_reminder_at: "2026-10-25T17:30:00Z", next_reminder_at: "2026-10-27T17:30:00Z", clicked_at: null },
    ];
    const moved = (calls: Call[]) => writes(calls, "PATCH", "review_requests").map((c) => [c.params.get("id"), c.params.get("next_reminder_at"), c.body]);
    let calls = office([starter(), recurring()], owner, [], { review_requests: open() });
    expect((await call("/reviews/asks", { method: "PUT", body: { ...asks, reminder_days: [7] } })).status).toBe(200);
    const read = calls.find((c) => c.method === "GET" && c.path === "review_requests")!;
    expect(["company_id", "status", "clicked_at", "next_reminder_at"].map((k) => read.params.get(k))).toEqual([`eq.${CO}`, "eq.sent", "is.null", "not.is.null"]);
    expect(moved(calls)).toEqual([
      // A week after the ask, at 1:30pm (standard time by then).
      ["eq.rr-a", "not.is.null", { next_reminder_at: "2026-11-02T18:30:00.000Z" }],
      ["eq.rr-b", "not.is.null", { next_reminder_at: null, reminder_note: "No more reminders are set" }],
    ]);

    calls = office([starter(), recurring()], owner, [], { review_requests: open() });
    await call("/reviews/asks", { method: "PUT", body: { ...asks, reminder_days: [] } });
    expect(moved(calls).map(([id, , body]) => [id, body])).toEqual([
      ["eq.rr-a", { next_reminder_at: null, reminder_note: "Reminders were turned off" }],
      ["eq.rr-b", { next_reminder_at: null, reminder_note: "Reminders were turned off" }],
    ]);

    // The same days as before: nothing to move.
    calls = office([starter(), recurring()], owner, [], { review_requests: open() });
    await call("/reviews/asks", { method: "PUT", body: { ...asks, reminder_days: [3, 5] } });
    expect(calls.some((c) => c.path === "review_requests")).toBe(false);
  });

  it("puts a deleted rule back", async () => {
    const calls = office([starter()]);
    await call("/reviews/asks", { method: "PUT", body: asks });
    expect(writes(calls, "POST", "automation_rules")[0]!.body).toMatchObject({
      company_id: CO, template_key: "review_recurring", name: "Ask for a Google review on recurring work", trigger: "job.recurring_third_visit", delay_minutes: 1440, enabled: true,
    });
  });

  it("keeps a description and name someone wrote", async () => {
    const calls = office([starter({ name: "Our ask", description: "Our own words." }), recurring()]);
    await call("/reviews/asks", { method: "PUT", body: asks });
    const job = writes(calls, "PATCH", "automation_rules")[0]!.body;
    expect(job).not.toHaveProperty("description");
    expect(job).not.toHaveProperty("name");
  });

  it("needs the Automations area", async () => {
    const calls = office([starter(), recurring()], { role: "admin", role_id: "role-1", subcontractor_id: null }, [{ id: "role-1", permissions: ["marketing"] }]);
    const res = await call("/reviews/asks", { method: "PUT", body: asks });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Changing when reviews are asked needs the Automations area." });
    expect(calls.some((c) => c.method !== "GET" && !c.path.startsWith("/auth"))).toBe(false);
  });

  it.each([
    { recurring_after_visits: 0 },
    { recurring_after_visits: 21 },
    { reminder_days: [5, 3] },
    { reminder_days: [4, 4] },
    { reminder_days: [3, 5, 7] },
    { reminder_days: [0] },
  ])("refuses %j", async (over) => {
    const calls = office([starter(), recurring()]);
    expect((await call("/reviews/asks", { method: "PUT", body: { ...asks, ...over } })).status).toBe(400);
    expect(writes(calls, "PATCH", "automation_rules")).toEqual([]);
  });

  it("says why reminder days out of order are refused", async () => {
    office([starter(), recurring()]);
    const res = await call("/reviews/asks", { method: "PUT", body: { ...asks, reminder_days: [5, 3] } });
    expect(await res.json()).toEqual({ error: "The second reminder comes after the first." });
  });

  it("refuses an ask by hand by text, in plain words, when texting isn't set up", async () => {
    serve({ tables: { memberships: [{ role: "office", role_id: null, subcontractor_id: null }], clients: [ANA], companies: [companyRow()] } });
    const res = await app.request("/api/reviews/request", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Company-Id": CO, "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: ANA_ID, channel: "sms" }),
    }, noTexting);
    expect([res.status, await res.json()]).toEqual([400, { error: "Texting isn't set up on this Crewtavo, so review asks can't go by text." }]);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("installs and uninstalls Marketing through the database's switch", async () => {
    const calls = office([]);
    const res = await call("/marketing/enabled", { method: "POST", body: { enabled: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(rpcCalls(calls, "marketing_set_enabled")).toEqual([{ p_company: CO, p_enabled: false }]);
  });

  it("lists Marketing in Apps as installed while it's on", async () => {
    office([]);
    const apps = (await (await call("/apps")).json()) as { apps: Array<{ id: string; status: string; name: string; auth: string; category: string }> };
    expect(apps.apps.find((a) => a.id === "marketing")).toMatchObject({ name: "Crewtavo - Marketing", auth: "builtin", category: "Team", status: "connected" });
    serve({ tables: { memberships: [{ role: "owner", role_id: null, subcontractor_id: null }], companies: [companyRow({ marketing: { enabled: false } })] } });
    const off = (await (await call("/apps")).json()) as { apps: Array<{ id: string; status: string }> };
    expect(off.apps.find((a) => a.id === "marketing")?.status).toBe("disconnected");
  });

  it("refuses an ask by hand with a friendly message while Marketing is off", async () => {
    serve({ tables: { memberships: [{ role: "office", role_id: null, subcontractor_id: null }], clients: [ANA], companies: [companyRow({ marketing: { enabled: false } })] } });
    const res = await call("/reviews/request", { method: "POST", body: { client_id: ANA_ID, channel: "both" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Marketing is off, so review requests can't be sent. An owner or admin can install it again in Apps." });
  });

  it("doesn't text a client who texted STOP from the message center, and learns of a STOP from Twilio", async () => {
    const stopped = { ...ANA, sms_opt_out_at: "2026-10-01T12:00:00Z" };
    serve({ tables: { memberships: [{ role: "office", role_id: null, subcontractor_id: null }], clients: [stopped], companies: [companyRow()] } });
    const res = await call("/messages/send", { method: "POST", body: { client_id: ANA_ID, channel: "sms", body: "Running late" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Ana Smith texted STOP, so texts to them are off. Send it by email instead." });
    expect(sendSms).not.toHaveBeenCalled();

    sendSms.mockImplementation(async () => ({ sent: false, reason: "The text provider refused it (400).", code: 21610 }));
    const calls = serve({ tables: { memberships: [{ role: "office", role_id: null, subcontractor_id: null }], clients: [ANA], companies: [companyRow()] } });
    expect((await call("/messages/send", { method: "POST", body: { client_id: ANA_ID, channel: "sms", body: "Running late" } })).status).toBe(502);
    expect(writes(calls, "PATCH", "clients").map((c) => [c.params.get("id"), typeof c.body.sms_opt_out_at])).toEqual([[`eq.${ANA_ID}`, "string"]]);
  });

  it("texts another number for a client who texted STOP, and a refusal there doesn't turn their texts off", async () => {
    const stopped = { ...ANA, sms_opt_out_at: "2026-10-01T12:00:00Z" };
    const member = { role: "office", role_id: null, subcontractor_id: null };
    serve({ tables: { memberships: [member], clients: [stopped], companies: [companyRow()] } });
    const own = await call("/messages/send", { method: "POST", body: { client_id: ANA_ID, channel: "sms", to: "540.555.0100", body: "Running late" } });
    expect(own.status).toBe(400);
    expect(sendSms).not.toHaveBeenCalled();
    const spouse = await call("/messages/send", { method: "POST", body: { client_id: ANA_ID, channel: "sms", to: "(540) 555-0199", body: "Running late" } });
    expect(spouse.status).toBe(200);
    expect(sendSms).toHaveBeenCalledWith(env, { to: "(540) 555-0199", body: "Running late" });

    // A number that once texted STOP, typed in for a client who never did: Twilio refuses, and the client keeps texts on.
    sendSms.mockImplementation(async () => ({ sent: false, reason: "The text provider refused it (400).", code: 21610 }));
    const calls = serve({ tables: { memberships: [member], clients: [ANA], companies: [companyRow()] } });
    expect((await call("/messages/send", { method: "POST", body: { client_id: ANA_ID, channel: "sms", to: "(540) 555-0199", body: "Running late" } })).status).toBe(502);
    expect(writes(calls, "PATCH", "clients")).toEqual([]);
  });

  describe("quotes and invoices by text", () => {
    const QUOTE_ID = "00000000-0000-4000-8000-0000000000d1";
    const INVOICE_ID = "00000000-0000-4000-8000-0000000000d2";
    const onRecord = { display_name: ANA.display_name, email: ANA.email, phone: ANA.phone };
    const quoteRow = {
      id: QUOTE_ID, company_id: CO, number: 1042, status: "sent", total: 400, tax_rate: 0, discount_amount: 0, client_id: ANA_ID, range_low: null, range_high: null,
      priced_on_site_at: null, exact_sent_at: null, client: onRecord, promo: null, options: [],
      lines: [{ id: "line-1", option_id: null, quantity: 1, unit_price: 400, taxable: false, optional: false, selected: true }],
    };
    const invoiceRow = { id: INVOICE_ID, company_id: CO, number: 88, status: "sent", total: 400, balance_due: 400, client_id: ANA_ID, client: onRecord, lines: [{ id: "line-1" }] };
    const sales = (client: Row) =>
      serve({ tables: { memberships: [{ role: "office", role_id: null, subcontractor_id: null }], clients: [client], companies: [companyRow()], quotes: [quoteRow], invoices: [invoiceRow] } });
    const path = (kind: string) => `/${kind}/${kind === "quotes" ? QUOTE_ID : INVOICE_ID}/send`;

    it.each(["quotes", "invoices"])("aren't texted to a client who texted STOP (%s), but go to another number", async (kind) => {
      sales({ ...ANA, sms_opt_out_at: "2026-10-01T12:00:00Z" });
      const res = await call(path(kind), { method: "POST", body: { channel: "sms" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Ana Smith texted STOP, so texts to them are off. Send it by email instead." });
      expect(sendSms).not.toHaveBeenCalled();
      const other = await call(path(kind), { method: "POST", body: { channel: "sms", to: "(540) 555-0199" } });
      expect(await other.json()).toMatchObject({ sent: true });
      expect(sendSms.mock.calls[0]![1].to).toBe("(540) 555-0199");
    });

    it.each(["quotes", "invoices"])("learn that the client's own phone texted STOP when Twilio says so (%s), and only theirs", async (kind) => {
      sendSms.mockImplementation(async () => ({ sent: false, reason: "The text provider refused it (400).", code: 21610 }));
      let calls = sales(ANA);
      expect(await (await call(path(kind), { method: "POST", body: { channel: "sms" } })).json()).toMatchObject({ sent: false });
      const marked = writes(calls, "PATCH", "clients");
      expect(marked.map((c) => [c.params.get("id"), c.params.get("sms_opt_out_at"), typeof c.body.sms_opt_out_at])).toEqual([[`eq.${ANA_ID}`, "is.null", "string"]]);
      calls = sales(ANA);
      await call(path(kind), { method: "POST", body: { channel: "sms", to: "(540) 555-0199" } });
      expect(writes(calls, "PATCH", "clients")).toEqual([]);
    });
  });

  it("won't send or test a campaign while Marketing is off", async () => {
    for (const path of ["/campaigns/00000000-0000-4000-8000-0000000000f1/send", "/campaigns/00000000-0000-4000-8000-0000000000f1/test"]) {
      serve({ tables: { memberships: [{ role: "office", role_id: null, subcontractor_id: null }], companies: [companyRow({ marketing: { enabled: false } })] } });
      const res = await call(path, { method: "POST", body: {} });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Marketing is off, so campaigns can't be sent. An owner or admin can install it again in Apps." });
    }
  });

  it("keeps review links working while Marketing is off, and an opened link has no more reminders", async () => {
    const calls = serve({ tables: { companies: [companyRow({ marketing: { enabled: false } })] } });
    const link = await clientLink(env, "https://ops.example.com", { c: CO, t: "review", id: "rr-1" });
    const res = await app.request(link.replace("https://ops.example.com", ""), {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://g.page/r/acme/review");
    const click = writes(calls, "PATCH", "review_requests")[0]!;
    expect(click.body).toMatchObject({ status: "clicked", next_reminder_at: null });
    expect(click.params.get("clicked_at")).toBe("is.null");
  });
});
