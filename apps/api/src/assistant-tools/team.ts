/**
 * The team: who's on it, inviting people, their roles and access, and custom roles. Everything
 * goes through the person's own client, so the database's rules hold for an assistant as for them:
 * only owners make owners, there's always an owner, nobody gives more access than they have, and
 * nobody changes their own role. The owners hear about every change an assistant makes (the
 * assistant_more_areas migration). An invite's link is emailed, never handed to the assistant.
 * Admin-level access (adminLevel) is never given here: it asks for the person's password, on the
 * Settings → People page (the database refuses it from an assistant too).
 */
import { ADMINS, adminLevel, OFFICE, PERMISSIONS, ROLE_LABELS, STAFF, type Role } from "@crewtavo/core";
import { z } from "zod";
import { adminClient } from "../lib/supabase";
import { currentRates } from "../services/payRates";
import { ADMIN_FROM_TEAM_PAGE, adminAccess, invitePerson } from "../services/team";
import { changed, companyArg, friendly, one, requireRole, roleAllows, rows, tool, type ToolContext } from "./tool";

const permissionKeys = PERMISSIONS.map((p) => p.key) as [string, ...string[]];

/** The team's levels (not Subcontractor: subs' sign-ins are given on their page under Subs). */
const LEVELS = STAFF as [Role, ...Role[]];

/** Everyone on the team, with their role and, for the office with job costs, their pay rate. Not subs. */
export async function teamList(ctx: ToolContext, includeInactive = false) {
  let q = ctx.db.from("memberships").select("user_id, role, role_id, active").eq("company_id", ctx.companyId).neq("role", "subcontractor");
  if (!includeInactive) q = q.eq("active", true);
  const members = await rows(q);
  const [profiles, roles, rates] = await Promise.all([
    members.length ? rows(ctx.db.from("profiles").select("user_id, full_name, email, phone").in("user_id", members.map((m) => m.user_id))) : Promise.resolve([]),
    rows(ctx.db.from("company_roles").select("id, name").eq("company_id", ctx.companyId)),
    roleAllows(ctx, OFFICE, "job_costs") ? currentRates(adminClient(ctx.env), ctx.companyId) : Promise.resolve(null),
  ]);
  const byId = new Map(profiles.map((p) => [p.user_id, p]));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  return members.map((m) => ({
    user_id: m.user_id,
    name: byId.get(m.user_id)?.full_name ?? null,
    email: byId.get(m.user_id)?.email ?? null,
    phone: byId.get(m.user_id)?.phone ?? null,
    role: m.role_id ? (roleName.get(m.role_id) ?? ROLE_LABELS[m.role as Role]) : ROLE_LABELS[m.role as Role] ?? m.role,
    level: m.role,
    role_id: m.role_id,
    active: m.active,
    ...(rates && { pay_rate: rates[m.user_id] ?? null }),
  }));
}

