/**
 * Settings → Your data: everything the business keeps in Crewtavo as one .zip, gathered here in the
 * browser with the owner's own sign-in, so the database's rules decide what's read, as on any screen.
 *   - spreadsheets/: a CSV of each kind of record with plain column names, for Excel, Google Sheets,
 *     Numbers, or another app's import (most match the columns themselves, as Housecall Pro's does).
 *     Records name each other the way people do (the client, Job #12), and end with their IDs.
 *   - jobber/: clients, quotes, jobs and invoices laid out for Jobber's imports (jobberExport in
 *     core), with a READ ME on bringing them in.
 *   - READ ME.txt: what's where.
 * Photos and other files aren't in it yet, and nothing secret is (the keys of connected apps).
 */
import { jobberExport, jobberReadme, type JobberLine, type JobberVisit } from "@crewtavo/core/jobberExport";
import { lineTotal, taxPercent } from "@crewtavo/core/money";
import { describeRule } from "@crewtavo/core/recurrence";
import { ROLE_LABELS, type Role } from "@crewtavo/core/roles";
import { localDate, localTime } from "@crewtavo/core/time";
import { api, supabase, unwrap } from "@/lib/api";
import { toCsv } from "@/lib/csv";
import { todayIn } from "@/lib/format";
import type { Session } from "@/lib/session";
import { zip } from "@/lib/zip";

const PAGE = 1000;
type DbError = { message: string; code?: string; details?: string | null; hint?: string | null };

/** Every row a query finds, a page at a time (the database sends at most 1,000 at once). */
async function everyRow<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: DbError | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const batch = unwrap(await page(from, from + PAGE - 1));
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

interface Member { user_id: string; role: Role; active: boolean; labor_rate: number | null; profile: { full_name: string; email: string | null; phone: string | null } | null; sub?: { id: string; name: string } }
type Column<T> = readonly [label: string, value: (row: T) => unknown];
interface Sheet { name: string; rows: number; csv: string }

/** A spreadsheet of `rows`, one column for each label. */
function sheet<T>(name: string, rows: readonly T[], columns: ReadonlyArray<Column<T>>): Sheet {
  const keys = columns.map(([label], i) => ({ key: String(i), label }));
  return { name, rows: rows.length, csv: toCsv(rows.map((row) => Object.fromEntries(columns.map(([, value], i) => [String(i), value(row)]))), keys) };
}

const yes = (value: boolean | null | undefined) => (value ? "Yes" : "No");
/** "partially_paid" as "Partially paid". */
const words = (value: string | null | undefined) => (value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ") : "");
const byNumber = (a: { number: number | null }, b: { number: number | null }) => (a.number ?? Infinity) - (b.number ?? Infinity);
const sumLines = (lines: ReadonlyArray<{ quantity: number; unit_price: number }>) => lines.reduce((n, l) => n + lineTotal(l.quantity, l.unit_price), 0);

function group<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row]);
  return out;
}

