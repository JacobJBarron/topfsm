/**
 * Signatures (routes/signing.ts, services/signing.ts): a person's saved signature, the homeowner
 * signing on the salesperson's iPad, signing for the business afterwards, and the signed copy.
 */
import { contractInput, contractValues, resolveSections, sectionsHash } from "@crewtavo/core/contracts";
import { DEFAULT_TEMPLATE, templateSettings } from "@crewtavo/core/documents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { readClientLink } from "../src/lib/links";
import { drawnPng } from "./fixtures/drawn";

// Stand-ins for the signed-in person's Supabase client: tables of rows that eq, in, is (including a
// ->> json path) and match filter, with insert, upsert, update (returning rows after .select()) and
// delete. sign_quote signs as the database does: only an open quote that still shows the option and
// comes to the total given; convert_quote_to_job answers `convertError` when it's set. Email and texts
// are recorded instead of sent, and automations aren't run.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  user: "",
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  /** Runs once just before sign_quote, as if someone else got there in between. */
  beforeSign: null as null | (() => void),
  /** What convert_quote_to_job refuses with, when it does. */
  convertError: null as null | { message: string; code: string },
}));
vi.mock("../src/lib/supabase", () => {
  const signQuote = (args: Record<string, unknown>) => {
    state.beforeSign?.();
    state.beforeSign = null;
    const q = (state.tables.quotes ?? []).find((row) => row.id === args.p_quote);
    if (!q || !["draft", "sent", "changes_requested"].includes(String(q.status))) return null;
    if ((q.option_id ?? null) !== (args.p_option ?? null)) return null;
    if (args.p_expected_total !== undefined && args.p_expected_total !== null && Number(q.total) !== args.p_expected_total) return null;
    const amounts = { subtotal: q.subtotal, discount_amount: q.discount_amount, tax_amount: q.tax_amount, total: q.total };
    Object.assign(q, { status: "approved", approved_at: new Date().toISOString(), salesperson_id: q.salesperson_id ?? state.user, approval: { ...structuredClone(args.p_approval as Row), ...amounts } });
    return amounts;
  };
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: state.user } }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      state.calls.push({ name, args });
      if (name === "sign_quote") return { data: signQuote(args), error: null };
      if (name === "convert_quote_to_job") return state.convertError ? { data: null, error: state.convertError } : { data: "job-1", error: null };
      return { data: true, error: null };
    },
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let change: { kind: "update"; values: Row } | { kind: "delete" } | null = null;
      let returning = false;
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const run = () => {
        if (change?.kind === "update") {
          const hit = rows();
          for (const row of hit) Object.assign(row, structuredClone(change.values));
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        if (change?.kind === "delete") {
          state.tables[table] = (state.tables[table] ?? []).filter((row) => !filters.every((keep) => keep(row)));
          return { data: null, error: null };
        }
        return { data: rows(), error: null };
      };
      const add = (list: Row | Row[], options?: { onConflict?: string }) => {
        const keys = options?.onConflict?.split(",") ?? [];
        for (const row of [list].flat()) {
          const existing = keys.length ? (state.tables[table] ?? []).find((r) => keys.every((k) => r[k] === row[k])) : undefined;
          if (existing) Object.assign(existing, row);
          else state.tables[table] = [...(state.tables[table] ?? []), { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row }];
        }
        return Promise.resolve({ data: null, error: null });
      };
      const value = (row: Row, column: string) => {
        const [col, key] = column.split("->>");
        const v = row[col!];
        return key ? (v && typeof v === "object" ? ((v as Row)[key] ?? null) : null) : v;
      };
      const builder: Record<string, unknown> = {
        select: () => ((returning = true), builder),
        order: () => builder,
        limit: () => builder,
        eq: (column: string, v: unknown) => (filters.push((row) => value(row, column) === v), builder),
        is: (column: string, v: unknown) => (filters.push((row) => (value(row, column) ?? null) === v), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(value(row, column))), builder),
        match: (values: Row) => (filters.push((row) => Object.entries(values).every(([k, v]) => row[k] === v)), builder),
        insert: (list: Row | Row[]) => add(list),
        upsert: add,
        update: (values: Row) => ((change = { kind: "update", values }), builder),
        delete: () => ((change = { kind: "delete" }), builder),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  });
  const db = client();
  return { userClient: () => db, adminClient: () => db, publishableKey: () => "key" };
});
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendEmail: vi.fn(async () => ({ sent: true, id: "email-1" })),
  sendSms: vi.fn(async () => ({ sent: true, id: "sms-1" })),
}));
vi.mock("../src/lib/background", async (original) => ({ ...(await original<typeof import("../src/lib/background")>()), kickAutomations: vi.fn() }));

