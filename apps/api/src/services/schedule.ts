/**
 * The schedule: creating and changing visits, a rain day, a crew's route, open time, on-demand
 * visits for many jobs, and a recurring job's upcoming visits. The schedule screen reaches these
 * through routes/schedule.ts, and AI assistants through their tools (assistant-tools/schedule.ts):
 * both with the person's own client, so the database decides which crews and people they may
 * schedule (private.schedules_crew).
 */
import { addDays, DISPATCH, localDate, localTime, scheduleSettings, zonedTimeToUtc, type Permission, type Role } from "@crewtavo/core";
import { z } from "zod";
import type { Env } from "../env";
import { dbError, HttpError, isoDate, must, uuid } from "../lib/http";
import { adminClient, type Db } from "../lib/supabase";
import { materializeJob, recurringJob } from "../tasks";
import { fitQuietly } from "./routes";

/** Who's asking, as requireCompany works it out. */
export interface Scope {
  db: Db;
  companyId: string;
  role: Role;
  permissions: readonly Permission[];
  /** Who's asking, for the record of who organized a route. */
  userId?: string;
}

export async function companyZone(s: Scope): Promise<{ tz: string; settings: Record<string, any> }> {
  const company = must(await s.db.from("companies").select("timezone, settings").eq("id", s.companyId).maybeSingle());
  return { tz: company.timezone, settings: (company.settings ?? {}) as Record<string, any> };
}

export const VISIT_FIELDS =
  "id, title, kind, status, scheduled_on, starts_at, ends_at, route_order, time_fixed, hold_reason, crew_id, notes, series_id, series_day, series_total, job:jobs(id, number, title, client:clients(id, display_name)), property:properties(id, line1, line2, city, region, postal_code, lat, lng), assignees:visit_assignees(user_id), equipment:visit_equipment(equipment_id)";

export const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());

/** Change a visit's people or equipment to `wanted`, touching only what was added or removed. */
async function syncLinks(s: Scope, table: "visit_assignees" | "visit_equipment", column: "user_id" | "equipment_id", visitId: string, wanted: string[], notYours: string) {
  const current = (must(await s.db.from(table).select(column).eq("visit_id", visitId)) as unknown as Array<Record<string, string>>).map((r) => r[column]!);
  const next = [...new Set(wanted)];
  const removed = current.filter((x) => !next.includes(x));
  const added = next.filter((x) => !current.includes(x));
  if (removed.length) {
    const del = await s.db.from(table).delete().eq("visit_id", visitId).in(column, removed).select(column);
    if (del.error) throw dbError(del.error);
    if (del.data.length < removed.length) throw new HttpError(403, notYours);
  }
  if (added.length) {
    const ins = await s.db.from(table).insert(added.map((id) => ({ company_id: s.companyId, visit_id: visitId, [column]: id })) as never);
    if (ins.error) throw ins.error.code === "42501" ? new HttpError(403, notYours) : dbError(ins.error);
  }
}

const STATUSES = ["unscheduled", "scheduled", "en_route", "in_progress", "completed", "cancelled"] as const;

export const newVisitInput = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["job", "assessment", "task", "event"]).default("job"),
  job_id: uuid.nullable().optional(),
  request_id: uuid.nullable().optional(),
  property_id: uuid.nullable().optional(),
  crew_id: uuid.nullable().optional(),
  status: z.enum(STATUSES).default("scheduled"),
  notes: z.string().max(5000).nullable().optional(),
  scheduled_on: isoDate.nullable().optional(),
  starts_at: z.iso.datetime({ offset: true }).nullable().optional(),
  ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
  /** Keep this start time when the route is organized. */
  time_fixed: z.boolean().optional(),
  days: z.number().int().min(1).max(30).default(1),
  skip_weekends: z.boolean().default(true),
  assignee_ids: z.array(uuid).max(20).default([]),
  equipment_ids: z.array(uuid).max(30).default([]),
});

/**
 * New visit, task or event. With days > 1 it's multi-day work: one linked visit per work day
 * (weekends skipped unless asked), each at the same local time, with the same people and equipment.
 */
