/**
 * Promo codes on jobs and invoices (supabase/migrations/20261031000600_promo_once_per_job.sql): a
 * promo code's line stays the code's (its price isn't typed, it isn't duplicated), the database's
 * refusal of a changed one is said in plain words, the "Change them too?" question on Marketing →
 * Promo codes backs out when it's closed, the pages a moved discount shows on load again, the Jobs
 * list's price for a visit leaves out a one-time code, and the Website Forms panel names every promo
 * field it reads.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { answer, choose, confirm } from "../src/components/ui/Confirm";
import { refreshJobInvoices } from "../src/features/jobs/JobDiscountNote";
import { isPromoLine } from "../src/features/quotes/LineItems";
import { friendlyDbError } from "../src/lib/errors";

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("a promo code's line", () => {
  it("is the job's discount line, or an invoice's copy of it", () => {
    expect(isPromoLine("job_line_items", { discount_key: "q1" })).toBe(true);
    expect(isPromoLine("invoice_line_items", { discount_quote_id: "q1" })).toBe(true);
    expect(isPromoLine("job_line_items", { discount_key: null })).toBe(false);
    expect(isPromoLine("invoice_line_items", {})).toBe(false);
    expect(isPromoLine("quote_line_items", { discount_key: "q1", discount_quote_id: "q1" })).toBe(false);
  });

  it("says why a price typed on it is refused, and what to do instead", () => {
    for (const table of ["job_line_items", "invoice_line_items"]) {
      const error = friendlyDbError({ code: "23514", message: `new row for relation "${table}" violates check constraint "${table}_discount_check"` });
      expect(error.message).toBe("A promo code's line has to take money off. To drop the discount, remove the line.");
    }
    expect(friendlyDbError({ code: "23514", message: 'new row for relation "jobs" violates check constraint "jobs_retainage_pct_check"' }).message).toBe(
      "One of the values isn't allowed. Check the form and try again.",
    );
  });

  it("offers no Duplicate, and no price or quantity to type", () => {
    const lineItems = source("../src/features/quotes/LineItems.tsx");
    expect(lineItems).toContain(`{ label: "Duplicate", icon: "copy", hidden: isPromoLine(table, line),`);
    expect(lineItems.match(/disabled=\{promo\}/g)).toHaveLength(2);
  });
});

describe("a question both of whose buttons are answers", () => {
  it("is true or false for its buttons, and null when it's closed without one", async () => {
    const asked = choose({ title: "Change the 2 jobs already using WEEKLY25 too?", confirmLabel: "Change them too", cancelLabel: "Only new jobs" });
    answer("dismiss");
    expect(await asked).toBeNull();
    const yes = choose({ title: "Again?" });
    answer("confirm");
    expect(await yes).toBe(true);
    const no = choose({ title: "Again?" });
    answer("cancel");
    expect(await no).toBe(false);
  });

  it("is closed by another question, as a confirm is", async () => {
    const first = choose({ title: "First?" });
    const second = confirm({ title: "Second?" });
    expect(await first).toBeNull();
    answer("dismiss");
    expect(await second).toBe(false);
  });

  it("saves nothing on Marketing → Promo codes when it's closed", () => {
    const promoCodes = source("../src/features/marketing/PromoCodes.tsx");
    expect(promoCodes).toContain("const choice = await choose({");
    expect(promoCodes).toContain("if (choice === null) return null;");
    expect(promoCodes).not.toMatch(/\bconfirm\(/);
  });
});

describe("a promo discount that moves to or off another of the job's drafts", () => {
  const seeded = () => {
    const queryClient = new QueryClient();
    const keys: Record<string, QueryKey> = {
      here: ["invoice", "i12"],
      movedTo: ["invoice", "i13"],
      job: ["job", "j1"],
      note: ["job", "j1", "promo-discounts"],
      jobInvoices: ["job", "j1", "invoices"],
      clientList: ["client", "c1", "work"],
      otherJob: ["job", "j2"],
      otherClient: ["client", "c2", "work"],
      referrals: ["invoice-referrals", "i12", ""],
    };
    for (const key of Object.values(keys)) queryClient.setQueryData(key, {});
    const stale = (name: string) => Boolean(queryClient.getQueryState(keys[name]!)?.isInvalidated);
    return { queryClient, stale };
  };

  it("loads every invoice page, the job's page with its note, and the client's list again", () => {
    const { queryClient, stale } = seeded();
    refreshJobInvoices(queryClient, { jobId: "j1", clientId: "c1" });
    for (const name of ["here", "movedTo", "job", "note", "jobInvoices", "clientList"]) expect(stale(name), name).toBe(true);
    for (const name of ["otherJob", "otherClient", "referrals"]) expect(stale(name), name).toBe(false);
  });

  it("leaves a deleted invoice's own page, which would only find it missing", () => {
    const { queryClient, stale } = seeded();
    refreshJobInvoices(queryClient, { jobId: "j1", gone: "i12" });
    expect(stale("here")).toBe(false);
    expect(stale("movedTo")).toBe(true);
    expect(stale("note")).toBe(true);
  });

  it("is what the invoice page does after Void, Delete and its lines' Remove and Undo", () => {
    const invoicePage = source("../src/features/invoices/InvoicePage.tsx");
    const refresh = /const refresh = \(\) => \{([\s\S]*?)\n  \};/.exec(invoicePage)![1]!;
    expect(refresh).toContain("if (inv?.job) refreshJobInvoices(queryClient, { jobId: inv.job.id, clientId: inv.client_id });");
    expect(invoicePage).toContain("if (inv?.job) refreshJobInvoices(queryClient, { jobId: inv.job.id, clientId: inv.client_id, gone: id });");
    // Void goes through refresh, and so do the lines' Remove and its Undo (LineItems' onChanged).
    expect(invoicePage).toMatch(/if \(patch\.status === "void"\) toast\.success\("Invoice voided"[^\n]*\n\s*refresh\(\);/);
    expect(invoicePage).toMatch(/<LineItems\s+table="invoice_line_items"[\s\S]*?onChanged=\{refresh\}/);
    const lineItems = source("../src/features/quotes/LineItems.tsx");
    const remove = /const remove = useMutation\(\{([\s\S]*?)\n  \}\);/.exec(lineItems)![1]!;
    expect(remove.match(/onChanged\(\);/g)).toHaveLength(2);
  });

  it("loads the job's pages and the Jobs list again when its rule is switched", () => {
    const jobPage = source("../src/features/jobs/JobPage.tsx");
    expect(jobPage).toContain(`queryClient.invalidateQueries({ queryKey: ["job", id] });\n    queryClient.invalidateQueries({ queryKey: ["jobs", session.company.id] });`);
    expect(jobPage).toMatch(/<JobDiscountNote [^\n]*onChanged=\{refresh\}/);
    // Marketing → Promo codes' "Change them too".
    const promoCodes = source("../src/features/marketing/PromoCodes.tsx");
    expect(promoCodes).toContain(`if (jobs) {\n        queryClient.invalidateQueries({ queryKey: ["job"] });\n        queryClient.invalidateQueries({ queryKey: ["jobs", session.company.id] });`);
  });
});

describe("the toast when one of a draft's promo lines comes off", () => {
  it("knows what the draft still has, as an every-visit code has a copy on each visit", () => {
    const lineItems = source("../src/features/quotes/LineItems.tsx");
    expect(lineItems).toContain("const rest = lines.filter((l) => l.id !== line.id);");
    expect(lineItems).toContain("removedPromoWords(key, parentId, before, after, promoJob.repeats, rest)");
  });
});

describe("the Jobs list", () => {
  it("prices a recurring job's visit without its one-time promo code", () => {
    const jobsPage = source("../src/features/jobs/JobsPage.tsx");
    expect(jobsPage).toContain("lines:job_line_items(quantity, unit_price, discount_billing)");
    expect(jobsPage).toContain("{formatMoney(visitPrice(j.financials?.contract_total, j.lines))}/visit");
    expect(jobsPage).not.toContain("{formatMoney(j.financials?.contract_total ?? 0)}/visit");
  });
});

describe("the Website Forms panel", () => {
  it("names every promo field a form can use", () => {
    const panel = source("../src/features/apps/WebsiteFormsPanel.tsx");
    for (const name of ["promo", "promo_code", "promocode", "coupon", "coupon_code", "discount_code"]) expect(panel).toContain(`<strong>${name}</strong>`);
  });
});
