/**
 * Signing in with a code by text or by email (routes/signInCodes.ts, services/signInCodes.ts), against
 * a small stand-in for PostgREST, Supabase Auth, Twilio and Resend: fetch is stubbed, and tables live
 * in memory. The stand-in finds whose number or address it is and keeps codes the way the database
 * does; that the database really does (only the office's number or address, made-here sign-ins, one
 * use, 10 minutes, 5 tries, a code by one way stopping one by the other, two tries at once) is tested
 * in supabase/tests/sign_in_codes_test.sql and email_sign_in_codes_test.sql.
 */
import { emailKey, isPlaceholderEmail, isSubLogin, phoneE164, subLoginEmail, subLoginMark, subSettings, textsCodesTo } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { forgetMailbox } from "../src/lib/notify";
import {
  CODE_EXPIRED,
  CODE_WRONG,
  EMAIL_CODE_WRONG,
  EMAIL_PROBLEM,
  newSignInCode,
  PHONE_PROBLEM,
  signInCodeHash,
  signInEmailHash,
  signInPhoneHash,
  TOO_MANY_CODES,
  TOO_MANY_TRIES,
  TOO_MANY_WRONG,
  visitorBlock,
} from "../src/services/signInCodes";

const base: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  // The visitor's address comes from X-Real-IP, so each test can be someone else.
  CREWTAVO_VISITOR_IP: "x-real-ip",
};
const env: Env = { ...base, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "twilio-token", TWILIO_FROM_NUMBER: "+15405550000" };
/** An instance that can't text, and sends email through its own Resend account. */
const mailing: Env = { ...base, RESEND_API_KEY: "re_instance", EMAIL_FROM: "Crewtavo <codes@crewtavo.example>" };

const CO = "00000000-0000-4000-8000-0000000000a1";
const OTHER_CO = "00000000-0000-4000-8000-0000000000a2";
const OFFICE = "00000000-0000-4000-8000-000000000001";
const AL = "00000000-0000-4000-8000-000000000005";
const UMA = "00000000-0000-4000-8000-000000000006";
const DOT = "00000000-0000-4000-8000-000000000007";
const DAN = "00000000-0000-4000-8000-000000000008";
const GUS = "00000000-0000-4000-8000-000000000009";
const PIA = "00000000-0000-4000-8000-000000000010";
const TIA = "00000000-0000-4000-8000-000000000011";
const TOM = "00000000-0000-4000-8000-000000000012";
const APEX = "00000000-0000-4000-8000-0000000000b1";
const UNION = "00000000-0000-4000-8000-0000000000b2";
const DUP_ONE = "00000000-0000-4000-8000-0000000000b3";
const DUP_TWO = "00000000-0000-4000-8000-0000000000b4";
const GUTTER = "00000000-0000-4000-8000-0000000000b5";
const PAVERS = "00000000-0000-4000-8000-0000000000b6";
const TWIN_A = "00000000-0000-4000-8000-0000000000b7";
const TWIN_B = "00000000-0000-4000-8000-0000000000b8";

type Row = Record<string, any>;
interface Code {
  channel: string;
  user_id: string | null;
  address_hash: string;
  code_hash: string;
  ip_hash: string | null;
  attempts: number;
  expires_at: number;
  used_at: number | null;
  /** A newer code for the account at its other address stopped it: never right again, otherwise as a live one. */
  stopped_at?: number | null;
  created_at: number;
  /** The ask it was made in: one number or address's codes for each of its sign-ins, made at once. None: its own. */
  ask?: number;
}
interface World {
  companies: Row[];
  subcontractors: Row[];
  memberships: Row[];
  accounts: Record<string, { id: string; email: string; app_metadata: Record<string, unknown> }>;
  codes: Code[];
  /** Companies that send email from a mailbox of their own: their Resend key. */
  mailboxes: Record<string, string>;
  /** A mailbox's integrations status, when it isn't "connected". */
  mailboxStatus?: Record<string, string>;
  /** Attempts counted per rate limit key. */
  hits: Map<string, number>;
  /** Rate limits whose key matches are used up. */
  full?: RegExp;
  /** The rate limiter can't be reached. */
  limiterDown?: boolean;
  /** The rate limiter can't be reached for keys that match (and counts nothing for them). */
  limiterDownFor?: RegExp;
  /** What public.sub_sign_ins_for_phone answers, in place of working it out. */
  lookup?: Row[];
  /** Twilio refuses texts with this message. */
  twilioRefuses?: string;
  /** Resend refuses emails with this message. */
  resendRefuses?: string;
  /** Auth can't find accounts, or can't make sign-in links. */
  accountsDown?: boolean;
  linksDown?: boolean;
}

/**
 * Oscar Roofing, with Opal in the office and its subs who sign in with sign-ins made here: Apex
 * Roofing (Al), Union Jack Builders (Uma, a UK number, no email), Gutter Guys (Gus, whose account is
 * for his own address while the office keeps the business's) and Placeholder Pavers (Pia, no email:
 * the office's record has her placeholder). Dup One and Papa's Dup Two (Dot and Dan) share a number
 * and an address, as someone who subs for two businesses would; Twin A and Twin B, both Oscar's, share
 * another number and address.
 */
function oscar(): World {
  const mark = (company: string, sub: string) => ({ provider: "email", crewtavo_sub: subLoginMark(company, sub) });
  return {
    companies: [
      { id: CO, name: "Oscar Roofing", email: "office@oscar.test", settings: {} },
      { id: OTHER_CO, name: "Papa Paving", email: null, settings: {} },
    ],
    subcontractors: [
      { id: APEX, company_id: CO, name: "Apex Roofing", contact_name: "Al Apex", phone: "(540) 555-0101", email: "al@apex.test", active: true },
      { id: UNION, company_id: CO, name: "Union Jack Builders", contact_name: "Uma Union", phone: "+44 20 7946 0958", email: null, active: true },
      { id: DUP_ONE, company_id: CO, name: "Dup One", contact_name: null, phone: "540-555-0177", email: "dup@dup.test", active: true },
      { id: DUP_TWO, company_id: OTHER_CO, name: "Dup Two", contact_name: null, phone: "+1 540 555 0177", email: "DUP@dup.test", active: true },
      { id: GUTTER, company_id: CO, name: "Gutter Guys", contact_name: "Gus Gutter", phone: null, email: "office@gutterguys.test", active: true },
      { id: PAVERS, company_id: CO, name: "Placeholder Pavers", contact_name: "Pia", phone: null, email: subLoginEmail(PAVERS), active: true },
      { id: TWIN_A, company_id: CO, name: "Twin A", contact_name: null, phone: "540-555-0188", email: "twins@twins.test", active: true },
      { id: TWIN_B, company_id: CO, name: "Twin B", contact_name: null, phone: "540-555-0188", email: "twins@twins.test", active: true },
    ],
    memberships: [
      { company_id: CO, user_id: OFFICE, role: "office", subcontractor_id: null, active: true },
      { company_id: CO, user_id: AL, role: "subcontractor", subcontractor_id: APEX, active: true },
      { company_id: CO, user_id: UMA, role: "subcontractor", subcontractor_id: UNION, active: true },
      { company_id: CO, user_id: DOT, role: "subcontractor", subcontractor_id: DUP_ONE, active: true },
      { company_id: OTHER_CO, user_id: DAN, role: "subcontractor", subcontractor_id: DUP_TWO, active: true },
      { company_id: CO, user_id: GUS, role: "subcontractor", subcontractor_id: GUTTER, active: true },
      { company_id: CO, user_id: PIA, role: "subcontractor", subcontractor_id: PAVERS, active: true },
      { company_id: CO, user_id: TIA, role: "subcontractor", subcontractor_id: TWIN_A, active: true },
      { company_id: CO, user_id: TOM, role: "subcontractor", subcontractor_id: TWIN_B, active: true },
    ],
    accounts: {
      [OFFICE]: { id: OFFICE, email: "opal@oscar.test", app_metadata: { provider: "email" } },
      [AL]: { id: AL, email: "al@apex.test", app_metadata: mark(CO, APEX) },
      [UMA]: { id: UMA, email: subLoginEmail(UNION), app_metadata: mark(CO, UNION) },
      [DOT]: { id: DOT, email: "dot@dup.test", app_metadata: mark(CO, DUP_ONE) },
      [DAN]: { id: DAN, email: "dan@dup.test", app_metadata: mark(OTHER_CO, DUP_TWO) },
      [GUS]: { id: GUS, email: "gus@gutterguys.test", app_metadata: mark(CO, GUTTER) },
      [PIA]: { id: PIA, email: subLoginEmail(PAVERS), app_metadata: mark(CO, PAVERS) },
      [TIA]: { id: TIA, email: subLoginEmail(TWIN_A), app_metadata: mark(CO, TWIN_A) },
      [TOM]: { id: TOM, email: subLoginEmail(TWIN_B), app_metadata: mark(CO, TWIN_B) },
    },
    codes: [],
    mailboxes: {},
    hits: new Map(),
  };
}

