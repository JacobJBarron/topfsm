import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { AbcClient, requestToken } from "../src/integrations/abcSupply";
import { decryptJson, encryptJson } from "../src/lib/crypto";

// Stand-ins for the signed-in person's Supabase client and the service-role client: tables of rows
// that eq, match and in filter, with insert, upsert, update and delete. ABC Supply is a fake fetch
// that answers like ABC's API does, and keeps what it was sent.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let change: { kind: "update"; values: Row } | { kind: "delete" } | null = null;
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const run = () => {
        if (change?.kind === "update") for (const row of rows()) Object.assign(row, change.values);
        if (change?.kind === "delete") state.tables[table] = (state.tables[table] ?? []).filter((row) => !filters.every((keep) => keep(row)));
        return { data: change ? null : rows(), error: null };
      };
      const add = (list: Row | Row[]) => {
        // Integrations are keyed by company and provider, with no id of their own.
        const keyed = table === "integrations" || table === "integration_secrets";
        const added = [list].flat().map((row) => (keyed ? row : { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row }));
        if (keyed) {
          state.tables[table] = (state.tables[table] ?? []).filter((row) => !added.some((a) => a.company_id === row.company_id && a.provider === row.provider));
        }
        state.tables[table] = [...(state.tables[table] ?? []), ...added];
        return Promise.resolve({ data: null, error: null });
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        match: (values: Row) => (filters.push((row) => Object.entries(values).every(([k, v]) => row[k] === v)), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        insert: add,
        upsert: add,
        update: (values: Row) => ((change = { kind: "update", values }), builder),
        delete: () => ((change = { kind: "delete" }), builder),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  });
  const user = client();
  const admin = client();
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
} as Env;
const ROOFER = "00000000-0000-4000-8000-0000000000c1";
const QUOTE = "00000000-0000-4000-8000-0000000000c2";
const ROOF = "00000000-0000-4000-8000-0000000000c3";
const EDGE = "00000000-0000-4000-8000-0000000000c4";
const send = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": ROOFER, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

const KEYS = { client_id: "0oa-client-id", client_secret: "client-secret-value", environment: "sandbox" as const };
const SHIP_TOS = {
  shipTos: [
    { name: "EASY ROOFING", number: "1163698", status: "active", address: { city: "MADISON", state: "WI" }, branches: [{ homeBranch: true, number: "18", name: "ABC Supply - Madison, WI" }] },
    { name: "OLD ACCOUNT", number: "999", status: "active", address: {}, branches: [] },
  ],
};

/** ABC's API, by path: what each call answers with. */
const abc = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const sent = (path: string) => abc.mock.calls.filter(([url]) => String(url).includes(path)).map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
function answer(prices: Record<string, number> = {}) {
  abc.mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes("/oauth2/")) return Response.json({ access_token: "token-1", expires_in: 1800, token_type: "Bearer" });
    if (u.includes("/search/accounts")) return Response.json(SHIP_TOS);
    if (u.includes("/pricing/v2/prices")) {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        lines: body.lines.map((l: { id: string; itemNumber: string; quantity: number; uom: string }) =>
          l.itemNumber in prices
            ? { id: l.id, itemNumber: l.itemNumber, quantity: l.quantity, uom: l.uom, unitPrice: prices[l.itemNumber], status: { code: "OK", message: "Priced Successfully" } }
            : { id: l.id, itemNumber: l.itemNumber, unitPrice: 0, status: { code: "Error", message: `Cannot price item ${l.itemNumber}. Call for pricing.` } },
        ),
      });
    }
    if (u.includes("/product/v1/items/")) {
      const number = decodeURIComponent(u.split("/items/")[1]!.split("?")[0]!);
      return Response.json({ itemNumber: number, itemDescription: `Item ${number}`, isDimensional: false, uoms: [{ name: "Bundle", code: "BD", description: "stocking" }, { name: "Square", code: "SQ", description: "costing" }] });
    }
    return new Response("{}", { status: 404 });
  });
}

beforeEach(() => {
  abc.mockReset();
  vi.stubGlobal("fetch", abc);
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.tables = {};
});

