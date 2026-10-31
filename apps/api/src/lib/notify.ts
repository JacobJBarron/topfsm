/**
 * Email and SMS. Email goes out through, in order:
 *   1. the company's own connected mailbox (Settings → Email): Gmail, Zoho, Microsoft 365... over
 *      SMTP with an app password, or the company's Resend key;
 *   2. the server's Resend account (RESEND_API_KEY, EMAIL_FROM), if whoever installed it set one;
 *   3. in development, the local Mailpit inbox (MAILPIT_URL).
 * SMS uses Twilio over REST. When nothing is set up, sends are skipped and the caller gets
 * { sent: false } plus the reason; the UI can then offer the link to copy instead.
 */
import { isPersonalMailDomain, isPlaceholderEmail } from "@crewtavo/core/email";
import type { Env } from "../env";
import { decryptJson } from "./crypto";
import { reportError } from "./monitoring";
import { smtpSend, SmtpError, type SmtpSettings } from "./smtp";
import { adminClient } from "./supabase";

export interface SendResult {
  sent: boolean;
  id?: string;
  reason?: string;
  /** The provider's HTTP status when it turned the email down: 401/403 is the key, 429 a limit. */
  status?: number;
  /** Twilio's error code when it refused a text: 21610 is a number that texted STOP. */
  code?: number;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Display name for the sender, usually the company name. */
  fromName?: string;
}

/** Non-secret mailbox settings, stored in integrations.settings (provider "email"). */
export interface MailboxSettings {
  preset: string;
  kind: "smtp" | "resend";
  host?: string;
  port?: number;
  security?: "tls" | "starttls";
  username?: string;
  from_email: string;
  from_name?: string | null;
}
/** Secret part, AES-encrypted in integration_secrets. */
export interface MailboxSecret {
  password?: string;
  api_key?: string;
}

type Mailbox = { settings: MailboxSettings; secret: MailboxSecret; status: string };

const cache = new Map<string, { at: number; value: Mailbox | null }>();
const CACHE_MS = 60_000;
/** A provider that doesn't answer in time counts as unreachable, so the send is recorded as failed. */
const TIMEOUT_MS = 15_000;

