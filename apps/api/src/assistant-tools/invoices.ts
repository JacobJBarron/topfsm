/**
 * Invoices and payments: made from jobs by the database (create_invoice_for_job, which handles
 * deposits, progress billing and completed visits), sent and reminded through services/sales.ts,
 * and payments recorded the way the invoice screen records them. An assistant never refunds or
 * deletes a payment (the database refuses it too) and doesn't touch Stripe: card payments come in
 * through Stripe itself. Invoices are money: "Full access, no money" doesn't change them.
 */
import { localDate, paymentProblem, zonedTimeToUtc } from "@crewtavo/core";
import { z } from "zod";
import { invoiceJobs, remindInvoices, sendInvoice, sendSchema } from "../services/sales";
import { changed, companyArg, friendly, one, tool, type ToolContext } from "./tool";

const salesScope = (ctx: ToolContext) => ({ db: ctx.db, env: ctx.env, companyId: ctx.companyId, baseUrl: (ctx.env.APP_URL ?? ctx.origin).replace(/\/$/, "") });

export const invoiceTools = {
  list_invoices: tool({
    description:
      "Invoices, newest first, with client, total, balance due and due date. Filter by status (draft, sent, partially_paid, paid, overdue, void, written_off, or unpaid: sent, partly paid and overdue) and client. Written off: the business took the loss on what's left, so it isn't counted as owed.",
    input: z.object({
      status: z.enum(["all", "unpaid", "draft", "sent", "partially_paid", "paid", "overdue", "void", "written_off"]).default("all"),
      client_id: z.uuid().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      ...companyArg,
    }),
    run: async (ctx, a) => {
      let q = ctx.db.from("invoices").select("id, number, kind, status, total, balance_due, issued_on, due_on, client:clients(id, display_name)", { count: "exact" }).eq("company_id", ctx.companyId);
      if (a.status === "unpaid") q = q.in("status", ["sent", "partially_paid", "overdue"]);
      else if (a.status !== "all") q = q.eq("status", a.status);
      if (a.client_id) q = q.eq("client_id", a.client_id);
      const { data, error, count } = await q.order("created_at", { ascending: false }).range(a.offset, a.offset + a.limit - 1);
      if (error) throw new Error(friendly(error.message));
      const next = a.offset + (data?.length ?? 0);
      return { total: count ?? data?.length ?? 0, invoices: data ?? [], next_offset: count !== null && next < count ? next : null };
    },
  }),
  get_invoice: tool({
    description: "An invoice in full: client, job, lines, totals, discounts and referral credits, tax, what's been paid (each payment) and what's still owed.",
    input: z.object({ invoice_id: z.uuid(), ...companyArg }),
    run: (ctx, a) =>
      one(
        ctx.db
          .from("invoices")
          .select("id, number, kind, status, subtotal, discount_amount, credit_amount, credits:referral_credits(amount, note), tax_amount, total, amount_paid, balance_due, issued_on, due_on, written_off_at, job:jobs(id, number, title), client:clients(id, display_name, email), lines:invoice_line_items(name, description, quantity, unit, unit_price, taxable), payments(id, amount, tip_amount, method, received_at, notes, processor)")
          .eq("id", a.invoice_id)
          .eq("company_id", ctx.companyId)
          .maybeSingle(),
        "That invoice",
      ),
  }),
  invoice_job: tool({
    description:
      "Invoice a job: standard (the job's lines, less any deposit or progress already billed), visits (the completed visits not yet billed, for recurring and per-visit jobs), deposit or progress (an amount), or retainage. It's a draft until sent.",
    input: z.object({ job_id: z.uuid(), kind: z.enum(["standard", "visits", "deposit", "progress", "retainage"]).default("standard"), amount: z.number().positive().max(1e8).optional(), ...companyArg }),
    area: "invoices",
    run: async (ctx, a) => {
      const { data, error } = await ctx.db.rpc("create_invoice_for_job", { p_job: a.job_id, p_kind: a.kind, ...(a.amount ? { p_amount: a.amount } : {}) });
      if (error) throw new Error(friendly(error.message));
      return one(ctx.db.from("invoices").select("id, number, status, total, balance_due").eq("id", data as string).maybeSingle(), "The invoice");
    },
  }),
  invoice_jobs: tool({
    description: "Invoice many finished jobs at once (up to 50): one invoice each (completed visits for recurring and per-visit jobs), and email each one if send is true. Each job succeeds or fails on its own.",
    input: z.object({ job_ids: z.array(z.uuid()).min(1).max(50), send: z.boolean().default(false), ...companyArg }),
    area: "invoices",
    run: (ctx, a) => invoiceJobs(salesScope(ctx), a.job_ids, a.send),
  }),
  send_invoice: tool({
    description: "Send an invoice to the client by email (default) or text, with their link to view and pay it; or just make the link (channel link). A draft becomes sent.",
    input: z.object({ invoice_id: z.uuid(), ...sendSchema.shape, ...companyArg }),
    area: "invoices",
    run: async (ctx, { invoice_id, company_id: _, ...body }) => sendInvoice(salesScope(ctx), invoice_id, body),
  }),
  send_reminders: tool({
    description: "Email a friendly payment reminder for these unpaid invoices (up to 100). Invoices with a bank payment on its way are skipped.",
    input: z.object({ invoice_ids: z.array(z.uuid()).min(1).max(100), ...companyArg }),
    area: "invoices",
    run: (ctx, a) => remindInvoices(salesScope(ctx), a.invoice_ids),
  }),
  record_payment: tool({
    description: "Record a payment the client made outside Crewtavo's online pay page: cash, check, ACH or other, up to the balance due, with an optional tip and a note (a check number). A draft invoice becomes sent. Card payments come in through Stripe; refunds are made in Crewtavo.",
    input: z.object({
      invoice_id: z.uuid(),
      amount: z.number().positive().max(1e8),
      method: z.enum(["cash", "check", "ach", "other"]),
      received_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Default today."),
      tip: z.number().min(0).max(1e6).optional(),
      notes: z.string().trim().max(500).optional(),
      ...companyArg,
    }),
    area: "invoices",
    run: async (ctx, a) => {
      const invoice = await one(ctx.db.from("invoices").select("id, client_id, status, balance_due").eq("id", a.invoice_id).eq("company_id", ctx.companyId).maybeSingle(), "That invoice");
      if (invoice.status === "void") throw new Error("This invoice is void.");
      const problem = paymentProblem(a.amount, Number(invoice.balance_due));
      if (problem) throw new Error(problem);
      if (invoice.status === "draft") {
        const { error } = await ctx.db.from("invoices").update({ status: "sent" }).eq("id", invoice.id);
        if (error) throw new Error(friendly(error.message));
      }
      const day = a.received_on ?? localDate(new Date(), ctx.timezone);
      const payment = await one(
        ctx.db
          .from("payments")
          .insert({
            company_id: ctx.companyId,
            invoice_id: invoice.id,
            client_id: invoice.client_id,
            amount: Math.round(a.amount * 100) / 100,
            tip_amount: a.tip ? Math.round(a.tip * 100) / 100 : 0,
            method: a.method,
            received_at: zonedTimeToUtc(day, "12:00", ctx.timezone).toISOString(),
            notes: a.notes || null,
          })
          .select("id")
          .single(),
        "The payment",
      );
      const after = await one(ctx.db.from("invoices").select("status, balance_due").eq("id", invoice.id).maybeSingle(), "That invoice");
      return { payment_id: payment.id, invoice_status: after.status, balance_due: after.balance_due };
    },
  }),
  void_invoice: tool({
    description: "Void an invoice that hasn't been paid (one with payments can't be). It stays on record as void.",
    input: z.object({ invoice_id: z.uuid(), ...companyArg }),
    area: "invoices",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("invoices").update({ status: "void" }).eq("id", a.invoice_id).eq("company_id", ctx.companyId).select("id"), "That invoice");
      return { voided: true };
    },
  }),
  write_off_invoice: tool({
    description:
      "Write off what's still owed on a sent invoice the client is never going to pay (partly paid ones too): it stops counting as owed (receivables, past due, reminders) but still counts as invoiced, and keeps its visits. A payment that comes in later is still recorded on it. undo_write_off makes it owed again.",
    input: z.object({ invoice_id: z.uuid(), ...companyArg }),
    area: "invoices",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("invoices").update({ status: "written_off" }).eq("id", a.invoice_id).eq("company_id", ctx.companyId).select("id"), "That invoice");
      return one(ctx.db.from("invoices").select("id, number, status, balance_due, written_off_at").eq("id", a.invoice_id).maybeSingle(), "That invoice");
    },
  }),
  undo_write_off: tool({
    description: "Make a written-off invoice owed again: it's back with the unpaid invoices, past due if its due date has passed.",
    input: z.object({ invoice_id: z.uuid(), ...companyArg }),
    area: "invoices",
    run: async (ctx, a) => {
      await changed(ctx.db.from("invoices").update({ status: "sent" }).eq("id", a.invoice_id).eq("company_id", ctx.companyId).eq("status", "written_off").select("id"), "That written-off invoice");
      return one(ctx.db.from("invoices").select("id, number, status, balance_due").eq("id", a.invoice_id).maybeSingle(), "That invoice");
    },
  }),
};
