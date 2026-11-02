/**
 * Autopay in the office (docs/autopay-plan.md): Settings → Payments is for owners and admins with
 * the invoices area, right after Company; it says what autopay needs (the company's own Stripe
 * account, a key that can save cards), saves the terms, timing, cap and receipts through PUT
 * /autopay/settings only, and says where tips stand without writing them: Settings → Company's
 * switch stays the one place hub_tips is written. Cards brought in from Stripe are listed for a
 * Confirm autopay link (or an owner's word). The client page's Autopay card shows the card the
 * client agreed to, and the Stripe key link asks for the permissions autopay needs.
 */
import { starterAutopayTerms, type AutopaySettings } from "@crewtavo/core/autopay";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { STRIPE_KEY_PERMISSIONS, STRIPE_NEW_KEY } from "../src/features/apps/catalog";
import { agreedText, AutopayCard, clientAutopayOf, type AutopayAgreement, type AutopayMethod, type ClientAutopay } from "../src/features/clients/AutopayCard";
import { autopayBody, paymentForm, PaymentSettings, type AutopayStatus } from "../src/features/settings/PaymentSettings";
import { settingsGroups } from "../src/features/settings/sections";
import { StripeCards, stripeCardRows, type StripeCardRow } from "../src/features/settings/StripeCards";

const COMPANY = "0f0f0f0f-0000-4000-8000-0000000000aa";
const CLIENT = "0f0f0f0f-0000-4000-8000-0000000000c1";
const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../src/lib/session", () => ({
  useSession: () => session.current,
  hasRole: (s: { role: string }, ...roles: string[]) => s.role === "owner" || roles.includes(s.role),
  can: (s: { role: string; permissions: string[] }, p: string) => s.role === "owner" || s.permissions.includes(p),
  isSub: (s: { role: string }) => s.role === "subcontractor",
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: { get: async () => ({}), put: async () => ({}), post: async () => ({}) },
  supabase: () => ({}),
}));

const as = (role: string, permissions: string[] = ["invoices"], features: Record<string, boolean> = { email: true, sms: true }) => {
  session.current = {
    role,
    permissions,
    userId: "u-me",
    company: { id: COMPANY, name: "Radford Lawn Care", trade_preset: "lawn_exterior", timezone: "America/New_York", settings: {} },
    config: { singleCompany: true, platform: "railway", features },
    refresh: async () => undefined,
  };
};

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
/** Every .ts and .tsx file under src, with its path from there. */
function sources(dir = SRC): Array<{ path: string; code: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) ? [{ path: full.slice(SRC.length + 1), code: readFileSync(full, "utf8") }] : [];
  });
}

/** What a screen says, without its tags. */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ");

function render(element: ReactElement, seed: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  seed(client);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, element)));
}

const SETTINGS: AutopaySettings = {
  enabled: false,
  terms: starterAutopayTerms("lawn_exterior"),
  terms_version: "starter-lawn_exterior-1",
  timing: "end_of_day",
  days: null,
  max_amount: 500,
  receipts: true,
  jobs_default: true,
  card_required: false,
  changed_at: null,
  changed_by: null,
};
const STATUS: AutopayStatus = { connected: true, own: true, livemode: true, can_autopay: true, can_refund: true, webhook_current: true, settings: SETTINGS, tips: true, stripe_cards: 0 };
const paymentsPage = (status: Partial<AutopayStatus>, cards: StripeCardRow[] = []) =>
  text(render(createElement(PaymentSettings), (client) => {
    client.setQueryData(["company", COMPANY, "payments"], { ...STATUS, ...status });
    client.setQueryData(["company", COMPANY, "payments", "stripe-cards"], cards);
  }));

