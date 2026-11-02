/**
 * Member roles, mirroring the public.member_role enum in Postgres. Every level but Subcontractor is
 * the team; a sub is an outsider who signs in to see their own jobs and paperwork, and nothing else
 * (docs/subcontractors-plan.md).
 */
export const ROLES = ["owner", "admin", "office", "estimator", "crew_lead", "field_crew", "subcontractor"] as const;
export type Role = (typeof ROLES)[number];

/** Role groups used by API route guards. RLS in Postgres enforces the same rules. */
export const ADMINS: readonly Role[] = ["owner", "admin"];
export const OFFICE: readonly Role[] = ["owner", "admin", "office"];
export const SALES: readonly Role[] = ["owner", "admin", "office", "estimator"];
export const DISPATCH: readonly Role[] = ["owner", "admin", "office", "estimator", "crew_lead"];
/** The team: every level but Subcontractor. What "a member of the company" means (private.is_member). */
export const STAFF: readonly Role[] = ["owner", "admin", "office", "estimator", "crew_lead", "field_crew"];
/** Everyone on the team. */
export const EVERYONE: readonly Role[] = STAFF;
/** The team and subs: only for the few routes a sub uses (My day, their visits, push, their photo). */
export const WITH_SUBS: readonly Role[] = ROLES;

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  office: "Office",
  estimator: "Estimator",
  crew_lead: "Crew lead",
  field_crew: "Field crew",
  subcontractor: "Subcontractor",
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);
/** On the team (every level but Subcontractor). */
export const isStaff = (role: unknown): role is Role => typeof role === "string" && (STAFF as readonly string[]).includes(role);

/**
 * Areas a role can be given. A member's access level (above) decides which records they can reach;
 * a custom role can switch areas off within that level. Mirrors private.level_permissions() in
 * supabase/migrations, which enforces the same rules in the database.
 */
export const PERMISSIONS = [
  { key: "sales", label: "Quotes and sales" },
  { key: "invoices", label: "Invoices and payments" },
  { key: "job_costs", label: "Job costs and profit" },
  { key: "reports", label: "Finance and metrics" },
  { key: "marketing", label: "Marketing" },
  { key: "automations", label: "Automations" },
  { key: "schedule", label: "Schedule the whole team" },
  { key: "timesheets", label: "Approve timesheets (crew leads: their crew's)" },
  { key: "settings", label: "Price list, checklists, crews and booking forms" },
  { key: "kb_edit", label: "Write and edit guides" },
  { key: "team", label: "Manage people and roles" },
  { key: "apps", label: "Connect apps" },
  { key: "equipment", label: "Manage equipment and maintenance" },
  { key: "subs", label: "Subcontractors, their paperwork and pay" },
  { key: "hiring", label: "Job applicants and hiring" },
] as const;
export type Permission = (typeof PERMISSIONS)[number]["key"];

const ALL: Permission[] = PERMISSIONS.map((p) => p.key);
export const LEVEL_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL,
  office: ALL.filter((p) => p !== "team" && p !== "apps"),
  estimator: ["sales", "schedule", "equipment"],
  // A crew lead always runs their own crew; "schedule" extends that to every crew.
  crew_lead: ["schedule", "timesheets", "equipment"],
  field_crew: [],
  // A sub reaches their own visits and paperwork through their level alone, never an area.
  subcontractor: [],
};

/** What each access level can reach, in a few words, for picking a level. */
export const LEVEL_SUMMARY: Record<Role, string> = {
  owner: "Everything, including billing and ownership",
  admin: "Everything",
  office: "All clients, jobs and money",
  estimator: "Clients, requests, quotes and the schedule. No invoices",
  crew_lead: "Schedules and staffs their own crew, sees its time. Sees the whole schedule. No prices",
  field_crew: "Only their own visits and time. No prices",
  subcontractor: "Only their own jobs, their price on each, and their paperwork. A client's phone and email only if you allow it",
};

export const isPermission = (value: unknown): value is Permission => typeof value === "string" && (ALL as string[]).includes(value);

/** Effective areas for a member: their custom role's list, or everything their level allows. */
export function memberPermissions(role: Role, customPermissions?: readonly string[] | null): Permission[] {
  const allowed = LEVEL_PERMISSIONS[role];
  return customPermissions ? allowed.filter((p) => customPermissions.includes(p)) : [...allowed];
}

/** The areas behind the Stripe key, the company's email (Apps or Settings) and the team. */
export const ADMIN_AREAS: readonly Permission[] = ["apps", "settings", "team"];

/**
 * Admin-level access: an owner, or an admin whose areas (their custom role's, or all of them)
 * include one of ADMIN_AREAS, so they could switch Stripe or make more admins. Giving it asks for
 * the giver's password (POST /api/team/invite, PATCH /api/team/:userId/access, /api/team/roles); the
 * database refuses it from the browser (private.admin_level, the admin_grants migration).
 */
export function adminLevel(role: string, customPermissions?: readonly string[] | null): boolean {
  return isRole(role) && ADMINS.includes(role) && memberPermissions(role, customPermissions).some((p) => ADMIN_AREAS.includes(p));
}

/**
 * Who may make a password reset link for whom (Settings → People): only for someone strictly below
 * them, so nobody can take over an account with as much access as their own. The owner: everyone
 * but other owners. An admin: people below admin. Never for a sub, who signs in with a link from
 * their page under Subs. The API enforces it (apps/api/src/routes/recovery.ts).
 */
export function canMakeResetLink(requester: Role, target: Role): boolean {
  if (target === "subcontractor") return false;
  if (requester === "owner") return target !== "owner";
  if (requester === "admin") return target !== "owner" && target !== "admin";
  return false;
}
