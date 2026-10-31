/**
 * New post, and Edit, on Marketing → Social: what to post (photos OK to share, a 4 or 5-star Google
 * review as its card, or words alone), a preview of what posts (the server's own card, or the photos
 * as Instagram gets them when they're padded), the caption with Suggest a caption, where it goes,
 * and when (now, or a date and time in the company's time zone). Save draft, Post now (after a
 * confirm, since it's public) or Schedule post, and Share elsewhere for anywhere Crewtavo doesn't post.
 *
 * Photos picked before it opened (a post being changed, a job's or client's Photos card) are read by
 * id, so they show and can be taken off even when they aren't among the newest; any that can't be
 * posted anymore are taken off, saying why. A network that can't post anymore is taken off the same way.
 */
import { captionLimit, captionProblems, captionProblemWords, GOOGLE_NEEDS_CAPTION, INSTAGRAM_RATIO, MAX_PHOTOS, NETWORK_NAMES, needsCaption, networkWords, PAD_GREY, timeZoneWords, type Network } from "@crewtavo/core/social";
import { parseZonedTime } from "@crewtavo/core/time";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { ShareElsewhere } from "./ShareElsewhere";
import { networkChoices, photoDay, pickedNote, rememberedNetworks, rememberNetworks, socialKey, startingNetworks, withLinks, type PickedPhoto, type SharePhoto, type ShareReview, type SocialPost, type SocialState, type Source } from "./socialData";

