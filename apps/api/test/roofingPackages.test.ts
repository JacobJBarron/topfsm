import { getPreset, savedRoofingQuantities, type Section } from "@crewtavo/core";
import { followPrice, optionsRange, priceRange, SITE_ADJUSTMENT_NAME } from "@crewtavo/core/estimates";
import { optionTotals, quoteTotals } from "@crewtavo/core/money";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { readClientLink } from "../src/lib/links";
import { packageLines, type PackageService } from "../src/services/roofPackages";

// Stand-ins for the signed-in person's Supabase client and the service-role client: tables of rows
// that eq, in and order filter, with insert (and insert().select().single()), update (returning what
// it changed) and delete. A quote row comes back with its lines, options, client and promo code, the
// way the routes embed them. accept_hub_range is the database's step as the migration writes it
// (only for the service role), as is put_quote_package, and every call is kept in `rpcs`; `meanwhile`
// runs once before the next one, for something that happens meanwhile on another screen. `afterInsert[table]` runs once a
// row goes into that table, for something that happens meanwhile on another screen.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcs: [] as Array<{ by: string; name: string; args: Record<string, unknown> }>,
  afterInsert: {} as Record<string, () => void>,
  meanwhile: null as (() => void) | null,
}));
vi.mock("../src/lib/supabase", () => {
  const embed = (table: string, row: Row): Row =>
    table === "quotes"
      ? {
          ...row,
          lines: (state.tables.quote_line_items ?? []).filter((l) => l.quote_id === row.id),
          options: (state.tables.quote_options ?? []).filter((o) => o.quote_id === row.id),
          client: (state.tables.clients ?? []).find((c) => c.id === row.client_id) ?? null,
          promo: null,
        }
      : row;
  const acceptHubRange = (args: Record<string, unknown>) => {
    const q = (state.tables.quotes ?? []).find(
      (row) =>
        row.company_id === args.p_company && row.id === args.p_quote && ["sent", "changes_requested"].includes(String(row.status)) &&
        row.range_low != null && row.range_accepted_at == null && row.priced_on_site_at == null && row.exact_sent_at == null,
    );
    if (!q) return null;
    if (args.p_option && !(state.tables.quote_options ?? []).some((o) => o.quote_id === q.id && o.id === args.p_option)) return null;
    q.range_accepted_at = "2026-10-23T15:00:00.000Z";
    if (args.p_option) q.option_id = args.p_option;
    return q.range_accepted_at;
  };
  const putQuotePackage = (args: Record<string, any>) => {
    const t = (name: string) => (state.tables[name] ??= []);
    const q = t("quotes").find((row) => row.id === args.p_quote)!;
    const had = t("quote_options").some((o) => o.quote_id === q.id);
    if (args.p_replace) {
      state.tables.quote_line_items = t("quote_line_items").filter((l) => l.quote_id !== q.id);
      state.tables.quote_options = t("quote_options").filter((o) => o.quote_id !== q.id);
      Object.assign(q, { priced_on_site_at: null, exact_sent_at: null, ...(q.promo_code_id ? {} : { discount_amount: 0 }) });
    }
    // The package's contract sections, as the database swaps them: the old package's come off
    // (unless this one brings them too; nothing comes off a quote that had options), this one's go on.
    const sectionsOf = (id: unknown) => (t("roof_packages").find((p) => p.id === id && p.company_id === q.company_id)?.section_ids as string[] | undefined) ?? [];
    const before = had ? [] : sectionsOf(q.roof_package_id);
    const after = sectionsOf(args.p_package);
    const kept = ((q.section_ids as string[] | undefined) ?? []).filter((id) => after.includes(id) || !before.includes(id));
    Object.assign(q, { roof_package_id: args.p_package, section_ids: [...new Set([...kept, ...after])].slice(0, 50) });
    if (t("quote_line_items").some((l) => l.quote_id === q.id)) return false;
    t("quote_line_items").push(...args.p_lines.map((l: Row) => ({ id: crypto.randomUUID(), company_id: q.company_id, quote_id: q.id, option_id: null, optional: false, selected: true, ...l })));
    return true;
  };
  const client = (by: string) => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      const meanwhile = state.meanwhile;
      state.meanwhile = null;
      meanwhile?.();
      state.rpcs.push({ by, name, args });
      if (name === "accept_hub_range") return by === "admin" ? { data: acceptHubRange(args), error: null } : { data: null, error: { message: "permission denied for function accept_hub_range", code: "42501" } };
      if (name === "put_quote_package") return { data: putQuotePackage(args), error: null };
      return { data: true, error: null };
    },
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const orders: Array<[string, boolean]> = [];
      let cap: number | null = null;
      let change: { kind: "update"; values: Row } | { kind: "delete" } | null = null;
      let inserted: Row[] | null = null;
      const matching = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const run = () => {
        if (inserted) return { data: inserted, error: null };
        if (change?.kind === "update") {
          const hit = matching();
          for (const row of hit) Object.assign(row, change.values);
          return { data: hit, error: null };
        }
        if (change?.kind === "delete") {
          state.tables[table] = (state.tables[table] ?? []).filter((row) => !filters.every((keep) => keep(row)));
          return { data: null, error: null };
        }
        let list = matching().map((row) => embed(table, row));
        for (const [column, ascending] of [...orders].reverse()) {
          list = [...list].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
        }
        if (cap !== null) list = list.slice(0, cap);
        return { data: list, error: null };
      };
      const one = () => {
        const { data } = run();
        return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null });
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: (column: string, options?: { ascending?: boolean }) => (orders.push([column, options?.ascending !== false]), builder),
        limit: (n: number) => ((cap = n), builder),
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        match: (values: Row) => (filters.push((row) => Object.entries(values).every(([k, v]) => row[k] === v)), builder),
        insert: (values: Row | Row[]) => {
          inserted = [values].flat().map((row) => ({ id: crypto.randomUUID(), ...row }));
          state.tables[table] = [...(state.tables[table] ?? []), ...inserted];
          state.afterInsert[table]?.();
          return builder;
        },
        // Secrets are keyed by company and provider: a new one replaces the old.
        upsert: (values: Row) => {
          state.tables[table] = [...(state.tables[table] ?? []).filter((row) => !(row.company_id === values.company_id && row.provider === values.provider)), values];
          inserted = [values];
          return builder;
        },
        update: (values: Row) => ((change = { kind: "update", values }), builder),
        delete: () => ((change = { kind: "delete" }), builder),
        maybeSingle: one,
        single: one,
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  });
  const user = client("user");
  const admin = client("admin");
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");
const { loadContext } = await import("../src/services/automations");
const { adminClient } = await import("../src/lib/supabase");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 5))),
  APP_URL: "https://ops.example.com",
} as Env;
const ROOFER = "00000000-0000-4000-8000-0000000000d1";
const QUOTE = "00000000-0000-4000-8000-0000000000d2";
const PKG = "00000000-0000-4000-8000-0000000000d3";
const ROOF = "00000000-0000-4000-8000-0000000000e1";
const TEAR = "00000000-0000-4000-8000-0000000000e2";
const EDGE = "00000000-0000-4000-8000-0000000000e3";
const STEEP = "00000000-0000-4000-8000-0000000000e4";
const BOOT = "00000000-0000-4000-8000-0000000000e5";
const OFF = "00000000-0000-4000-8000-0000000000e6";
const CLIENT = "00000000-0000-4000-8000-0000000000f1";
const GOOD = "00000000-0000-4000-8000-0000000000c1";
const BEST = "00000000-0000-4000-8000-0000000000c2";

const send = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": ROOFER, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const rows = (table: string) => state.tables[table] ?? [];
const quote = () => rows("quotes").find((q) => q.id === QUOTE)!;

// A 6/12 roof, 2,000 sq ft from above, with 100 ft of eaves and 50 ft of rakes, at 10% waste.
const SECTIONS = [
  { kind: "Area", value: 2000, pitch: "6/12" },
  { kind: "Length", value: 100, edge: "eave" },
  { kind: "Length", value: 50, edge: "rake" },
] as unknown as Section[];
const ROOFING = savedRoofingQuantities(SECTIONS, "6/12", 10);

