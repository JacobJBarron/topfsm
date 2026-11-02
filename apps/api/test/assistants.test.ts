/**
 * AI assistants only read until the person who connected them chooses what they can change, or
 * gives them full access: the MCP tools that change things refuse outside those areas, and only full
 * access deletes. Our API takes no changes from an assistant, and the instance's gateway takes none
 * from one that only reads. Ordinary sign-ins are unaffected (lib/assistants.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_AREAS, ASSISTANT_TOOL_LABELS, assistantRefusal } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { TOOLS } from "../src/assistant-tools";
import type { Env } from "../src/env";
import { ASSISTANT_NO_API, ASSISTANT_READ_ONLY, assistantClient, guardAssistant } from "../src/lib/assistants";
import { gateway } from "../src/lib/gateway";

const env: Env = {
  SUPABASE_URL: "http://127.0.0.1:8080",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
};

// Tokens Supabase Auth vouches for (getClaims asks /auth/v1/user about HS256 ones). Its OAuth
// server adds the approved client's id as client_id; an ordinary sign-in has none.
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims: object = {}) =>
  `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-1", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.c2ln`;
const signedIn = token();
const reading = token({ client_id: "client-reads" });
const records = token({ client_id: "client-records" });
const prices = token({ client_id: "client-prices" });
const full = token({ client_id: "client-full" });
const expired = token({ client_id: "client-expired" });

/** What each connection was given (public.assistant_connections); others have no row. */
const CONNECTIONS: Record<string, { level: string; areas: string[] }> = {
  "client-reads": { level: "read", areas: [] },
  // What "Allow changes" became.
  "client-records": { level: "areas", areas: ["records"] },
  "client-prices": { level: "areas", areas: ["prices"] },
  "client-full": { level: "full", areas: [] },
};

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
}

/** Supabase in memory, with the connections above; client-expired's token is refused. */
function supabase(company: { settings?: object } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, search: url.searchParams, body });
    const settings = { assistants: { enabled: true, read_only: false }, default_tax_rate: 0.05, branding: { color: "#0f2a35", logo: "logo.png" }, ...company.settings };
    switch (url.pathname) {
      case "/auth/v1/user":
        return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
      case "/rest/v1/rpc/rate_limit_hit":
        return Response.json(true);
      case "/rest/v1/assistant_connections": {
        const client = url.searchParams.get("client_id")?.replace(/^eq\./, "");
        if (client === "client-expired") return Response.json({ code: "PGRST303", message: "JWT expired" }, { status: 401 });
        return Response.json(client && CONNECTIONS[client] ? [CONNECTIONS[client]] : []);
      }
      case "/rest/v1/memberships":
        return Response.json([{ company_id: "company-1", role: "owner", role_id: null, company: { timezone: "America/New_York", settings } }]);
      case "/rest/v1/companies":
        if (method === "PATCH") return Response.json([{ id: "company-1" }]);
        return Response.json([{ name: "Kilo Gardens", slug: "kilo", phone: null, email: null, website: null, address: { line1: "1 Main St", city: "Radford" }, timezone: "America/New_York", settings }]);
      case "/rest/v1/messages":
        return Response.json({ id: "message-1", created_at: "2026-10-18T12:00:00Z" }, { status: 201 });
      case "/rest/v1/services":
        if (method === "POST") return Response.json((body as Array<{ name: string }>).map((s, i) => ({ id: `service-${i}`, name: s.name })), { status: 201 });
        if (method === "DELETE") return Response.json([{ id: "service-1" }]);
        return Response.json([]);
      case "/rest/v1/intake_forms":
        if (method === "POST") return Response.json({ id: "form-1" }, { status: 201 });
        return Response.json([{ id: "form-0", slug: "quote" }]);
      case "/rest/v1/assistant_calls":
        return new Response(null, { status: 201 });
      case "/rest/v1/profiles":
        return new Response(null, { status: 204 });
    }
    return Response.json([]);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const SERVICE = "6f4cc1b2-7e43-4c1d-9a8e-3c2f1d0b9a87";
const note = { client_id: SERVICE, text: "Gate code is 4410" };
const service = { items: [{ name: "Mulch install", unit: "yd", unit_price: 85 }] };

