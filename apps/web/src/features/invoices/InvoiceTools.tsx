/**
 * The money at a glance on the Invoices screen, invoicing every finished job in one go, autopay
 * charges that need someone, charging many saved cards at once, and reminding everyone who's past due.
 */
import { localDate } from "@crewtavo/core/time";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormChecks, FormError } from "@/components/ui/Field";
import { AnimatedNumber, MONEY } from "@/components/ui/AnimatedNumber";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { addDaysIso, formatDate, formatMoney, formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { receivablesTrend } from "@/lib/trends";
import { Change } from "../finance/change";
import { chargeBusy, chargeInChunks, chargeLiveText, chargeOutcomeText, chargeSummary, chargeTotal, type ChargeableInvoice, type ChargeResult } from "./charges";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * What's owed and past due today, and what came in over the past 30 days, each with its change: the
 * balances against 30 days ago, money in against the 30 days before. Balances back then are walked
 * back from today's through the payments since (lib/trends.ts), so they're close rather than exact.
 */
export function InvoiceSummary({ onPick }: { onPick: (filter: "open" | "overdue" | "paid") => void }) {
  const { company } = useSession();
  const tz = company.timezone;
  const today = todayIn(tz);
  const monthAgo = addDaysIso(today, -30);
  const summary = useQuery({
    queryKey: ["invoices", company.id, "summary"],
    queryFn: async () => {
      const [open, history] = await Promise.all([
        supabase().from("invoices").select("id, status, balance_due, issued_on, due_on").eq("company_id", company.id).in("status", ["sent", "partially_paid", "overdue"]).limit(5000),
        // Everything received in the past 60 days (and a day either side for time zones): this 30 days and the 30 before.
        supabase().from("payments").select("amount, received_at, invoice_id").eq("company_id", company.id).gte("received_at", `${addDaysIso(today, -61)}T00:00:00`).limit(5000),
      ]);
      const rows = unwrap(open);
      const late = rows.filter((r) => r.status === "overdue");
      const payments = unwrap(history);
      // Invoices paid off since then aren't open any more but were owed 30 days ago.
      const openIds = new Set(rows.map((r) => r.id));
      const paidIds = [...new Set(payments.map((p) => p.invoice_id).filter((id): id is string => Boolean(id) && !openIds.has(id!)))];
      const closed: typeof rows = [];
      for (let i = 0; i < paidIds.length; i += 200) {
        closed.push(...unwrap(await supabase().from("invoices").select("id, status, balance_due, issued_on, due_on").in("id", paidIds.slice(i, i + 200)).not("status", "in", "(draft,void)")));
      }
      const at = (day: string) => receivablesTrend({ invoices: [...rows, ...closed], payments, today: day, tz, weeks: 1 })[0]!;
      const now = at(today);
      return {
        owed: rows.reduce((sum, r) => sum + Number(r.balance_due), 0),
        owedCount: rows.length,
        late: late.reduce((sum, r) => sum + Number(r.balance_due), 0),
        lateCount: late.length,
        collected: now.collected,
        payments: payments.filter((p) => Number(p.amount) > 0 && localDate(new Date(p.received_at), tz) > monthAgo).length,
        before: at(monthAgo),
      };
    },
  });
  const s = summary.data;
  const stat = (label: string, value: number, change: ReactNode, hint: string, filter: "open" | "overdue" | "paid", tone?: "bad") => (
    <button type="button" className="card stat stat-button" onClick={() => onPick(filter)}>
      <span className="label">{label}</span>
      <span className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="value" style={tone ? { color: "var(--danger)" } : undefined}><AnimatedNumber value={value} format={MONEY} /></span>
        {change}
      </span>
      <span className="hint">{hint}</span>
    </button>
  );
  if (!s) return <div className="stat-row">{[0, 1, 2].map((i) => <div key={i} className="card stat"><Skeleton width="50%" height={11} /><Skeleton width="70%" height={24} /><Skeleton width="60%" height={11} style={{ marginTop: 6 }} /></div>)}</div>;
  // A balance's chip compares it with 30 days ago, which the hint then says.
  const since = (shown: boolean) => (shown ? " · vs 30 days ago" : "");
  return (
    <div className="stat-row">
      {stat(statusText("invoice", "sent"), s.owed, <Change now={s.owed} before={s.before.owed} compared="30 days ago" same="No change" />, `${plural(s.owedCount, "invoice")}${since(s.before.owed > 0)}`, "open")}
      {stat(
        statusText("invoice", "overdue"),
        s.late,
        <Change now={s.late} before={s.before.pastDue} compared="30 days ago" same="No change" better="down" />,
        `${s.lateCount ? plural(s.lateCount, "invoice") : "Nothing late"}${since(s.before.pastDue > 0)}`,
        "overdue",
        s.lateCount ? "bad" : undefined,
      )}
      {stat("Collected", s.collected, <Change now={s.collected} before={s.before.collected} compared="the 30 days before" />, `${plural(s.payments, "payment")} · Past 30 days`, "paid")}
    </div>
  );
}

interface ReadyJob {
  id: string;
  number: number;
  title: string;
  kind: string;
  billing_mode: string;
  client: { display_name: string; email: string | null } | null;
  financials: { contract_total: number } | null;
}

/**
 * Jobs waiting for their invoice: finished one-off jobs, and per-visit jobs with completed visits not
 * yet billed. Not ones autopay is about to bill and charge (a charge waiting for the job, or being
 * made): invoicing them by hand would only call the charge off.
 */
function useReadyJobs() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["invoices", company.id, "ready-jobs"],
    queryFn: async () => {
      const select = "id, number, title, kind, billing_mode, client:clients(display_name, email), financials:job_financials(contract_total)";
      const [finished, visits, charges] = await Promise.all([
        supabase().from("jobs").select(select).eq("company_id", company.id).eq("status", "requires_invoicing").order("number").limit(200),
        supabase().from("visits").select("job_id").eq("company_id", company.id).eq("status", "completed").eq("kind", "job").is("invoice_id", null).not("job_id", "is", null).limit(2000),
        supabase().from("autopay_charges").select("job_id").eq("company_id", company.id).in("status", ["waiting", "charging"]).is("invoice_id", null).not("job_id", "is", null).limit(2000),
      ]);
      // A server without autopay yet has nothing waiting: the list stays as it was rather than failing.
      const charged = new Set((charges.error ? [] : (charges.data ?? [])).map((c) => c.job_id));
      const ready = (unwrap(finished) as unknown as ReadyJob[]).filter((j) => !charged.has(j.id));
      const visitJobs = [...new Set(unwrap(visits).map((v) => v.job_id!))].filter((id) => !ready.some((j) => j.id === id) && !charged.has(id));
      if (visitJobs.length) {
        const perVisit = unwrap(await supabase().from("jobs").select(select).in("id", visitJobs).eq("billing_mode", "per_visit").eq("status", "active")) as unknown as ReadyJob[];
        ready.push(...perVisit);
      }
      return ready;
    },
  });
}

