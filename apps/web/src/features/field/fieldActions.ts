/**
 * Field actions that work without signal: each is a plain function of its variables (no screen
 * state), registered by name, so a queued action can still be sent after the app was closed.
 * See lib/offline.ts.
 */
import type { QueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { clockVisit, type ClockPlace } from "./fieldData";

export interface VisitStatusChange {
  companyId: string;
  userId: string;
  visitId: string;
  jobId: string | null;
  status: string;
  /** When it was tapped. */
  at: string;
  /** Where the phone was, when the tap starts or stops the clock (useStatusTap). */
  place?: ClockPlace;
  /**
   * Whether Start and Complete clock this person in and out, decided at the tap (useStatusTap): the
   * queued send only has what was saved with it. False for a sub the office doesn't keep hours for.
   * A tap saved before this was recorded clocks, as it always did.
   */
  clock?: boolean;
  /** Tapped by a sub: if the office has since taken them off the clock, the visit still moves on. */
  sub?: boolean;
}

/**
 * The status last tapped for a visit on this phone while that tap is still waiting to send (no
 * signal, or queued behind an earlier action). What the server says is older than that, so screens
 * show this instead; otherwise the crew would be offered a step they've already taken, and tapping
 * it would queue a step backwards.
 */
export function pendingVisitStatus(queryClient: QueryClient, visitId: string): string | undefined {
  const waiting = queryClient
    .getMutationCache()
    .findAll({ mutationKey: ["visit-status"], status: "pending" })
    .map((m) => m.state.variables as VisitStatusChange | undefined)
    .filter((v) => v?.visitId === visitId);
  return waiting.at(-1)?.status;
}

/**
 * The last checklist or notes save made on this phone for a visit that hasn't gone yet, like
 * pendingVisitStatus: the visit's screen shows it rather than the older copy the server has.
 */
export function pendingVisitSave<V extends { visitId: string }>(queryClient: QueryClient, key: "checklist-save" | "visit-notes", visitId: string): V | undefined {
  return queryClient
    .getMutationCache()
    .findAll({ mutationKey: [key], status: "pending" })
    .map((m) => m.state.variables as V | undefined)
    .filter((v): v is V => v?.visitId === visitId)
    .at(-1);
}

/** Show a tapped status at once, on My day and on the visit's own screen alike. */
export function showVisitStatus(queryClient: QueryClient, change: VisitStatusChange) {
  queryClient.setQueriesData<{ today: Array<{ id: string; status: string }> }>({ queryKey: ["field"] }, (old) => old && { ...old, today: old.today.map((v) => (v.id === change.visitId ? { ...v, status: change.status } : v)) });
  queryClient.setQueryData<{ status: string } | null>(["field-visit", change.visitId], (old) => old && { ...old, status: change.status });
}

export async function setVisitStatus(v: VisitStatusChange) {
  // As the company it was tapped in, even if the app has switched company since. Forward only: a
  // tap sent again after later ones went out (the app closed before it heard back) is skipped.
  const result = await api.patch<{ skipped?: boolean; status?: string }>(`/visits/${v.visitId}`, { status: v.status, forward_only: true }, { companyId: v.companyId });
  // The visit's status is shared, but each person's clock is their own: when the visit has moved on
  // (a crewmate finished it first), this person still clocks in and out as they tapped. Only a
  // cancelled visit doesn't start a clock, and someone without a clock (a sub, mostly) has none.
  const clocks = v.clock !== false;
  let clockOff = false;
  try {
    if (clocks && v.status === "in_progress" && !(result.skipped && result.status === "cancelled")) await clockVisit(v.companyId, v.userId, { id: v.visitId, job_id: v.jobId }, "start", v.at, v.place);
    if (clocks && v.status === "completed") await clockVisit(v.companyId, v.userId, { id: v.visitId, job_id: v.jobId }, "stop", v.at, v.place);
  } catch (error) {
    // A sub whose clock the office turned off after this phone last heard (the database refuses
    // their time now): the visit moved on, and there's simply no clock.
    if (!(v.sub && clockRefused(error))) throw error;
    clockOff = true;
  }
  return { skipped: Boolean(result.skipped), visitStatus: result.status, ...(clockOff && { clockOff }) };
}

/** The database turning a clock down: row-level security on time entries. */
export const clockRefused = (error: unknown) => /row-level security|permission/i.test(error instanceof Error ? error.message : String(error));

/** What a status tap's confirmation says, once the server has it (a toast: no closing period). */
export function statusSaved(result: { skipped: boolean; visitStatus?: string; clockOff?: boolean } | undefined, change: VisitStatusChange): string {
  const clocks = change.clock !== false && !result?.clockOff;
  if (result?.skipped) return result.visitStatus === "cancelled" ? "The office cancelled this visit" : clocks ? "Your crew already moved this visit on, your time is saved" : "This visit had already moved on";
  return change.status === "en_route" ? "On your way" : change.status === "in_progress" ? (clocks ? "Visit started, your clock is running" : "Visit started") : "Visit completed";
}

export interface ChecklistSave {
  companyId: string;
  visitId: string;
  /** Made on the phone, so saving twice offline updates one row instead of adding two. */
  responseId: string;
  templateId: string | null;
  /**
   * Left out when the checklist is only marked done with nothing of this phone's waiting: the
   * answers saved stay as they are, a crewmate's from another phone included.
   */
  answers?: Record<string, unknown>;
  completedAt: string | null;
}

export async function saveChecklist(v: ChecklistSave) {
  unwrap(
    await supabase()
      .from("checklist_responses")
      .upsert({ id: v.responseId, company_id: v.companyId, visit_id: v.visitId, template_id: v.templateId, ...(v.answers && { answers: v.answers as never }), completed_at: v.completedAt }),
  );
}

export interface VisitNotesSave {
  visitId: string;
  notes: string | null;
  /** Where the notes were written; notes queued before it was recorded go to the company on screen. */
  companyId?: string;
}

export async function saveVisitNotes(v: VisitNotesSave) {
  await api.patch(`/visits/${v.visitId}`, { notes: v.notes }, { companyId: v.companyId });
}

export interface PhotoShareChange {
  attachmentId: string;
  shareable: boolean;
  /** Where it was tapped. */
  companyId: string;
}

/** OK to share on a photo, or not (set_photo_shareable): safe to send twice. */
export async function setPhotoShareable(v: PhotoShareChange) {
  unwrap(await supabase().rpc("set_photo_shareable", { p_attachment: v.attachmentId, p_shareable: v.shareable }));
}

/**
 * Field actions wait for signal ("online" mode): with none, React Query pauses them and lib/offline.ts
 * keeps them on the phone. Every other save fails at once instead (lib/queryClient.ts).
 */
const WAIT_FOR_SIGNAL = { networkMode: "online" } as const;

export function registerFieldActions(queryClient: QueryClient) {
  queryClient.setMutationDefaults(["visit-status"], {
    ...WAIT_FOR_SIGNAL,
    mutationFn: async (v: VisitStatusChange) => {
      const result = await setVisitStatus(v);
      // Their clock was turned off: what this phone knows about them (GET /me) is out of date.
      if (result.clockOff) void queryClient.invalidateQueries({ queryKey: ["me"] });
      return result;
    },
  });
  queryClient.setMutationDefaults(["checklist-save"], { ...WAIT_FOR_SIGNAL, mutationFn: (v: ChecklistSave) => saveChecklist(v) });
  queryClient.setMutationDefaults(["visit-notes"], { ...WAIT_FOR_SIGNAL, mutationFn: (v: VisitNotesSave) => saveVisitNotes(v) });
  queryClient.setMutationDefaults(["photo-share"], { ...WAIT_FOR_SIGNAL, mutationFn: (v: PhotoShareChange) => setPhotoShareable(v) });
}
