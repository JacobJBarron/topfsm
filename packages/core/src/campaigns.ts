/**
 * Campaigns (Marketing → Campaigns, docs/marketing-plan.md phase C): the three automated campaigns,
 * which are starter automation rules shown as campaigns, and what every campaign email brought in.
 * Shared by the API (services/automatedCampaigns.ts sends them, PUT /api/campaigns/automated/:key
 * edits their rules) and Marketing → Campaigns.
 *
 *   Re-engage past clients  client.inactive, N the rule's days_since_visit condition (365 by default)
 *   Win back lost quotes    quote.lost, N the rule's wait (30 days)
 *   Close pending quotes    quote.sent, N the rule's wait (3 days): the quote_followup starter rule,
 *                           which follows up a quote the client asked for, so it isn't marketing
 *
 * Every send is a recipient row on an automated campaign for its template key, so one results view
 * reads both kinds (supabase/migrations/20261031000200_automated_campaigns.sql).
 */
import type { Action, Condition } from "./automations";
import { sameConditions } from "./marketing";
import { localDate } from "./time";

export type AutomatedKey = "reengage" | "win_back" | "close_quotes";

/** A client gets at most one re-engage email in this many days (about 6 months). */
export const REENGAGE_GAP_DAYS = 182;
/** Re-engage emails each rule queues a day, so a long list of past clients goes out over weeks. */
export const REENGAGE_DAILY_CAP = 100;
/** A last visit longer ago than this (3 years) doesn't qualify: those addresses bounce and complain. */
export const REENGAGE_OLDEST_DAYS = 1095;
export const INACTIVE_DEFAULT_DAYS = 365;
/** Work booked this many days after a click counts for the campaign. */
export const BOOKING_WINDOW_DAYS = 30;
/** A click this soon after sending is a link scanner's, not a person's. */
export const SCANNER_SECONDS = 30;
export const MAX_TRACKED_LINKS = 50;

export interface StarterRule {
  template_key: string;
  name: string;
  description: string;
  trigger: string;
  delay_minutes: number;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
}

