/**
 * Settings → Email: connect the company's Resend key (recommended) or its own mailbox (Gmail, Google
 * Workspace, Zoho, Microsoft 365, Yahoo, iCloud or any SMTP server, with an app password). Saving signs in and
 * sends a test email first, so a connected mailbox is one that works. The password or key is
 * encrypted with ENCRYPTION_KEY and never sent back to the browser. Connecting, changing or
 * disconnecting it asks for the person's own password and tells every owner: the owners hear about
 * Stripe changes by this email, so it mustn't be swapped out quietly first.
 */
import { ADMINS, MAIL_PRESETS, mailPreset } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../env";
import { confirmPassword, requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { encryptJson } from "../lib/crypto";
import { renderEmail } from "../lib/email";
import { appUrl, dbError, HttpError, must, readJson } from "../lib/http";
import { emailConfigured, forgetMailbox, loadMailbox, sendEmail, sendWithMailbox, type MailboxSecret, type MailboxSettings } from "../lib/notify";
import { smtpSend, SmtpError } from "../lib/smtp";
import { adminClient } from "../lib/supabase";
import { logoImage } from "../services/logo";
import { tellOwners } from "./apps";

export const email = new Hono<AppEnv>();

/** Admins with the Apps or Settings area set up the company's email. */
const emailAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.role !== "owner" && !c.var.permissions.some((p) => p === "apps" || p === "settings")) {
    throw new HttpError(403, "Ask an owner to connect the company's email.");
  }
  await next();
});
const requireEmailAdmin = [requireUser, requireCompany(ADMINS), emailAdmin] as const;

const PRESET_IDS = MAIL_PRESETS.map((p) => p.id) as [string, ...string[]];

/** The person's own Crewtavo password (`password` is the mailbox's). */
const currentPassword = z.string().min(1).max(200);

const IF_NOT_YOU = "If this wasn't you, sign in, check Settings → Email, and change your password.";

/** The company's email connected, changed or disconnected, on record and on every owner's bell. */
function noteMailboxChange(c: Context<AppEnv>, who: { email: string; full_name: string | null }, verb: string, summary: string, title: string) {
  const name = who.full_name || who.email;
  runInBackground(c, tellOwners(c, { verb, summary: `${name} ${summary}`, title, body: `${name} ${summary}. ${IF_NOT_YOU}`, link: "/settings?tab=email" }));
}

email.get("/email", ...requireEmailAdmin, async (c) => {
  const { data: row, error } = await adminClient(c.env)
    .from("integrations")
    .select("status, settings, last_error, connected_at")
    .eq("company_id", c.var.companyId)
    .eq("provider", "email")
    .maybeSingle();
  if (error) throw dbError(error);
  return c.json({
    mailbox: row && row.status !== "disconnected" ? { ...(row.settings as unknown as MailboxSettings), status: row.status, last_error: row.last_error, connected_at: row.connected_at } : null,
    // What happens without a mailbox: the install's own Resend account, the dev inbox, or nothing.
    fallback: c.env.RESEND_API_KEY && c.env.EMAIL_FROM ? "server" : c.env.MAILPIT_URL ? "dev" : null,
    // Railway's trial and Hobby plans block mail servers, so the screen points people to Resend.
    on_railway: Boolean(c.env.RAILWAY_PROJECT_ID),
  });
});

/** Railway's trial and Hobby plans block outgoing mail servers: a mailbox times out there, Resend doesn't. */
const RAILWAY_SMTP = " Railway's trial and Hobby plans block sending from a mailbox, so on those plans connect Resend instead.";

const connectSchema = z.object({
  preset: z.enum(PRESET_IDS),
  host: z.string().trim().toLowerCase().min(3).max(200).regex(/^[a-z0-9.-]+$/, "host").optional(),
  port: z.number().int().min(1).max(65535).optional(),
  security: z.enum(["tls", "starttls"]).optional(),
  username: z.string().trim().max(200).optional(),
  /** Leave out to keep the saved password (changing only the name or from address). */
  password: z.string().max(500).optional(),
  api_key: z.string().trim().max(500).optional(),
  from_email: z.email(),
  from_name: z.string().trim().max(120).nullable().optional(),
  current_password: currentPassword,
});

