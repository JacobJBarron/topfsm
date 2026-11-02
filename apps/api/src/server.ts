/**
 * Single-process server for Railway, Docker and local runs: the web app, the API, and a built-in
 * scheduler for background tasks (Railway cron jobs can't run more often than every 5 minutes,
 * and automations need every minute).
 *
 * In a Crewtavo instance (JWT_SECRET set; see lib/stack.ts and deploy/README.md) it is also the
 * gateway to the instance's own Supabase services, and it applies database migrations as it starts:
 * /api/health answers 503 until they're done, so Railway keeps the previous deployment serving.
 *
 *   PORT              port to listen on (Railway sets it)
 *   CREWTAVO_STATIC_DIR     built web app (default: ./public next to this file)
 *   CREWTAVO_SCHEDULER=off  don't run background tasks here (for extra replicas)
 *   CREWTAVO_LOG_TASKS=1    log every background task run, even when it had nothing to do
 *   APP_URL           public address; defaults to https://$RAILWAY_PUBLIC_DOMAIN on Railway (see readEnv)
 *   CREWTAVO_SENTRY_DSN     report errors to Sentry or GlitchTip (see lib/monitoring.ts)
 *   CREWTAVO_VISITOR_IP     where visitors' addresses come from, behind other proxies (lib/visitor.ts)
 *   CREWTAVO_VERSION        the release, reported by /api/health (the Docker image sets it)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { app } from "./app";
import { readEnv } from "./env";
import { forwardTo } from "./lib/address";
import { closeAfterUnreadBodies } from "./lib/connection";
import { cronMatches } from "./lib/cron";
import { gateway } from "./lib/gateway";
import { reportError } from "./lib/monitoring";
import { describeRecovery } from "./lib/recovery";
import { startMonitoring } from "./lib/monitoring-node";
import { stackServices, withStack } from "./lib/stack";
import { setStartup, startup, type Startup } from "./lib/startup";
import { CRON_TASKS, runTask, type TaskName } from "./tasks";

const here = dirname(fileURLToPath(import.meta.url));
const staticDir = process.env.CREWTAVO_STATIC_DIR ?? join(here, "public");
const port = Number(process.env.PORT ?? 8080);
const version = process.env.CREWTAVO_VERSION ?? "dev";
const stack = stackServices(process.env);
const env = readEnv(withStack(process.env, port));
startMonitoring(env);

const server = new Hono<{ Bindings: HttpBindings }>();
// The app gets the connection too: with no proxy in front, its address is the visitor's (lib/visitor.ts).
const api = (c: Context<{ Bindings: HttpBindings }>) => app.fetch(c.req.raw, { ...env, incoming: c.env.incoming });

// Railway routes traffic to a new deployment once this answers 200: after migrations, or when a
// brand-new instance couldn't finish them (the setup page then says why). A failed update answers
// 503, so the previous deployment keeps serving.
server.get("/api/health", (c) => {
  const s = startup();
  if (s?.state === "migrating") return c.json({ ok: false, version, starting: true }, 503);
  if (s?.state === "failed" && s.firstInstall === false) return c.json({ ok: false, version, problem: s.problem }, 503);
  return c.json({ ok: true, version });
});
server.all("/api/*", api);
server.all("/mcp", api);
server.all("/mcp/*", api);
server.all("/.well-known/*", api);
// Website analytics: the script on the business's website, and the page views it sends (routes/analytics.ts).
server.get("/v.js", api);
server.post("/v", api);
// Website forms: the address the business's own form sends to, and its thank-you page (routes/websiteForms.ts).
server.all("/f/*", api);

// Gateway to the instance's Supabase services (lib/gateway.ts).
if (stack) server.route("/", gateway(env, stack));

// After a switch in Settings → Web address, pages opened on an old address forward to the new one
// (lib/address.ts). Client links, webhooks and the API keep answering where they are.
server.use("*", async (c, next) => {
  const target = await forwardTo(env, c.req.raw);
  if (target) return c.redirect(target, 302);
  await next();
});

// The web app: fingerprinted assets cache forever; everything else falls back to index.html.
// Its pages can't be shown inside another site, so a signed-in screen (Apps → Stripe, say) can't
// be dressed up to trick a click. Booking forms are left out: businesses put them on their own
// websites (features/booking/embed.ts), and they're public anyway. The API has its own headers (app.ts).
const indexPath = join(staticDir, "index.html");
const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
server.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("content-type")?.includes("text/html") && !c.req.path.startsWith("/book/")) {
    c.res.headers.set("X-Frame-Options", "SAMEORIGIN");
    c.res.headers.set("Content-Security-Policy", "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
  }
  if (c.res.status !== 200) return;
  if (c.req.path.startsWith("/assets/")) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  else if (c.res.headers.get("content-type")?.includes("text/html")) c.res.headers.set("Cache-Control", "no-cache");
});
server.use("/*", serveStatic({ root: staticDir }));
server.get("*", (c) => {
  if (!indexHtml) return c.text("The web app isn't built. Run npm run build:server.", 500);
  return c.html(indexHtml, 200, { "Cache-Control": "no-cache" });
});

const listener = serve({ fetch: server.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`Crewtavo listening on port ${port}${env.APP_URL ? ` (${env.APP_URL})` : ""}`);
});
closeAfterUnreadBodies(listener as HttpServer);

// ---------------------------------------------------------------------------------------------
// Migrations, as a separate process (scripts/migrate.mjs, next to this file in the build) so a
// failure is reported rather than crashing the server. Background tasks start once it's done.
// ---------------------------------------------------------------------------------------------
const migrateScript = join(here, "scripts/migrate.mjs");

/**
 * In an instance, Auth and Storage set up their own tables as they start, and the migrations build
 * on those, so wait until both answer their health checks (up to five minutes on a cold start).
 */
