/**
 * The client page's Autopay card, for the office with the invoices area while the company has
 * autopay on: the card or bank account they saved, when and how they agreed, the day they started
 * being charged from Crewtavo (so nobody also charges them by hand in Stripe), and the last few
 * charges. From here the office sends the invite, pauses it, or takes the card off. Reads go
 * through the database (RLS keeps them to the same people); actions through the API.
 */
import { AUTOPAY_STATUS_TEXT, autopayDueText, methodExpiry, methodLabel } from "@crewtavo/core/autopay";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

export interface AutopayMethod {
  id: string;
  type: string;
  brand: string | null;
  last4: string | null;
  bank_name: string | null;
  wallet: string | null;
  exp_month: number | null;
  exp_year: number | null;
  status: string;
  is_default: boolean;
  source: string;
  created_at: string;
}

export interface AutopayAgreement {
  id: string;
  payment_method_id: string | null;
  accepted_at: string;
  source: string;
  recorded_by_name: string;
  paused_at: string | null;
  revoked_at: string | null;
  revoked_via: string | null;
}

export interface AutopayChargeRow {
  id: string;
  status: string;
  due_at: string;
  invoice_id: string | null;
  charged_amount: number | null;
  last_error: string | null;
  invoice: { number: number | null; total: number } | null;
}

/** Where a client's autopay stands: none, or an agreement in force that's active, paused, waiting on a bank check, or needing a new card. */
export type AutopayState = "none" | "active" | "paused" | "pending" | "needs_update";

export interface ClientAutopay {
  methods: AutopayMethod[];
  agreements: AutopayAgreement[];
  /** The agreement in force, if any. */
  live: AutopayAgreement | null;
  /** The live agreement's card, or (with none) the card they saved last. */
  method: AutopayMethod | null;
  state: AutopayState;
  /** When they first agreed: the day they started being charged from Crewtavo. */
  since: string | null;
  charges: AutopayChargeRow[];
  /** With none in force: the newest agreement, when the client or the office turned it off. */
  turnedOff: AutopayAgreement | null;
  /**
   * `method` can be agreed to: saved after that turn-off (as hubAutopay and the database hold it),
   * else they set autopay up afresh on Stripe's page.
   */
  confirmable: boolean;
}

/**
 * The card's facts from its rows. Only the card the agreement in force names is ever charged, and
 * only while it's active (private.autopay_ready), so that's the one shown; a card saved since that
 * they didn't agree to isn't.
 */
export function clientAutopayOf(methods: AutopayMethod[], agreements: AutopayAgreement[], since: string | null, charges: AutopayChargeRow[]): ClientAutopay {
  const live = agreements.find((a) => !a.revoked_at) ?? null;
  const usable = (m: AutopayMethod) => m.status === "active" || m.status === "pending";
  const method = live
    ? methods.find((m) => m.id === live.payment_method_id) ?? null
    : methods.find((m) => m.is_default && usable(m)) ?? methods.find(usable) ?? null;
  const state: AutopayState = !live ? "none" : live.paused_at ? "paused" : method?.status === "active" ? "active" : method?.status === "pending" ? "pending" : "needs_update";
  const last = live ? null : agreements[0];
  const turnedOff = last?.revoked_at && (last.revoked_via === "client" || last.revoked_via === "office") ? last : null;
  const confirmable = Boolean(method) && (!turnedOff || Date.parse(method!.created_at) > Date.parse(turnedOff.revoked_at!));
  return { methods, agreements, live, method, state, since, charges, turnedOff, confirmable };
}

/** How the agreement was made: "Agreed Oct 31, 2026 on their client page", "Confirmed ...", "Recorded by Pat on ...". */
export function agreedText(a: Pick<AutopayAgreement, "source" | "accepted_at" | "recorded_by_name">): string {
  const day = formatDate(a.accepted_at);
  if (a.source === "owner") return `Recorded by ${a.recorded_by_name || "an owner"} on ${day}`;
  if (a.source === "confirmed") return `Confirmed ${day}`;
  return `Agreed ${day} on their client page`;
}

const STATE_CHIP: Record<Exclude<AutopayState, "none">, { label: string; className: string }> = {
  active: { label: "Active", className: "chip chip-green" },
  paused: { label: "Paused", className: "chip chip-amber" },
  needs_update: { label: "Needs a new card", className: "chip chip-red" },
  pending: { label: "Bank account being checked", className: "chip chip-blue" },
};

