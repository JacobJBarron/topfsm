import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";

// Stand-ins for the signed-in person's Supabase client and the service-role client: tables of rows
// that eq, neq and in filter, and search_sops answering with `hits`. Claude itself is replaced by
// `complete`, which keeps what it was asked.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  hits: [] as Row[],
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  completions: [] as Array<{ apiKey?: string | null; prompt: string; system?: string }>,
}));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (fn: string, args: Record<string, unknown>) => (state.rpcs.push({ fn, args }), { data: state.hits, error: null }),
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
      };
      return builder;
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
vi.mock("../src/services/ai", async (original) => ({
  ...(await original<typeof import("../src/services/ai")>()),
  complete: async (_env: Env, options: { apiKey?: string | null; prompt: string; system?: string }) => {
    state.completions.push({ apiKey: options.apiKey, prompt: options.prompt, system: options.system });
    return '{"subject": "Spring is here", "body": "Book your aeration."}';
  },
}));
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
} as Env;
// Uniform Paving added its own Anthropic key; Victor Lawn took its key out again but sends email from its own mailbox.
const UNIFORM = "00000000-0000-4000-8000-0000000000a1";
const VICTOR = "00000000-0000-4000-8000-0000000000a2";
const request = (path: string, body?: unknown) =>
  app.request(`/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer token", "X-Company-Id": UNIFORM, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

const member = (company_id: string, name: string, role: string) => ({ company_id, user_id: "viewer", active: true, role, role_id: null, company: { id: company_id, name, slug: name, trade_preset: "paving", timezone: "America/New_York", currency: "USD", settings: {} } });

async function addKeys() {
  state.tables = {
    profiles: [{ user_id: "viewer", email: "una@uniform.test", full_name: "Una", phone: null }],
    memberships: [member(UNIFORM, "Uniform Paving", "owner"), member(VICTOR, "Victor Lawn", "field_crew")],
    companies: [{ id: UNIFORM, name: "Uniform Paving", trade_preset: "paving" }],
    integrations: [
      { company_id: UNIFORM, provider: "anthropic", status: "connected" },
      { company_id: VICTOR, provider: "anthropic", status: "disconnected" },
      { company_id: VICTOR, provider: "email", status: "connected" },
    ],
    integration_secrets: [{ company_id: UNIFORM, provider: "anthropic", ciphertext: await encryptJson(env, { api_key: "sk-ant-uniform-own-key" }) }],
  };
}

afterEach(() => {
  state.tables = {};
  state.hits = [];
  state.rpcs = [];
  state.completions = [];
});

describe("a business's own Anthropic key", () => {
  it("turns AI on for that business in the app, without one on the server", async () => {
    await addKeys();
    const res = await request("/me");
    expect(res.status).toBe(200);
    const { memberships } = (await res.json()) as { memberships: Array<{ company: { id: string }; ai_connected: boolean; email_connected: boolean }> };
    expect(memberships.find((m) => m.company.id === UNIFORM)).toMatchObject({ ai_connected: true, email_connected: false });
    expect(memberships.find((m) => m.company.id === VICTOR)).toMatchObject({ ai_connected: false, email_connected: true });
    // The server has no key of its own, so the instance-wide switch stays off.
    expect(((await (await app.request("/api/config", {}, env)).json()) as { features: { ai: boolean } }).features.ai).toBe(false);
  });

  it("answers Ask from guides with any of the question's words, using the business's key", async () => {
    await addKeys();
    state.hits = [{ id: "g1", title: "Sealcoating a driveway", body_text: "Let the sealer cure 24 hours before driving on it." }];
    const res = await request("/kb/ask", { question: "How long does sealer need to dry before cars drive on it?" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: expect.any(String), sources: [{ id: "g1", title: "Sealcoating a driveway" }] });
    expect(state.rpcs).toEqual([{ fn: "search_sops", args: { p_company: UNIFORM, p_query: "How long does sealer need to dry before cars drive on it?", p_limit: 4, p_any: true } }]);
    expect(state.completions).toEqual([{ apiKey: "sk-ant-uniform-own-key", prompt: expect.stringContaining("[1] Sealcoating a driveway"), system: expect.any(String) }]);
  });

  it("says so when no guide has any of the words, without asking Claude", async () => {
    await addKeys();
    const body = (await (await request("/kb/ask", { question: "Where do I park the trailer?" })).json()) as { answer: string; sources: unknown[] };
    expect(body).toEqual({ answer: expect.stringContaining("couldn't find a guide"), sources: [] });
    expect(state.completions).toEqual([]);
  });

  it("writes campaign drafts and rewrites with it too", async () => {
    await addKeys();
    expect((await request("/campaigns/draft", { goal: "Spring aeration special" })).status).toBe(200);
    expect((await request("/ai/rewrite", { text: "we r coming tmrw" })).status).toBe(200);
    expect(state.completions.map((c) => c.apiKey)).toEqual(["sk-ant-uniform-own-key", "sk-ant-uniform-own-key"]);
  });

  it("drafts campaigns with the Client Hub link their clicks and bookings are counted by", async () => {
    await addKeys();
    const res = await request("/campaigns/draft", { goal: "Spring aeration special" });
    // The draft came back without {{link}}, so it's put in on a line of its own.
    expect(await res.json()).toEqual({ subject: "Spring is here", body: "Book your aeration.\n\n{{link}}" });
    const system = state.completions.at(-1)!.system!;
    expect(system).toContain("no placeholders other than {{client.first_name}}, {{company.name}}, {{company.phone}} and {{link}}");
    expect(system).toContain("put it alone on its own line, just before the sign-off, and it becomes a Request work button");
  });
});
