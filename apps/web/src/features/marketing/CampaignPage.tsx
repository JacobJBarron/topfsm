/** Write, target, preview, test and send an email campaign; after sending, see who got it. */
import { greetingName } from "@crewtavo/core/automations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, NoAccess, PageError } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { TagInput } from "@/components/ui/TagInput";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { formatDateTime, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useClientTags } from "../clients/ClientForm";
import { CAMPAIGN_LABELS, CAMPAIGN_TONES, MarketingPage } from "./MarketingPage";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";

interface Audience {
  statuses?: string[];
  tags_any?: string[];
  tags_none?: string[];
  no_visit_days?: number | null;
}
interface Draft {
  name: string;
  subject: string;
  body: string;
  audience: Audience;
}

const STATUS_OPTIONS = [["active", "Active clients"], ["lead", "Leads"], ["archived", "Archived"]] as const;
const TEMPLATES = [
  { label: "Seasonal reminder", subject: "Time to book your {{season}} service", body: "Hi {{client.first_name}},\n\nThe season is almost here and our schedule fills up quickly. Reply to this email or call us to get on the calendar.\n\nThanks,\n{{company.name}}\n{{company.phone}}" },
  { label: "We miss you", subject: "It's been a while, {{client.first_name}}", body: "Hi {{client.first_name}},\n\nIt's been a while since we last worked together, and we'd love to help again. If anything around the property needs attention, just reply and we'll put together a quote.\n\nThanks,\n{{company.name}}" },
  { label: "Thank you", subject: "Thank you from {{company.name}}", body: "Hi {{client.first_name}},\n\nThank you for trusting us with your property this year. If you know anyone who could use our help, we'd be grateful for the introduction.\n\nThanks again,\n{{company.name}}" },
];

const render = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (_, key: string) => vars[key] ?? "");

export function CampaignPage() {
  const session = useSession();
  if (!hasRole(session, "admin", "office") || !can(session, "marketing")) return <NoAccess title="Campaign" />;
  // Uninstalled, Marketing's pages say so, as Drive's do.
  if (!featureOn(session.company.settings, "marketing")) return <MarketingPage />;
  return <CampaignPageScreen />;
}