describe("Settings → Payments in the menu", () => {
  const tabs = () => settingsGroups(session.current as never).flatMap((g) => g.items).flatMap((i) => ("tab" in i ? [i.tab] : []));

  it("is there for owners and admins with the invoices area", () => {
    as("owner", []);
    expect(tabs()).toContain("payments");
    as("admin", ["invoices"]);
    expect(tabs()).toContain("payments");
  });

  it("isn't there for an admin without invoices, the office, estimators, crews or subs", () => {
    as("admin", ["settings", "apps"]);
    expect(tabs()).not.toContain("payments");
    for (const role of ["office", "estimator", "crew_lead", "field_crew", "subcontractor"]) {
      as(role, ["invoices", "settings", "sales"]);
      expect(tabs(), role).not.toContain("payments");
    }
  });

  it("sits right after Company, and Contract terms still follows the estimate template", () => {
    as("owner", []);
    const business = settingsGroups(session.current as never).find((g) => g.title === "Business")!.items.map((i) => i.label);
    expect(business.indexOf("Payments")).toBe(business.indexOf("Company") + 1);
    expect(business.indexOf("Contract terms")).toBe(business.indexOf("Estimate template") + 1);
  });

  it("is found by searching for autopay, tips, a saved card or refunds", () => {
    as("owner", []);
    const item = settingsGroups(session.current as never).flatMap((g) => g.items).find((i) => "tab" in i && i.tab === "payments")!;
    expect(item).toMatchObject({ label: "Payments", icon: "card" });
    for (const word of ["autopay", "tips", "tip", "card on file", "saved card", "receipts", "stripe", "limit", "terms", "refund"]) expect(item.keywords).toContain(word);
  });

  it("opens from the Settings page", () => {
    expect(read("features/settings/SettingsPage.tsx")).toContain('{tab === "payments" && <PaymentSettings />}');
  });
});

describe("the autopay form", () => {
  it("shows the saved settings and sends them back as PUT /autopay/settings takes them", () => {
    const form = paymentForm({ ...SETTINGS, enabled: true, card_required: true });
    expect(form).toMatchObject({ enabled: true, timing: "end_of_day", max: "500", receipts: true, jobs_default: true, card_required: true });
    expect(autopayBody(form)).toEqual({ enabled: true, terms: SETTINGS.terms, timing: "end_of_day", days: null, max_amount: 500, receipts: true, jobs_default: true, card_required: true });
  });

  it("keeps days only with Days after, rounds the cap to cents, and blank means no limit", () => {
    const form = paymentForm(SETTINGS);
    expect(autopayBody({ ...form, timing: "days", days: "3", max: "250.555" })).toMatchObject({ timing: "days", days: 3, max_amount: 250.56 });
    expect(autopayBody({ ...form, timing: "now", days: "3", max: "" })).toMatchObject({ timing: "now", days: null, max_amount: null });
    expect(autopayBody({ ...form, terms: "  Charged after each mow.  " }).terms).toBe("Charged after each mow.");
    expect(paymentForm({ ...SETTINGS, max_amount: null }).max).toBe("");
  });

  it("says what to fix in the database's words", () => {
    const form = paymentForm(SETTINGS);
    expect(() => autopayBody({ ...form, terms: "   " })).toThrow("Write the terms clients agree to.");
    expect(() => autopayBody({ ...form, terms: "x".repeat(4001) })).toThrow("Write the terms clients agree to.");
    expect(() => autopayBody({ ...form, timing: "days", days: "0" })).toThrow("Choose 1 to 14 days.");
    expect(() => autopayBody({ ...form, timing: "days", days: "15" })).toThrow("Choose 1 to 14 days.");
    expect(() => autopayBody({ ...form, timing: "days", days: "2.5" })).toThrow("Choose 1 to 14 days.");
    expect(() => autopayBody({ ...form, max: "0" })).toThrow("The most to charge without asking has to be more than $0.");
    expect(() => autopayBody({ ...form, max: "2000000" })).toThrow("up to $1,000,000");
  });

  it("never carries the tip switch: that stays Settings → Company's", () => {
    expect(Object.keys(autopayBody(paymentForm(SETTINGS)))).not.toContain("hub_tips");
    const page = read("features/settings/PaymentSettings.tsx");
    expect(page).toContain('api.put<{ settings: AutopaySettings }>("/autopay/settings"');
    expect(page).not.toMatch(/from\("companies"\)/);
  });
});

