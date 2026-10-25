/**
 * ABC Supply: a business's own material prices from its own ABC account, for its estimates (Apps →
 * ABC Supply, Roofing → Estimate → Materials). This is ABC's "Individual Business" integration: the
 * business makes an app in ABC's developer portal (partners-developer.abcsupply.com), pastes that
 * app's Client ID and secret here, and Crewtavo signs in as that app (OAuth client credentials) to
 * read the catalog and the account's prices at its branch. There's no sign-in page to come back
 * to, so it works at every server's address as it is.
 *
 * ABC's API terms allow a business's own CRM to price its own work, and forbid comparing ABC's
 * prices with other suppliers', building price databases and reselling them. So prices are asked
 * for when someone picks a material or prices an estimate, and kept with that estimate and the
 * price list they belong to, never next to another supplier's.
 */
import type { Db } from "../lib/supabase";
import type { Env } from "../env";
import { IntegrationError, providerTimeout } from "./registry";
import { loadSecret, saveSecret, type StoredSecret } from "./tokens";

export type AbcEnvironment = "production" | "sandbox";

const ENVIRONMENTS: Record<AbcEnvironment, { api: string; token: string }> = {
  production: { api: "https://partners.abcsupply.com", token: "https://auth.partners.abcsupply.com/oauth2/ausvvp0xuwGKLenYy357/v1/token" },
  sandbox: { api: "https://partners-sb.abcsupply.com", token: "https://sandbox.auth.partners.abcsupply.com/oauth2/aus1vp07knpuqf6Xz0h8/v1/token" },
};

/** What Crewtavo asks ABC for: the account and its branches, the catalog and prices. No orders or invoices. */
const SCOPES = "account.read location.read product.read pricing.read";

/** ABC takes up to 50 lines in one price request. */
const PRICE_LINES = 50;

export interface AbcKeys {
  client_id: string;
  client_secret: string;
  environment: AbcEnvironment;
}

export interface AbcBranch {
  number: string;
  name: string;
  /** The account's home branch. */
  home: boolean;
}

/** A ship-to account the app can price for, with the branches it buys from. */
export interface AbcAccount {
  number: string;
  name: string;
  city: string | null;
  state: string | null;
  branches: AbcBranch[];
}

/** integrations.settings for abc_supply: where prices come from, and the accounts there are to pick. */
export interface AbcSettings {
  environment: AbcEnvironment;
  ship_to: string;
  ship_to_name: string;
  branch: string;
  branch_name: string;
  accounts: AbcAccount[];
}

export interface AbcUom {
  code: string;
  name: string;
  /** What ABC uses it for: costing, estimate, stocking. */
  role: string | null;
}

export interface AbcItem {
  item_number: string;
  name: string;
  family: string | null;
  color: string | null;
  /** Cut to length: it needs a length to be priced. */
  dimensional: boolean;
  uoms: AbcUom[];
  /** The unit it's ordered and stocked in (a bundle, not a square). */
  stocking_uom: string;
}

export interface AbcPriceLine {
  id: string;
  item_number: string;
  quantity: number;
  uom: string;
  length_ft?: number | null;
}

export interface AbcPrice {
  /** Null when ABC gave no price: the branch hasn't priced it, or the item can't be priced there. */
  unit_price: number | null;
  note: string | null;
}

/** Something ABC said no to, in words for an office manager. `status` is what the API answers with. */
export class AbcProblem extends IntegrationError {
  override name = "AbcProblem";
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502) {
    super(message);
  }
}

type FetchLike = typeof fetch;

const NOT_REACHED = "Couldn't reach ABC Supply. Check the server's internet connection and try again.";
const keysRefused = (environment: AbcEnvironment) =>
  environment === "sandbox"
    ? "ABC Supply's sandbox didn't accept that Client ID and secret. Copy both again from your app in ABC's developer portal (Manage Applications, then Manage)."
    : "ABC Supply didn't accept that Client ID and secret for your real prices. Copy both again from your app in ABC's developer portal. If you only just sent ABC the Production Request, it can take a business day or two before they work; until then, try Sandbox.";
