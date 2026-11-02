import { BREAK_PAY_LABELS, breakPay, type BreakPay } from "@crewtavo/core/breaks";
import { taxPercent, taxRateFromPercent } from "@crewtavo/core/money";
import { PRESETS } from "@crewtavo/core/presets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { formatPhoneTyping } from "@/lib/validate";
import { CompanyLogo } from "./CompanyLogo";

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico", "America/Toronto", "America/Vancouver", "Europe/London", "Australia/Sydney"];
const BREAK_HINTS: Record<BreakPay, string> = {
  short_paid: "Breaks of 20 minutes or less count as paid time; longer ones, like lunch, don't. This follows federal rules.",
  paid: "Every break counts as paid time, lunch included.",
  unpaid: "No break counts as paid time. Federal rules say rest breaks of 20 minutes or less must be paid, so check before choosing this.",
};
const BRAND_COLORS = ["#0f2a35", "#3b7d23", "#1d4ed8", "#b45309", "#be123c", "#6d28d9", "#0f766e", "#1f2937"];

export function CompanySettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const details = useQuery({
    queryKey: ["company", company.id],
    queryFn: async () => unwrap(await supabase().from("companies").select("name, slug, phone, email, website, address, timezone, settings, trade_preset").eq("id", company.id).single()),
  });
  const [f, setF] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!details.data || f) return;
    const d = details.data;
    const a = (d.address ?? {}) as Record<string, string>;
    const s = (d.settings ?? {}) as Record<string, any>;
    setF({
      name: d.name, phone: d.phone ?? "", email: d.email ?? "", website: d.website ?? "", trade: d.trade_preset,
      line1: a.line1 ?? "", city: a.city ?? "", region: a.region ?? "", postal_code: a.postal_code ?? "",
      timezone: d.timezone, payment_terms_days: String(s.payment_terms_days ?? 30), default_tax_rate: String(taxPercent(s.default_tax_rate ?? 0)),
      quote_valid_days: String(s.quote_valid_days ?? 30), hours_start: s.working_hours?.start ?? "07:00", hours_end: s.working_hours?.end ?? "18:00",
      color: s.branding?.color ?? "#0f2a35",
      hub_tips: s.hub_tips ? "1" : "",
      record_location: s.clock?.record_location === false ? "" : "1",
      breaks: breakPay(s),
    });
  }, [details.data, f]);

  const save = useMutation({
    // The button says it saved. Only an address the map couldn't find is worth a toast, since it changes how routes start.
    meta: { inline: true, success: (r: { located: boolean | null }) => (r.located === false ? "Shop address not found on the map. Routes start from the first stop." : null) },
    mutationFn: async () => {
      const v = f!;
      // Kept to 0.0001%, as quotes and invoices keep it (8.875% stays 8.875%).
      const tax = taxRateFromPercent(v.default_tax_rate);
      if (!(Number(v.default_tax_rate) >= 0 && tax < 1)) throw new Error("Sales tax must be between 0 and 100%.");
      if (v.hours_end <= v.hours_start) throw new Error("The workday has to end after it starts.");
      if (v.website && !/^https?:\/\//.test(v.website)) v.website = `https://${v.website}`;
      const previous = (details.data?.settings ?? {}) as Record<string, any>;
      const address = { line1: v.line1.trim(), city: v.city.trim(), region: v.region.trim(), postal_code: v.postal_code.trim() };
      const oldAddress = (details.data?.address ?? {}) as Record<string, string>;
      let depot = previous.depot ?? null;
      let located: boolean | null = null;
      if (address.line1 && (address.line1 !== oldAddress.line1 || address.city !== oldAddress.city || !depot)) {
        const hit = await api.post<{ found: boolean; lat?: number; lng?: number }>("/geocode", { address: [address.line1, address.city, address.region, address.postal_code].filter(Boolean).join(", ") }).catch(() => ({ found: false }) as { found: boolean; lat?: number; lng?: number });
        located = hit.found;
        depot = hit.found ? { lat: hit.lat, lng: hit.lng } : null;
      }
      const settings = {
        ...previous,
        payment_terms_days: Math.max(0, Math.round(Number(v.payment_terms_days) || 0)),
        default_tax_rate: tax,
        quote_valid_days: Math.max(1, Math.round(Number(v.quote_valid_days) || 30)),
        working_hours: { start: v.hours_start, end: v.hours_end },
        branding: { ...(previous.branding ?? {}), color: v.color },
        hub_tips: v.hub_tips === "1",
        clock: { ...(previous.clock ?? {}), record_location: v.record_location === "1", breaks: v.breaks },
        depot,
      };
      unwrap(
        await supabase()
          .from("companies")
          .update({ name: v.name.trim(), phone: v.phone.trim() || null, email: v.email.trim() || null, website: v.website.trim() || null, timezone: v.timezone, address, settings: settings as never, ...(v.trade in PRESETS ? { trade_preset: v.trade } : {}) })
          .eq("id", company.id),
      );
      return { located };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });

  const saved = useJustDone(save);
  if (details.isPending || !f) return details.error ? <div className="card"><ErrorState error={details.error} onRetry={() => details.refetch()} /></div> : <CardSkeleton lines={8} />;
  const set = (key: string) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });

  return (
    <form className="stack" style={{ maxWidth: 860 }} onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <div className="card card-pad stack">
        <strong>Business</strong>
        <div className="form-grid">
          <Field label="Business name"><input className="input" value={f.name} onChange={set("name")} required maxLength={200} /></Field>
          <Field label="Phone"><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: formatPhoneTyping(e.target.value) })} maxLength={40} /></Field>
          <Field label="Email"><input className="input" type="email" value={f.email} onChange={set("email")} maxLength={200} /></Field>
          <Field label="Website" optional><input className="input" value={f.website} onChange={set("website")} maxLength={200} placeholder="https://" /></Field>
          <Field label="Trade" hint={f.trade === "paving" ? "Paving adds the Paving section to the sidebar: takeoff, estimate, proposal, schedule and invoice in one place." : "What's opened up front for your kind of work, like roof tools for roofers and the Paving section for pavers."}>
            <select className="select" value={f.trade} onChange={set("trade")}>
              {Object.values(PRESETS).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="field">
          <span>Logo <span className="optional">(quotes, invoices, Client Hub and emails)</span></span>
          <CompanyLogo path={((details.data?.settings ?? {}) as Record<string, any>).branding?.logo ?? null} />
        </div>
        <div className="field">
          <span>Brand color <span className="optional">(Client Hub and emails)</span></span>
          <div className="row wrap" style={{ gap: 8 }}>
            {BRAND_COLORS.map((c) => <button key={c} type="button" aria-label={`Brand color ${c}`} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })} style={{ width: 32, height: 32, borderRadius: "var(--radius-control)", background: c, border: 0, boxShadow: f.color === c ? `0 0 0 2px #fff, 0 0 0 4px ${c}` : "none", cursor: "pointer" }} />)}
            <input type="color" value={f.color} onChange={set("color")} aria-label="Custom brand color" style={{ width: 38, height: 32, padding: 0, border: 0, background: "none" }} />
          </div>
        </div>
      </div>
      <div className="card card-pad stack">
        <strong>Shop address</strong>
        <Field label="Street"><input className="input" value={f.line1} onChange={set("line1")} maxLength={200} /></Field>
        <div className="form-grid-3">
          <Field label="City"><input className="input" value={f.city} onChange={set("city")} maxLength={100} /></Field>
          <Field label="State"><input className="input" value={f.region} onChange={set("region")} maxLength={20} /></Field>
          <Field label="ZIP"><input className="input" value={f.postal_code} onChange={set("postal_code")} maxLength={12} /></Field>
        </div>
      </div>
      <div className="card card-pad stack">
        <strong>Defaults</strong>
        <div className="form-grid">
          <Field label="Time zone">
            <select className="select" value={f.timezone} onChange={set("timezone")}>
              {[...new Set([f.timezone, ...ZONES])].filter(Boolean).map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </Field>
          <Field label="Sales tax (%)"><input className="input" inputMode="decimal" value={f.default_tax_rate} onChange={(e) => setF({ ...f, default_tax_rate: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
          <Field label="Invoice due after (days)" hint="0 means due on receipt."><input className="input" type="number" min={0} max={365} value={f.payment_terms_days} onChange={set("payment_terms_days")} /></Field>
          <Field label="Quotes valid for (days)"><input className="input" type="number" min={1} max={365} value={f.quote_valid_days} onChange={set("quote_valid_days")} /></Field>
          <Field label="Workday starts"><input className="input" type="time" value={f.hours_start} onChange={set("hours_start")} /></Field>
          <Field label="Workday ends"><input className="input" type="time" value={f.hours_end} onChange={set("hours_end")} /></Field>
        </div>
        <label className="switch-row" style={{ fontWeight: 400 }}>
          <input type="checkbox" className="switch" checked={f.hub_tips === "1"} onChange={(e) => setF({ ...f, hub_tips: e.target.checked ? "1" : "" })} />
          Let clients add a tip when they pay online
        </label>
        {/* The one switch for tips (settings.hub_tips): the Client Hub, the receipt and the server all follow it. */}
        <span className="muted small">Also offered on the receipt after an automatic charge. Off: no tip choice anywhere, and no tip is charged.</span>
      </div>
      <div className="card card-pad stack">
        <strong>Time clock</strong>
        <div className="form-grid">
          <Field label="Breaks" hint={BREAK_HINTS[f.breaks as BreakPay]}>
            <select className="select" value={f.breaks} onChange={set("breaks")}>
              {(Object.keys(BREAK_PAY_LABELS) as BreakPay[]).map((b) => <option key={b} value={b}>{BREAK_PAY_LABELS[b]}</option>)}
            </select>
          </Field>
        </div>
        <label className="switch-row" style={{ fontWeight: 400 }}>
          <input type="checkbox" className="switch" checked={f.record_location === "1"} onChange={(e) => setF({ ...f, record_location: e.target.checked ? "1" : "" })} />
          Save where people are when they clock in and out (the office and crew leads see it on Timesheets)
        </label>
      </div>
      <FormError error={save.error} />
      <div className="form-actions" style={{ justifyContent: "flex-start" }}><FormChecks /><Button type="submit" variant="primary" loading={save.isPending} done={saved}>Save company settings</Button></div>
    </form>
  );
}
