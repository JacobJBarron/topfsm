import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { formPage, newFormKey } from "../src/services/websiteForms";

// Website forms: a form on the business's own website posts to /f/<key>, like Formspree. The
// database's part (finding the client, making the request) is in supabase/tests/website_forms_test.sql.

const current = vi.hoisted(() => ({ db: null as unknown, background: [] as Array<Promise<unknown>>, emails: [] as Array<Record<string, unknown>> }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));
vi.mock("../src/lib/background", () => ({
  runInBackground: (_c: unknown, work: Promise<unknown>) => void current.background.push(work),
  kickAutomations: () => undefined,
}));
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  emailReady: async () => true,
  sendEmail: async (_env: unknown, message: Record<string, unknown>) => {
    current.emails.push(message);
    return { sent: true, id: "e1" };
  },
}));
vi.mock("../src/services/external", async (original) => ({ ...(await original<typeof import("../src/services/external")>()), geocodeAddress: async () => null }));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://crm.greenlawn.example",
};
const COMPANY = "00000000-0000-4000-8000-000000000001";
const FORM_ID = "00000000-0000-4000-8000-0000000000f1";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000e1";
const USER = "00000000-0000-4000-8000-0000000000aa";
const KEY = "3fa9c2d71b";
const THANKS = `https://crm.greenlawn.example/f/${KEY}/thanks`;

interface Query { table: string; calls: Array<[string, ...any[]]> }

const form = (changes: Record<string, unknown> = {}) => ({
  id: FORM_ID, key: KEY, name: "Contact form", email_to: ["office@greenlawn.example", "sam@greenlawn.example"], redirect_url: null, allowed_sites: [],
  company: { id: COMPANY, name: "Green Lawn", settings: { website_forms: { enabled: true } } },
  ...changes,
});