interface Call {
  method: string;
  url: URL;
  path: string;
  body: any;
  auth: string | null;
}

/** The sign-ins a sub's record leads to, by the rules both lookups share. */
function signInsOf(world: World, subs: Row[]) {
  return subs.flatMap((s) => {
    const company = world.companies.find((c) => c.id === s.company_id)!;
    return world.memberships
      .filter((m) => m.company_id === s.company_id && m.subcontractor_id === s.id && m.active && m.role === "subcontractor")
      .filter((m) => isSubLogin(world.accounts[m.user_id]?.app_metadata, s.company_id, s.id))
      .filter((m) => !world.memberships.some((o) => o.user_id === m.user_id && o.company_id !== s.company_id))
      .map((m) => ({ user_id: m.user_id, company_id: s.company_id, subcontractor_id: s.id, company_name: company.name }));
  });
}

/** public.sub_sign_ins_for_phone, as the database answers it. */
function signInsFor(world: World, typed: string) {
  const e164 = phoneE164(typed);
  if (!e164) return [];
  return signInsOf(
    world,
    world.subcontractors.filter((s) => s.active && phoneE164(s.phone) === e164 && textsCodesTo(e164, subSettings(world.companies.find((c) => c.id === s.company_id)!.settings).sign_in_countries)),
  );
}

/** public.sub_sign_ins_for_email, as the database answers it: the office's address only, never a placeholder. */
function signInsForEmail(world: World, typed: string) {
  const key = emailKey(typed);
  if (!key || isPlaceholderEmail(key)) return [];
  return signInsOf(world, world.subcontractors.filter((s) => s.active && emailKey(s.email) === key));
}

/** Answers one PostgREST filter (eq, neq) the way PostgREST would. */
function matches(row: Row, key: string, value: string) {
  const [op, ...rest] = value.split(".");
  const arg = rest.join(".");
  if (op === "eq") return String(row[key]) === arg;
  if (op === "neq") return String(row[key]) !== arg;
  return true;
}

function serve(world: World) {
  const calls: Call[] = [];
  let clock = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies stay text
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const call: Call = { method, url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body, auth: headers.get("authorization") };
    calls.push(call);
    if (url.host === "api.twilio.com") return world.twilioRefuses ? Response.json({ message: world.twilioRefuses }, { status: 400 }) : Response.json({ sid: "SM1" });
    if (url.host === "api.resend.com") return world.resendRefuses ? Response.json({ message: world.resendRefuses }, { status: 422 }) : Response.json({ id: "email-1" });
    const user = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (user) {
      const account = world.accountsDown ? undefined : world.accounts[user[1]!];
      return account ? Response.json({ aud: "authenticated", ...account }) : Response.json({ msg: "User not found" }, { status: 404 });
    }
    if (url.pathname === "/auth/v1/admin/generate_link") {
      if (world.linksDown) return Response.json({ msg: "Database error" }, { status: 500 });
      const account = Object.values(world.accounts).find((a) => a.email === body.email);
      return Response.json({ ...account, action_link: "https://example.supabase.co/verify", hashed_token: `tok-${account?.id}`, verification_type: body.type, redirect_to: body.redirect_to });
    }
    const now = Date.now() + clock++;
    switch (call.path) {
      case "rpc/rate_limit_hit": {
        if (world.limiterDown || world.limiterDownFor?.test(body.p_key)) return Response.json({ message: "connection refused" }, { status: 503 });
        const hits = (world.hits.get(body.p_key) ?? 0) + 1;
        world.hits.set(body.p_key, hits);
        return Response.json(hits <= body.p_max && !world.full?.test(body.p_key));
      }
      case "rpc/sub_sign_ins_for_phone":
        return Response.json(world.lookup ?? signInsFor(world, body.p_phone));
      case "rpc/sub_sign_ins_for_email":
        return Response.json(world.lookup ?? signInsForEmail(world, body.p_email));
      case "rpc/sign_in_codes_save": {
        const users: string[] = body.p_users ?? [];
        for (const c of world.codes) {
          if (c.used_at || c.expires_at <= now) continue;
          // The address's older codes run out; the accounts' at their other addresses are stopped.
          if (c.channel === body.p_channel && c.address_hash === body.p_address_hash) c.expires_at = now;
          else if (c.user_id && users.includes(c.user_id) && !c.stopped_at) c.stopped_at = now;
        }
        const ask = now;
        (users.length ? users : [null]).forEach((user, i) =>
          world.codes.push({
            channel: body.p_channel, user_id: user, address_hash: body.p_address_hash, code_hash: body.p_code_hashes[i], ip_hash: body.p_ip_hash ?? null,
            attempts: 0, expires_at: now + 600_000, used_at: null, created_at: now, ask,
          }),
        );
        return new Response(null, { status: 204 });
      }
      case "rpc/sign_in_codes_check": {
        const same = (r: Code) => r.channel === body.p_channel && r.address_hash === body.p_address_hash;
        const newest = world.codes.filter(same).sort((a, b) => b.created_at - a.created_at)[0];
        const answer = (result: string, user_id: string | null = null) => Response.json([{ result, user_id }]);
        if (!newest) return answer("wrong");
        // The ask's codes stand or fall together (a code with no ask is its own).
        const askOf = (r: Code) => r.ask ?? r;
        const ask = world.codes.filter((r) => same(r) && askOf(r) === askOf(newest));
        // Only the visitor who asked hears more than "wrong".
        const asker = newest.ip_hash !== null && newest.ip_hash === body.p_ip_hash;
        const told = (result: string) => answer(asker ? result : "wrong");
        if (newest.expires_at <= now) return told("expired");
        if (ask.some((r) => r.used_at)) return answer("wrong");
        const tries = Math.max(...ask.map((r) => r.attempts));
        if (tries >= 5) return told("dead");
        const today = (rows: Code[]) => rows.filter((r) => r.created_at > now - 86_400_000);
        const wrongToday = (rows: Code[]) => today(rows).reduce((sum, r) => sum + r.attempts - (r.used_at ? 1 : 0), 0);
        // An ask's tries are counted once for the address.
        const asks = [...new Set(today(world.codes.filter(same)).map(askOf))];
        const addressWrong = asks.reduce<number>((sum, a) => wrongToday(world.codes.filter((r) => same(r) && askOf(r) === a).slice(0, 1)) + sum, 0);
        // Only the address's own 15 says so; the account's stop a right code, as a wrong one.
        if (addressWrong >= 15) return told("locked");
        const users: string[] = body.p_users ?? [];
        const right = ask.find((c) => {
          const i = users.indexOf(c.user_id ?? "");
          return i >= 0 && c.code_hash === body.p_code_hashes[i] && !c.stopped_at && wrongToday(world.codes.filter((r) => r.user_id === c.user_id)) < 15;
        });
        for (const c of ask) {
          c.attempts++;
          if (right) c.used_at = now;
        }
        return right ? answer("ok", right.user_id) : tries + 1 >= 5 ? told("dead") : answer("wrong");
      }
    }
    // The tables sending email reads: the company's mailbox, the company and the sub.
    const tables: Record<string, () => Promise<Row[]>> = {
      integrations: async () =>
        Object.keys(world.mailboxes).map((id) => ({ company_id: id, provider: "email", status: world.mailboxStatus?.[id] ?? "connected", settings: { preset: "resend", kind: "resend", from_email: "office@oscar.test", from_name: null } })),
      integration_secrets: async () =>
        Promise.all(Object.entries(world.mailboxes).map(async ([id, key]) => ({ company_id: id, provider: "email", ciphertext: await encryptJson(base, { api_key: key }) }))),
      companies: async () => world.companies,
      subcontractors: async () => world.subcontractors,
    };
    if (method === "GET" && tables[call.path]) {
      const filters = [...url.searchParams].filter(([k]) => !["select", "limit", "order"].includes(k));
      const rows = (await tables[call.path]!()).filter((r) => filters.every(([k, v]) => matches(r, k, v)));
      if ((headers.get("accept") ?? "").includes("vnd.pgrst.object")) return rows.length ? Response.json(rows[0]) : Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 });
      return Response.json(rows);
    }
    throw new Error(`unexpected ${call.method} ${url}`);
  });
  const texts = () => calls.filter((c) => c.url.host === "api.twilio.com").map((c) => Object.fromEntries(new URLSearchParams(c.body as string)));
  const emails = () => calls.filter((c) => c.url.host === "api.resend.com").map((c) => ({ key: c.auth?.replace(/^Bearer /, ""), ...c.body }));
  const links = () => calls.filter((c) => c.url.pathname === "/auth/v1/admin/generate_link").map((c) => c.body);
  const limits = () =>
    calls.filter((c) => c.path === "rpc/rate_limit_hit").map((c) => [c.body.p_key.replace(/[0-9a-f]{64}/, c.body.p_key.startsWith("email-code") ? "<address>" : "<number>"), c.body.p_max, c.body.p_window_seconds]);
  return { calls, texts, emails, links, limits };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Mailboxes are remembered for a minute; each test has its own.
  forgetMailbox(CO);
  forgetMailbox(OTHER_CO);
});

