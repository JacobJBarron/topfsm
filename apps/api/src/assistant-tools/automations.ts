/**
 * Automations: rules that act when something happens (a quote is sent, a visit is tomorrow...),
 * built from the same catalog and checked the same way as on the rule screen
 * (packages/core/src/automations.ts). A rule an assistant makes starts out off: they message clients.
 */
import {
  ACTIONS,
  CONDITION_FIELDS,
  ROLE_GROUP_LABELS,
  STATUS_ACTION_CHOICES,
  TEMPLATE_VARIABLES,
  TRIGGERS,
  actionsForTrigger,
  describeRuleSentence,
  fieldsFor,
  triggerAllowed,
  triggerDef,
  validateRule,
  type Action,
  type Condition,
} from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, one, roleAllows, rows, tool, type ToolContext } from "./tool";

const COLUMNS = "id, name, description, trigger, delay_minutes, conditions, actions, enabled, run_count, last_run_at";

/**
 * Rules about subs' offers (their prices) are for people with the Subcontractors area, and rules about
 * autopay (clients' cards) for people with the invoices area, as on the rule screen.
 */
const mayUse = (ctx: ToolContext, verb: string) => triggerAllowed(verb, (area) => roleAllows(ctx, undefined, area));

const condition = z.object({
  field: z.string().max(60),
  op: z.enum(["equals", "not_equals", "in", "includes", "excludes", "contains", "gte", "lte"]),
  value: z.union([z.string().max(200), z.number(), z.array(z.string().max(200)).max(50)]),
});

const roleGroup = z.enum(Object.keys(ROLE_GROUP_LABELS) as [string, ...string[]]);
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notify"), roles: z.array(roleGroup).max(7).optional(), user_ids: z.array(z.uuid()).max(50).optional(), title: z.string().max(200), body: z.string().max(2000).optional() }),
  z.object({ type: z.literal("send_email"), subject: z.string().max(200), body: z.string().max(10_000) }),
  z.object({ type: z.literal("send_sms"), body: z.string().max(640) }),
  z.object({ type: z.literal("add_tag"), tag: z.string().max(60) }),
  z.object({ type: z.literal("remove_tag"), tag: z.string().max(60) }),
  z.object({ type: z.literal("add_note"), body: z.string().max(4000) }),
  z.object({ type: z.literal("create_task"), title: z.string().max(200), days_from_now: z.number().int() }),
  z.object({ type: z.literal("request_review"), channel: z.enum(["email", "sms"]) }),
  z.object({ type: z.literal("update_status"), status: z.string().max(40) }),
  z.object({ type: z.literal("invite_autopay"), channel: z.enum(["email", "sms"]) }),
]);

