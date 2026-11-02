import { canMakeResetLink, ROLES } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { MIN_RECOVERY_CODE, newSpareKeys, normalizeSpareKey, RECOVERY_WINDOW_MS, recoverySetting, spareKeyHash } from "../src/lib/recovery";

const base: Env = {
  SUPABASE_URL: "https://abcd1234.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
};

describe("who can make a reset link for whom", () => {
  it("only for someone strictly below you", () => {
    const allowed = Object.fromEntries(ROLES.map((r) => [r, ROLES.filter((t) => canMakeResetLink(r, t))]));
    expect(allowed).toEqual({
      owner: ["admin", "office", "estimator", "crew_lead", "field_crew"],
      admin: ["office", "estimator", "crew_lead", "field_crew"],
      office: [],
      estimator: [],
      crew_lead: [],
      field_crew: [],
      // A sub signs in with a link from their page under Subs, never a reset link.
      subcontractor: [],
    });
  });
});

describe("owner recovery setting", () => {
  const code = "mowing season starts in april";
  const started = 1_800_000_000_000;

  it("is off unless both variables are set and the code is long enough", () => {
    expect(recoverySetting(base, started, started)).toEqual({ on: false, reason: "unset" });
    expect(recoverySetting({ ...base, CREWTAVO_RECOVERY_EMAIL: "pat@example.com" }, started, started)).toEqual({ on: false, reason: "unset" });
    expect(recoverySetting({ ...base, CREWTAVO_RECOVERY_EMAIL: "pat@example.com", CREWTAVO_RECOVERY_CODE: "x".repeat(MIN_RECOVERY_CODE - 1) }, started, started)).toEqual({ on: false, reason: "short" });
  });

  it("works for an hour after the server starts, then turns itself off", () => {
    const env = { ...base, CREWTAVO_RECOVERY_EMAIL: " Pat@Example.com ", CREWTAVO_RECOVERY_CODE: ` ${code} ` };
    expect(recoverySetting(env, started + 1000, started)).toMatchObject({ on: true, email: "pat@example.com", code });
    expect(recoverySetting(env, started + RECOVERY_WINDOW_MS + 1, started)).toEqual({ on: false, reason: "expired" });
  });

});