describe("Settings → Payments", () => {
  it("asks for the company's own Stripe account first, and can't be turned on without it", () => {
    as("owner", []);
    const html = render(createElement(PaymentSettings), (client) => client.setQueryData(["company", COMPANY, "payments"], { ...STATUS, own: false, can_autopay: false, can_refund: false }));
    expect(text(html)).toContain("Connect your own Stripe account on the Apps page to use autopay.");
    expect(html).toContain('href="/apps/stripe"');
    expect(html).toMatch(/<input type="checkbox" class="switch" disabled=""/);
  });

  it("sends a key made before autopay to the Apps page to be updated", () => {
    as("admin", ["invoices"]);
    const page = paymentsPage({ can_autopay: false });
    expect(page).toContain("Update your Stripe key to turn on autopay");
    expect(page).toContain("Update your Stripe key on the Apps page to turn on autopay.");
  });

  it("warns when autopay is on but the key can't charge cards anymore, and still lets it be turned off", () => {
    as("owner", []);
    const html = render(createElement(PaymentSettings), (client) => client.setQueryData(["company", COMPANY, "payments"], { ...STATUS, can_autopay: false, settings: { ...SETTINGS, enabled: true } }));
    expect(text(html)).toContain("Your Stripe key can't charge saved cards anymore");
    expect(html).not.toMatch(/<input type="checkbox" class="switch" disabled=""/);
  });

  it("shows the terms, when clients are charged in the words they agree to, the cap and the switches", () => {
    as("owner", []);
    const page = paymentsPage({});
    for (const words of [
      "A key that can save cards",
      "Stripe's own emails off",
      "In Stripe, turn off emails about failed payments and receipts, so clients don't get two.",
      "Charge clients' saved cards when the work is done",
      "Terms clients agree to",
      SETTINGS.terms,
      'Clients read: "We charge at the end of the day of each visit."',
      "Most to charge without asking",
      "Over this, the charge waits for your OK. Leave it blank for no limit.",
      "Email a receipt after each charge",
      "Turn on autopay for new recurring jobs of clients on autopay",
      "Require a card on file",
      "Quotes ask for a card when they're signed",
      "Save payment settings",
    ]) expect(page, words).toContain(words);
    // The starter wording is what's there, so there's nothing to reset.
    expect(page).not.toContain("Use the suggested wording");
    expect(page).not.toContain("Overdue");
  });

  it("says where tips stand and links to the one switch, in Settings → Company", () => {
    as("owner", []);
    const on = render(createElement(PaymentSettings), (client) => client.setQueryData(["company", COMPANY, "payments"], STATUS));
    expect(text(on)).toContain("Tips are on");
    expect(text(on)).toContain("Clients choose a tip before they pay, and from the receipt after an automatic charge.");
    expect(on).toContain('href="/settings?tab=company"');
    const off = paymentsPage({ tips: false });
    expect(off).toContain("Tips are off");
    expect(off).toContain("no tip is charged");
    expect(off).not.toContain("Clients choose a tip");
  });

  it("lists the cards brought in from Stripe only when there are some", () => {
    as("owner", []);
    const cards: StripeCardRow[] = [{ client_id: CLIENT, name: "Pat Lee", email: "pat@lee.test", phone: null, card: "Visa ending 4242", expires: "08/28", turned_off: false }];
    expect(paymentsPage({ stripe_cards: 0 }, cards)).not.toContain("a card saved in Stripe");
    expect(paymentsPage({ stripe_cards: 1 }, cards)).toContain("1 client has a card saved in Stripe.");
  });
});

