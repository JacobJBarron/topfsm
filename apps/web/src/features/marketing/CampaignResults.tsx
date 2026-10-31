/**
 * What a campaign brought in, one-off or automated (public.campaign_results): emails sent, how many
 * were opened and clicked, the work booked after a click and what it has been paid (CampaignStats);
 * and who it went to, with what each did (campaign_recipient_results), a page at a time, narrowed to
 * those who opened, clicked or booked (CampaignRecipients). Opens are approximate, and the page says so.
 */
import { bookingWords, campaignRates, nextRecipientPage, RECIPIENT_PAGE, resultsLine, type CampaignResults as Results } from "@crewtavo/core/campaigns";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Skeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDateTime, formatMoneyCents } from "@/lib/format";
import { useSession } from "@/lib/session";

/** Every campaign's numbers, drafts left out: the one-off list and the automated cards read them. */
export function useCampaignResults() {
  const session = useSession();
  return useQuery({
    queryKey: ["campaign-results", session.company.id],
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("campaign_results", { p_company: session.company.id })) as unknown as Results[],
  });
}

/** "120 sent · 46% opened · 9% clicked · 3 bookings · $4,200.00", the money only for someone with Invoices. */
export function resultsSummary(r: Results | undefined): string {
  if (!r?.sent) return resultsLine(r);
  return [resultsLine(r), r.bookings ? bookingWords(r.bookings) : null, r.revenue ? formatMoneyCents(r.revenue) : null].filter(Boolean).join(" · ");
}

interface Recipient {
  id: number;
  client_id: string | null;
  name: string | null;
  email: string;
  status: string;
  error: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  open_count: number;
  click_count: number;
  quote_number: number | null;
  bookings: number;
  revenue: number | null;
}

interface RecipientPage {
  total: number;
  recipients: Recipient[];
}

/** Who to list: everyone, or those who opened, clicked or booked (public.campaign_recipient_results' p_filter). */
export const RECIPIENT_FILTERS = [
  { value: "all", label: "Everyone", empty: "No one yet" },
  { value: "opened", label: "Opened", empty: "No one has opened it yet" },
  { value: "clicked", label: "Clicked", empty: "No one has clicked a link yet" },
  { value: "booked", label: "Booked", empty: "No bookings yet" },
] as const;
type RecipientFilter = (typeof RECIPIENT_FILTERS)[number]["value"];

/** The numbers, across the page, and what they count. */
export function CampaignStats({ campaignId, live = false }: { campaignId: string; live?: boolean }) {
  const session = useSession();
  const results = useQuery({
    queryKey: ["campaign-results", session.company.id, campaignId],
    refetchInterval: live ? 3000 : false,
    queryFn: async () => ((unwrap(await supabase().rpc("campaign_results", { p_company: session.company.id, p_campaign: campaignId })) as unknown as Results[])[0] ?? null),
  });
  const r = results.data;
  const rates = r ? campaignRates(r) : null;
  return (
    <div className="stack">
      {results.isPending ? <StatsSkeleton count={5} /> : results.error ? (
        <div className="card"><ErrorState compact error={results.error} onRetry={() => results.refetch()} /></div>
      ) : (
        <div className="stat-row">
          <div className="card stat"><div className="label">Sent</div><div className="value">{(r?.sent ?? 0).toLocaleString()}</div></div>
          <div className="card stat"><div className="label">Opened</div><div className="value">{rates?.opened ?? 0}%</div><div className="hint">{(r?.opened ?? 0).toLocaleString()} {r?.opened === 1 ? "email" : "emails"}</div></div>
          <div className="card stat"><div className="label">Clicked</div><div className="value">{rates?.clicked ?? 0}%</div><div className="hint">{(r?.clicked ?? 0).toLocaleString()} {r?.clicked === 1 ? "email" : "emails"}</div></div>
          <div className="card stat"><div className="label">Bookings</div><div className="value">{(r?.bookings ?? 0).toLocaleString()}</div><div className="hint">Requests and approved quotes</div></div>
          <div className="card stat">
            <div className="label">Revenue</div>
            <div className="value">{r?.revenue == null ? "—" : formatMoneyCents(r.revenue)}</div>
            <div className="hint">{r?.revenue == null ? "Needs the Invoices area" : "Paid so far, before tax"}</div>
          </div>
        </div>
      )}
      <div className="stack-sm">
        <p className="muted small" style={{ margin: 0 }}>Opens are approximate: Apple Mail and some others load images to protect privacy, so some emails show as opened when they weren't.</p>
        <p className="muted small" style={{ margin: 0 }}>
          Bookings are requests and approved quotes from people who clicked a link, within 30 days. A request and the quote made from it count once. Revenue is what that work has been paid so far, before tax.
          Work booked another way counts when it was set up after the click and paid within 30 days of it, so invoices for work they already had, like recurring visits, don't.
        </p>
      </div>
    </div>
  );
}

