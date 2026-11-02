/**
 * The automation engine. Claims due automation_runs, loads the record each run is about,
 * re-checks the rule's conditions against fresh data and performs its actions.
 *
 * Runs are processed every minute by cron, and right away when the web app or a public page
 * reports an action (POST /api/automations/process), so notifications feel instant.
 * A retried run skips actions that already succeeded, so nobody gets the same email twice.
 */
import {
  actionsForTrigger,
  addDays,
  autopaySettings,
  evaluateConditions,
  isAutopayTrigger,
  localDate,
  memberPermissions,
  renderTemplate,
  STATUS_ACTION_CHOICES,
  statusChoices,
  taskVars,
  triggerDef,
  type Action,
  type Condition,
  type Facts,
  type SubjectKind,
  type Role,
  type TemplateVars,
} from "@crewtavo/core";
import { hidesExactPrice } from "@crewtavo/core/estimates";
import { countsOn } from "@crewtavo/core/money";
import type { Env } from "../env";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { clientLink } from "../lib/links";
import { sendEmail, sendSms } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { sendAutopayInvite } from "./autopay";
import { logoImage } from "./logo";
import { sendReviewRequest } from "./reviews";
import { isRoofWork } from "./roofPackages";
import { optionsFrom } from "./sales";

export interface ActionResult {
  type: string;
  ok: boolean;
  detail: string;
}

interface CompanyInfo {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  timezone: string;
  currency: string;
  trade_preset: string | null;
  settings: Record<string, unknown>;
  address: Record<string, string | undefined>;
}

export interface RunContext {
  subject: SubjectKind;
  id: string;
  label: string;
  company: CompanyInfo;
  client: { id: string; display_name: string; email: string | null; phone: string | null; tags: string[]; status: string; lead_source: string | null } | null;
  facts: Facts;
  vars: TemplateVars;
  appPath: string;
  jobId: string | null;
  propertyId: string | null;
  /** What started the rule (its trigger), once it's running: some keep to their own rules (sub_offer.*). */
  trigger?: string;
}

const SUBJECTS: SubjectKind[] = ["client", "request", "quote", "job", "visit", "invoice"];

export function money(amount: number | string | null | undefined, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(amount ?? 0));
}