describe("spare keys", () => {
  it("come in sets of eight easy-to-read, one-of-a-kind codes", () => {
    const keys = newSpareKeys();
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
    for (const key of keys) expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("are read the way people type them", () => {
    expect(normalizeSpareKey(" 7k4m pq2x-9drf ")).toBe("7K4MPQ2X9DRF");
    expect(normalizeSpareKey("O0IL-1111-0000")).toBe("001111110000");
  });

  it("are tied to one account", async () => {
    expect(await spareKeyHash(base, "user-1", "7K4M-PQ2X-9DRF")).toBe(await spareKeyHash(base, "user-1", "7k4mpq2x9drf"));
    expect(await spareKeyHash(base, "user-1", "7K4M-PQ2X-9DRF")).not.toBe(await spareKeyHash(base, "user-2", "7K4M-PQ2X-9DRF"));
  });
});

describe("POST /api/auth/recover", () => {
  afterEach(() => vi.unstubAllGlobals());
  const PAT = "11111111-1111-4111-8111-111111111111";
  const withCode = { ...base, CREWTAVO_RECOVERY_EMAIL: "pat@example.com", CREWTAVO_RECOVERY_CODE: "mowing season starts in april" };
  const recover = (e: object, body: object) =>
    app.request("/api/auth/recover", { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": "203.0.113.7" }, body: JSON.stringify(body) }, e);

  /**
   * A project with Pat's account. `claimed`: the server's code was used before. `spareKeyWorks`:
   * what spare_key_use answers. `mailbox`: whether Pat's company connected its email.
   */
  function supabase({ claimed = false, spareKeyWorks = false, mailbox = false } = {}) {
    const calls: Array<{ call: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ call: `${init?.method ?? "GET"} ${url.replace(/^https:\/\/abcd1234\.supabase\.co/, "")}`, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/rpc/rate_limit_hit")) return Response.json(true);
      if (url.includes("/rpc/spare_key_use")) return Response.json(spareKeyWorks);
      if (url.includes("/rpc/spare_keys_left")) return Response.json(5);
      if (url.includes("/rpc/user_id_for_email")) return Response.json(PAT);
      if (url.includes("/rest/v1/profiles")) return Response.json({ full_name: "Pat Owner" });
      if (url.includes("/rest/v1/memberships")) return Response.json([{ company_id: "c1" }]);
      if (url.includes("/rest/v1/integrations")) return Response.json(mailbox ? [{ company_id: "c1" }] : []);
      if (url.includes("/rest/v1/activity")) return new Response(null, { status: 201 });
      if (url.includes("/rest/v1/app_secrets")) {
        return claimed ? Response.json({ code: "23505", message: "duplicate key value violates unique constraint" }, { status: 409 }) : new Response(null, { status: 201 });
      }
      if (url.includes("/auth/v1/admin/users/")) return Response.json({ id: PAT, last_sign_in_at: "2026-10-01T00:00:00Z" });
      if (url.includes("/auth/v1/admin/generate_link")) return Response.json({ id: PAT, hashed_token: "hash123", action_link: "https://abcd1234.supabase.co/auth/v1/verify?token=x", verification_type: "recovery" });
      throw new Error(`unexpected ${url}`);
    });
    return calls;
  }
  const made = (calls: Array<{ call: string }>) => calls.some((c) => c.call.includes("generate_link"));

  it("lets the owner in with a spare key while email isn't set up, and tells them how many are left", async () => {
    const calls = supabase({ spareKeyWorks: true });
    const res = await recover(base, { email: "pat@example.com", code: "7k4m pq2x 9drf" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link: "https://ops.example.com/?token_hash=hash123&type=recovery", left: 5 });
    // The key is checked as a hash for Pat's account, however it was typed.
    const use = calls.find((c) => c.call.includes("/rpc/spare_key_use"));
    expect(use?.body).toEqual({ p_user: PAT, p_hash: await spareKeyHash(base, PAT, "7K4M-PQ2X-9DRF") });
  });

  it("takes a key file: the first key in it that still works, in one try", async () => {
    let tries = 0;
    const calls = supabase({ spareKeyWorks: true });
    const base_fetch = globalThis.fetch;
    // The file's first two keys were used already; the third works.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/rpc/spare_key_use")) return Response.json(++tries === 3);
      return base_fetch(input, init);
    });
    const res = await recover(base, { email: "pat@example.com", keys: ["Y0JZ-FZK1-FP0B", "Y67P-PEDG-JM9G", "C8X3-3VR9-B8GF", "6ZN5-1XRH-5R8R"] });
    expect(res.status).toBe(200);
    expect(tries).toBe(3); // stopped at the one that worked, so the fourth is still unused
    expect(calls.filter((c) => c.call.includes("/rpc/rate_limit_hit"))).toHaveLength(3); // one try: per visitor, account and overall
  });

  it("wants either a key or a key file's keys, and not a huge list", async () => {
    supabase({ spareKeyWorks: true });
    for (const body of [{ email: "pat@example.com" }, { email: "pat@example.com", code: "Y0JZ-FZK1-FP0B", keys: ["Y0JZ-FZK1-FP0B"] }, { email: "pat@example.com", keys: Array.from({ length: 21 }, () => "Y0JZ-FZK1-FP0B") }]) {
      expect((await recover(base, body)).status).toBe(400);
    }
  });

  it("refuses a key that doesn't match or was used, without making a link", async () => {
    const calls = supabase({ spareKeyWorks: false });
    const res = await recover(base, { email: "pat@example.com", code: "7K4M-PQ2X-9DRF" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/That didn't work/);
    expect(made(calls)).toBe(false);
  });

  it("doesn't take spare keys once the company can send email", async () => {
    let calls = supabase({ spareKeyWorks: true, mailbox: true });
    expect((await recover(base, { email: "pat@example.com", code: "7K4M-PQ2X-9DRF" })).status).toBe(400);
    expect(calls.some((c) => c.call.includes("spare_key_use"))).toBe(false);
    calls = supabase({ spareKeyWorks: true });
    expect((await recover({ ...base, RESEND_API_KEY: "re_1", EMAIL_FROM: "a@b.co" }, { email: "pat@example.com", code: "7K4M-PQ2X-9DRF" })).status).toBe(400);
    expect(calls.some((c) => c.call.includes("spare_key_use"))).toBe(false);
  });

  it("the server's code (the last resort) is claimed before the link is made, and works once", async () => {
    const calls = supabase();
    const res = await recover(withCode, { email: "PAT@example.com", code: " mowing season starts in april " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link: "https://ops.example.com/?token_hash=hash123&type=recovery", left: null });
    const claim = calls.findIndex((c) => c.call.startsWith("POST /rest/v1/app_secrets"));
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(calls.findIndex((c) => c.call.includes("generate_link")));

    supabase({ claimed: true });
    expect((await recover(withCode, { email: "pat@example.com", code: "mowing season starts in april" })).status).toBe(400);
  });

  it("a wrong server code is just a wrong key", async () => {
    const calls = supabase();
    for (const body of [{ email: "pat@example.com", code: "mowing season starts in may" }, { email: "sam@example.com", code: "mowing season starts in april" }]) {
      const res = await recover(withCode, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/That didn't work/);
    }
    expect(made(calls)).toBe(false);
  });
});

describe("POST /api/setup/owner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hands the new owner their spare keys, once", async () => {
    let saved: { p_user: string; p_hashes: string[] } | null = null;
    let users = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/rpc/rate_limit_hit")) return Response.json(true);
      if (url.includes("/rpc/spare_keys_replace")) {
        saved = JSON.parse(String(init?.body));
        return Response.json(8);
      }
      // The database is up and migrated (setup checks before making the account).
      if (url.includes("/auth/v1/settings")) return Response.json({});
      if (url.includes("/rest/v1/companies")) return Response.json([]);
      if (url.includes("/auth/v1/admin/users") && init?.method === "POST") {
        users = 1;
        return Response.json({ id: "22222222-2222-4222-8222-222222222222", email: "pat@example.com" });
      }
      if (url.includes("/auth/v1/admin/users")) return Response.json({ users: Array.from({ length: users }, () => ({ id: "22222222-2222-4222-8222-222222222222" })), aud: "authenticated" });
      throw new Error(`unexpected ${url}`);
    });
    const res = await app.request(
      "/api/setup/owner",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: "Pat Owner", email: "pat@example.com", password: "long-enough-pw" }) },
      { ...base, CREWTAVO_SINGLE_COMPANY: "1" },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { spare_keys: string[] };
    expect(body.spare_keys).toHaveLength(8);
    // Only hashes reach the database, each tied to the new account.
    expect(saved!.p_user).toBe("22222222-2222-4222-8222-222222222222");
    expect(saved!.p_hashes).toEqual(await Promise.all(body.spare_keys.map((k) => spareKeyHash(base, "22222222-2222-4222-8222-222222222222", k))));
    expect(JSON.stringify(saved)).not.toContain(body.spare_keys[0]);
  });
});

