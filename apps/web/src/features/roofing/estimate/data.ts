/**
 * A roof estimate's records and the changes made to it, shared by the office's project page and the
 * salesperson's iPad: the quote with its lines, options and newest measurement, the price list and a
 * package's quick adds, the edits behind − and + (saved straight to the quote's lines, one after
 * another so fast taps land in order, on the option being looked at), and the team's notes and
 * photos on the quote.
 */
import type { SnapshotLine } from "@crewtavo/core/estimates";
import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, supabase, unwrap } from "@/lib/api";
import { signedUrls, storedType, uploadFile } from "@/lib/files";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { IN_TRASH } from "../../drive/trash";
import { undoable } from "@/lib/undo";
import { TAKEOFF_FIELDS, type TakeoffRow } from "../../paving/data";
import { sortOptions } from "../../quotes/options";
import { layersFormula, layersName, layersOf } from "../data";
import {
  baseFormula,
  baseName,
  counts,
  isPendingLine,
  lessOf,
  lineDestination,
  lineKind,
  MAX_LAYERS,
  measuredInto,
  moreOf,
  nothingToMeasure,
  ownServices,
  removedLine,
  threadItems,
  withLines,
  withSavedLine,
  type RemovedLine,
  type Step,
  type ThreadItem,
} from "./rows";
import { ESTIMATE_QUOTE_FIELDS, ESTIMATE_SERVICE_FIELDS, type EstimateLine, type EstimateQuote, type EstimateService, type QuickAddService } from "./types";

// ---------------------------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------------------------

export interface EstimateData {
  quote: EstimateQuote;
  /** The roof's newest measurement, or null before it's measured. */
  takeoff: TakeoffRow | null;
}

export const estimateKey = (quoteId: string) => ["estimate", quoteId];

/**
 * Everything that shows this estimate, loaded again after it changes. `holdEstimate` only marks the
 * estimate itself out of date, for whatever loads it next (refreshEstimateAfterEdits).
 */
export function refreshEstimate(queryClient: QueryClient, quoteId: string, companyId: string, { holdEstimate = false }: { holdEstimate?: boolean } = {}) {
  queryClient.invalidateQueries({ queryKey: ["estimate", quoteId], refetchType: holdEstimate ? "none" : "active" });
  queryClient.invalidateQueries({ queryKey: ["roofing-project", quoteId] });
  queryClient.invalidateQueries({ queryKey: ["roofing-projects", companyId] });
  queryClient.invalidateQueries({ queryKey: ["quote", quoteId] });
}

/** The key the estimate's − and + edits save under (useEstimateEditor), one after another. */
export const editKey = (quoteId: string) => ["estimate-edit", quoteId];

/**
 * refreshEstimate for a change made beside the editor (the materials priced again, a salesperson
 * picked). While − and + are still saving, the estimate itself is only marked out of date: loaded
 * now, it would bring back quantities those taps are about to change, and the next tap would count
 * from the old one. The editor loads it once the last edit has saved. Says whether it loaded now.
 */
export function refreshEstimateAfterEdits(queryClient: QueryClient, quoteId: string, companyId: string): boolean {
  const editing = queryClient.isMutating({ mutationKey: editKey(quoteId) }) > 0;
  refreshEstimate(queryClient, quoteId, companyId, { holdEstimate: editing });
  return !editing;
}

const amount = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function readLine(l: EstimateLine): EstimateLine {
  return { ...l, quantity: Number(l.quantity), unit_price: Number(l.unit_price), unit_cost: amount(l.unit_cost), material_cost: amount(l.material_cost), sort: Number(l.sort) };
}

