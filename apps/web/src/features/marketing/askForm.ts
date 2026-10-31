/**
 * Marketing → Reviews' "Ask automatically" form (Reviews.tsx): what it shows, read from the two
 * starter rules and settings.reviews, and what it sends to PUT /api/reviews/asks, which changes the
 * rules (packages/core/src/marketing.ts says their shapes).
 */
import { readAskRule, reviewSettings, type AskChannel, type AskWhen } from "@crewtavo/core/marketing";

export interface AskRuleRow {
  id: string;
  name: string;
  description: string | null;
  template_key: string | null;
  trigger: string;
  enabled: boolean;
  delay_minutes: number;
  conditions: unknown;
  actions: unknown;
}

export interface AskForm {
  enabled: boolean;
  when: AskWhen;
  channel: AskChannel;
  recurring: boolean;
  visits: number;
  /** How many reminders: none, one or two. */
  reminders: number;
  days: [number, number];
}

/** The starter rules, whether each is one the form can show, and the form as they are now. */
export function askRules(rules: AskRuleRow[], settings: Record<string, unknown> | null | undefined) {
  const afterRule = rules.find((r) => r.template_key === "review_after_job");
  const recurringRule = rules.find((r) => r.template_key === "review_recurring");
  const after = readAskRule(afterRule, "after_job");
  const recurring = readAskRule(recurringRule, "recurring");
  // On when either rule asks: a business that only asks on recurring work has it on.
  const on = Boolean(afterRule?.enabled || recurringRule?.enabled);
  const current = reviewSettings(settings);
  const form: AskForm = {
    enabled: on,
    when: (after?.when as AskWhen | undefined) ?? "job.completed",
    // The channel of a rule that's asking, before one that's off.
    channel: (afterRule?.enabled ? after?.channel : undefined) ?? (recurringRule?.enabled ? recurring?.channel : undefined) ?? after?.channel ?? recurring?.channel ?? "email",
    // Turned off altogether, recurring work comes back on with the rest.
    recurring: on ? Boolean(recurringRule?.enabled) : true,
    visits: current.recurringAfterVisits,
    reminders: current.reminderDays.length,
    days: [current.reminderDays[0] ?? 3, current.reminderDays[1] ?? 5],
  };
  return {
    afterRule,
    recurringRule,
    afterCustom: Boolean(afterRule && !after),
    recurringCustom: Boolean(recurringRule && !recurring),
    /** Only recurring work is asked right now: saving with the switch on asks after the rest too. */
    onlyRecurring: !afterRule?.enabled && Boolean(recurringRule?.enabled),
    /** A rule was deleted: saving puts it back. */
    missing: !afterRule || !recurringRule,
    form,
  };
}

/** The second reminder comes after the first. */
export const daysInOrder = (form: AskForm) => form.reminders < 2 || form.days[1] > form.days[0];

/** What PUT /api/reviews/asks is sent. */
export const askBody = (form: AskForm) => ({
  enabled: form.enabled,
  when: form.when,
  channel: form.channel,
  recurring: form.recurring,
  recurring_after_visits: form.visits,
  reminder_days: form.days.slice(0, form.reminders),
});
