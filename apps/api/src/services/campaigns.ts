/**
 * Sends email campaigns in small batches (every minute by cron, and right after Send). Each email
 * is personalized, carries a one-click unsubscribe link and the company's address, and every
 * recipient's outcome is recorded. Nothing goes while the company has Marketing uninstalled:
 * uninstalling puts its scheduled campaigns back to drafts and stops ones sending
 * (public.marketing_set_enabled), so installing it again sends nothing late.
 *
 * Each email's links go through the recipient's own tracked links, and it carries their tracking
 * image (services/automatedCampaigns.ts trackedLinks), so the campaign's opens, clicks and the work
 * it brought in can be counted. {{link}} is the client's Client Hub home, where they can ask for work
 * (a link that lasts a year, and a "Request work" button on a line of its own).
 */
import { renderTemplate } from "@crewtavo/core";
import { HUB_HOME_BUTTON, trackableLinks } from "@crewtavo/core/campaigns";
import type { Env } from "../env";
import { firstName, renderEmail } from "../lib/email";
import { clientLink } from "../lib/links";
import { emailReady, sendEmail } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { CAMPAIGN_LINK_DAYS, trackedLinks } from "./automatedCampaigns";
import { companyAddress } from "./automations";
import { logoImage } from "./logo";

const BATCH = 25;
const SPACING_MS = 550; // stays under typical provider rate limits (about 2 per second)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshCounts(admin: Db, campaignId: string) {
  const count = async (...statuses: string[]) =>
    (await admin.from("campaign_recipients").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).in("status", statuses)).count ?? 0;
  // Recipients another run has claimed ('sending') aren't done yet either.
  const [sent, failed, unsent] = await Promise.all([count("sent"), count("failed"), count("pending", "sending")]);
  return { sent, failed, unsent };
}

/** How often, in emails, a batch writes its campaign's counts while it sends, so the page's header and progress move. */
const COUNTS_EVERY = 5;

/**
 * Writes a campaign's sent and failed counts from its recipients, whatever its status: a campaign
 * stopped partway keeps the counts of what went (the cancel route calls this too). Says the counts.
 */
export async function writeCampaignCounts(admin: Db, campaignId: string) {
  const counts = await refreshCounts(admin, campaignId);
  await admin.from("campaigns").update({ sent_count: counts.sent, failed_count: counts.failed }).eq("id", campaignId);
  return counts;
}

// These change only recipients this run still holds (its claim's token): one another run has
// claimed since is that run's to email and record.

/** Put claimed recipients back for the next run (rate limited, or the run stopped before them). */
async function release(admin: Db, token: string, ids: number[]) {
  if (ids.length) await admin.rpc("release_campaign_recipients", { p_token: token, p_ids: ids });
}

async function record(admin: Db, token: string, ids: number[], status: "sent" | "failed" | "skipped", reason?: string) {
  if (ids.length) await admin.rpc("finish_campaign_recipients", { p_token: token, p_ids: ids, p_status: status, p_error: reason });
}

