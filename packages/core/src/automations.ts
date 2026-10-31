/**
 * Automation rules: the catalog of triggers, conditions and actions, template rendering and
 * condition checks. Shared by the rule builder (web) and the engine that runs rules (API).
 */

export type SubjectKind = "client" | "request" | "quote" | "job" | "visit" | "invoice";

export interface TriggerDef {
  verb: string;
  label: string;
  group: "Clients" | "Requests" | "Quotes" | "Jobs" | "Visits" | "Invoices" | "Subcontractors";
  subject: SubjectKind;
  /** Delays only make sense for some triggers (follow-ups). */
  delayable: boolean;
  /** Only these actions, when the rest don't fit (a sub's offer has no client to email or tag). */
  actions?: ActionType[];
  /**
   * Tokens from the event itself ({{sub.name}}), beyond the record's. `officeOnly` ones (a sub's price)
   * go only in the office's notices, never in a task, which is on the schedule where the crew sees it.
   */
  variables?: Array<{ token: string; label: string; officeOnly?: boolean }>;
  /** The record's tokens that would mislead here (a job's {{total}} is the client's price, not the sub's). */
  hides?: string[];
  /** The area someone needs to build a rule on it, see it or its runs (the database holds to it too). */
  area?: "subs";
  /** Only these levels can be notified (no crew, nobody "on the visit"); the engine holds to it too. */
  notifyRoles?: string[];
}

/**
 * Job offers to subs (supabase/migrations/20261025004001_sub_offers.sql), on the job they're for:
 * for the office's own notices and tasks only, with the sub's name and price. Only someone with the
 * Subcontractors area builds these rules or sees them, and only the office with that area is told
 * (docs/subcontractors-plan.md: crew leads and field crew never see a sub's price); a task, which the
 * crew sees on the schedule, never shows the price or the sub's reason. A follow-up waiting on an
 * offer that's sent is called off once the offer is over, so a delay means "if they still haven't
 * answered".
 */
const SUB_OFFER: Pick<TriggerDef, "group" | "subject" | "actions" | "hides" | "area" | "notifyRoles"> = {
  group: "Subcontractors", subject: "job", actions: ["notify", "create_task"], hides: ["total"], area: "subs", notifyRoles: ["owner", "admin", "office"],
};
const SUB_VARIABLES = [
  { token: "sub.name", label: "Sub's name" },
  { token: "sub.price", label: "Their price", officeOnly: true },
];

export const TRIGGERS: TriggerDef[] = [
  { verb: "client.created", label: "A client is added", group: "Clients", subject: "client", delayable: true },
  { verb: "request.created", label: "A request comes in", group: "Requests", subject: "request", delayable: true },
  { verb: "quote.sent", label: "A quote is sent", group: "Quotes", subject: "quote", delayable: true },
  { verb: "quote.approved", label: "A quote is approved", group: "Quotes", subject: "quote", delayable: true },
  { verb: "quote.changes_requested", label: "A client asks for changes to a quote", group: "Quotes", subject: "quote", delayable: false },
  { verb: "quote.range_accepted", label: "A client says yes to a price range", group: "Quotes", subject: "quote", delayable: true },
  { verb: "quote.lost", label: "A quote is marked lost", group: "Quotes", subject: "quote", delayable: true },
  { verb: "job.created", label: "A job is created", group: "Jobs", subject: "job", delayable: true },
  { verb: "job.completed", label: "A job is completed", group: "Jobs", subject: "job", delayable: true },
  // A recurring job stays active, so it's never "completed": the visit chosen in Marketing → Reviews
  // stands in, once (settings.reviews.recurring_after_visits, 3 unless changed). The verb keeps its
  // old name so rules that name it keep working (20261030000400_recurring_review_visits.sql).
  { verb: "job.recurring_third_visit", label: "A recurring job reaches the visit set in Marketing", group: "Jobs", subject: "job", delayable: true },
  { verb: "visit.reminder", label: "A visit is tomorrow", group: "Visits", subject: "visit", delayable: false },
  { verb: "visit.en_route", label: "A crew is on the way", group: "Visits", subject: "visit", delayable: false },
  { verb: "visit.started", label: "A visit starts", group: "Visits", subject: "visit", delayable: false },
  { verb: "visit.completed", label: "A visit is completed", group: "Visits", subject: "visit", delayable: true },
  { verb: "invoice.sent", label: "An invoice is sent", group: "Invoices", subject: "invoice", delayable: true },
  { verb: "invoice.overdue", label: "An invoice becomes past due", group: "Invoices", subject: "invoice", delayable: true },
  { verb: "invoice.paid", label: "An invoice is paid in full", group: "Invoices", subject: "invoice", delayable: true },
  { verb: "payment.received", label: "A payment is received", group: "Invoices", subject: "invoice", delayable: false },
  { ...SUB_OFFER, verb: "sub_offer.sent", label: "A job is offered to a sub", delayable: true, variables: SUB_VARIABLES },
  { ...SUB_OFFER, verb: "sub_offer.accepted", label: "A sub takes a job offer", delayable: true, variables: SUB_VARIABLES },
  {
    ...SUB_OFFER, verb: "sub_offer.declined", label: "A sub turns down a job offer", delayable: false,
    variables: [...SUB_VARIABLES, { token: "sub.reason", label: "Their reason", officeOnly: true }],
  },
  { ...SUB_OFFER, verb: "sub_offer.expired", label: "A job offer to a sub runs out", delayable: false, variables: SUB_VARIABLES },
];

