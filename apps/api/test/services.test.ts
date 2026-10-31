/**
 * Background work and integrations against a stand-in for PostgREST and the providers: fetch is
 * stubbed, and each test answers the requests it expects. (What the database itself does, such as
 * claiming campaign recipients, is tested in supabase/tests.)
 */
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { DEFAULT_TEMPLATE } from "@crewtavo/core/documents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { encryptJson, signToken } from "../src/lib/crypto";
import { clientLink } from "../src/lib/links";
import { sendWithMailbox } from "../src/lib/notify";
import { adminClient } from "../src/lib/supabase";
import { zohoAccountsServer, zohoApiDomain } from "../src/integrations/registry";
import { processCampaigns } from "../src/services/campaigns";
import { sendReviewRequest } from "../src/services/reviews";
import { suggestPlaces } from "../src/services/external";
import { runTask } from "../src/tasks";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Crewtavo <noreply@example.com>",
};

interface Call {
  method: string;
  url: URL;
  /** The table or rpc/<name> for PostgREST calls. */
  path: string;
  body: any;
  signal?: AbortSignal | null;
}

/** Stub fetch: `answer` returns a Response, or rows to send back as JSON. */
function serve(answer: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies stay text
    }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body, signal: init?.signal };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}
const counted = (n: number) => new Response(null, { status: 200, headers: { "Content-Range": `*/${n}` } });
/** The settings plus the connection a request came in on, as server.ts hands them to the app. */
const connectedFrom = (remoteAddress: string, e: Env = env) => ({ ...e, incoming: { socket: { remoteAddress } } as unknown as IncomingMessage });

afterEach(() => vi.unstubAllGlobals());

describe("campaign sending", () => {
  const campaign = {
    id: "camp-1", company_id: "co-1", subject: "Fall cleanup", body: "Hi {{client.first_name}}, leaves are coming.",
    company: { name: "Acme Lawn Care, LLC", email: null, phone: null, address: {}, settings: { marketing: { enabled: true } } },
  };
  const recipients = [1, 2, 3].map((id) => ({
    id, campaign_id: "camp-1", company_id: "co-1", client_id: `client-${id}`, email: `person${id}@example.com`, name: `Person ${id}`, status: "sending", claim_token: "claim-1",
  }));

  /** One campaign with three claimed recipients; `onEmail` can change things as each email goes. */
  function run(options: { optedOut?: string[]; claimedSince?: number[]; onEmail?: (count: number, state: { status: string }) => Response | void } = {}) {
    const state = { status: "sending", emails: [] as string[], claims: 0 };
    const calls = serve((call) => {
      if (call.url.host === "api.resend.com") {
        state.emails.push(call.body.to[0]);
        return options.onEmail?.(state.emails.length, state) ?? Response.json({ id: `email-${state.emails.length}` });
      }
      if (call.path === "rpc/claim_campaign_recipients") return state.claims++ ? [] : recipients;
      if (call.path === "rpc/renew_campaign_recipient") return !(options.claimedSince ?? []).includes(call.body.p_id);
      if (call.method === "GET" && call.path === "campaigns") return call.url.searchParams.get("select") === "status" ? [{ status: state.status }] : [campaign];
      if (call.method === "GET" && call.path === "clients") return [{ marketing_opt_out: (options.optedOut ?? []).includes(call.url.searchParams.get("id")!.slice(3)) }];
      if (call.method === "HEAD") return counted(0);
      return [];
    });
    /** What it recorded or put back, each with its claim's token. */
    const settled = () =>
      calls.filter((c) => c.path === "rpc/finish_campaign_recipients" || c.path === "rpc/release_campaign_recipients").map((c) => ({ fn: c.path.slice(4), ...c.body }));
    return { state, calls, settled, done: processCampaigns(env, { campaignId: "camp-1", baseUrl: "https://ops.example.com" }) };
  }

  it("claims its batch instead of reading pending recipients, so overlapping runs don't send twice", async () => {
    const { calls, settled, done } = run();
    expect(await done).toMatchObject({ sent: 3 });
    expect(calls.find((c) => c.path === "rpc/claim_campaign_recipients")?.body).toEqual({ p_campaign: "camp-1", p_limit: 25 });
    expect(calls.some((c) => c.method === "GET" && c.path === "campaign_recipients")).toBe(false);
    expect(settled()).toEqual([1, 2, 3].map((id) => ({ fn: "finish_campaign_recipients", p_token: "claim-1", p_ids: [id], p_status: "sent" })));
  });

  it("renews its claim right before each email, and leaves recipients another run has claimed since", async () => {
    const { state, calls, settled, done } = run({ claimedSince: [2] });
    expect(await done).toMatchObject({ sent: 2, lost: 1 });
    expect(state.emails).toEqual(["person1@example.com", "person3@example.com"]);
    const order = calls.filter((c) => c.path === "rpc/renew_campaign_recipient" || c.url.host === "api.resend.com").map((c) => c.body.p_id ?? c.body.to[0]);
    expect(order).toEqual([1, "person1@example.com", 2, 3, "person3@example.com"]);
    expect(calls.find((c) => c.path === "rpc/renew_campaign_recipient")?.body).toEqual({ p_id: 1, p_token: "claim-1" });
    expect(settled().flatMap((s) => s.p_ids)).toEqual([1, 3]); // recipient 2 is the other run's to record
  });

  it("doesn't email people who unsubscribed after Send", async () => {
    const { state, settled, done } = run({ optedOut: ["client-2"] });
    expect(await done).toMatchObject({ sent: 2, skipped: 1 });
    expect(state.emails).toEqual(["person1@example.com", "person3@example.com"]);
    expect(settled()).toContainEqual({ fn: "finish_campaign_recipients", p_token: "claim-1", p_ids: [2], p_status: "skipped", p_error: "Unsubscribed" });
  });

  it("stops partway through a batch when the campaign is stopped", async () => {
    const { state, settled, done } = run({
      onEmail: (count, s) => {
        if (count === 1) s.status = "cancelled"; // Stop pressed while the first email went out
      },
    });
    expect(await done).toMatchObject({ sent: 1, skipped: 2 });
    expect(state.emails).toEqual(["person1@example.com"]);
    expect(settled()).toContainEqual({ fn: "finish_campaign_recipients", p_token: "claim-1", p_ids: [2, 3], p_status: "skipped", p_error: "Campaign stopped" });
  });

  it("leaves companies with Marketing uninstalled out, starting and sending", async () => {
    const calls = serve((call) => (call.method === "GET" && call.path === "campaigns" ? [] : []));
    expect(await processCampaigns(env)).toMatchObject({ campaigns: 0, sent: 0 });
    const reads = calls.filter((c) => c.method === "GET" && c.path === "campaigns");
    // Scheduled ones whose time has come, and sending ones, only for companies with it on.
    expect(reads.map((c) => c.url.searchParams.get("status"))).toEqual(["eq.scheduled", "eq.sending"]);
    for (const read of reads) {
      expect(read.url.searchParams.get("company.settings->marketing->>enabled")).toBe("eq.true");
      expect(read.url.searchParams.get("select")).toContain("company:companies!inner(");
    }
    // Nothing was due, so nothing started.
    expect(calls.some((c) => c.method === "PATCH" && c.path === "campaigns")).toBe(false);
  });

  it("starts only the scheduled campaigns it found due", async () => {
    const calls = serve((call) => (call.method === "GET" && call.path === "campaigns" && call.url.searchParams.get("status") === "eq.scheduled" ? [{ id: "camp-2" }] : []));
    await processCampaigns(env);
    const start = calls.find((c) => c.method === "PATCH" && c.path === "campaigns")!;
    expect(start.url.searchParams.get("id")).toBe("in.(camp-2)");
    expect(start.url.searchParams.get("status")).toBe("eq.scheduled");
    expect(start.body).toMatchObject({ status: "sending" });
  });

  it("puts the rest of the batch back when the provider rate limits", async () => {
    const { settled, done } = run({ onEmail: (count) => (count === 2 ? Response.json({ message: "Too many requests" }, { status: 429 }) : undefined) });
    expect(await done).toMatchObject({ sent: 1, failed: 0 });
    expect(settled()).toContainEqual({ fn: "release_campaign_recipients", p_token: "claim-1", p_ids: [2, 3] });
  });
});

