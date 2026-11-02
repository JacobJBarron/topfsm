/**
 * Marketing → Reviews' Google reviews, once Google Business Profile is connected in Apps
 * (apps/api/src/services/googleReviews.ts brings them in): the numbers across the top (Google's own
 * average and count, the response rate, time to reply and asks that led to a review), a card in the
 * narrow column (the monthly trend, or what's in the way, or an invitation to connect), and the
 * reviews themselves under the ask settings, each with its stars, the client it's matched to and its
 * reply. Replies post publicly on Google, so posting and changing one is confirmed first, and
 * Suggest a reply drafts one with Claude to read and change.
 *
 * Office staff can't read Apps, so what's connected comes from GET /api/reviews/google; the reviews
 * themselves are read through row-level security. ?review=<id> (a notification) shows that review
 * first with its reply open, and ?client=<id> (a client's page) shows only theirs.
 */
import { REPLY_MAX, replyTimeWords, responseRate, reviewerName, starsLabel, type ReviewMonth } from "@crewtavo/core/reviews";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { CardSkeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { ApprovalCallout, useCheckAgain, useSyncNow } from "../apps/GoogleBusinessPanel";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import {
  canReply,
  canSync,
  clientDetail,
  countHint,
  filterReviews,
  filtersOn,
  firstNameOf,
  initials,
  NO_FILTERS,
  problemCopy,
  progressWords,
  rankSuggestions,
  repliedWords,
  sharedNames,
  tooSoon,
  waitingOnGoogle,
  type GoogleState,
  type ReviewFilters,
  type SuggestedClient,
} from "./googleReviewData";

const ReviewTrend = lazy(() => import("./ReviewTrend").then((m) => ({ default: m.ReviewTrend })));

const PAGE = 25;
const FIELDS = "id, reviewer_name, reviewer_photo_url, reviewer_anonymous, rating, comment, posted_at, reply_comment, reply_updated_at, replied_by, client_id, match, client:clients(id, display_name)";

interface Review {
  id: string;
  reviewer_name: string | null;
  reviewer_photo_url: string | null;
  reviewer_anonymous: boolean;
  rating: number | null;
  comment: string | null;
  posted_at: string;
  reply_comment: string | null;
  reply_updated_at: string | null;
  replied_by: string | null;
  client_id: string | null;
  match: string;
  client: { id: string; display_name: string } | null;
}

export interface ReviewStats {
  count: number;
  average: number | null;
  by_stars: Record<string, number>;
  needs_reply: number;
  replied: number;
  count_12m: number;
  replied_12m: number;
  median_reply_hours: number | null;
  months: ReviewMonth[];
  unmatched: number;
  asks_12m: number;
  asks_reviewed_12m: number;
}

/**
 * What Google Business Profile is up to, for the tab. Followed every few seconds while a sync runs,
 * and now and then while the first one is under way between runs. Not while it waits on Google or a
 * person: the server says no progress then.
 */
export function useGoogleState() {
  const session = useSession();
  return useQuery({
    queryKey: ["google-reviews", session.company.id],
    queryFn: () => api.get<GoogleState>("/reviews/google"),
    refetchInterval: (q) => (q.state.data?.syncing ? 5000 : q.state.data?.progress ? 30_000 : false),
  });
}

export function useReviewStats(enabled: boolean) {
  const session = useSession();
  return useQuery({
    queryKey: ["review-stats", session.company.id],
    enabled,
    queryFn: async () => unwrap(await supabase().rpc("review_stats", { p_company: session.company.id })) as unknown as ReviewStats,
  });
}

/** Everything on the tab that changes when a review, its reply or its match does. */
function useRefresh() {
  const session = useSession();
  const queryClient = useQueryClient();
  return () => {
    for (const key of ["reviews", "review", "review-stats", "google-reviews", "review-requests"]) queryClient.invalidateQueries({ queryKey: [key, session.company.id] });
  };
}

function Stars({ rating }: { rating: number | null }) {
  if (!rating) return <span className="muted small">No stars</span>;
  return (
    <span role="img" aria-label={starsLabel(rating)} style={{ letterSpacing: 1, whiteSpace: "nowrap" }}>
      <span style={{ color: "var(--req)" }}>{"★".repeat(rating)}</span>
      <span style={{ color: "var(--text-4)" }}>{"★".repeat(5 - rating)}</span>
    </span>
  );
}

/** The numbers across the top: Google's own average and count, so they match what customers see. */
export function GoogleNumbers({ g, stats }: { g: GoogleState; stats: ReturnType<typeof useReviewStats> }) {
  if (stats.isPending) return <StatsSkeleton count={5} />;
  if (stats.error || !stats.data) return <div className="card"><ErrorState compact error={stats.error} onRetry={() => stats.refetch()} /></div>;
  const s = stats.data;
  const average = g.google.average_rating ?? s.average;
  const total = g.google.total_reviews ?? s.count;
  const rate = responseRate(s.replied_12m, s.count_12m);
  return (
    <div className="stat-row">
      <div className="card stat">
        <div className="label">Average rating</div>
        <div className="value">{average ? <><span style={{ color: "var(--req)" }} aria-hidden>★</span> {Number(average).toFixed(1)}</> : "—"}</div>
        <div className="hint">{g.google.average_rating !== null ? "As Google shows it" : "From the reviews here"}</div>
      </div>
      <div className="card stat"><div className="label">Reviews</div><div className="value">{total.toLocaleString("en-US")}</div><div className="hint">{countHint(g, s.unmatched)}</div></div>
      <div className="card stat"><div className="label">Response rate</div><div className="value">{rate === null ? "—" : `${rate}%`}</div><div className="hint">Reviews in the last 12 months with a reply</div></div>
      <div className="card stat"><div className="label">Time to reply</div><div className="value" style={{ whiteSpace: "nowrap" }}>{replyTimeWords(s.median_reply_hours) ?? "—"}</div><div className="hint">Usually, over the last 12 months</div></div>
      <div className="card stat">
        <div className="label">Asks that led to a review</div>
        <div className="value">{s.asks_reviewed_12m.toLocaleString("en-US")}</div>
        <div className="hint">{s.asks_12m ? `Of ${s.asks_12m.toLocaleString("en-US")} asks in the last 12 months` : "No asks in the last 12 months"}</div>
      </div>
    </div>
  );
}

/** Not connected: a small card saying what it adds, and who can connect it. */
function ConnectGoogleCard({ g }: { g: GoogleState }) {
  return (
    <div className="card card-pad stack-sm">
      <strong>Google reviews</strong>
      <span className="muted small">
        Connect Google Business Profile to see your reviews here, reply with a suggestion, and stop asking clients who already left one. Google approves each server first, which
        takes about 2 weeks.
      </span>
      {g.can_connect ? <Link className="small" to="/apps/google_business">Connect Google Business Profile</Link> : <span className="muted small">Ask an owner or admin to connect it in Apps.</span>}
    </div>
  );
}

/**
 * The narrow column: an invitation to connect, or what's in the way (Google's approval, with Check
 * again for owners and admins, or a sign-in or location problem), then the monthly trend whenever
 * there are reviews here, with how many need a reply while replies can be posted.
 */
export function GoogleSide({ g, stats }: { g: GoogleState | undefined; stats: ReturnType<typeof useReviewStats> }) {
  const session = useSession();
  const refresh = useRefresh();
  const check = useCheckAgain(refresh);
  if (!g) return null;
  if (g.state === "not_connected") return <ConnectGoogleCard g={g} />;
  const waiting = waitingOnGoogle(g);
  const copy = waiting ? null : problemCopy(g, session.company.timezone);
  const s = stats.data;
  return (
    <>
      {waiting && (
        <>
          <ApprovalCallout own={g.own_app} projectNumber={g.project_number} admin={g.can_connect} notEnabled={g.state === "not_enabled"}
            onCheck={g.can_connect ? () => check.mutate() : undefined} checking={check.isPending} />
          <FormError error={check.error} />
          {g.can_connect && <Link className="small" to="/apps/google_business">Open Google Business Profile in Apps</Link>}
        </>
      )}
      {copy && (
        <div className={`callout callout-${copy.tone}`} role="status">
          <Icon name={copy.tone === "info" ? "info" : "alert"} size={18} />
          <div className="grow stack-sm" style={{ gap: 4 }}>
            <span>{copy.title}</span>
            {copy.body && <span style={{ fontWeight: 400 }}>{copy.body}</span>}
            {copy.link && <Link to="/apps/google_business" style={{ fontWeight: 400 }}>{copy.link}</Link>}
          </div>
        </div>
      )}
      {s && s.count > 0 && (
        <div className="card card-pad stack-sm">
          <strong>Reviews each month</strong>
          <Suspense fallback={<CardSkeleton height={150} title={false} />}><ReviewTrend months={s.months} timeZone={session.company.timezone} /></Suspense>
          {s.needs_reply > 0 && canReply(g) && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}>{s.needs_reply === 1 ? "1 review needs a reply" : `${s.needs_reply.toLocaleString("en-US")} reviews need a reply`}</span>}
        </div>
      )}
    </>
  );
}

