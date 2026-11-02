import { greetingName } from "@crewtavo/core";
/**
 * Plain-text messages rendered as a simple, readable HTML email: paragraphs, clickable links,
 * the company's logo or name, and (for marketing) the address and an unsubscribe link.
 */

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function linkify(text: string): string {
  return escape(text).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)"']/g, (url) => `<a href="${url}" style="color:#2c611a;font-weight:600;word-break:break-all">${url}</a>`);
}

/** A link on its own line becomes a button; the label depends on where it goes. */
function buttonLabel(url: string): string {
  // Autopay's receipt and notices (services/autopay.ts): the invoice's tip, and the client's autopay page.
  if (/[?&]tip=1\b/.test(url)) return "Add a tip";
  if (/[?&]view=autopay\b/.test(url)) return "Manage autopay";
  if (url.includes("/hub/")) return "View online";
  if (url.includes("/refer/")) return "Request a quote";
  if (url.includes("/api/public/r/")) return "Leave a review";
  // A website form's message, to the office (services/websiteForms.ts).
  if (/\/requests\/[0-9a-f-]{36}$/.test(url)) return "Open the request";
  // A careers form's application, to the office (services/careers.ts).
  if (/\/applicants\/[0-9a-f-]{36}$/.test(url)) return "Open the application";
  return "Open";
}

function paragraph(p: string, code?: string | null, button?: string | null): string {
  const trimmed = p.trim();
  if (code && trimmed === code) {
    return `<p style="margin:0 0 20px;font-size:32px;font-weight:800;letter-spacing:0.2em;font-variant-numeric:tabular-nums">${escape(code)}</p>`;
  }
  if (/^https?:\/\/\S+$/.test(trimmed)) {
    const url = escape(trimmed);
    return `<p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#3b7d23;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">${escape(button ?? buttonLabel(trimmed))}</a></p>`;
  }
  return `<p style="margin:0 0 16px">${linkify(p).replace(/\n/g, "<br>")}</p>`;
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
  /** The label for the message's link buttons, in place of the one the link's address picks (an autopay invite's "Save your card"). */
  button?: string | null;
}

export function renderEmail({ companyName, logo, text, footer, unsubscribeUrl, code, button }: EmailParts): { html: string; text: string } {
  const paragraphs = text.trim().split(/\n{2,}/).map((p) => paragraph(p, code, button)).join("");
  const foot = [footer ? escape(footer) : null, unsubscribeUrl ? `<a href="${escape(unsubscribeUrl)}" style="color:#5f6f76">Unsubscribe</a>` : null].filter(Boolean).join(" · ");
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f6f5f1;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f2a35">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e3e2dd">
<tr><td style="padding:20px 24px 0;font-weight:800;font-size:17px">${logo ? `<img src="${escape(logo.src)}" width="${logo.width}" height="${logo.height}" alt="${escape(companyName)}" style="display:block;border:0;width:${logo.width}px;height:${logo.height}px">` : escape(companyName)}</td></tr>
<tr><td style="padding:16px 24px 8px;font-size:15px;line-height:1.6">${paragraphs}</td></tr>
</table>
${foot ? `<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#5f6f76;text-align:center">${foot}</p>` : ""}
</td></tr></table></body></html>`;
  const plain = [text.trim(), footer, unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : null].filter(Boolean).join("\n\n");
  return { html, text: plain };
}

/** "Jane Smith" -> "Jane". Businesses and longer names ("Town of Rocky Mount") stay whole. */
export const firstName = greetingName;

export const isEmail = (value: string | null | undefined) => Boolean(value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()));