export interface ComposerStart {
  source?: Source;
  photos?: string[];
  review?: string;
  job?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** A date and time in the company's time zone, as the inputs take them. */
function zonedParts(at: Date, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${pad2(Number(p.hour))}:${p.minute}` };
}

function Stars({ n }: { n: number }) {
  return <span aria-label={`${n} out of 5 stars`} style={{ color: "#f5b400", letterSpacing: 1 }}>{"★".repeat(n)}<span style={{ color: "var(--border)" }}>{"★".repeat(5 - n)}</span></span>;
}

export function SocialComposer({ open, onClose, state, post, start }: { open: boolean; onClose: () => void; state: SocialState; post?: SocialPost | null; start?: ComposerStart | null }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const editing = Boolean(post);
  const automatic = Boolean(post?.automatic);
  const [source, setSource] = useState<Source>(post?.source ?? start?.source ?? "photos");
  const [startIds] = useState<string[]>(() => (post?.attachment_ids ?? start?.photos ?? []).slice(0, MAX_PHOTOS));
  const [picked, setPicked] = useState<string[]>(startIds);
  const [takenOut, setTakenOut] = useState<string | null>(null);
  const [review, setReview] = useState<string | null>(post?.review_id ?? start?.review ?? null);
  const [job, setJob] = useState<string>(start?.job ?? "");
  const [caption, setCaption] = useState(post?.caption ?? "");
  const [captionBy, setCaptionBy] = useState<"person" | "ai">("person");
  const choices = networkChoices(state, source);
  // A post being changed keeps its networks that can still post; the rest are taken off, saying why.
  const [dropped] = useState(() => (post ? networkChoices(state, post.source).filter((c) => post.networks.includes(c.network) && !c.enabled) : []));
  const [networks, setNetworks] = useState<Network[]>(() =>
    post ? post.networks.filter((n) => !dropped.some((d) => d.network === n)) : startingNetworks(networkChoices(state, start?.source ?? "photos"), rememberedNetworks()));
  const later = post?.scheduled_for ? new Date(post.scheduled_for) : new Date(Date.now() + 86_400_000);
  const [when, setWhen] = useState<"now" | "schedule">(post?.status === "scheduled" ? "schedule" : "now");
  const [day, setDay] = useState(zonedParts(later, tz).date);
  const [time, setTime] = useState(post?.scheduled_for ? zonedParts(later, tz).time : "10:00");
  const [sharing, setSharing] = useState(false);

  // Instagram can't take words alone; a network that can't be chosen isn't kept.
  useEffect(() => {
    setNetworks((now) => now.filter((n) => choices.find((c) => c.network === n)?.enabled));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // The photos picked before it opened, as they are now.
  const pickedNow = useQuery({
    queryKey: [...socialKey(session.company.id), "picked", startIds.join(",")],
    enabled: open && startIds.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await api.get<{ photos: Array<Omit<PickedPhoto, "url">> }>(`/social/photos/picked?ids=${startIds.join(",")}`);
      return { photos: await withLinks(res.photos, (p) => p.path) };
    },
  });
  useEffect(() => {
    const out = (pickedNow.data?.photos ?? []).filter((p) => p.problem);
    if (!out.length) return;
    setPicked((now) => now.filter((id) => !out.some((p) => p.id === id)));
    setTakenOut(pickedNote(out.map((p) => p.problem!)));
  }, [pickedNow.data]);

  const photos = useInfiniteQuery({
    queryKey: [...socialKey(session.company.id), "photos", job],
    enabled: open && source === "photos",
    initialPageParam: null as { at: string; id: string } | null,
    queryFn: async ({ pageParam }) => {
      const page = await api.get<{ photos: Array<Omit<SharePhoto, "url">>; more: boolean }>(`/social/photos?${new URLSearchParams({ ...(pageParam ? { before_at: pageParam.at, before_id: pageParam.id } : {}), ...(job ? { job } : {}) })}`);
      return { ...page, photos: await withLinks(page.photos, (p) => p.path) };
    },
    getNextPageParam: (last) => (last.more && last.photos.length ? { at: last.photos.at(-1)!.created_at, id: last.photos.at(-1)!.id } : undefined),
  });
  const reviews = useInfiniteQuery({
    queryKey: [...socialKey(session.company.id), "reviews"],
    enabled: open && source === "review",
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<{ reviews: ShareReview[]; more: boolean }>(`/social/reviews${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.more && last.reviews.length ? last.reviews.at(-1)!.posted_at : undefined),
  });
  const allPhotos = photos.data?.pages.flatMap((p) => p.photos) ?? [];
  const allReviews = reviews.data?.pages.flatMap((p) => p.reviews) ?? [];
  const jobs = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of allPhotos) if (p.job_id && !seen.has(p.job_id)) seen.set(p.job_id, `Job #${p.job_number ?? ""}${p.job_title ? ` · ${p.job_title}` : ""}`);
    return [...seen.entries()];
  }, [allPhotos]);

  const card = useQuery({
    queryKey: [...socialKey(session.company.id), "card", review],
    enabled: open && source === "review" && Boolean(review),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const blob = await api.blob(`/social/reviews/${review}/card.jpg`);
      return blob ? URL.createObjectURL(blob) : null;
    },
  });

  const limit = captionLimit(networks);
  const problems = captionProblems(caption, networks);
  const meta = networks.includes("facebook") || networks.includes("instagram");
  const notLive = meta && !state.networks.facebook.live_confirmed;
  const aiOn = session.config.features.ai || state.ai;
  const canAddKey = hasRole(session, "admin") && can(session, "apps");
  const noCaption = source !== "text" && needsCaption(caption, networks);
  // Meta and Google fetch the pictures from this server, so on a private address only words alone post.
  const unreachable = source !== "text" && !state.images_public;
  const ready = (source === "photos" ? picked.length > 0 : source === "review" ? Boolean(review) : caption.trim().length > 0) && networks.length > 0 && !problems.length && caption.length <= limit && !noCaption && !unreachable;

  const body = (how: "draft" | "now" | { at: string }) => ({
    source,
    review_id: source === "review" ? review : null,
    attachment_ids: source === "photos" ? picked : [],
    caption,
    caption_by: captionBy,
    networks,
    when: how,
  });
  const save = useMutation({
    meta: { inline: true },
    mutationFn: (how: "draft" | "now" | { at: string }) => (post ? api.patch<{ warnings: string[] }>(`/social/posts/${post.id}`, body(how)) : api.post<{ warnings: string[] }>("/social/posts", body(how))),
    onSuccess: (res, how) => {
      rememberNetworks(networks);
      // A last name on its own may be an everyday word, so it's saved, and said here as the composer closes.
      const warnings = res.warnings ?? [];
      const check = warnings.length ? { description: `Check the caption: "${warnings.join('", "')}" may be a client's name. Captions never name clients.`, duration: 10_000 } : undefined;
      toast.success(how === "draft" ? "Draft saved" : how === "now" ? `Posting to ${networkWords(networks)}` : "Post scheduled", check);
      queryClient.invalidateQueries({ queryKey: socialKey(session.company.id) });
      onClose();
    },
  });
  const suggest = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ text: string; warning: string | null }>("/social/caption", { source, review_id: review, attachment_ids: picked, ...(caption.trim() ? { draft: caption.trim() } : {}) }),
    onSuccess: (res) => {
      setCaption(res.text);
      setCaptionBy("ai");
      if (res.warning) toast.info(res.warning);
    },
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (when === "now") {
      const hidden = networkWords(networks.filter((n) => n !== "google"));
      const ok = await confirm({ title: "Post this now?", body: `This posts publicly on ${networkWords(networks)}.${notLive ? ` Until your Meta app is Live, only you can see it on ${hidden}.` : ""}`, confirmLabel: "Post now" });
      if (ok) save.mutate("now");
      return;
    }
    const at = parseZonedTime(day, time, tz);
    if (!at) return toast.error("Pick a date and time.");
    save.mutate({ at: at.toISOString() });
  };

  const toggle = (id: string) => setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : now.length >= MAX_PHOTOS ? now : [...now, id]));
  const pickedPhotos = picked
    .map((id): Pick<SharePhoto, "id" | "url"> | undefined => allPhotos.find((p) => p.id === id) ?? pickedNow.data?.photos.find((p) => p.id === id && !p.problem))
    .filter((p): p is Pick<SharePhoto, "id" | "url"> => Boolean(p));
  const shownReviews = automatic ? allReviews.filter((r) => r.id === review) : allReviews;

  return (
    <>
      {/* Photos come first, so it doesn't open in the caption. */}
      <Dialog open={open && !sharing} onClose={onClose} size="lg" focusField={false} title={editing ? "Edit post" : "New post"} description={automatic ? "An automatic post of a 5-star review. Change its caption, where it goes or when." : undefined}>
        <form className="dialog-body stack" onSubmit={submit}>
          {!automatic && (
            <div className="segmented" role="group" aria-label="What to post" style={{ justifySelf: "start" }}>
              <button type="button" aria-pressed={source === "photos"} onClick={() => setSource("photos")}><Icon name="camera" size={14} />Photos</button>
              <button type="button" aria-pressed={source === "review"} onClick={() => setSource("review")}><Icon name="star" size={14} />A review</button>
              <button type="button" aria-pressed={source === "text"} onClick={() => setSource("text")}><Icon name="edit" size={14} />Just text</button>
            </div>
          )}

          {source === "photos" && (
            <section className="stack-sm" aria-label="Photos">
              <div className="row-between wrap" style={{ gap: 8 }}>
                <span className="muted small">{picked.length} of {MAX_PHOTOS} at most. Check the photo doesn't show a house number, a car plate or people's faces.</span>
                {takenOut && <span className="muted small" role="status">{takenOut}</span>}
                {(jobs.length > 1 || job) && (
                  <select className="select" style={{ maxWidth: 260 }} aria-label="Job" value={job} onChange={(e) => setJob(e.target.value)}>
                    <option value="">All jobs</option>
                    {job && !jobs.some(([id]) => id === job) && <option value={job}>This job</option>}
                    {jobs.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                )}
              </div>
              {photos.isPending ? (
                <div className="thumbs">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={96} radius={8} />)}</div>
              ) : photos.error ? (
                <ErrorState compact error={photos.error} onRetry={() => photos.refetch()} />
              ) : !allPhotos.length ? (
                <EmptyState inline icon="camera" title="No photos are OK to share yet">Mark them on a job's or visit's photos.</EmptyState>
              ) : (
                <>
                  <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))" }}>
                    {allPhotos.map((p) => {
                      const on = picked.includes(p.id);
                      return (
                        <div key={p.id} className="stack-sm" style={{ gap: 2 }}>
                          <div className="thumb">
                            {p.url && <img src={p.url} alt="" loading="lazy" />}
                            <button type="button" className="thumb-pick" aria-pressed={on} disabled={!on && picked.length >= MAX_PHOTOS} aria-label={`Photo from ${p.job_number != null ? `job #${p.job_number}` : "a client"}, ${formatDate(p.visit_on ?? p.created_at)}`} onClick={() => toggle(p.id)}>
                              <span className="thumb-pick-badge"><Icon name="check" size={13} strokeWidth={3} /></span>
                            </button>
                          </div>
                          <span className="muted small ellipsis">{p.job_number != null ? `Job #${p.job_number} · ` : ""}{photoDay(p, tz)}</span>
                        </div>
                      );
                    })}
                  </div>
                  {photos.hasNextPage && <Button size="sm" variant="ghost" style={{ justifySelf: "start" }} loading={photos.isFetchingNextPage} onClick={() => photos.fetchNextPage()}>Load more</Button>}
                </>
              )}
            </section>
          )}

          {source === "review" && (
            <section className="stack-sm" aria-label="Reviews">
              {reviews.isPending ? (
                <Skeleton height={64} />
              ) : reviews.error ? (
                <ErrorState compact error={reviews.error} onRetry={() => reviews.refetch()} />
              ) : !allReviews.length && !automatic ? (
                <EmptyState inline icon="star" title="No 4 or 5-star reviews with words yet">They come in from Google Business Profile.</EmptyState>
              ) : (
                <div className="stack-sm" style={{ maxHeight: 280, overflow: "auto" }}>
                  {automatic && <span className="muted small">An automatic post keeps its review. To share another one, make a new post.</span>}
                  {shownReviews.map((r) => {
                    const blocked = !r.card_ok || r.mentions_client || automatic;
                    return (
                      <label key={r.id} className={`card-row choice-row${review === r.id ? " picked" : ""}`} style={{ cursor: automatic ? "default" : blocked ? "not-allowed" : "pointer", alignItems: "flex-start" }}>
                        {!automatic && <input type="radio" name="social-review" checked={review === r.id} disabled={blocked} onChange={() => setReview(r.id)} />}
                        <span className="grow stack-sm" style={{ gap: 2, minWidth: 0 }}>
                          <span className="row wrap" style={{ gap: 8 }}><Stars n={r.rating} /><strong>{r.name ?? "A Google user"}</strong><span className="muted small">{formatDate(r.posted_at)}</span>{r.posted_on && <span className="chip">Posted {formatDate(r.posted_on)}</span>}</span>
                          <ReviewWords text={r.comment ?? ""} />
                          {!r.card_ok && <span className="muted small">This review has characters the card can't show yet.</span>}
                          {r.card_ok && r.card_drops_emoji && <span className="muted small">The card leaves out its emoji.</span>}
                          {r.card_ok && r.mentions_client && <span className="muted small">This review names the client or their street, so it isn't offered as a card.</span>}
                        </span>
                      </label>
                    );
                  })}
                  {reviews.hasNextPage && !automatic && <Button size="sm" variant="ghost" style={{ justifySelf: "start" }} loading={reviews.isFetchingNextPage} onClick={() => reviews.fetchNextPage()}>Load more</Button>}
                </div>
              )}
            </section>
          )}

          {(source === "review" ? Boolean(review) : pickedPhotos.length > 0) && (
            <section className="stack-sm" aria-label="Preview">
              <strong className="small">Preview</strong>
              {source === "review" ? (
                <>
                  {card.isPending ? <Skeleton width={220} height={220} radius={8} /> : card.data ? <img src={card.data} alt="The review's card, as it posts" style={{ width: 220, height: 220, borderRadius: 8, border: "1px solid var(--border)" }} /> : <ErrorState compact error={card.error} onRetry={() => card.refetch()} />}
                  {allReviews.find((r) => r.id === review)?.card_drops_emoji && <span className="muted small">The card leaves out the review's emoji: its font can't draw them.</span>}
                </>
              ) : (
                <PhotoPreview photos={pickedPhotos} instagram={networks.includes("instagram")} onRemove={(id) => setPicked((now) => now.filter((x) => x !== id))} />
              )}
            </section>
          )}

          <section className="stack-sm" aria-label="Caption">
            <label className="field">
              <span>{source === "text" ? "What to post" : "Caption"}</span>
              <textarea className="textarea" style={{ minHeight: 110 }} value={caption} maxLength={2200} onChange={(e) => { setCaption(e.target.value); setCaptionBy("person"); }} placeholder={source === "text" ? "Booking spring cleanups now. Reply to get on the list." : "A few friendly words about the work."} />
            </label>
            <div className="row wrap" style={{ gap: 8 }}>
              <Button size="sm" icon="sparkle" loading={suggest.isPending} disabled={!aiOn || (source === "photos" && !picked.length) || (source === "review" && !review)} onClick={() => suggest.mutate()}>{caption.trim() ? "Rewrite" : "Suggest a caption"}</Button>
              <span className="muted small grow" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{caption.length.toLocaleString("en-US")} / {limit.toLocaleString("en-US")}</span>
            </div>
            {!aiOn && (
              <span className="muted small">
                {canAddKey ? <><Link to="/apps/anthropic">Add a Claude key in Apps</Link> to draft captions.</> : "An admin can add a Claude key on the Apps page to draft captions."}
              </span>
            )}
            {problems.map((p) => <span key={`${p.network}-${p.kind}`} className="field-error">{captionProblemWords(p)}</span>)}
            {noCaption && <span className="muted small">{GOOGLE_NEEDS_CAPTION} Write one, or leave Google off.</span>}
            <span className="muted small">Captions never name clients or addresses.</span>
          </section>

          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small strong" style={{ marginBottom: 6 }}>Where it posts</legend>
            {dropped.length > 0 && (
              <span className="muted small" role="status">
                {networkWords(dropped.map((d) => d.network))} {dropped.length === 1 ? "was" : "were"} taken off this post: {dropped[0]!.reason}
              </span>
            )}
            {choices.map((c) => (
              <label key={c.network} className="checkbox">
                <input type="checkbox" checked={networks.includes(c.network)} disabled={!c.enabled} onChange={(e) => setNetworks((now) => (e.target.checked ? [...now, c.network] : now.filter((n) => n !== c.network)))} />
                <span>
                  {c.label}
                  {c.network === "facebook" && state.networks.facebook.page_name ? <span className="muted"> · {state.networks.facebook.page_name}</span> : null}
                  {c.network === "instagram" && state.networks.instagram.username ? <span className="muted"> · @{state.networks.instagram.username}</span> : null}
                  {c.reason && <span className="muted small" style={{ display: "block", fontWeight: 400 }}>{c.reason}</span>}
                </span>
              </label>
            ))}
            {notLive && (
              <div className="callout callout-warning"><Icon name="alert" size={20} /><div className="grow">Posts stay hidden from the public until your Meta app is Live.</div></div>
            )}
          </fieldset>

          <section className="stack-sm" aria-label="When">
            <div className="segmented" role="group" aria-label="When it posts" style={{ justifySelf: "start" }}>
              <button type="button" aria-pressed={when === "now"} onClick={() => setWhen("now")}>Post now</button>
              <button type="button" aria-pressed={when === "schedule"} onClick={() => setWhen("schedule")}>Schedule</button>
            </div>
            {when === "schedule" && (
              <div className="row wrap" style={{ gap: 8, alignItems: "flex-end" }}>
                <label className="field"><span>Date</span><input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} required /></label>
                <label className="field"><span>Time</span><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required /></label>
                <span className="muted small" style={{ paddingBottom: 10 }}>{timeZoneWords(tz)}</span>
              </div>
            )}
          </section>

          {unreachable && (
            <div className="callout callout-warning">
              <Icon name="alert" size={20} />
              <div className="grow">Crewtavo's address isn't public, so Meta and Google can't fetch the pictures. Save it as a draft, or use Share elsewhere. Words alone can still post.</div>
            </div>
          )}
          <FormError error={save.error ?? suggest.error} />
          <div className="form-actions">
            <Button variant="ghost" icon="share" disabled={source === "photos" ? !picked.length : source === "review" ? !review : !caption.trim()} onClick={() => setSharing(true)}>Share elsewhere</Button>
            <span className="grow" />
            <Button loading={save.isPending && save.variables === "draft"} disabled={source === "photos" ? !picked.length : source === "review" ? !review : !caption.trim()} onClick={() => save.mutate("draft")}>Save draft</Button>
            <Button type="submit" variant="primary" loading={save.isPending && save.variables !== "draft"} disabled={!ready}>{when === "now" ? "Post now" : "Schedule post"}</Button>
          </div>
        </form>
      </Dialog>
      <ShareElsewhere
        open={open && sharing}
        onClose={() => setSharing(false)}
        caption={caption}
        post={{ source, review_id: review, attachment_ids: picked }}
      />
    </>
  );
}

