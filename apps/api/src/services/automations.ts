/**
 * The automation engine. Claims due automation_runs, loads the record each run is about,
 * re-checks the rule's conditions against fresh data and performs its actions.
 *
 * Runs are processed every minute by cron, and right away when the web app or a public page
 * reports an action (POST /api/automations/process), so notifications feel instant.
 * A retried run skips actions that already succeeded, so nobody gets the same email twice. An
 * action that has to wait (an automatic review ask during quiet hours: WaitUntil) puts the run back
 * until then, and one with nothing to do says so (Skip) without failing the run.
 *
 * A rule that's an automated campaign (Marketing → Campaigns, services/automatedCampaigns.ts) sends
 * its email as one, tracked. Re-engage past clients (any rule on client.inactive) and Win back lost
 * quotes are marketing: their runs are skipped while Marketing is off and for clients who opted out
 * of marketing or are archived, whatever actions the rule has.
 */
import {
  actionsForTrigger,
  addDays,
  evaluateConditions,
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
import { daysSinceVisit, type AutomatedCampaign } from "@crewtavo/core/campaigns";
import { hidesExactPrice } from "@crewtavo/core/estimates";
import { marketingOn, REFERRAL_GAP_DAYS, REVIEW_GAP_DAYS, textsOff, textsOffReason } from "@crewtavo/core/marketing";
import { countsOn } from "@crewtavo/core/money";
import type { Env } from "../env";
import { companyAddress, companyFooter, firstName, isEmail, renderEmail } from "../lib/email";
import { clientLink } from "../lib/links";
import { sendEmail, sendSms } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { CAMPAIGN_LINK_DAYS, campaignRuleOf, letStretchGo, sendCampaignEmail } from "./automatedCampaigns";
import { logoImage } from "./logo";
import { sendReferralAsk } from "./referrals";
import { Busy, sendReviewRequest, WaitUntil } from "./reviews";
import { isRoofWork } from "./roofPackages";
import { optionsFrom } from "./sales";
import { noteRefusedText } from "./textsOff";

export interface ActionResult {
  type: string;
  ok: boolean;
  detail: string;
  /** Nothing to do (Marketing is off, the client opted out): not a failure, and not a success either. */
  skipped?: true;
}

/** What an action returns when it had nothing to do, and why. */
export class Skip {
  constructor(readonly detail: string) {}
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
  client: {
    id: string;
    display_name: string;
    email: string | null;
    phone: string | null;
    tags: string[];
    status: string;
    lead_source: string | null;
    review_opt_out: boolean;
    marketing_opt_out: boolean;
    sms_opt_out_at: string | null;
    reviewed_at: string | null;
  } | null;
  facts: Facts;
  vars: TemplateVars;
  appPath: string;
  jobId: string | null;
  propertyId: string | null;
  /** What started the rule (its trigger), once it's running: some keep to their own rules (sub_offer.*). */
  trigger?: string;
  /** The automated campaign the rule's email is sent as, once it's running. */
  campaign?: AutomatedCampaign;
  /** The run, for recording its campaign email once, and which of its actions this is (from 0). */
  run?: { id: number; activity_id: number | null; action?: number };
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

export { companyAddress, companyFooter };

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

/** When the client's last visit was: their latest completed job visit or assessment, on a job or a request of theirs. */
async function lastVisit(admin: Db, companyId: string, clientId: string): Promise<Date | null> {
  const latest = (rows: Array<{ completed_at: string | null }> | null) => rows?.[0]?.completed_at ?? null;
  const [onJobs, onRequests] = await Promise.all([
    admin.from("visits").select("completed_at, job:jobs!inner(client_id)").eq("company_id", companyId).eq("job.client_id", clientId).eq("status", "completed")
      .in("kind", ["job", "assessment"]).not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1),
    admin.from("visits").select("completed_at, request:requests!inner(client_id)").eq("company_id", companyId).eq("request.client_id", clientId).is("job_id", null)
      .eq("status", "completed").in("kind", ["job", "assessment"]).not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1),
  ]);
  if (onJobs.error || onRequests.error) throw new Error((onJobs.error ?? onRequests.error)!.message);
  const times = [latest(onJobs.data), latest(onRequests.data)].filter((t): t is string => Boolean(t)).map((t) => Date.parse(t));
  return times.length ? new Date(Math.max(...times)) : null;
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
        .select("number, title, status, kind, financials:job_financials(contract_total), client_id, property_id, property:properties(line1, city, region), lines:job_line_items(name)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      jobId = subjectId;
      facts = {
        status: data.status, kind: data.kind, job_kind: data.kind, amount: Number(data.financials?.contract_total ?? 0), line_items: (data.lines as Array<{ name: string }>).map((l) => l.name),
      };
      vars = { number: data.number, title: data.title, total: fmt(data.financials?.contract_total ?? 0), address: addressOf(data.property as Property) };
      label = `Job #${data.number}`;
      appPath = `/jobs/${subjectId}`;
      break;
    }
    case "visit": {
      const { data } = await admin
        .from("visits")
        .select("title, kind, status, scheduled_on, starts_at, job_id, property_id, property:properties(line1, city, region, client_id), job:jobs(client_id, kind), request:requests(client_id)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      const rel = data as unknown as { job: { client_id: string; kind: string } | null; request: { client_id: string } | null; property: (Property & { client_id: string }) | null };
      clientId = rel.job?.client_id ?? rel.request?.client_id ?? rel.property?.client_id ?? null;
      propertyId = data.property_id;
      jobId = data.job_id;
      facts = { status: data.status, kind: data.kind, job_kind: rel.job?.kind ?? null };
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
        .select("number, subject, status, kind, total, balance_due, amount_paid, client_id, job_id, job:jobs(kind), lines:invoice_line_items(name)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      jobId = data.job_id;
      facts = {
        status: data.status, invoice_kind: data.kind, job_kind: (data.job as unknown as { kind: string } | null)?.kind ?? null, amount: Number(data.total), amount_paid: Number(data.amount_paid ?? 0),
        line_items: (data.lines as Array<{ name: string }>).map((l) => l.name),
      };
      vars = { number: data.number, title: data.subject || `Invoice #${data.number}`, total: fmt(data.total), balance: fmt(data.balance_due) };
      label = `Invoice #${data.number}`;
      appPath = `/invoices/${subjectId}`;
      break;
    }
  }

  let client: RunContext["client"] = null;
  if (clientId) {
    const { data } = await admin
      .from("clients")
      .select("id, display_name, email, phone, tags, status, lead_source, review_opt_out, marketing_opt_out, sms_opt_out_at, reviewed_at")
      .eq("company_id", companyId)
      .eq("id", clientId)
      .maybeSingle();
    client = data ?? null;
    if (subject === "client") {
      if (!client) return null;
      // Days since their last visit, in the company's own dates, as client.inactive counts them.
      const tz = co.timezone || "UTC";
      const last = await lastVisit(admin, companyId, client.id);
      facts = { status: client.status, days_since_visit: last ? daysSinceVisit(last, new Date(), tz) : null };
      vars = { title: client.display_name, last_visit: last ? last.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: tz }) : "" };
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

/** Adds the signed client link ({{link}}): a quote's or invoice's Client Hub page, or for a client the Hub's home. */
async function withLink(env: Env, ctx: RunContext, baseUrl: string | null): Promise<RunContext> {
  if (!baseUrl || (ctx.subject !== "quote" && ctx.subject !== "invoice" && ctx.subject !== "client")) return ctx;
  const link = await clientLink(env, baseUrl, { c: ctx.company.id, t: ctx.subject, id: ctx.id });
  return { ...ctx, vars: { ...ctx.vars, link } };
}

/**
 * {{link}} in a re-engage or win-back email is the client's Client Hub home, where they can ask for
 * work (a lost quote can't be approved from its page). It lasts a year, as a review link does: campaign
 * emails are kept and clicked long after a quote's or invoice's would be.
 */
async function withHomeLink(env: Env, ctx: RunContext, baseUrl: string | null): Promise<RunContext> {
  if (!baseUrl || !ctx.client) return ctx;
  return { ...ctx, vars: { ...ctx.vars, link: await clientLink(env, baseUrl, { c: ctx.company.id, t: "client", id: ctx.client.id }, CAMPAIGN_LINK_DAYS) } };
}

/**
 * Adds what the event itself says, for the triggers that carry it: a sub's offer gives {{sub.name}},
 * {{sub.price}} (the price offered) and, turned down, {{sub.reason}}; a referral credit earned gives
 * {{referral.name}} (the friend's first name), {{referral.credit}} and {{referral.invoice}} (the
 * invoice it went on, if it did).
 */
export async function withEvent(admin: Db, ctx: RunContext, trigger: string, activityId: number | null | undefined): Promise<RunContext> {
  if (!triggerDef(trigger)?.variables?.length || activityId == null) return ctx;
  const { data } = await admin.from("activity").select("data").eq("company_id", ctx.company.id).eq("id", activityId).maybeSingle();
  const event = (data?.data ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (v == null ? "" : String(v));
  const amount = (v: unknown) => (v == null ? "" : money(v as number, ctx.company.currency || "USD"));
  if (trigger === "referral.earned") {
    const invoice = event.invoice_number == null ? "" : `#${event.invoice_number}`;
    return { ...ctx, vars: { ...ctx.vars, referral: { name: event.friend_name ? firstName(text(event.friend_name)) : "", credit: amount(event.credit), invoice } } };
  }
  return {
    ...ctx,
    vars: { ...ctx.vars, sub: { name: text(event.sub_name), price: amount(event.total), reason: text(event.reason) } },
  };
}

export async function buildContext(env: Env, admin: Db, companyId: string, subjectType: string, subjectId: string, baseUrl: string | null) {
  const ctx = await loadContext(admin, companyId, subjectType, subjectId);
  return ctx ? withLink(env, ctx, baseUrl) : null;
}

const render = (template: string | undefined, ctx: RunContext) => renderTemplate(template ?? "", ctx.vars).trim();

/**
 * Whoever of these the trigger lets hear about it: for a sub's offer (its price), only the office with
 * the Subcontractors area (private.subs_office), whatever levels or people the rule names, so neither
 * a rule saved before someone lost the area nor one written straight to the database tells anyone else.
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
 * Performs one action. Returns a short description of what happened (a Skip when there was nothing
 * to do), throws with the reason, or throws WaitUntil when it can't happen yet.
 */
export async function performAction(env: Env, admin: Db, ctx: RunContext, action: Action, ruleName: string, baseUrl: string | null): Promise<string | Skip> {
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
      if (!people.length) throw new Error("Only the office with the Subcontractors area hears about subs' offers, and nobody this rule notifies has it.");
      const title = render(action.title, ctx) || ruleName;
      const { error: insertError } = await admin.from("notifications").insert(
        people.map((p) => ({ company_id: ctx.company.id, user_id: p.user_id, kind: ctx.subject, title: title.slice(0, 300), body: render(action.body, ctx) || null, link: ctx.appPath })),
      );
      if (insertError) throw new Error(insertError.message);
      return `Notified ${people.length} ${people.length === 1 ? "person" : "people"}`;
    }
    case "send_email": {
      // An automated campaign's email goes as one, tracked (Close pending quotes as it always has without APP_URL).
      if (ctx.campaign && (ctx.campaign.marketing || baseUrl)) return sendCampaignEmail(env, admin, ctx, action, baseUrl);
      if (!client) throw new Error("There's no client on this record.");
      if (!isEmail(client.email)) throw new Error(`${client.display_name} has no email address.`);
      const subject = render(action.subject, ctx);
      const text = render(action.body, ctx);
      const email = renderEmail({ companyName: ctx.company.name, logo: baseUrl ? logoImage(baseUrl, ctx.company.id, ctx.company.settings) : null, text, footer: companyFooter(ctx.company) });
      const result = await sendEmail(env, { to: client.email!.trim(), subject, text: email.text, html: email.html, replyTo: ctx.company.email ?? undefined, fromName: ctx.company.name }, ctx.company.id);
      if (!result.sent) throw new Error(result.reason ?? "The email wasn't sent.");
      await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "email", direction: "out", subject, body: text,
        related_type: ctx.subject, related_id: ctx.id, external_id: result.id ?? null, sent_by: null,
      });
      return `Emailed ${client.email}`;
    }
    case "send_sms": {
      if (!client) throw new Error("There's no client on this record.");
      if (!client.phone) throw new Error(`${client.display_name} has no phone number.`);
      if (textsOff(client)) return new Skip(textsOffReason(client.display_name).replace(/\.$/, ""));
      const body = render(action.body, ctx);
      const result = await sendSms(env, { to: client.phone, body });
      await noteRefusedText(admin, client, client.phone, result);
      if (!result.sent) throw new Error(result.reason ?? "The text wasn't sent.");
      await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "sms", direction: "out", body,
        related_type: ctx.subject, related_id: ctx.id, external_id: result.id ?? null, sent_by: null,
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
      const { error } = await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "note", direction: "internal", body: render(action.body, ctx),
        related_type: ctx.subject, related_id: ctx.id, sent_by: null,
      });
      if (error) throw new Error(error.message);
      return "Added a note";
    }
    case "create_task": {
      const today = localDate(new Date(), ctx.company.timezone || "UTC");
      const due = addDays(today, Math.max(0, Math.min(365, Math.round(Number(action.days_from_now) || 0))));
      // A task is on the schedule, where the crew sees it: never a sub's price or reason in it.
      const title = renderTemplate(action.title ?? "", ctx.trigger ? taskVars(ctx.trigger, ctx.vars) : ctx.vars).trim();
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
      const channel = action.channel === "sms" || action.channel === "both" ? action.channel : "email";
      const result = await sendReviewRequest(env, admin, {
        companyId: ctx.company.id, client, jobId: ctx.jobId, channel, baseUrl, automatic: true, skipIfRecentDays: REVIEW_GAP_DAYS, createdBy: null,
      });
      return result.skipped ? new Skip(result.detail) : result.detail;
    }
    case "request_referral": {
      if (!client) throw new Error("There's no client on this record.");
      const result = await sendReferralAsk(env, admin, {
        companyId: ctx.company.id, client, baseUrl, automatic: true, skipIfRecentDays: REFERRAL_GAP_DAYS, createdBy: null,
      });
      return result.skipped ? new Skip(result.detail) : result.detail;
    }
    case "update_status": {
      const allowed = STATUS_ACTION_CHOICES[ctx.subject]?.some((s) => s.value === action.status);
      if (!allowed || (ctx.subject !== "quote" && ctx.subject !== "request")) throw new Error("That status change isn't available for this record.");
      const table = ctx.subject === "quote" ? "quotes" : "requests";
      const { error } = await admin.from(table).update({ status: action.status }).eq("id", ctx.id).eq("company_id", ctx.company.id);
      if (error) throw new Error(error.message);
      return action.status === "lost" ? "Marked lost" : "Archived";
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
  /** Times it waited for a busy email service (Busy). */
  busy_tries?: number | null;
}

