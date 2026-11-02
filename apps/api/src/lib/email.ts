import { greetingName } from "@crewtavo/core";
import { LINK_PATTERN } from "@crewtavo/core/campaigns";
/**
 * Plain-text messages rendered as a simple, readable HTML email: paragraphs, clickable links,
 * the company's logo or name, and (for marketing) the address and an unsubscribe link. A campaign
 * email's links can go through tracked links (`href`) and it can carry a tracking image (`pixel`):
 * the text and button labels stay the links as written, and the unsubscribe link is never tracked.
 */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const asIs = (url: string) => url;

function linkify(text: string, href: (url: string) => string): string {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const url = match[0];
    html += `${escape(text.slice(last, match.index))}<a href="${escape(href(url))}" style="color:#2c611a;font-weight:600;word-break:break-all">${escape(url)}</a>`;
    last = match.index + url.length;
  }
  return html + escape(text.slice(last));
}

/** A link on its own line becomes a button; the label depends on where it goes. */
function buttonLabel(url: string): string {
  if (url.includes("/hub/")) return "View online";
  if (url.includes("/refer/")) return "Request a quote";
  if (url.includes("/api/public/r/")) return "Leave a review";
  // A website form's message, to the office (services/websiteForms.ts).
  if (/\/requests\/[0-9a-f-]{36}$/.test(url)) return "Open the request";
  // A careers form's application, to the office (services/careers.ts).
  if (/\/applicants\/[0-9a-f-]{36}$/.test(url)) return "Open the application";
  return "Open";
}

function paragraph(p: string, code: string | null | undefined, href: (url: string) => string, buttons: Record<string, string> | undefined, shown: readonly string[] | undefined): string {
  const trimmed = p.trim();
  if (code && trimmed === code) {
    return `<p style="margin:0 0 20px;font-size:32px;font-weight:800;letter-spacing:0.2em;font-variant-numeric:tabular-nums">${escape(code)}</p>`;
  }
  if (/^https?:\/\/\S+$/.test(trimmed)) {
    const url = escape(href(trimmed));
    const button = `<p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#3b7d23;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">${escape(buttons?.[trimmed] ?? buttonLabel(trimmed))}</a></p>`;
    // A link the client is meant to pass on (their referral link) is written out under it, to copy.
    return shown?.includes(trimmed) ? `${button}<p style="margin:-8px 0 20px;font-size:13px">${linkify(trimmed, href)}</p>` : button;
  }
  return `<p style="margin:0 0 16px">${linkify(p, href).replace(/\n/g, "<br>")}</p>`;
}

export interface EmailParts {
  companyName: string;
  /** The company's logo (services/logo.ts logoImage), shown in place of its name. */
  logo?: { src: string; width: number; height: number } | null;
  text: string;
  /** Shown under the message, e.g. the company's postal address (required for marketing email). */
  footer?: string | null;
  unsubscribeUrl?: string | null;
  /** A one-time code (signing in by email): the paragraph that is just this code is shown large. */
  code?: string | null;
  /** Where each link in the text goes (a campaign's tracked link); shown as written. */
  href?: (url: string) => string;
  /** A campaign email's tracking image, after the footer. */
  pixel?: string | null;
  /** A button's label for a link on its own line, by the link as written, where its address can't say (a Client Hub home). */
  buttons?: Record<string, string>;
  /** Links on their own line written out under their button too, so they can be copied (a client's own referral link). */
  showUrls?: readonly string[];
}

export function renderEmail({ companyName, logo, text, footer, unsubscribeUrl, code, href = asIs, pixel, buttons, showUrls }: EmailParts): { html: string; text: string } {
  const paragraphs = text.trim().split(/\n{2,}/).map((p) => paragraph(p, code, href, buttons, showUrls)).join("");
  const foot = [footer ? escape(footer) : null, unsubscribeUrl ? `<a href="${escape(unsubscribeUrl)}" style="color:#5f6f76">Unsubscribe</a>` : null].filter(Boolean).join(" · ");
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f6f5f1;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f2a35">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e3e2dd">
<tr><td style="padding:20px 24px 0;font-weight:800;font-size:17px">${logo ? `<img src="${escape(logo.src)}" width="${logo.width}" height="${logo.height}" alt="${escape(companyName)}" style="display:block;border:0;width:${logo.width}px;height:${logo.height}px">` : escape(companyName)}</td></tr>
<tr><td style="padding:16px 24px 8px;font-size:15px;line-height:1.6">${paragraphs}</td></tr>
</table>
${foot ? `<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#5f6f76;text-align:center">${foot}</p>` : ""}
${pixel ? `<img src="${escape(pixel)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : ""}
</td></tr></table></body></html>`;
  const plain = [text.trim().replace(LINK_PATTERN, (url) => href(url)), footer, unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : null].filter(Boolean).join("\n\n");
  return { html, text: plain };
}

/** "Jane Smith" -> "Jane". Businesses and longer names ("Town of Rocky Mount") stay whole. */
export const firstName = greetingName;

export const isEmail = (value: string | null | undefined) => Boolean(value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()));

/** A company's postal address on one line: "1 Main St, Radford, VA, 24141". */
export function companyAddress(address: Record<string, string | undefined> | null | undefined): string {
  if (!address) return "";
  return [address.line1, address.line2, [address.city, address.region].filter(Boolean).join(", "), address.postal_code].filter(Boolean).join(", ");
}

/** Under an email: the company's name and postal address, which every marketing email carries. */
export function companyFooter(company: { name: string; address?: unknown }) {
  return [company.name, companyAddress(company.address as Record<string, string | undefined> | null | undefined)].filter(Boolean).join(" · ");
}