const { app } = await import("../src/app");
const notify = await import("../src/lib/notify");
const background = await import("../src/lib/background");
const sendEmail = vi.mocked(notify.sendEmail);
const sendSms = vi.mocked(notify.sendSms);

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 5))),
  APP_URL: "https://ops.example.com",
} as Env;

const ROOFER = "00000000-0000-4000-8000-00000000d0c1";
const OTHER = "00000000-0000-4000-8000-00000000d0c2";
const QUOTE = "00000000-0000-4000-8000-00000000d0c3";
const MIKE = "00000000-0000-4000-8000-00000000d0c4";
const CLIENT = "00000000-0000-4000-8000-00000000d0c5";
const HOMEOWNER = drawnPng(1200, 340, "Alex");
/** What a Hub link says about itself (lib/links), from the text it's in. */
const hubLinkIn = (text: unknown) => readClientLink(env, String(text).match(/\/hub\/(\S+)/)![1]!);
const MIKES = drawnPng(840, 280, "Mike");
const SAVED = drawnPng(840, 280, "Mike, saved");

const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": ROOFER, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

const quote = () => state.tables.quotes!.find((q) => q.id === QUOTE)!;

function roofer({ status = "sent", role = "estimator", approval = null as Row | null, templates = [] as Row[], saved = null as string | null, email = "alex@example.com" as string | null } = {}) {
  state.user = MIKE;
  state.tables = {
    memberships: [{ company_id: ROOFER, user_id: MIKE, active: true, role, role_id: null }],
    companies: [{ id: ROOFER, name: "Ridgeline Roofing", email: "office@ridgeline.example", phone: "(614) 555-0188", timezone: "America/New_York", address: { line1: "2290 Harper Rd", city: "Columbus", region: "OH" }, settings: {} }],
    profiles: [{ user_id: MIKE, full_name: "Mike Torres" }],
    document_templates: templates,
    user_signatures: [
      ...(saved ? [{ company_id: ROOFER, user_id: MIKE, image: saved }] : []),
      // Mike's signature at another business he works for never crosses over.
      { company_id: OTHER, user_id: MIKE, image: SAVED },
    ],
    quotes: [
      {
        id: QUOTE, company_id: ROOFER, number: 1042, status, title: "New roof", client_id: CLIENT, template_id: null, salesperson_id: null, option_id: null, section_ids: [],
        sent_at: "2026-10-19T14:00:00.000Z", created_at: "2026-10-18T14:00:00.000Z",
        subtotal: 18304, discount_amount: 0, tax_rate: 0, tax_amount: 0, total: 18304, deposit_amount: 1000, approval, approved_at: approval ? "2026-10-20T15:00:00.000Z" : null,
        client: { display_name: "Alex Morgan", email, phone: "(614) 555-0142", billing_address: {} },
        property: { line1: "88 Linden Ave", city: "Columbus", region: "OH", postal_code: "43204" },
        lines: [
          { id: "line-1", option_id: null, quantity: 1, unit_price: 17504, taxable: true, optional: false, selected: true },
          { id: "line-2", option_id: null, quantity: 1, unit_price: 800, taxable: true, optional: true, selected: true },
          { id: "line-3", option_id: null, quantity: 1, unit_price: 450, taxable: true, optional: true, selected: false },
        ],
      },
    ],
    quote_options: [],
    contract_sections: [],
    messages: [],
  };
}

beforeEach(() => {
  state.calls = [];
  state.beforeSign = null;
  state.convertError = null;
  sendEmail.mockClear();
  sendSms.mockClear();
  vi.mocked(background.kickAutomations).mockClear();
});
afterEach(() => {
  state.tables = {};
});

