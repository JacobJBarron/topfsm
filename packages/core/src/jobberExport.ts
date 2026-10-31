/**
 * Moving to Jobber: clients, quotes, jobs and invoices as the CSV files Jobber's own imports read
 * (Settings → Your data puts them in the download's jobber folder). The headers are exactly those of
 * Jobber's sample files (help.getjobber.com: Import Clients, Import Quotes, Import Jobs, Import
 * Invoices, as of October 2026); the quote, job and invoice imports take no others, and the client
 * import matches these by name. What Jobber can't take in stays out and is said so in its README:
 *   - quotes: Draft, Awaiting Response or Approved; 10 lines; 500 rows a file;
 *   - invoices: Draft, Sent or Paid, no payments; 10 lines; 500 rows a file;
 *   - jobs: one total price, no lines; weekly, every two weeks or monthly; 1,000 rows a file;
 *     nothing that started more than ten years ago;
 *   - clients: a row for each property; Jobber's own lead sources; about 5,000 rows a file.
 * Jobber finds a client again by email, then by name, so every file spells each one the same way.
 * A job still running starts from its next visit, so Jobber doesn't fill in past visits to invoice;
 * a finished one comes in as finished, invoiced never (its invoices are in the invoices file).
 */
import { normalizeKey } from "./clientImport";
import { lineTotal, taxPercent } from "./money";
import { phoneDisplay, phoneE164 } from "./phone";
import { describeRule, occurrenceDates } from "./recurrence";
import { addDays, localDate, localTime } from "./time";

export interface JobberAddress { line1?: string | null; line2?: string | null; city?: string | null; region?: string | null; postal_code?: string | null }
export interface JobberClient {
  id: string;
  display_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  lead_source: string | null;
  tags: readonly string[];
  notes: string | null;
  created_at: string;
  billing_address: JobberAddress | null;
}
export interface JobberContact { client_id: string; name: string; role: string | null; email: string | null; phone: string | null }
export interface JobberProperty extends JobberAddress { id: string; client_id: string; line1: string; country: string | null }
export interface JobberLine { name: string; description: string | null; quantity: number; unit_price: number; unit_cost?: number | null; taxable: boolean }
export interface JobberQuote {
  client_id: string;
  property_id: string | null;
  number: number | null;
  title: string;
  status: string;
  message: string | null;
  discount_amount: number;
  deposit_amount: number;
  tax_rate: number;
  sent_at: string | null;
  approved_at: string | null;
  /** The option the client chose or was shown, when the quote offers options. */
  option: string | null;
  /** The lines that count: selected ones, on the shown option or every option. */
  lines: JobberLine[];
}
export interface JobberVisit { date: string | null; starts_at: string | null; ends_at: string | null; status: string; people: string[] }
export interface JobberJob {
  client_id: string;
  property_id: string | null;
  number: number | null;
  title: string;
  instructions: string | null;
  kind: string;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
  recurrence_rule: string | null;
  active_months: number[] | null;
  billing_mode: string;
  /** "08:00" or "08:00:00"; null for anytime visits. */
  visit_start_time: string | null;
  visit_duration_min: number;
  lines: JobberLine[];
  visits: JobberVisit[];
}
export interface JobberInvoice {
  client_id: string;
  /** Its job's property, when it has a job. */
  property_id: string | null;
  number: number | null;
  subject: string | null;
  status: string;
  issued_on: string;
  due_on: string | null;
  discount_amount: number;
  /** Referral credits on it: Jobber has one discount, so they go into it. */
  credit_amount?: number;
  tax_rate: number;
  total: number;
  amount_paid: number;
  balance_due: number;
  retainage_amount: number;
  notes: string | null;
  lines: JobberLine[];
}
export interface JobberInput {
  timeZone: string;
  /** Today in the company's zone (YYYY-MM-DD). */
  today: string;
  clients: readonly JobberClient[];
  contacts: readonly JobberContact[];
  /** Each client's first property first. */
  properties: readonly JobberProperty[];
  quotes: readonly JobberQuote[];
  jobs: readonly JobberJob[];
  invoices: readonly JobberInvoice[];
}

export type JobberRow = Record<string, string | number>;
export interface JobberFile { name: string; columns: readonly string[]; rows: JobberRow[] }
export interface JobberExport {
  files: JobberFile[];
  counts: { clients: number; properties: number; quotes: number; jobs: number; invoices: number };
  /** What isn't in the files, or comes in differently, one sentence each. */
  notes: string[];
}

