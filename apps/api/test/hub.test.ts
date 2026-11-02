import { contractValues, resolveSections, sectionsHash } from "@crewtavo/core/contracts";
import { TRADE_TERMS, templateSettings } from "@crewtavo/core/documents";
import { snapshotLines } from "@crewtavo/core/estimates";
import { chosenTotals } from "@crewtavo/core/money";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { HttpError } from "../src/lib/http";
import { clientLink, readClientLink } from "../src/lib/links";
import { StripeError } from "../src/services/stripe";
import { drawnPng } from "./fixtures/drawn";

// A stand-in for the service-role client the Client Hub uses: tables of rows that the usual filters
// narrow down, and selects that return only the columns asked for (json paths like settings->branding
// included), so a test sees what a client's browser would. Database functions answer from `rpcs`, and
// Storage downloads from `files` (whole, or as a stream in chunks, with how much of it was read kept
// in `streamed`).
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  files: {} as Record<string, Uint8Array>,
  streamed: {} as Record<string, number>,
  rpcs: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null }>,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));
vi.mock("../src/lib/supabase", () => {
  /** Top-level parts of a select, leaving embedded ones (client:clients(...)) whole. */
  const parts = (select: string) => {
    const out: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of select) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(current.trim());
        current = "";
      } else current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  };
  const project = (row: Row, select: string | null) => {
    if (!select || select === "*") return { ...row };
    const out: Row = {};
    for (const part of parts(select)) {
      const embedded = /^(\w+)(?::\w+)?(?:!\w+)?\(/.exec(part);
      const path = /^(\w+)->(\w+)$/.exec(part);
      if (embedded) out[embedded[1]!] = row[embedded[1]!] ?? null;
      else if (path) out[path[2]!] = ((row[path[1]!] ?? {}) as Row)[path[2]!] ?? null;
      else out[part] = row[part] ?? null;
    }
    return out;
  };
  const client = () => ({
    auth: { getClaims: async () => ({ data: null, error: { message: "no session" } }) },
    storage: {
      from: () => ({
        download: (path: string) => {
          const missing = { data: null, error: { message: "Object not found" } };
          const file = state.files[path];
          // The file in 64 KB chunks, counting what the server read of it.
          const stream = () =>
            new ReadableStream<Uint8Array>({
              start: () => void (state.streamed[path] = 0),
              pull: (controller) => {
                const at = state.streamed[path]!;
                if (at >= file!.length) return controller.close();
                const chunk = file!.slice(at, at + 65_536);
                state.streamed[path] = at + chunk.length;
                controller.enqueue(chunk);
              },
            });
          return Object.assign(Promise.resolve(file ? { data: new Blob([file]), error: null } : missing), {
            asStream: async () => (file ? { data: stream(), error: null } : missing),
          });
        },
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args });
      const handler = state.rpcs[name];
      if (handler) return handler(args);
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_automation_runs") return { data: [], error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let select: string | null = null;
      let change: { kind: "update"; values: Row } | null = null;
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const run = () => {
        if (change) {
          for (const row of rows()) Object.assign(row, change.values);
          return { data: null, error: null };
        }
        return { data: rows().map((row) => project(row, select)), error: null };
      };
      const builder: Record<string, unknown> = {
        select: (columns: string) => ((select = columns), builder),
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), builder),
        gt: (column: string, value: number) => (filters.push((row) => Number(row[column]) > value), builder),
        gte: (column: string, value: string) => (filters.push((row) => String(row[column]) >= value), builder),
        is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), builder),
        not: (column: string, op: string, value: unknown) => (filters.push((row) => (op === "is" ? (row[column] ?? null) !== value : true)), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        insert: (list: Row | Row[]) => {
          state.tables[table] = [...(state.tables[table] ?? []), ...[list].flat().map((row) => ({ id: crypto.randomUUID(), ...row }))];
          return Promise.resolve({ data: null, error: null });
        },
        update: (values: Row) => ((change = { kind: "update", values }), builder),
        maybeSingle: () => Promise.resolve({ data: rows().map((row) => project(row, select))[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  });
  const admin = client();
  return { userClient: () => admin, adminClient: () => admin, publishableKey: () => "key" };
});
// The autopay facts and actions (services/autopay.ts) run as they are, unless a test says what one
// answers (mockResolvedValueOnce): then the test sees what the Hub's routes hold to themselves,
// whatever the autopay facts say. Stripe's Pay page answers with a link, and says what tip it got.
vi.mock("../src/services/autopay", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/autopay")>();
  return {
    ...real,
    hubAutopay: vi.fn(real.hubAutopay),
    hubInvoiceAutopay: vi.fn(real.hubInvoiceAutopay),
    autopayOffered: vi.fn(real.autopayOffered),
    startAutopaySetup: vi.fn(real.startAutopaySetup),
    finishAutopaySetup: vi.fn(real.finishAutopaySetup),
    confirmAutopay: vi.fn(real.confirmAutopay),
    turnOffAutopay: vi.fn(real.turnOffAutopay),
    tipOnSavedCard: vi.fn(real.tipOnSavedCard),
  };
});
vi.mock("../src/integrations/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/integrations/stripe")>()),
  stripeCheckout: vi.fn(async () => "https://invoice.stripe.test/i/pay"),
}));
const { app } = await import("../src/app");
const { addressLines, publicApproval, rangeDetails } = await import("../src/routes/public");
const { loadContext } = await import("../src/services/automations");
const { adminClient } = await import("../src/lib/supabase");
const autopay = await import("../src/services/autopay");
const { stripeCheckout } = await import("../src/integrations/stripe");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
} as Env;

const ROOFER = "00000000-0000-4000-8000-0000000000d1";
const QUOTE = "00000000-0000-4000-8000-0000000000d2";
const CLIENT = "00000000-0000-4000-8000-0000000000d3";
const PACKAGE = "00000000-0000-4000-8000-0000000000d4";
const SALES = "00000000-0000-4000-8000-0000000000d5";
const TEMPLATE = "00000000-0000-4000-8000-0000000000d6";
const PNG = drawnPng(600, 180, "Dana");
const S = { roof: "s-roof", tear: "s-tear", edge: "s-edge", deck: "s-deck", chimney: "s-chimney", cricket: "s-cricket", vent: "s-vent", boot: "s-boot" };

// The client's own link as an email or text to them carries it (own: 1), unless it's a preview, the
// office's copy (via), or `old`: a link minted before the client's own were marked.
type HubLink = { t: "quote" | "invoice" | "client"; id: string; pv?: 1; via?: "office"; old?: true };
const tokenFor = async ({ old, ...link }: HubLink) =>
  (await clientLink(env, "https://ops.example.com", { c: ROOFER, ...(old || link.pv || link.via ? {} : { own: 1 as const }), ...link })).split("/hub/")[1]!;