describe("POST /api/auth/email-link in an instance without email", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says it can't send, the same way for any address", async () => {
    const looked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      looked.push(url);
      if (url.includes("/rpc/rate_limit_hit")) return Response.json(true);
      if (url.includes("/rest/v1/integrations")) return Response.json([]);
      throw new Error(`unexpected ${url}`);
    });
    const env = { ...base, CREWTAVO_SINGLE_COMPANY: "1" };
    for (const email of ["owner@example.com", "nobody@example.com"]) {
      const res = await app.request("/api/auth/email-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, kind: "recovery" }) }, env);
      expect(await res.json()).toEqual({ sent: false, reason: "email_off" });
    }
    // It never looked anyone up.
    expect(looked.some((u) => u.includes("/profiles"))).toBe(false);
  });
});

describe("the team's record of reset links and new spare keys", () => {
  afterEach(() => vi.unstubAllGlobals());
  const PAT = "11111111-1111-4111-8111-111111111111";
  const SAM = "33333333-3333-4333-8333-333333333333";
  const CO = "0b0a0000-0000-4000-8000-000000000001";
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: PAT, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Company-Id": CO };

  /** Pat owns the company and Sam works in it; activity rows are kept with the key that wrote them. */
  function supabase() {
    const activity: Array<{ key: string | null; row: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const key = new Headers(init?.headers).get("apikey");
      if (url.includes("/rest/v1/activity")) {
        activity.push({ key, row: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 201 });
      }
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: PAT, aud: "authenticated" });
      if (url.includes("/rpc/rate_limit_hit")) return Response.json(true);
      if (url.includes("/rpc/spare_keys_replace")) return Response.json(8);
      if (url.includes("/rest/v1/memberships") && url.includes(`user_id=eq.${SAM}`)) return Response.json([{ company_id: CO, role: "field_crew", active: true }]);
      if (url.includes("/rest/v1/memberships")) return Response.json([{ company_id: CO, role: "owner", role_id: null, subcontractor_id: null }]);
      if (url.includes("/rest/v1/profiles") && url.includes(`user_id=eq.${SAM}`)) return Response.json([{ email: "sam@example.com", full_name: "Sam Crew" }]);
      if (url.includes("/rest/v1/profiles")) return Response.json([{ email: "pat@example.com", full_name: "Pat Owner" }]);
      if (url.includes("/rest/v1/companies")) return Response.json([{ name: "Green Lawn", email: null }]);
      if (url.includes("/rest/v1/notifications")) return new Response(null, { status: 201 });
      if (url.includes("/rest/v1/integration")) return Response.json([]);
      if (url.includes("/token?grant_type=password")) return Response.json({ access_token: "throwaway", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 2_000_000_000, user: { id: PAT, aud: "authenticated" } });
      if (url.includes("/logout")) return new Response(null, { status: 204 });
      if (url.includes("/auth/v1/admin/users/")) return Response.json({ id: SAM, last_sign_in_at: "2026-10-01T00:00:00Z" });
      if (url.includes("/auth/v1/admin/generate_link")) return Response.json({ id: SAM, hashed_token: "hash123", verification_type: "recovery" });
      throw new Error(`unexpected ${url}`);
    });
    return activity;
  }

  // Signed-in people can't add to the activity themselves (20261018000100_audit_fixes.sql).
  it("records a reset link as the server, with who made it", async () => {
    const activity = supabase();
    const res = await app.request(`/api/team/${SAM}/password-link`, { method: "POST", headers }, base);
    expect(res.status).toBe(200);
    expect(activity).toEqual([
      { key: "sb_secret_test", row: { company_id: CO, actor_id: PAT, verb: "member.password_link", subject_type: "member", subject_id: SAM, summary: "Pat Owner made a password reset link for Sam Crew" } },
    ]);
  });

  it("records new spare keys as the server, with who made them", async () => {
    const activity = supabase();
    const res = await app.request("/api/account/spare-keys", { method: "POST", headers, body: JSON.stringify({ password: "right" }) }, base);
    expect(res.status).toBe(200);
    expect(activity).toEqual([
      { key: "sb_secret_test", row: { company_id: CO, actor_id: PAT, verb: "member.spare_keys", subject_type: "member", subject_id: PAT, summary: "Pat Owner made new spare keys" } },
    ]);
  });
});