const service = (id: string, name: string, unit: string, unit_price: number, formula: string | null, extra: Row = {}): Row => ({
  id, company_id: ROOFER, name, unit, unit_price, unit_cost: Math.round(unit_price * 60) / 100, labor_cost: null, taxable: true, formula, formula_target: "quantity", active: true, sort: 0, ...extra,
});

function roofer({ role = "owner", lines = [] as Row[], status = "draft", measured = true } = {}) {
  state.tables = {
    memberships: [{ company_id: ROOFER, user_id: "viewer", active: true, role, role_id: null }],
    companies: [{ id: ROOFER, name: "Peak Roofing", email: "office@peak.example", phone: "555-0100", address: {}, currency: "USD", trade_preset: "roofing_exteriors", settings: {} }],
    clients: [{ id: CLIENT, company_id: ROOFER, display_name: "Dana Whitfield", email: "dana@example.com", phone: "555-0142" }],
    quotes: [{ id: QUOTE, company_id: ROOFER, number: 1042, status, total: 18304, client_id: CLIENT, promo_code_id: null, roof_package_id: null, option_id: null, discount_amount: 0, tax_rate: 0, subtotal: 18304, tax_amount: 0 }],
    quote_line_items: lines.map((l) => ({ quote_id: QUOTE, company_id: ROOFER, option_id: null, optional: false, ...l })),
    services: [
      service(ROOF, "Architectural shingle roof", "square", 560, "squares"),
      service(TEAR, "Tear-off and disposal", "square", 85, "roof_squares"),
      service(EDGE, "Drip edge", "ft", 3.5, "eave_ft + rake_ft"),
      service(STEEP, "Steep roof charge", "square", 65, "steep_squares"),
      service(BOOT, "Pipe boot", "ea", 45, null),
      service(OFF, "Old service", "ea", 10, null, { active: false }),
    ],
    service_materials: [],
    roof_packages: [{ id: PKG, company_id: ROOFER, name: "Architectural shingle", style: "shingle", roof_service_id: ROOF, price_mode: "manual", markup_pct: 70, is_default: true, sort: 0 }],
    roof_package_items: [
      { id: "i1", company_id: ROOFER, package_id: PKG, service_id: TEAR, kind: "included", quantity: null, sort: 0 },
      { id: "i2", company_id: ROOFER, package_id: PKG, service_id: EDGE, kind: "included", quantity: null, sort: 1 },
      { id: "i3", company_id: ROOFER, package_id: PKG, service_id: STEEP, kind: "included", quantity: null, sort: 2 },
      { id: "i4", company_id: ROOFER, package_id: PKG, service_id: BOOT, kind: "included", quantity: 3, sort: 3 },
      { id: "i5", company_id: ROOFER, package_id: PKG, service_id: OFF, kind: "included", quantity: null, sort: 4 },
      { id: "i6", company_id: ROOFER, package_id: PKG, service_id: EDGE, kind: "quick", quantity: null, sort: 0 },
    ],
    measurements: measured
      ? [
          { id: "m-old", company_id: ROOFER, quote_id: QUOTE, total_area_sqft: 10, total_area_sqyd: 1, total_length_ft: 0, sections: [], roof_pitch: "6/12", waste_pct: 10, show_on_quote: false, updated_at: "2026-10-01T00:00:00Z" },
          { id: "m-new", company_id: ROOFER, quote_id: QUOTE, total_area_sqft: 2000, total_area_sqyd: 222.22, total_length_ft: 150, sections: SECTIONS, roof_pitch: "6/12", waste_pct: 10, show_on_quote: false, updated_at: "2026-10-20T00:00:00Z" },
        ]
      : [],
    messages: [],
    integrations: [],
    integration_secrets: [],
  };
}

const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockImplementation(async () => Response.json({ ID: "mail-1" }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.tables = {};
  state.rpcs = [];
  state.afterInsert = {};
  state.meanwhile = null;
});

