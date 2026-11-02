/**
 * Messaging: send an email or text to a client from the message center, and receive replies to
 * texts (Twilio webhook). Every message is recorded on the client's timeline. A client who texts
 * STOP has texts off (clients.sms_opt_out_at) until they text START, and Crewtavo doesn't text them.
 */
import { SALES } from "@crewtavo/core";
import { smsKeyword } from "@crewtavo/core/marketing";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { addressHistory } from "../lib/address";
import { kickAutomations } from "../lib/background";
import { requireCompany, requireUser } from "../lib/auth";
import { safeEqual } from "../lib/crypto";
import { isEmail, renderEmail } from "../lib/email";
import { appUrl, dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { sendEmail, sendSms } from "../lib/notify";
import { adminClient } from "../lib/supabase";
import { companyAddress } from "../services/automations";
import { logoImage } from "../services/logo";
import { noteRefusedText, phoneKey, textsOffRefusal, textsOffTo } from "../services/textsOff";

export const messages = new Hono<AppEnv>();

messages.post("/messages/send", requireUser, requireCompany(SALES), async (c) => {
  const body = await readJson(
    c,
    z.object({
      client_id: uuid,
      channel: z.enum(["email", "sms"]),
      to: z.string().trim().max(200).optional(),
      subject: z.string().trim().max(200).optional(),
      body: z.string().trim().min(1).max(10_000),
    }),
  );
  const { db, companyId } = c.var;
  const client = must(await db.from("clients").select("id, display_name, email, phone, sms_opt_out_at").eq("id", body.client_id).eq("company_id", companyId).maybeSingle(), "Client not found.");
  const company = must(await db.from("companies").select("name, email, phone, address, settings").eq("id", companyId).maybeSingle());
  let result: { sent: boolean; id?: string; reason?: string };
  let to: string;
  if (body.channel === "email") {
    to = body.to || client.email || "";
    if (!isEmail(to)) throw new HttpError(400, `${client.display_name} has no valid email address.`);
    if (!body.subject) throw new HttpError(400, "Add a subject.");
    const footer = [company.name, companyAddress(company.address as Record<string, string>), company.phone].filter(Boolean).join(" · ");
    result = await sendEmail(c.env, { to, subject: body.subject, ...renderEmail({ companyName: company.name, logo: logoImage(appUrl(c), companyId, company.settings), text: body.body, footer }), replyTo: company.email ?? undefined, fromName: company.name }, companyId);
  } else {
    to = body.to || client.phone || "";
    if (!to) throw new HttpError(400, `${client.display_name} has no phone number.`);
    // Their own phone, after they texted STOP. Another number (a spouse's, say) is the office's to text.
    if (textsOffTo(client, to)) throw new HttpError(400, textsOffRefusal(client.display_name));
    if (body.body.length > 1600) throw new HttpError(400, "Texts are limited to 1,600 characters.");
    result = await sendSms(c.env, { to, body: body.body });
    await noteRefusedText(adminClient(c.env), client, to, result);
  }
  const { data: row, error } = await db
    .from("messages")
    .insert({
      company_id: companyId, client_id: client.id, channel: body.channel, direction: "out", subject: body.channel === "email" ? body.subject : null,
      body: body.body, status: result.sent ? "sent" : "failed", external_id: result.id ?? null,
    })
    .select("id")
    .single();
  if (error) throw dbError(error);
  if (!result.sent) throw new HttpError(502, `${result.reason ?? "It wasn't sent."} The message was saved as failed on the client's timeline.`);
  return c.json({ id: row.id, sent: true, to });
});

/** Twilio's request signature: base64(HMAC-SHA1(auth token, URL + sorted form params)). */
export async function twilioSignature(token: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac));
}

/** Incoming texts (set this URL as the Twilio number's messaging webhook). */
messages.post("/webhooks/twilio", async (c) => {
  const token = c.env.TWILIO_AUTH_TOKEN;
  if (!token) throw new HttpError(501, "Texting isn't configured.");
  const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
  // Twilio signs the exact address it posts to: APP_URL, or one this instance had before a switch.
  const signature = c.req.header("x-twilio-signature") ?? "";
  const signedFor = async (base: string) => safeEqual(await twilioSignature(token, `${base}/api/webhooks/twilio`, form), signature);
  let signed = await signedFor(appUrl(c));
  for (const base of signed ? [] : (await addressHistory(c.env)).origins) if (await signedFor(base)) signed = true;
  if (!signed) throw new HttpError(403, "Bad signature.");

  const from = phoneKey(form.From);
  const body = (form.Body ?? "").slice(0, 10_000);
  if (!from || !body) return c.text("<Response/>", 200, { "Content-Type": "text/xml" });
  // STOP or START: what Twilio itself acted on when it says (Advanced Opt-Out), else the words.
  const optOut = (form.OptOutType ?? "").toUpperCase();
  const keyword = optOut === "STOP" ? "stop" : optOut === "START" ? "start" : optOut ? null : smsKeyword(body);
  const admin = adminClient(c.env);
  // Match the sender to clients by phone number (last 10 digits), across companies using this number.
  const { data: candidates } = await admin.from("clients").select("id, company_id, phone, display_name").not("phone", "is", null).ilike("phone", `%${from.slice(-4)}%`).limit(50);
  const matches = (candidates ?? []).filter((cl) => phoneKey(cl.phone) === from);
  for (const client of matches) {
    await admin.from("messages").insert({
      company_id: client.company_id, client_id: client.id, channel: "sms", direction: "in", status: "received",
      body, external_id: form.MessageSid ?? null, sent_by: null,
    });
    // Texts off from now, or back on: only a change is news (a YES that's an ordinary reply isn't).
    let changed = false;
    if (keyword === "stop") {
      const { data } = await admin.from("clients").update({ sms_opt_out_at: new Date().toISOString() }).eq("id", client.id).is("sms_opt_out_at", null).select("id");
      changed = Boolean(data?.length);
    } else if (keyword === "start") {
      const { data } = await admin.from("clients").update({ sms_opt_out_at: null }).eq("id", client.id).not("sms_opt_out_at", "is", null).select("id");
      changed = Boolean(data?.length);
    }
    const notice = changed && keyword === "stop"
      ? { title: `${client.display_name} turned off texts`, body: "They texted STOP. Crewtavo won't text them until they text START." }
      : changed
        ? { title: `${client.display_name} turned texts back on`, body: `They texted ${body.trim().slice(0, 20).toUpperCase()}, so Crewtavo can text them again.` }
        : { title: "New text from a client", body: body.slice(0, 200) };
    const { data: office } = await admin.from("memberships").select("user_id").eq("company_id", client.company_id).eq("active", true).in("role", ["owner", "admin", "office"]);
    if (office?.length) {
      await admin.from("notifications").insert(office.map((m) => ({ company_id: client.company_id, user_id: m.user_id, kind: "client", title: notice.title.slice(0, 300), body: notice.body, link: `/messages?client=${client.id}` })));
    }
    kickAutomations(c, client.company_id);
  }
  return c.text("<Response/>", 200, { "Content-Type": "text/xml" });
});
