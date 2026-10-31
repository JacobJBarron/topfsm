/**
 * Marketing → Campaigns' automated campaigns, Jobber's way: Re-engage past clients, Win back lost
 * quotes and Close pending quotes. Each is a small card: its switch (saved at once), when it goes,
 * emails waiting, what it brought in, who gets it (folded away), and Edit email (the days, the
 * subject and message, a preview and a test, saved without touching the switch).
 *
 * Each is an automation rule underneath (PUT /api/campaigns/automated/:key edits it), so it still
 * shows in Automations. A rule someone changed there into something the card can't show keeps its
 * shape, with a link to it, and only the switch turns it on and off. Office staff without the
 * Automations area see each one's state (automated_campaign_states) and results, not its switch.
 */
import { variablesForTrigger } from "@crewtavo/core/automations";
import {
  AUTOMATED_KEYS,
  backlogWords,
  hasTrackableLink,
  inactiveDays,
  linkButton,
  qualifyWords,
  REENGAGE_DAILY_CAP,
  type AutomatedKey,
  type AutomatedState,
  type CampaignResults,
} from "@crewtavo/core/campaigns";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";
import { automatedBody, automatedRules, campaignTokens, dayChoices, daysError, daysWords, lowerWords, sampleVars, timingLine, turnOffWords, waitingLine, type AutomatedCard, type AutomatedRuleRow } from "./automatedForm";
import { resultsSummary } from "./CampaignResults";
import { companyAddressLine, EmailPreview, MessageField, SubjectField, TestEmailDialog } from "./EmailEditor";

const TEMPLATE_KEYS = ["reengage_past_clients", "win_back_lost_quotes", "quote_followup"];

/** Who each one leaves out, and how it paces itself: folded away under "Who gets it". */
const NOTES: Record<AutomatedKey, string> = {
  reengage:
    "Not sent to clients you're working with (recurring work, a job or visit still to do, an open request, or a quote approved or waiting on them), or anyone sent a quote in the last 6 months, which Win back looks after. Nor to anyone emailed this in the last 6 months, or whose last visit was over 3 years ago. Up to 100 a day, those who passed it most recently first.",
  win_back: "Not if the quote isn't lost anymore, or they've since approved another quote, had a job, sent a request or been sent a newer quote. Once for each quote.",
  close_quotes:
    "It follows up a quote they asked for, so it isn't a marketing email: it keeps going while Marketing is uninstalled, reaches clients who unsubscribed from marketing, and has no unsubscribe link.",
};
/** Beside the days in Edit email. */
const DAYS_HINTS: Record<AutomatedKey, string> = {
  reengage: "A year by default, so it reaches them at the same time of year as their last visit, when that work comes round again.",
  win_back: "Quotes already waiting move to the new wait.",
  close_quotes: "Quotes already waiting move to the new wait.",
};
/** What turning it on covers: the quotes from then on, not the ones before. */
const FROM_NOW: Partial<Record<AutomatedKey, string>> = {
  win_back: "Turning it on starts with quotes marked lost from now on.",
  close_quotes: "Turning it on starts with quotes sent from now on.",
};

const NO_LINK = <p className="small" style={{ margin: 0, color: "var(--warning)", fontWeight: 600 }}>Add a link so clicks and bookings can be counted.</p>;

/** Each automated campaign as its rule has it, with emails waiting, for every card (MarketingPage's off screen too). */
export function useAutomatedStates(enabled = true) {
  const session = useSession();
  return useQuery({
    queryKey: ["automated-states", session.company.id],
    enabled,
    queryFn: async () => unwrap(await supabase().rpc("automated_campaign_states", { p_company: session.company.id })) as unknown as AutomatedState[],
  });
}

