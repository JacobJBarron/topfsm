import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { afterExit, announceTopLayer } from "@/lib/motion";
import { Icon } from "./Icon";

/**
 * Modal built on native <dialog>: the browser handles focus trapping, Escape and the backdrop.
 * Renders the title and a close button; children are usually a <form> (or a .dialog-body div).
 * Once closed it keeps showing what it showed last until it has animated out, then calls onExited.
 */
export function Dialog({
  open,
  onClose,
  onExited,
  title,
  description,
  size = "md",
  focusField = true,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** After it has closed and finished animating out: the time to clear what it showed. */
  onExited?: () => void;
  title: string;
  description?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** False when its first field isn't where to start (a composer that starts with picking photos). */
  focusField?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Leaving starts in the same render that closes it, so the content never blinks out first.
  const [wasOpen, setWasOpen] = useState(open);
  const [leaving, setLeaving] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    setLeaving(!open);
  }
  // The caller often clears what's inside as it closes; the exit plays on what was last shown.
  const shown = useRef({ title, description, children });
  if (open) shown.current = { title, description, children };
  const exited = useRef(onExited);
  exited.current = onExited;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      announceTopLayer();
      // Start typing straight away on desktop; on phones don't pop the keyboard over the sheet.
      const finePointer = window.matchMedia("(pointer: fine)").matches;
      const target = finePointer && focusField
        ? bodyRef.current?.querySelector<HTMLElement>('[autofocus], input:not([type="hidden"]):not([disabled]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), select:not([disabled])')
        : null;
      (target ?? dialog).focus({ preventScroll: true });
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!leaving || !dialog) return;
    return afterExit(dialog, () => {
      setLeaving(false);
      exited.current?.();
    });
  }, [leaving]);

  // No close() on unmount: removing an open <dialog> takes it out of the top layer by itself, and
  // calling close() here would fire onClose during React's development double-mount.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) leaveInPlace(dialog);
    };
  }, []);

  const view = shown.current;
  return (
    <dialog
      ref={ref}
      className={["dialog", size !== "md" && `dialog-${size}`, className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      tabIndex={-1}
      // The close event arrives a moment after close(): by then it may have opened again (the next
      // confirmation in the same dialog), and that one mustn't be closed with it.
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {(open || leaving) && (
        <>
          <header className="dialog-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 id={titleId}>{view.title}</h2>
              {view.description && <p>{view.description}</p>}
            </div>
            <button type="button" className="icon-btn dialog-close" aria-label="Close" onClick={onClose}>
              <Icon name="x" size={20} />
            </button>
          </header>
          <div ref={bodyRef} className="dialog-content">{view.children}</div>
        </>
      )}
    </dialog>
  );
}

/**
 * Most dialogs close by not being rendered any more ({editing && <EditDialog open />}), which would
 * take them off the screen at once. So a copy is left where it was, inert and over a copy of the
 * backdrop, plays the same exit and is removed. It's taken while the dialog is still in the page
 * (scroll positions, a signature on a canvas) and put in only once React has really removed it,
 * not for its development double-mount.
 */
function leaveInPlace(dialog: HTMLDialogElement) {
  const ghost = dialog.cloneNode(true) as HTMLDialogElement;
  const from = [dialog, ...dialog.querySelectorAll<HTMLElement>("*")];
  const scrolled = from.flatMap((el, i) => (el.scrollTop || el.scrollLeft ? [{ i, top: el.scrollTop, left: el.scrollLeft }] : []));
  const canvases = Array.from(dialog.querySelectorAll("canvas"));
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  // A copied frame or video would load all over again.
  ghost.querySelectorAll("iframe, video, audio, source, embed").forEach((el) => el.removeAttribute("src"));
  ghost.querySelectorAll("object").forEach((el) => el.removeAttribute("data"));
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-ghost-backdrop";
  queueMicrotask(() => {
    if (dialog.isConnected) return;
    ghost.style.transition = "none";
    document.body.append(backdrop, ghost);
    const to = [ghost, ...ghost.querySelectorAll<HTMLElement>("*")];
    for (const { i, top, left } of scrolled) to[i]?.scrollTo(left, top);
    ghost.querySelectorAll("canvas").forEach((canvas, i) => {
      try {
        if (canvases[i]) canvas.getContext("2d")?.drawImage(canvases[i], 0, 0);
      } catch {
        // A canvas drawn some other way just shows blank as it fades.
      }
    });
    // Shown as it was first, then let go, so it transitions out rather than in.
    ghost.getBoundingClientRect();
    ghost.style.removeProperty("transition");
    ghost.removeAttribute("open");
    afterExit(ghost, () => {
      ghost.remove();
      backdrop.remove();
    });
  });
}