const post = (path: string, body: unknown, e: Env = env, ip = "203.0.113.7") =>
  app.request(`/api/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": ip }, body: JSON.stringify(body) }, e);
const ask = (phone: string, e?: Env, ip?: string) => post("text-code", { phone }, e, ip);
const verify = (phone: string, code: string, e?: Env, ip?: string) => post("text-code/verify", { phone, code }, e, ip);
const askEmail = (email: string, e: Env = mailing, ip?: string) => post("email-code", { email }, e, ip);
const verifyEmail = (email: string, code: string, e: Env = mailing, ip?: string) => post("email-code/verify", { email, code }, e, ip);
/** Lets work after the answer (sending) run, for tests that check nothing went out. */
const settle = () => new Promise((r) => setTimeout(r, 20));

/** Asks for a code (Al's, unless another number) and reads it off the text. */
async function codeFor(sent: ReturnType<typeof serve>, phone = "540-555-0101") {
  const before = sent.texts().length;
  expect(await (await ask(phone)).json()).toEqual({ sent: true });
  await vi.waitFor(() => expect(sent.texts()).toHaveLength(before + 1));
  return sent.texts().at(-1)!.Body!.slice(0, 6);
}

/** Asks for a code by email (Al's, unless another address) and reads it off the email. */
async function emailCodeFor(sent: ReturnType<typeof serve>, email = "al@apex.test", e: Env = mailing, ip?: string) {
  const before = sent.emails().length;
  expect(await (await askEmail(email, e, ip)).json()).toEqual({ sent: true });
  await vi.waitFor(() => expect(sent.emails()).toHaveLength(before + 1));
  return /\n\n(\d{6})\n\n/.exec(sent.emails().at(-1)!.text)![1]!;
}

// ===== Asking for a code ========================================================================

describe("asking for a code by text", () => {
  it("texts a sub's sign-in a code from the instance's number", async () => {
    const world = oscar();
    const sent = serve(world);
    const code = await codeFor(sent, "(540) 555 0101");
    expect(sent.texts()).toEqual([
      {
        To: "+15405550101",
        From: "+15405550000",
        Body: `${code} is your sign-in code for Oscar Roofing on Crewtavo. It runs out in 10 minutes. If you didn't ask for it, ignore this text.`,
      },
    ]);
    expect(code).toMatch(/^\d{6}$/);
    // Kept as hashes, by text: the number, the code (for Al's account) and the visitor's address, never as they are.
    expect(world.codes).toEqual([
      expect.objectContaining({ channel: "text", user_id: AL, address_hash: await signInPhoneHash(env, "+15405550101"), code_hash: await signInCodeHash(env, AL, code), ip_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
    const save = sent.calls.find((c) => c.path === "rpc/sign_in_codes_save")!;
    expect(JSON.stringify(save.body)).not.toMatch(/5405550101|203\.0\.113\.7|"\d{6}"/);
  });

  it("answers the same for a number with no sign-in, and texts nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = oscar();
    const sent = serve(world);
    const known = await ask("540-555-0101");
    await vi.waitFor(() => expect(sent.texts()).toHaveLength(1));
    // Nobody's; a UK sub's while the company hasn't added the UK; one on two of Oscar's subs' sign-ins.
    for (const phone of ["540-555-0199", "+44 20 7946 0958", "540-555-0188"]) {
      const res = await ask(phone, env, `198.51.100.${phone.length}`);
      expect([res.status, await res.json()], phone).toEqual([known.status, { sent: true }]);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.texts()).toHaveLength(1);
    expect(known.status).toBe(200);
    // Each still gets a code row, with nobody's account and a code nobody has.
    expect(world.codes.map((c) => c.user_id)).toEqual([AL, null, null, null]);
    // The operator hears about the number on two of one business's sign-ins, without the number.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/on 2 sub sign-ins at one business/);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/555|0188/);
  });

  it("texts a code for each business when the number is on two businesses' sub sign-ins, and each code signs in to its own", async () => {
    const world = oscar();
    const sent = serve(world);
    expect(await (await ask("540-555-0177")).json()).toEqual({ sent: true });
    await vi.waitFor(() => expect(sent.texts()).toHaveLength(2));
    const [oscars, papas] = ["Oscar Roofing", "Papa Paving"].map((name) => sent.texts().find((t) => t.Body!.includes(`for ${name} on Crewtavo`))!.Body!.slice(0, 6));
    expect(oscars).toMatch(/^\d{6}$/);
    expect(papas).not.toBe(oscars);
    // One ask: a code for each sign-in, each tied to its own account.
    expect(world.codes.map((c) => c.user_id).sort()).toEqual([DOT, DAN].sort());
    expect(new Set(world.codes.map((c) => c.ask)).size).toBe(1);
    expect(await (await verify("540-555-0177", papas!)).json()).toEqual({ token_hash: `tok-${DAN}`, type: "magiclink" });
    // One right code uses the ask: the other business's code doesn't work after it.
    expect((await (await verify("540-555-0177", oscars!)).json()).error).toBe(CODE_WRONG);
    expect(sent.links()).toEqual([expect.objectContaining({ email: "dan@dup.test" })]);
  });

  it("texts other countries' numbers once the company adds them", async () => {
    const world = oscar();
    world.companies[0]!.settings = { subs: { sign_in_countries: ["44"] } };
    const sent = serve(world);
    expect(await (await ask("+44 20 7946 0958")).json()).toEqual({ sent: true });
    await vi.waitFor(() => expect(sent.texts()).toHaveLength(1));
    expect(sent.texts()[0]!.To).toBe("+442079460958");
  });

  it("says so when the instance can't text, which says nothing about the number", async () => {
    const sent = serve(oscar());
    for (const phone of ["540-555-0101", "540-555-0199"]) {
      const res = await ask(phone, base);
      expect([res.status, await res.json()]).toEqual([200, { sent: false, reason: "sms_off" }]);
    }
    expect(sent.calls).toEqual([]);
  });

  it("wants a whole phone number", async () => {
    const sent = serve(oscar());
    for (const phone of ["555-0101", "call me", ""]) {
      const res = await ask(phone);
      expect(res.status, phone).toBe(400);
      if (phone) expect((await res.json()).error).toBe(PHONE_PROBLEM);
    }
    expect(sent.calls).toEqual([]);
  });

  it("is limited per visitor and per number, and texting for the whole instance", async () => {
    const sent = serve(oscar());
    await ask("540-555-0199");
    const perAsk = [
      ["text-code:ip:203.0.113.7", 10, 3600],
      ["text-code:phone:<number>", 3, 900],
      ["text-code:phone-day:<number>", 8, 86400],
    ];
    // A number with no sign-in sends nothing, so it isn't counted against the instance's texts.
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.limits()).toEqual(perAsk);
    // A sub's number is, after the answer, as its text goes out.
    await codeFor(sent);
    expect(sent.limits()).toEqual([...perAsk, ...perAsk, ["text-code:all", 200, 3600]]);
  });

  it("counts an IPv6 visitor by their /64, which a phone's addresses change within", async () => {
    const sent = serve(oscar());
    expect(visitorBlock("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1234:5678::/64");
    expect(visitorBlock("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(visitorBlock("2001:0db8:0001::")).toBe("2001:db8:1:0::/64");
    expect(visitorBlock("::ffff:1.2.3.4")).toBe("0:0:0:0::/64");
    expect(visitorBlock("203.0.113.7")).toBe("203.0.113.7");
    for (let i = 0; i < 10; i++) expect((await ask(`540-555-02${String(i).padStart(2, "0")}`, env, `2001:db8:1:2::${i + 1}`)).status).toBe(200);
    expect((await ask("540-555-0199", env, "2001:db8:1:2:ffff::9")).status).toBe(429);
    expect((await ask("540-555-0199", env, "2001:db8:1:3::1")).status).toBe(200);
    expect(sent.limits()[0]).toEqual(["text-code:ip:2001:db8:1:2::/64", 10, 3600]);
  });

  it("refuses a fourth code for a number within 15 minutes, from anywhere, without texting", async () => {
    const world = oscar();
    const sent = serve(world);
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) expect((await ask("540-555-0101", env, ip)).status).toBe(200);
    await vi.waitFor(() => expect(sent.texts()).toHaveLength(3));
    const res = await ask("(540) 555-0101", env, "203.0.113.4");
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^Too many codes/);
    expect(world.codes).toHaveLength(3);
    // The same for a number with no sign-in.
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) expect((await ask("540-555-0199", env, ip)).status).toBe(200);
    expect((await ask("540-555-0199", env, "203.0.113.4")).status).toBe(429);
  });

  it("refuses an eleventh ask from one visitor in an hour, whatever the number", async () => {
    const sent = serve(oscar());
    for (let i = 0; i < 10; i++) expect((await ask(`540-555-02${String(i).padStart(2, "0")}`)).status).toBe(200);
    expect((await ask("540-555-0101")).status).toBe(429);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.texts()).toEqual([]);
  });

  it("refuses once a number has had its 8 codes for the day", async () => {
    const world = oscar();
    world.full = /^text-code:phone-day:/;
    const sent = serve(world);
    expect((await ask("540-555-0101")).status).toBe(429);
    expect(world.codes).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.texts()).toEqual([]);
  });

  it("sends no more texts once the instance has sent its 200 for the hour, without saying so", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    world.full = /^text-code:all$/;
    const sent = serve(world);
    const res = await ask("540-555-0101");
    expect([res.status, await res.json()]).toEqual([200, { sent: true }]);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/hourly limit on code texts/)));
    expect(sent.texts()).toEqual([]);
    // The code is kept as usual, so trying it answers as any other.
    expect(world.codes).toHaveLength(1);
  });

  it("doesn't let asks for numbers with no sign-in use up the instance's texts", async () => {
    const world = oscar();
    const sent = serve(world);
    // 200 asks for made-up numbers, from 20 visitors.
    for (let i = 0; i < 200; i++) expect((await ask(`540-555-${1000 + i}`, env, `198.51.100.${Math.floor(i / 10)}`)).status).toBe(200);
    expect(world.hits.get("text-code:all") ?? 0).toBe(0);
    // A sub still gets their code.
    const res = await ask("540-555-0101", env, "192.0.2.50");
    expect(await res.json()).toEqual({ sent: true });
    await vi.waitFor(() => expect(sent.texts()).toHaveLength(1));
  });

  it("keeps the number out of the log when a text doesn't go out", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    world.twilioRefuses = "The 'To' number +15405550101 is not a valid phone number.";
    serve(world);
    expect(await (await ask("540-555-0101")).json()).toEqual({ sent: true });
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    const logged = error.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(logged).toContain("a code didn't go out");
    expect(logged).toContain("(number)");
    expect(logged).not.toMatch(/5405550101|555/);
  });

  it("sends nothing when the instance's hourly limit on texts can't be counted, without saying so", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    world.limiterDownFor = /^text-code:all$/;
    const sent = serve(world);
    const res = await ask("540-555-0101");
    expect([res.status, await res.json()]).toEqual([200, { sent: true }]);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/hourly limit on code texts/)));
    await settle();
    expect(sent.texts()).toEqual([]);
    expect(world.codes).toHaveLength(1);
  });

  it("refuses when the limits can't be counted, since texts cost money", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    world.limiterDown = true;
    const sent = serve(world);
    expect((await ask("540-555-0101")).status).toBe(429);
    expect(world.codes).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.texts()).toEqual([]);
  });

  it("makes six-digit codes, every one as likely", () => {
    const codes = Array.from({ length: 2000 }, () => newSignInCode());
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(new Set(codes).size).toBeGreaterThan(1990);
    // Leading zeros happen (about 1 in 10).
    expect(codes.filter((c) => c.startsWith("0")).length).toBeGreaterThan(100);
  });
});

