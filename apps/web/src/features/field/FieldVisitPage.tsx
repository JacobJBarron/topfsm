/**
 * One visit on a phone: where, how to get in, what to do, checklist, photos, receipts and notes. A
 * sub gets the client's name (and phone, if the office allows it) from visit_contact(), their own
 * price for the job once it's agreed, and no clock, receipts or materials: those are the team's.
 *
 * The visit's next step (On my way, Start visit, Complete visit) is the one thing to tap: on a phone
 * it sits in a bar above the tab bar, in thumb reach. The checklist and the notes save as the crew
 * goes, and Complete visit says how many required checklist items are left.
 */
import { onlineManager, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent, type RefObject } from "react";
import { useParams } from "react-router-dom";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { MapsLink } from "@/components/ui/MapsLink";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { SaveStatus, useSaveStatus, type SaveState } from "@/components/ui/SaveStatus";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { PageError } from "@/components/ui/States";
import { EntityStatus, StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { errorMessage, isAuthError } from "@/lib/errors";
import { signedUrls, storedType, uploadFile } from "@/lib/files";
import { addressLine, formatDateTime, timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { FIELD_SCOPE } from "@/lib/offline";
import { hasRole, isSub, keepsTime, useSession } from "@/lib/session";
import { startTask } from "@/lib/tasks";
import { toast } from "@/lib/toast";
import { IN_TRASH } from "../drive/trash";
import { ShareToggle, shareToggleState } from "../marketing/ShareToggle";
import { undoable } from "@/lib/undo";
import { ExpenseDialog } from "../jobs/ExpensesCard";
import { MaterialsCard } from "../jobs/JobMaterials";
import { ScopeOfWork } from "../jobs/ScopeOfWork";
import { FieldPlans } from "../plans/FieldPlans";
import { contactLinks, visitContact, type VisitContact } from "./contact";
import { pendingVisitSave, pendingVisitStatus, showVisitStatus, statusSaved, type ChecklistSave, type VisitNotesSave, type VisitStatusChange } from "./fieldActions";
import { formatDuration, useStatusTap } from "./fieldData";
import { OfflineNote, useSignal } from "./OfflineNote";
import { SignaturePad } from "./SignaturePad";
import { YourPrice } from "./YourPrice";

interface ChecklistItem { key: string; label: string; type: "check" | "number" | "text" | "choice" | "photo" | "signature"; required: boolean; options?: string[] }

/** What's still required on the visit's checklist, for Complete visit. Null when nothing holds it up. */
interface ChecklistProgress { required: number; missing: Array<{ key: string; label: string }> }

interface ChecklistHandle {
  /** With the visit's completion: saves the checklist as done, or (completed anyway) as it is. */
  finish: (done: boolean) => void;
  /** Brings the first required item still missing to the middle of the screen, lit up for a moment. */
  showMissing: () => void;
}

const stillMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function FieldVisitPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const queryClient = useQueryClient();
  const [expense, setExpense] = useState(false);
  const sub = isSub(session);
  const clocks = keepsTime(session);
  const checklist = useRef<ChecklistHandle>(null);
  // Undefined while the checklist loads.
  const [progress, setProgress] = useState<ChecklistProgress | null | undefined>(undefined);
  // The required item an early Complete visit last pointed at: tapped again, it offers to go without.
  const pointedAt = useRef<string | null>(null);

  const visit = useQuery({
    queryKey: ["field-visit", id],
    queryFn: async () => {
      const row = unwrapOne(
        await supabase()
          .from("visits")
          .select("id, title, kind, status, starts_at, ends_at, scheduled_on, notes, hold_reason, completed_at, series_day, series_total, equipment:visit_equipment(equipment:equipment(id, name, kind)), job:jobs(id, number, title, instructions, property_id, client:clients(display_name, phone, social_photos_opt_out)), request:requests(id, title, details, client:clients(display_name, phone, social_photos_opt_out)), property:properties(id, line1, city, region, postal_code, lat, lng, notes)")
          .eq("id", id)
          .maybeSingle(),
        "This visit",
      );
      const notes = pendingVisitSave<VisitNotesSave>(queryClient, "visit-notes", id);
      return { ...row, status: pendingVisitStatus(queryClient, id) ?? row.status, notes: notes ? notes.notes : row.notes };
    },
  });
  const v = visit.data;
  useDocumentTitle(v?.title ?? "Visit");
  const access = useQuery({
    queryKey: ["field-visit", id, "access"],
    enabled: Boolean(v?.property),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("property_access").select("gate_code, lockbox_code, alarm_code, instructions").eq("property_id", v!.property!.id))[0] ?? null,
  });
  // A sub can't read clients: the name, and the phone if they may call, come from visit_contact().
  // Kept on the phone with the visit, for no signal.
  const contact = useQuery({
    queryKey: ["field-visit", id, "contact"],
    enabled: sub,
    meta: { silent: true },
    queryFn: async () => (unwrap(await supabase().rpc("visit_contact", { p_visit: id })) as VisitContact[])[0] ?? null,
  });
  const myTime = useQuery({
    queryKey: ["field-visit", id, "time"],
    enabled: clocks,
    queryFn: async () => unwrap(await supabase().from("time_entries").select("started_at, ended_at").eq("visit_id", id).eq("user_id", session.userId)),
  });
  const refresh = () => {
    for (const k of [["field-visit", id], ["field"], ["schedule"], ["running-timer"], ["dashboard"], ["checklist", id]]) queryClient.invalidateQueries({ queryKey: k });
  };
  // These work offline: saved on the phone and sent, in order, when there's signal. Each is sent by
  // the action registered for it (fieldActions.ts), not a mutationFn here: lib/offline.ts notes when
  // it's on its way, for the count of updates waiting.
  const statusMutation = useMutation({
    mutationKey: ["visit-status"],
    scope: FIELD_SCOPE,
    meta: { success: statusSaved },
    onMutate: (change: VisitStatusChange) => {
      if (!onlineManager.isOnline()) toast.info("Saved on this phone", { description: "It sends when you have signal." });
      showVisitStatus(queryClient, change);
    },
    onSettled: refresh,
  });
  const statusTap = useStatusTap((change) => statusMutation.mutate(change));
  const setStatus = (status: string) => statusTap.tap({ id, jobId: v?.job?.id ?? null }, status);
  // Which step is on its way: finding the phone's place comes first for one that clocks.
  const going = statusTap.locating === id ? "locating" : statusMutation.isPending && !statusMutation.isPaused ? (statusMutation.variables?.status ?? null) : null;

  // Notes save a moment after the crew stops typing, and when they leave the box.
  const showing = useShowing();
  const saveNotes = useMutation({
    mutationKey: ["visit-notes"],
    scope: FIELD_SCOPE,
    meta: { inline: true },
    onMutate: (change: VisitNotesSave) => {
      queryClient.setQueryData<typeof visit.data>(["field-visit", id], (old) => old && { ...old, notes: change.notes });
    },
    onError: toastIfGone(showing),
    // Not waited on: the next field action in line goes without waiting for this reload.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["field-visit", id], exact: true }),
  });
  const notesSave = useAutoSave((text: string) => saveNotes.mutateAsync({ companyId: session.company.id, visitId: id, notes: text.trim() || null }), 1000);
  const notesSending = useIsMutating({ mutationKey: ["visit-notes"], predicate: (m) => (m.state.variables as VisitNotesSave | undefined)?.visitId === id });
  const [notes, setNotes] = useState("");
  const notesIn = useRef(false);
  // What's saved comes in (the first load, the office changing them) unless something typed here is
  // still on its way, or they're typing.
  useEffect(() => {
    if (!visit.data) return;
    if (notesIn.current && (notesSending > 0 || notesSave.waiting() || document.activeElement?.id === "visit-notes")) return;
    notesIn.current = true;
    setNotes(visit.data.notes ?? "");
  }, [visit.data?.notes, visit.isSuccess, notesSending]);

  if (visit.isPending) return <DetailSkeleton />;
  if (visit.error || !v) {
    return (
      <div className="field-app">
        <PageError error={visit.error} onRetry={() => visit.refetch()} back={<BackLink to="/field">My day</BackLink>} />
      </div>
    );
  }

  const client = visitContact((v.job?.client ?? v.request?.client) as { display_name: string; phone: string | null } | null, contact.data);
  const codes = access.data;
  const minutes = (myTime.data ?? []).reduce((s, t) => s + ((t.ended_at ? Date.parse(t.ended_at) : Date.now()) - Date.parse(t.started_at)), 0);
  const left = progress?.missing.length ?? 0;
  const complete = async () => {
    const first = progress?.missing[0];
    if (progress && first) {
      // The first tap shows what's still required; tapped again, it can go without.
      if (pointedAt.current !== first.key) {
        pointedAt.current = first.key;
        return checklist.current?.showMissing();
      }
      const names = progress.missing.map((m) => m.label).join(", ");
      const anyway = await confirm({ title: "The checklist isn't done", body: `Still needed: ${names}. The office will see the checklist is unfinished.`, confirmLabel: "Complete anyway", cancelLabel: "Keep working" });
      if (!anyway) return checklist.current?.showMissing();
    }
    checklist.current?.finish(!first);
    setStatus("completed");
  };
  const commit =
    v.status === "scheduled" ? (
      <>
        <Button icon="navigation" className="big-action" loading={going === "en_route"} onClick={() => setStatus("en_route")}>On my way</Button>
        <Button variant="primary" icon="play" className="big-action" loading={going === "in_progress" || going === "locating"} onClick={() => setStatus("in_progress")}>Start visit</Button>
      </>
    ) : v.status === "en_route" ? (
      <Button variant="primary" icon="play" className="big-action" loading={going !== null} onClick={() => setStatus("in_progress")}>Start visit</Button>
    ) : v.status === "in_progress" ? (
      // Green once nothing required is missing; until then it says how much is left.
      <Button variant={left ? "secondary" : "primary"} icon={left ? undefined : "check"} className="big-action" loading={going !== null} onClick={() => void complete()}>
        {progress && left > 0 && going === null && <ProgressRing value={(progress.required - left) / progress.required} />}
        Complete visit
        {left > 0 && (
          <>
            <span className="sr-only">, </span>
            <span className="field-commit-left"><AnimatedNumber value={left} /> required left</span>
          </>
        )}
      </Button>
    ) : null;

  return (
    <div className="field-app">
      <BackLink to="/field">My day</BackLink>
      <div className="stack-sm">
        <h1 className="page-title">{v.title}</h1>
        <div className="row wrap">
          <EntityStatus kind="visit" status={v.status} />
          <span className="muted">{v.starts_at ? formatDateTime(v.starts_at) : v.scheduled_on ? "Anytime today" : "Not scheduled"}</span>
          {v.series_total && v.series_total > 1 && <span className="chip chip-blue">Day {v.series_day} of {v.series_total}</span>}
          {clocks && minutes > 0 && <span className="chip"><Icon name="clock" size={12} />You: {formatDuration(minutes)}</span>}
        </div>
      </div>
      <OfflineNote />
      {v.status === "completed" && v.completed_at && <div className="callout callout-good"><Icon name="check" size={20} /><div className="grow">Completed {timeAgo(v.completed_at)}.</div></div>}

      <div className="field-actions">
        {commit && <div className="field-commit">{commit}</div>}
        {contactLinks(client).map((link) => (
          <a key={link.label} className="btn big-action" href={link.href}><Icon name={link.label === "Call" ? "phone" : "messages"} size={20} />{link.label}</a>
        ))}
        {v.property && <MapsLink className="btn big-action" place={v.property}><Icon name="navigation" size={20} />Directions</MapsLink>}
      </div>

      <section className="card card-pad stack-sm">
        <strong style={{ fontSize: 16 }}>{client.name ?? "Site"}</strong>
        {v.property && <MapsLink className="address-link" place={v.property}>{addressLine(v.property)}</MapsLink>}
        {access.isPending && v.property ? <Skeleton width="40%" /> : (
          <>
            {codes?.gate_code && <span style={{ fontSize: 16 }}><Icon name="lock" size={16} /> Gate code <strong style={{ fontSize: 20 }}>{codes.gate_code}</strong></span>}
            {codes?.lockbox_code && <span><Icon name="lock" size={14} /> Lockbox <strong>{codes.lockbox_code}</strong></span>}
            {codes?.alarm_code && <span><Icon name="lock" size={14} /> Alarm <strong>{codes.alarm_code}</strong></span>}
            {codes?.instructions && <span className="muted pre-wrap">{codes.instructions}</span>}
          </>
        )}
        {v.property?.notes && <span className="muted pre-wrap">{v.property.notes}</span>}
        {v.hold_reason && <span style={{ color: "var(--warning)", fontWeight: 600 }}><Icon name="cloud" size={14} /> Weather: {v.hold_reason}</span>}
      </section>

      {(v.job?.instructions || v.request?.details) && (
        <section className="card card-pad stack-sm" style={{ background: "var(--note)", borderColor: "var(--note-border)" }}>
          <strong>Instructions</strong>
          {v.job?.instructions && <p className="pre-wrap" style={{ margin: 0 }}>{v.job.instructions}</p>}
          {v.request?.details && <p className="pre-wrap" style={{ margin: 0 }}>{v.request.details}</p>}
        </section>
      )}
      {v.job && <section className="card card-pad"><ScopeOfWork jobId={v.job.id} title="The work" bare /></section>}
      {sub && <YourPrice visitId={v.id} />}
      <FieldPlans visitId={v.id} jobId={v.job?.id ?? null} propertyId={v.property?.id ?? v.job?.property_id ?? null} />
      {v.equipment.length > 0 && (
        <section className="card card-pad stack-sm">
          <strong>Bring</strong>
          <div className="row wrap" style={{ gap: 6 }}>
            {v.equipment.map((e) => e.equipment && <span key={e.equipment.id} className="chip"><Icon name="truck" size={12} />{e.equipment.name}</span>)}
          </div>
        </section>
      )}

      <VisitWork visitId={v.id} visitStatus={v.status} checklist={checklist} onProgress={setProgress} jobId={v.job && !sub ? v.job.id : null}
        clientOptOut={Boolean(v.job?.client?.social_photos_opt_out ?? v.request?.client?.social_photos_opt_out)} />

      <section className="card card-pad stack-sm">
        <div className="row-between">
          <label htmlFor="visit-notes"><strong>Notes for the office</strong></label>
          <AutoSaveStatus status={notesSave.status} waiting={notesSending > 0} />
        </div>
        <textarea
          id="visit-notes"
          className="textarea"
          value={notes}
          maxLength={5000}
          onChange={(e) => {
            setNotes(e.target.value);
            notesSave.change(e.target.value);
          }}
          onBlur={notesSave.flush}
          placeholder="Extra work they asked about, damage you noticed, materials used…"
        />
        <FormError error={saveNotes.error} />
        {v.job && !sub && <Button variant="ghost" icon="receipt" style={{ justifySelf: "start" }} onClick={() => setExpense(true)}>Add a receipt</Button>}
      </section>

      {expense && v.job && !sub && <ExpenseDialog jobId={v.job.id} expense={null} onClose={() => setExpense(false)} onSaved={() => toast.success("Receipt sent to the office", { tone: "job" })} />}
      {/* Room at the bottom for the phone's bar, so nothing ends up behind it. */}
      {commit && <div className="field-commit-room" aria-hidden="true" />}
    </div>
  );
}

