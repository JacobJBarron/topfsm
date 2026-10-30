/**
 * Marketing: email campaigns to client segments, promo codes, Google review requests and referral rewards,
 * and visits to the business's website once Website Analytics is installed (WebsiteSection).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, StatsSkeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate, formatDateTime, formatMoney, timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { PromoCodes } from "./PromoCodes";
import { analyticsOn } from "./website";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";

type Tab = "campaigns" | "promos" | "reviews" | "referrals" | "website";
// Charts load with the tab, not with the rest of Marketing.
const WebsiteSection = lazy(() => import("./WebsiteSection").then((m) => ({ default: m.WebsiteSection })));
export const CAMPAIGN_TONES: Record<string, Tone> = { draft: "muted", scheduled: "info", sending: "info", sent: "good", cancelled: "danger" };
export const CAMPAIGN_LABELS: Record<string, string> = { draft: "Draft", scheduled: "Scheduled", sending: "Sending", sent: "Sent", cancelled: "Stopped" };

export function MarketingPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const website = analyticsOn(session);
  const asked = (params.get("tab") as Tab) || "campaigns";
  const tab = asked === "website" && !website ? "campaigns" : asked;
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  const summary = useQuery({
    queryKey: ["marketing-summary", session.company.id],
    meta: { silent: true },
    queryFn: async () =>
      unwrap(await supabase().rpc("marketing_summary", { p_company_id: session.company.id })) as {
        campaigns_sent: number; emails_sent_30d: number; reviews_requested_30d: number; reviews_clicked_30d: number; referrals_total: number; referrals_won: number; rewards_pending: number; opted_out: number;
      },
  });

  if (!hasRole(session, "admin", "office") || !can(session, "marketing")) return <NoAccess title="Marketing" />;
  const s = summary.data;
  return (
    <>
      <PageHeader title="Marketing" />
      {summary.isPending ? <StatsSkeleton count={4} /> : s && (
        <div className="stat-row">
          <div className="card stat"><div className="label">Emails sent (30 days)</div><div className="value">{s.emails_sent_30d}</div><div className="hint">{s.campaigns_sent} campaigns sent in total</div></div>
          <div className="card stat"><div className="label">Review requests (30 days)</div><div className="value">{s.reviews_requested_30d}</div><div className="hint">{s.reviews_requested_30d ? `${Math.round((s.reviews_clicked_30d / s.reviews_requested_30d) * 100)}% opened the review link` : "None sent yet"}</div></div>
          <div className="card stat"><div className="label">Referrals</div><div className="value">{s.referrals_total}</div><div className="hint">{s.referrals_won} became jobs</div></div>
          <div className="card stat"><div className="label">Rewards owed</div><div className="value">{formatMoney(s.rewards_pending)}</div><div className="hint">{s.opted_out} clients unsubscribed</div></div>
        </div>
      )}
      <div className="underline-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "campaigns"} onClick={() => setTab("campaigns")}><Icon name="mail" size={16} />Campaigns</button>
        <button type="button" role="tab" aria-selected={tab === "promos"} onClick={() => setTab("promos")}><Icon name="tag" size={16} />Promo codes</button>
        <button type="button" role="tab" aria-selected={tab === "reviews"} onClick={() => setTab("reviews")}><Icon name="star" size={16} />Reviews</button>
        <button type="button" role="tab" aria-selected={tab === "referrals"} onClick={() => setTab("referrals")}><Icon name="gift" size={16} />Referrals</button>
        {website && <button type="button" role="tab" aria-selected={tab === "website"} onClick={() => setTab("website")}><Icon name="globe" size={16} />Website</button>}
      </div>
      {tab === "campaigns" && <Campaigns />}
      {tab === "promos" && <PromoCodes />}
      {tab === "reviews" && <Reviews />}
      {tab === "referrals" && <Referrals />}
      {tab === "website" && (
        <Suspense fallback={<Loading label="Loading website visits" className="stack"><CardSkeleton height={320} /></Loading>}>
          <WebsiteSection />
        </Suspense>
      )}
    </>
  );
}

function Campaigns() {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const campaigns = useQuery({
    queryKey: ["campaigns", session.company.id],
    refetchInterval: (q) => ((q.state.data as Array<{ status: string }> | undefined)?.some((c) => c.status === "sending") ? 5000 : false),
    queryFn: async () => unwrap(await supabase().from("campaigns").select("id, name, subject, status, recipients_count, sent_count, failed_count, scheduled_at, finished_at, created_at").eq("company_id", session.company.id).order("created_at", { ascending: false })),
  });
  const create = useMutation({
    mutationFn: async () => unwrap(await supabase().from("campaigns").insert({ company_id: session.company.id, name: `Campaign ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, audience: { statuses: ["active"] } }).select("id").single()),
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] });
      navigate(`/marketing/campaigns/${c.id}`);
    },
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("campaigns").delete().eq("id", id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] }),
  });
  type Campaign = NonNullable<typeof campaigns.data>[number];
  const key = ["campaigns", session.company.id];
  // Gone at once, with Undo; deleted for real once the toast leaves.
  const deleteCampaign = (campaign: Campaign) =>
    undoable({
      title: "Campaign deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Campaign[]>(key, (old) => old?.filter((c) => c.id !== campaign.id));
      },
      restore: () => queryClient.setQueryData<Campaign[]>(key, (old) => (old && !old.some((c) => c.id === campaign.id) ? [...old, campaign].sort((a, b) => b.created_at.localeCompare(a.created_at)) : old)),
      commit: () => remove.mutateAsync(campaign.id),
    });
  const list = useListAnimation<HTMLDivElement>();

  return (
    <div className="stack">
      {!session.config.features.email && (
        <div className="callout callout-info"><Icon name="info" size={20} /><div className="grow">Email isn't connected yet, so campaigns can't be sent.<ConnectEmailHint /></div></div>
      )}
      <div className="row-between">
        <span />
        <Button variant="primary" icon="plus" loading={create.isPending} onClick={() => create.mutate()}>New campaign</Button>
      </div>
      {campaigns.isPending ? <TableSkeleton columns={4} rows={3} /> : campaigns.error ? (
        <div className="card"><ErrorState error={campaigns.error} onRetry={() => campaigns.refetch()} /></div>
      ) : !campaigns.data?.length ? (
        <div className="card">
          <EmptyState icon="mail" title="No campaigns yet" action={<Button icon="plus" onClick={() => create.mutate()}>Write a campaign</Button>} />
        </div>
      ) : (
        <div className="card" ref={list}>
          {campaigns.data.map((c) => (
            <div key={c.id} className="card-row">
              <Link to={`/marketing/campaigns/${c.id}`} className="grow" style={{ color: "inherit", minWidth: 0 }}>
                <strong className="ellipsis" style={{ display: "block" }}>{c.name}</strong>
                <span className="muted small ellipsis" style={{ display: "block" }}>
                  {c.subject || "No subject yet"} ·{" "}
                  {c.status === "sent" ? `${c.sent_count} sent${c.failed_count ? `, ${c.failed_count} failed` : ""} · ${formatDate(c.finished_at)}` : c.status === "scheduled" ? `Sends ${formatDateTime(c.scheduled_at!)}` : c.status === "sending" ? `${c.sent_count} of ${c.recipients_count} sent…` : `Edited ${timeAgo(c.created_at)}`}
                </span>
              </Link>
              {c.status === "sending" && <div className="progress" style={{ width: 90 }}><span style={{ width: `${c.recipients_count ? (c.sent_count / c.recipients_count) * 100 : 0}%` }} /></div>}
              <StatusPill label={CAMPAIGN_LABELS[c.status] ?? c.status} tone={CAMPAIGN_TONES[c.status] ?? "muted"} />
              <Menu
                triggerClassName="btn btn-sm btn-ghost btn-icon"
                items={[
                  { label: c.status === "draft" ? "Edit" : "View", icon: c.status === "draft" ? "edit" : "eye", onSelect: () => navigate(`/marketing/campaigns/${c.id}`) },
                  { label: "Delete", icon: "trash", danger: true, hidden: c.status === "sending", onSelect: () => deleteCampaign(c) },
                ]}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Company settings for marketing: merged into companies.settings (owners and admins only). Its Save button says when it's saved. */
