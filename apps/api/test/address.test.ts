/**
 * Settings → Web address: DNS checks against a stand-in resolver, Railway's and Cloudflare's APIs
 * and PostgREST stubbed through fetch, and the addresses an instance keeps answering on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { addCloudflareRecords } from "../src/integrations/cloudflare";
import { addCustomDomain, certificateOf, railwayRecords, registerClient, SCOPE, type RailwayDomainStatus } from "../src/integrations/railway";
import { forgetAddressHistory, forwardTo } from "../src/lib/address";
import { decryptJson, encryptJson, instanceFingerprint, signToken } from "../src/lib/crypto";
import { checkRecord, findZone, type Lookup } from "../src/lib/dns";
import { twilioSignature } from "../src/routes/messages";
import { addressOverview, runAddressTask, useLookup } from "../src/services/address";
import { keepRailwayAlive, KEEP_ALIVE_MS, setRailwaySetup } from "../src/services/railway";
import { adminClient } from "../src/lib/supabase";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://app.greenlawn.com",
  RAILWAY_PUBLIC_DOMAIN: "crewtavo-production.up.railway.app",
  RAILWAY_PROJECT_ID: "proj-1",
  RAILWAY_ENVIRONMENT_ID: "env-1",
  RAILWAY_SERVICE_ID: "svc-crewtavo",
  CREWTAVO_SINGLE_COMPANY: "1",
};

/** A resolver that knows only `zone`: name → type → answers. */
function fakeDns(records: Record<string, Partial<Record<keyof Lookup, string[]>>>): Lookup {
  const answer = (type: keyof Lookup) => async (name: string) => records[name.toLowerCase()]?.[type] ?? [];
  return { cname: answer("cname"), txt: answer("txt"), a: answer("a"), aaaa: answer("aaaa"), ns: answer("ns") };
}

interface Call {
  method: string;
  url: URL;
  path: string;
  body: any;
  accept: string;
  projectToken: string | null;
}

function serve(answer: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies stay text
    }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body, accept: new Headers(init?.headers).get("accept") ?? "", projectToken: new Headers(init?.headers).get("project-access-token") };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  forgetAddressHistory();
});

describe("DNS checks", () => {
  const zoneDns = { "greenlawn.com": { ns: ["ns01.domaincontrol.com", "ns02.domaincontrol.com"] } };

  it("finds the zone a name lives in, not where a CNAME points", async () => {
    const lookup = fakeDns({ ...zoneDns, "app.greenlawn.com": { cname: ["abc.up.railway.app"], ns: ["ns1.railway.app"] } });
    expect(await findZone(lookup, "app.greenlawn.com")).toEqual({ zone: "greenlawn.com", nameservers: ["ns01.domaincontrol.com", "ns02.domaincontrol.com"] });
    expect(await findZone(fakeDns({}), "app.nowhere.test")).toBeNull();
  });

  it("knows a record is in place, or what's wrong with it", async () => {
    const want = { type: "CNAME" as const, purpose: "route" as const, name: "app.greenlawn.com", value: "abc123.up.railway.app" };
    const check = (records: Parameters<typeof fakeDns>[0], provider = "godaddy") => checkRecord(fakeDns({ ...zoneDns, ...records }), want, "greenlawn.com", provider);

    expect(await check({ "app.greenlawn.com": { cname: ["abc123.up.railway.app"] } })).toMatchObject({ status: "ok", host: "app" });
    expect(await check({ "app.greenlawn.com": { cname: ["old-host.example.net"] } })).toMatchObject({ status: "wrong", hint: expect.stringContaining("abc123.up.railway.app") });
    expect(await check({ "app.greenlawn.com": { a: ["192.0.2.1"] } })).toMatchObject({ status: "wrong", hint: expect.stringContaining("A record") });
    expect(await check({ "app.greenlawn.com": { a: ["104.21.1.1"] } }, "cloudflare")).toMatchObject({ status: "wrong", hint: expect.stringContaining("grey cloud") });
    expect(await check({ "app.greenlawn.com.greenlawn.com": { cname: ["abc123.up.railway.app"] } })).toMatchObject({
      status: "wrong",
      hint: expect.stringContaining("GoDaddy adds greenlawn.com by itself, so the Name should be just app"),
    });
    expect(await check({})).toMatchObject({ status: "missing" });
    // Railway already sees it, whatever the resolvers say.
    expect(await checkRecord(fakeDns(zoneDns), want, "greenlawn.com", "godaddy", true)).toMatchObject({ status: "ok" });
  });

  it("accepts any CNAME to Railway when only Railway knows the exact one", async () => {
    const lookup = fakeDns({ ...zoneDns, "app.greenlawn.com": { cname: ["zz9.up.railway.app"] } });
    expect(await checkRecord(lookup, { type: "CNAME", purpose: "route", name: "app.greenlawn.com", value: null }, "greenlawn.com", "godaddy")).toMatchObject({ status: "ok" });
  });

  it("checks TXT values whole, even when DNS splits them", async () => {
    const want = { type: "TXT" as const, purpose: "verify" as const, name: "_railway-verify.app.greenlawn.com", value: "railway-verify=abc" };
    expect(await checkRecord(fakeDns({ "_railway-verify.app.greenlawn.com": { txt: ["railway-verify=abc"] } }), want, "greenlawn.com", null)).toMatchObject({ status: "ok", host: "_railway-verify.app" });
    expect(await checkRecord(fakeDns({ "_railway-verify.app.greenlawn.com": { txt: ["something-else"] } }), want, "greenlawn.com", null)).toMatchObject({ status: "wrong" });
  });
});

