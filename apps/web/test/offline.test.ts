/**
 * The field queue for crews with no signal (lib/offline.ts): queued actions are sent once, the
 * saved copy never lists actions that have gone out, a weak signal or a restarting server queues
 * instead of failing, an expired sign-in keeps the queue, and each action goes to the company it
 * was made in.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { focusManager, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveVisitNotes, setVisitStatus } from "../src/features/field/fieldActions";
import { api, setActiveCompany, unwrap } from "../src/lib/api";
import { ApiError, OFFLINE, SESSION_EXPIRED } from "../src/lib/errors";
import { ROLES } from "@crewtavo/core/roles";
import { FIELD_SCOPE, forgetOfflineCache, keepQueuedFieldActions, keepsDayOffline, OFFLINE_MUTATIONS, pendingFieldActions, startOfflineCache, SYNC_TAG, WAITING_CACHE } from "../src/lib/offline";
import { FakeCaches, loadServiceWorker } from "./serviceWorker";

// The phone's storage, which can be made to run out of room.
const store = new Map<string, string>();
let room = Infinity;
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (value.length > room) throw new Error("QuotaExceededError");
    store.set(key, value);
  },
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
type Saved = { mutations: Array<{ state: { variables: unknown } }>; queries: Array<{ queryKey: unknown[]; state: { data: { status?: string } } }> };
const saved = (userId: string) => JSON.parse(store.get(`crewtavo.offline.v1.${userId}`) ?? "null") as Saved | null;

const clients: QueryClient[] = [];
/** Configured like lib/queryClient.ts (no retries by default), and mounted like the app's. */
function newClient() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  qc.mount();
  clients.push(qc);
  return qc;
}
/** A field action made on a screen, as useMutation would (onMutate is the screen's optimistic change). */
function tap(qc: QueryClient, key: string, variables: object, onMutate?: (v: never) => void) {
  return qc
    .getMutationCache()
    .build(qc, { mutationKey: [key], scope: FIELD_SCOPE, onMutate })
    .execute(variables)
    .then(
      () => "sent",
      () => "failed",
    );
}
/** Past the 800 ms save delay, with whatever requests are under way answered. */
const settle = (ms = 1_000) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  store.clear();
  room = Infinity;
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { onLine: true });
  vi.useFakeTimers();
  onlineManager.setOnline(true);
});

