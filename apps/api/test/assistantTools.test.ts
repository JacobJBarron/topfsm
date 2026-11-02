/**
 * The tools that run the business (assistant-tools/): importing clients and a schedule with a
 * preview first and no duplicates on a second run, money refused to "Full access, no money",
 * reports for the roles that see them, argument errors that name the field, invites that never
 * hand their link to the assistant, a crew's route organized (or only shown) from a chat, and quotes
 * that offer options read and approved for the option the client chose, keeping the contract they
 * were sent.
 */
import { templateSettings } from "@crewtavo/core/documents";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

const invites = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../src/services/team", async (original) => ({
  ...(await original<typeof import("../src/services/team")>()),
  invitePerson: async (_scope: unknown, body: unknown) => {
    invites.calls.push(body);
    return { user_id: "user-9", invited: true, emailed: true, reason: null, link: "https://ops.example.com/auth/confirm?token=SECRET" };
  },
}));
const { app } = await import("../src/app");
const { ADMIN_FROM_TEAM_PAGE } = await import("../src/services/team");

const env: Env = { SUPABASE_URL: "http://127.0.0.1:8080", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://ops.example.com" };
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (client: string) => `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-1", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, client_id: client })}.c2ln`;
const CONNECTIONS: Record<string, { level: string; areas: string[] }> = {
  full: { level: "full", areas: [] },
  nomoney: { level: "full_no_money", areas: [] },
  jobsonly: { level: "areas", areas: ["jobs", "clients"] },
};

type Row = Record<string, any>;
/** Supabase in memory: tables of rows, inserts that keep what they're given, the person's role, and what database functions answer. */
function supabase(role = "owner", answers: Record<string, unknown> = {}) {
  const db: Record<string, Row[]> = { clients: [], properties: [], jobs: [], visits: [], assistant_calls: [] };
  const sent: Array<{ method: string; table: string; body: any }> = [];
  const memberships: URL[] = [];
  let id = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const table = url.pathname.replace("/rest/v1/", "");
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
    if (table === "rpc/rate_limit_hit") return Response.json(true);
    if (table in answers) return Response.json(answers[table]);
    if (table === "assistant_connections") {
      const client = url.searchParams.get("client_id")?.replace(/^eq\./, "") ?? "";
      return Response.json(CONNECTIONS[client] ? [CONNECTIONS[client]] : []);
    }
    if (table === "memberships") memberships.push(url);
    if (table === "memberships") return Response.json([{ company_id: "company-1", role, role_id: null, company: { timezone: "America/New_York", settings: {} } }]);
    if (!url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    sent.push({ method, table, body });
    const rows = (db[table] ??= []);
    if (method === "POST") {
      const made = (Array.isArray(body) ? body : [body]).map((r: Row) => ({ id: r.id ?? `${table}-${++id}`, ...r }));
      rows.push(...made);
      const single = (init?.headers as Record<string, string> | undefined)?.Accept?.includes("vnd.pgrst.object");
      return Response.json(single ? made[0] : made, { status: 201 });
    }
    if (method === "PATCH") {
      const ids = url.searchParams.get("id")?.replace(/^in\.\(|\)$|^eq\./g, "").split(",") ?? [];
      const hit = rows.filter((r) => ids.includes(r.id));
      for (const r of hit) Object.assign(r, body);
      return Response.json(hit);
    }
    return Response.json(rows);
  });
  return { db, sent, memberships };
}

afterEach(() => {
  vi.unstubAllGlobals();
  invites.calls = [];
});

const call = async (client: string, name: string, args: object) => {
  const res = await app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token(client)}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }, env);
  const result = (await res.json()).result;
  return result.isError ? { error: result.content[0].text as string } : result.structuredContent.result;
};

const SPREADSHEET = [
  { source_id: "J-1", name: "Ana Diaz", email: "ana@example.com", status: "active", properties: [{ line1: "12 Oak St", city: "Radford" }] },
  { source_id: "J-2", name: "Bo Kent", status: "inactive", properties: [{ line1: "9 Main Street", city: "Radford" }, { line1: "9 Main St", city: "Radford" }] },
];

