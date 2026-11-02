/**
 * The schedule: what's on when, and scheduling, moving and changing visits, a rain day, a crew's
 * route, open time, and on-demand visits for many jobs. All through services/schedule.ts, as the
 * schedule screen does, with times in the company's own time zone.
 */
import { localDate, localTime, zonedTimeToUtc } from "@crewtavo/core";
import { z } from "zod";
import { bulkVisits, createVisits, findTime, previewRoute, saveRoute, scheduleRange, shiftDay, updateVisit } from "../services/schedule";
import { changed, companyArg, one, scopeOf, tool } from "./tool";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM.");

export const scheduleTools = {
  get_schedule: tool({
    description:
      "What's on the schedule from one date to another (default just today; at most two months), in the company's time zone: visits with client, address, crew, people and status, plus the unscheduled visits waiting for a date, the crews, and other calendars' events. Filter by crew.",
    input: z.object({ from: date.optional(), to: date.optional(), crew_id: z.uuid().optional(), ...companyArg }),
    run: async (ctx, a) => {
      const from = a.from ?? localDate(new Date(), ctx.timezone);
      const result = await scheduleRange(scopeOf(ctx), from, a.to ?? from, a.crew_id);
      const local = (iso: string | null) => (iso ? localTime(new Date(iso), ctx.timezone) : null);
      return {
        timezone: ctx.timezone,
        ...result,
        visits: (result.visits as Array<Record<string, any>>).map((v) => ({ ...v, start_time: local(v.starts_at), end_time: local(v.ends_at) })),
      };
    },
  }),
  create_visit: tool({
    description:
      "Schedule a visit for a job (job_id), an estimate visit for a request (kind assessment, request_id), a task or an event. Give a date, and a start_time and duration for a set time (any number of minutes, like 20 or 50; otherwise it's an anytime visit that day). time_fixed keeps the start time when the crew's route is organized (the customer expects it). days > 1 makes multi-day work, one visit per work day. People (list_team) and equipment can go on it.",
    input: z.object({
      title: z.string().trim().min(1).max(200),
      kind: z.enum(["job", "assessment", "task", "event"]).default("job"),
      job_id: z.uuid().optional(),
      request_id: z.uuid().optional(),
      property_id: z.uuid().optional().describe("Default: the job's property."),
      date: date.optional().describe("Leave out (with status unscheduled) to put it on the waiting list."),
      start_time: time.optional(),
      duration_min: z.number().int().min(1).max(1440).default(60).describe("Any whole number of minutes."),
      time_fixed: z.boolean().default(false).describe("Keep this start time when the route is organized."),
      days: z.number().int().min(1).max(30).default(1),
      skip_weekends: z.boolean().default(true),
      crew_id: z.uuid().optional(),
      assignee_ids: z.array(z.uuid()).max(20).default([]),
      equipment_ids: z.array(z.uuid()).max(30).default([]),
      status: z.enum(["unscheduled", "scheduled"]).default("scheduled"),
      notes: z.string().trim().max(5000).optional(),
      ...companyArg,
    }),
    area: "schedule",
    run: async (ctx, a) => {
      const job = a.job_id ? await one(ctx.db.from("jobs").select("property_id").eq("id", a.job_id).eq("company_id", ctx.companyId).maybeSingle(), "That job") : null;
      const start = a.date && a.start_time ? zonedTimeToUtc(a.date, a.start_time, ctx.timezone) : null;
      return createVisits(scopeOf(ctx), {
        title: a.title, kind: a.kind, job_id: a.job_id ?? null, request_id: a.request_id ?? null, property_id: a.property_id ?? job?.property_id ?? null,
        crew_id: a.crew_id ?? null, status: a.date ? a.status : "unscheduled", notes: a.notes ?? null,
        scheduled_on: a.date ?? null, starts_at: start?.toISOString() ?? null, ends_at: start ? new Date(start.getTime() + a.duration_min * 60_000).toISOString() : null,
        time_fixed: Boolean(start) && a.time_fixed,
        days: a.days, skip_weekends: a.skip_weekends, assignee_ids: a.assignee_ids, equipment_ids: a.equipment_ids,
      });
    },
  }),
  update_visit: tool({
    description:
      "Move or change a visit: its date, start time (or anytime: start_time null), length (any number of minutes), whether its time is fixed, crew, people (the whole list), equipment, status, title or notes. Moving a visit takes it out of its organized route. Moving one day of multi-day work moves the days after it too (shift_series, default true). A deleted recurring visit stays deleted; to skip one, use delete_visit. A visit you mark completed on a job charged automatically (autopay) waits for the office to approve its charge.",
    input: z.object({
      visit_id: z.uuid(),
      date: date.nullable().optional().describe("null puts it back on the waiting list."),
      start_time: time.nullable().optional(),
      duration_min: z.number().int().min(1).max(1440).optional(),
      time_fixed: z.boolean().optional().describe("Keep this start time when the route is organized."),
      crew_id: z.uuid().nullable().optional(),
      assignee_ids: z.array(z.uuid()).max(20).optional(),
      equipment_ids: z.array(z.uuid()).max(30).optional(),
      status: z.enum(["unscheduled", "scheduled", "en_route", "in_progress", "completed", "cancelled"]).optional(),
      title: z.string().trim().min(1).max(200).optional(),
      notes: z.string().trim().max(5000).nullable().optional(),
      shift_series: z.boolean().default(true),
      ...companyArg,
    }),
    area: "schedule",
    run: async (ctx, a) => {
      const visit = await one(ctx.db.from("visits").select("scheduled_on, starts_at, ends_at").eq("id", a.visit_id).eq("company_id", ctx.companyId).maybeSingle(), "That visit");
      const fields: Record<string, unknown> = {};
      const timed = a.date !== undefined || a.start_time !== undefined || a.duration_min !== undefined;
      if (timed) {
        if (a.date === null) Object.assign(fields, { status: "unscheduled", scheduled_on: null, starts_at: null, ends_at: null });
        else {
          const day = a.date ?? visit.scheduled_on;
          if (!day) throw new Error("This visit has no date yet: give one.");
          const startTime = a.start_time === undefined ? (visit.starts_at ? localTime(new Date(visit.starts_at), ctx.timezone) : null) : a.start_time;
          const length = a.duration_min ?? (visit.starts_at && visit.ends_at ? (Date.parse(visit.ends_at) - Date.parse(visit.starts_at)) / 60_000 : 60);
          if (startTime) {
            const start = zonedTimeToUtc(day, startTime, ctx.timezone);
            Object.assign(fields, { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + length * 60_000).toISOString() });
          } else Object.assign(fields, { scheduled_on: day, starts_at: null, ends_at: null });
          if (visit.scheduled_on === null) fields.status = "scheduled";
        }
      }
      for (const k of ["crew_id", "assignee_ids", "equipment_ids", "status", "title", "notes", "time_fixed"] as const) if (a[k] !== undefined) fields[k] = a[k];
      return updateVisit(scopeOf(ctx), a.visit_id, { ...fields, shift_series: a.shift_series });
    },
  }),
  delete_visit: tool({
    description: "Delete a visit, task or event. A recurring job's visit deleted this way stays deleted (that date is skipped). To move it instead, use update_visit.",
    input: z.object({ visit_id: z.uuid(), ...companyArg }),
    area: "schedule",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("visits").delete().eq("id", a.visit_id).eq("company_id", ctx.companyId).select("id"), "That visit");
      return { deleted: true };
    },
  }),
  rain_day: tool({
    description: "Move every open visit on one date to another, keeping their times, for the whole team or one crew. Weather holds are cleared.",
    input: z.object({ from_date: date, to_date: date, crew_id: z.uuid().optional(), ...companyArg }),
    area: "schedule",
    run: (ctx, a) => shiftDay(scopeOf(ctx), a),
  }),
  organize_route: tool({
    description:
      "Organize a crew's route for a date (crew_id null: the visits with no crew): the shortest driving order from the shop, each stop's time from the visit's length plus the drive, fixed-time visits kept where they are. Up to 100 stops. With save false, only shows the plan (miles before and after, finish time, warnings). order sets the order by hand (visit ids); that day is then never reordered automatically. Visits already started stay put.",
    input: z.object({
      date,
      crew_id: z.uuid().nullable().default(null),
      order: z.array(z.uuid()).max(100).optional().describe("The open stops' visit ids in the order wanted. Leave out for the shortest route."),
      save: z.boolean().default(true),
      ...companyArg,
    }),
    area: "schedule",
    run: async (ctx, a) => {
      const plan = await previewRoute(scopeOf(ctx), ctx.env, a);
      const local = (iso: string | null) => (iso ? localTime(new Date(iso), ctx.timezone) : null);
      const summary = {
        ...plan,
        stops: plan.stops.map((s) => ({ order: s.order, visit_id: s.id, title: s.title, client: s.client, address: s.address, start_time: local(s.starts_at), end_time: local(s.ends_at), drive_min: s.drive_min, drive_miles: s.drive_miles, fixed: s.fixed, late: s.late, located: s.located })),
        started: plan.started.map((s) => ({ visit_id: s.id, title: s.title, status: s.status })),
      };
      if (!a.save) return { saved: false, ...summary };
      const saved = await saveRoute(scopeOf(ctx), { date: a.date, crew_id: a.crew_id, order: plan.stops.map((s) => s.id), by_hand: Boolean(a.order) });
      return { saved: true, changed: saved.saved, ...summary };
    },
  }),
  find_time: tool({
    description: "Open slots of a given length in working hours over the next days (up to 14), for the whole team or one crew, around visits and busy calendar events. Up to 10 slots.",
    input: z.object({ date_from: date.optional(), days: z.number().int().min(1).max(14).default(7), duration_min: z.number().int().min(1).max(720), crew_id: z.uuid().optional(), ...companyArg }),
    run: async (ctx, a) => {
      const found = await findTime(scopeOf(ctx), { ...a, date_from: a.date_from ?? localDate(new Date(), ctx.timezone) });
      return { ...found, slots: found.slots.map((s) => ({ ...s, date: localDate(new Date(s.starts_at), ctx.timezone), start_time: localTime(new Date(s.starts_at), ctx.timezone) })) };
    },
  }),
  bulk_visits: tool({
    description: "On-demand work (snow, storm cleanup): one visit for each of these jobs on a date, with their usual crew or the one given.",
    input: z.object({ job_ids: z.array(z.uuid()).min(1).max(500), date, crew_id: z.uuid().optional(), ...companyArg }),
    area: "schedule",
    run: (ctx, a) => bulkVisits(scopeOf(ctx), a),
  }),
};