export const automationTools = {
  automation_options: tool({
    description:
      "What automations can be built from: triggers (what starts a rule, and whether it can wait first), the conditions each kind of record has, the actions, and the {{tokens}} messages can use. Read this before save_automation.",
    input: z.object({}),
    run: async (ctx) => ({
      triggers: TRIGGERS.filter((t) => mayUse(ctx, t.verb)).map(({ verb, label, subject, delayable, actions, variables, hides, notifyRoles }) => ({
        trigger: verb, label, record: subject, can_wait: delayable,
        // Some triggers take fewer actions than their record (a sub's offer has no client), or carry tokens of their own.
        ...(actions ? { only_actions: actions } : {}),
        ...(variables ? { extra_tokens: variables.map((v) => ({ token: `{{${v.token}}}`, label: v.label, ...(v.officeOnly ? { not_in_tasks: true } : {}) })) } : {}),
        ...(hides ? { not_tokens: hides.map((t) => `{{${t}}}`) } : {}),
        // Who can be told about it: a sub's offer or autopay, only the office.
        ...(notifyRoles ? { only_notify_roles: notifyRoles } : {}),
      })),
      conditions: CONDITION_FIELDS.map(({ field, label, ops, subjects, choices }) => ({ field, label, ops, records: subjects, choices })),
      actions: ACTIONS.map(({ type, label, description, subjects }) => ({ type, label, description, records: subjects })),
      status_choices: STATUS_ACTION_CHOICES,
      notify_roles: ROLE_GROUP_LABELS,
      message_tokens: TEMPLATE_VARIABLES.map(({ token, label, subjects }) => ({ token: `{{${token}}}`, label, records: subjects })),
    }),
  }),
  list_automations: tool({
    description: "The company's automation rules, each with a sentence saying what it does, whether it's on, and how often it has run.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      const rules = await rows(ctx.db.from("automation_rules").select(COLUMNS).eq("company_id", ctx.companyId).order("created_at"));
      return rules.map((r) => ({ ...r, does: describeRuleSentence(r as never) }));
    },
  }),
  save_automation: tool({
    description:
      "Make an automation rule (no rule_id) or replace one (with rule_id). Build it from automation_options. New rules start off; only turn one on (enabled) when the person says to, since rules can email and text clients.",
    input: z.object({
      rule_id: z.uuid().optional(),
      name: z.string().max(120),
      description: z.string().max(500).nullable().optional(),
      trigger: z.enum(TRIGGERS.map((t) => t.verb) as [string, ...string[]]),
      delay_minutes: z.number().int().min(0).max(525_600).default(0).describe("How long to wait after the trigger, for triggers that can wait."),
      conditions: z.array(condition).max(10).default([]),
      actions: z.array(action).min(1).max(10),
      enabled: z.boolean().optional(),
      ...companyArg,
    }),
    area: "automations",
    run: async (ctx, a) => {
      const trigger = triggerDef(a.trigger)!;
      if (!mayUse(ctx, trigger.verb)) {
        throw new Error(
          trigger.area === "invoices"
            ? "Rules about autopay need the Invoices and payments area. Ask an owner or admin."
            : "Rules about subs' job offers need the Subcontractors area. Ask an owner or admin.",
        );
      }
      const rule = { name: a.name.trim(), trigger: a.trigger, delay_minutes: trigger.delayable ? a.delay_minutes : 0, conditions: a.conditions as Condition[], actions: a.actions as Action[] };
      const fields = new Set(fieldsFor(trigger.subject).map((f) => f.field));
      const types = new Set(actionsForTrigger(trigger.verb).map((t) => t.type));
      const problems = [
        ...validateRule(rule),
        ...rule.conditions.filter((c) => !fields.has(c.field)).map((c) => `"${c.field}" isn't a condition for this trigger.`),
        ...rule.actions.filter((x) => !types.has(x.type)).map((x) => `"${x.type}" isn't an action for this trigger.`),
      ];
      if (problems.length) throw new Error(problems.join(" "));
      const row = {
        ...rule,
        description: a.description?.trim() || null,
        conditions: rule.conditions as never,
        actions: rule.actions as never,
        ...(a.enabled !== undefined || !a.rule_id ? { enabled: a.enabled ?? false } : {}),
      };
      if (a.rule_id) {
        await changed(ctx.db.from("automation_rules").update(row).eq("id", a.rule_id).eq("company_id", ctx.companyId).select("id"), "That rule");
        return { rule_id: a.rule_id, does: describeRuleSentence(rule) };
      }
      const made = await one(ctx.db.from("automation_rules").insert({ ...row, company_id: ctx.companyId }).select("id, enabled").single(), "The rule");
      return { rule_id: made.id, enabled: made.enabled, does: describeRuleSentence(rule) };
    },
  }),
  delete_automation: tool({
    description: "Delete an automation rule. To pause it but keep it, save it with enabled false instead.",
    input: z.object({ rule_id: z.uuid(), ...companyArg }),
    area: "automations",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("automation_rules").delete().eq("id", a.rule_id).eq("company_id", ctx.companyId).select("id"), "That rule");
      return { deleted: true };
    },
  }),
};