describe("Railway", () => {
  const status: RailwayDomainStatus = {
    verified: false,
    certificateStatus: "CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP",
    certificateErrorMessage: null,
    verificationDnsHost: "_railway-verify.app",
    verificationToken: "railway-verify=tok",
    dnsRecords: [{ recordType: "DNS_RECORD_TYPE_CNAME", purpose: "DNS_RECORD_PURPOSE_TRAFFIC_ROUTE", hostlabel: "app", fqdn: "app.greenlawn.com", zone: "greenlawn.com", requiredValue: "abc123.up.railway.app", status: "DNS_RECORD_STATUS_PROPAGATED" }],
  };

  it("turns Railway's domain status into the records to add", () => {
    expect(railwayRecords("app.greenlawn.com", status, null)).toEqual([
      { type: "CNAME", purpose: "route", name: "app.greenlawn.com", host: "app", value: "abc123.up.railway.app", ok: true },
      { type: "TXT", purpose: "verify", name: "_railway-verify.app.greenlawn.com", host: "_railway-verify.app", value: "railway-verify=tok", ok: false },
    ]);
    expect(certificateOf(status)).toBe("pending");
    expect(certificateOf({ ...status, certificateStatus: "CERTIFICATE_STATUS_TYPE_VALID" })).toBe("issued");
  });

  it("registers this instance as its own OAuth client, and says so plainly when Railway won't", async () => {
    const calls = serve(() => Response.json({ client_id: "cid", client_secret: "sec", registration_access_token: "rat", registration_client_uri: "https://backboard.railway.com/oauth/register/cid" }, { status: 201 }));
    const client = await registerClient("https://x.up.railway.app/api/railway/callback", "Crewtavo for Green Lawn");
    expect(client).toMatchObject({ client_id: "cid", client_secret: "sec", redirect_uri: "https://x.up.railway.app/api/railway/callback" });
    expect(calls[0]!.body).toMatchObject({ redirect_uris: ["https://x.up.railway.app/api/railway/callback"], scope: "openid project:member offline_access" });

    serve(() => Response.json({ error: "invalid_client_metadata", error_description: "registration closed" }, { status: 400 }));
    await expect(registerClient("https://x.up.railway.app/cb", "Crewtavo")).rejects.toThrow("Use a project token instead");
  });

  describe("adding the address", () => {
    const access = { method: "oauth" as const, token: "at" };
    /** Railway's GraphQL, answering customDomainCreate with `create`. */
    const railway = (create: () => unknown) =>
      serve((call) => {
        const q = call.body.query as string;
        if (q.includes("domains(")) return { data: { domains: { customDomains: [] } } };
        if (q.includes("customDomainCreate")) return create();
        return { errors: [{ message: "Not Authorized" }], data: null };
      });

    it("adds it straight away, without the availability check a one-project sign-in can't make", async () => {
      const calls = railway(() => ({ data: { customDomainCreate: { id: "dom-1", domain: "app.greenlawn.com", status } } }));
      expect(await addCustomDomain(env, access, "app.greenlawn.com")).toMatchObject({ id: "dom-1", added: true });
      expect(calls.some((c) => c.body.query.includes("customDomainAvailable"))).toBe(false);
      expect(calls.find((c) => c.body.query.includes("customDomainCreate"))?.body.variables.input).toEqual({ projectId: "proj-1", environmentId: "env-1", serviceId: "svc-crewtavo", domain: "app.greenlawn.com", targetPort: 8080 });
    });

    it("says how to add it in Railway when Railway won't let Crewtavo, and logs why", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      railway(() => ({ errors: [{ message: "Not Authorized" }], data: null }));
      const refused = await addCustomDomain(env, access, "app.greenlawn.com").catch((e: Error) => e.message);
      expect(refused).toContain("Add it in Railway yourself");
      expect(refused).not.toContain("Log in with Railway again");
      expect(warn).toHaveBeenCalledWith("Railway refused customDomainCreate: Not Authorized");
      warn.mockRestore();
    });

    it("explains the plan's domain limit, and passes Railway's other answers on", async () => {
      railway(() => ({ errors: [{ message: "Custom domain limit reached for this plan" }], data: null }));
      await expect(addCustomDomain(env, access, "app.greenlawn.com")).rejects.toThrow("doesn't allow another custom domain");
      railway(() => ({ errors: [{ message: "Domain is already in use" }], data: null }));
      await expect(addCustomDomain(env, access, "app.greenlawn.com")).rejects.toThrow("Railway can't use app.greenlawn.com: Domain is already in use");
    });
  });
});

