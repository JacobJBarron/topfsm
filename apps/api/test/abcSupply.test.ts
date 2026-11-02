import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { AbcClient, abcSays, brandOf, requestToken, uomOf } from "../src/integrations/abcSupply";
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
const { forgetCatalogMemory } = await import("../src/routes/materials");

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
    { name: "EASY ROOFING", number: "1163698", status: "active", address: { city: "MADISON", state: "WI" }, billTo: { number: "116660" }, branches: [{ homeBranch: true, number: "18", name: "ABC Supply - Madison, WI" }] },
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.tables = {};
  forgetCatalogMemory();
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

  it("passes on ABC's own words when it can't use a request, whatever shape they come in", async () => {
    expect(abcSays(JSON.stringify({ message: "Invalid branch" }))).toBe("Invalid branch");
    expect(abcSays('{\n  "errorMessage": "Bad Request : There was an issue with your request message. required key [requestId] not found"\n}')).toBe(
      "There was an issue with your request message. required key [requestId] not found",
    );
    expect(abcSays(JSON.stringify({ type: "https://tools.ietf.org/html/rfc9110#section-15.5.1", title: "One or more validation errors occurred.", status: 400, errors: { "lines[0].uom": ["The uom field is invalid."] }, traceId: "00-abc" }))).toBe(
      "One or more validation errors occurred. The uom field is invalid.",
    );
    expect(abcSays(JSON.stringify({ errors: [{ code: "E42", message: "Ship-To 2142885-2 isn't set up for pricing" }] }))).toBe("Ship-To 2142885-2 isn't set up for pricing");
    expect(abcSays("<html><body><h1>400 Bad Request</h1></body></html>")).toBe("400 Bad Request");
    expect(abcSays(JSON.stringify({ status: 400, error: "Bad Request" }))).toBeNull();

    vi.spyOn(console, "warn").mockImplementation(() => {});
    abc.mockImplementation(async () => Response.json({ title: "One or more validation errors occurred.", errors: { purpose: ["The purpose field is invalid."] } }, { status: 400 }));
    await expect(new AbcClient("production", "token-1", abc as never).prices("2142885-2", "525", [{ id: "1", item_number: "A", quantity: 1, uom: "BD" }])).rejects.toThrow(
      "ABC Supply couldn't use that: One or more validation errors occurred. The purpose field is invalid.",
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/^ABC Supply answered 400 to \/api\/pricing\/v2\/prices: .*purpose field.*\(sent .*"shipToNumber":"2142885-2"/));
  });

  it("lists the ship-to accounts it can price for, without retired ones", async () => {
    answer();
    const accounts = await new AbcClient("sandbox", "token-1", abc as never).accounts();
    expect(accounts).toEqual([{ number: "1163698", name: "EASY ROOFING", city: "MADISON", state: "WI", bill_to: "116660", branches: [{ number: "18", name: "ABC Supply - Madison, WI", home: true }] }]);
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
    // Production ABC turns a price request without a requestId down; each one gets its own.
    const [first, second] = sent("/pricing/v2/prices").map((b) => b.requestId);
    expect(first).toMatch(/^crewtavo-[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(prices.get("0")).toEqual({ unit_price: 12.35, note: null });
    expect(prices.get("50")).toEqual({ unit_price: null, note: "Cannot price item B. Call for pricing." });
  });

  it("asks for prices again when ABC hasn't answered in a few seconds, and takes the first answer", async () => {
    answer({ A: 12 });
    const answers = abc.getMockImplementation()!;
    let asked = 0;
    // The first price request hangs, as production ABC's did; the second answers.
    abc.mockImplementation((url, init) => (String(url).includes("/pricing/v2/prices") && asked++ === 0 ? new Promise<Response>(() => {}) : answers(url, init)));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = new AbcClient("sandbox", "token-1", abc as never).prices("1163698", "18", [{ id: "1", item_number: "A", quantity: 1, uom: "BD" }], "estimating");
      await vi.advanceTimersByTimeAsync(5_900);
      expect(sent("/pricing/v2/prices")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect((await pending).get("1")).toEqual({ unit_price: 12, note: null });
      const [first, second] = sent("/pricing/v2/prices").map((b) => b.requestId);
      expect(second).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for prices again at once when ABC fails, but not when it turns the request down", async () => {
    answer({ A: 12 });
    const answers = abc.getMockImplementation()!;
    let asked = 0;
    abc.mockImplementation((url, init) => (String(url).includes("/pricing/v2/prices") && asked++ === 0 ? Promise.resolve(new Response("upstream error", { status: 500 })) : answers(url, init)));
    const client = new AbcClient("sandbox", "token-1", abc as never);
    const line = [{ id: "1", item_number: "A", quantity: 1, uom: "BD" }];
    expect((await client.prices("1163698", "18", line)).get("1")!.unit_price).toBe(12);
    expect(sent("/pricing/v2/prices")).toHaveLength(2);

    abc.mockReset();
    abc.mockImplementation(async () => Response.json({ errorMessage: "Bad Request : shipToNumber is invalid" }, { status: 400 }));
    await expect(client.prices("1163698", "18", line)).rejects.toThrow("ABC Supply couldn't use that: shipToNumber is invalid.");
    expect(sent("/pricing/v2/prices")).toHaveLength(1);
  });

  it("says ABC didn't answer in time when neither request is answered, and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    abc.mockImplementation(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await expect(new AbcClient("sandbox", "token-1", abc as never).prices("1163698", "18", [{ id: "1", item_number: "A", quantity: 1, uom: "BD" }])).rejects.toThrow(
      "ABC Supply didn't answer in time. Try again in a minute.",
    );
    expect(sent("/pricing/v2/prices")).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^ABC Supply didn't answer \/api\/pricing\/v2\/prices: nothing in \d+ s$/));
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
      expect.objectContaining({ provider: "abc_supply", status: "connected", account_label: "EASY ROOFING · ABC Supply - Madison, WI", settings: expect.objectContaining({ environment: "sandbox", ship_to: "1163698", bill_to: "116660", branch: "18" }) }),
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

describe("ABC Supply's catalog", () => {
  const ITEM = {
    itemNumber: "02GATZ3CH",
    itemDescription: "GAF Timberline HDZ Shingles Charcoal 3 Bdl Per Square",
    marketingDescription: "LayerLock technology for a straighter roof.",
    familyId: "FAM-HDZ",
    familyName: "Timberline HDZ",
    supplierName: "GAF MATERIALS LLC",
    status: "Active",
    color: { name: "Charcoal", code: "CH" },
    uoms: [{ name: "Bundle", code: "BD", description: "stocking" }],
    specifications: [{ name: "Exposure", description: "5 5/8 in" }, { name: "Empty", description: "" }],
    images: [{ assetId: "IMG-77", type: "RepresentativeProductImageReference", href: "/product/v1/items/02GATZ3CH/images/IMG-77" }],
    // As production ABC names them: a code in front, and HTML entities.
    hierarchy: { productGroup: { name: "0001  -  Steep Slope Products", category: { name: "000013  -  Steep Slope Roofing (&gt;2/12 Pitch)", productType: { name: "000070  -  Laminated Shingles", materialComposition: { name: "Asphalt" } } } } },
    familyItems: [{ itemNumber: "02GATZ3CH", itemDescription: "same one", color: "Charcoal" }, { itemNumber: "02GATZ3WW", itemDescription: "GAF Timberline HDZ Weathered Wood", color: "Weathered Wood" }],
  };

  it("reads who makes an item, ABC's category for it, its picture, specs and other colors, and hides retired items", async () => {
    abc.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/search/items")) return Response.json({ items: [ITEM, { ...ITEM, itemNumber: "OLD1", status: "Inactive" }, { ...ITEM, itemNumber: "02OCTDDGT", supplierName: "OWENS CORNING SALES LLC", color: { name: "N/A" } }, { ...ITEM, itemNumber: "07DRIP", color: { description: "Product Color", name: null } }] });
      return Response.json(ITEM);
    });
    const client = new AbcClient("sandbox", "token-1", abc as never);
    const found = await client.searchItems("timberline", "18");
    expect(found.map((i) => i.item_number)).toEqual(["02GATZ3CH", "02OCTDDGT", "07DRIP"]);
    expect(found[0]).toMatchObject({ brand: "GAF Materials", kind: "Laminated Shingles", image: "IMG-77", family_id: "FAM-HDZ", color: "Charcoal", active: true });
    // ABC's "N/A" isn't a color, and its suppliers' legal names read as brands.
    expect(found[1]).toMatchObject({ brand: "Owens Corning", color: null });
    // Nor is "Product Color", the label production ABC sends for an item with none.
    expect(found[2]).toMatchObject({ color: null });

    const item = await client.item("02GATZ3CH");
    expect(String(abc.mock.calls.at(-1)![0])).toContain("/items/02GATZ3CH?embed=variations&familyItems=true");
    expect(item).toMatchObject({
      about: "LayerLock technology for a straighter roof.",
      path: ["Steep Slope Products", "Steep Slope Roofing (>2/12 Pitch)", "Laminated Shingles", "Asphalt"],
      specs: [{ name: "Exposure", value: "5 5/8 in" }],
      family_items: [{ item_number: "02GATZ3WW", name: "GAF Timberline HDZ Weathered Wood", color: "Weathered Wood" }],
    });

    await client.family("FAM-HDZ", "18");
    expect(sent("/search/items").at(-1).filters[0]).toEqual({ key: "productFamilyId", condition: "equals", values: ["FAM-HDZ"], joinCondition: "and" });
  });

  it("shows what the account usually buys, then its prices, finding its bill-to account the first time", async () => {
    await roofer();
    abc.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return Response.json({ access_token: "token-1", expires_in: 1800 });
      if (u.includes("/search/accounts")) return Response.json(SHIP_TOS);
      // As production ABC sends them: the unit as code and words.
      if (u.includes("/116660/frequents")) return Response.json({ items: [{ itemNumber: "02GATZ3CH", itemDescription: "Timberline HDZ Charcoal", uom: "BD - BUNDLE", count: 9, isAvailableForBranch: true }] });
      if (u.includes("/116660/recents")) return Response.json({ items: [{ itemNumber: "02GATZ3CH", count: 2 }, { itemNumber: "DRIP10", itemDescription: "Drip Edge 10 ft White", uom: "PC - PIECE", count: 1, isAvailableForBranch: false }] });
      if (u.includes("/pricing/v2/prices")) {
        const body = JSON.parse(String(init?.body));
        return Response.json({ lines: body.lines.map((l: { id: string; itemNumber: string }) => ({ id: l.id, unitPrice: l.itemNumber === "DRIP10" ? 0 : 41.2, status: { code: "OK" } })) });
      }
      return new Response("{}", { status: 404 });
    });
    const res = await send("/materials/usual");
    expect(res.status).toBe(200);
    const usual = (await res.json()) as { items: Array<{ item_number: string; uom: string }> };
    expect(usual).toMatchObject({
      items: [
        { item_number: "02GATZ3CH", name: "Timberline HDZ Charcoal", uom: "BD", uom_name: "Bundle", count: 9, at_branch: true },
        { item_number: "DRIP10", uom: "PC", uom_name: "Piece", at_branch: false },
      ],
    });
    // The cards show first; their prices are asked for next, by each unit's code: "BD - BUNDLE" can't be priced.
    expect(sent("/pricing/v2/prices")).toEqual([]);
    const prices = await send("/materials/prices", { lines: usual.items.map((i) => ({ item_number: i.item_number, uom: i.uom })) });
    expect(await prices.json()).toEqual({
      prices: { "02GATZ3CH:BD": { unit_price: 41.2, note: null }, "DRIP10:PC": { unit_price: null, note: expect.stringMatching(/hasn't priced/) } },
    });
    expect(sent("/pricing/v2/prices")[0].lines.map((l: { uom: string }) => l.uom)).toEqual(["BD", "PC"]);
    expect(String(abc.mock.calls.find(([u]) => String(u).includes("/frequents"))![0])).toContain("/api/product/v1/items/116660/frequents?itemsPerPage=50&pageNumber=1&branchNumber=18");
    expect(state.tables.integrations![0]!.settings).toMatchObject({ bill_to: "116660" });
    // Kept for a while: opening the Catalog again doesn't ask ABC for the list.
    abc.mockClear();
    expect((await (await send("/materials/usual")).json()).items).toHaveLength(2);
    expect(abc.mock.calls.some(([u]) => /search\/accounts|frequents|recents/.test(String(u)))).toBe(false);

    // ABC turning it down still leaves the rest of the catalog working, with ABC's reason.
    forgetCatalogMemory();
    abc.mockImplementation(async (url) => (String(url).includes("/oauth2/") ? Response.json({ access_token: "token-1", expires_in: 1800 }) : new Response("", { status: 403 })));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = await send("/materials/usual");
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ items: [], note: expect.stringMatching(/didn't share what you usually buy/) });
  });

  it("passes on ABC's picture of an item, and says when there's none", async () => {
    await roofer();
    abc.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return Response.json({ access_token: "token-1", expires_in: 1800 });
      if (u.includes("/items/IMG-77/images")) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
      return new Response("", { status: 404 });
    });
    const res = await send("/materials/images/IMG-77");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect((await send("/materials/images/NONE")).status).toBe(404);
    expect((await send("/materials/images/bad%20id")).status).toBe(400);
  });

  it("keeps a material's last price when ABC won't price it on an estimate, so the roof's cost doesn't drop", async () => {
    await roofer();
    answer({ FELT10: 89.5 });
    const res = await send(`/quotes/${QUOTE}/material-prices`, {});
    expect(res.status).toBe(200);
    const [shingles, felt] = state.tables.service_materials!;
    expect(shingles).toMatchObject({ unit_price: 40, price_note: "Cannot price item 02GASTZ3WW. Call for pricing." });
    expect(felt).toMatchObject({ unit_price: 89.5, price_note: null });
    // 3 bundles at the last $40 + 0.1 roll at $89.50 + $180 labor: not $8.95 + $180.
    expect(state.tables.services!.find((s) => s.id === ROOF)!.unit_cost).toBe(308.95);
    // The estimate itself says the shingles need a price, rather than counting them as free.
    expect((state.tables.quote_line_items![0]!.materials as { items: Array<{ unit_price: number | null }> }).items.map((i) => i.unit_price)).toEqual([null, 89.5]);
  });

  it("checks every material with ABC: renamed ones take the new name, retired ones are flagged and keep their price", async () => {
    await roofer();
    abc.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return Response.json({ access_token: "token-1", expires_in: 1800 });
      if (u.includes("/items/02GASTZ3WW")) return Response.json({ itemNumber: "02GASTZ3WW", itemDescription: "GAF Timberline HDZ Weathered Wood", status: "Active", uoms: [{ name: "Bundle", code: "BD", description: "stocking" }] });
      if (u.includes("/items/FELT10")) return new Response("", { status: 404 });
      if (u.includes("/pricing/v2/prices")) {
        const body = JSON.parse(String(init?.body));
        return Response.json({ lines: body.lines.map((l: { id: string }) => ({ id: l.id, unitPrice: 44, status: { code: "OK" } })) });
      }
      return new Response("{}", { status: 404 });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send("/materials/check", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ flagged: 1, services: 1 });
    const [shingles, felt] = state.tables.service_materials!;
    expect(shingles).toMatchObject({ name: "GAF Timberline HDZ Weathered Wood", unit_price: 44, price_note: null });
    expect(felt).toMatchObject({ name: "Underlayment 10 Sq", unit_price: 80, price_note: expect.stringMatching(/doesn't carry this any more/) });
    // Only the items ABC still has were priced.
    expect(sent("/pricing/v2/prices")[0].lines.map((l: { itemNumber: string }) => l.itemNumber)).toEqual(["02GASTZ3WW"]);
    expect(state.tables.services!.find((s) => s.id === ROOF)!.unit_cost).toBe(132 + 8 + 180);
  });

  it("replaces a material everywhere it's used, with how many of the new one go in each", async () => {
    await roofer();
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    state.tables.service_materials = [
      { id: a, company_id: ROOFER, service_id: ROOF, item_number: "FELT10", name: "Underlayment 10 Sq", uom: "RL", uom_name: "Roll", length_ft: null, per_unit: 0.1, unit_price: 80, price_note: "ABC Supply doesn't carry this any more.", sort: 1 },
      { id: b, company_id: ROOFER, service_id: EDGE, item_number: "FELT10", name: "Underlayment 10 Sq", uom: "RL", uom_name: "Roll", length_ft: null, per_unit: 0.01, unit_price: 80, price_note: "ABC Supply doesn't carry this any more.", sort: 1 },
    ];
    answer({ SYN10: 120 });
    const res = await send("/materials/replace", { item_number: "SYN10", uom: "BD", links: [{ id: a, per_unit: 0.1 }, { id: b, per_unit: 0.02 }] });
    expect(res.status).toBe(200);
    expect(state.tables.service_materials).toEqual([
      expect.objectContaining({ id: a, item_number: "SYN10", name: "Item SYN10", uom: "BD", uom_name: "Bundle", per_unit: 0.1, unit_price: 120, price_note: null }),
      expect.objectContaining({ id: b, item_number: "SYN10", per_unit: 0.02, unit_price: 120 }),
    ]);
    expect(state.tables.services!.find((s) => s.id === ROOF)!.unit_cost).toBe(12 + 180);

    // A material that's gone already can't be replaced.
    const missing = await send("/materials/replace", { item_number: "SYN10", links: [{ id: crypto.randomUUID(), per_unit: 1 }] });
    expect(missing.status).toBe(404);
  });

  it("reads units, brands and colors the way production ABC writes them", () => {
    expect(uomOf("PC - PIECE")).toEqual({ code: "PC", name: "Piece" });
    expect(uomOf("bd")).toEqual({ code: "BD", name: null });
    expect(uomOf(undefined)).toEqual({ code: "EA", name: null });
    expect(brandOf("OWENS CORNING SALES LLC")).toBe("Owens Corning");
    expect(brandOf("GAF")).toBe("GAF");
    expect(brandOf("CERTAINTEED, LLC")).toBe("Certainteed");
    expect(brandOf("IKO Industries Inc.")).toBe("IKO Industries");
    expect(brandOf("")).toBeNull();
  });

  it("finds the pictures of items listed without them: all in one search, then one by one, and keeps them", async () => {
    await roofer();
    const lookedUp: string[] = [];
    abc.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return Response.json({ access_token: "token-1", expires_in: 1800 });
      // ABC answers the search for only one of the numbers asked.
      if (u.includes("/search/items")) return Response.json({ items: [ITEM] });
      const number = decodeURIComponent(u.split("/items/")[1]!.split("?")[0]!);
      lookedUp.push(u.split("/items/")[1]!);
      if (number === "GONE1") return new Response("", { status: 404 });
      return Response.json({ ...ITEM, itemNumber: number, images: [], supplierName: "OWENS CORNING SALES LLC", color: { name: "Driftwood" } });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await send("/materials/pictures?items=02GATZ3CH,02OCTDDW,GONE1");
    expect(await res.json()).toEqual({
      looks: {
        "02GATZ3CH": { image: "IMG-77", brand: "GAF Materials", color: "Charcoal", kind: "Laminated Shingles" },
        "02OCTDDW": { image: null, brand: "Owens Corning", color: "Driftwood", kind: "Laminated Shingles" },
        GONE1: null,
      },
    });
    expect(sent("/search/items")[0].filters[0]).toEqual({ key: "itemNumber", condition: "equals", values: ["02GATZ3CH", "02OCTDDW", "GONE1"], joinCondition: "and" });
    // The ones the search didn't answer for, without the slower full item.
    expect(lookedUp.sort()).toEqual(["02OCTDDW", "GONE1"]);
    // Kept: asking again doesn't go to ABC.
    abc.mockClear();
    expect((await (await send("/materials/pictures?items=02GATZ3CH,GONE1")).json()).looks).toEqual({ "02GATZ3CH": expect.objectContaining({ image: "IMG-77" }), GONE1: null });
    expect(abc).not.toHaveBeenCalled();
  });

  it("makes ABC's big photos small for cards, and keeps them", async () => {
    await roofer();
    const { encode, decode } = await import("jpeg-js");
    const width = 1200;
    const height = 900;
    const big = encode({ data: new Uint8Array(width * height * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 251)), width, height }, 90).data;
    abc.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return Response.json({ access_token: "token-1", expires_in: 1800 });
      if (u.includes("/items/BIG-1/images")) return new Response(new Uint8Array(big), { headers: { "Content-Type": "image/jpeg" } });
      return new Response("", { status: 404 });
    });
    const res = await send("/materials/images/BIG-1");
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    const small = new Uint8Array(await res.arrayBuffer());
    const photo = decode(small, { useTArray: true });
    expect([photo.width, photo.height]).toEqual([480, 360]);
    expect(small.byteLength).toBeLessThan(big.byteLength / 4);
    abc.mockClear();
    expect((await send("/materials/images/BIG-1")).status).toBe(200);
    expect(abc).not.toHaveBeenCalled();
  });

  it("keeps a company's calls to ABC under its limit of 10 a second", async () => {
    abc.mockImplementation(async () => Response.json({ shipTos: [] }));
    const client = new AbcClient("sandbox", "token-1", abc as never, undefined, "pace-test");
    const started = Date.now();
    await Promise.all(Array.from({ length: 12 }, () => client.accounts()));
    // A burst of 8 goes at once; the next 4 wait an eighth of a second each.
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(abc).toHaveBeenCalledTimes(12);
  });
});