describe("tips have one switch", () => {
  it("is written only by Settings → Company", () => {
    // An object key set to a value (not a type saying what one is).
    const writers = sources().filter((f) => /\bhub_tips\s*:(?!\s*(?:boolean|unknown|string|number)\b)/.test(f.code)).map((f) => f.path);
    expect(writers).toEqual(["features/settings/CompanySettings.tsx"]);
  });

  it("says, under it, that it reaches the receipt and turns every tip off", () => {
    const company = read("features/settings/CompanySettings.tsx");
    expect(company).toContain("Let clients add a tip when they pay online");
    expect(company).toContain("Also offered on the receipt after an automatic charge. Off: no tip choice anywhere, and no tip is charged.");
    expect(company).toContain('hub_tips: v.hub_tips === "1"');
  });
});

describe("cards brought in from Stripe", () => {
  const method = (client_id: string, name: string, extra: Partial<{ id: string; is_default: boolean; last4: string; brand: string }> = {}) => ({
    id: extra.id ?? `pm-${client_id}`, client_id, type: "card", brand: extra.brand ?? "visa", last4: extra.last4 ?? "4242", bank_name: null, wallet: null, exp_month: 8, exp_year: 2028,
    is_default: extra.is_default ?? true, client: { id: client_id, display_name: name, email: `${name.split(" ")[0]!.toLowerCase()}@lawn.test`, phone: null },
  });

  it("lists each client once, with their default card, and leaves out those already on autopay", () => {
    const rows = stripeCardRows(
      [
        method("c-sam", "Sam Ortiz", { id: "pm-old", is_default: false, last4: "1111" }),
        method("c-sam", "Sam Ortiz", { id: "pm-new", is_default: true, last4: "2222", brand: "mastercard" }),
        method("c-pat", "Pat Lee"),
        method("c-ann", "Ann Agreed"),
        method("c-tim", "Tim Turnedoff", { brand: "amex", last4: "0005" }),
      ],
      [
        { client_id: "c-ann", revoked_at: null, revoked_via: null },
        { client_id: "c-tim", revoked_at: "2026-10-01T00:00:00Z", revoked_via: "client" },
        { client_id: "c-pat", revoked_at: "2026-10-01T00:00:00Z", revoked_via: "replaced" },
      ],
    );
    expect(rows.map((r) => r.name)).toEqual(["Pat Lee", "Sam Ortiz", "Tim Turnedoff"]);
    expect(rows.find((r) => r.name === "Sam Ortiz")).toMatchObject({ card: "Mastercard ending 2222", expires: "08/28", turned_off: false });
    expect(rows.find((r) => r.name === "Tim Turnedoff")).toMatchObject({ card: "American Express ending 0005", turned_off: true });
  });

  const cards: StripeCardRow[] = [
    { client_id: "c-pat", name: "Pat Lee", email: "pat@lee.test", phone: null, card: "Visa ending 4242", expires: "08/28", turned_off: false },
    { client_id: "c-sam", name: "Sam Ortiz", email: "sam@import.invalid", phone: "(555) 010-2000", card: "Visa ending 1881", expires: null, turned_off: false },
    { client_id: "c-tim", name: "Tim Turnedoff", email: "tim@lee.test", phone: null, card: "Visa ending 0005", expires: null, turned_off: true },
  ];
  const list = () => render(createElement(StripeCards, { enabled: true, termsVersion: "2026-10-31T14:05:09" }), (client) => client.setQueryData(["company", COMPANY, "payments", "stripe-cards"], cards));

  it("sends Confirm autopay links, by text to those with no email to send to", () => {
    as("admin", ["invoices"]);
    const page = text(list());
    expect(page).toContain("3 clients have a card saved in Stripe.");
    expect(page).toContain("Send Confirm autopay links");
    expect(page).toContain("Visa ending 4242 · expires 08/28");
    expect(page).toContain("Visa ending 1881 · By text");
    expect(page).toContain("Turned autopay off");
    // Recording that clients agreed is the owner's alone.
    expect(page).not.toContain("These clients agreed to be charged automatically");
    expect(list()).not.toContain('type="checkbox"');
  });

  it("lets an owner tick clients and record that they agreed, but not one who turned autopay off", () => {
    as("owner", []);
    const html = list();
    expect(text(html)).toContain("These clients agreed to be charged automatically");
    expect(html).toContain('aria-label="Choose Pat Lee"');
    expect(html).toMatch(/<input type="checkbox" disabled="" aria-label="Choose Tim Turnedoff"/);
  });

  it("asks to turn autopay on first", () => {
    as("owner", []);
    const page = text(render(createElement(StripeCards, { enabled: false, termsVersion: "starter-lawn_exterior-1" }), (client) => client.setQueryData(["company", COMPANY, "payments", "stripe-cards"], cards)));
    expect(page).toContain("Turn on autopay above and save first.");
  });

  it("vouches through the API with the saved terms version, and keeps the owner's words", () => {
    const code = read("features/settings/StripeCards.tsx");
    expect(code).toContain('"/clients/autopay/vouch", { client_ids: chunk, terms_version: termsVersion }');
    expect(code).toContain('"/clients/autopay/invite", { client_ids: chunk, channel }');
    expect(code).toContain("This is kept as their agreement, in your name, with today's terms.");
  });
});

