/**
 * A job's or a client's photos for the office (record_photos): the job's own, its visits' and its
 * quote's, or everything that's the client's, grouped by visit, with OK to share on each (while
 * Marketing is installed) and Open. For the office with the marketing area, Mark all OK to share
 * (skipping photos that can't be posted, with a count, and carrying on past one that's refused, which
 * it says) and Post these photos, which opens Marketing → Social's composer with them picked.
 */
import { CANT_SHARE, CLIENT_OPT_OUT, MAX_PHOTOS, type CantShare } from "@crewtavo/core/social";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { signedUrls } from "@/lib/files";
import { formatDate } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { setPhotoShareable } from "../field/fieldActions";
import { SHARE_NOTES, ShareToggle, shareToggleState } from "../marketing/ShareToggle";

interface RecordPhoto {
  id: string;
  path: string;
  file_name: string;
  content_type: string | null;
  created_at: string;
  shareable: boolean;
  owner_type: string;
  job_id: string | null;
  job_number: number | null;
  job_title: string | null;
  visit_id: string | null;
  visit_on: string | null;
  can_share: boolean;
  cant_share: string | null;
  url: string | null;
}

/**
 * Photos grouped by the visit they're from (or the job, quote or client they're on), newest first.
 * On a client's page each group names its job; on the job's own page it would only repeat it.
 */
export function groupPhotos(photos: readonly RecordPhoto[], withJob = true): Array<{ key: string; title: string; jobId: string | null; photos: RecordPhoto[] }> {
  const groups = new Map<string, { key: string; title: string; jobId: string | null; photos: RecordPhoto[] }>();
  for (const p of photos) {
    const key = p.visit_id ?? `${p.owner_type}:${p.job_id ?? "none"}`;
    const title = p.visit_on ? `Visit on ${formatDate(p.visit_on)}` : p.owner_type === "quote" ? "From the quote" : p.owner_type === "job" ? "On the job" : "On the client";
    const job = withJob && p.job_number != null ? ` · Job #${p.job_number}` : "";
    if (!groups.has(key)) groups.set(key, { key, title: `${title}${job}`, jobId: p.job_id, photos: [] });
    groups.get(key)!.photos.push(p);
  }
  return [...groups.values()];
}

/** "3 photos marked OK to share. 1 photo can't be posted, so it was left as it is" */
export function markedWords(marked: number, skipped: number): string {
  const done = `${marked === 1 ? "1 photo" : `${marked} photos`} marked OK to share`;
  if (!skipped) return done;
  return `${done}. ${skipped === 1 ? "1 photo can't be posted, so it was left as it is" : `${skipped} photos can't be posted, so they were left as they are`}`;
}

