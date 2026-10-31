/**
 * The crew's day on the phone, for job sites with no signal. What My day and a visit show is kept
 * in this browser's storage, and field actions (on my way, start, complete, checklist, notes) made
 * offline wait in order and go out when the connection is back, even if the app was closed in
 * between. Those screens are kept for crews and subs (OFFLINE_LEVELS), and a sub's My jobs too (only
 * to read: answering an offer needs signal). Office screens aren't kept:
 * they hold prices and client details that don't belong on a crew phone. Cleared when the person signs
 * out; when the app signs them out (an expired sign-in), only their unsent field actions are kept,
 * for when they sign back in.
 *
 * They go out while Crewtavo is on the screen: as it opens, when the connection is back, and when it
 * comes back on the screen. Put away, one already waiting there waits (React Query carries on with a
 * paused action only on a visible page), though one put back from the phone's storage goes once
 * there's signal; closed, nothing sends them (that would take the person's sign-in in the service
 * worker). Where the phone has Background Sync (Android), the service worker says how many are
 * waiting once there's signal (tellServiceWorker).
 */
import type { Role } from "@crewtavo/core/roles";
import { dehydrate, hydrate, onlineManager, type DehydratedState, type Mutation, type MutationFunction, type QueryClient } from "@tanstack/react-query";
import { ApiError, isAuthError, isNetworkError, isRestarting, SESSION_EXPIRED } from "./errors";

// React Query assumes it's online until it hears otherwise; a phone that opens the app with no
// signal is offline from the start, so field actions queue instead of failing.
if (typeof navigator !== "undefined" && navigator.onLine === false) onlineManager.setOnline(false);

const VERSION = 1;
/** Whose My day is kept on the phone: the people out on job sites, subs included. */
export const OFFLINE_LEVELS: readonly Role[] = ["crew_lead", "field_crew", "subcontractor"];
export const keepsDayOffline = (role: string) => (OFFLINE_LEVELS as readonly string[]).includes(role);
/** Queries worth having with no signal. */
const KEEP = new Set(["field", "field-visit", "field-jobs", "checklist", "running-timer", "material-choices", "my-crews", "dispatch-options", "crew-clock", "job"]);
/** Mutations that can wait for a connection (their functions are registered with setMutationDefaults). */
export const OFFLINE_MUTATIONS = new Set(["visit-status", "checklist-save", "visit-notes", "photo-share"]);
/** Field actions run one at a time, in the order they were made. */
export const FIELD_SCOPE = { id: "field-sync" };
/** Room for everything saved, cached screens included. Unsent actions are saved even past it. */
const BUDGET = 2_000_000;

const storageKey = (userId: string) => `crewtavo.offline.v${VERSION}.${userId}`;

const isFieldAction = (m: Mutation) => OFFLINE_MUTATIONS.has(String(m.options.mutationKey?.[0]));
/**
 * Turned away for the sign-in even after refreshing it: the app signs the person out (lib/queryClient.ts)
 * and keeps the action, which goes out once they sign back in (keepQueuedFieldActions). It isn't
 * tried again before then.
 */
const signInExpired = (error: unknown) => isAuthError(error) && (error as ApiError).code === SESSION_EXPIRED;
/** Not sent yet: waiting for a connection or its turn, or on its way, or turned away only because the sign-in expired. */
const unsent = (m: Mutation) => isFieldAction(m) && (m.state.status === "pending" || (m.state.status === "error" && signInExpired(m.state.error)));
/**
 * Field actions whose request is out right now, known by their variables (React Query sends each
 * action with its own). Their state can't tell: one put back from the phone's storage stays isPaused
 * while it goes, and one waiting to try again after a failure isn't paused, though it hasn't gone.
 */
const sending = new Set<unknown>();
/** Sends that already note what's out, so starting again (a remount) doesn't wrap them twice. */
const noting = new WeakSet<object>();
/**
 * Counts again as a request goes out, for the service worker: the signal that sends it also wakes the
 * worker, and an action put back from storage goes without any other change React Query reports.
 */
const recounts = new Set<() => void>();

