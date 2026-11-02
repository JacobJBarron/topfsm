/**
 * Under a recurring or per-visit job's line items: each promo code's discount, whether it comes off the
 * first invoice only or every visit, and for the office with the Invoices area where it went
 * (public.job_promo_discounts). People who sell can switch a job's discount the other way, from its
 * next invoice on, with Undo.
 */
import { jobDiscountWords, type DiscountBilling, type JobDiscount, type Words } from "@crewtavo/core/promos";
import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { toast } from "@/lib/toast";

export interface DiscountLine {
  name: string;
  quantity: number;
  unit_price: number;
  discount_billing?: string | null;
  discount_key?: string | null;
}

/** A job's discounts as the database has them, for a toast that says where one went: null when they can't be read. */
export async function readJobDiscounts(jobId: string): Promise<JobDiscount[] | null> {
  const { data, error } = await supabase().rpc("job_promo_discounts", { p_job: jobId });
  return error ? null : (data as unknown as JobDiscount[]);
}

/**
 * After a change to one of a job's invoices, which can move the job's promo discount to or off its
 * other drafts (a line taken off or put back, Void, Delete): every invoice's page, as the draft it
 * moved to can be any of them, the job's page with this note and its invoices, and the client's list
 * of them. Not `gone`, a deleted invoice's own page, which would load again only to find it missing.
 */
export function refreshJobInvoices(queryClient: QueryClient, job: { jobId: string; clientId?: string | null; gone?: string }) {
  queryClient.invalidateQueries({ queryKey: ["invoice"], predicate: (q) => q.queryKey[1] !== job.gone });
  queryClient.invalidateQueries({ queryKey: ["job", job.jobId] });
  if (job.clientId) queryClient.invalidateQueries({ queryKey: ["client", job.clientId, "work"] });
}

/** The job's discounts as its own lines say, for anyone who sees them: no word on invoices. */
export function lineDiscounts(lines: readonly DiscountLine[]): JobDiscount[] {
  const byKey = new Map<string, JobDiscount>();
  for (const l of lines) {
    if (!l.discount_key || !l.discount_billing) continue;
    const had = byKey.get(l.discount_key);
    const amount = -Math.round(Number(l.quantity) * Number(l.unit_price) * 100) / 100;
    if (had) had.amount = Math.round((had.amount + amount) * 100) / 100;
    else byKey.set(l.discount_key, { key: l.discount_key, name: l.name, billing: l.discount_billing as DiscountBilling, amount, placed: null, left: null, invoices: null });
  }
  return [...byKey.values()];
}

function Said({ words }: { words: Words }) {
  return (
    <>
      {words.map((w, i) => (typeof w === "string" ? <Fragment key={i}>{w}</Fragment> : <Link key={i} to={`/invoices/${w.invoice.id}`}>#{w.invoice.number}</Link>))}
    </>
  );
}

export function JobDiscountNote({ jobId, lines, seesInvoices, canSwitch, onChanged }: {
  jobId: string;
  lines: readonly DiscountLine[];
  /** The office with the Invoices area: where each discount went. */
  seesInvoices: boolean;
  /** People who sell, on an active job. */
  canSwitch: boolean;
  onChanged: () => void;
}) {
  const own = lineDiscounts(lines);
  const placed = useQuery({
    queryKey: ["job", jobId, "promo-discounts"],
    enabled: seesInvoices && own.length > 0,
    queryFn: async () => unwrap(await supabase().rpc("job_promo_discounts", { p_job: jobId })) as unknown as JobDiscount[],
  });
  const setBilling = async (key: string, everyVisit: boolean) =>
    unwrap(await supabase().rpc("set_job_discount_billing", { p_job: jobId, p_key: key, p_every_visit: everyVisit }));
  const change = useMutation({
    mutationFn: async (d: JobDiscount) => {
      const everyVisit = d.billing === "once";
      await setBilling(d.key, everyVisit);
      return { d, everyVisit };
    },
    // It changes every invoice still to come, so it can be undone from the toast.
    onSuccess: ({ d, everyVisit }) => {
      onChanged();
      toast.success(everyVisit ? "Promo code now comes off every visit" : "Promo code now comes off the first invoice only", {
        description: d.name,
        tone: "job",
        countdown: true,
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await setBilling(d.key, !everyVisit);
            } catch {
              toast.error("Couldn't change it back");
            }
            onChanged();
          },
        },
      });
    },
  });
  if (!own.length) return null;

  const shown = own.map((d) => placed.data?.find((p) => p.key === d.key) ?? d);
  return (
    <div className="card card-pad stack-sm" role="group" aria-label="Promo code discounts">
      {shown.map((d) => {
        const { rule, where } = jobDiscountWords(d);
        return (
          <div key={d.key} className="row wrap" style={{ gap: 8, alignItems: "flex-start" }}>
            <span className="muted" style={{ display: "inline-flex", marginTop: 2 }}><Icon name="tag" size={16} /></span>
            <span className="grow small" style={{ minWidth: 0, flexBasis: 220 }}>
              <strong>{d.name}</strong> {rule}
              {where ? <> <Said words={where} /></> : seesInvoices && placed.isPending && d.billing === "once" ? <Skeleton width="60%" style={{ display: "block", marginTop: 4 }} /> : null}
            </span>
            {canSwitch && (
              <Button size="sm" variant="ghost" loading={change.isPending && change.variables?.key === d.key} onClick={() => change.mutate(d)}>
                {d.billing === "once" ? "Take it off every visit instead" : "Take it off the first invoice only instead"}
              </Button>
            )}
          </div>
        );
      })}
      {/* A line, not a whole error block: the rule above still shows, only where it went is missing. */}
      {placed.error && <span className="field-error">Couldn't load which invoices have it. <button type="button" className="link-btn" onClick={() => placed.refetch()}>Try again</button></span>}
    </div>
  );
}
