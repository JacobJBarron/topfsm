/**
 * A crew member's clock on a visit (fieldActions.setVisitStatus + fieldData.clockVisit): the visit's
 * status is shared and only moves forward, but each person clocks in and out as they tapped, and
 * a tap sent again doesn't add time twice. A sub without a clock moves the visit along and has no
 * time at all, as decided when they tapped.
 */
import { beforeEach, expect, it, vi } from "vitest";

// The server side: the visit's status with the API's forward_only rule (apps/api/src/routes/schedule.ts),
// and time_entries rows as the database holds them.
const STEPS: Record<string, number> = { unscheduled: 0, scheduled: 0, en_route: 1, in_progress: 2, completed: 3 };
type Entry = { id: number; user_id: string; visit_id: string | null; started_at: string; ended_at: string | null };
const server = { status: "scheduled", entries: [] as Entry[], refuseTime: false, sent: [] as object[] };

vi.mock("../src/lib/api", () => {
  const api = {
    patch: async (_path: string, body: { status: string; forward_only?: boolean }) => {
      server.sent.push(body);
      if (body.forward_only && (server.status === "cancelled" || (STEPS[server.status] ?? 0) > (STEPS[body.status] ?? 0))) return { status: server.status, skipped: true };
      server.status = body.status;
      return { status: server.status };
    },
  };
  const table = () => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let update: Record<string, unknown> | null = null;
    let limit = Infinity;
    const q = {
      select: () => q,
      update: (values: Record<string, unknown>) => ((update = values), q),
      insert: (values: Omit<Entry, "id" | "ended_at">) => {
        // The office took a sub off the clock: the database refuses their time.
        if (server.refuseTime) return Promise.resolve({ data: null, error: new Error('new row violates row-level security policy for table "time_entries"') });
        server.entries.push({ id: server.entries.length + 1, ended_at: null, ...values });
        return Promise.resolve({ data: null, error: null });
      },
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      lte: (k: string, v: string) => (filters.push((r) => r[k] != null && String(r[k]) <= v), q),
      gt: (k: string, v: string) => (filters.push((r) => r[k] != null && String(r[k]) > v), q),
      limit: (n: number) => ((limit = n), q),
      then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const rows = server.entries.filter((r) => filters.every((f) => f(r))).slice(0, limit);
        if (update) rows.forEach((r) => Object.assign(r, update));
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return { api, supabase: () => ({ from: () => table() }), unwrap: (r: { data: unknown; error: unknown }) => { if (r.error) throw r.error; return r.data; } };
});

const { setVisitStatus, statusSaved } = await import("../src/features/field/fieldActions");
const { statusChange } = await import("../src/features/field/fieldData");
const tap = (userId: string, status: string, at: string, place?: { lat: number; lng: number; accuracy: number }, clock?: boolean) => setVisitStatus({ companyId: "c1", userId, visitId: "v1", jobId: null, status, at, place, clock });
const timeOf = (userId: string) => server.entries.filter((e) => e.user_id === userId).map((e) => [e.started_at, e.ended_at]);

beforeEach(() => {
  server.status = "scheduled";
  server.entries = [];
  server.refuseTime = false;
  server.sent = [];
});

it("clocks a crewmate in and out even when the visit was finished before their taps arrived", async () => {
  // Alice's phone gets signal first; Bob tapped Start and Complete with none, and his go out later.
  await tap("alice", "en_route", "2026-10-17T12:50:00Z");
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await tap("alice", "completed", "2026-10-17T16:00:00Z");
  await tap("bob", "in_progress", "2026-10-17T13:05:00Z");
  await tap("bob", "completed", "2026-10-17T16:10:00Z");
  expect(server.status).toBe("completed");
  expect(timeOf("bob")).toEqual([["2026-10-17T13:05:00Z", "2026-10-17T16:10:00Z"]]);
});

it("doesn't add time when someone's own Start is sent again after they finished", async () => {
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await tap("alice", "completed", "2026-10-17T16:00:00Z");
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  expect(server.status).toBe("completed");
  expect(timeOf("alice")).toEqual([["2026-10-17T13:00:00Z", "2026-10-17T16:00:00Z"]]);
});

it("stops the clock on a visit the office cancelled, and doesn't start one", async () => {
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  server.status = "cancelled";
  await tap("alice", "completed", "2026-10-17T14:00:00Z");
  expect(timeOf("alice")).toEqual([["2026-10-17T13:00:00Z", "2026-10-17T14:00:00Z"]]);
  await tap("bob", "in_progress", "2026-10-17T13:30:00Z");
  expect(timeOf("bob")).toEqual([]);
});

it("saves where the phone was with the clock it starts and stops, even sent later", async () => {
  const shop = { lat: 40.1, lng: -75.1, accuracy: 20 };
  const site = { lat: 40.0004, lng: -75.0003, accuracy: 12 };
  const after = { lat: 40.0001, lng: -75.0001, accuracy: 8 };
  server.entries.push({ id: 1, company_id: "c1", user_id: "alice", visit_id: null, started_at: "2026-10-17T12:00:00Z", ended_at: null, in_place: shop } as Entry);
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z", site);
  await tap("alice", "completed", "2026-10-17T16:00:00Z", after);
  const [drive, visit] = server.entries as Array<Entry & { in_place?: unknown; out_place?: unknown }>;
  expect([drive!.in_place, drive!.out_place]).toEqual([shop, site]);
  expect([visit!.in_place, visit!.out_place]).toEqual([site, after]);
});

it("doesn't clock a sub in or out when the office doesn't keep their hours, but moves the visit along", async () => {
  await tap("sub", "en_route", "2026-10-17T12:50:00Z", undefined, false);
  await tap("sub", "in_progress", "2026-10-17T13:00:00Z", undefined, false);
  expect(server.status).toBe("in_progress");
  await tap("sub", "completed", "2026-10-17T16:00:00Z", undefined, false);
  expect(server.status).toBe("completed");
  expect(server.entries).toEqual([]);
});

it("clocks a sub the office keeps hours for, and a tap saved before the flag existed, as before", async () => {
  await tap("sub", "in_progress", "2026-10-17T13:00:00Z", undefined, true);
  await tap("sub", "completed", "2026-10-17T15:00:00Z", undefined, true);
  expect(timeOf("sub")).toEqual([["2026-10-17T13:00:00Z", "2026-10-17T15:00:00Z"]]);
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  expect(timeOf("alice")).toEqual([["2026-10-17T13:00:00Z", null]]);
});

it("doesn't promise a running clock to someone who has none", () => {
  const change = { companyId: "c1", userId: "sub", visitId: "v1", jobId: null, status: "in_progress", at: "2026-10-17T13:00:00Z" };
  expect(statusSaved({ skipped: false }, { ...change, clock: false })).toBe("Visit started");
  expect(statusSaved({ skipped: false }, { ...change, clock: true })).toBe("Visit started, your clock is running");
  expect(statusSaved({ skipped: false }, change)).toBe("Visit started, your clock is running");
  expect(statusSaved({ skipped: true, visitStatus: "completed" }, { ...change, clock: false })).toBe("This visit had already moved on");
  expect(statusSaved({ skipped: true, visitStatus: "cancelled" }, { ...change, clock: false })).toBe("The office cancelled this visit");
});

it("decides at the tap whether it clocks, and only then asks the phone where it is", () => {
  const at = "2026-10-17T13:00:00Z";
  const visit = { id: "v1", jobId: "j1" };
  const person = (role: string, extra: object = {}, settings: Record<string, unknown> = {}) => ({ role, userId: "u1", subcontractor: null, company: { id: "c1", settings }, ...extra }) as never;
  const sub = (uses_clock: boolean) => person("subcontractor", { subcontractor: { id: "s1", name: "Apex", can_contact_clients: false, uses_clock } });
  expect(statusChange(sub(false), visit, "in_progress", at)).toEqual({
    change: { companyId: "c1", userId: "u1", visitId: "v1", jobId: "j1", status: "in_progress", at, clock: false, sub: true },
    locate: false,
  });
  expect(statusChange(sub(true), visit, "completed", at)).toMatchObject({ change: { clock: true, sub: true }, locate: true });
  const crew = statusChange(person("field_crew"), visit, "in_progress", at);
  expect(crew).toMatchObject({ change: { clock: true }, locate: true });
  expect(crew.change).not.toHaveProperty("sub");
  expect(statusChange(person("field_crew"), visit, "en_route", at).locate).toBe(false);
  expect(statusChange(person("field_crew", {}, { clock: { record_location: false } }), visit, "in_progress", at).locate).toBe(false);
});

it("moves a sub's visit along when the office turned their clock off after the phone last heard, without clocking", async () => {
  server.refuseTime = true;
  const result = await setVisitStatus({ companyId: "c1", userId: "al", visitId: "v1", jobId: null, status: "in_progress", at: "2026-10-17T13:00:00Z", clock: true, sub: true });
  expect(result).toEqual({ skipped: false, visitStatus: "in_progress", clockOff: true });
  expect(server.status).toBe("in_progress");
  expect(statusSaved(result, { companyId: "c1", userId: "al", visitId: "v1", jobId: null, status: "in_progress", at: "", clock: true, sub: true })).toBe("Visit started");
  // The team's clock refused is a real problem, shown as one.
  await expect(tap("alice", "in_progress", "2026-10-17T13:05:00Z")).rejects.toThrow(/row-level security/);
});


it("dates a Complete by when it was tapped, so one sent after a spell without signal isn't dated when it went out", async () => {
  await tap("alice", "en_route", "2026-10-17T12:50:00Z");
  await tap("alice", "in_progress", "2026-10-17T13:00:00Z");
  await tap("alice", "completed", "2026-10-17T16:00:00Z");
  // A sub without a clock is dated the same way: the date is the visit's, not their time.
  await tap("sub", "completed", "2026-10-17T16:05:00Z", undefined, false);
  expect(server.sent).toEqual([
    { status: "en_route", forward_only: true },
    { status: "in_progress", forward_only: true },
    { status: "completed", forward_only: true, completed_at: "2026-10-17T16:00:00Z" },
    { status: "completed", forward_only: true, completed_at: "2026-10-17T16:05:00Z" },
  ]);
});
