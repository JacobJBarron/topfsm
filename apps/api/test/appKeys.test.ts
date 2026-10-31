import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { accessToken, type StoredSecret } from "../src/integrations/tokens";
import { decryptJson, encryptJson, signToken } from "../src/lib/crypto";
import type { Db } from "../src/lib/supabase";

// QuickBooks and Zoho Books with a business's own app at Intuit or Zoho, on a server that has none.

const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://crew.example.com",
};
const COMPANY = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";
const headers = { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" };

interface Query {
  table: string;
  calls: Array<[string, ...any[]]>;
}
const call = (q: Query, name: string) => q.calls.find(([n]) => n === name);
const verb = (q: Query) => q.calls.find(([n]) => ["insert", "upsert", "update", "delete"].includes(n))?.[0] ?? "select";
/** The provider a query is about, from .eq("provider", …) or .match({ provider }). */
const providerOf = (q: Query) => (q.calls.find(([n, k]) => n === "eq" && k === "provider")?.[2] as string | undefined) ?? (call(q, "match")?.[1]?.provider as string | undefined);

/** A database with the integrations and their encrypted secrets, kept like the real tables. */
function fakeDb() {
  const secrets = new Map<string, string>();
  const integrations = new Map<string, Record<string, unknown>>();
  const queries: Query[] = [];
  const answer = (q: Query) => {
    if (q.table === "memberships") return { data: { role: "owner", role_id: null } };
    if (q.table === "companies") return { data: { settings: {} } };
    if (q.table === "integration_secrets") {
      const provider = providerOf(q) ?? call(q, "upsert")?.[1]?.provider;
      if (verb(q) === "upsert") secrets.set(provider, call(q, "upsert")![1].ciphertext);
      if (verb(q) === "delete") secrets.delete(provider!);
      return { data: verb(q) === "select" && secrets.has(provider!) ? { ciphertext: secrets.get(provider!) } : null };
    }
    if (q.table === "integrations") {
      if (verb(q) === "upsert") {
        const row = call(q, "upsert")![1];
        integrations.set(row.provider, { ...integrations.get(row.provider), ...row });
      }
      if (verb(q) === "update") {
        const provider = providerOf(q)!;
        if (integrations.has(provider)) integrations.set(provider, { ...integrations.get(provider), ...call(q, "update")![1] });
      }
      return { data: verb(q) === "select" ? [...integrations.values()] : null };
    }
    return { data: [] };
  };
  const chain = (q: Query): unknown =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(() => ({ error: null, ...answer(q) })).then(resolve, reject)
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
    rpc: async () => ({ data: null, error: null }),
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  current.db = db;
  const secret = async (provider: string) => (secrets.has(provider) ? decryptJson<StoredSecret>(env, secrets.get(provider)!) : null);
  const keep = async (provider: string, value: StoredSecret) => {
    integrations.set(provider, { company_id: COMPANY, provider, status: "disconnected" });
    secrets.set(provider, await encryptJson(env, value));
  };
  return { db: db as unknown as Db, queries, integrations, secret, keep };
}

const saveKeys = (provider: string, body: Record<string, unknown>) => app.request(`/api/apps/${provider}/app-keys`, { method: "PUT", headers, body: JSON.stringify(body) }, env);
type AppsBody = { apps: Array<{ id: string; available: boolean; takes_app_keys?: boolean; app_keys?: Record<string, unknown> | null }> };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a business's own QuickBooks and Zoho apps", () => {
  it("aren't available on a server without its own until keys are saved", async () => {
    fakeDb();
    const res = await app.request("/api/apps", { headers }, env);
    const { apps } = (await res.json()) as AppsBody;
    for (const id of ["quickbooks", "zoho_books"]) expect(apps.find((a) => a.id === id)).toMatchObject({ available: false, takes_app_keys: true, app_keys: null });
    expect(apps.find((a) => a.id === "google_calendar")).not.toHaveProperty("takes_app_keys");
  });

  it("keep the keys encrypted, and show only the Client ID", async () => {
    const db = fakeDb();
    const res = await saveKeys("quickbooks", { client_id: "ABintuitClientId123", client_secret: "intuit-secret-value", sandbox: true });
    expect(res.status).toBe(200);
    expect(db.integrations.get("quickbooks")).toMatchObject({ status: "disconnected" });
    expect(await db.secret("quickbooks")).toEqual({ extra: { client_id: "ABintuitClientId123", client_secret: "intuit-secret-value", environment: "sandbox" } });

    const listed = await app.request("/api/apps", { headers }, env);
    const text = await listed.text();
    expect(text).not.toContain("intuit-secret-value");
    const qbo = (JSON.parse(text) as AppsBody).apps.find((a) => a.id === "quickbooks");
    expect(qbo).toMatchObject({ available: true, app_keys: { client_id: "ABintuitClientId123", sandbox: true, accounts_server: null } });
  });

  it("only take Zoho's own data centers", async () => {
    fakeDb();
    const res = await saveKeys("zoho_books", { client_id: "1000.ZOHOCLIENT", client_secret: "zoho-secret-value", accounts_server: "https://accounts.zoho.evil.example" });
    expect(res.status).toBe(400);
  });

  it("start Zoho's sign-in in the data center the app was made in", async () => {
    fakeDb();
    await saveKeys("zoho_books", { client_id: "1000.ZOHOCLIENT", client_secret: "zoho-secret-value", accounts_server: "https://accounts.zoho.eu" });
    const res = await app.request("/api/apps/zoho_books/connect", { method: "POST", headers }, env);
    const url = new URL(((await res.json()) as { authorization_url: string }).authorization_url);
    expect(url.origin + url.pathname).toBe("https://accounts.zoho.eu/oauth/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("1000.ZOHOCLIENT");
    expect(url.searchParams.get("redirect_uri")).toBe("https://crew.example.com/api/apps/zoho_books/callback");
  });

  it("sign in to QuickBooks with the business's app, and keep its keys with the tokens", async () => {
    const db = fakeDb();
    await db.keep("quickbooks", { extra: { client_id: "own-id", client_secret: "own-secret", environment: "sandbox" } });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/oauth2/v1/tokens/bearer")) return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
      return Response.json({ CompanyInfo: { CompanyName: "Meadows Exteriors" } });
    });
    const state = await signToken(env, { company: COMPANY, user: USER, provider: "quickbooks", nonce: "nonce-1", exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await app.request(`/api/apps/quickbooks/callback?${new URLSearchParams({ state, code: "code-1", realmId: "4620816365" })}`, { headers: { Cookie: "crewtavo_oauth_nonce=nonce-1" } }, env);

    expect(res.headers.get("location")).toBe("https://crew.example.com/apps/quickbooks?status=connected");
    expect(calls[0]!.init?.headers).toMatchObject({ Authorization: `Basic ${btoa("own-id:own-secret")}` });
    // Development keys only reach sandbox companies.
    expect(calls[1]!.url).toMatch(/^https:\/\/sandbox-quickbooks\.api\.intuit\.com\/v3\/company\/4620816365\/companyinfo/);
    expect(db.integrations.get("quickbooks")).toMatchObject({ status: "connected", account_label: "Meadows Exteriors", external_account_id: "4620816365" });
    expect(await db.secret("quickbooks")).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1", extra: { client_id: "own-id", client_secret: "own-secret", environment: "sandbox" } });
  });

  it("say so when the provider turns the keys down", async () => {
    const db = fakeDb();
    await db.keep("quickbooks", { extra: { client_id: "own-id", client_secret: "pasted-wrong" } });
    vi.stubGlobal("fetch", async () => Response.json({ error: "invalid_client" }, { status: 401 }));
    const state = await signToken(env, { company: COMPANY, user: USER, provider: "quickbooks", nonce: "nonce-1", exp: Math.floor(Date.now() / 1000) + 600 });
    const res = await app.request(`/api/apps/quickbooks/callback?${new URLSearchParams({ state, code: "code-1", realmId: "1" })}`, { headers: { Cookie: "crewtavo_oauth_nonce=nonce-1" } }, env);
    expect(new URL(res.headers.get("location")!).searchParams.get("message")).toBe("QuickBooks Online didn't accept the Client ID and secret. Check them on this page, then connect again.");
  });

  it("refresh the sign-in with the business's app", async () => {
    const db = fakeDb();
    const keys = { client_id: "1000.ZOHOCLIENT", client_secret: "zoho-secret-value", accounts_server: "https://accounts.zoho.eu", api_domain: "https://www.zohoapis.eu" };
    await db.keep("zoho_books", { access_token: "old", refresh_token: "refresh-1", expires_at: Date.now() + 60_000, extra: keys });
    const fetch = vi.fn(async () => Response.json({ access_token: "new", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetch);

    expect((await accessToken(env, db.db, COMPANY, "zoho_books")).token).toBe("new");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://accounts.zoho.eu/oauth/v2/token");
    expect(Object.fromEntries(init.body as URLSearchParams)).toMatchObject({ client_id: "1000.ZOHOCLIENT", client_secret: "zoho-secret-value", refresh_token: "refresh-1" });
    expect(await db.secret("zoho_books")).toMatchObject({ access_token: "new", refresh_token: "refresh-1", extra: keys });
  });

  it("keep the keys when disconnecting, so connecting again is one click", async () => {
    const db = fakeDb();
    await db.keep("quickbooks", { access_token: "access-1", refresh_token: "refresh-1", expires_at: Date.now() + 3_600_000, extra: { client_id: "own-id", client_secret: "own-secret" } });
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const res = await app.request("/api/apps/quickbooks/disconnect", { method: "POST", headers }, env);

    expect(res.status).toBe(200);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://developer.api.intuit.com/v2/oauth2/tokens/revoke");
    expect(init.headers).toMatchObject({ Authorization: `Basic ${btoa("own-id:own-secret")}` });
    expect(await db.secret("quickbooks")).toEqual({ extra: { client_id: "own-id", client_secret: "own-secret" } });
    expect(db.integrations.get("quickbooks")).toMatchObject({ status: "disconnected" });
  });

  it("sign out of the old app when new keys are saved, and forget them when removed", async () => {
    const db = fakeDb();
    await db.keep("quickbooks", { access_token: "access-1", refresh_token: "refresh-1", expires_at: Date.now() + 3_600_000, extra: { client_id: "old-id", client_secret: "old-secret" } });
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await saveKeys("quickbooks", { client_id: "new-client-id", client_secret: "new-client-secret" });

    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: `Basic ${btoa("old-id:old-secret")}` });
    expect(await db.secret("quickbooks")).toEqual({ extra: { client_id: "new-client-id", client_secret: "new-client-secret" } });

    const res = await app.request("/api/apps/quickbooks/app-keys", { method: "DELETE", headers }, env);
    expect(res.status).toBe(200);
    expect(await db.secret("quickbooks")).toBeNull();
  });
});

