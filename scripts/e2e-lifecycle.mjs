#!/usr/bin/env node
/**
 * End-to-end job lifecycle test against a running local stack (npx supabase start, npm run dev:api,
 * npm run seed:demo). It walks one job from a new client to a paid invoice, signing in as the demo
 * owner and three team members with custom roles, and checks at every step both what each role can
 * do and what it must be refused:
 *
 *   owner (Dana)                 everything
 *   Operations manager (Tasha)   sales, schedule, timesheets, job costs, reports; no invoices
 *   Foreman (Marcus)             crew lead level: runs his own crew (schedule, people, time), no prices
 *   Employee (Luis)              field crew level, nothing switched on
 *
 *   node scripts/e2e-lifecycle.mjs          (add --keep to leave the test client active)
 *
 * The client portal approval, quote and invoice emails (via Mailpit), automations, an online
 * payment (a signed Stripe webhook, using STRIPE_WEBHOOK_SECRET from .dev.vars), and equipment
 * maintenance are all exercised.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vars = Object.fromEntries(
  readFileSync(join(root, ".dev.vars"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const API = (process.env.CREWTAVO_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const MAILPIT = (vars.MAILPIT_URL || "http://localhost:56324").replace(/\/$/, "");
const SUPABASE_URL = vars.SUPABASE_URL;
const SUPABASE_KEY = vars.SUPABASE_PUBLISHABLE_KEY ?? vars.SUPABASE_ANON_KEY;
// The demo accounts created by scripts/seed-demo.mjs.
const PASSWORD = process.env.CREWTAVO_DEMO_PASSWORD ?? "crewtavo-demo";
const PEOPLE = { owner: "demo@crewtavo.test", ops: "tasha@crewtavo.test", foreman: "marcus@crewtavo.test", employee: "luis@crewtavo.test" };
const keep = process.argv.includes("--keep");

// ------------------------------------------------------------------------------------- helpers
let passed = 0;
const failures = [];
function check(ok, what, detail) {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${what}`);
  } else {
    failures.push(what);
    console.log(`  \x1b[31m✗ ${what}\x1b[0m${detail ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)})` : ""}`);
  }
  return ok;
}
const step = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, timeoutMs = 45_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > until) return value;
    await sleep(1500);
  }
}
function must({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

async function signIn(email) {
  const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}. Run npm run seed:demo first.`);
  return { db, token: data.session.access_token, userId: data.user.id };
}

let companyId;
async function api(who, method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Company-Id": companyId, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
// Rate limits on public endpoints are kept in Postgres per visitor IP, so reruns within a few
// minutes would trip them. Each run comes from its own documentation-range address, passed on the
// way a web server in front of the API would (it believes X-Forwarded-For from this machine).
const visitorIp = `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
async function publicApi(method, path, body) {
  const headers = { "X-Forwarded-For": visitorIp, ...(body ? { "Content-Type": "application/json" } : {}) };
  const res = await fetch(`${API}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** The newest Mailpit message to `to` whose subject matches, and the Client Hub token in it. */
async function hubLinkFromEmail(to, subjectPart) {
  return eventually(async () => {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages = [] } = await res.json();
    const msg = messages.find((m) => m.Subject.includes(subjectPart));
    if (!msg) return null;
    const full = await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
    const token = (full.Text + full.HTML).match(/\/hub\/([A-Za-z0-9._-]+)/)?.[1];
    return token ? { subject: msg.Subject, token } : null;
  }, 20_000);
}