/** A price range as a client reads it: "$18,300 to $21,050" (cents only when an end has them). */
export function moneyRange(low: number | string | null | undefined, high: number | string | null | undefined, currency = "USD") {
  const ends = [Number(low ?? 0), Number(high ?? 0)];
  const digits = ends.every((n) => Number.isInteger(n)) ? 0 : 2;
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${format.format(ends[0]!)} to ${format.format(ends[1]!)}`;
}

export function companyAddress(address: Record<string, string | undefined> | null | undefined): string {
  if (!address) return "";
  return [address.line1, address.line2, [address.city, address.region].filter(Boolean).join(", "), address.postal_code].filter(Boolean).join(", ");
}

type Property = { line1: string; city: string | null; region: string | null } | null;
const addressOf = (p: Property) => (p ? [p.line1, [p.city, p.region].filter(Boolean).join(", ")].filter(Boolean).join(", ") : "");

/**
 * Whether a quote is roof work (roofPackages.ts isRoofWork): the business is a roofer or its newest
 * measurement is a roof, or the quote went out as a price range (only Roofing sends those).
 */
async function roofWork(admin: Db, company: CompanyInfo, quoteId: string, sentAsRange: boolean): Promise<boolean> {
  if (sentAsRange || isRoofWork(company.trade_preset, null)) return true;
  const { data } = await admin.from("measurements").select("sections, roof_pitch, roofing_squares").eq("company_id", company.id).eq("quote_id", quoteId).order("updated_at", { ascending: false }).limit(1);
  return isRoofWork(company.trade_preset, data?.[0] ?? null);
}

/**
 * For the "On autopay" condition: whether the client is being charged automatically, that is the
 * company has autopay on and the client has an agreement in force that isn't paused (as
 * private.autopay_ready, less the card's state, which the office fixes with the client). Null when
 * it can't be told.
 */
async function clientOnAutopay(admin: Db, company: CompanyInfo, clientId: string): Promise<Facts["autopay"]> {
  if (!autopaySettings(company.settings).enabled) return "no";
  const { data, error } = await admin
    .from("autopay_authorizations")
    .select("id")
    .eq("company_id", company.id)
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .is("paused_at", null)
    .limit(1);
  if (error) return null;
  return (data ?? []).length ? "yes" : "no";
}

/** For the "On autopay" condition: whether the invoice has an autopay charge that wasn't called off. Null when it can't be told. */
async function invoiceOnAutopay(admin: Db, companyId: string, invoiceId: string): Promise<Facts["autopay"]> {
  const { data, error } = await admin.from("autopay_charges").select("id").eq("company_id", companyId).eq("invoice_id", invoiceId).neq("status", "called_off").limit(1);
  if (error) return null;
  return (data ?? []).length ? "yes" : "no";
}

/** Everything a rule can know about the record it runs on. Null when the record is gone. */
export async function loadContext(admin: Db, companyId: string, subjectType: string, subjectId: string): Promise<RunContext | null> {
  if (!SUBJECTS.includes(subjectType as SubjectKind)) return null;
  const subject = subjectType as SubjectKind;

  const { data: company } = await admin.from("companies").select("id, name, phone, email, website, timezone, currency, trade_preset, settings, address").eq("id", companyId).maybeSingle();
  if (!company) return null;
  const co = company as unknown as CompanyInfo;
  const fmt = (n: number | string | null | undefined) => money(n, co.currency || "USD");

  let clientId: string | null = null;
  let facts: Facts = {};
  let vars: TemplateVars = {};
  let label = "";
  let appPath = "/";
  let jobId: string | null = null;
  let propertyId: string | null = null;

  switch (subject) {
    case "client": {
      clientId = subjectId;
      appPath = `/clients/${subjectId}`;
      break;
    }
    case "request": {
      const { data } = await admin.from("requests").select("number, title, status, source, client_id, property_id, property:properties(line1, city, region)").eq("company_id", companyId).eq("id", subjectId).maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      facts = { status: data.status, source: data.source };
      vars = { number: data.number, title: data.title, address: addressOf(data.property as Property) };
      label = `Request #${data.number}`;
      appPath = `/requests/${subjectId}`;
      break;
    }
    case "quote": {
      const { data } = await admin
        .from("quotes")
        .select(
          "number, title, status, total, tax_rate, discount_amount, range_low, range_high, priced_on_site_at, exact_sent_at, roof_package_id, option_id, client_id, property_id, property:properties(line1, city, region), promo:promo_codes(kind, value), lines:quote_line_items(name, option_id, quantity, unit_price, taxable, optional, selected), options:quote_options!quote_options_quote_fkey(id)",
        )
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      // Before the client answers, what's offered: the shared lines and the shown option's, add-ons
      // included (not picked isn't turned down yet). Once they've signed, what they're getting: the
      // shared lines and the option they chose, without the add-ons they left off, as the job has them.
      const answered = data.status === "approved" || data.status === "converted";
      const lines = data.lines.filter((l) => (answered ? countsOn(l, data.option_id) : l.option_id === null || l.option_id === data.option_id));
      facts = { status: data.status, amount: Number(data.total), line_items: lines.map((l) => l.name) };
      // Sent as a price range, the client hasn't seen the exact price (lost or archived since included),
      // so an email about it doesn't show it either. With options and no answer yet, the quote's total is
      // only the option shown, so it says how many there are and the lowest, as the quote's email did.
      const offer = optionsFrom(data);
      const total = hidesExactPrice(data)
        ? moneyRange(data.range_low, data.range_high, co.currency || "USD")
        : offer
          ? `${offer.count} options from ${fmt(offer.from)}`
          : fmt(data.total);
      vars = { number: data.number, title: data.title, total, address: addressOf(data.property as Property) };
      label = `Quote #${data.number}`;
      // A roof package's estimate is worked on in Roofing, where the office books the visit. Every
      // trade has packages now, so a package alone doesn't make it a roof.
      appPath = data.roof_package_id && (await roofWork(admin, co, subjectId, data.range_low !== null)) ? `/roofing/${subjectId}` : `/quotes/${subjectId}`;
      break;
    }
    case "job": {
      const { data } = await admin
        .from("jobs")
        .select("number, title, status, kind, autopay, financials:job_financials(contract_total), client_id, property_id, property:properties(line1, city, region), lines:job_line_items(name)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      jobId = subjectId;
      facts = {
        status: data.status, kind: data.kind, amount: Number(data.financials?.contract_total ?? 0), line_items: (data.lines as Array<{ name: string }>).map((l) => l.name),
        autopay: autopaySettings(co.settings).enabled && data.autopay === true ? "yes" : "no",
      };
      vars = { number: data.number, title: data.title, total: fmt(data.financials?.contract_total ?? 0), address: addressOf(data.property as Property) };
      label = `Job #${data.number}`;
      appPath = `/jobs/${subjectId}`;
      break;
    }
    case "visit": {
      const { data } = await admin
        .from("visits")
        .select("title, kind, status, scheduled_on, starts_at, job_id, property_id, property:properties(line1, city, region, client_id), job:jobs(client_id), request:requests(client_id)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      const rel = data as unknown as { job: { client_id: string } | null; request: { client_id: string } | null; property: (Property & { client_id: string }) | null };
      clientId = rel.job?.client_id ?? rel.request?.client_id ?? rel.property?.client_id ?? null;
      propertyId = data.property_id;
      jobId = data.job_id;
      facts = { status: data.status, kind: data.kind };
      const tz = co.timezone || "UTC";
      const date = data.starts_at ?? (data.scheduled_on ? `${data.scheduled_on}T12:00:00Z` : null);
      vars = {
        title: data.title,
        address: addressOf(rel.property),
        date: date ? new Date(date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: data.starts_at ? tz : "UTC" }) : "",
        time: data.starts_at ? ` at ${new Date(data.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}` : "",
      };
      label = data.title;
      appPath = data.job_id ? `/jobs/${data.job_id}` : "/schedule";
      break;
    }
    case "invoice": {
      const { data } = await admin
        .from("invoices")
        .select("number, subject, status, total, balance_due, client_id, job_id, lines:invoice_line_items(name)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      jobId = data.job_id;
      facts = { status: data.status, amount: Number(data.total), line_items: (data.lines as Array<{ name: string }>).map((l) => l.name), autopay: await invoiceOnAutopay(admin, companyId, subjectId) };
      vars = { number: data.number, title: data.subject || `Invoice #${data.number}`, total: fmt(data.total), balance: fmt(data.balance_due) };
      label = `Invoice #${data.number}`;
      appPath = `/invoices/${subjectId}`;
      break;
    }
  }

  let client: RunContext["client"] = null;
  if (clientId) {
    const { data } = await admin.from("clients").select("id, display_name, email, phone, tags, status, lead_source").eq("company_id", companyId).eq("id", clientId).maybeSingle();
    client = data ?? null;
    if (subject === "client") {
      if (!client) return null;
      facts = { status: client.status, autopay: await clientOnAutopay(admin, co, client.id) };
      vars = { title: client.display_name };
      label = client.display_name;
    }
  }
  facts.client = client ? { tags: client.tags, status: client.status, lead_source: client.lead_source } : null;

  return {
    subject,
    id: subjectId,
    label: client && subject !== "client" ? `${label} · ${client.display_name}` : label,
    company: co,
    client,
    facts,
    vars: {
      ...vars,
      status: statusChoices(subject).find((s) => s.value === facts.status)?.label ?? facts.status ?? "",
      client: { name: client?.display_name ?? "", first_name: firstName(client?.display_name), email: client?.email ?? "", phone: client?.phone ?? "" },
      company: { name: co.name, phone: co.phone ?? "", email: co.email ?? "", website: co.website ?? "" },
    },
    appPath,
    jobId,
    propertyId,
  };
}

