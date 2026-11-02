/**
 * ABC Supply: a business's own material prices from its own ABC account, for its estimates (Apps →
 * ABC Supply, Roofing → Estimate → Materials). This is ABC's "Individual Business" integration: the
 * business makes an app in ABC's developer portal (partners-developer.abcsupply.com), pastes that
 * app's Client ID and secret here, and Crewtavo signs in as that app (OAuth client credentials) to
 * read the catalog and the account's prices at its branch, and for Roofing → Catalog, an item's
 * product family, ABC's picture of it, and what the account buys again and again (ABC's record of
 * its invoices). There's no sign-in page to come back to, so it works at every server's address as it is.
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

/**
 * ABC usually prices a request in under 2.5 s, whatever its size, but now and then one hangs: on
 * crm.brrhi.com (2026-10-27) the first price requests after a quiet night got no answer in 15 s,
 * twice in a row, and a minute later took 1 s. So prices get longer to come than other calls, and a
 * price request with no answer after a few seconds is sent again alongside it (firstAnswer).
 */
const PRICE_WAIT_MS = 30_000;
const PRICE_AGAIN_MS = 6_000;

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
  /** The bill-to account it's invoiced to: what ABC keeps the account's usual items by. */
  bill_to?: string | null;
  branches: AbcBranch[];
}

/** integrations.settings for abc_supply: where prices come from, and the accounts there are to pick. */
export interface AbcSettings {
  environment: AbcEnvironment;
  ship_to: string;
  ship_to_name: string;
  /** The ship-to's bill-to account (missing on connections made before the catalog). */
  bill_to?: string | null;
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
  /** The product family it's one color or size of (GAF Timberline HDZ). */
  family_id: string | null;
  color: string | null;
  /** Who makes it (ABC's supplierName): GAF, Owens Corning, CertainTeed. */
  brand: string | null;
  /** What kind of product it is in ABC's own categories: its product type, or else its category. */
  kind: string | null;
  /** ABC's picture of it (an asset id for /materials/images), when it has one. */
  image: string | null;
  /** False when ABC lists it as Inactive: it doesn't sell it any more. */
  active: boolean;
  /** Cut to length: it needs a length to be priced. */
  dimensional: boolean;
  uoms: AbcUom[];
  /** The unit it's ordered and stocked in (a bundle, not a square). */
  stocking_uom: string;
}

/** One item in full, for its page in the catalog. */
export interface AbcItemDetail extends AbcItem {
  /** The lengths it's cut to, in feet, when it's dimensional. */
  lengths: number[];
  /** ABC's longer description, when it has one. */
  about: string | null;
  /** ABC's categories, from the broadest: Roofing, Shingles, Laminated. */
  path: string[];
  specs: Array<{ name: string; value: string }>;
  /** The other colors and sizes in its family (not checked against the branch). */
  family_items: Array<{ item_number: string; name: string; color: string | null }>;
}

/** An item the account buys again and again, from ABC's own record of its invoices. */
export interface AbcUsualItem {
  item_number: string;
  name: string;
  /** The unit's code, as pricing takes it: PC. */
  uom: string;
  /** The unit in words, when ABC gives them: Piece. */
  uom_name: string | null;
  /** Invoices it was on lately (ABC counts the last 90 days). */
  count: number;
  /** Whether the branch carries it, when ABC says. */
  at_branch: boolean | null;
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
const NOT_ANSWERED = "ABC Supply didn't answer in time. Try again in a minute.";
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
    const said = abcSays(body);
    return new AbcProblem(`ABC Supply couldn't use that${said ? `: ${said.replace(/\.$/, "")}` : ""}.`, 400);
  }
  return new AbcProblem("ABC Supply isn't answering right now. Try again in a minute.", 502);
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

const SAYING = /message$|^(detail|title|description|reason|error|error_description)$/i;
const NOT_SAYING = /^(type|code|status|traceId|instance|path|timestamp|links?|href|url)$/i;

