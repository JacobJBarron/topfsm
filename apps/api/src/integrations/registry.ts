/**
 * Apps shown on the Apps page and how each connects.
 *   oauth     - the company signs in to the provider; tokens are stored encrypted (integration_secrets)
 *   api_key   - the company pastes a key (or the deployment provides one in env)
 *   link      - calendars added by their ICS link (calendar_sources; see integrations/calendars.ts)
 *   connector - the app connects to us (Claude and ChatGPT via MCP at /mcp)
 *   builtin   - part of Crewtavo, turned on or off for the company (team chat: companies.settings.team_chat;
 *               website analytics: companies.settings.website_analytics, routes/analytics.ts; website
 *               forms: companies.settings.website_forms, routes/websiteForms.ts; careers:
 *               companies.settings.careers, the same routes; drive: companies.settings.drive,
 *               routes/drive.ts; marketing: companies.settings.marketing, routes/marketing.ts)
 *   site      - the company's website editor, by its address (Sveltia CMS: companies.settings.website, integrations/website.ts)
 * ABC Supply is an api_key app with two keys: its own app's Client ID and secret (integrations/abcSupply.ts).
 */
import type { Env } from "../env";

/** Apps with a row in integrations (and maybe integration_secrets). */
export type Provider = "quickbooks" | "zoho_books" | "google_calendar" | "stripe" | "twilio" | "anthropic" | "fal" | "railway" | "abc_supply";
/** Apps whose calendars are added by link. They're also the calendar_sources.app values (with google_calendar). */
export type LinkApp = "zoho_calendar" | "outlook_calendar" | "apple_calendar" | "ics_calendar";
export type AppId = Provider | LinkApp | "chatgpt" | "team_chat" | "website_analytics" | "website_forms" | "careers" | "drive" | "marketing" | "sveltia";
export type CalendarApp = LinkApp | "google_calendar";
export const CALENDAR_APPS: readonly CalendarApp[] = ["google_calendar", "zoho_calendar", "outlook_calendar", "apple_calendar", "ics_calendar"];