describe("the switch-over task", () => {
  beforeEach(() => useLookup(fakeDns({ "greenlawn.com": { ns: ["ada.ns.cloudflare.com"] }, "app.greenlawn.com": { cname: ["abc123.up.railway.app"] } })));

  const waiting = {
    company_id: "co-1", domain: "app.greenlawn.com", status: "waiting", automatic: true, railway_domain_id: "dom-1", records: [], certificate: "pending", error: null,
    from_url: "https://crewtavo-production.up.railway.app", previous_urls: [], started_by: "user-1", started_at: "2026-10-18T10:00:00Z", switching_at: null, finished_at: null, updated_at: "2026-10-18T10:00:00Z",
  };

  it("switches APP_URL and redeploys auth and crewtavo once Railway is ready and the address answers", async () => {
    const before = { ...env, APP_URL: "https://crewtavo-production.up.railway.app" };
    const secret = await encryptJson(before, { api_key: "project-token", extra: { method: "token" } });
    const fingerprint = await instanceFingerprint(before);
    const calls = serve((call) => {
      if (call.path === "web_address" && call.method === "GET") return [waiting];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      if (call.path === "integrations") return [{ status: "connected" }];
      if (call.url.pathname === "/.well-known/crewtavo-instance") return { instance: fingerprint };
      if (call.url.host === "backboard.railway.com") {
        const q = call.body.query as string;
        if (q.includes("customDomain(")) return { data: { customDomain: { id: "dom-1", domain: "app.greenlawn.com", status: { ...readyStatus } } } };
        if (q.includes("projectToken")) return { data: { projectToken: { projectId: "proj-1", environmentId: "env-1" } } };
        if (q.includes("project(")) return { data: { project: { name: "Green Lawn", services: { edges: [{ node: { id: "svc-auth", name: "auth" } }, { node: { id: "svc-crewtavo", name: "crewtavo" } }] } } } };
        return { data: { ok: true } };
      }
      return [];
    });
    const result = await runAddressTask(before, adminClient(before));
    expect(result).toMatchObject({ checked: 1, switching: 1 });
    const railway = calls.filter((c) => c.url.host === "backboard.railway.com").map((c) => c.body);
    expect(railway.find((b) => b.query.includes("variableUpsert"))?.variables.input).toMatchObject({ name: "APP_URL", value: "https://app.greenlawn.com", serviceId: "svc-crewtavo", skipDeploys: true });
    expect(railway.filter((b) => b.query.includes("serviceInstanceRedeploy")).map((b) => b.variables.serviceId)).toEqual(["svc-auth", "svc-crewtavo"]);
    const patches = calls.filter((c) => c.path === "web_address" && c.method === "PATCH").map((c) => c.body);
    expect(patches).toContainEqual(expect.objectContaining({ status: "switching" }));
    // A project token goes in Railway's own header.
    expect(calls.filter((c) => c.url.host === "backboard.railway.com").every((c) => c.projectToken === "project-token")).toBe(true);
  });

  it("finishes when Crewtavo starts with the new address: tells the admins and keeps Railway connected", async () => {
    const calls = serve((call) => {
      if (call.path === "web_address" && call.method === "GET") return [{ ...waiting, status: "switching", switching_at: "2026-10-18T10:30:00Z" }];
      if (call.path === "web_address" && call.method === "PATCH") {
        const row = { ...waiting, ...call.body };
        return call.accept.includes("vnd.pgrst.object") ? row : [row];
      }
      if (call.path === "memberships") return [{ user_id: "user-1" }, { user_id: "user-2" }];
      if (call.path === "companies") return [{ name: "Green Lawn" }];
      return [];
    });
    expect(await runAddressTask(env, adminClient(env))).toMatchObject({ done: 1 });
    const done = calls.find((c) => c.path === "web_address" && c.method === "PATCH")!;
    expect(done.body).toMatchObject({ status: "done", previous_urls: ["https://crewtavo-production.up.railway.app"] });
    expect(calls.find((c) => c.path === "notifications" && c.method === "POST")?.body).toHaveLength(2);
    expect(calls.some((c) => c.path === "integrations" && c.method === "DELETE")).toBe(false);
  });

  it("asks Railway again for an address it didn't take, and picks it up once it's on the service", async () => {
    const before = { ...env, APP_URL: "https://crewtavo-production.up.railway.app" };
    const secret = await encryptJson(before, { access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3_600_000, extra: { method: "oauth" } });
    const routed: RailwayDomainStatus = { ...readyStatus, verified: false, certificateStatus: "CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP", dnsRecords: [{ recordType: "DNS_RECORD_TYPE_CNAME", purpose: "DNS_RECORD_PURPOSE_TRAFFIC_ROUTE", hostlabel: "app", fqdn: "app.greenlawn.com", zone: "greenlawn.com", requiredValue: "abc123.up.railway.app", status: "DNS_RECORD_STATUS_REQUIRES_UPDATE" }] };
    const calls = serve((call) => {
      if (call.path === "web_address" && call.method === "GET") return [{ ...waiting, automatic: false, railway_domain_id: null, error: "Railway didn't let Crewtavo add app.greenlawn.com." }];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      if (call.path === "integrations") return [{ status: "connected" }];
      if (call.url.host === "backboard.railway.com") return { data: { domains: { customDomains: [{ id: "dom-9", domain: "app.greenlawn.com", status: routed }] } } };
      return [];
    });
    await runAddressTask(before, adminClient(before));
    expect(calls.filter((c) => c.url.host === "backboard.railway.com").map((c) => c.body.query.match(/\{\s*(\w+)/)[1])).toEqual(["domains"]);
    expect(calls.find((c) => c.path === "web_address" && c.method === "PATCH")?.body).toMatchObject({
      automatic: true,
      railway_domain_id: "dom-9",
      railway_domain_added: false,
      error: null,
      records: expect.arrayContaining([expect.objectContaining({ type: "CNAME", host: "app", value: "abc123.up.railway.app" })]),
    });
  });

  it("leaves an address set up by hand alone without Railway access", async () => {
    const calls = serve((call) => {
      if (call.path === "web_address" && call.method === "GET") return [{ ...waiting, automatic: false, railway_domain_id: null }];
      if (call.path === "integrations") return [];
      return [];
    });
    await runAddressTask({ ...env, APP_URL: "https://crewtavo-production.up.railway.app" }, adminClient(env));
    expect(calls.some((c) => c.url.host === "backboard.railway.com" || c.method === "PATCH")).toBe(false);
  });

  it("gives up on a switch that never came back", async () => {
    const calls = serve((call) => (call.path === "web_address" && call.method === "GET" ? [{ ...waiting, status: "switching", switching_at: "2026-01-01T00:00:00Z" }] : []));
    await runAddressTask({ ...env, APP_URL: "https://crewtavo-production.up.railway.app" }, adminClient(env));
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ status: "failed" });
  });
});