/**
 * Adds the signed client link ({{link}}) for quotes and invoices: the client's own (own: 1), for
 * the emails and texts that go to their own email and phone. Everything else a rule writes, where
 * the team reads it, has the office's copy (officeVars).
 */
async function withLink(env: Env, ctx: RunContext, baseUrl: string | null): Promise<RunContext> {
  if (!baseUrl || (ctx.subject !== "quote" && ctx.subject !== "invoice")) return ctx;
  const link = await clientLink(env, baseUrl, { c: ctx.company.id, t: ctx.subject, id: ctx.id, own: 1 });
  return { ...ctx, vars: { ...ctx.vars, link } };
}

/**
 * Adds what the event itself says, for the triggers that carry it: a sub's offer gives {{sub.name}},
 * {{sub.price}} (the price offered) and, turned down, {{sub.reason}}. Autopay's give
 * {{autopay.card}} ("Visa ending 4242"), {{autopay.reason}} (why a charge failed) and
 * {{autopay.expires}} ("08/28"), as private.emit wrote them into the activity's data.
 */
export async function withEvent(admin: Db, ctx: RunContext, trigger: string, activityId: number | null | undefined): Promise<RunContext> {
  if (!triggerDef(trigger)?.variables?.length || activityId == null) return ctx;
  const { data } = await admin.from("activity").select("data").eq("company_id", ctx.company.id).eq("id", activityId).maybeSingle();
  const event = (data?.data ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (v == null ? "" : String(v));
  if (isAutopayTrigger(trigger)) {
    return { ...ctx, vars: { ...ctx.vars, autopay: { ...autopayVars(ctx.vars), card: text(event.card), reason: text(event.reason), expires: text(event.expires) } } };
  }
  return {
    ...ctx,
    vars: {
      ...ctx.vars,
      sub: { name: text(event.sub_name), price: event.total == null ? "" : money(event.total as number, ctx.company.currency || "USD"), reason: text(event.reason) },
    },
  };
}

/** The {{autopay.*}} values so far, as an object (none yet is an empty one). */
function autopayVars(vars: TemplateVars): Record<string, string | number | null | undefined> {
  const group = vars.autopay;
  return group && typeof group === "object" ? group : {};
}

/**
 * Adds {{autopay.link}} to rules about autopay: the client's own Hub link to their autopay page
 * (own: 1, and fresh, so it works for the full 120 days), for their emails and texts. Without the
 * app's address, or a client, it stays empty.
 */
export async function withAutopayLink(env: Env, ctx: RunContext, trigger: string, baseUrl: string | null): Promise<RunContext> {
  if (!baseUrl || !ctx.client || !isAutopayTrigger(trigger)) return ctx;
  const link = `${await clientLink(env, baseUrl, { c: ctx.company.id, t: "client", id: ctx.client.id, own: 1 })}?view=autopay`;
  return { ...ctx, vars: { ...ctx.vars, autopay: { ...autopayVars(ctx.vars), link } } };
}

/**
 * The values for the office's own notices, the notes and tasks a rule adds, and the copy of a
 * client's email or text kept on their timeline: the client links in them are the office's copies
 * (via "office", as Copy Client Hub link makes them), so none can be used to confirm a card for the
 * client or add a tip to their saved card. Everything else is as the client's emails have it.
 */
export async function officeVars(env: Env, ctx: RunContext, baseUrl: string | null): Promise<TemplateVars> {
  if (!baseUrl) return ctx.vars;
  const vars: TemplateVars = { ...ctx.vars };
  if (vars.link && (ctx.subject === "quote" || ctx.subject === "invoice")) {
    vars.link = await clientLink(env, baseUrl, { c: ctx.company.id, t: ctx.subject, id: ctx.id, via: "office" });
  }
  const group = autopayVars(vars);
  if (group.link && ctx.client) {
    vars.autopay = { ...group, link: `${await clientLink(env, baseUrl, { c: ctx.company.id, t: "client", id: ctx.client.id, via: "office" })}?view=autopay` };
  }
  return vars;
}

export async function buildContext(env: Env, admin: Db, companyId: string, subjectType: string, subjectId: string, baseUrl: string | null) {
  const ctx = await loadContext(admin, companyId, subjectType, subjectId);
  return ctx ? withLink(env, ctx, baseUrl) : null;
}

const render = (template: string | undefined, ctx: RunContext) => renderTemplate(template ?? "", ctx.vars).trim();

function companyFooter(company: CompanyInfo) {
  return [company.name, companyAddress(company.address)].filter(Boolean).join(" · ");
}

/**
 * Whoever of these the trigger lets hear about it: for a sub's offer (its price), only the office with
 * the Subcontractors area (private.subs_office); for autopay (a client's card, why a charge failed),
 * only the office with the invoices area (private.money_office). That holds whatever levels or people
 * the rule names, so neither a rule saved before someone lost the area nor one written straight to the
 * database tells anyone else.
 */
async function mayHear(admin: Db, ctx: RunContext, people: Array<{ user_id: string; role: string; role_id?: string | null }>) {
  const trigger = ctx.trigger ? triggerDef(ctx.trigger) : undefined;
  if (!trigger?.area && !trigger?.notifyRoles) return people;
  const roleIds = [...new Set(people.map((p) => p.role_id).filter((id): id is string => Boolean(id)))];
  const { data: roles, error } = roleIds.length ? await admin.from("company_roles").select("id, permissions").eq("company_id", ctx.company.id).in("id", roleIds) : { data: [], error: null };
  if (error) throw new Error(error.message);
  const custom = new Map((roles ?? []).map((r) => [r.id, r.permissions as string[]]));
  return people.filter((p) => {
    if (trigger.notifyRoles && !trigger.notifyRoles.includes(p.role)) return false;
    if (!trigger.area) return true;
    // A custom role whose row can't be read counts as having no areas.
    const areas = memberPermissions(p.role as Role, p.role_id ? (custom.get(p.role_id) ?? []) : null);
    return areas.includes(trigger.area);
  });
}

/**
 * What a message a rule sends is about. Rules about autopay carry a client's card and their own link,
 * so their emails and texts are kept as "autopay" messages, which only the office with the invoices
 * area reads (messages_read), not as the record's, which crews who see the client can read.
 */
const messageAbout = (ctx: RunContext, clientId: string) =>
  isAutopayTrigger(ctx.trigger) ? { related_type: "autopay", related_id: clientId } : { related_type: ctx.subject, related_id: ctx.id };

/** Performs one action. Returns a short description of what happened, or throws with the reason. */
export async function performAction(env: Env, admin: Db, ctx: RunContext, action: Action, ruleName: string, baseUrl: string | null): Promise<string> {
  const client = ctx.client;
  switch (action.type) {
    case "notify": {
      // The team only: a sub isn't sent the office's notices, even on their own visit.
      let query = admin.from("memberships").select("user_id, role, role_id").eq("company_id", ctx.company.id).eq("active", true).neq("role", "subcontractor");
      if (action.user_ids?.length && !action.roles?.length) query = query.in("user_id", action.user_ids);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      // "The people on the visit": its crew, or for a job, the people on its upcoming visits.
      const onIt = new Set<string>();
      if (action.roles?.includes("assigned") && (ctx.subject === "visit" || ctx.subject === "job")) {
        const visits = ctx.subject === "visit"
          ? [ctx.id]
          : ((await admin.from("visits").select("id").eq("job_id", ctx.id).not("status", "in", "(completed,cancelled)").limit(20)).data ?? []).map((v) => v.id);
        const { data: assigned } = visits.length ? await admin.from("visit_assignees").select("user_id").in("visit_id", visits) : { data: [] };
        for (const a of assigned ?? []) onIt.add(a.user_id);
      }
      const named = (data ?? []).filter((m) => action.roles?.includes(m.role) || action.user_ids?.includes(m.user_id) || onIt.has(m.user_id));
      if (!named.length) throw new Error("No one on the team matches who this rule notifies.");
      const people = await mayHear(admin, ctx, named);
      if (!people.length) {
        throw new Error(
          ctx.trigger && triggerDef(ctx.trigger)?.area === "invoices"
            ? "Only the office with the Invoices and payments area hears about autopay, and nobody this rule notifies has it."
            : "Only the office with the Subcontractors area hears about subs' offers, and nobody this rule notifies has it.",
        );
      }
      const office = { ...ctx, vars: await officeVars(env, ctx, baseUrl) };
      const title = render(action.title, office) || ruleName;
      const { error: insertError } = await admin.from("notifications").insert(
        people.map((p) => ({ company_id: ctx.company.id, user_id: p.user_id, kind: ctx.subject, title: title.slice(0, 300), body: render(action.body, office) || null, link: ctx.appPath })),
      );
      if (insertError) throw new Error(insertError.message);
      return `Notified ${people.length} ${people.length === 1 ? "person" : "people"}`;
    }
    case "send_email": {
      if (!client) throw new Error("There's no client on this record.");
      if (!isEmail(client.email)) throw new Error(`${client.display_name} has no email address.`);
      const subject = render(action.subject, ctx);
      const text = render(action.body, ctx);
      const email = renderEmail({ companyName: ctx.company.name, logo: baseUrl ? logoImage(baseUrl, ctx.company.id, ctx.company.settings) : null, text, footer: companyFooter(ctx.company) });
      const result = await sendEmail(env, { to: client.email!.trim(), subject, text: email.text, html: email.html, replyTo: ctx.company.email ?? undefined, fromName: ctx.company.name }, ctx.company.id);
      if (!result.sent) throw new Error(result.reason ?? "The email wasn't sent.");
      // The timeline's copy has the office's copies of the client's links (officeVars).
      const kept = { ...ctx, vars: await officeVars(env, ctx, baseUrl) };
      await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "email", direction: "out", subject: render(action.subject, kept), body: render(action.body, kept),
        ...messageAbout(ctx, client.id), external_id: result.id ?? null, sent_by: null,
      });
      return `Emailed ${client.email}`;
    }
    case "send_sms": {
      if (!client) throw new Error("There's no client on this record.");
      if (!client.phone) throw new Error(`${client.display_name} has no phone number.`);
      const body = render(action.body, ctx);
      const result = await sendSms(env, { to: client.phone, body });
      if (!result.sent) throw new Error(result.reason ?? "The text wasn't sent.");
      // The timeline's copy has the office's copies of the client's links (officeVars).
      const kept = { ...ctx, vars: await officeVars(env, ctx, baseUrl) };
      await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "sms", direction: "out", body: render(action.body, kept),
        ...messageAbout(ctx, client.id), external_id: result.id ?? null, sent_by: null,
      });
      return `Texted ${client.phone}`;
    }
    case "add_tag":
    case "remove_tag": {
      if (!client) throw new Error("There's no client on this record.");
      const tag = action.tag.trim();
      const has = client.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
      if (action.type === "add_tag" && has) return `Already tagged “${tag}”`;
      if (action.type === "remove_tag" && !has) return `Didn't have the tag “${tag}”`;
      const tags = action.type === "add_tag" ? [...client.tags, tag] : client.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
      const { error } = await admin.from("clients").update({ tags }).eq("id", client.id).eq("company_id", ctx.company.id);
      if (error) throw new Error(error.message);
      client.tags = tags;
      return action.type === "add_tag" ? `Tagged “${tag}”` : `Removed “${tag}”`;
    }
    case "add_note": {
      if (!client) throw new Error("There's no client on this record.");
      // Crews who see the client read its notes: nothing about autopay goes there (the database refuses the rule too).
      if (isAutopayTrigger(ctx.trigger)) throw new Error("A rule about autopay can't add a client note (crews can read them).");
      // The team reads notes, so a link in one is the office's copy (officeVars), as the preview shows it.
      const kept = { ...ctx, vars: await officeVars(env, ctx, baseUrl) };
      const { error } = await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "note", direction: "internal", body: render(action.body, kept),
        related_type: ctx.subject, related_id: ctx.id, sent_by: null,
      });
      if (error) throw new Error(error.message);
      return "Added a note";
    }
    case "create_task": {
      const today = localDate(new Date(), ctx.company.timezone || "UTC");
      const due = addDays(today, Math.max(0, Math.min(365, Math.round(Number(action.days_from_now) || 0))));
      // A task is on the schedule, where the crew sees it: never a sub's price or reason in it, and
      // a link in it is the office's copy (officeVars), as the preview shows it.
      const office = await officeVars(env, ctx, baseUrl);
      const title = renderTemplate(action.title ?? "", ctx.trigger ? taskVars(ctx.trigger, office) : office).trim();
      const { error } = await admin.from("visits").insert({
        company_id: ctx.company.id, kind: "task", title: (title || ruleName).slice(0, 200), scheduled_on: due, status: "scheduled",
        job_id: ctx.subject === "job" || ctx.subject === "visit" || ctx.subject === "invoice" ? ctx.jobId : null,
        property_id: ctx.propertyId, notes: `Created by the automation “${ruleName}”.`,
      });
      if (error) throw new Error(error.message);
      return `Created a task for ${due}`;
    }
    case "request_review": {
      if (!client) throw new Error("There's no client on this record.");
      const result = await sendReviewRequest(env, admin, {
        companyId: ctx.company.id, client, jobId: ctx.jobId, channel: action.channel === "sms" ? "sms" : "email", baseUrl, skipIfRecentDays: 30, createdBy: null,
      });
      return result.detail;
    }
    case "update_status": {
      const allowed = STATUS_ACTION_CHOICES[ctx.subject]?.some((s) => s.value === action.status);
      if (!allowed || (ctx.subject !== "quote" && ctx.subject !== "request")) throw new Error("That status change isn't available for this record.");
      const table = ctx.subject === "quote" ? "quotes" : "requests";
      const { error } = await admin.from(table).update({ status: action.status }).eq("id", ctx.id).eq("company_id", ctx.company.id);
      if (error) throw new Error(error.message);
      return action.status === "lost" ? "Marked lost" : "Archived";
    }
    case "invite_autopay": {
      if (!client) throw new Error("There's no client on this record.");
      // Skips (already on autopay, invited in the last week) are fine; a reason it can't go out fails the action.
      const result = await sendAutopayInvite(env, admin, {
        companyId: ctx.company.id, clientId: client.id, channel: action.channel === "sms" ? "sms" : "email", baseUrl, createdBy: null, skipIfRecentDays: 7,
      });
      return result.detail;
    }
    default:
      throw new Error("Unknown action.");
  }
}

