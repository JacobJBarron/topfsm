import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { dismissToast, getToasts, subscribeToasts, type ToastItem } from "@/lib/toast";
import { Icon } from "./Icon";

const supportsPopover = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;
/** How far each older toast peeks out above the one in front, and the gap between them fanned out. */
const PEEK = 10;
const GAP = 8;
/** A toast's height until it has been measured. */
const GUESS = 52;
/** How far a toast has to be swiped sideways for letting go to dismiss it. */
const SWIPE = 80;

const coarsePointer = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
/** Focus that came from the keyboard (a click on a toast's button shouldn't hold the stack open). */
const keyboardFocus = (el: Element) => {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
};

const lessMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** In like --dur-slow with --ease-spring, out like --dur-exit with --ease-exit. */
const ENTER: KeyframeAnimationOptions = { duration: 320, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)" };
const EXIT: KeyframeAnimationOptions = { duration: 180, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "forwards" };

/**
 * A toast's entrance or exit, with Web Animations: raising the toaster again hides and shows it,
 * which would replay a CSS animation. With less motion it only fades.
 */
function animate(node: HTMLElement, from: Keyframe, to: Keyframe, options: KeyframeAnimationOptions) {
  if (typeof node.animate !== "function") return;
  node.animate(lessMotion() ? [{ opacity: from.opacity }, { opacity: to.opacity }] : [from, to], options);
}

/**
 * Renders toasts in the browser's top layer (popover), so they appear above open dialogs.
 * Re-raised whenever a toast is added, and when a dialog or the command palette opens
 * ("crewtavo:toplayer"), so it stacks above anything opened since.
 *
 * Two or more stack up, newest in front with up to two older ones peeking behind it, and fan out
 * into a list while hovered, tabbed into or (on a touch screen) tapped. Their timers wait meanwhile.
 */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  const ref = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const count = toasts.length;
  const countRef = useRef(count);
  countRef.current = count;
  const showing = toasts.filter((t) => !t.leaving).length;
  const paused = hovered || focused || tapped;
  const expanded = showing > 1 && paused;

  const raise = useCallback(() => {
    const el = ref.current;
    if (!el || !supportsPopover) return;
    try {
      if (el.matches(":popover-open")) el.hidePopover();
      if (countRef.current) el.showPopover();
    } catch {
      // Older browsers: the fallback attribute keeps it visible as a fixed element.
    }
  }, []);

  useLayoutEffect(raise, [count, toasts[count - 1]?.id, raise]);

  useEffect(() => {
    window.addEventListener("crewtavo:toplayer", raise);
    return () => window.removeEventListener("crewtavo:toplayer", raise);
  }, [raise]);

  // Nothing showing: a hidden toaster never hears the pointer leave, so start the next toast fresh.
  useEffect(() => {
    if (!count) {
      setHovered(false);
      setFocused(false);
      setTapped(false);
      setHeights({});
    } else if (showing < 2) setTapped(false);
    if (focused && !ref.current?.contains(document.activeElement)) setFocused(false);
  }, [count, showing, focused]);

  // A stack fanned out by a tap folds back when the person taps anywhere else, so the timers run again.
  useEffect(() => {
    if (!tapped) return;
    const fold = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setTapped(false);
    };
    document.addEventListener("pointerdown", fold, true);
    return () => document.removeEventListener("pointerdown", fold, true);
  }, [tapped]);

  const onHeight = useCallback((id: number, height: number) => {
    setHeights((all) => (all[id] === height ? all : { ...all, [id]: height }));
  }, []);

  // Newest first. A leaving toast keeps its place while it fades, and the ones behind move into it.
  const layout = new Map<number, { index: number; offset: number }>();
  let index = 0;
  let offset = 0;
  let frontHeight = 0;
  for (const t of [...toasts].reverse()) {
    layout.set(t.id, { index, offset });
    if (t.leaving) continue;
    const height = heights[t.id] ?? GUESS;
    if (!index) frontHeight = height;
    offset += height + GAP;
    index += 1;
  }
  const height = expanded ? offset - GAP : frontHeight + Math.min(Math.max(showing - 1, 0), 2) * PEEK;

  return (
    <div
      ref={ref}
      className="toaster"
      popover={supportsPopover ? "manual" : undefined}
      data-fallback={supportsPopover ? undefined : ""}
      style={{ height: height || undefined }}
      aria-live="polite"
      aria-relevant="additions"
      onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(false)}
      onFocus={(e) => keyboardFocus(e.target) && setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
      onClick={(e) => {
        if (coarsePointer() && showing > 1 && !(e.target as HTMLElement).closest("button")) setTapped((t) => !t);
      }}
    >
      {toasts.map((t) => {
        const place = layout.get(t.id) ?? { index: 0, offset: 0 };
        return <Toast key={t.id} toast={t} index={place.index} offset={place.offset} expanded={expanded} frontHeight={frontHeight} paused={paused} onHeight={onHeight} />;
      })}
    </div>
  );
}

