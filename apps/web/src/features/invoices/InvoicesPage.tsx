import { autopaySettings } from "@crewtavo/core/autopay";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { addDaysIso, formatDate, formatMoney, todayIn } from "@/lib/format";
import { useStatusCounts } from "@/lib/listing";
import { can, hasRole, useSession } from "@/lib/session";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { AutopayAttention, ChargeCardsDialog, InvoiceSummary, ReadyToInvoice, RemindAllButton } from "./InvoiceTools";

// Each filter is named for its status ("open" is everything still owed, under the sent status's name).
const FILTERS = [
  { key: "open", label: statusText("invoice", "sent"), statuses: ["sent", "partially_paid", "overdue"] },
  { key: "overdue", label: statusText("invoice", "overdue"), statuses: ["overdue"] },
  { key: "draft", label: statusText("invoice", "draft"), statuses: ["draft"] },
  { key: "paid", label: statusText("invoice", "paid"), statuses: ["paid"] },
  { key: "written_off", label: statusText("invoice", "written_off"), statuses: ["written_off"] },
  { key: "void", label: statusText("invoice", "void"), statuses: ["void"] },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

export function InvoicesPage() {
  const session = useSession();
  return hasRole(session, "admin", "office") && can(session, "invoices") ? <InvoicesPageScreen /> : <NoAccess title="Invoices" />;
}

function InvoicesPageScreen() {
  const session = useSession();
  const { company } = session;
  // Autopay's charges carry what clients owe: for the people who look after money.
  const seesMoney = hasRole(session, "admin", "office") && can(session, "invoices");
  // Charge cards: only while the company charges clients' saved cards (Settings → Payments).
  const chargesCards = seesMoney && autopaySettings(company.settings, company.trade_preset).enabled;
  const [charging, setCharging] = useState(false);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>(() => (FILTERS.find((x) => x.key === params.get("status"))?.key as FilterKey | undefined) ?? "open");
  const [search, setSearch] = useState("");
  const term = useDeferredValue(searchTerm(search));
  const statuses = FILTERS.find((f) => f.key === filter)!.statuses;
  // Settled ones (paid, written off, void) newest first; ones still owed by when they're due.
  const settled = filter === "paid" || filter === "written_off" || filter === "void";
  const counts = useStatusCounts("invoices", company.id, Object.fromEntries(FILTERS.map((f) => [f.key, f.statuses])));
  const today = todayIn(company.timezone);

  const invoices = useQuery({
    queryKey: ["invoices", company.id, filter, term],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase()
        .from("invoices")
        .select("id, number, kind, status, subject, issued_on, due_on, total, balance_due, client:clients(display_name)")
        .eq("company_id", company.id)
        .in("status", [...statuses])
        .order(settled ? "issued_on" : "due_on", { ascending: !settled, nullsFirst: false })
        .limit(300);
      if (term) {
        if (/^\d+$/.test(term)) q = q.eq("number", Number(term));
        else {
          const { data } = await supabase().from("clients").select("id").eq("company_id", company.id).ilike("display_name", `%${term}%`).limit(60);
          const ids = (data ?? []).map((c) => c.id);
          q = q.or([`subject.ilike.%${term}%`, ids.length ? `client_id.in.(${ids.join(",")})` : null].filter(Boolean).join(","));
        }
      }
      return unwrap(await q);
    },
  });

  if (invoices.isPending) return <ListPageSkeleton columns={6} tabs={FILTERS.length} />;
  const rows = invoices.data ?? [];
  const owed = rows.reduce((s, i) => s + Number(i.balance_due), 0);
  const billed = rows.reduce((s, i) => s + Number(i.total), 0);

  const exportCsv = () => {
    downloadCsv(
      `invoices-${filter}-${today}.csv`,
      toCsv(
        rows.map((i) => ({ ...i, client: i.client?.display_name ?? "" })),
        [
          { key: "number", label: "Invoice" }, { key: "client", label: "Client" }, { key: "subject", label: "Subject" }, { key: "status", label: "Status" },
          { key: "issued_on", label: "Issued" }, { key: "due_on", label: "Due" }, { key: "total", label: "Total" }, { key: "balance_due", label: "Balance due" },
        ],
      ),
    );
  };

  return (
    <>
      <PageHeader
        title="Invoices"
        actions={
          <>
            <Menu
              items={[
                { label: "Stripe deposits", icon: "dollar", onSelect: () => navigate("/payouts") },
                { label: "Download as spreadsheet", icon: "download", onSelect: exportCsv, disabled: !rows.length },
                { separator: true, hidden: !chargesCards },
                { label: "Charge cards", icon: "card", onSelect: () => setCharging(true), hidden: !chargesCards },
              ]}
            />
            <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" }, { replace: true })}>New invoice</Button>
          </>
        }
      />
      <InvoiceSummary onPick={setFilter} />
      <ReadyToInvoice />
      {seesMoney && <AutopayAttention />}
      <div className="toolbar">
        <div className="input-group">
          <span className="addon"><Icon name="search" size={16} /></span>
          <input className="input" type="search" placeholder="Search by client, subject or #number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search invoices" />
        </div>
        <div className="tabs" role="group" aria-label="Filter invoices">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {counts.data && <span className={`badge${f.key === "overdue" && counts.data[f.key] ? " badge-red" : ""}`}>{counts.data[f.key]}</span>}
            </button>
          ))}
        </div>
        {filter === "overdue" && <RemindAllButton ids={rows.filter((r) => Number(r.balance_due) > 0).map((r) => r.id)} />}
      </div>
      {invoices.error && !invoices.data ? (
        <div className="card"><ErrorState error={invoices.error} onRetry={() => invoices.refetch()} /></div>
      ) : rows.length === 0 ? (
        <div className="card">
          {term ? (
            <EmptyState icon="search" title="No invoices match" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
          ) : (
            <EmptyState icon="invoice" title={filter === "open" ? "Nothing awaiting payment" : filter === "overdue" ? "Nothing past due" : "Nothing here"} action={filter === "open" && <Link className="btn" to="/jobs">Find jobs to invoice</Link>}>
              {filter === "open"
                ? "Invoice finished jobs from the job page, or create a standalone invoice."
                : filter === "overdue"
                  ? "Every sent invoice is within its terms."
                  : filter === "written_off"
                    ? "When a client is never going to pay, open the invoice and choose Write off from its menu."
                    : "No invoices have this status."}
            </EmptyState>
          )}
        </div>
      ) : (
        <div className={`card${invoices.isPlaceholderData ? " is-stale" : ""}`}>
          <table className="table table-stack">
            <thead><tr><th>#</th><th>Client</th><th>Due</th><th className="num">Total</th><th className="num">Balance</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((i) => {
                const late = i.due_on && Number(i.balance_due) > 0 && i.status !== "draft" && i.status !== "written_off" && i.due_on < today;
                return (
                  <tr key={i.id} className="row-link" onClick={() => navigate(`/invoices/${i.id}`)}>
                    <td className="muted tabular" style={{ width: 56 }}>#{i.number}</td>
                    <td>
                      <Link className="cell-link" to={`/invoices/${i.id}`} onClick={(e) => e.stopPropagation()}>{i.client?.display_name}</Link>
                      <div className="muted small">{i.subject}{i.kind !== "standard" ? ` · ${i.kind === "visits" ? "visits" : i.kind}` : ""}</div>
                    </td>
                    <td className={late ? "text-danger strong" : undefined}>{i.due_on ? formatDate(i.due_on) : <span className="muted">On receipt</span>}</td>
                    <td className="num">{formatMoney(i.total)}</td>
                    <td className="num strong">{formatMoney(i.balance_due)}</td>
                    <td><EntityStatus kind="invoice" status={i.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="list-foot">
            <span>{rows.length} {rows.length === 1 ? "invoice" : "invoices"} · {formatMoney(billed)} billed</span>
            <strong className="tabular" style={{ color: "var(--ink)" }}>{formatMoney(owed)} {filter === "written_off" ? "written off" : "owed"}</strong>
          </div>
        </div>
      )}
      {charging && <ChargeCardsDialog onClose={() => setCharging(false)} />}
      <NewInvoiceDialog open={params.get("new") === "1"} onClose={() => setParams({}, { replace: true })} onCreated={(id) => navigate(`/invoices/${id}`)} />
    </>
  );
}

