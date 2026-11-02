/**
 * Getting back into an account without email (see lib/recovery.ts for the rules):
 *   POST /api/team/:userId/password-link  an admin makes a one-time reset link for someone below them
 *   POST /api/auth/recover                 the owner uses a spare key (or, the last resort, the server's code)
 *   GET  /api/account/spare-keys           how many spare keys the owner has left
 *   POST /api/account/spare-keys           a new set (needs the current password)
 * Each is recorded in the company's activity.
 */
import { ADMINS, canMakeResetLink, isRole } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { confirmAdminGrant, confirmPassword, emailAuthLink, passwordIn, requireCompany, requireUser } from "../lib/auth";
import { safeEqual } from "../lib/crypto";
import { renderEmail } from "../lib/email";
import { appUrl, HttpError, must, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { emailReady, sendEmail } from "../lib/notify";
import { accountCanEmail, accountForEmail, recoverySetting, replaceSpareKeys, spareKeyHash, usedCodeName } from "../lib/recovery";
import { adminClient } from "../lib/supabase";
import { adminAccess } from "../services/team";
import { clientIp } from "../lib/visitor";

export const recovery = new Hono<AppEnv>();

/** A one-time "choose a new password" link for this account (Supabase recovery token, opened by the app). */
async function resetLink(env: Env, base: string, email: string, userId: string): Promise<string> {
  const admin = adminClient(env);
  const { data: account } = await admin.auth.admin.getUserById(userId);
  const { data, error } = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: `${base}/` } });
  if (error || !data.properties?.hashed_token) {
    console.error("Couldn't create a reset link", error);
    throw new HttpError(500, "Couldn't make the link. Try again in a moment.");
  }
  // Someone who never signed in gets the "set your password" wording.
  return emailAuthLink(base, data.properties.hashed_token, "recovery", !account.user?.last_sign_in_at);
}

recovery.post("/team/:userId/password-link", requireUser, requireCompany(ADMINS, "team"), async (c) => {
  const parsed = uuid.safeParse(c.req.param("userId"));
  if (!parsed.success) throw new HttpError(404, "That person isn't on your team.");
  const targetId = parsed.data;
  const { companyId, userId, role } = c.var;
  if (targetId === userId) throw new HttpError(400, "Change your own password under Settings → Profile.");
  if (!(await allow(c.env, `password-link:${userId}`, 10, 3600))) throw new HttpError(429, "Too many reset links. Wait a while and try again.");

  const admin = adminClient(c.env);
  const memberships = must(await admin.from("memberships").select("company_id, role, role_id, active").eq("user_id", targetId));
  const here = memberships.find((m) => m.company_id === companyId);
  if (!here?.active || !isRole(here.role)) throw new HttpError(404, "That person isn't on your team.");
  if (here.role === "subcontractor") throw new HttpError(400, "A sub signs in with a link from their page under Subs.");
  if (!canMakeResetLink(role, here.role)) {
    throw new HttpError(403, role === "owner" ? "Another owner has to reset their own password." : "Only the owner can make a reset link for an admin or the owner.");
  }
  // Their account may unlock other businesses too; that isn't this company's to hand out.
  if (memberships.some((m) => m.company_id !== companyId)) {
    throw new HttpError(403, "This person also uses Crewtavo with another business, so they need to reset their password themselves.");
  }
  // A way into an account with admin-level access asks for the password, as giving that access does.
  if (await adminAccess(admin, companyId, here.role, here.role_id)) await confirmAdminGrant(c, await passwordIn(c));

  const [target, requester, company] = await Promise.all([
    admin.from("profiles").select("email, full_name").eq("user_id", targetId).maybeSingle(),
    admin.from("profiles").select("full_name").eq("user_id", userId).maybeSingle(),
    admin.from("companies").select("name, email").eq("id", companyId).maybeSingle(),
  ]);
  const email = target.data?.email;
  if (!email) throw new HttpError(400, "This person has no email address on their account.");
  const targetName = target.data?.full_name || email;
  const requesterName = requester.data?.full_name || "An admin";
  const companyName = company.data?.name ?? "your company";

  const link = await resetLink(c.env, appUrl(c), email, targetId);

  // On record for the team, and the person hears about it, so a link nobody asked for gets noticed.
  await admin.from("activity").insert({ company_id: companyId, actor_id: userId, verb: "member.password_link", subject_type: "member", subject_id: targetId, summary: `${requesterName} made a password reset link for ${targetName}` });
  await admin.from("notifications").insert({
    company_id: companyId,
    user_id: targetId,
    kind: "security",
    title: "A password reset link was made for your account",
    body: `${requesterName} made it. If you didn't ask for one, tell ${companyName}'s owner.`,
  });

  if (await emailReady(c.env, companyId)) {
    const text = `${requesterName} made a link for you to choose a new password for ${companyName} on Crewtavo. It works once:\n\n${link}\n\nIf you didn't ask for this, tell ${requesterName} or the owner.`;
    const sent = await sendEmail(c.env, { to: email, subject: `Choose a new password for ${companyName}`, ...renderEmail({ companyName, text }), replyTo: company.data?.email ?? undefined, fromName: companyName }, companyId);
    if (sent.sent) return c.json({ emailed: true, link: null });
  }
  // No email: the admin hands it over in person or by text.
  return c.json({ emailed: false, link });
});

const RECOVERY_FAILED =
  "That didn't work. Check the email and the spare key. Each key works once, and only while email isn't set up for your company; if it is, use Forgot password instead.";

