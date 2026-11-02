/**
 * Giving admin-level access (routes/account.ts, routes/recovery.ts): someone's new role, an invite,
 * a custom role's new areas, and a link into an admin's account all ask for the giver's own
 * password, open the database's minute for that one change (the admin_grants migration), and tell
 * every owner. Everything else on the team page needs no password, as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { ADMIN_PASSWORD, WRONG_PASSWORD } from "../src/lib/auth";
import type { Db } from "../src/lib/supabase";
import { ADMIN_FROM_TEAM_PAGE, invitePerson } from "../src/services/team";

const CO = "0b0a0000-0000-4000-8000-000000000001";
const PAT = "11111111-1111-4111-8111-111111111111";
const SAM = "33333333-3333-4333-8333-333333333333";
const ADA = "44444444-4444-4444-8444-444444444444";
const NEW = "55555555-5555-4555-8555-555555555555";
const GM = "66666666-6666-4666-8666-666666666666";
const BOOKS = "77777777-7777-4777-8777-777777777777";
const env: Env = { SUPABASE_URL: "https://abcd1234.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://ops.example.com", RESEND_API_KEY: "re_test", EMAIL_FROM: "Crewtavo <hello@crewtavo.example>" };
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: PAT, role: "authenticated", session_id: "s-1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Company-Id": CO };

type Row = Record<string, unknown>;

/**
 * Pat owns Green Lawn (password "right"); Sam is field crew, Ada an admin who never signed in. The
 * company has General manager (admin-level) and Bookkeeper (an admin role without apps, settings or
 * team). `log` keeps what was written, in order.
 */
function supabase() {
  const members: Record<string, Row> = {
    [PAT]: { role: "owner", role_id: null, active: true },
    [SAM]: { role: "field_crew", role_id: null, active: true },
    [ADA]: { role: "admin", role_id: null, active: true },
  };
  const roles: Record<string, Row> = {
    [GM]: { id: GM, name: "General manager", base_role: "admin", permissions: ["sales", "team"] },
    [BOOKS]: { id: BOOKS, name: "Bookkeeper", base_role: "admin", permissions: ["invoices"] },
  };
  const profiles: Record<string, Row> = {
    [PAT]: { user_id: PAT, email: "pat@greenlawn.example", full_name: "Pat Owner" },
    [SAM]: { user_id: SAM, email: "sam@greenlawn.example", full_name: "Sam Crew" },
    [ADA]: { user_id: ADA, email: "ada@greenlawn.example", full_name: "Ada Admin" },
  };
  const s = { members, roles, log: [] as Array<{ what: string; body: unknown }>, tables: { activity: [] as Row[], notifications: [] as Row[] }, emails: [] as Array<{ to: string[]; subject: string; text: string }>, passwordChecks: 0 };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const eq = (name: string) => url.searchParams.get(name)?.match(/^eq\.(.*)$/)?.[1];
    if (url.host === "api.resend.com") {
      s.emails.push(body);
      return Response.json({ id: "em_1" });
    }
    if (url.pathname === "/auth/v1/user") return Response.json({ id: PAT, aud: "authenticated" });
    if (url.pathname === "/auth/v1/token") {
      s.passwordChecks++;
      if (body.password !== "right") return Response.json({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, { status: 400 });
      return Response.json({ access_token: "throwaway", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 2_000_000_000, user: { id: PAT, aud: "authenticated" } });
    }
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/auth/v1/admin/generate_link") {
      s.log.push({ what: `link ${body.type}`, body: body.email });
      return Response.json({ id: body.type === "invite" ? NEW : ADA, email: body.email, hashed_token: "hash123", verification_type: body.type });
    }
    if (url.pathname.startsWith("/auth/v1/admin/users/")) return Response.json({ id: url.pathname.split("/").at(-1), email: "ada@greenlawn.example", created_at: "2026-10-30T12:00:00Z" });
    const table = url.pathname.replace("/rest/v1/", "");
    if (table === "rpc/rate_limit_hit") return Response.json(true);
    if (table === "rpc/user_id_for_email") return Response.json(null);
    if (table === "rpc/admin_grant_allow") {
      s.log.push({ what: "grant", body });
      return new Response(null, { status: 204 });
    }
    if (table === "memberships") {
      if (method === "PATCH") {
        s.log.push({ what: "memberships PATCH", body });
        Object.assign(members[eq("user_id")!]!, body);
        return Response.json([{ user_id: eq("user_id") }]);
      }
      if (method === "POST") {
        s.log.push({ what: "memberships POST", body });
        return new Response(null, { status: 201 });
      }
      if (url.searchParams.get("role") === "eq.owner") return Response.json(Object.entries(members).filter(([, m]) => m.role === "owner").map(([user_id]) => ({ user_id })));
      // Other businesses the person is in (inviteStatus): none.
      if (url.searchParams.has("company_id") && url.searchParams.get("company_id")!.startsWith("neq.")) return Response.json([]);
      const id = eq("user_id")!;
      return Response.json(members[id] ? [{ company_id: CO, subcontractor_id: null, ...members[id] }] : []);
    }
    if (table === "company_roles") {
      if (method === "POST") {
        s.log.push({ what: "company_roles POST", body });
        return Response.json({ id: body.id }, { status: 201 });
      }
      if (method === "PATCH") {
        s.log.push({ what: "company_roles PATCH", body });
        return Response.json([{ id: eq("id") }]);
      }
      const role = roles[eq("id")!];
      return Response.json(role ? [role] : []);
    }
    if (table === "profiles") {
      const ids = (eq("user_id") ?? url.searchParams.get("user_id")!.replace(/^in\.\(|\)$|"/g, "")).split(",");
      return Response.json(ids.flatMap((id) => (profiles[id] ? [profiles[id]] : [])));
    }
    if (table === "companies") return Response.json([{ name: "Green Lawn", email: null, timezone: "America/Chicago" }]);
    if (table === "activity" || table === "notifications") {
      s.tables[table].push(...(Array.isArray(body) ? body : [body]));
      return new Response(null, { status: 201 });
    }
    if (table === "integrations" || table === "integration_secrets") return Response.json([]);
    throw new Error(`unexpected ${method} ${url}`);
  });
  return s;
}