interface RunRow {
  id: number;
  company_id: string;
  rule_id: string;
  subject_type: string | null;
  subject_id: string | null;
  /** The event that queued it (public.activity). */
  activity_id?: number | null;
  result: unknown;
  /** The batch's claim (claim_automation_runs): this worker holds the run while it still matches. */
  claim_token: string | null;
}

/** The claim couldn't be checked, so the run is left as it is; it's retried once the claim runs out. */
class ClaimUnchecked extends Error {}

/** Records how the run went if this worker still holds it; "lost" when another worker has it now. */
async function finish(admin: Db, run: RunRow, status: "done" | "skipped" | "failed", result: ActionResult[], error: string | null) {
  const { data: held, error: finishError } = await admin.rpc("finish_automation_run", {
    p_id: run.id, p_token: run.claim_token!, p_status: status, p_result: result as unknown as never, p_error: error ?? undefined,
  });
  return !finishError && !held ? "lost" : status;
}

/** Five more minutes on this worker's claim, keeping the actions done so far; false once it's another's. */
async function renew(admin: Db, run: RunRow, results: ActionResult[]) {
  const { data, error } = await admin.rpc("renew_automation_run", { p_id: run.id, p_token: run.claim_token!, p_result: results as unknown as never });
  if (error) throw new ClaimUnchecked(error.message);
  return data === true;
}