describe("importing clients", () => {
  it("previews without changing anything, then commits, and a second run adds nothing", async () => {
    const { db, sent } = supabase();
    const preview = await call("full", "import_clients", { mode: "preview", clients: SPREADSHEET });
    expect(preview.totals).toEqual({ clients: 2, create: 2, match: 0, status_changes: 0, properties: 2, kept_properties: 0 });
    expect(sent.filter((s) => s.method !== "GET" && s.table !== "assistant_calls")).toEqual([]);

    const commit = await call("full", "import_clients", { mode: "commit", clients: SPREADSHEET });
    expect(commit.clients.map((c: Row) => [c.name, c.status, c.property_ids.length])).toEqual([["Ana Diaz", "active", 1], ["Bo Kent", "archived", 1]]);
    expect(db.clients.map((c) => [c.display_name, c.status, c.custom_fields.source_id])).toEqual([["Ana Diaz", "active", "J-1"], ["Bo Kent", "archived", "J-2"]]);
    expect(db.properties).toHaveLength(2);

    const again = await call("full", "import_clients", { mode: "commit", clients: SPREADSHEET });
    expect(again.totals).toMatchObject({ create: 0, match: 2, properties: 0, kept_properties: 2 });
    expect(again.clients.map((c: Row) => c.action)).toEqual(["already here (by source_id)", "already here (by source_id)"]);
    expect(db.clients).toHaveLength(2);
    expect(db.properties).toHaveLength(2);
  });
});