describe("sender names", () => {
  it("quotes the company name for Resend, so a comma doesn't make two senders", async () => {
    const calls = serve(() => Response.json({ id: "email-1" }));
    const settings = { preset: "resend", kind: "resend" as const, from_email: "office@acme.example", from_name: 'Acme Lawn Care, LLC "Pros"' };
    const result = await sendWithMailbox(settings, { api_key: "re_company" }, { to: "ana@example.com", subject: "Hi", text: "Hello" });
    expect(result).toEqual({ sent: true, id: "email-1" });
    expect(calls[0]!.body.from).toBe('"Acme Lawn Care, LLC \\"Pros\\"" <office@acme.example>');
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a provider that doesn't answer in time like one that can't be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const settings = { preset: "resend", kind: "resend" as const, from_email: "office@acme.example" };
    expect(await sendWithMailbox(settings, { api_key: "re_company" }, { to: "ana@example.com", subject: "Hi", text: "Hello" })).toEqual({
      sent: false,
      reason: "Couldn't reach Resend. Try again.",
    });
  });
});

describe("weather holds", () => {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const visit = { id: "visit-1", scheduled_on: tomorrow, hold_reason: "80% chance of rain", job: { weather_rules: [{ max_rain_pct: 50 }] }, property: { lat: 37.13, lng: -80.41 } };
  const forecast = (rain: number) => ({ daily: { time: [tomorrow], temperature_2m_min: [55], temperature_2m_max: [70], precipitation_probability_max: [rain] } });

  it("leaves holds alone when the forecast can't be fetched", async () => {
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? Response.json({ reason: "Too many requests" }, { status: 429 }) : call.path === "visits" ? [visit] : []));
    expect(await runTask("weather", env)).toMatchObject({ checked: 1, flagged: 0, unknown: 1 });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.find((c) => c.url.host === "api.open-meteo.com")?.signal).toBeInstanceOf(AbortSignal);
  });

  it("still clears a hold when the forecast says the weather is fine", async () => {
    const calls = serve((call) => (call.url.host === "api.open-meteo.com" ? forecast(10) : call.method === "GET" && call.path === "visits" ? [visit] : []));
    await runTask("weather", env);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.url.searchParams.get("id"), c.body])).toEqual([["eq.visit-1", { hold_reason: null }]]);
  });
});