/** Rows a file holds: Jobber's limits (the client import's is 2.5 MB, about 5,000 rows). */
export const JOBBER_ROWS = { clients: 4000, quotes: 500, jobs: 1000, invoices: 500 } as const;
/** Lines Jobber's quote and invoice imports take on each one. */
export const JOBBER_LINES = 10;
export const JOBBER_LEAD_SOURCES = ["Facebook", "Google", "Instagram", "Flyer", "Referral", "Vehicle Wrap", "Other"] as const;

const BOOL = (value: boolean) => (value ? "TRUE" : "FALSE");

const CLIENT_COLUMNS = [
  "Client Created Date", "Client Is Company?", "Client First Name", "Client Last Name", "Client Full Name (Display Only)", "Client Company Name",
  "Client Email", "Client Main Phone",
  "Property Street 1", "Property Street 2", "Property City", "Property State/Province", "Property Zip/Postal Code", "Property Country",
  "Billing Street 1", "Billing Street 2", "Billing City", "Billing State/Province", "Billing Zip/Postal Code", "Billing Country",
  "Archived (True/False)", "Client Internal Notes", "Lead Source", "Tags",
] as const;

/** The client, property and billing columns every quote and invoice row starts with. */
const CLIENT_BLOCK = [
  "Jobber Client ID", "Client Title", "Client First Name", "Client Last Name", "Client Full Name (Display Only)", "Client Company Name", "Client Is a Company? (True/False)",
  "Client Email", "Client Main Phone", "Client Home Phone", "Client Work Phone", "Client Mobile Phone", "Client Fax Phone", "Client Other Phone", "Client SMS Enabled Phone Number",
  "Jobber Property ID", "Property Street 1", "Property Street 2", "Property City", "Property State/Province", "Property Zip/Postal Code", "Property Country",
  "Billing Street 1", "Billing Street 2", "Billing City", "Billing State/Province", "Billing Zip/Postal Code", "Billing Country",
  "Client Receives Auto Visit Reminders? (True/False)", "Client Receives Auto Job Follow-ups? (True/False)", "Client Receives Auto Quote Follow-ups? (True/False)",
  "Client Receives Auto Invoice Follow-ups? (True/False)", "Client Receives Auto Review Requests? (True/False)",
] as const;

const lineColumns = (fields: readonly string[]) => Array.from({ length: JOBBER_LINES }, (_, i) => fields.map((f) => `Line Item ${i + 1} ${f}`)).flat();
const QUOTE_LINE = ["Category (Service/Product)", "Name", "Description", "Quantity", "UNIT Price", "UNIT Cost", "Taxable (True/False)"];
const INVOICE_LINE = ["Category (Service/Product)", "Name", "Description", "Quantity", "TOTAL Price", "Taxable (True/False)"];

const QUOTE_COLUMNS = [
  ...CLIENT_BLOCK,
  "Quote Number", "Quote Title", "Quote Status (Draft/Awaiting Response/Approved)", "Quote Message", "Quote Internal Note",
  "Quote Introduction Title", "Quote Introduction Body", "Quote Contract Disclaimer",
  "Quote Discount Type (Unit/Percentage)", "Quote Discount Amount (Unit/Percentage)", "Quote Deposit Type (Unit/Percentage)", "Quote Deposit Amount (Unit/Percentage)",
  "Quote New Tax Rate Name", "Quote New Tax Rate (Percentage)", "Quote Existing Tax Rate Name", "Tax Method (Inclusive/Exclusive)",
  ...lineColumns(QUOTE_LINE),
];

const INVOICE_COLUMNS = [
  ...CLIENT_BLOCK,
  "Invoice Number", "Invoice Subject", "Invoice Status (Draft/Sent/Paid)", "Invoice Issued Date", "Invoice Due Date",
  "Invoice Discount Type (Unit/Percentage)", "Invoice Discount Amount (Unit/Percentage)",
  "Invoice New Tax Rate Name", "Invoice New Tax Rate (Percentage)", "Invoice Existing Tax Rate Name", "Tax Method (Inclusive/Exclusive)", "Invoice Internal Note",
  ...lineColumns(INVOICE_LINE),
];

const JOB_COLUMNS = [
  "Job Title", "Instructions", "Job Number", "Client Name", "Client Phone Number", "Client Email",
  "Full Property Address", "Street1", "Street2", "City", "State", "Zip", "Country",
  "Start Date", "Start Time", "End Time", "Repeating", "Duration Length", "Duration Unit",
  "How do you want to invoice?", "When do you want to invoice?", "Assigned To", "Total Price",
] as const;

export const JOBBER_COLUMNS = { clients: CLIENT_COLUMNS, quotes: QUOTE_COLUMNS, jobs: JOB_COLUMNS, invoices: INVOICE_COLUMNS } as const;

