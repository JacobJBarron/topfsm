import type { Db } from "../lib/supabase";
/**
 * OAuth code exchange, refresh and revocation, plus encrypted storage of the results.
 * Everything here uses the admin client: integration_secrets is unreadable to users by design.
 */
import type { Env } from "../env";
import { decryptJson, encryptJson } from "../lib/crypto";
import { IntegrationError, OAUTH, providerTimeout, zohoAccountsServer, zohoApiDomain, type CallbackContext, type Provider } from "./registry";

export { IntegrationError };

export interface StoredSecret {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // ms since epoch
  api_key?: string;
  /**
   * Provider details needed later, e.g. Zoho's accounts server and API domain. A company that signs
   * in with its own app at the provider keeps that app's keys here too (see oauthClient).
   */
  extra?: Record<string, string>;
}

/** What a company's own app at the provider leaves in `extra`, and keeps when it disconnects (Meta's Configuration ID too). */
const APP_KEY_FIELDS = ["client_id", "client_secret", "environment", "accounts_server", "config_id"] as const;

/** A company's own app keys from a stored secret, without its tokens. Empty when it has none. */
export function appKeysOf(extra: Record<string, string> | undefined): Record<string, string> {
  if (!extra?.client_id || !extra.client_secret) return {};
  return Object.fromEntries(APP_KEY_FIELDS.filter((key) => extra[key]).map((key) => [key, extra[key]!]));
}

/**
 * The app a company signs in with: its own (keys pasted on the app's page) when it saved one,
 * otherwise this server's (QUICKBOOKS_CLIENT_ID and the like). Null when there's neither.
 */
export function oauthClient(env: Env, provider: Provider, extra?: Record<string, string>): { id: string; secret: string } | null {
  if (extra?.client_id && extra.client_secret) return { id: extra.client_id, secret: extra.client_secret };
  const config = OAUTH[provider];
  const id = config?.clientId(env);
  const secret = config?.clientSecret(env);
  return id && secret ? { id, secret } : null;
}

/** The provider said no for good (sign-in revoked or expired, or this server's app keys are wrong). */
export class SignInRefused extends IntegrationError {
  override name = "SignInRefused";
}

// OAuth errors that mean signing in again, not trying later. Zoho says invalid_code for a dead refresh token.
const REFUSALS = ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_code", "invalid_client_secret"];

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  api_domain?: string;
  error?: string;
}

async function tokenRequest(env: Env, provider: Provider, form: Record<string, string>, ctx?: CallbackContext, saved?: Record<string, string>) {
  const config = OAUTH[provider];
  if (!config) throw new IntegrationError(`${provider} doesn't use OAuth`);
  const client = oauthClient(env, provider, saved);
  if (!client) throw new IntegrationError(`${provider} isn't set up: add your app's keys on the Apps page`);

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body = new URLSearchParams(form);
  if (config.clientAuth === "basic") headers.Authorization = `Basic ${btoa(`${client.id}:${client.secret}`)}`;
  else {
    body.set("client_id", client.id);
    body.set("client_secret", client.secret);
  }
  const response = await fetch(config.tokenUrl(env, ctx, saved), { method: "POST", headers, body, signal: providerTimeout() });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !json.access_token) {
    const Failure = json.error && REFUSALS.includes(json.error) ? SignInRefused : IntegrationError;
    throw new Failure(`${provider} token request failed (${response.status}${json.error ? `: ${json.error}` : ""})`);
  }
  return json;
}

/** `saved` is what was stored before signing in: the company's own app keys, if it has them, stay. */
export async function exchangeCode(env: Env, provider: Provider, code: string, redirectUri: string, ctx: CallbackContext, saved?: Record<string, string>): Promise<StoredSecret> {
  const keys = appKeysOf(saved);
  const json = await tokenRequest(env, provider, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, ctx, keys);
  const extra: Record<string, string> = { ...keys };
  if (provider === "zoho_books") {
    // Both come from outside (the callback URL and the token response): only Zoho's servers are kept.
    if (ctx.query["accounts-server"]) extra.accounts_server = zohoAccountsServer(ctx.query["accounts-server"]);
    extra.api_domain = zohoApiDomain(json.api_domain);
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    extra,
  };
}

export async function saveSecret(env: Env, admin: Db, companyId: string, provider: Provider, secret: StoredSecret) {
  const { error } = await admin.from("integration_secrets").upsert({
    company_id: companyId,
    provider,
    ciphertext: await encryptJson(env, secret),
    expires_at: secret.expires_at ? new Date(secret.expires_at).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new IntegrationError(`Couldn't store ${provider} credentials: ${error.message}`);
}

export async function loadSecret(env: Env, admin: Db, companyId: string, provider: Provider): Promise<StoredSecret | null> {
  const { data, error } = await admin
    .from("integration_secrets")
    .select("ciphertext")
    .eq("company_id", companyId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new IntegrationError(error.message);
  return data ? decryptJson<StoredSecret>(env, data.ciphertext) : null;
}

/** A valid access token, refreshed (and re-saved) when it's within two minutes of expiring. */
export async function accessToken(env: Env, admin: Db, companyId: string, provider: Provider): Promise<{ token: string; secret: StoredSecret }> {
  const secret = await loadSecret(env, admin, companyId, provider);
  if (!secret?.access_token) throw new IntegrationError(`${provider} isn't connected`);
  if (!secret.expires_at || secret.expires_at - Date.now() > 120_000) return { token: secret.access_token, secret };
  if (!secret.refresh_token) throw new IntegrationError(`${provider} needs to be reconnected`);

  try {
    const json = await tokenRequest(env, provider, { grant_type: "refresh_token", refresh_token: secret.refresh_token }, undefined, secret.extra);
    const refreshed: StoredSecret = {
      ...secret,
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? secret.refresh_token, // Zoho keeps the old one
      expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    await saveSecret(env, admin, companyId, provider, refreshed);
    return { token: refreshed.access_token!, secret: refreshed };
  } catch (error) {
    // Only a definite no needs a person to reconnect. An outage or timeout throws so the work is retried later.
    if (error instanceof SignInRefused) {
      await admin
        .from("integrations")
        .update({ status: "error", last_error: "Sign-in expired. Reconnect on the Apps page." })
        .eq("company_id", companyId)
        .eq("provider", provider);
    }
    throw error;
  }
}

/** Best-effort revocation at the provider before we forget the tokens. */
export async function revoke(env: Env, provider: Provider, secret: StoredSecret): Promise<void> {
  const config = OAUTH[provider];
  const token = secret.refresh_token ?? secret.access_token;
  if (!config?.revokeUrl || !token) return;
  try {
    const url = config.revokeUrl(env, secret.extra);
    if (provider === "quickbooks") {
      const client = oauthClient(env, provider, secret.extra);
      if (!client) return;
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${client.id}:${client.secret}`)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ token }),
        signal: providerTimeout(),
      });
    } else {
      await fetch(`${url}?${new URLSearchParams({ token })}`, { method: "POST", signal: providerTimeout() });
    }
  } catch {
    // Revocation is a courtesy; the local tokens are deleted either way.
  }
}
