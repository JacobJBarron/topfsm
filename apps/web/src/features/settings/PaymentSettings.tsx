/**
 * Settings → Payments: autopay (docs/autopay-plan.md). A short checklist of what it needs (the
 * company's own Stripe account, a key that can save cards, Stripe's own emails off), then the
 * terms clients agree to, when finished work is charged, the most to charge without asking,
 * receipts and new jobs. Kept in companies.settings.autopay, which only autopay_set_settings writes
 * (PUT /autopay/settings): Settings → Company saves the rest of the settings and keeps it as it is.
 * Tips stay one switch, in Settings → Company; this page only says where it stands. Cards brought
 * in from Stripe are listed under it (StripeCards).
 */
import { AUTOPAY_TERMS_MAX, autopayTimingText, starterAutopayTerms, type AutopaySettings, type AutopayTiming } from "@crewtavo/core/autopay";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { StripeCards } from "./StripeCards";

/** GET /autopay/status (autopayStatus in apps/api/src/services/autopay.ts). */
export interface AutopayStatus {
  connected: boolean;
  /** The company's own Stripe key, not the server's: autopay needs it. */
  own: boolean;
  livemode: boolean;
  /** The key can save cards, charge them and detach them. */
  can_autopay: boolean;
  can_refund: boolean;
  webhook_current: boolean;
  /** settings.autopay with the starter terms filled in. */
  settings: AutopaySettings;
  /** settings.hub_tips, the one switch for tips (Settings → Company). */
  tips: boolean;
  /** Cards brought in from Stripe whose clients haven't agreed to autopay here yet. */
  stripe_cards: number;
}

/**
 * Where the company's key and autopay stand, for Settings → Payments and the screens that hide
 * autopay while it's off. Hangs off the company's key, so saving Settings → Company refreshes it.
 */
export function useAutopayStatus(enabled = true) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["company", company.id, "payments"],
    enabled,
    queryFn: () => api.get<AutopayStatus>("/autopay/status"),
  });
}

const TIMINGS: Array<{ value: AutopayTiming; label: string }> = [
  { value: "now", label: "Right away" },
  { value: "end_of_day", label: "At the end of the day" },
  { value: "days", label: "Days after" },
];

/** The form as typed: amounts and days stay text until they're saved. */
export interface PaymentForm {
  enabled: boolean;
  terms: string;
  timing: AutopayTiming;
  days: string;
  max: string;
  receipts: boolean;
  jobs_default: boolean;
  card_required: boolean;
}

/** The saved settings as the form shows them. */
export function paymentForm(s: AutopaySettings): PaymentForm {
  return {
    enabled: s.enabled,
    terms: s.terms,
    timing: s.timing,
    days: String(s.days ?? 1),
    max: s.max_amount == null ? "" : String(s.max_amount),
    receipts: s.receipts,
    jobs_default: s.jobs_default,
    card_required: s.card_required,
  };
}

/**
 * The form as PUT /autopay/settings takes it. Throws the first thing to fix, in the words
 * autopay_set_settings uses, so a mistake is caught before the round trip.
 */
export function autopayBody(f: PaymentForm) {
  const terms = f.terms.trim();
  if (!terms || terms.length > AUTOPAY_TERMS_MAX) throw new Error("Write the terms clients agree to.");
  let days: number | null = null;
  if (f.timing === "days") {
    days = Number(f.days);
    if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error("Choose 1 to 14 days.");
  }
  let max: number | null = null;
  if (f.max.trim()) {
    max = Math.round(Number(f.max) * 100) / 100;
    if (!(max > 0)) throw new Error("The most to charge without asking has to be more than $0.");
    if (max > 1_000_000) throw new Error("The most to charge without asking can be up to $1,000,000.");
  }
  return { enabled: f.enabled, terms, timing: f.timing, days, max_amount: max, receipts: f.receipts, jobs_default: f.jobs_default, card_required: f.card_required };
}