afterEach(async () => {
  onlineManager.setOnline(true);
  await vi.runOnlyPendingTimersAsync(); // let a pending connection check finish
  clients.splice(0).forEach((qc) => qc.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The server side of a visit status change, with the clock rules of fieldData.clockVisit (and no clock for a tap that says so). */
function fakeServer() {
  const s = { patches: [] as string[], entries: [] as Array<{ visit_id: string; started_at: string; ended_at: string | null }> };
  const setVisitStatus = async (v: { visitId: string; status: string; at: string; clock?: boolean }) => {
    await new Promise((r) => setTimeout(r, 5));
    s.patches.push(v.status);
    const action = v.clock === false ? null : v.status === "in_progress" ? "start" : v.status === "completed" ? "stop" : null;
    if (!action) return;
    for (const e of s.entries.filter((e) => e.ended_at === null)) {
      if (action === "start" && e.visit_id === v.visitId) return;
      if (e.started_at >= v.at) continue;
      e.ended_at = v.at;
    }
    if (action === "start") s.entries.push({ visit_id: v.visitId, started_at: v.at, ended_at: null });
  };
  return { s, setVisitStatus };
}

describe("restoring the saved queue", () => {
  it("sends each queued action once when the offline cache starts again (StrictMode, a remount, a new role)", async () => {
    const qc = newClient();
    const server = fakeServer();
    qc.setMutationDefaults(["visit-status"], { mutationFn: server.setVisitStatus });
    onlineManager.setOnline(false);
    let stop = startOfflineCache(qc, "u1", true);
    void tap(qc, "visit-status", { visitId: "v1", status: "en_route", at: "2026-10-17T13:00:00.000Z" });
    void tap(qc, "visit-status", { visitId: "v1", status: "in_progress", at: "2026-10-17T13:20:00.000Z" });
    void tap(qc, "visit-status", { visitId: "v1", status: "completed", at: "2026-10-17T15:20:00.000Z" });
    await settle();
    expect(saved("u1")!.mutations).toHaveLength(3);

    stop();
    stop = startOfflineCache(qc, "u1", true);
    stop();
    stop = startOfflineCache(qc, "u1", true);
    expect(pendingFieldActions(qc)).toBe(3);

    onlineManager.setOnline(true);
    await settle();
    expect(server.s.patches).toEqual(["en_route", "in_progress", "completed"]);
    // One two-hour entry on the timesheet, not two.
    expect(server.s.entries).toEqual([{ visit_id: "v1", started_at: "2026-10-17T13:20:00.000Z", ended_at: "2026-10-17T15:20:00.000Z" }]);
    expect(saved("u1")!.mutations).toHaveLength(0);
    stop();
  });

  it("keeps a sub's taps without a clock that way after the app closes and opens again (decided at the tap)", async () => {
    const before = newClient();
    before.setMutationDefaults(["visit-status"], { mutationFn: async () => undefined });
    onlineManager.setOnline(false);
    const stopBefore = startOfflineCache(before, "u11", true);
    for (const [status, at] of [["en_route", "2026-10-17T13:00:00.000Z"], ["in_progress", "2026-10-17T13:20:00.000Z"], ["completed", "2026-10-17T15:20:00.000Z"]]) {
      void tap(before, "visit-status", { visitId: "v1", status, at, clock: false });
    }
    await settle();
    stopBefore();
    before.clear();
    expect(saved("u11")!.mutations.map((m) => (m.state.variables as { clock?: boolean }).clock)).toEqual([false, false, false]);

    const qc = newClient();
    const server = fakeServer();
    qc.setMutationDefaults(["visit-status"], { mutationFn: server.setVisitStatus });
    onlineManager.setOnline(true);
    const stop = startOfflineCache(qc, "u11", true);
    await settle();
    expect(server.s.patches).toEqual(["en_route", "in_progress", "completed"]);
    expect(server.s.entries).toEqual([]);
    expect(saved("u11")!.mutations).toHaveLength(0);
    stop();
  });

  it("keeps the queue when the app signs the person out, and sends it once they sign back in", async () => {
    const qc = newClient();
    const sent: unknown[] = [];
    qc.setMutationDefaults(["visit-notes"], { mutationFn: async (v: unknown) => void sent.push(v) });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u2", true);
    qc.setQueryData(["field-visit", "v1"], { id: "v1", status: "in_progress" });
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();

    // SIGNED_OUT (an expired sign-in), sometimes twice in a row.
    keepQueuedFieldActions(qc, "u2");
    qc.clear();
    keepQueuedFieldActions(qc, "u2");
    stop();
    await settle();
    expect(saved("u2")).toMatchObject({ mutations: [{ state: { variables: { notes: "Gate was open" } } }], queries: [] });

    onlineManager.setOnline(true);
    const again = startOfflineCache(qc, "u2", true);
    await settle();
    expect(sent).toEqual([{ visitId: "v1", notes: "Gate was open" }]);
    expect(saved("u2")!.mutations).toHaveLength(0);
    again();
  });

  it("keeps actions turned away because the sign-in expired, and sends each once after the person signs back in", async () => {
    const qc = newClient();
    // Signed out everywhere from another device: the API turns this phone's sign-in away, refreshed or not.
    let signedIn = false;
    const tries: string[] = [];
    const sent: string[] = [];
    qc.setMutationDefaults(["visit-notes"], {
      mutationFn: async (v: { notes: string }) => {
        tries.push(v.notes);
        if (!signedIn) throw new ApiError("Your session has expired. Sign in again.", 401, SESSION_EXPIRED);
        sent.push(v.notes);
      },
    });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u8", true);
    const first = tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    const second = tap(qc, "visit-notes", { visitId: "v1", notes: "Dog in the yard" });
    onlineManager.setOnline(true);
    await settle();
    // Each fails (so the app signs them out, lib/queryClient.ts) but still counts as waiting to send.
    await expect(first).resolves.toBe("failed");
    await expect(second).resolves.toBe("failed");
    expect(pendingFieldActions(qc)).toBe(2);

    // SIGNED_OUT from the app.
    keepQueuedFieldActions(qc, "u8");
    qc.clear();
    stop();
    await settle(60_000);
    expect(tries).toEqual(["Gate was open", "Dog in the yard"]); // not tried again while signed out
    expect(saved("u8")).toMatchObject({ mutations: [{ state: { variables: { notes: "Gate was open" } } }, { state: { variables: { notes: "Dog in the yard" } } }], queries: [] });

    signedIn = true;
    const again = startOfflineCache(qc, "u8", true);
    await settle();
    expect(sent).toEqual(["Gate was open", "Dog in the yard"]);
    expect(tries).toHaveLength(4);
    expect(saved("u8")!.mutations).toHaveLength(0);
    again();
  });

  it("forgets everything when the person signs out, even with a save due", async () => {
    const qc = newClient();
    store.set("crewtavo.me.u3", JSON.stringify({ email: "u3@example.com", companies: [] }));
    startOfflineCache(qc, "u3", true);
    qc.setQueryData(["field-visit", "v1"], { id: "v1", status: "scheduled" });
    await settle();
    qc.setQueryData(["field-visit", "v1"], { id: "v1", status: "en_route" });
    forgetOfflineCache("u3");
    qc.clear();
    await settle();
    expect(store.size).toBe(0);
  });
});

describe("saving the queue", () => {
  it("past the 2 MB budget, still saves the queue (without cached screens), so sent actions don't come back", async () => {
    const qc = newClient();
    let sent = 0;
    qc.setMutationDefaults(["visit-notes"], { mutationFn: async () => void sent++ });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u4", true);
    qc.setQueryData(["field", "c1", "2026-10-17"], { today: [] });
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();
    expect(saved("u4")!.queries).toHaveLength(1);

    // Big visits (checklists with drawn signatures) push the cached screens past the budget.
    qc.setQueryData(["checklist", "v9"], { blob: "x".repeat(2_100_000) });
    await settle();
    expect(saved("u4")).toMatchObject({ mutations: [{ state: { variables: { notes: "Gate was open" } } }], queries: [] });

    onlineManager.setOnline(true);
    await settle();
    expect(sent).toBe(1);
    expect(saved("u4")!.mutations).toHaveLength(0);
    stop();

    // The next time the app opens on this phone.
    const next = newClient();
    next.setMutationDefaults(["visit-notes"], { mutationFn: async () => void sent++ });
    const stopNext = startOfflineCache(next, "u4", true);
    await settle();
    expect(sent).toBe(1);
    stopNext();
  });

  it("with storage full, saves the queue alone, and if even that won't fit, drops the old copy", async () => {
    const qc = newClient();
    let sent = 0;
    qc.setMutationDefaults(["visit-notes"], { mutationFn: async () => void sent++ });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u5", true);
    qc.setQueryData(["field-visit", "v1"], { id: "v1", notes: "x".repeat(5_000) });
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();
    expect(saved("u5")!.queries).toHaveLength(1);

    room = 1_000;
    qc.setQueryData(["field-visit", "v1"], { id: "v1", notes: "y".repeat(5_000) });
    await settle();
    expect(saved("u5")).toMatchObject({ mutations: [{ state: { variables: { notes: "Gate was open" } } }], queries: [] });

    room = 10;
    onlineManager.setOnline(true);
    await settle();
    expect(sent).toBe(1);
    expect(saved("u5")).toBeNull();
    stop();
  });
});

describe("weak signal", () => {
  it("a field action that can't reach the server, though the phone says it's online, waits and goes out once requests get through", async () => {
    const qc = newClient();
    let reachable = false;
    const sent: unknown[] = [];
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async (v: unknown) => {
        if (!reachable) throw new ApiError(OFFLINE, 0, "network");
        sent.push(v);
      },
    });
    const check = vi.fn(async () => {
      if (!reachable) throw new TypeError("Failed to fetch");
      return new Response("{}");
    });
    vi.stubGlobal("fetch", check);
    const stop = startOfflineCache(qc, "u6", true);
    qc.setQueryData(["field-visit", "v1"], { id: "v1", status: "scheduled" });
    const result = tap(qc, "visit-status", { visitId: "v1", status: "in_progress", at: "2026-10-17T13:20:00.000Z" }, (v: { status: string }) =>
      qc.setQueryData(["field-visit", "v1"], (old: object) => ({ ...old, status: v.status })),
    );
    await settle(1_500);

    const [action] = qc.getMutationCache().getAll();
    expect(action!.state).toMatchObject({ status: "pending", isPaused: true });
    expect(onlineManager.isOnline()).toBe(false); // so later taps queue too
    expect(pendingFieldActions(qc)).toBe(1);
    expect(saved("u6")!.mutations).toHaveLength(1);

    await settle(10_000);
    expect(check).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(action!.state.status).toBe("pending");

    reachable = true;
    await settle(31_000);
    expect(onlineManager.isOnline()).toBe(true);
    await expect(result).resolves.toBe("sent");
    expect(sent).toHaveLength(1);
    expect(qc.getQueryData(["field-visit", "v1"])).toMatchObject({ status: "in_progress" });
    expect(saved("u6")!.mutations).toHaveLength(0);
    stop();
  });

  it("an action that fails again while a check is out (the signal flickering) doesn't put the next check off", async () => {
    const qc = newClient();
    let reachable = true;
    const sent: unknown[] = [];
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async (v: unknown) => {
        if (!reachable) throw new ApiError(OFFLINE, 0, "network");
        sent.push(v);
      },
    });
    // Each check takes 5 seconds to fail (or get through).
    const checks: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        checks.push(Date.now());
        await new Promise((r) => setTimeout(r, 5_000));
        if (!reachable) throw new TypeError("Failed to fetch");
        return new Response("{}");
      }),
    );
    const stop = startOfflineCache(qc, "u11", true);
    // One goes out, so the checks start from the shortest wait; then the signal goes.
    await expect(tap(qc, "visit-status", { visitId: "v1", status: "en_route", at: "2026-10-17T13:00:00.000Z" })).resolves.toBe("sent");
    reachable = false;
    const failed = Date.now();
    const result = tap(qc, "visit-status", { visitId: "v1", status: "in_progress", at: "2026-10-17T13:20:00.000Z" });
    await settle(2_100);
    expect(checks).toEqual([failed + 2_000]);

    // While that check is out, the phone says it has signal again: the action goes, and fails again.
    onlineManager.setOnline(true);
    await settle(100);
    expect(onlineManager.isOnline()).toBe(false);
    // The check fails 5 seconds in, and the next is 4 seconds after that, as with no flicker.
    await settle(9_000);
    expect(checks).toEqual([failed + 2_000, failed + 11_000]);

    reachable = true;
    await settle(31_000);
    await expect(result).resolves.toBe("sent");
    expect(sent).toHaveLength(2);
    stop();
  });

  it("a refusal from the server still fails, isn't retried, and what the screen showed ahead of it is undone", async () => {
    const qc = newClient();
    let calls = 0;
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async () => {
        calls++;
        throw new ApiError("The office cancelled this visit.", 409);
      },
    });
    const stop = startOfflineCache(qc, "u7", true);
    const screen = new QueryObserver(qc, { queryKey: ["field-visit", "v1"], queryFn: async () => ({ id: "v1", status: "scheduled" }) });
    const unsubscribe = screen.subscribe(() => undefined);
    await settle();

    // No onSettled refresh, like an action restored after a restart.
    const result = tap(qc, "visit-status", { visitId: "v1", status: "in_progress", at: "2026-10-17T13:20:00.000Z" }, (v: { status: string }) =>
      qc.setQueryData(["field-visit", "v1"], (old: object) => ({ ...old, status: v.status })),
    );
    await settle();
    await expect(result).resolves.toBe("failed");
    expect(calls).toBe(1);
    expect(onlineManager.isOnline()).toBe(true);
    expect(qc.getQueryData(["field-visit", "v1"])).toEqual({ id: "v1", status: "scheduled" });
    expect(pendingFieldActions(qc)).toBe(0);
    expect(saved("u7")!.mutations).toHaveLength(0);
    expect(saved("u7")!.queries.find((q) => q.queryKey[0] === "field-visit")!.state.data.status).toBe("scheduled");
    unsubscribe();
    stop();
  });

  it.each([
    ["notes, through the API (Railway's proxy answers 502)", "visit-notes", () => {
      throw new ApiError("Something went wrong on our end. Try again in a moment.", 502);
    }],
    ["a checklist, through the gateway to the database (503 while it starts)", "checklist-save", () => {
      unwrap({ data: null, error: { message: "This part of Crewtavo is still starting. Try again in a moment." }, status: 503 });
    }],
  ])("%s, sent while the server restarts, waits and goes out once the server answers again", async (_, key, restarting) => {
    const qc = newClient();
    let up = false;
    let tries = 0;
    const sent: unknown[] = [];
    qc.setMutationDefaults([key], {
      mutationFn: async (v: unknown) => {
        tries++;
        if (!up) restarting();
        sent.push(v);
      },
    });
    // The proxy answers for the server until it's back.
    const check = vi.fn(async () => new Response("{}", { status: up ? 200 : 504 }));
    vi.stubGlobal("fetch", check);
    const stop = startOfflineCache(qc, "u9", true);
    const result = tap(qc, key, { visitId: "v1" });
    await settle(1_500);

    const [action] = qc.getMutationCache().getAll();
    expect(action!.state).toMatchObject({ status: "pending", isPaused: true });
    expect(onlineManager.isOnline()).toBe(false);
    expect(saved("u9")!.mutations).toHaveLength(1);

    await settle(10_000);
    expect(check.mock.calls.length).toBeGreaterThan(1);
    // The proxy's answer isn't the server's: the action isn't sent into it again at each check.
    expect(onlineManager.isOnline()).toBe(false);
    expect(tries).toBe(1);
    expect(sent).toHaveLength(0);

    up = true;
    await settle(31_000);
    expect(onlineManager.isOnline()).toBe(true);
    await expect(result).resolves.toBe("sent");
    expect(sent).toHaveLength(1);
    expect(saved("u9")!.mutations).toHaveLength(0);
    stop();
  });

  it("any other server error is final, and isn't sent again", async () => {
    const qc = newClient();
    let calls = 0;
    qc.setMutationDefaults(["visit-notes"], {
      mutationFn: async () => {
        calls++;
        throw new ApiError("Something went wrong on our end. Try again in a moment.", 500);
      },
    });
    const stop = startOfflineCache(qc, "u10", true);
    const result = tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle(60_000);
    await expect(result).resolves.toBe("failed");
    expect(calls).toBe(1);
    expect(onlineManager.isOnline()).toBe(true);
    expect(saved("u10")!.mutations).toHaveLength(0);
    stop();
  });
});