// ===== Typing it in =============================================================================

describe("signing in with the code", () => {
  it("trades the right code for a one-time sign-in for that account", async () => {
    const sent = serve(oscar());
    const code = await codeFor(sent);
    const res = await verify("+1 540.555.0101", code);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token_hash: `tok-${AL}`, type: "magiclink" });
    expect(sent.links()).toEqual([expect.objectContaining({ type: "magiclink", email: "al@apex.test" })]);
  });

  it("signs in a sub with no email, by their placeholder address", async () => {
    const world = oscar();
    world.companies[0]!.settings = { subs: { sign_in_countries: ["44"] } };
    const sent = serve(world);
    const code = await codeFor(sent, "+44 20 7946 0958");
    const res = await verify("0044 20 7946 0958", code);
    expect(await res.json()).toEqual({ token_hash: `tok-${UMA}`, type: "magiclink" });
    expect(sent.links()).toEqual([expect.objectContaining({ type: "magiclink", email: `sub-${UNION}@subs.invalid` })]);
  });

  it("refuses a wrong code, without saying anything about the number", async () => {
    const sent = serve(oscar());
    const code = await codeFor(sent);
    const wrong = code === "000000" ? "000001" : "000000";
    for (const phone of ["540-555-0101", "540-555-0199"]) {
      const res = await verify(phone, wrong);
      expect([res.status, (await res.json()).error], phone).toEqual([400, CODE_WRONG]);
    }
    expect(sent.links()).toEqual([]);
  });

  it("refuses a code that has run out, as it would for a number with no sign-in", async () => {
    const world = oscar();
    const sent = serve(world);
    const code = await codeFor(sent);
    await ask("540-555-0199");
    for (const c of world.codes) c.expires_at = Date.now() - 1000;
    for (const [phone, typed] of [["540-555-0101", code], ["540-555-0199", "123456"]] as const) {
      const res = await verify(phone, typed);
      expect([res.status, (await res.json()).error], phone).toEqual([400, CODE_EXPIRED]);
      // Only to the visitor who asked: to anyone else it isn't right, so trying a number doesn't
      // show that someone asked for a code for it.
      const other = await verify(phone, typed, env, "198.51.100.77");
      expect([other.status, (await other.json()).error], phone).toEqual([400, CODE_WRONG]);
    }
    expect(sent.links()).toEqual([]);
  });

  it("says to ask for a new code once 5 wrong tries have used it up", async () => {
    const sent = serve(oscar());
    const code = await codeFor(sent);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 4; i++) expect((await (await verify("540-555-0101", wrong)).json()).error).toBe(CODE_WRONG);
    expect((await (await verify("540-555-0101", wrong)).json()).error).toBe(CODE_EXPIRED);
    const right = await verify("540-555-0101", code);
    expect([right.status, (await right.json()).error]).toEqual([400, CODE_EXPIRED]);
    expect((await (await verify("540-555-0101", code, env, "198.51.100.77")).json()).error).toBe(CODE_WRONG);
    expect(sent.links()).toEqual([]);
  });

  it("stops after 15 wrong tries in a day, however many codes are asked for", async () => {
    const world = oscar();
    const sent = serve(world);
    const phoneHash = await signInPhoneHash(env, "+15405550101");
    // Three codes used up already today.
    for (let i = 0; i < 3; i++) world.codes.push({ channel: "text", user_id: AL, address_hash: phoneHash, code_hash: "x".repeat(64), ip_hash: null, attempts: 5, expires_at: Date.now(), used_at: null, created_at: Date.now() - 60_000 });
    const code = await codeFor(sent);
    const res = await verify("540-555-0101", code);
    expect([res.status, (await res.json()).error]).toEqual([429, TOO_MANY_WRONG]);
    expect((await (await verify("540-555-0101", code, env, "198.51.100.77")).json()).error).toBe(CODE_WRONG);
    expect(sent.links()).toEqual([]);
  });

  it("works once", async () => {
    const sent = serve(oscar());
    const code = await codeFor(sent);
    expect((await verify("540-555-0101", code)).status).toBe(200);
    const again = await verify("540-555-0101", code);
    expect([again.status, (await again.json()).error]).toEqual([400, CODE_WRONG]);
    expect(sent.links()).toHaveLength(1);
  });

  it("stops working when the office turns the sub or their sign-in off", async () => {
    for (const turnOff of [(w: World) => (w.subcontractors[0]!.active = false), (w: World) => (w.memberships[1]!.active = false)]) {
      const world = oscar();
      const sent = serve(world);
      const code = await codeFor(sent);
      turnOff(world);
      const res = await verify("540-555-0101", code);
      expect([res.status, (await res.json()).error]).toEqual([400, CODE_WRONG]);
      expect(sent.links()).toEqual([]);
    }
  });

  it("doesn't sign in an account whose own record says it isn't the sub's sign-in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    const sent = serve(world);
    const code = await codeFor(sent);
    // The database still names Al's sign-in, but his account no longer carries Apex's mark.
    world.lookup = [{ user_id: AL, company_id: CO, subcontractor_id: APEX, company_name: "Oscar Roofing" }];
    world.accounts[AL]!.app_metadata = { provider: "email" };
    const res = await verify("540-555-0101", code);
    expect([res.status, (await res.json()).error]).toEqual([400, CODE_WRONG]);
    expect(sent.links()).toEqual([]);
  });

  it("answers plainly when the account can't be found or the sign-in can't be made", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const down of ["accountsDown", "linksDown"] as const) {
      const world = oscar();
      const sent = serve(world);
      const code = await codeFor(sent);
      world[down] = true;
      const res = await verify("540-555-0101", code);
      expect([res.status, (await res.json()).error], down).toEqual([500, "Couldn't sign you in. Ask for a new code and try again."]);
    }
    expect(error).toHaveBeenCalled();
  });

  it("is limited per visitor and per number, and refuses when the limits can't be counted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    const sent = serve(world);
    const tries = () => sent.calls.filter((c) => c.path === "rpc/sign_in_codes_check").length;
    await verify("540-555-0101", "123456");
    expect(sent.limits()).toEqual([
      ["text-code-check:ip:203.0.113.7", 20, 3600],
      ["text-code-check:phone:<number>", 10, 900],
    ]);
    for (let i = 0; i < 9; i++) await verify("540-555-0101", "123456", env, `198.51.100.${i}`);
    expect(tries()).toBe(10);
    const res = await verify("540-555-0101", "123456", env, "198.51.100.99");
    expect([res.status, (await res.json()).error]).toEqual([429, "Too many tries. Wait a while and try again."]);
    world.limiterDown = true;
    expect((await verify("540-555-0102", "123456", env, "192.0.2.1")).status).toBe(429);
    expect(tries()).toBe(10);
  });
});