/** The checklist, materials and photos, sharing the visit's photos (a checklist item can ask for them). */
function VisitWork({ visitId, visitStatus, checklist, onProgress, jobId, clientOptOut }: { visitId: string; visitStatus: string; checklist: RefObject<ChecklistHandle>; onProgress: (p: ChecklistProgress | null | undefined) => void; jobId: string | null; clientOptOut: boolean }) {
  const photos = useVisitPhotos(visitId);
  return (
    <>
      <Checklist ref={checklist} visitId={visitId} visitStatus={visitStatus} photos={photos} onProgress={onProgress} />
      {jobId && <MaterialsCard jobId={jobId} visitId={visitId} compact />}
      <Photos photos={photos} clientOptOut={clientOptOut} />
    </>
  );
}

/**
 * Saving as the crew goes, for the parts of a visit with no Save button (the checklist, the notes):
 * `change` a moment after the last edit, `flush` at once (leaving a box), and before the screen goes
 * or the phone puts the app away. Each save is a field action, so with no signal it's kept on the
 * phone and goes out in order later; `status` is for SaveStatus.
 */
function useAutoSave<V>(send: (variables: V) => Promise<unknown>, delay: number) {
  const { status, edited, track } = useSaveStatus();
  const sendNow = useRef(send);
  sendNow.current = send;
  const next = useRef<{ variables: V } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const waiting = next.current;
    if (!waiting) return;
    next.current = null;
    void track(sendNow.current(waiting.variables));
  }, [track]);
  const change = useCallback(
    (variables: V) => {
      next.current = { variables };
      edited();
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, delay);
    },
    [edited, flush, delay],
  );
  useEffect(() => {
    // On the window as it's on its way down, so the save is made before lib/offline.ts (on the
    // document) writes what's waiting to the phone's storage.
    const hidden = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("visibilitychange", hidden, true);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("visibilitychange", hidden, true);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
  return { status, change, flush, waiting: () => next.current !== null };
}

/** False once the screen has gone, for saves that come back after it. */
function useShowing() {
  const showing = useRef(false);
  useEffect(() => {
    showing.current = true;
    return () => {
      showing.current = false;
    };
  }, []);
  return showing;
}

/**
 * For a save whose error the screen shows (meta.inline): turned down once the screen has gone (sent
 * as the crew left it, or when the signal came back), a toast says so instead. A lost sign-in is
 * said by lib/queryClient.ts.
 */
const toastIfGone = (showing: RefObject<boolean>) => (error: Error) => {
  if (!showing.current && !isAuthError(error)) toast.error(errorMessage(error));
};

/**
 * How a part that saves as the crew goes stands: SaveStatus, or kept on the phone until there's
 * signal. `waiting` is a save of it not sent yet, from this screen or from before the app was
 * closed (lib/offline.ts keeps them), which with signal is only a moment behind.
 */
function AutoSaveStatus({ status, waiting }: { status: SaveState; waiting: boolean }) {
  const online = useSignal();
  if (waiting && !online) {
    return (
      <span className="save-status" data-state="queued" role="status">
        <Icon name="wifiOff" size={14} />
        Saved on this phone
      </span>
    );
  }
  return <SaveStatus status={status} />;
}

/** How much of the checklist's required part is in, as a ring on Complete visit. */
function ProgressRing({ value }: { value: number }) {
  const length = 2 * Math.PI * 8;
  return (
    <svg className="progress-ring" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="progress-ring-track" cx="10" cy="10" r="8" />
      {value > 0 && <circle className="progress-ring-done" cx="10" cy="10" r="8" strokeDasharray={length} strokeDashoffset={length * (1 - value)} />}
    </svg>
  );
}

/** The mark on a required item, said as "required" to a screen reader. */
function Required() {
  return (
    <>
      <span className="text-danger" aria-hidden="true"> *</span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

const Checklist = forwardRef<ChecklistHandle, { visitId: string; visitStatus: string; photos: VisitPhotos; onProgress: (p: ChecklistProgress | null | undefined) => void }>(function Checklist({ visitId, visitStatus, photos, onProgress }, ref) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const root = useRef<HTMLElement>(null);
  const flashing = useRef<number | undefined>(undefined);
  const showing = useShowing();
  const data = useQuery({
    queryKey: ["checklist", visitId],
    queryFn: async () => {
      const [templates, responses] = await Promise.all([
        supabase().from("checklist_templates").select("id, name, items").eq("company_id", company.id).eq("active", true).order("name"),
        supabase().from("checklist_responses").select("id, template_id, answers, completed_at, completed_by").eq("visit_id", visitId).limit(1),
      ]);
      // A save still waiting on this phone is newer than what the server has (its answers too, unless it only marks the checklist done).
      const queued = pendingVisitSave<ChecklistSave>(queryClient, "checklist-save", visitId);
      const saved = unwrap(responses)[0] ?? null;
      const response = queued ? { id: queued.responseId, template_id: queued.templateId, answers: (queued.answers ?? saved?.answers ?? {}) as never, completed_at: queued.completedAt, completed_by: null } : saved;
      return { templates: unwrap(templates), response };
    },
  });
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [templateId, setTemplateId] = useState("");
  const answersNow = useRef(answers);
  answersNow.current = answers;
  // Made here so saving twice with no signal updates one checklist instead of adding two.
  const [newId] = useState(() => crypto.randomUUID());

  // Sent by the action registered for it, like the visit's own (no mutationFn here).
  const saveMutation = useMutation({
    mutationKey: ["checklist-save"],
    scope: FIELD_SCOPE,
    meta: { inline: true },
    onMutate: (v: ChecklistSave) => {
      queryClient.setQueryData<typeof data.data>(["checklist", visitId], (old) =>
        old && { ...old, response: { id: v.responseId, template_id: v.templateId, answers: (v.answers ?? old.response?.answers ?? {}) as never, completed_at: v.completedAt, completed_by: null } },
      );
    },
    onError: toastIfGone(showing),
    // Not waited on: the next field action in line goes without waiting for this reload.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["checklist", visitId] }),
  });
  const autosave = useAutoSave((v: ChecklistSave) => saveMutation.mutateAsync(v), 500);
  const sending = useIsMutating({ mutationKey: ["checklist-save"], predicate: (m) => (m.state.variables as ChecklistSave | undefined)?.visitId === visitId });
  const loaded = useRef(false);
  // What's saved comes in (the first load, another phone, the checklist reopened) unless something
  // changed here is still on its way.
  useEffect(() => {
    if (!data.data) return;
    if (loaded.current && (sending > 0 || autosave.waiting())) return;
    loaded.current = true;
    if (data.data.response) {
      setAnswers((data.data.response.answers ?? {}) as Record<string, unknown>);
      setTemplateId(data.data.response.template_id ?? "");
    } else if (data.data.templates.length === 1) setTemplateId(data.data.templates[0].id);
  }, [data.data, sending]);

  const template = data.data?.templates.find((t) => t.id === templateId);
  const items = (template?.items ?? []) as unknown as ChecklistItem[];
  const answered = (i: ChecklistItem) => {
    const a = answers[i.key];
    if (i.type === "photo") return true;
    // A signature needs the drawing (older checklists stored a typed name).
    if (i.type === "signature" && a && typeof a === "object") return Boolean((a as { image?: string }).image);
    return !(a === undefined || a === null || a === "" || a === false);
  };
  const missing = items.filter((i) => i.required && !answered(i));
  const required = items.filter((i) => i.required && i.type !== "photo").length;
  const doneCount = items.filter((i) => i.type !== "photo" && answered(i)).length;
  const countable = items.filter((i) => i.type !== "photo").length;
  const done = Boolean(data.data?.response?.completed_at);

  // Complete visit says what's left, and points at it.
  const missingKeys = missing.map((m) => m.key).join("\n");
  useEffect(() => {
    if (data.isPending) return onProgress(undefined);
    onProgress(template && !done && required ? { required, missing: missing.map(({ key, label }) => ({ key, label })) } : null);
  }, [data.isPending, template?.id, done, required, missingKeys]);
  useEffect(() => () => onProgress(null), [onProgress]);

  const variables = (next: Record<string, unknown> | undefined, chosen: string, completedAt: string | null = null): ChecklistSave => ({
    companyId: company.id,
    visitId,
    responseId: data.data?.response?.id ?? newId,
    templateId: chosen || null,
    ...(next && { answers: next }),
    completedAt,
  });
  const set = (key: string, value: unknown) => {
    const next = { ...answersNow.current, [key]: value };
    answersNow.current = next;
    setAnswers(next);
    autosave.change(variables(next, templateId));
  };
  const choose = (id: string) => {
    setTemplateId(id);
    autosave.change(variables(answersNow.current, id));
  };

  // Marked done, the answers go along only while some made here are still to send. Otherwise the
  // saved ones stay: this phone's copy may be older than a crewmate's answers from another phone.
  const markDone = () => {
    autosave.change(variables(sending > 0 || autosave.waiting() ? answersNow.current : undefined, templateId, new Date().toISOString()));
    autosave.flush();
  };

  useImperativeHandle(ref, () => ({
    finish: (complete) => {
      // Done: marked done. Completed anyway: what's in goes as it is, unfinished.
      if (complete && template && !done) return markDone();
      autosave.flush();
    },
    showMissing: () => {
      const first = missing[0];
      const row = first && root.current?.querySelector<HTMLElement>(`[data-check="${CSS.escape(first.key)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: stillMotion() ? "auto" : "smooth" });
      // Lit up again even if it already was: a color change, so it shows with Reduce Motion too.
      row.removeAttribute("data-flash");
      void row.offsetWidth;
      row.setAttribute("data-flash", "");
      window.clearTimeout(flashing.current);
      flashing.current = window.setTimeout(() => row.removeAttribute("data-flash"), 1300);
      // A box takes the focus; for anything else the row does. A list or a text field would count as
      // typing (AppShell hides the phone's bars for the keyboard), with no keyboard or picker open.
      (row.querySelector<HTMLElement>('input[type="checkbox"]') ?? row).focus({ preventScroll: true });
    },
  }));

  const reopen = useMutation({
    mutationFn: async () => unwrap(await supabase().from("checklist_responses").update({ completed_at: null }).eq("id", data.data!.response!.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["checklist", visitId] }),
  });

  if (data.isPending) return <section className="card card-pad"><Skeleton width="30%" /><div style={{ height: 10 }} /><Skeleton height={80} /></section>;
  if (!data.data?.templates.length) return null;
  return (
    <section ref={root} className="card card-pad stack-sm">
      <div className="row-between">
        <strong>Checklist</strong>
        <span className="row" style={{ gap: 12 }}>
          <AutoSaveStatus status={autosave.status} waiting={sending > 0} />
          {done ? <StatusPill label="Done" tone="good" /> : template && <span className="muted small tabular"><AnimatedNumber value={doneCount} /> of {countable}</span>}
        </span>
      </div>
      {template && !done && <div className="progress"><span style={{ width: `${countable ? (doneCount / countable) * 100 : 0}%` }} /></div>}
      {(!data.data.response || !done) && data.data.templates.length > 1 && (
        <select className="select" value={templateId} onChange={(e) => choose(e.target.value)} aria-label="Choose a checklist" disabled={done}>
          <option value="">Choose a checklist…</option>
          {data.data.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <div>
        {items.map((item) => (
          <div key={item.key} className="check-row" data-check={item.key} tabIndex={-1}>
            {item.type === "check" ? (
              // The whole row is the box's label, so a tap anywhere on it ticks it.
              <label className="checkbox">
                <input type="checkbox" checked={Boolean(answers[item.key])} disabled={done} onChange={(e) => set(item.key, e.target.checked)} />
                <span>{item.label}{item.required && <Required />}</span>
              </label>
            ) : item.type === "photo" ? (
              <>
                <span className="grow check-photo"><Icon name="camera" size={16} />{item.label}</span>
                {!done && <PhotoPicker photos={photos} />}
              </>
            ) : item.type === "choice" ? (
              <label className="field" style={{ flex: 1 }}><span>{item.label}{item.required && <Required />}</span>
                <select className="select" value={String(answers[item.key] ?? "")} disabled={done} onChange={(e) => set(item.key, e.target.value)}>
                  <option value="">Choose…</option>
                  {item.options?.map((o) => <option key={o}>{o}</option>)}
                </select>
              </label>
            ) : item.type === "signature" ? (
              <SignatureAnswer label={item.label} required={item.required} value={answers[item.key]} disabled={done} onChange={(next) => set(item.key, next)} />
            ) : (
              <label className="field" style={{ flex: 1 }}><span>{item.label}{item.required && <Required />}</span>
                <input className="input" inputMode={item.type === "number" ? "decimal" : undefined} value={String(answers[item.key] ?? "")} disabled={done} onChange={(e) => set(item.key, item.type === "number" ? e.target.value.replace(/[^0-9.\-]/g, "") : e.target.value)} onBlur={autosave.flush} />
              </label>
            )}
          </div>
        ))}
      </div>
      <FormError error={saveMutation.error} />
      {/* Under way, Complete visit marks it done. Otherwise this does: completed on My day, by the office, or anyway with the rest done after. */}
      {template && !done && !missing.length && visitStatus !== "in_progress" && <Button icon="check" style={{ justifySelf: "start" }} onClick={markDone}>Mark done</Button>}
      {done && hasRole(session, "admin", "office", "crew_lead") && <Button variant="ghost" icon="undo" style={{ justifySelf: "start" }} loading={reopen.isPending} onClick={() => reopen.mutate()}>Reopen checklist</Button>}
    </section>
  );
});

interface Photo { id: string; path: string; file_name: string; caption: string | null; content_type: string | null; shareable: boolean; created_at: string; created_by: string | null; url: string | null }
type VisitPhotos = ReturnType<typeof useVisitPhotos>;

/**
 * A visit's photos, for its Photos card and the checklist items that ask for them: added from the
 * camera or the phone's photos (in the task island while they go up), and removed with Undo.
 */
function useVisitPhotos(visitId: string) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const key = ["photos", visitId];
  const [uploading, setUploading] = useState(0);
  // Removed and waiting on Undo: kept off the screen even if the list loads again meanwhile.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const list = useQuery({
    queryKey: key,
    queryFn: async () => {
      const rows = unwrap(await supabase().from("attachments").select("id, path, file_name, caption, content_type, shareable, created_at, created_by").eq("owner_type", "visit").eq("owner_id", visitId).order("created_at"));
      const urls = await signedUrls(rows.map((r) => r.path)).catch(() => ({}) as Record<string, string>);
      return rows.map((r): Photo => ({ ...r, url: urls[r.path] ?? null }));
    },
  });
  const upload = useMutation({
    // With no signal the photos wait here, on the screen as they will be, and go up once it's back
    // (not kept on the phone like the field actions: closing the app loses them).
    networkMode: "online",
    onMutate: (files: File[]) => setUploading((n) => n + files.length),
    mutationFn: async (files: File[]) => {
      let stopped = false;
      const task = startTask({ label: files.length === 1 ? "Adding a photo" : `Adding ${files.length} photos`, total: files.length, cancel: () => (stopped = true) });
      const problems: string[] = [];
      let sent = 0;
      for (const file of files) {
        if (!stopped) {
          try {
            const path = await uploadFile(company.id, `visit/${visitId}`, file);
            unwrap(await supabase().from("attachments").insert({ company_id: company.id, owner_type: "visit", owner_id: visitId, path, file_name: file.name.slice(0, 200), content_type: storedType(path, file), size_bytes: file.size }));
          } catch (error) {
            problems.push(`${file.name}: ${errorMessage(error)}`);
          }
          task.progress(++sent);
          queryClient.invalidateQueries({ queryKey: key });
        }
        setUploading((n) => n - 1);
      }
      const saved = sent - problems.length;
      if (problems.length) task.fail(problems.length === 1 ? problems[0]! : `${problems.length} photos didn't upload. ${problems[0]}`);
      else task.done(saved === 1 ? "Photo added" : `${saved} photos added`);
    },
  });
  const refreshPhotos = () => queryClient.invalidateQueries({ queryKey: ["photos", visitId] });
  // Once its Undo has passed, the photo goes to the Trash with its row (the database moves it).
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (p: { id: string; path: string }) => {
      const gone = unwrap(await supabase().from("attachments").delete().eq("id", p.id).select("id"));
      if (!gone.length) throw new Error("You can only remove photos you added. Ask the office to remove this one.");
    },
    onSettled: () => void refreshPhotos(),
  });
  const without = (id: string) => (h: ReadonlySet<string>) => new Set([...h].filter((x) => x !== id));
  return {
    photos: (list.data ?? []).filter((p) => !hidden.has(p.id)),
    /** OK to share shown at once, as the field action goes (or waits for signal). */
    showShareable: (id: string, shareable: boolean) => queryClient.setQueryData<Photo[]>(key, (rows) => rows?.map((r) => (r.id === id ? { ...r, shareable } : r))),
    loading: list.isPending,
    uploading,
    add: (files: File[]) => upload.mutate(files),
    // A sub removes only the photos they added.
    canRemove: (p: Photo) => !isSub(session) || p.created_by === session.userId,
    remove: (p: Photo) =>
      undoable({
        title: "Photo removed",
        // A sub has no Trash to take it from later: the office can.
        description: isSub(session) ? undefined : IN_TRASH,
        tone: "job",
        hide: () => {
          void queryClient.cancelQueries({ queryKey: key });
          setHidden((h) => new Set(h).add(p.id));
          queryClient.setQueryData<Photo[]>(key, (rows) => rows?.filter((r) => r.id !== p.id));
        },
        restore: () => {
          setHidden(without(p.id));
          queryClient.setQueryData<Photo[]>(key, (rows) => (rows && !rows.some((r) => r.id === p.id) ? [...rows, p].sort((a, b) => a.created_at.localeCompare(b.created_at)) : rows));
        },
        commit: () => remove.mutateAsync(p),
      }),
  };
}

/** Take or choose photos for the visit: on the Photos card, and on checklist items that ask for them. */
function PhotoPicker({ photos }: { photos: VisitPhotos }) {
  return (
    <label className="btn">
      <Icon name="camera" size={16} />
      {photos.uploading ? "Uploading…" : "Add photos"}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="sr-only"
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) photos.add(files);
        }}
      />
    </label>
  );
}