describe("review requests", () => {
  it("asks again when the last request within the window failed to send", async () => {
    const calls = serve((call) => {
      if (call.url.host === "api.resend.com") return Response.json({ id: "email-1" });
      if (call.path === "companies") return [{ name: "Acme", phone: null, email: null, timezone: "UTC", settings: { review_url: "https://g.page/r/acme", marketing: { enabled: true } } }];
      // The database finds no ask in the window that went out (the only one failed), and records this one.
      if (call.path === "rpc/begin_review_request") return Response.json("rr-2");
      return [];
    });
    const result = await sendReviewRequest(env, adminClient(env), {
      companyId: "co-1",
      client: { id: "client-1", display_name: "Ana Smith", email: "ana@example.com", phone: null },
      channel: "email",
      baseUrl: "https://ops.example.com",
      skipIfRecentDays: 30,
      createdBy: null,
    });
    expect(result).toMatchObject({ sent: true, id: "rr-2" });
    expect(calls.find((c) => c.path === "rpc/begin_review_request")?.body).toMatchObject({ p_client: "client-1", p_gap_days: 30, p_channel: "email" });
    expect(calls.some((c) => c.url.host === "api.resend.com")).toBe(true);
  });
});

describe("Zoho data centers", () => {
  it("accepts only Zoho's own accounts and API servers over https", () => {
    expect(zohoAccountsServer("https://accounts.zoho.eu")).toBe("https://accounts.zoho.eu");
    expect(zohoAccountsServer("https://accounts.zoho.com.au/")).toBe("https://accounts.zoho.com.au");
    expect(zohoAccountsServer("https://accounts.zohocloud.ca")).toBe("https://accounts.zohocloud.ca");
    for (const bad of ["https://attacker.example", "http://accounts.zoho.com", "https://accounts.zoho.com.attacker.example", "https://accounts.zoho.com:8443", "https://x@accounts.zoho.com", "not a url", "https://www.zohoapis.com"]) {
      expect(() => zohoAccountsServer(bad), bad).toThrow("isn't Zoho's");
    }
    expect(zohoApiDomain("https://www.zohoapis.in")).toBe("https://www.zohoapis.in");
    expect(zohoApiDomain(undefined)).toBe("https://www.zohoapis.com");
    for (const bad of ["http://169.254.169.254/latest/meta-data", "https://www.zohoapis.com.attacker.example", "http://www.zohoapis.com", "https://accounts.zoho.com"]) {
      expect(() => zohoApiDomain(bad), bad).toThrow("isn't one of Zoho's");
    }
  });

  const zohoEnv: Env = { ...env, ZOHO_CLIENT_ID: "zoho-client", ZOHO_CLIENT_SECRET: "zoho-secret" };
  async function callback(query: Record<string, string>) {
    const state = await signToken(zohoEnv, { company: "co-1", user: "user-1", provider: "zoho_books", nonce: "nonce-1", exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await app.request(`/api/apps/zoho_books/callback?${new URLSearchParams({ code: "code-1", state, ...query })}`, { headers: { Cookie: "crewtavo_oauth_nonce=nonce-1" } }, zohoEnv);
    expect(res.status).toBe(302);
    return new URL(res.headers.get("Location")!).searchParams;
  }
  // Calls that leave the server: not the database (where the company's own Zoho app keys are read from).
  const outside = (calls: Call[]) => calls.filter((c) => c.url.origin !== new URL(env.SUPABASE_URL).origin);

  it("never sends the client secret to an accounts server that isn't Zoho's", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve(() => ({}));
    const result = await callback({ "accounts-server": "https://attacker.example" });
    expect(outside(calls)).toEqual([]);
    expect(result.get("status")).toBe("error");
    expect(result.get("message")).toContain("isn't Zoho's");
  });

  it("refuses an API domain that isn't Zoho's before calling it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = serve((call) => (call.url.pathname === "/oauth/v2/token" ? { access_token: "token-1", refresh_token: "refresh-1", api_domain: "http://169.254.169.254" } : []));
    const result = await callback({ "accounts-server": "https://accounts.zoho.eu" });
    expect(outside(calls).map((c) => c.url.origin)).toEqual(["https://accounts.zoho.eu"]);
    expect(outside(calls)[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(result.get("status")).toBe("error");
    expect(result.get("message")).toContain("isn't one of Zoho's");
  });
});

describe("calendar feed queries", () => {
  it("reads a crew member's visits through their assignments in the feed's dates, a page at a time", async () => {
    const token = "a".repeat(43);
    const visit = (n: number) => ({ visit: { id: `visit-${String(n).padStart(4, "0")}`, title: `Mow ${n}`, status: "scheduled", scheduled_on: "2026-11-02", starts_at: null, ends_at: null, notes: null, updated_at: null, crew: null, job: null, property: null } });
    const calls = serve((call) => {
      if (call.path === "calendar_feeds" && call.method === "GET") return [{ id: "feed-1", company_id: "co-1", user_id: "user-1", scope: "mine", last_used_at: new Date().toISOString() }];
      if (call.path === "memberships") return [{ role: "field_crew" }];
      if (call.path === "companies") return Response.json({ name: "Acme", timezone: "America/New_York" });
      if (call.path === "visit_assignees") {
        const offset = Number(call.url.searchParams.get("offset") ?? 0);
        return Array.from({ length: offset === 0 ? 1000 : 5 }, (_, i) => visit(offset + i));
      }
      return [];
    });
    const res = await app.request(`/api/calendar/${token}.ics`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.text()).split("BEGIN:VEVENT").length - 1).toBe(1005);
    const pages = calls.filter((c) => c.path === "visit_assignees").map((c) => c.url.searchParams);
    expect(pages.map((p) => [p.get("offset"), p.get("limit")])).toEqual([["0", "1000"], ["1000", "1000"]]);
    expect(pages[0]!.get("select")).toMatch(/^visit:visits!inner\(/);
    expect(pages[0]!.get("visit.scheduled_on")).toMatch(/^gte\./);
    expect(pages[0]!.getAll("visit.scheduled_on")[1]).toMatch(/^lte\./);
    expect(pages[0]!.get("order")).toBe("visit_id.asc");
    // No list of visit ids in a URL, however many visits someone has had.
    expect(calls.every((c) => !c.url.search.includes("id.in."))).toBe(true);
  });
});

describe("sign-in links", () => {
  /**
   * Ana is in one company, whose own mailbox is in `status`: Resend with the company's key, which
   * `companySends` says still works, or else the mail server on `smtpPort`. As in GoTrue, Supabase's
   * mailer won't send to her right after a link was made. Returns the emails that went out.
   */
  async function emailLink(options: { status: string; companySends?: boolean; smtpPort?: number; env?: Env }) {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const companyId = crypto.randomUUID(); // mailboxes are cached by company
    const mailbox = options.smtpPort
      ? { settings: { preset: "custom", kind: "smtp", host: "127.0.0.1", port: options.smtpPort, security: "tls", username: "office@acme.example", from_email: "office@acme.example" }, secret: { password: "app-password" } }
      : { settings: { preset: "resend", kind: "resend", from_email: "office@acme.example" }, secret: { api_key: "re_company" } };
    const ciphertext = await encryptJson(env, mailbox.secret);
    const calls = serve((call) => {
      if (call.path === "rpc/rate_limit_hit") return true;
      if (call.path === "rpc/user_id_for_email") return "user-1";
      if (call.path === "memberships") return [{ company_id: companyId, company: { name: "Acme Lawn Care", email: "office@acme.example" } }];
      if (call.method === "GET" && call.path === "integrations") return [{ status: options.status, settings: mailbox.settings }];
      if (call.path === "integration_secrets") return [{ ciphertext }];
      if (call.url.pathname === "/auth/v1/admin/generate_link") return { id: "user-1", email: "ana@example.com", hashed_token: "hashed-1", verification_type: "recovery" };
      if (call.url.pathname === "/auth/v1/recover") {
        const linked = calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link");
        return linked ? Response.json({ code: 429, error_code: "over_email_send_rate_limit", msg: "For security purposes, you can only request this after 59 seconds." }, { status: 429 }) : {};
      }
      if (call.url.host === "api.resend.com") {
        const fromCompany = call.body.from.includes("office@acme.example");
        return fromCompany && !options.companySends ? Response.json({ message: "API key is invalid" }, { status: 403 }) : Response.json({ id: "email-1" });
      }
      return [];
    });
    const res = await app.request("/api/auth/email-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "ana@example.com", kind: "recovery" }) }, options.env ?? env);
    expect(await res.json()).toEqual({ sent: true });
    const emails = calls.filter((c) => c.url.host === "api.resend.com").map((c) => ({ from: c.body.from as string, link: (c.body.text as string).includes("token_hash=hashed-1") }));
    return { emails, calls };
  }
  const company = '"Acme Lawn Care" <office@acme.example>';
  const server = "Crewtavo <noreply@example.com>";
  const noServerEmail = { ...env, RESEND_API_KEY: undefined, EMAIL_FROM: undefined };

  it("go out from the company's mailbox while it works", async () => {
    expect((await emailLink({ status: "connected", companySends: true })).emails).toEqual([{ from: company, link: true }]);
    expect((await emailLink({ status: "connected", companySends: true, env: noServerEmail })).emails).toEqual([{ from: company, link: true }]);
  });

  it("skip a company mailbox whose sign-in failed and use the server's email", async () => {
    expect((await emailLink({ status: "error", companySends: true })).emails).toEqual([{ from: server, link: true }]);
  });

  it("go out from the server's email when the company mailbox fails", async () => {
    expect((await emailLink({ status: "connected", companySends: false })).emails).toEqual([{ from: company, link: true }, { from: server, link: true }]);
  });

  it("without the server's email, check the mailbox signs in before making a link, and else use Supabase's mailer", async () => {
    const closed = net.createServer(); // a mail server that's gone
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const smtpPort = (closed.address() as net.AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const { calls } = await emailLink({ status: "connected", smtpPort, env: noServerEmail });
    // No link first: that would have kept Supabase's mailer from sending.
    expect(calls.some((c) => c.url.pathname === "/auth/v1/admin/generate_link")).toBe(false);
    expect(calls.find((c) => c.url.pathname === "/auth/v1/recover")?.body).toMatchObject({ email: "ana@example.com" });
  });

  it("without the server's email, set aside a mailbox whose Resend key is refused, so the next link skips it", async () => {
    const { emails, calls } = await emailLink({ status: "connected", companySends: false, env: noServerEmail });
    expect(emails).toEqual([{ from: company, link: true }]);
    // Supabase's mailer would refuse right after the link, so it isn't asked.
    expect(calls.some((c) => c.url.pathname === "/auth/v1/recover")).toBe(false);
    expect(calls.find((c) => c.method === "PATCH" && c.path === "integrations")?.body).toEqual({ status: "error", last_error: expect.stringContaining("Resend didn't accept this API key") });
  });
});

describe("public submissions", () => {
  /** The database for one company's forms; rate limits whose key matches `full` are used up. */
  function database(options: { full?: RegExp; questions?: unknown[] } = {}) {
    const calls = serve((call) => {
      if (call.path === "rpc/rate_limit_hit") return !options.full?.test(call.body.p_key);
      if (call.path === "companies") return [{ id: "co-1", name: "Acme Lawn Care", phone: null, timezone: "America/New_York", settings: {} }];
      if (call.path === "intake_forms") return [{ id: "form-1", name: "Request a quote", kind: "request", questions: options.questions ?? [], service_area_zips: [], lead_time_days: 0, slot_minutes: null }];
      // Storage: a link to upload each file, and what arrived (only the first file did).
      if (call.url.pathname.startsWith("/storage/v1/object/upload/sign/")) return { url: `${call.url.pathname.replace("/storage/v1", "")}?token=tok-${call.url.pathname.slice(-8)}` };
      if (call.url.pathname.startsWith("/storage/v1/object/info/")) {
        return arrived.has(call.url.pathname.replace("/storage/v1/object/info/files/", "")) ? { size: 48_000_000, content_type: "application/pdf" } : Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 });
      }
      if (call.method === "GET" && call.path === "clients") return [{ id: "client-1", display_name: "Ana Smith" }];
      if (call.method === "POST" && call.path === "clients") return Response.json({ id: "client-2" }, { status: 201 });
      if (call.method === "POST" && call.path === "properties") return Response.json({ id: "property-2" }, { status: 201 });
      if (call.method === "POST" && call.path === "requests") return Response.json({ id: "request-2", number: 1042 }, { status: 201 });
      if (call.path === "rpc/record_referral") return { client_id: "client-2", property_id: "property-2", new_property: true, request_id: "request-2", number: 1043 };
      return [];
    });
    const made = () => calls.filter((c) => c.method === "POST" && ["clients", "properties", "requests", "referrals", "rpc/record_referral"].includes(c.path)).map((c) => c.path);
    const limits = () => calls.filter((c) => c.path === "rpc/rate_limit_hit").map((c) => [c.body.p_key, c.body.p_max, c.body.p_window_seconds]);
    return { calls, made, limits };
  }
  // A visitor at 203.0.113.9, with nothing in front of the server.
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, bindings = connectedFrom("203.0.113.9")) =>
    app.request(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, bindings);
  const lead = { name: "Bob Jones", email: "bob@example.com", address: { line1: "12 Main St", city: "Radford", postal_code: "24141" } };
  const token = async (t: "refer" | "client" | "quote", id: string) => (await clientLink(env, "https://ops.example.com", { c: "co-1", t, id })).split(/\/(?:refer|hub)\//)[1]!;

  it("limits booking forms per visitor and per company, before anything is made", async () => {
    const ok = database();
    expect((await post("/public/forms/acme/quote", lead)).status).toBe(201);
    expect(ok.limits()).toEqual([["form:ip:203.0.113.9", 10, 3600], ["form:company:co-1", 100, 3600]]);
    expect(ok.made()).toEqual(["clients", "properties", "requests"]);

    for (const full of [/^form:ip:/, /^form:company:/]) {
      const limited = database({ full });
      const res = await post("/public/forms/acme/quote", lead);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "Too many requests. Try again later, or call us." });
      expect(limited.made()).toEqual([]);
      // No address lookup either.
      expect(limited.calls.every((c) => c.url.host === "example.supabase.co")).toBe(true);
    }
  });

  it("counts visitors by the address the deployment's own proxy gives, whatever headers they send", async () => {
    const forged = { "X-Real-IP": "198.51.100.2", "X-Forwarded-For": "198.51.100.1" };
    const visitorKey = async (headers: Record<string, string>, bindings: ReturnType<typeof connectedFrom>) => {
      const db = database();
      expect((await post("/public/forms/acme/quote", lead, headers, bindings)).status).toBe(201);
      return db.limits()[0]![0];
    };
    // Straight to the port: the connection's address.
    expect(await visitorKey(forged, connectedFrom("203.0.113.50"))).toBe("form:ip:203.0.113.50");
    // Behind Caddy (connecting from Docker's network): the entry it adds to X-Forwarded-For.
    expect(await visitorKey({ ...forged, "X-Forwarded-For": "198.51.100.1, 203.0.113.9" }, connectedFrom("172.18.0.1"))).toBe("form:ip:203.0.113.9");
    // On Railway: the X-Real-IP its edge sets.
    const railway = { ...env, RAILWAY_PROJECT_ID: "proj-1" };
    expect(await visitorKey({ ...forged, "X-Real-IP": "203.0.113.9" }, connectedFrom("100.64.0.7", railway))).toBe("form:ip:203.0.113.9");
  });

  const arrived = new Set<string>();
  const plansQuestion = { key: "plans", label: "Plans or photos", type: "files", required: false };

  it("takes files with a request: a one-time upload link for each, then records the ones that arrived", async () => {
    const db = database({ questions: [plansQuestion] });
    const files = [{ question: "plans", name: "C-101 Site Plan.pdf", size: 48_000_000, type: "application/pdf" }, { question: "plans", name: "lot.jpg", size: 2_000_000, type: "image/jpeg" }];
    const res = await post("/public/forms/acme/quote", { ...lead, answers: { plans: files.map((f) => f.name) }, files });
    expect(res.status).toBe(201);
    const sent = (await res.json()) as { reference: number; uploads: Array<{ name: string; path: string; token: string }>; files_token: string };
    expect(sent.uploads.every(Boolean)).toBe(true);
    expect(sent.reference).toBe(1042);
    expect(sent.uploads.map((u) => u.name)).toEqual(["C-101 Site Plan.pdf", "lot.jpg"]);
    expect(sent.uploads.every((u) => /^co-1\/plans\/[0-9a-f-]{36}\.(pdf|jpg)$/.test(u.path) && u.token.startsWith("tok-"))).toBe(true);
    // The request says which files came with it.
    expect(db.calls.find((c) => c.method === "POST" && c.path === "requests")?.body.answers).toEqual({ plans: ["C-101 Site Plan.pdf", "lot.jpg"] });

    // Only the first upload got through.
    arrived.add(sent.uploads[0]!.path);
    const done = await post("/public/forms/acme/quote/files", { files_token: sent.files_token, uploaded: sent.uploads.map((u) => u.path) });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ added: 1 });
    expect(db.calls.find((c) => c.method === "POST" && c.path === "plan_files")?.body).toEqual([
      { company_id: "co-1", request_id: "request-2", title: "C-101 Site Plan", path: sent.uploads[0]!.path, file_name: "C-101 Site Plan.pdf", content_type: "application/pdf", size_bytes: 48_000_000, crew_visible: true, created_by: null },
    ]);
    // A made-up path isn't recorded, and the link only works for this company.
    const forged = await post("/public/forms/acme/quote/files", { files_token: `${sent.files_token}x`, uploaded: [sent.uploads[0]!.path] });
    expect(forged.status).toBe(400);
  });

  it("takes files only for a form's file questions, and no more than ten", async () => {
    const noFiles = database();
    expect((await post("/public/forms/acme/quote", { ...lead, files: [{ question: "plans", name: "a.pdf", size: 10 }] })).status).toBe(400);
    expect(noFiles.made()).toEqual([]);
    const many = database({ questions: [plansQuestion] });
    const eleven = Array.from({ length: 11 }, (_, i) => ({ question: "plans", name: `sheet-${i}.pdf`, size: 10 }));
    expect((await post("/public/forms/acme/quote", { ...lead, files: eleven })).status).toBe(400);
    expect((await post("/public/forms/acme/quote", { ...lead, files: [{ question: "plans", name: "huge.pdf", size: 300 * 1024 * 1024 }] })).status).toBe(400);
    expect(many.made()).toEqual([]);
  });

  it("keeps booking form answers to the size and shape of real ones", async () => {
    const answers = { details: "Front and back yard", extras: ["Edging", "Leaf pickup"], acres: 2, gate: true };
    const ok = database();
    expect((await post("/public/forms/acme/quote", { ...lead, answers })).status).toBe(201);
    expect(ok.calls.find((c) => c.method === "POST" && c.path === "requests")?.body.answers).toEqual(answers);

    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`q${i}`, "yes"]));
    const bulky = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${i}`, "x".repeat(3000)]));
    for (const bad of [{ details: "x".repeat(4001) }, { details: { nested: "object" } }, { extras: Array(51).fill("Edging") }, tooMany, bulky]) {
      const db = database();
      expect((await post("/public/forms/acme/quote", { ...lead, answers: bad })).status).toBe(400);
      expect(db.made()).toEqual([]);
    }
  });

  it("limits referrals per visitor and per company", async () => {
    const path = `/public/refer/${await token("refer", "client-1")}`;
    const ok = database();
    const res = await post(path, { ...lead, phone: "540-555-0123" });
    expect([res.status, await res.json()]).toEqual([201, { ok: true, reference: 1043 }]);
    expect(ok.limits()).toEqual([["referral:ip:203.0.113.9", 10, 3600], ["referral:company:co-1", 100, 3600]]);
    // The lead, their property, the request and the referral, made together by the database.
    expect(ok.made()).toEqual(["rpc/record_referral"]);
    expect(ok.calls.find((c) => c.path === "rpc/record_referral")?.body).toEqual({
      p_company: "co-1", p_referrer: "client-1", p_name: "Bob Jones", p_email: "bob@example.com", p_phone: "540-555-0123",
      p_address: { line1: "12 Main St", city: "Radford", postal_code: "24141" },
    });

    const limited = database({ full: /^referral:company:/ });
    expect((await post(path, lead)).status).toBe(429);
    expect(limited.made()).toEqual([]);
  });

  it("limits work requests from the Client Hub, and counts their promo codes with other promo checks", async () => {
    const path = `/hub/${await token("client", "client-1")}/request`;
    const ok = database();
    expect((await post(path, { title: "Gutter cleaning", promo_code: "spring10" })).status).toBe(201);
    expect(ok.limits()).toEqual([["hub-request:ip:203.0.113.9", 10, 3600], ["hub-request:company:co-1", 100, 3600], ["promo:203.0.113.9", 10, 600]]);
    expect(ok.calls.find((c) => c.path === "requests")?.body.promo_code).toBe("SPRING10");

    for (const full of [/^hub-request:/, /^promo:/]) {
      const limited = database({ full });
      expect((await post(path, { title: "Gutter cleaning", promo_code: "SPRING10" })).status).toBe(429);
      // Whether the code is real isn't checked (or given away), and nothing is made.
      expect(limited.calls.some((c) => c.path === "rpc/check_promo_code")).toBe(false);
      expect(limited.made()).toEqual([]);
    }
  });
});

describe("place suggestions on the measuring map", () => {
  const photon = {
    features: [
      { geometry: { coordinates: [-79.88, 36.99] }, properties: { housenumber: "418", street: "Pell Avenue", city: "Rocky Mount", state: "Virginia", countrycode: "us", country: "United States" } },
      { geometry: { coordinates: [-79.87, 37.0] }, properties: { name: "Diamond Avenue", type: "street", osm_key: "highway", city: "Rocky Mount", state: "Virginia", countrycode: "us" } },
      { geometry: { coordinates: [-0.15, 51.5] }, properties: { name: "Hyde Park Corner", type: "locality", city: "London", state: "England", countrycode: "gb", country: "United Kingdom" } },
      { geometry: {}, properties: { name: "No point" } },
    ],
  };

  it("names each place plainly, leans toward the map, and asks Photon once per text and area", async () => {
    const calls = serve(() => photon);
    const places = await suggestPlaces("  418  Pell ", { lat: 36.9958, lng: -79.8862 });
    expect(places).toEqual([
      { label: "418 Pell Avenue", detail: "Rocky Mount, Virginia", lat: 36.99, lng: -79.88, country: "US", kind: "address" },
      { label: "Diamond Avenue", detail: "Rocky Mount, Virginia", lat: 37, lng: -79.87, country: "US", kind: "street" },
      { label: "Hyde Park Corner", detail: "London, England, United Kingdom", lat: 51.5, lng: -0.15, country: "GB", kind: "place" },
    ]);
    const asked = calls[0].url;
    expect(asked.host).toBe("photon.komoot.io");
    expect(asked.searchParams.get("q")).toBe("418 Pell");
    expect([asked.searchParams.get("lat"), asked.searchParams.get("lon"), asked.searchParams.get("location_bias_scale")]).toEqual(["36.9958", "-79.8862", "0.1"]);
    // The same text nearby comes from the cache.
    await suggestPlaces("418 pell", { lat: 36.99, lng: -79.89 });
    expect(calls).toHaveLength(1);
  });

  it("fails loudly enough for the route to say suggestions are down", async () => {
    serve(() => new Response("busy", { status: 503 }));
    await expect(suggestPlaces("somewhere new")).rejects.toThrow("Photon returned 503");
  });
});

describe("drawings in the Client Hub", () => {
  const DRAWING = "5d0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
  const picture = async (drawing: Record<string, unknown> | null, link: { t: "quote" | "invoice"; id: string } = { t: "quote", id: "quote-1" }) => {
    const calls = serve((call) => {
      if (call.method === "GET" && call.path === "measurements") return drawing ? [drawing] : [];
      if (call.url.pathname.startsWith("/storage/v1/object/files/")) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "Content-Type": "image/jpeg" } });
      return [];
    });
    const token = (await clientLink(env, "https://ops.example.com", { c: "co-1", ...link })).split("/hub/")[1];
    const res = await app.request(`/api/hub/${token}/drawings/${DRAWING}.jpg`, {}, env);
    return { res, calls };
  };
  const shown = { snapshot_path: `co-1/measurements/${DRAWING}.jpg`, show_on_quote: true, show_on_invoice: false, quote_id: "quote-1", invoice_id: "invoice-1" };

  it("serves the picture of a drawing shown on the quote", async () => {
    const { res, calls } = await picture(shown);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    expect(calls.find((c) => c.path === "measurements")?.url.searchParams.get("company_id")).toBe("eq.co-1");
    expect(calls.some((c) => c.url.pathname === `/storage/v1/object/files/co-1/measurements/${DRAWING}.jpg`)).toBe(true);
  });

  it("shows nothing the office didn't choose to show on that quote or invoice", async () => {
    for (const [drawing, link] of [
      [{ ...shown, show_on_quote: false, show_on_invoice: true }, undefined],
      [{ ...shown, snapshot_path: null }, undefined],
      [{ ...shown, quote_id: "quote-2" }, undefined],
      [shown, { t: "invoice" as const, id: "invoice-1" }],
      [null, undefined],
    ] as const) {
      const { res, calls } = await picture(drawing, link);
      expect(res.status, JSON.stringify([drawing, link])).toBe(404);
      expect(calls.some((c) => c.url.pathname.startsWith("/storage/"))).toBe(false);
    }
  });
});

describe("quote approval", () => {
  // The database claims the quote, then picks the options and records the approval with the amounts
  // they came to, in one step (approve_hub_quote; supabase/tests/hub_approval_test.sql).
  const company = [{ name: "Acme", phone: null, timezone: "America/Chicago" }];
  const addOn = (id: string, values: Record<string, unknown> = {}) => ({ id, option_id: null, quantity: 1, unit_price: 0, taxable: true, optional: true, selected: false, option_group: null, ...values });
  const approve = async (approved: boolean, headers: Record<string, string> = {}, bindings = connectedFrom("203.0.113.9")) => {
    const option = crypto.randomUUID();
    const calls = serve((call) => {
      if (call.method === "GET" && call.path === "quotes") return [{ id: "quote-1", status: "sent" }];
      if (call.method === "GET" && call.path === "quote_line_items") return [addOn(option)];
      if (call.method === "GET" && call.path === "companies") return company;
      if (call.path === "rpc/approve_hub_quote") return approved;
      return [];
    });
    const quote = (await clientLink(env, "https://ops.example.com", { c: "co-1", t: "quote", id: "quote-1" })).split("/hub/")[1];
    const res = await app.request(
      `/api/hub/${quote}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ name: "Ana Smith", selected_line_ids: [option] }) },
      bindings,
    );
    return { option, calls, res };
  };
  // Picking the options here, before the quote is claimed, let an approval that lost change them.
  const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && ["quotes", "quote_line_items"].includes(c.path));

  it("records the client's approval with the options they picked", async () => {
    const { option, calls, res } = await approve(true);
    expect(await res.json()).toEqual({ status: "approved" });
    expect(calls.find((c) => c.path === "rpc/approve_hub_quote")?.body).toEqual({
      p_company: "co-1",
      p_quote: "quote-1",
      p_selected: [option],
      // The business has no template saved, so the built-in one is kept with the approval, with its
      // terms as the contract (no options, no sections and nothing to initial).
      p_approval: {
        name: "Ana Smith", selected_line_ids: [option], signature: null, signed_at: expect.any(String), ip: "203.0.113.9", template: DEFAULT_TEMPLATE,
        option: null, contract: { terms: DEFAULT_TEMPLATE.terms, sections: [] }, initials: null,
      },
    });
    expect(writes(calls)).toEqual([]);
  });

  it("records the address the deployment's own proxy gives, not one the client sent", async () => {
    const recorded = async (headers: Record<string, string>, bindings: ReturnType<typeof connectedFrom>) => {
      const { calls } = await approve(true, headers, bindings);
      return calls.find((c) => c.path === "rpc/approve_hub_quote")?.body.p_approval.ip;
    };
    const forged = { "X-Real-IP": "198.51.100.2", "X-Forwarded-For": "198.51.100.1" };
    expect(await recorded(forged, connectedFrom("203.0.113.50"))).toBe("203.0.113.50");
    expect(await recorded({ ...forged, "X-Forwarded-For": "198.51.100.1, 203.0.113.9" }, connectedFrom("172.18.0.1"))).toBe("203.0.113.9");
    expect(await recorded({ ...forged, "X-Real-IP": "203.0.113.9" }, connectedFrom("100.64.0.7", { ...env, RAILWAY_PROJECT_ID: "proj-1" }))).toBe("203.0.113.9");
  });

  it("changes nothing when another approval got there first", async () => {
    const { calls, res } = await approve(false);
    expect(res.status).toBe(409);
    expect(writes(calls)).toEqual([]);
  });

  it("takes exactly one of the choices in an option group (Good, Better and Best roofs)", async () => {
    const [good, better, best, gutters] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const pick = async (selected: string[]) => {
      const calls = serve((call) => {
        if (call.method === "GET" && call.path === "quotes") return [{ id: "quote-1", status: "sent" }];
        if (call.method === "GET" && call.path === "quote_line_items") return [...[good, better, best].map((id) => addOn(id, { option_group: "Roof" })), addOn(gutters)];
        if (call.method === "GET" && call.path === "companies") return company;
        if (call.path === "rpc/approve_hub_quote") return true;
        return [];
      });
      const quote = (await clientLink(env, "https://ops.example.com", { c: "co-1", t: "quote", id: "quote-1" })).split("/hub/")[1];
      const res = await app.request(`/api/hub/${quote}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ana Smith", selected_line_ids: selected }) }, connectedFrom("203.0.113.9"));
      return { res, calls };
    };
    for (const wrong of [[], [good, best], [gutters]]) {
      const { res, calls } = await pick(wrong);
      expect(res.status, JSON.stringify(wrong)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Pick one of the choices for Roof.");
      expect(calls.some((c) => c.path === "rpc/approve_hub_quote")).toBe(false);
    }
    const { res, calls } = await pick([better, gutters]);
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.path === "quote_line_items")?.url.searchParams.get("company_id")).toBe("eq.co-1");
    expect(calls.find((c) => c.path === "rpc/approve_hub_quote")?.body.p_selected).toEqual([better, gutters]);
  });
});
