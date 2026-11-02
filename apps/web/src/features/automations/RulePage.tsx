/**
 * Rule builder: WHEN (trigger) → WAIT (optional delay) → IF (conditions) → THEN (actions), with a
 * plain-language summary, validation, and a preview against a real recent record.
 */
import {
  actionsFor,
  actionsForTrigger,
  describeRuleSentence,
  fieldsFor,
  OP_LABELS,
  ROLE_GROUP_LABELS,
  STATUS_ACTION_CHOICES,
  statusChoices,
  TRIGGERS,
  triggerAllowed,
  triggerDef,
  validateRule,
  variablesForTrigger,
  type Action,
  type ActionType,
  type Condition,
  type ConditionOp,
  type SubjectKind,
} from "@crewtavo/core/automations";
import { AUTOMATED_CAMPAIGNS, campaignKeyOf } from "@crewtavo/core/campaigns";
import { marketingOn, ordinal, RECURRING_TRIGGER, reviewSettings } from "@crewtavo/core/marketing";
import { STAFF } from "@crewtavo/core/roles";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { NoAccess, PageError } from "@/components/ui/States";
import { TagInput } from "@/components/ui/TagInput";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";
import { useClientTags } from "../clients/ClientForm";
import { RunHistory, type RuleRow } from "./AutomationsPage";

interface Draft {
  name: string;
  description: string;
  trigger: string;
  delay_minutes: number;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
}

const BLANK: Draft = {
  name: "",
  description: "",
  trigger: "quote.sent",
  delay_minutes: 0,
  conditions: [],
  actions: [{ type: "notify", roles: ["owner", "admin", "office"], title: "", body: "" }],
  enabled: true,
};

// Who a rule can notify: the team's levels (automations never notify subs).
const ROLE_OPTIONS: Array<[string, string]> = STAFF.map((r) => [r, ROLE_GROUP_LABELS[r] ?? r]);
const ACTION_ICON: Record<ActionType, IconName> = { notify: "bell", send_email: "mail", send_sms: "messages", add_tag: "tag", remove_tag: "tag", add_note: "note", create_task: "calendarCheck", request_review: "star", request_referral: "gift", update_status: "archive", invite_autopay: "card" };
const STEP_COLORS = { when: "#3474d4", wait: "#8b5cf6", if: "#c9852a", then: "#3b7d23" };

function blankAction(type: ActionType, subject: SubjectKind): Action {
  switch (type) {
    case "notify": return { type, roles: ["owner", "admin", "office"], title: "", body: "" };
    case "send_email": return { type, subject: "", body: "Hi {{client.first_name}},\n\n\n\nThanks,\n{{company.name}}" };
    case "send_sms": return { type, body: "Hi {{client.first_name}}, " };
    case "add_tag": case "remove_tag": return { type, tag: "" };
    case "add_note": return { type, body: "" };
    case "create_task": return { type, title: "", days_from_now: 1 };
    case "request_review": return { type, channel: "email" };
    case "request_referral": return { type };
    case "update_status": return { type, status: STATUS_ACTION_CHOICES[subject]?.[0]?.value ?? "archived" };
    case "invite_autopay": return { type, channel: "email" };
  }
}

function delayParts(minutes: number): { amount: number; unit: "minutes" | "hours" | "days" } {
  if (!minutes) return { amount: 0, unit: "days" };
  if (minutes % 1440 === 0) return { amount: minutes / 1440, unit: "days" };
  if (minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}
const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 };

export function RulePage() {
  const session = useSession();
  return hasRole(session, "admin", "office") && can(session, "automations") ? <RulePageScreen /> : <NoAccess title="Automation" />;
}