const readyStatus: RailwayDomainStatus = {
  verified: true,
  certificateStatus: "CERTIFICATE_STATUS_TYPE_VALID",
  certificateErrorMessage: null,
  verificationDnsHost: "_railway-verify.app",
  verificationToken: "railway-verify=tok",
  dnsRecords: [],
};

describe("old addresses", () => {
  const done = [{ domain: "app.greenlawn.com", status: "done", from_url: "https://crewtavo-production.up.railway.app", previous_urls: ["https://crewtavo-production.up.railway.app"] }];
  const page = (url: string, accept = "text/html") => new Request(url, { headers: { accept, host: new URL(url).host, "x-forwarded-proto": "https" } });

  it("forwards pages to the new address, but never API calls or client links", async () => {
    serve((call) => (call.path === "web_address" ? done : []));
    expect(await forwardTo(env, page("https://crewtavo-production.up.railway.app/schedule?day=2026-10-20"))).toBe("https://app.greenlawn.com/schedule?day=2026-10-20");
    for (const path of ["/api/health", "/hub/abc", "/book/acme/quote", "/auth/v1/verify", "/.well-known/crewtavo-instance"]) {
      expect(await forwardTo(env, page(`https://crewtavo-production.up.railway.app${path}`)), path).toBeNull();
    }
    expect(await forwardTo(env, page("https://crewtavo-production.up.railway.app/sw.js", "*/*"))).toBeNull();
    expect(await forwardTo(env, page("https://app.greenlawn.com/schedule"))).toBeNull();
    expect(await forwardTo(env, page("https://someone-else.example/schedule"))).toBeNull();
  });

  it("doesn't forward before a switch is done", async () => {
    serve((call) => (call.path === "web_address" ? [{ ...done[0], status: "waiting" }] : []));
    expect(await forwardTo(env, page("https://crewtavo-production.up.railway.app/schedule"))).toBeNull();
  });

  it("still takes texts Twilio signs for the old address", async () => {
    serve((call) => (call.path === "web_address" ? done : call.path === "clients" ? [] : []));
    const withTwilio = { ...env, TWILIO_AUTH_TOKEN: "twilio-token" };
    const form = { From: "+15405550163", Body: "Yes please" };
    const signature = await twilioSignature("twilio-token", "https://crewtavo-production.up.railway.app/api/webhooks/twilio", form);
    const res = await app.request("/api/webhooks/twilio", { method: "POST", headers: { "x-twilio-signature": signature }, body: new URLSearchParams(form) }, withTwilio);
    expect(res.status).toBe(200);
  });

  it("answers assistants on the address they were added with", async () => {
    serve((call) => (call.path === "web_address" ? done : []));
    const old = await app.request("https://crewtavo-production.up.railway.app/.well-known/oauth-protected-resource/mcp", { headers: { host: "crewtavo-production.up.railway.app", "x-forwarded-proto": "https" } }, { ...env, CREWTAVO_GATEWAY: "1" });
    expect(await old.json()).toMatchObject({ resource: "https://crewtavo-production.up.railway.app/mcp", authorization_servers: ["https://app.greenlawn.com/auth/v1"] });
    const stranger = await app.request("https://evil.example/.well-known/oauth-protected-resource/mcp", { headers: { host: "evil.example" } }, env);
    expect(await stranger.json()).toMatchObject({ resource: "https://app.greenlawn.com/mcp" });
  });

  it("names the instance without giving anything away", async () => {
    const res = await app.request("/.well-known/crewtavo-instance", {}, env);
    const { instance } = (await res.json()) as { instance: string };
    expect(instance).toBe(await instanceFingerprint(env));
    expect(instance).toMatch(/^[\w-]{24}$/);
    expect(instance).not.toBe(await instanceFingerprint({ ...env, ENCRYPTION_KEY: btoa("z".repeat(32)) }));
  });
});