export async function createVisits(s: Scope, body: z.infer<typeof newVisitInput>): Promise<{ ids: string[]; series_id: string | null }> {
  if (!DISPATCH.includes(s.role)) throw new HttpError(403, "Your role can't schedule visits.");
  if (body.starts_at && body.ends_at && Date.parse(body.ends_at) <= Date.parse(body.starts_at)) throw new HttpError(400, "The visit has to end after it starts.");
  const company = await companyZone(s);
  const { tz } = company;
  const first = body.starts_at ? localDate(new Date(body.starts_at), tz) : body.scheduled_on ?? null;
  const days = first && body.status !== "unscheduled" ? body.days : 1;
  const dates: Array<string | null> = [];
  for (let d = first; dates.length < days; d = addDays(d!, 1)) {
    if (!d) {
      dates.push(null);
      break;
    }
    if (days > 1 && body.skip_weekends && isWeekend(d) && dates.length > 0) continue;
    dates.push(d);
  }
  const seriesId = days > 1 ? crypto.randomUUID() : null;
  const startTime = body.starts_at ? localTime(new Date(body.starts_at), tz) : null;
  const length = body.starts_at && body.ends_at ? Date.parse(body.ends_at) - Date.parse(body.starts_at) : null;
  const rows = dates.map((date, i) => {
    const start = date && startTime ? zonedTimeToUtc(date, startTime, tz) : null;
    return {
      company_id: s.companyId,
      title: body.title,
      kind: body.kind,
      job_id: body.job_id ?? null,
      request_id: body.request_id ?? null,
      property_id: body.property_id ?? null,
      crew_id: body.crew_id ?? null,
      status: body.status,
      notes: body.notes ?? null,
      scheduled_on: body.status === "unscheduled" ? null : date,
      starts_at: start?.toISOString() ?? null,
      ends_at: start && length ? new Date(start.getTime() + length).toISOString() : null,
      time_fixed: Boolean(start && body.time_fixed),
      series_id: seriesId,
      series_day: seriesId ? i + 1 : null,
      series_total: seriesId ? dates.length : null,
    };
  });
  const created = await s.db.from("visits").insert(rows).select("id");
  if (created.error) throw created.error.code === "42501" ? new HttpError(403, "You can schedule your own crew's work. Pick your crew.") : dbError(created.error);
  const notYours = "You can put people and equipment from your own crew on its visits.";
  for (const v of created.data) {
    if (body.assignee_ids.length) await syncLinks(s, "visit_assignees", "user_id", v.id, body.assignee_ids, notYours);
    if (body.equipment_ids.length) await syncLinks(s, "visit_equipment", "equipment_id", v.id, body.equipment_ids, notYours);
  }
  // An anytime visit on an organized day goes into the route (with automatic routes on).
  const ids = created.data.map((v) => v.id);
  if (body.status === "scheduled" && !startTime) {
    for (const date of dates) if (date) await fitQuietly(s, ids, body.crew_id ?? null, date, company);
  }
  return { ids, series_id: seriesId };
}

export const visitChangeInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  starts_at: z.iso.datetime({ offset: true }).nullable().optional(),
  ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
  scheduled_on: isoDate.nullable().optional(),
  crew_id: uuid.nullable().optional(),
  status: z.enum(STATUSES).optional(),
  notes: z.string().max(5000).nullable().optional(),
  /** Keep this start time when the route is organized. */
  time_fixed: z.boolean().optional(),
  assignee_ids: z.array(uuid).max(20).optional(),
  equipment_ids: z.array(uuid).max(30).optional(),
  /** For multi-day work: when this day moves, move the days after it by as much. */
  shift_series: z.boolean().optional(),
  /** A crew's tap: never moves the visit back a step (see below). */
  forward_only: z.boolean().optional(),
  /**
   * When a Complete was tapped, sent with status "completed" (a tap that waited for signal is dated
   * when the work was done). One that can't be read is ignored, like one out of bounds (tapTime).
   */
  completed_at: z.iso.datetime({ offset: true }).optional().catch(undefined),
});

/** How far back a Complete tap's own time is believed: a phone that was offline for days, at most. */
const TAP_DAYS = 3;

