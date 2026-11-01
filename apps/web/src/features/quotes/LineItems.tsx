/**
 * Line items, shared by quotes, jobs and invoices. They read like a simple table; clicking a row opens
 * it for editing (one at a time). Each field saves when it loses focus (or on Enter), and says so in
 * the page header's save status when the page passes one; totals are recalculated by Postgres
 * triggers, so the parent just refetches. Removing a line can be undone.
 *
 * On a quote that offers options (quote_options), `lines` is every line on the quote and the list
 * shows the ones on every option with the option being looked at (`optionId`). New lines go on that
 * option, or on every option, and a line can be moved between them; the money counts as core money.ts
 * counts it for that option. Jobs and invoices have no options.
 */
import { countsOn, lineTotal, optionLabels, optionLines, toCents } from "@crewtavo/core/money";
import { promoCodeOf, removedPromoWords } from "@crewtavo/core/promos";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import type { SaveStatusHandle } from "@/components/ui/SaveStatus";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { ApiError, errorMessage, isAuthError, isNetworkError, isRestarting } from "@/lib/errors";
import { formatMoneyCents, formatNumber } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { toast, type ToastTone } from "@/lib/toast";
import { readJobDiscounts } from "../jobs/JobDiscountNote";
import styles from "./LineItems.module.css";

type Table = "quote_line_items" | "job_line_items" | "invoice_line_items";
type Parent = "quote_id" | "job_id" | "invoice_id";

export interface Line {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  unit_cost?: number | null;
  taxable: boolean;
  sort: number;
  optional?: boolean;
  selected?: boolean;
  formula?: string | null;
  service_id?: string | null;
  /** A quote line's option; null (or left out) for a line on every option. */
  option_id?: string | null;
  /** Add-ons that share one are a single choice: the client picks one of them. */
  option_group?: string | null;
  /** An invoice line that's a job's promo code discount (supabase/migrations/20261031000600_promo_once_per_job.sql). */
  discount_quote_id?: string | null;
  /** A job line that's a promo code's discount: the quote it's from. */
  discount_key?: string | null;
}

/**
 * A promo code's discount line on a job or an invoice. It stays the code's: its price and quantity
 * aren't typed (a price can't be typed below zero, and the database keeps it money off), and it isn't
 * duplicated, or the copy would come off every visit as a plain discount.
 */
export const isPromoLine = (table: Table, line: Pick<Line, "discount_quote_id" | "discount_key">) =>
  (table === "job_line_items" && Boolean(line.discount_key)) || (table === "invoice_line_items" && Boolean(line.discount_quote_id));

const COPY_FIELDS = ["name", "description", "quantity", "unit", "unit_price", "taxable", "service_id"] as const;
/** The workflow color of the record the lines are on, for their toasts. */
const TONES: Record<Table, ToastTone> = { quote_line_items: "quote", job_line_items: "job", invoice_line_items: "invoice" };

/** The lines a list shows: on a quote with options, the ones on every option and the option looked at's. */
export function visibleLines<T extends { option_id?: string | null }>(lines: readonly T[], optionId: string | null | undefined): T[] {
  return optionId ? lines.filter((l) => l.option_id == null || l.option_id === optionId) : [...lines];
}

/** The sort number for a new line: after every line there is, shown or not (another option's too). */
export const nextSort = (lines: ReadonlyArray<{ sort: number }>) => lines.reduce((top, l) => Math.max(top, Number(l.sort)), -1) + 1;

/**
 * A line moved up or down past the next line shown: it goes just before (or after) that line among all
 * the lines, the others keep their order (so another option's list stays as it was), and they're
 * numbered again from 0, so equal sort values (old data) can't block a move. Only the lines whose
 * number changes, to save.
 */
