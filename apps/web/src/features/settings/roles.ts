/** Company roles (custom + built-in) for pickers: one value per choice, "role:<id>" or "level:<access level>". */
import { adminLevel, ROLE_LABELS, STAFF, type Permission, type Role } from "@crewtavo/core/roles";
import { useQuery } from "@tanstack/react-query";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";

export interface CompanyRole { id: string; name: string; base_role: Role; permissions: Permission[] }

export function useCompanyRoles() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["company-roles", company.id],
    queryFn: async () => unwrap(await supabase().from("company_roles").select("id, name, base_role, permissions").eq("company_id", company.id).order("name")) as unknown as CompanyRole[],
  });
}

export interface RoleChoice { value: string; label: string; group: "Your roles" | "Built-in" }

/**
 * Choices for a role picker. Only owners can make someone an owner. Never Subcontractor: a sub's
 * sign-in comes from their page under Subcontractors.
 */
export function roleChoices(roles: CompanyRole[] | undefined, viewerIsOwner: boolean): RoleChoice[] {
  return [
    ...(roles ?? []).map((r) => ({ value: `role:${r.id}`, label: r.name, group: "Your roles" as const })),
    ...STAFF.filter((r) => r !== "owner" || viewerIsOwner).map((r) => ({ value: `level:${r}`, label: ROLE_LABELS[r], group: "Built-in" as const })),
  ];
}

export const choiceFor = (member: { role: Role; role_id?: string | null }) => (member.role_id ? `role:${member.role_id}` : `level:${member.role}`);

/** The membership fields a choice sets. */
export function patchFor(choice: string): { role_id: string | null; role?: Role } {
  if (choice.startsWith("role:")) return { role_id: choice.slice(5) };
  return { role_id: null, role: choice.slice(6) as Role };
}

/** What a choice gives, as the API takes it (PATCH /api/team/:id/access, POST /api/team/invite): the level and the custom role. */
export function accessFor(choice: string, roles: CompanyRole[] | undefined): { role: Role; role_id: string | null } {
  const patch = patchFor(choice);
  return { role: patch.role ?? roles?.find((r) => r.id === patch.role_id)?.base_role ?? "field_crew", role_id: patch.role_id };
}

/** Whether a choice gives admin-level access (adminLevel), which asks for the giver's own password. The API checks it too. */
export function givesAdmin(choice: string, roles: CompanyRole[] | undefined): boolean {
  const { role, role_id } = accessFor(choice, roles);
  return adminLevel(role, roles?.find((r) => r.id === role_id)?.permissions ?? null);
}

export function roleName(member: { role: Role; role_id?: string | null }, roles: CompanyRole[] | undefined): string {
  return (member.role_id && roles?.find((r) => r.id === member.role_id)?.name) || ROLE_LABELS[member.role];
}