/** A review's words, with More for a long one. */
function ReviewWords({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > 220;
  return (
    <span className="small pre-wrap">
      {long && !all ? `${text.slice(0, 200).trimEnd()}…` : text}
      {long && <>{" "}<button type="button" className="link-btn small" onClick={(e) => { e.preventDefault(); setAll(!all); }}>{all ? "Less" : "More"}</button></>}
    </span>
  );
}

/**
 * The photos as they post. With Instagram, as Instagram gets them: one photo outside its shapes (4:5
 * to 1.91:1) padded into them, several padded to squares, in the brand colour or a light grey.
 */
function PhotoPreview({ photos, instagram, onRemove }: { photos: Array<Pick<SharePhoto, "id" | "url">>; instagram: boolean; onRemove: (id: string) => void }) {
  const session = useSession();
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const brand = (session.company.settings as { branding?: { color?: string } } | null)?.branding?.color;
  const pad = brand && /^#[0-9a-f]{6}$/i.test(brand) ? brand : PAD_GREY;
  const frame = (p: Pick<SharePhoto, "id">) => {
    if (!instagram) return undefined;
    if (photos.length > 1) return 1;
    const r = ratios[p.id];
    return r ? Math.min(INSTAGRAM_RATIO.max, Math.max(INSTAGRAM_RATIO.min, r)) : undefined;
  };
  const padded = instagram && photos.some((p) => {
    const r = ratios[p.id];
    return r && (photos.length > 1 ? Math.abs(r - 1) > 0.01 : r < INSTAGRAM_RATIO.min || r > INSTAGRAM_RATIO.max);
  });
  return (
    <div className="stack-sm" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8, overflowX: "auto" }}>
        {photos.map((p, i) => (
          <div key={p.id} className="thumb" style={{ height: 150, aspectRatio: frame(p) ?? ratios[p.id] ?? 1, background: instagram ? pad : "var(--fill-2)", borderRadius: 8, flex: "none", display: "grid", placeItems: "center" }}>
            {p.url && <img src={p.url} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} onLoad={(e) => { const img = e.currentTarget; setRatios((now) => ({ ...now, [p.id]: img.naturalWidth / img.naturalHeight })); }} />}
            <button type="button" className="thumb-x" aria-label={`Take photo ${i + 1} off this post`} onClick={() => onRemove(p.id)}><Icon name="x" size={12} strokeWidth={2} /></button>
          </div>
        ))}
      </div>
      {padded && <span className="muted small">{photos.length > 1 ? "Instagram shows a carousel's photos square, so they're padded to fit." : `Instagram shows this photo padded to fit its shapes, in ${NETWORK_NAMES.instagram}'s feed.`}</span>}
    </div>
  );
}