/**
 * The time a Complete was tapped, when it's believable: only with status "completed", not in the
 * future and no more than TAP_DAYS back. Otherwise none, and the database dates it now
 * (private.visit_defaults). Autopay goes by this date (a visit finished before autopay started
 * waits for the office), so it can't be moved later than now or far back.
 */
export function tapTime(status: string | undefined, completedAt: string | undefined, now = Date.now()): string | null {
  if (status !== "completed" || !completedAt) return null;
  const at = Date.parse(completedAt);
  if (!Number.isFinite(at) || at > now || at < now - TAP_DAYS * 86_400_000) return null;
  return new Date(at).toISOString();
}

/** The steps a crew takes a visit through, in order. */
const CREW_STEPS: Record<string, number> = { unscheduled: 0, scheduled: 0, en_route: 1, in_progress: 2, completed: 3 };

/** What a sub changes on their own visit (the database holds them to it: private.visit_sub_guard). */
const SUB_FIELDS = ["status", "notes", "forward_only", "completed_at"];
const SUB_STATUSES = ["scheduled", "en_route", "in_progress", "completed"];

export async function updateVisit(s: Scope, id: string, body: z.infer<typeof visitChangeInput>) {
  if (s.role === "subcontractor") {
    if (Object.keys(body).some((k) => !SUB_FIELDS.includes(k))) throw new HttpError(403, "You can change a visit's status and notes. Ask the office about anything else.");
    if (body.status && !SUB_STATUSES.includes(body.status)) throw new HttpError(403, "Ask the office to cancel or move this visit.");
  }
  const { assignee_ids, equipment_ids, shift_series, forward_only, completed_at, ...fields } = body;
  const tapped = tapTime(fields.status, completed_at);
  const current =
    (forward_only && fields.status) || tapped
      ? must(await s.db.from("visits").select("status, completed_at").eq("id", id).eq("company_id", s.companyId).maybeSingle(), "Visit not found.")
      : null;
  // A crew only moves a visit forward. A tap sent again later (the phone closed the app before it
  // heard back, say) can arrive after the taps that followed it, so it's skipped, not applied
  // backwards: a finished visit isn't reopened, and a cancelled one stays cancelled.
  if (forward_only && fields.status && current) {
    if (current.status === "cancelled" || (CREW_STEPS[current.status] ?? 0) > (CREW_STEPS[fields.status] ?? 0)) {
      return { ...must(await s.db.from("visits").select(VISIT_FIELDS).eq("id", id).maybeSingle()), skipped: true };
    }
  }
  // A Complete dated when it was tapped, with who tapped it, as the database would have dated it
  // (private.visit_defaults). Only for a visit not finished before: a finished visit's date stays,
  // so a Complete sent again can't move it.
  const stamp = tapped && current && !current.completed_at ? { completed_at: tapped, ...(s.userId && { completed_by: s.userId }) } : {};
  const reschedules = assignee_ids !== undefined || equipment_ids !== undefined || ["starts_at", "ends_at", "scheduled_on", "crew_id", "time_fixed"].some((k) => k in fields);
  // Which visits and people: the database decides (every crew with the "schedule" area, a crew
  // lead's own crew without it). See private.schedules_crew().
  if (reschedules && !DISPATCH.includes(s.role)) throw new HttpError(403, "Your role can't reschedule or reassign visits.");
  if (fields.starts_at && fields.ends_at && Date.parse(fields.ends_at) <= Date.parse(fields.starts_at)) throw new HttpError(400, "The visit has to end after it starts.");
  const moves = ["starts_at", "scheduled_on", "crew_id"].some((k) => k in fields);
  const before =
    shift_series || moves
      ? must(await s.db.from("visits").select("scheduled_on, starts_at, crew_id, series_id, series_day").eq("id", id).eq("company_id", s.companyId).maybeSingle(), "Visit not found.")
      : null;
  // A visit that moves leaves its place in the route; an anytime visit has no time to keep.
  const moved =
    before &&
    (("scheduled_on" in fields && fields.scheduled_on !== before.scheduled_on) ||
      ("crew_id" in fields && (fields.crew_id ?? null) !== before.crew_id) ||
      ("starts_at" in fields && (fields.starts_at ? !before.starts_at || Date.parse(fields.starts_at) !== Date.parse(before.starts_at) : before.starts_at !== null)));
  const routeFields = { ...(moved && { route_order: null }), ...("starts_at" in fields && !fields.starts_at && { time_fixed: false }) };
  if (Object.keys(fields).length) {
    const { data, error } = await s.db
      .from("visits")
      .update({ ...fields, ...routeFields, ...stamp })
      .eq("id", id)
      .eq("company_id", s.companyId)
      .select("id, scheduled_on, starts_at, crew_id, status");
    if (error) throw dbError(error);
    if (!data.length) throw new HttpError(404, "Visit not found.");
    const now = data[0]!;
    if (moved && now.status === "scheduled" && now.scheduled_on && !now.starts_at) await fitQuietly(s, [id], now.crew_id, now.scheduled_on);
    // Later days of the same multi-day job follow on the work days after it, keeping their own times
    // (and skipping weekends if the job didn't use them).
    const seriesMoved = shift_series && before?.series_id && before.scheduled_on && now.scheduled_on && before.scheduled_on !== now.scheduled_on;
    if (seriesMoved && before?.series_id) {
      const { tz } = await companyZone(s);
      const all = must(await s.db.from("visits").select("id, series_day, scheduled_on, starts_at, ends_at, status").eq("series_id", before.series_id).order("series_day"));
      const skipWeekends = !all.some((v) => v.id !== id && v.scheduled_on && isWeekend(v.scheduled_on));
      let prev = now.scheduled_on!;
      for (const v of all.filter((x) => (x.series_day ?? 0) > (before.series_day ?? 0))) {
        let date = addDays(prev, 1);
        while (skipWeekends && isWeekend(date)) date = addDays(date, 1);
        prev = date;
        if (["completed", "cancelled"].includes(v.status) || v.scheduled_on === date) continue;
        const start = v.starts_at ? zonedTimeToUtc(date, localTime(new Date(v.starts_at), tz), tz) : null;
        const length = v.starts_at && v.ends_at ? Date.parse(v.ends_at) - Date.parse(v.starts_at) : null;
        const { error: shiftError } = await s.db
          .from("visits")
          .update(start ? { starts_at: start.toISOString(), ends_at: length ? new Date(start.getTime() + length).toISOString() : null } : { scheduled_on: date })
          .eq("id", v.id);
        if (shiftError) throw dbError(shiftError);
      }
    }
  }

  // Only who and what was added or removed changes, so a crew lead keeps people the office put on
  // their visit, and the people notified are the ones whose day actually changed.
  const notYours = "You can change who's on your own crew's visits, using people and equipment from your crew. Ask the office for this one.";
  if (assignee_ids) await syncLinks(s, "visit_assignees", "user_id", id, assignee_ids, notYours);
  if (equipment_ids) await syncLinks(s, "visit_equipment", "equipment_id", id, equipment_ids, notYours);
  return must(await s.db.from("visits").select(VISIT_FIELDS).eq("id", id).maybeSingle());
}

