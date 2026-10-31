/**
 * An email Marketing sends a client (a review ask or its reminder, a referral ask): in the company's
 * look, from the company, with one-click unsubscribe (clients.marketing_opt_out stops every one of
 * them, as it stops campaigns) in the footer and the List-Unsubscribe headers.
 */
import type { Env } from "../env";
import { renderEmail } from "../lib/email";
import { clientLink } from "../lib/links";
import { sendEmail, type SendResult } from "../lib/notify";
import { logoImage } from "./logo";

export interface MarketingCompany {
  name: string;
  email: string | null;
  settings: unknown;
}

export async function emailClient(
  env: Env,
  d: { companyId: string; company: MarketingCompany; client: { id: string; email: string | null }; subject: string; text: string; baseUrl: string },
): Promise<SendResult> {
  const unsubscribe = await clientLink(env, d.baseUrl, { c: d.companyId, t: "unsub", id: d.client.id });
  return sendEmail(
    env,
    {
      to: d.client.email!.trim(),
      subject: d.subject,
      ...renderEmail({ companyName: d.company.name, logo: logoImage(d.baseUrl, d.companyId, d.company.settings), text: d.text, unsubscribeUrl: unsubscribe }),
      replyTo: d.company.email ?? undefined,
      fromName: d.company.name,
      headers: { "List-Unsubscribe": `<${unsubscribe.replace("/u/", "/api/public/unsubscribe/")}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    },
    d.companyId,
  );
}