// ===== Asking for a code by email ===============================================================

describe("asking for a code by email", () => {
  it("emails a sub's sign-in a code, the way the company's other email goes out", async () => {
    const world = oscar();
    const sent = serve(world);
    const code = await emailCodeFor(sent, "  Al@Apex.TEST ");
    expect(code).toMatch(/^\d{6}$/);
    // Through the instance's sender (the company has no mailbox of its own), to the address the office keeps.
    expect(sent.emails()).toEqual([
      expect.objectContaining({
        key: "re_instance",
        from: "Crewtavo <codes@crewtavo.example>",
        to: ["al@apex.test"],
        reply_to: "office@oscar.test",
        subject: "Your sign-in code for Oscar Roofing",
        text: `Hi Al,\n\nHere's your code to sign in to Oscar Roofing on Crewtavo:\n\n${code}\n\nIt runs out in 10 minutes. If you didn't ask for it, ignore this email.\n\nThanks,\nOscar Roofing`,
      }),
    ]);
    // The code is shown large, on its own.
    expect(sent.emails()[0]!.html).toContain(`font-size:32px;font-weight:800;letter-spacing:0.2em;font-variant-numeric:tabular-nums">${code}</p>`);
    expect(sent.texts()).toEqual([]);
    // Kept as hashes, by email: the address (trimmed and lower-cased), the code (for Al's account) and the visitor's address.
    expect(world.codes).toEqual([
      expect.objectContaining({
        channel: "email", user_id: AL, address_hash: await signInEmailHash(mailing, "al@apex.test"), code_hash: await signInCodeHash(mailing, AL, code), ip_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    const save = sent.calls.find((c) => c.path === "rpc/sign_in_codes_save")!;
    expect(JSON.stringify(save.body)).not.toMatch(/apex|203\.0\.113\.7|"\d{6}"/i);
  });

  it("sends from the company's own mailbox when it has one, before the instance's sender", async () => {
    for (const e of [base, mailing]) {
      const world = oscar();
      world.mailboxes[CO] = "re_oscar_own";
      const sent = serve(world);
      await emailCodeFor(sent, "al@apex.test", e);
      expect(sent.emails()).toEqual([expect.objectContaining({ key: "re_oscar_own", from: '"Oscar Roofing" <office@oscar.test>', to: ["al@apex.test"], subject: "Your sign-in code for Oscar Roofing" })]);
      forgetMailbox(CO);
    }
  });

  it("answers the same for an address with no sign-in, and emails nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = oscar();
    const sent = serve(world);
    const known = await askEmail("al@apex.test");
    await vi.waitFor(() => expect(sent.emails()).toHaveLength(1));
    // Nobody's; the office's own; the address on Gus's account, not the one the office keeps; Pia's
    // and Uma's placeholders; one on two of Oscar's subs' sign-ins.
    const others = ["nobody@example.com", "opal@oscar.test", "gus@gutterguys.test", subLoginEmail(PAVERS), subLoginEmail(UNION), "twins@twins.test"];
    for (const [i, email] of others.entries()) {
      const res = await askEmail(email, mailing, `198.51.100.${i}`);
      expect([res.status, await res.json()], email).toEqual([known.status, { sent: true }]);
    }
    await settle();
    expect(sent.emails()).toHaveLength(1);
    expect(known.status).toBe(200);
    // Each still gets a code row, with nobody's account and a code nobody has.
    expect(world.codes.map((c) => [c.channel, c.user_id])).toEqual([["email", AL], ...others.map(() => ["email", null])]);
    // The operator hears about the address on two of one business's sign-ins, without the address.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^Email sign-in: an email address is on 2 sub sign-ins at one business/);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/twins@/i);
  });

  it("emails a code from each business when the address is on two businesses' sub sign-ins, and each code signs in to its own", async () => {
    const world = oscar();
    world.mailboxes[OTHER_CO] = "re_papa_own";
    const sent = serve(world);
    expect(await (await askEmail("dup@dup.test")).json()).toEqual({ sent: true });
    await vi.waitFor(() => expect(sent.emails()).toHaveLength(2));
    const codeIn = (subject: string) => /\n\n(\d{6})\n\n/.exec(sent.emails().find((e) => e.subject === subject)!.text)![1]!;
    const oscars = codeIn("Your sign-in code for Oscar Roofing");
    const papas = codeIn("Your sign-in code for Papa Paving");
    expect(papas).not.toBe(oscars);
    // Each the way its own business's email goes out.
    expect(sent.emails().find((e) => e.subject === "Your sign-in code for Papa Paving")!.key).toBe("re_papa_own");
    expect(await (await verifyEmail("dup@dup.test", oscars)).json()).toEqual({ token_hash: `tok-${DOT}`, type: "magiclink" });
  });

  it("sends nothing for a company with no way to send email, answers the same, and keeps the code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = oscar();
    const sent = serve(world);
    // No sender on the instance, and no mailbox for Oscar.
    const res = await askEmail("al@apex.test", base);
    expect([res.status, await res.json()]).toEqual([200, { sent: true }]);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringMatching(/has no way to send email yet/)));
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/al@|apex/i);
    expect(sent.emails()).toEqual([]);
    expect(world.codes).toEqual([expect.objectContaining({ channel: "email", user_id: AL })]);
    // Nothing went out, so nothing is counted against the instance's emails.
    expect(world.hits.get("email-code:all") ?? 0).toBe(0);
  });

  it("wants a whole email address", async () => {
    const sent = serve(oscar());
    for (const email of ["al@apex", "Al at Apex", "al apex@apex.test", "@apex.test", ""]) {
      const res = await askEmail(email);
      expect(res.status, email).toBe(400);
      if (email) expect((await res.json()).error).toBe(EMAIL_PROBLEM);
    }
    expect(sent.calls).toEqual([]);
  });

  it("is limited per visitor and per address, and sending for the whole instance", async () => {
    const sent = serve(oscar());
    await askEmail("nobody@example.com");
    const perAsk = [
      ["email-code:ip:203.0.113.7", 10, 3600],
      ["email-code:email:<address>", 3, 900],
      ["email-code:email-day:<address>", 8, 86400],
    ];
    // An address with no sign-in sends nothing, so it isn't counted against the instance's emails.
    await settle();
    expect(sent.limits()).toEqual(perAsk);
    // A sub's address is, after the answer, as its email goes out.
    await emailCodeFor(sent);
    expect(sent.limits()).toEqual([...perAsk, ...perAsk, ["email-code:all", 200, 3600]]);
  });

  it("counts an IPv6 visitor by their /64", async () => {
    const sent = serve(oscar());
    for (let i = 0; i < 10; i++) expect((await askEmail(`someone${i}@example.com`, mailing, `2001:db8:1:2::${i + 1}`)).status).toBe(200);
    expect((await askEmail("someone@example.com", mailing, "2001:db8:1:2:ffff::9")).status).toBe(429);
    expect((await askEmail("someone@example.com", mailing, "2001:db8:1:3::1")).status).toBe(200);
    expect(sent.limits()[0]).toEqual(["email-code:ip:2001:db8:1:2::/64", 10, 3600]);
  });

  it("refuses a fourth code for an address within 15 minutes, from anywhere, without emailing", async () => {
    const world = oscar();
    const sent = serve(world);
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) expect((await askEmail("al@apex.test", mailing, ip)).status).toBe(200);
    await vi.waitFor(() => expect(sent.emails()).toHaveLength(3));
    const res = await askEmail("AL@apex.test ", mailing, "203.0.113.4");
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/^Too many codes/);
    expect(world.codes).toHaveLength(3);
    // The same for an address with no sign-in.
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) expect((await askEmail("nobody@example.com", mailing, ip)).status).toBe(200);
    expect((await askEmail("nobody@example.com", mailing, "203.0.113.4")).status).toBe(429);
  });

  it("refuses an eleventh ask from one visitor in an hour, whatever the address", async () => {
    const sent = serve(oscar());
    for (let i = 0; i < 10; i++) expect((await askEmail(`someone${i}@example.com`)).status).toBe(200);
    expect((await askEmail("al@apex.test")).status).toBe(429);
    await settle();
    expect(sent.emails()).toEqual([]);
  });

  it("refuses once an address has had its 8 codes for the day", async () => {
    const world = oscar();
    world.full = /^email-code:email-day:/;
    const sent = serve(world);
    expect((await askEmail("al@apex.test")).status).toBe(429);
    expect(world.codes).toEqual([]);
    await settle();
    expect(sent.emails()).toEqual([]);
  });

  it("sends no more emails once the instance has sent its 200 for the hour, without saying so", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    world.full = /^email-code:all$/;
    const sent = serve(world);
    const res = await askEmail("al@apex.test");
    expect([res.status, await res.json()]).toEqual([200, { sent: true }]);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/hourly limit on code emails/)));
    expect(sent.emails()).toEqual([]);
    // The code is kept as usual, so trying it answers as any other.
    expect(world.codes).toHaveLength(1);
  });

  it("doesn't let asks for addresses with no sign-in use up the instance's emails", async () => {
    const world = oscar();
    const sent = serve(world);
    // 200 asks for made-up addresses, from 20 visitors.
    for (let i = 0; i < 200; i++) expect((await askEmail(`someone${i}@example.com`, mailing, `198.51.100.${Math.floor(i / 10)}`)).status).toBe(200);
    expect(world.hits.get("email-code:all") ?? 0).toBe(0);
    // A sub still gets their code.
    const res = await askEmail("al@apex.test", mailing, "192.0.2.50");
    expect(await res.json()).toEqual({ sent: true });
    await vi.waitFor(() => expect(sent.emails()).toHaveLength(1));
  });

  it("keeps the address out of the log when an email doesn't go out", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    // Resend's own words naming the address (an invalid `to` is said in the app's words, with none).
    world.resendRefuses = "The recipient al@apex.test is on the suppression list.";
    serve(world);
    expect(await (await askEmail("al@apex.test")).json()).toEqual({ sent: true });
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    const logged = error.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(logged).toContain("Email sign-in: a code didn't go out");
    expect(logged).toContain("(address)");
    expect(logged).not.toMatch(/al@|apex\.test/);
  });

  it("refuses when the limits can't be counted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    world.limiterDown = true;
    const sent = serve(world);
    expect((await askEmail("al@apex.test")).status).toBe(429);
    expect(world.codes).toEqual([]);
    await settle();
    expect(sent.emails()).toEqual([]);
  });

  it("refuses when any one of the limits on asking can't be counted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const down of [/^email-code:email:/, /^email-code:email-day:/]) {
      const world = oscar();
      world.limiterDownFor = down;
      const sent = serve(world);
      const res = await askEmail("al@apex.test");
      expect([res.status, (await res.json()).error], String(down)).toEqual([429, TOO_MANY_CODES]);
      expect(world.codes).toEqual([]);
      await settle();
      expect(sent.emails()).toEqual([]);
    }
  });

  it("sends nothing when the instance's hourly limit on emails can't be counted, without saying so", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    world.limiterDownFor = /^email-code:all$/;
    const sent = serve(world);
    const res = await askEmail("al@apex.test");
    expect([res.status, await res.json()]).toEqual([200, { sent: true }]);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/hourly limit on code emails/)));
    await settle();
    expect(sent.emails()).toEqual([]);
    expect(world.codes).toHaveLength(1);
  });

  it("stops a code by text when one is asked for by email, and the other way round, saying only that it isn't right", async () => {
    const both: Env = { ...env, RESEND_API_KEY: "re_instance", EMAIL_FROM: "Crewtavo <codes@crewtavo.example>" };
    const sent = serve(oscar());
    const texted = await codeFor(sent);
    const emailed = await emailCodeFor(sent, "al@apex.test", both);
    // "Run out" here would tell the visitor that the number and the address are one sub's.
    expect((await (await verify("540-555-0101", texted)).json()).error).toBe(CODE_WRONG);
    const texted2 = await codeFor(sent);
    expect((await (await verifyEmail("al@apex.test", emailed, both)).json()).error).toBe(EMAIL_CODE_WRONG);
    expect(await (await verify("540-555-0101", texted2)).json()).toEqual({ token_hash: `tok-${AL}`, type: "magiclink" });
  });

  it("answers a number's tries the same whether or not the address asked for after it is the same sub's", async () => {
    const both: Env = { ...env, RESEND_API_KEY: "re_instance", EMAIL_FROM: "Crewtavo <codes@crewtavo.example>" };
    const world = oscar();
    world.subcontractors.find((s) => s.id === UNION)!.email = "uma@union.test";
    const sent = serve(world);
    // One visitor: Al's number, then Al's address; the twins' number (on two of Oscar's sign-ins), then Uma's address.
    const answers = async (phone: string, email: string, ip: string) => {
      expect((await ask(phone, both, ip)).status).toBe(200);
      expect((await askEmail(email, both, ip)).status).toBe(200);
      const said: unknown[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await verify(phone, "000000", both, ip);
        said.push([res.status, (await res.json()).error]);
      }
      return said;
    };
    const linked = await answers("540-555-0101", "al@apex.test", "198.51.100.30");
    const unlinked = await answers("540-555-0188", "uma@union.test", "198.51.100.31");
    expect(linked).toEqual(unlinked);
    expect(linked.at(-1)).toEqual([400, CODE_EXPIRED]);
    expect(sent.links()).toEqual([]);
  });
});

