/** Promo codes: a percent or dollar amount off, for quotes, invoices, booking forms and the Client Hub. */
import type { Tables } from "@crewtavo/core/database";
import { repeatChoices } from "@crewtavo/core/promos";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { choose } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatDate, formatMoney, formatMoneyCents, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";

type Promo = Tables<"promo_codes">;

export function offerLabel(p: { kind: string; value: number | string }) {
  return p.kind === "percent" ? `${Number(p.value)}% off` : `${formatMoneyCents(Number(p.value))} off`;
}

function promoStatus(p: Promo, uses: number, today: string): { label: string; tone: Tone } {
  if (!p.active) return { label: "Paused", tone: "muted" };
  if (p.ends_on && p.ends_on < today) return { label: "Ended", tone: "muted" };
  if (p.max_uses && uses >= p.max_uses) return { label: "Used up", tone: "muted" };
  if (p.starts_on && p.starts_on > today) return { label: "Starts later", tone: "info" };
  return { label: "Active", tone: "good" };
}

export function PromoCodes() {
  const session = useSession();
  const queryClient = useQueryClient();
  const today = todayIn(session.company.timezone);
  const [editing, setEditing] = useState<Promo | "new" | null>(null);
  const codes = useQuery({
    queryKey: ["promo-codes", session.company.id],
    queryFn: async () => {
      const [rows, usage, forms] = await Promise.all([
        supabase().from("promo_codes").select("*").eq("company_id", session.company.id).order("created_at", { ascending: false }),
        supabase().rpc("promo_code_usage", { p_company: session.company.id }),
        supabase().from("intake_forms").select("slug, name").eq("company_id", session.company.id).eq("active", true).order("created_at").limit(1),
      ]);
      const used = new Map((unwrap(usage) ?? []).map((u) => [u.promo_code_id, u]));
      return { rows: unwrap(rows), used, form: unwrap(forms)[0] ?? null };
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["promo-codes", session.company.id] });
  const update = useMutation({
    meta: { success: (_: unknown, v: { active?: boolean }) => (v.active === false ? "Code paused" : v.active ? "Code turned back on" : null) },
    mutationFn: async ({ id, ...patch }: { id: string; active?: boolean }) => unwrap(await supabase().from("promo_codes").update(patch).eq("id", id)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("promo_codes").delete().eq("id", id)),
    onSettled: refresh,
  });
  type Codes = NonNullable<typeof codes.data>;
  const key = ["promo-codes", session.company.id];
  // Gone at once, with Undo. Quotes and invoices that used it keep their discount either way, and a
  // quote that becomes a job later still takes it off as the code said (once, or every visit).
  const deleteCode = (promo: Promo) =>
    undoable({
      title: "Promo code deleted",
      description: "Quotes and invoices that used it keep their discount.",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Codes>(key, (old) => old && { ...old, rows: old.rows.filter((r) => r.id !== promo.id) });
      },
      restore: () =>
        queryClient.setQueryData<Codes>(key, (old) => (old && !old.rows.some((r) => r.id === promo.id) ? { ...old, rows: [...old.rows, promo].sort((a, b) => b.created_at.localeCompare(a.created_at)) } : old)),
      commit: () => remove.mutateAsync(promo.id),
    });
  const list = useListAnimation<HTMLDivElement>();

  const form = codes.data?.form;
  const bookingLink = (code: string) => (form ? `${window.location.origin}/book/${session.company.slug}/${form.slug}?promo=${encodeURIComponent(code)}` : null);

  return (
    <div className="stack">
      <div className="row-between">
        <span className="muted small">Clients can enter a code on your booking form or when they open a quote or invoice. You can also add one for them.</span>
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>New promo code</Button>
      </div>
      {codes.isPending ? <TableSkeleton columns={4} rows={3} /> : codes.error ? (
        <div className="card"><ErrorState error={codes.error} onRetry={() => codes.refetch()} /></div>
      ) : !codes.data.rows.length ? (
        <div className="card">
          <EmptyState inline title="No promo codes yet" action={<Button onClick={() => setEditing("new")}>Create a promo code</Button>}>
            Offer a percent or dollar amount off, like SPRING10 for 10% off spring cleanups.
          </EmptyState>
        </div>
      ) : (
        <div className="card" ref={list}>
          {codes.data.rows.map((p) => {
            const usage = codes.data.used.get(p.id);
            const uses = usage?.uses ?? 0;
            const status = promoStatus(p, uses, today);
            const rules = [
              Number(p.min_subtotal) > 0 && `orders over ${formatMoney(p.min_subtotal)}`,
              p.new_clients_only ? "new customers only" : p.once_per_client && "once per client",
              p.every_visit && "every visit",
              p.starts_on && p.starts_on > today && `starts ${formatDate(p.starts_on)}`,
              p.ends_on && `${p.ends_on < today ? "ended" : "ends"} ${formatDate(p.ends_on)}`,
            ].filter(Boolean);
            const link = bookingLink(p.code);
            return (
              <div key={p.id} className="card-row">
                <span className="promo-code">{p.code}</span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>{offerLabel(p)}</strong>
                  {p.description && <span className="muted"> · {p.description}</span>}
                  <span className="muted small ellipsis" style={{ display: "block" }}>
                    {[`${uses}${p.max_uses ? ` of ${p.max_uses}` : ""} ${uses === 1 && !p.max_uses ? "use" : "uses"}`, Number(usage?.discounted ?? 0) > 0 && `${formatMoney(usage!.discounted)} off so far`, ...rules].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <StatusPill label={status.label} tone={status.tone} />
                <Menu
                  triggerClassName="btn btn-sm btn-ghost btn-icon"
                  label={`Actions for ${p.code}`}
                  items={[
                    { label: "Edit", icon: "edit", onSelect: () => setEditing(p) },
                    { label: "Copy code", icon: "copy", onSelect: () => copyText(p.code, "Code copied") },
                    { label: "Copy booking link with this code", icon: "link", hidden: !link, onSelect: () => copyText(link!, "Booking link copied") },
                    { separator: true },
                    { label: p.active ? "Pause" : "Turn back on", icon: p.active ? "pause" : "play", onSelect: () => update.mutate({ id: p.id, active: !p.active }) },
                    {
                      label: "Delete",
                      icon: "trash",
                      danger: true,
                      onSelect: () => deleteCode(p),
                    },
                  ]}
                />
              </div>
            );
          })}
        </div>
      )}
      {editing && <PromoDialog promo={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function PromoDialog({ promo, onClose, onSaved }: { promo: Promo | null; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [f, setF] = useState({
    code: promo?.code ?? "",
    kind: (promo?.kind ?? "percent") as "percent" | "amount",
    value: promo ? String(Number(promo.value)) : "",
    description: promo?.description ?? "",
    min_subtotal: promo && Number(promo.min_subtotal) > 0 ? String(Number(promo.min_subtotal)) : "",
    starts_on: promo?.starts_on ?? "",
    ends_on: promo?.ends_on ?? "",
    max_uses: promo?.max_uses ? String(promo.max_uses) : "",
    once_per_client: promo?.once_per_client ?? true,
    new_clients_only: promo?.new_clients_only ?? false,
    every_visit: promo?.every_visit ?? false,
  });
  const value = Number(f.value);
  const choices = repeatChoices(f.kind, f.value);
  const codeOk = /^[A-Z0-9-]{3,24}$/.test(f.code);
  const valueError = f.value && (!(value > 0) || (f.kind === "percent" && value > 100)) ? (f.kind === "percent" ? "Enter a percent between 1 and 100." : "Enter an amount more than $0.") : null;
  const datesError = f.starts_on && f.ends_on && f.ends_on < f.starts_on ? "The end date is before the start date." : null;
  const save = useMutation({
    // Null: the question about jobs using it was closed without an answer, so nothing was saved.
    meta: { inline: true, success: (jobs: number | null) => (jobs === null ? null : jobs ? `Promo code saved, and ${jobs === 1 ? "1 job" : `${jobs} jobs`} changed too` : promo ? "Promo code saved" : "Promo code created") },
    mutationFn: async () => {
      if (!codeOk) throw new Error("Use 3 to 24 letters, numbers or dashes for the code.");
      if (!(value > 0) || valueError) throw new Error(f.kind === "percent" ? "Enter a percent between 1 and 100." : "Enter an amount more than $0.");
      if (datesError) throw new Error("The end date is before the start date.");
      const row = {
        code: f.code,
        kind: f.kind,
        value: Math.round(value * 100) / 100,
        description: f.description.trim() || null,
        min_subtotal: Math.max(Number(f.min_subtotal) || 0, 0),
        starts_on: f.starts_on || null,
        ends_on: f.ends_on || null,
        max_uses: Number(f.max_uses) > 0 ? Math.round(Number(f.max_uses)) : null,
        once_per_client: f.new_clients_only || f.once_per_client,
        new_clients_only: f.new_clients_only,
        every_visit: f.every_visit,
      };
      // Jobs already using the code keep the rule they started with, unless the office says otherwise.
      // Both buttons save; closing the question (Escape, the X) saves nothing, as closing a confirm does.
      let alsoJobs = false;
      if (promo && f.every_visit !== promo.every_visit) {
        const using = unwrap(await supabase().rpc("promo_code_jobs", { p_promo: promo.id, p_every_visit: f.every_visit }));
        if (using > 0) {
          const one = using === 1;
          const choice = await choose({
            title: `Change the ${one ? "job" : `${using} jobs`} already using ${promo.code} too?`,
            body: f.every_visit
              ? `On ${one ? "that job" : "those jobs"} it comes off the first invoice only. Change ${one ? "it" : "them"} too, and it comes off every visit from ${one ? "its" : "their"} next invoice.`
              : `On ${one ? "that job" : "those jobs"} it comes off every visit. Change ${one ? "it" : "them"} too, and it comes off once: on ${one ? "its" : "their"} next invoice, unless an invoice has it already.`,
            confirmLabel: one ? "Change it too" : "Change them too",
            cancelLabel: "Only new jobs",
          });
          if (choice === null) return null;
          alsoJobs = choice;
        }
      }
      const result = promo
        ? await supabase().from("promo_codes").update(row).eq("id", promo.id)
        : await supabase().from("promo_codes").insert({ ...row, company_id: session.company.id });
      if (result.error?.code === "23505") throw new Error(`You already have a code called ${f.code}.`);
      unwrap(result);
      return alsoJobs && promo ? unwrap(await supabase().rpc("set_promo_code_jobs", { p_promo: promo.id, p_every_visit: f.every_visit })) : 0;
    },
    onSuccess: (jobs) => {
      if (jobs === null) return;
      // Jobs changed too: their pages (the discount's note, the Contract's) and the Jobs list's price for a visit.
      if (jobs) {
        queryClient.invalidateQueries({ queryKey: ["job"] });
        queryClient.invalidateQueries({ queryKey: ["jobs", session.company.id] });
      }
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={promo ? `Edit ${promo.code}` : "New promo code"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Code" hint="What clients type in. Letters, numbers and dashes." error={f.code && !codeOk ? "Use 3 to 24 letters, numbers or dashes." : null}>
          <input className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "") })} maxLength={24} placeholder="SPRING10" required autoFocus />
        </Field>
        <div className="form-grid">
          <Field label="Discount">
            <div className="segmented" role="group" aria-label="Discount type">
              <button type="button" aria-pressed={f.kind === "percent"} onClick={() => setF({ ...f, kind: "percent" })}>Percent off</button>
              <button type="button" aria-pressed={f.kind === "amount"} onClick={() => setF({ ...f, kind: "amount" })}>Dollars off</button>
            </div>
          </Field>
          <Field label={f.kind === "percent" ? "Percent" : "Amount"} error={valueError}>
            <span className="input-group">
              {f.kind === "amount" && <span className="addon">$</span>}
              <input className="input" style={f.kind === "amount" ? { paddingLeft: 22 } : undefined} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.replace(/[^0-9.]/g, "") })} placeholder={f.kind === "percent" ? "10" : "50.00"} required />
              {f.kind === "percent" && <span className="addon addon-right">%</span>}
            </span>
          </Field>
        </div>
        <Field label="What clients see" optional hint="Shown next to the discount, like “Spring cleanup special”.">
          <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={120} />
        </Field>
        <div className="form-grid">
          <Field label="Starts" optional><input className="input" type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} /></Field>
          <Field label="Ends" optional error={datesError}><input className="input" type="date" value={f.ends_on} min={f.starts_on || undefined} onChange={(e) => setF({ ...f, ends_on: e.target.value })} /></Field>
          <Field label="Minimum order" optional>
            <span className="input-group"><span className="addon">$</span><input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={f.min_subtotal} onChange={(e) => setF({ ...f, min_subtotal: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="0" /></span>
          </Field>
          <Field label="Total uses allowed" optional hint="Leave empty for no limit.">
            <input className="input" type="number" min={1} value={f.max_uses} onChange={(e) => setF({ ...f, max_uses: e.target.value })} />
          </Field>
        </div>
        <div className="stack-sm">
          <label className="switch-row">
            <input type="checkbox" className="switch" checked={f.once_per_client || f.new_clients_only} disabled={f.new_clients_only} onChange={(e) => setF({ ...f, once_per_client: e.target.checked })} />
            Each client can use it once
          </label>
          <label className="switch-row">
            <input type="checkbox" className="switch" checked={f.new_clients_only} onChange={(e) => setF({ ...f, new_clients_only: e.target.checked })} />
            New customers only
          </label>
          <label className="switch-row">
            <input type="checkbox" className="switch" checked={f.every_visit} aria-describedby="promo-every-visit" onChange={(e) => setF({ ...f, every_visit: e.target.checked })} />
            Take it off every visit of recurring work
          </label>
          {/* Both choices, whichever way the switch is, with the code's own value. */}
          <span id="promo-every-visit" className="muted small" style={{ display: "grid", gap: 2 }}>
            <span><strong>Off:</strong> {choices.once}</span>
            <span><strong>On:</strong> {choices.everyVisit}</span>
            {promo && <span>If jobs already use the code, saving a change asks whether to change them too.</span>}
          </span>
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{promo ? "Save" : "Create code"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
