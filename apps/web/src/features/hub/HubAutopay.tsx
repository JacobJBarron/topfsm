/**
 * Autopay in the Client Hub (?view=autopay on the client's link): how it works, adding a card or
 * bank account on Stripe's page, and agreeing to the terms, in three steps. Once it's on: the card,
 * since when, changing it, and turning autopay off. Crewtavo never sees the card number: Stripe's
 * page takes it and comes back here with its session (session_id), which is finished once, then
 * dropped from the address. The server keeps the agreement with the words and the version agreed to.
 * While the business can't take autopay (available false), an agreement in force still shows, on
 * hold, with Turn off and nothing to set up or change.
 */
import { autopayDueText } from "@crewtavo/core/autopay";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { ApiError } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import type { ClientView, Fetch } from "./ClientPortal";
import type { HubAutopay } from "./document";

/** A card or bank account as the server names it ("Visa ending 4242", "08/28"). */
type SavedMethod = NonNullable<HubAutopay["method"]>;
/** What finishing Stripe's page comes to: saved and waiting for the tick (a bank account still being checked: pending), or refused. */
type SetupOutcome = { status: "agree" | "pending"; method: SavedMethod } | { status: "refused"; reason: string };
/** The agreement kept: on, or on once the bank account is checked. */
type Agreed = { status: "active" | "pending"; method: string };

type Step = "how" | "card" | "agree";
const STEPS: Array<{ step: Step; label: string }> = [
  { step: "how", label: "How it works" },
  { step: "card", label: "Add a card" },
  { step: "agree", label: "Agree" },
];

/** What an agreement on hold says, here and on the home page's card. */
export const ON_HOLD_TEXT = "Charges are on hold for now. Until they start again, invoices come to you to pay.";

/** "Oct 31", where the business is. */
const shortDay = (at: string, timeZone: string) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });

export function AutopayView({ token, data, hubFetch, back, onChanged }: { token: string; data: ClientView; hubFetch: Fetch; back: () => void; onChanged: () => void }) {
  const autopay = data.autopay ?? null;
  const preview = Boolean(data.preview);
  const tz = data.company.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [params, setParams] = useSearchParams();
  const sessionId = params.get("session_id");
  // The step they're on, once they've moved; until then it follows what's saved (`current` below).
  const [step, setStep] = useState<Step | null>(null);
  // The card just saved on Stripe's page: what they agree to (with an agreement in force, it isn't the default yet).
  const [saved, setSaved] = useState<SavedMethod | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  // Cards the server wouldn't take an agreement for from this link: not offered again here.
  const [blocked, setBlocked] = useState<string[]>([]);
  const [agree, setAgree] = useState(false);
  const [agreed, setAgreed] = useState<Agreed | null>(null);
  // Change card (or Update card) from the page of autopay that's on: back into the steps, at the card.
  const [changing, setChanging] = useState(false);
  const [askOff, setAskOff] = useState(false);
  const [turnedOff, setTurnedOff] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const setup = useMutation({
    meta: { inline: true },
    mutationFn: () => hubFetch<{ url: string }>(`${token}/autopay/setup`, {}),
    onSuccess: (res) => window.location.assign(res.url),
  });
  const finish = useMutation({
    meta: { inline: true },
    mutationFn: (session: string) => hubFetch<SetupOutcome>(`${token}/autopay/finish`, { session_id: session }),
    onSuccess: (outcome) => {
      if (outcome.status === "refused") {
        setRefused(outcome.reason);
        setSaved(null);
        setStep("card");
      } else {
        setRefused(null);
        setSaved(outcome.method);
        setStep("agree");
      }
    },
    // Either way the session is done with: off the address (so a reload doesn't finish it again), and the page as it is now.
    onSettled: () => {
      setParams({ view: "autopay" }, { replace: true });
      onChanged();
    },
  });
  // Back from Stripe's page: finish its session once, however often the page draws.
  const finishing = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || preview || finishing.current === sessionId) return;
    finishing.current = sessionId;
    finish.mutate(sessionId);
  }, [sessionId, preview, finish.mutate]);

  // The card they agree to: the one just saved, else the one waiting for their tick.
  const waiting = autopay?.status === "agree" && autopay.method && !blocked.includes(autopay.method.id) ? autopay.method : null;
  const method = saved ?? waiting;
  const confirm = useMutation({
    meta: { inline: true },
    mutationFn: () => hubFetch<Agreed>(`${token}/autopay/confirm`, { payment_method_id: method!.id, terms_version: autopay!.terms_version, agreed: true }),
    onSuccess: (res) => {
      setAgreed(res);
      setSaved(null);
      setChanging(false);
      setStep(null);
      onChanged();
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      // The terms changed since the page loaded: the new ones load, and they agree to those.
      if (error.status === 409) {
        setAgree(false);
        onChanged();
      }
      // That card can't be agreed to from here (a copy of the link the office made, or it was removed): add one on Stripe's page.
      if ((error.status === 403 || error.status === 404) && method) {
        setBlocked((ids) => [...ids, method.id]);
        setSaved(null);
        setStep("card");
      }
    },
  });
  const off = useMutation({
    meta: { inline: true },
    mutationFn: () => hubFetch<{ ok: true }>(`${token}/autopay/off`, {}),
    onSuccess: () => {
      setAskOff(false);
      setTurnedOff(true);
      onChanged();
    },
  });
  const error = finish.error ?? setup.error ?? confirm.error ?? off.error;

  /** On to a step, read from its top. */
  const goTo = (next: Step) => {
    setStep(next);
    setup.reset();
    confirm.reset();
    requestAnimationFrame(() => heading.current?.focus());
  };

  const top = (
    <>
      <button type="button" className="hub-back" onClick={back}><Icon name="chevronLeft" size={16} />Your account</button>
      <h1 className="hub-h1">Pay automatically</h1>
      {preview && <div className="callout callout-info"><Icon name="eye" size={20} /><div className="grow">Preview: your client sets up autopay here.</div></div>}
    </>
  );

  if (!autopay) {
    return (
      <>
        {top}
        <div className="hub-card hub-calm">Autopay isn't available right now. Contact {data.company.name} to set it up.</div>
      </>
    );
  }

  // Back from Stripe's page, while the card is checked and saved.
  if (sessionId && !preview && !finish.isSuccess && !finish.isError) {
    return (
      <>
        {top}
        <div className="hub-card hub-calm" role="status"><Icon name="card" size={20} />Saving your card. One moment.</div>
      </>
    );
  }

  if (agreed || turnedOff) {
    const title = turnedOff ? "Autopay is off" : agreed!.status === "pending" ? "Almost done" : "Autopay is set up";
    const text = turnedOff
      ? "We'll send invoices to pay instead. You can set it up again anytime."
      : agreed!.status === "pending"
        ? "Your bank account is being checked. Charges start once it is."
        : `${agreed!.method} is set up. We'll charge it after each visit.`;
    return (
      <>
        {top}
        <div className="hub-card hub-done" role="status">
          <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
          <h2>{title}</h2>
          <p>{text}</p>
          <Button onClick={back}>Back to your account</Button>
        </div>
      </>
    );
  }

  const on = ["active", "paused", "pending", "needs_update"].includes(autopay.status);
  const nextVisit = data.visits[0]?.scheduled_on ?? null;

  // The business can't take autopay right now: their agreement shows, and they can turn it off.
  const onHold = autopay.available === false;

  // On autopay (or paused, or waiting on the bank): the card, since when, and what they can do.
  if (on && !changing && !saved && !refused) {
    const label = autopay.method?.label ?? "Your card";
    const state = onHold
      ? ON_HOLD_TEXT
      : autopay.status === "active"
        ? autopay.next_charge
          ? `Next charge ${autopayDueText(autopay.next_charge, tz)}.`
          : `We charge it ${autopay.timing}.`
        : autopay.status === "paused"
          ? "Autopay is paused. Contact us to turn it back on."
          : autopay.status === "pending"
            ? "Your bank account is being checked. Charges start once it is."
            : "Your card needs updating. Until it is, invoices come to you to pay.";
    return (
      <>
        {top}
        <section className="hub-card hub-autopay" aria-label="Your autopay">
          <div className="hub-autopay-body">
            <span className={`hub-icon-tile ${onHold ? "amber" : autopay.status === "active" ? "good" : autopay.status === "needs_update" ? "red" : "amber"}`}><Icon name="card" size={20} /></span>
            <span className="grow stack-xs">
              <strong className="hub-title">{label}</strong>
              <span className="hub-meta">
                {[autopay.since ? `Since ${shortDay(autopay.since, tz)}` : null, autopay.method?.exp ? `Expires ${autopay.method.exp}` : null].filter(Boolean).join(" · ")}
              </span>
            </span>
          </div>
          <p className="hub-autopay-state">{state}</p>
          {/* Paused by the office (a new card would start it again), or on hold: only turning it off. */}
          <div className="hub-card-actions" data-count={autopay.status === "paused" || onHold ? 1 : 2}>
            {autopay.status !== "paused" && !onHold && (
              <button type="button" disabled={preview} onClick={() => { setChanging(true); goTo("card"); }}>
                <Icon name="card" size={16} />{autopay.status === "needs_update" ? "Update card" : "Change card"}
              </button>
            )}
            <button type="button" disabled={preview || askOff} onClick={() => setAskOff(true)}><Icon name="x" size={16} />Turn off autopay</button>
          </div>
        </section>
        {askOff && (
          <div className="callout callout-warning" role="group" aria-labelledby="autopay-off-title">
            <Icon name="alert" size={20} />
            <div className="grow stack-sm">
              <strong id="autopay-off-title">Turn off autopay? We'll send invoices to pay instead.</strong>
              <div className="hub-step-actions">
                <Button variant="danger" loading={off.isPending} onClick={() => off.mutate()}>Turn off autopay</Button>
                <Button variant="ghost" onClick={() => setAskOff(false)}>Keep it on</Button>
              </div>
            </div>
          </div>
        )}
        <FormError error={error} />
      </>
    );
  }

  // Setting it up (or changing the card): three steps. A card waiting for the tick starts at the last.
  const wanted: Step = step ?? (method ? "agree" : changing || refused ? "card" : "how");
  // Nothing to agree to (the card was refused, or is gone): the card step.
  const current: Step = wanted === "agree" && !method ? "card" : wanted;
  const at = STEPS.findIndex((s) => s.step === current);
  const terms = (
    <blockquote className="hub-terms">
      <p className="pre-wrap">{autopay.terms}</p>
      <p>We charge {autopay.timing}.</p>
    </blockquote>
  );

  return (
    <>
      {top}
      <ol className="hub-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.step} aria-current={s.step === current ? "step" : undefined} data-done={i < at || undefined}>
            {i < at ? (
              <button type="button" onClick={() => goTo(s.step)}>
                <span className="hub-step-n"><Icon name="check" size={14} strokeWidth={2} /></span>
                {s.label}
                <span className="sr-only"> (done, go back)</span>
              </button>
            ) : (
              <span>
                <span className="hub-step-n">{i + 1}</span>
                {s.label}
              </span>
            )}
          </li>
        ))}
      </ol>

      {current === "how" && (
        <section className="card card-pad stack" aria-labelledby="autopay-how">
          <h2 id="autopay-how" ref={heading} tabIndex={-1} className="hub-step-title">How it works</h2>
          <ul className="hub-autopay-points">
            <li><Icon name="card" size={18} /><span>We charge your card or bank account {autopay.timing}.{autopay.per_visit === null ? "" : autopay.per_visit_taxed ? ` It's ${formatMoneyCents(autopay.per_visit)} per visit, plus tax.` : ` Each visit is ${formatMoneyCents(autopay.per_visit)}.`}</span></li>
            {nextVisit && <li><Icon name="calendar" size={18} /><span>Your next visit is {new Date(`${nextVisit}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}.</span></li>}
            <li><Icon name="receipt" size={18} /><span>Each charge is on its own invoice, which you can always see here.</span></li>
            <li><Icon name="x" size={18} /><span>Turn it off anytime on this page{data.company.phone ? `, or call us at ${data.company.phone}` : ", or by calling us"}.</span></li>
          </ul>
          {terms}
          <div className="hub-step-actions">
            <Button variant="primary" size="lg" icon="arrowRight" onClick={() => goTo(method ? "agree" : "card")}>Continue</Button>
          </div>
        </section>
      )}

      {current === "card" && (
        <section className="card card-pad stack" aria-labelledby="autopay-card">
          <h2 id="autopay-card" ref={heading} tabIndex={-1} className="hub-step-title">Add a card or bank account</h2>
          {refused ? (
            <div className="callout callout-danger" role="alert"><Icon name="alert" size={20} /><div className="grow">{refused}</div></div>
          ) : method ? (
            <p className="muted" style={{ margin: 0 }}>{autopay.imported && !saved ? `${method.label}, saved with us before.` : `${method.label} is saved.`} You can use it, or add another.</p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>You'll enter it on Stripe's secure page, then come back here. Your bank may ask you to confirm it. We never see the full card number.</p>
          )}
          <div className="hub-step-actions">
            {method && !refused && <Button variant="primary" size="lg" icon="arrowRight" wrap onClick={() => goTo("agree")}>Use {method.label}</Button>}
            <Button variant={method && !refused ? "secondary" : "primary"} size="lg" icon="lock" disabled={preview} loading={setup.isPending} onClick={() => setup.mutate()}>
              {refused ? "Try another card" : method ? "Add another card" : "Add a card or bank account"}
            </Button>
            {changing && !saved && <Button size="lg" variant="ghost" wrap onClick={() => { setChanging(false); setRefused(null); setStep(null); }}>Keep {autopay.method?.label ?? "your card"}</Button>}
          </div>
        </section>
      )}

      {current === "agree" && method && (
        <section className="card card-pad stack" aria-labelledby="autopay-agree">
          <h2 id="autopay-agree" ref={heading} tabIndex={-1} className="hub-step-title">Agree and finish</h2>
          <div className="hub-autopay-method">
            <Icon name={method.type === "us_bank_account" ? "bank" : "card"} size={20} />
            <strong>{method.label}</strong>
            {method.exp && <span className="muted small">Expires {method.exp}</span>}
          </div>
          {terms}
          <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (agree) confirm.mutate(); }}>
            <label className="checkbox">
              <input type="checkbox" checked={agree} disabled={preview} onChange={(e) => setAgree(e.target.checked)} />
              <span>I agree to these terms</span>
            </label>
            <div className="hub-step-actions">
              <Button type="submit" variant="primary" size="lg" icon="check" disabled={!agree || preview} loading={confirm.isPending}>Finish</Button>
            </div>
          </form>
        </section>
      )}

      <FormError error={error} />
    </>
  );
}
