/**
 * Background tasks against a stand-in for PostgREST and the forecast: fetch is stubbed, and each
 * test answers the requests it expects. (What the database functions do is tested in supabase/tests.)
 */
import { addDays } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { cronMatches } from "../src/lib/cron";
import { CRON_TASKS, runTask, TASKS } from "../src/tasks";

// Autopay's own work is tested in autopay.test.ts and the Stripe tests; here, only that the tasks call it.
const autopay = vi.hoisted(() => ({ reconcile: vi.fn(async () => 0), charge: vi.fn(), job: vi.fn() }));
vi.mock("../src/integrations/stripe", async (original) => ({
  ...(await original<typeof import("../src/integrations/stripe")>()),
  reconcileAutopayProcessing: autopay.reconcile,
}));
vi.mock("../src/services/autopay", async (original) => ({
  ...(await original<typeof import("../src/services/autopay")>()),
  chargeDueAutopay: autopay.charge,
  runAutopayJob: autopay.job,
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
};

interface Call {
  method: string;
  url: URL;
  /** The table or rpc/<name> for PostgREST calls. */
  path: string;
  body: any;
}

/** Stub fetch: `answer` returns a Response, or rows to send back as JSON. */
function serve(answer: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("weather holds", () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = addDays(today, 1);
  const days = [0, 1, 2, 3].map((i) => addDays(today, i));
  // Tomorrow is cold and wet.
  const forecast = { daily: { time: days, temperature_2m_min: [55, 35, 55, 55], temperature_2m_max: [70, 50, 70, 70], precipitation_probability_max: [10, 90, 10, 10] } };
  // What the Lawn & Exterior preset saves in settings.weather_rules at signup.
  const company = { weather_rules: [{ applies_to: "Weekly mow", max_rain_pct: 70 }, { applies_to: "House power wash", min_temp_f: 40 }] };
  const visit = (id: string, job: unknown) => ({ id, scheduled_on: tomorrow, hold_reason: null, job, company, property: { lat: 37.13, lng: -80.41 } });

  it("uses the company's rules for the services on a job that has none of its own", async () => {
    const visits = [
      visit("mow", { weather_rules: [], lines: [{ name: "Mowing, front and back", service: { name: "Weekly mow" } }] }),
      visit("wash", { weather_rules: [], lines: [{ name: "House power wash", service: null }] }),
      visit("gutters", { weather_rules: [], lines: [{ name: "Gutter cleaning", service: null }] }),
      // The job's own rules come first: it's fine with rain up to 95%.
      visit("own", { weather_rules: [{ max_rain_pct: 95 }], lines: [{ name: "Weekly mow", service: null }] }),
      visit("task", null),
    ];
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? forecast : call.method === "GET" && call.path === "visits" ? visits : []));
    expect(await runTask("weather", env)).toEqual({ checked: 5, flagged: 2, unknown: 0 });
    const holds = calls.filter((c) => c.method === "PATCH" && c.path === "visits").map((c) => ({ id: c.url.searchParams.get("id"), hold: c.body.hold_reason }));
    expect(holds).toEqual([
      { id: "eq.mow", hold: "Weekly mow: 90% chance of rain" },
      { id: "eq.wash", hold: "House power wash: low of 35°F is below 40°F" },
    ]);
  });

  it("reads every visit a page at a time, in a fixed order", async () => {
    const page = (start: number, n: number) => Array.from({ length: n }, (_, i) => visit(`v${start + i}`, { weather_rules: [], lines: [] }));
    const calls = serve((call) => {
      if (call.method !== "GET" || call.path !== "visits") return [];
      return Number(call.url.searchParams.get("offset")) === 0 ? page(0, 1000) : page(1000, 1);
    });
    expect(await runTask("weather", env)).toMatchObject({ checked: 1001 });
    const reads = calls.filter((c) => c.path === "visits").map((c) => [c.url.searchParams.get("order"), c.url.searchParams.get("offset"), c.url.searchParams.get("limit")]);
    expect(reads).toEqual([
      ["id.asc", "0", "1000"],
      ["id.asc", "1000", "1000"],
    ]);
  });
});

