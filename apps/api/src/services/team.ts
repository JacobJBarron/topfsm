/**
 * Inviting people to the team: Settings → People (routes/account.ts) and AI assistants' invite_person
 * tool both use it. The membership is made with the inviting person's own client, so the database's
 * rules hold (only owners make owners, nobody gives more than they have); the account itself, and
 * the one-time link to set it up, are made with the server's key.
 */
import { adminLevel, isPlaceholderEmail, isRole, isSubLogin, SUB_LOGIN_MARK, type Role } from "@crewtavo/core";
import type { Env } from "../env";
import { emailAuthLink } from "../lib/auth";
import { renderEmail } from "../lib/email";
import { dbError, HttpError, must } from "../lib/http";
import { sendEmail } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";

/** Who's inviting: their client, company, level, and the address links go to. */
export interface TeamScope {
  db: Db;
  env: Env;
  companyId: string;
  userId: string;
  role: Role;
  baseUrl: string;
}

/** What an assistant, or anything without the giver's password, is told about admin access. */
export const ADMIN_FROM_TEAM_PAGE = "Give admin access from Settings → People in Crewtavo, which asks for your password.";

/**
 * Whether a level, or a custom role (which sets its own level), is admin-level access (adminLevel).
 * Read with `db`, so a role from another company is no role.
 */
export async function adminAccess(db: Db, companyId: string, role: string, roleId?: string | null): Promise<boolean> {
  if (!roleId) return adminLevel(role);
  const custom = must(await db.from("company_roles").select("base_role, permissions").eq("id", roleId).eq("company_id", companyId).maybeSingle(), "That role no longer exists.");
  return adminLevel(custom.base_role, custom.permissions);
}

/**
 * Once the giver has confirmed their password: for a minute, the database lets their own changes give
 * `target` (a person, or a custom role's id) admin-level access (the admin_grants migration).
 */
export async function allowAdminGrant(env: Env, companyId: string, userId: string, target: string) {
  const { error } = await adminClient(env).rpc("admin_grant_allow", { p_user: userId, p_company: companyId, p_target: target });
  if (error) throw dbError(error);
}

/**
 * Where an invite stands for someone on the team: "pending" until they first sign in, so a new link
 * to set up their account can go out; "joined" after (someone locked out gets Reset password). And
 * "elsewhere" when another business has them too: the link sets their password, and it would come
 * back to this admin. A sign-in another business made for its sub (services/subAccess.ts) counts as
 * that business's, even before it's used.
 */
export async function inviteStatus(env: Env, companyId: string, userId: string): Promise<{ status: "pending"; email: string } | { status: "joined" | "elsewhere" }> {
  const admin = adminClient(env);
  const [{ data: account, error }, { data: elsewhere }] = await Promise.all([
    admin.auth.admin.getUserById(userId),
    admin.from("memberships").select("company_id").eq("user_id", userId).eq("active", true).neq("company_id", companyId).limit(1),
  ]);
  if (error || !account.user?.email) {
    console.error("Couldn't look up an account", error);
    throw new HttpError(500, "Couldn't look up their account. Try again in a moment.");
  }
  if (account.user.last_sign_in_at) return { status: "joined" };
  const othersSub = isSubLogin(account.user.app_metadata) && !String(account.user.app_metadata[SUB_LOGIN_MARK]).startsWith(`${companyId.toLowerCase()}:`);
  return elsewhere?.length || othersSub ? { status: "elsewhere" } : { status: "pending", email: account.user.email };
}

/** A fresh one-time link to set up the account of someone who was invited but never signed in. */
export async function welcomeLink(env: Env, base: string, email: string): Promise<string> {
  const { data, error } = await adminClient(env).auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: `${base}/` } });
  if (error || !data.properties?.hashed_token) {
    console.error("Couldn't create an invite link", error);
    throw new HttpError(500, "Couldn't make the invite link. Try again in a moment.");
  }
  return emailAuthLink(base, data.properties.hashed_token, "recovery", true);
}

/**
 * The invitation: a link to set up their account or, without one, a note that they now have access.
 * It goes out from the company's own mailbox (Settings → Email), not Supabase's mailer, which on
 * hosted projects only reaches the project's own team.
 */
export async function sendInvite(s: TeamScope, to: { email: string; name?: string | null }, link: string | null) {
  const company = must(await s.db.from("companies").select("name, email").eq("id", s.companyId).maybeSingle());
  const inviter = (await s.db.from("profiles").select("full_name").eq("user_id", s.userId).maybeSingle()).data?.full_name || "Your team";
  const first = to.name?.trim().split(/\s+/)[0];
  const greeting = first ? `Hi ${first},\n\n` : "";
  const text = link
    ? `${greeting}${inviter} invited you to ${company.name} on Crewtavo, where you'll see your schedule, visits and time.\n\nSet up your account here (the link works once; if it has expired, ask for a new invite):\n\n${link}\n\nOn your phone, open it in your browser and use "Add to Home Screen" to keep Crewtavo one tap away.`
    : `${greeting}${inviter} gave you access to ${company.name} on Crewtavo. Sign in with your email and password as usual:\n\n${s.baseUrl}/`;
  return sendEmail(
    s.env,
    { to: to.email, subject: link ? `Join ${company.name} on Crewtavo` : `You now have access to ${company.name}`, ...renderEmail({ companyName: company.name, text }), replyTo: company.email ?? undefined, fromName: company.name },
    s.companyId,
  );
}