/** Recorded in each of the person's companies, so the team can see the account was recovered. */
async function recordRecovery(env: Env, userId: string, summary: string) {
  const admin = adminClient(env);
  const { data: memberships } = await admin.from("memberships").select("company_id").eq("user_id", userId).eq("active", true);
  for (const m of memberships ?? []) {
    await admin.from("activity").insert({ company_id: m.company_id, actor_id: userId, verb: "member.recovered", subject_type: "member", subject_id: userId, summary });
  }
}

/**
 * Back in without email: a typed spare key, the owner's key file (all its keys, of which the first
 * unused one is taken: one upload is one try), or, as the last resort, the code set on the server.
 * Every failure gets the same answer, so it reveals nothing about which part was wrong.
 */
recovery.post("/auth/recover", async (c) => {
  const body = await readJson(
    c,
    z
      .object({ email: z.email(), code: z.string().min(1).max(500).optional(), keys: z.array(z.string().min(1).max(40)).min(1).max(20).optional() })
      .refine((b) => Boolean(b.code) !== Boolean(b.keys), { message: "Send a spare key or the keys from a key file." }),
  );
  const email = body.email.trim().toLowerCase();
  // Per visitor, per account and overall, so a key can't be guessed even from many addresses.
  const allowed =
    (await allow(c.env, `recover:ip:${clientIp(c)}`, 10, 900)) &&
    (await allow(c.env, `recover:email:${email}`, 5, 3600)) &&
    (await allow(c.env, "recover:all", 100, 3600));
  if (!allowed) throw new HttpError(429, "Too many tries. Wait an hour and try again.");
  const admin = adminClient(c.env);

  // The last resort: the code set on the server by whoever controls it.
  const setting = recoverySetting(c.env);
  if (setting.on && body.code && safeEqual(email, setting.email) && safeEqual(body.code.trim(), setting.code)) {
    const profile = await accountForEmail(c.env, setting.email);
    if (!profile) throw new HttpError(400, RECOVERY_FAILED);
    // One use per code, across restarts and replicas: claim it before making the link.
    const claim = await admin.from("app_secrets").insert({ name: await usedCodeName(setting), ciphertext: new Date().toISOString() });
    if (claim.error) {
      if (claim.error.code !== "23505") console.error("Account recovery: couldn't record the code's use", claim.error.message);
      throw new HttpError(400, RECOVERY_FAILED);
    }
    const link = await resetLink(c.env, appUrl(c), setting.email, profile.user_id);
    console.log(`Account recovery: ${setting.email} used the server's recovery code.`);
    await recordRecovery(c.env, profile.user_id, `${profile.full_name || setting.email} reset their password with the server's recovery code`);
    return c.json({ link, left: null });
  }

  // A spare key: only while none of the person's companies can send email.
  const profile = await accountForEmail(c.env, email);
  if (!profile || (await accountCanEmail(c.env, profile.user_id))) throw new HttpError(400, RECOVERY_FAILED);
  let used = false;
  for (const key of body.keys ?? [body.code!]) {
    const { data, error } = await admin.rpc("spare_key_use", { p_user: profile.user_id, p_hash: await spareKeyHash(c.env, profile.user_id, key) });
    if (error) console.error("Spare keys: couldn't check a key", error.message);
    if (data) {
      used = true;
      break;
    }
  }
  if (!used) {
    console.warn("Account recovery: a spare key that doesn't match (or was used) was entered.");
    throw new HttpError(400, RECOVERY_FAILED);
  }
  const link = await resetLink(c.env, appUrl(c), email, profile.user_id);
  const { data: left } = await admin.rpc("spare_keys_left", { p_user: profile.user_id });
  console.log(`Account recovery: ${email} used a spare key${body.keys ? " from their key file" : ""} (${left ?? "?"} left).`);
  await recordRecovery(c.env, profile.user_id, `${profile.full_name || email} reset their password with a spare key`);
  return c.json({ link, left: left ?? null });
});

/** How many spare keys the signed-in owner has left, and whether they'd work right now. */
recovery.get("/account/spare-keys", requireUser, async (c) => {
  const admin = adminClient(c.env);
  const [{ data: left }, canEmail] = await Promise.all([admin.rpc("spare_keys_left", { p_user: c.var.userId }), accountCanEmail(c.env, c.var.userId)]);
  return c.json({ left: left ?? 0, active: !canEmail });
});

/**
 * A new set of spare keys for the signed-in owner; the old ones stop working. Asks for the current
 * password, so someone at an unlocked phone or a leftover session can't quietly make their own.
 */
recovery.post("/account/spare-keys", requireUser, async (c) => {
  const body = await readJson(c, z.object({ password: z.string().min(1).max(200) }));
  const { userId } = c.var;
  const admin = adminClient(c.env);
  const { data: owner } = await admin.from("memberships").select("company_id").eq("user_id", userId).eq("role", "owner").eq("active", true).limit(1);
  if (!owner?.length) throw new HttpError(403, "Spare keys are for the owner. Anyone else can ask the owner or an admin for a reset link.");
  const profile = await confirmPassword(c, body.password, "spare-keys");

  const keys = await replaceSpareKeys(c.env, userId);
  for (const m of owner) {
    await admin.from("activity").insert({ company_id: m.company_id, actor_id: userId, verb: "member.spare_keys", subject_type: "member", subject_id: userId, summary: `${profile.full_name || profile.email} made new spare keys` });
  }
  return c.json({ keys });
});
