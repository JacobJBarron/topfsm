/**
 * Write, target, preview, test and send an email campaign; after sending, what it brought in and
 * who got it (CampaignResults). An automated campaign's page is its results, with a link to where
 * it's set (Marketing → Campaigns).
 */
import { greetingName } from "@crewtavo/core/automations";
import { audienceKeys, hasTrackableLink, HUB_HOME_BUTTON, RECURRING_CHOICES, recurringChoice, withRecurringChoice, type CampaignAudience } from "@crewtavo/core/campaigns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { NoAccess, PageError } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { TagInput } from "@/components/ui/TagInput";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { formatDateTime, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useClientTags } from "../clients/ClientForm";
import { CampaignRecipients, CampaignResults, CampaignStats } from "./CampaignResults";
import { EmailPreview, MessageField, SubjectField, TestEmailDialog } from "./EmailEditor";
import { MarketingPage } from "./MarketingPage";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";

interface Draft {
  name: string;
  subject: string;
  body: string;
  audience: CampaignAudience;
}

const STATUS_OPTIONS = [["active", "Active clients"], ["lead", "Leads"], ["archived", "Archived"]] as const;
const VISIT_OPTIONS = [["90", "3 months"], ["180", "6 months"], ["365", "12 months"], ["730", "2 years"]] as const;
const TOKENS = [
  { token: "client.first_name", label: "First name" },
  { token: "client.name", label: "Full name" },
  { token: "company.name", label: "Your company" },
  { token: "company.phone", label: "Your phone" },
  { token: "link", label: "Client Hub link" },
];
const TEMPLATES = [
  { label: "Seasonal reminder", subject: "Time to book your {{season}} service", body: "Hi {{client.first_name}},\n\nThe season is almost here and our schedule fills up quickly. Book online, reply to this email or call us to get on the calendar.\n\n{{link}}\n\nThanks,\n{{company.name}}\n{{company.phone}}" },
  { label: "We miss you", subject: "It's been a while, {{client.first_name}}", body: "Hi {{client.first_name}},\n\nIt's been a while since we last worked together, and we'd love to help again. If anything around the property needs attention, you can ask for a visit online, or just reply and we'll put together a quote.\n\n{{link}}\n\nThanks,\n{{company.name}}" },
  { label: "Thank you", subject: "Thank you from {{company.name}}", body: "Hi {{client.first_name}},\n\nThank you for trusting us with your property this year. If you know anyone who could use our help, we'd be grateful for the introduction.\n\nThanks again,\n{{company.name}}" },
];

interface Choice {
  value: string;
  label: string;
  count: number;
}

/** A city or service as the business writes it: the picker's label for it, or as it was saved. */
const labelOf = (list: Choice[] | undefined) => (value: string) => list?.find((x) => x.value === value.trim().toLowerCase())?.label ?? value;