// ===== Typing in the code from the email ========================================================

describe("signing in with the code from the email", () => {
  it("trades the right code for a one-time sign-in for that account", async () => {
    const sent = serve(oscar());
    const code = await emailCodeFor(sent);
    const res = await verifyEmail(" AL@apex.test", code);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token_hash: `tok-${AL}`, type: "magiclink" });
    expect(sent.links()).toEqual([expect.objectContaining({ type: "magiclink", email: "al@apex.test" })]);
  });

  it("signs in by the address the office keeps, whatever the account's own address is", async () => {
    const world = oscar();
    // Uma's sign-in was made with no email; the office has added one since.
    world.subcontractors.find((s) => s.id === UNION)!.email = "uma@union.test";
    const sent = serve(world);
    const uma = await emailCodeFor(sent, "uma@union.test");
    expect(await (await verifyEmail("uma@union.test", uma)).json()).toEqual({ token_hash: `tok-${UMA}`, type: "magiclink" });
    // Gus's account is for his own address; the office keeps the business's, which is where the code goes.
    const gus = await emailCodeFor(sent, "office@gutterguys.test", mailing, "198.51.100.20");
    expect(sent.emails().at(-1)).toMatchObject({ to: ["office@gutterguys.test"], text: expect.stringMatching(/^Hi Gus,/) });
    expect(await (await verifyEmail("office@gutterguys.test", gus, mailing, "198.51.100.20")).json()).toEqual({ token_hash: `tok-${GUS}`, type: "magiclink" });
    expect(sent.links()).toEqual([
      expect.objectContaining({ type: "magiclink", email: subLoginEmail(UNION) }),
      expect.objectContaining({ type: "magiclink", email: "gus@gutterguys.test" }),
    ]);
  });

  it("refuses a wrong code, without saying anything about the address", async () => {
    const sent = serve(oscar());
    const code = await emailCodeFor(sent);
    const wrong = code === "000000" ? "000001" : "000000";
    for (const email of ["al@apex.test", "nobody@example.com"]) {
      const res = await verifyEmail(email, wrong);
      expect([res.status, (await res.json()).error], email).toEqual([400, EMAIL_CODE_WRONG]);
    }
    expect(sent.links()).toEqual([]);
  });

  it("doesn't take the code from a text, or a text's code from the email", async () => {
    const both: Env = { ...env, RESEND_API_KEY: "re_instance", EMAIL_FROM: "Crewtavo <codes@crewtavo.example>" };
    const world = oscar();
    world.subcontractors.find((s) => s.id === UNION)!.email = "uma@union.test";
    world.companies[0]!.settings = { subs: { sign_in_countries: ["44"] } };
    const sent = serve(world);
    // Al's code by email, typed with his number; Uma's by text, typed with her address.
    const emailed = await emailCodeFor(sent, "al@apex.test", both);
    expect((await (await verify("540-555-0101", emailed, both)).json()).error).toBe(CODE_WRONG);
    const texted = await codeFor(sent, "+44 20 7946 0958");
    expect((await (await verifyEmail("uma@union.test", texted, both)).json()).error).toBe(EMAIL_CODE_WRONG);
    expect(sent.links()).toEqual([]);
  });

  it("refuses a code that has run out, as it would for an address with no sign-in", async () => {
    const world = oscar();
    const sent = serve(world);
    const code = await emailCodeFor(sent);
    await askEmail("nobody@example.com");
    for (const c of world.codes) c.expires_at = Date.now() - 1000;
    for (const [email, typed] of [["al@apex.test", code], ["nobody@example.com", "123456"]] as const) {
      const res = await verifyEmail(email, typed);
      expect([res.status, (await res.json()).error], email).toEqual([400, CODE_EXPIRED]);
      // Only to the visitor who asked: to anyone else it isn't right.
      const other = await verifyEmail(email, typed, mailing, "198.51.100.77");
      expect([other.status, (await other.json()).error], email).toEqual([400, EMAIL_CODE_WRONG]);
    }
    expect(sent.links()).toEqual([]);
  });

  it("says to ask for a new code once 5 wrong tries have used it up", async () => {
    const sent = serve(oscar());
    const code = await emailCodeFor(sent);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 4; i++) expect((await (await verifyEmail("al@apex.test", wrong)).json()).error).toBe(EMAIL_CODE_WRONG);
    expect((await (await verifyEmail("al@apex.test", wrong)).json()).error).toBe(CODE_EXPIRED);
    const right = await verifyEmail("al@apex.test", code);
    expect([right.status, (await right.json()).error]).toEqual([400, CODE_EXPIRED]);
    expect((await (await verifyEmail("al@apex.test", code, mailing, "198.51.100.77")).json()).error).toBe(EMAIL_CODE_WRONG);
    expect(sent.links()).toEqual([]);
  });

  it("stops after 15 wrong tries in a day for the account, by text and by email together", async () => {
    const world = oscar();
    const sent = serve(world);
    const phoneHash = await signInPhoneHash(env, "+15405550101");
    // Three codes by text used up already today.
    for (let i = 0; i < 3; i++) {
      world.codes.push({ channel: "text", user_id: AL, address_hash: phoneHash, code_hash: "x".repeat(64), ip_hash: null, attempts: 5, expires_at: Date.now(), used_at: null, created_at: Date.now() - 60_000 });
    }
    const code = await emailCodeFor(sent);
    // Not "too many": that would tell the visitor the number's tries were this address's account's.
    const res = await verifyEmail("al@apex.test", code);
    expect([res.status, (await res.json()).error]).toEqual([400, EMAIL_CODE_WRONG]);
    expect((await (await verifyEmail("al@apex.test", code, mailing, "198.51.100.77")).json()).error).toBe(EMAIL_CODE_WRONG);
    expect(sent.links()).toEqual([]);
  });

  it("says too many for an address's own 15 wrong tries in a day", async () => {
    const world = oscar();
    const sent = serve(world);
    const emailHash = await signInEmailHash(env, "al@apex.test");
    for (let i = 0; i < 3; i++) {
      world.codes.push({ channel: "email", user_id: AL, address_hash: emailHash, code_hash: "x".repeat(64), ip_hash: null, attempts: 5, expires_at: Date.now(), used_at: null, created_at: Date.now() - 60_000 });
    }
    const code = await emailCodeFor(sent);
    const res = await verifyEmail("al@apex.test", code);
    expect([res.status, (await res.json()).error]).toEqual([429, TOO_MANY_WRONG]);
    expect(sent.links()).toEqual([]);
  });

  it("works once", async () => {
    const sent = serve(oscar());
    const code = await emailCodeFor(sent);
    expect((await verifyEmail("al@apex.test", code)).status).toBe(200);
    const again = await verifyEmail("al@apex.test", code);
    expect([again.status, (await again.json()).error]).toEqual([400, EMAIL_CODE_WRONG]);
    expect(sent.links()).toHaveLength(1);
  });

  it("stops working when the office turns the sub or their sign-in off, or changes their address", async () => {
    const turnOffs = [
      (w: World) => (w.subcontractors[0]!.active = false),
      (w: World) => (w.memberships[1]!.active = false),
      (w: World) => (w.subcontractors[0]!.email = "al@apexroofing.test"),
    ];
    for (const turnOff of turnOffs) {
      const world = oscar();
      const sent = serve(world);
      const code = await emailCodeFor(sent);
      turnOff(world);
      const res = await verifyEmail("al@apex.test", code);
      expect([res.status, (await res.json()).error]).toEqual([400, EMAIL_CODE_WRONG]);
      expect(sent.links()).toEqual([]);
    }
  });

  it("doesn't sign in an account whose own record says it isn't the sub's sign-in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    const sent = serve(world);
    const code = await emailCodeFor(sent);
    // The database still names Al's sign-in, but his account no longer carries Apex's mark.
    world.lookup = [{ user_id: AL, company_id: CO, subcontractor_id: APEX, company_name: "Oscar Roofing" }];
    world.accounts[AL]!.app_metadata = { provider: "email" };
    const res = await verifyEmail("al@apex.test", code);
    expect([res.status, (await res.json()).error]).toEqual([400, EMAIL_CODE_WRONG]);
    expect(sent.links()).toEqual([]);
  });

  it("answers plainly when the account can't be found or the sign-in can't be made", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const down of ["accountsDown", "linksDown"] as const) {
      const world = oscar();
      const sent = serve(world);
      const code = await emailCodeFor(sent);
      world[down] = true;
      const res = await verifyEmail("al@apex.test", code);
      expect([res.status, (await res.json()).error], down).toEqual([500, "Couldn't sign you in. Ask for a new code and try again."]);
    }
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^Email sign-in: /), expect.anything());
  });

  it("is limited per visitor and per address, and refuses when the limits can't be counted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const world = oscar();
    const sent = serve(world);
    const tries = () => sent.calls.filter((c) => c.path === "rpc/sign_in_codes_check").length;
    await verifyEmail("al@apex.test", "123456");
    expect(sent.limits()).toEqual([
      ["email-code-check:ip:203.0.113.7", 20, 3600],
      ["email-code-check:email:<address>", 10, 900],
    ]);
    for (let i = 0; i < 9; i++) await verifyEmail("AL@apex.test", "123456", mailing, `198.51.100.${i}`);
    expect(tries()).toBe(10);
    const res = await verifyEmail("al@apex.test", "123456", mailing, "198.51.100.99");
    expect([res.status, (await res.json()).error]).toEqual([429, "Too many tries. Wait a while and try again."]);
    world.limiterDown = true;
    expect((await verifyEmail("nobody@example.com", "123456", mailing, "192.0.2.1")).status).toBe(429);
    expect(tries()).toBe(10);
    // The per-address limit alone, too.
    world.limiterDown = false;
    world.limiterDownFor = /^email-code-check:email:/;
    const refused = await verifyEmail("someone@example.com", "123456", mailing, "192.0.2.2");
    expect([refused.status, (await refused.json()).error]).toEqual([429, TOO_MANY_TRIES]);
    expect(tries()).toBe(10);
  });

  it("wants a whole email address", async () => {
    const sent = serve(oscar());
    const res = await verifyEmail("al@apex", "123456");
    expect([res.status, (await res.json()).error]).toEqual([400, EMAIL_PROBLEM]);
    expect(sent.calls).toEqual([]);
  });
});