describe("assistant tokens", () => {
  it("are told apart from ordinary sign-ins by their client_id claim", () => {
    expect(assistantClient(reading)).toBe("client-reads");
    expect(assistantClient(signedIn)).toBeNull();
    expect(assistantClient(token({ client_id: "" }))).toBeNull();
    for (const junk of ["", "abc", "a.!!!.c", `${part({})}.${Buffer.from("not json").toString("base64url")}.x`]) expect(assistantClient(junk)).toBeNull();
  });
});

describe("MCP tools", () => {
  const rpc = (bearer: string, method: string, params?: object) =>
    app.request(
      "/mcp",
      { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
      env,
    );
  const call = async (bearer: string, name: string, args: object) => (await (await rpc(bearer, "tools/call", { name, arguments: args })).json()).result;
  const wrote = (calls: Call[], path: string) => calls.some((c) => c.method !== "GET" && c.method !== "HEAD" && c.path === path);

  it("that change things refuse for an assistant that only reads, and say where to allow it", async () => {
    for (const bearer of [reading, token({ client_id: "connected-before-any-of-this" })]) {
      const calls = supabase();
      expect(await call(bearer, "add_note", note)).toMatchObject({ isError: true, content: [{ type: "text", text: assistantRefusal("records") }] });
      expect(await call(bearer, "add_services", service)).toMatchObject({ isError: true, content: [{ text: assistantRefusal("prices") }] });
      expect(assistantRefusal("prices")).toBe("This assistant can't change the price list. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.");
      expect(wrote(calls, "/rest/v1/messages") || wrote(calls, "/rest/v1/services")).toBe(false);
      // The refusal is in the activity log the owner sees.
      expect(calls.find((c) => c.path === "/rest/v1/assistant_calls")?.body).toMatchObject({ tool: "add_note", ok: false });
    }
  });

  it("change only the areas an assistant was given, and don't delete", async () => {
    let calls = supabase();
    expect((await call(prices, "add_services", service)).structuredContent).toEqual({ result: { added: [{ id: "service-0", name: "Mulch install" }] } });
    expect(calls.find((c) => c.method === "POST" && c.path === "/rest/v1/services")?.body).toMatchObject([{ name: "Mulch install", unit: "yd", unit_price: 85, taxable: true, company_id: "company-1" }]);
    expect((await call(prices, "add_note", note)).content[0].text).toBe(assistantRefusal("records"));
    expect((await call(prices, "delete_service", { service_id: SERVICE })).content[0].text).toBe(assistantRefusal("prices", true, { level: "areas", areas: ["prices"] }));
    expect(assistantRefusal("prices", true, { level: "areas", areas: ["prices"] })).toMatch(/^This assistant can't delete things\./);
    expect(wrote(calls, "/rest/v1/messages")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    // A connection that had "Allow changes" still logs requests and adds notes, and nothing more.
    calls = supabase();
    expect((await call(records, "add_note", note)).structuredContent).toEqual({ result: { id: "message-1", created_at: "2026-10-18T12:00:00Z" } });
    expect((await call(records, "add_services", service)).content[0].text).toBe(assistantRefusal("prices"));
    expect(wrote(calls, "/rest/v1/messages")).toBe(true);
    expect(wrote(calls, "/rest/v1/services")).toBe(false);
  });

  it("delete with full access, and work for an ordinary sign-in without looking anything up", async () => {
    for (const bearer of [full, signedIn]) {
      const calls = supabase();
      expect((await call(bearer, "delete_service", { service_id: SERVICE })).structuredContent).toEqual({ result: { deleted: true } });
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/rest/v1/services")).toBe(true);
      expect(calls.some((c) => c.path === "/rest/v1/assistant_connections")).toBe(bearer === full);
    }
  });

  it("refuse the way the database does", () => {
    // The newest hooks.before_request, the Data API's pre-request (the assistant_areas migration).
    const dir = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(dir, f), "utf8")).filter((s) => s.includes("function hooks.before_request()")).at(-1)!;
    const hook = sql.slice(sql.lastIndexOf("create or replace function hooks.before_request()"));
    const unquote = (s: string) => s.replaceAll("''", "'");
    const template = unquote(/format\('((?:[^']|'')*%s(?:[^']|'')*)'/.exec(hook)![1]);
    const nouns = Object.fromEntries([...hook.matchAll(/when '([a-z]+)' then '([^']+)'/g)].map((m) => [m[1], m[2]]));
    nouns.automations = /else '([^']+)' end\)/.exec(hook)![1];
    for (const { key } of ASSISTANT_AREAS) expect(template.replace("%s", nouns[key])).toBe(assistantRefusal(key));
    expect(unquote(/when v_delete and v_level = 'areas' then\s*'((?:[^']|'')*)'/.exec(hook)![1])).toBe(assistantRefusal("prices", true, { level: "areas", areas: [] }));
    expect(unquote(/when v_level = 'full_no_money' and private\.assistant_money_area\(v_area\) then\s*'((?:[^']|'')*)'/.exec(hook)![1])).toBe(assistantRefusal("invoices", false, { level: "full_no_money", areas: [] }));
  });

  it("still won't change anything when the company only lets assistants look things up", async () => {
    const calls = supabase({ settings: { assistants: { enabled: true, read_only: true } } });
    expect((await call(full, "add_services", service)).content[0].text).toMatch(/^Assistants can only look things up for this company/);
    expect(wrote(calls, "/rest/v1/services")).toBe(false);
    const names = ((await (await rpc(full, "tools/list")).json()).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("list_services");
    expect(names).not.toContain("add_services");
  });

  it("that read work for an assistant that only reads, with GET requests only", async () => {
    const calls = supabase();
    expect((await call(reading, "search_clients", { query: "Ana" })).isError).toBeUndefined();
    expect((await call(reading, "search_sops", { query: "gate codes" })).isError).toBeUndefined();
    expect((await call(reading, "list_services", {})).isError).toBeUndefined();
    const db = calls.filter((c) => c.path.startsWith("/rest/v1/") && !["/rest/v1/assistant_calls", "/rest/v1/rpc/rate_limit_hit"].includes(c.path));
    expect(db.map((c) => c.path)).toEqual(expect.arrayContaining(["/rest/v1/clients", "/rest/v1/rpc/search_sops", "/rest/v1/services"]));
    // The instance's gateway only lets an assistant that only reads send GETs (below).
    expect(db.every((c) => c.method === "GET")).toBe(true);
  });

  it("are all listed, so a refusal can say how to allow it, and say which delete", async () => {
    supabase();
    const tools = (await (await rpc(reading, "tools/list")).json()).result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
    expect(tools.map((t) => t.name)).toEqual(Object.keys(TOOLS));
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.list_services).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(hints.add_services).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.delete_service).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // Every delete is marked, so the assistant asks first; so are voiding and writing off an invoice, and taking down a public reply.
    const destructive = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
    expect(destructive.filter((n) => !n.startsWith("delete_"))).toEqual(["void_invoice", "write_off_invoice", "remove_review_reply"]);
    expect(tools.filter((t) => t.name.startsWith("delete_")).every((t) => t.annotations.destructiveHint)).toBe(true);
  });

  it("each have a label for the activity log", () => {
    expect(Object.keys(TOOLS).filter((name) => !ASSISTANT_TOOL_LABELS[name])).toEqual([]);
  });

  it("check a price list formula before saving anything", async () => {
    const calls = supabase();
    const res = await call(full, "add_services", { items: [{ name: "Gravel", formula: "area_sqft * depth_cm" }] });
    expect(res.content[0].text).toMatch(/^Gravel: that formula doesn't work \(Unknown value "depth_cm"\)/);
    expect(wrote(calls, "/rest/v1/services")).toBe(false);
  });

  it("change company settings without touching the owner's limits on assistants", async () => {
    const calls = supabase();
    const res = await call(full, "update_company_settings", { sales_tax_percent: 8.875, brand_color: "#3b7d23", website: "kilogardens.com" });
    expect(res.isError).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/rest/v1/companies")!.body;
    expect(patch).toMatchObject({ website: "https://kilogardens.com", settings: { default_tax_rate: 0.08875, branding: { color: "#3b7d23", logo: "logo.png" }, assistants: { enabled: true, read_only: false } } });
    expect(patch.name).toBeUndefined();
  });

  it("turn clients' tips for the crew on and off by a name that says so, the switch Settings → Company has", async () => {
    let calls = supabase({ settings: { hub_tips: true } });
    expect((await call(full, "get_company_settings", {})).structuredContent.result).toMatchObject({ client_tips: true });
    expect((await call(full, "update_company_settings", { client_tips: false })).isError).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH" && c.path === "/rest/v1/companies")!.body;
    // The setting keeps its name in the database, and the rest of the settings stay as they were.
    expect(patch.settings).toMatchObject({ hub_tips: false, default_tax_rate: 0.05, assistants: { enabled: true, read_only: false } });

    calls = supabase({ settings: { hub_tips: false } });
    const read = (await call(full, "get_company_settings", {})).structuredContent.result;
    expect(read.client_tips).toBe(false);
    expect(read).not.toHaveProperty("show_hub_tips");

    // What the assistant reads about it is about the Client Hub, not hints for the team.
    const tools = (await (await rpc(full, "tools/list")).json()).result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }>;
    const get = tools.find((t) => t.name === "get_company_settings")!;
    const update = tools.find((t) => t.name === "update_company_settings")!;
    expect(get.description).toContain("client_tips: whether clients can add a tip for the crew when they pay an invoice online in the Client Hub, or from an autopay receipt.");
    expect(Object.keys(update.inputSchema.properties)).toContain("client_tips");
    expect(Object.keys(update.inputSchema.properties)).not.toContain("show_hub_tips");
    expect(update.inputSchema.properties.client_tips!.description).toMatch(/^Let clients add a tip for the crew .* This is not about tips or hints shown to the team\.$/);
  });

  it("save booking forms the way the booking screen does, and give their link", async () => {
    const calls = supabase();
    const res = await call(full, "save_booking_form", { name: "Spring cleanup", service_area_zips: ["24141"], questions: [{ label: "Yard size", type: "choice", options: ["Small", "Large"] }] });
    expect(res.structuredContent).toEqual({ result: { form_id: "form-1", link: "https://ops.example.com/book/kilo/spring-cleanup" } });
    expect(calls.find((c) => c.method === "POST" && c.path === "/rest/v1/intake_forms")?.body).toMatchObject({ slug: "spring-cleanup", kind: "request", questions: [{ key: "yard_size", required: false }] });
    expect((await call(full, "save_booking_form", { name: "Quote", questions: [] })).content[0].text).toBe("Another form already uses that link.");
  });
});