describe("setting up roofing", () => {
  it("adds the standard services and packages, once", async () => {
    state.tables = { memberships: [{ company_id: ROOFER, user_id: "viewer", active: true, role: "office", role_id: null }], services: [], roof_packages: [], roof_package_items: [] };
    const res = await send("/roofing/setup", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    const preset = getPreset("roofing_exteriors");
    expect(body.services_added).toEqual(preset.services.map((s) => s.name));
    expect(body.packages_created).toBe(3);

    const packages = rows("roof_packages");
    expect(packages.map((p) => [p.name, p.style, p.is_default])).toEqual([
      ["Architectural shingle", "shingle", true],
      ["Designer shingle", "designer", false],
      ["Standing-seam metal", "metal", false],
    ]);
    const nameOf = (id: unknown) => rows("services").find((s) => s.id === id)?.name;
    expect(nameOf(packages[0]!.roof_service_id)).toBe("Architectural shingle roof");
    const items = (kind: string) => rows("roof_package_items").filter((i) => i.package_id === packages[0]!.id && i.kind === kind).sort((a, b) => Number(a.sort) - Number(b.sort));
    expect(items("included").map((i) => nameOf(i.service_id))).toEqual(preset.packages![0]!.included.map((i) => i.service));
    expect(items("included").find((i) => nameOf(i.service_id) === "Pipe boot")?.quantity).toBe(3);
    expect(items("quick").map((i) => nameOf(i.service_id))).toEqual(preset.packages![0]!.quick);
    // Each is offered as Good, Better or Best, with its highlights and warranty.
    expect(packages.map((p) => p.tier)).toEqual(["Good", "Better", "Best"]);
    expect(packages.map((p) => [p.highlights, p.warranty])).toEqual(preset.packages!.map((p) => [p.highlights, p.warranty]));

    const again = await (await send("/roofing/setup", {})).json();
    expect(again).toEqual({ services_added: [], packages_created: 0 });
    expect(rows("roof_packages")).toHaveLength(3);
  });

  it("is for the office", async () => {
    roofer({ role: "estimator" });
    expect((await send("/roofing/setup", {})).status).toBe(403);
  });
});

describe("a package on an estimate", () => {
  it("puts the roof first, then what's always on it, measured from the newest drawing", async () => {
    roofer();
    const res = await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ applied: true, lines: 4 });
    expect(body.skipped).toEqual([{ name: "Steep roof charge", reason: "None on this roof" }]);
    const lines = rows("quote_line_items").sort((a, b) => Number(a.sort) - Number(b.sort));
    expect(lines.map((l) => [l.name, l.quantity, l.unit_price])).toEqual([
      ["Architectural shingle roof", ROOFING.squares, 560],
      ["Tear-off and disposal", ROOFING.roof_squares, 85],
      ["Drip edge", 150, 3.5],
      ["Pipe boot", 3, 45],
    ]);
    expect(lines[0]).toMatchObject({ company_id: ROOFER, quote_id: QUOTE, service_id: ROOF, unit: "square", unit_cost: 336, taxable: true, formula: "squares" });
    expect(quote().roof_package_id).toBe(PKG);
    expect(rows("measurements").find((m) => m.id === "m-new")).toMatchObject({ show_on_quote: true, quote_id: QUOTE });
    expect(rows("measurements").find((m) => m.id === "m-old")?.show_on_quote).toBe(false);
  });

  it("keeps an estimate's own lines unless asked to start over", async () => {
    roofer({ lines: [{ id: "keep", name: "Roof repair", quantity: 1, unit_price: 650, sort: 0 }] });
    const kept = await (await send(`/roofing/${QUOTE}/package`, { package_id: PKG })).json();
    expect(kept).toEqual({ applied: false });
    expect(quote().roof_package_id).toBe(PKG);
    expect(rows("quote_line_items").map((l) => l.id)).toEqual(["keep"]);

    const replaced = await (await send(`/roofing/${QUOTE}/package`, { package_id: PKG, replace: true })).json();
    expect(replaced).toMatchObject({ applied: true, lines: 4 });
    expect(rows("quote_line_items").some((l) => l.id === "keep")).toBe(false);
  });

  it("leaves its contract sections to the database, which swaps the old package's for this one's", async () => {
    roofer();
    const METAL = "00000000-0000-4000-8000-0000000000b9";
    const [shingle] = rows("roof_packages");
    shingle!.section_ids = ["shingle-warranty"];
    state.tables.roof_packages!.push({ ...shingle!, id: METAL, name: "Standing-seam metal", is_default: false, section_ids: ["metal-warranty"] });
    Object.assign(quote(), { roof_package_id: METAL, section_ids: ["picked", "metal-warranty"] });
    expect((await send(`/roofing/${QUOTE}/package`, { package_id: PKG })).status).toBe(200);
    // put_quote_package works the sections out on the locked quote; the API sends none.
    const call = state.rpcs.find((r) => r.name === "put_quote_package")!;
    expect(Object.keys(call.args).sort()).toEqual(["p_lines", "p_package", "p_quote", "p_replace"]);
    expect(quote().section_ids).toEqual(["picked", "shingle-warranty"]);
  });

  it("starts the price over too when it starts over from a package", async () => {
    const repair = [{ id: "keep", name: "Roof repair", quantity: 1, unit_price: 650, sort: 0 }];
    // A price set on site (a discount) and an exact price sent instead of the range were for the old lines.
    roofer({ lines: repair });
    Object.assign(quote(), { priced_on_site_at: "2026-10-20T15:00:00Z", exact_sent_at: "2026-10-21T15:00:00Z", discount_amount: 804 });
    await send(`/roofing/${QUOTE}/package`, { package_id: PKG, replace: true });
    expect(quote()).toMatchObject({ priced_on_site_at: null, exact_sent_at: null, discount_amount: 0 });

    // A promo code keeps its discount.
    roofer({ lines: repair });
    Object.assign(quote(), { promo_code_id: "00000000-0000-4000-8000-0000000000a9", priced_on_site_at: "2026-10-20T15:00:00Z", discount_amount: 250 });
    await send(`/roofing/${QUOTE}/package`, { package_id: PKG, replace: true });
    expect(quote()).toMatchObject({ priced_on_site_at: null, discount_amount: 250 });

    // Keeping the lines keeps the price.
    roofer({ lines: repair });
    Object.assign(quote(), { priced_on_site_at: "2026-10-20T15:00:00Z", discount_amount: 804 });
    await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(quote()).toMatchObject({ priced_on_site_at: "2026-10-20T15:00:00Z", discount_amount: 804 });
  });

  it("needs the roof measured, and an estimate that isn't signed", async () => {
    roofer({ measured: false });
    const unmeasured = await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(unmeasured.status).toBe(409);
    expect((await unmeasured.json()).error).toBe("Measure the roof first.");
    expect(rows("quote_line_items")).toEqual([]);

    roofer({ status: "approved" });
    const signed = await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(signed.status).toBe(409);
    expect((await signed.json()).error).toBe("This estimate was already signed, so it can't change.");
  });

  it("leaves an estimate that offers options to the options bar", async () => {
    roofer({ lines: [{ id: "keep", name: "Architectural shingle roof", quantity: 30, unit_price: 560, sort: 0, option_id: GOOD }] });
    state.tables.quote_options = [{ id: GOOD, company_id: ROOFER, quote_id: QUOTE, name: "Architectural shingle", sort: 0 }, { id: BEST, company_id: ROOFER, quote_id: QUOTE, name: "Standing-seam metal", sort: 1 }];
    for (const replace of [false, true]) {
      const res = await send(`/roofing/${QUOTE}/package`, { package_id: PKG, replace });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("This estimate offers options; change them from the options bar.");
    }
    expect(quote().roof_package_id).toBeNull();
    expect(rows("quote_line_items").map((l) => l.id)).toEqual(["keep"]);
  });

  it("needs a roof's package to have its roof, and lets other trades' packages go without a main service", async () => {
    roofer();
    rows("roof_packages")[0]!.roof_service_id = null;
    const roof = await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(roof.status).toBe(409);
    expect((await roof.json()).error).toBe("Pick the roof for the Architectural shingle package first, in Roofing → Packages.");

    // A gutter business's package: what's always included, counted, with no main service and nothing measured.
    roofer({ measured: false });
    rows("companies")[0]!.trade_preset = "general";
    Object.assign(rows("roof_packages")[0]!, { roof_service_id: null, name: "Gutter tune-up" });
    state.tables.roof_package_items = [{ id: "g1", company_id: ROOFER, package_id: PKG, service_id: BOOT, kind: "included", quantity: 3, sort: 0 }];
    const res = await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true, lines: 1, skipped: [] });
    expect(rows("quote_line_items").map((l) => [l.name, l.quantity])).toEqual([["Pipe boot", 3]]);

    // Measured services outside roofing wait for the job's measurement, in the job's words.
    roofer({ measured: false });
    rows("companies")[0]!.trade_preset = "paving";
    const unmeasured = await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(unmeasured.status).toBe(409);
    expect((await unmeasured.json()).error).toBe("Measure the job first.");
  });

  it("prices a package that follows ABC at today's materials, and the price list follows", async () => {
    roofer();
    rows("roof_packages")[0]!.price_mode = "follow";
    rows("roof_packages")[0]!.markup_pct = 70;
    rows("services").find((s) => s.id === ROOF)!.labor_cost = 182;
    state.tables.service_materials = [
      { id: "sm1", company_id: ROOFER, service_id: ROOF, per_unit: 3, unit_price: 40 },
      { id: "sm2", company_id: ROOFER, service_id: ROOF, per_unit: 0.1, unit_price: 73.7 },
    ];
    await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    const price = followPrice(3 * 40 + 0.1 * 73.7, 182, 70);
    expect(rows("quote_line_items").find((l) => l.service_id === ROOF)?.unit_price).toBe(price);
    expect(rows("services").find((s) => s.id === ROOF)?.unit_price).toBe(price);
  });

  it("starts counted services at the package's count, and leaves off what isn't on this roof", () => {
    const svc = (id: string, formula: string | null, extra: Partial<PackageService> = {}): PackageService => ({ id, name: id, unit: "ea", unit_price: 10, unit_cost: null, taxable: true, formula, formula_target: "quantity", active: true, ...extra });
    const vars = { squares: 22, steep_squares: 0, eave_ft: 80, waste: 0.1 } as never;
    const built = packageLines(svc("roof", "squares"), [
      { service: svc("boots", null), quantity: 3 },
      { service: svc("dumpster", null), quantity: null },
      { service: svc("steep", "steep_squares"), quantity: null },
      { service: svc("roof", "squares"), quantity: null },
      { service: svc("permit", "eave_ft * 0 + 250", { formula_target: "unit_price" }), quantity: null },
      { service: svc("broken", "nonsense_ft"), quantity: null },
    ], vars);
    expect(built.lines.map((l) => [l.service_id, l.quantity, l.unit_price, l.sort])).toEqual([
      ["roof", 22, 10, 0],
      ["boots", 3, 10, 1],
      ["dumpster", 1, 10, 2],
      ["permit", 1, 250, 3],
    ]);
    expect(built.skipped.map((s) => s.name)).toEqual(["steep", "broken"]);
    expect(built.roofProblem).toBeNull();
  });
});