// ===== What the sign-in page offers =============================================================

describe("what the sign-in page offers", () => {
  const features = async (e: Env) => ((await (await app.request("/api/config", {}, e)).json()) as { features: { sms: boolean; emailCodes: boolean } }).features;

  it("offers codes by email when this Crewtavo can send email at all, by its own sender or a company's mailbox", async () => {
    const world = oscar();
    const sent = serve(world);
    // Nothing to send with: neither texts nor emails, so the page says to ask the office.
    expect(await features(base)).toMatchObject({ sms: false, emailCodes: false });
    // A company connects its own mailbox (Settings → Email forgets what was remembered).
    world.mailboxes[OTHER_CO] = "re_papa_own";
    forgetMailbox(OTHER_CO);
    expect(await features(base)).toMatchObject({ sms: false, emailCodes: true });
    // The instance's own sender: every company can, without asking the database.
    const asked = sent.calls.length;
    expect(await features(mailing)).toMatchObject({ sms: false, emailCodes: true });
    expect(await features({ ...env, RESEND_API_KEY: "re_instance", EMAIL_FROM: "Crewtavo <codes@crewtavo.example>" })).toMatchObject({ sms: true, emailCodes: true });
    expect(sent.calls.length).toBe(asked);
    // Nothing about any company is in it.
    expect(JSON.stringify(await (await app.request("/api/config", {}, base)).json())).not.toMatch(/0000000000a[12]|oscar|papa/i);
  });

  it("doesn't count a mailbox that was disconnected", async () => {
    const world = oscar();
    world.mailboxes[OTHER_CO] = "re_papa_old";
    world.mailboxStatus = { [OTHER_CO]: "disconnected" };
    serve(world);
    expect(await features(base)).toMatchObject({ sms: false, emailCodes: false });
    world.mailboxStatus = {};
    forgetMailbox(OTHER_CO);
    expect(await features(base)).toMatchObject({ sms: false, emailCodes: true });
  });

  it("offers them when it can't tell, since asking answers the same either way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async () => Response.json({ code: "XX000", message: "the database is having trouble" }, { status: 500 }));
    expect(await features(base)).toMatchObject({ sms: false, emailCodes: true });
  });
});