/** Who it went to and what each did, newest first, narrowed to those who opened, clicked or booked. */
export function CampaignRecipients({ campaignId, live = false }: { campaignId: string; live?: boolean }) {
  const [filter, setFilter] = useState<RecipientFilter>("all");
  // A page at a time, each from where the last left off, so a campaign of thousands can be read to the end.
  const people = useInfiniteQuery({
    queryKey: ["campaign-recipients", campaignId, filter],
    refetchInterval: live ? 3000 : false,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      unwrap(await supabase().rpc("campaign_recipient_results", { p_campaign: campaignId, p_limit: RECIPIENT_PAGE, p_offset: pageParam, p_filter: filter })) as unknown as RecipientPage,
    getNextPageParam: (last, pages) => (last.recipients.length ? nextRecipientPage(pages.reduce((n, p) => n + p.recipients.length, 0), last.total)?.p_offset : undefined),
  });
  const total = people.data?.pages.at(-1)?.total ?? 0;
  // A send in between pages moves the rest down one: each person is listed once.
  const recipients = [...new Map((people.data?.pages ?? []).flatMap((p) => p.recipients).map((p) => [p.id, p])).values()];

  return (
    <div className="card">
      <div className="card-head wrap" style={{ rowGap: 8 }}>
        <strong>Recipients</strong>
        <div className="segmented" role="group" aria-label="Show">
          {RECIPIENT_FILTERS.map((f) => <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</button>)}
        </div>
        <span className="muted small">{people.data ? total.toLocaleString() : ""}</span>
      </div>
      {people.isPending && <div className="card-pad"><Skeleton height={60} /></div>}
      {people.error && <ErrorState compact error={people.error} onRetry={() => people.refetch()} />}
      {people.data && recipients.length === 0 && <EmptyState inline title={RECIPIENT_FILTERS.find((f) => f.value === filter)!.empty} />}
      {recipients.map((p) => {
        const notes = [
          p.email,
          p.quote_number != null ? `Quote #${p.quote_number}` : null,
          p.sent_at ? `Sent ${formatDateTime(p.sent_at)}` : null,
          p.clicked_at ? `Clicked ${formatDateTime(p.clicked_at)}${p.click_count > 1 ? ` (${p.click_count} times)` : ""}` : p.opened_at ? `Opened ${formatDateTime(p.opened_at)}` : null,
          p.error,
        ].filter(Boolean);
        const booked = [p.bookings ? bookingWords(p.bookings) : null, p.revenue ? formatMoneyCents(p.revenue) : null].filter(Boolean).join(" · ");
        return (
          <div key={p.id} className="card-row" style={{ padding: "10px 20px" }}>
            <span className="grow" style={{ minWidth: 0 }}>
              {p.client_id ? <Link to={`/clients/${p.client_id}`} className="strong text-sm" style={{ color: "var(--ink)" }}>{p.name ?? p.email}</Link> : <strong className="text-sm">{p.name ?? p.email}</strong>}
              <span className="muted small" style={{ display: "block" }}>{notes.join(" · ")}</span>
              {booked && <span className="small" style={{ display: "block", fontWeight: 600 }}>{booked}</span>}
            </span>
            <EntityStatus kind="recipient" status={p.status === "sent" && p.clicked_at ? "clicked" : p.status === "sent" && p.opened_at ? "opened" : p.status} />
          </div>
        );
      })}
      {people.hasNextPage && (
        <div className="list-foot">
          <span>{recipients.length.toLocaleString()} of {total.toLocaleString()}</span>
          <Button size="sm" variant="ghost" loading={people.isFetchingNextPage} onClick={() => void people.fetchNextPage()}>Show more</Button>
        </div>
      )}
    </div>
  );
}

/** Both, one above the other: an automated campaign's page. */
export function CampaignResults({ campaignId, live = false }: { campaignId: string; live?: boolean }) {
  return (
    <div className="stack">
      <CampaignStats campaignId={campaignId} live={live} />
      <CampaignRecipients campaignId={campaignId} live={live} />
    </div>
  );
}
