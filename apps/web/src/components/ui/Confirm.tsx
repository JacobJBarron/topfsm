/**
 * Promise-based confirmation for destructive or irreversible actions:
 *   if (await confirm({ title: "Delete this quote?", danger: true })) remove.mutate();
 * A question whose two buttons are both answers ("Change them too" / "Only new jobs") uses choose():
 * closing it without one (Escape, the X) backs out, as closing a confirm does.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Ask the person to type this word to confirm (for deleting a lot of data). */
  typeToConfirm?: string;
}

/** The confirm button, the cancel button, or closed without either (Escape, the X, another question). */
export type Answer = "confirm" | "cancel" | "dismiss";

interface Pending extends ConfirmOptions {
  resolve: (answer: Answer) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function ask(options: ConfirmOptions): Promise<Answer> {
  pending?.resolve("dismiss");
  return new Promise((resolve) => {
    pending = { ...options, resolve };
    emit();
  });
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return ask(options).then((result) => result === "confirm");
}

/** True for the confirm button, false for the cancel button, null when it's closed without either. */
export function choose(options: ConfirmOptions): Promise<boolean | null> {
  return ask(options).then((result) => (result === "dismiss" ? null : result === "confirm"));
}

/** Answers the question showing (what ConfirmHost's buttons and closing it do). */
export function answer(result: Answer) {
  const current = pending;
  if (!current) return;
  pending = null;
  current.resolve(result);
  emit();
}

export function ConfirmHost() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
  const [typed, setTyped] = useState("");
  // The answered question stays on screen, closed, while the dialog animates out.
  const [shown, setShown] = useState(current);
  if (current && current !== shown) {
    setShown(current);
    setTyped("");
  }
  const view = current ?? shown;
  if (!view) return null;
  const blocked = Boolean(view.typeToConfirm) && typed.trim().toLowerCase() !== view.typeToConfirm!.toLowerCase();
  return (
    <Dialog open={Boolean(current)} onClose={() => answer("dismiss")} onExited={() => setShown(null)} title={view.title} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) answer("confirm");
        }}
      >
        {view.body && <div className="muted" style={{ marginTop: -6 }}>{view.body}</div>}
        {view.typeToConfirm && (
          <label className="field">
            <span>Type <strong>{view.typeToConfirm}</strong> to confirm</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        )}
        <div className="form-actions">
          <Button onClick={() => answer("cancel")}>{view.cancelLabel ?? "Cancel"}</Button>
          <Button type="submit" variant={view.danger ? "danger-solid" : "primary"} disabled={blocked}>{view.confirmLabel ?? "Confirm"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