describe("Cloudflare", () => {
  const records = [
    { type: "CNAME" as const, name: "app.greenlawn.com", value: "abc123.up.railway.app" },
    { type: "TXT" as const, name: "_railway-verify.app.greenlawn.com", value: "railway-verify=tok" },
  ];
  const ok = (result: unknown) => Response.json({ success: true, result });

  it("adds what's missing, skips what's there, and keeps nothing", async () => {
    const calls = serve((call) => {
      if (call.url.pathname === "/client/v4/zones") return ok([{ id: "z1", name: "greenlawn.com" }]);
      if (call.method === "GET") return ok(call.url.searchParams.get("name") === "app.greenlawn.com" ? [{ type: "CNAME", content: "abc123.up.railway.app" }] : []);
      return ok({ id: "r1" });
    });
    expect(await addCloudflareRecords(" cf-token ", "greenlawn.com", records)).toBe(1);
    const posted = calls.filter((c) => c.method === "POST");
    expect(posted.map((c) => c.body)).toEqual([expect.objectContaining({ type: "TXT", name: "_railway-verify.app.greenlawn.com", content: "railway-verify=tok" })]);
  });

  it("never replaces a record that's in the way", async () => {
    const calls = serve((call) => {
      if (call.url.pathname === "/client/v4/zones") return ok([{ id: "z1", name: "greenlawn.com" }]);
      if (call.method === "GET") return ok(call.url.searchParams.get("name") === "app.greenlawn.com" ? [{ type: "A", content: "192.0.2.10" }] : []);
      return ok({});
    });
    await expect(addCloudflareRecords("cf-token", "greenlawn.com", records)).rejects.toThrow("already has a A record");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains a token that can't see the domain", async () => {
    serve(() => ok([]));
    await expect(addCloudflareRecords("cf-token", "greenlawn.com", records)).rejects.toThrow("can't see greenlawn.com");
  });
});