/** A run waits this many times for a busy email service, then fails. */
export const BUSY_TRIES = 4;
/** How long a run waits for a busy email service after `tries` waits already: 1, 2, 4, then 8 minutes. */
export const busyWait = (tries: number) => 60_000 * 2 ** Math.max(0, Math.min(tries, BUSY_TRIES - 1));

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

/**
 * Skips a run called off by its rule being turned off or Marketing uninstalled after this worker
 * claimed it, when the database's own calling off (only of runs still waiting) missed it. A
 * client.inactive run lets the client's stretch go then too, so they're emailed once it's back on.
 */
async function calledOff(admin: Db, run: RunRow, inactive: boolean, why: string) {
  const outcome = await finish(admin, run, "skipped", [], why);
  if (inactive && outcome !== "lost") await letStretchGo(admin, run.id);
  return outcome;
}

/** What a run said along the way: it's waiting because the email service was busy, so its batch stops there. */
interface RunNotes {
  busy: boolean;
}

export async function executeRun(env: Env, admin: Db, run: RunRow, baseUrl: string | null, notes: RunNotes = { busy: false }): Promise<"done" | "skipped" | "failed" | "waiting" | "lost"> {
  try {
    const { data: rule } = await admin.from("automation_rules").select("id, name, trigger, enabled, conditions, actions, run_count, template_key").eq("id", run.rule_id).maybeSingle();
    if (!rule || !rule.enabled) return calledOff(admin, run, rule?.trigger === "client.inactive", "The rule was turned off or deleted.");
    if (!run.subject_type || !run.subject_id) return finish(admin, run, "skipped", [], "There was nothing to act on.");
    const loaded = await buildContext(env, admin, run.company_id, run.subject_type, run.subject_id, baseUrl);
    if (!loaded) return finish(admin, run, "skipped", [], "The record was deleted.");
    const campaign = campaignRuleOf(rule) ?? undefined;
    let ctx: RunContext = { ...(await withEvent(admin, loaded, rule.trigger, run.activity_id)), trigger: rule.trigger, campaign, run: { id: run.id, activity_id: run.activity_id ?? null } };
    // A marketing campaign's run does nothing at all (an action a business added, a text, included)
    // while Marketing is off, or for a client who unsubscribed from marketing or is archived.
    if (campaign?.marketing) {
      const who = ctx.client;
      if (!marketingOn(ctx.company.settings)) return calledOff(admin, run, campaign.key === "reengage", "Marketing is off");
      if (who?.marketing_opt_out) return finish(admin, run, "skipped", [], `${who.display_name} unsubscribed from marketing`);
      if (who?.status === "archived") return finish(admin, run, "skipped", [], `${who.display_name} is archived`);
    }
    if (campaign?.marketing) ctx = await withHomeLink(env, ctx, baseUrl);
    // The actions this trigger takes (a sub's offer: notices to the office and tasks), whatever the
    // rule says: a rule written straight to the database doesn't get to text the client a sub's price.
    // A status change is checked by the action itself, as the rule screen checks it.
    const def = triggerDef(rule.trigger);
    const fits = new Set<string>(actionsForTrigger(rule.trigger).map((a) => a.type));
    const fitsTrigger = (action: Action) => (action.type === "update_status" ? !def?.actions || def.actions.includes("update_status") : fits.has(action.type));

    const check = evaluateConditions((rule.conditions ?? []) as unknown as Condition[], ctx.facts, ctx.subject);
    if (!check.pass) {
      const outcome = await finish(admin, run, "skipped", [], `Conditions not met: ${(check.failed ?? "").charAt(0).toLowerCase()}${(check.failed ?? "").slice(1)}.`);
      // A client.inactive run's client changed since it was queued (a tag taken off): their stretch is
      // let go, so they're emailed if they meet the rule again before their next visit.
      if (rule.trigger === "client.inactive" && outcome !== "lost") await letStretchGo(admin, run.id);
      return outcome;
    }

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
        const done = await performAction(env, admin, { ...ctx, run: { ...ctx.run!, action: i } }, action, rule.name, baseUrl);
        results.push(done instanceof Skip ? { type: action.type, ok: true, skipped: true, detail: done.detail } : { type: action.type, ok: true, detail: done });
      } catch (error) {
        // The email service is busy (Resend's 429 or 5xx): the run waits longer each time, and the
        // batch stops so the rest don't pile in after it. After a few tries it fails, saying why.
        if (error instanceof Busy && (run.busy_tries ?? 0) < BUSY_TRIES) {
          notes.busy = true;
          const wait = busyWait(run.busy_tries ?? 0);
          const minutes = Math.round(wait / 60_000);
          const note = `${error.message.replace(/ Try again in [^.]*\.$/, "")} It's tried again by itself in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
          return postpone(admin, run, new WaitUntil(new Date(Date.now() + wait), note), results, true);
        }
        // Not yet: the run waits with what's done so far, and this action and the ones after it go
        // then. The reason is the run's note, not a result, so the action isn't counted as done.
        if (error instanceof WaitUntil && !(error instanceof Busy)) return postpone(admin, run, error, results);
        results.push({ type: action.type, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    const failure = results.find((r) => !r.ok);
    // A run whose every action had nothing to do is skipped, not done.
    const status = failure ? "failed" : results.length && results.every((r) => r.skipped) ? "skipped" : "done";
    const outcome = await finish(admin, run, status, results, failure ? failure.detail : null);
    // Counted by the worker that finished the run, not by one whose claim had gone.
    if (outcome !== "lost" && outcome !== "skipped") await admin.from("automation_rules").update({ run_count: (rule.run_count ?? 0) + 1, last_run_at: new Date().toISOString() }).eq("id", rule.id);
    return outcome;
  } catch (error) {
    if (error instanceof ClaimUnchecked) throw error;
    console.error("Automation run failed", run.id, error);
    return finish(admin, run, "failed", [], error instanceof Error ? error.message : String(error));
  }
}

/** Puts the run back to wait until the action can happen (`busy`: for a busy email service, counted); "lost" when another worker has it now. */
async function postpone(admin: Db, run: RunRow, wait: WaitUntil, results: ActionResult[], busy = false) {
  const { data: held, error } = await admin.rpc("postpone_automation_run", {
    p_id: run.id, p_token: run.claim_token!, p_until: wait.until.toISOString(), p_result: results as unknown as never, p_note: wait.message, ...(busy ? { p_busy: true } : {}),
  });
  if (error) throw new ClaimUnchecked(error.message);
  return held ? "waiting" : "lost";
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
  const tally = { claimed: claimed.length, done: 0, skipped: 0, failed: 0, waiting: 0, lost: 0 };
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
      const notes: RunNotes = { busy: false };
      tally[await executeRun(env, admin, run, baseUrl, notes)]++;
      // The email service is turning emails away: the rest of the batch goes back for the next pass
      // (finally, below) instead of meeting the same answer.
      if (notes.busy) break;
    }
  } finally {
    // A batch that stops early (the database didn't answer) leaves the runs it didn't get to for the
    // next one right away, instead of until the claim runs out.
    await release(admin, claimed.slice(next));
  }
  return tally;
}