export const triggerDef = (verb: string) => TRIGGERS.find((t) => t.verb === verb);

/** Whether someone with these areas may build, see and run rules on this trigger (most need none beyond automations). */
export const triggerAllowed = (verb: string, hasArea: (area: NonNullable<TriggerDef["area"]>) => boolean) => {
  const area = triggerDef(verb)?.area;
  return !area || hasArea(area);
};

// ---------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------

export type ConditionOp = "equals" | "not_equals" | "in" | "includes" | "excludes" | "contains" | "gte" | "lte";

export interface Condition {
  field: string;
  op: ConditionOp;
  value: string | number | string[];
}

export interface ConditionFieldDef {
  field: string;
  label: string;
  kind: "status" | "tags" | "text" | "money" | "choice";
  ops: ConditionOp[];
  subjects: SubjectKind[] | "all";
  choices?: Array<{ value: string; label: string }>;
}

const STATUS_CHOICES: Record<SubjectKind, Array<{ value: string; label: string }>> = {
  client: [{ value: "lead", label: "Lead" }, { value: "active", label: "Active" }, { value: "archived", label: "Archived" }],
  request: [
    { value: "new", label: "New" }, { value: "assessment_scheduled", label: "Assessment booked" }, { value: "assessment_complete", label: "Assessment done" },
    { value: "quoted", label: "Quoted" }, { value: "converted", label: "Converted" }, { value: "archived", label: "Archived" },
  ],
  quote: [
    { value: "draft", label: "Draft" }, { value: "sent", label: "Awaiting response" }, { value: "changes_requested", label: "Changes requested" },
    { value: "approved", label: "Approved" }, { value: "converted", label: "Converted" }, { value: "lost", label: "Lost" }, { value: "archived", label: "Archived" },
  ],
  job: [{ value: "active", label: "Active" }, { value: "requires_invoicing", label: "Requires invoicing" }, { value: "completed", label: "Completed" }, { value: "archived", label: "Archived" }],
  visit: [
    { value: "scheduled", label: "Scheduled" }, { value: "en_route", label: "On the way" }, { value: "in_progress", label: "In progress" },
    { value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" },
  ],
  invoice: [
    { value: "draft", label: "Draft" }, { value: "sent", label: "Awaiting payment" }, { value: "partially_paid", label: "Partly paid" },
    { value: "paid", label: "Paid" }, { value: "overdue", label: "Past due" }, { value: "void", label: "Void" }, { value: "written_off", label: "Written off" },
  ],
};

export const statusChoices = (subject: SubjectKind) => STATUS_CHOICES[subject];

export const CONDITION_FIELDS: ConditionFieldDef[] = [
  { field: "status", label: "Its status (when the rule runs)", kind: "status", ops: ["equals", "not_equals", "in"], subjects: "all" },
  { field: "client.tags", label: "Client tags", kind: "tags", ops: ["includes", "excludes"], subjects: "all" },
  { field: "client.status", label: "Client status", kind: "choice", ops: ["equals", "not_equals"], subjects: "all", choices: STATUS_CHOICES.client },
  { field: "client.lead_source", label: "Client lead source", kind: "text", ops: ["equals", "contains", "not_equals"], subjects: "all" },
  { field: "amount", label: "Total", kind: "money", ops: ["gte", "lte"], subjects: ["quote", "job", "invoice"] },
  { field: "line_items", label: "Line items", kind: "text", ops: ["contains"], subjects: ["quote", "job", "invoice"] },
  {
    field: "source", label: "Where the request came from", kind: "choice", ops: ["equals", "in", "not_equals"], subjects: ["request"],
    choices: [
      // Website forms' messages (Apps → Website Forms) are web_form requests too.
      { value: "web_form", label: "Booking or website form" }, { value: "hub", label: "Client Hub" }, { value: "referral", label: "Referral" },
      { value: "phone", label: "Phone" }, { value: "email", label: "Email" }, { value: "manual", label: "Entered by staff" }, { value: "assistant", label: "AI assistant" },
    ],
  },
  {
    field: "kind", label: "Type", kind: "choice", ops: ["equals", "not_equals"], subjects: ["job", "visit"],
    choices: [{ value: "one_off", label: "One-off job" }, { value: "recurring", label: "Recurring job" }, { value: "job", label: "Job visit" }, { value: "assessment", label: "Assessment" }, { value: "task", label: "Task" }],
  },
  // The job a visit or invoice is on: Marketing → Reviews leaves recurring work to its own rule.
  {
    field: "job_kind", label: "Job type", kind: "choice", ops: ["equals", "not_equals"], subjects: ["visit", "invoice"],
    choices: [{ value: "one_off", label: "One-off job" }, { value: "recurring", label: "Recurring job" }],
  },
  {
    field: "invoice_kind", label: "Invoice type", kind: "choice", ops: ["equals", "not_equals"], subjects: ["invoice"],
    choices: [{ value: "standard", label: "Standard" }, { value: "deposit", label: "Deposit" }, { value: "progress", label: "Progress billing" }, { value: "visits", label: "Visits" }],
  },
];

export const OP_LABELS: Record<ConditionOp, string> = {
  equals: "is",
  not_equals: "is not",
  in: "is one of",
  includes: "include",
  excludes: "don't include",
  contains: "contains",
  gte: "is at least",
  lte: "is at most",
};

export const fieldsFor = (subject: SubjectKind) => CONDITION_FIELDS.filter((f) => f.subjects === "all" || f.subjects.includes(subject));

/** Facts about the record a rule runs on, used to check conditions. */
export interface Facts {
  status?: string | null;
  amount?: number | null;
  source?: string | null;
  kind?: string | null;
  /** The kind of job a visit or invoice is on (one_off, recurring), and the job's own. */
  job_kind?: string | null;
  /** An invoice's kind: standard, deposit, progress or visits. */
  invoice_kind?: string | null;
  line_items?: string[];
  client?: { tags?: string[]; status?: string | null; lead_source?: string | null } | null;
}

function factValue(facts: Facts, field: string): unknown {
  if (field.startsWith("client.")) return (facts.client as Record<string, unknown> | null | undefined)?.[field.slice(7)];
  return (facts as Record<string, unknown>)[field];
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(norm) : String(v ?? "").split(",").map(norm)).filter(Boolean);

export function checkCondition(condition: Condition, facts: Facts): boolean {
  const actual = factValue(facts, condition.field);
  const expected = condition.value;
  switch (condition.op) {
    case "equals":
      return norm(actual) === norm(expected);
    case "not_equals":
      return norm(actual) !== norm(expected);
    case "in":
      return list(expected).includes(norm(actual));
    case "includes":
    case "excludes": {
      const have = Array.isArray(actual) ? actual.map(norm) : [];
      const hit = list(expected).some((tag) => have.includes(tag));
      return condition.op === "includes" ? hit : !hit;
    }
    case "contains":
      if (Array.isArray(actual)) return actual.some((item) => norm(item).includes(norm(expected)));
      return norm(actual).includes(norm(expected));
    case "gte":
      return Number(actual ?? 0) >= Number(expected);
    case "lte":
      return Number(actual ?? 0) <= Number(expected);
    default:
      return false;
  }
}

/** All conditions must hold. Returns the first one that failed, described in words. */
export function evaluateConditions(conditions: Condition[], facts: Facts, subject: SubjectKind): { pass: boolean; failed?: string } {
  for (const condition of conditions) {
    if (!checkCondition(condition, facts)) return { pass: false, failed: describeCondition(condition, subject) };
  }
  return { pass: true };
}

function valueLabel(condition: Condition, subject: SubjectKind): string {
  const def = CONDITION_FIELDS.find((f) => f.field === condition.field);
  const choices = def?.kind === "status" ? STATUS_CHOICES[subject] : def?.choices;
  const one = (v: string) => choices?.find((c) => c.value === v)?.label ?? v;
  if (def?.kind === "money") return `$${Number(condition.value).toLocaleString("en-US")}`;
  if (Array.isArray(condition.value)) return condition.value.map(one).join(", ");
  return one(String(condition.value));
}

export function describeCondition(condition: Condition, subject: SubjectKind): string {
  const def = CONDITION_FIELDS.find((f) => f.field === condition.field);
  const field = (def?.label ?? condition.field).replace(" (when the rule runs)", "");
  return `${field} ${OP_LABELS[condition.op] ?? condition.op} ${valueLabel(condition, subject)}`;
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

export type Action =
  | { type: "notify"; roles?: string[]; user_ids?: string[]; title: string; body?: string }
  | { type: "send_email"; subject: string; body: string }
  | { type: "send_sms"; body: string }
  | { type: "add_tag"; tag: string }
  | { type: "remove_tag"; tag: string }
  | { type: "add_note"; body: string }
  | { type: "create_task"; title: string; days_from_now: number }
  | { type: "request_review"; channel: "email" | "sms" | "both" }
  | { type: "update_status"; status: string };

export type ActionType = Action["type"];

export const ACTIONS: Array<{ type: ActionType; label: string; description: string; subjects: SubjectKind[] | "all" }> = [
  { type: "notify", label: "Notify my team", description: "An in-app notification for people by role.", subjects: "all" },
  { type: "send_email", label: "Email the client", description: "Sent to the client's email address.", subjects: "all" },
  { type: "send_sms", label: "Text the client", description: "Sent to the client's mobile number.", subjects: "all" },
  { type: "add_tag", label: "Add a client tag", description: "Tags help segment clients for campaigns.", subjects: "all" },
  { type: "remove_tag", label: "Remove a client tag", description: "", subjects: "all" },
  { type: "add_note", label: "Add a note to the client", description: "An internal note on the client's timeline.", subjects: "all" },
  { type: "create_task", label: "Create a task", description: "A task on the schedule for the office.", subjects: "all" },
  { type: "request_review", label: "Ask for a Google review", description: "Sends your review link (set it in Marketing).", subjects: "all" },
  { type: "update_status", label: "Change the status", description: "Archive a quote or request automatically.", subjects: ["quote", "request"] },
];

export const STATUS_ACTION_CHOICES: Partial<Record<SubjectKind, Array<{ value: string; label: string }>>> = {
  quote: [{ value: "lost", label: "Mark lost" }, { value: "archived", label: "Archive" }],
  request: [{ value: "archived", label: "Archive" }],
};

export const actionsFor = (subject: SubjectKind) => ACTIONS.filter((a) => a.subjects === "all" || a.subjects.includes(subject));

/** The actions a rule started by `verb` can take: its record's, and only those that fit the trigger. */
export function actionsForTrigger(verb: string) {
  const trigger = triggerDef(verb);
  if (!trigger) return ACTIONS;
  return actionsFor(trigger.subject).filter((a) => !trigger.actions || trigger.actions.includes(a.type));
}

/** Plural role names for "Notify owners, office": the team's levels, never a sub's (automations don't notify subs). */
export const ROLE_GROUP_LABELS: Record<string, string> = {
  owner: "Owners", admin: "Admins", office: "Office", estimator: "Estimators", crew_lead: "Crew leads", field_crew: "Field crew",
  assigned: "The people on the visit",
};

// ---------------------------------------------------------------------------------------------
// Templates: "Hi {{client.first_name}}" with values from the record
// ---------------------------------------------------------------------------------------------

export const TEMPLATE_VARIABLES: Array<{ token: string; label: string; subjects: SubjectKind[] | "all" }> = [
  { token: "client.first_name", label: "Client first name", subjects: "all" },
  { token: "client.name", label: "Client name", subjects: "all" },
  { token: "company.name", label: "Your company", subjects: "all" },
  { token: "company.phone", label: "Your phone", subjects: "all" },
  { token: "number", label: "Number", subjects: ["request", "quote", "job", "invoice"] },
  { token: "title", label: "Title", subjects: "all" },
  { token: "total", label: "Total", subjects: ["quote", "job", "invoice"] },
  { token: "balance", label: "Balance due", subjects: ["invoice"] },
  { token: "link", label: "Client link", subjects: ["quote", "invoice"] },
  { token: "date", label: "Visit date", subjects: ["visit"] },
  { token: "time", label: "Visit time", subjects: ["visit"] },
  { token: "address", label: "Address", subjects: ["visit", "request", "quote", "job"] },
];

export const variablesFor = (subject: SubjectKind) => TEMPLATE_VARIABLES.filter((v) => v.subjects === "all" || v.subjects.includes(subject));

/**
 * The tokens for a rule started by `verb`: its record's (less any that would mislead) and the event's
 * own. For a task (`forTask`), not the event's office-only ones: a task is on the schedule.
 */
export function variablesForTrigger(verb: string, forTask = false): Array<{ token: string; label: string }> {
  const trigger = triggerDef(verb);
  if (!trigger) return TEMPLATE_VARIABLES;
  const own = (trigger.variables ?? []).filter((v) => !(forTask && v.officeOnly)).map(({ token, label }) => ({ token, label }));
  return [...variablesFor(trigger.subject).filter((v) => !trigger.hides?.includes(v.token)), ...own];
}

/** The event's office-only tokens for `verb` ("sub.price"): never in a task. */
export const officeOnlyTokens = (verb: string) => (triggerDef(verb)?.variables ?? []).filter((v) => v.officeOnly).map((v) => v.token);

/** Whether a template uses one of these tokens ({{ sub.price }} in any spacing). */
export const usesToken = (template: string | undefined, tokens: readonly string[]) =>
  [...(template ?? "").matchAll(/\{\{\s*([a-z_]+(?:\.[a-z_]+)?)\s*\}\}/gi)].some((m) => tokens.includes(m[1]!.toLowerCase()));

/** The record's values with the event's office-only ones blanked, for a task's title. */
export function taskVars(verb: string, vars: TemplateVars): TemplateVars {
  const hidden = officeOnlyTokens(verb);
  if (!hidden.length) return vars;
  const out: TemplateVars = { ...vars };
  for (const token of hidden) {
    const [head, tail] = token.split(".") as [string, string | undefined];
    const group = out[head];
    if (tail && group && typeof group === "object") out[head] = { ...group, [tail]: "" };
    else if (!tail) out[head] = "";
  }
  return out;
}

const BUSINESS = /\b(llc|inc|ltd|co|corp|company|hoa|association|assn|builders|construction|contracting|services|group|partners|properties|management|church|school|academy|town|city|county|village|district|of|the|and)\b|&/i;

/** How to greet someone: "Jane Smith" -> "Jane"; businesses ("Town of Rocky Mount") stay whole. */
export function greetingName(name: string | null | undefined): string {
  const clean = (name ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return "there";
  const words = clean.split(" ");
  return words.length >= 3 || BUSINESS.test(clean) ? clean : words[0];
}

export type TemplateVars = Record<string, string | number | null | undefined | Record<string, string | number | null | undefined>>;

/** Replace {{path}} tokens; unknown or empty values become "". */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{\s*([a-z_]+(?:\.[a-z_]+)?)\s*\}\}/gi, (_, path: string) => {
    const [head, tail] = path.split(".");
    const value = tail ? (vars[head] as Record<string, unknown> | undefined)?.[tail] : vars[head];
    return value == null ? "" : String(value);
  });
}