const QUOTE_STATUS: Record<string, string> = { draft: "Draft", sent: "Awaiting Response", changes_requested: "Awaiting Response", approved: "Approved", converted: "Approved" };
const INVOICE_STATUS: Record<string, string> = { draft: "Draft", sent: "Sent", overdue: "Sent", partially_paid: "Sent", paid: "Paid" };
/** A running job's billing, as Jobber's job import asks: how, then when. */
const INVOICING: Record<string, [string, string]> = {
  per_visit: ["Per visit", "Per visit"],
  on_completion: ["One price", "On complete"],
  fixed_schedule: ["Per visit", "Periodic"],
  progress: ["One price", "Never"],
};

/** Words that make a client's name a business's, not a person's ("Summit Ridge Builders", "Meadowbrook HOA", "Town of Vinton"). */
const BUSINESS =
  /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|company|ltd|llp|pllc|hoa|poa|association|assn|builders|construction|contracting|contractors?|developers?|development|properties|property|management|realty|realtors?|apartments|condos?|condominiums|enterprises|holdings|services|solutions|group|partners|industries|town of|city of|county|village of|township|public works|schools?|district|ministries|university|college|hospital|clinic|restaurant|hotel|motel|plaza|club|farms?|ranch|landscaping|lawn care|paving|roofing|plumbing|electric|hvac|cleaning|foundation)\b/i;

/**
 * A client's name as Jobber keeps it: a person's first and last ("Mary Ann Smith" is Mary Ann,
 * Smith), or a company's. A person keeps their company alongside ("Jane Doe" at "Doe LLC").
 */
export function jobberName(client: { display_name: string; company_name: string | null }): { first: string; last: string; company: string; isCompany: boolean } {
  const name = client.display_name.trim();
  const company = (client.company_name ?? "").trim();
  if ((company && normalizeKey(company) === normalizeKey(name)) || BUSINESS.test(name)) return { first: "", last: "", company: company || name, isCompany: true };
  const words = name.split(/\s+/).filter(Boolean);
  // "John Smith Jr." keeps Jr. with Smith.
  const lastWords = words.length > 2 && /^(jr|sr|ii|iii|iv)\.?$/i.test(words.at(-1)!) ? 2 : 1;
  if (words.length <= lastWords) return { first: name, last: "", company, isCompany: false };
  return { first: words.slice(0, -lastWords).join(" "), last: words.slice(-lastWords).join(" "), company, isCompany: false };
}

/** A lead source as one of Jobber's (it takes no others): "Yard sign" is Other, "Google Maps" is Google. */
export function jobberLeadSource(source: string | null | undefined): string {
  const s = (source ?? "").trim();
  if (!s) return "";
  const exact = JOBBER_LEAD_SOURCES.find((j) => normalizeKey(j) === normalizeKey(s));
  if (exact) return exact;
  if (/refer|friend|neighbou?r|word of mouth|repeat/i.test(s)) return "Referral";
  if (/google|search|maps/i.test(s)) return "Google";
  if (/facebook|\bfb\b|\bmeta\b/i.test(s)) return "Facebook";
  if (/instagram|\big\b/i.test(s)) return "Instagram";
  if (/flyer|flier|door ?hanger|mailer|postcard/i.test(s)) return "Flyer";
  if (/wrap|truck|vehicle/i.test(s)) return "Vehicle Wrap";
  return "Other";
}

let regions: Intl.DisplayNames | undefined;
/** "US" as "United States", as Jobber's samples write countries. */
export function countryName(code: string | null | undefined): string {
  const c = (code ?? "").trim();
  if (!/^[A-Za-z]{2}$/.test(c)) return c;
  try {
    regions ??= new Intl.DisplayNames(["en"], { type: "region" });
    return regions.of(c.toUpperCase()) ?? c;
  } catch {
    return c;
  }
}