export interface CatalogEntry {
  id: AppId;
  name: string;
  category: "Team" | "Calendar" | "AI" | "Accounting" | "Payments" | "Pricing" | "Messaging" | "Website";
  description: string;
  auth: "oauth" | "api_key" | "link" | "connector" | "builtin" | "site";
  docs: string;
  /** False when this deployment lacks the OAuth app or platform key the provider needs. */
  available: (env: Env) => boolean;
  /**
   * A company can sign in with its own app at the provider instead: it pastes that app's keys on the
   * app's page (kept with its tokens, see oauthClient in tokens.ts), so nobody has to set up the server.
   */
  appKeys?: true;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "team_chat",
    name: "Crewtavo - Team Chat",
    category: "Team",
    description: "Channels for the whole team, each crew and the office, with photos, @mentions and who's online.",
    auth: "builtin",
    docs: "https://crewtavo.com/docs/connections/team-chat/",
    available: () => true,
  },
  {
    id: "website_analytics",
    name: "Crewtavo - Website Analytics",
    category: "Team",
    description: "See who visits your website, where they came from and which pages bring in booking requests, without cookies.",
    auth: "builtin",
    docs: "https://crewtavo.com/docs/connections/website-analytics/",
    available: () => true,
  },
  {
    id: "website_forms",
    name: "Crewtavo - Website Forms",
    category: "Team",
    description: "Keep your website's own form and point it at Crewtavo: each message lands in Requests and your inbox, like Formspree.",
    auth: "builtin",
    docs: "https://crewtavo.com/docs/connections/website-forms/",
    available: () => true,
  },
  {
    id: "careers",
    name: "Crewtavo - Careers",
    category: "Team",
    description: "Point the Apply form on your website at Crewtavo: each application, résumé and all, lands in Applicants for the office to work through.",
    auth: "builtin",
    docs: "https://crewtavo.com/docs/connections/careers/",
    available: () => true,
  },
  {
    id: "drive",
    name: "Crewtavo - Drive",
    category: "Team",
    description: "Every file in one place: company folders, files on each client and job, Word and PDF editing, versions, a 30-day Trash and import from Google Drive.",
    auth: "builtin",
    docs: "https://crewtavo.com/docs/connections/drive/",
    available: () => true,
  },
  {
    id: "marketing",
    name: "Crewtavo - Marketing",
    category: "Team",
    description: "Ask happy clients for Google reviews with reminders, track referrals and send email campaigns.",
    auth: "builtin",
    docs: "https://crewtavo.com/docs/connections/marketing/",
    available: () => true,
  },
  {
    id: "google_calendar",
    name: "Google Calendar",
    category: "Calendar",
    description: "Show your Google calendars on the schedule, and put visits on a Google calendar that stays up to date.",
    auth: "oauth",
    docs: "https://developers.google.com/calendar/api",
    available: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  },
  {
    id: "zoho_calendar",
    name: "Zoho Calendar",
    category: "Calendar",
    description: "Show Zoho calendars on the schedule from their private ICS link.",
    auth: "link",
    docs: "https://www.zoho.com/calendar/",
    available: () => true,
  },
  {
    id: "outlook_calendar",
    name: "Outlook",
    category: "Calendar",
    description: "Show Outlook and Microsoft 365 calendars on the schedule from their published ICS link.",
    auth: "link",
    docs: "https://outlook.office.com/calendar/",
    available: () => true,
  },
  {
    id: "apple_calendar",
    name: "Apple Calendar",
    category: "Calendar",
    description: "Show iCloud calendars on the schedule from their public calendar link.",
    auth: "link",
    docs: "https://www.icloud.com/calendar/",
    available: () => true,
  },
  {
    id: "ics_calendar",
    name: "Other calendars",
    category: "Calendar",
    description: "Any calendar with an ICS or webcal link: Yahoo, Fastmail, Proton, Nextcloud, booking tools and more.",
    auth: "link",
    docs: "https://en.wikipedia.org/wiki/ICalendar",
    available: () => true,
  },
  {
    id: "anthropic",
    name: "Claude",
    category: "AI",
    description: "Use Crewtavo from Claude, and power Crewtavo's writing help and SOP answers with your own Anthropic key.",
    auth: "api_key",
    docs: "https://docs.claude.com/",
    available: () => true,
  },
  {
    id: "fal",
    name: "fal.ai",
    category: "AI",
    description: "Find paving on the aerial in one tap: asphalt, concrete and stalls outlined for you, with your own fal.ai account.",
    auth: "api_key",
    docs: "https://crewtavo.com/docs/connections/fal/",
    available: () => true,
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    category: "AI",
    description: "Look up clients, check the schedule and log requests from ChatGPT.",
    auth: "connector",
    docs: "https://chatgpt.com/",
    available: () => true,
  },
  {
    id: "quickbooks",
    name: "QuickBooks Online",
    category: "Accounting",
    description: "Send clients, invoices and payments to QuickBooks when it's your book of record.",
    auth: "oauth",
    docs: "https://crewtavo.com/docs/connections/quickbooks/",
    available: (env) => Boolean(env.QUICKBOOKS_CLIENT_ID && env.QUICKBOOKS_CLIENT_SECRET),
    appKeys: true,
  },
  {
    id: "zoho_books",
    name: "Zoho Books",
    category: "Accounting",
    description: "Send clients, invoices and payments to Zoho Books in your data center.",
    auth: "oauth",
    docs: "https://crewtavo.com/docs/connections/zoho-books/",
    available: (env) => Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET),
    appKeys: true,
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "Payments",
    description: "Invoices go to Stripe and clients pay by card or bank. Invoices you make in Stripe come in too, with the fees and deposits behind every payment.",
    auth: "api_key",
    docs: "https://docs.stripe.com/keys",
    // A company adds its own key; a deployment can also set one for everyone.
    available: () => true,
  },
  {
    id: "abc_supply",
    name: "ABC Supply",
    category: "Pricing",
    description: "Your own ABC Supply prices on your estimates: every bundle, roll and piece priced at your branch, so material costs are exact.",
    auth: "api_key",
    docs: "https://crewtavo.com/docs/connections/abc-supply/",
    // Each business uses its own app at ABC (its Client ID and secret), so nothing to set up on the server.
    available: () => true,
  },
  {
    id: "twilio",
    name: "Twilio",
    category: "Messaging",
    description: "Text messages: reminders, on-my-way texts and two-way conversations.",
    auth: "api_key",
    docs: "https://www.twilio.com/docs/messaging",
    available: (env) => Boolean(env.TWILIO_ACCOUNT_SID),
  },
  {
    id: "sveltia",
    name: "Sveltia CMS",
    category: "Website",
    description: "Edit your website's pages and posts from Crewtavo, in the Sveltia CMS editor your site already has.",
    auth: "site",
    docs: "https://crewtavo.com/docs/connections/sveltia-cms/",
    available: () => true,
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

export const isCalendarApp = (id: string): id is CalendarApp => (CALENDAR_APPS as readonly string[]).includes(id);

/** Context passed back on the OAuth callback (Zoho tells us which data center the account lives in). */
export interface CallbackContext {
  query: Record<string, string>;
}

export interface OAuthConfig {
  authorizeUrl: (env: Env, saved?: Record<string, string>) => string;
  tokenUrl: (env: Env, ctx?: CallbackContext, saved?: Record<string, string>) => string;
  revokeUrl?: (env: Env, saved?: Record<string, string>) => string;
  scope: string;
  clientId: (env: Env) => string | undefined;
  clientSecret: (env: Env) => string | undefined;
  /** "basic": client credentials in an Authorization header; "body": in the form body. */
  clientAuth: "basic" | "body";
  extraParams?: Record<string, string>;
}

export class IntegrationError extends Error {
  override name = "IntegrationError";
}

/** A provider pointed us at a server that isn't its own. The message is shown on the Apps page. */
export class UntrustedServerError extends IntegrationError {}

/** Provider calls give up after this long, so a provider that hangs fails like one that's down. */
export const providerTimeout = () => AbortSignal.timeout(15_000);

// Zoho's data centers: US, EU, India, Australia, Japan, China, Canada, Saudi Arabia, UK.
const ZOHO_TLDS = ["com", "eu", "in", "com.au", "jp", "com.cn", "ca", "sa", "uk"];
const ZOHO_ACCOUNTS = new Set([...ZOHO_TLDS.map((tld) => `accounts.zoho.${tld}`), "accounts.zohocloud.ca"]);
const ZOHO_APIS = new Set(ZOHO_TLDS.flatMap((tld) => [`www.zohoapis.${tld}`, `zohoapis.${tld}`]));

/** The origin of an https URL on one of `hosts` (default port, no user info), or null. */
function trustedOrigin(value: string, hosts: Set<string>): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || !hosts.has(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The accounts server Zoho's callback names (?accounts-server=). It arrives in the browser's URL
 * and the client secret is sent there, so only Zoho's own accounts servers are accepted.
 */
export function zohoAccountsServer(value: string): string {
  const origin = trustedOrigin(value, ZOHO_ACCOUNTS);
  if (!origin) throw new UntrustedServerError("That sign-in came back from a server that isn't Zoho's, so Zoho Books wasn't connected. Try connecting again.");
  return origin;
}

/** The API domain from Zoho's token response: only Zoho's own API servers (zohoapis.*) are used. */
export function zohoApiDomain(value: string | undefined): string {
  if (!value) return "https://www.zohoapis.com";
  const origin = trustedOrigin(value, ZOHO_APIS);
  if (!origin) throw new UntrustedServerError("Zoho gave an API address that isn't one of Zoho's servers, so it wasn't used. Connect Zoho Books again.");
  return origin;
}

const zohoAccounts = (env: Env, saved?: Record<string, string>) =>
  saved?.accounts_server ? zohoAccountsServer(saved.accounts_server) : (env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.com").replace(/\/$/, "");

export const OAUTH: Partial<Record<Provider, OAuthConfig>> = {
  quickbooks: {
    authorizeUrl: () => "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: () => "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    revokeUrl: () => "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    scope: "com.intuit.quickbooks.accounting",
    clientId: (env) => env.QUICKBOOKS_CLIENT_ID,
    clientSecret: (env) => env.QUICKBOOKS_CLIENT_SECRET,
    clientAuth: "basic",
  },
  zoho_books: {
    // A company's own Zoho app lives in its own data center, so sign-in starts there.
    authorizeUrl: (env, saved) => `${zohoAccounts(env, saved)}/oauth/v2/auth`,
    // Zoho's callback says which data center the account is in; tokens must come from there.
    tokenUrl: (env, ctx, saved) => `${ctx?.query["accounts-server"] ? zohoAccountsServer(ctx.query["accounts-server"]) : zohoAccounts(env, saved)}/oauth/v2/token`,
    revokeUrl: (env, saved) => `${zohoAccounts(env, saved)}/oauth/v2/token/revoke`,
    scope: "ZohoBooks.fullaccess.all",
    clientId: (env) => env.ZOHO_CLIENT_ID,
    clientSecret: (env) => env.ZOHO_CLIENT_SECRET,
    clientAuth: "body",
    extraParams: { access_type: "offline", prompt: "consent" },
  },
  google_calendar: {
    authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: () => "https://oauth2.googleapis.com/token",
    revokeUrl: () => "https://oauth2.googleapis.com/revoke",
    // As little as the features need: see which calendars there are, read their events, and keep
    // the one calendar Crewtavo makes for visits. Never change anyone's own events.
    scope: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.app.created",
    ].join(" "),
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    clientAuth: "body",
    extraParams: { access_type: "offline", prompt: "consent" },
  },
};