describe("routes", () => {
  it("only exist in an instance", async () => {
    const res = await app.request("/api/address", {}, { ...env, CREWTAVO_SINGLE_COMPANY: undefined });
    expect(res.status).toBe(404);
  });

  it("come back from Railway with a code, never a message", async () => {
    const res = await app.request("/api/railway/callback?state=forged&code=abc", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.greenlawn.com/settings?tab=address&railway=expired");
  });

  it("go back to setup when that's where the owner connected from", async () => {
    const state = await signToken(env, { company: "co-1", user: "user-1", purpose: "railway", return_to: "setup", nonce: "n1", exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await app.request(`/api/railway/callback?state=${encodeURIComponent(state)}&error=access_denied`, { headers: { cookie: "crewtavo_railway=n1.verifier" } }, env);
    expect(res.headers.get("location")).toBe("https://app.greenlawn.com/?railway=cancelled");
  });

  it("forget a Login with Railway client Railway refuses, so the next try registers a new one", async () => {
    const secret = await encryptJson(env, { extra: { method: "oauth", client_id: "cid", client_secret: "sec", redirect_uri: "https://app.greenlawn.com/api/railway/callback", scope: SCOPE } });
    const calls = serve((call) => {
      if (call.path === "integration_secrets" && call.method === "GET") return [{ ciphertext: secret }];
      if (call.url.pathname === "/oauth/token") return Response.json({ error: "invalid_client" }, { status: 401 });
      return [];
    });
    const state = await signToken(env, { company: "co-1", user: "user-1", purpose: "railway", return_to: "hosting", nonce: "n1", exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await app.request(`/api/railway/callback?state=${encodeURIComponent(state)}&code=abc`, { headers: { cookie: "crewtavo_railway=n1.verifier" } }, env);
    expect(res.headers.get("location")).toBe("https://app.greenlawn.com/settings?tab=hosting&railway=error");
    const forgot = calls.filter((c) => c.path === "integration_secrets" && c.method === "DELETE");
    expect(forgot.map((c) => [c.url.searchParams.get("company_id"), c.url.searchParams.get("provider")])).toEqual([["eq.co-1", "eq.railway"]]);
  });

  it("aren't there off Railway", async () => {
    const res = await app.request("/api/railway/callback?state=x&code=abc", {}, { ...env, RAILWAY_PROJECT_ID: undefined, RAILWAY_PUBLIC_DOMAIN: undefined });
    expect(res.status).toBe(404);
  });
});

describe("the Railway connection", () => {
  const oauth = (refreshedAt: number) =>
    encryptJson(env, { access_token: "at", refresh_token: "rt-old", expires_at: Date.now() - 1, extra: { method: "oauth", client_id: "cid", client_secret: "sec", redirect_uri: "https://x/cb", refreshed_at: String(refreshedAt) } });

  it("refreshes a sign-in that hasn't rotated in a month, and leaves fresh ones alone", async () => {
    const stale = await oauth(Date.now() - KEEP_ALIVE_MS - 1000);
    const fresh = await oauth(Date.now() - 1000);
    const calls = serve((call) => {
      if (call.path === "integrations") return [{ company_id: "co-stale" }, { company_id: "co-fresh" }];
      if (call.path === "integration_secrets" && call.method === "GET") return [{ ciphertext: call.url.searchParams.get("company_id") === "eq.co-stale" ? stale : fresh }];
      if (call.url.pathname === "/oauth/token") return { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 };
      return [];
    });
    expect(await keepRailwayAlive(env, adminClient(env))).toEqual({ refreshed: 1, lapsed: 0 });
    expect(calls.filter((c) => c.url.pathname === "/oauth/token")).toHaveLength(1);
    const saved = calls.find((c) => c.path === "integration_secrets" && c.method === "POST")!;
    expect(await decryptJson(env, saved.body.ciphertext)).toMatchObject({ access_token: "at-new", refresh_token: "rt-new" });
  });

  it("marks the connection lapsed when Railway refuses the refresh", async () => {
    const stale = await oauth(0);
    const calls = serve((call) => {
      if (call.path === "integrations" && call.method === "GET") return [{ company_id: "co-1" }];
      if (call.path === "integration_secrets") return [{ ciphertext: stale }];
      if (call.url.pathname === "/oauth/token") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return [];
    });
    expect(await keepRailwayAlive(env, adminClient(env))).toEqual({ refreshed: 0, lapsed: 1 });
    expect(calls.find((c) => c.path === "integrations" && c.method === "PATCH")?.body).toMatchObject({ status: "error", last_error: expect.stringContaining("Connect Railway again") });
    // A refused refresh token is no reason to drop the client.
    expect(calls.some((c) => c.path === "integration_secrets" && c.method === "DELETE")).toBe(false);
  });

  it("forgets the client when Railway refuses it outright on a refresh", async () => {
    const stale = await oauth(0);
    const calls = serve((call) => {
      if (call.path === "integrations" && call.method === "GET") return [{ company_id: "co-1" }];
      if (call.path === "integration_secrets" && call.method === "GET") return [{ ciphertext: stale }];
      if (call.url.pathname === "/oauth/token") return Response.json({ error: "invalid_client" }, { status: 401 });
      return [];
    });
    expect(await keepRailwayAlive(env, adminClient(env))).toEqual({ refreshed: 0, lapsed: 1 });
    expect(calls.filter((c) => c.path === "integration_secrets" && c.method === "DELETE")).toHaveLength(1);
  });

  it("marks the setup step without losing the business's other settings", async () => {
    const calls = serve((call) => (call.path === "companies" && call.method === "GET" ? [{ settings: { payment_terms_days: 30 } }] : []));
    await setRailwaySetup(adminClient(env), "co-1", "pending");
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ settings: { payment_terms_days: 30, railway_setup: "pending" } });
  });

  it("offers domains already on Railway, but not the one in use", async () => {
    const secret = await encryptJson(env, { api_key: "project-token", extra: { method: "token" } });
    serve((call) => {
      if (call.path === "web_address") return [];
      if (call.path === "companies") return [{ website: null, email: null }];
      if (call.path === "integrations") return [{ status: "connected", settings: {}, last_error: null }];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      if (call.url.host === "backboard.railway.com") {
        const custom = (domain: string, verified: boolean) => ({ id: domain, domain, status: { ...readyStatus, verified } });
        return { data: { domains: { customDomains: [custom("app.greenlawn.com", true), custom("greenlawnco.com", true)] } } };
      }
      return [];
    });
    const overview = await addressOverview(env, adminClient(env), "co-domains");
    expect(overview.railway).toMatchObject({ connected: true, domains: [{ domain: "greenlawnco.com", verified: true, certificate: "issued" }] });
  });
});
