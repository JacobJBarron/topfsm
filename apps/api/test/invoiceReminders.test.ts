/**
 * Payment reminders (remindInvoices in services/sales.ts): how the email words the due date, by the
 * company's own calendar. The database is a stand-in that answers each table's query, and the mailer
 * keeps what it was given.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Db } from "../src/lib/supabase";
import { remindInvoices } from "../src/services/sales";

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string }>);
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendEmail: async (_env: Env, message: { to: string; subject: string; text: string }) => {
    sent.push(message);
    return { sent: true, id: `email-${sent.length}` };
  },
}));
vi.mock("../src/lib/links", async (original) => ({
  ...(await original<typeof import("../src/lib/links")>()),
  clientLink: async (_env: Env, baseUrl: string, link: { id: string }) => `${baseUrl}/u/${link.id}`,
  clientLinks: async (_env: Env, baseUrl: string, link: { id: string }) => ({ own: `${baseUrl}/u/${link.id}`, office: `${baseUrl}/u/${link.id}` }),
}));

const CO = "00000000-0000-4000-8000-0000000000a1";
const company = { name: "Ridge Paving", currency: "USD", timezone: "America/New_York", email: null, phone: null, address: {}, settings: {} };
const client = { display_name: "Pat Lee", email: "pat@example.com", phone: null };
const invoice = (id: string, number: number, due_on: string) => ({ id, number, status: "sent", total: 400, balance_due: 400, due_on, client_id: "client-1", client });

/** Answers each table with its rows, whatever the filters. */
function stubDb(tables: Record<string, unknown>): Db {
  const from = (table: string) => {
    const result = { data: tables[table] ?? null, error: null };
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "insert"]) builder[name] = () => builder;
    builder.maybeSingle = builder.single = () => Promise.resolve(result);
    builder.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return builder;
  };
  return { from } as unknown as Db;
}

afterEach(() => {
  sent.length = 0;
  vi.useRealTimers();
});

describe("a payment reminder", () => {
  it("says the invoice is due until the due date has passed, then that it was due", async () => {
    // 10 PM on November 30 in New York, already December 1 in UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T03:00:00Z"));
    const db = stubDb({
      companies: company,
      invoices: [invoice("inv-early", 4, "2026-12-15"), invoice("inv-today", 5, "2026-11-30"), invoice("inv-late", 6, "2026-11-29")],
      stripe_invoices: [],
    });

    const result = await remindInvoices({ db, env: {} as Env, companyId: CO, baseUrl: "https://ops.example.com" }, ["inv-early", "inv-today", "inv-late"]);

    expect(result).toEqual({ sent: 3, skipped: [] });
    const [early, today, late] = sent.map((m) => m.text);
    expect(early).toContain("$400.00 is still owed on invoice #4, which is due December 15.");
    expect(today).toContain("on invoice #5, which is due November 30.");
    expect(late).toContain("on invoice #6, which was due November 29.");
  });
});
