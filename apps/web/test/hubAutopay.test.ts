/**
 * Autopay and tips in the Client Hub (features/hub): the tip a page adds follows the business's one
 * switch (data.tips, the server's tipsAllowed), so with tips off no tip choice is drawn anywhere and
 * no tip is sent, the tip after an automatic charge included, even from the receipt's ?tip=1 link.
 * And the autopay states as the client sees them: on the invoice (paid automatically, being charged,
 * couldn't be charged), on their home (the autopay card, what's waiting on them, recent payments),
 * the autopay page's steps, and "Approve and set up autopay" on a quote charged by the visit.
 */
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ClientView } from "../src/features/hub/ClientPortal";
import { hubTip, type HubAutopay, type InvoiceView, type QuoteView } from "../src/features/hub/document";
import { HubPage } from "../src/features/hub/HubPage";

const company = { name: "Radford Lawn Care", phone: "555-0142", email: null, website: null, timezone: "America/New_York", branding: null, logo: null, address: [] };
const HOME = "https://ops.example.com/hub/home-token";

/** What a screen says, without its tags. */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ");

/** The Hub page for a link, as it draws with the server's answer already in. */
function page(view: unknown, search = "") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["hub", "tok"], view);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: [`/hub/tok${search}`] }, createElement(Routes, null, createElement(Route, { path: "/hub/:token", element: createElement(HubPage) }))),
    ),
  );
}

/** Invoice #2 for a $45 weekly mow, owed, with tips off and no autopay. */
function invoiceView(over: Partial<InvoiceView> = {}, invoice: Partial<InvoiceView["invoice"]> = {}): InvoiceView {
  return {
    kind: "invoice", home: HOME, company, template: {}, contract: null, drawings: [], preview: false,
    can_pay: true, processing: false, from_stripe: false, tips: false, autopay: null, save_card: false, tip_after: false, tip_method: null,
    invoice: {
      id: "i1", number: 2, status: "sent", subject: "Weekly mow", notes: null, issued_on: "2026-10-27", due_on: "2026-11-10",
      subtotal: 45, discount_amount: 0, tax_amount: 0, total: 45, retainage_amount: 0, amount_paid: 0, balance_due: 45, promo: null,
      client: { display_name: "Pat Lee" }, lines: [{ name: "Weekly mow", description: null, quantity: 1, unit: "visit", unit_price: 45 }], payments: [],
      ...invoice,
    },
    ...over,
  };
}
const PAID = { status: "paid", amount_paid: 45, balance_due: 0 };
const paidAutomatically = { status: "paid" as const, method: "Visa ending 4242", charged_at: "2026-10-27T23:10:00Z" };
const anyTip = /\btips?\b/i;

describe("hubTip", () => {
  it("is nothing while tips are off, whatever was chosen", () => {
    for (const choice of [0, 10, 15, 20, "custom"] as const) expect(hubTip({ tips: false, base: 45, choice, custom: "8" }), String(choice)).toBe(0);
  });

  it("is the percent chosen of what's tipped on, to the cent", () => {
    expect(hubTip({ tips: true, base: 45, choice: 15, custom: "" })).toBe(6.75);
    expect(hubTip({ tips: true, base: 45, choice: 0, custom: "" })).toBe(0);
    expect(hubTip({ tips: true, base: 33.33, choice: 15, custom: "" })).toBe(5);
    expect(hubTip({ tips: true, base: 120.5, choice: 20, custom: "" })).toBe(24.1);
  });

  it("is the amount typed for Other, never below nothing", () => {
    expect(hubTip({ tips: true, base: 45, choice: "custom", custom: "6.5" })).toBe(6.5);
    expect(hubTip({ tips: true, base: 45, choice: "custom", custom: "6.499" })).toBe(6.5);
    expect(hubTip({ tips: true, base: 45, choice: "custom", custom: "" })).toBe(0);
    expect(hubTip({ tips: true, base: 45, choice: "custom", custom: "." })).toBe(0);
    expect(hubTip({ tips: true, base: 45, choice: "custom", custom: "-5" })).toBe(0);
  });
});