describe("my saved signature", () => {
  it("saves, reads and removes the signed-in person's own signature in this business", async () => {
    roofer();
    expect(await (await call("/me/signature")).json()).toEqual({ image: null });

    const saved = await call("/me/signature", { image: MIKES }, "PUT");
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ image: MIKES });
    expect(await (await call("/me/signature")).json()).toEqual({ image: MIKES });

    // Signing again replaces it rather than adding another.
    await call("/me/signature", { image: SAVED }, "PUT");
    expect(state.tables.user_signatures!.filter((r) => r.company_id === ROOFER)).toEqual([expect.objectContaining({ user_id: MIKE, image: SAVED })]);

    expect(await (await call("/me/signature", undefined, "DELETE")).json()).toEqual({ ok: true });
    expect(await (await call("/me/signature")).json()).toEqual({ image: null });
    // The other business's copy is untouched.
    expect(state.tables.user_signatures).toEqual([expect.objectContaining({ company_id: OTHER })]);
  });

  it("only takes a drawn signature", async () => {
    roofer();
    // Not a PNG, not a picture, too long, and a few bytes claiming 20,000 × 20,000 pixels.
    for (const image of ["data:image/jpeg;base64,AAAA", "<svg></svg>", `data:image/png;base64,${"A".repeat(300_001)}`, `data:image/png;base64,${"A".repeat(400)}=`, drawnPng(20_000, 20_000)]) {
      const res = await call("/me/signature", { image }, "PUT");
      expect(res.status, image.slice(0, 20)).toBe(400);
    }
    expect(state.tables.user_signatures!.filter((r) => r.company_id === ROOFER)).toEqual([]);
  });
});

describe("signing on site", () => {
  it("approves the estimate with both signatures and emails the homeowner a copy", async () => {
    roofer();
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES, save_signature: true, email_copy: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "approved", emailed: true, link: expect.stringMatching(/^https:\/\/ops\.example\.com\/hub\/.+/) });

    const q = quote();
    expect(q.status).toBe("approved");
    expect(q.approved_at).toEqual(expect.any(String));
    expect(q.salesperson_id).toBe(MIKE);
    const signedAt = (q.approval as Row).signed_at;
    expect(q.approval).toEqual({
      name: "Alex Morgan",
      signature: HOMEOWNER,
      signed_at: expect.any(String),
      method: "in_person",
      selected_line_ids: ["line-2"],
      company: { name: "Mike Torres", user_id: MIKE, signature: MIKES, signed_at: signedAt },
      // No template saved yet: the built-in one, kept as it was signed.
      template: DEFAULT_TEMPLATE,
      // No options and no sections: only the template's terms, filled in (these have nothing to fill).
      option: null,
      contract: { terms: DEFAULT_TEMPLATE.terms, sections: [] },
      initials: null,
      // The database adds the amounts it was signed at.
      subtotal: 18304,
      discount_amount: 0,
      tax_amount: 0,
      total: 18304,
    });
    // Signed in the database, as the signed-in salesperson.
    expect(state.calls.filter((c) => c.name === "sign_quote")).toEqual([{ name: "sign_quote", args: { p_quote: QUOTE, p_approval: expect.objectContaining({ name: "Alex Morgan" }) } }]);
    // It's never the IP: that's only for online approvals.
    expect(q.approval).not.toHaveProperty("ip");

    // "Save my signature" keeps the one Mike drew for next time.
    expect(state.tables.user_signatures).toContainEqual(expect.objectContaining({ company_id: ROOFER, user_id: MIKE, image: MIKES }));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [, message, companyId] = sendEmail.mock.calls[0]!;
    expect(companyId).toBe(ROOFER);
    expect(message).toMatchObject({ to: "alex@example.com", subject: "Your signed estimate from Ridgeline Roofing", replyTo: "office@ridgeline.example", fromName: "Ridgeline Roofing" });
    expect(message.text).toContain("Hi Alex,");
    expect(message.text).toContain("Here's your signed estimate from Ridgeline Roofing. You can view, print or save it any time:");
    // The homeowner's email has their own link; the salesperson and the timeline get the office's copy.
    const own = await hubLinkIn(message.text);
    expect(own).toMatchObject({ c: ROOFER, t: "quote", id: QUOTE, own: 1 });
    expect(own!.via).toBeUndefined();
    expect(await hubLinkIn(body.link)).toMatchObject({ c: ROOFER, t: "quote", id: QUOTE, via: "office" });
    expect(state.tables.messages).toEqual([expect.objectContaining({ client_id: CLIENT, channel: "email", related_type: "quote", related_id: QUOTE, external_id: "email-1" })]);
    expect(await hubLinkIn(state.tables.messages![0]!.body)).toMatchObject({ t: "quote", id: QUOTE, via: "office" });
    expect(background.kickAutomations).toHaveBeenCalledTimes(1);
  });

  it("uses the salesperson's saved signature for the business", async () => {
    roofer({ saved: SAVED });
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "approved", emailed: false, link: expect.any(String) });
    expect((quote().approval as Row).company).toEqual(expect.objectContaining({ name: "Mike Torres", signature: SAVED }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("asks for the business's signature when the template has a line for it", async () => {
    roofer();
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Sign for Ridgeline Roofing too.");
    expect(quote().status).toBe("sent");
    expect(quote().approval).toBeNull();
  });

  it("signs without it when the quote's template has no line for the business", async () => {
    roofer({
      templates: [
        { id: "t-standard", company_id: ROOFER, is_default: true, settings: {} },
        { id: "t-simple", company_id: ROOFER, is_default: false, settings: { company_signs: false } },
      ],
    });
    quote().template_id = "t-simple";
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER });
    expect(res.status).toBe(200);
    expect((quote().approval as Row).company).toBeNull();
    // The quote's own template is kept with the signatures, so editing it later doesn't change the signed copy.
    expect((quote().approval as Row).template).toEqual(templateSettings({ company_signs: false }));
  });

  it("won't sign an estimate twice, or one that isn't open", async () => {
    roofer({ status: "approved", approval: { name: "Alex Morgan", signature: HOMEOWNER } });
    let res = await call(`/quotes/${QUOTE}/sign`, { name: "Someone Else", signature: HOMEOWNER, company_signature: MIKES });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This estimate was already signed.");
    expect((quote().approval as Row).name).toBe("Alex Morgan");
    expect(state.calls.some((c) => c.name === "sign_quote")).toBe(false);

    roofer({ status: "lost" });
    res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This estimate is marked lost, so it can't be signed. Reopen it as a draft first.");
  });

  it("keeps it signed when the copy can't be emailed, and says why", async () => {
    roofer({ email: null });
    let res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES, email_copy: true });
    expect(await res.json()).toEqual({ status: "approved", emailed: false, email_reason: "Add an email address for Alex Morgan first.", link: expect.any(String) });
    expect(quote().status).toBe("approved");

    roofer();
    sendEmail.mockResolvedValueOnce({ sent: false, reason: "Email isn't set up yet." });
    res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES, email_copy: true });
    expect(await res.json()).toMatchObject({ status: "approved", emailed: false, email_reason: "Email isn't set up yet." });
    expect(state.tables.messages).toEqual([]);
  });

  it("is for people who sell", async () => {
    roofer({ role: "field_crew" });
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES });
    expect(res.status).toBe(403);
    expect(quote().status).toBe("sent");
  });

  it("needs the customer's name and signature", async () => {
    roofer();
    expect((await call(`/quotes/${QUOTE}/sign`, { name: "A", signature: HOMEOWNER, company_signature: MIKES })).status).toBe(400);
    expect((await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", company_signature: MIKES })).status).toBe(400);
    expect(quote().status).toBe("sent");
  });
});