const hub = async (link: HubLink, path = "", body?: unknown) =>
  app.request(`/api/hub/${await tokenFor(link)}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7" }, body: JSON.stringify(body) }, env);

const line = (id: string, service_id: string | null, name: string, values: Row = {}) => ({
  id, company_id: ROOFER, quote_id: QUOTE, option_id: null, service_id, name, description: null, quantity: 1, unit: "ea", unit_price: 0, unit_cost: 0, taxable: true,
  optional: false, selected: true, option_group: null, sort: 0, formula: null, materials: null, material_cost: null, ...values,
});

function roofer(quote: Row = {}) {
  state.tables = {
    companies: [{
      id: ROOFER, name: "Summit Roofing", phone: "555-0100", email: "office@summit.example", website: "summit.example", timezone: "America/Chicago", currency: "USD", trade_preset: "roofing_exteriors",
      address: { line1: "200 Main St", line2: "Suite 4", city: "Springfield", region: "IL", postal_code: "62704" },
      settings: { branding: { color: "#1f4e79" }, hub_tips: false, roofing: { range_pct: 15, range_round: 50 } },
    }],
    quotes: [{
      id: QUOTE, company_id: ROOFER, number: 1042, status: "sent", title: "New roof", message: null, subtotal: 18304, discount_amount: 0, tax_rate: 0, tax_amount: 0,
      total: 18304, deposit_amount: 1000, valid_until: "2026-11-21", sent_at: "2026-10-22T15:00:00Z", created_at: "2026-10-21T13:00:00Z", approved_at: null, approval: null, client_id: CLIENT,
      change_order_for: null, template_id: TEMPLATE, roof_package_id: PACKAGE, option_id: null, section_ids: [], salesperson_id: SALES,
      range_low: 18300, range_high: 21050, range_sent_at: "2026-10-22T15:00:00Z", range_accepted_at: null, priced_on_site_at: null, promo_code_id: null,
      promo: null, client: { display_name: "Dana Whitfield", billing_address: {} }, property: { line1: "1482 Ridgeview Dr", city: "Springfield", region: "IL", postal_code: "62704" },
      // Its options, as automations embed them (the Hub reads quote_options itself).
      options: [],
      ...quote,
    }],
    quote_line_items: [
      line("l1", S.roof, "Architectural shingle roof", { quantity: 22.4, unit: "square", unit_price: 560, unit_cost: 330, formula: "squares", sort: 1 }),
      line("l2", S.tear, "Tear-off and disposal", { quantity: 20.4, unit: "square", unit_price: 85, unit_cost: 45, formula: "roof_squares", sort: 2 }),
      line("l3", S.edge, "Drip edge", { quantity: 210, unit: "ft", unit_price: 3.5, unit_cost: 1.6, formula: "eave_ft + rake_ft", sort: 3 }),
      line("l4", S.boot, "Pipe boot", { quantity: 3, unit_price: 45, unit_cost: 15, sort: 4 }),
      line("l5", S.chimney, "Chimney flashing", { unit_price: 650, unit_cost: 336, sort: 5 }),
      line("l6", null, "Gutter guards", { optional: true, selected: false, quantity: 120, unit: "ft", unit_price: 7, sort: 6 }),
    ],
    roof_packages: [{ id: PACKAGE, company_id: ROOFER, name: "Architectural shingle" }],
    roof_package_items: [
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.vent, kind: "quick", sort: 1 },
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.chimney, kind: "quick", sort: 2 },
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.deck, kind: "quick", sort: 3 },
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.cricket, kind: "quick", sort: 4 },
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.edge, kind: "included", sort: 1 },
    ],
    services: [
      { id: S.vent, company_id: ROOFER, name: "Ridge vent", unit: "ft", unit_price: 9, active: true },
      { id: S.chimney, company_id: ROOFER, name: "Chimney flashing", unit: "ea", unit_price: 650, active: true },
      { id: S.deck, company_id: ROOFER, name: "Rotten decking", unit: "sheet", unit_price: 95, active: true },
      { id: S.cricket, company_id: ROOFER, name: "Chimney cricket", unit: "ea", unit_price: 450, active: true },
    ],
    document_templates: [
      { id: "t-default", company_id: ROOFER, is_default: true, settings: { header: "banner", license: "RC-1" } },
      { id: TEMPLATE, company_id: ROOFER, is_default: false, settings: { header: "centered", license: "RC-104882", company_signs: true } },
    ],
    measurements: [],
    quote_options: [],
    contract_sections: [],
    clients: [{ id: CLIENT, company_id: ROOFER, display_name: "Dana Whitfield", properties: [] }],
    profiles: [{ user_id: SALES, full_name: "Mike Torres" }],
    user_signatures: [{ company_id: ROOFER, user_id: SALES, image: PNG }],
    memberships: [{ company_id: ROOFER, user_id: SALES, active: true, role: "estimator" }],
  };
}

beforeEach(() => roofer());
afterEach(() => {
  state.tables = {};
  state.files = {};
  state.streamed = {};
  state.rpcs = {};
  state.calls = [];
  // Back to the real autopay code (and Stripe's link), with any answer a test set and not used gone.
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("a price range in the Client Hub", () => {
  it("shows the range, what's included and what could change it, and never the exact price", async () => {
    const res = await hub({ t: "quote", id: QUOTE });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.range).toEqual({
      low: 18300, high: 21050, sent_at: "2026-10-22T15:00:00Z", accepted_at: null,
      included: ["Architectural shingle roof", "Tear-off and disposal", "Drip edge", "Pipe boot", "Chimney flashing"],
      // Chimney flashing is on the estimate already, so the chimney that could change it is the cricket.
      maybe: [
        { name: "Rotten decking", price: 95, per: "sheet" },
        { name: "Another layer of old shingles", price: 85, per: "square" },
        { name: "Chimney cricket", price: 450, per: null },
      ],
    });
    expect(body.quote.lines).toEqual([]);
    for (const field of ["subtotal", "discount_amount", "tax_amount", "total", "deposit_amount"]) expect(body.quote[field]).toBeNull();
    const text = JSON.stringify(body);
    expect(text).not.toContain("18304");
    expect(text).not.toContain("unit_cost");
    expect(text).not.toContain("formula");
    expect(text).not.toContain("range_pct");
    // The trade only decides whether a preview shows a range; it's never sent.
    expect(text).not.toContain("trade_preset");
    expect(text).not.toContain("roofing_exteriors");
    expect(body.quote.package).toEqual({ name: "Architectural shingle" });
    expect(body.company.address).toEqual(["200 Main St", "Suite 4", "Springfield, IL 62704"]);
    // The quote's own template, with the defaults filled in.
    expect(body.template).toMatchObject({ header: "centered", license: "RC-104882", company_signs: true, customer_signs: true });
  });

  it("shows the office's preview of a package estimate the range it would get", async () => {
    roofer({ status: "draft", range_low: null, range_high: null, range_sent_at: null });
    const preview = await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json();
    expect(preview.quote.range).toMatchObject({ low: 18300, high: 21050, sent_at: null, accepted_at: null });
    expect(preview.quote.total).toBeNull();
    // Sent the usual way (no range), the client gets the exact estimate.
    roofer({ range_low: null, range_high: null, range_sent_at: null });
    const sent = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(sent.quote.range).toBeNull();
    expect(sent.quote.total).toBe(18304);
    expect(sent.quote.lines.map((l: { id: string }) => l.id)).toEqual(["l1", "l2", "l3", "l4", "l5", "l6"]);
    expect(Object.keys(sent.quote.lines[0]).sort()).toEqual(["description", "id", "name", "option_group", "option_id", "optional", "quantity", "selected", "sort", "taxable", "unit", "unit_price"]);
    // And the office's preview of it shows the same, not a range the client never got.
    const sentPreview = await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json();
    expect(sentPreview.quote.range).toBeNull();
    expect(sentPreview.quote.total).toBe(18304);
    expect(sentPreview.quote.lines).toHaveLength(6);
  });

  it("keeps the exact price hidden on a range marked lost or archived", async () => {
    for (const status of ["lost", "archived"]) {
      roofer({ status });
      const body = await (await hub({ t: "quote", id: QUOTE })).json();
      expect(body.quote.range, status).toBeNull();
      expect(body.quote.lines, status).toEqual([]);
      for (const field of ["subtotal", "discount_amount", "tax_amount", "total", "deposit_amount"]) expect(body.quote[field], `${status} ${field}`).toBeNull();
      expect(JSON.stringify(body), status).not.toContain("18304");
    }
  });

  it("shows the exact price once the office sends it instead of the range, and it can be signed", async () => {
    roofer({ exact_sent_at: "2026-10-24T15:00:00Z" });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.range).toBeNull();
    expect(body.quote.total).toBe(18304);
    expect(body.quote.lines).toHaveLength(6);

    const home = await (await hub({ t: "client", id: CLIENT })).json();
    expect(home.quotes.find((q: { id: string }) => q.id === QUOTE)).toMatchObject({ total: 18304, range: null });

    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    const approve = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(approve.status).toBe(200);
    expect(state.calls.some((c) => c.name === "approve_hub_quote")).toBe(true);
  });

  it("shows the exact price once it's priced on site", async () => {
    roofer({ priced_on_site_at: "2026-10-25T18:00:00Z", total: 19950 });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.range).toBeNull();
    expect(body.quote.total).toBe(19950);
  });

  it("takes a yes once, and tells the office", async () => {
    state.rpcs.accept_hub_range = () => ({ data: "2026-10-23T14:00:00Z", error: null });
    const res = await hub({ t: "quote", id: QUOTE }, "/accept-range", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted_at: "2026-10-23T14:00:00Z" });
    expect(state.calls.find((c) => c.name === "accept_hub_range")?.args).toEqual({ p_company: ROOFER, p_quote: QUOTE });
    expect(Object.keys(state.calls.find((c) => c.name === "accept_hub_range")!.args)).not.toContain("p_option");

    state.rpcs.accept_hub_range = () => ({ data: null, error: null });
    const again = await hub({ t: "quote", id: QUOTE }, "/accept-range", {});
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("This price range isn't waiting for an answer.");
  });

  it("sends nothing from a preview", async () => {
    const res = await hub({ t: "quote", id: QUOTE, pv: 1 }, "/accept-range", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This is a preview, so nothing was sent.");
    expect(state.calls.some((c) => c.name === "accept_hub_range")).toBe(false);
  });

  it("can't be signed or given a promo code before the exact price", async () => {
    const approve = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(approve.status).toBe(409);
    const promo = await hub({ t: "quote", id: QUOTE }, "/promo", { code: "SPRING" });
    expect(promo.status).toBe(409);
    expect(state.calls.some((c) => c.name === "approve_hub_quote" || c.name === "apply_promo_code")).toBe(false);
  });

  it("shows the range on the client's home page instead of the total", async () => {
    state.tables.quotes!.push({ ...state.tables.quotes![0], id: "q-exact", number: 1043, range_low: null, range_high: null, total: 950 });
    const res = await hub({ t: "client", id: CLIENT });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ranged = body.quotes.find((q: { id: string }) => q.id === QUOTE);
    expect(ranged).toMatchObject({ total: null, range: { low: 18300, high: 21050, accepted_at: null } });
    expect(body.quotes.find((q: { id: string }) => q.id === "q-exact")).toMatchObject({ total: 950, range: null });
    expect(JSON.stringify(body)).not.toContain("18304");
  });
});

describe("referrals on the client's home page", () => {
  it("offers the client their link while Marketing is installed, and not once it's uninstalled", async () => {
    const company = state.tables.companies![0]!;
    company.settings = { ...(company.settings as Row), referrals: { reward: { kind: "amount", value: 50 }, offer: "$25 off your next roof check" }, marketing: { enabled: true } };
    let body = await (await hub({ t: "client", id: CLIENT })).json();
    expect(body.refer).toMatchObject({
      offer: "$25 off your next roof check", link: expect.stringContaining("/refer/"),
      rewards: "You'll get a $50 credit on your next invoice once they pay their first one.", credit_left: 0,
    });
    company.settings = { ...(company.settings as Row), marketing: { enabled: false } };
    body = await (await hub({ t: "client", id: CLIENT })).json();
    expect(body.refer).toBeNull();
  });

  it("says what the client gets, and the credit they've earned that goes on their next invoice", async () => {
    const company = state.tables.companies![0]!;
    company.settings = { ...(company.settings as Row), referrals: { reward: { kind: "percent", value: 10 } }, marketing: { enabled: true } };
    state.tables.referrals = [
      { company_id: ROOFER, referrer_client_id: CLIENT, reward_status: "earned", reward_amount: 50, given_amount: 0, auto_apply: true, credits: [{ amount: 20 }] },
      { company_id: ROOFER, referrer_client_id: CLIENT, reward_status: "earned", reward_amount: 45.06, given_amount: 0, auto_apply: true, credits: [] },
      // $50 given outside Crewtavo, $30 still to go on an invoice.
      { company_id: ROOFER, referrer_client_id: CLIENT, reward_status: "earned", reward_amount: 80, given_amount: 50, auto_apply: true, credits: [] },
    ];
    const body = await (await hub({ t: "client", id: CLIENT })).json();
    expect(body.refer).toMatchObject({ offer: null, rewards: "You'll get 10% of their first job back as a credit on your next invoice.", credit_left: 105.06 });
  });

  it("leaves out a credit the office keeps off invoices, since it won't go on the next one", async () => {
    const company = state.tables.companies![0]!;
    company.settings = { ...(company.settings as Row), referrals: { reward: { kind: "amount", value: 50 } }, marketing: { enabled: true } };
    state.tables.referrals = [
      { company_id: ROOFER, referrer_client_id: CLIENT, reward_status: "earned", reward_amount: 50, given_amount: 0, auto_apply: false, credits: [] },
    ];
    const body = await (await hub({ t: "client", id: CLIENT })).json();
    expect(body.refer.credit_left).toBe(0);
  });

  it("isn't offered with no credit or offer to tell friends about", async () => {
    const company = state.tables.companies![0]!;
    company.settings = { ...(company.settings as Row), referrals: { reward: { kind: "amount", value: 0 } }, marketing: { enabled: true } };
    expect((await (await hub({ t: "client", id: CLIENT })).json()).refer).toBeNull();
  });
});

describe("the crew on the client's home page", () => {
  it("is first names only, and a sub is named from the office's record, never their own profile", async () => {
    const visit = (id: string, assignees: string[]) => ({
      id, company_id: ROOFER, job_id: "job-1", title: "Tear off", scheduled_on: "2099-01-01", starts_at: null, ends_at: null, status: "scheduled", completed_at: null,
      property: null, assignees: assignees.map((user_id) => ({ user_id })),
    });
    Object.assign(state.tables, {
      jobs: [{ id: "job-1", company_id: ROOFER, client_id: CLIENT }],
      visits: [visit("v1", ["cy", "al", "bo"])],
      profiles: [
        { user_id: "cy", full_name: "Cy Q. Crewman" },
        // What subs typed on their own profiles.
        { user_id: "al", full_name: "Al - text me 540 555 0101 for 20% off" },
        { user_id: "bo", full_name: "Birch Gutters LLC" },
      ],
      memberships: [
        { company_id: ROOFER, user_id: "cy", role: "field_crew", subcontractor_id: null },
        { company_id: ROOFER, user_id: "al", role: "subcontractor", subcontractor_id: "apex" },
        { company_id: ROOFER, user_id: "bo", role: "subcontractor", subcontractor_id: "birch" },
      ],
      subcontractors: [
        { id: "apex", company_id: ROOFER, name: "Apex Roofing LLC", contact_name: "Albert Apex" },
        { id: "birch", company_id: ROOFER, name: "Birch Gutters LLC", contact_name: null },
      ],
    });
    const home = await (await hub({ t: "client", id: CLIENT })).json();
    // Birch has no contact name on file, so isn't named at all.
    expect(home.visits[0].crew).toEqual(["Cy", "Albert"]);
    expect(JSON.stringify(home)).not.toMatch(/540 555|20% off|Birch|LLC/);
  });
});

describe("signing online", () => {
  beforeEach(() => roofer({ range_low: null, range_high: null, range_sent_at: null }));

  it("puts the salesperson's saved signature on for the business", async () => {
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(res.status).toBe(200);
    const approval = state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval as Row;
    expect(approval).toMatchObject({ name: "Dana Whitfield", signature: PNG, company: { name: "Mike Torres", user_id: SALES, signature: PNG } });
    expect(typeof (approval.company as Row).signed_at).toBe("string");
  });

  it("keeps the quote's template with the approval, as it is when the client signs", async () => {
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    const approval = state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval as Row;
    expect(approval.template).toEqual(templateSettings({ header: "centered", license: "RC-104882", company_signs: true }));

    // A quote on the default template keeps the default as it is now.
    state.calls = [];
    state.tables.quotes![0]!.template_id = null;
    await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect((state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval as Row).template).toEqual(templateSettings({ header: "banner", license: "RC-1" }));
  });

  it("shows a signed quote with the template it was signed with, not today's", async () => {
    const signedWith = templateSettings({ header: "classic", terms: "Payment in full when the roof is done.", license: "RC-99" });
    roofer({
      status: "approved", approved_at: "2026-10-25T18:00:00Z", range_low: null, range_high: null,
      approval: { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", template: signedWith, total: 18304 },
    });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.template).toEqual(signedWith);
    expect(body.quote.approval).not.toHaveProperty("template");

    // Signed before the template was kept with it: the quote's template as it is now.
    state.tables.quotes![0]!.approval = { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z" };
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).template).toMatchObject({ header: "centered", license: "RC-104882" });

    // Opened again and not signed any more: today's template, whatever the old approval kept.
    state.tables.quotes![0]!.status = "sent";
    state.tables.quotes![0]!.approval = { name: "Dana Whitfield", template: signedWith };
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).template).toMatchObject({ header: "centered", license: "RC-104882" });
  });

  it("leaves the business's line for later when the template has none, or the salesperson left", async () => {
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    state.tables.document_templates![1]!.settings = { company_signs: false };
    await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval).not.toHaveProperty("company");

    state.calls = [];
    state.tables.document_templates![1]!.settings = { company_signs: true };
    state.tables.memberships![0]!.active = false;
    await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval).not.toHaveProperty("company");
  });

  it("shows a signed quote with both signatures and never where it was signed from", async () => {
    roofer({
      status: "approved", approved_at: "2026-10-25T18:00:00Z", range_low: null, range_high: null,
      approval: { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", ip: "198.51.100.4", method: "in_person", company: { name: "Mike Torres", user_id: SALES, signature: PNG, signed_at: "2026-10-25T18:01:00Z" }, total: 18304 },
    });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.approval).toEqual({
      name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", method: "in_person",
      company: { name: "Mike Torres", signature: PNG, signed_at: "2026-10-25T18:01:00Z" },
      option: null, contract: null, initials: null,
    });
    expect(JSON.stringify(body)).not.toContain("198.51.100.4");
    expect(body.quote.total).toBe(18304);
    expect(body.quote.lines).toHaveLength(6);
  });

  it("sends no approval for a quote that isn't signed", async () => {
    roofer({ status: "sent", range_low: null, range_high: null, approval: { name: "Old", ip: "198.51.100.4" } });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.approval).toBeNull();
    expect(JSON.stringify(body)).not.toContain("198.51.100.4");
  });
});

describe("how a quote's promo code comes off, in the Client Hub", () => {
  const coded = (status: string, everyVisit: boolean, signedRule: boolean | null = null) =>
    roofer({
      status, range_low: null, range_high: null, approved_at: status === "sent" ? null : "2026-10-25T18:00:00Z",
      approval: status === "sent" ? null : { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", total: 18304 },
      promo_code_id: "p-1", discount_amount: 25, promo_every_visit: signedRule,
      promo: { code: "WEEKLY25", kind: "amount", value: 25, description: null, min_subtotal: 0, every_visit: everyVisit },
    });

  it("says the code's rule while the quote is open", async () => {
    coded("sent", false);
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).quote.promo).toMatchObject({ code: "WEEKLY25", every_visit: false });
  });

  it("keeps the rule the client approved, whatever the code says now", async () => {
    // Approved while the code came off once; the code was switched to every visit since.
    coded("converted", true, false);
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).quote.promo).toMatchObject({ code: "WEEKLY25", every_visit: false });
    coded("approved", false, true);
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).quote.promo.every_visit).toBe(true);
    // Approved before quotes said how a code comes off: it still says nothing.
    coded("converted", true, null);
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).quote.promo.every_visit).toBeNull();
  });
});

// Two options: an architectural shingle roof (shown) and a standing-seam metal one, each with an add-on,
// on shared tear-off, drip edge and gutter guards. Without tax or a discount, the shingle roof is
// $1,734 + $735 + $12,544 = $15,013 and the metal one $1,734 + $735 + $28,784 = $31,253.
const GOOD = "00000000-0000-4000-8000-0000000000a1";
const METAL = "00000000-0000-4000-8000-0000000000a2";
const PICTURE = "00000000-0000-4000-8000-0000000000a3";
const OTHER = "00000000-0000-4000-8000-0000000000a4";
const PAYMENT = "00000000-0000-4000-8000-0000000000b1";
const CANCEL = "00000000-0000-4000-8000-0000000000b2";
const WARRANTY = "00000000-0000-4000-8000-0000000000b3";
const FOREIGN = "00000000-0000-4000-8000-0000000000b4";
const UNUSED = "00000000-0000-4000-8000-0000000000b5";
const L = {
  tear: "00000000-0000-4000-8000-0000000000c1", edge: "00000000-0000-4000-8000-0000000000c2", shingle: "00000000-0000-4000-8000-0000000000c3",
  vent: "00000000-0000-4000-8000-0000000000c4", metal: "00000000-0000-4000-8000-0000000000c5", snow: "00000000-0000-4000-8000-0000000000c6",
  gutter: "00000000-0000-4000-8000-0000000000c7", ridge: "00000000-0000-4000-8000-0000000000c8", power: "00000000-0000-4000-8000-0000000000c9",
};
const TERMS = "Thanks, {Customer name}. Warranty: {Warranty}";
const INITIALS = drawnPng(240, 90, "DW");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);

function withOptions(quote: Row = {}) {
  roofer({ range_low: null, range_high: null, range_sent_at: null, subtotal: 15013, total: 15013, option_id: GOOD, section_ids: [WARRANTY], ...quote });
  const t = state.tables;
  t.quote_line_items = [
    line(L.tear, S.tear, "Tear-off and disposal", { quantity: 20.4, unit: "square", unit_price: 85, formula: "roof_squares", sort: 1 }),
    line(L.edge, S.edge, "Drip edge", { quantity: 210, unit: "ft", unit_price: 3.5, formula: "eave_ft + rake_ft", sort: 2 }),
    line(L.shingle, S.roof, "Architectural shingle roof", { option_id: GOOD, quantity: 22.4, unit: "square", unit_price: 560, formula: "squares", sort: 3 }),
    line(L.vent, S.vent, "Ridge vent upgrade", { option_id: GOOD, optional: true, selected: false, unit_price: 400, sort: 4 }),
    line(L.metal, S.roof, "Standing-seam metal roof", { option_id: METAL, quantity: 22.4, unit: "square", unit_price: 1285, formula: "squares", selected: false, sort: 5 }),
    line(L.snow, null, "Snow guards", { option_id: METAL, optional: true, selected: false, unit_price: 600, sort: 6 }),
    line(L.gutter, null, "Gutter guards", { optional: true, selected: false, quantity: 120, unit: "ft", unit_price: 7, sort: 7 }),
  ];
  // Out of order on purpose: the Hub sends them in the order they're offered.
  t.quote_options = [
    {
      id: METAL, company_id: ROOFER, quote_id: QUOTE, package_id: null, name: "Standing-seam metal", tier: null, picture: null, picture_width: null, picture_height: null,
      style: "metal", highlights: ["Lasts 50 years or more"], warranty: "Lifetime on the panels & 15 years on our work.", section_ids: [CANCEL], sort: 1,
    },
    {
      id: GOOD, company_id: ROOFER, quote_id: QUOTE, package_id: PACKAGE, name: "Architectural shingle", tier: null, picture: `${ROOFER}/packages/${PICTURE}.jpg`, picture_width: 1600, picture_height: 1067,
      style: "shingle", highlights: ["30-year shingles", "Ice and water shield"], warranty: "10 years on our work.", section_ids: [], sort: 0,
    },
    // Another quote's option is never this quote's.
    { id: OTHER, company_id: ROOFER, quote_id: "q-other", package_id: null, name: "Someone else's", tier: "Best", picture: null, picture_width: null, picture_height: null, style: "other", highlights: [], warranty: "", section_ids: [], sort: 0 },
  ];
  t.document_templates![1]!.settings = { header: "centered", license: "RC-104882", company_signs: true, terms: TERMS, sections: [PAYMENT, FOREIGN] };
  t.contract_sections = [
    { id: PAYMENT, company_id: ROOFER, title: "Payment", body: "<p>The price is {Total}. Make checks out to {Business name}.</p>", place: "terms", initials: false, sort: 1 },
    { id: CANCEL, company_id: ROOFER, title: "Your right to cancel", body: "<p>{Customer name} may cancel within three business days.</p>", place: "signatures", initials: true, sort: 2 },
    { id: WARRANTY, company_id: ROOFER, title: "Warranty", body: "<p>{Option}: {Warranty}</p>", place: "terms", initials: false, sort: 3 },
    { id: UNUSED, company_id: ROOFER, title: "Not on this quote", body: "<p>Never sent.</p>", place: "terms", initials: false, sort: 4 },
    // Another business's section, even with an id the template names, never prints.
    { id: FOREIGN, company_id: "00000000-0000-4000-8000-0000000000ff", title: "Their terms", body: "<p>Another business's words.</p>", place: "terms", initials: false, sort: 0 },
  ];
}

type HubLine = { id: string; option_id: string | null; quantity: number; unit_price: number; taxable: boolean; optional: boolean; selected: boolean };

/**
 * What the page posts for an option (null for a quote without options), worked out from what the Hub
 * sent, as the browser does it: the paper's words filled in with the facts sent and the total picked,
 * and the option's card.
 */
async function picked(optionId: string | null, picks: string[]) {
  const view = await (await hub({ t: "quote", id: QUOTE })).json();
  const template = templateSettings(view.template);
  const option = view.quote.options.find((o: { id: string }) => o.id === optionId) ?? null;
  const sections = resolveSections({ kind: "estimate", template, optionSectionIds: option?.section_ids, quoteSectionIds: view.contract.quote_sections, library: view.contract.library });
  const total = chosenTotals(view.quote.lines as HubLine[], optionId, view.quote.option_id, picks, { taxRate: view.quote.tax_rate, discountAmount: view.quote.discount_amount }).total;
  const facts = view.contract.facts;
  const values = contractValues({ ...facts, total, optionName: option?.name ?? facts.optionName, warranty: option?.warranty ?? facts.warranty });
  const card = option && { name: option.name, tier: option.tier, warranty: option.warranty, highlights: option.highlights };
  return { sections_hash: sectionsHash(sections, { terms: template.terms, values, option: card }), expected_total: total };
}

const approvalArgs = () => state.calls.find((c) => c.name === "approve_hub_quote")!.args;

describe("options in the Client Hub", () => {
  it("sends every option with its picture, tier and price, and every line with its option", async () => {
    withOptions();
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.option_id).toBe(GOOD);
    expect(body.quote.section_ids).toEqual([WARRANTY]);
    expect(body.quote.options).toEqual([
      {
        id: GOOD, name: "Architectural shingle", tier: "Good", picture: { src: `/api/public/package/${ROOFER}/${PICTURE}.jpg`, width: 1600, height: 1067 },
        style: "shingle", highlights: ["30-year shingles", "Ice and water shield"], warranty: "10 years on our work.", section_ids: [], sort: 0, total: 15013, range: null,
      },
      {
        id: METAL, name: "Standing-seam metal", tier: "Better", picture: null,
        style: "metal", highlights: ["Lasts 50 years or more"], warranty: "Lifetime on the panels & 15 years on our work.", section_ids: [CANCEL], sort: 1, total: 31253, range: null,
      },
    ]);
    expect(body.quote.lines.map((l: { id: string; option_id: string | null }) => [l.id, l.option_id])).toEqual([
      [L.tear, null], [L.edge, null], [L.shingle, GOOD], [L.vent, GOOD], [L.metal, METAL], [L.snow, METAL], [L.gutter, null],
    ]);
    expect(JSON.stringify(body)).not.toContain("q-other");
  });

  it("names its own tier when an option has one, and leaves the rest without one", async () => {
    withOptions();
    state.tables.quote_options!.find((o) => o.id === METAL)!.tier = "Premium";
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.options.map((o: { tier: string | null }) => o.tier)).toEqual([null, "Premium"]);
  });

  it("shows each option's own range with a price range, and never an exact amount or the contract", async () => {
    withOptions({ range_low: 15000, range_high: 35950, range_sent_at: "2026-10-22T15:00:00Z" });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.range).toMatchObject({ low: 15000, high: 35950, included: ["Tear-off and disposal", "Drip edge", "Architectural shingle roof"] });
    expect(body.quote.options.map((o: { id: string; total: unknown; range: unknown }) => [o.id, o.total, o.range])).toEqual([
      [GOOD, null, { low: 15000, high: 17300 }],
      [METAL, null, { low: 31250, high: 35950 }],
    ]);
    expect(body.quote.lines).toEqual([]);
    expect(body.contract).toBeNull();
    const text = JSON.stringify(body);
    for (const exact of ["15013", "31253", "12544", "28784"]) expect(text).not.toContain(exact);
    // No contract at all: its words would say the price ({Total}).
    expect(text).not.toContain("{Total}");
    expect(text).not.toContain("Make checks out");
  });

  it("previews a roofing estimate's range from the cheapest option to the priciest, and other trades at their price", async () => {
    withOptions({ status: "draft", roof_package_id: null });
    const preview = await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json();
    expect(preview.quote.range).toMatchObject({ low: 15000, high: 35950, sent_at: null });
    expect(preview.quote.total).toBeNull();

    state.tables.companies![0]!.trade_preset = "paving";
    const paving = await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json();
    expect(paving.quote.range).toBeNull();
    expect(paving.quote.total).toBe(15013);
    expect(paving.quote.options.map((o: { total: number }) => o.total)).toEqual([15013, 31253]);
  });

  it("previews a range for a roof another trade measured, as Roofing sends it one", async () => {
    roofer({ status: "draft", range_low: null, range_high: null, range_sent_at: null });
    state.tables.companies![0]!.trade_preset = "paving";
    const preview = async () => (await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json()).quote;
    expect(await preview()).toMatchObject({ range: null, total: 18304 });
    state.tables.measurements = [{ id: "m-roof", company_id: ROOFER, quote_id: QUOTE, sections: [{ kind: "Area", value: 2000 }], roof_pitch: "6/12", roofing_squares: 22.4, updated_at: "2026-10-20T00:00:00Z" }];
    expect(await preview()).toMatchObject({ range: { low: 18300, high: 21050, sent_at: null }, total: null });
    // A lot measured for paving isn't a roof: the price.
    Object.assign(state.tables.measurements[0]!, { roof_pitch: null, roofing_squares: null });
    expect(await preview()).toMatchObject({ range: null, total: 18304 });
  });

  it("takes the option they're leaning toward with a yes to the range", async () => {
    withOptions({ range_low: 15000, range_high: 35950, range_sent_at: "2026-10-22T15:00:00Z" });
    state.rpcs.accept_hub_range = () => ({ data: "2026-10-23T14:00:00Z", error: null });
    const res = await hub({ t: "quote", id: QUOTE }, "/accept-range", { option_id: METAL });
    expect(res.status).toBe(200);
    expect(state.calls.find((c) => c.name === "accept_hub_range")?.args).toEqual({ p_company: ROOFER, p_quote: QUOTE, p_option: METAL });

    state.calls = [];
    expect((await hub({ t: "quote", id: QUOTE }, "/accept-range", { option_id: "metal" })).status).toBe(400);
    expect(state.calls.some((c) => c.name === "accept_hub_range")).toBe(false);
  });

  it("says the options changed when the one they lean toward isn't on the estimate", async () => {
    withOptions({ range_low: 15000, range_high: 35950, range_sent_at: "2026-10-22T15:00:00Z" });
    state.rpcs.accept_hub_range = () => ({ data: "2026-10-23T14:00:00Z", error: null });
    for (const option_id of [OTHER, UNUSED]) {
      const res = await hub({ t: "quote", id: QUOTE }, "/accept-range", { option_id });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("The options on this estimate changed. Please look it over again.");
    }
    expect(state.calls.some((c) => c.name === "accept_hub_range")).toBe(false);
    // Sent in capitals, it's still the metal roof.
    expect((await hub({ t: "quote", id: QUOTE }, "/accept-range", { option_id: METAL.toUpperCase() })).status).toBe(200);
    expect(state.calls.find((c) => c.name === "accept_hub_range")?.args.p_option).toBe(METAL);
  });

  it("keeps each option's range where it was when the range was sent, inside the range sent", async () => {
    withOptions({ range_low: 15000, range_high: 35950, range_sent_at: "2026-10-22T15:00:00Z" });
    state.tables.quotes![0]!.range_lines = snapshotLines(state.tables.quote_line_items as never);
    const ranges = async () => (await (await hub({ t: "quote", id: QUOTE })).json()).quote.options.map((o: { id: string; range: unknown }) => [o.id, o.range]);
    const sent = [
      [GOOD, { low: 15000, high: 17300 }],
      [METAL, { low: 31250, high: 35950 }],
    ];
    expect(await ranges()).toEqual(sent);
    // The office prices the metal roof higher after sending, and adds a third option: the homeowner's
    // ranges stay as sent until a new range goes out, and the new option has none yet.
    state.tables.quote_line_items!.find((l) => l.id === L.metal)!.unit_price = 1500;
    state.tables.quote_options!.push({ ...state.tables.quote_options![0]!, id: UNUSED, name: "Designer shingle", sort: 2 });
    state.tables.quote_line_items!.push(line("00000000-0000-4000-8000-0000000000ca", S.roof, "Designer shingle roof", { option_id: UNUSED, quantity: 22.4, unit: "square", unit_price: 700, selected: false, sort: 10 }));
    expect(await ranges()).toEqual([...sent, [UNUSED, null]]);
    // A range sent before its lines were kept: today's lines, kept inside the range that was sent.
    state.tables.quotes![0]!.range_lines = null;
    expect(await ranges()).toEqual([sent[0], [METAL, { low: 35950, high: 35950 }], [UNUSED, { low: 18100, high: 20900 }]]);
  });

  it("previews the exact price while none of the options has a price yet, as it can't be sent as a range", async () => {
    withOptions({ status: "draft", roof_package_id: null });
    state.tables.quote_line_items = state.tables.quote_line_items!.filter((l) => l.option_id === null);
    state.tables.quotes![0]!.total = 2469;
    const preview = await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json();
    expect(preview.quote.range).toBeNull();
    expect(preview.quote.total).toBe(2469);
    expect(preview.quote.options.map((o: { total: unknown; range: unknown }) => [o.total, o.range])).toEqual([[null, null], [null, null]]);
  });
});

describe("the contract in the Client Hub", () => {
  it("sends the business's own sections as written, and the facts the page fills them in with", async () => {
    withOptions();
    state.tables.quotes![0]!.client = { display_name: "Dana Whitfield", billing_address: { line1: "PO Box 12", city: "Springfield", region: "IL", postal_code: "62705" } };
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.contract).toEqual({
      kind: "live",
      terms: TERMS,
      // The template's, every option's and the quote's, and only this business's: never another business's, or one no quote names.
      library: [
        { id: PAYMENT, title: "Payment", body: "<p>The price is {Total}. Make checks out to {Business name}.</p>", place: "terms", initials: false },
        { id: CANCEL, title: "Your right to cancel", body: "<p>{Customer name} may cancel within three business days.</p>", place: "signatures", initials: true },
        { id: WARRANTY, title: "Warranty", body: "<p>{Option}: {Warranty}</p>", place: "terms", initials: false },
      ],
      template_sections: [PAYMENT, FOREIGN],
      quote_sections: [WARRANTY],
      facts: {
        customerName: "Dana Whitfield",
        customerAddress: ["PO Box 12", "Springfield, IL 62705"],
        jobAddress: ["1482 Ridgeview Dr", "Springfield, IL 62704"],
        businessName: "Summit Roofing",
        businessPhone: "555-0100",
        license: "RC-104882",
        estimateNumber: 1042,
        date: "2026-10-22T15:00:00Z",
        timeZone: "America/Chicago",
        deposit: 1000,
        // The option picked says these.
        optionName: null,
        warranty: null,
      },
    });
    expect(JSON.stringify(body)).not.toContain("Another business's words");
    expect(JSON.stringify(body)).not.toContain("billing_address");
    // Without a billing address, the customer's address is the job's.
    state.tables.quotes![0]!.client = { display_name: "Dana Whitfield", billing_address: {} };
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).contract.facts.customerAddress).toEqual(["1482 Ridgeview Dr", "Springfield, IL 62704"]);
  });

  it("sends a plain quote's terms too, with no sections", async () => {
    roofer({ range_low: null, range_high: null, range_sent_at: null });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.options).toEqual([]);
    expect(body.quote.option_id).toBeNull();
    expect(body.contract).toMatchObject({ kind: "live", library: [], template_sections: [], quote_sections: [] });
    expect(body.contract.terms).toBe(body.template.terms);
  });
});

describe("approving an estimate with options", () => {
  beforeEach(() => {
    withOptions();
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
  });

  it("signs for the option picked, with its add-ons, the terms filled in and the initials kept", async () => {
    const posted = await picked(METAL, [L.snow, L.gutter]);
    // The metal roof with snow guards and gutter guards: $31,253 + $600 + $840.
    expect(posted.expected_total).toBe(32693);
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", {
      name: "Dana Whitfield", signature: PNG, option_id: METAL, selected_line_ids: [L.snow, L.gutter, L.vent], initials: INITIALS, ...posted,
    });
    expect(res.status).toBe(200);
    const args = approvalArgs();
    // The shingle roof's add-on isn't on the metal roof, so it's left off.
    expect(args).toMatchObject({ p_company: ROOFER, p_quote: QUOTE, p_option: METAL, p_expected_total: 32693, p_selected: [L.snow, L.gutter] });
    const approval = args.p_approval as Row;
    expect(approval.selected_line_ids).toEqual([L.snow, L.gutter]);
    expect(approval.option).toEqual({
      id: METAL, name: "Standing-seam metal", tier: "Better", picture: null, style: "metal", highlights: ["Lasts 50 years or more"], warranty: "Lifetime on the panels & 15 years on our work.",
    });
    expect(approval.contract).toEqual({
      // Plain text: the paper escapes it as it prints.
      terms: "Thanks, Dana Whitfield. Warranty: Lifetime on the panels & 15 years on our work.",
      sections: [
        { id: PAYMENT, title: "Payment", body: "<p>The price is $32,693.00. Make checks out to Summit Roofing.</p>", place: "terms", initials: false, initialed: false },
        { id: CANCEL, title: "Your right to cancel", body: "<p>Dana Whitfield may cancel within three business days.</p>", place: "signatures", initials: true, initialed: true },
        { id: WARRANTY, title: "Warranty", body: "<p>Standing-seam metal: Lifetime on the panels &amp; 15 years on our work.</p>", place: "terms", initials: false, initialed: false },
      ],
    });
    expect(approval.initials).toEqual({ image: INITIALS, signed_at: approval.signed_at });
  });

  it("keeps the option's picture and no initials when nothing asks for them", async () => {
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: GOOD, initials: INITIALS, ...(await picked(GOOD, [])) });
    expect(res.status).toBe(200);
    const approval = approvalArgs().p_approval as Row;
    expect(approval.option).toMatchObject({ id: GOOD, tier: "Good", picture: { path: `${ROOFER}/packages/${PICTURE}.jpg`, width: 1600, height: 1067 } });
    expect((approval.contract as { sections: Row[] }).sections.map((s) => s.id)).toEqual([PAYMENT, WARRANTY]);
    expect(approval.initials).toBeNull();
  });

  it("needs one of the options picked", async () => {
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Pick one of the options first.");
    const other = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: OTHER });
    expect(other.status).toBe(409);
    expect((await other.json()).error).toBe("The options on this estimate changed. Please look it over again.");
    expect(state.calls.some((c) => c.name === "approve_hub_quote")).toBe(false);
  });

  it("asks for initials where the terms ask for them", async () => {
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: METAL, ...(await picked(METAL, [])) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Add your initials where the terms ask for them.");
    // Only a small drawn picture.
    const big = `data:image/png;base64,${"A".repeat(61_441)}`;
    expect((await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: METAL, initials: big })).status).toBe(400);
    expect(state.calls.some((c) => c.name === "approve_hub_quote")).toBe(false);
  });

  it("only takes a signature and initials of a size a signature pad draws", async () => {
    // A few bytes that would take everyone who opens the signed copy gigabytes to draw.
    const huge = drawnPng(20_000, 20_000);
    expect((await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: huge, option_id: GOOD })).status).toBe(400);
    expect((await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: METAL, initials: huge })).status).toBe(400);
    // Not a PNG at all, whatever it says it is.
    expect((await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: "data:image/png;base64,SU5JVElBTFM=", option_id: GOOD })).status).toBe(400);
    expect(state.calls.some((c) => c.name === "approve_hub_quote")).toBe(false);
    // A wide pad on a big iPad is fine.
    expect((await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: drawnPng(2752, 340), option_id: METAL, initials: drawnPng(2752, 200) })).status).toBe(200);
  });

  it("turns it down when the terms changed after they were read", async () => {
    const posted = await picked(METAL, []);
    state.tables.contract_sections![0]!.body = "<p>The price is {Total}, due up front.</p>";
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: METAL, initials: INITIALS, ...posted });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The terms changed. Please look them over again.");
    expect(state.calls.some((c) => c.name === "approve_hub_quote")).toBe(false);
  });

  it("says the price changed when the database's total isn't the one they saw", async () => {
    state.rpcs.approve_hub_quote = () => ({ data: false, error: null });
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: GOOD, expected_total: 15000 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The price changed. Please look it over again.");
    expect(approvalArgs().p_expected_total).toBe(15000);

    state.calls = [];
    const old = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: GOOD });
    expect((await old.json()).error).toBe("This quote can't be approved anymore.");
    expect(Object.keys(approvalArgs())).not.toContain("p_expected_total");
  });

  it("fills in the total their choices come to when the page didn't send one", async () => {
    await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: GOOD, selected_line_ids: [L.vent] });
    const contract = (approvalArgs().p_approval as Row).contract as { sections: Row[] };
    expect(contract.sections[0]!.body).toBe("<p>The price is $15,413.00. Make checks out to Summit Roofing.</p>");
  });

  it("keeps one pick per group among the option's lines only", async () => {
    const t = state.tables.quote_line_items!;
    t.push(line(L.ridge, null, "Ridge vent", { option_id: GOOD, optional: true, selected: false, option_group: "Ventilation", unit_price: 300, sort: 8 }));
    t.push(line(L.power, null, "Power vent", { option_id: GOOD, optional: true, selected: false, option_group: "Ventilation", unit_price: 500, sort: 9 }));
    // The metal roof has no ventilation group, so nothing to pick there.
    expect((await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: METAL, initials: INITIALS })).status).toBe(200);
    state.calls = [];
    const none = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: GOOD });
    expect(none.status).toBe(400);
    expect((await none.json()).error).toBe("Pick one of the choices for Ventilation.");
    expect((await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: GOOD, selected_line_ids: [L.power] })).status).toBe(200);
  });

  it("won't sign an option that isn't priced yet", async () => {
    // The metal roof was offered before measuring, and its package was gone when the lines were filled in.
    state.tables.quote_line_items = state.tables.quote_line_items!.filter((l) => l.option_id !== METAL || l.optional);
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: METAL, initials: INITIALS });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This option isn't priced yet. Pick another one, or ask us about it.");
    expect(state.calls.some((c) => c.name === "approve_hub_quote")).toBe(false);
  });

  it("says it can't be approved anymore when another approval got there first, whatever total was sent", async () => {
    state.rpcs.approve_hub_quote = () => {
      state.tables.quotes![0]!.status = "approved";
      return { data: false, error: null };
    };
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: GOOD, ...(await picked(GOOD, [])) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This quote can't be approved anymore.");
  });

  it("matches the option and add-ons when their ids come in capitals", async () => {
    const posted = await picked(METAL, [L.snow]);
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", {
      name: "Dana Whitfield", signature: PNG, option_id: METAL.toUpperCase(), selected_line_ids: [L.snow.toUpperCase()], initials: INITIALS, ...posted,
    });
    expect(res.status).toBe(200);
    expect(approvalArgs()).toMatchObject({ p_option: METAL, p_selected: [L.snow], p_expected_total: 31853 });
    expect((approvalArgs().p_approval as Row).selected_line_ids).toEqual([L.snow]);
  });

  it("signs a plain quote as before, keeping its terms filled in", async () => {
    roofer({ range_low: null, range_high: null, range_sent_at: null });
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    state.tables.document_templates![1]!.settings = { company_signs: false, terms: "Thanks, {Customer name}." };
    state.tables.quote_line_items!.find((l) => l.id === "l6")!.id = L.gutter;
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, selected_line_ids: [L.gutter] });
    expect(res.status).toBe(200);
    const args = approvalArgs();
    expect(Object.keys(args).sort()).toEqual(["p_approval", "p_company", "p_quote", "p_selected"]);
    expect(args.p_selected).toEqual([L.gutter]);
    expect(args.p_approval).toMatchObject({ option: null, contract: { terms: "Thanks, Dana Whitfield.", sections: [] }, initials: null });
  });
});

describe("a signed estimate with options", () => {
  const signedWith = templateSettings({ header: "classic", terms: TERMS, license: "RC-99" });
  const kept = {
    name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", ip: "198.51.100.4", template: signedWith, total: 32693,
    option: { id: METAL, name: "Standing-seam metal", tier: "Better", picture: null, style: "metal", highlights: ["Lasts 50 years or more"], warranty: "Lifetime on the panels & 15 years on our work." },
    contract: {
      terms: "Thanks, Dana Whitfield. Warranty: Lifetime on the panels & 15 years on our work.",
      sections: [{ id: CANCEL, title: "Your right to cancel", body: "<p>Dana Whitfield may cancel within three business days.</p>", place: "signatures", initials: true, initialed: true }],
    },
    initials: { image: INITIALS, signed_at: "2026-10-25T18:00:00Z" },
  };

  it("shows the copy kept when it was signed: the option chosen, its lines, the contract and the initials", async () => {
    withOptions({ status: "approved", approved_at: "2026-10-25T18:00:00Z", option_id: METAL, total: 32693, approval: kept });
    // Today's library says something else; the signed copy doesn't change.
    state.tables.contract_sections![1]!.body = "<p>Changed after signing.</p>";
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.template).toEqual(signedWith);
    expect(body.contract).toEqual({ kind: "signed", terms: kept.contract.terms, sections: kept.contract.sections, initials: kept.initials });
    expect(body.quote.approval).toMatchObject({ name: "Dana Whitfield", option: kept.option, contract: kept.contract, initials: kept.initials });
    expect(body.quote.lines.map((l: { id: string }) => l.id)).toEqual([L.tear, L.edge, L.metal, L.snow, L.gutter]);
    expect(body.quote.options.map((o: { id: string; total: number }) => [o.id, o.total])).toEqual([[METAL, 32693]]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("Changed after signing");
    expect(text).not.toContain("198.51.100.4");
  });

  it("shows the option as it was signed, whatever the office changes on it later", async () => {
    const picture = { path: `${ROOFER}/packages/${PICTURE}.jpg`, width: 1600, height: 1067 };
    withOptions({ status: "approved", approved_at: "2026-10-25T18:00:00Z", option_id: METAL, total: 32693, approval: { ...kept, option: { ...kept.option, picture } } });
    Object.assign(state.tables.quote_options!.find((o) => o.id === METAL)!, { name: "Renamed later", tier: "Premium", highlights: [], warranty: "None" });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.option_id).toBe(METAL);
    expect(body.quote.options).toEqual([
      {
        id: METAL, name: "Standing-seam metal", tier: "Better", picture: { src: `/api/public/package/${ROOFER}/${PICTURE}.jpg`, width: 1600, height: 1067 },
        style: "metal", highlights: ["Lasts 50 years or more"], warranty: "Lifetime on the panels & 15 years on our work.", section_ids: [], sort: 0, total: 32693, range: null,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("Renamed later");
  });

  it("fills in the terms of an estimate signed before the contract was kept", async () => {
    withOptions({ status: "approved", approved_at: "2026-10-25T18:00:00Z", option_id: METAL, total: 32693, approval: { name: "Dana Whitfield", signature: PNG, template: signedWith } });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.contract).toEqual({ kind: "signed", terms: "Thanks, Dana Whitfield. Warranty: ", sections: [], initials: null });
    expect(body.quote.approval).toMatchObject({ option: null, contract: null, initials: null });
  });
});

describe("an invoice in the Client Hub", () => {
  const INVOICE = "00000000-0000-4000-8000-0000000000e1";

  it("prints the template's invoice sections, the business's own only, filled in with the invoice's facts", async () => {
    withOptions();
    state.tables.document_templates![0]!.settings = { header: "banner", license: "RC-1", terms: "Due by {Date}. Thanks, {Customer name}.", invoice_sections: [FOREIGN, WARRANTY, PAYMENT], sections: [CANCEL] };
    state.tables.contract_sections![2]!.body = "<p>Invoice {Estimate number} for the work at {Job address}. {Option}{Warranty}{Deposit}</p>";
    state.tables.invoices = [{
      id: INVOICE, company_id: ROOFER, number: 77, status: "sent", subject: "Roof replacement", notes: null, issued_on: "2026-10-01", due_on: "2026-10-31",
      subtotal: 18304, discount_amount: 0, tax_amount: 0, total: 18304, retainage_amount: 0, amount_paid: 0, balance_due: 18304, client_id: CLIENT, promo: null,
      client: { display_name: "Dana Whitfield", billing_address: { line1: "PO Box 12", city: "Springfield", region: "IL", postal_code: "62705" } },
      job: { property: { line1: "1482 Ridgeview Dr", city: "Springfield", region: "IL", postal_code: "62704" } },
      lines: [{ name: "Architectural shingle roof", description: null, quantity: 1, unit: "ea", unit_price: 18304, sort: 1 }],
      payments: [], credit_amount: 50, credits: [{ amount: 50, note: "Referral credit: thanks for referring Maria", created_at: "2026-10-02T12:00:00Z" }],
    }];
    const res = await hub({ t: "invoice", id: INVOICE });
    expect(res.status).toBe(200);
    const body = await res.json();
    // A referral credit on it goes out with its note, as the paper and the totals show it.
    expect(body.invoice).toMatchObject({ credit_amount: 50, credits: [{ amount: 50, note: "Referral credit: thanks for referring Maria" }] });
    expect(body.contract).toEqual({
      // Plain text: the paper escapes it as it prints.
      terms: "Due by October 1, 2026. Thanks, Dana Whitfield.",
      sections: [
        { id: WARRANTY, title: "Warranty", body: "<p>Invoice 77 for the work at 1482 Ridgeview Dr, Springfield, IL 62704. </p>", place: "terms", initials: false },
        { id: PAYMENT, title: "Payment", body: "<p>The price is $18,304.00. Make checks out to Summit Roofing.</p>", place: "terms", initials: false },
      ],
    });
    // Only the customer's name goes out with the invoice; their billing address and the job only in the words.
    expect(body.invoice.client).toEqual({ display_name: "Dana Whitfield" });
    expect(body.invoice).not.toHaveProperty("job");
    const text = JSON.stringify(body);
    for (const hidden of ["billing_address", "PO Box 12", "Another business's words", "may cancel"]) expect(text).not.toContain(hidden);
    expect(body.promo_line).toBe(false);
  });

  it("says when its job's promo code is on a line, so no other code goes on it, without sending the line's key", async () => {
    withOptions();
    state.tables.invoices = [{
      id: INVOICE, company_id: ROOFER, number: 78, status: "sent", subject: "Weekly mowing", notes: null, issued_on: "2026-10-01", due_on: "2026-10-31",
      subtotal: 20, discount_amount: 0, tax_amount: 0, total: 20, retainage_amount: 0, amount_paid: 0, balance_due: 20, client_id: CLIENT, promo: null,
      client: { display_name: "Dana Whitfield", billing_address: null }, job: { property: null },
      lines: [
        { name: "Mowing", description: null, quantity: 1, unit: "visit", unit_price: 45, sort: 1, discount_quote_id: null },
        { name: "Promo code WEEKLY25", description: null, quantity: 1, unit: "ea", unit_price: -25, sort: 2, discount_quote_id: QUOTE },
      ],
      payments: [], credit_amount: 0, credits: [],
    }];
    const body = await (await hub({ t: "invoice", id: INVOICE })).json();
    expect(body.promo_line).toBe(true);
    expect(body.invoice.lines.map((l: { name: string }) => l.name)).toEqual(["Mowing", "Promo code WEEKLY25"]);
    expect(JSON.stringify(body.invoice.lines)).not.toContain("discount_quote_id");
  });
});

describe("package pictures", () => {
  const picture = (file: string, company = ROOFER) => app.request(`/api/public/package/${company}/${file}.jpg`, {}, env);

  it("shows any of the business's package pictures to anyone, kept for good", async () => {
    state.files[`${ROOFER}/packages/${PICTURE}.jpg`] = JPEG;
    const res = await picture(PICTURE);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  });

  it("shows none larger than the server saves one, and never reads one like that whole", async () => {
    // Uploaded straight to Storage by someone in the business: 8 MB that starts like a JPEG.
    const path = `${ROOFER}/packages/${PICTURE}.jpg`;
    const big = new Uint8Array(8_000_000);
    big.set(JPEG);
    state.files[path] = big;
    expect((await picture(PICTURE)).status).toBe(404);
    expect(state.streamed[path]).toBeLessThan(1_600_000);
    // Just under the limit is a picture the server could have saved.
    state.files[path] = big.slice(0, 1_400_000);
    expect((await picture(PICTURE)).status).toBe(200);
  });

  it("shows nothing that isn't a JPEG in a business's packages folder", async () => {
    state.files[`${ROOFER}/packages/${PICTURE}.jpg`] = JPEG;
    // Another business's folder, another folder, a file that isn't a JPEG, a name that isn't a uuid.
    expect((await picture(PICTURE, OTHER)).status).toBe(404);
    state.files[`${ROOFER}/logo/${OTHER}.jpg`] = JPEG;
    expect((await picture(OTHER)).status).toBe(404);
    state.files[`${ROOFER}/packages/${OTHER}.jpg`] = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect((await picture(OTHER)).status).toBe(404);
    expect((await app.request(`/api/public/package/${ROOFER}/..%2Flogo%2F${OTHER}.jpg`, {}, env)).status).toBe(404);
    expect((await picture("not-a-uuid")).status).toBe(404);
  });
});

describe("hub helpers", () => {
  it("splits the business's address into letterhead lines", () => {
    expect(addressLines({ line1: "200 Main St", city: "Springfield", region: "IL", postal_code: "62704" })).toEqual(["200 Main St", "Springfield, IL 62704"]);
    expect(addressLines({ city: "Springfield" })).toEqual(["Springfield"]);
    expect(addressLines(null)).toEqual([]);
    expect(addressLines("200 Main St")).toEqual([]);
  });

  it("keeps only real signatures from an approval", () => {
    expect(publicApproval({ name: "Office", method: "manual" }, "2026-10-25T18:00:00Z")).toEqual({
      name: "Office", signature: null, signed_at: "2026-10-25T18:00:00Z", method: "manual", company: null, option: null, contract: null, initials: null,
    });
    expect(publicApproval({ name: "Dana", signature: "javascript:alert(1)", company: { name: "Mike", signature: "not-a-png" }, initials: { image: "javascript:alert(1)" } }, null)).toMatchObject({ signature: null, company: null, initials: null });
    expect(publicApproval(null, null)).toEqual({ name: "", signature: null, signed_at: null, method: null, company: null, option: null, contract: null, initials: null });
    // One kept before signatures were checked for their size isn't sent on.
    const huge = drawnPng(20_000, 20_000);
    expect(publicApproval({ name: "Dana", signature: huge, company: { name: "Mike", signature: huge }, initials: { image: huge } }, null)).toMatchObject({ signature: null, company: null, initials: null });
  });

  it("leaves a price set on site out of what's included", () => {
    const details = rangeDetails(
      [
        { service_id: S.roof, name: "Metal roof", unit: "square", unit_price: 1285, formula: "squares", optional: false, selected: true },
        { service_id: null, name: "Price adjustment", unit: "ea", unit_price: 400, formula: null, optional: false, selected: true },
      ],
      [],
    );
    expect(details).toEqual({ included: ["Metal roof"], maybe: [] });
  });
});

describe("automations on a price range", () => {
  it("say the range, not the exact price, and link to the roofing project", async () => {
    state.tables.quotes![0]!.lines = [{ name: "Architectural shingle roof" }];
    const ctx = await loadContext(adminClient(env), ROOFER, "quote", QUOTE);
    expect(ctx?.vars.total).toBe("$18,300 to $21,050");
    expect(ctx?.appPath).toBe(`/roofing/${QUOTE}`);
    expect(ctx?.facts.amount).toBe(18304);

    state.tables.quotes![0]!.priced_on_site_at = "2026-10-25T18:00:00Z";
    state.tables.quotes![0]!.roof_package_id = null;
    const exact = await loadContext(adminClient(env), ROOFER, "quote", QUOTE);
    expect(exact?.vars.total).toBe("$18,304.00");
    expect(exact?.appPath).toBe(`/quotes/${QUOTE}`);
  });

  it("say how many options there are and the lowest price before the client chooses, never the option shown", async () => {
    withOptions({ option_id: METAL, total: 31253 });
    const q = state.tables.quotes![0]!;
    q.lines = state.tables.quote_line_items;
    q.options = state.tables.quote_options!.filter((o) => o.quote_id === QUOTE);
    const total = async () => (await loadContext(adminClient(env), ROOFER, "quote", QUOTE))?.vars.total;
    // "Just checking whether you had any questions about quote #1042 (2 options from $15,013.00)".
    expect(await total()).toBe("2 options from $15,013.00");
    // Signed, it's the option they chose.
    q.status = "approved";
    expect(await total()).toBe("$31,253.00");
    // While only one has a price, its total, as the quote's email said.
    q.status = "sent";
    q.lines = (q.lines as Row[]).filter((l) => l.option_id !== GOOD);
    expect(await total()).toBe("$31,253.00");
  });

  it("keep the range on one marked lost, and say the exact price once the office sent it instead", async () => {
    const q = state.tables.quotes![0]!;
    q.lines = [];
    q.status = "lost";
    expect((await loadContext(adminClient(env), ROOFER, "quote", QUOTE))?.vars.total).toBe("$18,300 to $21,050");

    q.status = "sent";
    q.exact_sent_at = "2026-10-24T15:00:00Z";
    expect((await loadContext(adminClient(env), ROOFER, "quote", QUOTE))?.vars.total).toBe("$18,304.00");
  });
});

describe("a quote with options on the client's home page", () => {
  const onHome = async () => (await (await hub({ t: "client", id: CLIENT })).json()).quotes.find((q: { id: string }) => q.id === QUOTE);

  it("says how many options there are and the lowest price until the client chooses, never the option shown", async () => {
    withOptions({ option_id: METAL, total: 31253 });
    expect(await onHome()).toMatchObject({ total: null, range: null, options: { count: 2, from: 15013 } });
    expect(JSON.stringify(await (await hub({ t: "client", id: CLIENT })).json())).not.toContain("31253");
    // Signed, the total is the option they chose.
    state.tables.quotes![0]!.status = "approved";
    expect(await onHome()).toMatchObject({ total: 31253, options: null });
  });

  it("shows the total while only one option has a price, and for a quote without options", async () => {
    withOptions();
    state.tables.quote_line_items = state.tables.quote_line_items!.filter((l) => l.option_id !== METAL);
    expect(await onHome()).toMatchObject({ total: 15013, options: null });
    roofer({ range_low: null, range_high: null, range_sent_at: null });
    expect(await onHome()).toMatchObject({ total: 18304, options: null });
  });
});

describe("a promo code on a price set on site", () => {
  const ADJUSTMENT = "00000000-0000-4000-8000-0000000000cb";
  const promo = () => hub({ t: "quote", id: QUOTE }, "/promo", { code: "SPRING" });
  beforeEach(() => {
    state.rpcs.apply_promo_code = () => ({ data: { total: 14000 }, error: null });
  });

  it("can't go on an option priced on site, where it would come off the price agreed", async () => {
    withOptions({ priced_on_site_at: "2026-10-25T18:00:00Z", subtotal: 14013, total: 14013 });
    state.tables.quote_line_items!.push(line(ADJUSTMENT, null, "Price adjustment", { option_id: GOOD, unit_price: -1000, sort: 9 }));
    const res = await promo();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Your price was set with you at the visit, so a promo code can't go on it. Give us a call about the code.");
    expect(state.calls.some((c) => c.name === "apply_promo_code")).toBe(false);
    // The page knows not to offer one.
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).quote.site_priced).toBe(true);
  });

  it("can't replace the discount a price set on site gave a quote without options", async () => {
    roofer({ range_low: null, range_high: null, range_sent_at: null, priced_on_site_at: "2026-10-25T18:00:00Z", discount_amount: 1000, total: 17304 });
    expect((await promo()).status).toBe(409);
    expect(state.calls.some((c) => c.name === "apply_promo_code")).toBe(false);
  });

  it("still goes on after a visit that kept the estimate's price", async () => {
    // Priced on site at the estimate's own price: no adjustment and no discount.
    roofer({ range_low: null, range_high: null, range_sent_at: null, priced_on_site_at: "2026-10-25T18:00:00Z" });
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).quote.site_priced).toBe(false);
    expect((await promo()).status).toBe(200);
    expect(state.calls.find((c) => c.name === "apply_promo_code")?.args).toEqual({ p_kind: "quote", p_id: QUOTE, p_code: "SPRING" });
    // An option priced on site that isn't shown any more doesn't count.
    state.calls = [];
    withOptions({ priced_on_site_at: "2026-10-25T18:00:00Z" });
    state.tables.quote_line_items!.push(line(ADJUSTMENT, null, "Price adjustment", { option_id: METAL, unit_price: -1000, selected: false, sort: 9 }));
    expect((await promo()).status).toBe(200);
  });
});

describe("a promo code's minimum order in the Client Hub", () => {
  beforeEach(() => {
    state.rpcs.apply_promo_code = () => ({ data: { total: 14000 }, error: null });
  });

  it("is checked against the option and add-ons the client is choosing", async () => {
    withOptions();
    const res = await hub({ t: "quote", id: QUOTE }, "/promo", { code: "SPRING", option_id: METAL.toUpperCase(), selected_line_ids: [L.snow] });
    expect(res.status).toBe(200);
    expect(state.calls.find((c) => c.name === "apply_promo_code")?.args).toEqual({ p_kind: "quote", p_id: QUOTE, p_code: "SPRING", p_option: METAL, p_selected: [L.snow] });
    // No add-ons ticked is a choice too.
    state.calls = [];
    await hub({ t: "quote", id: QUOTE }, "/promo", { code: "SPRING", option_id: GOOD, selected_line_ids: [] });
    expect(state.calls.find((c) => c.name === "apply_promo_code")?.args).toMatchObject({ p_option: GOOD, p_selected: [] });
  });

  it("turns down an option that isn't this estimate's", async () => {
    withOptions();
    const res = await hub({ t: "quote", id: QUOTE }, "/promo", { code: "SPRING", option_id: OTHER });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The options on this estimate changed. Please look it over again.");
    expect(state.calls.some((c) => c.name === "apply_promo_code")).toBe(false);
  });

  it("tells the page the code's minimum, so it can warn before signing", async () => {
    withOptions({ promo_code_id: "p-1", promo: { code: "SPRING", kind: "amount", value: 500, description: null, min_subtotal: 20000 } });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.promo).toMatchObject({ code: "SPRING", min_subtotal: 20000 });
    expect(body.quote.created_at).toBe("2026-10-21T13:00:00Z");
  });

  it("answers 409 with what to do when the choices at approval come to less than the code's minimum", async () => {
    withOptions();
    const message = "That code needs an order of at least $20,000.00. Remove the code, or change your choices.";
    state.rpcs.approve_hub_quote = () => ({ data: null, error: { message, code: "CX412" } });
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, option_id: GOOD, selected_line_ids: [], ...(await picked(GOOD, [])) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(message);
  });
});

describe("a single-package estimate's contract", () => {
  beforeEach(() => {
    roofer({ range_low: null, range_high: null, range_sent_at: null });
    state.tables.roof_packages![0]!.warranty = "10 years on our workmanship.";
    state.tables.document_templates![1]!.settings = { company_signs: false, terms: "Thanks, {Customer name}.", sections: [WARRANTY] };
    state.tables.contract_sections = [{ id: WARRANTY, company_id: ROOFER, title: "Warranty", body: "<p>{Option}: {Warranty}</p>", place: "terms", initials: false, sort: 1 }];
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
  });

  it("says its package's name and warranty in {Option} and {Warranty}, on the page and in the copy kept", async () => {
    const view = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(view.contract.facts).toMatchObject({ optionName: "Architectural shingle", warranty: "10 years on our workmanship." });
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, ...(await picked(null, [])) });
    expect(res.status).toBe(200);
    const approval = approvalArgs().p_approval as Row;
    expect(approval.option).toBeNull();
    expect((approval.contract as { sections: Row[] }).sections).toEqual([
      { id: WARRANTY, title: "Warranty", body: "<p>Architectural shingle: 10 years on our workmanship.</p>", place: "terms", initials: false, initialed: false },
    ]);
  });

  it("turns it down when the package's warranty changed after the page was read", async () => {
    const posted = await picked(null, []);
    state.tables.roof_packages![0]!.warranty = "5 years on our workmanship.";
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG, ...posted });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The terms changed. Please look them over again.");
  });
});

describe("an invoice's {Option} and {Warranty} in the Client Hub", () => {
  const INVOICE = "00000000-0000-4000-8000-0000000000e2";
  const invoice = (quote: Row | null) => ({
    id: INVOICE, company_id: ROOFER, number: 78, status: "sent", subject: "Roof replacement", notes: null, issued_on: "2026-10-01", due_on: "2026-10-31",
    subtotal: 32693, discount_amount: 0, tax_amount: 0, total: 32693, retainage_amount: 0, amount_paid: 0, balance_due: 32693, client_id: CLIENT, promo: null,
    client: { display_name: "Dana Whitfield", billing_address: {} }, job: { property: null, quote }, lines: [], payments: [],
  });
  const printed = async () => (await (await hub({ t: "invoice", id: INVOICE })).json()).contract.sections[0].body;

  it("say the option the job's estimate was signed for, else its package", async () => {
    roofer();
    state.tables.document_templates![0]!.settings = { invoice_sections: [WARRANTY] };
    state.tables.contract_sections = [{ id: WARRANTY, company_id: ROOFER, title: "Warranty", body: "<p>{Option}: {Warranty}</p>", place: "terms", initials: false, sort: 1 }];
    const option = { id: METAL, name: "Standing-seam metal", tier: "Better", picture: null, style: "metal", highlights: [], warranty: "Lifetime on the panels." };
    state.tables.invoices = [invoice({ approval: { name: "Dana Whitfield", option }, option_id: METAL, roof_package_id: null, option: { name: "Renamed later", warranty: "None" } })];
    expect(await printed()).toBe("<p>Standing-seam metal: Lifetime on the panels.</p>");
    state.tables.roof_packages![0]!.warranty = "10 years on our workmanship.";
    state.tables.invoices = [invoice({ approval: { name: "Dana Whitfield" }, option_id: null, roof_package_id: PACKAGE, option: null })];
    expect(await printed()).toBe("<p>Architectural shingle: 10 years on our workmanship.</p>");
    // A job that didn't come from an estimate has neither.
    state.tables.invoices = [invoice(null)];
    expect(await printed()).toBe("<p>: </p>");
  });
});

// ---------------------------------------------------------------------------------------------
// Autopay and tips (docs/autopay-plan.md). Tips follow one rule, held to on the server: the business
// has them on (settings.hub_tips, Settings → Company) and the invoice wasn't made in Stripe. Off,
// no page offers a tip, and no request adds one.
// ---------------------------------------------------------------------------------------------

const MOW = "00000000-0000-4000-8000-0000000000f1";
const CARD = "00000000-0000-4000-8000-0000000000f2";
const CHARGED_AT = "2026-10-27T23:10:00Z";

/** A lawn company's weekly mow for the client, invoice #2 for $45, with tips on or off. */
function mowed(invoice: Row = {}, { tips = false }: { tips?: boolean } = {}) {
  roofer();
  const company = state.tables.companies![0]!;
  Object.assign(company, { name: "Radford Lawn Care", trade_preset: "lawn_exterior", settings: { ...(company.settings as Row), hub_tips: tips } });
  state.tables.invoices = [{
    id: MOW, company_id: ROOFER, number: 2, status: "sent", subject: "Weekly mow", notes: null, issued_on: "2026-10-27", due_on: "2026-11-10",
    subtotal: 45, discount_amount: 0, tax_amount: 0, total: 45, retainage_amount: 0, amount_paid: 0, balance_due: 45, client_id: CLIENT, promo: null,
    client: { display_name: "Pat Lee", billing_address: {} }, job: { property: null, quote: null },
    lines: [{ name: "Weekly mow", description: null, quantity: 1, unit: "visit", unit_price: 45, sort: 1 }], payments: [],
    ...invoice,
  }];
}
/** The mow, paid by the automatic charge to the client's Visa. */
const paidMow = (tips: boolean) => mowed({ status: "paid", amount_paid: 45, balance_due: 0 }, { tips });
/** What services/autopay.ts would say about an invoice its charge paid, with a tip on offer. */
const paidAutomatically = {
  autopay: { status: "paid" as const, method: "Visa ending 4242", charged_at: CHARGED_AT }, save_card: false, tip_after: true, tip_method: "Visa ending 4242",
};
const invoicePage = async (link: Partial<HubLink> = {}, search = "") => (await hub({ t: "invoice", id: MOW, ...link }, search)).json();
const stripeCalls = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([url]) => String(url instanceof Request ? url.url : url).includes("stripe.com"));

// The tips-off rows of docs/autopay-plan.md's contract (5.4), one each: the user's own test of the
// feature is turning tips off in Settings → Company and seeing the Client Hub follow.
describe("with tips turned off in Settings → Company", () => {
  it("an invoice says it takes no tip, and an invoice made in Stripe never does", async () => {
    mowed();
    expect((await invoicePage()).tips).toBe(false);
    // Made in Stripe: paid exactly as Stripe billed it, with tips on or off.
    mowed({}, { tips: true });
    state.tables.stripe_invoices = [{ company_id: ROOFER, invoice_id: MOW, origin: "stripe", status: "open", livemode: false, detached_at: null }];
    expect((await invoicePage()).tips).toBe(false);
  });

  it("no tip is offered after an automatic charge to the card, whatever the autopay facts say", async () => {
    paidMow(false);
    vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValueOnce(paidAutomatically);
    const page = await invoicePage({}, "?tip=1");
    expect(page).toMatchObject({ tips: false, tip_after: false, tip_method: null, autopay: paidAutomatically.autopay });
    // The autopay facts are worked out knowing tips are off.
    expect(vi.mocked(autopay.hubInvoiceAutopay).mock.calls[0]![4]).toEqual({ tips: false, preview: false, imported: false, trust: "client" });
  });

  it("Pay with a tip is turned down before anything reaches Stripe", async () => {
    mowed();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const tip of [15, 0.5, 6.75]) {
      const res = await hub({ t: "invoice", id: MOW }, "/pay", { tip });
      expect(res.status, String(tip)).toBe(409);
      expect((await res.json()).error).toBe("Tips aren't offered here anymore. Check the amount and pay again.");
    }
    expect(stripeCheckout).not.toHaveBeenCalled();
    expect(stripeCalls(fetchSpy)).toEqual([]);
  });

  it("Pay without a tip pays the balance", async () => {
    mowed();
    const res = await hub({ t: "invoice", id: MOW }, "/pay", { tip: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://invoice.stripe.test/i/pay" });
    expect(vi.mocked(stripeCheckout).mock.calls[0]!.slice(2)).toEqual([ROOFER, MOW, 0]);
    // Nothing sent is no tip either.
    expect((await hub({ t: "invoice", id: MOW }, "/pay", {})).status).toBe(200);
    expect(vi.mocked(stripeCheckout).mock.calls[1]![4]).toBe(0);
  });

  it("a Stripe invoice the client made with a tip before is replaced by Pay without one", async () => {
    // Made from the Pay screen with a $6.75 tip while tips were on, still open on Stripe's page.
    mowed();
    state.tables.stripe_invoices = [{ company_id: ROOFER, invoice_id: MOW, origin: "crewtavo", purpose: "invoice", status: "open", livemode: false, detached_at: null, amount_due: 51.75, tip_amount: 6.75 }];
    // The page loaded before tips went off asks for the tip again: turned down.
    expect((await hub({ t: "invoice", id: MOW }, "/pay", { tip: 6.75 })).status).toBe(409);
    expect(stripeCheckout).not.toHaveBeenCalled();
    // Loaded again, it pays the balance: stripeCheckout replaces the tipped one (integrations/stripe.ts).
    expect((await hub({ t: "invoice", id: MOW }, "/pay", { tip: 0 })).status).toBe(200);
    expect(vi.mocked(stripeCheckout).mock.calls[0]![4]).toBe(0);
  });

  it("a tip on the saved card is turned down before any Stripe call", async () => {
    paidMow(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await hub({ t: "invoice", id: MOW }, "/tip", { tip: 6.75 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Tips are turned off.");
    expect(autopay.tipOnSavedCard).not.toHaveBeenCalled();
    expect(stripeCalls(fetchSpy)).toEqual([]);

    // On an invoice made in Stripe, with tips on: the same.
    paidMow(true);
    state.tables.stripe_invoices = [{ company_id: ROOFER, invoice_id: MOW, origin: "stripe", status: "paid", livemode: false, detached_at: null }];
    expect((await hub({ t: "invoice", id: MOW }, "/tip", { tip: 6.75 })).status).toBe(409);
    expect(autopay.tipOnSavedCard).not.toHaveBeenCalled();
    expect(stripeCalls(fetchSpy)).toEqual([]);
  });

  it("turning them off reaches a page already open: its next request is turned down", async () => {
    // Loaded with tips on, the tip after the charge is offered.
    paidMow(true);
    vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValueOnce(paidAutomatically);
    expect((await invoicePage()).tip_after).toBe(true);
    // The office turns tips off; the client taps the tip they chose on the page as it was.
    state.tables.companies![0]!.settings = { ...(state.tables.companies![0]!.settings as Row), hub_tips: false };
    expect((await hub({ t: "invoice", id: MOW }, "/tip", { tip: 6.75 })).status).toBe(409);
    expect(autopay.tipOnSavedCard).not.toHaveBeenCalled();
  });

  it("a business that never turned them on has them off too, on every page and request", async () => {
    paidMow(false);
    const settings = { ...(state.tables.companies![0]!.settings as Row) };
    delete settings.hub_tips;
    state.tables.companies![0]!.settings = settings;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValueOnce(paidAutomatically);
    expect(await invoicePage({}, "?tip=1")).toMatchObject({ tips: false, tip_after: false, tip_method: null });
    expect((await hub({ t: "invoice", id: MOW }, "/tip", { tip: 6.75 })).status).toBe(409);
    mowed();
    state.tables.companies![0]!.settings = settings;
    expect((await invoicePage()).tips).toBe(false);
    expect((await hub({ t: "invoice", id: MOW }, "/pay", { tip: 6.75 })).status).toBe(409);
    expect((await hub({ t: "invoice", id: MOW }, "/pay", { tip: 0 })).status).toBe(200);
    expect(vi.mocked(stripeCheckout).mock.calls.map((call) => call[4])).toEqual([0]);
    expect(autopay.tipOnSavedCard).not.toHaveBeenCalled();
    expect(stripeCalls(fetchSpy)).toEqual([]);
  });
});

describe("with tips turned on", () => {
  it("an invoice takes a tip", async () => {
    mowed({}, { tips: true });
    expect((await invoicePage()).tips).toBe(true);
  });

  it("Pay adds the tip chosen", async () => {
    mowed({}, { tips: true });
    expect((await hub({ t: "invoice", id: MOW }, "/pay", { tip: 6.75 })).status).toBe(200);
    expect(vi.mocked(stripeCheckout).mock.calls[0]![4]).toBe(675);
  });

  it("a tip is offered after an automatic charge, from the client's own link only", async () => {
    paidMow(true);
    vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValueOnce(paidAutomatically);
    expect(await invoicePage()).toMatchObject({ tips: true, tip_after: true, tip_method: "Visa ending 4242" });

    // A copy of the link the office made: none, whatever the autopay facts say, and none can be added.
    vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValueOnce(paidAutomatically);
    expect(await invoicePage({ via: "office" })).toMatchObject({ tips: true, tip_after: false, tip_method: null });
    expect(vi.mocked(autopay.hubInvoiceAutopay).mock.calls[1]![4]).toMatchObject({ trust: "office" });
    const res = await hub({ t: "invoice", id: MOW, via: "office" }, "/tip", { tip: 6.75 });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Tips are added from the client's own link.");
    // A link from before the client's own were marked (one kept on the timeline, say): none either.
    vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValueOnce(paidAutomatically);
    expect(await invoicePage({ old: true })).toMatchObject({ tips: true, tip_after: false, tip_method: null });
    expect(vi.mocked(autopay.hubInvoiceAutopay).mock.calls[2]![4]).toMatchObject({ trust: "legacy" });
    const old = await hub({ t: "invoice", id: MOW, old: true }, "/tip", { tip: 6.75 });
    expect(old.status).toBe(403);
    expect((await old.json()).error).toBe("Tips are added from the client's own link.");
    // Nor on a preview.
    vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValueOnce(paidAutomatically);
    expect(await invoicePage({ pv: 1 })).toMatchObject({ tip_after: false });
    expect(autopay.tipOnSavedCard).not.toHaveBeenCalled();
  });

  it("the tip goes to the card that paid, with who asked for it", async () => {
    paidMow(true);
    vi.mocked(autopay.tipOnSavedCard).mockResolvedValueOnce({ status: "paid", tip: 6.75 });
    const res = await app.request(
      `/api/hub/${await tokenFor({ t: "invoice", id: MOW })}/tip`,
      { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (iPhone)" }, body: JSON.stringify({ tip: 6.75 }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "paid", tip: 6.75 });
    expect(vi.mocked(autopay.tipOnSavedCard).mock.calls[0]![2]).toEqual({ companyId: ROOFER, invoiceId: MOW, tip: 6.75, ip: expect.any(String), userAgent: "Mozilla/5.0 (iPhone)" });
    // A declined card stays a 402, so the page says so.
    vi.mocked(autopay.tipOnSavedCard).mockRejectedValueOnce(new HttpError(402, "Your card was declined, so the tip wasn't added."));
    expect((await hub({ t: "invoice", id: MOW }, "/tip", { tip: 5 })).status).toBe(402);
    // Nothing, a negative amount, or too much isn't a tip.
    for (const tip of [0, -5, 20_000]) expect((await hub({ t: "invoice", id: MOW }, "/tip", { tip })).status, String(tip)).toBe(400);
    // Only on an invoice's own link.
    expect((await hub({ t: "client", id: CLIENT }, "/tip", { tip: 5 })).status).toBe(400);
  });
});

describe("paying an invoice in the Client Hub", () => {
  it("waits while the saved card is being charged for it, and the code can't change then", async () => {
    mowed({}, { tips: true });
    state.tables.autopay_charges = [{ id: "ch-1", company_id: ROOFER, client_id: CLIENT, invoice_id: MOW, status: "charging" }];
    const pay = await hub({ t: "invoice", id: MOW }, "/pay", { tip: 0 });
    expect(pay.status).toBe(409);
    expect((await pay.json()).error).toBe("This invoice is being charged to your saved card right now.");
    expect(stripeCheckout).not.toHaveBeenCalled();

    state.rpcs.apply_promo_code = () => ({ data: { total: 40 }, error: null });
    state.rpcs.remove_promo_code = () => ({ data: null, error: null });
    const promo = await hub({ t: "invoice", id: MOW }, "/promo", { code: "SPRING" });
    expect(promo.status).toBe(409);
    expect((await promo.json()).error).toBe("This invoice is being charged to your saved card right now.");
    const removed = await app.request(`/api/hub/${await tokenFor({ t: "invoice", id: MOW })}/promo`, { method: "DELETE" }, env);
    expect(removed.status).toBe(409);
    expect(state.calls.some((c) => c.name === "apply_promo_code" || c.name === "remove_promo_code")).toBe(false);

    // Charged (or called off), it's the usual invoice again.
    state.tables.autopay_charges![0]!.status = "failed";
    expect((await hub({ t: "invoice", id: MOW }, "/pay", { tip: 0 })).status).toBe(200);
    expect((await hub({ t: "invoice", id: MOW }, "/promo", { code: "SPRING" })).status).toBe(200);
  });

  it("hides Pay while the card is being charged", async () => {
    mowed();
    const shared = env as Env & { STRIPE_SECRET_KEY?: string };
    shared.STRIPE_SECRET_KEY = "sk_test_shared";
    try {
      expect((await invoicePage()).can_pay).toBe(true);
      vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValueOnce({ autopay: { status: "charging", method: "Visa ending 4242", charged_at: null }, save_card: false, tip_after: false, tip_method: null });
      expect(await invoicePage()).toMatchObject({ can_pay: false, autopay: { status: "charging" } });
      vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValueOnce({ autopay: { status: "failed", method: "Visa ending 4242", charged_at: null }, save_card: false, tip_after: false, tip_method: null });
      expect(await invoicePage()).toMatchObject({ can_pay: true, autopay: { status: "failed" } });
      // Refunded and taken off the invoice too: still a balance, but the office chose not to collect it.
      mowed({ status: "written_off", amount_paid: 0, balance_due: 45 });
      expect(await invoicePage()).toMatchObject({ can_pay: false, invoice: { status: "written_off", balance_due: 45 } });
    } finally {
      delete shared.STRIPE_SECRET_KEY;
    }
  });

  it("offers to save the card after paying, never on a preview", async () => {
    mowed({ status: "paid", amount_paid: 45, balance_due: 0 });
    vi.mocked(autopay.hubInvoiceAutopay).mockResolvedValue({ autopay: null, save_card: true, tip_after: false, tip_method: null });
    expect((await invoicePage()).save_card).toBe(true);
    const preview = await invoicePage({ pv: 1 });
    expect(preview).toMatchObject({ save_card: false, tip_after: false, home: null });
    expect(vi.mocked(autopay.hubInvoiceAutopay).mock.calls[1]![4]).toMatchObject({ preview: true });
  });
});

describe("autopay on the client's home page", () => {
  it("is null when the business doesn't take autopay", async () => {
    const home = await (await hub({ t: "client", id: CLIENT })).json();
    expect(home.autopay).toBeNull();
    expect(home.preview).toBe(false);
  });

  it("sends the autopay card as services/autopay.ts has it, for the link it was opened from", async () => {
    const card = {
      status: "active" as const, method: { id: CARD, type: "card", label: "Visa ending 4242", exp: "08/28" }, imported: false, since: "2026-10-31T14:05:09Z",
      terms: "We charge the card on file after each visit is done.", terms_version: "2026-10-31T14:05:09", timing: "at the end of the day of each visit",
      next_charge: "2026-11-01T05:00:00Z", per_visit: 45, per_visit_taxed: false, available: true, card_required: false,
    };
    vi.mocked(autopay.hubAutopay).mockResolvedValueOnce(card);
    expect((await (await hub({ t: "client", id: CLIENT })).json()).autopay).toEqual(card);
    expect(vi.mocked(autopay.hubAutopay).mock.calls[0]!.slice(2)).toEqual([ROOFER, CLIENT, { trust: "client" }]);
    await hub({ t: "client", id: CLIENT, via: "office" });
    expect(vi.mocked(autopay.hubAutopay).mock.calls[1]![4]).toEqual({ trust: "office" });
    // A link from before the client's own were marked is its own kind for saying yes to a card.
    await hub({ t: "client", id: CLIENT, old: true });
    expect(vi.mocked(autopay.hubAutopay).mock.calls[2]![4]).toEqual({ trust: "legacy" });
  });

  it("says which invoices are charged automatically, and which payments were", async () => {
    mowed({ status: "paid", amount_paid: 45, balance_due: 0 });
    const visa = { type: "card", brand: "visa", last4: "4242", bank_name: null, wallet: null };
    state.tables.invoices!.push(
      { ...state.tables.invoices![0]!, id: "inv-3", number: 3, status: "sent", balance_due: 45, issued_on: "2026-11-03" },
      { ...state.tables.invoices![0]!, id: "inv-4", number: 4, status: "sent", balance_due: 45, issued_on: "2026-11-10" },
      { ...state.tables.invoices![0]!, id: "inv-5", number: 5, status: "overdue", balance_due: 45, issued_on: "2026-11-17" },
    );
    state.tables.autopay_charges = [
      { company_id: ROOFER, client_id: CLIENT, invoice_id: MOW, status: "paid", method: visa },
      { company_id: ROOFER, client_id: CLIENT, invoice_id: "inv-3", status: "charging", method: visa },
      { company_id: ROOFER, client_id: CLIENT, invoice_id: "inv-4", status: "failed", failures: 1, method: visa },
      // Called off: the invoice is owed the usual way, and nothing says autopay.
      { company_id: ROOFER, client_id: CLIENT, invoice_id: "inv-5", status: "called_off", method: visa },
    ];
    state.tables.payments = [
      { company_id: ROOFER, client_id: CLIENT, amount: 45, tip_amount: 0, method: "card", received_at: "2026-10-27T23:10:00Z", invoice_id: MOW, processor: "stripe", invoice: { number: 2 } },
      // A check on another invoice.
      { company_id: ROOFER, client_id: CLIENT, amount: 30, tip_amount: 0, method: "check", received_at: "2026-10-20T15:00:00Z", invoice_id: "inv-5", processor: null, invoice: { number: 5 } },
    ];
    const home = await (await hub({ t: "client", id: CLIENT })).json();
    expect(home.invoices.map((i: { number: number; autopay: string | null }) => [i.number, i.autopay])).toEqual([[2, "paid"], [3, "charging"], [4, "failed"], [5, null]]);
    // The failed one, then paid by bank on Stripe's page: on its way, not waiting on the client
    // (a bank payment in a Stripe account Crewtavo has left is the office's to follow).
    state.tables.stripe_invoices = [{ company_id: ROOFER, invoice_id: "inv-4", purpose: "invoice", status: "processing", detached_at: null }];
    const paying = await (await hub({ t: "client", id: CLIENT })).json();
    expect(paying.invoices.map((i: { number: number; autopay: string | null }) => [i.number, i.autopay])).toEqual([[2, "paid"], [3, "charging"], [4, "processing"], [5, null]]);
    state.tables.stripe_invoices = [{ company_id: ROOFER, invoice_id: "inv-4", purpose: "invoice", status: "processing", detached_at: "2026-11-04T00:00:00Z" }];
    expect((await (await hub({ t: "client", id: CLIENT })).json()).invoices[2].autopay).toBe("failed");
    // Moved back to be tried on a card the client agreed to since (no failures on it): shown as one waiting, so not at all.
    state.tables.stripe_invoices = [];
    state.tables.autopay_charges[2]!.failures = 0;
    expect((await (await hub({ t: "client", id: CLIENT })).json()).invoices[2].autopay).toBeNull();
    expect(home.payments).toEqual([
      { amount: 45, tip_amount: 0, method: "card", received_at: "2026-10-27T23:10:00Z", invoice: 2, auto: true, card: "Visa ending 4242" },
      { amount: 30, tip_amount: 0, method: "check", received_at: "2026-10-20T15:00:00Z", invoice: 5, auto: false, card: null },
    ]);
    // Nothing about the payment's processor or the charges' ids goes out.
    expect(JSON.stringify(home)).not.toMatch(/processor|invoice_id/);
  });
});

describe("a copy of the client's link the office made", () => {
  it("stays one in every link the Hub makes from it, and the client's own stays theirs", async () => {
    mowed();
    const via = async (url: string) => (await readClientLink(env, url.split("/hub/")[1]!))?.via;
    const office = await (await hub({ t: "client", id: CLIENT, via: "office" })).json();
    expect(await via(office.invoices[0].link)).toBe("office");
    expect(await via(office.quotes[0].link)).toBe("office");
    expect(await via((await invoicePage({ via: "office" })).home)).toBe("office");

    const own = await (await hub({ t: "client", id: CLIENT })).json();
    expect(await via(own.invoices[0].link)).toBeUndefined();
    expect(await via((await invoicePage()).home)).toBeUndefined();
  });

  it("keeps the client's own mark on the links the Hub makes from their own, and never adds it to one without", async () => {
    mowed();
    const payload = (url: string) => readClientLink(env, url.split("/hub/")[1]!);
    const own = await (await hub({ t: "client", id: CLIENT })).json();
    expect(await payload(own.invoices[0].link)).toMatchObject({ t: "invoice", own: 1 });
    expect(await payload(own.quotes[0].link)).toMatchObject({ t: "quote", own: 1 });
    expect(await payload((await invoicePage()).home)).toMatchObject({ t: "client", own: 1 });
    // From a link minted before the mark: neither the client's own mark nor the office's.
    const old = await (await hub({ t: "client", id: CLIENT, old: true })).json();
    for (const url of [old.invoices[0].link, old.quotes[0].link, (await invoicePage({ old: true })).home]) {
      const link = await payload(url);
      expect(link?.own).toBeUndefined();
      expect(link?.via).toBeUndefined();
    }
    // The office's copy never gets it.
    expect((await payload((await invoicePage({ via: "office" })).home))?.own).toBeUndefined();
  });
});

describe("loading a Hub page", () => {
  it("never asks Stripe anything", async () => {
    mowed({}, { tips: true });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const link of [{ t: "client" as const, id: CLIENT }, { t: "invoice" as const, id: MOW }, { t: "quote" as const, id: QUOTE }]) {
      expect((await hub(link)).status, link.t).toBe(200);
    }
    expect(stripeCalls(fetchSpy)).toEqual([]);
  });
});

describe("approving a quote for work charged by the visit", () => {
  // A weekly mow, priced per visit, sent at its exact price.
  function weekly(quote: Row = {}) {
    roofer({ range_low: null, range_high: null, range_sent_at: null, title: "Weekly mowing", total: 45, subtotal: 45, roof_package_id: null, template_id: null, ...quote });
    Object.assign(state.tables.companies![0]!, { trade_preset: "lawn_exterior" });
    state.tables.document_templates = [];
    state.tables.quote_line_items = [line("m1", null, "Weekly mow", { unit: "visit", unit_price: 45, sort: 1 })];
  }

  it("offers \"Approve and set up autopay\" when the business takes autopay and the client isn't on it", async () => {
    weekly();
    vi.mocked(autopay.autopayOffered).mockResolvedValue(true);
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).autopay_offer).toBe(true);
    expect(vi.mocked(autopay.autopayOffered).mock.calls[0]!.slice(2)).toEqual([ROOFER, CLIENT]);
    vi.mocked(autopay.autopayOffered).mockResolvedValue(false);
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).autopay_offer).toBe(false);
  });

  it("doesn't offer it on a preview, a price range, a change order or work not charged by the visit", async () => {
    vi.mocked(autopay.autopayOffered).mockResolvedValue(true);
    weekly();
    expect((await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json()).autopay_offer).toBe(false);
    weekly({ range_low: 40, range_high: 60, range_sent_at: "2026-10-22T15:00:00Z" });
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).autopay_offer).toBe(false);
    weekly({ change_order_for: "q-original" });
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).autopay_offer).toBe(false);
    weekly();
    state.tables.quote_line_items = [line("m1", null, "Spring cleanup", { unit: "ea", unit_price: 300, sort: 1 })];
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).autopay_offer).toBe(false);
    expect(autopay.autopayOffered).not.toHaveBeenCalled();
  });

  it("asks for a card on any quote when the business needs one on file, and never sends its autopay settings", async () => {
    vi.mocked(autopay.autopayOffered).mockResolvedValue(true);
    weekly();
    let body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body).toMatchObject({ autopay_offer: true, card_required: false });
    const settings = state.tables.companies![0]!.settings as Row;
    state.tables.companies![0]!.settings = { ...settings, autopay: { enabled: true, card_required: true, terms: "Charged after each mow." } };
    body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body).toMatchObject({ autopay_offer: true, card_required: true });
    expect(JSON.stringify(body)).not.toContain("Charged after each mow.");
    // A one-off job, not charged by the visit, asks too.
    state.tables.quote_line_items = [line("m1", null, "Spring cleanup", { unit: "ea", unit_price: 300, sort: 1 })];
    expect((await (await hub({ t: "quote", id: QUOTE })).json())).toMatchObject({ autopay_offer: true, card_required: true });
    // Not when the client is on autopay already (or the business can't take it), a preview, a price range or a change order.
    vi.mocked(autopay.autopayOffered).mockResolvedValue(false);
    expect((await (await hub({ t: "quote", id: QUOTE })).json())).toMatchObject({ autopay_offer: false, card_required: false });
    vi.mocked(autopay.autopayOffered).mockResolvedValue(true);
    expect((await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json()).card_required).toBe(false);
    weekly({ change_order_for: "q-original" });
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).card_required).toBe(false);
    weekly({ range_low: 40, range_high: 60, range_sent_at: "2026-10-22T15:00:00Z" });
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).card_required ?? false).toBe(false);
  });

  it("prints and keeps the lawn starter terms when the business never wrote its own", async () => {
    weekly();
    const view = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(view.template.terms).toBe(TRADE_TERMS.lawn_exterior);
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Pat Lee", signature: PNG, ...(await picked(null, [])) });
    expect(res.status).toBe(200);
    expect(((approvalArgs().p_approval as Row).template as Row).terms).toBe(TRADE_TERMS.lawn_exterior);
    // The invoice prints them too.
    mowed();
    state.tables.document_templates = [];
    expect((await invoicePage()).template.terms).toBe(TRADE_TERMS.lawn_exterior);
  });
});

describe("setting up autopay from the Client Hub", () => {
  const post = (link: HubLink, path: string, body: unknown, headers: Record<string, string> = {}) =>
    tokenFor(link).then((token) => app.request(`/api/hub/${token}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, env));
  const agreement = { payment_method_id: CARD, terms_version: "2026-10-31T14:05:09", agreed: true };

  it("sends the client of whichever link it came from to Stripe's page, which comes back to their home", async () => {
    mowed();
    vi.mocked(autopay.startAutopaySetup).mockResolvedValue({ url: "https://checkout.stripe.test/c/setup" });
    const res = await post({ t: "invoice", id: MOW }, "/autopay/setup", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/c/setup" });
    const input = vi.mocked(autopay.startAutopaySetup).mock.calls[0]![2];
    expect(input).toMatchObject({ companyId: ROOFER, clientId: CLIENT, trust: "client" });
    const home = await readClientLink(env, input.home.split("/hub/")[1]!);
    expect(home).toMatchObject({ c: ROOFER, t: "client", id: CLIENT, own: 1 });
    expect(home?.via).toBeUndefined();
    // From an office copy, it comes back to an office copy, and the card is saved as one saved through it.
    await post({ t: "client", id: CLIENT, via: "office" }, "/autopay/setup", {});
    const office = vi.mocked(autopay.startAutopaySetup).mock.calls[1]![2];
    expect(office.trust).toBe("office");
    expect((await readClientLink(env, office.home.split("/hub/")[1]!))?.via).toBe("office");
    // From a link minted before the mark it still works, and the card is saved as that link can say yes to it.
    const res2 = await post({ t: "client", id: CLIENT, old: true }, "/autopay/setup", {});
    expect(res2.status).toBe(200);
    const old = vi.mocked(autopay.startAutopaySetup).mock.calls[2]![2];
    expect(old.trust).toBe("legacy");
    const oldHome = await readClientLink(env, old.home.split("/hub/")[1]!);
    expect(oldHome?.own).toBeUndefined();
    expect(oldHome?.via).toBeUndefined();
  });

  it("says saving cards isn't working when Stripe doesn't answer", async () => {
    vi.mocked(autopay.startAutopaySetup).mockRejectedValueOnce(new StripeError("Stripe is down", 500));
    const res = await post({ t: "client", id: CLIENT }, "/autopay/setup", {});
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Saving cards isn't working right now. Try again in a few minutes.");
  });

  it("finishes a setup from Stripe's page, by its session only", async () => {
    vi.mocked(autopay.finishAutopaySetup).mockResolvedValueOnce({ status: "agree", method: { id: CARD, label: "Visa ending 4242", type: "card", exp: "08/28" } });
    const res = await post({ t: "client", id: CLIENT }, "/autopay/finish", { session_id: "cs_test_a1B2c3" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "agree", method: { label: "Visa ending 4242" } });
    expect(vi.mocked(autopay.finishAutopaySetup).mock.calls[0]![2]).toEqual({ companyId: ROOFER, clientId: CLIENT, sessionId: "cs_test_a1B2c3" });
    for (const session_id of ["pi_123", "cs_../../x", ""]) expect((await post({ t: "client", id: CLIENT }, "/autopay/finish", { session_id })).status, session_id).toBe(400);
  });

  it("keeps the agreement with the link it was made on, the browser and who the link was for", async () => {
    vi.mocked(autopay.confirmAutopay).mockResolvedValue({ status: "active", method: "Visa ending 4242" });
    const res = await post({ t: "quote", id: QUOTE }, "/autopay/confirm", agreement, { "User-Agent": "Mozilla/5.0 (iPhone)" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "active", method: "Visa ending 4242" });
    expect(vi.mocked(autopay.confirmAutopay).mock.calls[0]![2]).toEqual({
      companyId: ROOFER, clientId: CLIENT, paymentMethodId: CARD, termsVersion: "2026-10-31T14:05:09", ip: expect.any(String), userAgent: "Mozilla/5.0 (iPhone)", linkKind: "quote", via: "client", trust: "client",
    });
    await post({ t: "client", id: CLIENT, via: "office" }, "/autopay/confirm", agreement);
    expect(vi.mocked(autopay.confirmAutopay).mock.calls[1]![2]).toMatchObject({ linkKind: "client", via: "office", trust: "office" });
    // A link from before the mark is kept as the client's, but is its own kind for which card it can say yes to.
    await post({ t: "client", id: CLIENT, old: true }, "/autopay/confirm", agreement);
    expect(vi.mocked(autopay.confirmAutopay).mock.calls[2]![2]).toMatchObject({ linkKind: "client", via: "client", trust: "legacy" });
    // Only with the box ticked, for a card's id and the terms' version.
    for (const body of [{ ...agreement, agreed: false }, { ...agreement, payment_method_id: "pm_123" }, { ...agreement, terms_version: "" }]) {
      expect((await post({ t: "client", id: CLIENT }, "/autopay/confirm", body)).status).toBe(400);
    }
    expect(autopay.confirmAutopay).toHaveBeenCalledTimes(3);
  });

  it("turns autopay off as the client, from any of their links", async () => {
    mowed();
    vi.mocked(autopay.turnOffAutopay).mockResolvedValue(undefined);
    // From the invoice's link, it's the invoice's client whose autopay goes off.
    const off = await post({ t: "invoice", id: MOW }, "/autopay/off", {});
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true });
    expect(vi.mocked(autopay.turnOffAutopay).mock.calls[0]![1]).toEqual({ companyId: ROOFER, clientId: CLIENT, via: "client", userId: null });
    // An office copy of the link is still the client turning it off (it's how offices send the Hub).
    await post({ t: "client", id: CLIENT, via: "office" }, "/autopay/off", {});
    expect(vi.mocked(autopay.turnOffAutopay).mock.calls[1]![1]).toMatchObject({ via: "client" });
    // A link to an invoice that's gone turns nothing off.
    state.tables.invoices = [];
    expect((await post({ t: "invoice", id: MOW }, "/autopay/off", {})).status).toBe(404);
    expect(autopay.turnOffAutopay).toHaveBeenCalledTimes(2);
  });

  it("does nothing from a preview", async () => {
    mowed({}, { tips: true });
    for (const [path, body] of [["/autopay/setup", {}], ["/autopay/finish", { session_id: "cs_test_1" }], ["/autopay/confirm", agreement], ["/autopay/off", {}]] as const) {
      for (const link of [{ t: "quote" as const, id: QUOTE, pv: 1 as const }, { t: "invoice" as const, id: MOW, pv: 1 as const }]) {
        const res = await post(link, path, body);
        expect(res.status, `${link.t} ${path}`).toBe(400);
        expect((await res.json()).error).toBe("Autopay can't be set up from a preview.");
      }
    }
    const tip = await post({ t: "invoice", id: MOW, pv: 1 }, "/tip", { tip: 5 });
    expect(tip.status).toBe(400);
    expect((await tip.json()).error).toBe("Tips can't be added from a preview.");
    for (const fn of [autopay.startAutopaySetup, autopay.finishAutopaySetup, autopay.confirmAutopay, autopay.turnOffAutopay, autopay.tipOnSavedCard]) expect(fn).not.toHaveBeenCalled();
  });

  it("counts tries against the visitor and the client, and answers 429 past them", async () => {
    mowed({ status: "paid", amount_paid: 45, balance_due: 0 }, { tips: true });
    vi.mocked(autopay.startAutopaySetup).mockResolvedValue({ url: "https://checkout.stripe.test/c/setup" });
    await post({ t: "client", id: CLIENT }, "/autopay/setup", {});
    const keys = state.calls.filter((c) => c.name === "rate_limit_hit").map((c) => [c.args.p_key, c.args.p_max, c.args.p_window_seconds]);
    expect(keys).toEqual([["autopay:ip:unknown", 10, 600], [`autopay:client:${CLIENT}`, 5, 600]]);

    state.calls = [];
    vi.mocked(autopay.tipOnSavedCard).mockResolvedValue({ status: "paid", tip: 5 });
    await post({ t: "invoice", id: MOW }, "/tip", { tip: 5 });
    expect(state.calls.filter((c) => c.name === "rate_limit_hit").map((c) => [c.args.p_key, c.args.p_max, c.args.p_window_seconds])).toEqual([["tip:ip:unknown", 10, 600], [`tip:invoice:${MOW}`, 3, 3600]]);

    state.rpcs.rate_limit_hit = () => ({ data: false, error: null });
    vi.mocked(autopay.startAutopaySetup).mockClear();
    vi.mocked(autopay.tipOnSavedCard).mockClear();
    for (const [link, path, body] of [
      [{ t: "client", id: CLIENT }, "/autopay/setup", {}],
      [{ t: "client", id: CLIENT }, "/autopay/finish", { session_id: "cs_test_1" }],
      [{ t: "client", id: CLIENT }, "/autopay/confirm", agreement],
      [{ t: "client", id: CLIENT }, "/autopay/off", {}],
      [{ t: "invoice", id: MOW }, "/tip", { tip: 5 }],
    ] as Array<[HubLink, string, unknown]>) {
      const res = await post(link, path, body);
      expect(res.status, path).toBe(429);
      expect((await res.json()).error).toBe("Too many tries. Wait a few minutes and try again.");
    }
    for (const fn of [autopay.startAutopaySetup, autopay.finishAutopaySetup, autopay.confirmAutopay, autopay.turnOffAutopay, autopay.tipOnSavedCard]) expect(fn).not.toHaveBeenCalled();
  });
});

