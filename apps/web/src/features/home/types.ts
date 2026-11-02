/** Shape returned by GET /api/dashboard (public.dashboard() in Postgres). */
export interface Dashboard {
  workflow: {
    requests: { new: number; assessment_complete: number; overdue: number };
    quotes: { awaiting: number; awaiting_value: number; approved: number; approved_value: number; draft: number; draft_value: number };
    jobs: { to_invoice: number; to_invoice_value: number; active: number };
    invoices: {
      awaiting: number;
      awaiting_value: number;
      past_due: number;
      past_due_value: number;
      draft: number;
      /** Autopay charges that failed (declined, or waiting on the client), and what they leave owed. Servers before autopay don't send them. */
      autopay_failed?: number;
      autopay_failed_value?: number;
      /** Autopay charges over the limit, waiting for the office's OK. */
      autopay_approval?: number;
    };
  };
  today: {
    total: number;
    by_status: Record<string, number>;
    visits: Array<{
      id: string;
      title: string;
      kind: string;
      status: string;
      starts_at: string | null;
      ends_at: string | null;
      scheduled_on: string;
      job_id: string | null;
      client_id: string | null;
      client: string | null;
      crew: string | null;
      crew_color: string | null;
      address: string | null;
      hold_reason: string | null;
    }>;
  };
  receivables: { clients_owing: number; total: number; top: Array<{ client_id: string; client: string; owed: number }> };
  month: { collected: number; collected_last: number; invoiced: number; won: number; won_count: number };
  /** Kinds: quote, visit, invoice, autopay_failed, autopay_approval (and equipment, added on the page). */
  attention: Array<{ kind: string; title: string; detail: string | null; link: string }>;
}