describe("hourly upkeep", () => {
  it("runs every step even when one fails, and reports the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => {
      if (call.path === "rpc/mark_overdue_invoices") return Response.json({ code: "22023", message: 'time zone "Not/AZone" not recognized', details: null, hint: null }, { status: 400 });
      if (call.path === "rpc/emit_visit_reminders") return 2;
      if (call.path === "rpc/emit_equipment_alerts") return 1;
      if (call.path === "rpc/expire_sub_offers") return 3;
      // Two certificates running out; the subs have no email or phone to remind.
      if (call.path === "rpc/emit_sub_document_alerts") return [{ remind_sub: false }, { remind_sub: false }];
      if (call.path === "rpc/emit_card_expiry_alerts") return 5;
      if (call.path === "rpc/clock_upkeep") return { reminded: 1, stopped: 0 };
      if (call.path === "rpc/tidy_sign_in_codes") return 4;
      throw new Error(`unexpected ${call.path}`);
    });
    autopay.reconcile.mockResolvedValueOnce(2);
    expect(await runTask("followups", env)).toEqual({
      overdue: 0,
      reminders: 2,
      equipment: 1,
      offers: 3,
      subs: { alerts: 2, reminded: { subs: 0, email: 0, sms: 0, failed: 0 } },
      cards: 5,
      autopay_processing: 2,
      clocks: { reminded: 1, stopped: 0 },
      codes: 4,
      problems: ['mark_overdue_invoices: time zone "Not/AZone" not recognized'],
    });
    // Cards expiring next month are flagged before the clocks.
    expect(calls.map((c) => c.path)).toEqual([
      "rpc/mark_overdue_invoices", "rpc/emit_visit_reminders", "rpc/emit_equipment_alerts", "rpc/expire_sub_offers", "rpc/emit_sub_document_alerts",
      "rpc/emit_card_expiry_alerts", "rpc/clock_upkeep", "rpc/tidy_sign_in_codes",
    ]);
    expect(autopay.reconcile).toHaveBeenCalledWith(env, expect.anything());
    expect(error).toHaveBeenCalled();
  });

  it("reads autopay's bank payments back from Stripe, and keeps going when Stripe can't be asked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => (call.path === "rpc/emit_sub_document_alerts" ? [] : call.path === "rpc/clock_upkeep" ? { reminded: 0, stopped: 0 } : call.path.startsWith("rpc/") ? 0 : []));
    autopay.reconcile.mockRejectedValueOnce(new Error("Stripe didn't answer"));
    const out = (await runTask("followups", env)) as { cards: number; autopay_processing: number; problems: string[] };
    expect(out).toMatchObject({ cards: 0, autopay_processing: 0, problems: ["reconcile_autopay_processing: Stripe didn't answer"] });
    expect(calls.slice(-2).map((c) => c.path)).toEqual(["rpc/clock_upkeep", "rpc/tidy_sign_in_codes"]);
  });

  it("only promises subs a link the server can send, and keeps going when reminding them fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const alert = { company_id: "co-1", subcontractor_id: "sub-1", document_id: "doc-1", kind: "liability", expires_on: "2026-11-24", days_left: 30, alert: "d30", remind_sub: true };
    const calls = serve((call) => {
      if (call.path === "rpc/emit_sub_document_alerts") return [alert];
      if (call.path === "subcontractors") return Response.json({ code: "57014", message: "canceling statement due to statement timeout", details: null, hint: null }, { status: 500 });
      if (call.path === "companies") return [];
      if (call.path === "rpc/clock_upkeep") return { reminded: 0, stopped: 0 };
      if (call.path.startsWith("rpc/")) return 0;
      throw new Error(`unexpected ${call.path}`);
    });
    const texting = { ...env, APP_URL: "https://ops.example.com", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15405550000" };
    const out = (await runTask("followups", texting)) as { subs: unknown; problems: string[] };
    expect(calls.find((c) => c.path === "rpc/emit_sub_document_alerts")?.body).toEqual({ p_can_text: true, p_can_email: false });
    expect(out.subs).toEqual({ alerts: 1, reminded: null });
    expect(out.problems).toEqual([expect.stringMatching(/^remind_subs: canceling statement/)]);
    expect(calls.slice(-2).map((c) => c.path)).toEqual(["rpc/clock_upkeep", "rpc/tidy_sign_in_codes"]);
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("clock_upkeep"), expect.anything());

    // Without the app's address there's no link to send, so nothing is promised.
    const quiet = serve((call) => (call.path === "rpc/emit_sub_document_alerts" ? [] : call.path === "rpc/clock_upkeep" ? { reminded: 0, stopped: 0 } : 0));
    await runTask("followups", { ...texting, APP_URL: undefined });
    expect(quiet.find((c) => c.path === "rpc/emit_sub_document_alerts")?.body).toEqual({ p_can_text: false, p_can_email: false });
  });
});