describe("when it was done", () => {
  it("sends a Complete tapped with no signal, after the app was closed, dated when it was tapped", async () => {
    vi.setSystemTime(new Date("2026-10-17T14:00:00.000Z"));
    const before = newClient();
    before.setMutationDefaults(["visit-status"], { mutationFn: setVisitStatus });
    onlineManager.setOnline(false);
    const stopBefore = startOfflineCache(before, "u12", true);
    void tap(before, "visit-status", { companyId: "company-a", userId: "u12", visitId: "v1", jobId: null, status: "completed", at: new Date().toISOString(), clock: false });
    await settle();
    stopBefore();
    before.clear();

    // Signal again hours later, on a fresh start of the app.
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") sent.push(JSON.parse(String(init.body)));
        return new Response("{}");
      }),
    );
    vi.setSystemTime(new Date("2026-10-17T20:00:00.000Z"));
    const qc = newClient();
    qc.setMutationDefaults(["visit-status"], { mutationFn: setVisitStatus });
    onlineManager.setOnline(true);
    const stop = startOfflineCache(qc, "u12", true);
    await settle();
    expect(sent).toEqual([{ status: "completed", forward_only: true, completed_at: "2026-10-17T14:00:00.000Z" }]);
    expect(saved("u12")!.mutations).toHaveLength(0);
    stop();
  });
});

