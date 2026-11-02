import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { hmacSha256Hex } from "../src/lib/crypto";
import {
  cents,
  importedLines,
  paymentMethod,
  STRIPE_VERSION,
  stripeApi,
  StripeError,
  stripeForm,
  stripeLineItems,
  stripeList,
  type BillableInvoice,
  type StripeCharge,
} from "../src/services/stripe";

// Provider calls normally get 15 seconds; a test can make that shorter.
const timeout = vi.hoisted(() => ({ ms: 15_000 }));
vi.mock("../src/integrations/registry", async (original) => ({
  ...(await original<typeof import("../src/integrations/registry")>()),
  providerTimeout: () => AbortSignal.timeout(timeout.ms),
}));

const invoice = (patch: Partial<BillableInvoice> = {}): BillableInvoice => ({
  number: 42,
  subject: "May mowing",
  subtotal: 160,
  discount_amount: 0,
  tax_rate: 0,
  tax_amount: 0,
  retainage_pct: 0,
  retainage_amount: 0,
  amount_paid: 0,
  balance_due: 160,
  lines: [
    { name: "Weekly mowing", quantity: 4, unit: "visit", unit_price: 35, sort: 1 },
    { name: "Edging", quantity: 1, unit: "ea", unit_price: 20, sort: 2 },
  ],
  ...patch,
});
const total = (items: Array<{ amount: number }>) => items.reduce((sum, item) => sum + item.amount, 0);

describe("stripe form encoding", () => {
  it("nests objects and arrays the way Stripe reads them", () => {
    const form = stripeForm({ customer: "cus_1", metadata: { invoice: "abc" }, expand: ["charge.balance_transaction"], custom_fields: [{ name: "Invoice", value: "#4" }], skip: undefined, none: null, auto_advance: false });
    expect(form.toString()).toBe(
      "customer=cus_1&metadata%5Binvoice%5D=abc&expand%5B0%5D=charge.balance_transaction&custom_fields%5B0%5D%5Bname%5D=Invoice&custom_fields%5B0%5D%5Bvalue%5D=%234&auto_advance=false",
    );
  });

  it("sends an empty string, which tells Stripe not to inherit a value", () => {
    expect(stripeForm({ discounts: "" }).toString()).toBe("discounts=");
  });
});