/** A database that answers by table and function, and remembers what was asked of it. */
function fakeDb(answers: { tables?: Record<string, (q: Query) => unknown>; rpc?: Record<string, (args: any) => unknown> } = {}) {
  const queries: Query[] = [];
  const rpcs: Array<{ name: string; args: any }> = [];
  const chain = (q: Query): unknown =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                Promise.resolve()
                  .then(() => {
                    if (q.table === "memberships") return { data: { role: "owner", role_id: null }, error: null };
                    const result = answers.tables?.[q.table]?.(q);
                    return result && typeof result === "object" && "error" in result ? result : { data: result ?? null, error: null };
                  })
                  .then(resolve, reject)
            : (...args: unknown[]) => {
                q.calls.push([String(name), ...args]);
                return chain(q);
              },
      },
    );
  current.db = {
    from: (table: string) => {
      const q: Query = { table, calls: [] };
      queries.push(q);
      return chain(q);
    },
    rpc: async (name: string, args: unknown) => {
      rpcs.push({ name, args });
      const fn = answers.rpc?.[name];
      if (!fn) return { data: name === "rate_limit_hit" ? true : null, error: null };
      const result = fn(args);
      return result && typeof result === "object" && "error" in (result as object) ? result : { data: result, error: null };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  return { queries, rpcs };
}

/** The business's form, and a database that makes the request. */
function withForm(changes: Record<string, unknown> = {}) {
  return fakeDb({
    tables: { website_forms: () => form(changes) },
    rpc: { website_form_request: () => ({ request_id: REQUEST_ID, number: 7, client_id: "c1", property_id: "p1", new_property: true, matched: false }) },
  });
}

const post = (body: string | Record<string, unknown>, headers: Record<string, string> = {}) =>
  app.request(
    `/f/${KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json", Origin: "https://www.greenlawn.example", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );

afterEach(() => {
  current.background.length = 0;
  current.emails.length = 0;
});

describe("a message from the website's own form", () => {
  it("becomes a request, emails the people the form names, and goes to the thank-you page", async () => {
    const db = withForm();
    const res = await post(new URLSearchParams({ name: "Jane Smith", email: "Jane@Example.com", phone: "540 555 0101", address: "12 Oak St", zip: "24012", service: "Mowing", message: "Fridays?" }).toString());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(THANKS);

    const made = db.rpcs.find((r) => r.name === "website_form_request")!;
    expect(made.args).toMatchObject({
      p_form: FORM_ID, p_name: "Jane Smith", p_email: "jane@example.com", p_phone: "540 555 0101", p_details: "Fridays?",
      p_address: { line1: "12 Oak St", postal_code: "24012" }, p_answers: { service: "Mowing" },
      p_contact: { name: "Jane Smith", email: "Jane@Example.com", phone: "540 555 0101", address: "12 Oak St", zip: "24012" },
    });
    expect(made.args.p_title).toBeUndefined();

    await Promise.all(current.background);
    expect(current.emails.map((e) => e.to)).toEqual(["office@greenlawn.example", "sam@greenlawn.example"]);
    expect(current.emails[0]).toMatchObject({ subject: "New message from Jane Smith", replyTo: "jane@example.com", fromName: "Green Lawn" });
    expect(current.emails[0]!.text).toContain(`https://crm.greenlawn.example/requests/${REQUEST_ID}`);
    expect(current.emails[0]!.html).toContain("Open the request");
  });

  it("answers fetch() with JSON, from any website", async () => {
    withForm();
    const res = await post({ email: "jane@example.com", message: "Hi" }, { Accept: "application/json" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, next: THANKS });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const preflight = await app.request(`/f/${KEY}`, { method: "OPTIONS", headers: { Origin: "https://greenlawn.example", "Access-Control-Request-Method": "POST" } }, env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });

  it("goes to the form's own thank-you page, or _next", async () => {
    withForm({ redirect_url: "https://greenlawn.example/thanks" });
    expect((await post("email=jane%40example.com")).headers.get("location")).toBe("https://greenlawn.example/thanks");
    expect((await post("email=jane%40example.com&_next=https%3A%2F%2Fgreenlawn.example%2Fsent")).headers.get("location")).toBe("https://greenlawn.example/sent");
  });

  it("tells a bot that filled in _gotcha it worked, and keeps nothing", async () => {
    const db = withForm();
    const res = await post("email=bot%40spam.example&_gotcha=http%3A%2F%2Fspam.example");
    expect(res.status).toBe(303);
    expect(db.rpcs.some((r) => r.name === "website_form_request")).toBe(false);
    expect(current.emails).toEqual([]);
  });

  it("says what's wrong on a page with a way back, or in JSON", async () => {
    withForm();
    const page = await post("name=Jane&message=Hi");
    expect(page.status).toBe(422);
    const html = await page.text();
    expect(html).toContain("Your message wasn&#39;t sent".replace("&#39;", "'"));
    expect(html).toContain("Add an email or phone number so we can reach you.");
    expect(html).toContain("Go back to the form");

    const json = await post({ name: "Jane" }, { Accept: "application/json" });
    expect(json.status).toBe(422);
    expect(await json.json()).toEqual({ ok: false, error: "Add an email or phone number so we can reach you.", errors: [{ message: "Add an email or phone number so we can reach you." }] });
  });

  it("only takes messages from the websites it lists", async () => {
    const db = withForm({ allowed_sites: ["greenlawn.example"] });
    expect((await post("email=jane%40example.com")).status).toBe(303);
    const elsewhere = await post("email=jane%40example.com", { Origin: "https://copycat.example" });
    expect(elsewhere.status).toBe(403);
    expect(db.rpcs.filter((r) => r.name === "website_form_request")).toHaveLength(1);
  });

  it("isn't taken while the app is uninstalled, or at an address that isn't a form", async () => {
    withForm({ company: { id: COMPANY, name: "Green Lawn", settings: { website_forms: { enabled: false } } } });
    expect((await post("email=jane%40example.com")).status).toBe(404);
    fakeDb({ tables: { website_forms: () => null } });
    expect((await post("email=jane%40example.com")).status).toBe(404);
    expect((await app.request("/f/NOT-A-KEY", { method: "POST" }, env)).status).toBe(404);
  });

  it("checks a promo code field by its usual names, and keeps the request when the code isn't valid", async () => {
    const promo = (code: string) => (code.toUpperCase() === "SPRING15" ? { promo_code: "SPRING15", rejected_promo_code: null, promo_problem: null } : { promo_code: null, rejected_promo_code: code, promo_problem: "That code expired on October 1." });
    const db = fakeDb({
      tables: { website_forms: () => form() },
      rpc: { website_form_request: (args: { p_promo?: string }) => ({ request_id: REQUEST_ID, number: 7, client_id: "c1", property_id: null, new_property: false, matched: false, ...promo(args.p_promo ?? "") }) },
    });
    expect((await post("email=jane%40example.com&Promo+Code=+spring15+")).status).toBe(303);
    const res = await post("email=gil%40example.com&coupon-code=old10&message=Hi");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(THANKS);
    expect((await post({ email: "kit@example.com", discount_code: "SPRING15" }, { Accept: "application/json" })).status).toBe(200);
    const made = db.rpcs.filter((r) => r.name === "website_form_request");
    expect(made.map((r) => r.args.p_promo)).toEqual(["spring15", "old10", "SPRING15"]);
    // The typed code stays an answer, so it's never lost.
    expect(made.map((r) => r.args.p_answers)).toEqual([{ "Promo Code": "spring15" }, { "coupon-code": "old10" }, { discount_code: "SPRING15" }]);

    await Promise.all(current.background);
    const texts = current.emails.filter((e) => e.to === "office@greenlawn.example").map((e) => e.text as string);
    expect(texts[0]).toContain("Promo code SPRING15, ready to apply on the quote.");
    expect(texts[1]).toContain("Promo code old10 wasn't applied: that code expired on October 1.");
  });

  it("leaves p_promo out when the form has no promo field", async () => {
    const db = withForm();
    await post("email=jane%40example.com&discount=10");
    expect(db.rpcs.find((r) => r.name === "website_form_request")!.args.p_promo).toBeUndefined();
  });

  it("is refused politely when too many come at once", async () => {
    fakeDb({ tables: { website_forms: () => form() }, rpc: { rate_limit_hit: () => false } });
    const res = await post("email=jane%40example.com");
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("Too many messages");
  });
});