// ------------------------------------------------------------------------------------- the run
const owner = await signIn(PEOPLE.owner);
const ops = await signIn(PEOPLE.ops);
const foreman = await signIn(PEOPLE.foreman);
const employee = await signIn(PEOPLE.employee);
const me = await (await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${owner.token}` } })).json();
companyId = me.memberships.find((m) => m.role === "owner")?.company.id;
if (!companyId) throw new Error("The demo owner has no company. Run npm run seed:demo.");
const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
const clientEmail = `e2e.client.${stamp}@example.com`;

step("Setup: give the team their roles");
{
  const roles = must(await owner.db.from("company_roles").select("id, name").eq("company_id", companyId), "roles");
  const id = (name) => roles.find((r) => r.name === name)?.id;
  check(id("Operations manager") && id("Foreman") && id("Employee"), "starter roles exist");
  must(await owner.db.from("company_roles").update({ permissions: ["sales", "job_costs", "reports", "schedule", "timesheets", "kb_edit"] }).eq("id", id("Operations manager")), "ops role");
  for (const [who, role] of [[ops, "Operations manager"], [foreman, "Foreman"], [employee, "Employee"]]) {
    must(await owner.db.from("memberships").update({ role_id: id(role) }).eq("company_id", companyId).eq("user_id", who.userId), "assign role");
  }
  const levels = must(await owner.db.from("memberships").select("user_id, role").eq("company_id", companyId), "levels");
  const level = (who) => levels.find((m) => m.user_id === who.userId)?.role;
  check(level(ops) === "office" && level(foreman) === "crew_lead" && level(employee) === "field_crew", "roles set each person's access level");
}

step("1. A new customer calls in");
const client = must(
  await owner.db.from("clients").insert({ company_id: companyId, display_name: `E2E Test Client ${stamp}`, email: clientEmail, phone: "(540) 555-0199", status: "lead", lead_source: "Phone" }).select("id, status").single(),
  "create client",
);
check(client.status === "lead", "owner adds the caller as a lead");
const property = must(
  await owner.db.from("properties").insert({ company_id: companyId, client_id: client.id, line1: "77 Test Lane", city: "Roanoke", region: "VA", postal_code: "24011", lat: 37.27, lng: -79.94 }).select("id").single(),
  "create property",
);
check(Boolean(property.id), "their service address is saved");
{
  const { error } = await employee.db.from("clients").insert({ company_id: companyId, display_name: "Should fail" });
  check(Boolean(error), "an employee can't add clients", error?.message);
}

step("2. The operations manager logs the request and builds a quote");
const request = must(
  await ops.db.from("requests").insert({ company_id: companyId, client_id: client.id, property_id: property.id, title: "Driveway replacement", source: "phone", details: "Cracked asphalt, about 1,200 sq ft." }).select("id, number").single(),
  "create request",
);
check(Boolean(request.id), `request #${request.number} created`);
const quoteRes = await api(ops, "POST", `/requests/${request.id}/quote`);
check(quoteRes.status === 201 || quoteRes.status === 200, "a quote is started from the request", quoteRes.body);
const quoteId = quoteRes.body.id;
must(
  await ops.db.from("quote_line_items").insert([
    { company_id: companyId, quote_id: quoteId, name: "Remove and haul old asphalt", quantity: 1200, unit: "sq ft", unit_price: 1.5, unit_cost: 0.6, taxable: false, sort: 0 },
    { company_id: companyId, quote_id: quoteId, name: "2 in. hot-mix asphalt", quantity: 1200, unit: "sq ft", unit_price: 4.25, unit_cost: 2.1, taxable: true, sort: 1 },
  ]),
  "line items",
);
const quote = must(await ops.db.from("quotes").select("number, subtotal, tax_amount, total, tax_rate, status").eq("id", quoteId).single(), "quote");
check(Number(quote.subtotal) === 6900, `quote #${quote.number} subtotal is $6,900.00`, quote);
check(Math.abs(Number(quote.tax_amount) - Math.round(5100 * Number(quote.tax_rate) * 100) / 100) < 0.01, "tax applies only to the taxable line", quote);

step("3. Prices stay away from the crew");
{
  const lines = must(await employee.db.from("quote_line_items").select("id").eq("quote_id", quoteId), "employee lines");
  check(lines.length === 0, "an employee can't see quote prices");
  const quotes = must(await employee.db.from("quotes").select("id, total").eq("company_id", companyId), "employee quotes");
  check(quotes.length === 0, "an employee can't see quotes or their totals at all");
  const fQuotes = must(await foreman.db.from("quotes").select("id").eq("id", quoteId), "foreman quotes");
  check(fQuotes.length === 0, "neither can a foreman");
  const theirClient = must(await employee.db.from("clients").select("id").eq("id", client.id), "employee client");
  check(theirClient.length === 0, "an employee can't look up a client they aren't working for");
  const send = await api(employee, "POST", `/quotes/${quoteId}/send`, { channel: "email" });
  check(send.status === 403, "an employee can't send quotes", send.body);
  const fsend = await api(foreman, "POST", `/quotes/${quoteId}/send`, { channel: "email" });
  check(fsend.status === 403, "a foreman can't send quotes", fsend.body);
}

step("4. The quote goes to the customer, who approves it online");
{
  const send = await api(ops, "POST", `/quotes/${quoteId}/send`, { channel: "email", subject: `Your quote #${quote.number}`, message: "Thanks for having us out." });
  check(send.status === 200 && send.body.sent, "the quote is emailed", send.body);
  const sent = must(await ops.db.from("quotes").select("status").eq("id", quoteId).single(), "status");
  check(sent.status === "sent", "the quote is marked sent");
  const mail = await hubLinkFromEmail(clientEmail, `#${quote.number}`);
  check(Boolean(mail?.token), "the customer's email has a link to the quote", mail);
  if (mail?.token) {
    const view = await publicApi("GET", `/hub/${mail.token}`);
    check(view.status === 200 && Number(view.body.quote?.total ?? view.body.total) === Number(quote.total), "the customer sees the quote and its total", view.body.quote ? { total: view.body.quote.total } : view.body);
    const forged = await publicApi("GET", `/hub/${mail.token.slice(0, -4)}AAAA`);
    const note = await publicApi("POST", `/hub/${mail.token}/message`, { message: "Can you start after the 20th?" });
    const inbox = must(await ops.db.from("messages").select("subject, direction").eq("client_id", client.id).eq("body", "Can you start after the 20th?"), "portal message");
    check(note.status === 201 && inbox.length === 1 && inbox[0].direction === "in", "a message from the customer's link reaches the office", inbox);
    check(forged.status === 404, "a tampered link is refused", forged.status);

    // Promo codes: made by someone with the marketing area, entered by the customer.
    const code = `E2E${stamp}`;
    const opsCode = await ops.db.from("promo_codes").insert({ company_id: companyId, code, kind: "percent", value: 10 });
    check(Boolean(opsCode.error), "the operations manager can't create promo codes (marketing area off)", opsCode.error?.message);
    must(await owner.db.from("promo_codes").insert({ company_id: companyId, code, kind: "percent", value: 10, description: "E2E test" }), "promo code");
    const empCodes = must(await employee.db.from("promo_codes").select("id").eq("code", code), "employee promo codes");
    check(empCodes.length === 0, "the employee can't see promo codes");
    const wrong = await publicApi("POST", `/hub/${mail.token}/promo`, { code: "NOT-A-CODE" });
    check(wrong.status === 400 && /isn't valid/.test(wrong.body.error ?? ""), "a wrong code gets a plain message", wrong.body);
    const good = await publicApi("POST", `/hub/${mail.token}/promo`, { code: code.toLowerCase() });
    check(good.status === 200 && Number(good.body.discount_amount) === 690, "the customer's 10% code takes $690.00 off", good.body);
    const withCode = await publicApi("GET", `/hub/${mail.token}`);
    check(withCode.body.quote?.promo?.code === code, "the quote shows the code", withCode.body.quote?.promo);
    const off = await publicApi("DELETE", `/hub/${mail.token}/promo`);
    const back = must(await ops.db.from("quotes").select("total, promo_code_id").eq("id", quoteId).single(), "quote after removing code");
    check(off.status === 200 && back.promo_code_id === null && Number(back.total) === Number(quote.total), "the customer can take it back off", back);
    const form = (await owner.db.from("intake_forms").select("slug").eq("company_id", companyId).eq("active", true).limit(1)).data?.[0];
    const slug = (await owner.db.from("companies").select("slug").eq("id", companyId).single()).data?.slug;
    if (form && slug) {
      const booking = await publicApi("POST", `/public/forms/${slug}/${form.slug}/promo`, { code });
      check(booking.status === 200 && booking.body.offer === "10% off: E2E test", "a booking form checks the code and describes the offer", booking.body);
    }
    const approve = await publicApi("POST", `/hub/${mail.token}/approve`, { name: "Pat Customer" });
    check(approve.status === 200 && approve.body.status === "approved", "the customer approves with their name", approve.body);
    const again = await publicApi("POST", `/hub/${mail.token}/approve`, { name: "Pat Customer" });
    check(again.status === 409, "an approved quote can't be approved twice", again.status);
  }
  const notified = await eventually(async () => {
    const rows = must(await owner.db.from("notifications").select("title").eq("user_id", owner.userId).ilike("title", `%#${quote.number}%approved%`), "notifications");
    return rows.length > 0;
  });
  check(notified, "the office is notified that the quote was approved (automation)");
}

step("5. The quote becomes a job");
const convert = await api(ops, "POST", `/quotes/${quoteId}/convert`);
check(convert.status === 201, "the operations manager converts it to a job", convert.body);
const jobId = convert.body.job_id;
{
  const job = must(await ops.db.from("jobs").select("number, status, financials:job_financials(contract_total)").eq("id", jobId).single(), "job");
  check(Number(job.financials?.contract_total) === 6900, `job #${job.number} carries the $6,900.00 contract`, job);
  const c = must(await owner.db.from("clients").select("status").eq("id", client.id).single(), "client");
  check(c.status === "active", "the lead becomes an active client");
}

step("6. The foreman schedules the work and assigns the employee");
const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const [foremanCrew] = must(await foreman.db.rpc("my_crew_ids", { p_company: companyId }), "foreman's crews");
const otherCrew = must(await foreman.db.from("crews").select("id").eq("company_id", companyId).neq("id", foremanCrew), "other crews")[0]?.id;
const visit = must(
  await foreman.db.from("visits").insert({ company_id: companyId, job_id: jobId, property_id: property.id, crew_id: foremanCrew, title: "Replace driveway", scheduled_on: day, status: "scheduled" }).select("id").single(),
  "create visit",
);
check(Boolean(visit.id), "the foreman schedules a visit for his crew");
{
  const elsewhere = await foreman.db.from("visits").insert({ company_id: companyId, job_id: jobId, crew_id: otherCrew, title: "Not his crew", scheduled_on: day }).select("id");
  check(Boolean(elsewhere.error), "but can't schedule another crew", elsewhere.data);
  const assign = await api(foreman, "PATCH", `/visits/${visit.id}`, { assignee_ids: [employee.userId] });
  check(assign.status === 200, "the foreman assigns the employee", assign.body);
  const seen = must(await employee.db.from("visits").select("id").eq("id", visit.id), "employee visit");
  check(seen.length === 1, "the employee sees their visit");
  const nowClient = must(await employee.db.from("clients").select("id, phone").eq("id", client.id), "employee client");
  check(nowClient.length === 1, "and now sees that client's details (name, phone, address)");
  const allVisits = must(await employee.db.from("visits").select("id").eq("company_id", companyId), "employee visits");
  const mine = must(await employee.db.from("visit_assignees").select("visit_id").eq("user_id", employee.userId), "mine");
  const mineIds = new Set(mine.map((m) => m.visit_id));
  check(allVisits.every((v) => mineIds.has(v.id)), "the employee sees only their own visits on the schedule", { visible: allVisits.length, assigned: mineIds.size });
  const fVisits = must(await foreman.db.from("visits").select("id").eq("company_id", companyId), "foreman visits");
  check(fVisits.length > allVisits.length, "the foreman sees the whole team's schedule");
  // Two days after the visit, so it's always a real change (the guard lets an unchanged date through).
  const later = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const move = await api(employee, "PATCH", `/visits/${visit.id}`, { scheduled_on: later });
  check(move.status === 403, "the employee can't reschedule it", move.body);
  const direct = await employee.db.from("visits").update({ scheduled_on: later }).eq("id", visit.id).select("id");
  check(Boolean(direct.error) || direct.data?.length === 0, "and can't get around that through the database", direct.error?.message);
  const ownJob = must(await employee.db.from("jobs").select("id").eq("id", jobId), "employee job");
  check(ownJob.length === 1, "the employee can open the job they're assigned to");
  const wide = await api(employee, "POST", "/calendar-feed", { scope: "all" });
  check(wide.status === 403, "an employee can't subscribe to the whole schedule", wide.body);
  const feed = await api(employee, "POST", "/calendar-feed", { scope: "mine" });
  const ics = feed.status === 201 ? await (await fetch(`${API}${new URL(feed.body.feed.url).pathname}`)).text() : "";
  const events = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
  const shift = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const theirs = must(await employee.db.from("visits").select("id").eq("company_id", companyId).neq("status", "unscheduled").gte("scheduled_on", shift(-29)).lte("scheduled_on", shift(179)), "employee visits");
  check(feed.status === 201 && ics.includes("Replace driveway") && events === theirs.length, "the employee's calendar link shows only the visits they're on", { status: feed.status, events, theirs: theirs.length });
  const forgedFeed = await fetch(`${API}/api/calendar/${"x".repeat(43)}.ics`);
  check(forgedFeed.status === 404, "a made-up calendar link shows nothing");
  await api(employee, "DELETE", "/calendar-feed");
  const jobLines = must(await employee.db.from("job_line_items").select("unit_price").eq("job_id", jobId), "employee job lines");
  check(jobLines.length === 0, "the employee doesn't see the job's line-item prices");
  const jobMoney = must(await employee.db.from("jobs").select("id, financials:job_financials(contract_total)").eq("id", jobId), "employee job total");
  check(jobMoney[0]?.financials == null, "the employee doesn't see what the job is worth", jobMoney);
  const fMoney = must(await foreman.db.from("job_financials").select("contract_total").eq("job_id", jobId), "foreman job total");
  check(fMoney.length === 0, "neither does the foreman");
  const otherJobs = must(await employee.db.from("jobs").select("id").eq("company_id", companyId).neq("id", jobId), "other jobs");
  const assignedElsewhere = must(await employee.db.from("visit_assignees").select("visit:visits(job_id)").eq("user_id", employee.userId), "assignments");
  const allowed = new Set(assignedElsewhere.map((a) => a.visit?.job_id).filter(Boolean));
  check(otherJobs.every((j) => allowed.has(j.id)), "the employee only sees jobs they're assigned to", { visible: otherJobs.length, assigned: allowed.size });
  const fLines = must(await foreman.db.from("job_line_items").select("id").eq("job_id", jobId), "foreman lines");
  check(fLines.length === 0, "the foreman doesn't see line-item prices either");
  const scope = must(await employee.db.rpc("job_scope", { p_job: jobId }), "job scope");
  check(scope.length > 0 && scope.every((l) => !("unit_price" in l)), "the employee sees the job's scope of work, without prices", scope);
  const services = must(await employee.db.from("services").select("unit_price").eq("company_id", companyId), "price list");
  check(services.length === 0, "and can't read the price list", services.length);
}

step("7. The employee does the work");
{
  for (const status of ["en_route", "in_progress"]) {
    const r = await api(employee, "PATCH", `/visits/${visit.id}`, { status });
    check(r.status === 200 && r.body.status === status, `status: ${status.replace("_", " ")}`, r.body);
  }
  const start = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const entry = must(
    await employee.db.from("time_entries").insert({ company_id: companyId, user_id: employee.userId, visit_id: visit.id, job_id: jobId, category: "visit", started_at: start, ended_at: new Date().toISOString() }).select("id").single(),
    "time entry",
  );
  check(Boolean(entry.id), "their time on the visit is recorded");
  const done = await api(employee, "PATCH", `/visits/${visit.id}`, { status: "completed" });
  check(done.status === 200 && done.body.status === "completed", "the visit is completed", done.body);
  // The phone sends an earlier tap again (it closed before hearing back): a crew's tap only goes forward.
  const replay = await api(employee, "PATCH", `/visits/${visit.id}`, { status: "in_progress", forward_only: true });
  check(replay.status === 200 && replay.body.skipped === true && replay.body.status === "completed", "a repeated earlier tap doesn't reopen the finished visit", replay.body);
  const activity = must(await owner.db.from("activity").select("verb").eq("subject_id", visit.id).eq("verb", "visit.completed"), "activity");
  check(activity.length === 1, "the office sees it in the activity feed");

  step("8. Time gets approved by the right person");
  const fApprove = await foreman.db.from("time_entries").update({ approved_at: new Date().toISOString() }).eq("id", entry.id).select("id");
  check(Boolean(fApprove.error) || fApprove.data?.length === 0, "the foreman can't approve time", fApprove.error?.message);
  const oApprove = await ops.db.from("time_entries").update({ approved_at: new Date().toISOString(), approved_by: ops.userId }).eq("id", entry.id).select("approved_at");
  check(!oApprove.error && oApprove.data?.[0]?.approved_at, "the operations manager approves it", oApprove.error?.message);
}

step("9. Work complete; billing is limited to people with invoices access");
{
  must(await ops.db.from("jobs").update({ status: "requires_invoicing" }).eq("id", jobId), "work complete");
  const denied = await api(ops, "POST", `/jobs/${jobId}/invoice`, { kind: "standard" });
  check(denied.status === 403, "the operations manager can't create invoices (area off)", denied.body);
  const rpc = await ops.db.rpc("create_invoice_for_job", { p_job: jobId });
  check(Boolean(rpc.error), "and can't create one through the database either", rpc.error?.message);
  const hidden = must(await ops.db.from("invoices").select("id").eq("company_id", companyId), "ops invoices");
  check(hidden.length === 0, "invoices are hidden from them entirely");
}

step("10. The owner invoices the customer");
const inv = await api(owner, "POST", `/jobs/${jobId}/invoice`, { kind: "standard" });
check(inv.status === 201, "the owner creates the invoice", inv.body);
const invoiceId = inv.body.invoice_id;
const invoice = must(await owner.db.from("invoices").select("number, subtotal, total, status").eq("id", invoiceId).single(), "invoice");
check(Number(invoice.subtotal) === 6900 && Number(invoice.total) === Number(quote.total), `invoice #${invoice.number} matches the approved quote ($${invoice.total})`, invoice);
{
  const job = must(await owner.db.from("jobs").select("status").eq("id", jobId).single(), "job");
  check(job.status === "completed", "the job is closed once it's invoiced");
  const send = await api(owner, "POST", `/invoices/${invoiceId}/send`, { channel: "email" });
  check(send.status === 200 && send.body.sent, "the invoice is emailed", send.body);
  const sent = must(await owner.db.from("invoices").select("status").eq("id", invoiceId).single(), "status");
  check(sent.status === "sent", "the invoice is marked sent");
  const again = await api(owner, "POST", "/invoices/batch", { job_ids: [jobId] });
  check(again.status === 200 && again.body.results?.[0]?.ok === false && /already has its final invoice/.test(again.body.results[0].error), "batch invoicing won't bill the same job twice", again.body);
  const reminder = await api(owner, "POST", "/invoices/remind", { invoice_ids: [invoiceId] });
  check(reminder.status === 200 && reminder.body.sent === 1, "a payment reminder is emailed", reminder.body);
  const mail = await hubLinkFromEmail(clientEmail, `#${invoice.number}`);
  check(Boolean(mail?.token), "the customer's email links to the invoice", mail);
  if (mail?.token) {
    const view = await publicApi("GET", `/hub/${mail.token}`);
    const balance = Number(view.body.invoice?.balance_due ?? view.body.balance_due);
    check(view.status === 200 && balance === Number(invoice.total), "the customer sees what they owe", view.body.invoice ? { balance_due: view.body.invoice.balance_due } : view.body);
  }
}

step("11. The customer pays: a check for part, the rest online");
{
  const opsPay = await ops.db.from("payments").insert({ company_id: companyId, client_id: client.id, invoice_id: invoiceId, amount: 1000, method: "check" });
  check(Boolean(opsPay.error), "the operations manager can't record payments", opsPay.error?.message);
  must(await owner.db.from("payments").insert({ company_id: companyId, client_id: client.id, invoice_id: invoiceId, amount: 1000, method: "check", notes: "Check 1043" }), "check");
  const partial = must(await owner.db.from("invoices").select("status, balance_due").eq("id", invoiceId).single(), "partial");
  check(partial.status === "partially_paid" && Number(partial.balance_due) === Number(invoice.total) - 1000, "a $1,000 check leaves the invoice partly paid", partial);

  const secret = vars.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    check(false, "online payment (set STRIPE_WEBHOOK_SECRET in .dev.vars to test it)");
  } else {
    const sign = (s, body) => {
      const t = Math.floor(Date.now() / 1000);
      return `t=${t},v1=${createHmac("sha256", s).update(`${t}.${body}`).digest("hex")}`;
    };
    const post = (body, s = secret) => fetch(`${API}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sign(s, body) }, body });
    // A bank (ACH) payment with a $50 tip: Checkout completes unpaid, and the money clears days later.
    const session = { id: `cs_test_${stamp}`, payment_intent: `pi_test_${stamp}`, amount_total: Math.round(Number(partial.balance_due) * 100) + 5000, payment_method_types: ["card", "us_bank_account"], metadata: { company_id: companyId, invoice_id: invoiceId, tip_cents: "5000" } };
    const started = JSON.stringify({ type: "checkout.session.completed", data: { object: { ...session, payment_status: "unpaid" } } });
    const cleared = JSON.stringify({ type: "checkout.session.async_payment_succeeded", data: { object: { ...session, payment_status: "paid" } } });
    check((await post(cleared, "whsec_wrong")).status === 400, "a forged payment notice is refused");
    check((await post(started)).status === 200, "Stripe's notice that a bank payment started is accepted");
    const pending = must(await owner.db.from("invoices").select("status").eq("id", invoiceId).single(), "pending");
    check(pending.status === "partially_paid", "a bank payment that hasn't cleared isn't counted yet", pending);
    check((await post(cleared)).status === 200, "Stripe's notice that the bank payment cleared is accepted");
    check((await post(cleared)).status === 200, "a repeated notice is accepted without charging twice");
    const paid = must(await owner.db.from("invoices").select("status, balance_due, amount_paid").eq("id", invoiceId).single(), "paid");
    check(paid.status === "paid" && Number(paid.balance_due) === 0, "the invoice is paid in full", paid);
    const payments = must(await owner.db.from("payments").select("amount, tip_amount, method").eq("invoice_id", invoiceId).order("received_at"), "payments");
    check(payments.length === 2, "exactly two payments are on record (check + bank)", payments);
    const online = payments.find((p) => p.method === "ach");
    check(Boolean(online) && Number(online.tip_amount) === 50 && Number(online.amount) === Number(partial.balance_due), "the bank payment is recorded with the $50 tip kept separate", online);
  }
  const notified = await eventually(async () => {
    const rows = must(await owner.db.from("notifications").select("title").eq("user_id", owner.userId).ilike("title", `%#${invoice.number}%paid%`), "notifications");
    return rows.length > 0;
  });
  check(notified, "the office is notified that the invoice was paid (automation)");
}

step("12. Who sees the money afterwards");
{
  const dash = await api(owner, "GET", "/dashboard");
  check(dash.status === 200 && Number(dash.body.month?.collected) >= Number(invoice.total), "the owner's dashboard counts the payment", dash.body.month);
  const opsDash = await api(ops, "GET", "/dashboard");
  check(opsDash.status === 200 && Number(opsDash.body.workflow?.invoices?.awaiting_value ?? 0) === 0 && Number(opsDash.body.month?.collected ?? 0) === 0, "the operations manager's dashboard shows no money figures", opsDash.body.month);
  const empPay = must(await employee.db.from("payments").select("id").eq("invoice_id", invoiceId), "employee payments");
  check(empPay.length === 0, "the employee sees no payments");
  const costs = await api(ops, "POST", "/time/rates", { job_ids: [jobId] });
  check(costs.status === 200 && Object.values(costs.body).some((rate) => Number(rate) > 0), "the operations manager sees labor on the job (job costs area on)", costs.body);
  for (const [who, name] of [[foreman, "foreman"], [employee, "employee"]]) {
    const rates = await who.db.from("time_entries").select("labor_rate").eq("job_id", jobId);
    check(Boolean(rates.error), `the ${name} can't read pay rates on time entries`, rates.error?.message ?? rates.data);
    const served = await api(who, "POST", "/time/rates", { job_ids: [jobId] });
    check(served.status === 403, `and the server won't give them to the ${name}`, served.body);
  }
}

step("13. A refund made in Stripe");
if (vars.STRIPE_WEBHOOK_SECRET) {
  const secret = vars.STRIPE_WEBHOOK_SECRET;
  const body = JSON.stringify({ type: "charge.refunded", data: { object: { id: `ch_test_${stamp}`, payment_intent: `pi_test_${stamp}`, amount_refunded: 10000 } } });
  const post = () => {
    const t = Math.floor(Date.now() / 1000);
    return fetch(`${API}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}` }, body });
  };
  check((await post()).status === 200 && (await post()).status === 200, "Stripe's refund notice is accepted (twice, as Stripe may retry)");
  const after = must(await owner.db.from("invoices").select("status, balance_due").eq("id", invoiceId).single(), "refunded");
  check(Number(after.balance_due) === 100 && after.status !== "paid", "a $100 refund shows on the invoice once, and it's owed again", after);
  // Then the rest, tip included: Stripe's refunded total counts the $50 tip, which the invoice never had.
  const online = must(await owner.db.from("payments").select("amount, tip_amount").eq("processor_ref", `pi_test_${stamp}`).single(), "online payment");
  const fullCents = Math.round((Number(online.amount) + Number(online.tip_amount)) * 100);
  const full = JSON.stringify({ type: "charge.refunded", data: { object: { id: `ch_test_${stamp}`, payment_intent: `pi_test_${stamp}`, amount_refunded: fullCents } } });
  const t = Math.floor(Date.now() / 1000);
  const fullPost = await fetch(`${API}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${full}`).digest("hex")}` }, body: full });
  const refunds = must(await owner.db.from("payments").select("amount, tip_amount").like("processor_ref", `pi_test_${stamp}:refund:%`), "refunds");
  const net = (key) => Math.round(refunds.reduce((s, p) => s + Number(p[key]), 0) * 100) / 100;
  const whole = must(await owner.db.from("invoices").select("balance_due").eq("id", invoiceId).single(), "fully refunded");
  check(fullPost.status === 200 && net("amount") === -Number(online.amount) && net("tip_amount") === -Number(online.tip_amount) && Number(whole.balance_due) === Number(online.amount),
    "a full refund takes back the tip as tip, and the invoice owes only what the online payment covered", { refunds, whole });
  const del = await owner.db.from("payments").delete().eq("invoice_id", invoiceId).eq("processor", "stripe").select("id");
  check(!del.error && del.data.length === 0, "online payments can't be deleted by hand", del.error?.message);
}

step("14. Equipment and maintenance");
{
  const name = `E2E Test Mower ${stamp}`;
  const empAdd = await employee.db.from("equipment").insert({ company_id: companyId, name });
  check(Boolean(empAdd.error), "the employee can't add equipment", empAdd.error?.message);
  const crew = must(await foreman.db.from("crew_members").select("crew_id").eq("user_id", foreman.userId), "foreman's crew")[0]?.crew_id ?? null;
  const mower = must(await foreman.db.from("equipment").insert({ company_id: companyId, name, kind: "mower", meter: "hours", meter_reading: 300, crew_id: crew }).select("id").single(), "foreman adds a mower");
  const plan = must(await foreman.db.from("equipment_plans").insert({ company_id: companyId, equipment_id: mower.id, name: "Sharpen blades", every_meter: 25 }).select("id").single(), "schedule");
  check(Boolean(mower.id && plan.id), "the foreman adds a mower and its blade schedule");
  must(await owner.db.from("equipment_financials").insert({ company_id: companyId, equipment_id: mower.id, purchase_price: 14500 }), "price");
  must(await employee.db.from("equipment_logs").insert({ company_id: companyId, equipment_id: mower.id, kind: "reading", meter_reading: 326 }), "employee logs hours");
  const due = must(await employee.db.from("equipment_due").select("state, meter_left").eq("plan_id", plan.id).single(), "due");
  check(due.state === "overdue" && Number(due.meter_left) === -1, "the employee logs hours from the field and the blades come due", due);
  const price = must(await employee.db.from("equipment_financials").select("purchase_price").eq("equipment_id", mower.id), "employee price");
  check(price.length === 0, "the employee can't see what the mower cost");

  const cron = await fetch(`${API}/api/cron/followups`, { method: "POST", headers: { Authorization: `Bearer ${vars.CRON_SECRET}` } });
  const ran = await cron.json();
  const told = must(await foreman.db.from("notifications").select("title, link").eq("link", `/equipment/${mower.id}`), "foreman notifications");
  const empTold = must(await employee.db.from("notifications").select("id").eq("link", `/equipment/${mower.id}`), "employee notifications");
  check(cron.status === 200 && ran.equipment >= 1 && told.length === 1 && empTold.length === 0, "the hourly check tells the foreman, not the employee", { status: cron.status, ran, told: told.length });

  const expense = must(await employee.db.from("expenses").insert({ company_id: companyId, equipment_id: mower.id, category: "Equipment upkeep", amount: 18, reimbursable: true, description: "Blade sharpening" }).select("id").single(), "employee expense");
  must(await employee.db.from("equipment_logs").insert({ company_id: companyId, equipment_id: mower.id, kind: "service", plan_id: plan.id, title: "Sharpen blades", expense_id: expense.id }), "employee marks done");
  const after = must(await employee.db.from("equipment_due").select("state, next_due_meter").eq("plan_id", plan.id).single(), "after");
  check(after.state === "ok" && Number(after.next_due_meter) === 351, "marking the blades done resets the schedule from the current hours", after);
  const upkeep = must(await owner.db.from("expenses").select("amount").eq("equipment_id", mower.id), "owner upkeep");
  check(upkeep.length === 1 && Number(upkeep[0].amount) === 18, "the owner sees the $18 upkeep, ready to reimburse");
  const assistant = await owner.db.from("equipment_due").select("plan_id").eq("company_id", companyId).neq("state", "ok");
  check(!assistant.error, "what's due can be listed for the whole company (used by assistants)");
}

if (!keep) await cleanUp();

/** Remove everything the test created (and leftovers from earlier runs), using the service key. */
async function cleanUp() {
  const secret = vars.SUPABASE_SECRET_KEY ?? vars.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return console.log("\n(No SUPABASE_SECRET_KEY in .dev.vars, so the test data was left in place.)");
  const admin = createClient(SUPABASE_URL, secret, { auth: { persistSession: false } });
  const gear = must(await admin.from("equipment").select("id").eq("company_id", companyId).like("name", "E2E Test Mower %"), "test equipment").map((e) => e.id);
  if (gear.length) {
    await admin.from("expenses").delete().in("equipment_id", gear);
    await admin.from("notifications").delete().in("link", gear.map((id) => `/equipment/${id}`));
    await admin.from("activity").delete().in("subject_id", gear);
    await admin.from("equipment").delete().in("id", gear);
  }
  const clients = must(await admin.from("clients").select("id").eq("company_id", companyId).like("display_name", "E2E Test Client %"), "test clients").map((c) => c.id);
  if (!clients.length) return;
  const ids = async (table, column, values) => (values.length ? must(await admin.from(table).select("id").in(column, values), table).map((r) => r.id) : []);
  const jobs = await ids("jobs", "client_id", clients);
  const quotes = await ids("quotes", "client_id", clients);
  const requests = await ids("requests", "client_id", clients);
  const invoices = await ids("invoices", "client_id", clients);
  const visits = await ids("visits", "job_id", jobs);
  const subjects = [...clients, ...jobs, ...quotes, ...requests, ...invoices, ...visits];
  const del = async (table, column, values) => {
    if (!values.length) return;
    const { error } = await admin.from(table).delete().in(column, values);
    if (error) throw new Error(`Cleaning ${table}: ${error.message}`);
  };
  await del("payments", "invoice_id", invoices);
  await del("visits", "invoice_id", invoices).catch(() => {});
  await admin.from("visits").update({ invoice_id: null }).in("invoice_id", invoices.length ? invoices : ["00000000-0000-0000-0000-000000000000"]);
  await del("invoices", "id", invoices);
  await del("time_entries", "job_id", jobs);
  await del("visits", "id", visits);
  await del("jobs", "id", jobs);
  await del("quotes", "id", quotes);
  await del("requests", "id", requests);
  await del("automation_runs", "subject_id", subjects);
  await del("activity", "subject_id", subjects);
  await del("messages", "client_id", clients);
  await del("clients", "id", clients);
  await admin.from("promo_codes").delete().eq("company_id", companyId).like("code", "E2E%");
  const links = [...quotes.map((id) => `/quotes/${id}`), ...invoices.map((id) => `/invoices/${id}`), ...requests.map((id) => `/requests/${id}`), ...jobs.map((id) => `/jobs/${id}`), ...clients.map((id) => `/clients/${id}`)];
  await del("notifications", "link", links);
  await admin.from("notifications").delete().eq("company_id", companyId).or("title.ilike.%E2E Test Client%,body.ilike.%E2E Test Client%");
  console.log(`\n(Removed the test data: ${clients.length} test ${clients.length === 1 ? "client" : "clients"} and everything attached. Use --keep to leave it.)`);
}

console.log(`\n${failures.length ? "\x1b[31m" : "\x1b[32m"}${passed} passed, ${failures.length} failed\x1b[0m`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
