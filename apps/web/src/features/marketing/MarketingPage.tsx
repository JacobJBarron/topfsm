/**
 * Marketing (Apps → Crewtavo - Marketing): campaigns (the automated ones, AutomatedCampaigns, and
 * one-off emails to client segments, with what each brought in), social posts (Social), promo codes, Google review requests
 * (Reviews) and referral credits and asks (Referrals), and visits to the business's website once
 * Website Analytics is installed (WebsiteSection). Uninstalled, the page says so, and still shows website
 * visits when Website Analytics is installed (Home and Website Analytics open them here).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, StatsSkeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDate, formatDateTime, formatMoneyCents, timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";
import { AutomatedCampaigns, useAutomatedStates } from "./AutomatedCampaigns";
import { emailsSentHint } from "./automatedForm";
import { resultsSummary, useCampaignResults } from "./CampaignResults";
import { PromoCodes } from "./PromoCodes";
import { Referrals } from "./Referrals";
import { Reviews } from "./Reviews";
import { Social } from "./Social";
import { analyticsOn } from "./website";

type Tab = "campaigns" | "social" | "promos" | "reviews" | "referrals" | "website";
// Charts load with the tab, not with the rest of Marketing.
const WebsiteSection = lazy(() => import("./WebsiteSection").then((m) => ({ default: m.WebsiteSection })));

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
        campaigns_sent: number; emails_sent_30d: number; automated_sent_30d: number; reviews_requested_30d: number; reviews_clicked_30d: number; referrals_total: number; referrals_won: number;
        credits_owed: number; referral_revenue: number | null; campaign_revenue: number | null; opted_out: number;
      },
  });

  if (!hasRole(session, "admin", "office") || !can(session, "marketing")) return <NoAccess title="Marketing" />;
  if (!featureOn(session.company.settings, "marketing")) return <MarketingOff />;
  const s = summary.data;
  return (
    <>
      <PageHeader title="Marketing" />
      {summary.isPending ? <StatsSkeleton count={5} /> : s && (
        <div className="stat-row">
          <div className="card stat"><div className="label">Emails sent (30 days)</div><div className="value">{s.emails_sent_30d}</div><div className="hint">{emailsSentHint(s)}</div></div>
          <div className="card stat">
            <div className="label">Revenue from campaigns</div>
            <div className="value">{s.campaign_revenue === null ? "—" : formatMoneyCents(s.campaign_revenue)}</div>
            <div className="hint">{s.campaign_revenue === null ? "Needs the Invoices area" : "Paid work from people who clicked a campaign, before tax"}</div>
          </div>
          <div className="card stat"><div className="label">Review requests (30 days)</div><div className="value">{s.reviews_requested_30d}</div><div className="hint">{s.reviews_requested_30d ? `${Math.round((s.reviews_clicked_30d / s.reviews_requested_30d) * 100)}% opened the review link` : "None sent yet"}</div></div>
          <div className="card stat">
            <div className="label">Referrals</div>
            <div className="value">{s.referrals_total}</div>
            <div className="hint">{s.referrals_won} became jobs{s.referral_revenue === null ? "" : ` · ${formatMoneyCents(s.referral_revenue)} paid, before tax`}</div>
          </div>
          <div className="card stat"><div className="label">Referral credits {statusText("credit", "earned").toLowerCase()}</div><div className="value">{formatMoneyCents(s.credits_owed)}</div><div className="hint">Not on an invoice yet</div></div>
        </div>
      )}
      <div className="underline-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "campaigns"} onClick={() => setTab("campaigns")}><Icon name="mail" size={16} />Campaigns</button>
        <button type="button" role="tab" aria-selected={tab === "social"} onClick={() => setTab("social")}><Icon name="share" size={16} />Social</button>
        <button type="button" role="tab" aria-selected={tab === "promos"} onClick={() => setTab("promos")}><Icon name="tag" size={16} />Promo codes</button>
        <button type="button" role="tab" aria-selected={tab === "reviews"} onClick={() => setTab("reviews")}><Icon name="star" size={16} />Reviews</button>
        <button type="button" role="tab" aria-selected={tab === "referrals"} onClick={() => setTab("referrals")}><Icon name="gift" size={16} />Referrals</button>
        {website && <button type="button" role="tab" aria-selected={tab === "website"} onClick={() => setTab("website")}><Icon name="globe" size={16} />Website</button>}
      </div>
      {tab === "campaigns" && <Campaigns />}
      {tab === "social" && <Social />}
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

/** Marketing isn't installed: say so, where to install it for those who can, and website visits, which are Website Analytics'. */
function MarketingOff() {
  const session = useSession();
  const canTurnOn = hasRole(session, "admin") && can(session, "apps");
  // Close pending quotes isn't marketing, so it keeps going while it's on: say so, and where it's turned off.
  const states = useAutomatedStates();
  const followUp = states.data?.find((x) => x.template_key === "quote_followup");
  return (
    <>
      <PageHeader title="Marketing" />
      <div className="card">
        <EmptyState icon="marketing" title="Marketing is off" action={canTurnOn && <Link className="btn btn-primary" to="/apps/marketing">Install Marketing</Link>}>
          {canTurnOn ? "Ask happy clients for reviews and referrals, send campaigns and post to your social pages. Install it to bring back everything you had." : "Ask an owner or admin to install Marketing from Apps."}
          {" "}Referral credits clients have earned, or earn later from links already shared, still go on their invoices.
          {followUp?.enabled && <>{" "}Following up on sent quotes keeps going.</>}
          {followUp?.enabled && can(session, "automations") && <>{" "}<Link to={`/automations/${followUp.rule_id}`}>Turn it off in Automations</Link>.</>}
        </EmptyState>
      </div>
      {analyticsOn(session) && (
        <section className="stack" aria-labelledby="website-visits">
          <h2 id="website-visits" className="section-title">Website visits</h2>
          <Suspense fallback={<Loading label="Loading website visits" className="stack"><CardSkeleton height={320} /></Loading>}>
            <WebsiteSection />
          </Suspense>
        </section>
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
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("campaigns")
          .select("id, name, subject, status, recipients_count, sent_count, failed_count, scheduled_at, finished_at, created_at")
          .eq("company_id", session.company.id)
          .eq("kind", "one_off")
          .order("created_at", { ascending: false }),
      ),
  });
  const results = useCampaignResults();
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
    <div className="stack-lg">
      {!session.config.features.email && (
        <div className="callout callout-info"><Icon name="info" size={20} /><div className="grow">Email isn't connected yet, so campaigns can't be sent.<ConnectEmailHint /></div></div>
      )}
      <AutomatedCampaigns results={results} />
      <section className="stack" aria-labelledby="one-off-campaigns">
        <div className="row-between">
          <h2 id="one-off-campaigns" className="section-title">One-off campaigns</h2>
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
                  {(c.status === "sent" || c.status === "cancelled") && results.data && (
                    <span className="muted small ellipsis" style={{ display: "block" }}>{resultsSummary(results.data.find((r) => r.campaign_id === c.id))}</span>
                  )}
                </Link>
                {c.status === "sending" && <div className="progress" style={{ width: 90 }}><span style={{ width: `${c.recipients_count ? (c.sent_count / c.recipients_count) * 100 : 0}%` }} /></div>}
                <EntityStatus kind="campaign" status={c.status} />
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
      </section>
    </div>
  );
}
