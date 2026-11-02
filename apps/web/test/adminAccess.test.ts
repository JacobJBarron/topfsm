/**
 * Giving someone admin access on Settings → People and Roles takes the giver's own Crewtavo
 * password, so a hijacked session can't make itself a new admin: a role change to an admin-level
 * role (adminLevel in @crewtavo/core), an invite as one, a reset or invite link for someone who has
 * it, and a custom role saved with it. Anything less asks for nothing.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { accessFor, givesAdmin, type CompanyRole } from "../src/features/settings/roles";
import { RoleDialog } from "../src/features/settings/RolesSettings";
import { ResendInviteDialog, ResetPasswordDialog, TeamSettings, type Member } from "../src/features/settings/TeamSettings";

const COMPANY = "0f0f0f0f-0000-4000-8000-000000000000";
vi.mock("../src/lib/session", () => ({
  useSession: () => ({ role: "owner", permissions: [], userId: "u-me", company: { id: COMPANY, name: "Green Acres", settings: {} }, config: { features: {} } }),
  hasRole: () => true,
  can: () => true,
  isSub: () => false,
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: { get: async () => ({}) },
  supabase: () => ({ rpc: async () => ({ data: null, error: null }) }),
}));

const ROLES: CompanyRole[] = [
  { id: "role-manager", name: "Manager", base_role: "admin", permissions: ["team", "apps", "settings"] },
  { id: "role-foreman", name: "Foreman", base_role: "crew_lead", permissions: ["schedule"] },
  { id: "role-mower", name: "Mower", base_role: "field_crew", permissions: [] },
  { id: "role-books", name: "Bookkeeper", base_role: "admin", permissions: ["invoices", "reports"] },
];
const member = (role: Member["role"], role_id: string | null = null): Member =>
  ({ user_id: "u-sam", role, role_id, active: true, labor_rate: null, profile: { full_name: "Sam Hill", email: "sam@example.com", color: null, avatar_url: null } });
const render = (element: ReactElement, entries?: Array<string | { pathname: string; state: unknown }>) => {
  const client = new QueryClient();
  client.setQueryData(["company-roles", COMPANY], ROLES);
  client.setQueryData(["team", COMPANY], []);
  client.setQueryData(["team-invites", COMPANY], []);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: entries }, element)));
};
const asksPassword = (html: string) => /<input[^>]*type="password"[^>]*autoComplete="current-password"[^>]*required=""/.test(html) && html.includes("Your Crewtavo password");

describe("which access is admin-level", () => {
  it("is the owner and admin levels, and a custom role on the admin level with apps, settings or the team", () => {
    expect(givesAdmin("level:owner", ROLES)).toBe(true);
    expect(givesAdmin("level:admin", ROLES)).toBe(true);
    expect(givesAdmin("role:role-manager", ROLES)).toBe(true);
    for (const choice of ["level:office", "level:estimator", "level:crew_lead", "level:field_crew", "role:role-foreman", "role:role-mower", "role:role-books"]) expect(givesAdmin(choice, ROLES)).toBe(false);
  });

  it("sends the level and the custom role as the API takes them", () => {
    expect(accessFor("role:role-foreman", ROLES)).toEqual({ role: "crew_lead", role_id: "role-foreman" });
    expect(accessFor("level:office", ROLES)).toEqual({ role: "office", role_id: null });
  });
});

describe("links that open an admin's account", () => {
  it("take your password for someone with admin access, and nothing for anyone else", () => {
    expect(asksPassword(render(createElement(ResetPasswordDialog, { member: member("admin"), onClose: () => undefined })))).toBe(true);
    expect(asksPassword(render(createElement(ResetPasswordDialog, { member: member("admin", "role-manager"), onClose: () => undefined })))).toBe(true);
    expect(asksPassword(render(createElement(ResendInviteDialog, { member: member("owner"), onClose: () => undefined })))).toBe(true);
    expect(asksPassword(render(createElement(ResetPasswordDialog, { member: member("crew_lead", "role-foreman"), onClose: () => undefined })))).toBe(false);
    expect(asksPassword(render(createElement(ResendInviteDialog, { member: member("office"), onClose: () => undefined })))).toBe(false);
  });
});

describe("invites and custom roles", () => {
  it("doesn't ask for a password to invite someone to the crew", () => {
    const html = render(createElement(TeamSettings), [{ pathname: "/settings", state: { invite: { name: "Ana Diaz", email: "ana@example.com" } } }]);
    expect(html).toContain("Send invite");
    expect(asksPassword(html)).toBe(false);
  });

  it("doesn't ask again to edit a role that already has admin access, or for one without it (a new role starts on Office)", () => {
    for (const role of [ROLES[0], ROLES[1], null]) expect(asksPassword(render(createElement(RoleDialog, { role, existing: ROLES, storage: null, onClose: () => undefined })))).toBe(false);
  });
});