function useSettingsSaver() {
  const session = useSession();
  return useMutation({
    meta: { inline: true },
    mutationFn: async (patch: Record<string, unknown>) => {
      const current = unwrap(await supabase().from("companies").select("settings").eq("id", session.company.id).single());
      unwrap(await supabase().from("companies").update({ settings: { ...(current.settings as Record<string, unknown>), ...patch } as never }).eq("id", session.company.id));
    },
    onSuccess: () => session.refresh(),
  });
}

/** The API's default (services/reviews.ts) word for word: it's what clients get until it's changed here. */
const DEFAULT_REVIEW_MESSAGE =
  "Hi {{client.first_name}}, thank you for choosing {{company.name}}! If you have a minute, would you leave us a quick review? It really helps a small business like ours.\n\n{{link}}";

function Reviews() {
  const session = useSession();
  const settings = session.company.settings as { review_url?: string; review_message?: string };
  const canSave = hasRole(session, "admin");
  const [url, setUrl] = useState(settings.review_url ?? "");
  const [message, setMessage] = useState(settings.review_message ?? DEFAULT_REVIEW_MESSAGE);
  const [client, setClient] = useState<PickedClient>(null);
  const [channel, setChannel] = useState<"email" | "sms" | "link">("email");
  const save = useSettingsSaver();
  const saved = useJustDone(save);
  const queryClient = useQueryClient();
  const validUrl = /^https:\/\/\S+\.\S+/.test(url.trim());

  const requests = useQuery({
    queryKey: ["review-requests", session.company.id],
    queryFn: async () => unwrap(await supabase().from("review_requests").select("id, channel, status, sent_at, clicked_at, error, client:clients(id, display_name)").eq("company_id", session.company.id).order("sent_at", { ascending: false }).limit(50)),
  });
  // A recurring job is never completed, so it has a starter rule of its own (its third visit).
  const rules = useQuery({
    queryKey: ["automation-rules", session.company.id, "review"],
    queryFn: async () => unwrap(await supabase().from("automation_rules").select("id, enabled, template_key").eq("company_id", session.company.id).in("template_key", ["review_after_job", "review_recurring"])),
  });
  const reviewRules = [
    { rule: rules.data?.find((r) => r.template_key === "review_after_job"), label: "After a job" },
    { rule: rules.data?.find((r) => r.template_key === "review_recurring"), label: "Recurring work" },
  ];
  const ask = useMutation({
    mutationFn: () => api.post<{ sent: boolean; link: string; detail: string }>("/reviews/request", { client_id: client!.id, channel }),
    onSuccess: (r) => {
      if (channel === "link") copyText(r.link, "Review link copied");
      else toast.success(r.detail);
      setClient(null);
      queryClient.invalidateQueries({ queryKey: ["review-requests", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["marketing-summary", session.company.id] });
    },
  });

  return (
    <div className="two-col">
      <div className="wide stack">
        <form className="card card-pad stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate({ review_url: url.trim(), review_message: message.trim() }); }}>
          <strong>Your review link</strong>
          <Field label="Google review URL" error={url && !validUrl ? "Paste the full link, starting with https://" : null} hint={<a href="https://support.google.com/business/answer/3474122" target="_blank" rel="noreferrer">Where to find it</a>}>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://g.page/r/…/review" disabled={!canSave} />
          </Field>
          <Field label="Message" hint="{{link}} is replaced with your review link.">
            <textarea className="textarea" style={{ minHeight: 110 }} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} disabled={!canSave} />
          </Field>
          {!message.includes("{{link}}") && <p className="error-text">Include {"{{link}}"} so clients can click through.</p>}
          <FormError error={save.error} />
          <div className="form-actions" style={{ justifyContent: "flex-start" }}>
            {canSave ? <Button type="submit" loading={save.isPending} done={saved} disabled={!validUrl || !message.includes("{{link}}")}>Save</Button> : <span className="muted small">Only owners and admins can change these.</span>}
          </div>
        </form>

        <div className="card">
          <div className="card-head"><strong>Recent requests</strong></div>
          {requests.isPending && <div className="card-pad"><CardSkeleton lines={2} title={false} /></div>}
          {requests.data?.length === 0 && <EmptyState inline title="No review requests yet" />}
          {requests.data?.map((r) => (
            <div key={r.id} className="card-row">
              <Icon name={r.channel === "sms" ? "messages" : r.channel === "email" ? "mail" : "link"} size={16} />
              <span className="grow">
                <Link to={`/clients/${(r.client as { id: string } | null)?.id}`} className="strong" style={{ color: "var(--ink)" }}>{(r.client as { display_name: string } | null)?.display_name ?? "Client"}</Link>
                <span className="muted small" style={{ display: "block" }}>{timeAgo(r.sent_at)}{r.error ? ` · ${r.error}` : ""}</span>
              </span>
              <StatusPill label={r.status === "clicked" ? "Opened link" : r.status === "failed" ? "Failed" : "Sent"} tone={r.status === "clicked" ? "good" : r.status === "failed" ? "danger" : "muted"} />
            </div>
          ))}
        </div>
      </div>
      <aside className="narrow stack">
        <form className="card card-pad stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (client) ask.mutate(); }}>
          <strong>Ask a client now</strong>
          <ClientPicker value={client} onChange={setClient} allowCreate={false} />
          <div className="segmented" role="group" aria-label="Send by">
            <button type="button" aria-pressed={channel === "email"} onClick={() => setChannel("email")}>Email</button>
            <button type="button" aria-pressed={channel === "sms"} onClick={() => setChannel("sms")}>Text</button>
            <button type="button" aria-pressed={channel === "link"} onClick={() => setChannel("link")}>Copy link</button>
          </div>
          {!settings.review_url && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>Save your Google review link first.</span>}
          <Button type="submit" variant="primary" icon="star" loading={ask.isPending} disabled={!client || !settings.review_url}>Ask for a review</Button>
        </form>
        <div className="card card-pad stack-sm">
          <strong>Ask automatically</strong>
          <p className="muted text-sm" style={{ margin: 0 }}>A day after each job, and on recurring work a day after its third visit, once for each job. At most once a month per client.</p>
          {reviewRules.some((r) => r.rule) ? (
            reviewRules.map(({ rule, label }) => rule && (
              <Link key={rule.id} to={`/automations/${rule.id}`} className="btn btn-sm" style={{ justifySelf: "start" }}>
                <Icon name="bolt" size={14} />{label} · {rule.enabled ? "On" : "Off, set it up"}
              </Link>
            ))
          ) : (
            <Link to="/automations/new" className="btn btn-sm" style={{ justifySelf: "start" }}><Icon name="bolt" size={14} />Create a rule</Link>
          )}
        </div>
      </aside>
    </div>
  );
}