export function PaymentSettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const status = useAutopayStatus();
  // From what's loaded already when there is (coming back to the tab), else once it loads.
  const [f, setF] = useState<PaymentForm | null>(() => (status.data ? paymentForm(status.data.settings) : null));
  useEffect(() => {
    if (status.data && !f) setF(paymentForm(status.data.settings));
  }, [status.data, f]);

  const save = useMutation({
    meta: { inline: true },
    mutationFn: () => api.put<{ settings: AutopaySettings }>("/autopay/settings", autopayBody(f!)),
    onSuccess: (r) => {
      // What the server kept (trimmed terms, days only with "Days after").
      setF(paymentForm(r.settings));
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });

  const saved = useJustDone(save);
  if (status.isPending || !f) return status.error ? <div className="card"><ErrorState error={status.error} onRetry={() => status.refetch()} /></div> : <CardSkeleton lines={8} />;
  const s = status.data!;
  const set = <K extends keyof PaymentForm>(key: K, value: PaymentForm[K]) => {
    setF({ ...f, [key]: value });
    save.reset();
  };
  const starter = starterAutopayTerms(company.trade_preset);
  // Days as the client will read them; a half-typed number reads as one day, as the database would.
  const days = Math.min(14, Math.max(1, Math.round(Number(f.days)) || 1));
  const cantTurnOn = !s.can_autopay && !f.enabled;

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <section className="card card-pad stack-sm" aria-labelledby="autopay-needs">
        <strong id="autopay-needs">What autopay needs</strong>
        <span className="muted small">
          Clients save a card or bank account once, from their client page, and agree to your terms. Each finished visit is then billed and charged to it, with a receipt. A charge that fails goes out with the Pay link, as invoices do now.
        </span>
        <div className="stack-sm" style={{ gap: 10, marginTop: 4 }}>
          <Check ok={s.own} title="Your own Stripe account">
            {s.own ? (
              <>Connected{s.livemode ? "" : ", in test mode"}. <Link to="/apps/stripe">Manage it on the Apps page</Link></>
            ) : (
              <Link to="/apps/stripe">Connect your own Stripe account on the Apps page to use autopay.</Link>
            )}
          </Check>
          <Check ok={s.can_autopay} title="A key that can save cards">
            {s.can_autopay ? `It can save cards and charge them${s.can_refund ? ", and make refunds" : ""}.` : s.own ? <Link to="/apps/stripe">Update your Stripe key to turn on autopay</Link> : "Comes with your own Stripe account."}
            {s.own && !s.webhook_current && <span style={{ display: "block", color: "var(--danger)" }}>Stripe isn't sending Crewtavo every update it needs. Connect the key again on the Apps page.</span>}
          </Check>
          <Check ok={null} title="Stripe's own emails off">In Stripe, turn off emails about failed payments and receipts, so clients don't get two.</Check>
        </div>
      </section>

      <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <section className="card card-pad stack" aria-labelledby="autopay-title">
          <strong id="autopay-title">Autopay</strong>
          {f.enabled && !s.can_autopay && (
            <div className="callout callout-warning">
              <Icon name="alert" size={16} />
              <div className="grow small" style={{ fontWeight: 400 }}>
                Your Stripe key can't charge saved cards anymore, so invoices go out with the Pay link. <Link to="/apps/stripe">Update it on the Apps page</Link>, or turn autopay off here.
              </div>
            </div>
          )}
          <label className="switch-row">
            <input type="checkbox" className="switch" checked={f.enabled} disabled={cantTurnOn} onChange={(e) => set("enabled", e.target.checked)} />
            <span>
              Charge clients' saved cards when the work is done
              <span className="muted small" style={{ display: "block", fontWeight: 400 }}>
                {cantTurnOn
                  ? s.own ? "Update your Stripe key on the Apps page to turn on autopay." : "Connect your own Stripe account on the Apps page to use autopay."
                  : "Only clients who saved a card and agreed are charged, and only for jobs with autopay on. You can turn it off for one client or one job."}
              </span>
            </span>
          </label>

          <Field label="Terms clients agree to" hint="Shown on their client page with when you charge, above the box they tick. Clients who already agreed keep the words they agreed to.">
            <textarea className="textarea" rows={4} value={f.terms} maxLength={AUTOPAY_TERMS_MAX} required onChange={(e) => set("terms", e.target.value)} />
          </Field>
          {f.terms.trim() !== starter && (
            <Button size="sm" variant="ghost" icon="undo" style={{ justifySelf: "start" }} onClick={() => set("terms", starter)}>Use the suggested wording</Button>
          )}

          <div className="form-grid">
            <Field label="When to charge" hint={`Clients read: "We charge ${autopayTimingText({ timing: f.timing, days })}."${f.timing === "now" ? "" : " The wait lets you catch a visit marked done by mistake."}`}>
              <select className="select" value={f.timing} onChange={(e) => set("timing", e.target.value as AutopayTiming)}>
                {TIMINGS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            {f.timing === "days" && (
              <Field label="Days after each visit">
                <input className="input" type="number" inputMode="numeric" min={1} max={14} step={1} required value={f.days} onChange={(e) => set("days", e.target.value)} />
              </Field>
            )}
            <Field label="Most to charge without asking" optional hint="Over this, the charge waits for your OK. Leave it blank for no limit.">
              <span className="input-group">
                <span className="addon">$</span>
                <input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={f.max} onChange={(e) => set("max", e.target.value.replace(/[^0-9.]/g, ""))} placeholder="No limit" />
              </span>
            </Field>
          </div>

          <label className="switch-row">
            <input type="checkbox" className="switch" checked={f.card_required} onChange={(e) => set("card_required", e.target.checked)} />
            <span>
              Require a card on file
              <span className="muted small" style={{ display: "block", fontWeight: 400 }}>Quotes ask for a card when they're signed, and clients' pages say it's required. Clients gets a Card not set up list, and jobs show who hasn't set one up.</span>
            </span>
          </label>
          <label className="switch-row">
            <input type="checkbox" className="switch" checked={f.receipts} onChange={(e) => set("receipts", e.target.checked)} />
            <span>
              Email a receipt after each charge
              <span className="muted small" style={{ display: "block", fontWeight: 400 }}>With a link to change their card or turn autopay off.</span>
            </span>
          </label>
          <label className="switch-row">
            <input type="checkbox" className="switch" checked={f.jobs_default} onChange={(e) => set("jobs_default", e.target.checked)} />
            <span>
              Turn on autopay for new recurring jobs of clients on autopay
              <span className="muted small" style={{ display: "block", fontWeight: 400 }}>And for their recurring jobs billed per visit when they agree. Each job's page has its own switch.</span>
            </span>
          </label>
        </section>
        <FormError error={save.error} />
        <div className="form-actions" style={{ justifyContent: "flex-start" }}><FormChecks /><Button type="submit" variant="primary" loading={save.isPending} done={saved}>Save payment settings</Button></div>
      </form>

      {/* Read only: the tip switch is Settings → Company's, and the Pay screen, the receipt and the server all follow it. */}
      <section className="card card-pad stack-sm" aria-labelledby="tips-title">
        <div className="row-between">
          <strong id="tips-title">Tips</strong>
          <span className={s.tips ? "chip chip-green" : "chip"}>{s.tips ? "Tips are on" : "Tips are off"}</span>
        </div>
        <span className="muted small">
          {s.tips
            ? "Clients choose a tip before they pay, and from the receipt after an automatic charge."
            : "Clients aren't offered a tip when they pay or on the receipt, and no tip is charged to a saved card."}
        </span>
        <Link className="small" to="/settings?tab=company" style={{ justifySelf: "start" }}>Change it in Settings → Company</Link>
      </section>

      {s.stripe_cards > 0 && <StripeCards enabled={s.settings.enabled} termsVersion={s.settings.terms_version} />}
    </div>
  );
}

/** One line of the checklist: done, not done, or (null) something to do in Stripe that Crewtavo can't see. */
function Check({ ok, title, children }: { ok: boolean | null; title: string; children: ReactNode }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
      <span style={{ color: ok ? "var(--green-dark)" : ok === false ? "var(--danger)" : "var(--text-2)", flex: "none", marginTop: 2 }}>
        <Icon name={ok ? "check" : ok === false ? "x" : "info"} size={16} strokeWidth={2} label={ok ? "Done" : ok === false ? "Not yet" : "In Stripe"} />
      </span>
      <span className="grow" style={{ display: "grid", gap: 2 }}>
        <strong className="small">{title}</strong>
        <span className="muted small">{children}</span>
      </span>
    </div>
  );
}