/**
 * Autopay charges someone has to see to, on the Invoices screen: ones that failed (the client was
 * sent the Pay link and a way to update their card), each name opening its invoice, and ones over
 * the autopay limit waiting for the office's OK. Nothing when there are none.
 */
export function AutopayAttention() {
  const { company } = useSession();
  const charges = useQuery({
    queryKey: ["invoices", company.id, "autopay"],
    meta: { silent: true },
    queryFn: async () => {
      const select = "id, status, invoice:invoices!autopay_charges_invoice_fkey(id, number), client:clients!autopay_charges_client_fkey(display_name)";
      const [failed, asking] = await Promise.all([
        supabase().from("autopay_charges").select(select, { count: "exact" }).eq("company_id", company.id).in("status", ["failed", "needs_client"]).not("invoice_id", "is", null).order("updated_at", { ascending: false }).limit(5),
        // The one waiting longest is the one to look at first.
        supabase().from("autopay_charges").select(select, { count: "exact" }).eq("company_id", company.id).eq("status", "needs_approval").not("invoice_id", "is", null).order("created_at").limit(1),
      ]);
      return { failed: unwrap(failed), failedCount: failed.count ?? 0, asking: unwrap(asking)[0] ?? null, askingCount: asking.count ?? 0 };
    },
  });
  const data = charges.data;
  if (!data || (!data.failedCount && !data.askingCount)) return null;
  const failed = data.failed.filter((c) => c.invoice);
  // The same client twice (two invoices) says which is which.
  const name = (c: (typeof failed)[number]) => {
    const who = c.client?.display_name ?? `Invoice #${c.invoice!.number}`;
    return failed.filter((o) => o.client?.display_name === c.client?.display_name).length > 1 ? `${who} (#${c.invoice!.number})` : who;
  };
  return (
    <>
      {data.failedCount > 0 && (
        <div className="callout callout-danger">
          <Icon name="card" size={20} />
          <div className="grow">
            <strong>{plural(data.failedCount, "autopay charge")} failed:</strong>{" "}
            {failed.map((c, i) => (
              <Fragment key={c.id}>
                {i > 0 && ", "}
                <Link to={`/invoices/${c.invoice!.id}`}>{name(c)}</Link>
              </Fragment>
            ))}
            {data.failedCount > failed.length && ` and ${data.failedCount - failed.length} more`}
          </div>
        </div>
      )}
      {data.askingCount > 0 && data.asking?.invoice && (
        <div className="callout callout-warning">
          <Icon name="card" size={20} />
          <div className="grow">
            <strong>{data.askingCount === 1 ? "1 charge needs" : `${data.askingCount} charges need`} your OK.</strong>{" "}
            <span className="muted">{data.asking.client?.display_name ? `${data.asking.client.display_name} · ` : ""}Invoice #{data.asking.invoice.number}</span>
          </div>
          <Link className="btn btn-sm" to={`/invoices/${data.asking.invoice.id}`}>Review</Link>
        </div>
      )}
    </>
  );
}