export function AutomatedCampaigns({ results }: { results: UseQueryResult<CampaignResults[]> }) {
  const session = useSession();
  // Rules a person can't see (no Automations area) don't come back, so the cards wait on knowing.
  const allowed = can(session, "automations");
  const rules = useQuery({
    queryKey: ["automation-rules", session.company.id, "campaigns"],
    enabled: allowed,
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("automation_rules")
          .select("id, name, description, enabled, template_key, trigger, delay_minutes, conditions, actions")
          .eq("company_id", session.company.id)
          .in("template_key", TEMPLATE_KEYS),
      ) as unknown as AutomatedRuleRow[],
  });
  const states = useAutomatedStates();
  const cards = rules.data ? automatedRules(rules.data) : allowed ? null : automatedRules([]);
  const loading = allowed ? rules : states;
  const stateOf = (key: AutomatedKey) => states.data?.find((x) => x.template_key === cards![key].campaign.templateKey);

  return (
    <section className="stack" aria-labelledby="automated-campaigns">
      <div className="stack-sm">
        <h2 id="automated-campaigns" className="section-title">Automated campaigns</h2>
        <p className="muted text-sm" style={{ margin: 0 }}>Sent by themselves to each client at the right time.</p>
      </div>
      {loading.isPending ? (
        <div className="grid-cards">{AUTOMATED_KEYS.map((key) => <CardSkeleton key={key} lines={4} />)}</div>
      ) : loading.error ? (
        <div className="card"><ErrorState compact error={loading.error} onRetry={() => loading.refetch()} /></div>
      ) : (
        <div className="grid-cards">
          {AUTOMATED_KEYS.map((key) =>
            allowed ? (
              <CampaignCard key={key} card={cards![key]} state={stateOf(key)} results={results} />
            ) : (
              <ReadOnlyCard key={key} card={cards![key]} state={stateOf(key)} results={results} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** What it brought in, and who got it: a placeholder while the numbers load, and a retry if they don't. */
function ResultsLine({ templateKey, results }: { templateKey: string; results: UseQueryResult<CampaignResults[]> }) {
  if (results.isPending) return <Skeleton width="70%" height={14} />;
  if (results.error) {
    return (
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="muted small">Couldn't load its results.</span>
        <Button size="sm" variant="ghost" icon="refresh" loading={results.isFetching} onClick={() => void results.refetch()}>Try again</Button>
      </div>
    );
  }
  const mine = results.data?.find((r) => r.kind === "automated" && r.template_key === templateKey);
  return (
    <p className="small" style={{ margin: 0 }}>
      {resultsSummary(mine)}
      {mine?.sent ? <>{" · "}<Link to={`/marketing/campaigns/${mine.campaign_id}`}>See who got it</Link></> : null}
    </p>
  );
}

/** Who it leaves out, folded away so the card leads with when it goes and what it brought in. */
const WhoGetsIt = ({ campaignKey }: { campaignKey: AutomatedKey }) => (
  <details className="more-options more-options-sm">
    <summary>Who gets it</summary>
    <p className="muted small" style={{ margin: 0 }}>{NOTES[campaignKey]}</p>
  </details>
);

/** For someone without the Automations area: whether it's on, when it goes and what it brought in, not its switch. */
function ReadOnlyCard({ card, state, results }: { card: AutomatedCard; state: AutomatedState | undefined; results: UseQueryResult<CampaignResults[]> }) {
  const on = state?.enabled ?? false;
  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <strong>{card.campaign.name}</strong>
        <StatusPill label={on ? "On" : "Off"} tone={on ? "good" : "muted"} />
      </div>
      <p className="text-sm" style={{ margin: 0 }}>{state?.days != null ? timingLine(card.key, state.days) : state ? "Its timing was changed in Automations." : "It isn't set up."}</p>
      {Boolean(state?.waiting) && <p className="small" style={{ margin: 0 }}>{waitingLine(state!.waiting)}</p>}
      <ResultsLine templateKey={card.campaign.templateKey} results={results} />
      <WhoGetsIt campaignKey={card.key} />
      <p className="muted small" style={{ margin: 0 }}>Owners and admins with the Automations area choose these.</p>
    </div>
  );
}

function CampaignCard({ card, state, results }: { card: AutomatedCard; state: AutomatedState | undefined; results: UseQueryResult<CampaignResults[]> }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const { key, campaign, rule, custom, missing, form } = card;
  const canSave = hasRole(session, "admin") && can(session, "automations");
  const emailReady = session.config.features.email;
  const [editing, setEditing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  // A rule changed in Automations waits as long as its own days condition says.
  const days = custom && rule ? inactiveDays(rule.conditions) : form.days;
  const backlog = useQuery({
    queryKey: ["inactive-count", session.company.id, days],
    enabled: key === "reengage",
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("inactive_client_count", { p_company: session.company.id, p_days: days })) as number,
  });
  const save = useMutation({
    meta: { inline: true, success: (r: { enabled: boolean }) => `${campaign.name} turned ${r.enabled ? "on" : "off"}` },
    mutationFn: (body: { enabled: boolean; backlog?: "send" | "skip" }) => api.put<{ kept: Array<{ id: string; name: string }> }>(`/campaigns/automated/${key}`, body).then((r) => ({ ...r, enabled: body.enabled })),
    onSettled: () => {
      for (const k of ["automation-rules", "automated-states", "campaign-results", "inactive-count"]) queryClient.invalidateQueries({ queryKey: [k, session.company.id] });
    },
  });
  const on = save.isPending ? save.variables.enabled : form.enabled;
  const waiting = backlog.data ?? 0;
  // Re-engage turns on only once it knows how many past clients already qualify now, so it can ask
  // first. Without a choice the server counts again and refuses if any do (the count is shown then).
  const counting = key === "reengage" && !on && (!backlog.isSuccess || backlog.isFetching);
  const queued = state?.waiting ?? 0;

  const toggle = async (next: boolean) => {
    // A long list of past clients: email them too, or only those who reach it from now on.
    if (next && key === "reengage" && waiting > 0) return setChoosing(true);
    // Turning off calls off the emails still waiting, and turning it on again doesn't bring them back.
    // Counted fresh, as the card counts them: only those that would still send (the quote still
    // awaiting a response, or still lost), not runs whose quote was approved or lost since.
    if (!next && key !== "reengage" && rule) {
      const { data, error } = await supabase().rpc("automated_campaign_states", { p_company: session.company.id });
      const count = error ? null : ((data as unknown as AutomatedState[] | null)?.find((x) => x.template_key === campaign.templateKey)?.waiting ?? 0);
      if ((count === null || count > 0) && !(await confirm({ title: `Turn off ${campaign.name}?`, body: turnOffWords(key, count), confirmLabel: "Turn off", cancelLabel: "Leave it on", danger: true }))) return;
    }
    save.mutate({ enabled: next });
  };

  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <strong>{campaign.name}</strong>
        <label className="switch-row" style={{ fontWeight: 400 }}>
          <input type="checkbox" className="switch" aria-label={campaign.name} checked={on} disabled={!canSave || save.isPending || counting || (!on && !emailReady)} onChange={(e) => void toggle(e.target.checked)} />
          {on ? "On" : "Off"}
        </label>
      </div>
      {custom ? (
        <div className="callout callout-info">
          <Icon name="info" size={18} />
          <div className="grow">You changed “{rule!.name}” in Automations, so only the switch above turns it on and off here. <Link to={`/automations/${rule!.id}`}>Open the rule</Link></div>
        </div>
      ) : (
        <p className="text-sm" style={{ margin: 0 }}>{timingLine(key, form.days)}</p>
      )}
      {canSave && !on && !emailReady && <p className="muted small" style={{ margin: 0 }}>Email isn't connected yet.<ConnectEmailHint /></p>}
      {key === "reengage" && !on && backlog.error && (
        <div className="row wrap" style={{ gap: 8 }}>
          <span className="muted small">Couldn't count the past clients who already qualify, so it can't be turned on yet.</span>
          <Button size="sm" variant="ghost" icon="refresh" loading={backlog.isFetching} onClick={() => void backlog.refetch()}>Try again</Button>
        </div>
      )}
      {key === "reengage" && on && waiting > 0 && <BacklogLine count={waiting} />}
      {queued > 0 && <p className="small" style={{ margin: 0 }}>{waitingLine(queued)}</p>}
      {!on && FROM_NOW[key] && <p className="muted small" style={{ margin: 0 }}>{FROM_NOW[key]}</p>}
      {!custom && !hasTrackableLink(form.body) && NO_LINK}
      <ResultsLine templateKey={campaign.templateKey} results={results} />
      <WhoGetsIt campaignKey={key} />
      {canSave && !custom && (
        <div className="row wrap" style={{ gap: 12 }}>
          <Button size="sm" icon="edit" onClick={() => setEditing(true)}>Edit email</Button>
          {rule && <Link className="small" to={`/automations/${rule.id}`}>See it in Automations</Link>}
        </div>
      )}
      {canSave && missing && <p className="muted small" style={{ margin: 0 }}>Turning it on puts the rule back in Automations.</p>}
      {!canSave && <span className="muted small">Only owners and admins can change these.</span>}
      <FormError error={save.error} />
      {editing && <EditEmailDialog card={card} backlog={waiting} onClose={() => setEditing(false)} />}
      {choosing && (
        <BacklogDialog
          count={waiting}
          onClose={() => setChoosing(false)}
          onChoose={(choice) => {
            setChoosing(false);
            save.mutate({ enabled: true, backlog: choice });
          }}
        />
      )}
    </div>
  );
}

const BacklogLine = ({ count }: { count: number }) => (
  <p className="small" style={{ margin: 0 }}>{qualifyWords(count)}: they get it {backlogWords(count)}.</p>
);

/** Turning Re-engage on with past clients who already qualify: email them too, 100 a day, or only those who reach it from now on. */
function BacklogDialog({ count, onChoose, onClose }: { count: number; onChoose: (choice: "send" | "skip") => void; onClose: () => void }) {
  const paced = count > REENGAGE_DAILY_CAP;
  return (
    <Dialog open onClose={onClose} title="Turn on Re-engage past clients?" size="sm">
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          {qualifyWords(count)}. They'd get it {backlogWords(count)}{paced ? ", those who passed it most recently first" : ""}.
        </p>
        <p className="muted small" style={{ margin: 0 }}>Only new ones for now? Turning it off and on again later asks again, so these can still be emailed.</p>
        <div className="stack-sm">
          <Button variant="primary" onClick={() => onChoose("send")}>{paced ? `Email them too, ${REENGAGE_DAILY_CAP} a day` : "Email them too"}</Button>
          <Button onClick={() => onChoose("skip")}>Only clients who reach it from now on</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** The days, the subject and the message, with a preview and a test. Saving never changes the switch. */
function EditEmailDialog({ card, backlog, onClose }: { card: AutomatedCard; backlog: number; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const { key, campaign, form } = card;
  const [draft, setDraft] = useState({ days: form.days, subject: form.subject, body: form.body });
  const [testing, setTesting] = useState(false);
  const [testedTo, setTestedTo] = useState<string | null>(null);
  const [counted, setCounted] = useState<unknown>(null);
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const emailReady = session.config.features.email;
  const tokens = campaignTokens(key, variablesForTrigger(campaign.trigger));
  const vars = sampleVars(key, { name: session.profile.full_name, email: session.profile.email, company: session.company.name, phone: session.company.phone }, draft.days, window.location.origin);
  const problem = daysError(key, draft.days) ?? (!draft.subject.trim() ? "Add a subject line." : draft.body.trim().length < 10 ? "Write the email." : null);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => api.put(`/campaigns/automated/${key}`, automatedBody(draft)),
    onSuccess: () => {
      for (const k of ["automation-rules", "automated-states", "inactive-count"]) queryClient.invalidateQueries({ queryKey: [k, session.company.id] });
    },
  });
  const saved = useJustDone(save);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setCounted(null);
    // A shorter wait while it's on brings in clients who already passed it: say how many first.
    if (key === "reengage" && form.enabled && draft.days < form.days) {
      let more: number;
      try {
        more = unwrap(await supabase().rpc("inactive_client_count", { p_company: session.company.id, p_days: draft.days })) as number;
      } catch (error) {
        return setCounted(error);
      }
      if (more > backlog && !(await confirm({ title: `Lower it to ${daysWords(key, draft.days)}?`, body: lowerWords(draft.days, more - backlog, more), confirmLabel: "Lower it" }))) return;
    }
    save.mutate();
  };

  return (
    <Dialog open onClose={onClose} title={campaign.name} size="lg">
      <form className="stack" onSubmit={submit}>
        <Field label={key === "reengage" ? "No visit in" : key === "win_back" ? "After a quote is marked lost" : "After a quote is sent"} hint={DAYS_HINTS[key]} error={daysError(key, draft.days)}>
          <select className="select" style={{ maxWidth: 220 }} value={draft.days} onChange={(e) => set({ days: Number(e.target.value) })}>
            {dayChoices(key, draft.days).map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
          </select>
        </Field>
        <SubjectField value={draft.subject} onChange={(subject) => set({ subject })} />
        <MessageField
          value={draft.body}
          onChange={(body) => set({ body })}
          tokens={tokens}
          hint={campaign.marketing ? "Your address and an unsubscribe link are added at the bottom. Client Hub link is theirs, where they can ask for work." : "Your address is added at the bottom."}
        />
        {!hasTrackableLink(draft.body) && NO_LINK}
        <EmailPreview companyName={session.company.name} address={companyAddressLine(session.company.address)} subject={draft.subject} body={draft.body} vars={vars} unsubscribe={campaign.marketing} linkLabel={linkButton(key)} />
        <FormError error={save.error ?? counted} />
        {!emailReady && <p className="muted small" style={{ margin: 0 }}>Email isn't connected yet, so a test can't be sent.<ConnectEmailHint then="to send one" /></p>}
        {testedTo && <p className="small" role="status" style={{ margin: 0 }}><Icon name="check" size={14} /> Test sent to {testedTo}.</p>}
        <div className="form-actions">
          <Button icon="mail" onClick={() => setTesting(true)} disabled={Boolean(problem) || !emailReady}>Send a test</Button>
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary" loading={save.isPending} done={saved} disabled={Boolean(problem)}>Save</Button>
        </div>
      </form>
      {testing && (
        <TestEmailDialog
          path={`/campaigns/automated/${key}/test`}
          body={{ subject: draft.subject, body: draft.body, days: draft.days }}
          defaultTo={session.profile.email ?? ""}
          onClose={() => setTesting(false)}
          onSent={setTestedTo}
        />
      )}
    </Dialog>
  );
}