describe("the client's Autopay card", () => {
  const card = (id: string, extra: Partial<AutopayMethod> = {}): AutopayMethod => ({
    id, type: "card", brand: "visa", last4: "4242", bank_name: null, wallet: null, exp_month: 8, exp_year: 2028, status: "active", is_default: false, source: "hub", created_at: "2026-10-31T12:00:00Z", ...extra,
  });
  const agreement = (extra: Partial<AutopayAgreement> = {}): AutopayAgreement => ({
    id: "a1", payment_method_id: "pm-1", accepted_at: "2026-10-31T14:00:00Z", source: "hub", recorded_by_name: "", paused_at: null, revoked_at: null, revoked_via: null, ...extra,
  });

  it("shows the card the agreement names, not a newer one they didn't agree to", () => {
    const a = clientAutopayOf([card("pm-2", { last4: "9999", is_default: true }), card("pm-1")], [agreement()], "2026-10-31T14:00:00Z", []);
    expect(a.method?.id).toBe("pm-1");
    expect(a.state).toBe("active");
  });

  it("tells active, paused, a bank account being checked and a card that needs replacing apart", () => {
    expect(clientAutopayOf([card("pm-1")], [agreement({ paused_at: "2026-11-01T00:00:00Z" })], null, []).state).toBe("paused");
    expect(clientAutopayOf([card("pm-1", { type: "us_bank_account", status: "pending" })], [agreement()], null, []).state).toBe("pending");
    expect(clientAutopayOf([card("pm-1", { status: "needs_update" })], [agreement()], null, []).state).toBe("needs_update");
    // A removed card isn't loaded, so the agreement has nothing to charge.
    expect(clientAutopayOf([], [agreement()], null, []).state).toBe("needs_update");
    const none = clientAutopayOf([card("pm-3", { is_default: true, source: "stripe_import" })], [agreement({ revoked_at: "2026-10-01T00:00:00Z", revoked_via: "client" })], null, []);
    expect(none).toMatchObject({ state: "none", live: null });
    expect(none.method?.id).toBe("pm-3");
  });

  it("says how they agreed", () => {
    expect(agreedText({ source: "hub", accepted_at: "2026-10-31T14:00:00Z", recorded_by_name: "" })).toBe("Agreed Oct 31, 2026 on their client page");
    expect(agreedText({ source: "confirmed", accepted_at: "2026-10-31T14:00:00Z", recorded_by_name: "" })).toBe("Confirmed Oct 31, 2026");
    expect(agreedText({ source: "owner", accepted_at: "2026-10-31T14:00:00Z", recorded_by_name: "Pat Radford" })).toBe("Recorded by Pat Radford on Oct 31, 2026");
  });

  const client = { id: CLIENT, display_name: "Pat Lee", email: "pat@lee.test", phone: "(555) 010-1000" };
  const page = (data: ClientAutopay) => render(createElement(AutopayCard, { client }), (q) => q.setQueryData(["client", CLIENT, "autopay"], data));

  it("shows the card, the agreement, the day they moved over and the last charges", () => {
    as("office", ["invoices"]);
    const html = page(clientAutopayOf([card("pm-1")], [agreement()], "2026-11-03T14:00:00Z", [
      { id: "ch1", status: "paid", due_at: "2026-11-04T05:00:00Z", invoice_id: "inv-2", charged_amount: 45, last_error: null, invoice: { number: 2, total: 45 } },
      { id: "ch2", status: "failed", due_at: "2026-11-08T05:00:00Z", invoice_id: "inv-3", charged_amount: null, last_error: "Your card was declined.", invoice: { number: 3, total: 45 } },
    ]));
    const words = text(html);
    for (const w of ["Autopay", "Active", "Visa ending 4242 · expires 08/28", "Agreed Oct 31, 2026 on their client page", "Charged from Crewtavo since Nov 3, 2026", "Pause", "Remove card", "Invoice #2", "$45.00", "Paid", "Failed"]) expect(words, w).toContain(w);
    expect(html).toContain('href="/invoices/inv-2"');
    // On autopay already: no invite to send.
    expect(words).not.toContain("Send autopay invite");
    // Credit the client had in Stripe paid it all: the invoice's total, not $0.00.
    const credit = text(page(clientAutopayOf([card("pm-1")], [agreement()], null, [
      { id: "ch3", status: "paid", due_at: "2026-11-04T05:00:00Z", invoice_id: "inv-4", charged_amount: 0, last_error: null, invoice: { number: 4, total: 160 } },
    ])));
    expect(credit).toContain("$160.00");
    expect(credit).toContain("Paid from Stripe credit");
    expect(credit).not.toContain("$0.00");
  });

  it("offers the invite when they aren't set up, and the Confirm link for a card from Stripe", () => {
    as("office", ["invoices"]);
    expect(text(page(clientAutopayOf([], [], null, [])))).toContain("Send autopay invite");
    const imported = text(page(clientAutopayOf([card("pm-9", { source: "stripe_import", is_default: true })], [], null, [])));
    expect(imported).toContain("Not set up");
    expect(imported).toContain("Saved in Stripe. Not charged until they confirm autopay.");
    expect(imported).toContain("Send Confirm autopay link");
  });

  it("asks them to set it up afresh once the client or office turned it off, for a card saved before that", () => {
    as("office", ["invoices"]);
    const offByClient = agreement({ revoked_at: "2026-11-01T12:00:00Z", revoked_via: "client" });
    // Brought in from Stripe before they turned it off: it can't be confirmed again.
    const before = text(page(clientAutopayOf([card("pm-9", { source: "stripe_import", is_default: true })], [offByClient], null, [])));
    expect(before).toContain("Turned off by the client on Nov 1, 2026");
    expect(before).toContain("Send autopay invite");
    expect(before).toContain("Not set up. Send them the link to save a card");
    expect(before).not.toMatch(/Confirm autopay|Saved in Stripe/);
    // Saved since: that one can be.
    const after = text(page(clientAutopayOf([card("pm-9", { source: "stripe_import", created_at: "2026-11-02T12:00:00Z" })], [offByClient], null, [])));
    expect(after).toContain("Send Confirm autopay link");
    expect(after).toContain("Saved in Stripe. Not charged until they confirm autopay.");
    // Turned off by the office: the same rule, without saying the client did it.
    const office = text(page(clientAutopayOf([card("pm-9", { source: "stripe_import" })], [agreement({ revoked_at: "2026-11-01T12:00:00Z", revoked_via: "office" })], null, [])));
    expect(office).toContain("Send autopay invite");
    expect(office).not.toContain("Turned off by the client");
    // A card changed (replaced) isn't a turn-off.
    expect(clientAutopayOf([card("pm-9")], [agreement({ revoked_at: "2026-11-01T12:00:00Z", revoked_via: "replaced" })], null, []).confirmable).toBe(true);
  });

  it("offers Turn back on while paused, and says a card needs replacing", () => {
    as("office", ["invoices"]);
    expect(text(page(clientAutopayOf([card("pm-1")], [agreement({ paused_at: "2026-11-01T00:00:00Z" })], null, [])))).toContain("Turn back on");
    expect(text(page(clientAutopayOf([card("pm-1", { status: "needs_update" })], [agreement()], null, [])))).toContain("Needs a new card");
  });

  it("is on the client page only for the office with invoices, once the company has autopay on", () => {
    const code = read("features/clients/ClientPage.tsx");
    expect(code).toContain("const seesMoney = isOffice && can(session, \"invoices\");");
    expect(code).toContain("{seesMoney && autopayOn && <AutopayCard client={c} />}");
    expect(code).toMatch(/Send autopay invite by email.*disabled: !c\.email, hidden: !seesMoney \|\| !autopayOn/);
    expect(code).toMatch(/Send autopay invite by text.*disabled: !c\.phone \|\| textsOff\(c\), hidden: !seesMoney \|\| !autopayOn/);
  });
});

