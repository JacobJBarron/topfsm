/**
 * Marketing → Campaigns' automated campaign cards (AutomatedCampaigns.tsx): what each shows, read
 * from its rule (packages/core/src/campaigns.ts says their shapes), what Edit email sends to PUT
 * /api/campaigns/automated/:key, and the sample values its preview and test use.
 */
import {
  AUTOMATED_CAMPAIGNS,
  AUTOMATED_KEYS,
  automatedDaysError,
  backlogWords,
  INACTIVE_CHOICES,
  inactiveLabel,
  readAutomatedRule,
  type AutomatedCampaign,
  type AutomatedForm,
  type AutomatedKey,
} from "@crewtavo/core/campaigns";

export interface AutomatedRuleRow {
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

export interface AutomatedCard {
  key: AutomatedKey;
  campaign: AutomatedCampaign;
  rule: AutomatedRuleRow | undefined;
  /** Changed in Automations into something the card can't show: only its switch works here. */
  custom: boolean;
  /** Deleted: turning it on puts it back. */
  missing: boolean;
  form: AutomatedForm;
}

/** Each campaign's rule, whether the card can show it, and the card as the rule is now. */
export function automatedRules(rules: AutomatedRuleRow[]): Record<AutomatedKey, AutomatedCard> {
  const cards = {} as Record<AutomatedKey, AutomatedCard>;
  for (const key of AUTOMATED_KEYS) {
    const campaign = AUTOMATED_CAMPAIGNS[key];
    const rule = rules.find((r) => r.template_key === campaign.templateKey);
    const read = readAutomatedRule(rule, key);
    const email = campaign.starter.actions[0] as { subject: string; body: string };
    cards[key] = {
      key,
      campaign,
      rule,
      custom: Boolean(rule && !read),
      missing: !rule,
      form: read ?? { enabled: rule?.enabled ?? false, days: campaign.days.default, subject: email.subject, body: email.body },
    };
  }
  return cards;
}

/** What Edit email's Save sends: never the switch. */
export const automatedBody = (form: Pick<AutomatedForm, "days" | "subject" | "body">) => ({ days: form.days, subject: form.subject.trim(), body: form.body.trim() });

export const daysError = (key: AutomatedKey, days: number) => automatedDaysError(key, days);

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The days a card offers, with one set in Automations that isn't among them as its own. */
export function dayChoices(key: AutomatedKey, current: number): Array<{ days: number; label: string }> {
  const choices =
    key === "reengage"
      ? [...INACTIVE_CHOICES]
      : (key === "win_back" ? [7, 14, 21, 30, 45, 60, 90, 120, 180] : Array.from({ length: 30 }, (_, i) => i + 1)).map((days) => ({ days, label: plural(days, "day") }));
  if (!choices.some((c) => c.days === current)) choices.push({ days: current, label: key === "reengage" ? inactiveLabel(current) : plural(current, "day") });
  return choices.sort((a, b) => a.days - b.days);
}

/** Edit email's tokens for a campaign: Close pending quotes' {{link}} is the quote's own page (its button reads View online). */
export function campaignTokens(key: AutomatedKey, tokens: ReadonlyArray<{ token: string; label: string }>) {
  return tokens.map(({ token, label }) => ({ token, label: key === "close_quotes" && token === "link" ? "Quote link (View online)" : label }));
}

/** "1 year", "3 days": how long N is, as the card says it. */
export const daysWords = (key: AutomatedKey, days: number) => (key === "reengage" ? inactiveLabel(days) : plural(days, "day"));

/** The sentence under a card's name: when it goes. */
export function timingLine(key: AutomatedKey, days: number): string {
  const n = daysWords(key, days);
  // "in a year", as the rule's own description says it, not "in 1 year".
  if (key === "reengage") return `Emails clients who haven't had a visit in ${n.replace(/^1 /, "a ")}, on the day they reach it.`;
  if (key === "win_back") return `Emails the client ${n} after a quote is marked lost.`;
  return `Emails the client ${n} after you send a quote they haven't answered.`;
}

/**
 * Sample values for the preview and Send a test: the person signed in as the client, a made-up
 * quote, a last visit N days ago, and `origin` for {{link}}. Re-engage is about a client, so its
 * {{title}} is the client's name, as the engine fills it in.
 */
export function sampleVars(key: AutomatedKey, who: { name: string; email: string | null; company: string; phone?: string | null }, days: number, origin: string, today = new Date()): Record<string, string> {
  const first = who.name.trim().split(/\s+/)[0] || "Jordan";
  const name = who.name || "Jordan Rivera";
  const last = new Date(today.getTime() - days * 86_400_000);
  return {
    "client.first_name": first,
    "client.name": name,
    "client.email": who.email ?? "",
    "client.phone": "",
    "company.name": who.company,
    "company.phone": who.phone ?? "",
    number: "1042",
    title: key === "reengage" ? name : "Spring cleanup",
    total: "$1,250.00",
    address: "12 Oak Street",
    status: key === "close_quotes" ? "Awaiting response" : key === "win_back" ? "Lost" : "Active",
    last_visit: last.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    link: origin,
  };
}

/**
 * What uninstalling Marketing does to the automated campaigns' emails still waiting (`winBacks`, or
 * null when that can't be read): win-back emails are cancelled for good, re-engage ones go once it's back.
 */
export function waitingWords(winBacks: number | null): string {
  const lost =
    winBacks === null
      ? "Win-back emails that are waiting are cancelled and aren't sent later."
      : winBacks
        ? `${winBacks.toLocaleString("en-US")} win-back ${winBacks === 1 ? "email is" : "emails are"} waiting: ${winBacks === 1 ? "it's" : "they're"} cancelled and not sent later.`
        : "";
  return [lost, "Past clients still due a re-engage email get it once Marketing is back."].filter(Boolean).join(" ");
}

/** "1 email waiting", "3 emails waiting": a card's emails still to go. */
export const waitingLine = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "email" : "emails"} waiting`;

/**
 * Turning Win back or Close pending quotes off with emails waiting (`count`, or null when that can't
 * be read): they're cancelled, and turning it back on doesn't send them.
 */
export function turnOffWords(key: AutomatedKey, count: number | null): string {
  const what = key === "close_quotes" ? "a follow-up" : "a win-back email";
  if (count === null) return `Any quotes waiting for ${what} are cancelled, and turning it back on won't send them.`;
  const one = count === 1;
  return `${one ? "1 quote is" : `${count.toLocaleString("en-US")} quotes are`} waiting for ${what}. Turning this off cancels ${one ? "it" : "them"}, and turning it back on won't send ${one ? "it" : "them"}.`;
}

/** Lowering Re-engage's wait while it's on: how many more clients that brings in, and when they get it. */
export function lowerWords(days: number, added: number, total: number): string {
  const who = added === 1 ? "1 client, who gets" : `${added.toLocaleString("en-US")} clients, who get`;
  return `Lowering it to ${daysWords("reengage", days)} adds ${who} it ${backlogWords(total)}.`;
}

/**
 * The overview's line under emails sent in 30 days: how many were automated and how many one-off
 * campaigns', and how many clients unsubscribed.
 */
export function emailsSentHint(s: { emails_sent_30d: number; automated_sent_30d?: number | null; opted_out: number }): string {
  const automated = Math.min(s.automated_sent_30d ?? 0, s.emails_sent_30d);
  const oneOff = s.emails_sent_30d - automated;
  const parts = s.emails_sent_30d
    ? [automated ? `${automated.toLocaleString("en-US")} automated` : null, oneOff ? `${oneOff.toLocaleString("en-US")} from one-off campaigns` : null].filter(Boolean).join(", ")
    : "None sent yet";
  return `${parts} · ${s.opted_out.toLocaleString("en-US")} unsubscribed`;
}