function Referrals() {
  const session = useSession();
  const queryClient = useQueryClient();
  const settings = session.company.settings as { referral_reward?: { amount?: number }; referral_offer?: string };
  const canSave = hasRole(session, "admin");
  const [amount, setAmount] = useState(String(settings.referral_reward?.amount ?? ""));
  const [offer, setOffer] = useState(settings.referral_offer ?? "");
  const [client, setClient] = useState<PickedClient>(null);
  useEffect(() => setAmount(String(settings.referral_reward?.amount ?? "")), [settings.referral_reward?.amount]);
  const save = useSettingsSaver();
  const saved = useJustDone(save);
  const referrals = useQuery({
    queryKey: ["referrals", session.company.id],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("referrals")
          .select("id, referred_name, status, reward_amount, reward_status, reward_issued_at, created_at, referrer:clients!referrals_company_id_referrer_client_id_fkey(id, display_name), referred:clients!referrals_company_id_referred_client_id_fkey(id, display_name)")
          .eq("company_id", session.company.id)
          .order("created_at", { ascending: false })
          .limit(100),
      ),
  });
  const issue = useMutation({
    meta: { success: "Reward marked as given" },
    mutationFn: async (id: string) => unwrap(await supabase().from("referrals").update({ reward_status: "issued", reward_issued_at: new Date().toISOString() }).eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["referrals", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["marketing-summary", session.company.id] });
    },
  });
  const link = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/referrals/link/${client!.id}`),
    onSuccess: (r) => copyText(r.link, `Referral link for ${client!.display_name} copied`),
  });
  const value = Number(amount);

  return (
    <div className="two-col">
      <div className="wide stack">
        <div className="card">
          <div className="card-head"><strong>Referrals</strong></div>
          {referrals.isPending && <div className="card-pad"><CardSkeleton lines={2} title={false} /></div>}
          {referrals.error && <ErrorState compact error={referrals.error} onRetry={() => referrals.refetch()} />}
          {referrals.data?.length === 0 && <EmptyState inline title="No referrals yet" />}
          {referrals.data?.map((r) => {
            const referrer = r.referrer as unknown as { id: string; display_name: string } | null;
            const referred = r.referred as unknown as { id: string; display_name: string } | null;
            return (
              <div key={r.id} className="card-row">
                <span className="grow">
                  <span><Link to={referred ? `/clients/${referred.id}` : "#"} className="strong" style={{ color: "var(--ink)" }}>{referred?.display_name ?? r.referred_name}</Link> <span className="muted">referred by</span> {referrer ? <Link to={`/clients/${referrer.id}`}>{referrer.display_name}</Link> : "a client"}</span>
                  <span className="muted small" style={{ display: "block" }}>{timeAgo(r.created_at)}{Number(r.reward_amount) > 0 ? ` · ${formatMoney(r.reward_amount)} reward${r.reward_status === "issued" ? ` given ${formatDate(r.reward_issued_at)}` : ""}` : ""}</span>
                </span>
                <StatusPill label={{ new: "New lead", quoted: "Quoted", won: "Won", lost: "Lost" }[r.status] ?? r.status} tone={r.status === "won" ? "good" : r.status === "quoted" ? "info" : r.status === "lost" ? "danger" : "warning"} />
                {r.status === "won" && r.reward_status === "pending" && <Button size="sm" icon="gift" loading={issue.isPending && issue.variables === r.id} onClick={() => issue.mutate(r.id)}>Mark reward given</Button>}
              </div>
            );
          })}
        </div>
      </div>
      <aside className="narrow stack">
        <form className="card card-pad stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (client) link.mutate(); }}>
          <strong>Get a client's referral link</strong>
          <ClientPicker value={client} onChange={setClient} allowCreate={false} />
          <Button type="submit" icon="copy" loading={link.isPending} disabled={!client}>Copy referral link</Button>
        </form>
        <form className="card card-pad stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate({ referral_reward: { amount: value > 0 ? Math.round(value * 100) / 100 : 0 }, referral_offer: offer.trim() || null }); }}>
          <strong>Reward</strong>
          <Field label="Reward per referral that becomes a job">
            <span className="input-group"><span className="addon">$</span><input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} disabled={!canSave} placeholder="50" /></span>
          </Field>
          <Field label="Offer shown to friends" optional>
            <input className="input" value={offer} maxLength={200} onChange={(e) => setOffer(e.target.value)} disabled={!canSave} placeholder="10% off your first service" />
          </Field>
          <FormError error={save.error} />
          {canSave ? <Button type="submit" loading={save.isPending} done={saved} style={{ justifySelf: "start" }}>Save</Button> : <span className="muted small">Only owners and admins can change these.</span>}
        </form>
      </aside>
    </div>
  );
}