describe("the Trash", () => {
  it("is emptied every night, after the plans sweep, of what's been there 30 days", async () => {
    expect(CRON_TASKS["35 4 * * *"]).toEqual(["trash"]);
    expect(CRON_TASKS["20 4 * * *"]).toEqual(["plans"]);
    const calls = serve(() => []);
    expect(await runTask("trash", env)).toEqual({ files: 0, folders: 0, other: 0, kept: 0 });
    // The database decides what's due (plan files, then Drive's folders, then files from the rest of
    // Crewtavo); nothing is removed when nothing is.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST rpc/trash_purge"]);
    expect(calls[0]!.body).toEqual({ p_cutoff: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), p_limit: 1000 });
  });
});

describe("review reminders", () => {
  it("are sent every five minutes, at 1:30pm in each company's time zone (services/reviews.ts)", async () => {
    expect(TASKS).toContain("reviews");
    expect(CRON_TASKS["*/5 * * * *"]).toContain("reviews");
    const calls = serve(() => []);
    expect(await runTask("reviews", { ...env, APP_URL: "https://ops.example.com" })).toEqual({ claimed: 0, sent: 0, failed: 0, stopped: 0, waiting: 0, lost: 0, errors: 0 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST rpc/claim_review_reminders"]);
  });
});

describe("Google reviews", () => {
  it("come in every 30 minutes for each company that's due (services/googleReviews.ts), with a tally", async () => {
    expect(TASKS).toContain("review_sync");
    expect(CRON_TASKS["12,42 * * * *"]).toEqual(["review_sync"]);
    expect([12, 42].every((m) => cronMatches("12,42 * * * *", new Date(Date.UTC(2026, 9, 27, 14, m, 0, 250))))).toBe(true);
    expect([0, 11, 30, 43].some((m) => cronMatches("12,42 * * * *", new Date(Date.UTC(2026, 9, 27, 14, m))))).toBe(false);
    const calls = serve((call) => {
      if (call.path === "rpc/review_syncs_due") return ["co-1", "co-2"];
      // co-1 is being synced by another worker; co-2 has Marketing uninstalled since.
      if (call.path === "rpc/claim_review_sync") return call.body.p_company === "co-1" ? null : "claim-2";
      if (call.path === "companies") return [{ settings: { marketing: { enabled: false } } }];
      return [];
    });
    expect(await runTask("review_sync", env)).toEqual({ due: 2, synced: 0, waiting: 2, problems: 0, errors: 0 });
    expect(calls.find((c) => c.path === "rpc/review_syncs_due")!.body).toEqual({ p_limit: 25 });
    expect(calls.some((c) => c.url.host !== "example.supabase.co")).toBe(false);
  });
});

describe("social posts", () => {
  it("go every minute, one claim at a time (services/social.ts), with a tally", async () => {
    expect(TASKS).toContain("social");
    expect(CRON_TASKS["* * * * *"]).toContain("social");
    const calls = serve(() => []);
    expect(await runTask("social", env)).toEqual({ claimed: 0, errors: 0 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST rpc/claim_social_posts"]);
    expect(calls[0]!.body).toEqual({ p_limit: 1, p_hold_seconds: 300 });
  });
});

describe("clients who haven't had a visit in a while", () => {
  it("are queued hourly, for each company that can email them, at most 100 a day for each rule (services/automatedCampaigns.ts)", async () => {
    expect(TASKS).toContain("inactive");
    expect(CRON_TASKS["5 * * * *"]).toEqual(["inactive"]);
    // The scheduler's minute check runs it at five past each hour, and only then.
    expect(cronMatches("5 * * * *", new Date("2026-10-27T14:05:30Z"))).toBe(true);
    expect([0, 4, 6, 35].some((m) => cronMatches("5 * * * *", new Date(Date.UTC(2026, 9, 27, 14, m))))).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T14:05:00Z") });
    try {
      const calls = serve((call) => {
        if (call.method === "GET" && call.path === "automation_rules") return [{ company_id: "co-1" }, { company_id: "co-1" }, { company_id: "co-2" }];
        if (call.path === "rpc/emit_inactive_clients") return call.body.p_company === "co-1" ? 3 : 1;
        return [];
      });
      const sending = { ...env, APP_URL: "https://ops.example.com", RESEND_API_KEY: "re_test", EMAIL_FROM: "Crewtavo <noreply@example.com>" };
      expect(await runTask("inactive", sending)).toEqual({ companies: 2, queued: 4, waiting: 0 });
      const rules = calls.find((c) => c.path === "automation_rules")!;
      expect([rules.url.searchParams.get("trigger"), rules.url.searchParams.get("enabled"), rules.url.searchParams.get("company.settings->marketing->>enabled")]).toEqual(["eq.client.inactive", "eq.true", "eq.true"]);
      expect(calls.filter((c) => c.path.startsWith("rpc/")).map((c) => [c.path, c.body])).toEqual([
        ["rpc/emit_inactive_clients", { p_now: "2026-10-27T14:05:00.000Z", p_cap: 100, p_company: "co-1" }],
        ["rpc/emit_inactive_clients", { p_now: "2026-10-27T14:05:00.000Z", p_cap: 100, p_company: "co-2" }],
      ]);

      // Without a way to send them, they wait: the runs would only fail and use up each client's turn.
      const quiet = serve((call) => (call.method === "GET" && call.path === "automation_rules" ? [{ company_id: "co-1" }] : []));
      expect(await runTask("inactive", { ...sending, APP_URL: undefined })).toEqual({ companies: 1, queued: 0, waiting: 1 });
      expect(quiet.some((c) => c.path === "rpc/emit_inactive_clients")).toBe(false);
      // Nor while the company has no mailbox and the server sends no email of its own.
      const unconnected = serve((call) => (call.method === "GET" && call.path === "automation_rules" ? [{ company_id: "co-1" }] : []));
      expect(await runTask("inactive", { ...env, APP_URL: "https://ops.example.com" })).toEqual({ companies: 1, queued: 0, waiting: 1 });
      expect(unconnected.some((c) => c.path === "rpc/emit_inactive_clients")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the nightly tidy-up", () => {
  it("also removes guide covers and quote and visit photos nobody recorded", async () => {
    const calls = serve((call) => (call.path === "companies" ? [] : call.path === "rpc/unrecorded_files" ? [{ company_id: "co-1", paths: ["co-1/kb/stray.jpg"] }] : []));
    expect(await runTask("plans", env)).toEqual({ unrecorded: 0, subs: { unrecorded: 0 }, applicants: { unrecorded: 0 }, photos: { unrecorded: 1, kept: 0 }, social: 0, meta: { checked: 0, signin: 0, expiring: 0 } });
    expect(calls.find((c) => c.path === "rpc/unrecorded_files")?.body).toEqual({ p_limit: 1000 });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.body)).toEqual([{ prefixes: ["co-1/kb/stray.jpg"] }]);
  });
});

describe("autopay", () => {
  it("charges what's due every 5 minutes, alongside the outbox that sends its receipts", async () => {
    expect(CRON_TASKS["*/5 * * * *"]).toEqual(["outbox", "reviews", "autopay"]);
    const result = { claimed: 2, charged: 1, processing: 0, needs_approval: 0, called_off: 0, failed: 1, needs_client: 0, busy: 0, retry: 0, lost: 0 };
    autopay.charge.mockResolvedValueOnce(result);
    expect(await runTask("autopay", env)).toEqual(result);
    expect(autopay.charge).toHaveBeenCalledWith(env);
  });

  it("hands the outbox's autopay jobs to the autopay service, and a job that keeps failing shows on Stripe's app", async () => {
    const rows = [
      { id: 1, company_id: "co-1", topic: "autopay.receipt", payload: { charge_id: "ch-1" }, attempts: 1 },
      { id: 2, company_id: "co-1", topic: "autopay.notice", payload: { charge_id: "ch-2", status: "failed", failures: 1 }, attempts: 8 },
      { id: 3, company_id: "co-1", topic: "autopay.agreed", payload: { authorization_id: "au-1" }, attempts: 1 },
    ];
    autopay.job.mockImplementation(async (_env: Env, _admin: unknown, row: { topic: string }) => {
      if (row.topic === "autopay.notice") throw new Error("Resend is having trouble right now. Try again in a few minutes.");
    });
    const calls = serve((call) => (call.path === "rpc/claim_outbox" ? rows : []));
    expect(await runTask("outbox", env)).toEqual({ claimed: 3, done: 2, failed: 1 });
    expect(autopay.job.mock.calls.map((c) => c[2])).toEqual(rows.map(({ company_id, topic, payload }) => ({ company_id, topic, payload })));
    const outbox = calls.filter((c) => c.method === "PATCH" && c.path === "outbox");
    expect(outbox.map((c) => [c.url.searchParams.get("id"), Boolean(c.body.done_at), Boolean(c.body.dead_at)])).toEqual([
      ["eq.1", true, false],
      ["eq.2", false, true],
      ["eq.3", true, false],
    ]);
    const marked = calls.find((c) => c.method === "PATCH" && c.path === "integrations")!;
    expect(marked.url.searchParams.get("provider")).toBe("in.(stripe)");
    expect(marked.body).toEqual({ last_error: "Resend is having trouble right now. Try again in a few minutes." });
    // Nothing went to Stripe's invoice sync or the books.
    expect(calls.some((c) => c.url.host === "api.stripe.com")).toBe(false);
  });
});
