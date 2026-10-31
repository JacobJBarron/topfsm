/**
 * A strip of tabs that scrolls sideways when they don't fit (.underline-tabs on a phone): the
 * selected tab is kept in view whenever it changes, and the strip says which edges have more tabs
 * past them (data-more: left, right or both), which components.css fades, since its scrollbar is
 * hidden.
 */
import { useEffect, useLayoutEffect, useRef } from "react";

/** Which edges of a strip scrolled to `left` have more past them. */
export function moreEdges(left: number, visible: number, total: number): "left" | "right" | "both" | null {
  const before = left > 1;
  const after = left + visible < total - 1;
  return before && after ? "both" : before ? "left" : after ? "right" : null;
}

/** Where to scroll a strip so a tab from `start` to `end` is in view, with `pad` beside it; null when it already is. */
export function scrollToTab(start: number, end: number, left: number, visible: number, pad = 24): number | null {
  if (start < left) return Math.max(0, start - pad);
  if (end > left + visible) return end - visible + pad;
  return null;
}

export function useTabStrip<T extends HTMLElement>(selected: unknown) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const strip = ref.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]');
    if (!strip || !tab) return;
    // The strip is position: relative, so a tab's offsets are from it. Only the strip scrolls, never the page.
    const to = scrollToTab(tab.offsetLeft, tab.offsetLeft + tab.offsetWidth, strip.scrollLeft, strip.clientWidth);
    if (to !== null) strip.scrollLeft = to;
  }, [selected]);

  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const mark = () => {
      const more = moreEdges(strip.scrollLeft, strip.clientWidth, strip.scrollWidth);
      if (more) strip.setAttribute("data-more", more);
      else strip.removeAttribute("data-more");
    };
    mark();
    strip.addEventListener("scroll", mark, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
    resize?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", mark);
      resize?.disconnect();
    };
    // Again with the tab, so a strip shown later (Marketing installed meanwhile) is watched too.
  }, [selected]);

  return ref;
}