// ---------------------------------------------------------------------------------------------
// Validation and descriptions
// ---------------------------------------------------------------------------------------------

export interface RuleShape {
  name: string;
  trigger: string;
  delay_minutes: number;
  conditions: Condition[];
  actions: Action[];
}

/** Problems that would stop a rule from working, in plain words. */
export function validateRule(rule: RuleShape): string[] {
  const errors: string[] = [];
  const trigger = triggerDef(rule.trigger);
  if (!rule.name.trim()) errors.push("Give the rule a name.");
  if (!trigger) errors.push("Choose what starts the rule.");
  if (rule.delay_minutes < 0 || rule.delay_minutes > 525_600) errors.push("The wait must be between 0 minutes and a year.");
  if (!rule.actions.length) errors.push("Add at least one action.");
  if (rule.actions.length > 10) errors.push("A rule can have at most 10 actions.");
  rule.conditions.forEach((c, i) => {
    const value = Array.isArray(c.value) ? c.value.join("") : String(c.value ?? "");
    if (!value.trim()) errors.push(`Condition ${i + 1} needs a value.`);
    if ((c.op === "gte" || c.op === "lte") && !Number.isFinite(Number(c.value))) errors.push(`Condition ${i + 1} needs a number.`);
  });
  rule.actions.forEach((a, i) => {
    const n = `Action ${i + 1}`;
    if (a.type === "notify" && !a.title?.trim()) errors.push(`${n}: add a notification title.`);
    if (a.type === "notify" && !(a.roles?.length || a.user_ids?.length)) errors.push(`${n}: choose who to notify.`);
    if (a.type === "send_email" && (!a.subject?.trim() || !a.body?.trim())) errors.push(`${n}: the email needs a subject and a message.`);
    if (a.type === "send_sms" && !a.body?.trim()) errors.push(`${n}: the text needs a message.`);
    if (a.type === "send_sms" && a.body.length > 640) errors.push(`${n}: keep texts under 640 characters.`);
    if ((a.type === "add_tag" || a.type === "remove_tag") && !a.tag?.trim()) errors.push(`${n}: enter a tag.`);
    if (a.type === "add_note" && !a.body?.trim()) errors.push(`${n}: write the note.`);
    if (a.type === "create_task" && !a.title?.trim()) errors.push(`${n}: name the task.`);
    if (a.type === "create_task" && !(a.days_from_now >= 0 && a.days_from_now <= 365)) errors.push(`${n}: the task must be due within a year.`);
    if (a.type === "update_status" && trigger && !STATUS_ACTION_CHOICES[trigger.subject]?.some((s) => s.value === a.status)) errors.push(`${n}: choose a status.`);
    if (trigger && a.type !== "update_status" && !actionsForTrigger(trigger.verb).some((t) => t.type === a.type)) {
      errors.push(`${n}: “${ACTIONS.find((t) => t.type === a.type)?.label ?? a.type}” doesn't fit what starts this rule.`);
    }
    if (trigger?.notifyRoles && a.type === "notify" && (a.roles ?? []).some((r) => !trigger.notifyRoles!.includes(r))) {
      errors.push(`${n}: only the office hears about this (${listWords(trigger.notifyRoles.map((r) => ROLE_GROUP_LABELS[r]?.toLowerCase() ?? r))}), never the crew.`);
    }
    if (trigger && a.type === "create_task" && usesToken(a.title, officeOnlyTokens(trigger.verb))) {
      errors.push(`${n}: a task is on the schedule, where the crew sees it, so it can't show the sub's price or reason.`);
    }
  });
  return errors;
}