export const teamTools = {
  list_team: tool({
    description: "The people on the team: name, email, phone, role, user_id (for crews, visits and time), and pay rate if your role sees job costs. Also the company's custom roles. include_inactive adds people whose access was taken away.",
    input: z.object({ include_inactive: z.boolean().default(false), ...companyArg }),
    run: async (ctx, a) => ({
      people: await teamList(ctx, a.include_inactive),
      custom_roles: await rows(ctx.db.from("company_roles").select("id, name, base_role, permissions").eq("company_id", ctx.companyId).order("name")),
      levels: LEVELS.map((r) => ({ level: r, label: ROLE_LABELS[r] })),
    }),
  }),
  invite_person: tool({
    description:
      "Invite someone to the team by email, with a role (a level, or a custom role_id from list_team). Crewtavo emails them a link to set up their account; someone who already has an account just gets access. Not as an owner or admin (or a custom role with the apps, settings or team area): that's done in Crewtavo, which asks for the person's password. Confirm the email and role with the person first.",
    input: z.object({
      email: z.email(),
      full_name: z.string().trim().max(120).optional(),
      role: z.enum(LEVELS).default("field_crew"),
      role_id: z.uuid().nullable().optional(),
      ...companyArg,
    }),
    area: "team",
    run: async (ctx, a) => {
      requireRole(ctx, ADMINS, "team");
      const { link: _, ...result } = await invitePerson(
        { db: ctx.db, env: ctx.env, companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, baseUrl: (ctx.env.APP_URL ?? ctx.origin).replace(/\/$/, "") },
        { email: a.email, full_name: a.full_name, role: a.role, role_id: a.role_id },
      );
      return { ...result, ...(!result.emailed && { note: `The invite email didn't go out (${result.reason ?? "email isn't set up"}). The person can be sent a new link from Settings → People in Crewtavo.` }) };
    },
  }),
  change_role: tool({
    description: "Change someone's role: a level (office, estimator, crew_lead, field_crew) or a custom role (role_id). Nobody can be given more access than you have; you can't change your own role. Owner and admin access (or a custom role with the apps, settings or team area) is given in Crewtavo, which asks for the person's password.",
    input: z.object({ user_id: z.uuid(), role: z.enum(LEVELS).optional(), role_id: z.uuid().nullable().optional(), ...companyArg }),
    area: "team",
    run: async (ctx, a) => {
      if (!a.role && a.role_id === undefined) throw new Error("Give a role or a role_id.");
      if (await adminAccess(ctx.db, ctx.companyId, a.role ?? "", a.role_id)) throw new Error(ADMIN_FROM_TEAM_PAGE);
      // A custom role decides the level itself (its base role).
      const patch = a.role_id ? { role_id: a.role_id } : { role: a.role!, role_id: null };
      const { data, error } = await ctx.db.from("memberships").update(patch).eq("company_id", ctx.companyId).eq("user_id", a.user_id).select("user_id, role");
      if (error) throw new Error(friendly(error.message));
      if (!data?.length) throw new Error("That person not found (or you can't change them).");
      return { saved: true, level: data[0].role };
    },
  }),
  deactivate_person: tool({
    description: "Take away someone's access to this company (they stay on record, with their time and history; restore_person gives it back). The last owner can't be removed. Confirm with the person first.",
    input: z.object({ user_id: z.uuid(), ...companyArg }),
    area: "team",
    run: async (ctx, a) => {
      if (a.user_id === ctx.userId) throw new Error("You can't take away your own access.");
      const { data, error } = await ctx.db.from("memberships").update({ active: false }).eq("company_id", ctx.companyId).eq("user_id", a.user_id).select("user_id");
      if (error) throw new Error(friendly(error.message));
      if (!data?.length) throw new Error("That person not found (or you can't change them).");
      return { access: "removed" };
    },
  }),
  restore_person: tool({
    description: "Give someone whose access was taken away their access back, with the role they had.",
    input: z.object({ user_id: z.uuid(), ...companyArg }),
    area: "team",
    run: async (ctx, a) => {
      const { data, error } = await ctx.db.from("memberships").update({ active: true }).eq("company_id", ctx.companyId).eq("user_id", a.user_id).select("user_id");
      if (error) throw new Error(friendly(error.message));
      if (!data?.length) throw new Error("That person not found (or you can't change them).");
      return { access: "restored" };
    },
  }),
  save_role: tool({
    description: `Make a custom role (no role_id) or change one: a name, the level it's based on (not owner), and the areas it can use, from: ${PERMISSIONS.map((p) => `${p.key} (${p.label})`).join(", ")}. A role can only have areas its level allows, and you can't give areas you don't have. A role based on admin that gets apps, settings or team is admin access, given in Crewtavo, which asks for the person's password.`,
    input: z.object({
      role_id: z.uuid().optional(),
      name: z.string().trim().min(1).max(60),
      base_role: z.enum(LEVELS.filter((r) => r !== "owner") as [Role, ...Role[]]),
      permissions: z.array(z.enum(permissionKeys)).max(permissionKeys.length),
      ...companyArg,
    }),
    area: "team",
    run: async (ctx, a) => {
      const row = { name: a.name, base_role: a.base_role, permissions: a.permissions };
      // Only a role that's admin-level already keeps it here (renamed, say).
      if (adminLevel(a.base_role, a.permissions) && !(a.role_id && (await adminAccess(ctx.db, ctx.companyId, "", a.role_id)))) throw new Error(ADMIN_FROM_TEAM_PAGE);
      if (a.role_id) {
        await changed(ctx.db.from("company_roles").update(row).eq("id", a.role_id).eq("company_id", ctx.companyId).select("id"), "That role");
        return { role_id: a.role_id, saved: true };
      }
      const made = await one(ctx.db.from("company_roles").insert({ company_id: ctx.companyId, ...row }).select("id").single(), "The role");
      return { role_id: made.id, saved: true };
    },
  }),
  delete_role: tool({
    description: "Delete a custom role. People who had it keep their level with every area it allows (which is checked: you can't give them more than you have).",
    input: z.object({ role_id: z.uuid(), ...companyArg }),
    area: "team",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("company_roles").delete().eq("id", a.role_id).eq("company_id", ctx.companyId).select("id"), "That role");
      return { deleted: true };
    },
  }),
};