describe("the address's own pages", () => {
  it("thank people by the business's name", async () => {
    withForm();
    const res = await app.request(`/f/${KEY}/thanks`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Thanks! Your message was sent.");
    expect(html).toContain("Green Lawn will get back to you soon.");
    // Site builders' HTML blocks are frames: the page shows inside one, as the rest of Crewtavo doesn't.
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect((await app.request("/api/health", {}, env)).headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("say what the address is for when someone opens it", async () => {
    withForm();
    expect(await (await app.request(`/f/${KEY}`, {}, env)).text()).toContain("takes messages from a form on Green Lawn's website");
  });

  it("escape what they show", () => {
    const html = formPage({ title: "<x>", heading: "A & B", text: `"quoted"`, company: { name: "<script>", logo: null } });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
  });
});

describe("the app's page", () => {
  const headers = { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" };

  it("lists the forms with their addresses", async () => {
    fakeDb({
      tables: {
        companies: () => ({ settings: { website_forms: { enabled: true } } }),
        website_forms: () => [{ id: FORM_ID, key: KEY, name: "Contact form", email_to: [], redirect_url: null, allowed_sites: [], created_at: "2026-10-26T00:00:00Z" }],
        requests: () => ({ created_at: "2026-10-26T12:00:00Z" }),
      },
    });
    const res = await app.request("/api/website-forms", { headers }, env);
    expect(await res.json()).toEqual({
      enabled: true,
      email_ready: true,
      promo_codes: false,
      forms: [expect.objectContaining({ url: `https://crm.greenlawn.example/f/${KEY}`, last_message_at: "2026-10-26T12:00:00Z" })],
    });
  });

  it("says whether the business has promo codes, for the form to paste", async () => {
    const db = fakeDb({
      tables: {
        companies: () => ({ settings: { website_forms: { enabled: true } } }),
        website_forms: () => [],
        promo_codes: () => ({ data: null, count: 2, error: null }),
      },
    });
    const res = await app.request("/api/website-forms", { headers }, env);
    expect(((await res.json()) as { promo_codes: boolean }).promo_codes).toBe(true);
    expect(db.queries.find((q) => q.table === "promo_codes")!.calls).toEqual(expect.arrayContaining([["eq", "company_id", COMPANY], ["eq", "active", true]]));
  });

  it("keeps emails, the thank-you page and websites in one spelling", async () => {
    const db = fakeDb({ tables: { website_forms: () => ({ id: FORM_ID, key: KEY }) } });
    const res = await app.request(`/api/website-forms/${FORM_ID}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ email_to: [" Office@GreenLawn.example", "office@greenlawn.example", ""], redirect_url: "greenlawn.example/thanks", allowed_sites: ["https://www.GreenLawn.example/contact"] }),
    }, env);
    expect(res.status).toBe(200);
    const update = db.queries.find((q) => q.table === "website_forms")!.calls.find(([name]) => name === "update")![1];
    expect(update).toEqual({ email_to: ["office@greenlawn.example"], redirect_url: "https://greenlawn.example/thanks", allowed_sites: ["greenlawn.example"] });

    const bad = await app.request(`/api/website-forms/${FORM_ID}`, { method: "PATCH", headers, body: JSON.stringify({ email_to: ["office at greenlawn"] }) }, env);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("office at greenlawn isn't an email address.");
  });

  it("gives forms random addresses", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newFormKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9]{10}$/);
  });
});