function Photos({ photos, clientOptOut }: { photos: VisitPhotos; clientOptOut: boolean }) {
  const session = useSession();
  const grid = useListAnimation<HTMLDivElement>();
  const count = photos.photos.length;
  // OK to share is only offered while Marketing is installed, never to subs (ShareToggle).
  const sharing = photos.photos.some((p) => shareToggleState(session, p, clientOptOut) === "ready");
  const unsupported = photos.photos.filter((p) => shareToggleState(session, p, clientOptOut) === "unsupported").length;
  return (
    <section className="card card-pad stack-sm">
      <div className="row-between"><strong>Photos</strong>{count > 0 && <span className="muted small tabular"><AnimatedNumber value={count} /></span>}</div>
      <div ref={grid} className="thumbs">
        {photos.loading && [0, 1, 2].map((i) => <Skeleton key={i} height={96} radius={8} />)}
        {photos.photos.map((p) => (
          <div key={p.id} className="thumb">
            {p.url ? <a href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.caption ?? p.file_name} loading="lazy" /></a> : <span className="muted small">Unavailable</span>}
            {photos.canRemove(p) && <button type="button" className="thumb-x" aria-label="Remove photo" onClick={() => photos.remove(p)}><Icon name="x" size={12} strokeWidth={2} /></button>}
            <ShareToggle photo={p} clientOptOut={clientOptOut} onShown={(shareable) => photos.showShareable(p.id, shareable)} />
          </div>
        ))}
        {Array.from({ length: photos.uploading }, (_, i) => <div key={`u${i}`} className="thumb" style={{ display: "grid", placeItems: "center" }}><span className="spinner" style={{ width: 20, height: 20, color: "var(--text-3)" }} /></div>)}
      </div>
      {sharing && <span className="muted small">Tap the corner to mark photos OK to share, and the office can post them. Posts never show the client's name or address. Check the photo doesn't show a house number, a car plate or people's faces.</span>}
      {unsupported > 0 && !clientOptOut && <span className="muted small">{unsupported === photos.photos.length ? (unsupported === 1 ? "This photo" : "These photos") : unsupported === 1 ? "The photo marked Can't share" : "The photos marked Can't share"} can't be marked OK to share: only JPEG and PNG photos can be posted.</span>}
      {count > 0 && clientOptOut && shareToggleState(session, { content_type: "image/jpeg" }) !== "hidden" && <span className="muted small">This client asked us not to post photos of their property.</span>}
      <span style={{ justifySelf: "start" }}><PhotoPicker photos={photos} /></span>
    </section>
  );
}

/** A signature on a checklist: the person signs on the screen and prints their name. */
function SignatureAnswer({ label, required, value, disabled, onChange }: { label: string; required: boolean; value: unknown; disabled: boolean; onChange: (next: { name: string; image: string | null } | null) => void }) {
  // Older checklists stored a typed name.
  const legacy = typeof value === "string" ? value : null;
  const current = value && typeof value === "object" ? (value as { name?: string; image?: string | null }) : null;
  return (
    <div className="field" style={{ flex: 1 }}>
      <span>{label}{required && <Required />}</span>
      {legacy ? (
        <span style={{ fontFamily: "'Brush Script MT', cursive", fontSize: 24 }}>{legacy}</span>
      ) : (
        <>
          <SignaturePad value={current?.image ?? null} disabled={disabled} label="Sign with your finger" onChange={(image) => onChange(image || current?.name ? { name: current?.name ?? "", image } : null)} />
          <input className="input" aria-label="Printed name" placeholder="Printed name" value={current?.name ?? ""} disabled={disabled} maxLength={120} onChange={(e) => onChange({ name: e.target.value, image: current?.image ?? null })} />
        </>
      )}
    </div>
  );
}
