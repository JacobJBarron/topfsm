import type { TablesUpdate } from "@crewtavo/core/database";
import { askRefusal, marketingOn } from "@crewtavo/core/marketing";
import { contractDiscountNote } from "@crewtavo/core/promos";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AnimatedNumber, MONEY_CENTS } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { MapsLink } from "@/components/ui/MapsLink";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader, useDocumentTitle } from "@/components/ui/PageHeader";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, PageError } from "@/components/ui/States";
import { EntityStatus, StatusPill, statusLabel, statusText, visitTone } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, formatDate, formatDateTime, formatMoney, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { LineItems } from "../quotes/LineItems";
import { VisitDialog, type VisitInput } from "../schedule/VisitDialog";
import { useSchedulingRights } from "../schedule/myCrews";
import { handlesSubPay, useJobPays } from "../subs/payData";
import { ChangeOrders, useStartChangeOrder } from "./ChangeOrders";
import { ExpensesCard, useJobExpenses } from "./ExpensesCard";
import { MaterialsCard, useJobMaterials } from "./JobMaterials";
import { PhotosCard } from "../files/PhotosCard";
import { PlansCard } from "../plans/PlansCard";
import { InvoiceJobDialog, JobDetailsDialog, type JobRecord } from "./JobDialogs";
import { JobDiscountNote } from "./JobDiscountNote";
import { jobCosts } from "./jobCosts";
import { JobPayCard, seesJobPay } from "./JobPayCard";
import { repeatText } from "./repeatText";
import { ScopeOfWork } from "./ScopeOfWork";
import { askToastKind, type AskResult } from "../marketing/askForm";

/** The sections a job only shows once it uses them, offered under its line items until then. */
type Extra = "materials" | "expenses" | "pay";