/** "owners, admins and office". */
const listWords = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

export function describeDelay(minutes: number): string {
  if (!minutes) return "";
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} minutes`;
}

export function describeAction(action: Action): string {
  switch (action.type) {
    case "notify":
      return `Notify ${(action.roles ?? []).map((r) => ROLE_GROUP_LABELS[r] ?? r).join(", ") || "selected people"}`;
    case "send_email":
      return "Email the client";
    case "send_sms":
      return "Text the client";
    case "add_tag":
      return `Tag the client “${action.tag}”`;
    case "remove_tag":
      return `Remove the tag “${action.tag}”`;
    case "add_note":
      return "Add a note to the client";
    case "create_task":
      return `Create a task${action.days_from_now ? ` due in ${action.days_from_now} ${action.days_from_now === 1 ? "day" : "days"}` : ""}`;
    case "request_review":
      return `Ask for a review by ${action.channel === "both" ? "text and email" : action.channel === "sms" ? "text" : "email"}`;
    case "update_status":
      return action.status === "lost" ? "Mark it lost" : "Archive it";
  }
}

/** "When a quote is sent, after 3 days, if its status is Awaiting response: email the client." */
export function describeRuleSentence(rule: Pick<RuleShape, "trigger" | "delay_minutes" | "conditions" | "actions">): string {
  const trigger = triggerDef(rule.trigger);
  const when = trigger ? `When ${trigger.label.charAt(0).toLowerCase()}${trigger.label.slice(1)}` : `When ${rule.trigger}`;
  const delay = rule.delay_minutes ? `, wait ${describeDelay(rule.delay_minutes)}` : "";
  const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
  const ifs = rule.conditions.length && trigger ? `, if ${rule.conditions.map((c) => lowerFirst(describeCondition(c, trigger.subject))).join(" and ")}` : "";
  const then = rule.actions.map((a) => lowerFirst(describeAction(a))).join(", then ");
  return `${when}${delay}${ifs}: ${then}.`;
}