type CalendarEventRow = {
  id: string;
  title: string;
  location: string | null;
  description: string | null;
  url: string | null;
  all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  starts_on: string;
  ends_on: string;
  busy: boolean;
  source: { id: string; name: string; color: string | null; crew_id: string | null; blocks_time: boolean } | null;
};

/**
 * Events from other calendars (Zoho, Outlook, Google...) on these days. Row-level security shows
 * them to people who see the whole schedule; for a crew, its own calendars and the whole team's.
 */
export async function calendarEvents(s: Scope, from: string, to: string, crew?: string) {
  const { data, error } = await s.db
    .from("calendar_events")
    .select("id, title, location, description, url, all_day, starts_at, ends_at, starts_on, ends_on, busy, source:calendar_sources(id, name, color, crew_id, blocks_time)")
    .eq("company_id", s.companyId)
    .lte("starts_on", to)
    .gte("ends_on", from)
    .order("starts_on")
    .limit(3000);
  if (error) throw dbError(error);
  return (data as unknown as CalendarEventRow[]).filter((e) => e.source && (!crew || !e.source.crew_id || e.source.crew_id === crew));
}

/** Visits between two dates (inclusive, at most two months), the unscheduled queue, the crews and other calendars' events. */
export async function scheduleRange(s: Scope, from: string, to: string, crew?: string) {
  if (to < from || addDays(from, 62) < to) throw new HttpError(400, "Ask for at most two months at a time.");
  const page = (offset: number) => {
    let visits = s.db.from("visits").select(VISIT_FIELDS).eq("company_id", s.companyId).gte("scheduled_on", from).lte("scheduled_on", to);
    if (crew) visits = visits.eq("crew_id", crew);
    // id breaks ties, so pages don't overlap or skip visits.
    return visits.order("scheduled_on").order("starts_at", { nullsFirst: false }).order("route_order", { nullsFirst: false }).order("id").range(offset, offset + 999);
  };
  // Supabase returns at most 1,000 rows per request, and a busy month has more, so read a page at a time.
  const allScheduled = async () => {
    const rows = must(await page(0));
    for (let offset = 1000; rows.length === offset; offset += 1000) rows.push(...must(await page(offset)));
    return rows;
  };
  const [scheduled, unscheduled, crews, events] = await Promise.all([
    allScheduled(),
    s.db.from("visits").select(VISIT_FIELDS).eq("company_id", s.companyId).eq("status", "unscheduled").limit(200),
    s.db.from("crews").select("id, name, color").eq("company_id", s.companyId).eq("active", true).order("name"),
    calendarEvents(s, from, to, crew),
  ]);
  return { visits: scheduled, unscheduled: must(unscheduled), crews: must(crews), events };
}

