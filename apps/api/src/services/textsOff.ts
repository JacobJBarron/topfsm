/**
 * Texts to a client who texted STOP (clients.sms_opt_out_at, set by the Twilio webhook in
 * routes/messages.ts): Crewtavo doesn't send them. When Twilio refuses a text because the number
 * opted out (a STOP Crewtavo never saw), the client is marked too, so the office sees it.
 *
 * Both are about the client's own phone, the number the webhook matches STOPs to. A text the office
 * sends to another number (a spouse's, a contact's, one typed in) isn't refused for the client's
 * STOP, and a refusal for that number doesn't mark the client.
 */
import { textsOff, textsOffReason } from "@crewtavo/core/marketing";
import type { SendResult } from "../lib/notify";
import type { Db } from "../lib/supabase";

/** Twilio's error for a number that texted STOP. */
export const TWILIO_OPTED_OUT = 21610;

/** The last 10 digits, as the Twilio webhook matches a text to the clients it's from. */
export const phoneKey = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "").slice(-10);

/** The number texted is the client's own phone. */
export function isClientPhone(to: string | null | undefined, client: { phone?: string | null }) {
  const key = phoneKey(to);
  return key !== "" && key === phoneKey(client.phone);
}

/** A text to `to` isn't sent: it's the client's own phone, and they texted STOP. */
export const textsOffTo = (client: { phone?: string | null; sms_opt_out_at?: string | null }, to: string | null | undefined) => textsOff(client) && isClientPhone(to, client);

/** After a text to `to` that wasn't sent: Twilio said the client's own phone texted STOP, so they have texts off from now. */
export async function noteRefusedText(admin: Db, client: { id: string; phone?: string | null }, to: string, result: SendResult) {
  if (result.sent || result.code !== TWILIO_OPTED_OUT || !isClientPhone(to, client)) return;
  await admin.from("clients").update({ sms_opt_out_at: new Date().toISOString() }).eq("id", client.id).is("sms_opt_out_at", null);
}

/** Why a text to a client who texted STOP isn't sent, when someone sends it by hand. */
export const textsOffRefusal = (name: string) => `${textsOffReason(name)} Send it by email instead.`;