// The estimate offers two options; the homeowner chose the metal roof on the visit page, so it's the
// one shown. Its section asks for initials, and the template prints a payment section.
const SHINGLE = "00000000-0000-4000-8000-00000000e0a1";
const METAL = "00000000-0000-4000-8000-00000000e0a2";
const PAYMENT = "00000000-0000-4000-8000-00000000e0b1";
const CANCEL = "00000000-0000-4000-8000-00000000e0b2";
const INITIALS = drawnPng(2048, 200, "AM");

function withOptions() {
  roofer({ templates: [{ id: "t-standard", company_id: ROOFER, is_default: true, settings: { company_signs: false, license: "OH-7731", terms: "Thanks, {Customer name}.", sections: [PAYMENT] } }] });
  Object.assign(quote(), { option_id: METAL, subtotal: 31253, total: 31253 });
  quote().lines = [
    { id: "line-1", option_id: null, quantity: 1, unit_price: 2469, taxable: true, optional: false, selected: true },
    { id: "line-s", option_id: SHINGLE, quantity: 1, unit_price: 12544, taxable: true, optional: false, selected: false },
    { id: "line-m", option_id: METAL, quantity: 1, unit_price: 28784, taxable: true, optional: false, selected: true },
    { id: "line-g", option_id: METAL, quantity: 1, unit_price: 600, taxable: true, optional: true, selected: false },
  ];
  state.tables.quote_options = [
    { id: SHINGLE, company_id: ROOFER, quote_id: QUOTE, name: "Architectural shingle", tier: null, picture: null, picture_width: null, picture_height: null, style: "shingle", highlights: [], warranty: "10 years on our work.", section_ids: [], sort: 0 },
    {
      id: METAL, company_id: ROOFER, quote_id: QUOTE, name: "Standing-seam metal", tier: null, picture: `${ROOFER}/packages/00000000-0000-4000-8000-00000000e0c1.jpg`, picture_width: 1600, picture_height: 1200,
      style: "metal", highlights: ["Lasts 50 years"], warranty: "Lifetime on the panels.", section_ids: [CANCEL], sort: 1,
    },
  ];
  state.tables.contract_sections = [
    { id: PAYMENT, company_id: ROOFER, title: "Payment", body: "<p>{Total} for {Option}, at {Job address}.</p>", place: "terms", initials: false, sort: 0 },
    { id: CANCEL, company_id: ROOFER, title: "Your right to cancel", body: "<p>{Customer name} may cancel within three business days.</p>", place: "signatures", initials: true, sort: 1 },
    // Another business's section with an id this one's template might name never prints.
    { id: "00000000-0000-4000-8000-00000000e0b9", company_id: OTHER, title: "Theirs", body: "<p>Not ours.</p>", place: "terms", initials: false, sort: 0 },
  ];
}