/** The quote with its lines in order, and the roof's newest measurement. */
export function useEstimateQuote(quoteId: string | null | undefined) {
  return useQuery({
    queryKey: ["estimate", quoteId],
    enabled: Boolean(quoteId),
    queryFn: async (): Promise<EstimateData> => {
      const db = supabase();
      const [quote, takeoff] = await Promise.all([
        db.from("quotes").select(ESTIMATE_QUOTE_FIELDS).eq("id", quoteId!).maybeSingle(),
        db.from("measurements").select(TAKEOFF_FIELDS).eq("quote_id", quoteId!).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const q = unwrap(quote) as unknown as EstimateQuote | null;
      if (!q) throw new ApiError("That estimate wasn't found. It may have been deleted.", 404, "PGRST116");
      const lines = (q.lines ?? []).map(readLine).sort((a, b) => a.sort - b.sort);
      return {
        quote: {
          ...q,
          promo: q.promo ? { code: q.promo.code, kind: q.promo.kind, value: Number(q.promo.value) } : null,
          section_ids: q.section_ids ?? [],
          options: sortOptions(q.options ?? []).map((o) => ({ ...o, highlights: o.highlights ?? [], section_ids: o.section_ids ?? [] })),
          subtotal: Number(q.subtotal),
          discount_amount: Number(q.discount_amount),
          tax_rate: Number(q.tax_rate),
          tax_amount: Number(q.tax_amount),
          total: Number(q.total),
          range_low: amount(q.range_low),
          range_high: amount(q.range_high),
          range_lines: Array.isArray(q.range_lines) ? q.range_lines : null,
          lines,
        },
        takeoff: (unwrap(takeoff) ?? null) as TakeoffRow | null,
      };
    },
  });
}

/** The price list's active services, in its order. */
export function useActiveServices() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["services", company.id, "active", "estimate"],
    queryFn: async () =>
      (unwrap(await supabase().from("services").select(ESTIMATE_SERVICE_FIELDS).eq("company_id", company.id).eq("active", true).order("sort").order("name")) as unknown as EstimateService[]).map((s) => ({
        ...s,
        unit_price: Number(s.unit_price),
        unit_cost: amount(s.unit_cost),
        labor_cost: amount(s.labor_cost),
      })),
  });
}

/**
 * A roof package's quick adds, in its order, with how many each starts at. Under the packages' key,
 * so editing a package (["roof-packages", company]) refreshes them.
 */