async function waitForServices(): Promise<boolean> {
  if (!stack) return true;
  const deadline = Date.now() + 5 * 60_000;
  for (const url of [`${stack.auth}/health`, `${stack.storage}/status`]) {
    for (;;) {
      const ok = await fetch(url, { signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return true;
}

async function migrate(): Promise<void> {
  if (!existsSync(migrateScript) || !(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL)) return;
  setStartup({ state: "migrating" });
  if (!(await waitForServices())) {
    console.error("Startup: Auth or Storage didn't come up within five minutes.");
    return setStartup({ state: "failed", problem: "services_not_ready" });
  }
  const statusFile = join(tmpdir(), `crewtavo-migrate-${process.pid}.json`);
  return new Promise((resolve) => {
    // CREWTAVO_SINGLE_COMPANY as this server reads it (on by default in an instance), so the
    // database refuses a second business too, not just this API.
    const child = spawn(process.execPath, [migrateScript], { env: { ...process.env, CREWTAVO_SINGLE_COMPANY: env.CREWTAVO_SINGLE_COMPANY ?? "", CREWTAVO_MIGRATE_STATUS: statusFile }, stdio: "inherit" });
    child.on("exit", () => {
      let status: { ok?: boolean; firstInstall?: boolean; problem?: Startup["problem"]; detail?: string } = {};
      try {
        status = JSON.parse(readFileSync(statusFile, "utf8"));
        rmSync(statusFile, { force: true });
      } catch {
        status = { ok: false, problem: "migration_failed", detail: "The migration process stopped without a result." };
      }
      setStartup(status.ok ? { state: "ready" } : { state: "failed", firstInstall: status.firstInstall, problem: status.problem, detail: status.detail });
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Scheduler: once a minute, run every task whose cron expression matches. A task still running
// from the last tick is skipped rather than started twice. Tasks are safe to run concurrently
// across replicas, but CREWTAVO_SCHEDULER=off keeps extra replicas quiet.
// ---------------------------------------------------------------------------------------------
const running = new Set<TaskName>();
let timer: ReturnType<typeof setTimeout> | undefined;

async function tick() {
  const now = new Date();
  for (const [expression, tasks] of Object.entries(CRON_TASKS)) {
    if (!cronMatches(expression, now)) continue;
    for (const task of tasks) {
      if (running.has(task)) continue;
      running.add(task);
      runTask(task, env)
        .then((result) => {
          if (process.env.CREWTAVO_LOG_TASKS === "1" || Object.values(result).some((v) => typeof v === "number" && v > 0)) console.log(JSON.stringify({ task, ...result }));
        })
        .catch((error) => {
          console.error(`Task ${task} failed`, error);
          reportError(error, { task });
        })
        .finally(() => running.delete(task));
    }
  }
}

function scheduleNext() {
  const delay = 60_000 - (Date.now() % 60_000) + 250; // just after the next minute starts
  timer = setTimeout(() => {
    void tick();
    scheduleNext();
  }, delay);
}

void migrate().then(() => {
  void describeRecovery(env).then((line) => line && console.log(line), () => undefined);
  if (startup()?.state === "failed" || process.env.CREWTAVO_SCHEDULER === "off") return;
  scheduleNext();
  console.log("Background tasks: running in this process");
  // Started with a new web address (Settings → Web address)? Say so now rather than at the next tick.
  runTask("address", env).catch((error) => console.error("Task address failed", error));
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  if (timer) clearTimeout(timer);
  listener.close(() => process.exit(0));
  // Give in-flight requests and tasks a few seconds, then exit regardless.
  setTimeout(() => process.exit(0), 8_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