/** A field action's registered send, noting in `sending` while its request is out. */
function noteSending(send: MutationFunction<unknown, unknown>): MutationFunction<unknown, unknown> {
  if (noting.has(send)) return send;
  const noted = async (variables: unknown) => {
    sending.add(variables);
    recounts.forEach((recount) => recount());
    try {
      return await send(variables);
    } finally {
      sending.delete(variables);
    }
  };
  noting.add(noted);
  return noted;
}

/**
 * Unsent and not on its way, as the service worker counts them: waiting for signal (or for requests
 * to get through), its turn, its next try, or a new sign-in. One on its way when the app closes has
 * most likely gone, and goes again when the app next opens anyway.
 */
const queued = (m: Mutation) => unsent(m) && !sending.has(m.state.variables);

/** No answer from the server itself: no signal, too little to carry a request, or the server restarting or deploying. */
const cannotReach = (error: unknown) => isNetworkError(error) || (error instanceof ApiError && isRestarting(error.status));

/**
 * Field actions keep trying while they can't reach the server. Anything else the server answers, a
 * refusal included, is final and shows as an error.
 */
const FIELD_RETRY = { retry: (_failures: number, error: unknown) => cannotReach(error) };

// The phone can say it's online while nothing gets through (one bar, a hotspot with no data). When a
// field action can't reach the server, the app goes offline as if there were no signal at all:
// actions wait in the queue (saved on the phone), new ones queue behind them, and every so often we
// check whether requests get through again.
let recheck: ReturnType<typeof setTimeout> | undefined;
let recheckDelay = 0;
let checking = false;

function cannotReachServer() {
  onlineManager.setOnline(false);
  if (recheck !== undefined || checking) return;
  recheckDelay = Math.min(recheckDelay * 2 || 2_000, 30_000);
  recheck = setTimeout(checkServer, recheckDelay);
}

/**
 * Whether requests get through again. Also checked as soon as the app is back on the screen: a
 * phone put away for a while has waited out the delay, and the timer may not have run meanwhile.
 */
async function checkServer() {
  clearTimeout(recheck);
  recheck = undefined;
  // The phone knows it has no signal: its "online" event brings the app back.
  const noSignal = () => navigator.onLine === false;
  if (checking || onlineManager.isOnline() || noSignal()) return;
  checking = true;
  const ok = await reachable();
  checking = false;
  if (onlineManager.isOnline() || noSignal()) return;
  if (ok) onlineManager.setOnline(true); // Paused field actions resume (QueryClient listens).
  else cannotReachServer();
}

/** Any answer from the server itself counts; a request that fails outright or hangs doesn't, nor one answered for it while it restarts. */
async function reachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch("/api/config", { cache: "no-store", signal: controller.signal });
    return !isRestarting(res.status);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** What's saved: the unsent field actions, and the field screens when this person is crew. */
function snapshot(queryClient: QueryClient, keepQueries: boolean): DehydratedState {
  const state = dehydrate(queryClient, {
    shouldDehydrateQuery: (q) => keepQueries && q.state.status === "success" && KEEP.has(String(q.queryKey[0])) && !(q.queryKey[0] === "job" && q.queryKey[2] !== "scope"),
    shouldDehydrateMutation: unsent,
  });
  // All saved as waiting, the one on its way included, so if the app closes before the server
  // answers it goes again on the next start (as do any turned away for the sign-in). Each field
  // action is safe to repeat on its own. Put back, it has no screen to show an error on: one the
  // server turns down says so in a toast (meta.inline off).
  return { ...state, mutations: state.mutations.map((m) => ({ ...m, meta: { ...m.meta, inline: undefined }, state: { ...m.state, status: "pending" as const, error: null, isPaused: true } })) };
}

function write(key: string, state: DehydratedState, budget = Infinity): boolean {
  try {
    const text = JSON.stringify(state);
    if (text.length >= budget) return false;
    localStorage.setItem(key, text);
    return true;
  } catch {
    return false; // Private mode or storage full.
  }
}

function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Everything if it fits; otherwise just the unsent actions, without the cached screens; failing
 * even that, nothing. An older copy left in place would send actions again that have gone out since.
 */
function save(userId: string, state: DehydratedState) {
  const key = storageKey(userId);
  if (!write(key, state, BUDGET) && !write(key, { mutations: state.mutations, queries: [] })) remove(key);
}