/**
 * Why ABC said no, in its own words. Its error answers aren't documented and come in more than one
 * shape ({"message"}, {"errorMessage": "Bad Request : …"} from pricing, a validation "errors" map
 * of field to messages, plain text from its gateway).
 */
export function abcSays(body: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return text(body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "))?.slice(0, 200) ?? null;
  }
  const said: string[] = [];
  const walk = (value: unknown, key: string, inErrors: boolean) => {
    if (typeof value === "string") {
      const words = value.trim().replace(/^bad request\s*:?\s*/i, "");
      if ((SAYING.test(key) || (inErrors && !NOT_SAYING.test(key))) && words) said.push(words);
    } else if (Array.isArray(value)) value.forEach((v) => walk(v, key, inErrors));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k, inErrors || /^errors?$/i.test(key));
  };
  walk(json, "", false);
  const words = [...new Set(said)].join(" ").slice(0, 300);
  return words || null;
}

/** A level of ABC's product categories (product group, category, product type...). */
interface RawLevel {
  name?: string | null;
  description?: string | null;
  category?: RawLevel | null;
  productType?: RawLevel | null;
  materialComposition?: RawLevel | null;
}

interface RawItem {
  itemNumber?: string;
  itemDescription?: string;
  marketingDescription?: string | null;
  familyId?: string | null;
  familyName?: string;
  supplierName?: string | null;
  status?: string | null;
  isDimensional?: boolean;
  // ABC's docs show color as an object; an older shape had a plain string.
  color?: { name?: string | null; description?: string | null } | string | null;
  uoms?: Array<{ code?: string; name?: string; description?: string }>;
  dimensions?: { variations?: Array<{ length?: { value?: string | number; uom?: string; uomCode?: string } }> };
  specifications?: Array<{ name?: string | null; code?: string | null; description?: string | null }> | null;
  images?: Array<{ assetId?: string | null; type?: string | null }> | null;
  hierarchy?: { productGroup?: RawLevel | null } | null;
  familyItems?: Array<{ itemNumber?: string; itemDescription?: string; color?: string | { name?: string | null } | null }> | null;
}

/** A color, or nothing for ABC's "N/A", or "Product Color" (the field's own label, shown when it has no color). */
const colorText = (value: unknown) => {
  const color = text(value);
  return color && !/^(n\/?a|none|-+|product colou?r)$/i.test(color) ? color : null;
};
const colorOf = (color: RawItem["color"]) => (typeof color === "string" ? colorText(color) : (colorText(color?.name) ?? colorText(color?.description)));

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };

/**
 * A category's name without ABC's code in front, and with its HTML entities read:
 * "000013  -  Steep Slope Roofing (&gt;2/12 Pitch)" is "Steep Slope Roofing (>2/12 Pitch)".
 */
const levelName = (value: unknown) => text(text(value)?.replace(/^\d+\s*-\s*/, "").replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ENTITIES[e]!));

const LEGAL_ENDING = /[\s,.]+(sales|llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|lp|mfg)\.?$/i;

/**
 * Who makes it, without the company's legal ending, and in ordinary capitals when ABC sends it
 * shouting: "OWENS CORNING SALES LLC" is "Owens Corning". Short names (GAF, IKO) stay as they are.
 */
export function brandOf(value: unknown): string | null {
  let name = text(value);
  while (name && LEGAL_ENDING.test(name)) name = name.replace(LEGAL_ENDING, "").trim();
  if (!name || name !== name.toUpperCase()) return name || null;
  return name.replace(/[A-Z]+/g, (word) => (word.length <= 3 ? word : word[0] + word.slice(1).toLowerCase()));
}

/** ABC's categories for an item, from the broadest: product group, category, product type, material. */
function pathOf(raw: RawItem): string[] {
  const group = raw.hierarchy?.productGroup;
  const levels = [group, group?.category, group?.category?.productType, group?.category?.productType?.materialComposition];
  return levels.map((level) => levelName(level?.name) ?? levelName(level?.description)).filter((name): name is string => Boolean(name));
}