/** Rain day: move every open visit from one date to another, keeping each visit's local time. */
export async function shiftDay(s: Scope, body: { from_date: string; to_date: string; crew_id?: string }): Promise<{ moved: number }> {
  if (!DISPATCH.includes(s.role)) throw new HttpError(403, "Your role can't move visits.");
  // Without "Schedule the whole team", a crew lead shifts their own crew (the database checks it's theirs).
  if (!s.permissions.includes("schedule") && !body.crew_id) throw new HttpError(400, "Pick your crew to move its visits.");
  const { tz } = await companyZone(s);
  let query = s.db
    .from("visits")
    .select("id, starts_at, ends_at")
    .eq("company_id", s.companyId)
    .eq("scheduled_on", body.from_date)
    .not("status", "in", "(completed,cancelled)");
  if (body.crew_id) query = query.eq("crew_id", body.crew_id);
  const visits = must(await query);

  const updates = visits.map((v) => {
    if (!v.starts_at) return { id: v.id, scheduled_on: body.to_date };
    const start = zonedTimeToUtc(body.to_date, localTime(new Date(v.starts_at), tz), tz);
    const duration = v.ends_at ? new Date(v.ends_at).getTime() - new Date(v.starts_at).getTime() : 60 * 60_000;
    return { id: v.id, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + duration).toISOString() };
  });
  for (const { id, ...fields } of updates) {
    const { error } = await s.db.from("visits").update({ ...fields, hold_reason: null }).eq("id", id);
    if (error) throw dbError(error);
  }
  return { moved: updates.length };
}

/**
 * A crew's route (Organize route): see services/routes.ts. Ordering takes about a quarter second
 * at 100 stops and grows fast, so a day is limited to MAX_ROUTE_STOPS.
 */
export { MAX_ROUTE_STOPS, previewRoute, saveRoute, undoRoute } from "./routes";