describe("company", () => {
  it("sends a field action as the company it was made in, even after switching company", async () => {
    const sentAs: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentAs.push((init.headers as Record<string, string>)["X-Company-Id"]);
        return new Response("{}");
      }),
    );
    setActiveCompany("company-b");
    await setVisitStatus({ companyId: "company-a", userId: "u1", visitId: "v1", jobId: null, status: "en_route", at: "2026-10-17T13:00:00.000Z" });
    await saveVisitNotes({ companyId: "company-a", visitId: "v1", notes: "Gate code changed" });
    // Notes queued before they recorded their company, and everything else, go as the company on screen.
    await saveVisitNotes({ visitId: "v1", notes: "Side gate" });
    await api.get("/me");
    expect(sentAs).toEqual(["company-a", "company-a", "company-b", "company-b"]);
    setActiveCompany(null);
  });
});

describe("back on the screen", () => {
  it("with requests not getting through, checks again as soon as the app is opened, not after the wait, and sends what's queued", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const show = (state: DocumentVisibilityState) => {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    const qc = newClient();
    let reachable = false;
    const sent: unknown[] = [];
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async (v: unknown) => {
        if (!reachable) throw new ApiError(OFFLINE, 0, "network");
        sent.push(v);
      },
    });
    const check = vi.fn(async () => {
      if (!reachable) throw new TypeError("Failed to fetch");
      return new Response("{}");
    });
    vi.stubGlobal("fetch", check);
    const stop = startOfflineCache(qc, "u20", true);
    const result = tap(qc, "visit-status", { visitId: "v1", status: "completed", at: "2026-10-17T15:20:00.000Z" });
    // Put away for two minutes: by then the checks are 30 seconds apart.
    show("hidden");
    await settle(120_000);
    expect(onlineManager.isOnline()).toBe(false);
    const checks = check.mock.calls.length;

    reachable = true;
    show("visible");
    await settle(50);
    expect(check).toHaveBeenCalledTimes(checks + 1);
    expect(onlineManager.isOnline()).toBe(true);
    await expect(result).resolves.toBe("sent");
    expect(sent).toHaveLength(1);
    stop();
  });

  it("doesn't check when the phone knows it has no signal (its online event brings the app back)", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    vi.stubGlobal("navigator", { onLine: false });
    const check = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", check);
    const qc = newClient();
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u21", true);
    page.dispatchEvent(new Event("visibilitychange"));
    await settle(50);
    expect(check).not.toHaveBeenCalled();
    expect(onlineManager.isOnline()).toBe(false);
    stop();
  });
});

