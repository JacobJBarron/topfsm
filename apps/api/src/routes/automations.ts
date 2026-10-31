/**
 * Automations: rules are edited straight from the browser (row-level security limits that to the
 * office). These routes run the engine, preview a rule against a real record, and retry or cancel runs.
 */
import { evaluateConditions, OFFICE, renderTemplate, triggerAllowed, triggerDef, validateRule, type Action, type Condition, type RuleShape } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { appUrl, dbError, HttpError, must, readJson } from "../lib/http";
import { emailReady, smsConfigured } from "../lib/notify";
import { adminClient } from "../lib/supabase";
import { buildContext, processAutomations } from "../services/automations";

export const automations = new Hono<AppEnv>();

const lastRun = new Map<string, number>();

/** The web app calls this after actions so rules run right away instead of on the next cron tick. */
automations.post("/automations/process", requireUser, requireCompany(), async (c) => {
  const now = Date.now();
  if (now - (lastRun.get(c.var.companyId) ?? 0) < 1500) return c.json({ claimed: 0, throttled: true });
  lastRun.set(c.var.companyId, now);
  return c.json(await processAutomations(c.env, { companyId: c.var.companyId, limit: 25, baseUrl: appUrl(c) }));
});

const ruleSchema = z.object({
  name: z.string().max(120).default("Untitled rule"),
  trigger: z.string().max(60),
  delay_minutes: z.number().int().min(0).max(525_600).default(0),
  conditions: z.array(z.object({ field: z.string().max(40), op: z.string().max(20), value: z.union([z.string().max(200), z.number(), z.array(z.string().max(100)).max(30)]) })).max(10),
  actions: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
});

/** Preview what a rule would do on the most recent matching record, without doing it. */
automations.post("/automations/preview", requireUser, requireCompany(OFFICE, "automations"), async (c) => {
  const rule = (await readJson(c, ruleSchema)) as unknown as RuleShape;
  // Rules about subs' job offers (their prices) are for the office with the Subcontractors area.
  if (!triggerAllowed(rule.trigger, (area) => c.var.permissions.includes(area))) throw new HttpError(403, "Rules about subs' job offers need the Subcontractors area. Ask an owner or admin.");
  const problems = validateRule(rule);
  if (problems.length) throw new HttpError(400, problems[0]);
  const trigger = triggerDef(rule.trigger)!;
  const { db, companyId } = c.var;

  // The latest event of this kind, or else the latest record of the subject's type.
  const event = must(await db.from("activity").select("subject_type, subject_id").eq("company_id", companyId).eq("verb", rule.trigger).not("subject_id", "is", null).order("created_at", { ascending: false }).limit(1));
  let subjectId = event[0]?.subject_id ?? null;
  if (!subjectId) {
    const table = ({ client: "clients", request: "requests", quote: "quotes", job: "jobs", visit: "visits", invoice: "invoices" } as const)[trigger.subject];
    const latest = must(await db.from(table).select("id").eq("company_id", companyId).order("created_at", { ascending: false }).limit(1));
    subjectId = latest[0]?.id ?? null;
  }
  if (!subjectId) return c.json({ record: null, pass: false, failed: null, previews: [] });

  const ctx = await buildContext(c.env, adminClient(c.env), companyId, trigger.subject, subjectId, appUrl(c));
  if (!ctx) return c.json({ record: null, pass: false, failed: null, previews: [] });
  const check = evaluateConditions(rule.conditions as Condition[], ctx.facts, ctx.subject);
  const r = (t?: string) => renderTemplate(t ?? "", ctx.vars).trim();
  const warnings: string[] = [];
  const canEmail = await emailReady(c.env, companyId);
  const previews = (rule.actions as Action[]).map((a) => {
    switch (a.type) {
      case "notify":
        return { type: a.type, title: r(a.title), body: r(a.body) };
      case "send_email":
        if (!canEmail) warnings.push("Email isn't connected yet (Settings → Email), so email actions will fail until it is.");
        if (!ctx.client?.email) warnings.push(`${ctx.client?.display_name ?? "This client"} has no email address.`);
        return { type: a.type, to: ctx.client?.email ?? null, title: r(a.subject), body: r(a.body) };
      case "send_sms":
        if (!smsConfigured(c.env)) warnings.push("Text messaging isn't set up on this server, so text actions will fail until it is.");
        return { type: a.type, to: ctx.client?.phone ?? null, body: r(a.body) };
      case "add_note":
        return { type: a.type, body: r(a.body) };
      case "create_task":
        return { type: a.type, title: r(a.title), body: `Due in ${a.days_from_now} days` };
      case "add_tag":
      case "remove_tag":
        return { type: a.type, title: a.tag };
      default:
        return { type: a.type };
    }
  });
  return c.json({ record: { type: ctx.subject, id: ctx.id, label: ctx.label, path: ctx.appPath }, pass: check.pass, failed: check.failed ?? null, previews, warnings: [...new Set(warnings)] });
});

async function ownRun(c: Parameters<typeof appUrl>[0]) {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, "We couldn't find that run.");
  return must(await c.var.db.from("automation_runs").select("id, status").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), "Run not found.");
}

automations.post("/automations/runs/:id/retry", requireUser, requireCompany(OFFICE, "automations"), async (c) => {
  const run = await ownRun(c);
  if (run.status !== "failed") throw new HttpError(409, "Only failed runs can be retried.");
  const { error } = await adminClient(c.env).from("automation_runs").update({ status: "pending", run_after: new Date().toISOString(), attempts: 0, busy_tries: 0, error: null, finished_at: null }).eq("id", run.id);
  if (error) throw dbError(error);
  const result = await processAutomations(c.env, { companyId: c.var.companyId, limit: 10, baseUrl: appUrl(c) });
  return c.json(result);
});

automations.post("/automations/runs/:id/cancel", requireUser, requireCompany(OFFICE, "automations"), async (c) => {
  const run = await ownRun(c);
  if (run.status !== "pending") throw new HttpError(409, "Only waiting runs can be cancelled.");
  const { error } = await adminClient(c.env).from("automation_runs").update({ status: "cancelled", finished_at: new Date().toISOString(), error: "Cancelled by the office" }).eq("id", run.id).eq("status", "pending");
  if (error) throw dbError(error);
  return c.json({ status: "cancelled" });
});
