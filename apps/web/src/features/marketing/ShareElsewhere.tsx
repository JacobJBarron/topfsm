/**
 * Share elsewhere: a small dialog with the post's pictures and caption, for posting anywhere
 * Crewtavo doesn't (X, LinkedIn, Nextdoor). Opening it fetches the pictures; then Share opens the
 * browser's share sheet where it takes files, Copy caption copies, and each picture has its own
 * Download, each in its own tap, as Safari wants (socialShare.ts).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { canShareFiles, downloadFile, shareFiles, shareWithSheet, type ShareSource } from "./socialShare";

export function ShareElsewhere({ post, caption, open, onClose }: { post: ShareSource | null; caption: string; open: boolean; onClose: () => void }) {
  const files = useQuery({
    queryKey: ["social-share", post?.source, post?.review_id, post?.attachment_ids?.join(",")],
    enabled: open && Boolean(post),
    staleTime: 60_000,
    queryFn: () => shareFiles(post!),
  });
  const urls = useMemo(() => (files.data ?? []).map((f) => URL.createObjectURL(f)), [files.data]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const sheet = files.data ? canShareFiles(files.data) || (!files.data.length && typeof navigator !== "undefined" && typeof navigator.share === "function") : false;
  const share = async () => {
    try {
      await shareWithSheet(files.data ?? [], caption);
    } catch (error) {
      // Closing the share sheet isn't a problem.
      if ((error as Error).name !== "AbortError") toast.error("Couldn't open sharing here. Download the pictures and copy the caption instead.");
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Share elsewhere" description="For X, LinkedIn, Nextdoor or anywhere else: the pictures without their location, and the caption.">
      <div className="dialog-body stack">
        {files.isPending && post?.source !== "text" ? (
          <div className="thumbs"><Skeleton height={96} radius={8} /><Skeleton height={96} radius={8} /></div>
        ) : files.error ? (
          <ErrorState compact error={files.error} onRetry={() => files.refetch()} />
        ) : urls.length > 0 ? (
          <div className="thumbs">
            {files.data!.map((file, i) => (
              <div key={file.name} className="stack-sm" style={{ gap: 6 }}>
                <div className="thumb"><img src={urls[i]} alt={`Picture ${i + 1}`} /></div>
                <Button size="sm" icon="download" onClick={() => downloadFile(file)}>Download</Button>
              </div>
            ))}
          </div>
        ) : null}
        {caption.trim() ? <blockquote className="pre-wrap small" style={{ margin: 0, paddingLeft: 12, borderLeft: "3px solid var(--border)" }}>{caption.trim()}</blockquote> : <span className="muted small">No caption yet.</span>}
        <div className="form-actions">
          {caption.trim() && <Button icon="copy" onClick={() => copyText(caption.trim(), "Caption copied. Paste it on X, LinkedIn or Nextdoor.")}>Copy caption</Button>}
          {sheet && <Button variant="primary" icon="share" onClick={share}>Share</Button>}
          {!sheet && <Button variant="ghost" onClick={onClose}><Icon name="check" size={16} />Done</Button>}
        </div>
      </div>
    </Dialog>
  );
}