describe("the price range", () => {
  const lines = [
    { id: "l1", service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, unit_cost: 330, taxable: true, formula: "squares", optional: false, selected: true, sort: 0 },
    { id: "l2", service_id: BOOT, name: "Pipe boot", quantity: 3, unit: "ea", unit_price: 45, unit_cost: 15, taxable: true, formula: null, optional: false, selected: true, sort: 1 },
  ];

  it("saves the range and the lines it came from, and takes the link to share", async () => {
    roofer({ lines });
    quote().range_accepted_at = "2026-10-10T00:00:00Z";
    quote().priced_on_site_at = "2026-10-11T00:00:00Z";
    quote().exact_sent_at = "2026-10-12T00:00:00Z";
    const res = await send(`/roofing/${QUOTE}/send-range`, { channel: "link" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sent: false, range: { low: 18300, high: 21050 } });
    expect(body.link).toMatch(/^https:\/\/ops\.example\.com\//);
    expect(quote()).toMatchObject({ range_low: 18300, range_high: 21050, range_accepted_at: null, priced_on_site_at: null, exact_sent_at: null, status: "sent" });
    expect(quote().range_sent_at).toEqual(expect.any(String));
    expect(quote().range_lines).toEqual([
      { id: "l1", option_id: null, service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, unit_cost: 330, taxable: true, formula: "squares", total: 16800 },
      { id: "l2", option_id: null, service_id: BOOT, name: "Pipe boot", quantity: 3, unit: "ea", unit_price: 45, unit_cost: 15, taxable: true, formula: null, total: 135 },
    ]);
  });

  it("emails the range in its own words, with the business's room on top and rounding", async () => {
    roofer({ lines });
    rows("companies")[0]!.settings = { roofing: { range_pct: 10, range_round: 100 } };
    env.MAILPIT_URL = "http://mailpit.local";
    try {
      const body = await (await send(`/roofing/${QUOTE}/send-range`, { channel: "email" })).json();
      expect(body).toMatchObject({ sent: true, range: { low: 18300, high: 20200 } });
    } finally {
      delete env.MAILPIT_URL;
    }
    const mail = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("mailpit"))![1]!.body));
    expect(mail.Subject).toBe("Your roof estimate from Peak Roofing");
    expect(mail.To).toEqual([{ Email: "dana@example.com" }]);
    expect(mail.Text).toContain("Hi Dana,");
    expect(mail.Text).toContain("your new roof will cost between $18,300 and $20,200.");
    expect(rows("messages")[0]).toMatchObject({ channel: "email", subject: "Your roof estimate from Peak Roofing", related_type: "quote", related_id: QUOTE });
    expect(quote().status).toBe("sent");
  });

  it("runs from the cheapest option to the priciest, before add-ons, whichever option is shown", async () => {
    const tiers = [
      { id: "s1", option_id: null, service_id: null, name: "Dumpster", quantity: 1, unit: "ea", unit_price: 500, unit_cost: 300, taxable: true, formula: null, optional: false, selected: true, sort: 0 },
      { id: "g1", option_id: GOOD, service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, unit_cost: 330, taxable: true, formula: "squares", optional: false, selected: true, sort: 1 },
      { id: "g2", option_id: GOOD, service_id: null, name: "Gutter guards", quantity: 1, unit: "ea", unit_price: 900, unit_cost: 400, taxable: true, formula: null, optional: true, selected: true, sort: 2 },
      { id: "b1", option_id: BEST, service_id: null, name: "Standing-seam metal roof", quantity: 30, unit: "square", unit_price: 1285, unit_cost: 700, taxable: true, formula: "squares", optional: false, selected: false, sort: 3 },
    ];
    roofer({ lines: tiers });
    Object.assign(quote(), { option_id: GOOD, tax_rate: 0.05 });
    state.tables.quote_options = [
      { id: GOOD, company_id: ROOFER, quote_id: QUOTE, name: "Architectural shingle", sort: 0 },
      { id: BEST, company_id: ROOFER, quote_id: QUOTE, name: "Standing-seam metal", sort: 1 },
      // Offered before it was measured: no lines yet, so it's left out.
      { id: "00000000-0000-4000-8000-0000000000c3", company_id: ROOFER, quote_id: QUOTE, name: "Designer shingle", sort: 2 },
    ];
    env.MAILPIT_URL = "http://mailpit.local";
    let body;
    try {
      body = await (await send(`/roofing/${QUOTE}/send-range`, { channel: "email" })).json();
    } finally {
      delete env.MAILPIT_URL;
    }
    // Each option before add-ons: the dumpster and its own roof, with tax; the picked gutter guards don't move it.
    const good = quoteTotals([{ quantity: 1, unit_price: 500 }, { quantity: 30, unit_price: 560 }], { taxRate: 0.05 }).total;
    const best = quoteTotals([{ quantity: 1, unit_price: 500 }, { quantity: 30, unit_price: 1285 }], { taxRate: 0.05 }).total;
    const range = optionsRange([good, best]);
    expect(range).toEqual({ low: priceRange(good).low, high: priceRange(best).high });
    expect(body).toMatchObject({ sent: true, range });
    expect(quote()).toMatchObject({ range_low: range.low, range_high: range.high });
    // What the range was priced from: every option's required lines, not the add-on.
    expect((quote().range_lines as Row[]).map((l) => [l.id, l.option_id])).toEqual([["s1", null], ["g1", GOOD], ["b1", BEST]]);
    const mail = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("mailpit"))![1]!.body));
    const money = (n: number) => `$${n.toLocaleString("en-US")}`;
    expect(mail.Text).toContain(`your new roof will cost between ${money(range.low)} and ${money(range.high)}, depending on the option you pick. You can see the options`);
  });

  it("waits for an option to be priced before sending its range", async () => {
    roofer({ lines: [{ id: "s1", service_id: null, name: "Dumpster", quantity: 1, unit: "ea", unit_price: 500, optional: false, selected: true, sort: 0 }] });
    quote().option_id = GOOD;
    state.tables.quote_options = [{ id: GOOD, company_id: ROOFER, quote_id: QUOTE, name: "Architectural shingle", sort: 0 }, { id: BEST, company_id: ROOFER, quote_id: QUOTE, name: "Standing-seam metal", sort: 1 }];
    const res = await send(`/roofing/${QUOTE}/send-range`, { channel: "link" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Price the options before sending the range: none of them has any lines yet.");
    expect(quote().range_low).toBeUndefined();
  });

  it("checks where it's going before changing anything", async () => {
    roofer({ lines });
    rows("clients")[0]!.email = null;
    const res = await send(`/roofing/${QUOTE}/send-range`, { channel: "email" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Add a valid email address for this client first.");
    expect(quote().range_low).toBeUndefined();
    expect(quote().status).toBe("draft");

    roofer();
    const empty = await send(`/roofing/${QUOTE}/send-range`, { channel: "link" });
    expect(empty.status).toBe(400);
  });
});

describe("a yes to the range, marked by the office", () => {
  const lines = [{ id: "l1", service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, sort: 0, selected: true }];
  const waiting = (patch: Row = {}, role = "office") => {
    roofer({ lines, status: "sent", role });
    Object.assign(quote(), { range_low: 18300, range_high: 21050, range_sent_at: "2026-10-22T13:20:00Z", range_accepted_at: null, priced_on_site_at: null, exact_sent_at: null }, patch);
    state.tables.profiles = [{ user_id: "viewer", full_name: "Sarah Lopez" }];
  };
  const mark = (body: unknown = {}) => send(`/roofing/${QUOTE}/range-accepted`, body);
  const accepts = () => state.rpcs.filter((r) => r.name === "accept_hub_range");

  it("says yes for them through the database's own step, and notes who marked it", async () => {
    waiting();
    const res = await mark({ note: "  Called the office Tuesday " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted_at: "2026-10-23T15:00:00.000Z", range: { low: 18300, high: 21050 }, option_id: null });
    expect(accepts()).toEqual([{ by: "admin", name: "accept_hub_range", args: { p_company: ROOFER, p_quote: QUOTE } }]);
    expect(quote().range_accepted_at).toBe("2026-10-23T15:00:00.000Z");
    expect(rows("messages")).toEqual([
      expect.objectContaining({
        company_id: ROOFER,
        client_id: CLIENT,
        channel: "note",
        direction: "internal",
        related_type: "quote",
        related_id: QUOTE,
        sent_by: "viewer",
        body: "Dana Whitfield said yes to the range ($18,300 to $21,050), marked by Sarah Lopez.\nCalled the office Tuesday",
      }),
    ]);
  });

  it("works without a note, and for a client who asked a question first", async () => {
    waiting({ status: "changes_requested" }, "estimator");
    state.tables.profiles = [];
    expect((await mark()).status).toBe(200);
    expect(rows("messages")[0]!.body).toBe("Dana Whitfield said yes to the range ($18,300 to $21,050), marked by the office.");
  });

  it("only while the range is out and waiting for an answer", async () => {
    const cases: Array<[string, Row]> = [
      ["no range", { range_low: null, range_high: null, range_sent_at: null }],
      ["the exact price went out instead", { exact_sent_at: "2026-10-23T14:00:00Z" }],
      ["priced on site", { priced_on_site_at: "2026-10-24T18:00:00Z" }],
      ["they already said yes", { range_accepted_at: "2026-10-23T12:00:00Z" }],
      ["signed", { status: "approved" }],
      ["lost", { status: "lost" }],
    ];
    for (const [why, patch] of cases) {
      waiting(patch);
      const res = await mark({ note: "Called" });
      expect(res.status, why).toBe(409);
      expect((await res.json()).error, why).toBe("This price range isn't waiting for an answer.");
      expect(rows("messages"), why).toEqual([]);
    }
    expect(accepts()).toEqual([]);
  });

  it("takes no for an answer from the database too", async () => {
    // They tapped Yes on their link while the office was marking it.
    waiting();
    state.meanwhile = () => void (quote().range_accepted_at = "2026-10-23T14:59:00Z");
    const res = await mark();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This price range isn't waiting for an answer.");
    expect(accepts()).toHaveLength(1);
    expect(rows("messages")).toEqual([]);
  });

  it("marks a yes heard on the phone before the range went out, saving the range they were told", async () => {
    // Never sent, or saved on a draft whose email didn't go: the range is worked out now, as sending would.
    for (const saved of [{}, { range_low: 15000, range_high: 17250, range_sent_at: "2026-10-22T13:20:00Z" }]) {
      roofer({ lines });
      Object.assign(quote(), saved);
      state.tables.profiles = [{ user_id: "viewer", full_name: "Sarah Lopez" }];
      const res = await mark({ note: "Called the office" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accepted_at: "2026-10-23T15:00:00.000Z", range: { low: 18300, high: 21050 }, option_id: null });
      expect(quote()).toMatchObject({ status: "sent", range_low: 18300, range_high: 21050, range_accepted_at: "2026-10-23T15:00:00.000Z", priced_on_site_at: null, exact_sent_at: null });
      expect(quote().range_sent_at).not.toBe("2026-10-22T13:20:00Z");
      expect(quote().range_lines).toEqual([expect.objectContaining({ name: "Architectural shingle roof", quantity: 30, unit_price: 560 })]);
      // Nothing went to them: no email, no text, only the note.
      expect(fetcher).not.toHaveBeenCalled();
      expect(rows("messages").map((m) => [m.channel, m.body])).toEqual([["note", "Dana Whitfield said yes to the range ($18,300 to $21,050), marked by Sarah Lopez.\nCalled the office"]]);
    }
  });

  it("can't mark a yes to a range before there's a price", async () => {
    roofer();
    const res = await mark();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Add at least one line item before sending.");
    expect(quote()).toMatchObject({ status: "draft" });
    expect(quote().range_low).toBeUndefined();
    expect(accepts()).toEqual([]);
  });

  it("notes the option they're leaning toward, which is shown first from then on", async () => {
    waiting({ option_id: GOOD });
    state.tables.quote_options = [
      { id: GOOD, company_id: ROOFER, quote_id: QUOTE, name: "Architectural shingle", sort: 0 },
      { id: BEST, company_id: ROOFER, quote_id: QUOTE, name: "Standing-seam metal", sort: 1 },
    ];
    const res = await mark({ option_id: BEST.toUpperCase() });
    expect(res.status).toBe(200);
    expect((await res.json()).option_id).toBe(BEST);
    expect(accepts()).toEqual([{ by: "admin", name: "accept_hub_range", args: { p_company: ROOFER, p_quote: QUOTE, p_option: BEST } }]);
    expect(quote().option_id).toBe(BEST);
    expect(rows("messages")[0]!.body).toBe("Dana Whitfield said yes to the range ($18,300 to $21,050), leaning toward Standing-seam metal, marked by Sarah Lopez.");

    // An option that isn't on this estimate (anymore): nothing changes.
    waiting({ option_id: GOOD });
    state.tables.quote_options = [{ id: GOOD, company_id: ROOFER, quote_id: QUOTE, name: "Architectural shingle", sort: 0 }];
    const gone = await mark({ option_id: BEST });
    expect(gone.status).toBe(409);
    expect((await gone.json()).error).toBe("The options on this estimate changed. Look them over and try again.");
    expect(quote()).toMatchObject({ option_id: GOOD, range_accepted_at: null });
    expect(rows("messages")).toEqual([]);
  });

  it("is for people who sell, in their own business", async () => {
    for (const role of ["crew_lead", "field_crew"]) {
      waiting({}, role);
      expect((await mark()).status, role).toBe(403);
    }
    waiting();
    quote().company_id = "00000000-0000-4000-8000-0000000000d9";
    const other = await mark();
    expect(other.status).toBe(404);
    expect((await other.json()).error).toBe("That estimate wasn't found.");

    waiting();
    expect((await mark({ note: "x".repeat(501) })).status).toBe(400);
    expect(accepts()).toEqual([]);
    expect(quote().range_accepted_at).toBeNull();
  });
});

describe("sending a roof estimate the usual way", () => {
  const lines = [{ id: "l1", service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, sort: 0, selected: true }];
  const emailed = async () => {
    env.MAILPIT_URL = "http://mailpit.local";
    try {
      const res = await send(`/quotes/${QUOTE}/send`, { channel: "email" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ sent: true });
    } finally {
      delete env.MAILPIT_URL;
    }
    return JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("mailpit"))![1]!.body));
  };

  it("says the range, never the exact total, while it's out as a range", async () => {
    roofer({ lines, status: "sent" });
    Object.assign(quote(), { range_low: 18300, range_high: 21050, priced_on_site_at: null, exact_sent_at: null, total: 19768.32 });
    const mail = await emailed();
    expect(mail.Subject).toBe("Your roof estimate from Peak Roofing");
    expect(mail.Text).toContain("your new roof will cost between $18,300 and $21,050.");
    expect(mail.Text).not.toContain("19,768");
    expect(rows("messages")[0]).toMatchObject({ subject: "Your roof estimate from Peak Roofing", related_type: "quote", related_id: QUOTE });
    expect(String(rows("messages")[0]!.body)).not.toContain("19,768");
  });

  it("says how many options there are and the lowest price, not the total of the one shown", async () => {
    roofer({
      status: "sent",
      lines: [
        { id: "g1", option_id: GOOD, service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit_price: 560, taxable: true, optional: false, selected: false, sort: 0 },
        { id: "g2", option_id: GOOD, service_id: null, name: "Gutter guards", quantity: 1, unit_price: 900, taxable: true, optional: true, selected: false, sort: 1 },
        { id: "b1", option_id: BEST, service_id: null, name: "Standing-seam metal roof", quantity: 30, unit_price: 1285, taxable: true, optional: false, selected: true, sort: 2 },
      ],
    });
    Object.assign(quote(), { option_id: BEST, total: 38550, tax_rate: 0 });
    state.tables.quote_options = [{ id: GOOD, company_id: ROOFER, quote_id: QUOTE, name: "Architectural shingle", sort: 0 }, { id: BEST, company_id: ROOFER, quote_id: QUOTE, name: "Standing-seam metal", sort: 1 }];
    const mail = await emailed();
    expect(optionTotals(rows("quote_line_items") as never, GOOD, null, { taxRate: 0 }).total).toBe(16800);
    expect(mail.Subject).toBe("Quote #1042 from Peak Roofing");
    expect(mail.Text).toContain("Here's your quote, with 2 options from $16,800.00. You can compare them, choose the one you want and approve it online:");
    expect(mail.Text).not.toContain("38,550");

    // An option with only an add-on has no price of its own, as the Client Hub shows it: it isn't
    // counted or quoted, and one priced option is the quote's own total.
    fetcher.mockClear();
    rows("quote_line_items").find((l) => l.id === "g1")!.option_id = null;
    const one = await emailed();
    expect(one.Text).toContain("Here's your quote ($38,550.00).");
    expect(one.Text).not.toContain("options from");
  });

  it("says the range across the options while it's out as a range", async () => {
    roofer({
      status: "sent",
      lines: [
        { id: "g1", option_id: GOOD, service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit_price: 560, taxable: true, optional: false, selected: true, sort: 0 },
        { id: "b1", option_id: BEST, service_id: null, name: "Standing-seam metal roof", quantity: 30, unit_price: 1285, taxable: true, optional: false, selected: false, sort: 1 },
      ],
    });
    Object.assign(quote(), { range_low: 16800, range_high: 44350, priced_on_site_at: null, exact_sent_at: null, option_id: GOOD });
    state.tables.quote_options = [{ id: GOOD, company_id: ROOFER, quote_id: QUOTE, name: "Architectural shingle", sort: 0 }, { id: BEST, company_id: ROOFER, quote_id: QUOTE, name: "Standing-seam metal", sort: 1 }];
    const mail = await emailed();
    expect(mail.Subject).toBe("Your roof estimate from Peak Roofing");
    expect(mail.Text).toContain("your new roof will cost between $16,800 and $44,350, depending on the option you pick.");

    // Only one of them priced yet: it's that option's range, in the words for one estimate.
    fetcher.mockClear();
    state.tables.quote_line_items = rows("quote_line_items").filter((l) => l.option_id === GOOD);
    expect(await emailed().then((m) => m.Text)).toContain("your new roof will cost between $16,800 and $44,350. You can see what's included");
  });

  it("gives the exact total once it's priced on site or sent at the exact price", async () => {
    for (const exact of [{ priced_on_site_at: "2026-10-24T15:00:00Z" }, { exact_sent_at: "2026-10-24T15:00:00Z" }]) {
      fetcher.mockClear();
      roofer({ lines, status: "sent" });
      Object.assign(quote(), { range_low: 18300, range_high: 21050, priced_on_site_at: null, exact_sent_at: null, total: 19768.32 }, exact);
      const mail = await emailed();
      expect(mail.Subject).toBe("Quote #1042 from Peak Roofing");
      expect(mail.Text).toContain("Here's your quote ($19,768.32).");
    }
  });
});