export function JobPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [visit, setVisit] = useState<VisitInput | null>(null);
  // ?invoice=1 (from a paving project's Invoice step) opens Create invoice straight away.
  const [params] = useSearchParams();
  const [dialog, setDialog] = useState<null | "details" | "invoice">(() => (params.get("invoice") ? "invoice" : null));
  const [showPast, setShowPast] = useState(false);
  // The empty section an add button under the line items just opened, shown while its dialog is up.
  const [adding, setAdding] = useState<Extra | null>(null);
  // The add button pressed goes as its section shows, so when the dialog closes keyboard focus goes back
  // to it, or (something was added, so it's gone for good) to the section's own add button, not the page.
  const wasAdding = useRef<Extra | null>(null);
  useEffect(() => {
    const was = wasAdding.current;
    wasAdding.current = adding;
    if (adding || !was || (document.activeElement && document.activeElement !== document.body)) return;
    (document.querySelector<HTMLElement>(`[data-add="${was}"]`) ?? document.querySelector<HTMLElement>(`[data-extra="${was}"] .section-head button`))?.focus({ preventScroll: true });
  }, [adding]);
  const visitsRef = useListAnimation<HTMLDivElement>();
  const isOffice = hasRole(session, "admin", "office");
  const seesInvoices = isOffice && can(session, "invoices");
  const seesCosts = isOffice && can(session, "job_costs");
  const seesPay = seesJobPay(session);
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  const canDispatch = useSchedulingRights().canDispatch;
  const today = todayIn(session.company.timezone);
  // The same queries the sections use, to know which ones this job has anything in.
  const materialRows = useJobMaterials(id);
  const expenseRows = useJobExpenses(id, seesCosts);
  const payRows = useJobPays(session.company.id, id, seesPay);

  const job = useQuery({
    queryKey: ["job", id],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("jobs")
          .select("*, financials:job_financials(contract_total), client:clients(id, display_name, phone, email, status, review_opt_out, marketing_opt_out, sms_opt_out_at, reviewed_at), property:properties(id, line1, city, region, postal_code, lat, lng), quote:quotes!jobs_company_id_quote_id_fkey(id, number, deposit_amount), crew:crews(name), lines:job_line_items(id, name, description, quantity, unit, unit_price, unit_cost, unit_labor_cost, taxable, sort, service_id, source_quote_id, discount_billing, discount_key), visits(id, title, kind, status, scheduled_on, starts_at, ends_at, crew_id, notes, hold_reason, invoice_id, completed_at, crew:crews(name, color), assignees:visit_assignees(user_id))")
          .eq("id", id)
          .order("sort", { referencedTable: "job_line_items" })
          .order("scheduled_on", { referencedTable: "visits" })
          .maybeSingle(),
        "This job",
      ),
  });
  const j = job.data;
  useDocumentTitle(j ? `Job #${j.number}` : "Job");
  useRememberRecent(session.company.id, j ? { kind: "job", id: j.id, title: j.title, subtitle: `Job #${j.number} · ${j.client?.display_name ?? ""}`, path: `/jobs/${j.id}` } : null);

  const invoices = useQuery({
    queryKey: ["job", id, "invoices"],
    enabled: seesInvoices,
    queryFn: async () => unwrap(await supabase().from("invoices").select("id, number, kind, status, subtotal, total, balance_due, retainage_amount, pay_app_number").eq("job_id", id).order("number")),
  });
  const costs = useQuery({
    queryKey: ["job", id, "costs"],
    enabled: seesCosts,
    queryFn: async () => {
      const [time, expenses, rates, crewPay] = await Promise.all([
        supabase().from("time_entries").select("id, started_at, ended_at").eq("job_id", id),
        supabase().from("expenses").select("amount").eq("job_id", id),
        // Pay rates come from the server: nobody reads them on time entries directly.
        api.post<Record<string, number>>("/time/rates", { job_ids: [id] }),
        // Sub and crew pay that's agreed, done or paid (totals only).
        supabase().rpc("job_pay_costs", { p_jobs: [id] }),
      ]);
      const entries = unwrap(time);
      const hours = entries.reduce((s, t) => s + (t.ended_at ? (Date.parse(t.ended_at) - Date.parse(t.started_at)) / 3_600_000 : 0), 0);
      const labor = entries.reduce((s, t) => s + (t.ended_at ? ((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 3_600_000) * Number(rates[t.id] ?? 0) : 0), 0);
      return { hours, labor, crewPay: unwrap(crewPay), expenses: unwrap(expenses).reduce((s, e) => s + Number(e.amount), 0) };
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["job", id] });
    queryClient.invalidateQueries({ queryKey: ["jobs", session.company.id] });
  };
  const update = useMutation({
    meta: { success: (_: unknown, p: TablesUpdate<"jobs">) => (p.status === "requires_invoicing" ? "Job marked complete" : p.status === "archived" ? "Job archived" : p.status === "active" ? "Job reopened" : p.status === "completed" ? "Job closed" : "Job saved"), tone: "job" },
    mutationFn: async (patch: TablesUpdate<"jobs">) => unwrap(await supabase().from("jobs").update(patch).eq("id", id)),
    onSuccess: refresh,
  });
  const completeVisit = useMutation({
    meta: { success: "Visit completed", tone: "job" },
    mutationFn: (visitId: string) => api.patch(`/visits/${visitId}`, { status: "completed" }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { success: "Job deleted", tone: "job" },
    mutationFn: async () => unwrap(await supabase().from("jobs").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs", session.company.id] });
      navigate("/jobs", { replace: true });
    },
  });
  const review = useMutation({
    mutationFn: (channel: "email" | "sms") => api.post<AskResult>("/reviews/request", { client_id: j!.client!.id, job_id: id, channel }),
    onSuccess: (r) => toast[askToastKind(r)](r.detail),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["review-requests", session.company.id] }),
  });

  const changeOrder = useStartChangeOrder({ id, title: j?.title ?? "", client: j?.client ?? null, property: j?.property ?? null });

  if (job.isPending) return <DetailSkeleton />;
  if (job.error || !j) return <PageError error={job.error} onRetry={() => job.refetch()} back={<BackLink to="/jobs">Jobs</BackLink>} />;

  const contract = Number(j.financials?.contract_total ?? 0);
  const cost = jobCosts({ contract, lines: j.lines, labor: costs.data?.labor ?? 0, expenses: costs.data?.expenses ?? 0, crewPay: costs.data?.crewPay ?? [] });
  const { materials, labor, crew, expenses, profit, margin } = cost;
  const visits = j.visits;
  const upcoming = visits.filter((v) => !["completed", "cancelled"].includes(v.status));
  const past = visits.filter((v) => ["completed", "cancelled"].includes(v.status));
  const shownVisits = [...upcoming.slice(0, 12), ...(showPast ? past : [])];
  const uninvoiced = visits.filter((v) => v.status === "completed" && !v.invoice_id && v.kind === "job").length;
  const billed = (invoices.data ?? []).filter((i) => ["deposit", "progress"].includes(i.kind) && i.status !== "void").reduce((s, i) => s + Number(i.subtotal), 0);
  const hasInvoices = Boolean(invoices.data?.length);
  const live = (invoices.data ?? []).filter((i) => i.status !== "void");
  const retainageHeld =
    live.filter((i) => i.kind !== "retainage").reduce((s, i) => s + Number(i.retainage_amount), 0) -
    live.filter((i) => i.kind === "retainage").reduce((s, i) => s + Number(i.subtotal), 0);
  const finalInvoice = j.kind !== "recurring" ? live.find((i) => i.kind === "standard")?.number ?? null : null;
  // Work that repeats takes a once-per-job promo code off its first invoice only, which the job says.
  const repeats = j.kind === "recurring" || j.billing_mode === "per_visit";
  const contractNote = repeats ? contractDiscountNote(j.lines) : null;
  // By email, or by text when email can't reach them, as the client's page offers it: not to a client
  // who opted out or is archived. Marketing uninstalled, nobody's asked.
  const ready = { email: session.config.features.email, sms: session.config.features.sms };
  const reviewBy = j.client ? (["email", "sms"] as const).find((channel) => !askRefusal(j.client!, channel, ready)) ?? null : null;
  const newVisit = (): VisitInput => ({ job_id: j.id, property_id: j.property?.id ?? null, title: j.title, crew_id: j.default_crew_id, kind: "job", context: { label: `Job #${j.number} · ${j.client?.display_name ?? ""}`, to: `/jobs/${j.id}` } });

  // Materials, expenses and sub pay take no room until they have something (or failed to load, to
  // say so). Until then they're small add buttons under the line items, each opening the same dialog
  // as the section's own button and showing the section while it's open.
  const used = (extra: Extra, rows: { data?: readonly unknown[]; error: unknown }) => Boolean(rows.data?.length) || Boolean(rows.error) || adding === extra;
  const shows = { materials: used("materials", materialRows), expenses: seesCosts && used("expenses", expenseRows), pay: seesPay && used("pay", payRows) };
  const offers: Array<{ key: Extra; label: string; name: string }> = [];
  if (materialRows.data?.length === 0 && !shows.materials) offers.push({ key: "materials", label: "Materials", name: "Log materials" });
  if (seesCosts && expenseRows.data?.length === 0 && !shows.expenses) offers.push({ key: "expenses", label: "Expense", name: "Add an expense" });
  if (seesPay && j.status !== "archived" && payRows.data?.length === 0 && !shows.pay) {
    const label = handlesSubPay(session) ? "Sub pay" : "Crew pay";
    offers.push({ key: "pay", label, name: `Add ${label.toLowerCase()}` });
  }
  const addButtons = offers.length > 0 && (
    <div className="add-chips" role="group" aria-label="Add to this job">
      {offers.map((o) => <Button key={o.key} size="sm" icon="plus" className="add-chip" aria-label={o.name} data-add={o.key} onClick={() => setAdding(o.key)}>{o.label}</Button>)}
    </div>
  );
  const doneAdding = () => setAdding(null);
  // Green says the job made money: ink while there's nothing to count, red when it lost some.
  const profitColor = profit >= 0.005 ? "var(--green-dark)" : profit <= -0.005 ? "var(--danger)" : undefined;

  return (
    <>
      <BackLink to="/jobs">Jobs</BackLink>
      <PageHeader
        title={j.title}
        actions={
          <>
            {seesInvoices && j.status !== "archived" && <Button icon="invoice" variant={j.status === "requires_invoicing" ? "primary" : "secondary"} onClick={() => setDialog("invoice")}>Create invoice</Button>}
            {canSell && j.status === "active" && j.kind === "one_off" && <Button variant="primary" icon="check" loading={update.isPending} onClick={() => update.mutate({ status: "requires_invoicing" })}>Mark work complete</Button>}
            {canSell && (
              <Menu
                items={[
                  { label: "Edit details and schedule", icon: "edit", onSelect: () => setDialog("details") },
                  { label: "New change order", icon: "quote", hidden: !["active", "requires_invoicing"].includes(j.status) || !j.client, onSelect: () => changeOrder.mutate() },
                  {
                    label: j.client?.reviewed_at ? "Already left a Google review" : reviewBy === "sms" ? "Ask for a review by text" : "Ask for a review", icon: "star",
                    hidden: !marketingOn(session.company.settings) || !j.client, disabled: !reviewBy, onSelect: () => review.mutate(reviewBy!),
                  },
                  { separator: true },
                  { label: "Mark work complete", icon: "check", hidden: j.status !== "active" || j.kind === "one_off", onSelect: () => update.mutate({ status: "requires_invoicing" }) },
                  { label: "Close job", icon: "check", hidden: !["requires_invoicing"].includes(j.status), onSelect: () => update.mutate({ status: "completed" }) },
                  { label: "Reopen job", icon: "undo", hidden: j.status === "active", onSelect: () => update.mutate({ status: "active" }) },
                  { label: "Archive job", icon: "archive", hidden: j.status === "archived", onSelect: () => update.mutate({ status: "archived" }) },
                  {
                    label: "Delete job",
                    icon: "trash",
                    danger: true,
                    hidden: !isOffice || hasInvoices,
                    onSelect: async () => {
                      if (await confirm({ title: `Delete job #${j.number}?`, body: "Its visits, line items and checklists are deleted too. Logged time and expenses are kept. This can't be undone.", confirmLabel: "Delete job", danger: true, typeToConfirm: visits.length > 5 ? "delete" : undefined })) remove.mutate();
                    },
                  },
                ]}
              />
            )}
          </>
        }
      />
      {/* The status, who it's for and how often it repeats. The number is under Details, the address with the client. */}
      <div className="page-meta">
        <EntityStatus kind="job" status={j.status} />
        {j.client && <Link to={`/clients/${j.client.id}`}>{j.client.display_name}</Link>}
        {j.kind === "recurring" && <span className="muted">{j.recurrence_rule ? repeatText(j.recurrence_rule) : "Recurring"}</span>}
      </div>

      {/* Requires invoicing needs no banner: the pill says so and Create invoice is the page's green button. */}
      {uninvoiced > 0 && seesInvoices && j.status === "active" && j.billing_mode === "per_visit" && (
        <div className="callout callout-info">
          <Icon name="invoice" size={20} />
          <div className="grow">{uninvoiced} completed {uninvoiced === 1 ? "visit is" : "visits are"} ready to invoice.</div>
          <Button size="sm" onClick={() => setDialog("invoice")}>Invoice visits</Button>
        </div>
      )}

      <div className="two-col">
        <div className="wide stack-lg">
          <section className="stack">
            <div className="section-head">
              <h2 className="section-title">Visits</h2>
              {visits.length > 0 && <span className="muted small">{past.filter((v) => v.status === "completed").length} of {visits.length} done</span>}
              {canDispatch && j.status !== "archived" && <Button size="sm" icon="plus" onClick={() => setVisit(newVisit())}>Add visit</Button>}
            </div>
            <div className="card" ref={visitsRef}>
              {visits.length === 0 && (
                <EmptyState inline title="No visits scheduled">
                  {j.kind === "recurring" ? "Set how it repeats in Edit details, and visits are made for the next 60 days." : null}
                </EmptyState>
              )}
              {shownVisits.map((v) => {
                const overdue = !["completed", "cancelled"].includes(v.status) && v.scheduled_on && v.scheduled_on < today;
                return (
                  <div key={v.id} className="card-row" style={{ cursor: canDispatch ? "pointer" : undefined }} onClick={() => canDispatch && setVisit({ ...v, job_id: j.id, property_id: j.property?.id ?? null, assignee_ids: v.assignees.map((a) => a.user_id), context: { label: `Job #${j.number}`, to: `/jobs/${j.id}` } })}>
                    <span style={{ width: 4, alignSelf: "stretch", borderRadius: "var(--radius-sm)", background: (v.crew as { color?: string } | null)?.color || "var(--fill-3)" }} aria-hidden="true" />
                    <span className="grow">
                      <strong>{v.title}</strong>
                      <span className={`small ${overdue ? "text-danger strong" : "muted"}`} style={{ display: "block" }}>
                        {v.starts_at ? formatDateTime(v.starts_at, session.company.timezone) : v.scheduled_on ? `${formatDate(v.scheduled_on)} · anytime` : "Not scheduled"}
                        {v.crew ? ` · ${(v.crew as { name: string }).name}` : ""}
                        {overdue ? " · overdue" : ""}
                        {v.invoice_id ? " · invoiced" : ""}
                      </span>
                      {v.hold_reason && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>Weather: {v.hold_reason}</span>}
                    </span>
                    <StatusPill label={statusText("visit", v.status)} tone={visitTone(v.status)} />
                    {canDispatch && !["completed", "cancelled"].includes(v.status) && (
                      <Button size="sm" variant="ghost" icon="check" aria-label={`Complete ${v.title}`} title="Mark complete" loading={completeVisit.isPending && completeVisit.variables === v.id} onClick={(e) => { e.stopPropagation(); completeVisit.mutate(v.id); }} />
                    )}
                  </div>
                );
              })}
              {(upcoming.length > 12 || past.length > 0) && (
                <div className="list-foot">
                  <span>{upcoming.length > 12 ? `${upcoming.length - 12} more upcoming` : ""}</span>
                  {past.length > 0 && <Button size="sm" variant="ghost" onClick={() => setShowPast(!showPast)}>{showPast ? "Hide past visits" : `Show ${past.length} past ${past.length === 1 ? "visit" : "visits"}`}</Button>}
                </div>
              )}
            </div>
          </section>

          {!hasRole(session, "admin", "office", "estimator") && (
            <>
              <ScopeOfWork jobId={j.id} />
              {addButtons}
            </>
          )}

          {hasRole(session, "admin", "office", "estimator") && (
            <section className="stack">
              <h2 className="section-title">Line items</h2>
              <LineItems table="job_line_items" parent="job_id" parentId={j.id} lines={j.lines} editable={canSell && ["active", "requires_invoicing"].includes(j.status)} onChanged={refresh} />
              {repeats && <JobDiscountNote jobId={j.id} lines={j.lines} seesInvoices={seesInvoices} canSwitch={canSell && j.status === "active"} onChanged={refresh} />}
              {addButtons}
            </section>
          )}

          {canSell && <ChangeOrders jobId={j.id} onStart={() => changeOrder.mutate()} starting={changeOrder.isPending} />}

          <PhotosCard jobId={j.id} />
          <PlansCard scope={{ kind: "job", id: j.id, propertyId: j.property?.id ?? null }} />

          {/* Each wrapped (display: contents) so focus can find its add button as its dialog closes. */}
          {shows.materials && <div data-extra="materials" style={{ display: "contents" }}><MaterialsCard jobId={j.id} showCosts={seesCosts} startAdding={adding === "materials"} onAddClosed={doneAdding} /></div>}

          {shows.expenses && <div data-extra="expenses" style={{ display: "contents" }}><ExpensesCard jobId={j.id} onChanged={() => queryClient.invalidateQueries({ queryKey: ["job", id, "costs"] })} startAdding={adding === "expenses"} onAddClosed={doneAdding} /></div>}

          {shows.pay && <div data-extra="pay" style={{ display: "contents" }}><JobPayCard job={{ id: j.id, number: j.number, title: j.title, archived: j.status === "archived" }} visits={visits} lines={j.lines} startAdding={adding === "pay"} onAddClosed={doneAdding} /></div>}

          {seesInvoices && (
            <section className="stack">
              <h2 className="section-title">Invoices</h2>
              <div className="card">
                {invoices.isPending && <div className="card-row"><Skeleton width="50%" /></div>}
                {/* Create invoice is in the page header, so the empty line doesn't repeat it. */}
                {invoices.data?.length === 0 && <EmptyState inline title="Not invoiced yet" />}
                {invoices.data?.map((inv) => (
                  <Link key={inv.id} to={`/invoices/${inv.id}`} className="card-row">
                    <strong className="grow">Invoice #{inv.number}{inv.kind === "progress" ? ` · pay app ${inv.pay_app_number}` : inv.kind === "deposit" ? " · deposit" : inv.kind === "visits" ? " · visits" : inv.kind === "retainage" ? " · retainage" : ""}</strong>
                    <span className="tabular">{formatMoney(inv.total)}</span>
                    <EntityStatus kind="invoice" status={inv.status} />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="narrow stack">
          {seesCosts && (
            <div className="card card-pad stack-sm">
              <strong>Job costing</strong>
              {costs.isPending ? <Skeleton height={60} /> : (
                <>
                  <ProfitBar price={contract} labor={labor} crew={crew} expenses={expenses} materials={materials} />
                  {/* The figures roll to their new values as line items, time and costs change. */}
                  <div className="totals" style={{ marginTop: 6 }}>
                    <div className="line" style={{ alignItems: "flex-start" }}>
                      <span>Price{contractNote && <span className="muted small" style={{ display: "block" }}>{contractNote}</span>}</span>
                      <AnimatedNumber value={contract} format={MONEY_CENTS} />
                    </div>
                    <div className="line"><span>{cost.actualLabor ? "Line item materials" : "Line item costs"}</span><AnimatedNumber value={materials} format={MONEY_CENTS} /></div>
                    <div className="line"><span>Labor ({(costs.data?.hours ?? 0).toFixed(1)} h)</span><AnimatedNumber value={labor} format={MONEY_CENTS} /></div>
                    <div className="line"><span>Sub and crew pay</span><AnimatedNumber value={crew} format={MONEY_CENTS} /></div>
                    <div className="line"><span>Expenses</span><AnimatedNumber value={expenses} format={MONEY_CENTS} /></div>
                    <div className="line grand">
                      <span>Profit</span>
                      <span style={{ color: profitColor }}><AnimatedNumber value={profit} format={MONEY_CENTS} />{margin !== null ? ` (${margin}%)` : ""}</span>
                    </div>
                  </div>
                  {cost.note && <span className="muted small">{cost.note}</span>}
                  {labor === 0 && (costs.data?.hours ?? 0) > 0 && <span className="muted small">Set labor rates in Settings → Team to cost tracked hours.</span>}
                </>
              )}
            </div>
          )}
          <div className="card card-pad stack-sm">
            <div className="row-between">
              <strong>Details</strong>
              {canSell && <Button size="sm" variant="ghost" icon="edit" onClick={() => setDialog("details")}>Edit</Button>}
            </div>
            <dl className="kv">
              <dt>Job number</dt><dd>#{j.number}</dd>
              {canSell && (
                <>
                  <dt>Contract</dt>
                  <dd>
                    <AnimatedNumber value={contract} format={MONEY_CENTS} />
                    {contractNote && <span className="muted small" style={{ display: "block" }}>{contractNote}</span>}
                  </dd>
                </>
              )}
              <dt>Billing</dt><dd>{statusLabel(j.billing_mode)}</dd>
              {j.kind === "recurring" && <><dt>Repeats</dt><dd>{j.recurrence_rule ? repeatText(j.recurrence_rule) : "—"}{j.starts_on ? `, from ${formatDate(j.starts_on)}` : ""}{j.ends_on ? ` to ${formatDate(j.ends_on)}` : ""}</dd></>}
              {j.crew && <><dt>Crew</dt><dd>{j.crew.name}</dd></>}
              {j.po_number && <><dt>PO</dt><dd>{j.po_number}</dd></>}
              {j.permit_number && <><dt>Permit</dt><dd>{j.permit_number}</dd></>}
              {Number(j.retainage_pct) > 0 && <><dt>Retainage</dt><dd>{Number(j.retainage_pct)}%</dd></>}
              {j.warranty_until && <><dt>Warranty</dt><dd>until {formatDate(j.warranty_until)}</dd></>}
              {j.quote && <><dt>From</dt><dd><Link to={`/quotes/${j.quote.id}`}>Quote #{j.quote.number}</Link></dd></>}
            </dl>
            {j.instructions && <p className="pre-wrap small" style={{ margin: 0, padding: 10, background: "var(--note)", borderRadius: "var(--radius-control)", border: "1px solid var(--note-border)" }}>{j.instructions}</p>}
          </div>
          {j.client && (
            <div className="card card-pad stack-sm">
              <strong>Client</strong>
              <Link to={`/clients/${j.client.id}`}>{j.client.display_name}</Link>
              {j.client.phone && <a href={`tel:${j.client.phone}`} className="small">{j.client.phone}</a>}
              {j.property && (
                <>
                  <span className="small">{addressLine(j.property)}</span>
                  <span style={{ justifySelf: "start" }}><MapsLink className="btn btn-sm" place={j.property}><Icon name="navigation" size={14} />Directions</MapsLink></span>
                </>
              )}
            </div>
          )}
        </aside>
      </div>

      {visit && <VisitDialog visit={visit} onClose={() => setVisit(null)} onSaved={refresh} />}
      {dialog === "details" && <JobDetailsDialog job={j as unknown as JobRecord} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === "invoice" && (
        <InvoiceJobDialog
          job={{ id: j.id, contract_total: contract, deposit: Number(j.quote?.deposit_amount ?? 0), billed, uninvoicedVisits: uninvoiced, kind: j.kind, retainageHeld, finalInvoice }}
          onClose={() => setDialog(null)}
          onCreated={(invoiceId) => {
            refresh();
            navigate(`/invoices/${invoiceId}`);
          }}
        />
      )}
    </>
  );
}

/** Price split into costs and profit, like Jobber's job profit bar. */
function ProfitBar({ price, labor, crew, expenses, materials }: { price: number; labor: number; crew: number; expenses: number; materials: number }) {
  const total = Math.max(price, labor + crew + expenses + materials, 1);
  const parts = [
    { label: "Line item costs", value: materials, color: "#c9852a" },
    { label: "Labor", value: labor, color: "#3474d4" },
    { label: "Sub and crew pay", value: crew, color: "#0e9aa7" },
    { label: "Expenses", value: expenses, color: "#8b5cf6" },
    { label: "Profit", value: Math.max(0, price - labor - crew - expenses - materials), color: "var(--green)" },
  ];
  return (
    <div style={{ display: "flex", height: 12, borderRadius: "var(--radius-pill)", overflow: "hidden", background: "var(--fill-2)" }} role="img" aria-label={parts.map((p) => `${p.label} ${formatMoney(p.value)}`).join(", ")}>
      {parts.map((p) => p.value > 0 && <span key={p.label} title={`${p.label}: ${formatMoney(p.value)}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color, transition: "width var(--dur-slow) var(--ease-out)" }} />)}
    </div>
  );
}
