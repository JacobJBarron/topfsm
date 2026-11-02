import { forwardRef, useEffect, useState, type ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "secondary" | "primary" | "danger" | "danger-solid" | "ghost" | "dark";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  /** Shows a spinner in place of the icon and blocks clicks until the work finishes. */
  loading?: boolean;
  icon?: IconName;
  block?: boolean;
  /**
   * A label that can run long, such as one naming the card ("Use American Express ending 1005"):
   * it goes onto a second line rather than past the edge of a phone's card (.btn-wrap).
   */
  wrap?: boolean;
  /**
   * Shows a check and doneLabel in place of the icon and label for a moment, right where the save
   * happened (see useJustDone). The button keeps its width either way.
   */
  done?: boolean;
  doneLabel?: string;
  /** Said under a button that has been loading for 10 seconds, or false for work that's slow anyway (uploads). */
  slowHint?: string | false;
}

/** How long a button loads before it says it's still working. */
const SLOW = 10_000;

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, block, wrap, done, doneLabel = "Saved", slowHint = "Still working. Check your signal.", className, disabled, type = "button", children, ...rest },
  ref,
) {
  const iconSize = size === "sm" ? 14 : size === "lg" ? 20 : 16;
  const hinted = loading && Boolean(slowHint) && Boolean(children);
  const slow = useLater(hinted, SLOW);
  const face = loading ? <Spinner size={iconSize} /> : icon && <Icon name={icon} size={iconSize} />;
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", variant !== "secondary" && `btn-${variant}`, size !== "md" && `btn-${size}`, block && "btn-block", wrap && "btn-wrap", !children && "btn-icon", loading && "is-loading", done && "is-done", className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {done === undefined ? (
        <>
          {face}
          {children}
        </>
      ) : (
        // Both faces share one grid cell, so the button is as wide as the wider of the two.
        <span className="btn-faces">
          <span className="btn-face" aria-hidden={done || undefined}>
            {face}
            {children}
          </span>
          <span className="btn-face btn-face-done" aria-hidden="true">
            <Icon name="check" size={iconSize} strokeWidth={2} />
            {children ? doneLabel : null}
          </span>
          <span className="sr-only" aria-live="polite">{done ? doneLabel : ""}</span>
        </span>
      )}
      {/* In place from the start of loading, so the hint is announced when it fills in. */}
      {hinted && <span className="btn-slow" aria-live="polite">{slow ? slowHint : null}</span>}
    </button>
  );
});

/** True once `active` has held for `ms`, and false again as soon as it stops. */
function useLater(active: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setLate(true), ms);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [active, ms]);
  return active && late;
}

/**
 * True for `ms` after each success of a mutation, for a Button's done state:
 * <Button done={useJustDone(save)} loading={save.isPending}>Save</Button>.
 * React Query mutation results carry submittedAt, so every save shows it again.
 */
export function useJustDone(mutation: { isSuccess: boolean; submittedAt: number }, ms = 1200): boolean {
  const { isSuccess, submittedAt } = mutation;
  // The save whose moment has passed, so the same success doesn't show twice.
  const [spent, setSpent] = useState(0);
  useEffect(() => {
    if (!isSuccess) return;
    const timer = setTimeout(() => setSpent(submittedAt), ms);
    return () => clearTimeout(timer);
  }, [isSuccess, submittedAt, ms]);
  return isSuccess && spent !== submittedAt;
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return <span className="spinner" style={{ width: size, height: size }} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
