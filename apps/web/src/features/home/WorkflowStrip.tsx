import { Link } from "react-router-dom";
import { AnimatedNumber, moneyCompact } from "@/components/ui/AnimatedNumber";
import { Icon, type IconName } from "@/components/ui/Icon";
import { statusText } from "@/components/ui/StatusPill";
import { formatMoneyCompact } from "@/lib/format";
import type { Dashboard } from "./types";
import styles from "./WorkflowStrip.module.css";

interface Column {
  key: string;
  label: string;
  icon: IconName;
  to: string;
  color: string;
  textColor: string;
  count: number;
  value?: number;
  caption: string;
  rows: Array<{ label: string; value: string; danger?: boolean }>;
}

/** Money in short ("$54.1K") for a glance at Home; Invoices and Finance write it in full. Each column's figures wrap under its count when they need to. */
export function WorkflowStrip({ workflow, showInvoices = true }: { workflow: Dashboard["workflow"]; showInvoices?: boolean }) {
  const { requests, quotes, jobs, invoices } = workflow;
  const columns: Column[] = [
    {
      key: "requests", label: "Requests", icon: "requests", to: "/requests", color: "var(--req)", textColor: "var(--req-text)",
      count: requests.new, caption: statusText("request", "new"),
      rows: [
        { label: statusText("request", "assessment_complete"), value: String(requests.assessment_complete) },
        // Late work, not late money: a new request nobody has answered in two days.
        { label: "Overdue", value: String(requests.overdue) },
      ],
    },
    {
      key: "quotes", label: "Quotes", icon: "quote", to: "/quotes", color: "var(--quote)", textColor: "var(--quote-text)",
      count: quotes.awaiting, value: quotes.awaiting_value, caption: statusText("quote", "sent"),
      rows: [
        { label: `${statusText("quote", "approved")} (${quotes.approved ?? 0})`, value: formatMoneyCompact(quotes.approved_value ?? 0) },
        { label: `${statusText("quote", "draft")} (${quotes.draft})`, value: formatMoneyCompact(quotes.draft_value) },
      ],
    },
    {
      key: "jobs", label: "Jobs", icon: "job", to: "/jobs", color: "var(--job)", textColor: "var(--job-text)",
      count: jobs.to_invoice, value: jobs.to_invoice_value, caption: statusText("job", "requires_invoicing"),
      rows: [{ label: statusText("job", "active"), value: String(jobs.active) }],
    },
    {
      key: "invoices", label: "Invoices", icon: "invoice", to: "/invoices", color: "var(--invoice)", textColor: "var(--invoice-text)",
      count: invoices.awaiting, value: invoices.awaiting_value, caption: statusText("invoice", "sent"),
      rows: [
        { label: `${statusText("invoice", "draft")} (${invoices.draft})`, value: "" },
        { label: `${statusText("invoice", "overdue")} (${invoices.past_due})`, value: formatMoneyCompact(invoices.past_due_value), danger: invoices.past_due > 0 },
        // Autopay's, only when there's one: charges that failed, and ones waiting for the office's OK.
        ...(invoices.autopay_failed ? [{ label: `Autopay failed (${invoices.autopay_failed})`, value: formatMoneyCompact(invoices.autopay_failed_value ?? 0), danger: true }] : []),
        ...(invoices.autopay_approval ? [{ label: `Needs your OK (${invoices.autopay_approval})`, value: "" }] : []),
      ],
    },
  ];

  return (
    <section aria-labelledby="workflow-title" className={styles.section}>
      <h2 id="workflow-title" className="section-title">Workflow</h2>
      <div className={styles.strip} style={{ ["--cols" as string]: showInvoices ? 4 : 3 }}>
        {columns.filter((col) => showInvoices || col.key !== "invoices").map((col, i) => (
          <Link key={col.key} to={col.to} className={styles.column} style={{ borderTopColor: col.color }} data-rise>
            {i > 0 && <span className={styles.chevron} aria-hidden="true"><Icon name="chevronRight" size={12} /></span>}
            <span className={styles.label} style={{ color: col.textColor }}>
              <span style={{ color: col.color }}><Icon name={col.icon} /></span>
              {col.label}
            </span>
            <span>
              <span className={styles.countRow}>
                <AnimatedNumber className={styles.count} value={col.count} />
                {col.value !== undefined && <AnimatedNumber className={styles.value} value={col.value} format={moneyCompact(col.value)} />}
              </span>
              <span className={styles.caption}>{col.caption}</span>
            </span>
            <span className={styles.rows}>
              {col.rows.map((row) => (
                <span key={row.label} className={styles.row} style={row.danger ? { color: "var(--danger)", fontWeight: 600 } : undefined}>
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </span>
              ))}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
