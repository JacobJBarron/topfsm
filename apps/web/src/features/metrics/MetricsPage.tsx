/**
 * Metrics: how the business is running beyond the money (quotes and lead sources, visits and
 * requests, the team's hours, and clients won and lapsed) over one date range. Money lives on
 * Finance. Owners and office staff with "Finance and metrics".
 */
import { breakPay, isUnpaidBreak } from "@crewtavo/core/breaks";
import { marketingOn } from "@crewtavo/core/marketing";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { NoAccess } from "@/components/ui/States";
import { StatusPill, statusText } from "@/components/ui/StatusPill";
import { supabase } from "@/lib/api";
import { formatDate, formatMoney, formatNumber, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { CATEGORY_LABELS } from "../field/fieldData";
import { leadSource } from "../marketing/website";
import { HBars, Kpi, KpiStrip, ReportCard, ReportTable, TrendChart } from "../finance/Charts";
import { bucketize, bucketsFor, hoursBetween, type Range } from "../finance/range";
import { fetchAll, hrs, memberName, pct, plural, RangeHeader, sum, TabBody, timeRates, useRangeParams, useTeam } from "../finance/shared";

const TABS = [
  { key: "sales", label: "Sales" },
  { key: "work", label: "Work" },
  { key: "team", label: "Team" },
  { key: "clients", label: "Clients" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function MetricsPage() {
  const session = useSession();
  const state = useRangeParams();
  const tab = (TABS.find((t) => t.key === state.params.get("tab"))?.key ?? "sales") as TabKey;
  if (!hasRole(session, "admin", "office") || !can(session, "reports")) return <NoAccess title="Metrics" />;
  const { range } = state;
  return (
    <>
      <RangeHeader title="Metrics" state={state} tabs={TABS} tab={tab} />
      <div key={tab} className="stack" style={{ gap: 28, animation: "page-in var(--dur-slow) var(--ease-out)" }} role="tabpanel">
        {tab === "sales" && <Sales range={range} />}
        {tab === "work" && <Work range={range} />}
        {tab === "team" && <Team range={range} />}
        {tab === "clients" && <Clients range={range} />}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Sales */

function Sales({ range }: { range: Range }) {
  const { company } = useSession();
  const cid = company.id;
  const team = useTeam();
  const query = useQuery({
    queryKey: ["metrics", cid, "sales", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [quotes, clients] = await Promise.all([
        fetchAll((a, b) => db.from("quotes").select("id, status, total, sent_at, approved_at, salesperson_id, created_by, lost_reason, client:clients(lead_source, requests(web_visit))").eq("company_id", cid).gte("sent_at", range.start).lt("sent_at", range.end).range(a, b)),
        fetchAll((a, b) => db.from("clients").select("id, lead_source, status, requests(web_visit)").eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end).range(a, b)),
      ]);
      return { quotes, clients };
    },
  });
  const buckets = bucketsFor(range);
  const nameOf = (id: string | null) => (id ? memberName(team.data?.find((m) => m.user_id === id)) : "Unassigned");
  return (
    <TabBody query={query}>
      {(d) => {
        const won = d.quotes.filter((q) => ["approved", "converted"].includes(q.status));
        const lost = d.quotes.filter((q) => q.status === "lost");
        const open = d.quotes.filter((q) => ["sent", "changes_requested"].includes(q.status));
        const approvalDays = won.filter((q) => q.approved_at && q.sent_at).map((q) => (Date.parse(q.approved_at!) - Date.parse(q.sent_at!)) / 86_400_000);
        const avgDays = approvalDays.length ? sum(approvalDays, (n) => n) / approvalDays.length : null;
        const people = new Map<string, { id: string; name: string; sent: number; won: number; value: number; sentValue: number }>();
        for (const q of d.quotes) {
          const id = q.salesperson_id ?? q.created_by ?? "none";
          const row = people.get(id) ?? { id, name: nameOf(id === "none" ? null : id), sent: 0, won: 0, value: 0, sentValue: 0 };
          row.sent++;
          row.sentValue += Number(q.total);
          if (["approved", "converted"].includes(q.status)) { row.won++; row.value += Number(q.total); }
          people.set(id, row);
        }
        const sources = new Map<string, { source: string; clients: number; quotes: number; won: number; value: number }>();
        // Website-form leads by where their visit came from, once the website counts visits ("Website form · Google").
        for (const c of d.clients) {
          const key = leadSource(c.lead_source, c.requests);
          const row = sources.get(key) ?? { source: key, clients: 0, quotes: 0, won: 0, value: 0 };
          row.clients++;
          sources.set(row.source, row);
        }
        for (const q of d.quotes) {
          const key = leadSource(q.client?.lead_source, q.client?.requests);
          const row = sources.get(key) ?? { source: key, clients: 0, quotes: 0, won: 0, value: 0 };
          row.quotes++;
          if (["approved", "converted"].includes(q.status)) { row.won++; row.value += Number(q.total); }
          sources.set(key, row);
        }
        const reasons = new Map<string, number>();
        for (const q of lost) reasons.set(q.lost_reason?.trim() || "No reason given", (reasons.get(q.lost_reason?.trim() || "No reason given") ?? 0) + 1);
        return (
          <>
            <KpiStrip label="Sales this period">
              <Kpi label="Quotes sent" value={formatNumber(d.quotes.length)} hint={formatMoney(sum(d.quotes, (q) => Number(q.total)))} />
              <Kpi label="Won" value={formatNumber(won.length)} hint={formatMoney(sum(won, (q) => Number(q.total)))} />
              <Kpi label="Conversion" value={pct(won.length, d.quotes.length)} hint={`${lost.length} ${statusText("quote", "lost").toLowerCase()} · ${open.length} ${statusText("quote", "sent").toLowerCase()}`} />
              <Kpi label="Average quote" value={d.quotes.length ? formatMoney(sum(d.quotes, (q) => Number(q.total)) / d.quotes.length) : "—"} />
              <Kpi label="Days to approval" value={avgDays === null ? "—" : formatNumber(avgDays, 1)} />
              <Kpi label={statusText("quote", "sent")} value={formatMoney(sum(open, (q) => Number(q.total)))} hint={<Link to="/pipeline">Open pipeline</Link>} />
            </KpiStrip>
            <div className="report-grid">
              <ReportCard title="Quoted value" value={formatMoney(sum(d.quotes, (q) => Number(q.total)))} footer={plural(d.quotes.length, "quote") + " sent"}>
                <TrendChart buckets={buckets} values={bucketize(d.quotes, buckets, (q) => q.sent_at, (q) => Number(q.total), company.timezone)} format={formatMoney} label="Quote value sent over time" color="var(--quote)" height={200} />
              </ReportCard>
              <ReportCard title="Why quotes were lost" subtitle={plural(lost.length, "lost quote")}>
                <HBars rows={[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ key: label, label, value, color: "var(--danger)" }))} format={(n) => formatNumber(n)} empty="No lost quotes in this period" />
              </ReportCard>
            </div>
            <ReportCard title="By salesperson">
              <ReportTable
                rows={[...people.values()]}
                rowKey={(r) => r.id}
                filename={`sales-by-person-${range.from}-to-${range.to}`}
                initialSort={{ key: "value", desc: true }}
                empty="No quotes sent in this period"
                columns={[
                  { key: "name", label: "Salesperson", value: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
                  { key: "sent", label: "Sent", num: true, value: (r) => r.sent },
                  { key: "won", label: "Won", num: true, value: (r) => r.won },
                  { key: "rate", label: "Conversion", num: true, value: (r) => (r.sent ? Math.round((r.won / r.sent) * 100) : 0), render: (r) => pct(r.won, r.sent) },
                  { key: "value", label: "Won value", num: true, value: (r) => r.value, render: (r) => formatMoney(r.value) },
                ]}
              />
            </ReportCard>
            <ReportCard title="Lead sources">
              <ReportTable
                rows={[...sources.values()]}
                rowKey={(r) => r.source}
                filename={`lead-sources-${range.from}-to-${range.to}`}
                initialSort={{ key: "value", desc: true }}
                empty="No new clients or quotes in this period"
                columns={[
                  { key: "source", label: "Source", value: (r) => r.source, render: (r) => <strong>{r.source}</strong> },
                  { key: "clients", label: "New clients", num: true, value: (r) => r.clients },
                  { key: "quotes", label: "Quotes sent", num: true, value: (r) => r.quotes },
                  { key: "won", label: "Won", num: true, value: (r) => r.won },
                  { key: "value", label: "Won value", num: true, value: (r) => r.value, render: (r) => formatMoney(r.value) },
                ]}
              />
            </ReportCard>
          </>
        );
      }}
    </TabBody>
  );
}

/* ------------------------------------------------------------------ Work */

function Work({ range }: { range: Range }) {
  const session = useSession();
  const { company } = session;
  const cid = company.id;
  const query = useQuery({
    queryKey: ["metrics", cid, "work", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [visits, requests, jobs] = await Promise.all([
        fetchAll((a, b) => db.from("visits").select("completed_at, kind").eq("company_id", cid).eq("status", "completed").gte("completed_at", range.start).lt("completed_at", range.end).range(a, b)),
        fetchAll((a, b) => db.from("requests").select("status, created_at").eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end).range(a, b)),
        db.from("jobs").select("id", { count: "exact", head: true }).eq("company_id", cid).in("status", ["requires_invoicing", "completed"]).gte("updated_at", range.start).lt("updated_at", range.end),
      ]);
      if (jobs.error) throw jobs.error;
      return { visits, requests, jobs: jobs.count ?? 0 };
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query}>
      {(d) => {
        const converted = d.requests.filter((r) => ["quoted", "converted"].includes(r.status)).length;
        const perDay = d.visits.length / range.days;
        return (
          <>
            <KpiStrip label="Work this period">
              <Kpi label="Visits completed" value={formatNumber(d.visits.length)} hint={perDay >= 1 ? `${formatNumber(perDay, 1)} per day` : `${formatNumber(perDay * 7, 1)} per week`} />
              <Kpi label="Requests received" value={formatNumber(d.requests.length)} hint={`${pct(converted, d.requests.length)} quoted or booked`} />
              <Kpi label="Jobs completed" value={formatNumber(d.jobs)} hint={can(session, "invoices") ? <Link to="/finance?tab=profit">Profit by job</Link> : undefined} />
            </KpiStrip>
            <div className="report-grid">
              <ReportCard title="Visits completed" value={formatNumber(d.visits.length)}>
                <TrendChart buckets={buckets} values={bucketize(d.visits, buckets, (v) => v.completed_at, () => 1, company.timezone)} format={(n) => formatNumber(n)} label="Visits completed over time" color="var(--job)" height={200} />
              </ReportCard>
              <ReportCard title="Requests received" value={formatNumber(d.requests.length)} footer={`${formatNumber(converted)} quoted or booked`}>
                <TrendChart buckets={buckets} values={bucketize(d.requests, buckets, (r) => r.created_at, () => 1, company.timezone)} format={(n) => formatNumber(n)} label="Requests received over time" color="var(--req)" height={200} />
              </ReportCard>
            </div>
          </>
        );
      }}
    </TabBody>
  );
}

/* ------------------------------------------------------------------ Team */

function Team({ range }: { range: Range }) {
  const session = useSession();
  const { company } = session;
  const cid = company.id;
  const team = useTeam();
  const query = useQuery({
    queryKey: ["metrics", cid, "team", range.from, range.to],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [rows, rates] = await Promise.all([
        fetchAll((a, b) => supabase().from("time_entries").select("id, user_id, started_at, ended_at, category, approved_at").eq("company_id", cid).gte("started_at", range.start).lt("started_at", range.end).range(a, b)),
        timeRates(can(session, "job_costs"), { from: range.start, to: range.end }),
      ]);
      // A running timer counts up to now. Breaks the company doesn't pay for aren't paid hours.
      const now = new Date().toISOString();
      const pay = breakPay(company.settings);
      return rows.map((e) => ({ ...e, labor_rate: rates[e.id] ?? null, running: !e.ended_at, ended_at: e.ended_at ?? now, paid: isUnpaidBreak(e, pay) ? 0 : hoursBetween(e.started_at, e.ended_at ?? now) }));
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query}>
      {(entries) => {
        const member = (id: string) => team.data?.find((m) => m.user_id === id);
        const people = new Map<string, { id: string; name: string; total: number; visit: number; drive: number; other: number; approved: number; cost: number; running: boolean }>();
        for (const e of entries) {
          const h = e.paid;
          const row = people.get(e.user_id) ?? { id: e.user_id, name: memberName(member(e.user_id)), total: 0, visit: 0, drive: 0, other: 0, approved: 0, cost: 0, running: false };
          row.total += h;
          if (e.category === "visit" || e.category === "assessment") row.visit += h;
          else if (e.category === "drive") row.drive += h;
          else row.other += h;
          if (e.approved_at) row.approved += h;
          if (e.running) row.running = true;
          row.cost += h * Number(e.labor_rate ?? member(e.user_id)?.labor_rate ?? 0);
          people.set(e.user_id, row);
        }
        const total = sum(entries, (e) => e.paid);
        const onVisits = sum(entries.filter((e) => e.category === "visit" || e.category === "assessment"), (e) => hoursBetween(e.started_at, e.ended_at));
        const pending = sum(entries.filter((e) => !e.approved_at && !e.running), (e) => e.paid);
        const categories = new Map<string, number>();
        for (const e of entries) categories.set(e.category, (categories.get(e.category) ?? 0) + hoursBetween(e.started_at, e.ended_at));
        return (
          <>
            <KpiStrip label="Team this period">
              <Kpi label="Paid hours" value={hrs(total)} hint={plural(people.size, "person", "people")} />
              <Kpi label="On visits" value={pct(onVisits, total)} hint={hrs(onVisits)} />
              {can(session, "job_costs") && <Kpi label="Labor cost" value={formatMoney(sum([...people.values()], (p) => p.cost))} />}
              <Kpi label="Awaiting approval" value={hrs(pending)} hint={pending ? <Link to="/timesheets">Review timesheets</Link> : "All caught up"} />
            </KpiStrip>
            <div className="report-grid">
              <ReportCard title="Hours worked" value={hrs(total)}>
                <TrendChart buckets={buckets} values={bucketize(entries, buckets, (e) => e.started_at, (e) => e.paid, company.timezone)} format={(n) => hrs(n)} label="Hours worked over time" color="var(--ink)" height={200} />
              </ReportCard>
              <ReportCard title="Where the time went">
                <HBars rows={[...categories].sort((a, b) => b[1] - a[1]).map(([c, value]) => ({ key: c, label: CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c, value }))} format={hrs} empty="No time tracked in this period" />
              </ReportCard>
            </div>
            <ReportCard title="By team member">
              <ReportTable
                rows={[...people.values()]}
                rowKey={(r) => r.id}
                filename={`hours-by-person-${range.from}-to-${range.to}`}
                initialSort={{ key: "total", desc: true }}
                empty="No time tracked in this period"
                columns={[
                  { key: "name", label: "Name", value: (r) => r.name, render: (r) => <span className="row" style={{ gap: 6 }}><strong>{r.name}</strong>{r.running && <StatusPill label="Clocked in" tone="good" />}</span> },
                  { key: "total", label: "Total", num: true, value: (r) => Math.round(r.total * 100) / 100, render: (r) => hrs(r.total) },
                  { key: "visit", label: "On visits", num: true, value: (r) => Math.round(r.visit * 100) / 100, render: (r) => hrs(r.visit) },
                  { key: "drive", label: "Driving", num: true, value: (r) => Math.round(r.drive * 100) / 100, render: (r) => hrs(r.drive) },
                  { key: "other", label: "Other", num: true, value: (r) => Math.round(r.other * 100) / 100, render: (r) => hrs(r.other) },
                  { key: "approved", label: "Approved", num: true, value: (r) => (r.total ? Math.round((r.approved / r.total) * 100) : 0), render: (r) => pct(r.approved, r.total) },
                  { key: "cost", label: "Labor cost", num: true, value: (r) => Math.round(r.cost * 100) / 100, render: (r) => formatMoney(r.cost) },
                ]}
              />
            </ReportCard>
          </>
        );
      }}
    </TabBody>
  );
}

/* ------------------------------------------------------------------ Clients */

function Clients({ range }: { range: Range }) {
  const session = useSession();
  const { company } = session;
  const cid = company.id;
  // Referrals made in the range, as Marketing → Referrals counts them: only with Marketing, and installed.
  const referrals = hasRole(session, "admin", "office") && can(session, "marketing") && marketingOn(company.settings);
  const query = useQuery({
    queryKey: ["metrics", cid, "clients", range.from, range.to, referrals],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const db = supabase();
      const [created, active, leads, jobs, referred] = await Promise.all([
        fetchAll((a, b) => db.from("clients").select("created_at, lead_source, requests(web_visit)").eq("company_id", cid).gte("created_at", range.start).lt("created_at", range.end).range(a, b)),
        db.from("clients").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "active"),
        db.from("clients").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "lead"),
        fetchAll((a, b) => db.from("jobs").select("status, updated_at, client:clients(id, display_name, status, email, marketing_opt_out)").eq("company_id", cid).neq("status", "archived").range(a, b)),
        referrals ? db.rpc("referral_stats", { p_company: cid, p_from: range.start, p_to: range.end }) : Promise.resolve({ data: null, error: null }),
      ]);
      for (const r of [active, leads, referred]) if (r.error) throw r.error;
      // Lapsed: past work, nothing active, nothing touched in a year.
      const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();
      const byClient = new Map<string, { id: string; name: string; email: string | null; optOut: boolean; last: string; active: boolean }>();
      for (const j of jobs) {
        if (!j.client || j.client.status === "archived") continue;
        const row = byClient.get(j.client.id) ?? { id: j.client.id, name: j.client.display_name, email: j.client.email, optOut: Boolean(j.client.marketing_opt_out), last: j.updated_at, active: false };
        if (j.updated_at > row.last) row.last = j.updated_at;
        if (j.status === "active") row.active = true;
        byClient.set(j.client.id, row);
      }
      const lapsed = [...byClient.values()].filter((c) => !c.active && c.last < yearAgo);
      const stats = referred.data as { leads: number; won: number; revenue: number | null } | null;
      return { created, active: active.count ?? 0, leads: leads.count ?? 0, lapsed, referred: stats };
    },
  });
  const buckets = bucketsFor(range);
  return (
    <TabBody query={query}>
      {(d) => {
        const sources = new Map<string, number>();
        for (const c of d.created) sources.set(leadSource(c.lead_source, c.requests), (sources.get(leadSource(c.lead_source, c.requests)) ?? 0) + 1);
        return (
          <>
            <KpiStrip label="Clients">
              <Kpi label="New clients" value={formatNumber(d.created.length)} hint={`${formatNumber((d.created.length / range.days) * 30, 1)} per month`} />
              <Kpi label="Active clients" value={formatNumber(d.active)} />
              <Kpi label="Leads" value={formatNumber(d.leads)} hint={<Link to="/clients?status=lead">View leads</Link>} />
              <Kpi label="No work in 12+ months" value={formatNumber(d.lapsed.length)} />
              {d.referred && (
                <Kpi
                  label="Referrals"
                  value={formatNumber(d.referred.leads)}
                  hint={<>{[`${formatNumber(d.referred.won)} won`, d.referred.revenue === null ? null : formatMoney(d.referred.revenue)].filter(Boolean).join(" · ")} · <Link to="/marketing?tab=referrals">View referrals</Link></>}
                />
              )}
            </KpiStrip>
            <div className="report-grid">
              <ReportCard title="New clients" value={formatNumber(d.created.length)}>
                <TrendChart buckets={buckets} values={bucketize(d.created, buckets, (c) => c.created_at, () => 1, company.timezone)} format={(n) => formatNumber(n)} label="New clients over time" color="var(--req)" height={200} />
              </ReportCard>
              <ReportCard title="How they found you">
                <HBars rows={[...sources].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, value]) => ({ key: label, label, value }))} format={(n) => formatNumber(n)} empty="No new clients in this period" />
              </ReportCard>
            </div>
            <ReportCard
              title="No work in 12+ months"
              action={d.lapsed.length > 0 && marketingOn(company.settings) && <Link to="/marketing" className="btn btn-ghost btn-sm"><Icon name="marketing" size={14} />Start a campaign</Link>}
            >
              <ReportTable
                rows={d.lapsed}
                rowKey={(r) => r.id}
                filename={`win-back-${todayIn(company.timezone)}`}
                initialSort={{ key: "last", desc: true }}
                empty="No clients to win back"
                columns={[
                  { key: "name", label: "Client", value: (r) => r.name, render: (r) => <Link className="cell-link" to={`/clients/${r.id}`}>{r.name}</Link> },
                  { key: "email", label: "Email", value: (r) => r.email ?? "", render: (r) => r.email ? <span className="row" style={{ gap: 6 }}>{r.email}{r.optOut && <StatusPill label="Unsubscribed" />}</span> : <span className="muted">—</span> },
                  { key: "last", label: "Last activity", value: (r) => r.last.slice(0, 10), render: (r) => formatDate(r.last) },
                ]}
              />
            </ReportCard>
          </>
        );
      }}
    </TabBody>
  );
}
