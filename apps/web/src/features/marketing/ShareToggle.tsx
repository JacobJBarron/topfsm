/**
 * OK to share on a photo (docs/marketing-plan.md, phase E): a 44 px tap target in the thumbnail's
 * bottom-left corner with a small badge, a green check once it's on, as the remove button sits in the
 * top-right. The office may then post the photo from Marketing → Social. Its label stays "OK to
 * share" and aria-pressed says whether it is.
 *
 * It's a field action (lib/offline.ts, "photo-share"): with no signal it's kept on the phone and sent
 * once there is, as a visit's notes are. Not shown while Marketing is uninstalled, to subs, or for a
 * client who said no (which is said instead). A photo that can't be posted (only JPEG and PNG can)
 * gets a "Can't share" label in its place, so the crew can tell which one it is.
 */
import { canShareType, CLIENT_OPT_OUT } from "@crewtavo/core/social";
import { onlineManager, useMutation } from "@tanstack/react-query";
import { featureOn } from "@/components/shell/nav";
import { Icon } from "@/components/ui/Icon";
import { FIELD_SCOPE } from "@/lib/offline";
import { isSub, useSession, type Session } from "@/lib/session";
import { toast } from "@/lib/toast";
import type { PhotoShareChange } from "../field/fieldActions";

export interface ShareablePhoto {
  id: string;
  content_type: string | null;
  shareable: boolean;
}

/** Whether a photo's OK to share shows: hidden (Marketing off, or a sub), unsupported (not JPEG or PNG), opted_out, or ready. */
export function shareToggleState(session: Pick<Session, "role"> & { company: { settings: unknown } }, photo: Pick<ShareablePhoto, "content_type">, clientOptOut = false): "hidden" | "unsupported" | "opted_out" | "ready" {
  if (isSub(session) || !featureOn(session.company.settings as Record<string, unknown> | null, "marketing")) return "hidden";
  if (!canShareType(photo.content_type)) return "unsupported";
  return clientOptOut ? "opted_out" : "ready";
}

/** The words for a photo that can't be OK to share. */
export const SHARE_NOTES = { unsupported: "Can't be posted: JPEG or PNG only", opted_out: CLIENT_OPT_OUT } as const;

/**
 * The button itself. `onShown` puts the change on the screen at once (and back if it's refused);
 * the parent keeps the photo's list.
 */
export function ShareToggle({ photo, clientOptOut = false, onShown }: { photo: ShareablePhoto; clientOptOut?: boolean; onShown: (shareable: boolean) => void }) {
  const session = useSession();
  const toggle = useMutation({
    mutationKey: ["photo-share"],
    scope: FIELD_SCOPE,
    meta: { inline: true },
    onMutate: (change: PhotoShareChange) => {
      if (!onlineManager.isOnline()) toast.info("Saved on this phone", { description: "It sends when you have signal." });
      onShown(change.shareable);
    },
    onError: (error, change) => {
      onShown(!change.shareable);
      toast.error((error as Error).message);
    },
  });
  const state = shareToggleState(session, photo, clientOptOut);
  if (state === "unsupported") return <span className="thumb-noshare" title={SHARE_NOTES.unsupported}>Can't share</span>;
  if (state !== "ready") return null;
  return (
    <button
      type="button"
      className="thumb-share"
      aria-label="OK to share"
      aria-pressed={photo.shareable}
      title={photo.shareable ? "OK to share: the office can post it" : "Mark OK to share"}
      onClick={() => toggle.mutate({ attachmentId: photo.id, shareable: !photo.shareable, companyId: session.company.id })}
    >
      <span className="thumb-share-badge">{photo.shareable ? <Icon name="check" size={12} strokeWidth={3} /> : <Icon name="share" size={11} />}</span>
    </button>
  );
}
