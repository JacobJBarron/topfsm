/**
 * Marketing → Reviews, Jobber's way: when clients are asked for a Google review automatically, by
 * which channels, after which recurring visit, and the reminders that follow every ask; the review
 * link and its two messages; asking a client now; and recent asks.
 *
 * "Ask automatically" edits the two starter rules (review_after_job, review_recurring) through PUT
 * /api/reviews/asks, so they're still where asking is set and still show in Automations. A rule
 * someone changed there into something this can't show keeps its shape, with a link to it, and only
 * the switch turns it on and off.
 */
import {
  askChannels,
  askError,
  askRefusal,
  askStatus,
  askTiming,
  ASK_WHEN,
  DEFAULT_REVIEW_MESSAGE,
  MAX_RECURRING_VISITS,
  MAX_REMINDER_DAYS,
  notAsked,
  ordinal,
  reachOf,
  reminderLines,
  REVIEW_GAP_DAYS,
  reviewSettings,
  type AskChannel,
  type AskWhen,
} from "@crewtavo/core/marketing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";
import { askBody, askRules, daysInOrder, type AskForm, type AskRuleRow } from "./askForm";
import { useSettingsSaver } from "./useSettingsSaver";

/** Email, Text, Both: the same order wherever a review ask's channel is picked. */
const CHANNELS: Array<{ value: AskChannel; label: string }> = [
  { value: "email", label: "Email" },
  { value: "sms", label: "Text" },
  { value: "both", label: "Both" },
];
const WHEN_HINTS: Record<AskWhen, string> = {
  "job.completed": "When a job moves to Requires invoicing or Completed.",
  "visit.completed": "Each visit of a one-off job, not assessments or tasks.",
  "invoice.paid": "Not deposits or progress billing: the work isn't done yet.",
};
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

export function Reviews() {
  const session = useSession();
  // Rules a person can't see (no Automations area) don't come back, so the form waits on knowing.
  const rules = useQuery({
    queryKey: ["automation-rules", session.company.id, "review"],
    enabled: can(session, "automations"),
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("automation_rules")
          .select("id, name, description, enabled, template_key, trigger, delay_minutes, conditions, actions")
          .eq("company_id", session.company.id)
          .in("template_key", ["review_after_job", "review_recurring"]),
      ) as unknown as AskRuleRow[],
  });

  // Recent requests run the full width under the rest, so on a phone Ask a client now comes before a long list.
  return (
    <div className="stack">
      <div className="two-col">
        <div className="wide stack">
          {!can(session, "automations") ? (
            <div className="card card-pad stack-sm">
              <strong>Ask automatically</strong>
              <p className="muted text-sm" style={{ margin: 0 }}>Owners and admins with the Automations area choose when clients are asked for a review.</p>
            </div>
          ) : rules.isPending ? (
            <div className="card card-pad"><CardSkeleton lines={4} /></div>
          ) : rules.error ? (
            <div className="card"><ErrorState compact error={rules.error} onRetry={() => rules.refetch()} /></div>
          ) : (
            <AskAutomatically rules={rules.data} />
          )}
          <ReviewLink />
        </div>
        <aside className="narrow stack">
          <AskNow />
        </aside>
      </div>
      <RecentRequests />
    </div>
  );
}

/** A starter rule changed in Automations into something the form can't show. */
function CustomRule({ rule }: { rule: AskRuleRow }) {
  return (
    <div className="callout callout-info">
      <Icon name="info" size={18} />
      <div className="grow">
        You changed “{rule.name}” in Automations, so only the switch above turns it on and off here.{" "}
        <Link to={`/automations/${rule.id}`}>Open the rule</Link>
      </div>
    </div>
  );
}

