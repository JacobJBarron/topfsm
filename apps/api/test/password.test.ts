/**
 * Changing your password (POST /api/account/password), and the password check other changes ask
 * for (lib/auth.ts confirmPassword): it goes to Auth itself, never through the instance's gateway,
 * whose sign-in pause a stranger could set off for the owner's email.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { TOO_MANY_SIGN_INS, WRONG_PASSWORD } from "../src/lib/auth";

const PAT = "11111111-1111-4111-8111-111111111111";
const hosted: Env = { SUPABASE_URL: "https://abcd1234.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://ops.example.com" };
// An instance: SUPABASE_URL is this server's own gateway (lib/stack.ts), Auth is on the private network.
const instance = { ...hosted, SUPABASE_URL: "http://127.0.0.1:8080", JWT_SECRET: "x".repeat(40), SUPABASE_AUTH_URL: "http://auth.railway.internal:9999" } as Env;

const NOW = Math.floor(Date.now() / 1000);
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** Pat's session, signed in by `method` `ago` seconds back (Auth checks the signature: GET /user below). */
const session = (method: string, ago = 0, providers = ["email"]) =>
  `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: PAT, role: "authenticated", session_id: "s-1", exp: NOW + 3600, amr: [{ method, timestamp: NOW - ago }], app_metadata: { provider: providers[0], providers } })}.sig`;

/** Supabase, with Pat's password `password`; `auth` answers the password check instead when set. */
function services({ password = "old password 1", auth }: { password?: string; auth?: number } = {}) {
  const calls = { checks: [] as string[], updates: [] as unknown[], logouts: [] as string[], limits: [] as string[] };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.includes("/rpc/rate_limit_hit")) {
      calls.limits.push(body.p_key);
      return Response.json(true);
    }
    if (url.includes("/rest/v1/profiles")) return Response.json([{ email: "pat@example.com", full_name: "Pat Owner" }]);
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: PAT, aud: "authenticated", email: "pat@example.com" });
    if (url.includes("/token?grant_type=password")) {
      calls.checks.push(url.split("/token")[0]!);
      if (auth) return Response.json({ code: auth, error_code: "over_request_rate_limit", msg: "Too many" }, { status: auth });
      if (body.password !== password) return Response.json({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
      return Response.json({ access_token: "throwaway", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: NOW + 3600, user: { id: PAT, aud: "authenticated" } });
    }
    if (url.includes("/logout")) {
      calls.logouts.push(`${url.split("?")[1]} ${new Headers(init?.headers).get("authorization")}`);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith(`/auth/v1/admin/users/${PAT}`) && init?.method === "PUT") {
      calls.updates.push(body);
      return Response.json({ id: PAT });
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
  return calls;
}

const change = (token: string, body: object, env: Env = hosted) =>
  app.request("/api/account/password", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }, env);
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

afterEach(() => vi.unstubAllGlobals());

describe("changing your password", () => {
  it("needs the current one, then ends every other sign-in", async () => {
    const calls = services();
    const token = session("password", 3 * 86400);
    const wrong = await change(token, { current: "a guess", password: "new password 2" });
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe(WRONG_PASSWORD);
    const missing = await change(token, { password: "new password 2" });
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toBe("Enter your current password. If you don't have one yet, sign out and in again, then set it within 10 minutes.");
    expect(calls.updates).toEqual([]);

    const res = await change(token, { current: "old password 1", password: "new password 2" });
    expect(res.status).toBe(200);
    expect(calls.updates).toEqual([{ password: "new password 2" }]);
    // The check's throwaway session, then everyone else's but this one.
    expect(calls.logouts).toEqual(["scope=local Bearer throwaway", `scope=others Bearer ${token}`]);
    // Counted for this sign-in, and for Pat.
    expect(calls.limits).toEqual(Array(2).fill([`account-password:${PAT}:s-1`, `account-password:${PAT}`]).flat());
  });

  it("keeps the rules for a new one", async () => {
    const calls = services();
    const res = await change(session("password"), { current: "old password 1", password: "short" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("Password is too short.");
    expect(calls.checks).toEqual([]);
  });

  it("lets someone without one yet choose a first one within 10 minutes of signing in", async () => {
    const calls = services();
    // Signed in with Google, or after an invitation they skipped with an emailed link or code.
    for (const [method, providers] of [["oauth", ["google"]], ["magiclink", ["email"]], ["invite", ["email"]]] as const) {
      expect((await change(session(method, 5 * 60, [...providers]), { password: "first password" })).status, method).toBe(200);
    }
    const stale = await change(session("oauth", 11 * 60, ["google"]), { password: "first password" });
    expect(stale.status).toBe(400);
    expect(await errorOf(stale)).toContain("sign out and in again");
    expect(calls.updates).toHaveLength(3);
    expect(calls.checks).toEqual([]);
  });
});

describe("the password check", () => {
  it("asks Auth itself in an instance, not the gateway's paused sign-in", async () => {
    const calls = services();
    expect((await change(session("password"), { current: "old password 1", password: "new password 2" }, instance)).status).toBe(200);
    expect(calls.checks).toEqual(["http://auth.railway.internal:9999"]);
    expect(calls.logouts[0]).toBe("scope=local Bearer throwaway");
  });

  it("asks the Supabase project's Auth otherwise", async () => {
    const calls = services();
    expect((await change(session("password"), { current: "old password 1", password: "new password 2" })).status).toBe(200);
    expect(calls.checks).toEqual(["https://abcd1234.supabase.co/auth/v1"]);
  });

  it("says when Auth is holding sign-ins back, or can't be reached, instead of calling the password wrong", async () => {
    services({ auth: 429 });
    const busy = await change(session("password"), { current: "old password 1", password: "new password 2" }, instance);
    expect(busy.status).toBe(429);
    expect(await errorOf(busy)).toBe(TOO_MANY_SIGN_INS);
    services({ auth: 503 });
    const down = await change(session("password"), { current: "old password 1", password: "new password 2" }, instance);
    expect(down.status).toBe(503);
    expect(await errorOf(down)).toBe("Couldn't check your password. Try again in a moment.");
  });
});