export function movedSorts(lines: ReadonlyArray<{ id: string; sort: number }>, shownIds: readonly string[], id: string, dir: -1 | 1): Array<{ id: string; sort: number }> {
  const neighbor = shownIds[shownIds.indexOf(id) + dir];
  if (!shownIds.includes(id) || !neighbor) return [];
  const order = lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => Number(a.line.sort) - Number(b.line.sort) || a.i - b.i)
    .map(({ line }) => line.id)
    .filter((lineId) => lineId !== id);
  order.splice(order.indexOf(neighbor) + (dir === 1 ? 1 : 0), 0, id);
  const before = new Map(lines.map((l) => [l.id, Number(l.sort)]));
  return order.map((lineId, sort) => ({ id: lineId, sort })).filter((l) => before.get(l.id) !== l.sort);
}

/**
 * What the lines shown come to before any discount and tax, and what they cost: the lines that count
 * with the option looked at, as they would once it's the one shown (core optionLines and countsOn), so
 * the price is that option's subtotal. `withOptions`: quote lines, where an add-on the client left off
 * doesn't count; on a job or an invoice every line does.
 */
export function lineSums(lines: readonly Line[], { optionId = null, shownOptionId = null, withOptions = false }: { optionId?: string | null; shownOptionId?: string | null; withOptions?: boolean } = {}) {
  const counted = withOptions
    ? optionLines(lines.map((l) => ({ ...l, option_id: l.option_id ?? null })), optionId, shownOptionId).filter((l) => countsOn(l, optionId))
    : lines;
  const price = counted.reduce((s, l) => s + toCents(lineTotal(l.quantity, l.unit_price)), 0) / 100;
  const cost = counted.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_cost ?? 0), 0);
  const costed = counted.some((l) => l.unit_cost != null && Number(l.unit_cost) > 0);
  return { price, cost, costed };
}

/** Where a line is, on a quote that offers options: "On every option", or "Only on Better". */
export const placeName = (optionId: string | null | undefined, options: ReadonlyArray<{ id: string; name: string }>) =>
  optionId ? `Only on ${options.find((o) => o.id === optionId)?.name ?? "one option"}` : "On every option";