export async function processCampaigns(env: Env, options: { campaignId?: string; baseUrl?: string | null } = {}) {
  const admin = adminClient(env);
  const baseUrl = options.baseUrl ?? env.APP_URL ?? null;
  const now = new Date().toISOString();

  // Scheduled campaigns whose time has come start sending, for companies with Marketing installed.
  let due = admin.from("campaigns").select("id, company:companies!inner(id)").eq("status", "scheduled").lte("scheduled_at", now).eq("company.settings->marketing->>enabled", "true").limit(100);
  if (options.campaignId) due = due.eq("id", options.campaignId);
  const { data: starting, error: dueError } = await due;
  if (dueError) throw new Error(dueError.message);
  if (starting?.length) {
    await admin.from("campaigns").update({ status: "sending", started_at: now }).in("id", starting.map((c) => c.id)).eq("status", "scheduled");
  }

  // Filtered in the query, so companies with Marketing uninstalled don't fill the batch.
  let query = admin
    .from("campaigns")
    .select("id, company_id, subject, body, company:companies!inner(name, email, phone, address, settings)")
    .eq("status", "sending")
    .eq("company.settings->marketing->>enabled", "true")
    .limit(5);
  if (options.campaignId) query = query.eq("id", options.campaignId);
  const { data: campaigns, error } = await query;
  if (error) throw new Error(error.message);

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let lost = 0;
  for (const campaign of campaigns ?? []) {
    const company = campaign.company as unknown as { name: string; email: string | null; phone: string | null; address: Record<string, string>; settings: unknown };
    // Runs overlap (Send, the every-minute task, other servers), so each claims its batch: a
    // recipient one run has claimed isn't emailed by another.
    const { data: recipients, error: claimError } = await admin.rpc("claim_campaign_recipients", { p_campaign: campaign.id, p_limit: BATCH });
    if (claimError) throw new Error(claimError.message);
    const claimed = recipients ?? [];
    const token = claimed[0]?.claim_token ?? "";
    const rest = (index: number) => claimed.slice(index).map((r) => r.id);

    let next = 0; // the first recipient this run hasn't started on
    try {
      const canSend = await emailReady(env, campaign.company_id);
      for (const [index, r] of claimed.entries()) {
        next = index;
        if (!canSend || !baseUrl) {
          await record(admin, token, [r.id], "failed", !baseUrl ? "APP_URL isn't set." : "Email isn't set up.");
          failed++;
          continue;
        }
        if (index) await sleep(SPACING_MS);
        // Checked right before each email: Stop stops the rest, and people who unsubscribed after
        // the audience was taken aren't emailed.
        const [live, client] = await Promise.all([
          admin.from("campaigns").select("status").eq("id", campaign.id).maybeSingle(),
          r.client_id ? admin.from("clients").select("marketing_opt_out").eq("id", r.client_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
        ]);
        if (live.error || client.error) {
          await release(admin, token, rest(index));
          break;
        }
        if (live.data?.status !== "sending") {
          await record(admin, token, rest(index), "skipped", "Campaign stopped");
          skipped += claimed.length - index;
          break;
        }
        if (!r.client_id || !client.data || client.data.marketing_opt_out) {
          await record(admin, token, [r.id], "skipped", client.data ? "Unsubscribed" : "Client was deleted");
          skipped++;
          continue;
        }
        const vars = {
          client: { first_name: firstName(r.name), name: r.name ?? "" },
          company: { name: company.name, phone: company.phone ?? "" },
          link: await clientLink(env, baseUrl, { c: campaign.company_id, t: "client", id: r.client_id }, CAMPAIGN_LINK_DAYS),
        };
        const unsubscribe = await clientLink(env, baseUrl, { c: campaign.company_id, t: "unsub", id: r.client_id });
        const text = renderTemplate(campaign.body, vars);
        const links = trackableLinks(text);
        const email = renderEmail({
          companyName: company.name,
          logo: logoImage(baseUrl, campaign.company_id, company.settings),
          text,
          footer: [company.name, companyAddress(company.address)].filter(Boolean).join(" · "),
          unsubscribeUrl: unsubscribe,
          ...trackedLinks(baseUrl, r.track_token, links),
          buttons: { [vars.link]: HUB_HOME_BUTTON },
        });
        // The claim is renewed right before each email, with the links it carries (its tracked links
        // go only to these). A slow mail server can take minutes per message, so a batch can outlast
        // its claim; by now another run may have claimed this recipient, and then it's theirs to email.
        const { data: held, error: renewError } = await admin.rpc("renew_campaign_recipient", { p_id: r.id, p_token: token, p_links: links });
        if (renewError) {
          await release(admin, token, rest(index));
          break;
        }
        if (!held) {
          lost++;
          continue;
        }
        next = index + 1; // whatever happens to this email now, it isn't put back to go again
        const result = await sendEmail(env, {
          to: r.email,
          subject: renderTemplate(campaign.subject, vars),
          ...email,
          replyTo: company.email ?? undefined,
          fromName: company.name,
          // One-click unsubscribe (RFC 8058): mail apps POST to the API endpoint directly.
          headers: { "List-Unsubscribe": `<${unsubscribe.replace("/u/", "/api/public/unsubscribe/")}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        }, campaign.company_id);
        if (!result.sent && result.status === 429) {
          await release(admin, token, rest(index)); // rate limited: the rest go next run
          break;
        }
        await record(admin, token, [r.id], result.sent ? "sent" : "failed", result.sent ? undefined : (result.reason ?? "Not sent"));
        if (result.sent) sent++;
        else failed++;
        if ((index + 1) % COUNTS_EVERY === 0 && index + 1 < claimed.length) await writeCampaignCounts(admin, campaign.id);
      }
      next = claimed.length;
    } finally {
      // An error stopped the batch partway: the recipients it didn't get to go back now, not once
      // the claim runs out. (One whose email had started stays claimed: it may have gone.)
      await release(admin, token, rest(next));
    }

    // The counts whatever its status (stopped meanwhile, it keeps what went); only one still sending is finished.
    const counts = await writeCampaignCounts(admin, campaign.id);
    if (counts.unsent === 0) {
      await admin.from("campaigns").update({ status: "sent", finished_at: new Date().toISOString() }).eq("id", campaign.id).eq("status", "sending");
    }
  }
  return { campaigns: campaigns?.length ?? 0, sent, failed, skipped, lost };
}