export function PhotosCard(props: { jobId: string } | { clientId: string }) {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const jobId = "jobId" in props ? props.jobId : null;
  const clientId = "clientId" in props ? props.clientId : null;
  const key = ["record-photos", session.company.id, jobId ?? clientId];
  const [marking, setMarking] = useState(false);
  const photos = useQuery({
    queryKey: key,
    queryFn: async () => {
      const rows = unwrap(await supabase().rpc("record_photos", { p_company: session.company.id, p_job: jobId ?? undefined, p_client: clientId ?? undefined })) as unknown as Omit<RecordPhoto, "url">[];
      const urls = await signedUrls(rows.map((r) => r.path)).catch(() => ({}) as Record<string, string>);
      return rows.map((r): RecordPhoto => ({ ...r, url: urls[r.path] ?? null }));
    },
  });
  const show = (id: string, shareable: boolean) => queryClient.setQueryData<RecordPhoto[]>(key, (rows) => rows?.map((r) => (r.id === id ? { ...r, shareable } : r)));
  const marketing = featureOn(session.company.settings, "marketing");
  const posts = marketing && hasRole(session, "admin", "office") && can(session, "marketing");
  const rows = photos.data ?? [];
  const markable = rows.filter((p) => p.can_share && !p.shareable && shareToggleState(session, p) === "ready");
  const skipped = rows.filter((p) => !p.can_share).length;
  const shared = rows.filter((p) => p.shareable && p.can_share);
  const markAll = useMutation({
    meta: { inline: true },
    // Counted as it goes: show() changes the list markable comes from, so it can't be counted after.
    mutationFn: async (): Promise<{ marked: number; skipped: number }> => {
      setMarking(true);
      const todo = [...markable];
      const left = skipped;
      const refused: string[] = [];
      for (const p of todo) {
        try {
          await setPhotoShareable({ attachmentId: p.id, shareable: true, companyId: session.company.id });
          show(p.id, true);
        } catch (error) {
          refused.push(errorMessage(error));
        }
      }
      const marked = todo.length - refused.length;
      if (refused.length) {
        throw new Error(`${marked === 1 ? "1 photo was" : `${marked} photos were`} marked OK to share. ${refused.length === 1 ? "1 wasn't" : `${refused.length} weren't`}: ${refused[0]}`);
      }
      return { marked, skipped: left };
    },
    onSuccess: (res) => toast.success(markedWords(res.marked, res.skipped)),
    onSettled: () => {
      setMarking(false);
      queryClient.invalidateQueries({ queryKey: key });
    },
  });
  // Said once for the card: every photo here is the same client's.
  const optedOut = rows.some((p) => p.cant_share === "client_opt_out") && shareToggleState(session, { content_type: "image/jpeg" }) !== "hidden";
  const postThese = () => navigate(`/marketing?tab=social&compose=photos&photos=${shared.slice(0, MAX_PHOTOS).map((p) => p.id).join(",")}${jobId ? `&job=${jobId}` : ""}`);

  return (
    <section className="stack" aria-labelledby={`photos-${jobId ?? clientId}`}>
      <div className="section-head">
        <h2 id={`photos-${jobId ?? clientId}`} className="section-title">Photos</h2>
        {posts && rows.length > 0 && (
          <div className="row wrap" style={{ gap: 8 }}>
            {markable.length > 0 && <Button size="sm" variant="ghost" loading={marking} onClick={() => markAll.mutate()}>Mark all OK to share</Button>}
            {shared.length > 0 && <Button size="sm" icon="share" onClick={postThese}>Post these photos</Button>}
          </div>
        )}
      </div>
      <div className="card card-pad stack">
        {photos.isPending ? (
          <div className="thumbs">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={120} radius={8} />)}</div>
        ) : photos.error ? (
          <ErrorState compact error={photos.error} onRetry={() => photos.refetch()} />
        ) : !rows.length ? (
          <EmptyState inline title="No photos yet">Photos the crew takes on visits show here.</EmptyState>
        ) : (
          groupPhotos(rows, Boolean(clientId)).map((group) => (
            <div key={group.key} className="stack-sm">
              <div className="row-between">
                <strong className="small">{group.title}</strong>
                {clientId && group.jobId && <Link className="small" to={`/jobs/${group.jobId}`}>Open job</Link>}
              </div>
              <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
                {group.photos.map((p) => {
                  const state = shareToggleState(session, p, p.cant_share === "client_opt_out");
                  const note = !p.can_share && p.cant_share && p.cant_share !== "client_opt_out" && state !== "hidden" ? (p.cant_share === "format" ? SHARE_NOTES.unsupported : CANT_SHARE[p.cant_share as CantShare]) : null;
                  return (
                    <div key={p.id} className="stack-sm" style={{ gap: 4 }}>
                      <div className="thumb">
                        {p.url ? <a href={p.url} target="_blank" rel="noreferrer" aria-label={`Open ${p.file_name}`}><img src={p.url} alt={p.file_name} loading="lazy" /></a> : <span className="muted small">Unavailable</span>}
                        {p.can_share && <ShareToggle photo={p} onShown={(shareable) => show(p.id, shareable)} />}
                      </div>
                      {p.shareable && p.can_share && state === "ready" && <span className="chip chip-green" style={{ justifySelf: "start" }}>OK to share</span>}
                      {note && <span className="muted small">{note}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
        <FormError error={markAll.error} />
        {optedOut && <span className="muted small">{CLIENT_OPT_OUT} Their photos stay out of Marketing → Social.</span>}
        {marketing && rows.some((p) => p.can_share) && <span className="muted small">Photos marked OK to share can be posted from Marketing → Social. Check a photo doesn't show a house number, a car plate or people's faces.</span>}
      </div>
    </section>
  );
}