describe("stripe line items", () => {
  it("adds up to the balance, line by line", () => {
    const items = stripeLineItems(invoice());
    expect(items).toEqual([
      { description: "Weekly mowing (4 visit × $35.00)", amount: 14000 },
      { description: "Edging", amount: 2000 },
    ]);
    expect(total(items)).toBe(16000);
  });

  it("shows the discount, tax, retainage, what was paid and the tip", () => {
    const items = stripeLineItems(
      invoice({ discount_amount: 10, promo: { code: "SPRING" }, tax_rate: 0.0825, tax_amount: 12.38, retainage_pct: 10, retainage_amount: 16.24, amount_paid: 50, balance_due: 96.14 }),
      1500,
    );
    expect(items.map((i) => i.description)).toEqual(["Weekly mowing (4 visit × $35.00)", "Edging", "Discount (SPRING)", "Tax (8.25%)", "Retainage held (10%), billed later", "Already paid", "Tip for the crew"]);
    expect(total(items)).toBe(9614 + 1500);
  });

  it("shows each referral credit under its note, as much of it as the invoice takes, and still adds up", () => {
    // $160 less a $10 promo less $55 of credits, taxed at 5%: $95 + $4.75.
    const items = stripeLineItems(invoice({
      discount_amount: 10, promo: { code: "SPRING" }, credit_amount: 55, tax_rate: 0.05, tax_amount: 4.75, balance_due: 99.75,
      credits: [{ amount: 50, note: "Referral credit: thanks for referring Maria" }, { amount: 20, note: "Referral credit: thanks for referring Nia" }],
    }));
    expect(items.slice(2, 5)).toEqual([
      { description: "Discount (SPRING)", amount: -1000 },
      { description: "Referral credit: thanks for referring Maria", amount: -5000 },
      { description: "Referral credit: thanks for referring Nia", amount: -500 },
    ]);
    expect(items.some((i) => i.description === "Rounding")).toBe(false);
    expect(total(items)).toBe(9975);
  });

  it("names the tax rate as it's kept, to 0.0001%", () => {
    const tax = (tax_rate: number) =>
      stripeLineItems(invoice({ tax_rate, tax_amount: 14.2, balance_due: 174.2 })).find((i) => i.description.startsWith("Tax"))?.description;
    expect(tax(0.08875)).toBe("Tax (8.875%)");
    expect(tax(0.088755)).toBe("Tax (8.8755%)");
    expect(tax(0.047125)).toBe("Tax (4.7125%)");
    expect(tax(0.1)).toBe("Tax (10%)");
  });

  it("evens out any rounding so Stripe asks for exactly what's owed", () => {
    const items = stripeLineItems(invoice({ lines: [{ name: "Mulch", quantity: 3, unit: "yd", unit_price: 33.335, sort: 1 }], subtotal: 100.01, balance_due: 100.01 }));
    expect(total(items)).toBe(10001);
  });

  it("sums up long invoices in one line", () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ name: `Visit ${i + 1}`, quantity: 1, unit: "visit", unit_price: 40, sort: i }));
    const items = stripeLineItems(invoice({ lines, subtotal: 1200, balance_due: 1200 }));
    expect(items).toEqual([{ description: "Invoice #42: May mowing (30 items)", amount: 120000 }]);
  });

  it("skips free lines", () => {
    const items = stripeLineItems(invoice({ lines: [{ name: "Mowing", quantity: 1, unit: "ea", unit_price: 50, sort: 1 }, { name: "Free edging", quantity: 1, unit: "ea", unit_price: 0, sort: 2 }], subtotal: 50, balance_due: 50 }));
    expect(items).toEqual([{ description: "Mowing", amount: 5000 }]);
  });
});

describe("invoices made in Stripe", () => {
  it("come in with lines that add up to what's due", () => {
    const lines = importedLines({ total: 10750, amount_due: 10750, tax: 750, total_discount_amounts: [] }, [
      { id: "il_1", amount: 10000, description: "Weekly mowing", quantity: 4 },
    ]);
    expect(lines).toEqual([
      { name: "Weekly mowing", quantity: 4, unit_price: 25 },
      { name: "Tax", quantity: 1, unit_price: 7.5 },
    ]);
  });

  it("keep account credit and odd quantities", () => {
    const lines = importedLines({ total: 9000, amount_due: 6000, tax: 0, total_discount_amounts: [{ amount: 1000 }] }, [
      { id: "il_1", amount: 10000, description: null, quantity: 3 },
    ]);
    expect(lines).toEqual([
      { name: "Item", quantity: 1, unit_price: 100 },
      { name: "Discount", quantity: 1, unit_price: -10 },
      { name: "Account credit applied", quantity: 1, unit_price: -30 },
    ]);
    expect(lines.reduce((sum, l) => sum + cents(l.quantity * l.unit_price), 0)).toBe(6000);
  });
});

describe("payment methods", () => {
  it("maps Stripe's payment types to ours", () => {
    const charge = (type?: string) => ({ payment_method_details: type ? { type } : null }) as StripeCharge;
    expect(paymentMethod(charge("card"))).toBe("card");
    expect(paymentMethod(charge("us_bank_account"))).toBe("ach");
    expect(paymentMethod(charge("cashapp"))).toBe("other");
    expect(paymentMethod(null)).toBe("card");
  });
});