// The same pages with the real autopay facts (services/autopay.ts) worked out from the saved cards,
// agreements and charges, for a business with its own Stripe key that can save cards.
describe("autopay facts from the business's saved cards and agreements", () => {
  const AGREEMENT = "00000000-0000-4000-8000-0000000000f3";
  const visa = {
    id: CARD, company_id: ROOFER, client_id: CLIENT, stripe_payment_method_id: "pm_visa", stripe_customer_id: "cus_pat", stripe_account: "acct_radford", livemode: false,
    type: "card", brand: "visa", wallet: null, last4: "4242", exp_month: 8, exp_year: 2028, bank_name: null, status: "active", is_default: true, source: "hub", saved_via: "client",
    removed_at: null, removed_reason: null, created_at: "2026-10-01T15:00:00Z", updated_at: "2026-10-01T15:00:00Z",
  };
  const agreed = {
    id: AGREEMENT, company_id: ROOFER, client_id: CLIENT, payment_method_id: CARD, terms: "We charge the card on file after each visit is done.", terms_version: "2026-10-01T15:00:00",
    accepted_at: "2026-10-01T15:05:00Z", source: "hub", link_kind: "client", link_via: "client", paused_at: null, paused_by: null, revoked_at: null, revoked_by: null, revoked_via: null,
    created_at: "2026-10-01T15:05:00Z", updated_at: "2026-10-01T15:05:00Z",
  };

  /** Autopay on in Settings → Payments, the business's own key saved, and the key able to save cards. */
  async function takesAutopay(tips: boolean) {
    const company = state.tables.companies![0]!;
    company.settings = {
      ...(company.settings as Row), hub_tips: tips,
      autopay: { enabled: true, terms: "We charge the card on file after each visit is done.", terms_version: "2026-10-01T15:00:00", timing: "end_of_day", days: null, max_amount: 500, receipts: true, jobs_default: true, changed_at: "2026-10-01T15:00:00Z", changed_by: null },
    };
    state.tables.integration_secrets = [{ company_id: ROOFER, provider: "stripe", ciphertext: await encryptJson(env, { api_key: "rk_test_radford", extra: { account_id: "acct_radford", webhook_secret: "whsec_radford", webhook_id: "we_radford" } }) }];
    state.tables.integrations = [{ company_id: ROOFER, provider: "stripe", external_account_id: "acct_radford", settings: { autopay: true, refunds: true, events_version: 2, checked_at: new Date().toISOString() } }];
    state.tables.client_payment_methods = [{ ...visa }];
    state.tables.autopay_authorizations = [{ ...agreed }];
  }

  it("says the client is on autopay, and off once they turned it off with the card still saved", async () => {
    mowed();
    await takesAutopay(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const on = (await (await hub({ t: "client", id: CLIENT })).json()).autopay;
    expect(on).toMatchObject({ status: "active", method: { id: CARD, label: "Visa ending 4242", exp: "08/28" }, since: "2026-10-01T15:05:00Z", terms_version: "2026-10-01T15:00:00" });

    Object.assign(state.tables.autopay_authorizations![0]!, { revoked_at: "2026-10-20T15:00:00Z", revoked_via: "client" });
    const off = (await (await hub({ t: "client", id: CLIENT })).json()).autopay;
    expect(off).toMatchObject({ status: "off", since: null });
    expect(stripeCalls(fetchSpy)).toEqual([]);
  });

  it("never offers the office's copy of the link a card it can't say yes to", async () => {
    mowed();
    await takesAutopay(false);
    // A card brought in from Stripe, and no agreement yet.
    state.tables.autopay_authorizations = [];
    state.tables.client_payment_methods = [{ ...visa, source: "stripe_import", saved_via: "client" }];
    expect((await (await hub({ t: "client", id: CLIENT })).json()).autopay).toMatchObject({ status: "agree", imported: true, method: { id: CARD } });
    expect((await (await hub({ t: "client", id: CLIENT, via: "office" })).json()).autopay).toMatchObject({ status: "off", method: null, imported: false });
    // Nor on a link minted before the client's own were marked (one from the timeline, say).
    expect((await (await hub({ t: "client", id: CLIENT, old: true })).json()).autopay).toMatchObject({ status: "off", method: null, imported: false });
    // Saved on the client's own link: still not on the office's copy.
    state.tables.client_payment_methods = [{ ...visa, saved_via: "client" }];
    expect((await (await hub({ t: "client", id: CLIENT, via: "office" })).json()).autopay).toMatchObject({ status: "off", method: null });
    // Saved through an office copy: that one waits for the tick there.
    state.tables.client_payment_methods = [{ ...visa, saved_via: "office" }];
    expect((await (await hub({ t: "client", id: CLIENT, via: "office" })).json()).autopay).toMatchObject({ status: "agree", method: { id: CARD } });
  });

  it("never offers a tip after an automatic charge to the card while tips are off", async () => {
    paidMow(false);
    await takesAutopay(false);
    state.tables.autopay_charges = [{
      id: "ch-2", company_id: ROOFER, client_id: CLIENT, job_id: null, bill: "visits", invoice_id: MOW, payment_method_id: CARD, status: "paid", attempts: 1, failures: 0,
      charged_amount: 45, charged_at: CHARGED_AT, due_at: "2026-10-27T05:00:00Z", created_at: "2026-10-26T20:00:00Z",
      method: { type: "card", brand: "visa", last4: "4242", bank_name: null, wallet: null },
    }];
    state.tables.stripe_invoices = [{ company_id: ROOFER, invoice_id: MOW, origin: "crewtavo", purpose: "invoice", collection: "charge_automatically", status: "paid", livemode: false, detached_at: null, tip_amount: 0 }];
    const off = await invoicePage();
    expect(off).toMatchObject({ tips: false, tip_after: false, tip_method: null, autopay: { status: "paid" } });
    // The same invoice with tips on offers one, to the card that paid.
    state.tables.companies![0]!.settings = { ...(state.tables.companies![0]!.settings as Row), hub_tips: true };
    expect(await invoicePage()).toMatchObject({ tips: true, tip_after: true, tip_method: "Visa ending 4242" });
  });
});