/**
 * Add someone to the team: an account they already have, or a new one with a one-time link to set
 * it up, emailed to them. The link comes back too, for Settings → People to text it; an AI
 * assistant's tool never passes it on (whoever opens it gets into that account). Admin-level access
 * needs `confirmAdmin` (the giver's password, checked before any account is made); without it,
 * as for an assistant, it's refused.
 */
export async function invitePerson(s: TeamScope, body: { email: string; full_name?: string; role: Role; role_id?: string | null }, confirmAdmin?: () => Promise<unknown>) {
  if (!isRole(body.role)) throw new HttpError(400, "Pick a role.");
  // A sub isn't on the team: they sign in from their page under Subs (services/subAccess.ts).
  if (body.role === "subcontractor") throw new HttpError(400, "A sub isn't invited to the team. Give them a sign-in from their page under Subs.");
  if (isPlaceholderEmail(body.email)) throw new HttpError(400, "Enter their own email address.");
  // Checked before an account is made: the database would refuse the membership, but only after.
  if (body.role === "owner" && s.role !== "owner") throw new HttpError(403, "Only an owner can make someone an owner.");
  const givesAdmin = await adminAccess(s.db, s.companyId, body.role, body.role_id);
  if (givesAdmin) {
    if (!confirmAdmin) throw new HttpError(403, ADMIN_FROM_TEAM_PAGE);
    await confirmAdmin();
  }
  const admin = adminClient(s.env);
  const email = body.email.toLowerCase();

  // Existing account? Add them. Otherwise create the account and a one-time link to set a password.
  // By the email they sign in with: profile emails are only a copy, and `ilike` would treat "_" as a wildcard.
  const { data: existing } = await admin.rpc("user_id_for_email", { p_email: email });
  let userId = existing ?? undefined;
  let link: string | null = null;
  // A sign-in another business made for its sub is that business's: joining it to a team here would
  // stop its sign-in codes and links working there (they're only for a sign-in nobody else has).
  if (userId) await notAnotherBusinessSub(s, userId);
  // Someone who was this company's sub: their old sign-in gives way to the team's (formerSub).
  const wasSub = userId ? await formerSub(s, userId) : false;
  if (!userId) {
    const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email, options: { data: { full_name: body.full_name ?? "" }, redirectTo: `${s.baseUrl}/` } });
    if (error || !data.user) {
      console.error("Invite failed", error);
      throw new HttpError(400, /already|registered/i.test(error?.message ?? "") ? "That email already has an account. Try again in a moment." : "Couldn't create the invite. Check the email address and try again.");
    }
    userId = data.user.id;
    link = emailAuthLink(s.baseUrl, data.properties.hashed_token, "invite");
  } else if ((await inviteStatus(s.env, s.companyId, userId)).status === "pending") {
    // Invited before but never signed in (the first link expired, or never arrived): a fresh set-up
    // link instead of "sign in as usual", since they don't have a password yet.
    link = await welcomeLink(s.env, s.baseUrl, email);
  }

  if (wasSub) {
    const { error: removed } = await adminClient(s.env).from("memberships").delete().eq("company_id", s.companyId).eq("user_id", userId).eq("role", "subcontractor").eq("active", false);
    if (removed) throw dbError(removed);
  }
  // Inserted as the inviting person, so RLS checks they may grant this role.
  if (givesAdmin) await allowAdminGrant(s.env, s.companyId, s.userId, userId);
  const { error } = await s.db.from("memberships").upsert({ company_id: s.companyId, user_id: userId, role: body.role, role_id: body.role_id ?? null, active: true });
  if (error) throw dbError(error);

  const sent = await sendInvite(s, { email, name: body.full_name }, link);
  return { user_id: userId, invited: !existing, emailed: sent.sent, reason: sent.sent ? null : sent.reason ?? null, link };
}

/** Refuses an account another business made for its sub (services/subAccess.ts): it's theirs alone. */
async function notAnotherBusinessSub(s: TeamScope, userId: string) {
  const { data, error } = await adminClient(s.env).auth.admin.getUserById(userId);
  if (error || !data.user) {
    console.error("Couldn't look up an account to invite", error);
    throw new HttpError(500, "Couldn't look up their account. Try again in a moment.");
  }
  const mark = data.user.app_metadata?.[SUB_LOGIN_MARK];
  if (isSubLogin(data.user.app_metadata) && !String(mark).startsWith(`${s.companyId.toLowerCase()}:`)) {
    throw new HttpError(409, "That email is a sign-in another business made for its subcontractor. Invite them with another email address.");
  }
}

/**
 * Whether someone being invited signs in here as a sub. One membership per person per company: while
 * their sub sign-in is on, the office removes it first, on their page under Subs; once it's off, the
 * old sub sign-in gives way to the team's (invitePerson removes it with the server's key, since from
 * a browser nobody turns a sub's sign-in into the team's: membership_sub_guard).
 */
async function formerSub(s: TeamScope, userId: string): Promise<boolean> {
  const { data: here, error } = await adminClient(s.env).from("memberships").select("role, active").eq("company_id", s.companyId).eq("user_id", userId).maybeSingle();
  if (error) throw dbError(error);
  if (here?.role !== "subcontractor") return false;
  if (here.active) throw new HttpError(409, "They sign in as your sub. Remove their sign-in on their page under Subs first.");
  return true;
}
