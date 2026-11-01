import { visitPrice } from "@crewtavo/core/promos";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { formatDate, formatMoney, todayIn } from "@/lib/format";
import { titleOrClientFilter, useStatusCounts } from "@/lib/listing";
import { can, hasRole, useSession } from "@/lib/session";
import { NewJobDialog } from "./JobDialogs";

const FILTERS = [
  { key: "active", label: "Active", statuses: ["active"] },
  { key: "invoice", label: "Requires invoicing", statuses: ["requires_invoicing"] },
  { key: "completed", label: "Completed", statuses: ["completed"] },
  { key: "archived", label: "Archived", statuses: ["archived"] },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

/** What an empty filter says, in the filter's own words. */
const EMPTY_TITLES: Record<FilterKey, string> = { active: "No active jobs", invoice: "No jobs to invoice", completed: "No completed jobs", archived: "No archived jobs" };

export function JobsPage() {
  const session = useSession();
  const { company } = session;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>(() => (FILTERS.find((x) => x.key === params.get("status"))?.key as FilterKey | undefined) ?? "active");
  const [kind, setKind] = useState<"" | "one_off" | "recurring">("");
  const [search, setSearch] = useState("");
  const term = useDeferredValue(searchTerm(search));
  const statuses = FILTERS.find((f) => f.key === filter)!.statuses;
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  const counts = useStatusCounts("jobs", company.id, Object.fromEntries(FILTERS.map((f) => [f.key, f.statuses])));
  const today = todayIn(company.timezone);

  const jobs = useQuery({
    queryKey: ["jobs", company.id, filter, kind, term],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase()
        .from("jobs")
        .select("id, number, title, status, kind, financials:job_financials(contract_total), lines:job_line_items(quantity, unit_price, discount_billing), client:clients(display_name), property:properties(line1, city), visits(id, status, scheduled_on)")
        .eq("company_id", company.id)
        .in("status", [...statuses])
        .order("created_at", { ascending: false })
        .limit(200);
      if (kind) q = q.eq("kind", kind);
      if (term) q = /^\d+$/.test(term) ? q.eq("number", Number(term)) : q.or(await titleOrClientFilter(company.id, term));
      return unwrap(await q);
    },
  });

  if (jobs.isPending) return <ListPageSkeleton columns={5} tabs={4} />;
  const rows = jobs.data ?? [];

  return (
    <>
      <PageHeader title="Jobs" actions={canSell && <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" }, { replace: true })}>New job</Button>} />
      <div className="toolbar">
        <div className="input-group">
          <span className="addon"><Icon name="search" size={16} /></span>
          <input className="input" type="search" placeholder="Search by title, client or #number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search jobs" />
        </div>
        <div className="tabs" role="group" aria-label="Filter jobs">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {counts.data && <span className="badge">{counts.data[f.key]}</span>}
            </button>
          ))}
        </div>
        <select className="select" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Job type">
          <option value="">One-off and recurring</option>
          <option value="one_off">One-off only</option>
          <option value="recurring">Recurring only</option>
        </select>
      </div>
      {jobs.error && !jobs.data ? (
        <div className="card"><ErrorState error={jobs.error} onRetry={() => jobs.refetch()} /></div>
      ) : rows.length === 0 ? (
        <div className="card">
          {term || kind ? (
            <EmptyState icon="search" title="No jobs match" action={<Button onClick={() => { setSearch(""); setKind(""); }}>Clear filters</Button>} />
          ) : (
            // New job is the page header's green button, so the empty state points to quotes instead of repeating it.
            <EmptyState icon="job" title={EMPTY_TITLES[filter]} action={canSell && filter === "active" && <Link className="btn" to="/quotes">Go to quotes</Link>}>
              {filter !== "active" ? null : canSell ? "Jobs come from approved quotes. For work that doesn't need one, create the job directly with New job." : "Jobs come from approved quotes."}
            </EmptyState>
          )}
        </div>
      ) : (
        <div className={`card${jobs.isPlaceholderData ? " is-stale" : ""}`}>
          <table className="table table-stack">
            <thead><tr><th>#</th><th>Job</th><th>Next visit</th>{canSell && <th className="num">Value</th>}<th>Status</th></tr></thead>
            <tbody>
              {rows.map((j) => {
                const open = j.visits.filter((v) => !["completed", "cancelled"].includes(v.status));
                const next = open.filter((v) => v.scheduled_on && v.scheduled_on >= today).sort((a, b) => a.scheduled_on!.localeCompare(b.scheduled_on!))[0];
                const late = open.filter((v) => v.scheduled_on && v.scheduled_on < today).length;
                const done = j.visits.filter((v) => v.status === "completed").length;
                return (
                  <tr key={j.id} className="row-link" onClick={() => navigate(`/jobs/${j.id}`)}>
                    <td className="muted tabular" style={{ width: 56 }}>#{j.number}</td>
                    <td>
                      <Link className="cell-link" to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>{j.title}</Link>
                      <div className="muted small">{j.client?.display_name}{j.property ? ` · ${j.property.line1}` : ""}</div>
                    </td>
                    <td>
                      {next?.scheduled_on ? formatDate(next.scheduled_on) : <span className="muted">—</span>}
                      <div className="small">
                        <span className="muted">{done}/{j.visits.length} done{j.kind === "recurring" ? " · recurring" : ""}</span>
                        {late > 0 && <span className="text-danger strong"> · {late} overdue</span>}
                      </div>
                    </td>
                    {/* A visit's price: a once-per-job promo code comes off the first invoice only, not every visit. */}
                    {canSell && <td className="num">{j.kind === "recurring" ? <span className="muted small">{formatMoney(visitPrice(j.financials?.contract_total, j.lines))}/visit</span> : formatMoney(j.financials?.contract_total ?? 0)}</td>}
                    <td><EntityStatus kind="job" status={j.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="list-foot"><span>{rows.length} {rows.length === 1 ? "job" : "jobs"}</span></div>
        </div>
      )}
      <NewJobDialog open={params.get("new") === "1"} onClose={() => setParams({}, { replace: true })} onCreated={(id) => navigate(`/jobs/${id}`)} />
    </>
  );
}