describe("the API", () => {
  const rename = (bearer: string) =>
    app.request("/api/me", { method: "PATCH", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ full_name: "Renamed" }) }, env);

  it("takes no changes from an assistant, whatever it's been given: its tools are how it changes things", async () => {
    for (const bearer of [reading, full]) {
      const calls = supabase();
      const res = await rename(bearer);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: ASSISTANT_NO_API });
      expect(calls.some((c) => c.path === "/rest/v1/profiles")).toBe(false);
    }
  });

  it("takes them from an ordinary sign-in", async () => {
    const calls = supabase();
    expect((await rename(signedIn)).status).toBe(200);
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/rest/v1/profiles")).toBe(true);
  });
});

describe("the instance's gateway", () => {
  const upstream = () => {
    const sent: Request[] = [];
    return { sent, send: async (request: Request) => (sent.push(request), Response.json({ ok: true })) };
  };
  const ask = (method: string, path: string, bearer: string) =>
    new Request(`http://localhost:8080${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, apikey: "sb_publishable_test", "Content-Type": "application/json" }, body: method === "GET" || method === "HEAD" ? undefined : "{}" });

  it("won't let an assistant that only reads change anything in the Data API or Storage", async () => {
    supabase();
    const { sent, send } = upstream();
    for (const [method, path, prefix] of [
      ["POST", "/rest/v1/clients", "/rest/v1"],
      ["PATCH", "/rest/v1/clients?id=eq.1", "/rest/v1"],
      ["DELETE", "/rest/v1/clients?id=eq.1", "/rest/v1"],
      ["POST", "/rest/v1/rpc/create_company", "/rest/v1"],
      ["POST", "/storage/v1/object/files/company-1/photo.jpg", "/storage/v1"],
      ["DELETE", "/storage/v1/object/files/company-1/photo.jpg", "/storage/v1"],
    ]) {
      const res = await guardAssistant(env, ask(method, path, reading), prefix, send);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: "assistant_read_only", message: ASSISTANT_READ_ONLY });
    }
    expect(sent).toHaveLength(0);
  });

  it("is what the instance's gateway runs for the Data API, Storage and Auth", async () => {
    const calls = supabase();
    const routes = gateway(env, { auth: "http://auth.internal:9999", rest: "http://rest.internal:3000", storage: "http://storage.internal:5000" });
    const through = (method: string, path: string, bearer: string) => routes.fetch(ask(method, path, bearer), {});
    // The services' own paths, which only a forwarded request reaches.
    const forwarded = () => calls.filter((c) => !c.path.startsWith("/rest/v1/") && !c.path.startsWith("/auth/v1/")).map((c) => `${c.method} ${c.path}`);
    for (const [method, path] of [["POST", "/rest/v1/services"], ["DELETE", "/storage/v1/object/files/company-1/photo.jpg"], ["PUT", "/auth/v1/user"]]) {
      expect((await through(method, path, reading)).status, path).toBe(403);
    }
    expect(forwarded()).toEqual([]);
    expect((await through("GET", "/rest/v1/clients?select=*", reading)).status).toBe(200);
    expect((await through("POST", "/rest/v1/services", prices)).status).toBe(200);
    expect((await through("PATCH", "/rest/v1/clients?id=eq.1", signedIn)).status).toBe(200);
    expect(forwarded()).toEqual(["GET /clients", "POST /services", "PATCH /clients"]);
  });

  it("lets its reads through", async () => {
    const calls = supabase();
    const { sent, send } = upstream();
    for (const path of ["/rest/v1/clients?select=*", "/rest/v1/rpc/search_sops?p_query=gate", "/storage/v1/object/authenticated/files/company-1/photo.jpg"]) {
      expect((await guardAssistant(env, ask("GET", path, reading), path.startsWith("/rest") ? "/rest/v1" : "/storage/v1", send)).status).toBe(200);
    }
    expect(sent).toHaveLength(3);
    expect(calls.some((c) => c.path === "/rest/v1/assistant_connections")).toBe(false);
  });

  it("leaves what an assistant that may change things can change to the database, and lets ordinary sign-ins through", async () => {
    const calls = supabase();
    const { sent, send } = upstream();
    expect((await guardAssistant(env, ask("POST", "/rest/v1/services", prices), "/rest/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("DELETE", "/storage/v1/object/files/company-1/photo.jpg", full), "/storage/v1", send)).status).toBe(200);
    expect(calls.filter((c) => c.path === "/rest/v1/assistant_connections")).toHaveLength(2);
    expect((await guardAssistant(env, ask("PATCH", "/rest/v1/clients?id=eq.1", signedIn), "/rest/v1", send)).status).toBe(200);
    expect(calls.filter((c) => c.path === "/rest/v1/assistant_connections")).toHaveLength(2);
    expect(sent.map((r) => r.method)).toEqual(["POST", "DELETE", "PATCH"]);
  });

  it("leaves a token the services won't take for them to answer, so the assistant refreshes it", async () => {
    supabase();
    const { sent, send } = upstream();
    await guardAssistant(env, ask("POST", "/rest/v1/clients", expired), "/rest/v1", send);
    expect(sent).toHaveLength(1);
  });

  it("never lets an assistant change the person's sign-in, but lets it refresh its own token", async () => {
    supabase();
    const { sent, send } = upstream();
    for (const bearer of [reading, full]) {
      for (const [method, path] of [["PUT", "/auth/v1/user"], ["POST", "/auth/v1/logout?scope=global"], ["POST", "/auth/v1/factors"], ["DELETE", "/auth/v1/user/oauth/grants?client_id=x"], ["POST", "/auth/v1/oauth/authorizations/abc/consent"]]) {
        const res = await guardAssistant(env, ask(method, path, bearer), "/auth/v1", send);
        expect(res.status).toBe(403);
        expect((await res.json()).msg).toBe("An AI assistant can't change your sign-in. Do that in Crewtavo itself.");
      }
    }
    expect(sent).toHaveLength(0);
    expect((await guardAssistant(env, ask("POST", "/auth/v1/oauth/token", reading), "/auth/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("GET", "/auth/v1/user", reading), "/auth/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("PUT", "/auth/v1/user", signedIn), "/auth/v1", send)).status).toBe(200);
    expect(sent).toHaveLength(3);
  });
});