/** Who a sent campaign went to, in words: the audience it was sent with, its cities and services as the business writes them. */
export function audienceSummary(audience: CampaignAudience, choices?: { cities?: Choice[]; services?: Choice[] }): string {
  const a = audienceKeys(audience);
  const cities = (a.cities ?? []).map(labelOf(choices?.cities));
  const services = (a.services ?? []).map(labelOf(choices?.services));
  const statuses = a.statuses?.length ? a.statuses.map((s) => statusText("client", s)).join(", ") : "Every status";
  const parts = [
    statuses,
    a.tags_any?.length ? `tagged ${a.tags_any.join(", ")}` : null,
    a.tags_none?.length ? `not tagged ${a.tags_none.join(", ")}` : null,
    a.no_visit_days ? `no completed visit in ${VISIT_OPTIONS.find(([d]) => Number(d) === a.no_visit_days)?.[1] ?? `${a.no_visit_days} days`}` : null,
    cities.length ? `in ${cities.join(", ")}` : null,
    services.length ? `had ${services.join(", ")}` : null,
    recurringChoice(a) !== "any" ? RECURRING_CHOICES.find((c) => c.value === recurringChoice(a))!.label.toLowerCase() : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

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
  const tags = useClientTags();

  const campaign = useQuery({
    queryKey: ["campaign", id],
    refetchInterval: (q) => ((q.state.data as { status?: string } | undefined)?.status === "sending" ? 3000 : false),
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("campaigns")
          .select("id, kind, template_key, name, subject, body, audience, status, scheduled_at, started_at, finished_at, recipients_count, sent_count, failed_count")
          .eq("id", id)
          .maybeSingle(),
        "This campaign",
      ),
  });
  const c = campaign.data;
  useEffect(() => {
    if (c && !draft && c.kind !== "automated") setDraft({ name: c.name, subject: c.subject, body: c.body, audience: (c.audience ?? {}) as CampaignAudience });
  }, [c, draft]);
  const editable = c?.status === "draft";
  const audience = useDeferredValue(draft?.audience);

  const recipients = useQuery({
    queryKey: ["campaign-audience", session.company.id, JSON.stringify(audience)],
    enabled: Boolean(audience) && editable,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("campaign_audience", { p_company_id: session.company.id, p_audience: audienceKeys(audience) as never })),
  });
  // A sent campaign's preview greets someone who got it, not a made-up name.
  const firstRecipient = useQuery({
    queryKey: ["campaign-first-recipient", id],
    enabled: Boolean(c) && c?.kind !== "automated" && !editable,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("campaign_recipients").select("name").eq("campaign_id", id).order("id").limit(1))[0]?.name ?? null,
  });
  // A sent campaign's summary reads its cities and services with the business's own spelling too.
  const choices = useQuery({
    queryKey: ["campaign-audience-choices", session.company.id],
    enabled: Boolean(c) && c?.kind !== "automated",
    meta: { silent: true },
    staleTime: 60_000,
    queryFn: async () => unwrap(await supabase().rpc("campaign_audience_choices", { p_company: session.company.id })) as unknown as { cities: Choice[]; services: Choice[] },
  });

  // Autosave drafts a moment after typing stops, and say so beside the status.
  const saving = useSaveStatus();
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (d: Draft) =>
      unwrap(await supabase().from("campaigns").update({ name: d.name.trim() || "Untitled campaign", subject: d.subject, body: d.body, audience: audienceKeys(d.audience) as never }).eq("id", id)),
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

  if (c?.kind === "automated") return <AutomatedCampaignView id={c.id} name={c.name} />;
  if (campaign.isPending || (c && !draft)) return <DetailSkeleton />;
  if (campaign.error || !c || !draft) return <PageError error={campaign.error} onRetry={() => campaign.refetch()} back={<BackLink to="/marketing">Marketing</BackLink>} />;

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setAudience = (patch: Partial<CampaignAudience>) => setDraft((d) => (d ? { ...d, audience: { ...d.audience, ...patch } } : d));
  const count = recipients.data?.length ?? 0;
  const sampleName = editable ? recipients.data?.[0]?.display_name : firstRecipient.data;
  const vars = {
    "client.first_name": sampleName ? greetingName(sampleName) : "Jordan",
    "client.name": sampleName ?? "Jordan Rivera",
    "company.name": session.company.name,
    "company.phone": session.company.phone ?? "",
    link: window.location.origin,
  };
  const problems = [
    !draft.subject.trim() && "Add a subject line.",
    draft.body.trim().length < 10 && "Write the email.",
    editable && recipients.data && !count && "No one matches this audience.",
  ].filter(Boolean) as string[];

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
        <EntityStatus kind="campaign" status={c.status} />
        {editable && <SaveStatus status={saving.status} />}
        {c.status === "scheduled" && c.scheduled_at && <span className="muted">Sends {formatDateTime(c.scheduled_at)}</span>}
        {c.status !== "draft" && <span className="muted">{c.sent_count} of {c.recipients_count} sent{c.failed_count ? ` · ${c.failed_count} failed` : ""}</span>}
      </div>
      {!session.config.features.email && editable && <div className="callout callout-info"><Icon name="info" size={20} /><div className="grow">Email isn't connected yet, so this can't be sent.<ConnectEmailHint /></div></div>}
      {c.status === "sending" && <div className="progress"><span style={{ width: `${c.recipients_count ? (c.sent_count / c.recipients_count) * 100 : 0}%` }} /></div>}
      {/* Across the page, so the five numbers sit in one row. */}
      {!editable && <CampaignStats campaignId={c.id} live={c.status === "sending"} />}

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
              <SubjectField value={draft.subject} onChange={(subject) => set({ subject })} placeholder="Spring cleanup spots are filling up" />
              <MessageField
                value={draft.body}
                onChange={(body) => set({ body })}
                tokens={TOKENS}
                hint="Your address and an unsubscribe link are added at the bottom. Client Hub link is each client's own, where they can ask for work."
              />
              {!hasTrackableLink(draft.body) && <p className="small" style={{ margin: 0, color: "var(--warning)", fontWeight: 600 }}>Add a link so clicks and bookings can be counted.</p>}
              <FormError error={save.error} />
            </div>
          ) : (
            <CampaignRecipients campaignId={c.id} live={c.status === "sending"} />
          )}

          <EmailPreview companyName={session.company.name} subject={draft.subject} body={draft.body} vars={vars} unsubscribe linkLabel={HUB_HOME_BUTTON} />
        </div>

        <aside className="narrow stack">
          <div className="card card-pad stack">
            <div className="row-between"><strong>Audience</strong>{editable && (recipients.isFetching ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <span className="badge badge-green">{count}</span>)}</div>
            {editable ? (
              <>
                <div className="field">
                  <span>Client status</span>
                  <div className="row wrap" style={{ gap: 6 }}>
                    {STATUS_OPTIONS.map(([value, text]) => {
                      const on = draft.audience.statuses?.includes(value) ?? false;
                      return <button key={value} type="button" className="tab" aria-pressed={on} onClick={() => setAudience({ statuses: on ? (draft.audience.statuses ?? []).filter((x) => x !== value) : [...(draft.audience.statuses ?? []), value] })}>{text}</button>;
                    })}
                  </div>
                  <span className="hint">None selected means every status.</span>
                </div>
                <Field label="Has any of these tags" optional><TagInput value={draft.audience.tags_any ?? []} onChange={(t) => setAudience({ tags_any: t })} suggestions={tags.data} placeholder="Any client" /></Field>
                <Field label="But none of these tags" optional><TagInput value={draft.audience.tags_none ?? []} onChange={(t) => setAudience({ tags_none: t })} suggestions={tags.data} placeholder="No exclusions" /></Field>
                <Field label="City" optional hint="From their properties or billing address.">
                  <TagInput value={(draft.audience.cities ?? []).map(labelOf(choices.data?.cities))} onChange={(t) => setAudience({ cities: t })} options={choices.data?.cities} placeholder="Any city" />
                </Field>
                <Field label="Had any of these services" optional hint="On jobs that are done, or have had a visit.">
                  <TagInput value={(draft.audience.services ?? []).map(labelOf(choices.data?.services))} onChange={(t) => setAudience({ services: t })} options={choices.data?.services} placeholder="Any service" />
                </Field>
                <Field label="Recurring work" optional>
                  <select className="select" value={recurringChoice(draft.audience)} onChange={(e) => set({ audience: withRecurringChoice(draft.audience, e.target.value as ReturnType<typeof recurringChoice>) })}>
                    {RECURRING_CHOICES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                  </select>
                </Field>
                <Field label="No completed visit in the last" optional>
                  <select className="select" value={draft.audience.no_visit_days ?? ""} onChange={(e) => setAudience({ no_visit_days: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Don't filter by visits</option>
                    {VISIT_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                  </select>
                </Field>
                <div className="stack-sm" style={{ borderTop: "1px solid var(--divider)", paddingTop: 12 }}>
                  <span className="text-sm"><strong>{count}</strong> {count === 1 ? "client" : "clients"} will get this.</span>
                  {recipients.data?.slice(0, 5).map((r) => <span key={r.client_id} className="small ellipsis">{r.display_name} · <span className="muted">{r.email}</span></span>)}
                  {count > 5 && <span className="muted small">and {count - 5} more</span>}
                </div>
              </>
            ) : (
              <p className="text-sm" style={{ margin: 0 }}>{audienceSummary(draft.audience, choices.data)}</p>
            )}
          </div>
          {editable && problems.length > 0 && <div className="callout callout-warning"><Icon name="alert" size={20} /><div className="grow">{problems.map((p) => <div key={p} style={{ fontWeight: 600 }}>{p}</div>)}</div></div>}
        </aside>
      </div>

      {dialog === "send" && <SendCampaignDialog id={id} count={count} onClose={() => setDialog(null)} onDone={() => { setDraft(null); savedRef.current = ""; campaign.refetch(); }} />}
      {dialog === "test" && <TestEmailDialog path={`/campaigns/${id}/test`} defaultTo={session.profile.email ?? ""} onClose={() => setDialog(null)} />}
      {dialog === "ai" && <AiDialog onClose={() => setDialog(null)} onDraft={(d) => { set(d); setDialog(null); }} />}
    </>
  );
}

/** An automated campaign's page: what it brought in and who got it. It's set on Marketing → Campaigns. */
function AutomatedCampaignView({ id, name }: { id: string; name: string }) {
  return (
    <>
      <BackLink to="/marketing">Marketing</BackLink>
      <PageHeader title={name} />
      <div className="page-meta">
        <EntityStatus kind="campaign" status="automated" />
        <span className="muted">Sends by itself. <Link to="/marketing?tab=campaigns">Edit on Marketing → Campaigns</Link></span>
      </div>
      <CampaignResults campaignId={id} />
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