/** Everything as one .zip, and its file name. `step` hears what's being read, for the button. */
export async function exportEverything(session: Session, step: (what: string) => void): Promise<{ name: string; blob: Blob }> {
  const companyId = session.company.id;
  const timeZone = session.company.timezone;
  const today = todayIn(timeZone);
  const db = supabase();
  const day = (instant: string | null) => (instant ? localDate(new Date(instant), timeZone) : "");
  const when = (instant: string | null) => (instant ? `${localDate(new Date(instant), timeZone)} ${localTime(new Date(instant), timeZone)}` : "");

  step("Reading clients…");
  const [clients, contacts, properties, requests, members] = await Promise.all([
    everyRow((from, to) => db.from("clients").select("id, display_name, company_name, email, phone, status, lead_source, referred_by, tags, notes, billing_address, marketing_opt_out, review_opt_out, sms_opt_out_at, created_at").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("client_contacts").select("id, client_id, name, role, email, phone, is_primary, notify_email, notify_sms").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("properties").select("id, client_id, label, line1, line2, city, region, postal_code, country, lot_size_sqft, tags, notes, lat, lng, created_at").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("requests").select("id, number, title, client_id, property_id, status, source, details, created_at").eq("company_id", companyId).order("id").range(from, to)),
    api.get<Member[]>("/team?with_subs=1"),
  ]);

  step("Reading quotes and jobs…");
  const [quotes, options, quoteLines, jobs, jobLines] = await Promise.all([
    everyRow((from, to) => db.from("quotes").select("id, number, title, client_id, property_id, status, option_id, subtotal, discount_amount, tax_rate, tax_amount, total, deposit_amount, message, lost_reason, salesperson_id, created_at, sent_at, approved_at, valid_until").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("quote_options").select("id, quote_id, name, tier").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("quote_line_items").select("id, quote_id, option_id, sort, name, description, quantity, unit, unit_price, unit_cost, taxable, optional, selected").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("jobs").select("id, number, title, client_id, property_id, quote_id, kind, status, starts_on, ends_on, recurrence_rule, active_months, billing_mode, instructions, po_number, permit_number, warranty_until, visit_start_time, visit_duration_min, created_at").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("job_line_items").select("id, job_id, sort, name, description, quantity, unit, unit_price, unit_cost, taxable").eq("company_id", companyId).order("id").range(from, to)),
  ]);

  step("Reading visits and invoices…");
  const [visits, assignees, crews, crewMembers, invoices, invoiceLines, payments] = await Promise.all([
    everyRow((from, to) => db.from("visits").select("id, job_id, request_id, property_id, kind, title, status, scheduled_on, starts_at, ends_at, crew_id, notes, completed_at, invoice_id").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("visit_assignees").select("visit_id, user_id").eq("company_id", companyId).order("visit_id").order("user_id").range(from, to)),
    everyRow((from, to) => db.from("crews").select("id, name, lead_user_id, active").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("crew_members").select("crew_id, user_id").eq("company_id", companyId).order("crew_id").order("user_id").range(from, to)),
    everyRow((from, to) => db.from("invoices").select("id, number, subject, client_id, job_id, kind, status, issued_on, due_on, subtotal, discount_amount, credit_amount, tax_rate, tax_amount, total, amount_paid, balance_due, retainage_amount, notes, sent_at, written_off_at").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("invoice_line_items").select("id, invoice_id, sort, name, description, quantity, unit, unit_price, taxable").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("payments").select("id, client_id, invoice_id, amount, tip_amount, fee_amount, method, processor, processor_ref, received_at, notes").eq("company_id", companyId).order("id").range(from, to)),
  ]);

  step("Reading time, expenses and equipment…");
  const [services, timeEntries, expenses, equipment, equipmentLogs, subs] = await Promise.all([
    everyRow((from, to) => db.from("services").select("id, category, name, description, unit, unit_price, unit_cost, labor_cost, taxable, active, sort").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("time_entries").select("id, user_id, started_at, ended_at, category, job_id, notes, approved_at").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("expenses").select("id, incurred_on, vendor, category, description, amount, job_id, equipment_id, user_id, reimbursable, reimbursed_at").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("equipment").select("id, name, kind, make, model, year, serial, plate, status, meter, meter_reading, meter_read_on, purchased_on, crew_id, notes").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("equipment_logs").select("id, equipment_id, done_on, kind, title, meter_reading, notes, user_id").eq("company_id", companyId).order("id").range(from, to)),
    everyRow((from, to) => db.from("subcontractors").select("id, name, contact_name, email, phone, trade, tax_classification, active, notes, address").eq("company_id", companyId).order("id").range(from, to)),
  ]);

  // People by name: the team, then anyone who has left but is still on old visits and timesheets.
  const people = new Map(members.map((m) => [m.user_id, m.profile?.full_name || m.profile?.email || "Team member"]));
  const missing = [
    ...new Set([...assignees.map((a) => a.user_id), ...timeEntries.map((t) => t.user_id), ...expenses.map((e) => e.user_id), ...equipmentLogs.map((l) => l.user_id), ...quotes.map((q) => q.salesperson_id)]),
  ].filter((id): id is string => Boolean(id) && !people.has(id!));
  for (let at = 0; at < missing.length; at += 200) {
    for (const p of unwrap(await db.from("profiles").select("user_id, full_name").in("user_id", missing.slice(at, at + 200)))) people.set(p.user_id, p.full_name);
  }
  const person = (id: string | null) => (id ? people.get(id) ?? "Former team member" : "");

  step("Packing the .zip…");
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const requestById = new Map(requests.map((r) => [r.id, r]));
  const optionById = new Map(options.map((o) => [o.id, o]));
  const crewById = new Map(crews.map((c) => [c.id, c]));
  const equipmentById = new Map(equipment.map((e) => [e.id, e]));
  const clientName = (id: string | null | undefined) => (id ? clientById.get(id)?.display_name ?? "" : "");
  const address = (id: string | null | undefined) => {
    const p = id ? propertyById.get(id) : undefined;
    return p ? [p.line1, p.line2, p.city, [p.region, p.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  };
  const jobNumber = (id: string | null | undefined) => (id ? jobById.get(id)?.number ?? "" : "");
  const linesOf = { quote: group(quoteLines, (l) => l.quote_id), job: group(jobLines, (l) => l.job_id), invoice: group(invoiceLines, (l) => l.invoice_id) };
  const sortLines = <L extends { sort: number }>(lines: L[] | undefined) => [...(lines ?? [])].sort((a, b) => a.sort - b.sort);
  const visitsOf = group(visits, (v) => v.job_id);
  const assigned = group(assignees, (a) => a.visit_id);
  const membersOf = group(crewMembers, (m) => m.crew_id);
  const peopleOn = (visitId: string) => (assigned.get(visitId) ?? []).map((a) => person(a.user_id));
  const visitClient = (v: (typeof visits)[number]) =>
    (v.job_id && jobById.get(v.job_id)?.client_id) || (v.request_id && requestById.get(v.request_id)?.client_id) || (v.property_id && propertyById.get(v.property_id)?.client_id) || null;
  const toJobberLine = (l: { name: string; description: string | null; quantity: number; unit_price: number; unit_cost?: number | null; taxable: boolean }): JobberLine => l;

  const byName = [...clients].sort((a, b) => a.display_name.localeCompare(b.display_name));
  const propertiesInOrder = [...properties].sort((a, b) => a.created_at.localeCompare(b.created_at));
  type Billing = { line1?: string; line2?: string; city?: string; region?: string; postal_code?: string } | null;
  const billing = (c: (typeof clients)[number]) => (c.billing_address ?? null) as Billing;

  const sheets: Sheet[] = [
    sheet("clients.csv", byName, [
      ["Name", (c) => c.display_name], ["Company", (c) => c.company_name], ["Email", (c) => c.email], ["Phone", (c) => c.phone],
      ["Status", (c) => words(c.status)], ["Lead source", (c) => c.lead_source], ["Referred by", (c) => clientName(c.referred_by)], ["Tags", (c) => c.tags.join("; ")],
      ["Notes", (c) => c.notes], ["Billing street", (c) => billing(c)?.line1], ["Billing street 2", (c) => billing(c)?.line2], ["Billing city", (c) => billing(c)?.city],
      ["Billing state", (c) => billing(c)?.region], ["Billing ZIP", (c) => billing(c)?.postal_code], ["No marketing", (c) => yes(c.marketing_opt_out)],
      ["No review asks", (c) => yes(c.review_opt_out)], ["Texts off since", (c) => day(c.sms_opt_out_at)], ["Added", (c) => day(c.created_at)], ["Client ID", (c) => c.id],
    ]),
    sheet("client-contacts.csv", [...contacts].sort((a, b) => clientName(a.client_id).localeCompare(clientName(b.client_id))), [
      ["Client", (c) => clientName(c.client_id)], ["Name", (c) => c.name], ["Role", (c) => c.role], ["Email", (c) => c.email], ["Phone", (c) => c.phone],
      ["Primary", (c) => yes(c.is_primary)], ["Gets work emails", (c) => yes(c.notify_email)], ["Gets work texts", (c) => yes(c.notify_sms)], ["Client ID", (c) => c.client_id],
    ]),
    sheet("properties.csv", [...propertiesInOrder].sort((a, b) => clientName(a.client_id).localeCompare(clientName(b.client_id))), [
      ["Client", (p) => clientName(p.client_id)], ["Name", (p) => p.label], ["Street", (p) => p.line1], ["Street 2", (p) => p.line2], ["City", (p) => p.city],
      ["State", (p) => p.region], ["ZIP", (p) => p.postal_code], ["Country", (p) => p.country], ["Lot size (sq ft)", (p) => p.lot_size_sqft], ["Tags", (p) => p.tags.join("; ")],
      ["Notes", (p) => p.notes], ["Latitude", (p) => p.lat], ["Longitude", (p) => p.lng], ["Client ID", (p) => p.client_id], ["Property ID", (p) => p.id],
    ]),
    sheet("requests.csv", [...requests].sort(byNumber), [
      ["Request #", (r) => r.number], ["Title", (r) => r.title], ["Client", (r) => clientName(r.client_id)], ["Property", (r) => address(r.property_id)],
      ["Status", (r) => words(r.status)], ["Source", (r) => words(r.source)], ["Details", (r) => r.details], ["Received", (r) => when(r.created_at)],
      ["Client ID", (r) => r.client_id], ["Request ID", (r) => r.id],
    ]),
    sheet("quotes.csv", [...quotes].sort(byNumber), [
      ["Quote #", (q) => q.number], ["Title", (q) => q.title], ["Client", (q) => clientName(q.client_id)], ["Property", (q) => address(q.property_id)],
      ["Status", (q) => words(q.status)], ["Option", (q) => (q.option_id ? optionById.get(q.option_id)?.name : "")], ["Subtotal", (q) => q.subtotal],
      ["Discount", (q) => q.discount_amount], ["Tax rate (%)", (q) => taxPercent(q.tax_rate)], ["Tax", (q) => q.tax_amount], ["Total", (q) => q.total],
      ["Deposit", (q) => q.deposit_amount], ["Created", (q) => day(q.created_at)], ["Sent", (q) => day(q.sent_at)], ["Approved", (q) => day(q.approved_at)],
      ["Valid until", (q) => q.valid_until], ["Lost reason", (q) => q.lost_reason], ["Message", (q) => q.message], ["Salesperson", (q) => person(q.salesperson_id)],
      ["Client ID", (q) => q.client_id], ["Quote ID", (q) => q.id],
    ]),
    sheet("quote-lines.csv", [...quotes].sort(byNumber).flatMap((q) => sortLines(linesOf.quote.get(q.id))), [
      ["Quote #", (l) => quoteById.get(l.quote_id)?.number], ["Option", (l) => (l.option_id ? optionById.get(l.option_id)?.name : "")], ["Name", (l) => l.name],
      ["Description", (l) => l.description], ["Quantity", (l) => l.quantity], ["Unit", (l) => l.unit], ["Unit price", (l) => l.unit_price], ["Unit cost", (l) => l.unit_cost],
      ["Total", (l) => lineTotal(l.quantity, l.unit_price)], ["Taxable", (l) => yes(l.taxable)], ["Optional", (l) => yes(l.optional)], ["Counted", (l) => yes(l.selected)],
      ["Quote ID", (l) => l.quote_id],
    ]),
    sheet("jobs.csv", [...jobs].sort(byNumber), [
      ["Job #", (j) => j.number], ["Title", (j) => j.title], ["Client", (j) => clientName(j.client_id)], ["Property", (j) => address(j.property_id)],
      ["Type", (j) => (j.kind === "recurring" ? "Recurring" : "One-off")], ["Status", (j) => words(j.status)], ["Starts", (j) => j.starts_on], ["Ends", (j) => j.ends_on],
      ["Repeats", (j) => (j.recurrence_rule ? describeRule(j.recurrence_rule) : "")], ["Billing", (j) => words(j.billing_mode)], ["Total", (j) => sumLines(linesOf.job.get(j.id) ?? [])],
      ["Instructions", (j) => j.instructions], ["PO number", (j) => j.po_number], ["Permit number", (j) => j.permit_number], ["Warranty until", (j) => j.warranty_until],
      ["From quote #", (j) => (j.quote_id ? quoteById.get(j.quote_id)?.number : "")], ["Created", (j) => day(j.created_at)], ["Client ID", (j) => j.client_id], ["Job ID", (j) => j.id],
    ]),
    sheet("job-lines.csv", [...jobs].sort(byNumber).flatMap((j) => sortLines(linesOf.job.get(j.id))), [
      ["Job #", (l) => jobNumber(l.job_id)], ["Name", (l) => l.name], ["Description", (l) => l.description], ["Quantity", (l) => l.quantity], ["Unit", (l) => l.unit],
      ["Unit price", (l) => l.unit_price], ["Unit cost", (l) => l.unit_cost], ["Total", (l) => lineTotal(l.quantity, l.unit_price)], ["Taxable", (l) => yes(l.taxable)], ["Job ID", (l) => l.job_id],
    ]),
    sheet("visits.csv", [...visits].sort((a, b) => (a.scheduled_on ?? "9999").localeCompare(b.scheduled_on ?? "9999") || (a.starts_at ?? "").localeCompare(b.starts_at ?? "")), [
      ["Date", (v) => v.scheduled_on], ["Starts", (v) => (v.starts_at ? localTime(new Date(v.starts_at), timeZone) : "")], ["Ends", (v) => (v.ends_at ? localTime(new Date(v.ends_at), timeZone) : "")],
      ["Title", (v) => v.title], ["Type", (v) => words(v.kind)], ["Status", (v) => words(v.status)], ["Job #", (v) => jobNumber(v.job_id)], ["Client", (v) => clientName(visitClient(v))],
      ["Property", (v) => address(v.property_id ?? (v.job_id ? jobById.get(v.job_id)?.property_id : null))], ["Crew", (v) => (v.crew_id ? crewById.get(v.crew_id)?.name : "")],
      ["People", (v) => peopleOn(v.id).join("; ")], ["Notes", (v) => v.notes], ["Completed", (v) => when(v.completed_at)],
      ["Invoice #", (v) => (v.invoice_id ? invoiceById.get(v.invoice_id)?.number : "")], ["Job ID", (v) => v.job_id], ["Visit ID", (v) => v.id],
    ]),
    sheet("invoices.csv", [...invoices].sort(byNumber), [
      ["Invoice #", (i) => i.number], ["Subject", (i) => i.subject], ["Client", (i) => clientName(i.client_id)], ["Job #", (i) => jobNumber(i.job_id)], ["Type", (i) => words(i.kind)],
      ["Status", (i) => words(i.status)], ["Issued", (i) => i.issued_on], ["Due", (i) => i.due_on], ["Subtotal", (i) => i.subtotal], ["Discount", (i) => i.discount_amount],
      ["Referral credit", (i) => i.credit_amount], ["Tax rate (%)", (i) => taxPercent(i.tax_rate)], ["Tax", (i) => i.tax_amount], ["Total", (i) => i.total], ["Paid", (i) => i.amount_paid], ["Balance", (i) => i.balance_due],
      ["Retainage", (i) => i.retainage_amount], ["Sent", (i) => day(i.sent_at)], ["Written off", (i) => day(i.written_off_at)], ["Notes", (i) => i.notes],
      ["Client ID", (i) => i.client_id], ["Invoice ID", (i) => i.id],
    ]),
    sheet("invoice-lines.csv", [...invoices].sort(byNumber).flatMap((i) => sortLines(linesOf.invoice.get(i.id))), [
      ["Invoice #", (l) => invoiceById.get(l.invoice_id)?.number], ["Name", (l) => l.name], ["Description", (l) => l.description], ["Quantity", (l) => l.quantity], ["Unit", (l) => l.unit],
      ["Unit price", (l) => l.unit_price], ["Total", (l) => lineTotal(l.quantity, l.unit_price)], ["Taxable", (l) => yes(l.taxable)], ["Invoice ID", (l) => l.invoice_id],
    ]),
    sheet("payments.csv", [...payments].sort((a, b) => a.received_at.localeCompare(b.received_at)), [
      ["Received", (p) => when(p.received_at)], ["Client", (p) => clientName(p.client_id)], ["Invoice #", (p) => (p.invoice_id ? invoiceById.get(p.invoice_id)?.number : "")],
      ["Amount", (p) => p.amount], ["Tip", (p) => p.tip_amount], ["Fee", (p) => p.fee_amount], ["Method", (p) => words(p.method)], ["Processor", (p) => words(p.processor)],
      ["Reference", (p) => p.processor_ref], ["Notes", (p) => p.notes], ["Client ID", (p) => p.client_id], ["Payment ID", (p) => p.id],
    ]),
    sheet("expenses.csv", [...expenses].sort((a, b) => a.incurred_on.localeCompare(b.incurred_on)), [
      ["Date", (e) => e.incurred_on], ["Vendor", (e) => e.vendor], ["Category", (e) => e.category], ["Description", (e) => e.description], ["Amount", (e) => e.amount],
      ["Job #", (e) => jobNumber(e.job_id)], ["Equipment", (e) => (e.equipment_id ? equipmentById.get(e.equipment_id)?.name : "")], ["Person", (e) => person(e.user_id)],
      ["Reimbursable", (e) => yes(e.reimbursable)], ["Reimbursed", (e) => day(e.reimbursed_at)], ["Expense ID", (e) => e.id],
    ]),
    sheet("price-list.csv", [...services].sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.sort - b.sort), [
      ["Category", (s) => s.category], ["Name", (s) => s.name], ["Description", (s) => s.description], ["Unit", (s) => s.unit], ["Price", (s) => s.unit_price],
      ["Unit cost", (s) => s.unit_cost], ["Labor cost", (s) => s.labor_cost], ["Taxable", (s) => yes(s.taxable)], ["Active", (s) => yes(s.active)],
    ]),
    sheet("team.csv", [...members].sort((a, b) => person(a.user_id).localeCompare(person(b.user_id))), [
      ["Name", (m) => person(m.user_id)], ["Email", (m) => m.profile?.email], ["Phone", (m) => m.profile?.phone], ["Role", (m) => ROLE_LABELS[m.role] ?? m.role],
      ["Subcontractor", (m) => m.sub?.name], ["Active", (m) => yes(m.active)], ["Hourly pay", (m) => m.labor_rate],
    ]),
    sheet("crews.csv", [...crews].sort((a, b) => a.name.localeCompare(b.name)), [
      ["Crew", (c) => c.name], ["Lead", (c) => person(c.lead_user_id)], ["Members", (c) => (membersOf.get(c.id) ?? []).map((m) => person(m.user_id)).join("; ")], ["Active", (c) => yes(c.active)],
    ]),
    sheet("timesheets.csv", [...timeEntries].sort((a, b) => a.started_at.localeCompare(b.started_at)), [
      ["Person", (t) => person(t.user_id)], ["Started", (t) => when(t.started_at)], ["Ended", (t) => when(t.ended_at)],
      ["Hours", (t) => (t.ended_at ? Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 36_000) / 100 : "")], ["Category", (t) => words(t.category)],
      ["Job #", (t) => jobNumber(t.job_id)], ["Notes", (t) => t.notes], ["Approved", (t) => day(t.approved_at)],
    ]),
    sheet("equipment.csv", [...equipment].sort((a, b) => a.name.localeCompare(b.name)), [
      ["Name", (e) => e.name], ["Kind", (e) => words(e.kind)], ["Make", (e) => e.make], ["Model", (e) => e.model], ["Year", (e) => e.year], ["Serial", (e) => e.serial],
      ["Plate", (e) => e.plate], ["Status", (e) => words(e.status)], ["Meter", (e) => words(e.meter)], ["Reading", (e) => e.meter_reading], ["Read on", (e) => e.meter_read_on],
      ["Purchased", (e) => e.purchased_on], ["Crew", (e) => (e.crew_id ? crewById.get(e.crew_id)?.name : "")], ["Notes", (e) => e.notes], ["Equipment ID", (e) => e.id],
    ]),
    sheet("equipment-log.csv", [...equipmentLogs].sort((a, b) => a.done_on.localeCompare(b.done_on)), [
      ["Equipment", (l) => equipmentById.get(l.equipment_id)?.name], ["Date", (l) => l.done_on], ["Kind", (l) => words(l.kind)], ["Title", (l) => l.title],
      ["Reading", (l) => l.meter_reading], ["Notes", (l) => l.notes], ["Person", (l) => person(l.user_id)], ["Equipment ID", (l) => l.equipment_id],
    ]),
    sheet("subcontractors.csv", [...subs].sort((a, b) => a.name.localeCompare(b.name)), [
      ["Business", (s) => s.name], ["Contact", (s) => s.contact_name], ["Email", (s) => s.email], ["Phone", (s) => s.phone], ["Trade", (s) => s.trade],
      ["Tax classification", (s) => words(s.tax_classification)], ["Active", (s) => yes(s.active)], ["Notes", (s) => s.notes],
      ["Address", (s) => {
        const a = (s.address ?? {}) as { line1?: string; city?: string; region?: string; postal_code?: string };
        return [a.line1, a.city, [a.region, a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      }],
    ]),
  ];

  const jobber = jobberExport({
    timeZone,
    today,
    clients: clients.map((c) => ({ ...c, billing_address: billing(c) })),
    contacts,
    properties: propertiesInOrder,
    quotes: quotes.map((q) => ({
      ...q,
      option: q.option_id ? optionById.get(q.option_id)?.name ?? null : null,
      lines: sortLines(linesOf.quote.get(q.id)).filter((l) => l.selected).map(toJobberLine),
    })),
    jobs: jobs.map((j) => ({
      ...j,
      lines: sortLines(linesOf.job.get(j.id)).map(toJobberLine),
      visits: (visitsOf.get(j.id) ?? []).map((v): JobberVisit => ({ date: v.scheduled_on, starts_at: v.starts_at, ends_at: v.ends_at, status: v.status, people: peopleOn(v.id) })),
    })),
    invoices: invoices.map((i) => ({ ...i, property_id: i.job_id ? jobById.get(i.job_id)?.property_id ?? null : null, lines: sortLines(linesOf.invoice.get(i.id)).map(toJobberLine) })),
  });

  const stamp = today;
  const folder = `crewtavo-${session.company.slug || "export"}-${stamp}`;
  const readme = [
    `${session.company.name.toUpperCase()}: EVERYTHING IN CREWTAVO`,
    `Downloaded ${when(new Date().toISOString())} (${timeZone}).`,
    "",
    "spreadsheets/",
    "  A spreadsheet of each kind of record, for Excel, Google Sheets or Numbers, or for another",
    "  app's import. Records name each other the way you do (the client, Job #12) and end with",
    "  their IDs, which match from one spreadsheet to the next.",
    "",
    ...sheets.map((s) => `  ${s.name.padEnd(22)} ${s.rows.toLocaleString("en-US")} ${s.rows === 1 ? "row" : "rows"}`),
    "",
    "jobber/",
    "  Your clients, quotes, jobs and invoices laid out for Jobber's imports. Open its READ ME first.",
    "",
    "Not in this download: photos and other files, signed documents, messages, and the keys of apps",
    "you've connected.",
    "",
  ].join("\r\n");

  // Spreadsheets start with a byte-order mark so Excel reads them as UTF-8; Jobber's files don't, as its samples don't.
  const blob = await zip([
    { name: `${folder}/READ ME.txt`, data: readme },
    ...sheets.map((s) => ({ name: `${folder}/spreadsheets/${s.name}`, data: "﻿" + s.csv })),
    { name: `${folder}/jobber/READ ME.txt`, data: jobberReadme(jobber) },
    ...jobber.files.map((f) => ({ name: `${folder}/jobber/${f.name}`, data: toCsv(f.rows, f.columns.map((c) => ({ key: c, label: c }))) })),
  ]);
  return { name: `${folder}.zip`, blob };
}
