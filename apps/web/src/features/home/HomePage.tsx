import { dueSummary } from "@crewtavo/core/equipment";
import { addDays, zonedTimeToUtc } from "@crewtavo/core/time";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatedNumber, MONEY } from "@/components/ui/AnimatedNumber";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill, statusLabel, statusText, visitTone } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { formatMoney, formatMoneyCompact, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { monthToDate } from "@/lib/trends";
import { managesEquipment, useEquipmentDue } from "../equipment/equipmentData";
import { Change } from "../finance/change";
import { seesWebsite } from "../marketing/website";
import { InstallAppCard } from "../field/InstallAppCard";
import styles from "./Home.module.css";
import { SetupCard } from "./SetupCard";
import type { Dashboard } from "./types";
import { WebsiteCard } from "./WebsiteCard";
import { collectedByWeek, type Week } from "./weeks";
import { WorkflowStrip } from "./WorkflowStrip";

function greeting(timeZone: string) {
  const h = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

const ATTENTION_ICON: Record<string, IconName> = { quote: "quote", visit: "cloud", invoice: "invoice", equipment: "truck", autopay_failed: "card", autopay_approval: "card" };

/**
 * Each kind's tint in Needs attention: money that didn't come in (a late invoice, an automatic charge
 * that failed) in red; things to see to soon (machines coming due, a charge waiting for your OK) in amber.
 */
const ATTENTION_TINT: Record<string, { background: string; color: string }> = {
  invoice: { background: "var(--danger-tint)", color: "var(--danger)" },
  autopay_failed: { background: "var(--danger-tint)", color: "var(--danger)" },
  equipment: { background: "var(--warning-tint)", color: "var(--warning)" },
  autopay_approval: { background: "var(--warning-tint)", color: "var(--warning)" },
};
const ATTENTION_PLAIN = { background: "var(--fill-2)", color: "var(--text-2)" };

/** Weeks of bars under the collected figure; fewer weeks of money than this and it's the figure alone. */
const WEEKS = 6;
const MIN_WEEKS = 4;

export function HomePage() {
  const session = useSession();
  const navigate = useNavigate();
  const tz = session.company.timezone;
  const isOffice = hasRole(session, "admin", "office", "estimator");
  const seesMoney = hasRole(session, "admin", "office") && can(session, "invoices");
  useDocumentTitle("Home");
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["dashboard", session.company.id],
    queryFn: () => api.get<Dashboard>("/dashboard"),
    refetchInterval: 60_000,
  });
  const collected = useCollectedHistory(seesMoney);
  const page = useRef<HTMLDivElement>(null);
  useFirstArrival(page, Boolean(data));
  // Things handled elsewhere leave the list as it refreshes.
  const attentionRows = useListAnimation<HTMLDivElement>();
  // Equipment overdue or coming due joins the list for the people who look after it.
  const gear = useEquipmentDue(session.company.id, { enabled: managesEquipment(session) });
  const attention = useMemo(() => {
    const worst = new Map<string, NonNullable<typeof gear.data>[number]>();
    for (const row of gear.data ?? []) if (row.equipment_status === "active" && row.state !== "ok" && !worst.has(row.equipment_id)) worst.set(row.equipment_id, row);
    const rows = [...worst.values()];
    const items: Dashboard["attention"] = rows.slice(0, 3).map((r) => ({
      kind: "equipment",
      title: `${r.name} ${r.state === "overdue" ? "overdue" : "coming due"}`,
      detail: `${r.equipment_name} · ${dueSummary(r)}`,
      link: `/equipment/${r.equipment_id}`,
    }));
    if (rows.length > 3) items.push({ kind: "equipment", title: `${rows.length - 3} more machines need maintenance`, detail: null, link: "/equipment?show=due" });
    return [...(data?.attention ?? []), ...items];
  }, [data?.attention, gear.data]);
  const firstName = session.profile.full_name.split(" ")[0] || "there";
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });

  return (
    <>
      <div className="row-between wrap" style={{ alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>{today}</div>
          <h1 style={{ marginTop: 6, fontSize: 32, fontWeight: 800, letterSpacing: "var(--tracking-display)", lineHeight: 1.1 }}>
            {greeting(tz)}, {firstName}
          </h1>
        </div>
        {isOffice && (
          <div className="page-actions">
            <Link className="btn" to="/requests?new=1"><Icon name="requests" size={16} />New request</Link>
            <Link className="btn btn-primary" to="/quotes?new=1"><Icon name="plus" size={16} />New quote</Link>
          </div>
        )}
      </div>

      {/* The crew's phones: Crewtavo as an app. The office isn't asked here (Settings has it). */}
      {!isOffice && <InstallAppCard />}

      {isPending && <HomeSkeleton office={isOffice} />}
      {error && <div className="card"><ErrorState error={error} onRetry={() => refetch()} title="Couldn't load your dashboard" /></div>}

      {data && (
        <div ref={page} className="stack" style={{ gap: 28 }}>
          {isOffice && <WorkflowStrip workflow={data.workflow} showInvoices={seesMoney} />}

          <div className="two-col">
            <section className="wide stack" aria-labelledby="today-title">
              <div className="section-head">
                <h2 id="today-title" className="section-title">Today's appointments</h2>
                <Link className="btn btn-sm" to={isOffice ? "/schedule" : "/field"}>{isOffice ? "View schedule" : "My day"}</Link>
              </div>
              <div className="card">
                {data.today.total > 0 && (
                  <div className="card-pad stack-sm" style={{ paddingBottom: 14 }}>
                    <div className="row-between">
                      <span className="muted text-sm">
                        <strong style={{ color: "var(--ink)" }}>{data.today.by_status.completed ?? 0}</strong> of {data.today.total} complete
                        {data.today.by_status.in_progress ? ` · ${data.today.by_status.in_progress} ${statusText("visit", "in_progress").toLowerCase()}` : ""}
                      </span>
                    </div>
                    <div className="progress" aria-hidden="true"><span style={{ width: `${((data.today.by_status.completed ?? 0) / data.today.total) * 100}%` }} /></div>
                  </div>
                )}
                {data.today.visits.length === 0 ? (
                  <EmptyState inline title="Nothing on the schedule today" action={isOffice ? <Link className="btn" to="/schedule?new=1">Schedule a visit</Link> : undefined} />
                ) : (
                  data.today.visits.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className="card-row"
                      onClick={() => navigate(isOffice && v.job_id ? `/jobs/${v.job_id}` : `/field/visits/${v.id}`)}
                    >
                      <span style={{ width: 4, alignSelf: "stretch", borderRadius: "var(--radius-sm)", background: v.crew_color || "var(--fill-3)" }} aria-hidden="true" />
                      <span className="tabular" style={{ width: 76, fontWeight: 700, fontSize: 13 }}>{v.starts_at ? time(v.starts_at) : "Anytime"}</span>
                      <span className="grow">
                        <span className="strong ellipsis" style={{ display: "block" }}>{v.title}</span>
                        <span className="muted small ellipsis" style={{ display: "block" }}>
                          {[v.client, v.address, v.crew].filter(Boolean).join(" · ") || statusLabel(v.kind)}
                        </span>
                        {v.hold_reason && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>Weather: {v.hold_reason.split(";")[0]}</span>}
                      </span>
                      <StatusPill label={statusText("visit", v.status)} tone={visitTone(v.status)} />
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="narrow stack" aria-labelledby="perf-title">
              <h2 id="perf-title" className="section-title">{seesMoney ? "Business performance" : "Needs attention"}</h2>
              {seesMoney && (
                <div className="card card-pad stack-sm">
                  <div className="muted small strong">Collected this month</div>
                  <div className="row" style={{ alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                    <AnimatedNumber value={data.month.collected} format={MONEY} className="hero-number" />
                    {collected.data && <Change now={data.month.collected} before={collected.data.sameDaysLastMonth} compared="the same days last month" same="Same as last month" />}
                  </div>
                  {collected.data && collected.data.weeks.length >= MIN_WEEKS && <WeekBars weeks={collected.data.weeks} />}
                  <div className="row-between small muted"><span>Invoiced this month</span><AnimatedNumber value={data.month.invoiced} format={MONEY} className="strong ink" /></div>
                  <div className="row-between small muted"><span>Quotes won ({data.month.won_count})</span><AnimatedNumber value={data.month.won} format={MONEY} className="strong ink" /></div>
                </div>
              )}
              {seesMoney && (
                <div className="card">
                  <div className="card-pad" style={{ paddingBottom: 8 }}>
                    <div className="row-between">
                      <strong>Receivables</strong>
                      <Link to="/invoices" className="small strong">All invoices</Link>
                    </div>
                    <div className="muted small" style={{ marginTop: 10 }}>{data.receivables.clients_owing} {data.receivables.clients_owing === 1 ? "client owes" : "clients owe"} you</div>
                    <AnimatedNumber value={data.receivables.total} format={MONEY} className="hero-number" />
                  </div>
                  {data.receivables.top.map((row) => (
                    <Link key={row.client_id} to={`/clients/${row.client_id}`} className="card-row" style={{ padding: "10px 20px", fontSize: 13 }}>
                      <span className="grow ellipsis">{row.client}</span>
                      <span className="tabular strong">{formatMoneyCompact(row.owed)}</span>
                    </Link>
                  ))}
                </div>
              )}
              {seesWebsite(session) && <WebsiteCard />}
              <div className="card" ref={attentionRows}>
                <div className="card-head"><strong>Needs attention</strong>{attention.length > 0 && <span className="badge">{attention.length}</span>}</div>
                {attention.length === 0 ? (
                  <EmptyState inline title="All clear" />
                ) : (
                  attention.map((item, i) => (
                    <Link key={`${item.link}-${i}`} to={item.link} className="card-row">
                      <span className="n-icon" style={{ width: 32, height: 32, borderRadius: "var(--radius-control)", display: "grid", placeItems: "center", ...(ATTENTION_TINT[item.kind] ?? ATTENTION_PLAIN), flex: "none" }}>
                        <Icon name={ATTENTION_ICON[item.kind] ?? "alert"} size={16} />
                      </span>
                      <span className="grow">
                        <span className="strong text-sm" style={{ display: "block" }}>{item.title}</span>
                        {item.detail && <span className="muted small ellipsis" style={{ display: "block" }}>{item.detail}</span>}
                      </span>
                      <Icon name="chevronRight" size={16} />
                    </Link>
                  ))
                )}
              </div>
              {/* Last in the rail, so it never pushes the day's work down. */}
              <SetupCard />
            </section>
          </div>
        </div>
      )}
    </>
  );
}

/** Home's tiles and cards have risen into place once this session, so later visits and refreshes don't repeat it. */
let arrived = false;

/**
 * The first time Home loads in a session, its workflow tiles and cards fade and rise 6px into place,
 * 30ms apart, in page order (only fade with Reduce Motion). Never on a refresh or on coming back.
 */
function useFirstArrival(ref: RefObject<HTMLElement | null>, ready: boolean) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!ready || arrived || !root) return;
    arrived = true;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frames = still ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }];
    // A card inside another card (or a tile's own parts) moves with it.
    const items = [...root.querySelectorAll<HTMLElement>("[data-rise], .card")].filter((el) => !el.parentElement?.closest("[data-rise], .card"));
    // --dur-enter and --ease-enter.
    items.forEach((el, i) => el.animate?.(frames, { duration: 300, delay: i * 30, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "backwards" }));
  }, [ref, ready]);
}