async function roofer({ connected = true }: { connected?: boolean } = {}) {
  state.tables = {
    memberships: [{ company_id: ROOFER, user_id: "viewer", active: true, role: "owner", role_id: null }],
    integrations: connected
      ? [{ company_id: ROOFER, provider: "abc_supply", status: "connected", settings: { environment: "sandbox", ship_to: "1163698", ship_to_name: "EASY ROOFING", branch: "18", branch_name: "ABC Supply - Madison, WI", accounts: [] } }]
      : [],
    integration_secrets: connected ? [{ company_id: ROOFER, provider: "abc_supply", ciphertext: await encryptJson(env, { extra: KEYS }) }] : [],
    quotes: [{ id: QUOTE, company_id: ROOFER, status: "draft" }],
    services: [
      { id: ROOF, company_id: ROOFER, name: "Architectural shingle roof", unit: "square", unit_cost: 330, labor_cost: 180 },
      { id: EDGE, company_id: ROOFER, name: "Drip edge", unit: "ft", unit_cost: 1.6, labor_cost: null },
    ],
    service_materials: [
      { id: "m1", company_id: ROOFER, service_id: ROOF, item_number: "02GASTZ3WW", name: "Timberline HDZ", uom: "BD", uom_name: "Bundle", length_ft: null, per_unit: 3, unit_price: 40, sort: 1 },
      { id: "m2", company_id: ROOFER, service_id: ROOF, item_number: "FELT10", name: "Underlayment 10 Sq", uom: "RL", uom_name: "Roll", length_ft: null, per_unit: 0.1, unit_price: 80, sort: 2 },
    ],
    quote_line_items: [
      { id: "l1", quote_id: QUOTE, service_id: ROOF, quantity: 28.4, unit_cost: 330, materials: null },
      { id: "l2", quote_id: QUOTE, service_id: EDGE, quantity: 180, unit_cost: 1.6, materials: null },
    ],
  };
}

