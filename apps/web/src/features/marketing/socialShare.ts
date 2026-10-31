/**
 * Share elsewhere (X, LinkedIn, Nextdoor or anywhere): a post's pictures as the server makes them for
 * posting (turned, shrunk, without EXIF; a review as its card) and its caption. The browser's own
 * share sheet takes them where it can share files; otherwise each picture downloads and the caption
 * is copied. Safari only shares or copies straight from a tap, so the files are fetched first, when
 * the dialog opens, and each button does one thing in its own tap (ShareElsewhere.tsx).
 */
import { api } from "@/lib/api";

export interface ShareSource {
  source: "photos" | "review" | "text";
  review_id?: string | null;
  attachment_ids?: readonly string[];
}

/** The post's pictures as files, ready to share. None for words alone. */
export async function shareFiles(post: ShareSource): Promise<File[]> {
  const paths = post.source === "review" && post.review_id
    ? [`/social/reviews/${post.review_id}/card.jpg`]
    : post.source === "photos" ? (post.attachment_ids ?? []).map((id) => `/social/image/${id}`) : [];
  const files: File[] = [];
  for (const [i, path] of paths.entries()) {
    const blob = await api.blob(path);
    if (blob) files.push(new File([blob], paths.length === 1 ? "post.jpg" : `post-${i + 1}.jpg`, { type: "image/jpeg" }));
  }
  return files;
}

type Sharer = Pick<Navigator, "share"> & { canShare?: (data?: ShareData) => boolean };

/** Whether this browser's share sheet takes these files (iPhone, iPad and Android do; most desktops don't). */
export function canShareFiles(files: readonly File[], nav: Partial<Sharer> | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  if (!nav || typeof nav.canShare !== "function" || typeof nav.share !== "function") return false;
  try {
    return nav.canShare({ files: [...files] });
  } catch {
    return false;
  }
}

/** The share sheet, with the pictures and the caption. Call it straight from a tap. */
export function shareWithSheet(files: readonly File[], caption: string, nav: Sharer = navigator): Promise<void> {
  return nav.share({ files: [...files], ...(caption.trim() ? { text: caption.trim() } : {}) });
}

/** One picture saved to the device. */
export function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}