describe("the link a send hands back", () => {
  const lines = [{ id: "l1", service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, sort: 0, selected: true }];
  const payload = (url: string) => readClientLink(env, url.split("/hub/")[1]!);
  const hubLink = (text: unknown) => String(text).match(/https:\/\/ops\.example\.com\/hub\/\S+/)![0];

  it("is the office's copy for an estimator's Copy link, so it can't say yes to autopay or tip as the client", async () => {
    roofer({ role: "estimator", lines, status: "sent" });
    for (const path of [`/quotes/${QUOTE}/send`, `/roofing/${QUOTE}/send-range`]) {
      const res = await send(path, { channel: "link" });
      expect(res.status, path).toBe(200);
      expect(await payload((await res.json()).link), path).toMatchObject({ c: ROOFER, t: "quote", id: QUOTE, via: "office" });
    }
    expect(rows("messages")).toEqual([]);
  });

  it("is the client's own only in the email that goes out; the timeline keeps the office's copy", async () => {
    roofer({ lines, status: "sent" });
    env.MAILPIT_URL = "http://mailpit.local";
    let body: { sent: boolean; link: string };
    try {
      body = await (await send(`/quotes/${QUOTE}/send`, { channel: "email" })).json();
    } finally {
      delete env.MAILPIT_URL;
    }
    expect(body.sent).toBe(true);
    const mail = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("mailpit"))![1]!.body));
    const own = await payload(hubLink(mail.Text));
    expect(own).toMatchObject({ c: ROOFER, t: "quote", id: QUOTE });
    expect(own!.via).toBeUndefined();
    expect(await payload(body.link)).toMatchObject({ t: "quote", id: QUOTE, via: "office" });
    expect(await payload(hubLink(rows("messages")[0]!.body))).toMatchObject({ t: "quote", id: QUOTE, via: "office" });
  });

  /** The link in what went out, by email or text, for a send with this body. */
  const sentLink = async (body: Record<string, unknown>) => {
    fetcher.mockClear();
    env.MAILPIT_URL = "http://mailpit.local";
    try {
      const res = await send(`/quotes/${QUOTE}/send`, body);
      expect(res.status, JSON.stringify(body)).toBe(200);
    } finally {
      delete env.MAILPIT_URL;
    }
    const mail = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("mailpit"))![1]!.body));
    return payload(hubLink(mail.Text));
  };

  it("is the client's own only when it goes to their own email or phone on file; typed to anyone else, it's the office's copy", async () => {
    roofer({ role: "estimator", lines, status: "sent" });
    rows("clients")[0]!.phone = "(540) 555-0142";
    // To the client: no address typed, or theirs typed in another case or format.
    for (const body of [{ channel: "email" }, { channel: "email", to: " DANA@example.com" }, { channel: "sms" }, { channel: "sms", to: "+1 540 555 0142" }]) {
      const own = await sentLink(body);
      expect(own, JSON.stringify(body)).toMatchObject({ t: "quote", id: QUOTE, own: 1 });
      expect(own, JSON.stringify(body)).not.toHaveProperty("via");
    }
    // To an address the estimator typed (their own, say): the office's copy, which can't say yes to autopay or tip.
    for (const body of [{ channel: "email", to: "estimator@peak.example" }, { channel: "sms", to: "540-555-0199" }]) {
      const copy = await sentLink(body);
      expect(copy, JSON.stringify(body)).toMatchObject({ t: "quote", id: QUOTE, via: "office" });
      expect(copy, JSON.stringify(body)).not.toHaveProperty("own");
    }
  });
});

