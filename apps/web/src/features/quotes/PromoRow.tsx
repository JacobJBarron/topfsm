/**
 * The discount lines in a quote's or invoice's totals: a promo code (applied, or a box to enter
 * one) or a plain dollar discount. The database checks each code's rules and recalculates totals.
 */
import { promoRuleWords } from "@crewtavo/core/promos";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { api } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import { offerLabel } from "../marketing/PromoCodes";

/** `every_visit`: on a quote, whether it comes off every visit of recurring work or once (older pages leave it out). */
export type AppliedPromo = { code: string; kind: string; value: number; description: string | null; every_visit?: boolean | null } | null;

export function DiscountRows({
  kind,
  id,
  promo,
  discount,
  subtotal,
  canEditDiscount,
  canChangePromo,
  suggestedCode,
  suggestedFrom = "booking",
  rejected,
  onSaveDiscount,
  onEditDiscount,
  onUnchangedDiscount,
  onChanged,
}: {
  kind: "quote" | "invoice";
  id: string;
  promo: AppliedPromo;
  discount: number;
  subtotal: number;
  /** A plain dollar discount can be typed in (drafts). */
  canEditDiscount: boolean;
  /** A promo code can be added or removed (the database has the final say). */
  canChangePromo: boolean;
  /** A code the client typed on the booking form or a website form, not applied yet. */
  suggestedCode?: string | null;
  /** Where they typed it: a booking form (or the Client Hub), or a website form. */
  suggestedFrom?: "booking" | "website";
  /** A code they typed on a website form that wasn't valid, and why: shown, with no Apply. */
  rejected?: { code: string; problem: string | null } | null;
  onSaveDiscount: (amount: number) => void;
  /** Each keystroke in the discount, for the page's save status. */
  onEditDiscount?: () => void;
  /** The discount left without a change (or with one it turned down), for the page's save status. */
  onUnchangedDiscount?: () => void;
  onChanged: () => void;
}) {
  const [entering, setEntering] = useState(false);
  const [code, setCode] = useState("");
  const path = `/${kind === "quote" ? "quotes" : "invoices"}/${id}/promo`;
  const apply = useMutation({
    meta: { inline: true, success: (r: { code: string }) => `${r.code} applied`, tone: kind },
    mutationFn: (value: string) => api.post<{ code: string; discount_amount: number }>(path, { code: value }),
    onSuccess: () => {
      setEntering(false);
      setCode("");
      onChanged();
    },
  });
  const remove = useMutation({
    meta: { success: "Promo code removed", tone: kind },
    mutationFn: () => api.delete(path),
    onSuccess: onChanged,
  });
  const shown = Math.min(discount, Math.max(subtotal, 0));

  if (promo) {
    return (
      <div className="line" style={{ alignItems: "flex-start" }}>
        <span className="promo-applied">
          <span className="promo-code">{promo.code}</span>
          <span className="muted small">{offerLabel(promo)}{kind === "quote" && promo.every_visit != null ? ` · ${promoRuleWords(promo.every_visit)}` : ""}</span>
          {canChangePromo && <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>}
        </span>
        <span className="nowrap">−{formatMoneyCents(shown)}</span>
      </div>
    );
  }

  return (
    <>
      {(canEditDiscount || discount > 0) && (
        <div className="line">
          <span>Discount</span>
          {canEditDiscount ? <MoneyInput label="Discount" value={discount} max={Math.max(subtotal, 0)} onSave={onSaveDiscount} onEdit={onEditDiscount} onUnchanged={onUnchangedDiscount} /> : <span>−{formatMoneyCents(shown)}</span>}
        </div>
      )}
      {canChangePromo && suggestedCode && !entering && (
        <div className="callout callout-info" style={{ margin: "4px 0", padding: "8px 10px" }}>
          <div className="grow small">The client entered <strong className="mono">{suggestedCode}</strong> {suggestedFrom === "website" ? "on your website form" : "when they booked"}.</div>
          <Button size="sm" loading={apply.isPending} onClick={() => apply.mutate(suggestedCode)}>Apply</Button>
        </div>
      )}
      {canChangePromo && !suggestedCode && rejected && !entering && (
        <div className="callout" style={{ margin: "4px 0", padding: "8px 10px" }}>
          <div className="grow small muted">
            The client entered <strong className="mono">{rejected.code}</strong> on your website form.
            {rejected.problem ? ` It wasn't applied: ${rejected.problem.charAt(0).toLowerCase()}${rejected.problem.slice(1)}` : " It wasn't applied."}
          </div>
        </div>
      )}
      {canChangePromo && (
        entering ? (
          <form className="promo-entry" onSubmit={(e: FormEvent) => { e.preventDefault(); if (code.trim()) apply.mutate(code.trim()); }}>
            <input className="input input-sm mono grow" aria-label="Promo code" placeholder="Promo code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={24} autoFocus />
            {/* Outlined: inside the totals, the page's next step keeps the only solid button. */}
            <Button size="sm" type="submit" loading={apply.isPending} disabled={!code.trim()}>Apply</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEntering(false); apply.reset(); }}>Cancel</Button>
          </form>
        ) : (
          <div className="line"><Button size="sm" variant="ghost" icon="tag" onClick={() => setEntering(true)}>Add promo code</Button></div>
        )
      )}
      <FormError error={apply.error} />
    </>
  );
}