describe("closed with updates waiting", () => {
  /** The phone's service worker registration: with Background Sync (Android) or without (iPhone). */
  function phone({ backgroundSync }: { backgroundSync: boolean }) {
    const caches = new FakeCaches();
    const register = vi.fn(async (_tag: string) => undefined);
    const close = vi.fn();
    const registration = { ...(backgroundSync ? { sync: { register } } : {}), getNotifications: vi.fn(async () => [{ close }]) };
    vi.stubGlobal("caches", caches);
    vi.stubGlobal("navigator", { onLine: true, serviceWorker: { getRegistration: async () => registration } });
    return { caches, register, close, waiting: () => caches.entries(WAITING_CACHE) };
  }

  it("on Android, asks to hear when there's signal, and tells the worker how many wait; once sent, takes its notice down", async () => {
    const { register, close, waiting, caches } = phone({ backgroundSync: true });
    const qc = newClient();
    const server = fakeServer();
    qc.setMutationDefaults(["visit-status"], { mutationFn: server.setVisitStatus });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u30", true);
    void tap(qc, "visit-status", { visitId: "v1", status: "en_route", at: "2026-10-17T13:00:00.000Z" });
    void tap(qc, "visit-status", { visitId: "v1", status: "in_progress", at: "2026-10-17T13:20:00.000Z" });
    await settle();
    expect(register).toHaveBeenCalledWith(SYNC_TAG);
    expect(waiting()).toEqual({ "/waiting/u30": "2" });

    // The app closed here: the worker, woken by the signal coming back, says so.
    const sw = loadServiceWorker({ caches });
    await sw.dispatch("sync", { tag: SYNC_TAG });
    expect(sw.showNotification.mock.calls[0]![1]).toMatchObject({ body: "2 updates are waiting to be sent. Open Crewtavo to send them." });

    // Opened again with signal: the queue goes out and the notice goes.
    onlineManager.setOnline(true);
    await settle();
    expect(server.s.patches).toEqual(["en_route", "in_progress"]);
    expect(waiting()).toEqual({});
    expect(close).toHaveBeenCalled();
    stop();
  });

  it("put away with updates still waiting, asks again, in case the earlier signal came while the app was open", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const { register } = phone({ backgroundSync: true });
    const qc = newClient();
    qc.setMutationDefaults(["visit-notes"], { mutationFn: async () => undefined });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u31", true);
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();
    expect(register).toHaveBeenCalledTimes(1);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(register).toHaveBeenCalledTimes(2);
    stop();
  });

  it("with signal, an update on its way isn't waiting: no wake-up or notice for it, even if the app is put away meanwhile", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const show = (state: DocumentVisibilityState) => {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    const { register, waiting, caches } = phone({ backgroundSync: true });
    const qc = newClient();
    const sent: string[] = [];
    // A slow connection: each takes 3 seconds to go out.
    qc.setMutationDefaults(["visit-notes"], {
      mutationFn: async (v: { notes: string }) => {
        await new Promise((r) => setTimeout(r, 3_000));
        sent.push(v.notes);
      },
    });
    const stop = startOfflineCache(qc, "u34", true);
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle(); // past the save delay, still on its way
    show("hidden");
    await settle(100);
    // Saved, in case the app is closed before it's sent, but nothing to tell the worker.
    expect(saved("u34")!.mutations).toHaveLength(1);
    expect(register).not.toHaveBeenCalled();
    expect(waiting()).toEqual({});
    const sw = loadServiceWorker({ caches });
    await sw.dispatch("sync", { tag: SYNC_TAG });
    expect(sw.showNotification).not.toHaveBeenCalled();
    await settle(3_000);
    expect(sent).toEqual(["Gate was open"]);
    expect(register).not.toHaveBeenCalled();

    // Two at once: the one behind hasn't left the phone, so it counts until its turn comes.
    show("visible");
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Dog in the yard" });
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Side gate" });
    await settle();
    expect(waiting()).toEqual({ "/waiting/u34": "1" });
    await settle(6_000);
    expect(sent).toEqual(["Gate was open", "Dog in the yard", "Side gate"]);
    expect(waiting()).toEqual({});
    stop();
  });

  it("put away right after an update couldn't get through, the worker already knows it's waiting", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const show = (state: DocumentVisibilityState) => {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    const { register, waiting } = phone({ backgroundSync: true });
    let reachable = false;
    vi.stubGlobal("fetch", vi.fn(async () => (reachable ? new Response("{}") : Promise.reject(new TypeError("Failed to fetch")))));
    const qc = newClient();
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async () => {
        if (!reachable) throw new ApiError(OFFLINE, 0, "network");
      },
    });
    const stop = startOfflineCache(qc, "u35", true);
    const result = tap(qc, "visit-status", { visitId: "v1", status: "completed", at: "2026-10-17T15:20:00.000Z" });
    await settle(10);
    // Into the pocket while it waits to try again.
    show("hidden");
    await settle(10);
    expect(register).toHaveBeenCalledWith(SYNC_TAG);
    expect(waiting()).toEqual({ "/waiting/u35": "1" });

    reachable = true;
    show("visible");
    await settle(2_000);
    await expect(result).resolves.toBe("sent");
    expect(waiting()).toEqual({});
    stop();
  });

  it("put away with no signal, and the signal back while it's still in a pocket: nothing goes until it's on the screen, so the worker says it's waiting", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const show = (state: DocumentVisibilityState) => {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    const { register, close, waiting, caches } = phone({ backgroundSync: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const qc = newClient();
    const sent: string[] = [];
    qc.setMutationDefaults(["visit-status"], { mutationFn: async (v: { status: string }) => void sent.push(v.status) });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u36", true);
    const result = tap(qc, "visit-status", { visitId: "v1", status: "completed", at: "2026-10-17T15:20:00.000Z" });
    await settle();
    show("hidden");
    await settle(100);
    expect(register).toHaveBeenCalledWith(SYNC_TAG);

    // Driving back into coverage, the phone still in a pocket: React Query sends nothing from a hidden page.
    onlineManager.setOnline(true);
    await settle(60_000);
    expect(sent).toEqual([]);
    expect(waiting()).toEqual({ "/waiting/u36": "1" });
    // The browser wakes the worker. Crewtavo's window is there, but put away.
    const sw = loadServiceWorker({ caches, windows: [{ url: "https://crew.example.com/field", visibilityState: "hidden" }] });
    await expect(sw.dispatch("sync", { tag: SYNC_TAG })).resolves.toBe("done");
    expect(sw.showNotification.mock.calls[0]![1]).toMatchObject({ body: "1 update is waiting to be sent. Open Crewtavo to send them." });

    // Tapping it brings Crewtavo back on the screen (React Query's own listener hears it in a browser): it goes, and the notice goes.
    show("visible");
    focusManager.onFocus();
    await settle();
    await expect(result).resolves.toBe("sent");
    expect(sent).toEqual(["completed"]);
    expect(waiting()).toEqual({});
    expect(close).toHaveBeenCalled();
    stop();
  });

  it("opened again with signal, an update put back from the phone goes at once: not waiting, no wake-up, even put away (or closed) before the answer", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const show = (state: DocumentVisibilityState) => {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    const { register, waiting, caches } = phone({ backgroundSync: true });
    // Earlier: tapped with no signal, then the app was closed.
    const before = newClient();
    before.setMutationDefaults(["visit-notes"], { mutationFn: async () => undefined });
    onlineManager.setOnline(false);
    const stopBefore = startOfflineCache(before, "u37", true);
    void tap(before, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();
    stopBefore();
    before.clear();
    expect(waiting()).toEqual({ "/waiting/u37": "1" });
    register.mockClear();

    // Opened again with signal, on a slow connection: each request takes 3 seconds.
    onlineManager.setOnline(true);
    const qc = newClient();
    const sent: string[] = [];
    qc.setMutationDefaults(["visit-notes"], {
      mutationFn: async (v: { notes: string }) => {
        await new Promise((r) => setTimeout(r, 3_000));
        sent.push(v.notes);
      },
    });
    const stop = startOfflineCache(qc, "u37", true);
    // Swiped away straight after opening, or put away mid-send: the worker has nothing to say about it.
    await settle(10);
    expect(waiting()).toEqual({});
    show("hidden");
    await settle(100);
    expect(waiting()).toEqual({});
    expect(register).not.toHaveBeenCalled();
    const sw = loadServiceWorker({ caches });
    await sw.dispatch("sync", { tag: SYNC_TAG });
    expect(sw.showNotification).not.toHaveBeenCalled();
    // Still saved, in case the app is closed before the answer: it goes again on the next start.
    expect(saved("u37")!.mutations).toHaveLength(1);
    await settle(4_000);
    expect(sent).toEqual(["Gate was open"]);
    expect(saved("u37")!.mutations).toHaveLength(0);
    stop();
  });

  it("opened with no signal and put away, an update put back from the phone goes when the signal comes, off the count as it goes; a notice shown just then is taken down once it's through", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const { close, waiting, caches } = phone({ backgroundSync: true });
    // Earlier: tapped with no signal, then the app was closed.
    const before = newClient();
    before.setMutationDefaults(["visit-notes"], { mutationFn: async () => undefined });
    onlineManager.setOnline(false);
    const stopBefore = startOfflineCache(before, "u39", true);
    void tap(before, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();
    stopBefore();
    before.clear();

    // Opened again, still with no signal, and put away.
    const qc = newClient();
    const sent: string[] = [];
    qc.setMutationDefaults(["visit-notes"], {
      mutationFn: async (v: { notes: string }) => {
        await new Promise((r) => setTimeout(r, 3_000));
        sent.push(v.notes);
      },
    });
    const stop = startOfflineCache(qc, "u39", true);
    await settle();
    expect(waiting()).toEqual({ "/waiting/u39": "1" });
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    await settle(100);

    // The signal comes back with the phone in a pocket: React Query sends the one put back even so,
    // and the worker, woken by the same signal, finds nothing waiting.
    onlineManager.setOnline(true);
    await settle(10);
    expect(waiting()).toEqual({});
    const sw = loadServiceWorker({ caches, windows: [{ url: "https://crew.example.com/field", visibilityState: "hidden" }] });
    await sw.dispatch("sync", { tag: SYNC_TAG });
    expect(sw.showNotification).not.toHaveBeenCalled();

    // Had the worker read the count first and said it was waiting, that notice goes once it's sent.
    close.mockClear();
    await settle(4_000);
    expect(sent).toEqual(["Gate was open"]);
    expect(close).toHaveBeenCalled();
    stop();
  });

  /** Tapped with no signal, then the app closed: one update saved on the phone for `userId`. */
  async function savedFromEarlier(userId: string) {
    const before = newClient();
    before.setMutationDefaults(["visit-status"], { mutationFn: async () => undefined });
    onlineManager.setOnline(false);
    const stopBefore = startOfflineCache(before, userId, true);
    void tap(before, "visit-status", { visitId: "v1", status: "completed", at: "2026-10-17T15:20:00.000Z" });
    await settle();
    stopBefore();
    before.clear();
  }

  it("the same when the server turns the update down: the notice shown as it went is taken down too", async () => {
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "hidden" as DocumentVisibilityState }));
    const { close, waiting } = phone({ backgroundSync: true });
    await savedFromEarlier("u40");
    const qc = newClient();
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async () => {
        await new Promise((r) => setTimeout(r, 3_000));
        throw new ApiError("The office cancelled this visit.", 409, "conflict");
      },
    });
    const stop = startOfflineCache(qc, "u40", true);
    await settle();
    onlineManager.setOnline(true);
    await settle(10);
    expect(waiting()).toEqual({});
    close.mockClear();
    await settle(4_000);
    expect(close).toHaveBeenCalled();
    expect(waiting()).toEqual({});
    stop();
  });

  it("put away, an update that fails as it goes counts as waiting again at once, not after the next save", async () => {
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "hidden" as DocumentVisibilityState }));
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const { register, waiting } = phone({ backgroundSync: true });
    await savedFromEarlier("u41");
    const qc = newClient();
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async () => {
        await new Promise((r) => setTimeout(r, 50));
        throw new ApiError(OFFLINE, 0, "network"); // the network changing as the signal comes back
      },
    });
    const stop = startOfflineCache(qc, "u41", true);
    await settle();
    register.mockClear();
    onlineManager.setOnline(true);
    await settle(10);
    expect(waiting()).toEqual({});
    await settle(60); // failed, well within the 800 ms save delay
    expect(waiting()).toEqual({ "/waiting/u41": "1" });
    expect(register).toHaveBeenCalledWith(SYNC_TAG);
    stop();
  });

  it("on the screen, sending a backlog doesn't wake the worker for each one", async () => {
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }));
    const { register, waiting } = phone({ backgroundSync: true });
    const qc = newClient();
    const sent: string[] = [];
    qc.setMutationDefaults(["visit-notes"], {
      mutationFn: async (v: { notes: string }) => {
        await new Promise((r) => setTimeout(r, 100));
        sent.push(v.notes);
      },
    });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u42", true);
    for (const notes of ["one", "two", "three", "four", "five"]) void tap(qc, "visit-notes", { visitId: "v1", notes });
    await settle();
    expect(waiting()).toEqual({ "/waiting/u42": "5" });
    register.mockClear();
    onlineManager.setOnline(true);
    await settle(2_000);
    expect(sent).toEqual(["one", "two", "three", "four", "five"]);
    expect(waiting()).toEqual({});
    expect(register).not.toHaveBeenCalled();
    stop();
  });

  it("an update waiting to try again still counts while the phone says it has signal and My day reloads, so put away and closed then, the worker says so", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const show = (state: DocumentVisibilityState) => {
      page.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    };
    const { register, waiting, caches } = phone({ backgroundSync: true });
    // One bar: nothing gets through, though the phone keeps saying it's online.
    let reachable = false;
    vi.stubGlobal("fetch", vi.fn(async () => (reachable ? new Response("{}") : Promise.reject(new TypeError("Failed to fetch")))));
    const qc = newClient();
    const sent: unknown[] = [];
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async (v: unknown) => {
        if (!reachable) throw new ApiError(OFFLINE, 0, "network");
        sent.push(v);
      },
    });
    // My day on the screen: it loads again when the connection comes back.
    const screen = new QueryObserver(qc, { queryKey: ["field", "c1", "2026-10-17"], queryFn: async () => ({ today: [] }) });
    const unsubscribe = screen.subscribe(() => undefined);
    const stop = startOfflineCache(qc, "u38", true);
    void tap(qc, "visit-status", { visitId: "v1", status: "completed", at: "2026-10-17T15:20:00.000Z" });
    await settle(1_500);
    // The phone's online event: it tries again, fails again, and waits 2 seconds before its next try.
    onlineManager.setOnline(true);
    await settle(10);
    // The phone's online event again during that wait: My day reloads, and the count is saved again.
    onlineManager.setOnline(true);
    await settle(1_000);
    const [action] = qc.getMutationCache().getAll();
    expect(action!.state).toMatchObject({ status: "pending", isPaused: false });
    expect(sent).toEqual([]);
    expect(waiting()).toEqual({ "/waiting/u38": "1" });

    // Put away, then swiped away before that try: the worker says it's waiting.
    register.mockClear();
    show("hidden");
    await settle(10);
    expect(register).toHaveBeenCalledWith(SYNC_TAG);
    const sw = loadServiceWorker({ caches });
    await sw.dispatch("sync", { tag: SYNC_TAG });
    expect(sw.showNotification.mock.calls[0]![1]).toMatchObject({ body: "1 update is waiting to be sent. Open Crewtavo to send them." });

    // Or back on the screen in time, with requests getting through: it goes.
    reachable = true;
    show("visible");
    await settle(2_000);
    expect(sent).toHaveLength(1);
    expect(waiting()).toEqual({});
    unsubscribe();
    stop();
  });

  it("put away while an update's next try is on its way, counts again first: nothing left waiting, so no wake-up for it", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const { register, waiting, caches } = phone({ backgroundSync: true });
    let reachable = false;
    vi.stubGlobal("fetch", vi.fn(async () => (reachable ? new Response("{}") : Promise.reject(new TypeError("Failed to fetch")))));
    const qc = newClient();
    const sent: unknown[] = [];
    qc.setMutationDefaults(["visit-status"], {
      mutationFn: async (v: unknown) => {
        if (!reachable) throw new ApiError(OFFLINE, 0, "network");
        await new Promise((r) => setTimeout(r, 3_000)); // a slow connection
        sent.push(v);
      },
    });
    const stop = startOfflineCache(qc, "u39", true);
    void tap(qc, "visit-status", { visitId: "v1", status: "completed", at: "2026-10-17T15:20:00.000Z" });
    await settle(1_500);
    // Failed again on the phone's online event, and counted while it waits 2 seconds for its next try.
    onlineManager.setOnline(true);
    await settle(10);
    onlineManager.setOnline(true);
    await settle(1_000);
    expect(waiting()).toEqual({ "/waiting/u39": "1" });

    // Requests get through now: the next try goes out (React Query says nothing when it does).
    reachable = true;
    await settle(1_100);
    expect(sent).toEqual([]);
    register.mockClear();
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    await settle(10);
    expect(waiting()).toEqual({});
    expect(register).not.toHaveBeenCalled();
    // Closed before the answer: the worker has nothing to say (it's saved, and goes again on the next start).
    const sw = loadServiceWorker({ caches });
    await sw.dispatch("sync", { tag: SYNC_TAG });
    expect(sw.showNotification).not.toHaveBeenCalled();
    expect(saved("u39")!.mutations).toHaveLength(1);
    await settle(3_000);
    expect(sent).toHaveLength(1);
    stop();
  });

  it("on an iPhone (no Background Sync), nothing breaks and the queue goes out when the app is open with signal", async () => {
    const { waiting } = phone({ backgroundSync: false });
    const qc = newClient();
    const server = fakeServer();
    qc.setMutationDefaults(["visit-status"], { mutationFn: server.setVisitStatus });
    onlineManager.setOnline(false);
    const stop = startOfflineCache(qc, "u32", true);
    const result = tap(qc, "visit-status", { visitId: "v1", status: "en_route", at: "2026-10-17T13:00:00.000Z" });
    await settle();
    expect(waiting()).toEqual({ "/waiting/u32": "1" });
    onlineManager.setOnline(true);
    await settle();
    await expect(result).resolves.toBe("sent");
    expect(waiting()).toEqual({});
    stop();
  });

  it("forgets the count with the queue when the person signs out, and keeps it when the app signs them out", async () => {
    const { waiting } = phone({ backgroundSync: true });
    const qc = newClient();
    qc.setMutationDefaults(["visit-notes"], { mutationFn: async () => undefined });
    onlineManager.setOnline(false);
    startOfflineCache(qc, "u33", true);
    void tap(qc, "visit-notes", { visitId: "v1", notes: "Gate was open" });
    await settle();
    keepQueuedFieldActions(qc, "u33");
    await settle();
    expect(waiting()).toEqual({ "/waiting/u33": "1" });
    forgetOfflineCache("u33");
    await settle();
    expect(waiting()).toEqual({});
  });
});

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