/**
 * The fingerprint of the paper the iPad showed, as it works it out: the library's words filled in with
 * the quote's facts at the total on the paper, and the metal roof's card.
 */
const paperHash = (total = 31253) => {
  const q = quote() as never as Parameters<typeof contractInput>[0] & { client: { display_name: string }; property: unknown };
  const metal = state.tables.quote_options!.find((o) => o.id === METAL) as never as { name: string; warranty: string; highlights: string[] };
  const values = contractValues(contractInput({ ...q, total }, q.client, q.property, { name: "Ridgeline Roofing", phone: "(614) 555-0188", timezone: "America/New_York" }, templateSettings({ license: "OH-7731" }), metal));
  return sectionsHash(
    resolveSections({ kind: "estimate", template: templateSettings({ sections: [PAYMENT] }), optionSectionIds: [CANCEL], quoteSectionIds: [], library: state.tables.contract_sections!.filter((r) => r.company_id === ROOFER) as never }),
    { terms: "Thanks, {Customer name}.", values, option: { name: metal.name, tier: "Better", warranty: metal.warranty, highlights: metal.highlights } },
  );
};

describe("signing an estimate with options on site", () => {
  it("signs for the option shown, keeping it, the contract filled in and the homeowner's initials", async () => {
    withOptions();
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, option_id: METAL, expected_total: 31253, sections_hash: paperHash(), initials: INITIALS });
    expect(res.status).toBe(200);
    expect(state.calls.filter((c) => c.name === "sign_quote").map((c) => c.args)).toEqual([
      { p_quote: QUOTE, p_option: METAL, p_expected_total: 31253, p_approval: expect.objectContaining({ method: "in_person" }) },
    ]);
    const approval = quote().approval as Row;
    expect(quote().status).toBe("approved");
    expect(approval.option).toEqual({
      id: METAL, name: "Standing-seam metal", tier: "Better", picture: { path: `${ROOFER}/packages/00000000-0000-4000-8000-00000000e0c1.jpg`, width: 1600, height: 1200 },
      style: "metal", highlights: ["Lasts 50 years"], warranty: "Lifetime on the panels.",
    });
    expect(approval.contract).toEqual({
      terms: "Thanks, Alex Morgan.",
      sections: [
        { id: PAYMENT, title: "Payment", body: "<p>$31,253.00 for Standing-seam metal, at 88 Linden Ave, Columbus, OH 43204.</p>", place: "terms", initials: false, initialed: false },
        { id: CANCEL, title: "Your right to cancel", body: "<p>Alex Morgan may cancel within three business days.</p>", place: "signatures", initials: true, initialed: true },
      ],
    });
    expect(approval.initials).toEqual({ image: INITIALS, signed_at: approval.signed_at });
    expect(approval.total).toBe(31253);
  });

  it("keeps the add-ons picked on the option chosen, never another option's", async () => {
    withOptions();
    // Gutter guards picked on the metal roof; a shingle add-on left picked from before is on another option.
    quote().lines = [...(quote().lines as Row[]), { id: "line-v", option_id: SHINGLE, quantity: 1, unit_price: 400, taxable: true, optional: true, selected: true }];
    (quote().lines as Row[]).find((l) => l.id === "line-g")!.selected = true;
    Object.assign(quote(), { subtotal: 31853, total: 31853 });
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, option_id: METAL.toUpperCase(), expected_total: 31853, sections_hash: paperHash(31853), initials: INITIALS });
    expect(res.status).toBe(200);
    expect(state.calls.find((c) => c.name === "sign_quote")?.args.p_option).toBe(METAL);
    expect((quote().approval as Row).selected_line_ids).toEqual(["line-g"]);
  });

  it("won't sign an option that isn't priced yet", async () => {
    withOptions();
    // The metal roof was picked before its lines were filled in.
    quote().lines = (quote().lines as Row[]).filter((l) => l.option_id !== METAL || l.optional);
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, option_id: METAL, initials: INITIALS });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This option isn't priced yet. Add its lines, or pick another one.");
    expect(state.calls.some((c) => c.name === "sign_quote")).toBe(false);
    expect(quote().status).toBe("sent");
  });

  it("needs the option they chose, and it has to be the one shown", async () => {
    withOptions();
    let res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, initials: INITIALS });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Pick one of the options first.");
    res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, option_id: SHINGLE, initials: INITIALS });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The option or the price changed. Check it again.");
    expect(state.calls.some((c) => c.name === "sign_quote")).toBe(false);
    expect(quote().status).toBe("sent");
  });

  it("asks for the homeowner's initials where the terms ask for them", async () => {
    withOptions();
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, option_id: METAL });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Add your initials where the terms ask for them.");
    expect(quote().status).toBe("sent");
  });

  it("only takes initials and signatures of a size a signature pad draws", async () => {
    withOptions();
    const huge = drawnPng(20_000, 20_000);
    expect((await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, option_id: METAL, initials: huge })).status).toBe(400);
    expect((await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: huge, option_id: METAL, initials: INITIALS })).status).toBe(400);
    expect((await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: huge, option_id: METAL, initials: INITIALS })).status).toBe(400);
    expect(state.calls.some((c) => c.name === "sign_quote")).toBe(false);
    expect(quote().status).toBe("sent");
  });

  it("turns it down when what the paper said changed since, like the option's warranty", async () => {
    withOptions();
    const hash = paperHash();
    state.tables.quote_options!.find((o) => o.id === METAL)!.warranty = "25 years on the panels.";
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, option_id: METAL, sections_hash: hash, initials: INITIALS });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The terms changed. Please look them over again.");
  });

  it("turns it down when the terms changed after the paper was shown", async () => {
    withOptions();
    const hash = paperHash();
    state.tables.contract_sections![0]!.title = "Payment schedule";
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, option_id: METAL, sections_hash: hash, initials: INITIALS });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The terms changed. Please look them over again.");
    expect(quote().status).toBe("sent");
  });

  it("isn't signed when the total isn't the one on the paper", async () => {
    withOptions();
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, option_id: METAL, expected_total: 31000, initials: INITIALS });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The option or the price changed. Check it again.");
    expect(quote().status).toBe("sent");
    expect(quote().approval).toBeNull();
  });

  it("says it was already signed when someone else signed it first", async () => {
    roofer();
    // Signed elsewhere between loading the quote and signing it.
    state.beforeSign = () => (quote().status = "approved");
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This estimate was already signed.");
    expect(state.calls.map((c) => c.name)).toEqual(["sign_quote"]);
  });
});

