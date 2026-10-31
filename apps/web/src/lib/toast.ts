/**
 * Toast notifications: brief feedback after an action ("Quote sent", "Couldn't save").
 * A tiny external store so any module (React Query handlers included) can raise one.
 */
export type ToastKind = "success" | "error" | "info" | "warning";
/** Why a toast left: its action was pressed, its time ran out (or newer toasts pushed it out), or it was closed. */
export type ToastCloseReason = "action" | "timeout" | "dismiss";
/** A workflow color for the icon, so a toast about a quote looks like quotes do. */
export type ToastTone = "request" | "quote" | "job" | "invoice";

export interface ToastOptions {
  description?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
  /** Called once when the toast leaves, with why. */
  onClose?: (reason: ToastCloseReason) => void;
  /** A ring around the action button that drains over the toast's duration (pauses while hovered). */
  countdown?: boolean;
  tone?: ToastTone;
}

export interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
  title: string;
  duration: number;
  leaving?: boolean;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const recent = new Map<string, number>();

function emit() {
  for (const listener of listeners) listener();
}

function closed(item: ToastItem, reason: ToastCloseReason) {
  try {
    item.onClose?.(reason);
  } catch (error) {
    console.error("A toast's onClose failed", error);
  }
}

export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getToasts = () => items;

export function dismissToast(id: number, reason: ToastCloseReason = "dismiss") {
  const item = items.find((t) => t.id === id && !t.leaving);
  if (!item) return;
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  closed(item, reason);
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 180);
}

function push(kind: ToastKind, title: string, options: ToastOptions = {}): number {
  // The same message twice within 2s (several failing requests at once) shows once. Toasts that
  // hand back a choice (Undo) always show, since each one stands for its own change.
  const key = `${kind}:${title}:${options.description ?? ""}`;
  const last = recent.get(key);
  const plain = !options.action && !options.onClose;
  if (plain && last && Date.now() - last < 2000) return -1;
  recent.set(key, Date.now());

  const id = nextId++;
  const duration = options.duration ?? (options.action ? 6000 : kind === "error" || kind === "warning" ? 6000 : 3500);
  const showing = items.filter((t) => !t.leaving);
  const kept = showing.slice(-3);
  items = [...kept, { id, kind, title, ...options, duration }];
  emit();
  // Older toasts pushed out by newer ones have left too.
  for (const item of showing.slice(0, showing.length - kept.length)) closed(item, "timeout");
  return id;
}

export const toast = {
  success: (title: string, options?: ToastOptions) => push("success", title, options),
  error: (title: string, options?: ToastOptions) => push("error", title, options),
  info: (title: string, options?: ToastOptions) => push("info", title, options),
  /** It worked, but not all of it: says what didn't, and stays as long as an error. */
  warning: (title: string, options?: ToastOptions) => push("warning", title, options),
  dismiss: (id: number) => dismissToast(id),
};