function CampaignPageScreen() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dialog, setDialog] = useState<null | "send" | "ai" | "test">(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const tags = useClientTags();

  const campaign = useQuery({
    queryKey: ["campaign", id],
    refetchInterval: (q) => ((q.state.data as { status?: string } | undefined)?.status === "sending" ? 3000 : false),
    queryFn: async () => unwrapOne(await supabase().from("campaigns").select("id, name, subject, body, audience, status, scheduled_at, started_at, finished_at, recipients_count, sent_count, failed_count").eq("id", id).maybeSingle(), "This campaign"),
  });
  const c = campaign.data;
  useEffect(() => {
    if (c && !draft) setDraft({ name: c.name, subject: c.subject, body: c.body, audience: (c.audience ?? {}) as Audience });
  }, [c, draft]);
  const editable = c?.status === "draft";
  const audience = useDeferredValue(draft?.audience);

  const recipients = useQuery({
    queryKey: ["campaign-audience", session.company.id, JSON.stringify(audience)],
    enabled: Boolean(audience) && editable,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("campaign_audience", { p_company_id: session.company.id, p_audience: audience as never })),
  });
  const delivered = useQuery({
    queryKey: ["campaign", id, "recipients"],
    enabled: Boolean(c) && !editable,
    refetchInterval: c?.status === "sending" ? 3000 : false,
    queryFn: async () => unwrap(await supabase().from("campaign_recipients").select("id, email, name, status, error, sent_at").eq("campaign_id", id).order("id").limit(500)),
  });

  // Autosave drafts a moment after typing stops, and say so beside the status.
  const saving = useSaveStatus();
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (d: Draft) => unwrap(await supabase().from("campaigns").update({ name: d.name.trim() || "Untitled campaign", subject: d.subject, body: d.body, audience: d.audience as never }).eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] }),
  });
  const savedRef = useRef<string>("");
  useEffect(() => {
    if (!draft || !editable) return;
    const json = JSON.stringify(draft);
    if (!savedRef.current) {
      savedRef.current = json;
      return;
    }
    if (json === savedRef.current) return;
    saving.edited();
    const t = setTimeout(() => {
      savedRef.current = json;
      void saving.track(save.mutateAsync(draft));
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editable]);

  const cancel = useMutation({
    meta: { success: (r: { status: string }) => (r.status === "draft" ? "Campaign unscheduled" : "Sending stopped") },
    mutationFn: () => api.post<{ status: string }>(`/campaigns/${id}/cancel`),
    onSuccess: () => {
      setDraft(null);
      savedRef.current = "";
      queryClient.invalidateQueries({ queryKey: ["campaign", id] });
      queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] });
    },
  });
  const duplicate = useMutation({
    meta: { success: "Copied as a new draft" },
    mutationFn: async () => unwrap(await supabase().from("campaigns").insert({ company_id: session.company.id, name: `${c!.name} (copy)`.slice(0, 120), subject: c!.subject, body: c!.body, audience: c!.audience }).select("id").single()),
    onSuccess: (row) => {
      setDraft(null);
      savedRef.current = "";
      navigate(`/marketing/campaigns/${row.id}`);
    },
  });
  const remove = useMutation({
    meta: { success: "Campaign deleted" },
    mutationFn: async () => unwrap(await supabase().from("campaigns").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] });
      navigate("/marketing", { replace: true });
    },
  });

  if (campaign.isPending || (c && !draft)) return <DetailSkeleton />;
  if (campaign.error || !c || !draft) return <PageError error={campaign.error} onRetry={() => campaign.refetch()} back={<BackLink to="/marketing">Marketing</BackLink>} />;

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setAudience = (patch: Partial<Audience>) => setDraft((d) => (d ? { ...d, audience: { ...d.audience, ...patch } } : d));
  const count = recipients.data?.length ?? 0;
  const sample = recipients.data?.[0];
  const vars = { "client.first_name": sample ? greetingName(sample.display_name) : "Jordan", "client.name": sample?.display_name ?? "Jordan Rivera", "company.name": session.company.name, "company.phone": "" };
  const problems = [
    !draft.subject.trim() && "Add a subject line.",
    draft.body.trim().length < 10 && "Write the email.",
    editable && recipients.data && !count && "No one matches this audience.",
  ].filter(Boolean) as string[];
  const insert = (token: string) => {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? start;
    set({ body: draft.body.slice(0, start) + token + draft.body.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <>
      <BackLink to="/marketing">Marketing</BackLink>
      <PageHeader
        title={editable ? <h1 className="page-title"><input className="title-input" value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} aria-label="Campaign name" /></h1> : c.name}
        documentTitle={c.name}
        actions={
          <>
            {editable && <Button icon="mail" onClick={() => setDialog("test")} disabled={!session.config.features.email || problems.slice(0, 2).length > 0}>Send test</Button>}
            {editable && <Button variant="primary" icon="send" onClick={() => setDialog("send")} disabled={problems.length > 0 || !session.config.features.email}>Send</Button>}
            {(c.status === "scheduled" || c.status === "sending") && <Button variant="danger" icon="x" loading={cancel.isPending} onClick={async () => (await confirm({ title: c.status === "scheduled" ? "Unschedule this campaign?" : "Stop sending?", body: c.status === "sending" ? "Emails already sent can't be recalled." : "It goes back to being a draft.", confirmLabel: c.status === "scheduled" ? "Unschedule" : "Stop", danger: c.status === "sending" })) && cancel.mutate()}>{c.status === "scheduled" ? "Unschedule" : "Stop sending"}</Button>}
            <Menu
              items={[
                { label: "Duplicate", icon: "copy", onSelect: () => duplicate.mutate() },
                { label: "Delete", icon: "trash", danger: true, hidden: c.status === "sending", onSelect: async () => (await confirm({ title: "Delete this campaign?", confirmLabel: "Delete", danger: true })) && remove.mutate() },
              ]}
            />
          </>
        }
      />
      <div className="page-meta">
        <StatusPill label={CAMPAIGN_LABELS[c.status] ?? c.status} tone={CAMPAIGN_TONES[c.status] ?? "muted"} />
        {editable && <SaveStatus status={saving.status} />}
        {c.status === "scheduled" && c.scheduled_at && <span className="muted">Sends {formatDateTime(c.scheduled_at)}</span>}
        {c.status !== "draft" && <span className="muted">{c.sent_count} of {c.recipients_count} sent{c.failed_count ? ` · ${c.failed_count} failed` : ""}</span>}
      </div>
      {!session.config.features.email && editable && <div className="callout callout-info"><Icon name="info" size={20} /><div className="grow">Email isn't connected yet, so this can't be sent.<ConnectEmailHint /></div></div>}
      {c.status === "sending" && <div className="progress"><span style={{ width: `${c.recipients_count ? (c.sent_count / c.recipients_count) * 100 : 0}%` }} /></div>}

      <div className="two-col">
        <div className="wide stack">
          {editable ? (
            <div className="card card-pad stack">
              <div className="row-between wrap">
                <strong>Email</strong>
                <div className="row">
                  <Menu label="Start from a template" triggerClassName="btn btn-sm btn-ghost" trigger={<><Icon name="file" size={14} />Templates</>} items={TEMPLATES.map((t) => ({ label: t.label, onSelect: async () => { if (draft.body.trim().length > 20 && !(await confirm({ title: "Replace your email?", body: "The template replaces the subject and message.", confirmLabel: "Replace" }))) return; set({ subject: t.subject.replace("{{season}}", "spring"), body: t.body }); } }))} />
                  {session.config.features.ai && <Button size="sm" variant="ghost" icon="sparkle" onClick={() => setDialog("ai")}>Write with AI</Button>}
                </div>
              </div>
              <Field label="Subject line"><input className="input" value={draft.subject} maxLength={200} onChange={(e) => set({ subject: e.target.value })} placeholder="Spring cleanup spots are filling up" /></Field>
              <Field label="Message" hint="Your address and an unsubscribe link are added at the bottom.">
                <textarea ref={bodyRef} className="textarea" style={{ minHeight: 240 }} value={draft.body} maxLength={20000} onChange={(e) => set({ body: e.target.value })} />
              </Field>
              <div className="token-list">
                {[["{{client.first_name}}", "First name"], ["{{client.name}}", "Full name"], ["{{company.name}}", "Your company"], ["{{company.phone}}", "Your phone"]].map(([t, l]) => <button key={t} type="button" className="token" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(t)}>{l}</button>)}
              </div>
              <FormError error={save.error} />
            </div>
          ) : (
            <div className="card">
              <div className="card-head"><strong>Recipients</strong><span className="muted small">{c.recipients_count}</span></div>
              {delivered.isPending && <div className="card-pad"><Skeleton height={60} /></div>}
              {delivered.data?.length === 0 && <EmptyState inline title="No recipients" />}
              <div style={{ maxHeight: 420, overflowY: "auto" }}>
                {delivered.data?.map((r) => (
                  <div key={r.id} className="card-row" style={{ padding: "10px 20px" }}>
                    <span className="grow"><strong className="text-sm">{r.name ?? r.email}</strong><span className="muted small" style={{ display: "block" }}>{r.email}{r.error ? ` · ${r.error}` : ""}</span></span>
                    <StatusPill label={{ pending: "Queued", sending: "Sending", sent: "Sent", failed: "Failed", skipped: "Skipped" }[r.status] ?? r.status} tone={r.status === "sent" ? "good" : r.status === "failed" ? "danger" : "muted"} />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="stack-sm">
            <strong>Preview</strong>
            <div className="email-preview">
              <div className="sheet-inner">
                <div className="muted small" style={{ marginBottom: 6 }}>Subject: <strong style={{ color: "var(--ink)" }}>{render(draft.subject, vars) || "No subject"}</strong></div>
                <div style={{ fontWeight: 700, marginBottom: 12 }}>{session.company.name}</div>
                {render(draft.body, vars) || <span className="muted">Your message appears here.</span>}
              </div>
              <div className="email-foot">{session.company.name} · Unsubscribe</div>
            </div>
          </div>
        </div>

        <aside className="narrow stack">
          <div className="card card-pad stack">
            <div className="row-between"><strong>Audience</strong>{editable && (recipients.isFetching ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <span className="badge badge-green">{count}</span>)}</div>
            <div className="field">
              <span>Client status</span>
              <div className="row wrap" style={{ gap: 6 }}>
                {STATUS_OPTIONS.map(([value, label]) => {
                  const on = draft.audience.statuses?.includes(value) ?? false;
                  return <button key={value} type="button" className="tab" aria-pressed={on} disabled={!editable} onClick={() => setAudience({ statuses: on ? (draft.audience.statuses ?? []).filter((x) => x !== value) : [...(draft.audience.statuses ?? []), value] })}>{label}</button>;
                })}
              </div>
              <span className="hint">None selected means every status.</span>
            </div>
            <Field label="Has any of these tags" optional><TagInput value={draft.audience.tags_any ?? []} onChange={(t) => setAudience({ tags_any: t })} suggestions={tags.data} placeholder="Any client" /></Field>
            <Field label="But none of these tags" optional><TagInput value={draft.audience.tags_none ?? []} onChange={(t) => setAudience({ tags_none: t })} suggestions={tags.data} placeholder="No exclusions" /></Field>
            <Field label="No completed visit in the last" optional>
              <select className="select" value={draft.audience.no_visit_days ?? ""} disabled={!editable} onChange={(e) => setAudience({ no_visit_days: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Don't filter by visits</option>
                <option value="90">3 months</option>
                <option value="180">6 months</option>
                <option value="365">12 months</option>
                <option value="730">2 years</option>
              </select>
            </Field>
            {editable && (
              <div className="stack-sm" style={{ borderTop: "1px solid var(--divider)", paddingTop: 12 }}>
                <span className="text-sm"><strong>{count}</strong> {count === 1 ? "client" : "clients"} will get this.</span>
                {recipients.data?.slice(0, 5).map((r) => <span key={r.client_id} className="small ellipsis">{r.display_name} · <span className="muted">{r.email}</span></span>)}
                {count > 5 && <span className="muted small">and {count - 5} more</span>}
              </div>
            )}
          </div>
          {editable && problems.length > 0 && <div className="callout callout-warning"><Icon name="alert" size={20} /><div className="grow">{problems.map((p) => <div key={p} style={{ fontWeight: 600 }}>{p}</div>)}</div></div>}
        </aside>
      </div>

      {dialog === "send" && <SendCampaignDialog id={id} count={count} onClose={() => setDialog(null)} onDone={() => { setDraft(null); savedRef.current = ""; campaign.refetch(); }} />}
      {dialog === "test" && <TestDialog id={id} defaultTo={session.profile.email ?? ""} onClose={() => setDialog(null)} />}
      {dialog === "ai" && <AiDialog onClose={() => setDialog(null)} onDraft={(d) => { set(d); setDialog(null); }} />}
    </>
  );
}

function SendCampaignDialog({ id, count, onClose, onDone }: { id: string; count: number; onClose: () => void; onDone: () => void }) {
  const session = useSession();
  const [when, setWhen] = useState<"now" | "later">("now");
  const [date, setDate] = useState(todayIn(session.company.timezone));
  const [time, setTime] = useState("09:00");
  const at = new Date(`${date}T${time}:00`);
  const past = when === "later" && at.getTime() < Date.now() + 60_000;
  const send = useMutation({
    meta: { inline: true, success: (r: { status: string; recipients: number }) => (r.status === "scheduled" ? `Scheduled for ${r.recipients} clients` : `Sending to ${r.recipients} clients`) },
    mutationFn: () => api.post<{ status: string; recipients: number }>(`/campaigns/${id}/send`, when === "later" ? { scheduled_at: at.toISOString() } : {}),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Send campaign" description={`To ${count} ${count === 1 ? "client" : "clients"}.`} size="sm">
      <form onSubmit={(e) => { e.preventDefault(); if (!past) send.mutate(); }}>
        <div className="segmented" role="group" aria-label="When">
          <button type="button" aria-pressed={when === "now"} onClick={() => setWhen("now")}>Send now</button>
          <button type="button" aria-pressed={when === "later"} onClick={() => setWhen("later")}>Schedule</button>
        </div>
        {when === "later" && (
          <div className="form-grid">
            <Field label="Date"><input className="input" type="date" value={date} min={todayIn(session.company.timezone)} onChange={(e) => setDate(e.target.value)} required /></Field>
            <Field label="Time"><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required /></Field>
          </div>
        )}
        {past && <p className="error-text">Pick a time in the future.</p>}
        <FormError error={send.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={when === "now" ? "send" : "calendar"} loading={send.isPending} disabled={past || !count}>{when === "now" ? `Send to ${count}` : "Schedule"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function TestDialog({ id, defaultTo, onClose }: { id: string; defaultTo: string; onClose: () => void }) {
  const [to, setTo] = useState(defaultTo);
  const test = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ to: string }>(`/campaigns/${id}/test`, { to: to.trim() }),
    onSuccess: (r) => {
      toast.success(`Test sent to ${r.to}`);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Send a test" size="sm">
      <form onSubmit={(e) => { e.preventDefault(); test.mutate(); }}>
        <Field label="Send to"><input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} required /></Field>
        <FormError error={test.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="mail" loading={test.isPending}>Send test</Button>
        </div>
      </form>
    </Dialog>
  );
}

function AiDialog({ onClose, onDraft }: { onClose: () => void; onDraft: (d: { subject: string; body: string }) => void }) {
  const [goal, setGoal] = useState("");
  const [tone, setTone] = useState<"friendly" | "professional" | "urgent">("friendly");
  const draft = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ subject: string; body: string }>("/campaigns/draft", { goal: goal.trim(), tone }),
    onSuccess: (d) => {
      toast.success("Draft ready", { description: "Read it over before sending." });
      onDraft(d);
    },
  });
  return (
    <Dialog open onClose={onClose} title="Write with AI">
      <form onSubmit={(e) => { e.preventDefault(); draft.mutate(); }}>
        <Field label="What's this email for?"><textarea className="textarea" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={600} required minLength={5} placeholder="Remind past sealcoating clients to book before June, 10% off if they book this month" /></Field>
        <div className="segmented" role="group" aria-label="Tone">
          {(["friendly", "professional", "urgent"] as const).map((t) => <button key={t} type="button" aria-pressed={tone === t} onClick={() => setTone(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
        <FormError error={draft.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="sparkle" loading={draft.isPending}>Write draft</Button>
        </div>
      </form>
    </Dialog>
  );
}