function AskAutomatically({ rules }: { rules: AskRuleRow[] }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const settings = session.company.settings as { review_url?: string };
  const { afterRule, recurringRule, afterCustom, recurringCustom, onlyRecurring, missing, form: initial } = askRules(rules, session.company.settings);
  const [form, setForm] = useState<AskForm>(initial);
  const set = (patch: Partial<AskForm>) => setForm((f) => ({ ...f, ...patch }));
  const canSave = hasRole(session, "admin") && can(session, "automations");
  const inOrder = daysInOrder(form);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => api.put<{ kept: Array<{ id: string; name: string }> }>("/reviews/asks", askBody(form)),
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["automation-rules", session.company.id] });
      // New reminder days move the reminders still to come.
      queryClient.invalidateQueries({ queryKey: ["review-requests", session.company.id] });
      await session.refresh();
    },
  });
  const saved = useJustDone(save);
  const whenLabel = ASK_WHEN.find((w) => w.verb === form.when)?.label ?? "";
  const texts = form.channel !== "email";
  const emails = form.channel !== "sms";
  // With the after-job rule changed in Automations, Send by is the recurring rule's alone.
  const channelShown = !afterCustom || !recurringCustom;
  const timing = !afterCustom
    ? askTiming("after_job", form.when, afterRule?.delay_minutes ?? 1440)
    : channelShown && form.recurring ? askTiming("recurring", form.when, recurringRule?.delay_minutes ?? 1440) : "";
  const disabled = !canSave;
  // A rule changed in Automations may ask on recurring work itself, so then this says only what the recurring rule does.
  const recurringHint = form.recurring
    ? afterCustom ? "Asks once for each recurring job, after this visit." : "Recurring jobs wait for this visit instead."
    : afterCustom ? "Nothing asks after a recurring job's visits." : "Recurring work isn't asked automatically.";

  return (
    <form className="card card-pad stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (inOrder) save.mutate(); }}>
      <div className="row-between">
        <strong>Ask automatically</strong>
        <label className="switch-row" style={{ fontWeight: 400 }}>
          <input type="checkbox" className="switch" aria-label="Ask automatically" checked={form.enabled} disabled={disabled} onChange={(e) => set({ enabled: e.target.checked })} />
          {form.enabled ? "On" : "Off"}
        </label>
      </div>
      {!settings.review_url && (
        <div className="callout callout-warning"><Icon name="alert" size={18} /><div className="grow">Add your Google review link below first. Until then there's nothing to send.</div></div>
      )}
      {form.enabled && onlyRecurring && !afterCustom && (
        <p className="muted small" style={{ margin: 0 }}>Only recurring work is asked right now. Saving with this on asks after {lowerFirst(whenLabel)} too.</p>
      )}

      {afterCustom ? (
        <CustomRule rule={afterRule!} />
      ) : (
        <Field label="Ask when" hint={WHEN_HINTS[form.when]}>
          <select className="select" value={form.when} disabled={disabled} onChange={(e) => set({ when: e.target.value as AskWhen })}>
            {ASK_WHEN.map((w) => <option key={w.verb} value={w.verb}>{w.label}</option>)}
          </select>
        </Field>
      )}
      {channelShown && (
        <>
          <Field label="Send by" hint={afterCustom ? "For recurring work. The rule you changed keeps its own." : undefined}>
            <div className="segmented" role="group" aria-label="Send by" style={{ justifySelf: "start" }}>
              {CHANNELS.map((c) => (
                <button key={c.value} type="button" aria-pressed={form.channel === c.value} disabled={disabled} onClick={() => set({ channel: c.value })}>{c.label}</button>
              ))}
            </div>
          </Field>
          {texts && !session.config.features.sms && (
            <div className="callout callout-warning">
              <Icon name="alert" size={18} />
              <div className="grow">
                {emails && session.config.features.email
                  ? "Texting isn't set up on this Crewtavo, so asks go by email only, or fail for clients with no email."
                  : "Texting isn't set up on this Crewtavo, so asks can't go by text."}
              </div>
            </div>
          )}
          {emails && !session.config.features.email && (
            <div className="callout callout-warning"><Icon name="alert" size={18} /><div className="grow">Email isn't connected yet, so asks can't go by email.<ConnectEmailHint /></div></div>
          )}
        </>
      )}

      {recurringCustom ? (
        <CustomRule rule={recurringRule!} />
      ) : (
        <Field label="Recurring work" hint={recurringHint}>
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="checkbox">
              <input type="checkbox" checked={form.recurring} disabled={disabled} onChange={(e) => set({ recurring: e.target.checked })} />
              Ask after the
            </label>
            <select className="select" style={{ width: "auto" }} aria-label="Visit to ask after" value={form.visits} disabled={disabled || !form.recurring} onChange={(e) => set({ visits: Number(e.target.value) })}>
              {Array.from({ length: MAX_RECURRING_VISITS }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{ordinal(n)} visit</option>)}
            </select>
          </div>
        </Field>
      )}

      {/* Reminders follow every ask, by hand too, so they're set here whether or not asking is on. */}
      <div className="stack-sm">
        <strong className="small">Reminders</strong>
        <span className="muted small">For every ask, automatic or by hand. At 1:30pm, to anyone who hasn't opened the link.</span>
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="segmented" role="group" aria-label="Reminders">
            {(["None", "One", "Two"] as const).map((label, n) => (
              <button key={label} type="button" aria-pressed={form.reminders === n} disabled={disabled} onClick={() => set({ reminders: n })}>{label}</button>
            ))}
          </div>
          {[0, 1].filter((i) => i < form.reminders).map((i) => (
            <select key={i} className="select" style={{ width: "auto" }} aria-label={i === 0 ? "First reminder" : "Second reminder"} value={form.days[i]} disabled={disabled}
              onChange={(e) => set({ days: (i === 0 ? [Number(e.target.value), form.days[1]] : [form.days[0], Number(e.target.value)]) as [number, number] })}>
              {Array.from({ length: MAX_REMINDER_DAYS }, (_, d) => d + 1).map((d) => <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`} after</option>)}
            </select>
          ))}
        </div>
        {!inOrder && <p className="error-text" style={{ margin: 0 }}>The second reminder comes after the first.</p>}
      </div>

      <p className="muted small" style={{ margin: 0 }}>
        {timing} At most once every 6 months per client. Between 9pm and 9am the first ask goes by email.
        {afterRule && <> <Link to={`/automations/${afterRule.id}`}>{afterRule.name}</Link></>}
        {recurringRule && <> · <Link to={`/automations/${recurringRule.id}`}>{recurringRule.name}</Link></>}
      </p>
      {canSave && missing && <p className="muted small" style={{ margin: 0 }}>Saving puts the rules back in Automations.</p>}
      <FormError error={save.error} />
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        {canSave ? (
          <Button type="submit" loading={save.isPending} done={saved} disabled={!inOrder}>Save</Button>
        ) : (
          <span className="muted small">Only owners and admins can change these.</span>
        )}
      </div>
    </form>
  );
}

function ReviewLink() {
  const session = useSession();
  const settings = session.company.settings as { review_url?: string; review_message?: string };
  const canSave = hasRole(session, "admin");
  const [url, setUrl] = useState(settings.review_url ?? "");
  const [message, setMessage] = useState(settings.review_message ?? DEFAULT_REVIEW_MESSAGE);
  const [reminder, setReminder] = useState(reviewSettings(session.company.settings).reminderMessage);
  const save = useSettingsSaver();
  const saved = useJustDone(save);
  const validUrl = /^https:\/\/\S+\.\S+/.test(url.trim());
  const linked = message.includes("{{link}}") && reminder.includes("{{link}}");

  return (
    <form
      className="card card-pad stack"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        // settings.reviews is also saved by Ask automatically: what's there now is kept.
        save.mutate((current) => ({
          review_url: url.trim(),
          review_message: message.trim(),
          reviews: { ...((current.reviews as Record<string, unknown> | undefined) ?? {}), reminder_message: reminder.trim() },
        }));
      }}
    >
      <strong>Your review link</strong>
      <Field label="Google review URL" error={url && !validUrl ? "Paste the full link, starting with https://" : null} hint={<a href="https://support.google.com/business/answer/3474122" target="_blank" rel="noreferrer">Where to find it</a>}>
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://g.page/r/…/review" disabled={!canSave} />
      </Field>
      <Field label="Message" hint="{{link}} is replaced with your review link.">
        <textarea className="textarea" style={{ minHeight: 110 }} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} disabled={!canSave} />
      </Field>
      <Field label="Reminder message" hint="Sent to anyone who hasn't opened the link, with the same link.">
        <textarea className="textarea" style={{ minHeight: 90 }} value={reminder} maxLength={1000} onChange={(e) => setReminder(e.target.value)} disabled={!canSave} />
      </Field>
      {!linked && <p className="error-text">Include {"{{link}}"} in both messages so clients can click through.</p>}
      <FormError error={save.error} />
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        {canSave ? <Button type="submit" loading={save.isPending} done={saved} disabled={!validUrl || !linked}>Save</Button> : <span className="muted small">Only owners and admins can change these.</span>}
      </div>
    </form>
  );
}

/** One width for every row, so names line up whether an ask went one way or two. */
function ChannelIcon({ channel }: { channel: string }) {
  const label = channel === "both" ? "Text and email" : channel === "sms" ? "Text" : channel === "email" ? "Email" : "Link copied";
  return (
    <span className="row" role="img" style={{ gap: 2, width: 30, flex: "none" }} aria-label={label}>
      {channel === "both" ? <><Icon name="messages" size={14} /><Icon name="mail" size={14} /></> : <Icon name={channel === "sms" ? "messages" : channel === "email" ? "mail" : "link"} size={16} />}
    </span>
  );
}

const RECENT_SHOWN = 10;

function RecentRequests() {
  const session = useSession();
  const [all, setAll] = useState(false);
  const requests = useQuery({
    queryKey: ["review-requests", session.company.id],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("review_requests")
          .select("id, channel, status, sent_at, clicked_at, error, reminders_sent, reminders_failed, next_reminder_at, reminder_note, reminder_error, client:clients(id, display_name)")
          .eq("company_id", session.company.id)
          .order("sent_at", { ascending: false })
          .limit(50),
      ),
  });
  const timeZone = session.company.timezone;
  const remindersSet = reviewSettings(session.company.settings).reminderDays.length;
  const rows = requests.data ?? [];
  return (
    <div className="card">
      <div className="card-head"><strong>Recent requests</strong></div>
      {requests.isPending && <div className="card-pad"><CardSkeleton lines={2} title={false} /></div>}
      {requests.error && <ErrorState compact error={requests.error} onRetry={() => requests.refetch()} />}
      {requests.data?.length === 0 && <EmptyState inline title="No review requests yet" />}
      {(all ? rows : rows.slice(0, RECENT_SHOWN)).map((r) => {
        const client = r.client as { id: string; display_name: string } | null;
        const notes = [timeAgo(r.sent_at), askError(r), ...reminderLines(r, remindersSet, (iso) => formatDateTime(iso, timeZone))];
        return (
          <div key={r.id} className="card-row">
            <ChannelIcon channel={r.channel} />
            <span className="grow">
              <Link to={`/clients/${client?.id}`} className="strong" style={{ color: "var(--ink)" }}>{client?.display_name ?? "Client"}</Link>
              <span className="muted small" style={{ display: "block" }}>{notes.filter(Boolean).join(" · ")}</span>
            </span>
            <StatusPill {...askStatus(r)} />
          </div>
        );
      })}
      {rows.length > RECENT_SHOWN && (
        <div className="list-foot">
          <span />
          <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${rows.length}`}</Button>
        </div>
      )}
    </div>
  );
}

/**
 * Asking a client by hand: right away, whatever the time and however lately they were asked, unless
 * they opted out or are archived. The channels this Crewtavo can't send by aren't offered.
 */
function AskNow() {
  const session = useSession();
  const queryClient = useQueryClient();
  const settings = session.company.settings as { review_url?: string };
  const ready = { email: session.config.features.email, sms: session.config.features.sms };
  const [client, setClient] = useState<PickedClient>(null);
  const [channel, setChannel] = useState<AskChannel | "link">(ready.email ? "email" : ready.sms ? "sms" : "link");
  const remindersOn = reviewSettings(session.company.settings).reminderDays.length > 0;
  // The picked client's opt-outs, and when they were last asked as the 6 months count it.
  const picked = useQuery({
    queryKey: ["review-ask", client?.id],
    enabled: Boolean(client),
    queryFn: async () => {
      const [who, last] = await Promise.all([
        supabase().from("clients").select("display_name, email, phone, status, review_opt_out, marketing_opt_out, sms_opt_out_at").eq("id", client!.id).maybeSingle(),
        supabase().rpc("last_review_ask", { p_company: session.company.id, p_client: client!.id }),
      ]);
      return { client: unwrap(who), last: unwrap(last) ?? null };
    },
  });
  const ask = useMutation({
    mutationFn: () => api.post<{ sent: boolean; link: string; detail: string }>("/reviews/request", { client_id: client!.id, channel }),
    onSuccess: (r) => {
      if (channel === "link") copyText(r.link, "Review link copied");
      else toast.success(r.detail);
      setClient(null);
    },
    // An ask that failed is listed too, saying why.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["review-requests", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["marketing-summary", session.company.id] });
      // Picked again, the client says they were just asked.
      queryClient.invalidateQueries({ queryKey: ["review-ask"] });
    },
  });

  const who = picked.data?.client;
  const refusal = !who ? null : channel === "link" ? notAsked(who) : askRefusal(who, channel, ready);
  // By text and email, but only one of them can go: which, and why not the other.
  const oneWay = who && channel === "both" && !refusal ? askChannels("both", reachOf(who, ready), false).send : [];
  const only = oneWay.length === 1 ? oneWay[0]! : null;
  const last = picked.data?.last;
  const waitsUntil = last ? new Date(Date.parse(last) + REVIEW_GAP_DAYS * 86_400_000) : null;

  return (
    <form className="card card-pad stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (client && !refusal) ask.mutate(); }}>
      <strong>Ask a client now</strong>
      <ClientPicker value={client} onChange={setClient} allowCreate={false} />
      {client && picked.data && (
        <span className="muted small">
          {last ? `Last asked ${timeAgo(last)}` : "Not asked yet"}
          {waitsUntil && waitsUntil > new Date() ? `, so automatic asks wait until ${formatDate(waitsUntil)}.` : "."}
        </span>
      )}
      <div className="segmented" role="group" aria-label="Send by">
        {CHANNELS.map((c) => (
          <button key={c.value} type="button" aria-pressed={channel === c.value} disabled={c.value === "both" ? !ready.email && !ready.sms : !ready[c.value]} onClick={() => setChannel(c.value)}>{c.label}</button>
        ))}
        <button type="button" aria-pressed={channel === "link"} onClick={() => setChannel("link")}>Copy link</button>
      </div>
      {!ready.sms && <span className="muted small">Texting isn't set up on this Crewtavo.</span>}
      {!ready.email && <span className="muted small">Email isn't connected yet.<ConnectEmailHint /></span>}
      {!settings.review_url && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>Save your Google review link first.</span>}
      {refusal && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>{refusal}</span>}
      {only && <span className="muted small">Goes by {only === "email" ? "email" : "text"} only. {askRefusal(who!, only === "email" ? "sms" : "email", ready)}</span>}
      {channel === "link" && !refusal && <span className="muted small">Automatic asks don't count it until the link is opened.</span>}
      {!refusal && channel !== "link" && remindersOn && <span className="muted small">Reminders follow if they don't open it.</span>}
      <Button type="submit" variant="primary" icon="star" loading={ask.isPending} disabled={!client || !settings.review_url || Boolean(refusal)}>Ask for a review</Button>
    </form>
  );
}