/** Suggest open slots in working hours (company settings.working_hours, default 7:00-18:00). */
export async function findTime(s: Scope, body: { date_from: string; days: number; duration_min: number; crew_id?: string }) {
  const { tz, settings } = await companyZone(s);
  const hours = { start: settings.working_hours?.start ?? "07:00", end: settings.working_hours?.end ?? "18:00" };
  const dateTo = addDays(body.date_from, body.days - 1);

  let query = s.db
    .from("visits")
    .select("starts_at, ends_at, scheduled_on")
    .eq("company_id", s.companyId)
    .gte("scheduled_on", body.date_from)
    .lte("scheduled_on", dateTo)
    .not("starts_at", "is", null)
    .not("status", "eq", "cancelled");
  if (body.crew_id) query = query.eq("crew_id", body.crew_id);
  const busy = must(await query).map((v) => ({ start: new Date(v.starts_at).getTime(), end: new Date(v.ends_at ?? v.starts_at).getTime() }));
  // Busy time on other calendars counts too (a crew's own calendars, and the whole team's).
  for (const e of await calendarEvents(s, body.date_from, dateTo, body.crew_id)) {
    if (!e.busy || !e.source?.blocks_time) continue;
    if (e.starts_at && e.ends_at) busy.push({ start: Date.parse(e.starts_at), end: Date.parse(e.ends_at) });
    else busy.push({ start: zonedTimeToUtc(e.starts_on, "00:00", tz).getTime(), end: zonedTimeToUtc(addDays(e.ends_on, 1), "00:00", tz).getTime() });
  }

  const slots: Array<{ starts_at: string; ends_at: string }> = [];
  const need = body.duration_min * 60_000;
  // Slots start on the company's time step (every 5 minutes, unless Settings → Schedule says otherwise).
  const step = Math.max(5, scheduleSettings(settings).timeStep) * 60_000;
  const now = Math.ceil(Date.now() / step) * step;
  for (let day = body.date_from; day <= dateTo && slots.length < 10; day = addDays(day, 1)) {
    const dayStart = Math.max(zonedTimeToUtc(day, hours.start, tz).getTime(), now);
    const dayEnd = zonedTimeToUtc(day, hours.end, tz).getTime();
    const blocks = busy.filter((b) => b.end > dayStart && b.start < dayEnd).sort((a, b) => a.start - b.start);
    let cursor = dayStart;
    for (const block of [...blocks, { start: dayEnd, end: dayEnd }]) {
      if (block.start - cursor >= need && slots.length < 10) {
        slots.push({ starts_at: new Date(cursor).toISOString(), ends_at: new Date(cursor + need).toISOString() });
      }
      cursor = Math.max(cursor, block.end);
    }
  }
  return { timezone: tz, slots };
}

/** On-demand work (snow, storm cleanup): one visit per chosen job on a date. */
export async function bulkVisits(s: Scope, body: { job_ids: string[]; date: string; crew_id?: string }): Promise<{ created: number }> {
  if (!DISPATCH.includes(s.role) || !s.permissions.includes("schedule")) throw new HttpError(403, "Your role can't schedule the whole team.");
  const jobs = must(await s.db.from("jobs").select("id, title, property_id, default_crew_id").eq("company_id", s.companyId).in("id", body.job_ids));
  const { error } = await s.db.from("visits").insert(
    jobs.map((j) => ({
      company_id: s.companyId,
      job_id: j.id,
      property_id: j.property_id,
      title: j.title,
      scheduled_on: body.date,
      crew_id: body.crew_id ?? j.default_crew_id,
    })),
  );
  if (error) throw dbError(error);
  return { created: jobs.length };
}

/**
 * After a recurring job's schedule changes: create its upcoming visits now, and drop ones it no
 * longer has. It's done with the server's key (the visits are the job's, not a crew's), so who may
 * ask is checked here: a dispatcher with "Schedule the whole team".
 */
export async function generateVisits(s: Scope, env: Env, jobId: string): Promise<{ created: number; removed: number }> {
  if (!DISPATCH.includes(s.role) || !s.permissions.includes("schedule")) throw new HttpError(403, "Your role can't schedule the whole team, so a recurring job's visits can't be made for it. Ask the office.");
  const owned = must(await s.db.from("jobs").select("id, kind, status").eq("id", jobId).eq("company_id", s.companyId).maybeSingle(), "Job not found.");
  if (owned.kind !== "recurring" || owned.status !== "active") return { created: 0, removed: 0 };
  const admin = adminClient(env);
  const job = await recurringJob(admin, jobId);
  if (!job) throw new HttpError(404, "Job not found.");
  try {
    return await materializeJob(admin, job, true);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Couldn't schedule the visits.");
  }
}