describe("signing a single-package estimate on site", () => {
  it("says the package's name and warranty in {Option} and {Warranty}", async () => {
    const WARRANTY = "00000000-0000-4000-8000-00000000e0b3";
    const PKG = "00000000-0000-4000-8000-00000000e0d1";
    roofer({ templates: [{ id: "t-standard", company_id: ROOFER, is_default: true, settings: { company_signs: false, sections: [WARRANTY] } }] });
    quote().roof_package_id = PKG;
    state.tables.roof_packages = [{ id: PKG, company_id: ROOFER, name: "Architectural shingle", warranty: "10 years on our workmanship." }];
    state.tables.contract_sections = [{ id: WARRANTY, company_id: ROOFER, title: "Warranty", body: "<p>{Option}: {Warranty}</p>", place: "terms", initials: false, sort: 0 }];
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER });
    expect(res.status).toBe(200);
    expect((quote().approval as Row).option).toBeNull();
    expect(((quote().approval as Row).contract as { sections: Row[] }).sections[0]!.body).toBe("<p>Architectural shingle: 10 years on our workmanship.</p>");
  });
});

describe("a quote turned into a job before it was signed", () => {
  const PAYMENT_DUE = "00000000-0000-4000-8000-00000000e0b4";
  function sent() {
    roofer({ templates: [{ id: "t-standard", company_id: ROOFER, is_default: true, settings: { license: "OH-7731", terms: "Thanks, {Customer name}.", sections: [PAYMENT_DUE] } }] });
    quote().section_ids = [CANCEL];
    state.tables.contract_sections = [
      { id: PAYMENT_DUE, company_id: ROOFER, title: "Payment", body: "<p>{Total} when the roof is done, {Customer name}.</p>", place: "terms", initials: false, sort: 0 },
      { id: CANCEL, company_id: ROOFER, title: "Your right to cancel", body: "<p>{Customer name} may cancel within three business days.</p>", place: "signatures", initials: true, sort: 1 },
    ];
  }

  it("keeps the contract it was sent with, approved in the name of whoever converted it", async () => {
    sent();
    const res = await call(`/quotes/${QUOTE}/convert`, {});
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ job_id: "job-1" });
    expect(quote().approval).toEqual({
      name: "Mike Torres",
      method: "manual",
      template: templateSettings({ license: "OH-7731", terms: "Thanks, {Customer name}.", sections: [PAYMENT_DUE] }),
      option: null,
      contract: {
        terms: "Thanks, Alex Morgan.",
        sections: [
          { id: PAYMENT_DUE, title: "Payment", body: "<p>$18,304.00 when the roof is done, Alex Morgan.</p>", place: "terms", initials: false, initialed: false },
          // Nobody signed, so nobody initialed it.
          { id: CANCEL, title: "Your right to cancel", body: "<p>Alex Morgan may cancel within three business days.</p>", place: "signatures", initials: true, initialed: false },
        ],
      },
      initials: null,
    });
    // Only the approval: the database's one step turns it into a job (and a change order joins its job).
    expect(quote().status).toBe("sent");
    expect(state.calls.map((c) => c.name)).toEqual(["convert_quote_to_job"]);
  });

  it("leaves the approval of a quote that was signed as it is", async () => {
    roofer({ status: "approved", approval: { name: "Alex Morgan", signature: HOMEOWNER } });
    expect((await call(`/quotes/${QUOTE}/convert`, {})).status).toBe(201);
    expect(quote().approval).toEqual({ name: "Alex Morgan", signature: HOMEOWNER });
  });

  it("goes back to the approval it had when it doesn't become a job", async () => {
    sent();
    quote().approval = { name: "Old", method: "manual" };
    state.convertError = { message: "This quote can't become a job right now.", code: "22023" };
    const res = await call(`/quotes/${QUOTE}/convert`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This quote can't become a job right now.");
    expect(quote().approval).toEqual({ name: "Old", method: "manual" });
  });

  it("isn't approved here when it offers options: it's approved with the option chosen first", async () => {
    withOptions();
    state.convertError = { message: "This estimate offers options. Mark it approved with the option they chose first.", code: "22023" };
    const res = await call(`/quotes/${QUOTE}/convert`, {});
    expect(res.status).toBe(400);
    expect(quote().approval).toBeNull();
  });
});