describe("jobs and the clients list", () => {
  it("puts the job's switch behind the invoices area and the job types autopay charges", () => {
    const code = read("features/jobs/JobPage.tsx");
    expect(code).toContain("const autopayOn = seesInvoices && autopay.enabled;");
    expect(code).toContain("disabled={!autopayAllowed(j.kind, j.billing_mode)");
    expect(code).toContain("Autopay works with recurring jobs billed per visit, or one-off jobs billed when the work is done.");
    expect(code).toContain('supabase().from("jobs").update({ autopay: on })');
    expect(code).toContain('title: "Mark work complete?"');
  });

  it("tells a bank account being checked apart from a card that needs updating", () => {
    const code = read("features/jobs/JobPage.tsx");
    expect(code).toContain('checking: method?.status === "pending",');
    expect(code).toContain("jobAutopay.data.checking ? `Charges start once ${j.client.display_name}'s bank account is checked.`");
    // Checked before the card wording, which stays for one to update or none at all.
    expect(code.indexOf("bank account is checked.`")).toBeLessThan(code.indexOf("card needs updating before it's charged."));
  });

  it("sends invites to many clients in chunks the API takes", () => {
    const code = read("features/clients/ClientsPage.tsx");
    expect(code).toContain('"/clients/autopay/invite", { client_ids: ids.slice(i, i + INVITE_CHUNK), channel }');
    expect(code).toContain("const INVITE_CHUNK = 200;");
    expect(code).toContain("toast.success(`Sent ${r.sent}. Skipped ${r.skipped}.`)");
  });
});

describe("the Stripe key", () => {
  it("asks for what autopay needs, on top of what it asked before", () => {
    for (const p of ["webhook_write", "customer_write", "invoice_write", "charge_read", "payout_read", "setup_intent_write", "payment_method_write", "payment_intent_write", "checkout_session_write", "refund_write"]) {
      expect(STRIPE_KEY_PERMISSIONS, p).toContain(p);
      expect(STRIPE_NEW_KEY, p).toContain(`permissions%5B%5D=rak_${p}`);
    }
    expect(STRIPE_NEW_KEY.startsWith("https://dashboard.stripe.com/apikeys/create?name=Crewtavo&")).toBe(true);
  });

  it("is defined once, in the catalog, for the Apps page and the Stripe panel", () => {
    expect(read("features/apps/AppDetailPage.tsx")).not.toMatch(/const STRIPE_(KEY_PERMISSIONS|NEW_KEY)/);
    const panel = read("features/apps/StripePanel.tsx");
    expect(panel).toContain("details.own && !details.autopay");
    expect(panel).toContain("Update your key to turn on autopay. Saving cards, charging them and refunds need a new key with more permissions.");
    expect(panel).toContain('to="/settings?tab=payments"');
  });
});