const sameAction = (m: { mutationKey?: unknown; scope?: { id: string }; state: { variables?: unknown } }) =>
  JSON.stringify([m.mutationKey ?? null, m.scope?.id ?? null, m.state.variables ?? null]);

/** Puts back what was saved. Actions this page already holds (restored by an earlier start, or made since) aren't added again. */
function restore(queryClient: QueryClient, userId: string) {
  let saved: Partial<DehydratedState> | null;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "null") as Partial<DehydratedState> | null;
  } catch {
    return; // Unreadable storage: start fresh.
  }
  if (!saved) return;
  const held = new Map<string, number>();
  for (const m of queryClient.getMutationCache().getAll()) {
    const id = sameAction({ mutationKey: m.options.mutationKey, scope: m.options.scope, state: m.state });
    held.set(id, (held.get(id) ?? 0) + 1);
  }
  const mutations = (saved.mutations ?? []).filter((m) => {
    const id = sameAction(m);
    const count = held.get(id) ?? 0;
    if (count) held.set(id, count - 1);
    return !count;
  });
  try {
    hydrate(queryClient, { queries: saved.queries ?? [], mutations });
  } catch {
    // Saved by an incompatible version: start fresh.
  }
}

/** The Background Sync tag public/sw.js listens for, also the tag of its notification. */
export const SYNC_TAG = "crewtavo-field-sync";
/** Where public/sw.js reads how many field actions wait on this phone: one entry per person. */
export const WAITING_CACHE = "crewtavo-waiting";

type SyncRegistration = ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } };

/** Everyone's waiting field actions on this phone, as the service worker counts them. */
async function waitingOnPhone(cache: Cache) {
  let total = 0;
  for (const entry of await cache.keys()) total += Number(await (await cache.match(entry))?.text()) || 0;
  return total;
}

let telling = Promise.resolve();

/**
 * Tells the service worker how many of this person's field actions are waiting and, while some are,
 * asks to hear when there's signal (Background Sync, on Android): if Crewtavo isn't open then, it
 * says so with a notification. Once none are left, that notification goes. Without Background Sync
 * (iPhones) only the count is kept, and the queue goes out the next time the app is open.
 */
function tellServiceWorker(userId: string, waiting: number) {
  telling = telling.then(async () => {
    try {
      if (typeof caches === "undefined" || typeof navigator === "undefined" || !navigator.serviceWorker) return;
      const cache = await caches.open(WAITING_CACHE);
      const entry = `/waiting/${encodeURIComponent(userId)}`;
      if (waiting) await cache.put(entry, new Response(String(waiting)));
      else await cache.delete(entry);
      const registration = (await navigator.serviceWorker.getRegistration()) as SyncRegistration | undefined;
      if (!registration) return;
      if (waiting) await registration.sync?.register(SYNC_TAG);
      else if (!(await waitingOnPhone(cache))) for (const shown of (await registration.getNotifications?.({ tag: SYNC_TAG })) ?? []) shown.close();
    } catch {
      // Storage turned off, or a private window: the queue still goes out while the app is open.
    }
  });
}

interface Running {
  userId: string;
  stop: () => void;
}
const running = new Set<Running>();

/** Stops saving for this person. True when it was running, so the query client holds their whole queue. */
function stopSaving(userId: string) {
  const theirs = [...running].filter((r) => r.userId === userId);
  theirs.forEach((r) => r.stop());
  return theirs.length > 0;
}