describe("tips on an invoice page", () => {
  it("aren't drawn on Pay while tips are off", () => {
    const off = text(page(invoiceView()));
    expect(off).toContain("Pay $45.00 by card or bank");
    expect(off).not.toMatch(anyTip);
    const on = text(page(invoiceView({ tips: true })));
    expect(on).toContain("Add a tip for the crew?");
    expect(on).toContain("No tip");
    expect(on).toContain("15%");
  });

  it("aren't drawn after an automatic charge while tips are off, even from the receipt's ?tip=1 link", () => {
    // Even if a server said a tip could follow, the page holds to tips being off.
    const off = text(page(invoiceView({ tips: false, autopay: paidAutomatically, tip_after: true, tip_method: "Visa ending 4242" }, PAID), "?tip=1"));
    expect(off).toContain("Paid in full");
    expect(off).toContain("Paid automatically with Visa ending 4242 on Oct 27");
    expect(off).not.toMatch(anyTip);

    const on = text(page(invoiceView({ tips: true, autopay: paidAutomatically, tip_after: true, tip_method: "Visa ending 4242" }, PAID), "?tip=1"));
    expect(on).toContain("Add a tip for the crew?");
    expect(on).toContain("Add a tip to your Visa ending 4242");
    // After paying there's no "No tip": they came to add one.
    expect(on).not.toContain("No tip");
    // Not when the server says no tip can follow (a tip already added, another card, an office copy of the link).
    expect(text(page(invoiceView({ tips: true, autopay: paidAutomatically, tip_after: false }, PAID), "?tip=1"))).not.toMatch(anyTip);
  });

  it("are only ever drawn under data.tips in the page's code, and both go through hubTip", () => {
    const source = readFileSync(new URL("../src/features/hub/HubPage.tsx", import.meta.url), "utf8");
    const invoiceHub = source.slice(source.indexOf("function InvoiceHub("), source.indexOf("function HubDiscount("));
    // Pay's tip block, and the tip after an automatic charge.
    expect(invoiceHub.match(/<TipChoices/g)).toHaveLength(2);
    expect(invoiceHub).toMatch(/\{data\.tips && \(\s*<section className="card card-pad stack-sm">\s*<strong>Add a tip for the crew\?<\/strong>\s*<TipChoices/);
    expect(invoiceHub).toContain("const tipAfter = balance <= 0 && data.tips && Boolean(data.tip_after)");
    expect(invoiceHub).toMatch(/\{tipAfter && \(\s*<section ref=\{tipSection\}/);
    expect(invoiceHub.match(/hubTip\(\{ tips: data\.tips,/g)).toHaveLength(2);
    // What's posted is what hubTip worked out.
    expect(invoiceHub).toContain("hubFetch<{ url: string }>(`${token}/pay`, { tip })");
    expect(invoiceHub).toContain("hubFetch<{ status: \"paid\"; tip: number }>(`${token}/tip`, { tip: afterTip })");
  });
});

describe("buttons that name the card", () => {
  const css = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");

  it("wrap onto a second line inside a phone's card rather than run past it", () => {
    // .btn is nowrap; .btn-wrap lets the label wrap, grows the button to fit, and holds it to the card's width.
    const rule = css.match(/\.btn-wrap \{([^}]*)\}/)?.[1] ?? "";
    for (const part of ["white-space: normal", "height: auto", "min-height: var(--control)", "max-width: 100%", "min-width: 0"]) expect(rule).toContain(part);
    expect(css).toMatch(/\.btn-lg\.btn-wrap \{[^}]*min-height: var\(--control-lg\)/);
  });

  it("are the tip after an automatic charge, the autopay page's Use and Keep, and the owner's word in Settings", () => {
    const tip = page(invoiceView({ tips: true, autopay: paidAutomatically, tip_after: true, tip_method: "American Express ending 1005" }, PAID), "?tip=1");
    expect(tip).toMatch(/<button[^>]*class="btn btn-primary btn-wrap"[^>]*>(?:(?!<\/button>).)*Add a tip to your American Express ending 1005<\/button>/);
    const autopay = readFileSync(new URL("../src/features/hub/HubAutopay.tsx", import.meta.url), "utf8");
    // Each on one line of the source, with wrap among its props.
    expect(autopay).toMatch(/<Button [^\n]* wrap [^\n]*>Use \{method\.label\}<\/Button>/);
    expect(autopay).toMatch(/<Button [^\n]* wrap [^\n]*>Keep \{autopay\.method\?\.label \?\? "your card"\}<\/Button>/);
    const cards = readFileSync(new URL("../src/features/settings/StripeCards.tsx", import.meta.url), "utf8");
    expect(cards).toMatch(/<Button [^\n]* wrap [^\n]*>These clients agreed to be charged automatically<\/Button>/);
  });
});

describe("autopay on an invoice page", () => {
  it("says it's being charged now, with no Pay", () => {
    const html = text(page(invoiceView({ autopay: { status: "charging", method: "Visa ending 4242", charged_at: null }, can_pay: false })));
    expect(html).toContain("Charging your Visa ending 4242 now");
    expect(html).not.toContain("Pay $45.00");
    expect(html).not.toContain("To pay, contact");
    expect(html).not.toContain("Have a promo code?");
  });

  it("keeps Pay when the charge didn't go through, with a way to update the card", () => {
    const html = page(invoiceView({ autopay: { status: "failed", method: "Visa ending 4242", charged_at: null }, tips: true }));
    expect(text(html)).toContain("We couldn't charge your Visa ending 4242. We'll try again in a few days, or you can pay now.");
    expect(html).toContain(`href="${HOME}?view=autopay"`);
    expect(text(html)).toContain("Pay $45.00 by card or bank");
    const confirm = text(page(invoiceView({ autopay: { status: "needs_client", method: "Visa ending 4242", charged_at: null } })));
    expect(confirm).toContain("We couldn't charge your Visa ending 4242 automatically. Pay below, or update your card.");
    // A preview has no link home, and says nothing about the card.
    expect(text(page(invoiceView({ preview: true, home: null, can_pay: false, autopay: { status: "failed", method: "Visa ending 4242", charged_at: null } })))).not.toContain("Update your card");
  });

  it("says a bank payment is on its way once, under the heading", () => {
    const html = text(page(invoiceView({ autopay: { status: "processing", method: "Chase ending 6789", charged_at: null }, processing: true, can_pay: false })));
    expect(html.match(/Your bank payment is on its way/g)).toHaveLength(1);
  });

  it("says nothing of trying the card again while the client's own bank payment is on its way", () => {
    const html = text(page(invoiceView({ autopay: { status: "failed", method: "Visa ending 4242", charged_at: null }, processing: true, can_pay: false })));
    expect(html.match(/Your bank payment is on its way/g)).toHaveLength(1);
    expect(html).not.toContain("We couldn't charge your Visa ending 4242");
    expect(html).not.toContain("try again");
    expect(html).not.toContain("Update your card");
  });

  it("says it was paid automatically only while nothing is owed, after a refund", () => {
    // Refunded and put back to owed: Pay, and no "Paid automatically" under "$45.00 due".
    const owedAgain = text(page(invoiceView({ autopay: paidAutomatically }, { payments: [{ amount: 45, received_at: "2026-10-27T23:10:00Z" }, { amount: -45, received_at: "2026-10-29T15:00:00Z" }] } as never)));
    expect(owedAgain).toContain("$45.00 due");
    expect(owedAgain).not.toContain("Paid automatically");
    expect(owedAgain).toContain("Pay $45.00 by card or bank");
  });

  it("asks for nothing on an invoice the office wrote off, whatever the server says about paying", () => {
    const html = text(page(invoiceView({ autopay: paidAutomatically, can_pay: true, save_card: true }, { status: "written_off" })));
    expect(html).toContain("Nothing due");
    expect(html).not.toContain("$45.00 due");
    expect(html).not.toContain("Paid in full");
    expect(html).not.toContain("Paid automatically");
    expect(html).not.toMatch(/Pay \$|To pay, contact|Pay automatically next time/);
    // On the invoice as it prints too.
    expect(html).not.toContain("Balance due $45.00");
    expect(html.match(/Balance due \$0\.00/g)).toHaveLength(2);
  });

  it("offers to save the card near the top whenever it's paid, with nothing in the address needed", () => {
    const html = page(invoiceView({ save_card: true }, PAID));
    const paid = text(html);
    // It may have been paid by check: nothing says "this card".
    expect(paid).toContain("Paid. Pay automatically next time?");
    expect(paid).not.toContain("this card");
    expect(paid).toContain("Save a card once, and we charge it after each visit. You'll get a receipt each time.");
    expect(paid.match(/Save a card\b(?! once)/g)).toHaveLength(1);
    // Right under the heading, before the invoice's lines.
    expect(paid.indexOf("Paid. Pay automatically next time?")).toBeGreaterThan(paid.indexOf("Paid in full"));
    expect(paid.indexOf("Paid. Pay automatically next time?")).toBeLessThan(paid.indexOf("Weekly mow 1 visit"));
    // Not while it's owed, not when the server says no (autopay on, or a card already saved), and not in a preview.
    expect(text(page(invoiceView({ save_card: true })))).not.toContain("Save a card");
    expect(text(page(invoiceView({ save_card: false }, PAID)))).not.toContain("Save a card");
    expect(text(page(invoiceView({ save_card: true, preview: true }, PAID)))).not.toContain("Save a card");
  });

  it("has no thank-you for ?paid=1, which nothing sends: paying ends on Stripe's page", () => {
    const back = text(page(invoiceView({ save_card: true }), "?paid=1"));
    expect(back).not.toContain("Your payment is processing.");
    expect(back).not.toContain("Save a card");
    const source = readFileSync(new URL("../src/features/hub/HubPage.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/params\.get\("paid"\)/);
    // The plan says the same: the offer is on the paid invoice opened again, not at the end of paying.
    const plan = readFileSync(new URL("../../../docs/autopay-plan.md", import.meta.url), "utf8");
    expect(plan).toContain("a paid invoice, when the client opens it again");
    expect(plan).toContain('"Paid. Pay automatically next time?"');
    expect(plan).not.toContain("Save this card");
    expect(plan).not.toMatch(/the end of paying an invoice \(|After paying by hand \| Back to the invoice/);
  });
});

/** The client's home: Pat, with nothing waiting and the business taking autopay when `autopay` is set. */
function clientView(over: Partial<ClientView> = {}): ClientView {
  return {
    kind: "client", company, preview: false, autopay: null,
    client: { name: "Pat Lee", first_name: "Pat", properties: [{ id: "p1", line1: "12 Elm St", city: "Radford" }] },
    quotes: [], invoices: [], visits: [], past_visits: [], payments: [], requests: [], services: [], refer: null,
    ...over,
  };
}
const active: HubAutopay = {
  status: "active", method: { id: "pm-1", type: "card", label: "Visa ending 4242", exp: "08/28" }, imported: false, since: "2026-10-31T14:05:09Z",
  terms: "We charge the card on file after each visit is done. Turn it off anytime from your client page or by calling us.", terms_version: "2026-10-31T14:05:09",
  timing: "at the end of the day of each visit", next_charge: null, per_visit: 45,
};
const owed = (id: string, number: number, autopay: string | null) => ({
  id, number, subject: "Weekly mow", status: "sent", total: 45, balance_due: 45, due_on: "2026-11-10", issued_on: "2026-10-27", link: `https://ops.example.com/hub/${id}`, autopay: autopay as never,
});

describe("autopay on the client's home", () => {
  it("shows nothing about it when the business doesn't take autopay", () => {
    expect(text(page(clientView()))).not.toMatch(/autopay|automatically/i);
  });

  it("starts it when they're not on it, and shows it when they are", () => {
    const off = text(page(clientView({ autopay: { ...active, status: "off", method: null, since: null } })));
    expect(off).toContain("Pay automatically after each visit");
    expect(off).toContain("Save a card once, and we charge it at the end of the day of each visit.");
    expect(off).toContain("Pay automatically");
    // A business that needs a card on file: a step left to do.
    const required = text(page(clientView({ autopay: { ...active, status: "off", method: null, since: null, card_required: true } })));
    expect(required).toContain("Finish setting up: add your card");
    expect(required).toContain("A card on file is required for service. You'll add it on Stripe's secure page.");
    expect(required).toContain("Add your card");
    expect(required).not.toContain("Pay automatically after each visit");
    // It's what's waiting on them, not "All caught up".
    expect(required).toContain("Waiting on you");
    expect(required).not.toContain("All caught up");
    expect(required.indexOf("Waiting on you")).toBeLessThan(required.indexOf("Finish setting up: add your card"));

    const on = text(page(clientView({ autopay: { ...active, next_charge: "2099-11-04T15:00:00Z" } })));
    expect(on).toContain("Paid automatically · Visa ending 4242");
    expect(on).toMatch(/Next charge on Nov \d/);
    expect(on).toContain("Change card");
    expect(on).toContain("Turn off");
  });

  it("keeps an agreement in force on hold while the business can't take autopay, with Turn off", () => {
    const html = text(page(clientView({ autopay: { ...active, available: false }, invoices: [owed("i4", 4, "failed")] })));
    expect(html).toContain("Autopay is on hold · Visa ending 4242");
    expect(html).toContain("Charges are on hold for now.");
    expect(html).toContain("Turn off");
    expect(html).not.toMatch(/Change card|Update your card|Paid automatically/);
  });

  it("says what's left to do, or what to know", () => {
    expect(text(page(clientView({ autopay: { ...active, status: "agree", imported: true, since: null } })))).toContain("We have your Visa ending 4242 on file");
    expect(text(page(clientView({ autopay: { ...active, status: "agree", since: null } })))).toContain("Finish setting up");
    expect(text(page(clientView({ autopay: { ...active, status: "pending" } })))).toContain("Your bank account is being checked");
    expect(text(page(clientView({ autopay: { ...active, status: "paused" } })))).toContain("Autopay is paused Contact us to turn it back on.");
    const update = text(page(clientView({ autopay: { ...active, status: "needs_update" } })));
    expect(update).toContain("Your card needs updating");
    expect(update).toContain("Update card");
  });

  it("leaves an invoice being charged out of what's waiting on them, and keeps one that couldn't be", () => {
    const charging = text(page(clientView({ autopay: active, invoices: [owed("i3", 3, "charging"), owed("i5", 5, "processing")] })));
    expect(charging).toContain("All caught up");
    expect(charging).not.toContain("Pay $45.00");

    const failed = text(page(clientView({ autopay: active, invoices: [owed("i4", 4, "failed")] })));
    expect(failed).toContain("Waiting on you");
    expect(failed).toContain("We couldn't charge your card for this one.");
    expect(failed).toContain("Pay $45.00");
    expect(failed).toContain("Update your card");
  });

  it("says a payment was charged automatically, and to which card", () => {
    const html = text(page(clientView({
      autopay: active,
      payments: [
        { amount: 45, tip_amount: 0, method: "card", received_at: "2026-10-27T23:10:00Z", invoice: 2, auto: true, card: "Visa ending 4242" },
        { amount: 30, tip_amount: 0, method: "check", received_at: "2026-10-20T15:00:00Z", invoice: 1, auto: false, card: null },
      ],
    })));
    expect(html).toContain("$45.00 charged automatically to Visa ending 4242");
    expect(html).toContain("$30.00 by check");
  });
});

describe("the autopay page", () => {
  const view = (autopay: HubAutopay | null, over: Partial<ClientView> = {}) => page(clientView({ autopay, ...over }), "?view=autopay");

  it("starts with how it works when they're not on it", () => {
    const html = text(view({ ...active, status: "off", method: null, since: null }, { visits: [{ id: "v1", title: "Weekly mow", scheduled_on: "2026-11-04", starts_at: null, ends_at: null, status: "scheduled", completed_at: null, address: null, crew: [] }] }));
    expect(html).toContain("Pay automatically");
    for (const step of ["How it works", "Add a card", "Agree"]) expect(html).toContain(step);
    expect(html).toContain("We charge your card or bank account at the end of the day of each visit. Each visit is $45.00.");
    expect(html).toContain("Your next visit is Wednesday, Nov 4.");
    expect(html).toContain("We charge the card on file after each visit is done.");
    expect(html).toContain("We charge at the end of the day of each visit.");
    expect(html).toContain("call us at 555-0142");
  });

  it("goes straight to agreeing for a card they have on file, with the box unticked", () => {
    const html = view({ ...active, status: "agree", imported: true, since: null });
    expect(text(html)).toContain("Agree and finish");
    expect(text(html)).toContain("Visa ending 4242");
    expect(text(html)).toContain("I agree to these terms");
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*>/);
    // Finish waits for the tick.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Finish<\/button>/);
  });

  it("shows the card and since when once it's on, with Change card and Turn off autopay", () => {
    const html = text(view(active));
    expect(html).toContain("Visa ending 4242");
    expect(html).toContain("Since Oct 31");
    expect(html).toContain("Expires 08/28");
    expect(html).toContain("Change card");
    expect(html).toContain("Turn off autopay");
    // Paused by the office: only turning it off.
    const paused = text(view({ ...active, status: "paused" }));
    expect(paused).toContain("Autopay is paused. Contact us to turn it back on.");
    expect(paused).not.toContain("Change card");
    expect(paused).toContain("Turn off autopay");
  });

  it("says it isn't available when the business doesn't take autopay", () => {
    expect(text(view(null))).toContain("Autopay isn't available right now. Contact Radford Lawn Care to set it up.");
  });

  it("still shows an agreement in force while the business can't take autopay, with only Turn off", () => {
    for (const status of ["active", "needs_update", "pending"] as const) {
      const html = text(view({ ...active, status, available: false }));
      expect(html, status).toContain("Visa ending 4242");
      expect(html, status).toContain("Since Oct 31");
      expect(html, status).toContain("Charges are on hold for now. Until they start again, invoices come to you to pay.");
      expect(html, status).toContain("Turn off autopay");
      expect(html, status).not.toMatch(/Change card|Update card|isn't available/);
    }
  });

  it("says tax goes on top of each visit's price when it does", () => {
    const off = { ...active, status: "off" as const, method: null, since: null };
    expect(text(view({ ...off, per_visit_taxed: true }))).toContain("We charge your card or bank account at the end of the day of each visit. It's $45.00 per visit, plus tax.");
    expect(text(view({ ...off, per_visit_taxed: true }))).not.toContain("Each visit is");
    expect(text(view({ ...off, per_visit_taxed: false }))).toContain("Each visit is $45.00.");
  });

  it("can't be used from a preview", () => {
    const html = view({ ...active, status: "off", method: null, since: null }, { preview: true });
    expect(text(html)).toContain("Preview: your client sets up autopay here.");
    const card = view(active, { preview: true });
    for (const label of ["Change card", "Turn off autopay"]) expect(card).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>(?:(?!</button>).)*${label}</button>`));
  });
});

describe("a quote charged by the visit", () => {
  function quoteView(over: Partial<QuoteView> = {}, quote: Partial<QuoteView["quote"]> = {}): QuoteView {
    return {
      kind: "quote", home: HOME, company, template: {}, contract: null, drawings: [], preview: false, autopay_offer: true,
      quote: {
        id: "q1", number: 12, status: "sent", title: "Weekly mowing", message: null, subtotal: 45, discount_amount: 0, promo: null, tax_rate: 0, tax_amount: 0, total: 45,
        deposit_amount: 0, valid_until: null, sent_at: "2026-10-22T15:00:00Z", approved_at: null, client: { display_name: "Pat Lee" }, property: null, range: null,
        lines: [{ id: "l1", name: "Weekly mow", description: null, quantity: 1, unit: "visit", unit_price: 45, optional: false, selected: true }],
        ...quote,
      },
      ...over,
    };
  }

  it("offers \"Approve and set up autopay\" beside Approve when the server offers it", () => {
    const html = text(page(quoteView()));
    expect(html).toContain("Approve quote");
    expect(html).toContain("Approve and set up autopay");
    expect(text(page(quoteView({ autopay_offer: false })))).not.toContain("autopay");
  });

  it("asks for a card before they sign, with one button, when the business needs a card on file", () => {
    const html = page(quoteView({ card_required: true }));
    expect(text(html)).toContain("A card on file is required for service. After you sign, you'll add yours on Stripe's secure page.");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*data-autopay="1"[^>]*>(?:(?!<\/button>).)*Approve and add your card<\/button>/);
    // No way to approve without the card.
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(text(html)).not.toContain("Approve quote");
    expect(text(html)).not.toContain("Approve and set up autopay");
  });

  it("leaves adding the card as the step left to do once it's signed, when a card is required", () => {
    const html = page(quoteView({ card_required: true }, { status: "approved", approved_at: "2026-10-23T15:00:00Z", approval: { name: "Pat Lee", signature: null, signed_at: "2026-10-23T15:00:00Z", company: null } }));
    expect(text(html)).toContain("Finish setting up: add your card");
    expect(text(html)).toContain("Add your card");
    expect(html).toContain(`href="${HOME}?view=autopay"`);
  });

  it("offers to pay automatically once it's signed", () => {
    const html = page(quoteView({}, { status: "approved", approved_at: "2026-10-23T15:00:00Z", approval: { name: "Pat Lee", signature: null, signed_at: "2026-10-23T15:00:00Z", company: null } }));
    expect(text(html)).toContain("Pay automatically after each visit");
    expect(html).toContain(`href="${HOME}?view=autopay"`);
    expect(text(page(quoteView({ autopay_offer: false }, { status: "approved", approved_at: "2026-10-23T15:00:00Z" })))).not.toContain("Pay automatically");
  });
});