describe("signing for the business afterwards", () => {
  const online = { name: "Alex Morgan", signature: HOMEOWNER, signed_at: "2026-10-20T15:00:00.000Z", ip: "203.0.113.9", selected_line_ids: [], total: 18304 };

  it("adds the saved signature to an estimate the client signed online", async () => {
    roofer({ status: "approved", approval: { ...online }, saved: SAVED });
    const res = await call(`/quotes/${QUOTE}/countersign`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(quote().approval).toEqual({ ...online, company: { name: "Mike Torres", user_id: MIKE, signature: SAVED, signed_at: expect.any(String) } });

    // Only once.
    const again = await call(`/quotes/${QUOTE}/countersign`, { signature: MIKES });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("This estimate was already signed for Ridgeline Roofing.");
    expect(((quote().approval as Row).company as Row).signature).toBe(SAVED);
  });

  it("takes a signature drawn now, and can save it", async () => {
    roofer({ status: "converted", approval: { ...online, company: null } });
    const res = await call(`/quotes/${QUOTE}/countersign`, { signature: MIKES, save_signature: true });
    expect(res.status).toBe(200);
    expect(((quote().approval as Row).company as Row).signature).toBe(MIKES);
    expect(state.tables.user_signatures).toContainEqual(expect.objectContaining({ company_id: ROOFER, user_id: MIKE, image: MIKES }));
  });

  it("asks for a signature when there's no saved one", async () => {
    roofer({ status: "approved", approval: { ...online } });
    const res = await call(`/quotes/${QUOTE}/countersign`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Draw your signature first.");
    expect((quote().approval as Row).company).toBeUndefined();
  });

  it("is only for signed estimates", async () => {
    roofer({ status: "sent", saved: SAVED });
    const res = await call(`/quotes/${QUOTE}/countersign`, {});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This estimate isn't signed yet.");
  });
});

describe("the signed copy", () => {
  it("texts the client a link to the signed estimate", async () => {
    roofer({ status: "approved", approval: { name: "Alex Morgan", signature: HOMEOWNER } });
    const res = await call(`/quotes/${QUOTE}/send-copy`, { channel: "sms" });
    const body = await res.json();
    expect(body).toEqual({ sent: true, link: expect.stringContaining("/hub/") });
    expect(sendSms).toHaveBeenCalledWith(env, { to: "(614) 555-0142", body: expect.stringMatching(/^Ridgeline Roofing: Here's your signed estimate\. You can view, print or save it any time: https:\/\/ops\.example\.com\/hub\/\S+$/) });
    // The text has the client's own link; the person sending it and the timeline get the office's copy.
    expect((await hubLinkIn(sendSms.mock.calls[0]![1].body))!.via).toBeUndefined();
    expect(await hubLinkIn(sendSms.mock.calls[0]![1].body)).toMatchObject({ own: 1 });
    expect(await hubLinkIn(body.link)).toMatchObject({ t: "quote", id: QUOTE, via: "office" });
    expect(state.tables.messages).toEqual([expect.objectContaining({ channel: "sms", subject: "Signed estimate #1042", related_type: "quote", related_id: QUOTE })]);
    expect(state.tables.messages![0]!.body).toMatch(/^Ridgeline Roofing: Here's your signed estimate\./);
    expect(await hubLinkIn(state.tables.messages![0]!.body)).toMatchObject({ t: "quote", id: QUOTE, via: "office" });
  });

  it("emails it to another address when asked, with the office's copy of the link", async () => {
    roofer({ status: "converted", approval: { name: "Alex Morgan", signature: HOMEOWNER } });
    const res = await call(`/quotes/${QUOTE}/send-copy`, { channel: "email", to: "alex.work@example.com" });
    expect(await res.json()).toMatchObject({ sent: true });
    expect(sendEmail.mock.calls[0]![1].to).toBe("alex.work@example.com");
    // Not the client's address on file, so not their own link: a year-long link that could say yes
    // to autopay or tip doesn't go to whoever the sender typed (their own inbox, say).
    const copy = await hubLinkIn(sendEmail.mock.calls[0]![1].text);
    expect(copy).toMatchObject({ t: "quote", id: QUOTE, via: "office" });
    expect(copy).not.toHaveProperty("own");
    // Their address typed in another case is still theirs.
    await call(`/quotes/${QUOTE}/send-copy`, { channel: "email", to: " ALEX@example.com" });
    expect(await hubLinkIn(sendEmail.mock.calls[1]![1].text)).toMatchObject({ own: 1 });
  });

  it("texts the office's copy of the link to a number that isn't the client's", async () => {
    roofer({ status: "approved", approval: { name: "Alex Morgan", signature: HOMEOWNER } });
    await call(`/quotes/${QUOTE}/send-copy`, { channel: "sms", to: "(614) 555-0199" });
    const copy = await hubLinkIn(sendSms.mock.calls[0]![1].body);
    expect(copy).toMatchObject({ t: "quote", id: QUOTE, via: "office" });
    expect(copy).not.toHaveProperty("own");
    // Their own number, with the country code: their own link.
    await call(`/quotes/${QUOTE}/send-copy`, { channel: "sms", to: "+16145550142" });
    expect(await hubLinkIn(sendSms.mock.calls[1]![1].body)).toMatchObject({ own: 1 });
  });

  it("emails the copy at signing to another address with the office's copy of the link", async () => {
    roofer();
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES, email_copy: true, to: "sales@ridgeline.example" });
    expect(await res.json()).toMatchObject({ status: "approved", emailed: true });
    expect(sendEmail.mock.calls[0]![1].to).toBe("sales@ridgeline.example");
    expect(await hubLinkIn(sendEmail.mock.calls[0]![1].text)).toMatchObject({ t: "quote", id: QUOTE, via: "office" });
  });

  it("says why it wasn't sent instead of failing", async () => {
    roofer({ status: "approved", approval: { name: "Alex Morgan" }, email: null });
    const res = await call(`/quotes/${QUOTE}/send-copy`, { channel: "email" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, reason: "Add an email address for Alex Morgan first.", link: expect.any(String) });
    expect(await (await call(`/quotes/${QUOTE}/send-copy`, { channel: "email", to: "not an email" })).json()).toMatchObject({ sent: false, reason: "That email address doesn't look right." });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("is only for signed estimates", async () => {
    roofer({ status: "sent" });
    const res = await call(`/quotes/${QUOTE}/send-copy`, { channel: "email" });
    expect(res.status).toBe(409);
  });
});