export function usePackageQuickAdds(packageId: string | null | undefined) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["roof-packages", company.id, packageId, "quick"],
    enabled: Boolean(packageId),
    queryFn: async (): Promise<QuickAddService[]> => {
      const rows = unwrap(
        await supabase().from("roof_package_items").select(`quantity, sort, service:services(${ESTIMATE_SERVICE_FIELDS}, active)`).eq("package_id", packageId!).eq("kind", "quick").order("sort"),
      ) as unknown as Array<{ quantity: number | null; service: (EstimateService & { active: boolean }) | null }>;
      return rows.flatMap(({ quantity, service }) => {
        if (!service?.active) return [];
        const { active: _active, ...rest } = service;
        return [{ ...rest, unit_price: Number(rest.unit_price), unit_cost: amount(rest.unit_cost), labor_cost: amount(rest.labor_cost), quantity: amount(quantity) }];
      });
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Changing it
// ---------------------------------------------------------------------------------------------

interface NewLine {
  company_id: string;
  quote_id: string;
  /** The option it goes on; null on every option. */
  option_id: string | null;
  service_id: string | null;
  name: string;
  description: string | null;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  taxable: boolean;
  formula: string | null;
  quantity: number;
  sort: number;
}

/** What can be set on a line by hand: how many, its price for one, and the words printed under its name. */
export interface LinePatch {
  quantity?: number;
  unit_price?: number;
  description?: string | null;
}

type Edit =
  | { op: "quantity"; lineId: string; quantity: number }
  | { op: "line"; lineId: string; patch: LinePatch }
  | { op: "delete"; lineId: string }
  | { op: "layers"; lineId: string; formula: string; name: string }
  | { op: "insert"; row: NewLine; serviceId: string | null; putBack?: RemovedLine; pendingId: string | null };

/** What apply-measurement says about a line it measured. */
interface MeasuredLine {
  id: string;
  field?: string;
  value?: number;
  error?: string;
}

export interface EstimateEditor {
  /** + on a line: one more, or one more layer. */
  inc: (line: EstimateLine) => void;
  /** − on a line: one fewer (taking it off at one), a layer fewer, or take a measured line off. */
  dec: (line: EstimateLine) => void;
  remove: (line: EstimateLine) => void;
  /** Set a line's quantity, price for one or description by hand. */
  setLine: (line: EstimateLine, patch: LinePatch) => void;
  /** Put a line that was taken off back, as it was. */
  putBack: (snapshot: SnapshotLine) => void;
  /**
   * Add a service (a quick add, or from the price list); a count already on the estimate gets more.
   * `to` is the option a new line goes on (null: every option), as the add control shows it (rows.ts
   * lineDestination); left out, it goes where lineDestination puts it by default.
   */
  addService: (service: EstimateService, quantity?: number | null, to?: string | null) => void;
  /** Tear off this many layers (0 takes the tear-off off). */
  setLayers: (line: EstimateLine, layers: number) => void;
  /** Changes are still saving. */
  busy: boolean;
  /** Lines added, changed and taken off on this screen, for the Added, Changed and Taken off tags. */
  added: string[];
  changed: string[];
  removed: RemovedLine[];
  /** Services being added right now. */
  adding: string[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const NO_SERVICES: ReadonlySet<string> = new Set();

/**
 * A line to show while it's being saved. On an option that isn't the one shown it's unselected, as
 * the database keeps it, so the quote's total doesn't count it.
 */
const pendingLine = (id: string, row: NewLine, shownOptionId: string | null): EstimateLine => ({
  id,
  option_id: row.option_id,
  service_id: row.service_id,
  name: row.name,
  description: row.description,
  quantity: row.quantity,
  unit: row.unit,
  unit_price: row.unit_price,
  unit_cost: row.unit_cost,
  taxable: row.taxable,
  optional: false,
  selected: row.option_id === null || row.option_id === shownOptionId,
  option_group: null,
  formula: row.formula,
  sort: row.sort,
  materials: null,
  material_cost: null,
});

/**
 * The edits behind the estimate's − and + buttons, quick adds and Put back. Each shows on screen at
 * once and saves in the order it was made (a mutation scope), so tapping + three times quickly
 * saves 4, 5 and 6, not 4 three times. A line worked out from the roof is measured on the server
 * after it's added or its layers change (apply-measurement for that line only, so the rest keep what
 * was set by hand). The estimate loads again once everything has saved.
 * On an estimate with options, `optionId` is the option being looked at: a service already on it or
 * on every option gets more, and a new line goes where the add control says (rows.ts
 * lineDestination, with `own`, that option's package's own services).
 * Pass the quote from useEstimateQuote: its cached copy is where edits show before they save.
 */
export function useEstimateEditor({ quote, measurementId, optionId = null, own = NO_SERVICES }: { quote: EstimateQuote; measurementId: string | null; optionId?: string | null; own?: ReadonlySet<string> }): EstimateEditor {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const quoteId = quote.id;
  const key = estimateKey(quoteId);
  const mutationKey = editKey(quoteId);
  const [added, setAdded] = useState<string[]>([]);
  const [changed, setChanged] = useState<string[]>([]);
  const [removed, setRemoved] = useState<RemovedLine[]>([]);
  const [adding, setAdding] = useState<string[]>([]);
  // Measured lines being added: they show only once measured, so another tap waits for the first.
  const measuring = useRef(new Set<string>());
  const nextSort = useRef(0);
  const busy = useIsMutating({ mutationKey }) > 0;
  // Edits not saved yet, for a quote that isn't from useEstimateQuote (nothing to show them in): the
  // next tap still counts from them. Forgotten when the quote comes back from the database.
  const unsaved = useRef<EstimateLine[] | null>(null);
  useEffect(() => {
    unsaved.current = null;
  }, [quote.lines]);

  // The lines as they are on screen right now, including edits still saving.
  const linesNow = () => queryClient.getQueryData<EstimateData>(key)?.quote.lines ?? unsaved.current ?? quote.lines;
  const lineNow = (id: string) => linesNow().find((l) => l.id === id) ?? null;
  const show = (change: (lines: EstimateLine[]) => EstimateLine[]) => {
    if (!queryClient.getQueryData<EstimateData>(key)) {
      unsaved.current = change(unsaved.current ?? quote.lines);
      return;
    }
    void queryClient.cancelQueries({ queryKey: key, exact: true });
    queryClient.setQueryData<EstimateData>(key, (old) => (old ? { ...old, quote: withLines(old.quote, change(old.quote.lines)) } : old));
  };
  const sortForNew = () => {
    const last = linesNow().reduce((m, l) => Math.max(m, l.sort), 0);
    nextSort.current = Math.max(nextSort.current, last + 1);
    return nextSort.current++;
  };
  // Only the line that changed: the others keep quantities set by hand in the office.
  const measure = async (lineId: string) => {
    if (!measurementId) throw new ApiError("Measure the roof first. This line is worked out from it.", 409);
    const result = await api.post<{ lines: MeasuredLine[] }>(`/quotes/${quoteId}/apply-measurement`, { measurement_id: measurementId, line_ids: [lineId] });
    return result.lines.find((l) => l.id === lineId) ?? null;
  };

  const edit = useMutation({
    mutationKey,
    scope: { id: `estimate-${quoteId}` },
    mutationFn: async (e: Edit): Promise<{ id: string; measured: MeasuredLine | null } | null> => {
      const db = supabase();
      if (e.op === "quantity") {
        unwrap(await db.from("quote_line_items").update({ quantity: e.quantity }).eq("id", e.lineId));
        return null;
      }
      if (e.op === "line") {
        unwrap(await db.from("quote_line_items").update(e.patch).eq("id", e.lineId));
        return null;
      }
      if (e.op === "delete") {
        unwrap(await db.from("quote_line_items").delete().eq("id", e.lineId));
        return null;
      }
      if (e.op === "layers") {
        unwrap(await db.from("quote_line_items").update({ formula: e.formula, name: e.name }).eq("id", e.lineId));
        await measure(e.lineId);
        return null;
      }
      const inserted = unwrap(await db.from("quote_line_items").insert(e.row).select("id").single()) as { id: string };
      let measured: MeasuredLine | null = null;
      if (e.row.formula && (measurementId || !e.putBack)) {
        // A new measured line has to measure something on this roof; one that comes to nothing goes again.
        let problem: unknown = null;
        try {
          measured = await measure(inserted.id);
          if (!e.putBack && (!measured || measured.error || !((measured.value ?? 0) > 0))) problem = new ApiError(nothingToMeasure(e.row.name, e.row.formula), 409);
        } catch (error) {
          problem = error;
        }
        if (problem) {
          await db.from("quote_line_items").delete().eq("id", inserted.id);
          throw problem;
        }
      }
      return { id: inserted.id, measured };
    },
    onSuccess: (saved, e) => {
      if (e.op === "insert" && saved) {
        // On screen as saved, with its amount from the roof, before its button turns back on: the
        // estimate may not load again until later edits have saved.
        show((lines) => withSavedLine(lines, measuredInto(pendingLine(saved.id, e.row, quote.option_id), saved.measured), e.pendingId));
        if (!e.putBack || added.includes(e.putBack.id)) setAdded((a) => [...a, saved.id]);
      } else if (e.op === "quantity" || e.op === "layers" || e.op === "line") {
        setChanged((c) => (c.includes(e.lineId) ? c : [...c, e.lineId]));
      }
    },
    onError: (_error, e) => {
      // The line is back once the estimate loads again; so is whatever was being put back.
      if (e.op === "delete") setRemoved((r) => r.filter((x) => x.id !== e.lineId));
      if (e.op === "insert" && e.putBack) setRemoved((r) => (r.some((x) => x.id === e.putBack!.id) ? r : [...r, e.putBack!]));
    },
    onSettled: (_data, _error, e) => {
      if (e.op === "insert" && e.serviceId) {
        measuring.current.delete(e.serviceId);
        setAdding((a) => a.filter((id, i) => id !== e.serviceId || a.indexOf(id) !== i));
      }
      // Load the estimate again once the last change in line has saved (this one still counts).
      if (queryClient.isMutating({ mutationKey }) <= 1) refreshEstimate(queryClient, quoteId, company.id);
    },
  });
  const run = (e: Edit) => edit.mutate(e);

  const setQuantity = (line: EstimateLine, quantity: number) => {
    if (isPendingLine(line)) return;
    show((lines) => lines.map((l) => (l.id === line.id ? { ...l, quantity } : l)));
    run({ op: "quantity", lineId: line.id, quantity });
  };
  const setLine = (line: EstimateLine, patch: LinePatch) => {
    const now = lineNow(line.id);
    if (!now || isPendingLine(now)) return;
    show((lines) => lines.map((l) => (l.id === now.id ? { ...l, ...patch } : l)));
    run({ op: "line", lineId: now.id, patch });
  };
  const remove = (line: EstimateLine) => {
    // Already gone (a second tap), or still being saved.
    const now = lineNow(line.id);
    if (!now || isPendingLine(now)) return;
    show((lines) => lines.filter((l) => l.id !== now.id));
    setRemoved((r) => [...r.filter((x) => x.id !== now.id), removedLine(now)]);
    run({ op: "delete", lineId: now.id });
  };
  const setLayers = (line: EstimateLine, layers: number) => {
    const now = lineNow(line.id) ?? line;
    if (!now.formula || isPendingLine(now)) return;
    if (layers < 1) return remove(now);
    if (!measurementId) return void toast.error("Measure the roof first. The tear-off is worked out from it.");
    const n = Math.min(layers, MAX_LAYERS);
    const was = layersOf(now.formula);
    if (n === was) return;
    const formula = layersFormula(baseFormula(now.formula), n);
    const name = layersName(baseName(now.name), n);
    // Each layer is the same squares, so the new amount shows before the server measures it.
    show((lines) => lines.map((l) => (l.id === now.id ? { ...l, formula, name, quantity: round3((Number(l.quantity) / was) * n) } : l)));
    run({ op: "layers", lineId: now.id, formula, name });
  };
  const step = (line: EstimateLine, s: Step) => {
    if (!s) return;
    if (s.op === "quantity") setQuantity(line, s.quantity);
    else if (s.op === "layers") setLayers(line, s.layers);
    else remove(line);
  };

  const addService = (service: EstimateService, quantity?: number | null, to?: string | null) => {
    const existing = linesNow().find((l) => counts(l, optionId) && l.service_id === service.id);
    if (existing && isPendingLine(existing)) return;
    if (existing) {
      if (lineKind(existing) === "count") return setQuantity(existing, round3(Number(existing.quantity) + (quantity && quantity > 0 ? quantity : 1)));
      return void toast.info(`${service.name} is already on the estimate.`);
    }
    if (service.formula && !measurementId) return void toast.error(`Measure the roof first. ${service.name} is worked out from it.`);
    if (service.formula && measuring.current.has(service.id)) return;
    const byPrice = service.formula_target === "unit_price";
    const row: NewLine = {
      company_id: company.id,
      quote_id: quoteId,
      option_id: to !== undefined ? (optionId ? to : null) : lineDestination(service, optionId, { own: ownServices(own, optionId, [...(quote.range_lines ?? []), ...removed]), lines: linesNow() }),
      service_id: service.id,
      name: service.name,
      description: null,
      unit: service.unit,
      unit_price: service.formula && byPrice ? 0 : Number(service.unit_price),
      unit_cost: service.unit_cost,
      taxable: service.taxable,
      formula: service.formula,
      // Measured lines get their amount from the roof once they're on.
      quantity: service.formula ? (byPrice ? 1 : 0) : quantity && quantity > 0 ? quantity : 1,
      sort: sortForNew(),
    };
    // Adding it again replaces the crossed-out one.
    setRemoved((r) => r.filter((x) => x.service_id !== service.id));
    setAdding((a) => [...a, service.id]);
    // A count shows at once; a measured line once the roof has measured it.
    const pendingId = service.formula ? null : `pending:${service.id}`;
    if (pendingId) {
      show((lines) => [...lines, pendingLine(pendingId, row, quote.option_id)]);
      setAdded((a) => [...a, pendingId]);
    } else {
      measuring.current.add(service.id);
    }
    run({ op: "insert", row, serviceId: service.id, pendingId });
  };

  const putBack = (snapshot: SnapshotLine) => {
    const id = `pending:${snapshot.id}`;
    if (linesNow().some((l) => l.id === id)) return;
    const own = removed.find((r) => r.id === snapshot.id);
    const back: RemovedLine = own ?? { ...snapshot, sort: null };
    const row: NewLine = {
      company_id: company.id,
      quote_id: quoteId,
      // Back where it was: on every option, or on its own.
      option_id: snapshot.option_id ?? null,
      service_id: snapshot.service_id,
      name: snapshot.name,
      description: own?.description ?? null,
      unit: snapshot.unit,
      unit_price: snapshot.unit_price,
      unit_cost: snapshot.unit_cost,
      taxable: snapshot.taxable,
      formula: snapshot.formula,
      quantity: snapshot.quantity,
      sort: own?.sort ?? sortForNew(),
    };
    // It's back on screen at once, as it was.
    setRemoved((r) => r.filter((x) => x.id !== snapshot.id));
    show((lines) => [...lines, pendingLine(id, row, quote.option_id)].sort((a, b) => a.sort - b.sort));
    run({ op: "insert", serviceId: null, putBack: back, row, pendingId: id });
  };

  return {
    inc: (line) => {
      const now = lineNow(line.id);
      if (now) step(now, moreOf(now));
    },
    dec: (line) => {
      const now = lineNow(line.id);
      if (now) step(now, lessOf(now));
    },
    remove,
    setLine,
    putBack,
    addService,
    setLayers,
    busy,
    added,
    changed,
    removed,
    adding,
  };
}

// ---------------------------------------------------------------------------------------------
// Notes and photos
// ---------------------------------------------------------------------------------------------

export interface NoteAuthor {
  user_id: string;
  name: string;
  color: string | null;
  photo: string | null;
}

export interface QuoteNote {
  id: string;
  body: string;
  created_at: string;
  author_id: string | null;
}

export interface QuotePhoto {
  id: string;
  path: string;
  /** A signed link for an hour, or null when it couldn't be made. */
  url: string | null;
  file_name: string | null;
  caption: string | null;
  created_at: string;
  author_id: string | null;
}

export interface QuoteNotes {
  /** The quote's client, so notes show on their timeline too. */
  clientId: string | null;
  notes: QuoteNote[];
  photos: QuotePhoto[];
  authors: Record<string, NoteAuthor>;
  /** Notes with the photos taken around them, newest first. */
  thread: Array<ThreadItem<QuoteNote, QuotePhoto>>;
}

export const notesKey = (quoteId: string) => ["quote-notes", quoteId];

/**
 * The team's notes on a quote (internal messages tied to it) and the photos taken for it (attachments
 * owned by the quote), with who wrote or took each. Only the team sees them; the client never does.
 */
export function useQuoteNotes(quoteId: string | null | undefined) {
  return useQuery({
    queryKey: ["quote-notes", quoteId],
    enabled: Boolean(quoteId),
    // Photo links last an hour; don't sign them again on every look.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<QuoteNotes> => {
      const db = supabase();
      const [messages, attachments, quote] = await Promise.all([
        db.from("messages").select("id, body, created_at, sent_by").eq("related_type", "quote").eq("related_id", quoteId!).eq("channel", "note").eq("direction", "internal").order("created_at").limit(200),
        db.from("attachments").select("id, path, file_name, caption, created_at, created_by").eq("owner_type", "quote").eq("owner_id", quoteId!).order("created_at").limit(200),
        db.from("quotes").select("client_id").eq("id", quoteId!).maybeSingle(),
      ]);
      const notes: QuoteNote[] = unwrap(messages).map((m) => ({ id: m.id, body: m.body, created_at: m.created_at, author_id: m.sent_by }));
      const files = unwrap(attachments);
      const ids = [...new Set([...notes.map((n) => n.author_id), ...files.map((f) => f.created_by)].filter((id): id is string => Boolean(id)))];
      const [people, urls] = await Promise.all([
        ids.length ? supabase().from("profiles").select("user_id, full_name, color, avatar_url").in("user_id", ids).then(unwrap) : Promise.resolve([]),
        signedUrls(files.map((f) => f.path)).catch(() => ({}) as Record<string, string>),
      ]);
      const photos: QuotePhoto[] = files.map((f) => ({ id: f.id, path: f.path, url: urls[f.path] ?? null, file_name: f.file_name, caption: f.caption, created_at: f.created_at, author_id: f.created_by }));
      const authors: Record<string, NoteAuthor> = {};
      for (const p of people) authors[p.user_id] = { user_id: p.user_id, name: p.full_name?.trim() || "Someone on your team", color: p.color ?? null, photo: p.avatar_url ?? null };
      return { clientId: unwrap(quote)?.client_id ?? null, notes, photos, authors, thread: threadItems(notes, photos) };
    },
  });
}

/** The notes with one changed, and the thread built again from them. */
const withNotes = (data: QuoteNotes, notes: QuoteNote[], photos: QuotePhoto[] = data.photos): QuoteNotes => ({ ...data, notes, photos, thread: threadItems(notes, photos) });
const byCreated = (a: { created_at: string }, b: { created_at: string }) => Date.parse(a.created_at) - Date.parse(b.created_at);

/**
 * Adding and removing a quote's notes and photos. Photos upload one at a time; `uploading` counts
 * what's left. A note or photo deleted goes at once with Undo on its toast (deleteNote, deletePhoto),
 * and is only deleted for real once the toast leaves.
 */
export function useNoteActions(quoteId: string) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(0);
  const refresh = () => queryClient.invalidateQueries({ queryKey: notesKey(quoteId) });
  const clientId = () => queryClient.getQueryData<QuoteNotes>(notesKey(quoteId))?.clientId ?? null;

  // The note shows in the thread, and its button says Added.
  const addNote = useMutation({
    mutationFn: async (body: string) =>
      unwrap(
        await supabase()
          .from("messages")
          .insert({ company_id: company.id, client_id: clientId(), channel: "note", direction: "internal", body: body.trim(), related_type: "quote", related_id: quoteId })
          .select("id")
          .single(),
      ),
    onSuccess: refresh,
  });
  const addPhotos = useMutation({
    // One batch after another; the count covers every photo still to go.
    scope: { id: `quote-photos-${quoteId}` },
    onMutate: (files: File[]) => setUploading((n) => n + files.length),
    mutationFn: async (files: File[]) => {
      let saved = 0;
      for (const file of files) {
        try {
          const path = await uploadFile(company.id, `quote/${quoteId}`, file);
          const { error } = await supabase()
            .from("attachments")
            .insert({ company_id: company.id, owner_type: "quote", owner_id: quoteId, path, file_name: file.name.slice(0, 200) || "photo.jpg", content_type: storedType(path, file), size_bytes: file.size });
          if (error) throw new Error(error.message);
          saved++;
        } catch (error) {
          toast.error(`${file.name || "That photo"} didn't upload. ${(error as Error).message}`);
        } finally {
          setUploading((n) => Math.max(0, n - 1));
          void refresh();
        }
      }
      return saved;
    },
    onSuccess: (saved) => saved && toast.success(saved === 1 ? "Photo added" : `${saved} photos added`),
  });
  // undoable says when these fail, and puts the note or photo back.
  const removeNote = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("messages").delete().eq("id", id)),
    onSettled: refresh,
  });
  // The photo goes to the Trash with its row (the database moves it), so Undo can put it back.
  const removePhoto = useMutation({
    meta: { inline: true },
    mutationFn: async (photo: Pick<QuotePhoto, "id" | "path">) => {
      const gone = unwrap(await supabase().from("attachments").delete().eq("id", photo.id).select("id"));
      if (!gone.length) throw new Error("You can only remove photos you took. Ask the office to remove this one.");
    },
    onSettled: refresh,
  });
  const key = notesKey(quoteId);
  // Put back into the thread as it is now, so a note added meanwhile stays.
  const change = (fn: (data: QuoteNotes) => QuoteNotes) => queryClient.setQueryData<QuoteNotes>(key, (data) => (data ? fn(data) : data));
  const deleteNote = (note: QuoteNote) =>
    undoable({
      title: "Note deleted",
      tone: "quote",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        change((d) => withNotes(d, d.notes.filter((n) => n.id !== note.id)));
      },
      restore: () => change((d) => (d.notes.some((n) => n.id === note.id) ? d : withNotes(d, [...d.notes, note].sort(byCreated)))),
      commit: () => removeNote.mutateAsync(note.id),
    });
  const deletePhoto = (photo: QuotePhoto) =>
    undoable({
      title: "Photo removed",
      description: IN_TRASH,
      tone: "quote",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        change((d) => withNotes(d, d.notes, d.photos.filter((p) => p.id !== photo.id)));
      },
      restore: () => change((d) => (d.photos.some((p) => p.id === photo.id) ? d : withNotes(d, d.notes, [...d.photos, photo].sort(byCreated)))),
      commit: () => removePhoto.mutateAsync(photo),
    });
  return { addNote, addPhotos, deleteNote, deletePhoto, uploading };
}