const CHARGE_TONE: Record<string, string> = { paid: "var(--green-dark)", failed: "var(--danger)", needs_client: "var(--danger)", needs_approval: "var(--warning)" };

/** Everything the card shows about one client, under the client's own key. */
export function useClientAutopay(clientId: string, enabled = true) {
  return useQuery({
    queryKey: ["client", clientId, "autopay"],
    enabled,
    queryFn: async () => {
      const db = supabase();
      const [methods, agreements, first, charges] = await Promise.all([
        db.from("client_payment_methods").select("id, type, brand, last4, bank_name, wallet, exp_month, exp_year, status, is_default, source, created_at").eq("client_id", clientId).neq("status", "removed").order("created_at", { ascending: false }),
        db.from("autopay_authorizations").select("id, payment_method_id, accepted_at, source, recorded_by_name, paused_at, revoked_at, revoked_via").eq("client_id", clientId).order("accepted_at", { ascending: false }).limit(5),
        db.from("autopay_authorizations").select("accepted_at").eq("client_id", clientId).order("accepted_at").limit(1),
        db.from("autopay_charges").select("id, status, due_at, invoice_id, charged_amount, last_error, invoice:invoices!autopay_charges_invoice_fkey(number, total)").eq("client_id", clientId).order("created_at", { ascending: false }).limit(10),
      ]);
      return clientAutopayOf(unwrap(methods), unwrap(agreements), unwrap(first)[0]?.accepted_at ?? null, unwrap(charges) as AutopayChargeRow[]);
    },
  });
}

/** Send one client the link to set up (or confirm) autopay. The toast says whether it went, or why not. */
export function useAutopayInvite(clientId: string) {
  return useMutation({
    mutationFn: (channel: "email" | "sms") => api.post<{ sent: boolean; detail: string }>(`/clients/${clientId}/autopay/invite`, { channel }),
    onSuccess: (r) => (r.sent ? toast.success(r.detail) : toast.info(r.detail)),
  });
}

