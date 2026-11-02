/**
 * Referral credits in an invoice's totals, looking like a promo code: each credit, who it's for
 * referring, and Remove while the invoice is open and unpaid (the credit stays earned and goes on
 * the client's next invoice); and Apply referral credit when the client has one earned and the
 * invoice has room. The database places them and keeps the totals right
 * (supabase/migrations/20261031000100_referral_credits.sql). A void invoice keeps the credit it was
 * sent with after the credit itself is given back, so that shows as one line.
 */
import { creditMoney } from "@crewtavo/core/marketing";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { supabase, unwrap } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import { useSession } from "@/lib/session";
import { creditRoom, creditsChangeable, takesCredit, type CreditInvoice } from "./creditRules";

export interface InvoiceCredit {
  id: string;
  amount: number;
  note: string;
  referral_id: string;
}

export function ReferralCredits({
  invoice,
  onChanged,
}: {
  invoice: CreditInvoice & { id: string; client_id: string; subtotal: number; discount_amount: number; credit_amount: number; credits: InvoiceCredit[] };
  onChanged: () => void;
}) {
  const session = useSession();
  const changeable = creditsChangeable(invoice);
  const canTake = takesCredit(invoice) && creditRoom(invoice) > 0;
  // Credit the invoice still counts whose rows were given back (it was voided since).
  const onRows = invoice.credits.reduce((sum, c) => sum + Math.round(Number(c.amount) * 100), 0);
  const released = Math.max(Math.round(Number(invoice.credit_amount) * 100) - onRows, 0) / 100;
  // Who each credit is for referring. Without the Marketing area the referrals don't come back, and the note says.
  const referrals = useQuery({
    queryKey: ["invoice-referrals", invoice.id, invoice.credits.map((c) => c.referral_id).join(",")],
    enabled: invoice.credits.length > 0,
    meta: { silent: true },
    queryFn: async () =>
      unwrap(await supabase().from("referrals").select("id, referred_name, referred_client_id").in("id", invoice.credits.map((c) => c.referral_id))),
  });
  const earned = useQuery({
    queryKey: ["referral-credits-for", invoice.client_id],
    enabled: canTake,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("referral_credits_for", { p_company: session.company.id, p_client: invoice.client_id })),
  });
  const remove = useMutation({
    meta: { success: "Credit taken off this invoice. It goes on their next one.", tone: "invoice" },
    mutationFn: async (credit: string) => unwrap(await supabase().rpc("remove_referral_credit", { p_credit: credit })),
    onSuccess: () => {
      onChanged();
      void earned.refetch();
    },
  });
  const apply = useMutation({
    meta: { success: (put: number) => `${creditMoney(put)} referral credit applied`, tone: "invoice" },
    mutationFn: async (referral: string) => Number(unwrap(await supabase().rpc("apply_referral_credit", { p_referral: referral, p_invoice: invoice.id }))),
    onSuccess: () => {
      onChanged();
      void earned.refetch();
    },
  });
  const left = (earned.data ?? []).filter((r) => Number(r.credit_left) > 0);

  return (
    <>
      {invoice.credits.map((c) => {
        const friend = referrals.data?.find((r) => r.id === c.referral_id);
        return (
          <div key={c.id} className="line" style={{ alignItems: "flex-start" }}>
            <span className="promo-applied">
              <span>Referral credit</span>
              {friend ? (
                <span className="muted small">
                  for referring {friend.referred_client_id ? <Link to={`/clients/${friend.referred_client_id}`}>{friend.referred_name}</Link> : friend.referred_name}
                </span>
              ) : (
                <span className="muted small">{c.note.replace(/^Referral credit:\s*/, "")}</span>
              )}
              {changeable && <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === c.id} onClick={() => remove.mutate(c.id)}>Remove</Button>}
            </span>
            <span className="nowrap">−{formatMoneyCents(Number(c.amount))}</span>
          </div>
        );
      })}
      {released > 0 && (
        <div className="line" style={{ alignItems: "flex-start" }}>
          <span className="promo-applied">
            <span>Referral credit</span>
            <span className="muted small">Given back when this invoice was voided</span>
          </span>
          <span className="nowrap">−{formatMoneyCents(released)}</span>
        </div>
      )}
      {canTake && left.length > 0 && (
        <div className="line">
          <Menu
            trigger={<><Icon name="gift" size={16} />Apply referral credit</>}
            triggerClassName="btn btn-sm btn-ghost"
            label="Apply referral credit"
            align="start"
            items={left.map((r) => ({ label: `${r.friend}'s referral · ${creditMoney(Number(r.credit_left))} left`, icon: "gift" as const, onSelect: () => apply.mutate(r.referral_id) }))}
          />
        </div>
      )}
    </>
  );
}