describe("a business's own Meta app", () => {
  it("is never available on the server, only with the business's own keys, and keeps a Configuration ID", async () => {
    const db = fakeDb();
    const before = (await (await app.request("/api/apps", { headers }, env)).json()) as AppsBody;
    expect(before.apps.find((a) => a.id === "meta")).toMatchObject({ available: false, takes_app_keys: true, app_keys: null });
    expect((await saveKeys("meta", { client_id: "1234567890123", client_secret: "meta-secret-value-0123456789", config_id: "not digits" })).status).toBe(400);
    expect((await saveKeys("meta", { client_id: "1234567890123", client_secret: "meta-secret-value-0123456789", config_id: "987654321" })).status).toBe(200);
    expect(await db.secret("meta")).toEqual({ extra: { client_id: "1234567890123", client_secret: "meta-secret-value-0123456789", config_id: "987654321" } });
    const after = (await (await app.request("/api/apps", { headers }, env)).json()) as AppsBody;
    expect(after.apps.find((a) => a.id === "meta")).toMatchObject({ available: true, app_keys: { client_id: "1234567890123", config_id: "987654321" } });
  });

  it("signs in at Meta with its Configuration ID", async () => {
    fakeDb();
    await saveKeys("meta", { client_id: "1234567890123", client_secret: "meta-secret-value-0123456789", config_id: "987654321" });
    const res = await app.request("/api/apps/meta/connect", { method: "POST", headers }, env);
    const url = new URL(((await res.json()) as { authorization_url: string }).authorization_url);
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.searchParams.get("config_id")).toBe("987654321");
    expect(url.searchParams.get("redirect_uri")).toBe("https://crew.example.com/api/apps/meta/callback");
  });

  it("keeps its keys, Configuration ID too, when disconnecting", async () => {
    const db = fakeDb();
    await db.keep("meta", { access_token: "long", expires_at: Date.now() + 86_400_000, extra: { client_id: "1234567890123", client_secret: "meta-secret", config_id: "987654321", user_id: "u1", page_id: "1", page_token: "pt" } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true })));
    expect((await app.request("/api/apps/meta/disconnect", { method: "POST", headers }, env)).status).toBe(200);
    expect(await db.secret("meta")).toEqual({ extra: { client_id: "1234567890123", client_secret: "meta-secret", config_id: "987654321" } });
  });
});
