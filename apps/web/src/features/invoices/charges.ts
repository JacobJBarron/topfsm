/**
 * Charging a client's saved card from the office: the invoice page's Charge card button and the
 * Invoices page's Charge cards list. The server queues each one as a charge the autopay task
 * makes (POST /invoices/charge), so receipts, the paid-twice guards and failures work as autopay's.
 */

/** What the server did with each invoice (public.request_manual_charges). */
export interface ChargeResult {
  invoice_id: string;
  outcome: string;
  reason: string | null;
}

/** An unpaid invoice whose client has a card they agreed to have charged (GET /invoices/chargeable). */
export interface ChargeableInvoice {
  id: string;
  number: number;
  client_id: string;
  client_name: string;
  balance_due: number;
  due_on: string | null;
  status: string;
  card: string;
  in_progress: boolean;
  /** The charge already under way, when there is one, and the server's words for it. */
  live_status?: "charging" | "waiting_on_client" | "retrying" | "needs_approval" | "bank_clearing" | null;
  live_detail?: string | null;
}

/** The most invoices one call takes. */
export const CHARGE_CHUNK = 50;

const OUTCOMES: Record<string, string> = {
  queued: "Charging",
  no_card: "No card on file",
  not_owed: "Nothing owed",
  in_progress: "Already on its way",
  changed: "The amount changed. Check it and try again",
  not_sent: "Not sent. Try again.",
  autopay_off: "Charging saved cards is off in Settings → Payments",
  too_small: "Too small for Stripe",
  not_found: "Invoice not found",
};

/**
 * What happened to one invoice, in plain words: the server's reason when it gives one (it knows
 * whether it's the Settings switch or the Stripe key, or a paused card), else the outcome's own.
 */
export const chargeOutcomeText = (r: Pick<ChargeResult, "outcome" | "reason">) => r.reason ?? OUTCOMES[r.outcome] ?? "Not charged";

const LIVE: Record<string, string> = {
  charging: "Charging now",
  waiting_on_client: "Waiting on the client",
  retrying: "Autopay will try it again",
  needs_approval: "Waiting for your OK",
  bank_clearing: "Bank payment on its way",
};

/** Whether a listed invoice has a charge under way already, so it can't be picked. */
export const chargeBusy = (r: ChargeableInvoice) => r.in_progress || r.live_status != null;

/** What the charge under way is doing, in plain words: the server's when it gives them, else its status's own. */
export const chargeLiveText = (r: ChargeableInvoice) => r.live_detail ?? LIVE[r.live_status ?? ""] ?? "Already on its way";

/**
 * Sends the picked invoices CHARGE_CHUNK at a time, each with the balance the office saw, and says
 * what happened to each. When a later chunk fails, the ones sent keep their results and the rest say
 * they weren't sent (with the error); when the first fails nothing went, so it throws for the form.
 */
export async function chargeInChunks(rows: ChargeableInvoice[], post: (body: { invoices: Array<{ id: string; amount: number }> }) => Promise<{ results: ChargeResult[] }>) {
  const results = new Map<string, ChargeResult>();
  let error: unknown = null;
  for (let i = 0; i < rows.length; i += CHARGE_CHUNK) {
    const chunk = rows.slice(i, i + CHARGE_CHUNK);
    try {
      const r = await post({ invoices: chunk.map((b) => ({ id: b.id, amount: Number(b.balance_due) })) });
      for (const one of r.results) results.set(one.invoice_id, one);
    } catch (e) {
      if (i === 0) throw e;
      for (const row of rows.slice(i)) results.set(row.id, { invoice_id: row.id, outcome: "not_sent", reason: null });
      error = e;
      break;
    }
  }
  return { error, rows: rows.map((row) => ({ row, result: results.get(row.id) ?? { invoice_id: row.id, outcome: "not_found", reason: null } })) };
}

/** The line under the results: what's charging, what was on its way already (not a failure), and what wasn't charged. */
export function chargeSummary(results: Array<Pick<ChargeResult, "outcome">>) {
  const queued = results.filter((r) => r.outcome === "queued").length;
  const onWay = results.filter((r) => r.outcome === "in_progress").length;
  const not = results.length - queued - onWay;
  return [`${queued} charging`, onWay && `${onWay} already on ${onWay === 1 ? "its" : "their"} way`, not && `${not} not charged`].filter(Boolean).join(". ") + ". Each invoice shows when it's paid.";
}

/** What the picked invoices add up to, in cents so a long list doesn't drift. */
export const chargeTotal = (rows: Array<{ balance_due: number }>) => rows.reduce((sum, r) => sum + Math.round(Number(r.balance_due) * 100), 0) / 100;