describe("ABC Supply", () => {
  it("signs in as the business's own app, asking only for what pricing needs", async () => {
    answer();
    const token = await requestToken(KEYS, abc as never);
    expect(token.access_token).toBe("token-1");
    const [url, init] = abc.mock.calls[0]!;
    expect(url).toBe("https://sandbox.auth.partners.abcsupply.com/oauth2/aus1vp07knpuqf6Xz0h8/v1/token");
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("0oa-client-id:client-secret-value")}`);
    const form = new URLSearchParams(String(init!.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")?.split(" ").sort()).toEqual(["account.read", "location.read", "pricing.read", "product.read"]);
  });

  it("says why ABC turned the keys down", async () => {
    abc.mockImplementation(async () => Response.json({ error: "invalid_client" }, { status: 401 }));
    await expect(requestToken({ ...KEYS, environment: "production" }, abc as never)).rejects.toThrow(/didn't accept that Client ID and secret for your real prices/);
    abc.mockImplementation(async () => Response.json({ error: "invalid_scope" }, { status: 400 }));
    await expect(requestToken(KEYS, abc as never)).rejects.toThrow(/multiple ABC customers/);
    abc.mockImplementation(async () => { throw new Error("offline"); });
    await expect(requestToken(KEYS, abc as never)).rejects.toThrow(/Couldn't reach ABC Supply/);
  });

  it("lists the ship-to accounts it can price for, without retired ones", async () => {
    answer();
    const accounts = await new AbcClient("sandbox", "token-1", abc as never).accounts();
    expect(accounts).toEqual([{ number: "1163698", name: "EASY ROOFING", city: "MADISON", state: "WI", branches: [{ number: "18", name: "ABC Supply - Madison, WI", home: true }] }]);
    expect(sent("/search/accounts")[0].filters).toEqual([{ key: "accountType", condition: "equals", values: ["Ship-To"] }]);
  });

  it("searches the branch's catalog, and tries the longest word when the whole phrase finds nothing", async () => {
    abc.mockImplementation(async (_url, init) => {
      const value = JSON.parse(String(init?.body)).filters[0].values[0];
      if (value.toLowerCase() !== "timberline") return Response.json({ items: [] });
      return Response.json({
        items: [
          { itemNumber: "02GATZ3CH", itemDescription: "GAF Timberline HDZ Shingles Charcoal 3 Bdl Per Square", uoms: [{ name: "Square", code: "SQ", description: "costing" }, { name: "Square", code: "SQ", description: "estimate" }, { name: "Bundle", code: "BD", description: "stocking" }] },
          { itemNumber: "02GATZ3WW", itemDescription: "GAF Timberline HDZ Shingles Weathered Wood", uoms: [] },
        ],
      });
    });
    const items = await new AbcClient("sandbox", "token-1", abc as never).searchItems("timberline charcoal", "18");
    expect(items.map((i) => i.item_number)).toEqual(["02GATZ3CH"]);
    expect(items[0]).toMatchObject({ stocking_uom: "BD", uoms: [{ code: "SQ", name: "Square", role: "costing" }, { code: "BD", name: "Bundle", role: "stocking" }] });
    expect(sent("/search/items")[0].filters[1]).toEqual({ key: "branchNumber", condition: "equals", values: ["18"], joinCondition: null });
  });

  it("prices 50 lines at a time, and doesn't take a branch's 0.00 as a price", async () => {
    answer({ A: 12.345 });
    const lines = Array.from({ length: 51 }, (_, i) => ({ id: String(i), item_number: i === 50 ? "B" : "A", quantity: 2.2, uom: "BD" }));
    const prices = await new AbcClient("sandbox", "token-1", abc as never).prices("1163698", "18", lines);
    expect(sent("/pricing/v2/prices").map((b) => b.lines.length)).toEqual([50, 1]);
    expect(sent("/pricing/v2/prices")[0]).toMatchObject({ shipToNumber: "1163698", branchNumber: "18", purpose: "quoting", lines: expect.arrayContaining([{ id: "0", itemNumber: "A", quantity: 3, uom: "BD" }]) });
    expect(prices.get("0")).toEqual({ unit_price: 12.35, note: null });
    expect(prices.get("50")).toEqual({ unit_price: null, note: "Cannot price item B. Call for pricing." });
  });

  it("gets a new token when ABC says the old one ran out", async () => {
    let calls = 0;
    abc.mockImplementation(async () => (calls++ === 0 ? new Response("", { status: 401 }) : Response.json({ shipTos: [] })));
    const renew = vi.fn(async () => "token-2");
    await new AbcClient("sandbox", "token-1", abc as never, renew).accounts();
    expect(renew).toHaveBeenCalledOnce();
    expect((abc.mock.calls[1]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer token-2");
  });

  it("connects with pasted keys, starting at the first account's home branch", async () => {
    await roofer({ connected: false });
    answer();
    const res = await send("/apps/abc_supply/keys", { client_id: KEYS.client_id, client_secret: KEYS.client_secret, sandbox: true }, "PUT");
    expect(res.status).toBe(200);
    expect(state.tables.integrations).toEqual([
      expect.objectContaining({ provider: "abc_supply", status: "connected", account_label: "EASY ROOFING · ABC Supply - Madison, WI", settings: expect.objectContaining({ environment: "sandbox", ship_to: "1163698", branch: "18" }) }),
    ]);
    const secret = await decryptJson<{ access_token: string; extra: Record<string, string> }>(env, state.tables.integration_secrets![0]!.ciphertext as string);
    expect(secret).toMatchObject({ access_token: "token-1", extra: KEYS });
    // Shown on the Apps page, without the keys.
    const listed = (await (await send("/apps")).json()) as { apps: Array<{ id: string; supplier?: { branch_name: string } }> };
    expect(listed.apps.find((a) => a.id === "abc_supply")?.supplier?.branch_name).toBe("ABC Supply - Madison, WI");
    expect(JSON.stringify(listed)).not.toContain("client-secret-value");
  });

  it("prices an estimate's materials in whole bundles and rolls, and keeps the cost per unit", async () => {
    await roofer();
    answer({ "02GASTZ3WW": 45.12, FELT10: 89.5 });
    const res = await send(`/quotes/${QUOTE}/material-prices`, {});
    expect(res.status).toBe(200);
    const [roof, edge] = state.tables.quote_line_items!;
    expect(roof!.material_cost).toBe(4148.82); // 86 bundles × 45.12 + 3 rolls × 89.50
    expect(roof!.unit_cost).toBe(326.09); // 4148.82 / 28.4 + 180 labor
    expect((roof!.materials as { items: Array<{ quantity: number; unit_price: number }> }).items.map((i) => [i.quantity, i.unit_price])).toEqual([[86, 45.12], [3, 89.5]]);
    expect(roof!.materials).toMatchObject({ supplier: "abc_supply", branch: "18", line_quantity: 28.4 });
    // A line whose service has no materials keeps its price list cost.
    expect(edge).toMatchObject({ unit_cost: 1.6, materials: null });
    // The price list keeps the newest prices, and the roof's cost follows them.
    expect(state.tables.service_materials!.map((m) => m.unit_price)).toEqual([45.12, 89.5]);
    expect(state.tables.services!.find((s) => s.id === ROOF)!.unit_cost).toBe(324.31);
    expect(sent("/pricing/v2/prices")[0].lines.map((l: { quantity: number }) => l.quantity)).toEqual([86, 3]);
  });

  it("says how to get prices when ABC Supply isn't installed, and leaves approved quotes alone", async () => {
    await roofer({ connected: false });
    const missing = await send(`/quotes/${QUOTE}/material-prices`, {});
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { error: string }).error).toMatch(/install it on the Apps page/);

    await roofer();
    state.tables.quotes![0]!.status = "approved";
    expect((await send(`/quotes/${QUOTE}/material-prices`, {})).status).toBe(409);
    expect(abc).not.toHaveBeenCalled();
  });

  it("adds a material to a service, splitting its cost into materials and the rest", async () => {
    await roofer();
    state.tables.service_materials = [];
    state.tables.services![0]!.labor_cost = null;
    answer({ "02GASTZ3WW": 45 });
    const res = await send(`/services/${ROOF}/materials`, { item_number: "02GASTZ3WW", uom: "BD", per_unit: 3 });
    expect(res.status).toBe(201);
    expect(state.tables.service_materials).toEqual([expect.objectContaining({ service_id: ROOF, item_number: "02GASTZ3WW", name: "Item 02GASTZ3WW", uom: "BD", uom_name: "Bundle", per_unit: 3, unit_price: 45 })]);
    // $330 a square was the whole cost: $135 of it is shingles now, and $195 the rest.
    expect(state.tables.services![0]).toMatchObject({ labor_cost: 195, unit_cost: 330 });

    const wrongUnit = await send(`/services/${ROOF}/materials`, { item_number: "02GASTZ3WW", uom: "RL", per_unit: 1 });
    expect(wrongUnit.status).toBe(400);
  });
});