describe("stripe api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    timeout.ms = 15_000;
  });

  it("pins the API version, sends idempotency keys and reads Stripe's errors", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "No such customer: 'cus_x'", code: "resource_missing", param: "customer" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const error = await stripeApi("sk_test_1", "POST", "/v1/invoices", { customer: "cus_x" }, { idempotencyKey: "k1" }).catch((e) => e);
    expect(error).toBeInstanceOf(StripeError);
    expect(error).toMatchObject({ status: 400, code: "resource_missing", param: "customer" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/invoices");
    expect(init.headers).toMatchObject({ "Stripe-Version": STRIPE_VERSION, "Idempotency-Key": "k1", Authorization: "Bearer sk_test_1" });
    expect(init.body).toBe("customer=cus_x");
  });

  it("keeps why a card was declined and how far its payment got", async () => {
    const declined = {
      error: {
        type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds.",
        payment_intent: { id: "pi_1", status: "requires_payment_method" },
      },
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(declined), { status: 402 }));
    vi.stubGlobal("fetch", fetch);
    const error = await stripeApi("sk_test_1", "POST", "/v1/invoices/in_1/pay", { off_session: true }, { idempotencyKey: "k1" }).catch((e) => e);
    expect(error).toBeInstanceOf(StripeError);
    expect(error).toMatchObject({
      status: 402, code: "card_declined", declineCode: "insufficient_funds", type: "card_error", paymentIntent: "pi_1", paymentIntentStatus: "requires_payment_method",
      message: "Your card has insufficient funds.",
    });
    // A decline is Stripe's answer, not a failure to answer: it isn't sent again.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up on a call Stripe doesn't answer, and tries again only when that's safe", async () => {
    // Hangs until the call's own time limit (shortened here) runs out.
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))));
    vi.stubGlobal("fetch", fetch);
    timeout.ms = 20;
    const error = await stripeApi("sk_test_1", "POST", "/v1/invoices", { customer: "cus_1" }, { idempotencyKey: "k1" }).catch((e) => e);
    expect(error).toBeInstanceOf(StripeError);
    expect(error).toMatchObject({ status: 0 });
    // Tried three times with the same idempotency key, so Stripe does it at most once.
    expect(fetch.mock.calls.map(([, init]) => (init.headers as Record<string, string>)["Idempotency-Key"])).toEqual(["k1", "k1", "k1"]);

    fetch.mockClear();
    expect(await stripeApi("sk_test_1", "POST", "/v1/customers", { email: "pat@example.com" }).catch((e) => e)).toBeInstanceOf(StripeError);
    // No idempotency key: it may have gone through, so it isn't sent again.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a read that timed out", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "in_1" })));
    vi.stubGlobal("fetch", fetch);
    expect(await stripeApi("sk_test_1", "GET", "/v1/invoices/in_1")).toEqual({ id: "in_1" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("pages through lists", async () => {
    const pages = [
      { data: [{ id: "in_1" }, { id: "in_2" }], has_more: true },
      { data: [{ id: "in_3" }], has_more: false },
    ];
    const fetch = vi.fn(async () => new Response(JSON.stringify(pages.shift())));
    vi.stubGlobal("fetch", fetch);
    const ids: string[] = [];
    for await (const item of stripeList<{ id: string }>("sk_test_1", "/v1/invoices", { created: { gte: 100 } })) ids.push(item.id);
    expect(ids).toEqual(["in_1", "in_2", "in_3"]);
    expect(String((fetch.mock.calls[1] as unknown as [string])[0])).toContain("starting_after=in_2");
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toContain("created%5Bgte%5D=100");
  });
});

describe("stripe webhook routes", () => {
  const env: Env = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    ENCRYPTION_KEY: btoa("k".repeat(32)),
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  };
  const post = (path: string, body: string, signature?: string) =>
    app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...(signature ? { "Stripe-Signature": signature } : {}) }, body }, env);

  it("refuses unsigned events and companies that aren't real", async () => {
    expect((await post("/api/webhooks/stripe", "{}")).status).toBe(400);
    const t = Math.floor(Date.now() / 1000);
    const forged = `t=${t},v1=${await hmacSha256Hex("whsec_other", `${t}.{}`)}`;
    expect((await post("/api/webhooks/stripe", "{}", forged)).status).toBe(400);
    expect((await post("/api/webhooks/stripe/not-a-company", "{}", forged)).status).toBe(404);
  });
});
