/** Signed, expiring links for clients (and subcontractors) that work without an account. */
import type { Env } from "../env";
import { signToken, verifyToken } from "./crypto";

/**
 * quote / invoice: the Client Hub page for that document.
 * client: the client's Hub home (upcoming visits, quotes, invoices, request work).
 * unsub: marketing unsubscribe.  review: tracked review link.  refer: a client's referral page.
 * sub: a subcontractor's page for sending in their paperwork (routes/subs.ts), without signing in.
 */
export type LinkKind = "quote" | "invoice" | "client" | "unsub" | "review" | "refer" | "sub";

export interface ClientLink {
  c: string; // company id
  t: LinkKind;
  id: string; // record id (client id for client/unsub/refer, review request id for review, subcontractor id for sub)
  exp: number; // seconds since epoch
  pv?: 1; // office preview: may show drafts
  // "office": a copy of the client's Hub link the office made (Copy Client Hub link), every link a
  // signed-in person is handed (a send's Copy link, the copy kept on the client's timeline, a send
  // typed to an address that isn't the client's; clientLinks), and every link minted from one. It
  // works as the client's own link, except that it can't say yes to a card it didn't save itself or
  // add a tip to a saved card. Missing means the client's own link (and see `own`).
  via?: "office";
  // 1: the client's own link, sent to their own email or phone (clientLinks' `own`, the autopay
  // invite, receipts and notices, an automation's email or text to them), and every link minted from
  // one. Only a link with it can say yes to a card it didn't save or tip on a saved card: one
  // without it (every link minted before it was added) can do all else the client's own can.
  own?: 1;
}

const PATHS: Record<LinkKind, string> = {
  quote: "/hub/",
  invoice: "/hub/",
  client: "/hub/",
  unsub: "/u/",
  review: "/api/public/r/",
  refer: "/refer/",
  sub: "/paperwork/",
};

const LIFETIME_DAYS: Record<LinkKind, number> = { quote: 60, invoice: 90, client: 120, unsub: 3650, review: 365, refer: 3650, sub: 30 };
export const linkLifetimeDays = (kind: LinkKind) => LIFETIME_DAYS[kind];

export async function clientLink(env: Env, baseUrl: string, link: Omit<ClientLink, "exp">, days?: number): Promise<string> {
  const lifetime = days ?? LIFETIME_DAYS[link.t];
  const token = await signToken(env, { ...link, exp: Math.floor(Date.now() / 1000) + lifetime * 86_400 });
  return `${baseUrl.replace(/\/$/, "")}${PATHS[link.t]}${token}`;
}

/**
 * One client link minted twice: `own`, the client's own (own: 1), only for the email or text that
 * goes out to their own email or phone (sentToClient); and `office`, the office's copy (via
 * "office"), for anything a signed-in person gets: what a send hands back to copy, the copy kept on
 * the client's timeline, and a send to any other address. So no one on the team holds a link that
 * can say yes to autopay or tip on the client's saved card for them.
 */
export async function clientLinks(env: Env, baseUrl: string, link: Omit<ClientLink, "exp" | "via" | "own">, days?: number): Promise<{ own: string; office: string }> {
  const [own, office] = await Promise.all([clientLink(env, baseUrl, { ...link, own: 1 }, days), clientLink(env, baseUrl, { ...link, via: "office" }, days)]);
  return { own, office };
}

/** An email's address for comparing: trimmed, in lower case. */
const emailKey = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/** A phone number's digits for comparing, without the leading country code 1 of a US or Canadian number. */
const phoneKey = (value: string | null | undefined) => {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
};

/**
 * Whether a send goes to the client's own contact on file, so it can carry their own link: an email
 * to their email (any case, spaces aside), or a text to their phone (the same digits, with or
 * without the leading 1). A send typed to any other address gets the office's copy.
 */
export function sentToClient(channel: "email" | "sms", to: string | null | undefined, client: { email: string | null; phone: string | null } | null | undefined): boolean {
  if (!client) return false;
  const [sent, onFile] = channel === "email" ? [emailKey(to), emailKey(client.email)] : [phoneKey(to), phoneKey(client.phone)];
  return Boolean(onFile) && sent === onFile;
}

export const readClientLink = (env: Env, token: string) => verifyToken<ClientLink>(env, token);

/** A review ask's short link token (review_requests.link_token): 12 letters and digits. */
export const REVIEW_TOKEN = /^[0-9A-Za-z]{12}$/;

/** A review ask's short link, in the ask and its reminders: about 50 characters, where a signed one is about 265. */
export const reviewLink = (baseUrl: string, token: string) => `${baseUrl.replace(/\/$/, "")}${PATHS.review}${token}`;

/**
 * A request from a link preview or crawler, not a person opening the link: a text's or chat app's
 * preview (iMessage sends "facebookexternalhit/1.1 Facebot Twitterbot/1.0"), Slack, WhatsApp and
 * the like. A tracked link still answers it, but doesn't count it as an open.
 */
export function linkPreview(userAgent: string | null | undefined): boolean {
  return /facebookexternalhit|facebot|twitterbot|slackbot|whatsapp|telegrambot|discordbot|linkedinbot|skypeuripreview|bot\b|crawler|spider|preview/i.test(userAgent ?? "");
}