describe("the price set on site", () => {
  const lines = [
    { id: "l1", service_id: ROOF, name: "Architectural shingle roof", formula: "squares", quantity: 30, unit_price: 560, selected: true, sort: 0 },
    { id: "l2", service_id: null, name: "Gutter guards", formula: null, quantity: 1, unit_price: 500, selected: false, optional: true, sort: 1 },
    { id: "adj", service_id: null, name: SITE_ADJUSTMENT_NAME, formula: null, quantity: 1, unit_price: 400, selected: true, sort: 2 },
  ];

  it("takes a lower price off as a discount, and drops the old adjustment", async () => {
    roofer({ lines });
    const res = await send(`/roofing/${QUOTE}/site-price`, { price: 16000 }, "PUT");
    expect(res.status).toBe(200);
    expect(quote().discount_amount).toBe(800);
    expect(quote().priced_on_site_at).toEqual(expect.any(String));
    expect(rows("quote_line_items").map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(Object.keys(await res.json()).sort()).toEqual(["discount_amount", "subtotal", "tax_amount", "total"]);
  });

  it("puts a higher price on as an adjustment line, with the note for the office", async () => {
    roofer({ lines });
    quote().discount_amount = 300;
    await send(`/roofing/${QUOTE}/site-price`, { price: 17250.5, note: "Two layers under the porch" }, "PUT");
    expect(quote().discount_amount).toBe(0);
    const adjustment = rows("quote_line_items").filter((l) => l.name === SITE_ADJUSTMENT_NAME);
    expect(adjustment).toHaveLength(1);
    expect(adjustment[0]).toMatchObject({ service_id: null, formula: null, quantity: 1, unit: "ea", unit_price: 450.5, taxable: true, description: "Two layers under the porch", sort: 3 });
    expect(rows("messages")).toEqual([expect.objectContaining({ channel: "note", direction: "internal", body: "Two layers under the porch", related_type: "quote", related_id: QUOTE, client_id: CLIENT })]);
  });

  it("goes back to the estimate as it is", async () => {
    roofer({ lines });
    quote().discount_amount = 300;
    await send(`/roofing/${QUOTE}/site-price`, { price: null }, "PUT");
    expect(quote().discount_amount).toBe(0);
    expect(rows("quote_line_items").some((l) => l.name === SITE_ADJUSTMENT_NAME)).toBe(false);
  });

  it("puts the price on the option shown, up or down, and leaves the other options and the office's discount alone", async () => {
    const tiers = [
      { id: "s1", option_id: null, service_id: null, name: "Dumpster", formula: null, quantity: 1, unit_price: 500, optional: false, selected: true, sort: 0 },
      { id: "g1", option_id: GOOD, service_id: ROOF, name: "Architectural shingle roof", formula: "squares", quantity: 30, unit_price: 560, optional: false, selected: true, sort: 1 },
      { id: "g2", option_id: GOOD, service_id: null, name: "Gutter guards", formula: null, quantity: 1, unit_price: 900, optional: true, selected: false, sort: 2 },
      { id: "g3", option_id: GOOD, service_id: null, name: SITE_ADJUSTMENT_NAME, formula: null, quantity: 1, unit_price: 250, optional: false, selected: true, sort: 3 },
      { id: "b1", option_id: BEST, service_id: null, name: "Standing-seam metal roof", formula: "squares", quantity: 30, unit_price: 1285, optional: false, selected: false, sort: 4 },
    ];
    roofer({ lines: tiers });
    Object.assign(quote(), { option_id: GOOD, discount_amount: 300, tax_rate: 0.07 });
    const money = { taxRate: 0.07, discountAmount: 300 };
    const beforeTax = (optionId: string) => {
      const t = optionTotals(rows("quote_line_items") as never, optionId, GOOD, money);
      return Math.round((t.subtotal - t.discount) * 100) / 100;
    };
    const best = beforeTax(BEST);
    // $500 + $16,800 for Good, less the office's $300: a price of $16,000 is a $1,000 line off Good's
    // own lines, and the $300 still comes off after it.
    const res = await send(`/roofing/${QUOTE}/site-price`, { price: 16000, note: "Matched their other bid" }, "PUT");
    expect(res.status).toBe(200);
    const adjustments = rows("quote_line_items").filter((l) => l.name === SITE_ADJUSTMENT_NAME);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ option_id: GOOD, service_id: null, formula: null, quantity: 1, unit_price: -1000, taxable: true, description: "Matched their other bid", sort: 5 });
    expect(rows("quote_line_items").some((l) => l.id === "g3")).toBe(false);
    expect(quote()).toMatchObject({ discount_amount: 300, priced_on_site_at: expect.any(String) });
    expect(beforeTax(GOOD)).toBe(16000);
    expect(beforeTax(BEST)).toBe(best);

    // Above the estimate it's a line on that option too.
    await send(`/roofing/${QUOTE}/site-price`, { price: 17500.25 }, "PUT");
    expect(rows("quote_line_items").filter((l) => l.name === SITE_ADJUSTMENT_NAME).map((l) => [l.option_id, l.unit_price])).toEqual([[GOOD, 500.25]]);
    expect(rows("quote_line_items").filter((l) => l.option_id === BEST).map((l) => l.id)).toEqual(["b1"]);
    expect(beforeTax(GOOD)).toBe(17500.25);

    // An office discount bigger than the lines still leaves the option at the price agreed.
    quote().discount_amount = 20000;
    await send(`/roofing/${QUOTE}/site-price`, { price: 15000 }, "PUT");
    expect(optionTotals(rows("quote_line_items") as never, GOOD, GOOD, { taxRate: 0, discountAmount: 20000 })).toMatchObject({ discount: 20000, total: 15000 });
  });

  it("takes a lower price off an option's taxed and untaxed work as a discount would, so the tax comes off the same", async () => {
    const tiers = [
      { id: "s1", option_id: null, service_id: null, name: "Permit", formula: null, quantity: 1, unit_price: 500, taxable: false, optional: false, selected: true, sort: 0 },
      { id: "g1", option_id: GOOD, service_id: ROOF, name: "Architectural shingle roof", formula: "squares", quantity: 1, unit_price: 10000, taxable: true, optional: false, selected: true, sort: 1 },
      { id: "b1", option_id: BEST, service_id: null, name: "Standing-seam metal roof", formula: "squares", quantity: 1, unit_price: 20000, taxable: true, optional: false, selected: false, sort: 2 },
    ];
    roofer({ lines: tiers });
    Object.assign(quote(), { option_id: GOOD, tax_rate: 0.08 });
    expect((await send(`/roofing/${QUOTE}/site-price`, { price: 9500 }, "PUT")).status).toBe(200);
    const adjustments = () => rows("quote_line_items").filter((l) => l.name === SITE_ADJUSTMENT_NAME).map((l) => [l.option_id, l.unit_price, l.taxable, l.sort]);
    expect(adjustments()).toEqual([[GOOD, -952.38, true, 3], [GOOD, -47.62, false, 4]]);
    // What the price would come to as a discount without options, tax and all.
    const total = optionTotals(rows("quote_line_items") as never, GOOD, GOOD, { taxRate: 0.08 }).total;
    expect(total).toBe(10223.81);
    expect(total).toBe(quoteTotals(tiers.slice(0, 2), { taxRate: 0.08, discountAmount: 1000 }).total);
    // Setting it again replaces both; above the estimate it's one taxed line.
    await send(`/roofing/${QUOTE}/site-price`, { price: 11000 }, "PUT");
    expect(adjustments()).toEqual([[GOOD, 500, true, 5]]);
  });

  it("needs the option shown to have lines of its own, and to still be shown once the price is saved", async () => {
    const tiers = [
      { id: "s1", option_id: null, service_id: null, name: "Dumpster", formula: null, quantity: 1, unit_price: 500, optional: false, selected: true, sort: 0 },
      { id: "g2", option_id: GOOD, service_id: null, name: "Gutter guards", formula: null, quantity: 1, unit_price: 900, optional: true, selected: true, sort: 1 },
      { id: "b1", option_id: BEST, service_id: null, name: "Standing-seam metal roof", formula: "squares", quantity: 30, unit_price: 1285, optional: false, selected: false, sort: 2 },
    ];
    // Good was offered before the roof was measured: it has an add-on, and nothing to price against.
    roofer({ lines: tiers });
    quote().option_id = GOOD;
    const empty = await send(`/roofing/${QUOTE}/site-price`, { price: 16000 }, "PUT");
    expect(empty.status).toBe(409);
    expect((await empty.json()).error).toBe("This option has no lines of its own yet, so there's nothing to set its price against.");
    expect(rows("quote_line_items")).toHaveLength(3);
    expect(quote().priced_on_site_at).toBeUndefined();
    // Going back to the estimate as it is still works.
    expect((await send(`/roofing/${QUOTE}/site-price`, { price: null }, "PUT")).status).toBe(200);

    // "They chose this one" on another screen while the price is saved: it was Best's price, so it isn't kept.
    roofer({ lines: tiers });
    quote().option_id = BEST;
    state.afterInsert.quote_line_items = () => (quote().option_id = GOOD);
    const moved = await send(`/roofing/${QUOTE}/site-price`, { price: 38000 }, "PUT");
    expect(moved.status).toBe(409);
    expect((await moved.json()).error).toBe("The option changed. Check it again.");
    expect(rows("quote_line_items").map((l) => l.id)).toEqual(["s1", "g2", "b1"]);
    expect(quote().priced_on_site_at).toBeUndefined();
  });

  it("won't fight a promo code or change a signed estimate", async () => {
    roofer({ lines });
    quote().promo_code_id = "00000000-0000-4000-8000-0000000000a9";
    const promo = await send(`/roofing/${QUOTE}/site-price`, { price: 16000 }, "PUT");
    expect(promo.status).toBe(409);
    expect((await promo.json()).error).toBe("Take the promo code off first.");
    expect(rows("quote_line_items")).toHaveLength(3);

    roofer({ lines, status: "converted" });
    expect((await send(`/roofing/${QUOTE}/site-price`, { price: 16000 }, "PUT")).status).toBe(409);
    expect((await send(`/roofing/${QUOTE}/site-price`, { price: -1 }, "PUT")).status).toBe(400);
  });

  it("keeps a promo code off a price set on site the other way round too, until it's back to the estimate's", async () => {
    const promo = () => send(`/quotes/${QUOTE}/promo`, { code: "SPRING" });
    const promoted = () => state.rpcs.some((r) => r.name === "apply_promo_code");
    const tiers = [
      { id: "s1", option_id: null, service_id: null, name: "Dumpster", formula: null, quantity: 1, unit_price: 500, optional: false, selected: true, sort: 0 },
      { id: "g1", option_id: GOOD, service_id: ROOF, name: "Architectural shingle roof", formula: "squares", quantity: 30, unit_price: 560, optional: false, selected: true, sort: 1 },
      { id: "b1", option_id: BEST, service_id: null, name: "Standing-seam metal roof", formula: "squares", quantity: 30, unit_price: 1285, optional: false, selected: false, sort: 2 },
    ];
    // On an option the price is a line of its own: a 10% code would come off the $1,000 agreed off it too.
    roofer({ lines: tiers });
    quote().option_id = GOOD;
    expect((await send(`/roofing/${QUOTE}/site-price`, { price: 16000 }, "PUT")).status).toBe(200);
    const refused = await promo();
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("A price was set on site for this estimate, so a promo code can't go on it too. Set the price back to the estimate's first.");
    expect(promoted()).toBe(false);
    // Back to the estimate's price, it goes on.
    await send(`/roofing/${QUOTE}/site-price`, { price: null }, "PUT");
    expect((await promo()).status).toBe(200);
    expect(promoted()).toBe(true);

    // Without options the price is a discount, which the code would replace.
    roofer({ lines });
    state.rpcs = [];
    await send(`/roofing/${QUOTE}/site-price`, { price: 16000 }, "PUT");
    expect((await promo()).status).toBe(409);
    expect(promoted()).toBe(false);
  });
});