email.put("/email", ...requireEmailAdmin, async (c) => {
  const body = await readJson(c, connectSchema);
  const who = await confirmPassword(c, body.current_password, "mailbox", 10);
  const preset = mailPreset(body.preset)!;
  const saved = await loadMailbox(c.env, c.var.companyId).catch(() => null);
  const company = must(await c.var.db.from("companies").select("name, email, settings").eq("id", c.var.companyId).maybeSingle());
  const me = must(await c.var.db.from("profiles").select("email").eq("user_id", c.var.userId).maybeSingle());

  let settings: MailboxSettings;
  let secret: MailboxSecret;
  if (preset.kind === "resend") {
    const apiKey = body.api_key || (saved?.settings.kind === "resend" ? saved.secret.api_key : undefined);
    if (!apiKey) throw new HttpError(400, "Paste your Resend API key.");
    settings = { preset: preset.id, kind: "resend", from_email: body.from_email.toLowerCase(), from_name: body.from_name || null };
    secret = { api_key: apiKey };
  } else {
    const host = body.host || preset.host;
    const port = body.port || preset.port;
    const security = body.security || preset.security || "tls";
    if (!host || !port) throw new HttpError(400, "Add the mail server and port.");
    const username = (body.username || body.from_email).trim();
    // Google shows app passwords in groups of four; the spaces aren't part of it.
    const typed = preset.id === "gmail" || preset.id === "google_workspace" ? body.password?.replace(/\s+/g, "") : body.password;
    const password = typed || (saved?.settings.kind === "smtp" && saved.settings.username === username && saved.settings.host === host ? saved.secret.password : undefined);
    if (!password) throw new HttpError(400, `Paste the ${preset.passwordLabel.toLowerCase()}.`);
    settings = { preset: preset.id, kind: "smtp", host, port, security, username, from_email: body.from_email.toLowerCase(), from_name: body.from_name || null };
    secret = { password };
    // Sign in first: a wrong password should say so plainly, before anything is saved.
    try {
      await smtpSend({ host, port, security, username, password }, null);
    } catch (error) {
      const message = error instanceof SmtpError ? error.message : "Couldn't sign in to the mail server.";
      throw new HttpError(400, c.env.RAILWAY_PROJECT_ID && /^Couldn't connect/.test(message) ? message + RAILWAY_SMTP : message);
    }
  }

  // Then a real test email to the person setting it up, which proves the whole path works.
  const to = me.email;
  if (to) {
    const result = await sendWithMailbox(settings, secret, {
      to,
      subject: `Email is connected for ${company.name}`,
      ...renderEmail({ companyName: company.name, logo: logoImage(appUrl(c), c.var.companyId, company.settings), text: `This is a test from Crewtavo.\n\nQuotes, invoices, reminders and team notifications for ${company.name} will now be sent from ${settings.from_email}. Replies go to ${company.email || settings.from_email}.` }),
      replyTo: company.email ?? undefined,
      fromName: company.name,
    });
    if (!result.sent) throw new HttpError(400, result.reason ?? "The test email wasn't sent.");
  }

  const admin = adminClient(c.env);
  const { error } = await admin.from("integrations").upsert({
    company_id: c.var.companyId,
    provider: "email",
    status: "connected",
    account_label: settings.from_email,
    settings: settings as never,
    connected_by: c.var.userId,
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  if (error) throw dbError(error);
  const { error: secretError } = await admin
    .from("integration_secrets")
    .upsert({ company_id: c.var.companyId, provider: "email", ciphertext: await encryptJson(c.env, secret), updated_at: new Date().toISOString() });
  if (secretError) throw dbError(secretError);
  forgetMailbox(c.var.companyId);
  const was = saved?.settings.from_email;
  if (!was) noteMailboxChange(c, who, "email.connected", `connected the company's email (${settings.from_email})`, "The company's email was connected");
  else noteMailboxChange(c, who, "email.changed", `changed the company's email (${was === settings.from_email ? was : `${settings.from_email}, was ${was}`})`, "The company's email was changed");
  return c.json({ connected: true, test_sent_to: to ?? null });
});

email.post("/email/test", ...requireEmailAdmin, async (c) => {
  const body = await readJson(c, z.object({ to: z.email().optional() }));
  const me = must(await c.var.db.from("profiles").select("email").eq("user_id", c.var.userId).maybeSingle());
  const company = must(await c.var.db.from("companies").select("name, email, settings").eq("id", c.var.companyId).maybeSingle());
  const to = body.to ?? me.email;
  if (!to) throw new HttpError(400, "Add an address to send the test to.");
  forgetMailbox(c.var.companyId);
  const result = await sendEmail(
    c.env,
    { to, subject: `Test email from ${company.name}`, ...renderEmail({ companyName: company.name, logo: logoImage(appUrl(c), c.var.companyId, company.settings), text: "This is a test from Crewtavo. If you can read it, email is working." }), replyTo: company.email ?? undefined, fromName: company.name },
    c.var.companyId,
  );
  if (!result.sent) throw new HttpError(400, result.reason ?? "The test email wasn't sent.");
  return c.json({ sent: true, to });
});

email.delete("/email", ...requireEmailAdmin, async (c) => {
  const who = await confirmPassword(c, (await readJson(c, z.object({ current_password: currentPassword }))).current_password, "mailbox", 10);
  const { data: removed, error } = await adminClient(c.env).from("integrations").delete().eq("company_id", c.var.companyId).eq("provider", "email").select("account_label");
  if (error) throw dbError(error);
  forgetMailbox(c.var.companyId);
  if (removed?.length) noteMailboxChange(c, who, "email.disconnected", `disconnected the company's email (${removed[0]!.account_label ?? "a mailbox"})`, "The company's email was disconnected");
  return c.json({ connected: false, fallback: emailConfigured(c.env) });
});
