/**
 * Asking a client for referrals, Jobber's way (docs/marketing-plan.md, phase B): an email with
 * their own referral link (the public referral page, routes/public.ts), saying what their friend and
 * they get, with one-click unsubscribe. Email only, and no reminders. It lands in the client's
 * messages like a review ask.
 *
 * An ask sent by the starter rule (`automatic`) skips what it can't send (Marketing is off,
 * Referrals have no credit or offer, the client opted out of marketing, is archived or has no email)
 * and clients asked in the last 6 months, and waits while the client's review reminders are still
 * going out, so they aren't sent both at once. One by hand goes right away, or says why it can't.
 * Every ask that went counts toward the 6 months (begin_referral_ask).
 */
import { renderTemplate } from "@crewtavo/core";
import { marketingOn, referralAskRefusal, referralRewards, referralSettings, referralsReady, REFERRAL_EMAIL_NOT_CONNECTED, REFERRAL_GAP_DAYS } from "@crewtavo/core/marketing";
import type { Env } from "../env";
import { firstName } from "../lib/email";
import { clientLink } from "../lib/links";
import { emailReady } from "../lib/notify";
import type { Db } from "../lib/supabase";
import { emailClient } from "./marketingEmail";
import { WaitUntil } from "./reviews";

export interface ReferralClient {
  id: string;
  display_name: string;
  email: string | null;
  status?: string | null;
  marketing_opt_out?: boolean | null;
}

interface ReferralAskArgs {
  companyId: string;
  client: ReferralClient;
  baseUrl: string | null;
  /** Sent by an automation, not by someone. */
  automatic?: boolean;
  /** Doesn't ask a client who was asked within this many days (automations: REFERRAL_GAP_DAYS). */
  skipIfRecentDays?: number;
  createdBy: string | null;
}

export interface ReferralAskResult {
  sent: boolean;
  detail: string;
  id: string;
  /** Nothing was sent, and that's as it should be (the detail says why). */
  skipped?: true;
}

/** Why an ask by hand can't go: said as the pages that offer it say it. */
export class ReferralAskRefused extends Error {
  override name = "ReferralAskRefused";
  constructor(
    message: string,
    /** Marketing is off: the business's to turn on, not this client's. */
    readonly marketingOff = false,
  ) {
    super(message);
  }
}

const recentlyAsked = (days: number) => `Already asked for referrals in the last ${days === REFERRAL_GAP_DAYS ? "6 months" : `${days} days`}`;

export async function sendReferralAsk(env: Env, admin: Db, args: ReferralAskArgs): Promise<ReferralAskResult> {
  const automatic = args.automatic === true;
  const { client } = args;
  const skipped = (detail: string): ReferralAskResult => ({ sent: false, detail, id: "", skipped: true });
  const { data: company } = await admin.from("companies").select("name, phone, email, settings").eq("id", args.companyId).maybeSingle();
  if (!company) throw new Error("Company not found.");
  const settings = (company.settings ?? {}) as Record<string, unknown>;

  // Uninstalled, Marketing sends clients nothing. Links already sent still work, and credits still earn.
  if (!marketingOn(settings)) {
    if (automatic) return skipped("Marketing is off");
    throw new ReferralAskRefused("Marketing is off, so referral asks can't be sent. An owner or admin can install it again in Apps.", true);
  }
  if (!referralsReady(settings)) {
    if (automatic) return skipped("Referrals aren't set up: there's no credit or offer");
    throw new ReferralAskRefused("Add a credit or an offer in Marketing → Referrals first, so there's something to tell them.");
  }
  const refusal = referralAskRefusal(client);
  if (refusal) {
    const name = client.display_name;
    if (automatic) return skipped(client.marketing_opt_out ? `${name} unsubscribed from marketing` : client.status === "archived" ? `${name} is archived` : `${name} has no email address`);
    throw new ReferralAskRefused(refusal);
  }
  // The business's to fix, so an automatic ask fails rather than skips.
  if (!(await emailReady(env, args.companyId))) throw new Error(REFERRAL_EMAIL_NOT_CONNECTED);
  const now = Date.now();
  if (args.skipIfRecentDays) {
    const { data: last, error } = await admin.rpc("last_referral_ask", { p_company: args.companyId, p_client: client.id });
    if (error) throw new Error(error.message);
    if (last && Date.parse(last) > now - args.skipIfRecentDays * 86_400_000) return skipped(recentlyAsked(args.skipIfRecentDays));
  }
  if (automatic) {
    // A review reminder still to come goes first: the referral ask follows the day after it.
    const { data: reminders, error } = await admin
      .from("review_requests")
      .select("next_reminder_at")
      .eq("company_id", args.companyId)
      .eq("client_id", client.id)
      .gt("next_reminder_at", new Date(now).toISOString())
      .order("next_reminder_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const next = reminders?.[0]?.next_reminder_at;
    if (next) throw new WaitUntil(new Date(Date.parse(next) + 86_400_000), "Waits for their review reminders to go out first");
  }
  if (!args.baseUrl) throw new Error("APP_URL isn't set, so a referral link can't be built.");

  // Recorded first, by the database, which also holds to the gap: two workers asking one client at
  // the same moment ask once.
  const { data: id, error } = await admin.rpc("begin_referral_ask", {
    p_company: args.companyId,
    p_client: client.id,
    p_automatic: automatic,
    p_gap_days: args.skipIfRecentDays ?? undefined,
    p_created_by: args.createdBy ?? undefined,
  });
  if (error) throw new Error(error.message);
  if (!id) return skipped(recentlyAsked(args.skipIfRecentDays ?? REFERRAL_GAP_DAYS));

  const link = await clientLink(env, args.baseUrl, { c: args.companyId, t: "refer", id: client.id });
  const text = renderTemplate(referralSettings(settings).message, {
    client: { first_name: firstName(client.display_name), name: client.display_name },
    company: { name: company.name, phone: company.phone ?? "" },
    link,
    rewards: referralRewards(settings),
  }).replace(/\n{3,}/g, "\n\n").trim();
  const result = await emailClient(env, { companyId: args.companyId, company, client, subject: `Know someone who could use ${company.name}?`, text, baseUrl: args.baseUrl });
  if (!result.sent) {
    const reason = result.reason ?? "The email wasn't sent.";
    await admin.from("referral_asks").update({ status: "failed", error: reason.slice(0, 500) }).eq("id", id);
    throw new Error(reason);
  }
  await admin.from("messages").insert({
    company_id: args.companyId, client_id: client.id, channel: "email", direction: "out", subject: "Referral ask", body: text,
    related_type: "referral_ask", related_id: id, external_id: result.id ?? null, sent_by: args.createdBy,
  });
  return { sent: true, detail: "Asked for referrals by email", id };
}