export function ReadyToInvoice() {
  const ready = useReadyJobs();
  const [open, setOpen] = useState(false);
  const jobs = ready.data ?? [];
  if (!jobs.length) return null;
  return (
    <>
      <div className="callout callout-info">
        <Icon name="invoice" size={20} />
        <div className="grow">
          <strong>{jobs.length} {jobs.length === 1 ? "job is" : "jobs are"} ready to invoice.</strong>{" "}
          <span className="muted">{jobs.slice(0, 3).map((j) => j.client?.display_name ?? j.title).join(", ")}{jobs.length > 3 ? ` and ${jobs.length - 3} more` : ""}</span>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>Invoice them</Button>
      </div>
      {open && <BatchDialog jobs={jobs} onClose={() => setOpen(false)} />}
    </>
  );
}

function BatchDialog({ jobs, onClose }: { jobs: ReadyJob[]; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string[]>(jobs.map((j) => j.id));
  const canEmail = session.config.features.email;
  const [send, setSend] = useState(false);
  const run = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      if (!picked.length) throw new Error("Pick at least one job to invoice.");
      return api.post<{ results: Array<{ number: number; ok: boolean; sent?: boolean; error?: string }> }>("/invoices/batch", { job_ids: picked, send });
    },
    onSuccess: ({ results }) => {
      const made = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const emailed = made.filter((r) => r.sent).length;
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (made.length) {
        toast.success(`${plural(made.length, "invoice")} created${send && emailed ? ` and ${emailed} emailed` : ""}`, { tone: "invoice", description: send ? undefined : "They're drafts until you send them." });
      }
      if (failed.length) toast.error(`${failed.length} couldn't be invoiced`, { description: failed.map((f) => `Job #${f.number}: ${f.error}`).join(". ") });
      const unsent = made.filter((r) => send && !r.sent);
      if (unsent.length) toast.error(`${unsent.length} not emailed`, { description: "No email address on file. They're in Drafts." });
      onClose();
    },
  });
  const total = jobs.filter((j) => picked.includes(j.id) && j.billing_mode !== "per_visit").reduce((s, j) => s + Number(j.financials?.contract_total ?? 0), 0);
  return (
    <Dialog open onClose={onClose} title="Invoice finished jobs" description="Each job gets its invoice, less any deposits or progress payments already billed." size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }}>
        <div className="card" style={{ boxShadow: "none", maxHeight: 340, overflowY: "auto" }}>
          {jobs.map((j) => (
            <label key={j.id} className="card-row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={picked.includes(j.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, j.id] : picked.filter((x) => x !== j.id))} />
              <span className="grow" style={{ minWidth: 0 }}>
                <strong>{j.client?.display_name ?? j.title}</strong>
                <span className="muted small" style={{ display: "block" }}>Job #{j.number} · {j.title}{j.billing_mode === "per_visit" ? " · completed visits" : ""}{send && !j.client?.email ? " · no email on file" : ""}</span>
              </span>
              <span className="tabular">{j.billing_mode === "per_visit" ? <span className="muted small">per visit</span> : formatMoney(j.financials?.contract_total ?? 0)}</span>
            </label>
          ))}
        </div>
        {canEmail && (
          <label className="switch-row" style={{ fontWeight: 400 }}>
            <input type="checkbox" className="switch" checked={send} onChange={(e) => setSend(e.target.checked)} />
            Email each client their invoice now
          </label>
        )}
        <FormError error={run.error} />
        <div className="form-actions">
          <FormChecks />
          <span className="muted small" style={{ marginRight: "auto" }}>{total > 0 ? `${formatMoney(total)} before tax` : null}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={send ? "send" : "invoice"} loading={run.isPending}>
            {send ? "Create and send" : "Create"} {picked.length} {picked.length === 1 ? "invoice" : "invoices"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RemindAllButton({ ids }: { ids: string[] }) {
  const { config } = useSession();
  const remind = useMutation({
    mutationFn: () => api.post<{ sent: number; skipped: Array<{ number: number; reason: string }> }>("/invoices/remind", { invoice_ids: ids }),
    onSuccess: (r) => {
      if (r.sent) toast.success(`${plural(r.sent, "reminder")} sent`, { tone: "invoice" });
      if (r.skipped.length) toast.error(`${r.skipped.length} not sent`, { description: r.skipped.map((s) => `Invoice #${s.number}: ${s.reason}`).join(". ") });
    },
  });
  if (!ids.length || !config.features.email) return null;
  return (
    <Button
      icon="send"
      loading={remind.isPending}
      onClick={async () => {
        if (await confirm({ title: `Email ${ids.length} payment ${ids.length === 1 ? "reminder" : "reminders"}?`, body: "Each client gets a friendly note with a link to view and pay.", confirmLabel: "Send reminders" })) remind.mutate();
      }}
    >
      Remind all
    </Button>
  );
}

/**
 * Charge cards: unpaid invoices whose client saved a card and agreed to be charged, ticked and
 * charged in one go. One with a charge under way shows what it's doing but can't be ticked. Each is a
 * charge the autopay task makes, for the balance shown, so a declined card sends that client the Pay
 * link, as autopay does; once they're sent, each invoice says what happened.
 */
export function ChargeCardsDialog({ onClose }: { onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["invoices", company.id, "chargeable"],
    queryFn: () => api.get<{ invoices: ChargeableInvoice[] }>("/invoices/chargeable"),
  });
  const rows = list.data?.invoices ?? [];
  const open = rows.filter((r) => !chargeBusy(r));
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = open.filter((r) => picked.includes(r.id));
  const total = chargeTotal(chosen);
  // The rows go with their results: the list changes under them once they're charging or paid. Looked
  // at again however it ends, since a chunk that failed may still have queued some.
  const charge = useMutation({
    meta: { inline: true },
    mutationFn: (batch: ChargeableInvoice[]) => chargeInChunks(batch, (body) => api.post<{ results: ChargeResult[] }>("/invoices/charge", body)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen.length || charge.isPending) return;
    const ok = await confirm({
      title: `Charge ${plural(chosen.length, "invoice")}?`,
      body: `${formatMoneyCents(total)} in all, each to the card its client saved. If a card is declined, that client is sent the Pay link.`,
      confirmLabel: `Charge ${formatMoneyCents(total)}`,
    });
    if (ok) charge.mutate(chosen);
  };
  const done = charge.data?.rows;
  const all = open.length > 0 && chosen.length === open.length;

  return (
    <Dialog open onClose={onClose} title="Charge saved cards" description="Unpaid invoices whose client saved a card and agreed to be charged." size="lg">
      {done ? (
        <div className="stack">
          <div className="card" style={{ boxShadow: "none", maxHeight: 340, overflowY: "auto" }}>
            {done.map(({ row, result }) => (
              <div key={row.id} className="card-row">
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>{row.client_name}</strong>
                  <span className="muted small" style={{ display: "block" }}>#{row.number} · {row.card}</span>
                </span>
                <span style={{ textAlign: "right" }}>
                  <span className="tabular">{formatMoneyCents(row.balance_due)}</span>
                  <span className={`small ${result.outcome === "queued" || result.outcome === "in_progress" ? "muted" : "text-danger"}`} style={{ display: "block" }}>{chargeOutcomeText(result)}</span>
                </span>
              </div>
            ))}
          </div>
          <FormError error={charge.data?.error} />
          <span className="muted small" role="status">{chargeSummary(done.map((d) => d.result))}</span>
          <div className="form-actions">
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          {list.isPending ? (
            <span className="muted small" role="status">Finding unpaid invoices…</span>
          ) : rows.length === 0 && !list.error ? (
            <EmptyState inline title="No saved cards to charge">Unpaid invoices show here once their client saves a card and agrees to be charged.</EmptyState>
          ) : (
            rows.length > 0 && (
              <>
                <label className="row" style={{ gap: 8, cursor: open.length ? "pointer" : "default" }}>
                  <input type="checkbox" checked={all} disabled={!open.length} onChange={(e) => setPicked(e.target.checked ? open.map((r) => r.id) : [])} />
                  Select all ({open.length})
                </label>
                <div className="card" style={{ boxShadow: "none", maxHeight: 340, overflowY: "auto" }}>
                  {rows.map((r) => (
                    <label key={r.id} className="card-row" style={{ cursor: chargeBusy(r) ? "default" : "pointer" }}>
                      <input type="checkbox" disabled={chargeBusy(r)} checked={!chargeBusy(r) && picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <strong>{r.client_name}</strong>
                        <span className="muted small" style={{ display: "block" }}>
                          #{r.number} · <span className={r.status === "overdue" ? "text-danger" : undefined}>{r.due_on ? `Due ${formatDate(r.due_on)}` : "Due on receipt"}</span> · {r.card}
                        </span>
                      </span>
                      <span style={{ textAlign: "right" }}>
                        <span className="tabular">{formatMoneyCents(r.balance_due)}</span>
                        {chargeBusy(r) && <span className="muted small" style={{ display: "block" }}>{chargeLiveText(r)}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )
          )}
          <FormError error={charge.error ?? list.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="card" loading={charge.isPending} disabled={!chosen.length}>
              {chosen.length ? `Charge ${plural(chosen.length, "invoice")} · ${formatMoneyCents(total)}` : "Charge invoices"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
