/** Automation rules (turn them on and off, edit, duplicate) and the history of what they did. */
import { describeRuleSentence, TRIGGERS, triggerDef, type Action, type Condition } from "@crewtavo/core/automations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, StatsSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";

export interface RuleRow {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  delay_minutes: number;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
  run_count: number;
  last_run_at: string | null;
  template_key: string | null;
}

export const RUN_TONES: Record<string, Tone> = { done: "good", failed: "danger", skipped: "muted", pending: "info", running: "info", cancelled: "muted" };
export const RUN_LABELS: Record<string, string> = { done: "Done", failed: "Failed", skipped: "Skipped", pending: "Waiting", running: "Running", cancelled: "Cancelled" };

export function AutomationsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"rules" | "activity">("rules");
  const canEdit = hasRole(session, "admin", "office") && can(session, "automations");

  const rules = useQuery({
    queryKey: ["automation-rules", session.company.id],
    queryFn: async () =>
      (unwrap(await supabase().from("automation_rules").select("id, name, description, trigger, delay_minutes, conditions, actions, enabled, run_count, last_run_at, template_key").eq("company_id", session.company.id).order("created_at")) as unknown as RuleRow[])
        // In workflow order (requests, quotes, jobs, visits, invoices), then by name.
        .sort((a, b) => TRIGGERS.findIndex((t) => t.verb === a.trigger) - TRIGGERS.findIndex((t) => t.verb === b.trigger) || a.name.localeCompare(b.name)),
  });
  const stats = useQuery({
    queryKey: ["automation-stats", session.company.id],
    meta: { silent: true },
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const count = async (status?: string) => {
        let q = supabase().from("automation_runs").select("id", { count: "exact", head: true }).eq("company_id", session.company.id);
        q = status === "pending" ? q.eq("status", "pending") : q.gte("created_at", since);
        if (status && status !== "pending") q = q.eq("status", status);
        return (await q).count ?? 0;
      };
      const [done, failed, waiting] = await Promise.all([count("done"), count("failed"), count("pending")]);
      return { done, failed, waiting };
    },
  });

  if (!canEdit) return <NoAccess title="Automations" />;

  const active = rules.data?.filter((r) => r.enabled).length ?? 0;
  const usesEmail = rules.data?.some((r) => r.enabled && r.actions.some((a) => a.type === "send_email" || a.type === "request_review"));
  const usesSms = rules.data?.some((r) => r.enabled && r.actions.some((a) => a.type === "send_sms" || (a.type === "request_review" && a.channel !== "email")));

  return (
    <>
      <BackLink to="/settings">Settings</BackLink>
      <PageHeader title="Automations" actions={<Button variant="primary" icon="plus" onClick={() => navigate("/automations/new")}>New rule</Button>} />

      {(usesEmail && !session.config.features.email) || (usesSms && !session.config.features.sms) ? (
        <div className="callout callout-warning">
          <Icon name="alert" size={20} />
          <div className="grow">
            <div>{usesEmail && !session.config.features.email ? "Email isn't connected" : "Texting isn't set up on this server"}</div>
            <div className="small" style={{ fontWeight: 400 }}>Rules that send {usesEmail && !session.config.features.email ? "emails" : "texts"} will show as failed until it is. Notifications, tags and tasks still work.{usesEmail && !session.config.features.email && <ConnectEmailHint />}</div>
          </div>
        </div>
      ) : null}

      {stats.isPending || rules.isPending ? (
        <StatsSkeleton count={4} />
      ) : (
        <div className="stat-row">
          <div className="card stat"><div className="label">Active rules</div><div className="value">{active}</div><div className="hint">of {rules.data?.length ?? 0}</div></div>
          <div className="card stat"><div className="label">Done in the last 7 days</div><div className="value">{stats.data?.done ?? 0}</div></div>
          <div className="card stat"><div className="label">Waiting to run</div><div className="value">{stats.data?.waiting ?? 0}</div><div className="hint">delayed follow-ups</div></div>
          <button type="button" className="card stat card-link" style={{ textAlign: "left", background: "var(--surface)", font: "inherit" }} onClick={() => setTab("activity")}>
            <div className="label">Failed in the last 7 days</div>
            <div className="value" style={{ color: stats.data?.failed ? "var(--danger)" : undefined }}>{stats.data?.failed ?? 0}</div>
            <div className="hint">{stats.data?.failed ? "Review and retry" : "All good"}</div>
          </button>
        </div>
      )}

      <div className="underline-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "rules"} onClick={() => setTab("rules")}>Rules <span className="badge">{rules.data?.length ?? "·"}</span></button>
        <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Activity</button>
      </div>

      {tab === "rules" ? <RuleList rules={rules} /> : <RunHistory />}
    </>
  );
}

