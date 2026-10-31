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
