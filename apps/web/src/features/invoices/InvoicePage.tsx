import { autopayDueText, autopaySettings, methodLabel } from "@crewtavo/core/autopay";
import type { TablesUpdate } from "@crewtavo/core/database";
import { paymentProblem, taxPercent, taxRateFromPercent } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AnimatedNumber, MONEY_CENTS } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { BackLink, PageHeader, useDocumentTitle } from "@/components/ui/PageHeader";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, NoAccess, PageError } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { ApiError, errorMessage, isAuthError, isNetworkError, isRestarting } from "@/lib/errors";
import { addDaysIso, formatDate, formatMoney, formatMoneyCents, formatTaxRate, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { contractTemplate, documentCompany, invoiceDocument, invoiceFill, NO_CONTRACT, useDocumentTemplate, useInvoiceContract, useLetterhead, type DocumentInvoice, type InvoiceQuote } from "../documents/data";
import { DocumentSheet } from "../documents/EstimateDocument";
import { InvoiceDrawings } from "../measure/drawings";
import { LineItems } from "../quotes/LineItems";
import { DiscountRows } from "../quotes/PromoRow";
import { SendDialog } from "../quotes/SendDialog";
import { refundable, stripeCharge, stripeRefundable, stripeRefundToasts, type StripeRefundResult } from "./refunds";
import { settle } from "./settle";
import { autopayBankNote, bankPayment, bankPaymentNote, paidInStripe, paymentAmount, RECORD_IN_STRIPE } from "./stripeInvoices";
import { chargeOutcomeText, type ChargeResult } from "./charges";

const METHODS: Record<string, string> = { check: "Check", cash: "Cash", card: "Card", ach: "Bank transfer", other: "Other" };
/** A charge still going, or waiting on someone: the database lets an invoice have one at a time. */
const LIVE_CHARGES = new Set(["waiting", "needs_approval", "charging", "processing", "failed", "needs_client"]);
/** The totals roll to their new figures, cents and all, as lines, payments and the tax rate change. */

export function InvoicePage() {
  const session = useSession();
  return hasRole(session, "admin", "office") && can(session, "invoices") ? <InvoicePageScreen /> : <NoAccess title="Invoice" />;
}

function InvoicePageScreen() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<null | "send" | "payment">(null);
  const [refunding, setRefunding] = useState<null | { id: string; amount: number; method: string }>(null);
  const [stripeRefund, setStripeRefund] = useState<null | { id: string; amount: number; tip_amount: number; method: string; processor_ref: string | null }>(null);
  const today = todayIn(session.company.timezone);

  const invoice = useQuery({
    queryKey: ["invoice", id],
    queryFn: async () => {
      // Its autopay charges come in alongside, by the same key (autopay_charges_invoice_fkey): one
      // select with them embedded too is more than the typed client can read.
      const [row, autopay] = await Promise.all([
        supabase()
          .from("invoices")
          .select("*, promo:promo_codes(code, kind, value, description), client:clients(id, display_name, email, phone, billing_address), job:jobs(id, number, title, po_number, property:properties(line1, city, region, postal_code), quote:quotes!jobs_company_id_quote_id_fkey(approval, option_id, option:quote_options!quotes_option_fkey(name, warranty), package:roof_packages!quotes_roof_package_fkey(name, warranty))), lines:invoice_line_items(id, name, description, quantity, unit, unit_price, taxable, sort, service_id), payments(id, amount, tip_amount, method, received_at, processor, processor_ref, notes, fee_amount, payout:payouts(arrival_on, status)), stripe:stripe_invoices(stripe_id, origin, status, number, hosted_url, livemode, amount_due, created_at, detached_at, processing_at, collection, purpose)")
          .eq("id", id)
          .order("sort", { referencedTable: "invoice_line_items" })
          .order("received_at", { referencedTable: "payments" })
          .order("created_at", { referencedTable: "stripe_invoices", ascending: false })
          .maybeSingle(),
        supabase()
          .from("autopay_charges")
          .select("id, source, status, due_at, attempts, failures, last_error, decline_code, charged_at, approved_at, method:client_payment_methods!autopay_charges_method_fkey(type, brand, last4, bank_name, wallet)")
          .eq("invoice_id", id)
          .order("created_at", { ascending: false }),
      ]);
      return { ...unwrapOne(row, "This invoice"), autopay: unwrap(autopay) };
    },
    // While it's being charged (or was just approved), look again every few seconds until Stripe answers.
    refetchInterval: (query) => (query.state.data?.autopay.some((a) => a.status === "charging" || (a.status === "waiting" && a.approved_at)) ? 10_000 : false),
  });
  const inv = invoice.data;
  // Whether the company's Stripe key can make refunds (Settings → Payments reads the same), asked
  // only for an invoice with a payment Stripe took. Unknown (loading, or an older server) leaves
  // Refund on: the server says why if it can't.
  const autopayStatus = useQuery({
    queryKey: ["company", session.company.id, "payments"],
    enabled: Boolean(inv?.payments.some(stripeCharge)),
    meta: { silent: true },
    queryFn: () => api.get<{ can_refund: boolean }>("/autopay/status"),
  });
  const canRefund = autopayStatus.data?.can_refund !== false;
  // Charge card's card, when the server says it can be pressed: charging saved cards is on, it's
  // owed, and the client agreed to a card. Asked only while nothing is charging it already.
  const chargeable = useQuery({
    queryKey: ["invoice", id, "charge"],
    enabled: Boolean(inv && Number(inv.balance_due) > 0 && !inv.autopay.some((a) => LIVE_CHARGES.has(a.status))) && autopaySettings(session.company.settings, session.company.trade_preset).enabled,
    meta: { silent: true },
    queryFn: () => api.get<{ manual: { card: string } | null }>(`/invoices/${id}/charge`),
  });
  useDocumentTitle(inv ? `Invoice #${inv.number}` : "Invoice");
  useRememberRecent(session.company.id, inv ? { kind: "invoice", id: inv.id, title: `Invoice #${inv.number}`, subtitle: inv.client?.display_name, path: `/invoices/${inv.id}` } : null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["invoice", id] });
    queryClient.invalidateQueries({ queryKey: ["invoices", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  // Status changes, from the header and its menu.
  const update = useMutation({
    meta: { success: (_: unknown, p: TablesUpdate<"invoices">) => (p.status === "void" ? "Invoice voided" : p.status === "sent" ? "Invoice marked as sent" : p.status === "draft" ? "Invoice moved back to draft" : null), tone: "invoice" },
    mutationFn: async (patch: TablesUpdate<"invoices">) => unwrap(await supabase().from("invoices").update(patch).eq("id", id)),
    onSuccess: refresh,
  });
  // The fields on the page, saved as they're left: "Saving…" and "Saved" beside the status.
  const save = useSaveStatus();
  const edit = useMutation({
    meta: { inline: true },
    mutationFn: async (patch: TablesUpdate<"invoices">) => unwrap(await supabase().from("invoices").update(patch).eq("id", id)),
    onSuccess: refresh,
    // Offline or restarting, "Couldn't save" in the header is enough; a refusal also says why in a toast, since trying again won't help.
    onError: (error) => {
      if (!isNetworkError(error) && !isAuthError(error) && !(error instanceof ApiError && isRestarting(error.status))) toast.error(errorMessage(error));
    },
  });
  const saveField = (patch: TablesUpdate<"invoices">) => void save.track(edit.mutateAsync(patch));
  // A field left without a change takes back its "Edited".
  const unchanged = () => save.status === "edited" && save.reset();
  // Written off: what's left isn't counted as owed any more (or is again, undone).
  const writeOff = useMutation({
    meta: { success: (_: unknown, on: boolean) => (on ? "Invoice written off" : "Write-off undone"), tone: "invoice" },
    mutationFn: async (on: boolean) => unwrap(await supabase().from("invoices").update({ status: on ? "written_off" : "sent" }).eq("id", id)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { success: "Draft invoice deleted", tone: "invoice" },
    mutationFn: async () => unwrap(await supabase().from("invoices").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices", session.company.id] });
      navigate("/invoices", { replace: true });
    },
  });
  // Undone from its toast (see takeOff below), which also says when it fails.
  const removePayment = useMutation({
    meta: { inline: true },
    mutationFn: async (paymentId: string) => unwrap(await supabase().from("payments").delete().eq("id", paymentId)),
    onSuccess: refresh,
  });
  const paymentRows = useListAnimation<HTMLDivElement>();
  const openClientView = useMutation({
    mutationFn: (print: boolean) => api.get<{ link: string }>(`/invoices/${id}/link`).then((r) => ({ ...r, print })),
    onSuccess: ({ link, print }) => window.open(print ? `${link}?print=1` : link, "_blank", "noopener"),
  });
  // What Stripe does next (a charge, a refund) is booked a few seconds later, so look again then too.
  const refreshSoon = () => {
    refresh();
    window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["invoice", id] }), 5000);
  };
  // Approve charge: a charge over the autopay limit goes ahead, and the server starts on it at once.
  const approveCharge = useMutation({
    meta: { success: "Charging it now", tone: "invoice" },
    mutationFn: (chargeId: string) => api.post(`/autopay/charges/${chargeId}/approve`, {}),
    onSuccess: refreshSoon,
  });
  // Charge card: queued for the autopay task, which the server starts on at once. Charge card goes
  // as soon as it's queued, so a second press can't queue another. It sends the balance the office
  // confirmed: if a line changed it since, the server says so (changed) and the page shows the new one.
  const chargeCard = useMutation({
    meta: { success: (r: { results: ChargeResult[] }) => (r.results[0]?.outcome === "queued" ? "Charging it now" : null), tone: "invoice" },
    mutationFn: (amount: number) => api.post<{ results: ChargeResult[] }>("/invoices/charge", { invoices: [{ id, amount }] }),
    onSuccess: ({ results }) => {
      const r = results[0];
      if (r && r.outcome !== "queued") toast.error("Not charged", { description: chargeOutcomeText(r) });
      queryClient.setQueryData(["invoice", id, "charge"], { manual: null });
      refreshSoon();
    },
  });
  // Send it the usual way: the charge is called off, and the draft goes out with the Send dialog.
  const callOffCharge = useMutation({
    mutationFn: (chargeId: string) => api.post(`/autopay/charges/${chargeId}/call-off`, {}),
    onSuccess: () => {
      refresh();
      setDialog("send");
    },
  });

  if (invoice.isPending) return <DetailSkeleton />;
  if (invoice.error || !inv) return <PageError error={invoice.error} onRetry={() => invoice.refetch()} back={<BackLink to="/invoices">Invoices</BackLink>} />;

  const draft = inv.status === "draft";
  const isVoid = inv.status === "void";
  const writtenOff = inv.status === "written_off";
  const balance = Number(inv.balance_due);
  const paid = Number(inv.amount_paid);
  const daysLate = inv.due_on && balance > 0 && !draft && !isVoid && !writtenOff ? Math.floor((Date.parse(today) - Date.parse(inv.due_on)) / 86_400_000) : 0;
  const lastPayment = inv.payments.at(-1);
  // The Stripe invoice that matters now: the live one, else the latest. A tip added after an
  // automatic charge is its own small Stripe invoice, and isn't the one for this invoice's bill.
  const billed = inv.stripe.filter((s) => s.purpose !== "tip");
  const stripe = billed.find((s) => s.status === "open" || s.status === "processing") ?? billed.find((s) => s.stripe_id);
  const bank = bankPayment(inv.stripe);
  // Charged automatically (autopay): its charge, if one is still going or done. Only one at a time
  // isn't called off, and one called off leaves the invoice to be sent and paid as usual.
  const charge = inv.autopay.find((a) => a.status !== "called_off") ?? null;
  // The task holds it: Stripe is charging it, and the database refuses changes to it meanwhile.
  const charging = charge?.status === "charging";
  const card = charge?.method ? methodLabel(charge.method) : "the saved card";
  // Its bank payment is on its way: it settles or bounces on its own, so payments, voiding and moving
  // it back to draft wait until then (the database holds them back too), and this says why. Not in a
  // Stripe account Crewtavo has since left: Crewtavo won't hear how that one ends, so the office
  // follows it there, as any bank payment there (bankNote says so), and nothing waits for it.
  const left = inv.stripe.some((s) => s.collection === "charge_automatically" && s.purpose === "invoice" && s.status === "processing" && Boolean(s.detached_at));
  const clearing = charge?.status === "processing" && !left;
  const clearingNote = clearing ? autopayBankNote(card, bank, session.company.timezone) : null;
  // Any other bank payment on its way: said next to Record payment, and asked about before recording one.
  const bankNote = bank && balance > 0 && !clearing ? bankPaymentNote(bank, session.company.timezone) : null;
  const clientName = inv.client?.display_name ?? "The client";
  // Over the limit, or with visits autopay didn't queue itself: the draft waits for the office.
  const asking = charge?.status === "needs_approval" && draft;
  // Declined, or the client has to do something: they were sent the Pay link, and a reminder is the next step.
  // Not while their bank payment is on its way (bankNote says so): nothing is tried again meanwhile.
  // One in a Stripe account Crewtavo left doesn't hold the retry back, so that one still says it.
  // Moved back to be tried on a card the client agreed to since (autopay_try_new_card: no failures
  // on it): said as one waiting, so nothing says that card was declined.
  const onNewCard = charge?.status === "failed" && charge.failures === 0;
  const chargeFailed = ((charge?.status === "failed" && !onNewCard) || charge?.status === "needs_client") && balance > 0 && (!bank || bank.left);
  // A draft being charged stays as it is until it's done (the database refuses edits meanwhile).
  const editable = draft && !charging;
  // Made in Stripe: paid as Stripe billed it, so its total changes there, not here.
  const fromStripe = inv.stripe.some((s) => s.origin === "stripe");
  // And while it's open there, so do its payments.
  const paysInStripe = paidInStripe(inv.stripe);
  // Charge card: not while a charge is going, or a bank payment (in a Stripe account left too, while
  // it may still clear there) or Stripe is collecting it already. The server says the same.
  const manual = balance > 0 && !inv.autopay.some((a) => LIVE_CHARGES.has(a.status)) && !paysInStripe && !bank ? (chargeable.data?.manual ?? null) : null;
  const chargeNow = async (card: string) => {
    const amount = formatMoneyCents(balance);
    const ok = await confirm({
      title: `Charge ${amount} to ${card}?`,
      body: `Invoice #${inv.number}${inv.client ? ` for ${inv.client.display_name}` : ""}. It's charged in the next minute or so, and this page shows when it goes through.${draft ? " The draft is marked as sent, without an email." : ""}`,
      confirmLabel: `Charge ${amount}`,
    });
    if (ok) chargeCard.mutate(balance);
  };

  // A payment marked by mistake goes at once, with Undo, and the balance goes back up with it.
  type Loaded = typeof inv;
  const takeOff = (payment: Loaded["payments"][number]) => {
    const key = ["invoice", id];
    undoable({
      title: "Payment removed",
      tone: "invoice",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Loaded>(key, (current) => current && settle(current, current.payments.filter((p) => p.id !== payment.id), today));
      },
      restore: () =>
        queryClient.setQueryData<Loaded>(key, (current) =>
          current && !current.payments.some((p) => p.id === payment.id) ? settle(current, [...current.payments, payment].sort((a, b) => a.received_at.localeCompare(b.received_at)), today) : current,
        ),
      commit: () => removePayment.mutateAsync(payment.id),
    });
  };

  return (
    <>
      <BackLink to="/invoices">Invoices</BackLink>
      <PageHeader
        title={`Invoice #${inv.number}`}
        actions={
          <>
            {!isVoid && !writtenOff && (
              <Button icon="send" variant={draft && !asking ? "primary" : "secondary"} disabled={!inv.lines.length || charging} title={!inv.lines.length ? "Add a line item first" : charging ? `Charging ${card} now` : undefined} onClick={() => setDialog("send")}>
                {draft ? "Send invoice" : "Resend"}
              </Button>
            )}
            {manual && <Button icon="card" loading={chargeCard.isPending} onClick={() => void chargeNow(manual.card)}>Charge card</Button>}
            {!draft && !isVoid && balance > 0 && <Button variant="primary" icon="dollar" disabled={paysInStripe || charging || clearing} title={paysInStripe ? "Made in Stripe: record its payments there" : charging ? `Charging ${card} now` : (clearingNote ?? bankNote ?? undefined)} onClick={() => setDialog("payment")}>Record payment</Button>}
            {/* While it's being charged, or its bank payment is on its way, the menu leaves out what the database refuses until it's done. */}
            <Menu
              items={[
                { label: "Preview as client", icon: "eye", onSelect: () => openClientView.mutate(false) },
                { label: "Print or save PDF", icon: "printer", onSelect: () => openClientView.mutate(true) },
                { separator: true },
                { label: "Mark as sent", icon: "check", hidden: !draft || !inv.lines.length || charging, onSelect: () => update.mutate({ status: "sent" }) },
                { label: "Record payment", icon: "dollar", hidden: !draft || !inv.lines.length || charging || clearing, onSelect: () => setDialog("payment") },
                { label: "Move back to draft", icon: "undo", hidden: draft || isVoid || writtenOff || inv.payments.length > 0 || fromStripe || charging || clearing, onSelect: () => update.mutate({ status: "draft", sent_at: null }) },
                {
                  label: "Write off",
                  icon: "archive",
                  hidden: draft || isVoid || writtenOff || inv.status === "paid" || balance <= 0 || charging,
                  // A bank payment on its way may still pay it.
                  disabled: Boolean(bank) || clearing,
                  onSelect: async () => {
                    const ok = await confirm({
                      title: `Write off invoice #${inv.number}?`,
                      body: `${formatMoneyCents(balance)} stops counting as owed: it comes off your unpaid invoices and receivables, and no more reminders go out. The invoice still counts toward what you've invoiced. If ${inv.client?.display_name ?? "the client"} pays later, record the payment here. You can undo this.`,
                      confirmLabel: "Write off",
                    });
                    if (ok) writeOff.mutate(true);
                  },
                },
                { label: "Undo write-off", icon: "undo", hidden: !writtenOff, onSelect: () => writeOff.mutate(false) },
                {
                  label: "Void invoice",
                  icon: "x",
                  danger: true,
                  hidden: isVoid || paid !== 0 || charging || clearing,
                  onSelect: async () => {
                    if (await confirm({ title: `Void invoice #${inv.number}?`, body: "It stays on record but no longer counts as owed. Visits it covered can be invoiced again.", confirmLabel: "Void invoice", danger: true })) update.mutate({ status: "void" });
                  },
                },
                {
                  label: "Delete draft",
                  icon: "trash",
                  danger: true,
                  hidden: !draft || paid !== 0 || charging || clearing,
                  onSelect: async () => {
                    if (await confirm({ title: `Delete draft invoice #${inv.number}?`, body: "This can't be undone.", confirmLabel: "Delete", danger: true })) remove.mutate();
                  },
                },
              ]}
            />
          </>
        }
      />
      <div className="page-meta">
        <EntityStatus kind="invoice" status={inv.status} />
        <SaveStatus status={save.status} />
        {inv.client && <Link to={`/clients/${inv.client.id}`} className="strong">{inv.client.display_name}</Link>}
        {inv.job && <Link to={`/jobs/${inv.job.id}`} className="muted">Job #{inv.job.number}: {inv.job.title}</Link>}
        {inv.kind === "progress" && <span className="chip">Pay application {inv.pay_app_number}</span>}
        {inv.kind === "deposit" && <span className="chip">Deposit</span>}
        {inv.kind === "retainage" && <span className="chip">Retainage</span>}
        {inv.kind === "visits" && <span className="chip">Completed visits</span>}
      </div>

      {isVoid && <div className="callout"><Icon name="x" size={20} /><div className="grow">This invoice is void and isn't owed.</div></div>}
      {writtenOff && (
        <div className="callout">
          <Icon name="archive" size={20} />
          <div className="grow">
            Written off{inv.written_off_at ? ` on ${formatDate(inv.written_off_at)}` : ""}: {formatMoneyCents(balance)} isn't counted as owed. If the client pays after all, record it and the invoice is marked paid.
          </div>
          <Button size="sm" icon="undo" disabled={writeOff.isPending} onClick={() => writeOff.mutate(false)}>Undo write-off</Button>
        </div>
      )}
      {inv.status === "paid" && (
        <div className="callout callout-good">
          <Icon name="check" size={20} />
          <div className="grow">
            {charge?.status === "paid" ? `Paid automatically with ${card} on ${formatDate(charge.charged_at ?? lastPayment?.received_at)}.` : `Paid in full${lastPayment ? ` on ${formatDate(lastPayment.received_at)}` : ""}.`}
          </div>
        </div>
      )}
      {charging && <div className="callout callout-info"><Icon name="card" size={20} /><div className="grow">Charging {card} now.</div></div>}
      {/* Approved, or on its way back to the task after a moment's wait. */}
      {(charge?.status === "waiting" || onNewCard) && charge && (
        <div className="callout callout-info">
          <Icon name="card" size={20} />
          <div className="grow">{charge.approved_at ? `Charging ${card} in the next few minutes.` : `Charged automatically to ${card} ${autopayDueText(charge.due_at, session.company.timezone)}.`}</div>
        </div>
      )}
      {bankNote && <div className="callout callout-info"><Icon name="clock" size={20} /><div className="grow">{bankNote}</div></div>}
      {/* The bank payment the charge started: why Record payment waits. */}
      {clearingNote && !isVoid && balance > 0 && <div className="callout callout-info"><Icon name="clock" size={20} /><div className="grow">{clearingNote}</div></div>}
      {asking && charge && (
        <div className="callout callout-warning">
          <Icon name="card" size={20} />
          <div className="grow">{approvalText(charge, balance, autopaySettings(session.company.settings, session.company.trade_preset).max_amount)}</div>
          <div className="row wrap" style={{ gap: 6 }}>
            <Button size="sm" variant="primary" icon="check" loading={approveCharge.isPending} disabled={callOffCharge.isPending} onClick={() => approveCharge.mutate(charge.id)}>Approve charge</Button>
            <Button size="sm" icon="send" loading={callOffCharge.isPending} disabled={approveCharge.isPending || !inv.lines.length} onClick={() => callOffCharge.mutate(charge.id)}>Send it the usual way</Button>
          </div>
        </div>
      )}
      {chargeFailed && charge && (
        <div className="callout callout-danger">
          <Icon name="card" size={20} />
          <div className="grow">
            {charge.status === "failed"
              ? `Autopay failed${charge.last_error ? `: ${clause(charge.last_error)}` : ""}. ${clientName} was sent the Pay link and a way to update their card. We'll try again ${autopayDueText(charge.due_at, session.company.timezone)}.`
              : `Autopay needs ${clientName}: ${needsClientReason(charge)}.`}
          </div>
          <Button size="sm" icon="send" onClick={() => setDialog("send")}>Send a reminder</Button>
        </div>
      )}
      {/* Up front, rather than refused once someone has filled in a payment. */}
      {paysInStripe && !bank && !isVoid && balance > 0 && <div className="callout callout-info"><Icon name="info" size={20} /><div className="grow">{RECORD_IN_STRIPE}</div></div>}
      {daysLate > 0 && !bank && !clearing && (
        <div className="callout callout-danger">
          <Icon name="alert" size={20} />
          <div className="grow">{daysLate} {daysLate === 1 ? "day" : "days"} past due. {formatMoneyCents(balance)} is still owed.</div>
          {/* A failed charge's callout above has the reminder already. */}
          {!chargeFailed && <Button size="sm" icon="send" onClick={() => setDialog("send")}>Send a reminder</Button>}
        </div>
      )}
      {draft && !charge && <div className="callout callout-info"><Icon name="info" size={20} /><div className="grow">This invoice hasn't been sent yet.</div></div>}
      {!isVoid && balance < 0 && <div className="callout callout-info"><Icon name="info" size={20} /><div className="grow">The client paid {formatMoneyCents(-balance)} more than they owed. Record a refund, or keep it as a credit for their next invoice.</div></div>}

      <div className="two-col">
        <div className="wide stack-lg">
          {draft && <SubjectCard value={inv.subject} onEdit={save.edited} onUnchanged={unchanged} onSave={(subject) => saveField({ subject })} />}
          <LineItems table="invoice_line_items" parent="invoice_id" parentId={inv.id} lines={inv.lines} editable={editable} onChanged={refresh} />
          <NotesCard value={inv.notes} editable={!isVoid} onEdit={save.edited} onUnchanged={unchanged} onSave={(notes) => saveField({ notes })} />
          <section className="stack">
            <h2 className="section-title">Payments</h2>
            <div className="card" ref={paymentRows}>
              {inv.payments.length === 0 && <EmptyState inline title="No payments yet" />}
              {inv.payments.map((p) => {
                const shown = paymentAmount(p);
                return (
                  <div key={p.id} className="card-row">
                    <span className="n-icon" style={{ width: 32, height: 32, borderRadius: "var(--radius-control)", display: "grid", placeItems: "center", background: shown.back ? "var(--danger-tint)" : "var(--green-tint)", color: shown.back ? "var(--danger)" : "var(--green-dark)", flex: "none" }}><Icon name="dollar" size={16} /></span>
                    <span className="grow">
                      <strong className="tabular">{shown.amount}</strong>
                      {shown.tip && <span className="muted"> {shown.tip}</span>}
                      <span className="muted small" style={{ display: "block" }}>
                        {METHODS[p.method] ?? p.method}{p.processor ? ` via ${p.processor === "stripe" ? "Stripe" : p.processor}` : ""}{p.notes ? ` · ${p.notes}` : ""}
                        {Number(p.fee_amount) > 0 && ` · ${formatMoneyCents(p.fee_amount)} fee`}
                        {p.payout && ` · ${p.payout.status === "paid" ? "deposited" : "arrives"} ${formatDate(p.payout.arrival_on)}`}
                      </span>
                    </span>
                    <span className="muted small">{formatDate(p.received_at)}</span>
                    {/*
                      Payments recorded here are refunded and removed here. One Stripe took is refunded
                      through Stripe (Refund here, or in Stripe's dashboard), and either way the refund
                      is booked from Stripe, so it shows up here as a negative payment on its own.
                    */}
                    {!p.processor ? (
                      <Menu
                        triggerClassName="btn btn-sm btn-ghost btn-icon"
                        label="Payment actions"
                        items={[
                          // Hidden once it's all been refunded.
                          { label: "Record a refund", icon: "undo", hidden: refundable(p, inv.payments) <= 0, onSelect: () => setRefunding({ id: p.id, amount: Number(p.amount), method: p.method }) },
                          { label: "Remove payment", icon: "trash", danger: true, onSelect: () => takeOff(p) },
                        ]}
                      />
                    ) : (
                      stripeCharge(p) && (
                        <Menu
                          triggerClassName="btn btn-sm btn-ghost btn-icon"
                          label="Payment actions"
                          items={[
                            // The menu can't explain a turned-off item itself, so it says why above it.
                            { heading: "Needs a new Stripe key", hidden: canRefund },
                            // Hidden once it's all been refunded.
                            { label: "Refund", icon: "undo", hidden: stripeRefundable(p, inv.payments) <= 0, disabled: !canRefund, title: canRefund ? undefined : "Your Stripe key can't make refunds. Update it on the Apps page.", onSelect: () => setStripeRefund(p) },
                          ]}
                        />
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </section>
          <InvoicePaper invoice={inv} />
        </div>
        <aside className="narrow stack">
          <div className="card card-pad totals">
            <div className="line"><span>Subtotal</span><AnimatedNumber value={Number(inv.subtotal)} format={MONEY_CENTS} /></div>
            <DiscountRows
              kind="invoice"
              id={inv.id}
              promo={inv.promo}
              discount={Number(inv.discount_amount)}
              subtotal={Number(inv.subtotal)}
              canEditDiscount={editable}
              canChangePromo={!isVoid && !fromStripe && !charging && inv.payments.length === 0 && ["draft", "sent", "overdue"].includes(inv.status)}
              onSaveDiscount={(v) => saveField({ discount_amount: v })}
              onEditDiscount={save.edited}
              onUnchangedDiscount={unchanged}
              onChanged={refresh}
            />
            <div className="line">
              <span>Tax {editable ? "" : `(${formatTaxRate(inv.tax_rate)})`}</span>
              {editable ? <MoneyInput percent label="Tax rate" value={taxPercent(inv.tax_rate)} max={99.99} onSave={(v) => saveField({ tax_rate: taxRateFromPercent(v) })} onEdit={save.edited} onUnchanged={unchanged} /> : <AnimatedNumber value={Number(inv.tax_amount)} format={MONEY_CENTS} />}
            </div>
            {editable && <div className="line"><span>Tax amount</span><AnimatedNumber value={Number(inv.tax_amount)} format={MONEY_CENTS} /></div>}
            <div className="line grand"><span>Total</span><AnimatedNumber value={Number(inv.total)} format={MONEY_CENTS} /></div>
            {Number(inv.retainage_amount) > 0 && <div className="line"><span>Retainage held ({Number(inv.retainage_pct)}%)</span><span>−<AnimatedNumber value={Number(inv.retainage_amount)} format={MONEY_CENTS} /></span></div>}
            {paid !== 0 && <div className="line"><span>Paid</span><span>−<AnimatedNumber value={paid} format={MONEY_CENTS} /></span></div>}
            <div className="line grand" style={{ fontSize: 20, color: balance > 0 && daysLate > 0 ? "var(--danger)" : writtenOff ? "var(--text-2)" : undefined }}><span>{writtenOff ? statusText("invoice", "written_off") : "Balance due"}</span><AnimatedNumber value={balance} format={MONEY_CENTS} /></div>
          </div>
          <div className="card card-pad stack-sm">
            <strong>Dates</strong>
            <div className="totals">
              <div className="line">
                <span>Issued</span>
                {draft ? <input className="input input-sm" type="date" style={{ width: 150 }} value={inv.issued_on} onChange={(e) => e.target.value && saveField({ issued_on: e.target.value })} aria-label="Issued on" /> : <span>{formatDate(inv.issued_on)}</span>}
              </div>
              <div className="line">
                <span>Due</span>
                {draft ? <input className="input input-sm" type="date" style={{ width: 150 }} value={inv.due_on ?? ""} min={inv.issued_on} onChange={(e) => saveField({ due_on: e.target.value || null })} aria-label="Due on" /> : <span>{inv.due_on ? formatDate(inv.due_on) : "On receipt"}</span>}
              </div>
            </div>
            {draft && (
              <div className="row wrap" style={{ gap: 6 }}>
                {[["On receipt", 0], ["Net 15", 15], ["Net 30", 30], ["Net 45", 45]].map(([l, d]) => (
                  <button key={l} type="button" className="tab" aria-pressed={inv.due_on === addDaysIso(inv.issued_on, Number(d))} onClick={() => saveField({ due_on: addDaysIso(inv.issued_on, Number(d)) })}>{l}</button>
                ))}
              </div>
            )}
            {inv.sent_at && <span className="muted small">Sent {formatDate(inv.sent_at)}</span>}
            {inv.job?.po_number && <span className="muted small">PO {inv.job.po_number}</span>}
          </div>
          {stripe?.stripe_id && <StripeCard stripe={stripe} />}
          <InvoiceDrawings invoiceId={inv.id} clientId={inv.client_id} jobId={inv.job?.id ?? null} editable={!isVoid} />
        </aside>
      </div>

      {dialog === "send" && <SendDialog kind="invoice" id={inv.id} number={inv.number} email={inv.client?.email ?? null} phone={inv.client?.phone ?? null} onClose={() => setDialog(null)} onSent={refresh} />}
      {dialog === "payment" && <PaymentDialog invoice={{ id: inv.id, client_id: inv.client_id, balance, draft }} bank={bankNote} onClose={() => setDialog(null)} onSaved={refresh} />}
      {refunding && <RefundDialog invoice={{ id: inv.id, client_id: inv.client_id }} payment={refunding} left={refundable(refunding, inv.payments)} onClose={() => setRefunding(null)} onSaved={refresh} />}
      {stripeRefund && <StripeRefundDialog payment={stripeRefund} left={stripeRefundable(stripeRefund, inv.payments)} onClose={() => setStripeRefund(null)} onSaved={refreshSoon} />}
    </>
  );
}

/** A message from Stripe or the database as part of a sentence: without its full stop. */
const clause = (text: string) => text.trim().replace(/[.\s]+$/, "");

/** Whole dollars when it's a round figure ("$500"), else with cents. */
const limitText = (amount: number) => (Number.isInteger(amount) ? formatMoney(amount) : formatMoneyCents(amount));

/**
 * Why a charge waits for the office's OK. The database asks first, whatever the amount, when the
 * invoice has visits autopay didn't queue itself or from before the client agreed, and says why
 * ("Includes visits from before autopay started"); and when it's over the company's limit, with no
 * reason given.
 */
function approvalText(charge: { last_error: string | null }, balance: number, cap: number | null): string {
  if (charge.last_error) return `${clause(charge.last_error).replace(/^Includes /, "It includes ")}, so it waits for your OK.`;
  if (cap != null && balance > cap) return `${formatMoneyCents(balance)} is over your ${limitText(cap)} limit, so it waits for your OK.`;
  return "It waits for your OK before it's charged.";
}

/** Stripe's answers that mean the client's bank wants them to confirm the payment themselves. */
const CONFIRM_CODES = new Set(["authentication_required", "invoice_payment_intent_requires_action"]);

/**
 * Why a charge waits on the client, in the words the office is told (the database's notice for it):
 * a bank payment that bounced or a card declined twice pauses autopay until they update it (a
 * declined Charge card just sends them the Pay link); their
 * bank asking them to confirm the payment; else what Stripe said.
 */
function needsClientReason(charge: { source: string; failures: number; last_error: string | null; decline_code: string | null; method: { type: string } | null }): string {
  if (charge.failures > 0 && (charge.method?.type === "us_bank_account" || charge.decline_code === "bank_failed")) return "their bank payment didn't go through, so autopay is paused until they update it";
  // Charge card isn't tried again, and one decline the office asked for doesn't pause autopay.
  if (charge.failures > 0 && charge.source === "manual") return "the card was declined, so they were sent the Pay link and a way to update their card";
  if (charge.failures >= 2) return "the card was declined twice, so autopay is paused until they update it";
  if (CONFIRM_CODES.has(charge.decline_code ?? "") || !charge.last_error) return "their bank wants them to confirm the payment";
  return clause(charge.last_error);
}

/**
 * The invoice as it prints, and as the client's link shows it: letter pages on the business's
 * template (its default, as the link uses), with the template's terms and its invoice sections filled
 * in for this invoice. It follows the edits above as they're saved.
 */
function InvoicePaper({ invoice }: { invoice: DocumentInvoice & { client: { display_name: string; billing_address: unknown } | null; job: { property: unknown; quote?: InvoiceQuote | null } | null } }) {
  const session = useSession();
  const id = useId();
  const { template, isPending } = useDocumentTemplate(null);
  const letterhead = useLetterhead();
  const terms = useInvoiceContract(
    isPending
      ? null
      : // {Option} and {Warranty} say what the client chose on the quote the job came from, as the client's link says them.
        { invoice: { number: invoice.number, issued_on: invoice.issued_on, total: invoice.total }, template, client: invoice.client, property: invoice.job?.property ?? null, fill: invoiceFill(invoice.job?.quote) },
  );
  const ready = !isPending && !terms.isPending;
  // Without the contract, the terms are left off too: the template's own would print with their fill-ins unfilled.
  const contract = terms.contract ?? (terms.error ? NO_CONTRACT : null);
  return (
    <section className="stack" aria-labelledby={id}>
      <h2 id={id} className="section-title">As it prints</h2>
      {ready ? (
        <>
          {terms.error && (
            <p className="muted small" style={{ margin: 0 }}>
              The terms didn't load, so they're not on the pages below. The client's copy has them.{" "}
              <button type="button" className="btn btn-sm btn-ghost" onClick={terms.refetch}>Try again</button>
            </p>
          )}
          <DocumentSheet
            template={contractTemplate(template, contract)}
            company={letterhead.data ?? documentCompany(session.company)}
            data={invoiceDocument(invoice, { timeZone: session.company.timezone, contract })}
          />
        </>
      ) : (
        <Skeleton height="auto" radius={4} style={{ aspectRatio: "8.5 / 11" }} />
      )}
    </section>
  );
}

// Stripe's invoice states in Crewtavo's words where there's one for it.
const STRIPE_STATUS: Record<string, string> = {
  open: statusText("invoice", "sent"),
  processing: "Bank payment on its way",
  paid: statusText("invoice", "paid"),
  void: statusText("invoice", "void"),
  uncollectible: "Written off in Stripe",
};

/** Where this invoice is in Stripe, with a way to open it there or share its payment page. Autopay's are charged to the saved card or bank account. */
function StripeCard({ stripe }: { stripe: { stripe_id: string | null; origin: string; status: string; number: string | null; hosted_url: string | null; livemode: boolean; collection: string } }) {
  const dashboard = `https://dashboard.stripe.com/${stripe.livemode ? "" : "test/"}invoices/${stripe.stripe_id}`;
  return (
    <div className="card card-pad stack-sm">
      <strong>Stripe</strong>
      <div className="totals">
        <div className="line"><span>{stripe.origin === "stripe" ? "Made in Stripe" : "Invoice"}</span><span>{stripe.number ?? "—"}</span></div>
        <div className="line"><span>Status</span><span>{STRIPE_STATUS[stripe.status] ?? stripe.status}</span></div>
        {stripe.collection === "charge_automatically" && <div className="line"><span>Charged</span><span>Automatically</span></div>}
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <a className="btn btn-sm" href={dashboard} target="_blank" rel="noreferrer">Open in Stripe <Icon name="external" size={14} /></a>
        {stripe.hosted_url && stripe.status === "open" && <Button size="sm" icon="copy" onClick={() => copyText(stripe.hosted_url!, "Payment link copied")}>Copy payment link</Button>}
      </div>
      {!stripe.livemode && <span className="muted small">Test mode: no real money moves.</span>}
    </div>
  );
}

/** `onEdit` on every keystroke (the header says "Edited"), `onSave` when the field is left changed, `onUnchanged` when it's left as it was. */
function SubjectCard({ value, onEdit, onUnchanged, onSave }: { value: string | null; onEdit: () => void; onUnchanged: () => void; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <label className="card card-pad field">
      <span>Subject <span className="optional">(shown at the top of the invoice)</span></span>
      <input className="input" value={draft} maxLength={200} onChange={(e) => { setDraft(e.target.value); onEdit(); }} onBlur={() => (draft.trim() !== (value ?? "") ? onSave(draft.trim() || null) : onUnchanged())} placeholder="Spring cleanup, May services…" />
    </label>
  );
}

function NotesCard({ value, editable, onEdit, onUnchanged, onSave }: { value: string | null; editable: boolean; onEdit: () => void; onUnchanged: () => void; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  if (!editable) return value ? <div className="card card-pad"><strong>Note to client</strong><p className="pre-wrap" style={{ margin: "6px 0 0" }}>{value}</p></div> : null;
  return (
    <label className="card card-pad field">
      <span>Note to client <span className="optional">(thank-you, payment instructions)</span></span>
      <textarea className="textarea" value={draft} maxLength={4000} onChange={(e) => { setDraft(e.target.value); onEdit(); }} onBlur={() => (draft.trim() !== (value ?? "") ? onSave(draft.trim() || null) : onUnchanged())} placeholder="Thank you for your business. Checks payable to…" />
    </label>
  );
}

/**
 * `bank` says a bank payment from the Pay link is on its way, so recording another is confirmed first
 * (it isn't refused: it can bounce). Autopay's own is refused by the database until it clears or
 * bounces, so Record payment waits for that instead.
 */
function PaymentDialog({ invoice, bank, onClose, onSaved }: { invoice: { id: string; client_id: string; balance: number; draft: boolean }; bank: string | null; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const [amount, setAmount] = useState(invoice.balance > 0 ? invoice.balance.toFixed(2) : "");
  const [tip, setTip] = useState("");
  const [method, setMethod] = useState<"check" | "cash" | "card" | "ach" | "other">("check");
  const [date, setDate] = useState(todayIn(session.company.timezone));
  const [notes, setNotes] = useState("");
  const value = Number(amount);
  const tooMuch = value > invoice.balance + 0.005;
  const save = useMutation({
    meta: { inline: true, success: "Payment recorded", tone: "invoice" },
    mutationFn: async () => {
      // The same check AI assistants' record_payment makes (packages/core/src/money.ts).
      const problem = paymentProblem(value, invoice.balance);
      if (problem) throw new Error(problem);
      if (invoice.draft) unwrap(await supabase().from("invoices").update({ status: "sent" }).eq("id", invoice.id));
      unwrap(
        await supabase().from("payments").insert({
          company_id: session.company.id,
          invoice_id: invoice.id,
          client_id: invoice.client_id,
          amount: Math.round(value * 100) / 100,
          tip_amount: Number(tip) > 0 ? Math.round(Number(tip) * 100) / 100 : 0,
          method,
          received_at: new Date(`${date}T12:00:00`).toISOString(),
          notes: notes.trim() || null,
        }),
      );
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Record payment" description={`Balance due ${formatMoneyCents(invoice.balance)}`}>
      <form
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (bank && !(await confirm({ title: "A bank payment is still clearing", body: bank, confirmLabel: "Record it anyway" }))) return;
          save.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Amount" requiredMessage="Enter the amount you received." error={tooMuch ? `More than the ${formatMoneyCents(invoice.balance)} balance.` : null}>
            <span className="input-group"><span className="addon">$</span><input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={tooMuch || undefined} required /></span>
          </Field>
          <Field label="Tip" optional>
            <span className="input-group"><span className="addon">$</span><input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value.replace(/[^0-9.]/g, ""))} /></span>
          </Field>
          <Field label="Method">
            <select className="select" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {Object.entries(METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="Received"><input className="input" type="date" value={date} max={todayIn(session.company.timezone)} onChange={(e) => setDate(e.target.value)} required /></Field>
        </div>
        <Field label="Reference" optional><input className="input" placeholder="Check number" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="dollar" loading={save.isPending}>Record {value > 0 ? formatMoneyCents(value) : "payment"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** `left` is what hasn't been refunded yet (earlier refunds count against the payment). */
function RefundDialog({ invoice, payment, left, onClose, onSaved }: { invoice: { id: string; client_id: string }; payment: { id: string; amount: number; method: string }; left: number; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const [amount, setAmount] = useState(left.toFixed(2));
  const [date, setDate] = useState(todayIn(session.company.timezone));
  const [notes, setNotes] = useState("");
  const value = Number(amount);
  const tooMuch = value > left + 0.005;
  const limit = left < payment.amount ? `the ${formatMoneyCents(left)} left to refund on this payment` : `the ${formatMoneyCents(payment.amount)} payment`;
  const save = useMutation({
    meta: { inline: true, success: "Refund recorded", tone: "invoice" },
    mutationFn: async () => {
      if (!(value > 0)) throw new Error("Enter an amount greater than zero.");
      if (tooMuch) throw new Error(`That's more than ${limit}.`);
      // Check again against the latest payments, in case a refund was just recorded elsewhere.
      const latest = unwrap(await supabase().from("payments").select("amount, method, processor").eq("invoice_id", invoice.id));
      const now = refundable(payment, latest);
      if (value > now + 0.005) throw new Error(now > 0 ? `Only ${formatMoneyCents(now)} of this payment is left to refund.` : "This payment has already been refunded.");
      unwrap(
        await supabase().from("payments").insert({
          company_id: session.company.id,
          invoice_id: invoice.id,
          client_id: invoice.client_id,
          amount: -Math.round(value * 100) / 100,
          method: payment.method as "check",
          received_at: new Date(`${date}T12:00:00`).toISOString(),
          notes: notes.trim() ? `Refund: ${notes.trim()}` : "Refund",
        }),
      );
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Record a refund" description="Record money you gave back to the client. The invoice balance goes back up by this amount.">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Amount" requiredMessage="Enter the amount you gave back." error={tooMuch ? `More than ${limit}.` : null}>
            <span className="input-group"><span className="addon">$</span><input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={tooMuch || undefined} required /></span>
          </Field>
          <Field label="Refunded on"><input className="input" type="date" value={date} max={todayIn(session.company.timezone)} onChange={(e) => setDate(e.target.value)} required /></Field>
        </div>
        <Field label="Note" optional><input className="input" placeholder="Check number or reason" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={180} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="undo" loading={save.isPending}>Record {value > 0 ? `${formatMoneyCents(value)} refund` : "refund"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Refund a payment Stripe took, all of it or part, through Stripe: the server makes the refund and
 * books it at once (Stripe's own report of it then finds it booked). `left` is what hasn't gone back
 * yet, tip included. A refund puts the balance back up by what went back, so "Take it off the
 * invoice too" writes that off, and nobody asks the client to pay again for what they were refunded.
 * When other money is still owed on it too, nothing is written off, and the office is told how much
 * is still asked for.
 */
function StripeRefundDialog({ payment, left, onClose, onSaved }: { payment: { id: string; method: string }; left: number; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState(left.toFixed(2));
  const [writeOff, setWriteOff] = useState(true);
  const value = Number(amount);
  const tooMuch = value > left + 0.005;
  const save = useMutation({
    // "Refund sent to Stripe", unless the note below says it all (stripeRefundToasts).
    meta: { inline: true, success: (result: StripeRefundResult) => stripeRefundToasts(result, writeOff).success, tone: "invoice" },
    mutationFn: async () => {
      if (!(value > 0)) throw new Error("Enter an amount greater than zero.");
      if (tooMuch) throw new Error(`That's more than the ${formatMoneyCents(left)} left to refund.`);
      return api.post<StripeRefundResult>(`/payments/${payment.id}/refund`, { amount: Math.round(value * 100) / 100, write_off: writeOff });
    },
    onSuccess: (result) => {
      // Ticked but not written off (other money is still owed), or not booked here yet.
      const { note } = stripeRefundToasts(result, writeOff);
      if (note) toast.info(note.title, note.description ? { description: note.description } : undefined);
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Refund payment" description={`The money goes back to their ${payment.method === "ach" ? "bank account" : "card"}. Stripe keeps its fee.`}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Amount" hint={`Up to ${formatMoneyCents(left)}`} requiredMessage="Enter the amount to refund." error={tooMuch ? `More than the ${formatMoneyCents(left)} left to refund.` : null}>
          <span className="input-group"><span className="addon">$</span><input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={tooMuch || undefined} required /></span>
        </Field>
        <div className="stack-sm">
          <label className="checkbox"><input type="checkbox" checked={writeOff} onChange={(e) => setWriteOff(e.target.checked)} /> Take it off the invoice too</label>
          {!writeOff && <span className="muted small">The balance goes back up by the refund, and the client will be asked for it.</span>}
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="undo" loading={save.isPending}>{value > 0 ? `Refund ${formatMoneyCents(value)}` : "Refund"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
