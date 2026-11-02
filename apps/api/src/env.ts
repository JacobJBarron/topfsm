import type { IncomingMessage } from "node:http";
import type { Db } from "./lib/supabase";
import type { Permission, Role } from "@crewtavo/core";

/**
 * Configuration, from the server's environment (server.ts). In a Crewtavo instance, lib/stack.ts
 * fills in the Supabase settings from JWT_SECRET; in local development they come from .dev.vars.
 * Either Supabase key style works (publishable/secret or the legacy anon/service_role).
 */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  SUPABASE_ANON_KEY?: string; // legacy name
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string; // legacy name
  /**
   * Encrypts third-party tokens and signs client links: 32+ random bytes in base64, or any phrase of
   * 32+ characters. Optional: without it, a key is derived from the Supabase secret key.
   */
  ENCRYPTION_KEY?: string;
  /** Public URL of this deployment, e.g. https://ops.example.com. Defaults to the request origin. */
  APP_URL?: string;
  /** Set by Railway on every deployment: where this instance lives, for Settings → Web address. */
  RAILWAY_PUBLIC_DOMAIN?: string;
  RAILWAY_PROJECT_ID?: string;
  RAILWAY_PROJECT_NAME?: string;
  RAILWAY_ENVIRONMENT_ID?: string;
  RAILWAY_SERVICE_ID?: string;
  /** "compose" when started by docker-compose.yml (npm run instance). */
  CREWTAVO_PLATFORM?: string;
  PORT?: string;
  /**
   * Set by server.ts in stack mode (lib/stack.ts): this server is the gateway to the instance's own
   * Supabase services, and the instance belongs to one company (the first person becomes the owner).
   */
  CREWTAVO_GATEWAY?: string;
  CREWTAVO_SINGLE_COMPANY?: string;
  /** Owner account recovery without email (lib/recovery.ts): the account's email and a phrase of 12+ characters. */
  CREWTAVO_RECOVERY_EMAIL?: string;
  CREWTAVO_RECOVERY_CODE?: string;
  /** Shared secret for /api/cron/* (run a background task by hand, as a bearer token). */
  CRON_SECRET?: string;
  /**
   * Where the visitor's address comes from, when something other than Railway's edge or one web
   * server (Caddy, nginx) is in front: a header the proxy sets ("cf-connecting-ip"), how many proxies
   * add to X-Forwarded-For ("x-forwarded-for:2"), or "connection" for none. See lib/visitor.ts.
   */
  CREWTAVO_VISITOR_IP?: string;

  /**
   * Where Graph API calls go instead of https://graph.facebook.com: a local stub, for checking the
   * app without reaching Meta. Never set in production.
   */
  META_GRAPH_URL?: string;

  ANTHROPIC_API_KEY?: string;
  AI_MODEL?: string;

  GOOGLE_MAPS_BROWSER_KEY?: string;
  GOOGLE_MAPS_SERVER_KEY?: string;

  QUICKBOOKS_CLIENT_ID?: string;
  QUICKBOOKS_CLIENT_SECRET?: string;
  QUICKBOOKS_ENVIRONMENT?: "sandbox" | "production";
  ZOHO_CLIENT_ID?: string;
  ZOHO_CLIENT_SECRET?: string;
  ZOHO_ACCOUNTS_URL?: string; // https://accounts.zoho.com (or .eu, .in, .com.au ...)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Import from Google Drive (Apps → Crewtavo - Drive): a browser API key with the Google Picker API
   * on, restricted to this deployment's web address and https://docs.google.com/*. It's public (the
   * web app gets it from /api/config), and works with GOOGLE_CLIENT_ID's Google Cloud project.
   */
  GOOGLE_PICKER_API_KEY?: string;

  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  /** Development only: deliver email and texts to a local Mailpit inbox (e.g. http://localhost:56324). */
  MAILPIT_URL?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;

  /** Error reporting: a Sentry DSN, or a self-hosted GlitchTip DSN. Unset turns reporting off. */
  CREWTAVO_SENTRY_DSN?: string;
  /** Send the web app's errors to a different project (defaults to CREWTAVO_SENTRY_DSN). */
  CREWTAVO_SENTRY_WEB_DSN?: string;
  /** Shown on each report, e.g. "staging". Defaults to "production". */
  CREWTAVO_SENTRY_ENVIRONMENT?: string;
}

export interface Vars {
  userId: string;
  token: string;
  /** The sign-in this token belongs to (its session_id claim; empty for a token without one). */
  sessionId: string;
  /** Supabase client acting as the signed-in user: RLS applies to everything it does. */
  db: Db;
  /** The session's app_metadata, which only the server sets (a sub's sign-in carries its mark: isSubLogin). */
  appMetadata: Record<string, unknown>;
  companyId: string;
  role: Role;
  /** Areas the member's role includes (see packages/core/src/roles.ts). */
  permissions: Permission[];
  /** For a sub's sign-in (role "subcontractor"): which sub it is. Null for the team. */
  subcontractorId: string | null;
}

/** A request to the app gets the settings and, from server.ts, the connection it came in on. */
export type AppEnv = { Bindings: Env & { incoming?: IncomingMessage }; Variables: Vars };

const normalized = new WeakMap<object, Env>();

/**
 * Settings as the app reads them. A blank value counts as unset (an empty line copied from
 * .env.example, or a field left empty in a deploy form), and APP_URL falls back to the address the
 * platform gives the deployment, so emails sent by background tasks have working links.
 */
export function readEnv(source: object): Env {
  const cached = normalized.get(source);
  if (cached) return cached;
  const env: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() === "") continue;
    env[name] = value;
  }
  env.APP_URL ??= platformUrl(env);
  normalized.set(source, env as unknown as Env);
  return env as unknown as Env;
}

function platformUrl(env: Record<string, unknown>): string | undefined {
  if (typeof env.RAILWAY_PUBLIC_DOMAIN === "string") return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return undefined;
}