const send = (method: string, path: string, body: object = {}) => app.request(`/api${path}`, { method, headers, body: JSON.stringify(body) }, env);
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
const wrote = (s: ReturnType<typeof supabase>) => s.log.map((l) => l.what);

afterEach(() => vi.unstubAllGlobals());

describe("giving someone admin access", () => {
  it("asks for the giver's password, opens the database's minute for them only, then tells the owners", async () => {
    const s = supabase();
    const missing = await send("PATCH", `/team/${SAM}/access`, { role: "admin" });
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toBe(ADMIN_PASSWORD);
    const wrong = await send("PATCH", `/team/${SAM}/access`, { role: "admin", current_password: "guess" });
    expect(wrong.status).toBe(400);
    expect(await errorOf(wrong)).toBe(WRONG_PASSWORD);
    expect(s.log).toEqual([]);

    const res = await send("PATCH", `/team/${SAM}/access`, { role: "admin", current_password: "right" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(s.log).toEqual([
      { what: "grant", body: { p_user: PAT, p_company: CO, p_target: SAM } },
      { what: "memberships PATCH", body: { role: "admin", role_id: null } },
    ]);
    await vi.waitFor(() => expect(s.emails).toHaveLength(1));
    expect(s.tables.activity).toEqual([expect.objectContaining({ company_id: CO, actor_id: PAT, verb: "team.admin_access", summary: "Pat Owner made Sam Crew Admin" })]);
    expect(s.tables.notifications).toEqual([expect.objectContaining({ user_id: PAT, kind: "security", title: "Someone was given admin access", link: "/settings?tab=team" })]);
    expect(s.emails[0]).toMatchObject({ to: ["pat@greenlawn.example"], subject: "Someone was given admin access for Green Lawn" });
    expect(s.emails[0]!.text).toContain("Who: Pat Owner (pat@greenlawn.example)");
    expect(s.emails[0]!.text).toContain("What: made Sam Crew Admin");
    expect(s.emails[0]!.text).toMatch(/When: \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M C[DS]T/);
    expect(s.emails[0]!.text).toContain("If this wasn't you");
  });

  it("goes by the custom role, which sets the level", async () => {
    const s = supabase();
    expect(await errorOf(await send("PATCH", `/team/${SAM}/access`, { role: "field_crew", role_id: GM }))).toBe(ADMIN_PASSWORD);
    // An admin role without apps, settings or team isn't admin-level.
    expect((await send("PATCH", `/team/${SAM}/access`, { role: "field_crew", role_id: BOOKS })).status).toBe(200);
    expect(s.log).toEqual([{ what: "memberships PATCH", body: { role: "admin", role_id: BOOKS } }]);
    expect(s.passwordChecks).toBe(0);
  });

  it("needs no password for anything below admin, or for an admin moved down", async () => {
    const s = supabase();
    expect((await send("PATCH", `/team/${SAM}/access`, { role: "office" })).status).toBe(200);
    expect((await send("PATCH", `/team/${ADA}/access`, { role: "estimator" })).status).toBe(200);
    expect(wrote(s)).toEqual(["memberships PATCH", "memberships PATCH"]);
    expect(s.passwordChecks).toBe(0);
    expect(s.tables.activity).toEqual([]);
  });

  it("keeps the rules for who changes whose role", async () => {
    const s = supabase();
    s.members[PAT]!.role = "admin";
    expect(await errorOf(await send("PATCH", `/team/${SAM}/access`, { role: "owner", current_password: "right" }))).toBe("Only an owner can make someone an owner.");
    expect(await errorOf(await send("PATCH", `/team/${PAT}/access`, { role: "office" }))).toBe("Ask an owner to change your own role or access.");
    s.members[SAM]!.role = "owner";
    expect(await errorOf(await send("PATCH", `/team/${SAM}/access`, { role: "office" }))).toBe("Only an owner can do that for another owner.");
    expect(s.log).toEqual([]);
    expect(s.passwordChecks).toBe(0);
  });

  it("asks before an invite as admin makes any account", async () => {
    const s = supabase();
    const missing = await send("POST", "/team/invite", { email: "New@Greenlawn.example", role: "admin" });
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toBe(ADMIN_PASSWORD);
    expect(s.log).toEqual([]);

    const res = await send("POST", "/team/invite", { email: "New@Greenlawn.example", role: "admin", current_password: "right" });
    expect(res.status).toBe(201);
    expect(wrote(s)).toEqual(["link invite", "grant", "memberships POST"]);
    expect(s.log[1]!.body).toEqual({ p_user: PAT, p_company: CO, p_target: NEW });
    await vi.waitFor(() => expect(s.tables.activity).toHaveLength(1));
    expect(s.tables.activity[0]).toMatchObject({ verb: "team.admin_access", summary: "Pat Owner invited new@greenlawn.example as Admin" });
  });

  it("is never given without the password, as by an AI assistant", async () => {
    supabase();
    const scope = { db: {} as Db, env, companyId: CO, userId: PAT, role: "owner" as const, baseUrl: "https://ops.example.com" };
    await expect(invitePerson(scope, { email: "new@greenlawn.example", role: "admin" })).rejects.toThrow(ADMIN_FROM_TEAM_PAGE);
  });
});

describe("custom roles", () => {
  it("one that becomes admin-level asks for the password, by the id it's made with", async () => {
    const s = supabase();
    const row = { name: "Everything", base_role: "admin", permissions: ["team"] };
    expect(await errorOf(await send("POST", "/team/roles", row))).toBe(ADMIN_PASSWORD);
    const res = await send("POST", "/team/roles", { ...row, current_password: "right" });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(s.log).toEqual([
      { what: "grant", body: { p_user: PAT, p_company: CO, p_target: id } },
      { what: "company_roles POST", body: { id, company_id: CO, ...row } },
    ]);
    await vi.waitFor(() => expect(s.tables.activity).toHaveLength(1));
    expect(s.tables.activity[0]).toMatchObject({ summary: "Pat Owner made the Everything role, with admin access" });
  });

  it("asks when a role's new areas make it admin-level, and not otherwise", async () => {
    const s = supabase();
    expect(await errorOf(await send("PUT", `/team/roles/${BOOKS}`, { name: "Bookkeeper", base_role: "admin", permissions: ["invoices", "settings"] }))).toBe(ADMIN_PASSWORD);
    // Renaming one that's admin-level already, or taking areas away, or a role below admin.
    expect((await send("PUT", `/team/roles/${GM}`, { name: "Manager", base_role: "admin", permissions: ["team"] })).status).toBe(200);
    expect((await send("PUT", `/team/roles/${BOOKS}`, { name: "Books", base_role: "admin", permissions: ["invoices", "reports"] })).status).toBe(200);
    expect((await send("POST", "/team/roles", { name: "Front desk", base_role: "office", permissions: ["settings"] })).status).toBe(201);
    expect(wrote(s)).toEqual(["company_roles PATCH", "company_roles PATCH", "company_roles POST"]);
    expect(s.passwordChecks).toBe(0);

    expect((await send("PUT", `/team/roles/${BOOKS}`, { name: "Bookkeeper", base_role: "admin", permissions: ["invoices", "settings"], current_password: "right" })).status).toBe(200);
    expect(s.log.slice(-2).map((l) => l.what)).toEqual(["grant", "company_roles PATCH"]);
    await vi.waitFor(() => expect(s.tables.activity).toHaveLength(1));
    expect(s.tables.activity[0]).toMatchObject({ summary: "Pat Owner gave the Bookkeeper role admin access" });
  });
});

describe("links into an admin's account", () => {
  it("a reset link for an admin asks for the password", async () => {
    const s = supabase();
    s.members[ADA]!.role_id = GM;
    const missing = await send("POST", `/team/${ADA}/password-link`);
    expect(missing.status).toBe(400);
    expect(await errorOf(missing)).toBe(ADMIN_PASSWORD);
    expect(wrote(s)).toEqual([]);
    expect((await send("POST", `/team/${ADA}/password-link`, { current_password: "right" })).status).toBe(200);
    expect(wrote(s)).toEqual(["link recovery"]);
  });

  it("so does a new invite link for an admin who hasn't joined yet, but not for the crew", async () => {
    const s = supabase();
    expect(await errorOf(await send("POST", `/team/${ADA}/invite-link`))).toBe(ADMIN_PASSWORD);
    expect((await send("POST", `/team/${ADA}/invite-link`, { current_password: "right" })).status).toBe(200);
    expect(s.passwordChecks).toBe(1);
    // Sam's link needs none (and a request with no body at all is fine).
    expect((await app.request(`/api/team/${SAM}/invite-link`, { method: "POST", headers }, env)).status).toBe(200);
    expect(s.passwordChecks).toBe(1);
    expect(wrote(s)).toEqual(["link recovery", "link recovery"]);
  });
});