/** A phone as people write it: "(540) 555-0100" for a US or Canadian number, otherwise as typed. */
const phone = (value: string | null) => {
  const e164 = phoneE164(value);
  return e164 ? phoneDisplay(e164) : (value ?? "").trim();
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parts = (date: string) => date.slice(0, 10).split("-").map(Number) as [number, number, number];
/** "Jan 1, 2024", as Jobber's job sample writes dates. */
const jobDate = (date: string) => {
  const [y, m, d] = parts(date);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
/** "12/25/2025", as Jobber's client sample writes them. */
const slashDate = (date: string) => {
  const [y, m, d] = parts(date);
  return `${m}/${d}/${y}`;
};
/** "2:00 PM" for "14:00". */
const clock = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const addMinutes = (time: string, minutes: number) => {
  const [h, m] = time.split(":").map(Number);
  const total = Math.min(h * 60 + m + minutes, 23 * 60 + 59);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
/** Days from one date to another, both counted. */
const daysThrough = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
/** "$4,675.99", for notes people read. */
const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (rate: number) => String(taxPercent(rate));
const taxName = (rate: number) => `Sales tax (${percent(rate)}%)`;

/** The weekly, every-two-weeks or monthly repeat Jobber's job import knows, or null for any other. */
export function jobberRepeat(rule: string | null | undefined): "Weekly" | "BiWeekly" | "Monthly" | null {
  if (!rule) return null;
  const p = Object.fromEntries(rule.toUpperCase().replace(/^RRULE:/, "").split(";").map((part) => part.split("=")));
  const interval = Number(p.INTERVAL ?? 1);
  if (p.BYMONTH || p.COUNT) return null;
  if (p.FREQ === "WEEKLY" && (!p.BYDAY || !String(p.BYDAY).includes(","))) return interval === 1 ? "Weekly" : interval === 2 ? "BiWeekly" : null;
  if (p.FREQ === "MONTHLY" && interval === 1 && !p.BYDAY) return "Monthly";
  return null;
}

/** Up to `room` lines; past that, the rest added up into one line (two when some are taxed and some aren't). */
export function fitLines(lines: readonly JobberLine[], room = JOBBER_LINES): JobberLine[] {
  if (lines.length <= room) return [...lines];
  for (let keep = room - 1; keep >= 0; keep--) {
    const groups = [true, false].map((taxed) => lines.slice(keep).filter((l) => l.taxable === taxed)).filter((g) => g.length);
    if (keep + groups.length > room) continue;
    return [
      ...lines.slice(0, keep),
      ...groups.map((group) => ({
        name: `${group.length} more items`,
        description: group.map((l) => `${l.quantity} x ${l.name}`).join("; "),
        quantity: 1,
        unit_price: group.reduce((n, l) => n + lineTotal(l.quantity, l.unit_price), 0),
        unit_cost: group.some((l) => l.unit_cost != null) ? group.reduce((n, l) => n + lineTotal(l.quantity, l.unit_cost ?? 0), 0) : null,
        taxable: group[0].taxable,
      })),
    ];
  }
  return [...lines];
}

/** Bytes a file holds, under the client import's 2.5 MB with room for the CSV's quotes and commas. */
export const JOBBER_BYTES = 2_000_000;

/** A string's length in UTF-8 bytes. */
function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Rows in files of at most `size` rows and about JOBBER_BYTES: "2-quotes.csv", or "2-quotes-part-1.csv"
 * and on when they don't fit in one.
 */
function split(name: string, columns: readonly string[], rows: JobberRow[], size: number, bytes = JOBBER_BYTES): JobberFile[] {
  const parts: JobberRow[][] = [];
  let used = 0;
  for (const row of rows) {
    const rowBytes = utf8Length(Object.values(row).join(",")) + columns.length;
    const last = parts.at(-1);
    if (!last || last.length >= size || used + rowBytes > bytes) {
      parts.push([row]);
      used = rowBytes;
    } else {
      last.push(row);
      used += rowBytes;
    }
  }
  if (parts.length === 1) return [{ name: `${name}.csv`, columns, rows: parts[0] }];
  return parts.map((part, i) => ({ name: `${name}-part-${i + 1}.csv`, columns, rows: part }));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function jobberExport(input: JobberInput): JobberExport {
  const { timeZone, today } = input;
  const clients = new Map(input.clients.map((c) => [c.id, c]));
  const properties = new Map(input.properties.map((p) => [p.id, p]));
  const propertiesOf = new Map<string, JobberProperty[]>();
  for (const p of input.properties) propertiesOf.set(p.client_id, [...(propertiesOf.get(p.client_id) ?? []), p]);
  const contactsOf = new Map<string, JobberContact[]>();
  for (const c of input.contacts) contactsOf.set(c.client_id, [...(contactsOf.get(c.client_id) ?? []), c]);
  const day = (instant: string) => localDate(new Date(instant), timeZone);
  /** The one it names when it's the client's, otherwise the client's first. */
  const propertyFor = (id: string | null, clientId: string) => {
    const named = id ? properties.get(id) : undefined;
    return named?.client_id === clientId ? named : propertiesOf.get(clientId)?.[0];
  };
  const notes: string[] = [];
  let fitted = 0;

  const billingCells = (client: JobberClient) => {
    const b = client.billing_address;
    return {
      "Billing Street 1": b?.line1 ?? "", "Billing Street 2": b?.line2 ?? "", "Billing City": b?.city ?? "",
      "Billing State/Province": b?.region ?? "", "Billing Zip/Postal Code": b?.postal_code ?? "",
      "Billing Country": b?.line1 ? countryName(propertiesOf.get(client.id)?.[0]?.country) : "",
    };
  };
  const propertyCells = (p: JobberProperty | undefined) => ({
    "Property Street 1": p?.line1 ?? "", "Property Street 2": p?.line2 ?? "", "Property City": p?.city ?? "",
    "Property State/Province": p?.region ?? "", "Property Zip/Postal Code": p?.postal_code ?? "", "Property Country": p ? countryName(p.country) : "",
  });
  /** The client, property and billing columns of a quote or invoice row. Auto messages off: they're only used for a client Jobber doesn't have yet. */
  const clientBlock = (client: JobberClient, property: JobberProperty | undefined): JobberRow => {
    const name = jobberName(client);
    return {
      "Client First Name": name.first, "Client Last Name": name.last, "Client Full Name (Display Only)": client.display_name,
      "Client Company Name": name.company, "Client Is a Company? (True/False)": BOOL(name.isCompany),
      "Client Email": client.email ?? "", "Client Main Phone": phone(client.phone),
      ...propertyCells(property), ...billingCells(client),
      "Client Receives Auto Visit Reminders? (True/False)": "FALSE", "Client Receives Auto Job Follow-ups? (True/False)": "FALSE",
      "Client Receives Auto Quote Follow-ups? (True/False)": "FALSE", "Client Receives Auto Invoice Follow-ups? (True/False)": "FALSE",
      "Client Receives Auto Review Requests? (True/False)": "FALSE",
    };
  };
  const lineCells = (lines: readonly JobberLine[], price: "unit" | "total"): JobberRow => {
    if (lines.length > JOBBER_LINES) fitted++;
    const row: JobberRow = {};
    fitLines(lines).forEach((l, i) => {
      const at = `Line Item ${i + 1}`;
      row[`${at} Category (Service/Product)`] = "Service";
      row[`${at} Name`] = l.name;
      row[`${at} Description`] = l.description ?? "";
      row[`${at} Quantity`] = l.quantity;
      if (price === "unit") {
        row[`${at} UNIT Price`] = l.unit_price;
        row[`${at} UNIT Cost`] = l.unit_cost ?? "";
      } else {
        row[`${at} TOTAL Price`] = lineTotal(l.quantity, l.unit_price);
      }
      row[`${at} Taxable (True/False)`] = BOOL(l.taxable);
    });
    return row;
  };

  // Clients: a row for each property, the client's columns on each.
  const clientRows: JobberRow[] = [];
  const sorted = [...input.clients].sort((a, b) => a.display_name.localeCompare(b.display_name));
  for (const client of sorted) {
    const name = jobberName(client);
    const others = (contactsOf.get(client.id) ?? []).map((c) => [c.name, c.role && `(${c.role})`, c.email, phone(c.phone)].filter(Boolean).join(" "));
    const base: JobberRow = {
      "Client Created Date": slashDate(day(client.created_at)), "Client Is Company?": BOOL(name.isCompany),
      "Client First Name": name.first, "Client Last Name": name.last, "Client Full Name (Display Only)": client.display_name, "Client Company Name": name.company,
      "Client Email": client.email ?? "", "Client Main Phone": phone(client.phone), ...billingCells(client),
      "Archived (True/False)": BOOL(client.status === "archived"),
      "Client Internal Notes": [client.notes?.trim(), others.length ? `Other contacts: ${others.join("; ")}` : null].filter(Boolean).join("\n\n"),
      "Lead Source": jobberLeadSource(client.lead_source),
      "Tags": [...client.tags, ...(client.status === "lead" ? ["Lead"] : [])].join(", "),
    };
    const own = propertiesOf.get(client.id) ?? [];
    for (const p of own.length ? own : [undefined]) clientRows.push({ ...base, ...propertyCells(p) });
  }

  // Quotes Jobber has a status for, with a property (it needs one).
  const quoteRows: JobberRow[] = [];
  let quotesLeft = 0;
  let quotesNoAddress = 0;
  for (const q of [...input.quotes].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
    const client = clients.get(q.client_id);
    const status = QUOTE_STATUS[q.status];
    if (!client || !status) {
      quotesLeft++;
      continue;
    }
    const property = propertyFor(q.property_id, client.id);
    if (!property) {
      quotesNoAddress++;
      continue;
    }
    const history = [q.option && `Option: ${q.option}.`, q.sent_at && `Sent ${jobDate(day(q.sent_at))}.`, q.approved_at && `Approved ${jobDate(day(q.approved_at))}.`].filter(Boolean);
    quoteRows.push({
      ...clientBlock(client, property),
      "Quote Number": q.number ?? "", "Quote Title": q.title, "Quote Status (Draft/Awaiting Response/Approved)": status,
      "Quote Message": q.message ?? "", "Quote Internal Note": history.length ? `From Crewtavo. ${history.join(" ")}` : "",
      ...(q.discount_amount > 0 && { "Quote Discount Type (Unit/Percentage)": "Unit", "Quote Discount Amount (Unit/Percentage)": q.discount_amount }),
      ...(q.deposit_amount > 0 && { "Quote Deposit Type (Unit/Percentage)": "Unit", "Quote Deposit Amount (Unit/Percentage)": q.deposit_amount }),
      ...(q.tax_rate > 0 && { "Quote New Tax Rate Name": taxName(q.tax_rate), "Quote New Tax Rate (Percentage)": percent(q.tax_rate), "Tax Method (Inclusive/Exclusive)": "Exclusive" }),
      ...lineCells(q.lines, "unit"),
    });
  }
  if (quotesLeft) notes.push(`${plural(quotesLeft, "lost or archived quote")} ${quotesLeft === 1 ? "isn't" : "aren't"} in the quotes file: Jobber's import takes draft, sent and approved quotes.`);
  if (quotesNoAddress) notes.push(`${plural(quotesNoAddress, "quote")} for clients without an address ${quotesNoAddress === 1 ? "isn't" : "aren't"} in the quotes file: Jobber needs a property for each quote.`);

  // Jobs: a running one from its next visit; a finished one as it was, never to be invoiced.
  const jobRows: JobberRow[] = [];
  const tenYearsAgo = `${Number(today.slice(0, 4)) - 10}${today.slice(4)}`;
  let jobsNoAddress = 0;
  let jobsOld = 0;
  let jobsUnscheduled = 0;
  let jobsToInvoice = 0;
  let jobsAsNeeded = 0;
  let jobsMoreVisits = 0;
  for (const job of [...input.jobs].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
    const client = clients.get(job.client_id);
    if (!client) continue;
    const property = propertyFor(job.property_id, client.id);
    if (!property) {
      jobsNoAddress++;
      continue;
    }
    const dated = job.visits.filter((v) => v.date && v.status !== "cancelled").sort((a, b) => a.date!.localeCompare(b.date!));
    const next = dated.find((v) => v.date! >= today && v.status !== "completed");
    const recurring = job.kind === "recurring" && Boolean(job.recurrence_rule);
    const repeat = recurring ? jobberRepeat(job.recurrence_rule) : null;
    const extra: string[] = [];
    let start: string | null;
    let visit: JobberVisit | undefined;
    let length = "";
    let invoicing: [string, string];
    const nextDate = recurring
      ? next?.date ?? occurrenceDates({ starts_on: job.starts_on ?? today, ends_on: job.ends_on, recurrence_rule: job.recurrence_rule!, active_months: job.active_months }, job.starts_on && job.starts_on > today ? job.starts_on : today, addDays(today, 400))[0]
      : next?.date;
    if (job.status === "active" && (nextDate || !recurring)) {
      start = nextDate ?? null;
      visit = next;
      if (recurring && start) length = String(job.ends_on ? Math.max(1, daysThrough(start, job.ends_on)) : 365);
      if (!start) jobsUnscheduled++;
      if (!recurring && dated.filter((v) => v.date! >= today && v.status !== "completed").length > 1) jobsMoreVisits++;
      invoicing = INVOICING[job.billing_mode] ?? INVOICING.on_completion;
      if (!recurring && job.billing_mode === "fixed_schedule") invoicing = INVOICING.on_completion;
    } else {
      const done = dated.filter((v) => v.date! < today);
      start = dated[0]?.date ?? job.starts_on;
      visit = dated[0];
      if (!start) continue;
      if (start < tenYearsAgo) {
        jobsOld++;
        continue;
      }
      if (recurring) {
        const last = [done.at(-1)?.date ?? job.ends_on ?? start, addDays(today, -1)].sort()[0];
        length = String(Math.max(1, daysThrough(start, last < start ? start : last)));
      }
      if (job.status === "requires_invoicing") jobsToInvoice++;
      invoicing = ["One price", "Never"];
    }
    if (recurring && !repeat) {
      jobsAsNeeded++;
      extra.push(`Repeats ${describeRule(job.recurrence_rule!)} in Crewtavo.`);
    }
    if (recurring && job.active_months?.length && job.active_months.length < 12) extra.push(`In season ${job.active_months.map((m) => MONTHS[m - 1]).join(", ")}.`);
    const from = visit?.starts_at ? localTime(new Date(visit.starts_at), timeZone) : recurring ? job.visit_start_time?.slice(0, 5) : null;
    const to = visit?.starts_at ? (visit.ends_at ? localTime(new Date(visit.ends_at), timeZone) : null) : from ? addMinutes(from, job.visit_duration_min) : null;
    jobRows.push({
      "Job Title": job.title,
      "Instructions": [job.instructions?.trim(), ...extra].filter(Boolean).join("\n\n"),
      "Job Number": job.number ?? "",
      "Client Name": client.display_name, "Client Phone Number": phone(client.phone), "Client Email": client.email ?? "",
      "Street1": property.line1, "Street2": property.line2 ?? "", "City": property.city ?? "", "State": property.region ?? "",
      "Zip": property.postal_code ?? "", "Country": countryName(property.country),
      "Start Date": start ? jobDate(start) : "",
      "Start Time": start && from ? clock(from) : "", "End Time": start && from && to ? clock(to) : "",
      "Repeating": !recurring ? "DoesNotRepeat" : repeat ?? "AsNeeded",
      "Duration Length": recurring && length ? length : "", "Duration Unit": recurring && length ? "days" : "",
      "How do you want to invoice?": invoicing[0], "When do you want to invoice?": invoicing[1],
      "Assigned To": (visit?.people ?? []).join(", "),
      "Total Price": money(job.lines.reduce((n, l) => n + lineTotal(l.quantity, l.unit_price), 0)),
    });
  }
  if (jobsNoAddress) notes.push(`${plural(jobsNoAddress, "job")} without an address ${jobsNoAddress === 1 ? "isn't" : "aren't"} in the jobs file: Jobber needs one for each job.`);
  if (jobsOld) notes.push(`${plural(jobsOld, "job")} that started more than ten years ago ${jobsOld === 1 ? "isn't" : "aren't"} in the jobs file: Jobber's import doesn't take them.`);
  if (jobsUnscheduled) notes.push(`${plural(jobsUnscheduled, "running job")} with no visit coming up ${jobsUnscheduled === 1 ? "comes" : "come"} in unscheduled, for you to schedule in Jobber.`);
  if (jobsMoreVisits) notes.push(`${plural(jobsMoreVisits, "one-off job")} with more than one visit still to come ${jobsMoreVisits === 1 ? "comes" : "come"} in with the next visit only: add the others in Jobber (they're all in visits.csv).`);
  if (jobsToInvoice) notes.push(`${plural(jobsToInvoice, "job")} waiting to be invoiced ${jobsToInvoice === 1 ? "comes" : "come"} in as finished: make ${jobsToInvoice === 1 ? "its invoice" : "their invoices"} in Jobber.`);
  if (jobsAsNeeded) notes.push(`${plural(jobsAsNeeded, "recurring job")} that doesn't repeat weekly, every two weeks or monthly ${jobsAsNeeded === 1 ? "comes" : "come"} in as "as needed", with ${jobsAsNeeded === 1 ? "its" : "their"} schedule in the instructions.`);

  // Invoices Jobber has a status for; payments as a note, since its import has none.
  const invoiceRows: JobberRow[] = [];
  let invoicesLeft = 0;
  let partlyPaid = 0;
  for (const inv of [...input.invoices].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
    const client = clients.get(inv.client_id);
    const status = INVOICE_STATUS[inv.status];
    if (!client || !status) {
      invoicesLeft++;
      continue;
    }
    const paidSome = status === "Sent" && inv.amount_paid > 0;
    if (paidSome) partlyPaid++;
    const internal = [
      paidSome && `Paid ${dollars(inv.amount_paid)} of ${dollars(inv.total)} in Crewtavo; ${dollars(inv.balance_due)} left. Record the payment in Jobber.`,
      inv.retainage_amount > 0 && `Retainage held: ${dollars(inv.retainage_amount)}.`,
      inv.notes?.trim(),
    ].filter(Boolean);
    const discount = Math.round((inv.discount_amount + (inv.credit_amount ?? 0)) * 100) / 100;
    invoiceRows.push({
      ...clientBlock(client, propertyFor(inv.property_id, client.id)),
      "Invoice Number": inv.number ?? "", "Invoice Subject": inv.subject?.trim() || `Invoice ${inv.number ?? ""}`.trim(),
      "Invoice Status (Draft/Sent/Paid)": status, "Invoice Issued Date": inv.issued_on, "Invoice Due Date": inv.due_on ?? "",
      ...(discount > 0 && { "Invoice Discount Type (Unit/Percentage)": "Unit", "Invoice Discount Amount (Unit/Percentage)": discount }),
      ...(inv.tax_rate > 0 && { "Invoice New Tax Rate Name": taxName(inv.tax_rate), "Invoice New Tax Rate (Percentage)": percent(inv.tax_rate), "Tax Method (Inclusive/Exclusive)": "Exclusive" }),
      "Invoice Internal Note": internal.join("\n\n"),
      ...lineCells(inv.lines, "total"),
    });
  }
  if (invoicesLeft) notes.push(`${plural(invoicesLeft, "void or written-off invoice")} ${invoicesLeft === 1 ? "isn't" : "aren't"} in the invoices file: Jobber's import takes draft, sent and paid invoices.`);
  notes.push(
    partlyPaid
      ? `Jobber's invoice import has no payments. Paid invoices come in as paid. ${plural(partlyPaid, "partly paid invoice")} ${partlyPaid === 1 ? "comes" : "come"} in as sent, with what was paid in ${partlyPaid === 1 ? "its" : "their"} internal note: record those payments in Jobber.`
      : "Jobber's invoice import has no payments: paid invoices come in as paid, without the payments themselves.",
  );
  notes.push("Jobs come in with their total price, not their line items: Jobber's job import has no lines. Quotes and invoices keep theirs.");
  if (fitted) notes.push(`${plural(fitted, "quote or invoice", "quotes and invoices")} with more than ${JOBBER_LINES} lines ${fitted === 1 ? "has" : "have"} the rest added up into one line (two when some are taxed and some aren't).`);

  return {
    files: [
      ...split("1-clients", CLIENT_COLUMNS, clientRows, JOBBER_ROWS.clients),
      ...split("2-quotes", QUOTE_COLUMNS, quoteRows, JOBBER_ROWS.quotes),
      ...split("3-jobs", JOB_COLUMNS, jobRows, JOBBER_ROWS.jobs),
      ...split("4-invoices", INVOICE_COLUMNS, invoiceRows, JOBBER_ROWS.invoices),
    ],
    counts: { clients: input.clients.length, properties: input.properties.filter((p) => clients.has(p.client_id)).length, quotes: quoteRows.length, jobs: jobRows.length, invoices: invoiceRows.length },
    notes,
  };
}

/** How to bring the files into Jobber, and what doesn't come over: the jobber folder's READ ME. */
export function jobberReadme(result: JobberExport): string {
  const names = (prefix: string) => result.files.filter((f) => f.name.startsWith(prefix)).map((f) => f.name);
  const step = (n: number, what: string, prefix: string, where: string) => {
    const files = names(prefix);
    return files.length ? [`${n}. ${what}: ${files.join(", ")}`, `   ${where}`] : [`${n}. ${what}: nothing to bring over.`];
  };
  return [
    "MOVING TO JOBBER",
    "",
    "These files are laid out the way Jobber's own imports read them, with the column names from",
    "Jobber's sample files. Bring them in as an admin in Jobber, in this order, so the quotes, jobs",
    "and invoices find the clients and properties that are already there.",
    "",
    ...step(1, `Clients and properties (${plural(result.counts.clients, "client")}, ${plural(result.counts.properties, "property", "properties")})`, "1-clients", "In Jobber: Clients, then Import from the More Actions menu. Check the column matches before you finish."),
    ...step(2, `Quotes (${plural(result.counts.quotes, "quote")})`, "2-quotes", "In Jobber: Quotes, then Import under More Actions."),
    ...step(3, `Jobs (${plural(result.counts.jobs, "job")})`, "3-jobs", "In Jobber: Jobs, then Import under More Actions. Jobber's job import is a beta."),
    ...step(4, `Invoices (${plural(result.counts.invoices, "invoice")})`, "4-invoices", "In Jobber: Invoices, then More Actions, then Invoice Imports."),
    "",
    "Upload each file as it is: Jobber's quote, job and invoice imports need these exact column names.",
    "A file with \"part-1\", \"part-2\" in its name was split to fit Jobber's limit; import every part.",
    "Jobber can undo an import for a short while after it finishes, if something looks wrong.",
    "",
    "Jobber finds a client again by email, then by name, exactly as written. So import the clients",
    "first and don't rename anyone in Jobber until the rest is in.",
    "",
    "WHAT COMES IN DIFFERENTLY",
    "",
    ...result.notes.map((n) => `- ${n}`),
    "- Taxes come in as a tax rate named for its percent, like \"Sales tax (8.25%)\".",
    "- Visit reminders and follow-ups are off for any client Jobber makes from the quotes or invoices",
    "  files; the clients file leaves them to your Jobber settings.",
    "- Visits already done, timesheets, expenses, the price list, equipment and your team aren't",
    "  part of Jobber's imports. They're in the spreadsheets folder, to keep or to enter by hand.",
    "",
    "Jobber's help center explains each import: search help.getjobber.com for \"Import clients\",",
    "\"Import quotes\", \"Import jobs\" or \"Import invoices\".",
    "",
  ].join("\r\n");
}