function RulePageScreen() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [saved, setSaved] = useState<string>(JSON.stringify(BLANK));
  const [touched, setTouched] = useState(false);

  const rule = useQuery({
    queryKey: ["automation-rule", id],
    enabled: !isNew,
    queryFn: async () => unwrapOne(await supabase().from("automation_rules").select("id, name, description, trigger, delay_minutes, conditions, actions, enabled, run_count, last_run_at, template_key").eq("id", id).maybeSingle(), "This rule") as unknown as RuleRow,
  });
  useEffect(() => {
    if (rule.data) {
      const d: Draft = { name: rule.data.name, description: rule.data.description ?? "", trigger: rule.data.trigger, delay_minutes: rule.data.delay_minutes, conditions: rule.data.conditions ?? [], actions: rule.data.actions ?? [], enabled: rule.data.enabled };
      setDraft(d);
      setSaved(JSON.stringify(d));
    }
  }, [rule.data]);

  const dirty = JSON.stringify(draft) !== saved;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    confirm({ title: "Leave without saving?", body: "Your changes to this rule will be lost.", confirmLabel: "Leave", danger: true }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker]);
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const trigger = triggerDef(draft.trigger);
  const subject: SubjectKind = trigger?.subject ?? "quote";
  // A rule that's an automated campaign (Marketing → Campaigns): any on client.inactive is Re-engage.
  const campaignKey = campaignKeyOf({ template_key: isNew ? null : rule.data?.template_key, trigger: draft.trigger });
  const campaign = campaignKey ? AUTOMATED_CAMPAIGNS[campaignKey] : null;
  // Only an email to the client goes as the campaign's, tracked (a notice to the team doesn't).
  const emailsClient = draft.actions.some((a) => a.type === "send_email");
  // Rules about subs' offers (their prices) are for people with the Subcontractors area, and rules
  // about autopay (clients' cards) for people with the invoices area.
  const triggers = TRIGGERS.filter((t) => t.verb === draft.trigger || triggerAllowed(t.verb, (area) => can(session, area)));
  const errors = useMemo(() => validateRule(draft), [draft]);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = useMutation({
    // A new rule opens as itself, so that's said; a change saves in place, and its button says so.
    meta: { inline: true, success: isNew ? "Rule created" : undefined },
    mutationFn: async () => {
      const row = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        trigger: draft.trigger,
        delay_minutes: trigger?.delayable ? draft.delay_minutes : 0,
        conditions: draft.conditions as never,
        actions: draft.actions as never,
        enabled: draft.enabled,
      };
      if (isNew) return unwrap(await supabase().from("automation_rules").insert({ ...row, company_id: session.company.id }).select("id").single()).id;
      unwrap(await supabase().from("automation_rules").update(row).eq("id", id));
      return id;
    },
    onSuccess: (ruleId) => {
      setSaved(JSON.stringify(draft));
      queryClient.invalidateQueries({ queryKey: ["automation-rules", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["automation-rule", ruleId] });
      if (isNew) setTimeout(() => navigate(`/automations/${ruleId}`, { replace: true }), 0);
    },
  });
  const remove = useMutation({
    meta: { success: "Rule deleted" },
    mutationFn: async () => unwrap(await supabase().from("automation_rules").delete().eq("id", id)),
    onSuccess: () => {
      setSaved(JSON.stringify(draft));
      queryClient.invalidateQueries({ queryKey: ["automation-rules", session.company.id] });
      setTimeout(() => navigate("/automations", { replace: true }), 0);
    },
  });
  const justSaved = useJustDone(save) && !isNew;
  const preview = useMutation({
    meta: { inline: true },
    mutationFn: () =>
      api.post<{ record: { type: string; id: string; label: string; path: string } | null; pass: boolean; failed: string | null; previews: Array<{ type: string; to?: string | null; title?: string; body?: string }>; warnings?: string[] }>(
        "/automations/preview",
        { ...draft, delay_minutes: trigger?.delayable ? draft.delay_minutes : 0 },
      ),
  });

  // A failed save's message is stale as soon as the rule changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => save.reset(), [draft]);
  const submit = () => {
    setTouched(true);
    if (!errors.length) save.mutate();
  };

  if (!isNew && rule.isPending) return <DetailSkeleton />;
  if (!isNew && (rule.error || !rule.data)) return <PageError error={rule.error} onRetry={() => rule.refetch()} back={<BackLink to="/automations">Automations</BackLink>} />;

  const delay = delayParts(draft.delay_minutes);

  return (
    <>
      <BackLink to="/automations">Automations</BackLink>
      <PageHeader
        title={isNew ? "New rule" : draft.name || "Rule"}
        actions={
          <>
            <label className="switch-row" style={{ marginRight: 4 }}>
              <input type="checkbox" className="switch" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
              {draft.enabled ? "On" : "Off"}
            </label>
            <Button icon="eye" loading={preview.isPending} disabled={errors.length > 0} onClick={() => preview.mutate()}>Test</Button>
            <Button variant="primary" icon="check" loading={save.isPending} done={justSaved} disabled={!dirty && !isNew && !justSaved} onClick={submit}>{isNew ? "Create rule" : "Save changes"}</Button>
            {!isNew && <Menu items={[{ label: "Delete rule", icon: "trash", danger: true, onSelect: async () => (await confirm({ title: "Delete this rule?", body: "Follow-ups it has waiting are cancelled.", confirmLabel: "Delete", danger: true })) && remove.mutate() }]} />}
          </>
        }
      />
      <div className="callout callout-info"><Icon name="bolt" size={20} /><div className="grow" style={{ fontWeight: 600 }}>{describeRuleSentence(draft)}</div></div>
      {campaign && (
        <div className="callout callout-info">
          <Icon name="mail" size={20} />
          <div className="grow">
            {campaign.marketing && !marketingOn(session.company.settings) && <div>Marketing is off, so this rule is skipped.</div>}
            <span style={{ fontWeight: 400 }}>
              {rule.data?.template_key === campaign.templateKey ? "This is" : "Rules on this trigger are part of"} {campaign.name} in <Link to="/marketing?tab=campaigns">Marketing → Campaigns</Link>.{" "}
              {emailsClient
                ? campaign.marketing
                  ? "Its email to the client goes as a marketing email with an unsubscribe link, and opens and clicks are counted."
                  : "Its email's opens and clicks are counted."
                : campaign.marketing
                  ? "It runs only while Marketing is installed, and not for clients who unsubscribed from marketing. Nothing is emailed to the client unless you add Email the client."
                  : null}
            </span>
          </div>
        </div>
      )}

      <div className="two-col">
        <div className="wide stack">
          <div className="card card-pad form-grid">
            <Field label="Rule name"><input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} placeholder="Follow up on quotes after 3 days" /></Field>
            <Field label="Description" optional><input className="input" value={draft.description} onChange={(e) => set({ description: e.target.value })} maxLength={300} /></Field>
          </div>

          <div className="rule-flow">
            <Step color={STEP_COLORS.when} icon="bolt" title="When">
              <select className="select" value={draft.trigger} onChange={(e) => {
                const next = triggerDef(e.target.value);
                // Who can be told about it may be fewer (a sub's offer or autopay: the office only).
                const actions = draft.actions.map((a) => (a.type === "notify" && next?.notifyRoles ? { ...a, roles: (a.roles ?? []).filter((r) => next.notifyRoles!.includes(r)) } : a));
                const conditions = next?.subject === subject ? draft.conditions : [];
                // client.inactive needs to know how many days: a year, until it's changed.
                const days = e.target.value === "client.inactive" && !conditions.some((c) => c.field === "days_since_visit")
                  ? [...conditions, { field: "days_since_visit", op: "gte" as const, value: 365 }]
                  : conditions;
                set({ trigger: e.target.value, conditions: days, delay_minutes: next?.delayable ? draft.delay_minutes : 0, actions });
              }} aria-label="Trigger">
                {[...new Set(triggers.map((t) => t.group))].map((group) => (
                  <optgroup key={group} label={group}>
                    {triggers.filter((t) => t.group === group).map((t) => <option key={t.verb} value={t.verb}>{t.label}</option>)}
                  </optgroup>
                ))}
              </select>
              {draft.trigger === "client.inactive" && (
                <p className="muted small" style={{ margin: 0 }}>Checked each morning at 10. Set the number of days under Only if.</p>
              )}
              {draft.trigger === RECURRING_TRIGGER && (
                <p className="muted small" style={{ margin: 0 }}>
                  The {ordinal(reviewSettings(session.company.settings).recurringAfterVisits)} visit, set in <Link to="/marketing?tab=reviews">Marketing → Reviews</Link>.
                </p>
              )}
            </Step>

            {trigger?.delayable && (
              <Step color={STEP_COLORS.wait} icon="clock" title="Wait">
                <div className="rule-line">
                  <select className="select" value={draft.delay_minutes ? "later" : "now"} onChange={(e) => set({ delay_minutes: e.target.value === "now" ? 0 : 3 * 1440 })} aria-label="When to run">
                    <option value="now">Run right away</option>
                    <option value="later">Wait first</option>
                  </select>
                  {draft.delay_minutes > 0 && (
                    <>
                      <input className="input" type="number" min={1} max={365} style={{ maxWidth: 90 }} value={delay.amount} aria-label="Wait amount" onChange={(e) => set({ delay_minutes: Math.max(1, Math.min(525600, Number(e.target.value) || 1)) * UNIT_MINUTES[delay.unit] })} />
                      <select className="select" style={{ maxWidth: 140 }} value={delay.unit} aria-label="Wait unit" onChange={(e) => set({ delay_minutes: Math.max(1, delay.amount) * UNIT_MINUTES[e.target.value as keyof typeof UNIT_MINUTES] })}>
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                      </select>
                    </>
                  )}
                </div>
                {!isNew && <p className="muted small" style={{ margin: 0 }}>Runs already waiting move to the new wait.</p>}
              </Step>
            )}

            <Step color={STEP_COLORS.if} icon="filter" title="Only if" optional>
              {draft.conditions.length === 0 && <p className="muted text-sm" style={{ margin: 0 }}>Runs every time.</p>}
              {draft.conditions.map((c, i) => (
                <ConditionRow
                  key={i}
                  subject={subject}
                  value={c}
                  invalid={touched && !String(Array.isArray(c.value) ? c.value.join("") : c.value ?? "").trim()}
                  onChange={(next) => set({ conditions: draft.conditions.map((x, j) => (j === i ? next : x)) })}
                  onRemove={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })}
                />
              ))}
              {draft.conditions.length < 10 && (
                <Button size="sm" variant="ghost" icon="plus" style={{ justifySelf: "start" }} onClick={() => {
                  const f = fieldsFor(subject)[0];
                  set({ conditions: [...draft.conditions, { field: f.field, op: f.ops[0], value: f.kind === "status" ? statusChoices(subject)[0].value : "" }] });
                }}>Add condition</Button>
              )}
            </Step>

            <Step color={STEP_COLORS.then} icon="check" title="Then">
              {draft.actions.map((a, i) => (
                <ActionEditor
                  key={i}
                  index={i}
                  count={draft.actions.length}
                  subject={subject}
                  verb={draft.trigger}
                  value={a}
                  onChange={(next) => set({ actions: draft.actions.map((x, j) => (j === i ? next : x)) })}
                  onRemove={() => set({ actions: draft.actions.filter((_, j) => j !== i) })}
                  onMove={(dir) => {
                    const next = [...draft.actions];
                    [next[i], next[i + dir]] = [next[i + dir], next[i]];
                    set({ actions: next });
                  }}
                />
              ))}
              {draft.actions.length < 10 && (
                <Menu
                  label="Add action"
                  align="start"
                  triggerClassName="btn btn-sm btn-ghost"
                  trigger={<><Icon name="plus" size={14} />Add action</>}
                  items={actionsForTrigger(draft.trigger).map((a) => ({ label: a.label, icon: ACTION_ICON[a.type], onSelect: () => set({ actions: [...draft.actions, blankAction(a.type, subject)] }) }))}
                />
              )}
            </Step>
          </div>
          {touched && errors.length > 0 && (
            <div className="form-error" role="alert"><Icon name="alert" size={16} /><div>{errors.map((e) => <div key={e}>{e}</div>)}</div></div>
          )}
          <FormError error={save.error} />
        </div>

        <aside className="narrow stack">
          <div className="card card-pad stack-sm">
            <strong>Test this rule</strong>
            <p className="muted text-sm" style={{ margin: 0 }}>Nothing is sent.</p>
            <Button icon="eye" loading={preview.isPending} disabled={errors.length > 0} onClick={() => preview.mutate()} style={{ justifySelf: "start" }}>Test with a recent {subject}</Button>
            <FormError error={preview.error} />
            {preview.data && !preview.data.record && <p className="muted text-sm" style={{ margin: 0 }}>There's no {subject} to test with yet.</p>}
            {preview.data?.record && (
              <div className="stack-sm" style={{ borderTop: "1px solid var(--divider)", paddingTop: 10 }}>
                <span className="small">Using <Link to={preview.data.record.path}>{preview.data.record.label}</Link></span>
                {preview.data.pass ? (
                  <span className="chip chip-green" style={{ justifySelf: "start" }}>Conditions met: it would run</span>
                ) : (
                  <span className="chip chip-amber" style={{ justifySelf: "start", height: "auto", whiteSpace: "normal", padding: "4px 8px" }}>Skipped: {(preview.data.failed ?? "").charAt(0).toLowerCase() + (preview.data.failed ?? "").slice(1)} isn't true</span>
                )}
                {preview.data.warnings?.map((w) => <span key={w} className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>{w}</span>)}
                {preview.data.previews.map((p, i) => (
                  <div key={i} className="email-preview" style={{ padding: 10 }}>
                    <div className="small strong" style={{ marginBottom: 4 }}><Icon name={ACTION_ICON[p.type as ActionType] ?? "bolt"} size={14} /> {actionsFor(subject).find((a) => a.type === p.type)?.label}{p.to ? ` → ${p.to}` : ""}</div>
                    {p.title && <div className="strong text-sm">{p.title}</div>}
                    {p.body && <div className="pre-wrap text-sm muted" style={{ marginTop: 2 }}>{p.body}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
          {!isNew && (
            <div className="stack-sm">
              <h2 className="section-title" style={{ fontSize: 16 }}>Recent runs</h2>
              <RunHistory ruleId={id} />
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function Step({ color, icon, title, optional, children }: { color: string; icon: IconName; title: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <section className="rule-step">
      <div className="rule-step-head">
        <span className="step-icon" style={{ background: color }}><Icon name={icon} size={14} /></span>
        {title}
        {optional && <span className="muted small" style={{ fontWeight: 400 }}>(optional)</span>}
      </div>
      {children}
    </section>
  );
}

function ConditionRow({ subject, value, invalid, onChange, onRemove }: { subject: SubjectKind; value: Condition; invalid: boolean; onChange: (c: Condition) => void; onRemove: () => void }) {
  const fields = fieldsFor(subject);
  const def = fields.find((f) => f.field === value.field) ?? fields[0];
  const tags = useClientTags();
  const choices = def.kind === "status" ? statusChoices(subject) : def.choices;
  const multi = value.op === "in" || def.kind === "tags";
  const asList = Array.isArray(value.value) ? value.value : String(value.value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return (
    <div className="rule-line" style={invalid ? { outline: "2px solid var(--danger-tint)", borderRadius: "var(--radius-control)" } : undefined}>
      <select className="select" value={def.field} aria-label="Field" onChange={(e) => {
        const f = fields.find((x) => x.field === e.target.value)!;
        const firstChoice = f.kind === "status" ? statusChoices(subject)[0].value : f.choices?.[0]?.value ?? "";
        onChange({ field: f.field, op: f.ops[0], value: f.kind === "tags" ? [] : f.kind === "days" ? 365 : firstChoice });
      }}>
        {fields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
      </select>
      <select className="select" style={{ maxWidth: 150 }} value={value.op} aria-label="Comparison" onChange={(e) => onChange({ ...value, op: e.target.value as ConditionOp, value: e.target.value === "in" ? asList : Array.isArray(value.value) ? value.value[0] ?? "" : value.value })}>
        {def.ops.map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
      </select>
      {def.kind === "tags" ? (
        <span style={{ flex: "1 1 200px" }}><TagInput value={asList} onChange={(t) => onChange({ ...value, value: t })} suggestions={tags.data} placeholder="Tag" /></span>
      ) : choices && multi ? (
        <span className="row wrap" style={{ flex: "1 1 220px", gap: 4 }}>
          {choices.map((c) => {
            const on = asList.includes(c.value);
            return <button key={c.value} type="button" className="tab" aria-pressed={on} onClick={() => onChange({ ...value, value: on ? asList.filter((x) => x !== c.value) : [...asList, c.value] })}>{c.label}</button>;
          })}
        </span>
      ) : choices ? (
        <select className="select" value={String(value.value)} aria-label="Value" onChange={(e) => onChange({ ...value, value: e.target.value })}>
          {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      ) : def.kind === "days" ? (
        <span className="row" style={{ flex: "0 1 180px", gap: 6 }}>
          <input className="input" type="number" min={30} max={730} style={{ maxWidth: 100 }} value={String(value.value ?? "")} aria-label="Days"
            onChange={(e) => onChange({ ...value, value: e.target.value === "" ? "" : Math.round(Number(e.target.value)) })} />
          <span className="muted small">days</span>
        </span>
      ) : def.kind === "money" ? (
        <span className="input-group" style={{ flex: "0 1 160px" }}><span className="addon">$</span><input className="input" inputMode="decimal" style={{ paddingLeft: 22 }} value={String(value.value ?? "")} aria-label="Amount" onChange={(e) => onChange({ ...value, value: e.target.value.replace(/[^0-9.]/g, "") })} /></span>
      ) : (
        <input className="input" value={String(value.value ?? "")} aria-label="Value" maxLength={200} onChange={(e) => onChange({ ...value, value: e.target.value })} placeholder={def.field === "line_items" ? "e.g. sealcoat" : ""} />
      )}
      <Button size="sm" variant="ghost" icon="x" aria-label="Remove condition" onClick={onRemove} />
    </div>
  );
}

/**
 * Who a notice can go to: the team's levels, and the people on the visit (or the job's next visits).
 * About a sub's offer or autopay, only the office: never the crew, who don't see subs' prices or clients' cards.
 */
function whoToTell(verb: string, subject: SubjectKind): Array<[string, string]> {
  const only = triggerDef(verb)?.notifyRoles;
  if (only) return ROLE_OPTIONS.filter(([role]) => only.includes(role));
  return [...ROLE_OPTIONS, ...(subject === "visit" || subject === "job" ? [["assigned", subject === "job" ? "People on its next visits" : "People on the visit"] as [string, string]] : [])];
}

/** Clickable {{variables}} that insert at the cursor of the field they belong to. A task (on the schedule) gets no office-only ones. */
function Tokens({ verb, forTask = false, target, onInsert }: { verb: string; forTask?: boolean; target: React.RefObject<HTMLInputElement | HTMLTextAreaElement>; onInsert: (text: string) => void }) {
  return (
    <div className="token-list">
      {variablesForTrigger(verb, forTask).map((v) => (
        <button
          key={v.token}
          type="button"
          className="token"
          title={v.label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = target.current;
            const token = `{{${v.token}}}`;
            if (!el) return onInsert(token);
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? start;
            const next = el.value.slice(0, start) + token + el.value.slice(end);
            onInsert(next);
            requestAnimationFrame(() => {
              el.focus();
              el.setSelectionRange(start + token.length, start + token.length);
            });
          }}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function ActionEditor({ index, count, subject, verb, value, onChange, onRemove, onMove }: { index: number; count: number; subject: SubjectKind; verb: string; value: Action; onChange: (a: Action) => void; onRemove: () => void; onMove: (dir: -1 | 1) => void }) {
  const tags = useClientTags();
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Variables go into whichever field (title/subject or message) was used last.
  const [target, setTarget] = useState<"title" | "body">("body");
  const tokenTarget = target === "title" ? titleRef : bodyRef;
  const insertToken = (text: string) => {
    if (target === "title" && "title" in value) onChange({ ...value, title: text } as Action);
    else if (target === "title" && "subject" in value) onChange({ ...value, subject: text } as Action);
    else if ("body" in value) onChange({ ...value, body: text } as Action);
  };
  const def = actionsFor(subject).find((a) => a.type === value.type);
  const session = useSession();
  return (
    <div className="card" style={{ padding: 14, display: "grid", gap: 10, boxShadow: "none", background: "var(--fill)" }}>
      <div className="row">
        <Icon name={ACTION_ICON[value.type]} size={16} />
        <strong className="grow">{def?.label ?? value.type}</strong>
        <Button size="sm" variant="ghost" icon="chevronUp" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
        <Button size="sm" variant="ghost" icon="chevronDown" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)} />
        <Button size="sm" variant="ghost" icon="trash" aria-label="Remove action" disabled={count === 1} onClick={onRemove} />
      </div>

      {value.type === "notify" && (
        <>
          <div className="field">
            <span>Who</span>
            <div className="row wrap" style={{ gap: 6 }}>
              {whoToTell(verb, subject).map(([role, label]) => {
                const on = value.roles?.includes(role) ?? false;
                return <button key={role} type="button" className="tab" aria-pressed={on} onClick={() => onChange({ ...value, roles: on ? (value.roles ?? []).filter((r) => r !== role) : [...(value.roles ?? []), role] })}>{label}</button>;
              })}
            </div>
          </div>
          <Field label="Title"><input ref={titleRef} className="input" value={value.title} maxLength={200} onFocus={() => setTarget("title")} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder="Quote #{{number}} approved" /></Field>
          <Field label="Details" optional><textarea ref={bodyRef} className="textarea" style={{ minHeight: 60 }} value={value.body ?? ""} maxLength={1000} onFocus={() => setTarget("body")} onChange={(e) => onChange({ ...value, body: e.target.value })} /></Field>
          <Tokens verb={verb} target={tokenTarget} onInsert={insertToken} />
        </>
      )}

      {value.type === "send_email" && (
        <>
          <Field label="Subject"><input ref={titleRef} className="input" value={value.subject} maxLength={200} onFocus={() => setTarget("title")} onChange={(e) => onChange({ ...value, subject: e.target.value })} /></Field>
          <Field label="Message"><textarea ref={bodyRef} className="textarea" style={{ minHeight: 140 }} value={value.body} maxLength={8000} onFocus={() => setTarget("body")} onChange={(e) => onChange({ ...value, body: e.target.value })} /></Field>
          <Tokens verb={verb} target={tokenTarget} onInsert={insertToken} />
        </>
      )}

      {value.type === "send_sms" && (
        <>
          <Field label="Message" hint={`${value.body.length}/640 characters${value.body.length > 160 ? ` · sent as ${Math.ceil(value.body.length / 153)} texts` : ""}`}>
            <textarea ref={bodyRef} className="textarea" style={{ minHeight: 80 }} value={value.body} maxLength={640} onChange={(e) => onChange({ ...value, body: e.target.value })} />
          </Field>
          <Tokens verb={verb} target={bodyRef} onInsert={(text) => onChange({ ...value, body: text })} />
        </>
      )}

      {(value.type === "add_tag" || value.type === "remove_tag") && (
        <Field label="Tag">
          <input className="input" list={`tags-${index}`} value={value.tag} maxLength={40} onChange={(e) => onChange({ ...value, tag: e.target.value })} placeholder="Repeat client" />
          <datalist id={`tags-${index}`}>{tags.data?.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
      )}

      {value.type === "add_note" && (
        <>
          <Field label="Note"><textarea ref={bodyRef} className="textarea" style={{ minHeight: 60 }} value={value.body} maxLength={2000} onChange={(e) => onChange({ ...value, body: e.target.value })} /></Field>
          <Tokens verb={verb} target={bodyRef} onInsert={(text) => onChange({ ...value, body: text })} />
        </>
      )}

      {value.type === "create_task" && (
        <div className="form-grid">
          <Field label="Task"><input ref={titleRef} className="input" value={value.title} maxLength={200} onFocus={() => setTarget("title")} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder="Call {{client.name}} about quote #{{number}}" /></Field>
          <Field label="Due">
            <select className="select" value={value.days_from_now} onChange={(e) => onChange({ ...value, days_from_now: Number(e.target.value) })}>
              {[0, 1, 2, 3, 5, 7, 14, 30].map((d) => <option key={d} value={d}>{d === 0 ? "Same day" : d === 1 ? "Next day" : `In ${d} days`}</option>)}
            </select>
          </Field>
          <div style={{ gridColumn: "1 / -1" }}><Tokens verb={verb} forTask target={titleRef} onInsert={(text) => onChange({ ...value, title: text })} /></div>
        </div>
      )}

      {value.type === "request_review" && (
        <>
          {!marketingOn(session.company.settings) && (
            <div className="callout callout-info"><Icon name="info" size={18} /><div className="grow">Marketing is off, so this action is skipped.</div></div>
          )}
          <Field label="Send by">
            <select className="select" value={value.channel} onChange={(e) => onChange({ ...value, channel: e.target.value as "email" | "sms" | "both" })}>
              <option value="email">Email</option>
              <option value="sms">Text message</option>
              <option value="both">Text and email</option>
            </select>
          </Field>
          <p className="muted small" style={{ margin: 0 }}>Uses your <Link to="/marketing?tab=reviews">review settings</Link>, and asks each client at most once every 6 months.</p>
        </>
      )}

      {value.type === "request_referral" && (
        <>
          {!marketingOn(session.company.settings) && (
            <div className="callout callout-info"><Icon name="info" size={18} /><div className="grow">Marketing is off, so this action is skipped.</div></div>
          )}
          <p className="muted small" style={{ margin: 0 }}>
            Emails each client their referral link, at most once every 6 months. The message is in your <Link to="/marketing?tab=referrals">referral settings</Link>.
          </p>
        </>
      )}

      {value.type === "invite_autopay" && (
        <>
          <Field label="Send by">
            <select className="select" value={value.channel} onChange={(e) => onChange({ ...value, channel: e.target.value as "email" | "sms" })}>
              <option value="email">Email</option>
              <option value="sms">Text message</option>
            </select>
          </Field>
          <p className="muted small" style={{ margin: 0 }}>Skipped for clients already on autopay or invited in the last week. Uses your <Link to="/settings?tab=payments">autopay settings</Link>.</p>
        </>
      )}

      {value.type === "update_status" && (
        <Field label="Change it to">
          <select className="select" value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value })}>
            {(STATUS_ACTION_CHOICES[subject] ?? []).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </Field>
      )}
    </div>
  );
}