export interface AutomatedCampaign {
  key: AutomatedKey;
  templateKey: string;
  /** The card's name, and the automated campaign's. */
  name: string;
  trigger: string;
  /** A marketing email: unsubscribe link, skipped while Marketing is off or for clients who opted out. */
  marketing: boolean;
  days: { min: number; max: number; default: number };
  /** Where N lives: the rule's days_since_visit condition, or its wait. */
  daysIn: "condition" | "delay";
  conditions: (days: number) => Condition[];
  /** The rule's name and description for N days: the card replaces only these, or the starter's own. */
  ruleName: (days: number) => string;
  ruleDescription: (days: number) => string;
  starter: StarterRule;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The re-engage choices, stored as days: 1, 2, 3, 6, 9 and 12 months, 18 months and 2 years. */
export const INACTIVE_CHOICES: ReadonlyArray<{ days: number; label: string }> = [
  { days: 30, label: "1 month" },
  { days: 60, label: "2 months" },
  { days: 90, label: "3 months" },
  { days: 182, label: "6 months" },
  { days: 273, label: "9 months" },
  { days: 365, label: "1 year" },
  { days: 547, label: "18 months" },
  { days: 730, label: "2 years" },
];

/** "1 year", "3 months", "200 days" (a value set in Automations). */
export const inactiveLabel = (days: number) => INACTIVE_CHOICES.find((c) => c.days === days)?.label ?? plural(days, "day");

const sinceVisit = (days: number): Condition[] => [{ field: "days_since_visit", op: "gte", value: days }];
const stillLost: Condition[] = [{ field: "status", op: "equals", value: "lost" }];
const stillSent: Condition[] = [{ field: "status", op: "equals", value: "sent" }];

export const AUTOMATED_CAMPAIGNS: Record<AutomatedKey, AutomatedCampaign> = {
  reengage: {
    key: "reengage",
    templateKey: "reengage_past_clients",
    name: "Re-engage past clients",
    trigger: "client.inactive",
    marketing: true,
    days: { min: 30, max: 730, default: INACTIVE_DEFAULT_DAYS },
    daysIn: "condition",
    conditions: sinceVisit,
    ruleName: () => "Re-engage past clients",
    ruleDescription: (days) => `Emails clients ${inactiveLabel(days).replace(/^1 /, "a ")} after their last visit, once each time they go quiet.`,
    starter: {
      template_key: "reengage_past_clients",
      name: "Re-engage past clients",
      description: "Emails clients a year after their last visit, once each time they go quiet.",
      trigger: "client.inactive",
      delay_minutes: 0,
      conditions: sinceVisit(INACTIVE_DEFAULT_DAYS),
      actions: [
        {
          type: "send_email",
          subject: "It's been a while, {{client.first_name}}",
          // The phone goes under the name, so a business without one leaves no "or call ." gap.
          body: "Hi {{client.first_name}},\n\nIt's been a while since we last worked together, and we'd love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr just reply to this email and we'll get you on the schedule.\n\nThanks,\n{{company.name}}\n{{company.phone}}",
        },
      ],
      enabled: false,
    },
  },
  win_back: {
    key: "win_back",
    templateKey: "win_back_lost_quotes",
    name: "Win back lost quotes",
    trigger: "quote.lost",
    marketing: true,
    days: { min: 1, max: 180, default: 30 },
    daysIn: "delay",
    conditions: () => stillLost,
    ruleName: () => "Win back lost quotes",
    ruleDescription: (days) => `Emails the client ${plural(days, "day")} after a quote is marked lost, if it still is.`,
    starter: {
      template_key: "win_back_lost_quotes",
      name: "Win back lost quotes",
      description: "Emails the client 30 days after a quote is marked lost, if it still is.",
      trigger: "quote.lost",
      delay_minutes: 43200,
      conditions: stillLost,
      actions: [
        {
          type: "send_email",
          subject: "Still thinking about {{title}}?",
          body: "Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn't right, or you'd like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email and we'll take another look.\n\nThanks,\n{{company.name}}\n{{company.phone}}",
        },
      ],
      enabled: false,
    },
  },
  close_quotes: {
    key: "close_quotes",
    templateKey: "quote_followup",
    name: "Close pending quotes",
    trigger: "quote.sent",
    marketing: false,
    days: { min: 1, max: 30, default: 3 },
    daysIn: "delay",
    conditions: () => stillSent,
    ruleName: (days) => `Follow up on quotes after ${plural(days, "day")}`,
    ruleDescription: (days) => `Emails the client if they haven't answered a quote ${plural(days, "day")} after you send it.`,
    // As every business has had it since 20261017000200_automations.sql.
    starter: {
      template_key: "quote_followup",
      name: "Follow up on quotes after 3 days",
      description: "Emails the client if they haven't answered a quote three days after you send it.",
      trigger: "quote.sent",
      delay_minutes: 4320,
      conditions: stillSent,
      actions: [
        {
          type: "send_email",
          subject: "Following up on your quote from {{company.name}}",
          body: "Hi {{client.first_name}},\n\nJust checking whether you had any questions about quote #{{number}} ({{total}}). You can review and approve it here:\n\n{{link}}\n\nThanks,\n{{company.name}}",
        },
      ],
      enabled: true,
    },
  },
};

export const AUTOMATED_KEYS = Object.keys(AUTOMATED_CAMPAIGNS) as AutomatedKey[];

export const automatedKeyOf = (templateKey: string | null | undefined): AutomatedKey | null =>
  AUTOMATED_KEYS.find((key) => AUTOMATED_CAMPAIGNS[key].templateKey === templateKey) ?? null;

/**
 * The campaign a rule sends as: its template key's, or Re-engage past clients for any rule on
 * client.inactive (a copy made in Automations too), since that trigger is Marketing's own.
 */
export function campaignKeyOf(rule: { template_key?: string | null; trigger: string }): AutomatedKey | null {
  return automatedKeyOf(rule.template_key) ?? (rule.trigger === "client.inactive" ? "reengage" : null);
}

/**
 * How many days without a visit a client.inactive rule waits for: the largest of its
 * days_since_visit conditions, since every condition has to hold, and never under 30. A rule with
 * none waits a year. The emitter reads it the same way (private.inactive_days).
 */
export function inactiveDays(conditions: unknown): number {
  const values = (Array.isArray(conditions) ? (conditions as Condition[]) : [])
    .filter((c) => c?.field === "days_since_visit" && c.op === "gte" && /^ *[0-9]+(\.[0-9]+)? *$/.test(String(c.value)))
    .map((c) => Math.min(Math.floor(Number(c.value)), 100_000));
  return values.length ? Math.max(30, ...values) : INACTIVE_DEFAULT_DAYS;
}

/**
 * Days from a client's last visit to now, counted in the company's own dates, as the emitter counts
 * them (private.inactive_clients): a visit late yesterday is a day ago this morning.
 */
export function daysSinceVisit(last: Date, now: Date, timeZone: string): number {
  return Math.round((Date.parse(localDate(now, timeZone)) - Date.parse(localDate(last, timeZone))) / 86_400_000);
}

/** Why `days` doesn't fit the campaign, or null. */
export function automatedDaysError(key: AutomatedKey, days: number): string | null {
  const { min, max } = AUTOMATED_CAMPAIGNS[key].days;
  return Number.isInteger(days) && days >= min && days <= max ? null : `Pick from ${min} to ${max} days.`;
}

export interface AutomatedRuleRow {
  name: string;
  description?: string | null;
  trigger: string;
  enabled: boolean;
  delay_minutes: number;
  conditions: unknown;
  actions: unknown;
}

export interface AutomatedForm {
  enabled: boolean;
  days: number;
  subject: string;
  body: string;
}

/** The days a rule's wait is, when it's a whole number of them. */
const delayDays = (minutes: number) => (minutes > 0 && minutes % 1440 === 0 ? minutes / 1440 : null);

/**
 * The card's view of the campaign's rule, or null when it was changed in Automations into something
 * the card can't show (another trigger, other conditions, more actions, a wait that isn't whole days
 * in range): then the card links to the rule and only its switch works here.
 */
export function readAutomatedRule(rule: AutomatedRuleRow | null | undefined, key: AutomatedKey): AutomatedForm | null {
  if (!rule) return null;
  const campaign = AUTOMATED_CAMPAIGNS[key];
  if (rule.trigger !== campaign.trigger) return null;
  const actions = rule.actions as Action[] | null;
  if (!Array.isArray(actions) || actions.length !== 1 || actions[0]!.type !== "send_email") return null;
  const email = actions[0] as Extract<Action, { type: "send_email" }>;
  if (typeof email.subject !== "string" || typeof email.body !== "string") return null;
  let days: number | null;
  if (campaign.daysIn === "condition") {
    const conditions = rule.conditions as Condition[] | null;
    const value = Array.isArray(conditions) && conditions.length === 1 ? Number(conditions[0]!.value) : NaN;
    days = rule.delay_minutes === 0 && sameConditions(rule.conditions, campaign.conditions(value)) ? value : null;
  } else {
    days = sameConditions(rule.conditions, campaign.conditions(0)) ? delayDays(rule.delay_minutes) : null;
  }
  if (days === null || automatedDaysError(key, days)) return null;
  return { enabled: rule.enabled, days, subject: email.subject, body: email.body };
}

/** A name or description the starter rule or the card wrote, for any N: the card replaces only these. */
function written(text: string | null | undefined, starter: string, generate: (days: number) => string, key: AutomatedKey): boolean {
  const clean = (text ?? "").trim();
  if (!clean || clean === starter) return true;
  const { min, max } = AUTOMATED_CAMPAIGNS[key].days;
  for (let days = min; days <= max; days++) if (generate(days) === clean) return true;
  return false;
}

/**
 * The change the card makes to the campaign's rule: its trigger, conditions, wait and email, the
 * name and description when they're still the starter's or the card's, and the switch when it's
 * given (Edit email never changes it). With no rule (it was deleted), the whole starter rule to put
 * back, with the form.
 */
export function automatedRuleUpdate(rule: AutomatedRuleRow | null | undefined, key: AutomatedKey, form: Partial<AutomatedForm>) {
  const campaign = AUTOMATED_CAMPAIGNS[key];
  const current = rule ? readAutomatedRule(rule, key) : null;
  const days = form.days ?? current?.days ?? campaign.days.default;
  const subject = form.subject ?? current?.subject ?? (campaign.starter.actions[0] as { subject: string }).subject;
  const body = form.body ?? current?.body ?? (campaign.starter.actions[0] as { body: string }).body;
  const change = {
    trigger: campaign.trigger,
    conditions: campaign.conditions(days),
    delay_minutes: campaign.daysIn === "delay" ? days * 1440 : 0,
    actions: [{ type: "send_email", subject, body }] as Action[],
    ...(form.enabled === undefined ? {} : { enabled: form.enabled }),
  };
  if (!rule) {
    const fresh = days === campaign.days.default;
    return {
      ...change,
      template_key: campaign.templateKey,
      name: fresh ? campaign.starter.name : campaign.ruleName(days),
      description: fresh ? campaign.starter.description : campaign.ruleDescription(days),
      enabled: form.enabled ?? false,
    };
  }
  const same = current?.days === days;
  return {
    ...change,
    ...(!same && written(rule.name, campaign.starter.name, campaign.ruleName, key) ? { name: campaign.ruleName(days) } : {}),
    ...(!same && written(rule.description, campaign.starter.description, campaign.ruleDescription, key) ? { description: campaign.ruleDescription(days) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Tracked links
// ---------------------------------------------------------------------------------------------

/** A link in an email's text, without the punctuation that ends a sentence (lib/email.ts links these). */
export const LINK_PATTERN = /https?:\/\/[^\s<>"]+[^\s<>.,;:!?)"']/g;

/** The http and https links in an email, each once, in order, up to MAX_TRACKED_LINKS: the ones that are tracked. */
export function trackableLinks(text: string): string[] {
  const links: string[] = [];
  for (const [url] of text.matchAll(LINK_PATTERN)) {
    if (!links.includes(url)) links.push(url);
    if (links.length === MAX_TRACKED_LINKS) break;
  }
  return links;
}

/** An email whose clicks can be counted: a link of its own, or {{link}}. */
export const hasTrackableLink = (text: string) => /\{\{\s*link\s*\}\}/i.test(text) || trackableLinks(text).length > 0;

/**
 * The button a {{link}} on its own line becomes, as the Client Hub names that page: the Hub's home
 * (a campaign's link, where a client can ask for work) is "Request work"; a quote's page is "View
 * online" (lib/email.ts). The preview draws the same button.
 */
export const HUB_HOME_BUTTON = "Request work";
export const HUB_PAGE_BUTTON = "View online";
export const linkButton = (key: AutomatedKey | "one_off") => (key === "close_quotes" ? HUB_PAGE_BUTTON : HUB_HOME_BUTTON);

const SIGN_OFF = /^(thanks|thank you|many thanks|best|all the best|cheers|sincerely|regards|kind regards|warm regards|warmly|talk soon|see you|—|-)/i;

/**
 * A one-off campaign's body with {{link}} (the client's Client Hub home, a Request work button) on a
 * line of its own, so its clicks and bookings can be counted: as written when it has one, otherwise
 * just before the sign-off ("Thanks,\n{{company.name}}"), or at the end. Write with AI's drafts
 * come back this way (routes/marketing.ts).
 */
export function withHubLink(body: string): string {
  if (/\{\{\s*link\s*\}\}/i.test(body)) return body;
  const paragraphs = body.trim().split(/\n{2,}/);
  const last = paragraphs.at(-1)?.trim() ?? "";
  const signOff = paragraphs.length > 1 && last.length <= 120 && last.split("\n").length <= 3 && (SIGN_OFF.test(last) || /\{\{\s*company\.name\s*\}\}\s*$/i.test(last));
  const out = signOff ? [...paragraphs.slice(0, -1), "{{link}}", last] : [...paragraphs, "{{link}}"];
  return out.join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export interface CampaignResults {
  campaign_id: string;
  kind?: string;
  template_key?: string | null;
  sent: number;
  opened: number;
  clicked: number;
  bookings: number;
  /** Paid invoices before tax; null for someone without the Invoices area. */
  revenue: number | null;
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Opened and clicked as whole percents of those sent. */
export const campaignRates = (r: Pick<CampaignResults, "sent" | "opened" | "clicked">) => ({ opened: percent(r.opened, r.sent), clicked: percent(r.clicked, r.sent) });

/** "120 sent · 46% opened · 9% clicked", or "Nothing sent yet". */
export function resultsLine(r: Pick<CampaignResults, "sent" | "opened" | "clicked"> | null | undefined): string {
  if (!r?.sent) return "Nothing sent yet";
  const rates = campaignRates(r);
  return `${r.sent.toLocaleString("en-US")} sent · ${rates.opened}% opened · ${rates.clicked}% clicked`;
}

/** The per-recipient view loads this many at a time. */
export const RECIPIENT_PAGE = 50;

/** The next page of a campaign's recipients after `loaded` of `total`, or null when they're all in. */
export const nextRecipientPage = (loaded: number, total: number) => (loaded < total ? { p_limit: RECIPIENT_PAGE, p_offset: loaded } : null);

/** An automated campaign as its rule has it (public.automated_campaign_states), for those who can't read the rule. */
export interface AutomatedState {
  template_key: string;
  rule_id: string;
  enabled: boolean;
  /** Its N, or null when the wait isn't whole days. */
  days: number | null;
  /** Emails still waiting to go. */
  waiting: number;
}

/** "1 booking", "3 bookings". */
export const bookingWords = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "booking" : "bookings"}`;

/** How many days a backlog of re-engage emails takes to go out, 100 a day. */
export const backlogDays = (count: number) => Math.ceil(Math.max(0, count) / REENGAGE_DAILY_CAP);

/** When a backlog goes out: "within a day" (100 or fewer), "100 a day over the next 6 days", "100 a day over about 3 weeks". */
export function backlogWords(count: number): string {
  const days = backlogDays(count);
  if (days <= 1) return "within a day";
  return `${REENGAGE_DAILY_CAP} a day over ${days < 14 ? `the next ${days} days` : `about ${Math.ceil(days / 7)} weeks`}`;
}

/** "43 past clients qualify now", "1 past client qualifies now". */
export const qualifyWords = (count: number) => `${count.toLocaleString("en-US")} past ${count === 1 ? "client qualifies" : "clients qualify"} now`;

/** Why a win-back email isn't sent after all: the client came back another way. Null when it goes. */
export function winBackSkip(since: { approvedSince?: boolean; activeJob?: boolean; jobSince?: boolean; newerQuote?: boolean; requestSince?: boolean }): string | null {
  if (since.approvedSince) return "They approved another quote since";
  if (since.activeJob) return "They have an active job";
  if (since.jobSince) return "They have a newer job";
  if (since.newerQuote) return "They have a newer quote";
  if (since.requestSince) return "They sent a request since";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Audiences
// ---------------------------------------------------------------------------------------------

export interface CampaignAudience {
  statuses?: string[];
  tags_any?: string[];
  tags_none?: string[];
  no_visit_days?: number | null;
  /** Cities, from their properties or billing address, as picked (the database matches them in any case). */
  cities?: string[];
  /** Services on their past jobs, as picked. */
  services?: string[];
  /** Has an active recurring job, or doesn't. */
  recurring?: "yes" | "no";
  /** An active recurring job ends in the next 30 days. */
  recurring_ending?: boolean;
}

/** Each once, in any case, as first written: a sent campaign shows "St. Louis", not "st. louis". */
function words(list: unknown): string[] {
  const out: string[] = [];
  for (const value of Array.isArray(list) ? list : []) {
    const word = String(value ?? "").trim();
    if (word && !out.some((w) => w.toLowerCase() === word.toLowerCase())) out.push(word);
  }
  return out;
}

/** The audience with the newer keys in the shape public.campaign_audience reads them; empty ones left out. */
export function audienceKeys(audience: CampaignAudience | null | undefined): CampaignAudience {
  const { cities, services, recurring, recurring_ending, ...rest } = audience ?? {};
  const out: CampaignAudience = { ...rest };
  const c = words(cities);
  const s = words(services);
  if (c.length) out.cities = c;
  if (s.length) out.services = s;
  if (recurring === "yes" || recurring === "no") out.recurring = recurring;
  if (recurring_ending === true) {
    out.recurring_ending = true;
    delete out.recurring;
  }
  return out;
}

export type RecurringChoice = "any" | "has" | "ending" | "none";

/** One choice for recurring work, so no pick matches nobody. */
export const RECURRING_CHOICES: ReadonlyArray<{ value: RecurringChoice; label: string }> = [
  { value: "any", label: "Any" },
  { value: "has", label: "Has an active recurring job" },
  { value: "ending", label: "Recurring job ends in the next 30 days" },
  { value: "none", label: "No active recurring job" },
];

export function recurringChoice(audience: CampaignAudience | null | undefined): RecurringChoice {
  if (audience?.recurring_ending) return "ending";
  return audience?.recurring === "yes" ? "has" : audience?.recurring === "no" ? "none" : "any";
}

export function withRecurringChoice(audience: CampaignAudience, choice: RecurringChoice): CampaignAudience {
  const { recurring: _recurring, recurring_ending: _ending, ...rest } = audience;
  if (choice === "has") return { ...rest, recurring: "yes" };
  if (choice === "none") return { ...rest, recurring: "no" };
  if (choice === "ending") return { ...rest, recurring_ending: true };
  return rest;
}