export function startOfflineCache(queryClient: QueryClient, userId: string, keepQueries: boolean): () => void {
  // Added to the defaults registerFieldActions set (setMutationDefaults replaces, so call this after it), before restoring any.
  // The screens send field actions with these too (no mutationFn of their own), so every request out is noted.
  // "online" mode is what makes them wait for signal: every other save fails at once (lib/queryClient.ts).
  for (const key of OFFLINE_MUTATIONS) {
    const defaults = queryClient.getMutationDefaults([key]);
    queryClient.setMutationDefaults([key], { ...defaults, networkMode: "online", ...FIELD_RETRY, ...(defaults.mutationFn && { mutationFn: noteSending(defaults.mutationFn) }) });
  }
  restore(queryClient, userId);

  let told = -1;
  const count = () => queryClient.getMutationCache().getAll().filter(queued).length;
  /** `again`: with some waiting, asks again to hear when there's signal, even if the count is the same. */
  const tell = (again = false, waiting = count()) => {
    if (waiting !== told || (again && waiting > 0)) tellServiceWorker(userId, waiting);
    told = waiting;
  };
  /**
   * As a request goes out. On the screen the worker leaves the sending to the app, so the next save's
   * count will do, unless none are left; put away, the worker may be reading it now.
   */
  const recount = () => {
    const waiting = count();
    if (!waiting || typeof document === "undefined" || document.visibilityState !== "visible") tell(false, waiting);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const saveNow = () => {
    clearTimeout(timer);
    timer = undefined;
    save(userId, snapshot(queryClient, keepQueries));
    tell();
  };
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(saveNow, 800);
  };
  // A phone often closes an app soon after it's put away: don't leave a change unsaved.
  const flush = () => timer !== undefined && saveNow();
  const onVisibility = () => {
    if (document.visibilityState === "visible") return void checkServer();
    flush();
    // Put away with updates waiting: ask again to hear when there's signal, in case Crewtavo is closed
    // by then. Counted again first: one may have gone out since the last count.
    tell(true);
  };

  const stopQueries = queryClient.getQueryCache().subscribe(saveSoon);
  const stopMutations = queryClient.getMutationCache().subscribe((event) => {
    saveSoon();
    if (event.type !== "updated" || !isFieldAction(event.mutation)) return;
    const { action } = event;
    if (action.type === "failed" && cannotReach(action.error)) cannotReachServer();
    // It didn't get through: waiting again from now, not from the next save.
    if (action.type === "failed") tell();
    if (action.type === "success") recheckDelay = 0;
    // Done with, sent or turned down: told again even with the same count, since the worker may have
    // said this one was waiting just as it went, and the next count closes that notification.
    if (action.type === "success" || action.type === "error") told = -1;
    // Turned down by the server: what the screens showed ahead of it is wrong, so load it again.
    // Screens do this too, but an action restored after a restart has no screen.
    if (action.type === "error" && !signInExpired(action.error)) queryClient.invalidateQueries({ predicate: (q) => KEEP.has(String(q.queryKey[0])) });
  });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  if (typeof window !== "undefined") window.addEventListener("pagehide", flush);
  recounts.add(recount);
  queryClient.resumePausedMutations().catch(() => undefined);
  // Counted once they've resumed: one put back that's on its way again at once isn't waiting.
  tell();

  const end = (saveFirst: boolean) => {
    if (!running.delete(self)) return;
    if (saveFirst) flush();
    stopQueries();
    stopMutations();
    recounts.delete(recount);
    clearTimeout(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", flush);
  };
  // Signing out stops it without saving; anything else (a remount, a new role) saves what's pending first.
  const self: Running = { userId, stop: () => end(false) };
  running.add(self);
  return () => end(true);
}

/** Signed out on purpose: nothing of theirs stays on this phone (it may be shared). */
export function forgetOfflineCache(userId: string) {
  stopSaving(userId);
  remove(storageKey(userId));
  // Who they are and their companies, kept by lib/session.tsx for opening the app with no signal.
  remove(`crewtavo.me.${userId}`);
  tellServiceWorker(userId, 0);
}

/**
 * Signed out by the app rather than the person (the sign-in expired or couldn't be refreshed):
 * keep their unsent field actions, without the cached screens, so they go out once the same person
 * signs back in. Call before clearing the query client.
 */
export function keepQueuedFieldActions(queryClient: QueryClient, userId: string) {
  const key = storageKey(userId);
  let mutations: DehydratedState["mutations"];
  if (stopSaving(userId)) {
    mutations = snapshot(queryClient, false).mutations;
  } else {
    // Not running (already signed out once, or never started): what's stored is still current.
    try {
      mutations = (JSON.parse(localStorage.getItem(key) ?? "null") as Partial<DehydratedState> | null)?.mutations ?? [];
    } catch {
      return;
    }
  }
  if (!mutations.length) remove(key);
  else write(key, { mutations, queries: [] });
  tellServiceWorker(userId, mutations.length);
}

/** Field actions not sent yet (waiting for a connection, their turn or a new sign-in, or on their way), for "3 updates waiting to send". */
export const pendingFieldActions = (queryClient: QueryClient) => queryClient.getMutationCache().getAll().filter(unsent).length;