export function AutopayCard({ client }: { client: { id: string; display_name: string; email: string | null; phone: string | null } }) {
  const session = useSession();
  const features = session.config.features;
  const queryClient = useQueryClient();
  const autopay = useClientAutopay(client.id);
  const invite = useAutopayInvite(client.id);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["client", client.id, "autopay"] });
    // Each job's switch hint and "Charged automatically" line read the same agreement.
    queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "job" && q.queryKey[2] === "autopay" });
    // The Clients list's Card not set up tab and its count.
    queryClient.invalidateQueries({ queryKey: ["clients", session.company.id] });
  };
  const pause = useMutation({
    meta: { success: (_: unknown, paused: boolean) => (paused ? "Autopay paused" : "Autopay turned back on") },
    mutationFn: (paused: boolean) => api.post(`/clients/${client.id}/autopay/pause`, { paused }),
    onSettled: refresh,
  });
  const removeCard = useMutation({
    meta: { success: "Card removed" },
    mutationFn: (methodId: string) => api.post(`/clients/${client.id}/autopay/remove-card`, { payment_method_id: methodId }),
    onSettled: refresh,
  });

  const inviteMenu = (label: string) => (
    <Menu
      triggerClassName="btn btn-sm"
      label={label}
      trigger={<><Icon name="send" size={14} />{label}</>}
      align="start"
      items={[
        { label: "By email", icon: "mail", onSelect: () => invite.mutate("email"), disabled: !client.email || !features.email },
        { label: "By text", icon: "smartphone", onSelect: () => invite.mutate("sms"), disabled: !client.phone || !features.sms },
      ]}
    />
  );

  const head = (chip: ReactNode) => (
    <div className="row-between">
      <strong id={`autopay-${client.id}`}>Autopay</strong>
      {chip}
    </div>
  );
  if (autopay.isPending) return <div className="card card-pad stack-sm" aria-busy="true">{head(null)}<Skeleton width="70%" /><Skeleton width="50%" /></div>;
  if (autopay.error) return <div className="card"><ErrorState compact title="Autopay couldn't load" error={autopay.error} onRetry={() => autopay.refetch()} /></div>;

  const a = autopay.data!;
  const m = a.method;
  const label = m ? methodLabel(m) : null;
  const expires = m ? methodExpiry(m) : null;
  const askRemove = async () => {
    if (!m) return;
    const agreed = a.live?.payment_method_id === m.id;
    const body = [
      agreed ? `Autopay turns off for ${client.display_name}. To turn it back on, they add a card again from their client page.` : `It's taken off ${client.display_name}'s account here.`,
      m.source === "stripe_import" ? "It stays saved in Stripe." : "It's removed from Stripe too.",
    ].join(" ");
    if (await confirm({ title: `Remove ${label}?`, body, confirmLabel: "Remove card", danger: true })) removeCard.mutate(m.id);
  };
  const reachable = (client.email && features.email) || (client.phone && features.sms);

  return (
    <section className="card card-pad stack-sm" aria-labelledby={`autopay-${client.id}`}>
      {head(a.state === "none" ? <span className="chip">Not set up</span> : <span className={STATE_CHIP[a.state].className}>{STATE_CHIP[a.state].label}</span>)}
      {m && (
        <span className="small row" style={{ gap: 6 }}>
          <Icon name={m.type === "us_bank_account" ? "bank" : "card"} size={14} />
          <span className="grow">{label}{expires ? ` · expires ${expires}` : ""}</span>
        </span>
      )}
      {a.live ? (
        <>
          <span className="muted small">{agreedText(a.live)}</span>
          {a.since && <span className="muted small">Charged from Crewtavo since {formatDate(a.since)}</span>}
          {a.state === "paused" && <span className="muted small">Nothing is charged until you turn it back on. Invoices go out with the Pay link meanwhile.</span>}
          {a.state === "pending" && <span className="muted small">Charges start once Stripe has checked the bank account. This takes a few days.</span>}
          {a.state === "needs_update" && <span className="small" style={{ color: "var(--danger)" }}>{m ? "The card was declined or can't be charged. They were sent a link to update it." : "The card was removed. They need to add one again from their client page."}</span>}
        </>
      ) : (
        <>
          {a.turnedOff?.revoked_via === "client" && <span className="muted small">Turned off by the client on {formatDate(a.turnedOff.revoked_at!)}</span>}
          <span className="muted small">
            {!a.confirmable
              ? "Not set up. Send them the link to save a card and agree to be charged after each visit."
              : m!.source === "stripe_import"
                ? "Saved in Stripe. Not charged until they confirm autopay."
                : "Saved, but not charged until they agree to autopay."}
          </span>
        </>
      )}

      <div className="row wrap" style={{ gap: 8 }}>
        {!a.live && reachable && inviteMenu(a.confirmable && m?.source === "stripe_import" ? "Send Confirm autopay link" : "Send autopay invite")}
        {a.live && (a.state === "paused" ? (
          <Button size="sm" icon="play" loading={pause.isPending} onClick={() => pause.mutate(false)}>Turn back on</Button>
        ) : (
          <Button size="sm" icon="pause" loading={pause.isPending} onClick={() => pause.mutate(true)}>Pause</Button>
        ))}
        {m && <Button size="sm" variant="ghost" icon="trash" loading={removeCard.isPending} onClick={askRemove}>Remove card</Button>}
      </div>
      {!a.live && !reachable && <span className="muted small">Add an email or phone to send the link{features.email || features.sms ? "" : ", and connect email in Settings → Email"}.</span>}

      {a.charges.length > 0 && (
        <div className="stack-sm" style={{ gap: 4, marginTop: 4 }}>
          <span className="muted small strong">Recent charges</span>
          {a.charges.map((c) => {
            // Paid with nothing on the card (credit the client had in Stripe paid it all): the invoice's total, said so.
            const fromCredit = c.status === "paid" && c.charged_amount !== null && Number(c.charged_amount) === 0;
            const amount = (fromCredit ? null : c.charged_amount) ?? c.invoice?.total ?? null;
            const what = c.invoice?.number != null ? `Invoice #${c.invoice.number}` : "Next charge";
            const status = c.status === "waiting" ? `Charges ${autopayDueText(c.due_at, session.company.timezone)}` : fromCredit ? "Paid from Stripe credit" : AUTOPAY_STATUS_TEXT[c.status] ?? c.status;
            const row = (
              <>
                <span className="grow ellipsis">{what}</span>
                {amount != null && <span className="tabular">{formatMoneyCents(amount)}</span>}
                <span style={{ color: CHARGE_TONE[c.status] ?? "var(--text-2)", fontWeight: 600 }}>{status}</span>
              </>
            );
            return c.invoice_id ? (
              <Link key={c.id} to={`/invoices/${c.invoice_id}`} className="row small" style={{ gap: 8 }} title={c.last_error ?? undefined}>{row}</Link>
            ) : (
              <span key={c.id} className="row small" style={{ gap: 8 }} title={c.last_error ?? undefined}>{row}</span>
            );
          })}
        </div>
      )}
    </section>
  );
}