describe("signing out", () => {
  // A plain auth.signOut() counts as the app signing the person out (lib/session.tsx), which keeps
  // their queued field actions on the phone. Sign out buttons use the session's signOut instead.
  it("on purpose, from any screen (the license, setting up a business, choosing a password), leaves nothing of theirs on the phone", () => {
    const callers = sources(SRC).filter((file) => /\.auth\s*\.signOut\(/.test(readFileSync(file, "utf8")));
    expect(callers.map((file) => relative(SRC, file).replaceAll("\\", "/"))).toEqual(["lib/session.tsx"]);
  });
});

describe("screens", () => {
  /** What each useMutation({ ... }) in a file is given, up to its closing brace. */
  const mutationOptions = (text: string) =>
    [...text.matchAll(/\buseMutation(?:<[^;()]*?>)?\(\{/g)].map((call) => {
      let depth = 0;
      for (let i = call.index + call[0].length - 1; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) return text.slice(call.index, i + 1);
      }
      return text.slice(call.index);
    });

  it("send field actions with the function registered for them, which knows when each is on its way (for the count the worker reads)", () => {
    const field = new RegExp(`mutationKey: \\["(${[...OFFLINE_MUTATIONS].join("|")})"\\]`);
    const found: string[] = [];
    for (const file of sources(SRC)) {
      for (const options of mutationOptions(readFileSync(file, "utf8"))) {
        if (!field.test(options)) continue;
        found.push(`${relative(SRC, file).replaceAll("\\", "/")} ${options.match(field)![1]}`);
        expect(options, relative(SRC, file)).not.toMatch(/\bmutationFn\b/);
      }
    }
    expect(found.sort()).toEqual(["features/field/FieldTodayPage.tsx visit-status", "features/field/FieldVisitPage.tsx checklist-save", "features/field/FieldVisitPage.tsx visit-notes", "features/field/FieldVisitPage.tsx visit-status"]);
  });
});

describe("whose day is kept", () => {
  it("keeps My day on the phone for crew leads, field crew and subs, and not for the office", () => {
    expect(ROLES.filter(keepsDayOffline)).toEqual(["crew_lead", "field_crew", "subcontractor"]);
  });
});