function Toast({ toast, index, offset, expanded, frontHeight, paused, onHeight }: { toast: ToastItem; index: number; offset: number; expanded: boolean; frontHeight: number; paused: boolean; onHeight: (id: number, height: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const left = useRef(toast.duration);
  const swipe = useRef<{ pointer: number; x: number; dx: number; dragging: boolean } | null>(null);
  const dragged = useRef(false);
  const ring = useRef<SVGRectElement>(null);
  const drain = useRef<Animation>();
  const behind = !expanded && index > 0;

  // Rises into place from just below.
  useLayoutEffect(() => {
    if (ref.current) animate(ref.current, { opacity: 0, transform: "translateY(14px) scale(0.96)" }, { opacity: 1, transform: "none" }, ENTER);
  }, []);

  // Leaves where it was dropped, or carries on the way it was swiped.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !toast.leaving) return;
    const swiped = node.dataset.swipe;
    const away = swiped === "right" ? "translateX(calc(100% + 32px))" : swiped === "left" ? "translateX(calc(-100% - 32px))" : "translateY(6px) scale(0.97)";
    animate(node, { opacity: 1, transform: node.style.transform || "none" }, { opacity: 0, transform: away }, EXIT);
  }, [toast.leaving]);

  // Counts down only while nobody is reading the toasts, picking up where it left off.
  useEffect(() => {
    if (paused || toast.leaving) return;
    const started = Date.now();
    const timer = setTimeout(() => dismissToast(toast.id, "timeout"), Math.max(left.current, 0));
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - started;
    };
  }, [paused, toast.leaving, toast.id]);

  // The countdown ring drains with the same pauses.
  useLayoutEffect(() => {
    const rect = ring.current;
    if (!rect || typeof rect.animate !== "function") return;
    const animation = rect.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: 100 }], { duration: toast.duration, easing: "linear", fill: "forwards" });
    drain.current = animation;
    return () => animation.cancel();
  }, [toast.duration]);
  useEffect(() => {
    const animation = drain.current;
    if (!animation || animation.playState === "finished") return;
    if (paused) animation.pause();
    else animation.play();
  }, [paused]);

  // Its own height, measured with any stacked height lifted, so fanning out knows where each one goes.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const stacked = node.style.height;
      node.style.height = "";
      onHeight(toast.id, node.offsetHeight);
      node.style.height = stacked;
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [toast.id, onHeight]);

  // On a touch screen a toast follows the finger sideways and goes when flung far enough.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragged.current = false;
    if (e.pointerType === "mouse" || toast.leaving || !coarsePointer()) return;
    swipe.current = { pointer: e.pointerId, x: e.clientX, dx: 0, dragging: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    const node = ref.current;
    if (!s || s.pointer !== e.pointerId || !node) return;
    s.dx = e.clientX - s.x;
    if (!s.dragging) {
      if (Math.abs(s.dx) < 6) return;
      s.dragging = true;
      try {
        node.setPointerCapture(e.pointerId);
      } catch {
        // The finger already lifted.
      }
      node.dataset.swiping = "";
    }
    node.style.transform = `translateX(${s.dx}px)`;
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    const node = ref.current;
    if (!s || s.pointer !== e.pointerId || !node) return;
    swipe.current = null;
    if (!s.dragging) return;
    dragged.current = true;
    delete node.dataset.swiping;
    if (e.type === "pointerup" && Math.abs(s.dx) > SWIPE) {
      node.dataset.swipe = s.dx > 0 ? "right" : "left";
      dismissToast(toast.id, "dismiss");
    } else {
      node.style.transform = "";
    }
  };

  const depth = Math.min(index, 2);
  const style: CSSProperties = behind ? { translate: `0 ${-depth * PEEK}px`, scale: String(1 - depth * 0.04), height: frontHeight || undefined } : { translate: `0 ${-offset}px` };

  return (
    <div
      ref={ref}
      className="toast"
      style={style}
      data-kind={toast.kind}
      data-tone={toast.tone}
      data-leaving={toast.leaving || undefined}
      data-behind={behind ? Math.min(index, 3) : undefined}
      role={toast.kind === "error" ? "alert" : "status"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={(e) => {
        // A swipe that ended over a button isn't a press.
        if (!dragged.current) return;
        dragged.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span className="toast-icon"><Icon name={toast.kind === "success" ? "check" : toast.kind === "error" ? "x" : toast.kind === "warning" ? "alert" : "info"} size={12} strokeWidth={2} /></span>
      <div className="toast-body">
        {toast.title}
        {toast.description && <div className="toast-desc">{toast.description}</div>}
      </div>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          data-toast={toast.id}
          onClick={() => {
            toast.action!.onClick();
            dismissToast(toast.id, "action");
          }}
        >
          {toast.action.label}
          {toast.countdown && (
            <svg className="toast-ring" aria-hidden="true">
              <rect ref={ring} width="100%" height="100%" rx="9" pathLength={100} />
            </svg>
          )}
        </button>
      )}
      <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}><Icon name="x" size={14} /></button>
    </div>
  );
}
