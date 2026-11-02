/**
 * Delivers notifications beyond the bell: email, text and phone push, by each person's choices
 * (Settings → Profile → Notifications). Runs every minute; each notification is claimed once, about
 * a minute after it's made so quick changes have folded together, and skipped if already read.
 * One email and one text per person per run, however many notifications there are. A sub on a
 * sign-in Crewtavo made for them is reached at the phone and email the office keeps on their record
 * (public.sub_notice_contacts), so the office's corrections reach them; a phone they put on their own
 * profile comes first for texts. Google reviews of 3 stars or more go by push only (byEmail), and 1 and
 * 2 stars come first.
 */
import { byEmail, DEFAULT_NOTIFICATION_PREFS, isPlaceholderEmail, notificationTopic, type NotificationChannel, type NotificationTopic } from "@crewtavo/core";
import type { Env } from "../env";
import { renderEmail } from "../lib/email";
import { sendEmail, sendSms, smsConfigured } from "../lib/notify";
import { reportError } from "../lib/monitoring";
import { adminClient } from "../lib/supabase";
import { sendPush } from "../lib/webpush";

interface Row {
  id: string;
  company_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
}

export async function deliverNotifications(env: Env, options: { minAgeSeconds?: number } = {}) {
  const admin = adminClient(env);
  const { data, error } = await admin.rpc("claim_notifications", { p_min_age_seconds: options.minAgeSeconds ?? 45, p_limit: 300 });
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Row[]).filter((r) => !r.read_at);
  const counts = { claimed: data?.length ?? 0, email: 0, sms: 0, push: 0, failed: 0 };
  if (!rows.length) return counts;

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const companyIds = [...new Set(rows.map((r) => r.company_id))];
  const [prefs, profiles, companies, devices, subContacts] = await Promise.all([
    admin.from("notification_prefs").select("company_id, user_id, email, sms, push").in("user_id", userIds),
    admin.from("profiles").select("user_id, email, phone, full_name").in("user_id", userIds),
    admin.from("companies").select("id, name, email").in("id", companyIds),
    admin.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", userIds),
    // A sub's sign-in made by Crewtavo: the phone and email the office keeps for them, as they are now.
    admin.rpc("sub_notice_contacts", { p_users: userIds }),
  ]);
  if (subContacts.error) reportError(new Error(subContacts.error.message), { task: "notify", step: "sub_notice_contacts" });
  const prefsFor = (companyId: string, userId: string): Record<NotificationChannel, string[]> =>
    prefs.data?.find((p) => p.company_id === companyId && p.user_id === userId) ?? DEFAULT_NOTIFICATION_PREFS;
  const base = (env.APP_URL ?? "").replace(/\/$/, "");
  const url = (link: string | null) => (base && link ? `${base}${link}` : base || null);
  // Where several at once lead: a sub's job offers and pay to My jobs, Google reviews to Marketing →
  // Reviews, anything else home.
  const batchLink = (items: Row[]) => (items.every((i) => i.kind === "jobs") ? "/field/jobs" : items.every((i) => notificationTopic(i.kind) === "reviews") ? "/marketing?tab=reviews" : items.every((i) => notificationTopic(i.kind) === "social") ? "/marketing?tab=social" : "/");
  // Low ratings first: those are the reviews to answer before the rest. Otherwise as they came.
  const lowFirst = (items: Row[]) => [...items].sort((a, b) => Number(b.kind === "review_low") - Number(a.kind === "review_low"));

  // Each notice is one paragraph of the email, its title, words and link on their own lines: line
  // breaks typed into a notice (a sub's reason for turning down a job) are run together, so nothing
  // but the app's own link can stand alone as a paragraph and show as a button (lib/email.ts).
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(`${r.company_id}:${r.user_id}`, [...(groups.get(`${r.company_id}:${r.user_id}`) ?? []), r]);

  for (const items of groups.values()) {
    const { company_id: companyId, user_id: userId } = items[0]!;
    const company = companies.data?.find((c) => c.id === companyId);
    const person = profiles.data?.find((p) => p.user_id === userId);
    if (!company || !person) continue;
    // A sub's own sign-in: email to the address on the office's record (its own is a stand-in), and
    // texts to the phone they put on their profile, else the record's. Everyone else: their account's.
    const sub = (subContacts.data ?? []).find((c) => c.company_id === companyId && c.user_id === userId);
    const emailTo = sub ? sub.email : person.email;
    const phoneTo = person.phone || sub?.phone || null;
    const chosen = prefsFor(companyId, userId);
    const pick = (channel: NotificationChannel) =>
      lowFirst(items.filter((i) => chosen[channel].includes(notificationTopic(i.kind) as NotificationTopic) && (channel !== "email" || byEmail(i.kind))));

    try {
      const forEmail = pick("email");
      // Never to a sub's stand-in address.
      if (forEmail.length && emailTo && !isPlaceholderEmail(emailTo)) {
        const text = [
          forEmail.length === 1 ? "" : `${forEmail.length} updates from ${company.name}:`,
          ...forEmail.map((i) => [oneLine(i.title), i.body && i.body !== i.title ? oneLine(i.body) : null, url(i.link)].filter(Boolean).join("\n")),
          `You get these because of your notification settings. Change them in Crewtavo under Settings → Profile${base ? `: ${base}/settings?tab=profile` : "."}`,
        ].filter(Boolean).join("\n\n");
        const result = await sendEmail(
          env,
          { to: emailTo, subject: forEmail.length === 1 ? forEmail[0]!.title : `${forEmail.length} updates from ${company.name}`, ...renderEmail({ companyName: company.name, text }), replyTo: company.email ?? undefined, fromName: company.name },
          companyId,
        );
        if (result.sent) counts.email++;
        else counts.failed++;
      }

      const forSms = pick("sms");
      if (forSms.length && phoneTo && smsConfigured(env)) {
        const first = forSms[0]!;
        const more = forSms.length > 1 ? ` (+${forSms.length - 1} more)` : "";
        const link = url(forSms.length > 1 ? batchLink(forSms) : first.link);
        const result = await sendSms(env, { to: phoneTo, body: `${company.name}: ${first.title}${more}${link ? ` ${link}` : ""}` });
        if (result.sent) counts.sms++;
        else counts.failed++;
      }

      const forPush = pick("push");
      const phones = (devices.data ?? []).filter((d) => d.user_id === userId);
      if (forPush.length && phones.length) {
        const contact = base.startsWith("https://") ? base : `mailto:${company.email || "notifications@crewtavo.invalid"}`;
        // Up to three separately; more than that, one summary.
        const messages = forPush.length <= 3
          ? forPush.map((i) => ({ title: i.title, body: i.body && i.body !== i.title ? i.body : company.name, link: i.link ?? "/", tag: i.id }))
          : [{ title: `${forPush.length} updates from ${company.name}`, body: forPush.map((i) => i.title).slice(0, 4).join("\n"), link: batchLink(forPush), tag: `batch-${companyId}` }];
        for (const device of phones) {
          for (const message of messages) {
            const sent = await sendPush(env, device, message, contact);
            if (sent.gone) {
              await admin.from("push_subscriptions").delete().eq("id", device.id);
              break;
            }
            if (sent.ok) counts.push++;
            else counts.failed++;
          }
        }
        await admin.from("push_subscriptions").update({ last_sent_at: new Date().toISOString() }).eq("user_id", userId);
      }
    } catch (err) {
      counts.failed++;
      reportError(err, { task: "notify" });
    }
  }
  return counts;
}