export async function executeRun(env: Env, admin: Db, run: RunRow, baseUrl: string | null): Promise<"done" | "skipped" | "failed" | "lost"> {
  try {
    const { data: rule } = await admin.from("automation_rules").select("id, name, trigger, enabled, conditions, actions, run_count").eq("id", run.rule_id).maybeSingle();
    if (!rule || !rule.enabled) return finish(admin, run, "skipped", [], "The rule was turned off or deleted.");
    if (!run.subject_type || !run.subject_id) return finish(admin, run, "skipped", [], "There was nothing to act on.");
    const loaded = await buildContext(env, admin, run.company_id, run.subject_type, run.subject_id, baseUrl);
    if (!loaded) return finish(admin, run, "skipped", [], "The record was deleted.");
    const ctx = await withAutopayLink(env, { ...(await withEvent(admin, loaded, rule.trigger, run.activity_id)), trigger: rule.trigger }, rule.trigger, baseUrl);
    // The actions this trigger takes (a sub's offer: notices to the office and tasks), whatever the
    // rule says: a rule written straight to the database doesn't get to text the client a sub's price.
    // A status change is checked by the action itself, as the rule screen checks it.
    const def = triggerDef(rule.trigger);
    const fits = new Set<string>(actionsForTrigger(rule.trigger).map((a) => a.type));
    const fitsTrigger = (action: Action) => (action.type === "update_status" ? !def?.actions || def.actions.includes("update_status") : fits.has(action.type));

    const check = evaluateConditions((rule.conditions ?? []) as unknown as Condition[], ctx.facts, ctx.subject);
    if (!check.pass) return finish(admin, run, "skipped", [], `Conditions not met: ${(check.failed ?? "").charAt(0).toLowerCase()}${(check.failed ?? "").slice(1)}.`);

    const prior = Array.isArray(run.result) ? (run.result as ActionResult[]) : [];
    const results: ActionResult[] = [];
    const actions = (rule.actions ?? []) as unknown as Action[];
    let acted = false;
    for (const [i, action] of actions.entries()) {
      if (prior[i]?.ok && prior[i].type === action.type) {
        results.push(prior[i]);
        continue;
      }
      // An email can take a few minutes (lib/smtp.ts), so the claim is renewed before each action
      // after the first, with what's done so far. If another worker has the run by then, this one
      // stops there: that worker does the rest, skipping what this one did.
      if (!fitsTrigger(action)) {
        results.push({ type: action.type, ok: false, detail: "This action doesn't fit what starts this rule." });
        continue;
      }
      if (acted && !(await renew(admin, run, results))) return "lost";
      acted = true;
      try {
        results.push({ type: action.type, ok: true, detail: await performAction(env, admin, ctx, action, rule.name, baseUrl) });
      } catch (error) {
        results.push({ type: action.type, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    const failure = results.find((r) => !r.ok);
    const outcome = await finish(admin, run, failure ? "failed" : "done", results, failure ? failure.detail : null);
    // Counted by the worker that finished the run, not by one whose claim had gone.
    if (outcome !== "lost") await admin.from("automation_rules").update({ run_count: (rule.run_count ?? 0) + 1, last_run_at: new Date().toISOString() }).eq("id", rule.id);
    return outcome;
  } catch (error) {
    if (error instanceof ClaimUnchecked) throw error;
    console.error("Automation run failed", run.id, error);
    return finish(admin, run, "failed", [], error instanceof Error ? error.message : String(error));
  }
}

/** Runs this worker claimed but never started go back to waiting, without using an attempt. */
async function release(admin: Db, runs: RunRow[]) {
  if (runs.length) await admin.rpc("release_automation_runs", { p_token: runs[0]!.claim_token!, p_ids: runs.map((r) => r.id) });
}

export async function processAutomations(env: Env, options: { companyId?: string; limit?: number; baseUrl?: string | null } = {}) {
  const admin = adminClient(env);
  const baseUrl = options.baseUrl ?? env.APP_URL ?? null;
  const { data: runs, error } = await admin.rpc("claim_automation_runs", { p_limit: options.limit ?? 25, ...(options.companyId ? { p_company: options.companyId } : {}) });
  if (error) throw new Error(error.message);
  const claimed = runs ?? [];
  const tally = { claimed: claimed.length, done: 0, skipped: 0, failed: 0, lost: 0 };
  let next = 0; // the first run not started yet
  try {
    for (const [index, run] of claimed.entries()) {
      next = index;
      // A batch is claimed for five minutes and a slow one can outlast that, so confirm (and extend)
      // this run's claim right before doing it, which is also when the attempt counts. If that fails,
      // another worker has claimed the run since.
      const { data: held, error: startError } = await admin.rpc("start_automation_run", { p_id: run.id, p_token: run.claim_token! });
      if (startError) throw new Error(startError.message);
      next = index + 1;
      if (!held) {
        tally.lost++;
        continue;
      }
      tally[await executeRun(env, admin, run, baseUrl)]++;
    }
  } finally {
    // A batch that stops early (the database didn't answer) leaves the runs it didn't get to for the
    // next one right away, instead of until the claim runs out.
    await release(admin, claimed.slice(next));
  }
  return tally;
}
