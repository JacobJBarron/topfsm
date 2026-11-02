/**
 * How a recurring job's repeat reads on the job page, in sentence case: "Weekly, Monday and Thursday",
 * "Every 2 weeks, Tuesday", "Monthly, first Monday", "Monthly, the 15th". RRule's own wording
 * ("every month on the 1st Monday") is for rules this doesn't know, capitalized.
 */
import { describeRule } from "@crewtavo/core/recurrence";

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DAY_NAMES: Record<string, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
const NTH: Record<string, string> = { "1": "first", "2": "second", "3": "third", "4": "fourth", "5": "fifth", "-1": "last" };

const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
};
const joined = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function repeatText(rule: string): string {
  const parts: Record<string, string | undefined> = Object.fromEntries(rule.replace(/^RRULE:/i, "").split(";").map((p) => p.split("=")));
  const interval = Math.max(1, Number(parts.INTERVAL ?? 1) || 1);
  const every = (unit: string, once: string) => (interval === 1 ? once : `Every ${interval} ${unit}s`);
  const days = parts.BYDAY ? parts.BYDAY.split(",") : [];
  const plainDays = days.every((d) => WEEKDAYS.includes(d));
  const fallback = () => capitalized(describeRule(rule));

  if (parts.BYMONTH || parts.BYHOUR || parts.COUNT) return fallback();
  if (parts.FREQ === "DAILY" && !days.length) return every("day", "Daily");
  if (parts.FREQ === "WEEKLY" && plainDays) {
    const ordered = WEEKDAYS.filter((d) => days.includes(d));
    if (interval === 1 && ordered.join() === "MO,TU,WE,TH,FR") return "Every weekday";
    return [every("week", "Weekly"), joined(ordered.map((d) => DAY_NAMES[d]!))].filter(Boolean).join(", ");
  }
  if (parts.FREQ === "MONTHLY") {
    const head = every("month", "Monthly");
    if (!days.length && !parts.BYMONTHDAY) return head;
    if (!days.length && !parts.BYSETPOS) {
      const day = Number(parts.BYMONTHDAY);
      if (Number.isInteger(day) && day >= 1 && day <= 31) return `${head}, the ${ordinal(day)}`;
      if (day === -1) return `${head}, the last day`;
    }
    // "1MO", or "MO" with BYSETPOS=1: the first Monday.
    const nth = days.length === 1 && !parts.BYMONTHDAY ? /^([+-]?\d)?([A-Z]{2})$/.exec(days[0]!) : null;
    const position = nth ? String(Number(nth[1] ?? parts.BYSETPOS)) : "";
    if (nth && DAY_NAMES[nth[2]!] && NTH[position]) return `${head}, ${NTH[position]} ${DAY_NAMES[nth[2]!]}`;
  }
  if (parts.FREQ === "YEARLY" && !days.length && !parts.BYMONTHDAY) return every("year", "Yearly");
  return fallback();
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A season as it reads: "April to October" for months in a row, else "June, July and December"; null for all year. */
export function seasonText(months: readonly number[] | null | undefined): string | null {
  const sorted = [...new Set(months ?? [])].sort((a, b) => a - b);
  if (!sorted.length || sorted.length === 12) return null;
  const inRow = sorted.every((m, i) => i === 0 || m === sorted[i - 1]! + 1);
  if (inRow && sorted.length > 2) return `${MONTH_NAMES[sorted[0]! - 1]} to ${MONTH_NAMES[sorted.at(-1)! - 1]}`;
  return joined(sorted.map((m) => MONTH_NAMES[m - 1]!));
}

/** How often recurring work is done, as a quote tells the client: "Every 2 weeks, Tuesday, April to October". */
export function scheduleText(rule: string, months?: readonly number[] | null): string {
  return [repeatText(rule), seasonText(months)].filter(Boolean).join(", ");
}