const SCOPE_REFUSED =
  "ABC Supply won't give this app prices. It has to be an app for your own company, not a software company's: in ABC's developer portal, make a new app, answer No when ABC asks if it will be used by multiple ABC customers, and paste its keys.";

/** A token for the app, from ABC's sign-in server (they last 30 minutes). */
export async function requestToken(keys: AbcKeys, fetcher: FetchLike = fetch): Promise<{ access_token: string; expires_at: number }> {
  const res = await fetcher(ENVIRONMENTS[keys.environment].token, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${keys.client_id}:${keys.client_secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPES }),
    signal: providerTimeout(),
  }).catch(() => null);
  if (!res) throw new AbcProblem(NOT_REACHED, 502);
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (res.ok && json.access_token) return { access_token: json.access_token, expires_at: Date.now() + (json.expires_in ?? 1800) * 1000 };
  if (json.error === "invalid_scope" || json.error === "unauthorized_client") throw new AbcProblem(SCOPE_REFUSED, 400);
  if (res.status === 400 || res.status === 401 || json.error === "invalid_client") throw new AbcProblem(keysRefused(keys.environment), 400);
  throw new AbcProblem(`ABC Supply couldn't sign in right now (error ${res.status}). Try again in a minute.`, 502);
}

/** What an ABC answer that isn't OK means for whoever pressed the button. */
function apiProblem(status: number, body: string): AbcProblem {
  if (status === 401) return new AbcProblem("ABC Supply asked Crewtavo to sign in again.", 401);
  if (status === 403) return new AbcProblem("ABC Supply says this app can't see that. In ABC's developer portal, check the app has access to your ABC account.", 403);
  if (status === 404) return new AbcProblem("ABC Supply doesn't have that item.", 404);
  if (status === 429) return new AbcProblem("ABC Supply is busy right now. Try again in a minute.", 429);
  if (status === 400) {
    const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(body)?.[1];
    return new AbcProblem(`ABC Supply couldn't use that${said ? `: ${said}` : ""}.`, 400);
  }
  return new AbcProblem("ABC Supply isn't answering right now. Try again in a minute.", 502);
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

interface RawItem {
  itemNumber?: string;
  itemDescription?: string;
  familyName?: string;
  isDimensional?: boolean;
  color?: { name?: string | null } | null;
  uoms?: Array<{ code?: string; name?: string; description?: string }>;
  dimensions?: { variations?: Array<{ length?: { value?: string | number; uom?: string; uomCode?: string } }> };
}

function itemOf(raw: RawItem): AbcItem {
  const uoms = (raw.uoms ?? []).flatMap((u): AbcUom[] => (text(u.code) ? [{ code: u.code!.trim().toUpperCase(), name: text(u.name) ?? u.code!.trim(), role: text(u.description)?.toLowerCase() ?? null }] : []));
  // The same unit can be listed once per use (Square for costing and for estimating).
  const unique = uoms.filter((u, i) => uoms.findIndex((v) => v.code === u.code) === i);
  return {
    item_number: raw.itemNumber ?? "",
    name: text(raw.itemDescription) ?? raw.itemNumber ?? "",
    family: text(raw.familyName),
    color: text(raw.color?.name),
    dimensional: raw.isDimensional === true,
    uoms: unique,
    stocking_uom: uoms.find((u) => u.role === "stocking")?.code ?? unique[0]?.code ?? "EA",
  };
}

/** A length variation in feet ("10" ft, or "120" in). */
function lengthInFeet(length: { value?: string | number; uom?: string; uomCode?: string } | undefined): number | null {
  const value = Number(length?.value);
  if (!(value > 0)) return null;
  const unit = `${length?.uomCode ?? length?.uom ?? "ft"}`.toLowerCase();
  return /^(in|inch|inches)$/.test(unit) ? Math.round((value / 12) * 1000) / 1000 : value;
}

/** ABC's API for one app's token. A 401 means the token ran out: get another and call again. */
export class AbcClient {
  constructor(
    private readonly environment: AbcEnvironment,
    private token: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly renew?: () => Promise<string>,
  ) {}

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
    const res = await this.fetcher(`${ENVIRONMENTS[this.environment].api}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: providerTimeout(),
    }).catch(() => null);
    if (!res) throw new AbcProblem(NOT_REACHED, 502);
    if (res.status === 401 && this.renew && !retried) {
      this.token = await this.renew();
      return this.call(path, init, true);
    }
    if (!res.ok) throw apiProblem(res.status, await res.text().catch(() => ""));
    return (await res.json().catch(() => ({}))) as T;
  }

  /** The ship-to accounts this app prices for, with their branches. Retired ones (no branches) are left out, as ABC asks. */
  async accounts(): Promise<AbcAccount[]> {
    const body = await this.call<{ shipTos?: Array<{ number?: string; name?: string; status?: string; address?: { city?: string; state?: string }; branches?: Array<{ number?: string; name?: string; homeBranch?: boolean; status?: string }> }> }>(
      "/api/account/v1/search/accounts",
      { body: { filters: [{ key: "accountType", condition: "equals", values: ["Ship-To"] }], pagination: { itemsPerPage: 100, pageNumber: 1 } } },
    );
    return (body.shipTos ?? []).flatMap((s): AbcAccount[] => {
      const branches = (s.branches ?? []).flatMap((b): AbcBranch[] => (text(b.number) ? [{ number: b.number!.trim(), name: text(b.name) ?? `Branch ${b.number}`, home: b.homeBranch === true }] : []));
      if (!text(s.number) || !branches.length || (s.status && s.status.toLowerCase() === "inactive")) return [];
      return [{ number: s.number!.trim(), name: text(s.name) ?? `Account ${s.number}`, city: text(s.address?.city), state: text(s.address?.state), branches }];
    });
  }

  /**
   * Items at a branch whose description has these words (or whose item number starts so). ABC
   * matches the words as one piece of text, so when that finds nothing, the longest word is asked
   * for and the rest are checked here.
   */
  async searchItems(query: string, branch: string): Promise<AbcItem[]> {
    const words = query.trim().split(/\s+/).filter(Boolean);
    const byNumber = words.length === 1 && /\d/.test(query) && /^[A-Za-z0-9-]{4,}$/.test(query.trim());
    const search = async (key: "itemDescription" | "itemNumber", value: string) => {
      const body = await this.call<{ items?: RawItem[] }>("/api/product/v1/search/items", {
        body: {
          filters: [
            { key, condition: "contains", values: [value], joinCondition: "and" },
            { key: "branchNumber", condition: "equals", values: [branch], joinCondition: null },
          ],
          pagination: { itemsPerPage: 30, pageNumber: 1 },
        },
      });
      return (body.items ?? []).map(itemOf).filter((i) => i.item_number);
    };
    if (byNumber) {
      const found = await search("itemNumber", query.trim().toUpperCase());
      if (found.length) return found;
    }
    const whole = await search("itemDescription", query.trim());
    if (whole.length || words.length < 2) return whole;
    const longest = [...words].sort((a, b) => b.length - a.length)[0]!;
    const lower = words.map((w) => w.toLowerCase());
    return (await search("itemDescription", longest)).filter((i) => lower.every((w) => `${i.name} ${i.family ?? ""} ${i.color ?? ""}`.toLowerCase().includes(w)));
  }

  /** One item, with the lengths it's cut to when it's dimensional. */
  async item(itemNumber: string): Promise<AbcItem & { lengths: number[] }> {
    const raw = await this.call<RawItem>(`/api/product/v1/items/${encodeURIComponent(itemNumber)}?embed=variations`);
    const item = itemOf(raw);
    if (!item.item_number) throw new AbcProblem("ABC Supply doesn't have that item.", 404);
    const lengths = [...new Set((raw.dimensions?.variations ?? []).map((v) => lengthInFeet(v.length)).filter((n): n is number => n !== null))].sort((a, b) => a - b);
    return { ...item, lengths };
  }

  /** The account's prices at the branch, 50 lines at a time. A price of 0.00 is ABC's way of saying the branch hasn't priced it. */
  async prices(shipTo: string, branch: string, lines: readonly AbcPriceLine[], purpose: "estimating" | "quoting" = "quoting"): Promise<Map<string, AbcPrice>> {
    const out = new Map<string, AbcPrice>();
    for (let i = 0; i < lines.length; i += PRICE_LINES) {
      const chunk = lines.slice(i, i + PRICE_LINES);
      const body = await this.call<{ lines?: Array<{ id?: string; unitPrice?: number; status?: { code?: string; message?: string } }> }>("/api/pricing/v2/prices", {
        body: {
          shipToNumber: shipTo,
          branchNumber: branch,
          purpose,
          lines: chunk.map((l) => ({
            id: l.id,
            itemNumber: l.item_number,
            quantity: Math.max(1, Math.ceil(l.quantity)),
            uom: l.uom,
            ...(l.length_ft ? { length: { value: l.length_ft, uom: "ft" } } : {}),
          })),
        },
      });
      for (const line of body.lines ?? []) {
        if (!line.id) continue;
        const ok = (line.status?.code ?? "").toUpperCase() === "OK";
        const price = Number(line.unitPrice);
        if (ok && price > 0) out.set(line.id, { unit_price: Math.round(price * 100) / 100, note: null });
        else out.set(line.id, { unit_price: null, note: ok ? "The branch hasn't priced this yet. Call the branch for a price." : (text(line.status?.message) ?? "ABC Supply couldn't price this.") });
      }
    }
    for (const line of lines) if (!out.has(line.id)) out.set(line.id, { unit_price: null, note: "ABC Supply didn't price this." });
    return out;
  }
}

/** The account and branch to start with: the first account's home branch. */
export function defaultChoice(accounts: AbcAccount[]): { account: AbcAccount; branch: AbcBranch } | null {
  const account = accounts.find((a) => a.branches.some((b) => b.home)) ?? accounts[0];
  if (!account) return null;
  return { account, branch: account.branches.find((b) => b.home) ?? account.branches[0]! };
}

const NO_ACCOUNTS: Record<AbcEnvironment, string> = {
  sandbox: "ABC Supply's sandbox has no test accounts for this app. Check the app was made for your own company (No to being used by multiple ABC customers), or ask ABC's API support.",
  production:
    "ABC Supply accepted the keys, but no ABC account is linked to this app yet. On your app in ABC's developer portal, send the Production Request with your ABC account number and your myABCSupply email. ABC usually approves it in a business day or two.",
};

export const settingsOf = (value: unknown): AbcSettings | null => {
  const s = value as Partial<AbcSettings> | null;
  return s?.ship_to && s.branch && s.environment ? (s as AbcSettings) : null;
};

const labelOf = (s: Pick<AbcSettings, "ship_to_name" | "branch_name">) => `${s.ship_to_name} · ${s.branch_name}`;

/**
 * Checks the keys with ABC, finds the accounts they price for and starts with the first one's home
 * branch. Saves it all, the keys encrypted, so prices can come from it.
 */
export async function connectAbc(env: Env, admin: Db, opts: { companyId: string; userId: string; keys: AbcKeys }, fetcher: FetchLike = fetch): Promise<AbcSettings> {
  const token = await requestToken(opts.keys, fetcher);
  const accounts = await new AbcClient(opts.keys.environment, token.access_token, fetcher).accounts();
  const choice = defaultChoice(accounts);
  if (!choice) throw new AbcProblem(NO_ACCOUNTS[opts.keys.environment], 400);
  const settings: AbcSettings = {
    environment: opts.keys.environment,
    ship_to: choice.account.number,
    ship_to_name: choice.account.name,
    branch: choice.branch.number,
    branch_name: choice.branch.name,
    accounts,
  };
  // The integrations row must exist before its secret (foreign key).
  const { error } = await admin.from("integrations").upsert({
    company_id: opts.companyId,
    provider: "abc_supply",
    status: "connected",
    account_label: labelOf(settings),
    external_account_id: settings.ship_to,
    settings: settings as never,
    connected_by: opts.userId,
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  if (error) throw new IntegrationError(error.message);
  await saveSecret(env, admin, opts.companyId, "abc_supply", { ...token, extra: { client_id: opts.keys.client_id, client_secret: opts.keys.client_secret, environment: opts.keys.environment } });
  return settings;
}

/** A connected company's ABC client and settings, with a fresh token when the saved one is about to run out. */
export async function abcConnection(env: Env, admin: Db, companyId: string, fetcher: FetchLike = fetch): Promise<{ client: AbcClient; settings: AbcSettings }> {
  const [{ data: row }, secret] = await Promise.all([
    admin.from("integrations").select("status, settings").match({ company_id: companyId, provider: "abc_supply" }).maybeSingle(),
    loadSecret(env, admin, companyId, "abc_supply").catch(() => null),
  ]);
  const settings = settingsOf(row?.settings);
  const keys = keysOf(secret);
  if (!row || row.status === "disconnected" || !settings || !keys) throw new AbcProblem("Material prices come from ABC Supply. An owner or admin can install it on the Apps page.", 409);
  const renew = async () => {
    try {
      const token = await requestToken(keys, fetcher);
      await saveSecret(env, admin, companyId, "abc_supply", { ...secret, ...token });
      if (row.status === "error") await admin.from("integrations").update({ status: "connected", last_error: null }).match({ company_id: companyId, provider: "abc_supply" });
      return token.access_token;
    } catch (error) {
      // Keys ABC turned down need a person; an outage doesn't.
      if (error instanceof AbcProblem && error.status === 400) {
        await admin.from("integrations").update({ status: "error", last_error: error.message }).match({ company_id: companyId, provider: "abc_supply" });
      }
      throw error;
    }
  };
  const fresh = secret?.access_token && secret.expires_at && secret.expires_at - Date.now() > 120_000 ? secret.access_token : await renew();
  return { client: new AbcClient(settings.environment, fresh, fetcher, renew), settings };
}

function keysOf(secret: StoredSecret | null): AbcKeys | null {
  const extra = secret?.extra;
  if (!extra?.client_id || !extra.client_secret) return null;
  return { client_id: extra.client_id, client_secret: extra.client_secret, environment: extra.environment === "sandbox" ? "sandbox" : "production" };
}

/** Prices from another of the app's accounts or branches. The accounts are asked for again, so a new one shows up. */
export async function chooseAbcAccount(env: Env, admin: Db, companyId: string, choice: { ship_to: string; branch: string }, fetcher: FetchLike = fetch): Promise<AbcSettings> {
  const { client, settings } = await abcConnection(env, admin, companyId, fetcher);
  const accounts = await client.accounts();
  const account = accounts.find((a) => a.number === choice.ship_to);
  const branch = account?.branches.find((b) => b.number === choice.branch);
  if (!account || !branch) throw new AbcProblem("That account or branch isn't one this ABC app can price for anymore. Pick another.", 400);
  const next: AbcSettings = { ...settings, ship_to: account.number, ship_to_name: account.name, branch: branch.number, branch_name: branch.name, accounts };
  const { error } = await admin
    .from("integrations")
    .update({ settings: next as never, account_label: labelOf(next), external_account_id: next.ship_to })
    .match({ company_id: companyId, provider: "abc_supply" });
  if (error) throw new IntegrationError(error.message);
  return next;
}