describe("importing a schedule", () => {
  it("places items by address or name, says what it can't place, and needs the schedule to commit", async () => {
    const { db } = supabase();
    db.clients.push({ id: "c-ana", display_name: "Ana Diaz", company_name: null }, { id: "c-bo", display_name: "Bo Kent", company_name: null });
    db.properties.push({ id: "p-ana", client_id: "c-ana", line1: "12 Oak St", city: "Radford" }, { id: "p-bo", client_id: "c-bo", line1: "9 Main St", city: "Radford" });
    const items = [
      { title: "Mowing", address: { line1: "12 Oak Street" }, first_date: "2026-04-07", start_time: "09:00", duration_min: 45, repeat: { every_weeks: 2 }, price: 45 },
      { title: "Mowing", client_name: "bo kent", first_date: "2026-04-08", repeat: { rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE" } },
      { title: "Mowing", client_name: "Cy Lane", first_date: "2026-04-09", repeat: { every_weeks: 2 } },
      { title: "Sharpen blades", kind: "task", first_date: "2026-04-06" },
    ];
    const preview = await call("full", "import_schedule", { mode: "preview", items });
    expect(preview.totals).toEqual({ items: 4, ready: 3, already_here: 0, problems: 1 });
    expect(preview.items.map((i: Row) => [i.client_id, i.property_id, i.found_by, i.repeats ?? null])).toEqual([
      ["c-ana", "p-ana", "address", "every 2 weeks on Tuesday"],
      ["c-bo", "p-bo", "name", "every 2 weeks on Wednesday"],
      [null, null, null, "every 2 weeks on Thursday"],
      [null, null, null, null],
    ]);
    expect(preview.items[0].next_dates).toEqual(["2026-04-07", "2026-04-21", "2026-05-05"]);
    expect(preview.items[2].problem).toMatch(/^No client found/);
    expect((await call("jobsonly", "import_schedule", { mode: "commit", items })).error).toBe(
      "This assistant can't change the schedule. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.",
    );
    expect(db.jobs).toHaveLength(0);
  });
});

describe("money", () => {
  it("is out of reach for full access without money, and says how to allow it", async () => {
    const { sent } = supabase();
    for (const [name, args] of [
      ["record_payment", { invoice_id: "6f4cc1b2-7e43-4c1d-9a8e-3c2f1d0b9a87", amount: 50, method: "check" }],
      ["create_quote", { client_id: "6f4cc1b2-7e43-4c1d-9a8e-3c2f1d0b9a87", title: "Sealcoat" }],
      ["mark_paid", { from: "2026-10-12", to: "2026-10-18", method: "check" }],
    ] as const) {
      expect((await call("nomoney", name, args)).error, name).toMatch(/^This assistant can't change money: quotes, invoices, payments or pay\./);
    }
    expect(sent.filter((s) => ["payments", "quotes", "pay_periods"].includes(s.table))).toEqual([]);
  });

  it("job profit counts sub and crew pay as labor, once", async () => {
    const { db } = supabase("owner", { "rpc/job_pay_costs": [{ job_id: "j1", amount: 2700, payees: 1 }] });
    db.jobs.push(
      { id: "j1", number: 12, title: "New roof", status: "completed", financials: { contract_total: 12150 }, client: { display_name: "Ann" }, lines: [{ quantity: 27, unit_cost: 300, unit_labor_cost: 120 }] },
      { id: "j2", number: 13, title: "Gutters", status: "completed", financials: { contract_total: 1440 }, client: { display_name: "Ann" }, lines: [{ quantity: 120, unit_cost: 5, unit_labor_cost: 2 }] },
    );
    const result = await call("full", "job_profit", {});
    expect(result.jobs.find((j: Row) => j.id === "j1")).toMatchObject({ crew_pay: 2700, materials: 4860, line_labor_left_out: 3240, actual_labor: true, cost: 7560, profit: 4590 });
    expect(result.jobs.find((j: Row) => j.id === "j2")).toMatchObject({ crew_pay: 0, materials: 600, line_labor_left_out: 0, actual_labor: false, cost: 600 });
  });

  it("figures are for the roles that see them", async () => {
    supabase("estimator");
    expect((await call("full", "money_report", {})).error).toBe("Your role in Crewtavo doesn't allow that. An owner or admin can change your role.");
    expect((await call("full", "pay_summary", {})).error).toMatch(/^Pay is for the office/);
  });
});

describe("tools", () => {
  it("name every field that's wrong", async () => {
    supabase();
    const res = await call("full", "add_services", { items: [{ unit_price: "a lot" }, { name: "" }] });
    expect(res.error).toMatch(/^Invalid arguments\. /);
    expect(res.error).toContain("items.0.name");
    expect(res.error).toContain("items.0.unit_price");
    expect(res.error).toContain("items.1.name");
  });

  it("keep subs off the team: not listed, no Subcontractor level, not invited or made one", async () => {
    const { memberships } = supabase();
    const listed = await call("full", "list_team", {});
    expect(listed.levels.map((l: { level: string }) => l.level)).not.toContain("subcontractor");
    expect(listed.levels.map((l: { level: string }) => l.level)).toContain("field_crew");
    // The people list asks the database for the team only.
    expect(memberships.filter((u) => u.searchParams.get("select") === "user_id,role,role_id,active").map((u) => u.searchParams.get("role"))).toEqual(["neq.subcontractor"]);
    const invite = await call("full", "invite_person", { email: "sub@example.com", role: "subcontractor" });
    expect(invite.error).toMatch(/^Invalid arguments\. /);
    expect(invites.calls).toEqual([]);
    const change = await call("full", "change_role", { user_id: "00000000-0000-4000-8000-000000000009", role: "subcontractor" });
    expect(change.error).toMatch(/^Invalid arguments\. /);
  });

  it("invite people without handing the assistant their link", async () => {
    supabase();
    const result = await call("full", "invite_person", { email: "new@example.com", role: "office" });
    expect(result).toEqual({ user_id: "user-9", invited: true, emailed: true, reason: null });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(invites.calls).toEqual([{ email: "new@example.com", full_name: undefined, role: "office", role_id: undefined }]);
  });

  it("never give admin access: that asks for the person's password, in Crewtavo", async () => {
    const admin = { company_roles: [{ base_role: "admin", permissions: ["team"] }] };
    const { sent } = supabase("owner", admin);
    const person = "00000000-0000-4000-8000-000000000009";
    for (const args of [{ user_id: person, role: "admin" }, { user_id: person, role: "owner" }, { user_id: person, role_id: "00000000-0000-4000-8000-0000000000aa" }]) {
      expect((await call("full", "change_role", args)).error, JSON.stringify(args)).toBe(ADMIN_FROM_TEAM_PAGE);
    }
    expect((await call("full", "save_role", { name: "Everything", base_role: "admin", permissions: ["team"] })).error).toBe(ADMIN_FROM_TEAM_PAGE);
    expect(sent.filter((r) => r.method !== "GET" && r.table !== "assistant_calls")).toEqual([]);
    // A role that's admin-level already can still be renamed.
    expect(await call("full", "save_role", { role_id: "00000000-0000-4000-8000-0000000000aa", name: "Manager", base_role: "admin", permissions: ["team"] })).toEqual({ role_id: "00000000-0000-4000-8000-0000000000aa", saved: true });
  });
});

describe("routes", () => {
  const lawns = () =>
    [0, 1, 2].map((i) => ({
      id: `visit-${i}`,
      title: `Mow ${i}`,
      kind: "job",
      status: "scheduled",
      starts_at: null,
      ends_at: null,
      route_order: null,
      time_fixed: false,
      property: { id: `property-${i}`, line1: `${i} Oak St`, city: "Radford", lat: 37.13 + (3 - i) / 100, lng: -80.57 },
      job: { number: i, visit_duration_min: 20, client: null },
    }));
  const company = { timezone: "America/New_York", settings: { depot: { lat: 37.13, lng: -80.57 }, working_hours: { start: "08:00", end: "17:00" } } };

  it("shows a crew's organized day without saving it", async () => {
    const { db, sent } = supabase();
    db.companies = [company];
    db.visits = lawns();
    const result = await call("full", "organize_route", { date: "2099-06-03", crew_id: null, save: false });
    expect(result.saved).toBe(false);
    expect(result.stops.map((s: { visit_id: string }) => s.visit_id)).toEqual(["visit-2", "visit-1", "visit-0"]);
    // 20-minute lawns, any length, one after another in local time.
    expect(result.stops[0]).toMatchObject({ order: 1, start_time: "08:05", end_time: "08:25" });
    expect(sent.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("saves the route and remembers the day", async () => {
    const { db, sent } = supabase();
    db.companies = [company];
    db.visits = lawns();
    const result = await call("full", "organize_route", { date: "2099-06-03", crew_id: null });
    expect(result).toMatchObject({ saved: true, changed: 3 });
    expect(sent.filter((r) => r.method === "PATCH" && r.table === "visits").map((r) => r.body.route_order)).toEqual([1, 2, 3]);
    expect(sent.find((r) => r.method === "POST" && r.table === "routes")?.body).toMatchObject({ route_date: "2099-06-03", by_hand: false, organized_by: "user-1" });
  });

  it("books a visit of any length", async () => {
    const { db, sent } = supabase();
    db.companies = [company];
    await call("full", "create_visit", { title: "Mow 4 Elm St", kind: "task", date: "2099-06-03", start_time: "09:03", duration_min: 50, time_fixed: true });
    const visit = sent.find((r) => r.method === "POST" && r.table === "visits")!.body[0];
    expect([visit.starts_at, visit.ends_at, visit.time_fixed]).toEqual(["2099-06-03T13:03:00.000Z", "2099-06-03T13:53:00.000Z", true]);
  });
});

describe("quotes that offer options", () => {
  const QUOTE = "6f4cc1b2-7e43-4c1d-9a8e-3c2f1d0b9a87";
  const GOOD = "0b8f3c2e-1d4a-4e6b-9c7d-2a1b3c4d5e60";
  const BEST = "0b8f3c2e-1d4a-4e6b-9c7d-2a1b3c4d5e61";
  const PAYMENT = "0b8f3c2e-1d4a-4e6b-9c7d-2a1b3c4d5e70";
  // The business's template prints a payment section, and the quote's options are its quote_options rows too.
  const template = templateSettings({ terms: "Thanks, {Customer name}.", sections: [PAYMENT] });
  const offering = (db: Record<string, Row[]>, extra: Row = {}) => {
    db.companies = [{ id: "company-1", name: "Summit Roofing", phone: "555-0100", timezone: "America/New_York", settings: {} }];
    db.document_templates = [{ id: "t-1", company_id: "company-1", is_default: true, settings: template }];
    db.contract_sections = [{ id: PAYMENT, company_id: "company-1", title: "Payment", body: "<p>{Total} for {Option}, {Customer name}.</p>", place: "terms", initials: false, sort: 0 }];
    db.quotes = [{
      id: QUOTE, number: 1042, title: "New roof", status: "sent", subtotal: 17300, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 17300, deposit_amount: 0, option_id: GOOD, promo: null,
      sent_at: "2026-10-22T15:00:00Z", created_at: "2026-10-21T13:00:00Z", template_id: null, section_ids: [], roof_package_id: null, approval: null,
      client: { display_name: "Dana Whitfield", billing_address: {} }, property: null,
      lines: [
        { id: "l-best", option_id: BEST, name: "Standing-seam metal roof", quantity: 30, unit_price: 1285, taxable: true, optional: false, selected: false, option_group: null, sort: 2 },
        { id: "l-shared", option_id: null, name: "Dumpster", quantity: 1, unit_price: 500, taxable: true, optional: false, selected: true, option_group: null, sort: 0 },
        { id: "l-good", option_id: GOOD, name: "Architectural shingle roof", quantity: 30, unit_price: 560, taxable: true, optional: false, selected: true, option_group: null, sort: 1 },
      ],
      options: [
        { id: BEST, name: "Standing-seam metal", tier: "Best", highlights: [], warranty: "", sort: 1 },
        { id: GOOD, name: "Architectural shingle", tier: "Good", highlights: ["Color you pick"], warranty: "30 years.", sort: 0 },
      ],
      ...extra,
    }];
    db.quote_options = db.quotes[0]!.options;
  };
  const writes = (sent: Array<{ method: string; table: string; body: any }>) => sent.filter((s) => s.method !== "GET" && s.table !== "assistant_calls");

  it("are read with their options, each option's total, and the option each line is on", async () => {
    const { db } = supabase();
    offering(db);
    const quote = await call("full", "get_quote", { quote_id: QUOTE });
    expect(quote.option_id).toBe(GOOD);
    expect(quote.options).toEqual([
      { id: GOOD, name: "Architectural shingle", tier: "Good", highlights: ["Color you pick"], warranty: "30 years.", shown: true, total: 17300 },
      { id: BEST, name: "Standing-seam metal", tier: "Best", highlights: [], warranty: "", shown: false, total: 39050 },
    ]);
    expect(quote.lines.map((l: Row) => [l.id, l.option_id])).toEqual([["l-shared", null], ["l-good", GOOD], ["l-best", BEST]]);
    expect(quote).not.toHaveProperty("promo");
  });

  it("keep their lines out of reach: those are edited in Crewtavo", async () => {
    const { db, sent } = supabase();
    offering(db);
    const result = await call("full", "update_quote", { quote_id: QUOTE, title: "Roof", lines: [{ name: "Gutters", unit_price: 900 }] });
    expect(result.error).toBe("This quote offers options; edit its lines in Crewtavo.");
    expect(writes(sent)).toEqual([]);
  });

  it("are approved for the option the client chose, set first and on its own", async () => {
    const { db, sent } = supabase();
    offering(db);
    expect((await call("full", "mark_quote", { quote_id: QUOTE, status: "approved" })).error).toBe(
      "This quote offers options (Architectural shingle, Standing-seam metal). Say which one the client chose with option_id, from get_quote.",
    );
    expect((await call("full", "mark_quote", { quote_id: QUOTE, status: "approved", option_id: "0b8f3c2e-1d4a-4e6b-9c7d-2a1b3c4d5e62" })).error).toBe("That option isn't on this quote. get_quote lists its options.");
    expect((await call("full", "convert_quote_to_job", { quote_id: QUOTE })).error).toBe("This quote offers options. Mark it approved with the option the client chose first (mark_quote with option_id).");
    expect(writes(sent)).toEqual([]);

    // The approval keeps the option as it was offered, so the signed copy shows it even once it's renamed.
    const picture = { path: "00000000-0000-4000-8000-000000000001/packages/11111111-1111-4111-8111-111111111111.jpg", width: 1600, height: 1000 };
    Object.assign(db.quotes![0]!.options.find((o: Row) => o.id === BEST), { picture: picture.path, picture_width: 1600, picture_height: 1000, style: "metal", highlights: ["Lasts 50 years"], warranty: "40 years on the panels." });
    expect(await call("full", "mark_quote", { quote_id: QUOTE, status: "approved", option_id: BEST })).toEqual({ saved: true });
    const patches = writes(sent).filter((s) => s.table === "quotes").map((s) => s.body);
    // And the contract the client was sent, filled in for the metal roof at its price, as "Mark approved" keeps it.
    const approval = {
      name: "Assistant",
      method: "manual",
      template,
      option: { id: BEST, name: "Standing-seam metal", tier: "Best", picture, style: "metal", highlights: ["Lasts 50 years"], warranty: "40 years on the panels." },
      contract: {
        terms: "Thanks, Dana Whitfield.",
        sections: [{ id: PAYMENT, title: "Payment", body: "<p>$39,050.00 for Standing-seam metal, Dana Whitfield.</p>", place: "terms", initials: false, initialed: false }],
      },
      initials: null,
    };
    expect(patches).toEqual([{ option_id: BEST }, { status: "approved", approved_at: expect.any(String), approval }]);

    // The option already shown: the status alone.
    const second = supabase();
    offering(second.db);
    await call("full", "mark_quote", { quote_id: QUOTE, status: "approved", option_id: GOOD });
    expect(writes(second.sent).map((s) => s.body)).toEqual([{ status: "approved", approved_at: expect.any(String), approval: expect.objectContaining({ option: expect.objectContaining({ id: GOOD, tier: "Good" }) }) }]);
  });

  it("are approved only for an option that has a price of its own", async () => {
    const { db, sent } = supabase();
    offering(db);
    db.quotes![0]!.lines = db.quotes![0]!.lines.filter((l: Row) => l.option_id !== BEST);
    expect((await call("full", "mark_quote", { quote_id: QUOTE, status: "approved", option_id: BEST })).error).toBe(
      "That option isn't priced yet: it has no lines of its own. Add them in Crewtavo, or pick another one.",
    );
    expect(writes(sent)).toEqual([]);
  });

  it("put the option shown back when the approval doesn't go through", async () => {
    const { db, sent } = supabase();
    offering(db);
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const approving = init?.method === "PATCH" && String(input).includes("/rest/v1/quotes") && "status" in JSON.parse(String(init.body));
      return approving ? Response.json({ message: "This quote can't be approved right now.", code: "22023" }, { status: 400 }) : stubbed(input, init);
    });
    expect((await call("full", "mark_quote", { quote_id: QUOTE, status: "approved", option_id: BEST })).error).toBeDefined();
    expect(writes(sent).map((s) => s.body)).toEqual([{ option_id: BEST }, { option_id: GOOD }]);
    expect(db.quotes![0]!.option_id).toBe(GOOD);
  });

  it("aren't needed to approve a quote without them, which takes no option and keeps the contract it was sent", async () => {
    const { db, sent } = supabase();
    offering(db, { option_id: null, options: [] });
    expect((await call("full", "mark_quote", { quote_id: QUOTE, status: "approved", option_id: GOOD })).error).toBe("This quote doesn't offer options, so leave out option_id.");
    expect(await call("full", "mark_quote", { quote_id: QUOTE, status: "approved" })).toEqual({ saved: true });
    const contract = { terms: "Thanks, Dana Whitfield.", sections: [{ id: PAYMENT, title: "Payment", body: "<p>$17,300.00 for , Dana Whitfield.</p>", place: "terms", initials: false, initialed: false }] };
    expect(writes(sent).map((s) => s.body)).toEqual([{ status: "approved", approved_at: expect.any(String), approval: { name: "Assistant", method: "manual", template, option: null, contract, initials: null } }]);
  });

  it("keep a signed quote's own approval when it's marked approved again", async () => {
    const { db, sent } = supabase();
    offering(db, { option_id: null, options: [], status: "approved", approval: { name: "Dana Whitfield", signature: "data:image/png;base64,AAAA" } });
    expect((await call("full", "mark_quote", { quote_id: QUOTE, status: "approved" })).error).toBe("The client has already answered this quote: it's approved already.");
    db.quotes![0]!.status = "converted";
    expect((await call("full", "mark_quote", { quote_id: QUOTE, status: "approved" })).error).toBe("The client has already answered this quote: it's a job already.");
    // Nothing is written: the database would turn a new approval or approval date down anyway.
    expect(writes(sent)).toEqual([]);
  });

  it("become a job straight from sent with the contract they were sent, approved by the assistant", async () => {
    const { db, sent } = supabase();
    offering(db, { option_id: null, options: [] });
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/rest/v1/rpc/convert_quote_to_job") ? (sent.push({ method: "POST", table: "rpc/convert_quote_to_job", body: null }), Response.json("job-1")) : stubbed(input, init),
    );
    expect(await call("full", "convert_quote_to_job", { quote_id: QUOTE })).toEqual({ job_id: "job-1" });
    const [approve, convert] = writes(sent);
    expect(approve).toMatchObject({ method: "PATCH", table: "quotes", body: { approval: { name: "Assistant", method: "manual", template, option: null, initials: null } } });
    expect(approve!.body.approval.contract.sections.map((s: Row) => s.body)).toEqual(["<p>$17,300.00 for , Dana Whitfield.</p>"]);
    // The approval only: the database turns it into a job (and a change order joins its job) in one step.
    expect(approve!.body).not.toHaveProperty("status");
    expect(convert).toMatchObject({ table: "rpc/convert_quote_to_job" });
  });

  it("keep the deposit no more than the cheapest option's price", async () => {
    const { db } = supabase();
    offering(db);
    const result = await call("full", "update_quote", { quote_id: QUOTE, deposit_amount: 20000 });
    // The shingle roof comes to $17,300, the metal one to $39,050.
    expect(result).toMatchObject({ deposit_amount: 17300, note: "The deposit was lowered to 17300: it can't be more than the quote's total (with options, its cheapest option's price)." });
    expect(db.quotes![0]!.deposit_amount).toBe(17300);
    // Within it, it's kept as it is.
    expect(await call("full", "update_quote", { quote_id: QUOTE, deposit_amount: 5000 })).not.toHaveProperty("note");
    expect(db.quotes![0]!.deposit_amount).toBe(5000);
  });

  it("aren't what a line group is: its lines are add-ons the client picks one of, the first picked", async () => {
    const { db, sent } = supabase();
    db.companies = [{ id: "company-1", settings: {} }];
    await call("full", "create_quote", {
      client_id: QUOTE,
      title: "Gutters",
      lines: [
        { name: "Cleaning", unit_price: 150 },
        { name: "5-inch gutters", unit_price: 1200, option_group: "Size" },
        { name: "6-inch gutters", unit_price: 1500, option_group: "Size" },
        { name: "Guards", unit_price: 600, optional: true },
      ],
    });
    const lines = sent.find((s) => s.method === "POST" && s.table === "quote_line_items")!.body;
    expect(lines.map((l: Row) => [l.name, l.optional, l.selected, l.option_group])).toEqual([
      ["Cleaning", false, true, null],
      ["5-inch gutters", true, true, "Size"],
      ["6-inch gutters", true, false, "Size"],
      ["Guards", true, false, null],
    ]);
  });
});

describe("automations about subs' offers", () => {
  // An office person whose role has automations but not the Subcontractors area.
  const clerk = () =>
    supabase("office", {
      memberships: [{ company_id: "company-1", role: "office", role_id: "role-clerk", company: { timezone: "America/New_York", settings: {} } }],
      company_roles: [{ permissions: ["automations"] }],
    });
  const rule = { name: "Tell me", trigger: "sub_offer.declined", actions: [{ type: "notify", roles: ["owner"], title: "{{sub.name}} said no" }] };

  it("aren't offered or made without the Subcontractors area", async () => {
    const { sent } = clerk();
    const options = await call("full", "automation_options", {});
    expect(options.triggers.map((t: { trigger: string }) => t.trigger)).not.toContain("sub_offer.declined");
    expect(options.triggers.map((t: { trigger: string }) => t.trigger)).toContain("quote.sent");
    expect((await call("full", "save_automation", rule)).error).toMatch(/Subcontractors area/);
    expect(sent.some((s) => s.table === "automation_rules" && s.method === "POST")).toBe(false);
  });

  it("tell only the office, and keep the sub's price out of a task, for someone with the area", async () => {
    const { sent } = supabase("owner");
    const options = await call("full", "automation_options", {});
    expect(options.triggers.find((t: { trigger: string }) => t.trigger === "sub_offer.declined")).toMatchObject({
      only_actions: ["notify", "create_task"], only_notify_roles: ["owner", "admin", "office"],
      extra_tokens: expect.arrayContaining([{ token: "{{sub.price}}", label: "Their price", not_in_tasks: true }]),
    });
    expect((await call("full", "save_automation", { ...rule, actions: [{ type: "notify", roles: ["field_crew"], title: "x" }] })).error).toMatch(/only the office hears about this/);
    expect((await call("full", "save_automation", { ...rule, actions: [{ type: "create_task", title: "Call {{sub.name}} about {{sub.price}}", days_from_now: 1 }] })).error).toMatch(/can't show the sub's price/);
    expect(await call("full", "save_automation", rule)).toMatchObject({ does: "When a sub turns down a job offer: notify Owners." });
    expect(sent.filter((s) => s.table === "automation_rules" && s.method === "POST")).toHaveLength(1);
  });
});