/** A unit as the list of usual items gives it ("PC - PIECE"), as its code (PC) and words (Piece). */
export function uomOf(value: unknown): { code: string; name: string | null } {
  const [code, ...rest] = (text(value) ?? "EA").split(/\s+-\s+/);
  const words = text(rest.join(" - "));
  return { code: code!.trim().toUpperCase(), name: words ? words[0]!.toUpperCase() + words.slice(1).toLowerCase() : null };
}

/** An asset id ABC's image call takes: letters, digits and a few separators. */
export const ASSET_ID = /^[A-Za-z0-9._-]{1,120}$/;

function itemOf(raw: RawItem): AbcItem {
  const uoms = (raw.uoms ?? []).flatMap((u): AbcUom[] => (text(u.code) ? [{ code: u.code!.trim().toUpperCase(), name: text(u.name) ?? u.code!.trim(), role: text(u.description)?.toLowerCase() ?? null }] : []));
  // The same unit can be listed once per use (Square for costing and for estimating).
  const unique = uoms.filter((u, i) => uoms.findIndex((v) => v.code === u.code) === i);
  const path = pathOf(raw);
  const image = (raw.images ?? []).map((i) => text(i?.assetId)).find((id): id is string => Boolean(id && ASSET_ID.test(id))) ?? null;
  return {
    item_number: raw.itemNumber ?? "",
    name: text(raw.itemDescription) ?? raw.itemNumber ?? "",
    family: text(raw.familyName),
    family_id: text(raw.familyId),
    color: colorOf(raw.color),
    brand: brandOf(raw.supplierName),
    // The product type says the most ("Laminated Shingles"); the category is next best.
    kind: path[2] ?? path[1] ?? null,
    image,
    active: (text(raw.status) ?? "active").toLowerCase() !== "inactive",
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

/** ABC allows an app 10 calls a second; each company's calls stay under it, a burst of 8 and 8 a second after. */
const CALLS_PER_SECOND = 8;
const lanes = new Map<string, { tokens: number; at: number }>();

/** Waits for the company's turn to call ABC. */
async function pace(lane: string): Promise<void> {
  for (;;) {
    const now = Date.now();
    const bucket = lanes.get(lane) ?? { tokens: CALLS_PER_SECOND, at: now };
    bucket.tokens = Math.min(CALLS_PER_SECOND, bucket.tokens + ((now - bucket.at) / 1000) * CALLS_PER_SECOND);
    bucket.at = now;
    lanes.set(lane, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(((1 - bucket.tokens) / CALLS_PER_SECOND) * 1000)));
  }
}

/** An answer slower than this gets a line in the server's logs. */
const SLOW_MS = 6_000;

/**
 * The first answer to `ask`, asked once more when it hasn't come within `after` ms, or right away
 * when ABC didn't answer or failed (502). ABC turning it down (400, 403, 429) is the answer. Only
 * for calls that change nothing at ABC, like prices.
 */
export function firstAnswer<T>(ask: () => Promise<T>, after: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let asked = 0;
    let failed = 0;
    let done = false;
    const again = () => {
      asked += 1;
      if (asked === 2) clearTimeout(timer);
      ask().then(
        (answer) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(answer);
        },
        (error: unknown) => {
          failed += 1;
          if (done) return;
          if (asked === 1 && error instanceof AbcProblem && error.status === 502) return again();
          if (failed < asked) return;
          done = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (!done && asked === 1) again();
    }, after);
    again();
  });
}

/**
 * ABC's API for one app's token. A 401 means the token ran out: get another and call again.
 * `lane` (the company) keeps its calls under ABC's limit (pace).
 */
export class AbcClient {
  constructor(
    private readonly environment: AbcEnvironment,
    private token: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly renew?: () => Promise<string>,
    private readonly lane?: string,
  ) {}