export function LineItems({
  table,
  parent,
  parentId,
  lines,
  editable,
  onChanged,
  withOptions = false,
  optionId = null,
  shownOptionId = null,
  options = [],
  saveStatus,
  onOfferOptions,
  promoJob = null,
}: {
  table: Table;
  parent: Parent;
  parentId: string;
  lines: Line[];
  editable: boolean;
  onChanged: () => void;
  withOptions?: boolean;
  /** On a quote that offers options: the option being looked at. Its lines show with the shared ones, and new lines go on it. */
  optionId?: string | null;
  /** The option shown first (quotes.option_id), whose add-on picks count. */
  shownOptionId?: string | null;
  /** The quote's options, for where each line is ("On every option", "Only on Better"). */
  options?: ReadonlyArray<{ id: string; name: string }>;
  /** The page header's save status (useSaveStatus): each field's save shows there, and its failure too; a toast only says why one was turned down. */
  saveStatus?: SaveStatusHandle;
  /** On a quote that offers no options yet: "Offer options" in the add row, beside "Custom item". */
  onOfferOptions?: () => void;
  /** An invoice's job, for what the toast says when one of its promo lines is removed: where the discount went. */
  promoJob?: { id: string; repeats: boolean } | null;
}) {
  const session = useSession();
  const { company } = session;
  const tone = TONES[table];
  const listRef = useListAnimation<HTMLDivElement>();
  const showCosts = hasRole(session, "admin", "office", "estimator") && can(session, "job_costs") && table !== "invoice_line_items";
  // Only a quote's lines are ever on an option.
  const offers = table === "quote_line_items" && options.length > 0 && optionId !== null;
  const viewing = offers ? optionId : null;
  const shown = useMemo(() => visibleLines(lines, viewing), [lines, viewing]);
  const viewingName = options.find((o) => o.id === viewing)?.name ?? "this option";
  // Where a new line goes: the option looked at, or every option.
  const [addToEvery, setAddToEvery] = useState(false);
  const services = useQuery({
    queryKey: ["services", company.id],
    enabled: editable,
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, description, unit, unit_price, unit_cost, taxable, formula, category").eq("company_id", company.id).eq("active", true).order("sort")),
  });

  const [openId, setOpenId] = useState<string | null>(null);
  // Numbered after every line, another option's too, so a new line never shares a place with one.
  const insert = async (rows: Array<Record<string, unknown>>) => {
    const base = nextSort(lines);
    const created = unwrap(await supabase().from(table).insert(rows.map((row, i) => ({ ...row, company_id: company.id, [parent]: parentId, sort: base + i })) as never).select("id")) as Array<{ id: string }>;
    return created[0]?.id ?? null;
  };

  const add = useMutation({
    mutationFn: async (serviceId: string | null) => {
      const s = services.data?.find((x) => x.id === serviceId);
      const row: Record<string, unknown> = s
        ? { service_id: s.id, name: s.name, description: s.description, unit: s.unit, unit_price: s.unit_price, taxable: s.taxable, quantity: 1 }
        : { name: "New item", quantity: 1, unit: "ea", unit_price: 0 };
      if (table !== "invoice_line_items" && s) row.unit_cost = s.unit_cost;
      if (table === "quote_line_items" && s) row.formula = s.formula;
      if (offers) row.option_id = addToEvery ? null : viewing;
      return { id: await insert([row]), custom: !s };
    },
    // A custom item opens for editing right away; a price-list item is ready as it is.
    onSuccess: (r) => {
      if (r.custom) setOpenId(r.id);
      onChanged();
    },
  });

  const move = useMutation({
    mutationFn: async ({ id, dir }: { id: string; dir: -1 | 1 }) => {
      const changes = movedSorts(lines, shown.map((l) => l.id), id, dir);
      await Promise.all(changes.map((c) => supabase().from(table).update({ sort: c.sort } as never).eq("id", c.id)));
    },
    onSuccess: onChanged,
  });

  const duplicate = useMutation({
    meta: { success: "Line duplicated", tone },
    mutationFn: async (line: Line) => {
      const row: Record<string, unknown> = Object.fromEntries(COPY_FIELDS.map((k) => [k, line[k] ?? null]));
      if (table !== "invoice_line_items") row.unit_cost = line.unit_cost ?? null;
      if (table === "quote_line_items") Object.assign(row, { optional: line.optional ?? false, selected: line.selected ?? true, formula: line.formula ?? null });
      // The copy is where the line is: on every option, or on the one looked at.
      if (offers) row.option_id = line.option_id ?? null;
      setOpenId(await insert([row]));
    },
    onSuccess: onChanged,
  });

  const remove = useMutation({
    mutationFn: async (line: Line) => {
      // A job's promo line on a draft: where its discount goes is read before and after (the database
      // moves it as the line comes off), so the toast can say. The draft's other lines say whether it
      // still takes the code off (an every-visit code has a copy on each visit).
      const key = table === "invoice_line_items" && promoJob ? line.discount_quote_id : null;
      const before = key && promoJob ? await readJobDiscounts(promoJob.id) : null;
      unwrap(await supabase().from(table).delete().eq("id", line.id));
      const after = key && promoJob ? await readJobDiscounts(promoJob.id) : null;
      const rest = lines.filter((l) => l.id !== line.id);
      return { line, note: key && promoJob ? removedPromoWords(key, parentId, before, after, promoJob.repeats, rest) : null };
    },
    // Gone at once (the totals follow), and put back from the toast: a new row with the same fields.
    onSuccess: ({ line, note }) => {
      onChanged();
      toast.success("Line removed", {
        description: note ?? line.name,
        tone,
        countdown: true,
        action: {
          label: "Undo",
          onClick: async () => {
            const { id: _id, ...rest } = line;
            const row: Record<string, unknown> = { ...rest, company_id: company.id, [parent]: parentId };
            if (table !== "quote_line_items") {
              delete row.optional;
              delete row.selected;
              delete row.formula;
              delete row.option_id;
              delete row.option_group;
            }
            if (table === "invoice_line_items") delete row.unit_cost;
            // Back on the option it was on (that option may have gone since: then it can't come back).
            const { error } = await supabase().from(table).insert(row as never);
            // A promo line comes back off the draft its discount moved to, but not off an invoice sent since: the database says which.
            if (error) toast.error("Couldn't put the line back", error.code === "22023" ? { description: error.message } : undefined);
            onChanged();
          },
        },
      });
    },
  });

  const totals = useMemo(() => lineSums(shown, { optionId: viewing, shownOptionId, withOptions }), [shown, viewing, shownOptionId, withOptions]);
  const place = offers ? options : null;
  // Without options, a line group's add-ons have the tier words the Client Hub and the paper give them.
  const tiers = useMemo(() => (table === "quote_line_items" && !offers ? optionLabels(lines) : null), [table, offers, lines]);
  const chipOf = (line: Line) => addOnLabel(line, { offers, tier: tiers?.get(line.id) });

  return (
    <div className="card">
      {editable ? (
        <div role="table" aria-label="Line items" ref={listRef}>
          <div className="lines-head" role="row">
            <span role="columnheader">Item</span>
            <span role="columnheader" className="num">Qty</span>
            <span role="columnheader">Unit</span>
            <span role="columnheader" className="num">Price</span>
            <span role="columnheader" className="num">Total</span>
            <span role="columnheader"><span className="sr-only">Actions</span></span>
          </div>
          {shown.map((line, i) => {
            const actions = (
              <Menu
                triggerClassName="btn btn-sm btn-ghost btn-icon"
                label={`Actions for ${line.name}`}
                items={[
                  { label: "Edit", icon: "edit", hidden: openId === line.id, onSelect: () => setOpenId(line.id) },
                  { label: "Move up", icon: "chevronUp", disabled: i === 0, onSelect: () => move.mutate({ id: line.id, dir: -1 }) },
                  { label: "Move down", icon: "chevronDown", disabled: i === shown.length - 1, onSelect: () => move.mutate({ id: line.id, dir: 1 }) },
                  { label: "Duplicate", icon: "copy", hidden: isPromoLine(table, line), onSelect: () => duplicate.mutate(line) },
                  { separator: true },
                  { label: "Remove", icon: "trash", danger: true, onSelect: () => remove.mutate(line) },
                ]}
              />
            );
            return openId === line.id ? (
              <LineRow key={line.id} table={table} line={line} editable withOptions={withOptions} showCosts={showCosts} place={place} viewing={viewing} addOn={chipOf(line)} saveStatus={saveStatus} onChanged={onChanged} onDone={() => setOpenId(null)} actions={actions} />
            ) : (
              <LineSummary key={line.id} line={line} withOptions={withOptions} shared={offers && line.option_id == null} addOn={chipOf(line)} onOpen={() => setOpenId(line.id)} actions={actions} />
            );
          })}
        </div>
      ) : (
        <table className="table table-stack" aria-label="Line items">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num" style={{ width: 90 }}>Qty</th>
              <th style={{ width: 80 }}>Unit</th>
              <th className="num" style={{ width: 110 }}>Price</th>
              <th className="num" style={{ width: 120 }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={5} className="muted">No line items</td></tr>}
            {shown.map((line) => (
              <LineRow key={line.id} table={table} line={line} editable={false} withOptions={withOptions} showCosts={false} place={place} viewing={viewing} addOn={chipOf(line)} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      )}
      {/* One quiet line, right above the ways to add one. */}
      {editable && shown.length === 0 && <EmptyState inline title={offers ? `Nothing on ${viewingName} yet` : "No line items yet"} />}
      {editable && (
        <div className="card-pad row wrap" style={{ borderTop: "1px solid var(--divider)", paddingTop: 14, paddingBottom: 14 }}>
          <ServicePicker services={services.data ?? []} loading={services.isPending || add.isPending} onPick={(id) => add.mutate(id)} />
          <Button icon="plus" onClick={() => add.mutate(null)} disabled={add.isPending}>Custom item</Button>
          {/* What the options bar offered before there were any: one package to price it from, or two or three side by side. */}
          {onOfferOptions && <Button icon="package" onClick={onOfferOptions}>{lines.length ? "Offer options" : "Pick packages"}</Button>}
          {offers && (
            <div className={`segmented ${styles.addTo}`} role="group" aria-label="New lines go">
              <button type="button" aria-pressed={!addToEvery} onClick={() => setAddToEvery(false)}><span>Only on {viewingName}</span></button>
              <button type="button" aria-pressed={addToEvery} onClick={() => setAddToEvery(true)}><span>On every option</span></button>
            </div>
          )}
          {showCosts && totals.costed && (
            <span className="muted small" style={{ marginLeft: "auto" }}>
              Cost {formatMoneyCents(totals.cost)} · Margin <strong style={{ color: totals.price - totals.cost < 0 ? "var(--danger)" : "var(--ink)" }}>{totals.price > 0 ? `${Math.round(((totals.price - totals.cost) / totals.price) * 100)}%` : "—"}</strong>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** "Add from price list": a searchable list of services. */
function ServicePicker({ services, loading, onPick }: { services: Array<{ id: string; name: string; unit: string; unit_price: number; category: string | null }>; loading: boolean; onPick: (id: string) => void }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState("");
  const [index, setIndex] = useState(0);
  const matches = services.filter((s) => `${s.name} ${s.category ?? ""}`.toLowerCase().includes(term.trim().toLowerCase())).slice(0, 50);

  useEffect(() => {
    const p = panel.current;
    if (!p) return;
    const onToggle = (e: Event) => {
      if ((e as Event & { newState: string }).newState !== "open") return;
      const r = button.current!.getBoundingClientRect();
      const below = r.bottom + 6 + 340 < window.innerHeight;
      p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8))}px`;
      // Opening upward: anchor the bottom edge so the panel stays next to the button as results shrink.
      p.style.top = below ? `${r.bottom + 6}px` : "auto";
      p.style.bottom = below ? "auto" : `${window.innerHeight - r.top + 6}px`;
      setTerm("");
      setIndex(0);
      requestAnimationFrame(() => input.current?.focus());
    };
    p.addEventListener("toggle", onToggle);
    return () => p.removeEventListener("toggle", onToggle);
  }, []);

  const pick = (serviceId: string) => {
    panel.current?.hidePopover();
    onPick(serviceId);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(matches.length - 1, i + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    if (e.key === "Enter" && matches[index]) { e.preventDefault(); pick(matches[index].id); }
  };

  return (
    <>
      {/* Outlined like the other ways to add: the page's next step is its only solid button. */}
      <button ref={button} type="button" className="btn" popovertarget={id} disabled={loading && !services.length}>
        {loading ? <span className="spinner" style={{ width: 16, height: 16 }} /> : <Icon name="list" size={16} />}
        Add from price list
      </button>
      <div ref={panel} id={id} popover="auto" className="menu" style={{ width: 360, maxWidth: "calc(100vw - 16px)", padding: 0 }}>
        <div className="input-group" style={{ padding: 8, borderBottom: "1px solid var(--divider)" }}>
          <span className="addon" style={{ left: 18 }}><Icon name="search" size={14} /></span>
          <input ref={input} className="input input-sm" value={term} onChange={(e) => { setTerm(e.target.value); setIndex(0); }} onKeyDown={onKeyDown} placeholder="Search your services" aria-label="Search services" />
        </div>
        <div style={{ maxHeight: 280, overflowY: "auto", padding: 4 }} role="listbox">
          {matches.length === 0 && <div className="empty" style={{ padding: 16 }}>{services.length ? "No services match" : "Your price list is empty. Add services in Settings."}</div>}
          {matches.map((s, i) => (
            <button key={s.id} type="button" role="option" aria-selected={i === index} className="menu-item" style={{ height: "auto", padding: "8px 10px", background: i === index ? "var(--fill-2)" : undefined }} onMouseMove={() => setIndex(i)} onClick={() => pick(s.id)}>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="ellipsis" style={{ display: "block" }}>{s.name}</span>
                {s.category && <span className="muted small">{s.category}</span>}
              </span>
              <span className="muted small tabular">{formatMoneyCents(s.unit_price)}/{s.unit}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function NumberField({ value, onCommit, onEdit, onUnchanged, label, step = "any", align = "right", prefix, disabled = false, describedBy }: { value: number; onCommit: (v: number) => void; onEdit?: () => void; onUnchanged?: () => void; label: string; step?: string; align?: "right" | "left"; prefix?: string; disabled?: boolean; describedBy?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n) || n < 0) {
      setDraft(String(value));
      onUnchanged?.();
      if (draft.trim() !== "") toast.error(`${label} must be zero or more`);
      return;
    }
    const rounded = step === "0.01" ? Math.round(n * 100) / 100 : Math.round(n * 1000) / 1000;
    if (rounded !== Number(value)) onCommit(rounded);
    else onUnchanged?.();
    setDraft(String(rounded));
  };
  return (
    <span className={prefix ? "input-group" : undefined}>
      {prefix && <span className="addon">{prefix}</span>}
      <input
        className="input"
        aria-label={label}
        aria-describedby={describedBy}
        inputMode="decimal"
        disabled={disabled}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value.replace(/[^0-9.]/g, ""));
          onEdit?.();
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        onFocus={(e) => e.target.select()}
        style={{ textAlign: align, paddingLeft: prefix ? 22 : undefined }}
      />
    </span>
  );
}

/**
 * The chip on an add-on, and whether it's picked. On a quote that offers options (`offers`), add-ons
 * the client picks one of (a line group) say "Pick one": Good, Better and Best are the options there.
 * Otherwise a group's add-on has the tier word the Client Hub and the paper give it (`tier`, core
 * optionLabels), and any other add-on is "Optional".
 */
export const addOnLabel = (line: Pick<Line, "optional" | "selected" | "option_group">, { offers = false, tier }: { offers?: boolean; tier?: string | null } = {}) =>
  line.optional ? `${offers && line.option_group ? "Pick one" : (tier ?? "Optional")}${line.selected ? " · chosen" : ""}` : null;

/** A line as it reads to the office: click anywhere on it to edit. `shared`: on every option of a quote that offers options. `addOn`: its add-on chip (addOnLabel). */
function LineSummary({ line, withOptions, shared, addOn, onOpen, actions }: { line: Line; withOptions: boolean; shared: boolean; addOn: string | null; onOpen: () => void; actions: React.ReactNode }) {
  const excluded = withOptions && line.optional && !line.selected;
  // Rounded to the cent as the database rounds it (1.5 × $0.35 is $0.53).
  const amount = lineTotal(line.quantity, line.unit_price);
  const qty = formatNumber(Number(line.quantity), Number(line.quantity) % 1 ? 2 : 0);
  return (
    <div className="line-view" role="row" data-excluded={excluded || undefined}>
      <div role="cell">
        <button type="button" className="line-open" onClick={onOpen} aria-label={`Edit ${line.name}`}>
          <span className="name-cell">
            <strong>{line.name}</strong>
            {addOn && <span className="chip" style={{ marginLeft: 6 }}>{addOn}</span>}
            {shared && <span className="chip" style={{ marginLeft: 6 }}>On every option</span>}
            {!line.taxable && <span className="chip" style={{ marginLeft: 6 }}>No tax</span>}
            {line.description && <span className="muted small ellipsis-2" style={{ display: "block" }}>{line.description}</span>}
          </span>
          <span className="num">{qty}</span>
          <span>{line.unit}</span>
          <span className="num">{formatMoneyCents(line.unit_price)}</span>
          <span className="num total">{excluded ? <span className="muted">Not included</span> : formatMoneyCents(amount)}</span>
        </button>
      </div>
      <div role="cell">{actions}</div>
    </div>
  );
}

/**
 * A line as a row: its fields to edit, or (not `editable`) as it reads. `place`: the quote's options,
 * when it offers them, for where the line is; `viewing` is the option looked at. `addOn`: its add-on
 * chip (addOnLabel). `saveStatus`: the page header's, which each save reports to.
 */
function LineRow({ table, line, editable, withOptions, showCosts, place, viewing, addOn, saveStatus, onChanged, onDone, actions }: {
  table: Table;
  line: Line;
  editable: boolean;
  withOptions: boolean;
  showCosts: boolean;
  place: ReadonlyArray<{ id: string; name: string }> | null;
  viewing: string | null;
  addOn: string | null;
  saveStatus?: SaveStatusHandle;
  onChanged: () => void;
  onDone?: () => void;
  actions?: React.ReactNode;
}) {
  const [draft, setDraft] = useState(line);
  useEffect(() => setDraft(line), [line]);
  const promoHint = useId();
  const promo = isPromoLine(table, line);
  const save = useMutation({
    // With a save status in the header, a failure says so there instead of in a toast, unless it
    // was turned down (an approved quote's lines, say): then the toast says why, as trying again won't help.
    meta: { inline: Boolean(saveStatus) },
    mutationFn: async (patch: Partial<Line>) => unwrap(await supabase().from(table).update(patch as never).eq("id", line.id)),
    onSuccess: onChanged,
    onError: (error) => {
      setDraft(line);
      if (saveStatus && !isNetworkError(error) && !isAuthError(error) && !(error instanceof ApiError && isRestarting(error.status))) toast.error(errorMessage(error));
    },
  });
  // Moved onto another option, the line leaves this list: the toast says where it went.
  const moveTo = useMutation({
    meta: { success: (_: unknown, optionId: string | null) => (optionId && optionId !== viewing ? `Moved to ${place?.find((o) => o.id === optionId)?.name ?? "the other option"}` : null), tone: TONES[table] },
    mutationFn: async (optionId: string | null) => unwrap(await supabase().from(table).update({ option_id: optionId } as never).eq("id", line.id)),
    onSuccess: onChanged,
    onError: () => setDraft(line),
  });
  const persist = (patch: Partial<Line>) => (saveStatus ? void saveStatus.track(save.mutateAsync(patch)) : save.mutate(patch));
  const edited = () => saveStatus?.edited();
  // A field left as it was takes back its "Edited".
  const unchanged = () => saveStatus?.status === "edited" && saveStatus.reset();
  const set = (patch: Partial<Line>) => {
    setDraft({ ...draft, ...patch });
    persist(patch);
  };
  const commitText = (key: "name" | "unit" | "description") => () => {
    const value = (draft[key] ?? "").toString().trim();
    if (key === "name" && !value) {
      setDraft({ ...draft, name: line.name });
      unchanged();
      toast.error("A line item needs a name");
      return;
    }
    if (key === "unit" && !value) {
      unchanged();
      return setDraft({ ...draft, unit: line.unit });
    }
    if (value !== (line[key] ?? "")) persist({ [key]: key === "description" ? value || null : value } as Partial<Line>);
    else unchanged();
  };
  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && e.currentTarget.blur();
  const excluded = withOptions && line.optional && !line.selected;
  const amount = lineTotal(draft.quantity, draft.unit_price);

  if (!editable) {
    return (
      <tr style={excluded ? { opacity: 0.55 } : undefined}>
        <td>
          <strong>{line.name}</strong>
          {addOn && <span className="chip" style={{ marginLeft: 6 }}>{addOn}</span>}
          {place && line.option_id == null && <span className="chip" style={{ marginLeft: 6 }}>On every option</span>}
          {line.description && <div className="muted small pre-wrap">{line.description}</div>}
        </td>
        <td className="num">{formatNumber(Number(line.quantity), Number(line.quantity) % 1 ? 2 : 0)}</td>
        <td>{line.unit}</td>
        <td className="num">{formatMoneyCents(line.unit_price)}</td>
        <td className="num">{excluded ? <span className="muted">—</span> : formatMoneyCents(amount)}</td>
      </tr>
    );
  }

  return (
    <div className="line-edit" role="row" data-excluded={excluded || undefined} data-saving={save.isPending || undefined}>
      <div className="name-cell" role="cell">
        <input className="input" aria-label="Item name" value={draft.name} maxLength={200} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); edited(); }} onBlur={commitText("name")} onKeyDown={blurOnEnter} style={{ fontWeight: 700 }} autoFocus={Boolean(onDone)} onFocus={(e) => line.name === "New item" && e.target.select()} />
      </div>
      <div className="num" role="cell"><span className="cell-label" aria-hidden="true">Qty</span>
        <NumberField label="Quantity" value={Number(draft.quantity)} disabled={promo} describedBy={promo ? promoHint : undefined} onEdit={edited} onUnchanged={unchanged} onCommit={(v) => set({ quantity: v })} />
      </div>
      <div role="cell"><span className="cell-label" aria-hidden="true">Unit</span>
        <input className="input" aria-label="Unit" value={draft.unit} maxLength={20} onChange={(e) => { setDraft({ ...draft, unit: e.target.value }); edited(); }} onBlur={commitText("unit")} onKeyDown={blurOnEnter} />
      </div>
      <div className="num" role="cell"><span className="cell-label" aria-hidden="true">Price</span>
        <NumberField label="Unit price" step="0.01" prefix="$" value={Number(draft.unit_price)} disabled={promo} describedBy={promo ? promoHint : undefined} onEdit={edited} onUnchanged={unchanged} onCommit={(v) => set({ unit_price: v })} />
      </div>
      <div className="total" role="cell"><span className="cell-label">Total</span>{excluded ? <span className="muted">Not included</span> : formatMoneyCents(amount)}</div>
      <div role="cell" style={{ paddingTop: 3 }}>{actions}</div>
      <div className="wide-cell" role="cell">
        <textarea
          className="textarea"
          aria-label="Description"
          placeholder="Description the client will see (optional)"
          value={draft.description ?? ""}
          maxLength={4000}
          onChange={(e) => {
            setDraft({ ...draft, description: e.target.value });
            edited();
          }}
          onBlur={commitText("description")}
          style={{ minHeight: 38, fontSize: 13 }}
          rows={1}
        />
        <div className="opts">
          {promo && <span id={promoHint} className="muted">{promoCodeOf(line.name) ? `Set by promo code ${promoCodeOf(line.name)}.` : "Set by a promo code."} To take it off, remove the line.</span>}
          {place && (
            <select
              className="select input-sm"
              style={{ width: "auto", maxWidth: "100%", fontSize: 12 }}
              aria-label="Which options it's on"
              value={draft.option_id ?? ""}
              disabled={moveTo.isPending}
              onChange={(e) => {
                const optionId = e.target.value || null;
                setDraft({ ...draft, option_id: optionId });
                moveTo.mutate(optionId);
              }}
            >
              <option value="">On every option</option>
              {place.map((o) => <option key={o.id} value={o.id}>{placeName(o.id, place)}</option>)}
            </select>
          )}
          {withOptions && (
            <label>
              <input type="checkbox" checked={Boolean(draft.optional)} onChange={(e) => set({ optional: e.target.checked, selected: !e.target.checked })} />
              {draft.option_group ? "Optional (client picks one)" : "Optional (client chooses)"}
            </label>
          )}
          <label>
            <input type="checkbox" checked={draft.taxable} onChange={(e) => set({ taxable: e.target.checked })} />
            Taxable
          </label>
          {showCosts && (
            <label style={{ gap: 6 }}>
              Unit cost
              <span style={{ width: 96 }}><NumberField label="Unit cost" step="0.01" prefix="$" value={Number(draft.unit_cost ?? 0)} onEdit={edited} onUnchanged={unchanged} onCommit={(v) => set({ unit_cost: v })} /></span>
            </label>
          )}
          {draft.formula && <span className="muted" title="Fills from a measurement">Formula: {draft.formula}</span>}
          {onDone && <Button size="sm" style={{ marginLeft: "auto" }} onClick={onDone}>Done</Button>}
        </div>
      </div>
    </div>
  );
}