/** The reviews, newest first, a page at a time, under a heading with when they last came in and Sync now. */
export function GoogleReviewList({ g }: { g: GoogleState }) {
  const session = useSession();
  const refresh = useRefresh();
  const [params, setParams] = useSearchParams();
  const focus = params.get("review");
  const forClientParam = params.get("client");
  const [filters, setFilters] = useState<ReviewFilters>(() => ({ ...NO_FILTERS, client: forClientParam }));
  const [limit, setLimit] = useState(PAGE);
  const [matching, setMatching] = useState<Review | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // ?client= follows the address, so See their review on this same tab shows theirs, and brings the list into view.
  useEffect(() => {
    if (!forClientParam) return;
    setFilters({ ...NO_FILTERS, client: forClientParam });
    setLimit(PAGE);
    document.getElementById("google-reviews")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [forClientParam]);
  // Changing what's shown lets go of the link that brought the person here.
  const change = (next: ReviewFilters) => {
    setFilters(next);
    setLimit(PAGE);
    if (params.has("review") || params.has("client")) setParams({ tab: "reviews" }, { replace: true });
  };
  const key = ["reviews", session.company.id, filters, limit, g.location?.id ?? null];
  const list = useQuery({
    queryKey: key,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase().from("reviews").select(FIELDS, { count: "exact" }).eq("company_id", session.company.id).is("deleted_at", null);
      if (g.location) q = q.eq("location_id", g.location.id);
      const { data, error, count } = await filterReviews(q, filters).order("posted_at", { ascending: false }).order("id").limit(limit);
      return { rows: unwrap({ data, error }) as unknown as Review[], total: count ?? 0 };
    },
  });
  // The review a notification links to, first and whatever the filters, even past the first page.
  const focused = useQuery({
    queryKey: ["review", session.company.id, focus],
    enabled: Boolean(focus),
    queryFn: async () => unwrap(await supabase().from("reviews").select(FIELDS).eq("company_id", session.company.id).eq("id", focus!).maybeSingle()) as unknown as Review | null,
  });
  const forClient = useQuery({
    queryKey: ["client-name", filters.client],
    enabled: Boolean(filters.client),
    queryFn: async () => unwrap(await supabase().from("clients").select("display_name").eq("id", filters.client!).maybeSingle()),
  });
  const rows = list.data?.rows ?? [];
  const shown = focused.data ? [focused.data, ...rows.filter((r) => r.id !== focused.data!.id)] : rows;
  const repliers = [...new Set(shown.map((r) => r.replied_by).filter((id): id is string => Boolean(id)))];
  const people = useQuery({
    queryKey: ["profiles", repliers],
    enabled: repliers.length > 0,
    queryFn: async () => unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", repliers)),
  });
  const names = new Map((people.data ?? []).map((p) => [p.user_id, p.full_name?.split(" ")[0] ?? ""] as const));
  useEffect(() => {
    if (focused.data) document.getElementById(`review-${focused.data.id}`)?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [focused.data]);

  const sync = useSyncNow(() => setTimeout(refresh, 1500));
  const setClient = useMutation({
    mutationFn: (v: { review: Review; client: { id: string; display_name: string } | null }) => api.put(`/reviews/${v.review.id}/client`, { client_id: v.client?.id ?? null }),
    onSuccess: (_, v) => {
      if (v.client) toast.success(`Matched to ${v.client.display_name}. They won't be asked for reviews again.`);
    },
    onSettled: refresh,
  });
  const queryClient = useQueryClient();
  type Page = { rows: Review[]; total: number };
  const notThem = (review: Review) =>
    undoable({
      title: `Asks can go to ${review.client?.display_name ?? "them"} again`,
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Page>(key, (old) => old && { ...old, rows: old.rows.map((r) => (r.id === review.id ? { ...r, client: null, client_id: null, match: "none" } : r)) });
      },
      restore: () => queryClient.setQueryData<Page>(key, (old) => old && { ...old, rows: old.rows.map((r) => (r.id === review.id ? review : r)) }),
      commit: () => setClient.mutateAsync({ review, client: null }),
    });

  const total = list.data?.total ?? 0;
  const live = canReply(g);
  const progress = progressWords(g.progress);
  return (
    <section className="stack" aria-labelledby="google-reviews">
      <div className="row-between wrap" style={{ gap: 8 }}>
        <h2 id="google-reviews" className="section-title">Your Google reviews</h2>
        <div className="row" style={{ gap: 8 }}>
          <span className="muted small" role="status">{progress ?? (g.last_synced_at ? `Last synced ${timeAgo(g.last_synced_at)}` : null)}</span>
          {canSync(g) && <Button size="sm" variant="ghost" icon="refresh" loading={sync.isPending || g.syncing} onClick={() => sync.mutate()}>Sync now</Button>}
        </div>
      </div>
      <FormError error={tooSoon(sync.error) ? null : sync.error} />
      {/* Nothing to filter until there are reviews here. */}
      {g.reviews > 0 && <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Show">
        <button type="button" className="tab" aria-pressed={!filtersOn({ ...filters, client: null })} onClick={() => change({ ...NO_FILTERS, client: filters.client })}>All</button>
        <button type="button" className="tab" aria-pressed={filters.needsReply} onClick={() => change({ ...filters, needsReply: !filters.needsReply })}>Needs a reply</button>
        <select className="select" style={{ width: "auto" }} aria-label="Stars" value={filters.stars ?? ""} onChange={(e) => change({ ...filters, stars: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Any stars</option>
          {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n === 1 ? "1 star" : `${n} stars`}</option>)}
        </select>
        <button type="button" className="tab" aria-pressed={filters.matched === "matched"} onClick={() => change({ ...filters, matched: filters.matched === "matched" ? "all" : "matched" })}>Matched</button>
        <button type="button" className="tab" aria-pressed={filters.matched === "unmatched"} onClick={() => change({ ...filters, matched: filters.matched === "unmatched" ? "all" : "unmatched" })}>Not matched</button>
        {filters.client && (
          <span className="chip chip-green">
            {forClient.data?.display_name ?? "One client"}
            <button type="button" aria-label="Show every client's reviews" onClick={() => change({ ...filters, client: null })}><Icon name="x" size={12} /></button>
          </span>
        )}
      </div>}
      <div className="card">
        {list.isPending && <div className="card-pad"><CardSkeleton lines={3} title={false} /></div>}
        {list.error && <ErrorState compact error={list.error} onRetry={() => list.refetch()} />}
        {list.data && !shown.length && (
          filtersOn(filters)
            ? <EmptyState inline title="No reviews match" action={<Button size="sm" onClick={() => change(NO_FILTERS)}>Clear filters</Button>} />
            : <EmptyState inline title="No reviews yet">{progress ?? "New Google reviews show here."}</EmptyState>
        )}
        {focused.data && (
          <div className="list-foot" style={{ borderTop: 0 }}>
            <span>From your notification</span>
            <Button size="sm" variant="ghost" onClick={() => setParams({ tab: "reviews" }, { replace: true })}>Show all reviews</Button>
          </div>
        )}
        {shown.map((r) => (
          <ReviewRow
            key={r.id}
            review={r}
            names={names}
            highlight={r.id === focused.data?.id}
            live={live}
            onMatch={() => { setMatching(r); setDialogOpen(true); }}
            onNotThem={() => notThem(r)}
            onChanged={refresh}
          />
        ))}
        {total > PAGE && (
          <div className="list-foot">
            <span>Showing {rows.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")}</span>
            {rows.length < total ? (
              <Button size="sm" variant="ghost" loading={list.isFetching} onClick={() => setLimit((l) => l + PAGE)}>Load more</Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setLimit(PAGE)}>Show less</Button>
            )}
          </div>
        )}
      </div>
      <MatchDialog review={matching} open={dialogOpen} onClose={() => setDialogOpen(false)} onExited={() => setMatching(null)}
        onPick={(client) => { setDialogOpen(false); setClient.mutate({ review: matching!, client }); }} />
    </section>
  );
}

const LONG = 320;

/**
 * One review. The status and the menu sit on the name's line, so on a phone the words and the reply
 * get the row's whole width beside the photo.
 */
function ReviewRow({ review: r, names, highlight, live, onMatch, onNotThem, onChanged }: {
  review: Review;
  names: ReadonlyMap<string, string>;
  highlight: boolean;
  live: boolean;
  onMatch: () => void;
  onNotThem: () => void;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [more, setMore] = useState(false);
  const [broken, setBroken] = useState(false);
  const known = reviewerName(r);
  const name = known ?? "A Google user";
  const text = r.comment ?? "";
  const long = text.length > LONG;
  return (
    <div id={`review-${r.id}`} className="card-row" style={{ alignItems: "flex-start", ...(highlight ? { background: "var(--green-tint)" } : {}) }}>
      <span className="avatar" style={{ width: 36, height: 36, fontSize: 13 }} aria-hidden>
        {r.reviewer_photo_url && !broken
          ? <img className="avatar-photo" src={r.reviewer_photo_url} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />
          : known ? initials(known) : <Icon name="user" size={16} />}
      </span>
      <div className="grow stack-sm" style={{ gap: 6, minWidth: 0 }}>
        <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
          <div className="row wrap grow" style={{ gap: 8, minWidth: 0 }}>
            <strong>{name}</strong>
            <Stars rating={r.rating} />
            <span className="muted small">{formatDate(r.posted_at)}</span>
            <EntityStatus kind="review" status={r.reply_comment ? "replied" : "needs_reply"} />
          </div>
          <Menu
            triggerClassName="btn btn-sm btn-ghost btn-icon"
            label="Review actions"
            items={[
              { label: r.client ? "Match to another client…" : "Match to a client…", icon: "user", onSelect: onMatch },
              { label: "Not this client", icon: "x", hidden: !r.client, onSelect: onNotThem },
              // A 4 or 5-star review with words can be posted as a card (Marketing → Social).
              { label: "Post on social", icon: "share", hidden: (r.rating ?? 0) < 4 || !text.trim(), onSelect: () => navigate(`/marketing?tab=social&compose=review&review=${r.id}`) },
            ]}
          />
        </div>
        {text && (
          <p className="pre-wrap" style={{ margin: 0 }}>
            {long && !more ? `${text.slice(0, LONG).trimEnd()}…` : text}
            {long && <>{" "}<button type="button" className="link-btn small" onClick={() => setMore(!more)}>{more ? "Less" : "More"}</button></>}
          </p>
        )}
        <span className="muted small">
          {r.client ? <><Link to={`/clients/${r.client.id}`}>{r.client.display_name}</Link>{r.match === "auto" ? " · Matched by name" : ""}</> : r.reviewer_anonymous ? "Anonymous, so not matched" : "Not matched to a client"}
        </span>
        <Reply review={r} names={names} live={live} open={highlight && !r.reply_comment} onChanged={onChanged} />
      </div>
    </div>
  );
}

/**
 * A review's reply: the one posted, with who and when, Edit and Delete; or the editor, with Suggest
 * a reply and Rewrite when Claude is set up. Posting and updating say first that everyone can read it.
 * `open` (the review a notification links to, with no reply yet) opens the editor, also when it
 * turns true after the row is already showing.
 */
function Reply({ review: r, names, live, open, onChanged }: { review: Review; names: ReadonlyMap<string, string>; live: boolean; open: boolean; onChanged: () => void }) {
  const session = useSession();
  const [editing, setEditing] = useState(open);
  const [text, setText] = useState(r.reply_comment ?? "");
  useEffect(() => {
    if (open) setEditing(true);
  }, [open]);
  const reviewer = reviewerName(r);
  const aiOn = session.config.features.ai;
  const post = useMutation({
    meta: { inline: true },
    mutationFn: (comment: string) => api.put(`/reviews/${r.id}/reply`, { comment }),
    onSuccess: () => {
      toast.success(r.reply_comment ? "Reply updated on Google" : "Reply posted on Google");
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({
    meta: { inline: true, success: "Reply deleted from Google" },
    mutationFn: () => api.delete(`/reviews/${r.id}/reply`),
    onSuccess: () => {
      setText("");
      onChanged();
    },
  });
  const suggest = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ text: string }>(`/reviews/${r.id}/suggest`, text.trim() ? { draft: text.trim() } : {}),
    onSuccess: (res) => setText(res.text),
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const comment = text.trim();
    if (!comment) return;
    const updating = Boolean(r.reply_comment);
    const ok = await confirm({
      title: updating ? "Update your reply on Google?" : "Post this reply on Google?",
      body: (
        <div className="stack-sm">
          <p style={{ margin: 0 }}>Everyone can read it on Google, under {reviewer ? `${reviewer}'s review` : "the review"}.</p>
          <blockquote className="pre-wrap" style={{ margin: 0, paddingLeft: 12, borderLeft: "3px solid var(--border)" }}>{comment}</blockquote>
        </div>
      ),
      confirmLabel: updating ? "Update reply" : "Post reply",
    });
    if (ok) post.mutate(comment);
  };
  const askDelete = async () => {
    if (await confirm({ title: "Delete your reply on Google?", body: "It comes off the review on Google for everyone. The review stays.", confirmLabel: "Delete reply", danger: true })) remove.mutate();
  };

  if (r.reply_comment && !editing) {
    return (
      <div className="stack-sm" style={{ gap: 4, paddingLeft: 12, borderLeft: "3px solid var(--border)" }}>
        <span className="pre-wrap small">{r.reply_comment}</span>
        <span className="muted small">
          {repliedWords(r, names)}
          {live && <>{" · "}<button type="button" className="link-btn small" onClick={() => { setText(r.reply_comment ?? ""); setEditing(true); }}>Edit</button>{" · "}<button type="button" className="link-btn small" onClick={askDelete}>Delete</button></>}
        </span>
        <FormError error={remove.error} />
      </div>
    );
  }
  if (!live) return null;
  if (!editing) return <Button size="sm" style={{ justifySelf: "start" }} icon="reply" onClick={() => setEditing(true)}>Reply</Button>;
  const canAddKey = hasRole(session, "admin") && can(session, "apps");
  return (
    <form className="stack-sm" onSubmit={submit}>
      <textarea className="textarea" aria-label={reviewer ? `Reply to ${reviewer}` : "Reply to the review"} style={{ minHeight: 90 }} value={text} maxLength={REPLY_MAX} onChange={(e) => setText(e.target.value)} placeholder="Thank them, and keep it short." />
      <div className="row wrap" style={{ gap: 8 }}>
        <Button type="submit" size="sm" variant="primary" loading={post.isPending} disabled={!text.trim()}>{r.reply_comment ? "Update reply" : "Post reply"}</Button>
        <Button size="sm" icon="sparkle" loading={suggest.isPending} disabled={!aiOn} onClick={() => suggest.mutate()}>{text.trim() ? "Rewrite" : "Suggest a reply"}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setText(r.reply_comment ?? ""); }}>Cancel</Button>
        <span className="muted small grow" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{text.length.toLocaleString("en-US")} / {REPLY_MAX.toLocaleString("en-US")}</span>
      </div>
      {!aiOn && (
        <span className="muted small">
          {canAddKey ? <><Link to="/apps/anthropic">Add a Claude key in Apps</Link> to draft replies.</> : "An admin can add a Claude key on the Apps page to draft replies."}
        </span>
      )}
      <FormError error={post.error ?? suggest.error} />
    </form>
  );
}

/** Match to a client: anyone, with the clients whose name fits the reviewer's first. */
function MatchDialog({ review, open, onClose, onExited, onPick }: { review: Review | null; open: boolean; onClose: () => void; onExited: () => void; onPick: (client: { id: string; display_name: string }) => void }) {
  const session = useSession();
  const [picked, setPicked] = useState<PickedClient>(null);
  const reviewer = review ? reviewerName(review) : null;
  const first = firstNameOf(reviewer);
  const suggestions = useQuery({
    queryKey: ["review-suggestions", session.company.id, review?.id],
    enabled: open && Boolean(reviewer) && first.length > 1,
    queryFn: async () => {
      // What tells two clients of the same name apart, as the client picker shows it.
      const rows = unwrap(
        await supabase().from("clients").select("id, display_name, company_name, email, phone, properties(line1)").eq("company_id", session.company.id).ilike("display_name", `${first}%`).order("display_name").limit(20),
      ) as SuggestedClient[];
      return rankSuggestions({ name: review!.reviewer_name, anonymous: review!.reviewer_anonymous }, rows).slice(0, 5);
    },
  });
  const twins = sharedNames(suggestions.data ?? []);
  return (
    <Dialog open={open} onClose={onClose} onExited={() => { setPicked(null); onExited(); }} title="Match to a client" description={review ? `Who left ${reviewer ? `${reviewer}'s review` : "this review"}? They won't be asked for reviews again.` : undefined}>
      <form className="dialog-body stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (picked) onPick({ id: picked.id, display_name: picked.display_name }); }}>
        {(suggestions.data?.length ?? 0) > 0 && (
          <div className="stack-sm" style={{ gap: 6 }}>
            <span className="muted small strong">Names that fit</span>
            {suggestions.data!.map((c) => {
              const detail = clientDetail(c);
              // Two of the same name: a click picks this one below, and Match matches it.
              const twin = twins.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`card-row choice-row${twin && picked?.id === c.id ? " picked" : ""}`}
                  aria-pressed={twin ? picked?.id === c.id : undefined}
                  onClick={() => (twin ? setPicked({ id: c.id, display_name: c.display_name }) : onPick(c))}
                >
                  <Icon name="user" size={16} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    {c.display_name}
                    {detail && <span className="muted small ellipsis" style={{ display: "block" }}>{detail}</span>}
                  </span>
                </button>
              );
            })}
            {twins.size > 0 && <span className="muted small">Two clients have that name: pick the right one, then Match.</span>}
          </div>
        )}
        <ClientPicker value={picked} onChange={setPicked} allowCreate={false} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!picked}>Match</Button>
        </div>
      </form>
    </Dialog>
  );
}
