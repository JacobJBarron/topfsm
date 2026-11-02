/**
 * The customer's account in the Client Hub: what's waiting on them first (quotes to approve, bills
 * to pay), then autopay and their next visit, quick actions, and history. Visits, "request work"
 * and autopay are their own views (?view=visits, ?view=request, ?view=autopay) so the back button
 * works.
 */
import { autopayDueText } from "@crewtavo/core/autopay";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { dateIn, formatDate, formatMoney, formatMoneyCents, formatTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { needsNewCard, waitingInvoices, type HubAutopay, type HubInvoiceAutopay } from "./document";
import { AutopayView, ON_HOLD_TEXT } from "./HubAutopay";

export interface PortalVisit {
  id: string;
  title: string;
  scheduled_on: string;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  completed_at: string | null;
  address: string | null;
  crew: string[];
}
export interface ClientView {
  kind: "client";
  company: { name: string; phone: string | null; email: string | null; website: string | null; timezone?: string | null; branding?: { color?: string } | null };
  /** The office's look at the page: it shows, and nothing on it can be done. */
  preview?: boolean;
  /** Their autopay. Null when the business doesn't take autopay; servers that don't send it have none. */
  autopay?: HubAutopay | null;
  client: { name: string; first_name: string; properties: Array<{ id: string; line1: string; city: string | null }> };
  /**
   * A quote out as a price range has its range and no total: the client hasn't seen the exact price.
   * One that offers options has how many and the lowest price (`options`) and no total, until they choose.
   */
  quotes: Array<{
    id: string; number: number; title: string; status: string; total: number | null;
    range?: { low: number; high: number; accepted_at: string | null } | null;
    options?: { count: number; from: number } | null;
    valid_until: string | null; approved_at: string | null; link: string;
  }>;
  /** `autopay`: what the automatic charge is doing on it. Servers that don't send it have none. */
  invoices: Array<{ id: string; number: number; subject: string | null; status: string; total: number; balance_due: number; due_on: string | null; issued_on: string; link: string; autopay?: HubInvoiceAutopay["status"] | null }>;
  visits: PortalVisit[];
  past_visits: PortalVisit[];
  /** `auto`: charged automatically, to `card` ("Visa ending 4242"). Servers that don't send them have none. */
  payments: Array<{ amount: number; tip_amount: number; method: string; received_at: string; invoice: number | null; auto?: boolean; card?: string | null }>;
  requests: Array<{ number: number; title: string; status: string; created_at: string }>;
  services: string[];
  refer: { link: string; offer: string | null } | null;
}

export type Fetch = <T>(path: string, body?: unknown, method?: "DELETE") => Promise<T>;

/** The company's time zone: times and dates in the Hub read as the company schedules them. */
export const hubZone = (company: { timezone?: string | null }) => company.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
/** The day a visit was finished, or its scheduled day. */
const doneOn = (v: PortalVisit, tz: string) => (v.completed_at ? dateIn(v.completed_at, tz) : v.scheduled_on);

const METHOD: Record<string, string> = { card: "card", ach: "bank transfer", cash: "cash", check: "check", other: "payment" };
const when = (v: PortalVisit, tz: string) =>
  v.starts_at && v.ends_at ? `Arriving between ${formatTime(v.starts_at, tz)} and ${formatTime(v.ends_at, tz)}` : v.starts_at ? `Starting at ${formatTime(v.starts_at, tz)}` : "Time to be confirmed";
const names = (crew: string[]) => (crew.length <= 1 ? crew[0] ?? "" : `${crew.slice(0, -1).join(", ")} and ${crew.at(-1)}`);

/** The views of the client's account, each its own ?view= so the back button works. */
export type PortalView = "home" | "visits" | "request" | "autopay";

export function ClientPortal({ token, data, hubFetch, onMessage, onChanged }: { token: string; data: ClientView; hubFetch: Fetch; onMessage: (visit?: PortalVisit) => void; onChanged: () => void }) {
  const [params, setParams] = useSearchParams();
  const view = params.get("view");
  const go = (next: PortalView) => {
    setParams(next === "home" ? {} : { view: next });
    window.scrollTo({ top: 0 });
  };
  if (view === "visits") return <Visits token={token} data={data} back={() => go("home")} onMessage={onMessage} />;
  if (view === "request") return <RequestWork token={token} data={data} hubFetch={hubFetch} back={() => go("home")} />;
  if (view === "autopay") return <AutopayView token={token} data={data} hubFetch={hubFetch} back={() => go("home")} onChanged={onChanged} />;
  return <Home token={token} data={data} go={go} onMessage={onMessage} />;
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="hub-section">
      <div className="hub-section-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function DateTile({ date }: { date: string }) {
  const d = new Date(`${date}T12:00:00Z`);
  return (
    <span className="hub-date" aria-hidden="true">
      <span className="dow">{d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}</span>
      <span className="day">{d.getUTCDate()}</span>
      <span className="mon">{d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}</span>
    </span>
  );
}

function Crew({ crew }: { crew: string[] }) {
  if (!crew.length) return null;
  return (
    <span className="hub-crew">
      <span className="faces">{crew.slice(0, 3).map((n) => <span key={n} className="face">{n.slice(0, 1)}</span>)}</span>
      {names(crew)}
    </span>
  );
}

function VisitCard({ token, visit, tz, onMessage }: { token: string; visit: PortalVisit; tz: string; onMessage: (visit: PortalVisit) => void }) {
  const live = visit.status === "en_route" ? "On the way" : visit.status === "in_progress" ? "Working now" : null;
  return (
    <article className="hub-card hub-visit">
      <div className="hub-visit-body">
        <DateTile date={visit.scheduled_on} />
        <div className="grow stack-xs">
          {live && <span className="hub-live">{live}</span>}
          <strong className="hub-title">{visit.title}</strong>
          <span className="hub-meta"><Icon name="clock" size={14} />{when(visit, tz)}</span>
          {visit.address && <span className="hub-meta"><Icon name="pin" size={14} />{visit.address}</span>}
          <Crew crew={visit.crew} />
        </div>
      </div>
      <div className="hub-card-actions">
        <a href={`/api/hub/${token}/visits/${visit.id}.ics`}><Icon name="calendar" size={16} />Add to calendar</a>
        <button type="button" onClick={() => onMessage(visit)}><Icon name="messages" size={16} />Ask to change</button>
      </div>
    </article>
  );
}

function Home({ token, data, go, onMessage }: { token: string; data: ClientView; go: (v: PortalView) => void; onMessage: (visit?: PortalVisit) => void }) {
  // A range they've said yes to waits on the business (to book the visit), not on them.
  const waitingQuotes = data.quotes.filter((q) => (q.status === "sent" || q.status === "changes_requested") && !q.range?.accepted_at);
  // One being charged to their card (or on its way from their bank) waits on the card, not on them.
  const owed = waitingInvoices(data.invoices);
  const next = data.visits[0];
  const tz = hubZone(data.company);
  // `day` is the date where the company is: a payment at 8:30 PM on Oct 16 in New York is Oct 17 in UTC.
  const recent = [
    ...data.payments.map((p) => ({
      at: p.received_at, day: dateIn(p.received_at, tz), icon: (p.auto ? "card" : "dollar") as IconName, tone: "good", title: p.invoice ? `Payment on invoice #${p.invoice}` : "Payment received",
      detail: p.auto ? `${formatMoneyCents(p.amount)} charged automatically to ${p.card ?? "your card"}` : `${formatMoneyCents(p.amount)} by ${METHOD[p.method] ?? "payment"}`,
      link: p.invoice ? data.invoices.find((i) => i.number === p.invoice)?.link : undefined,
    })),
    ...data.past_visits.map((v) => ({ at: v.completed_at ?? `${v.scheduled_on}T12:00:00Z`, day: doneOn(v, tz), icon: "check" as IconName, tone: "good", title: `${v.title} done`, detail: v.crew.length ? `by ${names(v.crew)}` : "Visit complete", link: undefined })),
    ...data.quotes.filter((q) => q.approved_at).map((q) => ({ at: q.approved_at!, day: dateIn(q.approved_at!, tz), icon: "quote" as IconName, tone: "blue", title: `You approved quote #${q.number}`, detail: q.title, link: q.link })),
    ...data.quotes.filter((q) => q.range?.accepted_at).map((q) => ({ at: q.range!.accepted_at!, day: dateIn(q.range!.accepted_at!, tz), icon: "calendar" as IconName, tone: "blue", title: "You asked for a visit", detail: q.title, link: q.link })),
    ...data.requests.map((r) => ({ at: r.created_at, day: dateIn(r.created_at, tz), icon: "requests" as IconName, tone: "plain", title: `Request #${r.number} received`, detail: r.title, link: undefined })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);

  const share = async () => {
    if (!data.refer) return;
    const text = `${data.company.name} did great work for us.${data.refer.offer ? ` ${data.refer.offer}` : ""}`;
    if (navigator.share) {
      await navigator.share({ title: data.company.name, text, url: data.refer.link }).catch(() => undefined);
    } else {
      await navigator.clipboard.writeText(data.refer.link).then(() => toast.success("Link copied. Paste it in a text or email."), () => toast.error("Couldn't copy the link."));
    }
  };

  return (
    <>
      <section className="hub-hello">
        <h1>Hi {data.client.first_name}</h1>
        {data.client.properties[0] && (
          <span className="hub-chip"><Icon name="pin" size={14} />{data.client.properties[0].line1}{data.client.properties.length > 1 ? ` + ${data.client.properties.length - 1} more` : ""}</span>
        )}
      </section>

      <Section title={waitingQuotes.length || owed.length ? "Waiting on you" : "All caught up"}>
        {waitingQuotes.length === 0 && owed.length === 0 && (
          <div className="hub-card hub-calm"><Icon name="check" size={20} />Nothing needs your attention right now.</div>
        )}
        {waitingQuotes.map((q) =>
          q.range ? (
            <article key={q.id} className="hub-card hub-todo">
              <div className="hub-todo-head">
                <span className="hub-icon-tile blue"><Icon name="roofing" size={20} /></span>
                <span className="grow stack-xs">
                  <span className="hub-meta">Estimate #{q.number}{q.valid_until ? ` · good until ${formatDate(q.valid_until)}` : ""}</span>
                  <strong className="hub-title">{q.title}</strong>
                  <span className="hub-range-line">Between {formatMoney(q.range.low)} and {formatMoney(q.range.high)}</span>
                </span>
              </div>
              <a className="hub-btn hub-btn-brand" href={q.link}>See your estimate</a>
            </article>
          ) : (
            <article key={q.id} className="hub-card hub-todo">
              <div className="hub-todo-head">
                <span className="hub-icon-tile blue"><Icon name="quote" size={20} /></span>
                <span className="grow stack-xs">
                  <span className="hub-meta">Quote #{q.number}{q.status === "changes_requested" ? " · you asked for changes" : q.valid_until ? ` · valid until ${formatDate(q.valid_until)}` : ""}</span>
                  <strong className="hub-title">{q.title}</strong>
                  {q.options && <span className="hub-range-line">{q.options.count} options, from {formatMoneyCents(q.options.from)}</span>}
                </span>
                {!q.options && q.total !== null && <strong className="hub-amount">{formatMoneyCents(q.total)}</strong>}
              </div>
              <a className="hub-btn hub-btn-brand" href={q.link}>{q.options ? "See your options" : "Review and approve"}</a>
            </article>
          ),
        )}
        {owed.map((i) => (
          <article key={i.id} className="hub-card hub-todo">
            <div className="hub-todo-head">
              <span className={`hub-icon-tile ${i.status === "overdue" ? "red" : "amber"}`}><Icon name="invoice" size={20} /></span>
              <span className="grow stack-xs">
                <span className="hub-meta" style={i.status === "overdue" ? { color: "var(--danger)", fontWeight: 600 } : undefined}>Invoice #{i.number}{i.due_on ? ` · ${i.status === "overdue" ? "was due" : "due"} ${formatDate(i.due_on)}` : ""}</span>
                <strong className="hub-title">{i.subject ?? "Balance due"}</strong>
              </span>
              <strong className="hub-amount">{formatMoneyCents(i.balance_due)}</strong>
            </div>
            {needsNewCard(i) && <span className="hub-meta">We couldn't charge your card for this one.</span>}
            <a className="hub-btn hub-btn-dark" href={i.link}><Icon name="lock" size={16} />Pay {formatMoneyCents(i.balance_due)}</a>
            {needsNewCard(i) && data.autopay && data.autopay.available !== false && <button type="button" className="hub-link" onClick={() => go("autopay")}>Update your card</button>}
          </article>
        ))}
      </Section>

      {data.autopay && <AutopayCard autopay={data.autopay} timeZone={tz} go={go} />}

      {next && (
        <Section title="Next visit" action={data.visits.length > 1 || data.past_visits.length ? <button type="button" className="hub-link" onClick={() => go("visits")}>All visits</button> : undefined}>
          <VisitCard token={token} visit={next} tz={tz} onMessage={onMessage} />
        </Section>
      )}

      <section className="hub-actions" aria-label="Quick actions" data-count={data.refer ? 3 : 2}>
        <button type="button" onClick={() => go("request")}><span className="hub-icon-tile brand"><Icon name="plus" size={20} /></span>Request work</button>
        <button type="button" onClick={() => onMessage()}><span className="hub-icon-tile plain"><Icon name="messages" size={20} /></span>Message us</button>
        {data.refer && <button type="button" onClick={share}><span className="hub-icon-tile amber"><Icon name="gift" size={20} /></span>Refer a friend</button>}
      </section>

      {recent.length > 0 && (
        <Section title="Recent" action={!next && data.past_visits.length ? <button type="button" className="hub-link" onClick={() => go("visits")}>All visits</button> : undefined}>
          <div className="hub-card hub-list">
            {recent.map((r, i) => {
              const body = (
                <>
                  <span className={`hub-icon-tile small ${r.tone}`}><Icon name={r.icon} size={16} /></span>
                  <span className="grow stack-xs">
                    <strong>{r.title}</strong>
                    <span className="hub-meta">{formatDate(r.day)} · {r.detail}</span>
                  </span>
                  {r.link && <Icon name="chevronRight" size={16} />}
                </>
              );
              return r.link ? <a key={i} href={r.link} className="hub-list-row">{body}</a> : <div key={i} className="hub-list-row">{body}</div>;
            })}
          </div>
        </Section>
      )}

      {data.refer && (
        <section className="hub-refer">
          <h2>Know someone who could use {data.company.name}?</h2>
          {data.refer.offer && <p>{data.refer.offer}</p>}
          <button type="button" onClick={share}>Share my link</button>
        </section>
      )}
    </>
  );
}

/**
 * Autopay on the client's home, between what's waiting on them and the next visit: on ("Paid
 * automatically · Visa ending 4242", the next charge, Change card and Turn off), a step left or a
 * state to know about, or, when they're not on it, a card that starts it. All lead to ?view=autopay.
 * On hold while the business can't take autopay: only Turn off.
 */
function AutopayCard({ autopay, timeZone, go }: { autopay: HubAutopay; timeZone: string; go: (v: PortalView) => void }) {
  const open = () => go("autopay");
  const label = autopay.method?.label ?? "your card";
  const onHold = autopay.available === false;
  if (autopay.status === "active" && !onHold) {
    return (
      <article className="hub-card hub-autopay" aria-label="Autopay">
        <div className="hub-autopay-body">
          <span className="hub-icon-tile good"><Icon name="card" size={20} /></span>
          <span className="grow stack-xs">
            <strong className="hub-title">Paid automatically · {label}</strong>
            <span className="hub-meta">{autopay.next_charge ? `Next charge ${autopayDueText(autopay.next_charge, timeZone)}` : `Charged ${autopay.timing}`}</span>
          </span>
        </div>
        <div className="hub-card-actions">
          <button type="button" onClick={open}><Icon name="card" size={16} />Change card</button>
          <button type="button" onClick={open}><Icon name="x" size={16} />Turn off</button>
        </div>
      </article>
    );
  }
  if (autopay.status === "off") {
    return (
      <article className="hub-card hub-todo" aria-label="Autopay">
        <div className="hub-todo-head">
          <span className="hub-icon-tile brand"><Icon name="card" size={20} /></span>
          <span className="grow stack-xs">
            <strong className="hub-title">Pay automatically after each visit</strong>
            <span className="hub-meta">Save a card once, and we charge it {autopay.timing}.</span>
          </span>
        </div>
        <button type="button" className="hub-btn hub-btn-brand" onClick={open}>Pay automatically</button>
      </article>
    );
  }
  // A step left (agree), or a state to know about: one line, with what to do when there's something.
  // Active gets here only on hold.
  const state = onHold || autopay.status === "active" ? { tone: "amber", title: `Autopay is on hold · ${label}`, line: ON_HOLD_TEXT, action: "Turn off" } : {
    agree: { tone: "brand", title: autopay.imported ? `We have your ${label} on file` : `${autopay.method?.label ?? "Your card"} is saved`, line: "Agree to the terms to start paying automatically.", action: "Finish setting up" },
    pending: { tone: "amber", title: "Your bank account is being checked", line: "This takes a few days. Charges start once it's done.", action: null },
    paused: { tone: "amber", title: "Autopay is paused", line: "Contact us to turn it back on.", action: null },
    needs_update: { tone: "red", title: "Your card needs updating", line: `We couldn't charge ${label}. Until it's updated, invoices come to you to pay.`, action: "Update card" },
  }[autopay.status];
  return (
    <article className="hub-card hub-autopay" aria-label="Autopay">
      <div className="hub-autopay-body">
        <span className={`hub-icon-tile ${state.tone}`}><Icon name="card" size={20} /></span>
        <span className="grow stack-xs">
          <strong className="hub-title">{state.title}</strong>
          <span className="hub-meta">{state.line}</span>
        </span>
      </div>
      <div className="hub-card-actions" data-count={1}>
        <button type="button" onClick={open}>{state.action ?? "See autopay"}</button>
      </div>
    </article>
  );
}

function Visits({ token, data, back, onMessage }: { token: string; data: ClientView; back: () => void; onMessage: (visit?: PortalVisit) => void }) {
  const tz = hubZone(data.company);
  return (
    <>
      <button type="button" className="hub-back" onClick={back}><Icon name="chevronLeft" size={16} />Your account</button>
      <h1 className="hub-h1">Visits</h1>
      <Section title="Coming up">
        {data.visits.length === 0 ? <div className="hub-card hub-calm">Nothing scheduled right now.</div> : data.visits.map((v) => <VisitCard key={v.id} token={token} visit={v} tz={tz} onMessage={onMessage} />)}
      </Section>
      {data.past_visits.length > 0 && (
        <Section title="Done">
          <div className="hub-card hub-list">
            {data.past_visits.map((v) => (
              <div key={v.id} className="hub-list-row">
                <span className="hub-icon-tile small good"><Icon name="check" size={16} /></span>
                <span className="grow stack-xs">
                  <strong>{v.title}</strong>
                  <span className="hub-meta">{formatDate(doneOn(v, tz))}{v.crew.length ? ` · ${names(v.crew)}` : ""}</span>
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function RequestWork({ token, data, hubFetch, back }: { token: string; data: ClientView; hubFetch: Fetch; back: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [propertyId, setPropertyId] = useState(data.client.properties[0]?.id ?? "");
  const [details, setDetails] = useState("");
  const [timing, setTiming] = useState<"asap" | "month" | "flexible">("month");
  const [promo, setPromo] = useState("");
  const [tried, setTried] = useState(false);
  const title = [...picked, other.trim()].filter(Boolean).join(", ");
  const send = useMutation({
    mutationFn: () =>
      hubFetch<{ reference: number }>(`${token}/request`, {
        title: title.length >= 3 ? title.slice(0, 200) : details.trim().split("\n")[0].slice(0, 200) || "New request",
        details: details.trim() || undefined,
        property_id: propertyId || undefined,
        timing,
        promo_code: promo.trim() || undefined,
      }),
  });
  const ready = title.length >= 3 || details.trim().length >= 3;

  if (send.isSuccess) {
    return (
      <>
        <button type="button" className="hub-back" onClick={back}><Icon name="chevronLeft" size={16} />Your account</button>
        <div className="hub-card hub-done">
          <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
          <h2>Request sent</h2>
          <p>{data.company.name} will get back to you with a quote or a time to come look. Your reference is #{send.data.reference}.</p>
          <Button onClick={back}>Back to your account</Button>
        </div>
      </>
    );
  }
  return (
    <>
      <button type="button" className="hub-back" onClick={back}><Icon name="chevronLeft" size={16} />Your account</button>
      <h1 className="hub-h1">Request work</h1>
      <form className="hub-form" onSubmit={(e: FormEvent) => { e.preventDefault(); setTried(true); if (ready) send.mutate(); }}>
        <fieldset>
          <legend>What do you need?</legend>
          {data.services.length > 0 && (
            <div className="hub-choices">
              {data.services.map((s) => {
                const on = picked.includes(s);
                return (
                  <label key={s} className="hub-choice" data-on={on || undefined}>
                    <input type="checkbox" checked={on} onChange={(e) => setPicked(e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))} />
                    {s}
                  </label>
                );
              })}
            </div>
          )}
          <input className="input" value={other} onChange={(e) => setOther(e.target.value)} placeholder={data.services.length ? "Something else" : "Fall cleanup, a repair, a new estimate…"} maxLength={160} aria-label="Something else" aria-invalid={(tried && !ready) || undefined} />
          {/* The button stays on; trying it with nothing picked says what's missing, here. */}
          {tried && !ready && <span className="field-error" role="alert">Pick what you need, or tell us about it below.</span>}
        </fieldset>
        {data.client.properties.length > 1 && (
          <fieldset>
            <legend>Where?</legend>
            {data.client.properties.map((p) => (
              <label key={p.id} className="hub-radio" data-on={propertyId === p.id || undefined}>
                <input type="radio" name="property" checked={propertyId === p.id} onChange={() => setPropertyId(p.id)} />
                <span><strong>{p.line1}</strong>{p.city && <span className="hub-meta">{p.city}</span>}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="field">Tell us about it <span className="optional">(optional)</span>
          <textarea className="textarea" rows={4} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} placeholder="What's going on, and anything we should know before we come out." />
        </label>
        <fieldset>
          <legend>When would you like it done?</legend>
          <div className="hub-choices three">
            {([["asap", "As soon as possible"], ["month", "In the next month"], ["flexible", "I'm flexible"]] as const).map(([k, l]) => (
              <label key={k} className="hub-choice" data-on={timing === k || undefined}>
                <input type="radio" name="timing" checked={timing === k} onChange={() => setTiming(k)} />
                {l}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">Promo code <span className="optional">(optional)</span>
          <input className="input mono" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} maxLength={24} autoCapitalize="characters" />
        </label>
        <FormError error={send.error} />
        <Button type="submit" variant="primary" size="lg" icon="send" className="hub-submit" loading={send.isPending}>Send request</Button>
      </form>
    </>
  );
}

/** "Message us" and "Ask to change" both land in the office's message center. */
export function MessageDialog({ token, company, visit, hubFetch, onClose }: { token: string; company: string; visit?: PortalVisit; hubFetch: Fetch; onClose: () => void }) {
  const [message, setMessage] = useState(visit ? `Could we move the ${visit.title.toLowerCase()} visit on ${formatDate(visit.scheduled_on)}? ` : "");
  const send = useMutation({
    mutationFn: () => hubFetch(`${token}/message`, { message: message.trim(), visit_id: visit?.id }),
    onSuccess: () => {
      toast.success("Message sent", { description: `${company} will get back to you.` });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={visit ? "Ask to change a visit" : `Message ${company}`} description={visit ? `${visit.title}, ${formatDate(visit.scheduled_on)}` : "They'll reply by email or text."}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
        <Field label={visit ? "What works better for you?" : "Your message"} requiredMessage={visit ? "Tell us a day or time that works better." : "Write your message, and we'll get back to you."}>
          <textarea className="textarea" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} required autoFocus />
        </Field>
        <FormError error={send.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending}>Send</Button>
        </div>
      </form>
    </Dialog>
  );
}