/** The company's connected mailbox, if any (cached for a minute; campaigns send many at once). */
export async function loadMailbox(env: Env, companyId: string): Promise<Mailbox | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const admin = adminClient(env);
  const [row, secret] = await Promise.all([
    admin.from("integrations").select("status, settings").eq("company_id", companyId).eq("provider", "email").maybeSingle(),
    admin.from("integration_secrets").select("ciphertext").eq("company_id", companyId).eq("provider", "email").maybeSingle(),
  ]);
  let value: Mailbox | null = null;
  if (row.data && row.data.status !== "disconnected" && secret.data) {
    try {
      value = { settings: row.data.settings as unknown as MailboxSettings, secret: await decryptJson<MailboxSecret>(env, secret.data.ciphertext), status: row.data.status };
    } catch (error) {
      reportError(error, { feature: "mailbox" });
    }
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

/** Whether any company has a mailbox (anyMailbox), cached alongside. */
let someMailbox: { at: number; value: boolean } | null = null;

export const forgetMailbox = (companyId: string) => {
  cache.delete(companyId);
  someMailbox = null;
};

/**
 * Whether any company here sends email from its own mailbox (cached for a minute), for what the
 * sign-in page offers before anyone is known (GET /api/config). Null when it can't be told.
 */
export async function anyMailbox(env: Env): Promise<boolean | null> {
  if (someMailbox && Date.now() - someMailbox.at < CACHE_MS) return someMailbox.value;
  const { data, error } = await adminClient(env).from("integrations").select("company_id").eq("provider", "email").neq("status", "disconnected").limit(1);
  if (error) {
    reportError(new Error(`Couldn't tell whether any company has a mailbox: ${error.message}`), { feature: "mailbox" });
    return null;
  }
  someMailbox = { at: Date.now(), value: Boolean(data?.length) };
  return someMailbox.value;
}

/** Is there a server-wide way to send (Resend for the whole install, or Mailpit in development)? */
export const emailConfigured = (env: Env) => Boolean((env.RESEND_API_KEY && env.EMAIL_FROM) || env.MAILPIT_URL);
export const smsConfigured = (env: Env) => Boolean((env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER) || env.MAILPIT_URL);

/** Can this company send email (its own mailbox, or the server's)? */
export async function emailReady(env: Env, companyId?: string | null): Promise<boolean> {
  if (companyId && (await loadMailbox(env, companyId).catch(() => null))) return true;
  return emailConfigured(env);
}

/** `"Name" <email>`: quoted, so a comma in the name ("Acme Lawn Care, LLC") doesn't split it in two. */
export function fromAddress(name: string | null | undefined, email: string): string {
  const clean = (name ?? "").replace(/[\r\n<>]+/g, " ").trim();
  return clean ? `"${clean.replace(/[\\"]/g, "\\$&")}" <${email}>` : email;
}

const smtpOf = (settings: MailboxSettings, secret: MailboxSecret): SmtpSettings => ({
  host: settings.host!, port: settings.port!, security: settings.security ?? "tls", username: settings.username!, password: secret.password ?? "",
});

/** Send through a mailbox's settings (also used by Settings → Email to test before saving). */
export async function sendWithMailbox(settings: MailboxSettings, secret: MailboxSecret, message: EmailMessage): Promise<SendResult> {
  const fromName = settings.from_name || message.fromName || null;
  if (settings.kind === "resend") {
    return resendSend(secret.api_key ?? "", fromAddress(fromName, settings.from_email), message);
  }
  const smtp = smtpOf(settings, secret);
  try {
    const { id } = await smtpSend(smtp, { from: { name: fromName, email: settings.from_email }, to: message.to, subject: message.subject, text: message.text, html: message.html, replyTo: message.replyTo, headers: message.headers });
    return { sent: true, id };
  } catch (error) {
    if (error instanceof SmtpError) return { sent: false, reason: error.message };
    throw error;
  }
}

/**
 * Does the company's mailbox still sign in? Checked without sending, as Settings → Email does before
 * saving. A Resend key can't be checked without sending, so it passes. A refused sign-in shows in Settings.
 */
export async function checkMailbox(env: Env, companyId: string, mailbox: Mailbox): Promise<boolean> {
  if (mailbox.settings.kind !== "smtp") return true;
  let result: SendResult = { sent: true };
  try {
    await smtpSend(smtpOf(mailbox.settings, mailbox.secret), null);
  } catch (error) {
    if (!(error instanceof SmtpError)) throw error;
    result = { sent: false, reason: error.message };
  }
  await noteMailboxHealth(env, companyId, mailbox, result);
  return result.sent;
}

export async function sendEmail(env: Env, message: EmailMessage, companyId?: string | null): Promise<SendResult> {
  // A sub's stand-in address (a sign-in without an email of their own) never gets anything.
  if (isPlaceholderEmail(message.to)) return { sent: false, reason: "They have no email address. Text them instead." };
  if (companyId) {
    const mailbox = await loadMailbox(env, companyId).catch(() => null);
    if (mailbox) {
      const result = await sendWithMailbox(mailbox.settings, mailbox.secret, message);
      await noteMailboxHealth(env, companyId, mailbox, result);
      return result;
    }
  }
  if ((!env.RESEND_API_KEY || !env.EMAIL_FROM) && env.MAILPIT_URL) return mailpit(env, { ...message, from: env.EMAIL_FROM });
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { sent: false, reason: "Email isn't set up yet. An admin can connect the company's email in Settings → Email." };
  return resendSend(env.RESEND_API_KEY, env.EMAIL_FROM, message);
}

/**
 * Show a broken mailbox (changed password, revoked app password, a Resend key that's revoked or not
 * allowed to send) in Settings, and clear it once it works again.
 */
async function noteMailboxHealth(env: Env, companyId: string, mailbox: Mailbox, result: SendResult) {
  const failedSignIn = !result.sent && (result.status === 401 || result.status === 403 || /password|sign-in|didn't accept|turned off/i.test(result.reason ?? ""));
  const next = result.sent ? "connected" : failedSignIn ? "error" : mailbox.status;
  if (next === mailbox.status) return;
  mailbox.status = next;
  await adminClient(env)
    .from("integrations")
    .update({ status: next, last_error: result.sent ? null : (result.reason ?? "").slice(0, 500) })
    .eq("company_id", companyId)
    .eq("provider", "email");
}

async function resendSend(apiKey: string, from: string, message: EmailMessage): Promise<SendResult> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      reply_to: message.replyTo,
      headers: message.headers,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!response) return { sent: false, reason: "Couldn't reach Resend. Try again." };
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string };
    return { sent: false, status: response.status, reason: resendProblem(response.status, detail.message ?? "") };
  }
  const body = (await response.json().catch(() => ({}))) as { id?: string };
  return { sent: true, id: body.id };
}

/**
 * Resend's refusals in words the person setting up email can act on. These show in Settings → Email
 * and wherever a send fails; anything not listed keeps Resend's own message.
 */