  private async call<T>(path: string, init: { method?: string; body?: unknown; wait?: number } = {}, retried = false): Promise<T> {
    if (this.lane) await pace(this.lane);
    const started = Date.now();
    let timedOut = false;
    const res = await this.fetcher(`${ENVIRONMENTS[this.environment].api}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.wait ? AbortSignal.timeout(init.wait) : providerTimeout(),
    }).catch((error: unknown) => {
      timedOut = error instanceof Error && error.name === "TimeoutError";
      // For the server's logs: a call ABC never answered shows nowhere else.
      console.warn(`ABC Supply didn't answer ${path}: ${timedOut ? `nothing in ${Math.round((Date.now() - started) / 1000)} s` : String(error)}`);
      return null;
    });
    if (!res) throw new AbcProblem(timedOut ? NOT_ANSWERED : NOT_REACHED, 502);
    if (Date.now() - started > SLOW_MS) console.warn(`ABC Supply took ${Math.round((Date.now() - started) / 1000)} s to answer ${path} (${res.status})`);
    if (res.status === 401 && this.renew && !retried) {
      this.token = await this.renew();
      return this.call(path, init, true);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // For the server's logs: what was asked and ABC's whole answer, since the person only sees the gist.
      console.warn(`ABC Supply answered ${res.status} to ${path}: ${body.slice(0, 1000) || "(nothing)"}${init.body === undefined ? "" : ` (sent ${JSON.stringify(init.body).slice(0, 1000)})`}`);
      throw apiProblem(res.status, body);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  /** The ship-to accounts this app prices for, with their branches. Retired ones (no branches) are left out, as ABC asks. */
  async accounts(): Promise<AbcAccount[]> {
    const body = await this.call<{ shipTos?: Array<{ number?: string; name?: string; status?: string; address?: { city?: string; state?: string }; billTo?: { number?: string } | null; branches?: Array<{ number?: string; name?: string; homeBranch?: boolean; status?: string }> }> }>(
      "/api/account/v1/search/accounts",
      { body: { filters: [{ key: "accountType", condition: "equals", values: ["Ship-To"] }], pagination: { itemsPerPage: 100, pageNumber: 1 } } },
    );
    return (body.shipTos ?? []).flatMap((s): AbcAccount[] => {
      const branches = (s.branches ?? []).flatMap((b): AbcBranch[] => (text(b.number) ? [{ number: b.number!.trim(), name: text(b.name) ?? `Branch ${b.number}`, home: b.homeBranch === true }] : []));
      if (!text(s.number) || !branches.length || (s.status && s.status.toLowerCase() === "inactive")) return [];
      return [{ number: s.number!.trim(), name: text(s.name) ?? `Account ${s.number}`, city: text(s.address?.city), state: text(s.address?.state), bill_to: text(s.billTo?.number), branches }];
    });
  }

  /**
   * Items at a branch whose description has these words (or whose item number starts so). ABC
   * matches the words as one piece of text, so when that finds nothing, the longest word is asked
   * for and the rest are checked here.
   */
  async searchItems(query: string, branch: string, limit = 30): Promise<AbcItem[]> {
    const words = query.trim().split(/\s+/).filter(Boolean);
    const byNumber = words.length === 1 && /\d/.test(query) && /^[A-Za-z0-9-]{4,}$/.test(query.trim());
    const search = async (key: "itemDescription" | "itemNumber", value: string) => {
      const body = await this.call<{ items?: RawItem[] }>("/api/product/v1/search/items", {
        body: {
          filters: [
            { key, condition: "contains", values: [value], joinCondition: "and" },
            { key: "branchNumber", condition: "equals", values: [branch], joinCondition: null },
          ],
          pagination: { itemsPerPage: limit, pageNumber: 1 },
        },
      });
      // ABC asks that items it lists as Inactive aren't shown.
      return (body.items ?? []).map(itemOf).filter((i) => i.item_number && i.active);
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

  /**
   * The items in a product family at a branch: the colors and sizes of one product (every
   * Timberline HDZ color the branch carries).
   */
  async family(familyId: string, branch: string): Promise<AbcItem[]> {
    const body = await this.call<{ items?: RawItem[] }>("/api/product/v1/search/items", {
      body: {
        filters: [
          { key: "productFamilyId", condition: "equals", values: [familyId], joinCondition: "and" },
          { key: "branchNumber", condition: "equals", values: [branch], joinCondition: null },
        ],
        pagination: { itemsPerPage: 60, pageNumber: 1 },
      },
    });
    return (body.items ?? []).map(itemOf).filter((i) => i.item_number && i.active);
  }

  /**
   * Items by their numbers, at a branch, in one search: their pictures, brands and colors for cards.
   * ABC's docs show one value per filter, so it may answer for some of them or none; whoever asks
   * looks the rest up one by one.
   */
  async itemsByNumber(numbers: readonly string[], branch: string): Promise<AbcItem[]> {
    const body = await this.call<{ items?: RawItem[] }>("/api/product/v1/search/items", {
      body: {
        filters: [
          { key: "itemNumber", condition: "equals", values: numbers, joinCondition: "and" },
          { key: "branchNumber", condition: "equals", values: [branch], joinCondition: null },
        ],
        pagination: { itemsPerPage: numbers.length, pageNumber: 1 },
      },
    });
    return (body.items ?? []).map(itemOf).filter((i) => i.item_number);
  }

  /**
   * One item in full: the lengths it's cut to when it's dimensional, its categories, specs and
   * family. Without `full`, only the item (its picture, brand and color), which ABC answers faster.
   */
  async item(itemNumber: string, full = true): Promise<AbcItemDetail> {
    const raw = await this.call<RawItem>(`/api/product/v1/items/${encodeURIComponent(itemNumber)}${full ? "?embed=variations&familyItems=true" : ""}`);
    const item = itemOf(raw);
    if (!item.item_number) throw new AbcProblem("ABC Supply doesn't have that item.", 404);
    const lengths = [...new Set((raw.dimensions?.variations ?? []).map((v) => lengthInFeet(v.length)).filter((n): n is number => n !== null))].sort((a, b) => a - b);
    const specs = (raw.specifications ?? []).flatMap((spec) => {
      const name = text(spec?.name) ?? text(spec?.code);
      const value = text(spec?.description);
      return name && value ? [{ name, value }] : [];
    });
    const familyItems = (raw.familyItems ?? []).flatMap((f) =>
      text(f?.itemNumber) && f.itemNumber!.trim() !== item.item_number
        ? [{ item_number: f.itemNumber!.trim(), name: text(f.itemDescription) ?? f.itemNumber!.trim(), color: colorOf(f.color ?? null) }]
        : [],
    );
    const about = text(raw.marketingDescription);
    return { ...item, lengths, about: about && about !== item.name ? about : null, path: pathOf(raw), specs, family_items: familyItems };
  }

  /**
   * What the account buys again and again: ABC's record of items invoiced to it at least twice in
   * the last 180 days, most often first, then anything else bought in the last 90.
   */
  async usual(billTo: string, branch: string): Promise<AbcUsualItem[]> {
    type Answer = { items?: Array<{ itemNumber?: string; itemDescription?: string; uom?: string; count?: number; isAvailableForBranch?: boolean }> };
    const query = `itemsPerPage=50&pageNumber=1&branchNumber=${encodeURIComponent(branch)}`;
    const account = encodeURIComponent(billTo);
    const [frequent, recent] = await Promise.all([
      this.call<Answer>(`/api/product/v1/items/${account}/frequents?${query}`),
      // Recent items only fill in after the frequent ones, so one ABC can't give isn't a reason to fail.
      this.call<Answer>(`/api/product/v1/items/${account}/recents?${query}`).catch(() => ({ items: [] }) as Answer),
    ]);
    const out = new Map<string, AbcUsualItem>();
    for (const raw of [...(frequent.items ?? []), ...(recent.items ?? [])]) {
      const number = text(raw.itemNumber);
      if (!number || out.has(number)) continue;
      // ABC sends the unit here as code and words ("PC - PIECE"); pricing takes only the code.
      const unit = uomOf(raw.uom);
      out.set(number, {
        item_number: number,
        name: text(raw.itemDescription) ?? number,
        uom: unit.code,
        uom_name: unit.name,
        count: Number(raw.count) > 0 ? Number(raw.count) : 0,
        at_branch: typeof raw.isAvailableForBranch === "boolean" ? raw.isAvailableForBranch : null,
      });
    }
    return [...out.values()];
  }

  /** ABC's picture of an item (its docs say a PNG up to 250 px; production sends larger JPEGs), or null when it has none. */
  async image(assetId: string, retried = false): Promise<{ body: ArrayBuffer; type: string } | null> {
    if (this.lane) await pace(this.lane);
    const res = await this.fetcher(`${ENVIRONMENTS[this.environment].api}/api/product/v1/items/${encodeURIComponent(assetId)}/images`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "image/png, image/*" },
      signal: providerTimeout(),
    }).catch(() => null);
    if (!res) throw new AbcProblem(NOT_REACHED, 502);
    if (res.status === 401 && this.renew && !retried) {
      this.token = await this.renew();
      return this.image(assetId, true);
    }
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw apiProblem(res.status, await res.text().catch(() => ""));
    const type = res.headers.get("Content-Type") ?? "image/png";
    if (!type.startsWith("image/")) return null;
    return { body: await res.arrayBuffer(), type };
  }

  /**
   * The account's prices at the branch, 50 lines at a time. A price of 0.00 is ABC's way of saying
   * the branch hasn't priced it. ABC's docs call requestId optional, but production turns a request
   * without one down (400, "required key [requestId] not found"); the sandbox doesn't.
   */
  async prices(shipTo: string, branch: string, lines: readonly AbcPriceLine[], purpose: "estimating" | "quoting" = "quoting"): Promise<Map<string, AbcPrice>> {
    const out = new Map<string, AbcPrice>();
    for (let i = 0; i < lines.length; i += PRICE_LINES) {
      const chunk = lines.slice(i, i + PRICE_LINES);
      const ask = () =>
        this.call<{ lines?: Array<{ id?: string; unitPrice?: number; status?: { code?: string; message?: string } }> }>("/api/pricing/v2/prices", {
          body: {
            requestId: `crewtavo-${crypto.randomUUID()}`,
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
          wait: PRICE_WAIT_MS,
        });
      const body = await firstAnswer(ask, PRICE_AGAIN_MS);
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
    bill_to: choice.account.bill_to ?? null,
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
  return { client: new AbcClient(settings.environment, fresh, fetcher, renew, companyId), settings };
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
  const next: AbcSettings = { ...settings, ship_to: account.number, ship_to_name: account.name, bill_to: account.bill_to ?? null, branch: branch.number, branch_name: branch.name, accounts };
  const { error } = await admin
    .from("integrations")
    .update({ settings: next as never, account_label: labelOf(next), external_account_id: next.ship_to })
    .match({ company_id: companyId, provider: "abc_supply" });
  if (error) throw new IntegrationError(error.message);
  return next;
}

/**
 * The bill-to account ABC keeps the account's usual items by. A connection made before the catalog
 * didn't keep it, so the accounts are asked for once and it's saved.
 */
export async function abcBillTo(admin: Db, companyId: string, client: AbcClient, settings: AbcSettings): Promise<string | null> {
  if (settings.bill_to !== undefined) return settings.bill_to;
  const accounts = await client.accounts();
  const billTo = accounts.find((a) => a.number === settings.ship_to)?.bill_to ?? null;
  const { error } = await admin.from("integrations").update({ settings: { ...settings, bill_to: billTo, accounts } as never }).match({ company_id: companyId, provider: "abc_supply" });
  if (error) throw new IntegrationError(error.message);
  return billTo;
}
