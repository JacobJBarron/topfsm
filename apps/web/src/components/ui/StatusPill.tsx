/*
 * Status words: the one place they're written. Each kind of record, its states, and the label each
 * state gets everywhere (two words at most). Anything else that names a state, a filter, a column, a
 * stat, a picker, uses statusText or these same words, so a state never reads two ways.
 *
 *   Client   lead "Lead" · active "Active" · archived "Archived"
 *   Request  new "New" · assessment_scheduled "Assessment booked" · assessment_complete "Assessment done" ·
 *            quoted "Quoted" · converted "Converted" · archived "Archived"
 *   Quote    draft "Draft" · sent "Awaiting response" · changes_requested "Changes requested" ·
 *            approved "Approved" · converted "Converted" · lost "Lost" · archived "Archived"
 *   Job      active "Active" · requires_invoicing "Requires invoicing" · completed "Completed" · archived "Archived"
 *   Invoice  draft "Draft" · sent "Awaiting payment" · partially_paid "Partly paid" · paid "Paid" ·
 *            overdue "Past due" · void "Void" · written_off "Written off"
 *   Visit    unscheduled "Unscheduled" · scheduled "Scheduled" · en_route "On the way" ·
 *            in_progress "In progress" · completed "Completed" · cancelled "Cancelled"
 *   Referral new "New lead" · quoted "Quoted" · won "Won" · lost "Lost"
 *   Credit   pending "Pending" · earned "Earned" · applied "Applied" · issued "Given" · none "No credit"
 *            (a referral credit: Marketing → Referrals shows the referral's state until the friend
 *            pays, then its credit's, packages/core/src/marketing.ts referralPill)
 *   Campaign draft "Draft" · scheduled "Scheduled" · sending "Sending" · sent "Sent" · cancelled "Stopped" ·
 *            automated "Automated" (one that sends by itself, Marketing → Campaigns)
 *   Recipient pending "Queued" · sending "Sending" · sent "Sent" · failed "Failed" · skipped "Skipped" ·
 *            opened "Opened" · clicked "Clicked" (a campaign email, and what was done with it)
 *
 * Money that's late is "Past due", never "Overdue" or "Waiting on payment". "Overdue" is kept for work
 * that's late: a new request nobody has answered in two days (Home's workflow), a visit past its day,
 * equipment maintenance. packages/core/src/automations.ts (STATUS_CHOICES) repeats these words for the
 * automation builder, so change both together. A paving or roofing project's stage ("Proposal sent",
 * "Won") is its own thing, worded in features/paving/data.ts and features/roofing/data.ts.
 */

const TONES = {
  good: { bg: "var(--green-tint)", fg: "var(--green-dark)", dot: "var(--job)" },
  info: { bg: "var(--invoice-tint)", fg: "var(--invoice-text)", dot: "var(--invoice)" },
  warning: { bg: "var(--warning-tint)", fg: "var(--warning)", dot: "var(--req)" },
  danger: { bg: "var(--danger-tint)", fg: "var(--danger)", dot: "var(--danger)" },
  muted: { bg: "var(--fill-2)", fg: "var(--text-2)", dot: "#9aa39d" },
} as const;

export type Tone = keyof typeof TONES;

/** Status is always shown as text in a pill, never color alone. */
export function StatusPill({ label, tone = "muted" }: { label: string; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <span className="pill" style={{ background: t.bg, color: t.fg }}>
      <span className="pill-dot" style={{ background: t.dot }} />
      {label}
    </span>
  );
}

/** "in_progress" -> "In progress". For other snake_case words; a record's status goes through statusText. */
export const statusLabel = (status: string) => (status.charAt(0).toUpperCase() + status.slice(1)).replace(/_/g, " ");

const STATUS_TEXT = {
  client: { lead: "Lead", active: "Active", archived: "Archived" },
  request: { new: "New", assessment_scheduled: "Assessment booked", assessment_complete: "Assessment done", quoted: "Quoted", converted: "Converted", archived: "Archived" },
  quote: { draft: "Draft", sent: "Awaiting response", changes_requested: "Changes requested", approved: "Approved", converted: "Converted", lost: "Lost", archived: "Archived" },
  job: { active: "Active", requires_invoicing: "Requires invoicing", completed: "Completed", archived: "Archived" },
  invoice: { draft: "Draft", sent: "Awaiting payment", partially_paid: "Partly paid", paid: "Paid", overdue: "Past due", void: "Void", written_off: "Written off" },
  visit: { unscheduled: "Unscheduled", scheduled: "Scheduled", en_route: "On the way", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" },
  referral: { new: "New lead", quoted: "Quoted", won: "Won", lost: "Lost" },
  credit: { pending: "Pending", earned: "Earned", applied: "Applied", issued: "Given", none: "No credit" },
  campaign: { draft: "Draft", scheduled: "Scheduled", sending: "Sending", sent: "Sent", cancelled: "Stopped", automated: "Automated" },
  recipient: { pending: "Queued", sending: "Sending", sent: "Sent", failed: "Failed", skipped: "Skipped", opened: "Opened", clicked: "Clicked" },
} satisfies Record<string, Record<string, string>>;

export type StatusKind = keyof typeof STATUS_TEXT;

/** The label for a record's state, from the list at the top: statusText("invoice", "overdue") is "Past due". */
export const statusText = (kind: StatusKind, status: string) => (STATUS_TEXT[kind] as Record<string, string>)[status] ?? statusLabel(status);

const VISIT_TONES: Record<string, Tone> = {
  completed: "good",
  in_progress: "info",
  en_route: "info",
  scheduled: "muted",
  unscheduled: "warning",
  cancelled: "danger",
};

export const visitTone = (status: string): Tone => VISIT_TONES[status] ?? "muted";

const ENTITY_TONES: Record<StatusKind, Record<string, Tone>> = {
  client: { lead: "warning", active: "good", archived: "muted" },
  request: { new: "warning", assessment_scheduled: "info", assessment_complete: "info", quoted: "good", converted: "good", archived: "muted" },
  quote: { draft: "muted", sent: "info", changes_requested: "warning", approved: "good", converted: "good", lost: "danger", archived: "muted" },
  job: { active: "info", requires_invoicing: "warning", completed: "good", archived: "muted" },
  invoice: { draft: "muted", sent: "info", partially_paid: "warning", paid: "good", overdue: "danger", void: "muted", written_off: "muted" },
  visit: VISIT_TONES,
  referral: { new: "warning", quoted: "info", won: "good", lost: "danger" },
  credit: { pending: "muted", earned: "warning", applied: "good", issued: "good", none: "muted" },
  campaign: { draft: "muted", scheduled: "info", sending: "info", sent: "good", cancelled: "danger", automated: "info" },
  // Each step further reads stronger: sent, then opened, then clicked.
  recipient: { pending: "muted", sending: "info", sent: "muted", failed: "danger", skipped: "muted", opened: "info", clicked: "good" },
};

/** Pill for a record's status, e.g. <EntityStatus kind="quote" status="sent" />. */
export function EntityStatus({ kind, status }: { kind: StatusKind; status: string }) {
  return <StatusPill label={statusText(kind, status)} tone={ENTITY_TONES[kind][status] ?? "muted"} />;
}