describe("the packages' ABC prices", () => {
  it("prices their materials at the branch today, and moves a following package's roof price", async () => {
    roofer();
    rows("roof_packages")[0]!.price_mode = "follow";
    rows("services").find((s) => s.id === ROOF)!.labor_cost = 182;
    state.tables.service_materials = [{ id: "sm1", company_id: ROOFER, service_id: ROOF, item_number: "02GASTZ3WW", name: "Timberline HDZ", uom: "BD", length_ft: null, per_unit: 3, unit_price: 40, priced_at: null }];
    state.tables.integrations = [{ company_id: ROOFER, provider: "abc_supply", status: "connected", settings: { environment: "sandbox", ship_to: "1163698", ship_to_name: "PEAK", branch: "18", branch_name: "ABC Supply - Madison, WI", accounts: [] } }];
    state.tables.integration_secrets = [{ company_id: ROOFER, provider: "abc_supply", ciphertext: await encryptJson(env, { extra: { client_id: "id", client_secret: "secret", environment: "sandbox" } }) }];
    fetcher.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return Response.json({ access_token: "token-1", expires_in: 1800, token_type: "Bearer" });
      if (u.includes("/pricing/v2/prices")) {
        const asked = JSON.parse(String(init?.body));
        return Response.json({ lines: asked.lines.map((l: { id: string }) => ({ id: l.id, unitPrice: 42.5, status: { code: "OK" } })) });
      }
      return new Response("{}", { status: 404 });
    });
    const res = await send("/roofing/prices", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ branch_name: "ABC Supply - Madison, WI", services: 1 });
    expect(rows("service_materials")[0]).toMatchObject({ unit_price: 42.5, priced_at: expect.any(String) });
    const roof = rows("services").find((s) => s.id === ROOF)!;
    expect(roof.unit_cost).toBe(127.5 + 182);
    expect(roof.unit_price).toBe(followPrice(127.5, 182, 70));
  });

  it("keeps a material's last price when ABC won't price it, and holds a following roof whose material never had one", async () => {
    roofer();
    rows("roof_packages")[0]!.price_mode = "follow";
    const roof = rows("services").find((s) => s.id === ROOF)!;
    Object.assign(roof, { labor_cost: 182, unit_price: 555 });
    state.tables.service_materials = [
      { id: "sm1", company_id: ROOFER, service_id: ROOF, item_number: "02GASTZ3WW", name: "Timberline HDZ", uom: "BD", length_ft: null, per_unit: 3, unit_price: 40, priced_at: null },
      { id: "sm2", company_id: ROOFER, service_id: ROOF, item_number: "NEWSTARTER", name: "Starter strip", uom: "BD", length_ft: null, per_unit: 0.1, unit_price: null, priced_at: null },
    ];
    state.tables.integrations = [{ company_id: ROOFER, provider: "abc_supply", status: "connected", settings: { environment: "sandbox", ship_to: "1163698", ship_to_name: "PEAK", branch: "18", branch_name: "ABC Supply - Madison, WI", accounts: [] } }];
    state.tables.integration_secrets = [{ company_id: ROOFER, provider: "abc_supply", ciphertext: await encryptJson(env, { extra: { client_id: "id", client_secret: "secret", environment: "sandbox" } }) }];
    // The branch prices neither today.
    fetcher.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return Response.json({ access_token: "token-1", expires_in: 1800, token_type: "Bearer" });
      if (u.includes("/pricing/v2/prices")) {
        const asked = JSON.parse(String(init?.body));
        return Response.json({ lines: asked.lines.map((l: { id: string }) => ({ id: l.id, unitPrice: 0, status: { code: "OK" } })) });
      }
      return new Response("{}", { status: 404 });
    });
    expect((await send("/roofing/prices", {})).status).toBe(200);
    expect(rows("service_materials").map((m) => [m.unit_price, m.price_note])).toEqual([
      [40, expect.stringMatching(/hasn't priced/)],
      [null, expect.stringMatching(/hasn't priced/)],
    ]);
    // The cost counts what's known; the price a square stays put rather than leaving the starter out.
    expect(roof.unit_cost).toBe(120 + 182);
    expect(roof.unit_price).toBe(555);
  });
});