/** An invoice that isn't tied to a job: a product sale, a one-time charge. */
function NewInvoiceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const settings = company.settings as { payment_terms_days?: number; default_tax_rate?: number };
  const [client, setClient] = useState<PickedClient>(null);
  const [subject, setSubject] = useState("");
  // Said under the client picker once Create is pressed without one.
  const [noClient, setNoClient] = useState(false);
  const create = useMutation({
    meta: { inline: true, success: "Draft invoice created", tone: "invoice" },
    mutationFn: async () => {
      const today = todayIn(company.timezone);
      return unwrap(
        await supabase()
          .from("invoices")
          .insert({
            company_id: company.id,
            client_id: client!.id,
            subject: subject.trim() || null,
            issued_on: today,
            due_on: addDaysIso(today, Number(settings.payment_terms_days ?? 30)),
            tax_rate: Number(settings.default_tax_rate ?? 0),
          })
          .select("id")
          .single(),
      ).id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["invoices", company.id] });
      onCreated(id);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New invoice"
      onExited={() => {
        setClient(null);
        setSubject("");
        setNoClient(false);
        create.reset();
      }}
    >
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (client) create.mutate(); else setNoClient(true); }}>
        <Field label="Client" error={noClient && !client ? "Choose who this invoice is for." : null}><ClientPicker value={client} onChange={setClient} /></Field>
        <Field label="Subject" optional><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Salt delivery, March services…" /></Field>
        <FormError error={create.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Create invoice</Button>
        </div>
      </form>
    </Dialog>
  );
}
