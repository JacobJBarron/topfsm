import { askChannels, askRefusal, creditMoney, marketingOn, notAsked, reachOf, referralAskRefusal, referralsReady, textsOff, type AskChannel } from "@crewtavo/core/marketing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { MapsLink } from "@/components/ui/MapsLink";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, PageError } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { addressLine, formatDate, formatMoney } from "@/lib/format";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { PlansCard } from "../plans/PlansCard";
import { NewQuoteDialog } from "../quotes/NewQuoteDialog";
import { listPrice, withOptionLines } from "../quotes/options";
import { NewRequestDialog } from "../requests/NewRequestDialog";
import { EditClientDialog } from "./ClientForm";
import { AddContact, ContactsCard, useClientContacts } from "./ContactsCard";
import { PropertyDialog, type AccessRow, type PropertyRow } from "./PropertyDialog";
import { Timeline } from "./Timeline";

type WorkTab = "requests" | "quotes" | "jobs" | "invoices";
type ClientPatch = { status?: "lead" | "active" | "archived"; marketing_opt_out?: boolean; review_opt_out?: boolean };
/** The client's switches, which move the moment they're flipped. */
const SWITCHES = ["marketing_opt_out", "review_opt_out"] as const;

export function ClientPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Null until someone picks a tab: until then it opens on the first kind of work the client has.
  const [picked, setPicked] = useState<WorkTab | null>(null);
  const workRef = useRef<HTMLElement>(null);
  const [dialog, setDialog] = useState<null | "edit" | "request" | "quote">(null);
  const [property, setProperty] = useState<{ row?: PropertyRow; access?: AccessRow | null } | null>(null);
  const isOffice = hasRole(session, "admin", "office");
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  const contacts = useClientContacts(id);

  const client = useQuery({
    queryKey: ["client", id],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("clients")
          .select("id, display_name, company_name, email, phone, status, tags, lead_source, notes, created_at, billing_address, marketing_opt_out, review_opt_out, sms_opt_out_at, reviewed_at, referred_by, properties(id, label, line1, line2, city, region, postal_code, lat, lng, notes)")
          .eq("id", id)
          .maybeSingle(),
        "This client",
      ),
  });
  const c = client.data;
  useRememberRecent(session.company.id, c ? { kind: "client", id: c.id, title: c.display_name, subtitle: c.properties[0] ? addressLine(c.properties[0]) : c.email ?? undefined, path: `/clients/${c.id}` } : null);

  const referrer = useQuery({
    queryKey: ["client", c?.referred_by, "name"],
    enabled: Boolean(c?.referred_by),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("clients").select("id, display_name").eq("id", c!.referred_by!).maybeSingle()),
  }).data;
  const access = useQuery({
    queryKey: ["client", id, "access", c?.properties.map((p) => p.id).join(",")],
    enabled: isOffice && Boolean(c?.properties.length),
    queryFn: async () => unwrap(await supabase().from("property_access").select("property_id, gate_code, lockbox_code, instructions").in("property_id", c!.properties.map((p) => p.id))),
  });
  const work = useQuery({
    queryKey: ["client", id, "work"],
    queryFn: async () => {
      const db = supabase();
      const [requests, quotes, jobs, invoices] = await Promise.all([
        db.from("requests").select("id, number, title, status, created_at").eq("client_id", id).order("created_at", { ascending: false }),
        // Priced as the quotes list prices them (listPrice): one offering options starts from its cheapest.
        db.from("quotes").select("id, number, title, status, total, tax_rate, discount_amount, promo:promo_codes(kind, value), updated_at, options:quote_options!quote_options_quote_fkey(id)").eq("client_id", id).order("created_at", { ascending: false }),
        db.from("jobs").select("id, number, title, status, kind, financials:job_financials(contract_total)").eq("client_id", id).order("created_at", { ascending: false }),
        isOffice ? db.from("invoices").select("id, number, status, total, balance_due, due_on").eq("client_id", id).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
      ]);
      return { requests: unwrap(requests), quotes: await withOptionLines(unwrap(quotes)), jobs: unwrap(jobs), invoices: unwrap(invoices) as Array<{ id: string; number: number | null; status: string; total: number; balance_due: number; due_on: string | null }> };
    },
  });

  const update = useMutation({
    // The switches show their own change, so only archiving and restoring say so.
    meta: { success: (_: unknown, patch: ClientPatch) => (patch.status === "archived" ? "Client archived" : patch.status ? "Client restored" : null) },
    mutationFn: async (patch: ClientPatch) => unwrap(await supabase().from("clients").update(patch).eq("id", id)),
    // A switch moves the moment it's flipped, and back if the save fails.
    onMutate: async (patch) => {
      const key = SWITCHES.find((k) => patch[k] !== undefined);
      if (!key) return;
      await queryClient.cancelQueries({ queryKey: ["client", id], exact: true });
      queryClient.setQueryData<typeof client.data>(["client", id], (old) => old && { ...old, [key]: Boolean(patch[key]) });
    },
    onError: (_error, patch) => {
      const key = SWITCHES.find((k) => patch[k] !== undefined);
      if (key) queryClient.setQueryData<typeof client.data>(["client", id], (old) => old && { ...old, [key]: !patch[key] });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["client", id] });
      queryClient.invalidateQueries({ queryKey: ["clients", session.company.id] });
    },
  });
  const remove = useMutation({
    meta: { success: "Client deleted" },
    mutationFn: async () => unwrap(await supabase().from("clients").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients", session.company.id] });
      navigate("/clients", { replace: true });
    },
  });
  const removeProperty = useMutation({
    // Undo's toast says how it went (removeLater below).
    meta: { inline: true },
    mutationFn: async (propertyId: string) => unwrap(await supabase().from("properties").delete().eq("id", propertyId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["client", id] }),
  });
  const hubLink = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/clients/${id}/hub-link`),
    onSuccess: (r) => copyText(r.link, "Client Hub link copied"),
  });
  const referralLink = useMutation({
    mutationFn: () => api.get<{ link: string }>(`/referrals/link/${id}`),
    onSuccess: (r) => copyText(r.link, "Referral link copied"),
  });
  const referralAsk = useMutation({
    mutationFn: () => api.post<{ sent: boolean; detail: string }>("/referrals/request", { client_id: id }),
    onSuccess: (r) => toast.success(r.detail),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["referral-asks", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["referral-ask", id] });
    },
  });
  // Credits they've earned and that aren't on an invoice yet: shown whether Marketing is installed
  // or not, since they still go on their invoices.
  const credits = useQuery({
    queryKey: ["referral-credits-for", id],
    enabled: isOffice && can(session, "invoices"),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("referral_credits_for", { p_company: session.company.id, p_client: id })),
  });
  const review = useMutation({
    mutationFn: (channel: AskChannel) => api.post<{ sent: boolean; detail: string }>("/reviews/request", { client_id: id, channel }),
    onSuccess: (r) => toast.success(r.detail),
    // Marketing → Reviews lists the ask, failed or not, and "Ask a client now" says when they were last asked.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["review-requests", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["review-ask", id] });
    },
  });
  // Review asks and referrals are Marketing's: while it's uninstalled they aren't offered here.
  const marketing = marketingOn(session.company.settings);

  if (client.isPending) return <DetailSkeleton />;
  if (client.error || !c) return <PageError error={client.error} onRetry={() => client.refetch()} back={<BackLink to="/clients">Clients</BackLink>} />;

  const unpaid = work.data?.invoices.filter((i) => ["sent", "partially_paid", "overdue"].includes(i.status)) ?? [];
  const stopped = textsOff(c);
  // The review asks offered are the ones that can go: not to a client who opted out or is archived,
  // nor by a way this Crewtavo can't send or the client can't get.
  const ready = { email: session.config.features.email, sms: session.config.features.sms };
  const cannotAsk = (channel: AskChannel) => Boolean(askRefusal(c, channel, ready));
  const bothWays = !notAsked(c) && askChannels("both", reachOf(c, ready), false).send.length === 2;
  const owed = unpaid.reduce((sum, i) => sum + Number(i.balance_due), 0);
  const pastDue = unpaid.reduce((sum, i) => sum + (i.status === "overdue" ? Number(i.balance_due) : 0), 0);
  // Never paid, and taken as a loss: worth knowing before taking on more work for them.
  const writtenOff = work.data?.invoices.reduce((sum, i) => sum + (i.status === "written_off" ? Number(i.balance_due) : 0), 0) ?? 0;
  const counts = { requests: work.data?.requests.length ?? 0, quotes: work.data?.quotes.length ?? 0, jobs: work.data?.jobs.length ?? 0, invoices: work.data?.invoices.length ?? 0 };
  const hasWork = counts.quotes + counts.jobs + counts.invoices > 0;
  const tabs: WorkTab[] = ["requests", "quotes", "jobs", ...(isOffice ? (["invoices"] as const) : [])];
  // In the order work happens. While it loads none is chosen, so the underline doesn't slide over on arrival.
  const tab = picked ?? (work.data ? tabs.find((t) => counts[t] > 0) : undefined);
  const noWork = Boolean(work.data) && tabs.every((t) => counts[t] === 0);
  const accessFor = (pid: string) => access.data?.find((a) => a.property_id === pid) ?? null;
  const billing = c.billing_address as { line1?: string; city?: string; region?: string; postal_code?: string } | null;

  const deleteClient = async () => {
    if (hasWork) {
      if (await confirm({ title: `Archive ${c.display_name} instead?`, body: "This client has quotes, jobs or invoices, so deleting would erase that history. Archiving hides them from lists and keeps the records.", confirmLabel: "Archive client" })) update.mutate({ status: "archived" });
      return;
    }
    if (await confirm({ title: `Delete ${c.display_name}?`, body: "Their properties, requests, notes and contacts are deleted too. This can't be undone.", confirmLabel: "Delete client", danger: true })) remove.mutate();
  };

  /** Takes the property off the page at once; it's deleted when the Undo toast leaves. */
  const removeLater = (p: (typeof c.properties)[number]) => {
    const key = ["client", id];
    let at = -1;
    undoable({
      title: "Property removed",
      description: "Its requests, quotes and jobs keep their history.",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key, exact: true });
        queryClient.setQueryData<typeof client.data>(key, (old) => {
          if (!old) return old;
          at = old.properties.findIndex((x) => x.id === p.id);
          return { ...old, properties: old.properties.filter((x) => x.id !== p.id) };
        });
      },
      restore: () =>
        queryClient.setQueryData<typeof client.data>(key, (old) => {
          if (!old || old.properties.some((x) => x.id === p.id)) return old;
          const properties = [...old.properties];
          properties.splice(at < 0 ? properties.length : Math.min(at, properties.length), 0, p);
          return { ...old, properties };
        }),
      commit: () => removeProperty.mutateAsync(p.id),
    });
  };

  // The balance opens this client's invoices just below: the invoices list has no filter for one client.
  const showInvoices = () => {
    setPicked("invoices");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    workRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    document.getElementById("work-tab-invoices")?.focus({ preventScroll: true });
  };

  return (
    <>
      <BackLink to="/clients">Clients</BackLink>
      <PageHeader
        title={c.display_name}
        actions={
          <>
            {canSell && <Button icon="requests" onClick={() => setDialog("request")}>New request</Button>}
            {canSell && <Button variant="primary" icon="plus" onClick={() => setDialog("quote")}>New quote</Button>}
            {canSell && (
              <Menu
                items={[
                  { label: "Edit client", icon: "edit", onSelect: () => setDialog("edit") },
                  { label: "Copy Client Hub link", icon: "link", onSelect: () => hubLink.mutate() },
                  { separator: true, hidden: !marketing },
                  // A client who already left a Google review isn't asked again: the one line says so.
                  { label: "Already left a Google review", icon: "star", onSelect: () => undefined, disabled: true, hidden: !marketing || !c.reviewed_at },
                  { label: "Ask for a review by email", icon: "star", onSelect: () => review.mutate("email"), disabled: cannotAsk("email"), hidden: !marketing || Boolean(c.reviewed_at) },
                  { label: "Ask for a review by text", icon: "star", onSelect: () => review.mutate("sms"), disabled: cannotAsk("sms"), hidden: !marketing || Boolean(c.reviewed_at) },
                  { label: "Ask for a review by text and email", icon: "star", onSelect: () => review.mutate("both"), disabled: !bothWays, hidden: !marketing || Boolean(c.reviewed_at) },
                  { label: "Ask for referrals by email", icon: "gift", onSelect: () => referralAsk.mutate(), hidden: !marketing,
                    disabled: !referralsReady(session.company.settings) || Boolean(referralAskRefusal(c, session.config.features.email)) },
                  { label: "Copy referral link", icon: "link", onSelect: () => referralLink.mutate(), hidden: !marketing },
                  { separator: true, hidden: !isOffice },
                  { label: c.status === "archived" ? "Restore client" : "Archive client", icon: c.status === "archived" ? "undo" : "archive", onSelect: () => update.mutate({ status: c.status === "archived" ? "active" : "archived" }), hidden: !isOffice },
                  { label: "Delete client", icon: "trash", danger: true, onSelect: deleteClient, hidden: !isOffice },
                ]}
              />
            )}
          </>
        }
      />
      <div className="page-meta">
        <EntityStatus kind="client" status={c.status} />
        {c.company_name && c.company_name !== c.display_name && <span className="muted">{c.company_name}</span>}
        {c.tags.map((t) => <span key={t} className="tag">{t}</span>)}
        {c.marketing_opt_out && <span className="chip chip-amber">Unsubscribed from marketing</span>}
        {c.review_opt_out && <span className="chip chip-amber">No review asks</span>}
        {c.reviewed_at && <ReviewedChip clientId={c.id} />}
        {stopped && <span className="chip chip-amber">Texts off</span>}
      </div>
      {c.status === "archived" && (
        <div className="callout callout-warning">
          <Icon name="archive" size={20} />
          <div className="grow">This client is archived.</div>
          {isOffice && <Button size="sm" onClick={() => update.mutate({ status: "active" })} loading={update.isPending && update.variables?.status === "active"}>Restore client</Button>}
        </div>
      )}

      <div className="two-col">
        <div className="wide stack-lg">
          <section className="stack" aria-labelledby="props-title">
            <div className="section-head">
              <h2 id="props-title" className="section-title">Properties</h2>
              {canSell && c.properties.length > 0 && <Button size="sm" icon="plus" onClick={() => setProperty({})}>Add property</Button>}
            </div>
            {c.properties.length === 0 ? (
              <div className="card">
                <EmptyState inline title="No service address yet" action={canSell && <Button icon="plus" onClick={() => setProperty({})}>Add property</Button>} />
              </div>
            ) : (
              <div className="grid-cards">
                {c.properties.map((p) => {
                  const codes = accessFor(p.id);
                  // A label that only repeats the street isn't a name: the address is the heading then.
                  const label = p.label?.trim() && p.label.trim().toLowerCase() !== p.line1.trim().toLowerCase() ? p.label.trim() : null;
                  return (
                    <div key={p.id} className="card card-pad stack-sm">
                      <div className="row-between" style={{ alignItems: "flex-start" }}>
                        <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                          {label ? (
                            <>
                              <strong>{label}</strong>
                              {/* Sized by its wrapper: .address-link takes its font from around it. */}
                              <span className="text-sm"><MapsLink place={p}>{addressLine(p)}</MapsLink></span>
                            </>
                          ) : (
                            <strong><MapsLink place={p}>{addressLine(p)}</MapsLink></strong>
                          )}
                        </div>
                        {canSell && (
                          <Menu
                            triggerClassName="btn btn-sm btn-ghost btn-icon"
                            label="Property actions"
                            items={[
                              { label: "Edit property", icon: "edit", onSelect: () => setProperty({ row: p, access: codes }) },
                              { label: "Measure on the map", icon: "area", onSelect: () => navigate(`/measure?property=${p.id}${p.lat != null ? `&lat=${p.lat}&lng=${p.lng}` : ""}`) },
                              { label: "Remove property", icon: "trash", danger: true, hidden: !isOffice, onSelect: () => removeLater(p) },
                            ]}
                          />
                        )}
                      </div>
                      {(codes?.gate_code || codes?.lockbox_code) && (
                        <div className="row wrap text-sm" style={{ gap: 12 }}>
                          {codes.gate_code && <span><Icon name="lock" size={14} /> Gate <strong>{codes.gate_code}</strong></span>}
                          {codes.lockbox_code && <span><Icon name="lock" size={14} /> Lockbox <strong>{codes.lockbox_code}</strong></span>}
                        </div>
                      )}
                      {codes?.instructions && <span className="muted small pre-wrap">{codes.instructions}</span>}
                      {p.notes && <span className="muted small pre-wrap">{p.notes}</span>}
                      <div className="row wrap" style={{ marginTop: 4 }}>
                        <MapsLink className="btn btn-sm" place={p}><Icon name="navigation" size={14} />Directions</MapsLink>
                        {p.lat == null && <span className="muted small" title="Routing and weather checks need a map location">Not on the map yet</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Clear of the sticky top bar when the balance scrolls here. */}
          <section ref={workRef} className="stack" aria-label="Work" style={{ scrollMarginTop: "calc(var(--topbar-height) + 16px)" }}>
            {noWork ? (
              <div className="card">
                <EmptyState inline title={isOffice ? "No requests, quotes, jobs or invoices yet" : "No requests, quotes or jobs yet"} action={canSell && <Button icon="plus" onClick={() => setDialog("quote")}>New quote</Button>} />
              </div>
            ) : (
              <>
                <div className="underline-tabs" role="tablist" aria-label="Work for this client">
                  {tabs.map((t) => (
                    <button key={t} id={`work-tab-${t}`} type="button" role="tab" aria-selected={tab === t} aria-controls="work-panel" onClick={() => setPicked(t)}>
                      {t[0].toUpperCase() + t.slice(1)} <span className="badge">{work.isPending ? "·" : counts[t]}</span>
                    </button>
                  ))}
                </div>
                <div id="work-panel" className="card" role="tabpanel" aria-labelledby={tab ? `work-tab-${tab}` : undefined}>
                  {work.isPending && [0, 1, 2].map((i) => <div key={i} className="card-row"><Skeleton width={40} /><Skeleton width="45%" /><span className="grow" /><Skeleton width={84} height={22} radius={999} /></div>)}
                  {work.error && <ErrorState compact error={work.error} onRetry={() => work.refetch()} />}
                  {work.data && tab === "requests" && (
                    <WorkList empty="No requests yet" rows={work.data.requests.map((r) => ({ to: `/requests/${r.id}`, number: r.number, title: r.title, right: formatDate(r.created_at), status: <EntityStatus kind="request" status={r.status} /> }))} />
                  )}
                  {work.data && tab === "quotes" && (
                    <WorkList
                      empty="No quotes yet"
                      rows={work.data.quotes.map((q) => {
                        const price = listPrice(q);
                        return { to: `/quotes/${q.id}`, number: q.number, title: q.title, right: price.from ? `From ${formatMoney(price.amount)}` : formatMoney(price.amount), status: <EntityStatus kind="quote" status={q.status} /> };
                      })}
                    />
                  )}
                  {work.data && tab === "jobs" && (
                    <WorkList empty="No jobs yet" rows={work.data.jobs.map((j) => ({ to: `/jobs/${j.id}`, number: j.number, title: j.title, right: j.kind === "recurring" ? "Recurring" : canSell ? formatMoney(j.financials?.contract_total ?? 0) : "", status: <EntityStatus kind="job" status={j.status} /> }))} />
                  )}
                  {work.data && tab === "invoices" && (
                    <WorkList empty="No invoices yet" rows={work.data.invoices.map((i) => ({ to: `/invoices/${i.id}`, number: i.number, title: i.due_on ? `Due ${formatDate(i.due_on)}` : "Invoice", right: formatMoney(i.balance_due > 0 ? i.balance_due : i.total), status: <EntityStatus kind="invoice" status={i.status} /> }))} />
                  )}
                </div>
              </>
            )}
          </section>

          {c.properties.length > 0 && <PlansCard scope={{ kind: "client", properties: c.properties.map((p) => ({ id: p.id, label: p.label || p.line1 })) }} />}

          <Timeline clientId={c.id} />
        </div>

        <aside className="narrow stack">
          {/* How to reach them and where the account stands, in one card. Cards of their own are for sections you act on. */}
          <div className="card card-pad stack-sm">
            <div className="row-between">
              <strong>Details</strong>
              {canSell && <Button size="sm" variant="ghost" icon="edit" onClick={() => setDialog("edit")}>Edit</Button>}
            </div>
            <dl className="kv">
              <dt>Email</dt><dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : "—"}</dd>
              <dt>Phone</dt><dd>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : "—"}</dd>
              {c.sms_opt_out_at && <><dt>Texts</dt><dd>Off since {formatDate(c.sms_opt_out_at)}. They texted STOP, and can text START to turn texts back on.</dd></>}
              {owed > 0 && (
                <>
                  <dt>Balance</dt>
                  <dd>
                    <button type="button" className="link-btn tabular" style={pastDue > 0 ? { color: "var(--danger)" } : undefined} onClick={showInvoices}>{formatMoney(owed)}</button>
                    {pastDue > 0 && <span className="muted">{pastDue < owed ? ` · ${formatMoney(pastDue)} ${statusText("invoice", "overdue").toLowerCase()}` : ` · ${statusText("invoice", "overdue")}`}</span>}
                  </dd>
                </>
              )}
              {writtenOff > 0 && <><dt>Written off</dt><dd className="tabular">{formatMoney(writtenOff)}</dd></>}
              <dt>Lead source</dt><dd>{c.lead_source ?? "—"}</dd>
              {referrer && <><dt>Referred by</dt><dd><Link to={`/clients/${referrer.id}`}>{referrer.display_name}</Link></dd></>}
              {credits.data?.some((r) => Number(r.credit_left) > 0) && (
                <>
                  <dt>Referral credit</dt>
                  <dd className="stack-sm" style={{ gap: 2 }}>
                    {credits.data.filter((r) => Number(r.credit_left) > 0).map((r) => (
                      <span key={r.referral_id}>
                        {creditMoney(Number(r.credit_left))} for referring {r.friend_name}. {r.auto_apply ? "Goes on their next invoice." : "Kept off invoices."}
                      </span>
                    ))}
                  </dd>
                </>
              )}
              <dt>Client since</dt><dd>{formatDate(c.created_at)}</dd>
              {billing?.line1 && <><dt>Billing</dt><dd>{addressLine(billing)}</dd></>}
              {isOffice && (
                <>
                  <dt>Marketing</dt>
                  <dd>
                    <label className="switch-row" style={{ fontWeight: 400 }}>
                      <input type="checkbox" className="switch" checked={!c.marketing_opt_out} onChange={(e) => update.mutate({ marketing_opt_out: !e.target.checked })} />
                      Gets campaigns, review and referral asks
                    </label>
                  </dd>
                  <dt>Reviews</dt>
                  <dd>
                    <label className="switch-row" style={{ fontWeight: 400 }}>
                      <input type="checkbox" className="switch" checked={!c.review_opt_out && !c.marketing_opt_out && !c.reviewed_at} disabled={c.marketing_opt_out || Boolean(c.reviewed_at)} onChange={(e) => update.mutate({ review_opt_out: !e.target.checked })} />
                      Gets review asks
                    </label>
                    {c.marketing_opt_out ? (
                      <span className="muted small" style={{ display: "block" }}>Off while they're unsubscribed from marketing</span>
                    ) : c.reviewed_at ? (
                      <span className="muted small" style={{ display: "block" }}>Left a Google review, so not asked</span>
                    ) : null}
                  </dd>
                </>
              )}
            </dl>
            {c.notes && <p className="muted small pre-wrap" style={{ margin: 0 }}>{c.notes}</p>}
            {canSell && contacts.data?.length === 0 && <AddContact clientId={c.id} />}
          </div>
          <ContactsCard clientId={c.id} canEdit={canSell} />
        </aside>
      </div>

      {dialog === "edit" && <EditClientDialog open onClose={() => setDialog(null)} client={c} />}
      {property && <PropertyDialog clientId={c.id} property={property.row} access={property.access} onClose={() => setProperty(null)} />}
      {dialog === "request" && <NewRequestDialog open onClose={() => setDialog(null)} initialClient={{ id: c.id, display_name: c.display_name }} onCreated={(rid) => navigate(`/requests/${rid}`)} />}
      {dialog === "quote" && <NewQuoteDialog open onClose={() => setDialog(null)} initialClient={{ id: c.id, display_name: c.display_name }} onCreated={(qid) => navigate(`/quotes/${qid}`)} />}
    </>
  );
}

function WorkList({ rows, empty }: { rows: Array<{ to: string; number: number | null; title: string; right: string; status: React.ReactNode }>; empty: string }) {
  if (!rows.length) return <EmptyState inline title={empty} />;
  return (
    <>
      {rows.map((r) => (
        <Link key={r.to} to={r.to} className="card-row">
          <span className="muted tabular" style={{ width: 48 }}>{r.number != null ? `#${r.number}` : "—"}</span>
          <span className="grow strong ellipsis">{r.title}</span>
          <span className="tabular hide-mobile">{r.right}</span>
          <span style={{ width: 150, display: "flex", justifyContent: "flex-end" }}>{r.status}</span>
        </Link>
      ))}
    </>
  );
}

/**
 * A client matched to a Google review: they aren't asked for reviews again. Its stars, and a link to
 * their review in Marketing → Reviews (where a wrong match is undone), for those who can open it.
 */
function ReviewedChip({ clientId }: { clientId: string }) {
  const session = useSession();
  const sees = hasRole(session, "admin", "office") && can(session, "marketing") && marketingOn(session.company.settings);
  const review = useQuery({
    queryKey: ["client-review", clientId],
    enabled: sees,
    queryFn: async () => unwrap(await supabase().from("reviews").select("rating").eq("client_id", clientId).is("deleted_at", null).order("posted_at").limit(1)),
  });
  const rating = review.data?.[0]?.rating;
  const words = rating ? `Left a ${rating}-star Google review` : "Left a Google review";
  return sees ? <Link className="chip chip-green" to={`/marketing?tab=reviews&client=${clientId}`}>{words}</Link> : <span className="chip chip-green">{words}</span>;
}