describe("automations about an estimate", () => {
  it("link to Roofing only for roof work, not for every estimate with a package", async () => {
    roofer();
    Object.assign(quote(), { roof_package_id: PKG, range_low: null, range_high: null });
    const appPath = async () => (await loadContext(adminClient(env), ROOFER, "quote", QUOTE))?.appPath;
    expect(await appPath()).toBe(`/roofing/${QUOTE}`);

    // A paving business's package: its estimate is worked on as a quote, unless what's measured is a roof.
    rows("companies")[0]!.trade_preset = "paving";
    state.tables.measurements = [{ id: "m-lot", company_id: ROOFER, quote_id: QUOTE, sections: [{ kind: "Area", value: 4000 }], roof_pitch: null, roofing_squares: null, updated_at: "2026-10-20T00:00:00Z" }];
    expect(await appPath()).toBe(`/quotes/${QUOTE}`);
    rows("measurements")[0]!.roof_pitch = "6/12";
    expect(await appPath()).toBe(`/roofing/${QUOTE}`);
    state.tables.measurements = [];
    quote().range_low = 18300;
    expect(await appPath()).toBe(`/roofing/${QUOTE}`);

    quote().roof_package_id = null;
    expect(await appPath()).toBe(`/quotes/${QUOTE}`);
  });

  it("know the lines the client is offered before they answer, and the lines they're getting once they've signed", async () => {
    roofer({
      lines: [
        { id: "s1", option_id: null, name: "Dumpster", quantity: 1, unit_price: 500, optional: false, selected: true, sort: 0 },
        { id: "s2", option_id: null, name: "Gutter guards", quantity: 1, unit_price: 900, optional: true, selected: false, sort: 1 },
        { id: "g1", option_id: GOOD, name: "Architectural shingle roof", quantity: 30, unit_price: 560, optional: false, selected: true, sort: 2 },
        { id: "g2", option_id: GOOD, name: "Ridge vent", quantity: 1, unit_price: 400, optional: true, selected: true, sort: 3 },
        { id: "b1", option_id: BEST, name: "Standing-seam metal roof", quantity: 30, unit_price: 1285, optional: false, selected: false, sort: 4 },
      ],
    });
    quote().option_id = GOOD;
    const facts = async () => (await loadContext(adminClient(env), ROOFER, "quote", QUOTE))?.facts;
    // Before they answer: the shared lines and the shown option's, add-ons not picked yet included
    // ("Line items contains Gutter guards" on a quote that's sent), and never another option's.
    expect((await facts())?.line_items).toEqual(["Dumpster", "Gutter guards", "Architectural shingle roof", "Ridge vent"]);
    // Signed: what they're getting, without the add-ons they left off.
    quote().status = "approved";
    expect((await facts())?.line_items).toEqual(["Dumpster", "Architectural shingle roof", "Ridge vent"]);

    // A quote without options the same way.
    state.tables.quote_line_items = rows("quote_line_items").filter((l) => l.option_id === null);
    quote().option_id = null;
    expect((await facts())?.line_items).toEqual(["Dumpster"]);
    quote().status = "sent";
    expect((await facts())?.line_items).toEqual(["Dumpster", "Gutter guards"]);
  });
});