/**
 * Payments since the earlier of the 1st of last month and the start of the bars' first week: this
 * month so far against the same days of last month, and the weeks for the bars.
 */
function useCollectedHistory(enabled: boolean) {
  const { company } = useSession();
  const tz = company.timezone;
  const today = todayIn(tz);
  return useQuery({
    queryKey: ["dashboard", company.id, "collected", today],
    enabled,
    refetchInterval: 60_000,
    meta: { silent: true },
    queryFn: async () => {
      const [y, m] = today.split("-").map(Number) as [number, number];
      const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      const firstWeek = addDays(today, -7 * WEEKS);
      const since = lastMonth < firstWeek ? lastMonth : firstWeek;
      const rows = unwrap(await supabase().from("payments").select("amount, received_at").eq("company_id", company.id).gte("received_at", zonedTimeToUtc(since, "00:00", tz).toISOString()).limit(5000));
      const month = monthToDate(rows, today, tz);
      return { sameDaysLastMonth: month[Number(today.slice(8)) - 1]?.before ?? 0, weeks: collectedByWeek(rows, today, tz, WEEKS) };
    },
  });
}

/** A bar a week, its date under it; the latest week's amount over its bar, another week's on hover. */
function WeekBars({ weeks }: { weeks: Week[] }) {
  const max = Math.max(0, ...weeks.map((w) => w.total));
  const said = weeks.map((w, i) => `${i === weeks.length - 1 ? "this week so far" : `week of ${w.label}`} ${formatMoney(w.total)}`).join(", ");
  return (
    <figure className={styles.bars} role="img" aria-label={`Collected by week: ${said}`}>
      {weeks.map((w, i) => (
        <div key={w.from} className={styles.week} data-latest={i === weeks.length - 1 || undefined} aria-hidden="true">
          <span className={styles.track}>
            <span className={styles.amount}>{formatMoneyCompact(w.total)}</span>
            <span className={styles.bar} style={{ ["--h" as string]: max > 0 ? Math.max(0, w.total) / max : 0 }} />
          </span>
          <span className={styles.label}>{w.label}</span>
        </div>
      ))}
    </figure>
  );
}

function HomeSkeleton({ office }: { office: boolean }) {
  return (
    <Loading label="Loading your day">
      <div className="stack-lg">
        {office && (
          <div className="stack">
            <Skeleton width={120} height={20} />
            <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 24, padding: 24 }}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="stack-sm">
                  <Skeleton width={90} height={12} />
                  <Skeleton width={60} height={30} />
                  <Skeleton width="70%" height={12} />
                  <Skeleton width="85%" height={10} />
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="two-col">
          <div className="wide stack">
            <Skeleton width={220} height={20} />
            <div className="card">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="card-row">
                  <Skeleton width={60} height={12} />
                  <span className="grow stack-sm"><Skeleton width="55%" height={13} /><Skeleton width="35%" height={10} /></span>
                  <Skeleton width={84} height={22} radius={999} />
                </div>
              ))}
            </div>
          </div>
          <div className="narrow stack">
            <Skeleton width={200} height={20} />
            <CardSkeleton lines={3} />
            <CardSkeleton lines={4} />
          </div>
        </div>
      </div>
    </Loading>
  );
}