function RuleList({ rules }: { rules: ReturnType<typeof useQuery<RuleRow[]>> }) {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const key = ["automation-rules", session.company.id];
  const toggle = useMutation({
    meta: { success: (_: unknown, v: { enabled: boolean }) => (v.enabled ? "Rule turned on" : "Rule turned off") },
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => unwrap(await supabase().from("automation_rules").update({ enabled }).eq("id", id)),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<RuleRow[]>(key);
      queryClient.setQueryData<RuleRow[]>(key, (old) => old?.map((r) => (r.id === id ? { ...r, enabled } : r)));
      return { previous };
    },
    onError: (_e, _v, context) => context?.previous && queryClient.setQueryData(key, context.previous),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const duplicate = useMutation({
    mutationFn: async (r: RuleRow) =>
      unwrap(
        await supabase()
          .from("automation_rules")
          .insert({ company_id: session.company.id, name: `${r.name} (copy)`.slice(0, 120), description: r.description, trigger: r.trigger, delay_minutes: r.delay_minutes, conditions: r.conditions as never, actions: r.actions as never, enabled: false })
          .select("id")
          .single(),
      ),
    onSuccess: (row) => {
      toast.success("Rule copied", { description: "It's off until you turn it on." });
      navigate(`/automations/${row.id}`);
    },
  });
  const list = useListAnimation<HTMLDivElement>();
  const remove = useMutation({
    meta: { success: "Rule deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("automation_rules").delete().eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (rules.isPending) return <Loading><div className="stack">{[0, 1, 2, 3].map((i) => <CardSkeleton key={i} lines={2} />)}</div></Loading>;
  if (rules.error) return <div className="card"><ErrorState error={rules.error} onRetry={() => rules.refetch()} /></div>;
  if (!rules.data?.length) {
    return (
      <div className="card">
        <EmptyState icon="bolt" title="No rules yet" action={<Button icon="plus" onClick={() => navigate("/automations/new")}>Create a rule</Button>} />
      </div>
    );
  }
  return (
    <div className="stack" ref={list}>
      {rules.data.map((r) => {
        const trigger = triggerDef(r.trigger);
        return (
          <div key={r.id} className="card card-pad row" style={{ alignItems: "flex-start", gap: 14, opacity: r.enabled ? 1 : 0.75, transition: "opacity 200ms" }}>
            <input type="checkbox" className="switch" style={{ marginTop: 3 }} checked={r.enabled} aria-label={r.enabled ? `Turn off ${r.name}` : `Turn on ${r.name}`} onChange={(e) => toggle.mutate({ id: r.id, enabled: e.target.checked })} />
            <Link to={`/automations/${r.id}`} className="grow" style={{ color: "inherit", minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <strong style={{ fontSize: 16 }}>{r.name}</strong>
                {trigger && <span className="chip">{trigger.group}</span>}
                {!r.enabled && <span className="chip">Off</span>}
              </div>
              <div className="muted text-sm" style={{ marginTop: 2 }}>{describeRuleSentence(r)}</div>
              <div className="muted small" style={{ marginTop: 6 }}>{r.last_run_at ? `Ran ${r.run_count} ${r.run_count === 1 ? "time" : "times"} · last ${timeAgo(r.last_run_at)}` : "Hasn't run yet"}</div>
            </Link>
            <Menu
              triggerClassName="btn btn-sm btn-ghost btn-icon"
              label={`Actions for ${r.name}`}
              items={[
                { label: "Edit", icon: "edit", onSelect: () => navigate(`/automations/${r.id}`) },
                { label: "Duplicate", icon: "copy", onSelect: () => duplicate.mutate(r) },
                { separator: true },
                { label: "Delete", icon: "trash", danger: true, onSelect: async () => (await confirm({ title: `Delete “${r.name}”?`, body: "Follow-ups it has waiting are cancelled. Its history is deleted.", confirmLabel: "Delete rule", danger: true })) && remove.mutate(r.id) },
              ]}
            />
          </div>
        );
      })}
    </div>
  );
}

const SUBJECT_PATH: Record<string, string> = { client: "/clients/", request: "/requests/", quote: "/quotes/", job: "/jobs/", invoice: "/invoices/" };
type RunFilter = "all" | "failed" | "pending" | "skipped";
const RUN_FILTERS: Array<{ value: RunFilter; label: string; empty: string }> = [
  { value: "all", label: "All", empty: "Nothing has run yet" },
  { value: "failed", label: "Failed", empty: "No failures" },
  { value: "pending", label: "Waiting", empty: "Nothing waiting" },
  { value: "skipped", label: "Skipped", empty: "Nothing skipped" },
];

export function RunHistory({ ruleId }: { ruleId?: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<RunFilter>("all");
  const key = ["automation-runs", session.company.id, ruleId ?? "all", filter];
  const runs = useQuery({
    queryKey: key,
    refetchInterval: 15_000,
    queryFn: async () => {
      let q = supabase()
        .from("automation_runs")
        .select("id, status, subject_type, subject_id, run_after, created_at, finished_at, error, result, rule:automation_rules(id, name)")
        .eq("company_id", session.company.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (ruleId) q = q.eq("rule_id", ruleId);
      if (filter !== "all") q = q.eq("status", filter);
      return unwrap(await q);
    },
  });
  const act = useMutation({
    meta: { success: (_: unknown, v: { action: string }) => (v.action === "retry" ? "Running it again" : "Cancelled") },
    mutationFn: ({ id, action }: { id: number; action: "retry" | "cancel" }) => api.post(`/automations/runs/${id}/${action}`),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["automation-runs"] });
      queryClient.invalidateQueries({ queryKey: ["automation-stats"] });
    },
  });

  return (
    <div className="stack">
      <div className="tabs" role="group" aria-label="Filter runs">
        {RUN_FILTERS.map((f) => <button key={f.value} type="button" className="tab" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</button>)}
      </div>
      <div className="card">
        {runs.isPending && <div className="card-pad"><CardSkeleton lines={3} title={false} /></div>}
        {runs.error && <ErrorState compact error={runs.error} onRetry={() => runs.refetch()} />}
        {runs.data?.length === 0 && <EmptyState inline title={RUN_FILTERS.find((f) => f.value === filter)!.empty} />}
        {runs.data?.map((r) => {
          const result = (Array.isArray(r.result) ? r.result : []) as Array<{ type: string; ok: boolean; detail: string; skipped?: boolean }>;
          const rule = r.rule as { id: string; name: string } | null;
          const path = r.subject_type && r.subject_id && SUBJECT_PATH[r.subject_type] ? `${SUBJECT_PATH[r.subject_type]}${r.subject_id}` : null;
          return (
            <div key={r.id} className="card-row" style={{ alignItems: "flex-start" }}>
              <StatusPill label={RUN_LABELS[r.status] ?? r.status} tone={RUN_TONES[r.status] ?? "muted"} />
              <span className="grow" style={{ minWidth: 0 }}>
                {!ruleId && <strong>{rule?.name ?? "Deleted rule"}</strong>}
                <span className="muted small" style={{ display: "block" }}>
                  {r.status === "pending" ? `Runs ${timeAgo(r.run_after)}` : formatDateTime(r.finished_at ?? r.created_at)}
                  {path && <> · <Link to={path}>Open {r.subject_type}</Link></>}
                </span>
                {/* An action with nothing to do (Marketing off, a client who opted out) is neither done nor failed. The pill says Skipped when they all were. */}
                {result.map((x, i) => (
                  <span key={i} className={`small ${x.skipped ? "muted" : x.ok ? "text-good" : "text-danger"}`} style={{ display: "block" }}>
                    {x.skipped ? "–" : x.ok ? "✓" : "✕"} {x.skipped && r.status !== "skipped" ? `Skipped: ${x.detail}` : x.detail}
                  </span>
                ))}
                {(!result.length || r.status === "pending") && r.error && <span className="small muted" style={{ display: "block" }}>{r.error}</span>}
              </span>
              {r.status === "failed" && <Button size="sm" icon="refresh" loading={act.isPending && act.variables?.id === r.id} onClick={() => act.mutate({ id: r.id, action: "retry" })}>Retry</Button>}
              {r.status === "pending" && <Button size="sm" variant="ghost" loading={act.isPending && act.variables?.id === r.id} onClick={() => act.mutate({ id: r.id, action: "cancel" })}>Cancel</Button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