export function resendProblem(status: number, message: string): string {
  const keyDomain = message.match(/not authorized to send emails from ([a-z0-9.-]+[a-z0-9])/i)?.[1];
  if (keyDomain) {
    return `This Resend API key can only send from a different domain, not ${keyDomain}. In Resend, create a new API key with Sending access for all domains (or for ${keyDomain}) and use it instead, or send from an address on the domain the key is for.`;
  }
  const unverified = message.match(/the\s+`?([a-z0-9.-]+[a-z0-9])`?\s+domain is not verified/i)?.[1];
  if (unverified && isPersonalMailDomain(unverified)) {
    return `Resend can't send from a ${unverified} address. Send from an address on your own domain (the one you added in Resend), like office@yourcompany.com.`;
  }
  if (unverified) {
    return `${unverified} isn't verified in Resend yet. In Resend, open Domains, check every DNS record for it is added, and wait until it shows Verified (usually within 15 minutes). Or send from an address on a domain that's already verified.`;
  }
  if (/only send testing emails to your own email/i.test(message)) {
    return "This Resend account has no verified domain yet, so it only sends tests to its owner. Add your domain under Domains in Resend, wait until it shows Verified, and send from an address on it.";
  }
  if (/suspended/i.test(message)) return "Resend has suspended this API key. Check the Resend account, or ask Resend's support why.";
  if (status === 401 || /api key is (invalid|not active)|missing api key/i.test(message)) {
    return "Resend didn't accept this API key. It may have been deleted, or only part of it was copied. Create a new one under API keys in Resend and paste the whole key (it starts with re_).";
  }
  if (/daily .*quota/i.test(message)) {
    return "This Resend account has reached its daily sending limit (100 emails on the free plan). Sending starts again after midnight UTC, or upgrade the Resend plan to send more.";
  }
  if (/monthly .*quota/i.test(message)) {
    return "This Resend account has reached its monthly sending limit (3,000 emails on the free plan). Upgrade the Resend plan to keep sending this month.";
  }
  // A bounced address, not Resend's: said so, not in Resend's own words (an ask to a client's typo).
  if (status === 422 && /`to`|\bto\b field/i.test(message)) return "That email address isn't valid, so Resend didn't send it.";
  if (status === 429) return "Resend got too many emails at once. Try again in a minute.";
  if (status >= 500) return "Resend is having trouble right now. Try again in a few minutes.";
  return `Resend refused it (${status}${message ? `: ${message}` : ""}).`;
}

/** Development transport: Mailpit's HTTP send API. */
async function mailpit(env: Env, message: EmailMessage & { from?: string }): Promise<SendResult> {
  const fromMatch = (message.from || `${message.fromName ?? "Crewtavo"} <noreply@crewtavo.local>`).match(/^(.*)<(.+)>$/);
  const response = await fetch(`${env.MAILPIT_URL!.replace(/\/$/, "")}/api/v1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      From: fromMatch ? { Name: fromMatch[1].trim(), Email: fromMatch[2].trim() } : { Email: message.from || "noreply@crewtavo.local" },
      To: [{ Email: message.to }],
      Subject: message.subject,
      Text: message.text,
      HTML: message.html,
      ReplyTo: message.replyTo ? [{ Email: message.replyTo }] : undefined,
      Headers: message.headers,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return { sent: false, reason: "Couldn't reach the local Mailpit inbox." };
  const body = (await response.json().catch(() => ({}))) as { ID?: string };
  return { sent: true, id: body.ID };
}

export async function sendSms(env: Env, message: { to: string; body: string }): Promise<SendResult> {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = env;
  if ((!sid || !token || !from) && env.MAILPIT_URL) {
    const digits = message.to.replace(/[^0-9]/g, "") || "unknown";
    return mailpit(env, { to: `sms-${digits}@sms.local`, subject: `Text to ${message.to}`, text: message.body });
  }
  if (!sid || !token || !from) return { sent: false, reason: "Texting isn't set up on this Crewtavo yet." };
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: message.to, From: from, Body: message.body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!response) return { sent: false, reason: "Couldn't reach the text provider. Try again." };
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string; code?: number };
    return {
      sent: false,
      reason: `The text provider refused it (${response.status}${detail.message ? `: ${detail.message}` : ""}).`,
      ...(typeof detail.code === "number" ? { code: detail.code } : {}),
    };
  }
  const body = (await response.json().catch(() => ({}))) as { sid?: string };
  return { sent: true, id: body.sid };
}
