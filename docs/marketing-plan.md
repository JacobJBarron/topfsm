# Marketing as an app: plan

Proposed 30 October 2026. Phase A, the app and review reminders, is built
(`supabase/migrations/20261030000200_marketing_app.sql` to `20261030000600_review_ask_followups.sql`,
`packages/core/src/marketing.ts`, `apps/api/src/services/reviews.ts`, Marketing → Reviews). Phases B to E
aren't. This is the plan.

The goal: Crewtavo's own version of Jobber's Marketing Suite (Reviews, Referrals, Campaigns and
social posting), following how Jobber does each one, shipped as one built-in app in Apps that owns
the Marketing tab. It replaces an earlier, NiceJob-shaped draft of this plan.

---

## The short version

- **Marketing becomes an app, not a second tab.** **Crewtavo - Marketing** is listed in Apps under
  Built into Crewtavo, like Drive, Team Chat and Careers. Installed, **Marketing** is in the
  sidebar with its tabs. Uninstalled, the tab goes away and every automatic message it sends to
  clients stops; nothing is deleted. Every business keeps it installed when this ships.
- **Review asks work like Jobber's.**
  - **When:** a job is closed, a visit is completed or an invoice is paid in full.
  - **How:** by text, email or both.
  - **Reminders:** up to two, for anyone who hasn't opened the link.
  - **How often:** at most once per client every 6 months.
  - **Recurring work:** waits a number of visits the business chooses.
- **Referrals work like Jobber's.** A link for every client, asked for by email after a job, and a
  $ or % credit on the referrer's next invoice once the friend pays their first.
- **Campaigns work like Jobber's.**
  - **Automated campaigns:** win back past clients, win back lost quotes, close pending quotes.
  - **More ways to pick an audience.**
  - **Results:** opens, clicks and the work each campaign brought in.
- **Two later phases need outside accounts.**
  - **Google reviews in Crewtavo, with AI replies:** Google approves each business on its own.
  - **Posting reviews and job photos to Facebook, Instagram and Google:** each business's own Meta
    app, which Meta doesn't review.
- **Build order:** the app and review reminders first, then referral credits and automated
  campaigns side by side, then Google reviews and social posting.

## Where it lives: Marketing becomes the app

Three ways were weighed:

1. **A new app with a tab of its own** next to Marketing. Reviews and referrals already sit in
   Marketing, so they'd end up split across two places, or moved and the old tab emptied. No.
2. **Just update the Marketing tab.** It works, but nothing in Apps tells a business it's there,
   and there's no one switch that stops every automatic message to clients.
3. **Marketing itself becomes the app (chosen).** Nothing moves, and it gains a page in Apps
   explaining what it does, Jobber's Marketing Suite style. Install and Uninstall work like every
   other built-in app.

How, in the code that's there:

- **Built-in apps already work this way.** A sidebar item with `feature` shows only while
  `companies.settings.<app>.enabled` is on (`apps/web/src/components/shell/nav.ts:15`). The
  Marketing item (`nav.ts:43`) gets `feature: "marketing"`, and the catalog gets a `marketing` entry
  with `auth: "builtin"` (`apps/api/src/integrations/registry.ts`, `apps/web/src/features/apps/catalog.ts`).
- **A migration sets `settings.marketing.enabled = true` for every business**, so nobody loses the
  tab.
- **Uninstalling stops what it sends:**
  - review asks and their reminders
  - referral asks
  - automated campaigns
  - social posts
  - The `request_review` and `request_referral` actions skip with "Marketing is off". Links
    already sent keep working, so a friend with an old referral link still reaches the business.
- **The tabs, modeled on Jobber's Marketing area in Crewtavo's own look:**
  - **Overview:** the numbers that are there today, plus referral revenue and campaign revenue.
  - **Reviews**, **Referrals** and **Campaigns:** below.
  - **Social:** phase E.
  - **Promo codes:** as today.
  - **Website:** visits, from the Website Analytics app, as today.

## What Jobber does, and what we copy

From Jobber's help center, October 2026 (sources at the end). Jobber sells these as the Marketing
Suite, $99 a month or included in its Plus plan.

| Jobber | What it does | Crewtavo today | Plan |
| --- | --- | --- | --- |
| Review requests | After a job closes, a visit is completed or an invoice is paid in full. Text, email or both. Between 9pm and 9am the first ask goes by email only. Up to 2 reminders if the link isn't clicked, by default 3 and 5 days later at 1:30pm. One ask per client every 6 months. Recurring jobs: a chosen number of visits first. Turns itself off for a client who already left a Google review. Google only. | One email or text a day after a job is completed (`review_after_job`), recurring jobs after their third visit (`review_recurring`), at most once a month. No reminders. | **Copy it all** (phase A). The "already reviewed" stop needs phase D. |
| Reviews dashboard | Rating, count, trends, response time. AI-suggested replies with a rewrite button. Alerts for new reviews. Comparison with up to 10 local competitors. | Asks sent and opened, nothing about the reviews themselves | **Copy it, apart from competitors** (phase D, needs Google's approval) |
| Referrals | A link per client in the client hub and in referral emails. A fixed $ or % credit for the referrer once the friend pays their first invoice, applied to the referrer's invoices. Asked for by email, by hand or after a completed job. A dashboard of leads, jobs, revenue and credits (pending, earned, applied). | A link per client in the Client Hub, a referral page that makes a lead and a request, quoted and won tracking, a reward amount marked given by hand | **Copy the credit, the automatic ask and the dashboard** (phase B) |
| Campaigns | Email only. Automated: re-engage past clients, win back lost leads, close pending quotes. One-off: seasonal, upsell, holidays. Segments by tags, city, services, recurring-job status, recurring job ending in 30 days. AI writer. Opens, clicks and revenue. | One-off email campaigns by status, tags and "no visit in N days", AI drafts, unsubscribe. A 3-day quote follow-up rule. | **Copy the automated campaigns, segments and results** (phase C) |
| Social posting | Turns 5★ Google reviews into posts for Facebook, Instagram and Google Business Profile, with AI-drafted captions and scheduling. | Nothing | **Copy it** (phase E) |
| Website reviews | Its free website builder shows Google reviews | Businesses keep their own website | **Not now.** A widget for any website can come later. |
| Job follow-up emails | A rating survey after a job; Jobber suggests turning it off once Reviews is on | Nothing | **Not copied** |

## What the code does today

**Review asks are one message.** `sendReviewRequest` (`apps/api/src/services/reviews.ts:27`)
sends one email or text with a tracked link, the click is recorded on `review_requests`
(`apps/api/src/routes/public.ts:1204-1214`), and the automation action skips anyone asked in the
last 30 days (`apps/api/src/services/automations.ts:414-420`). Two starter rules ask automatically,
both off for new businesses: `review_after_job` and `review_recurring`.

**Opt-outs only cover campaigns.** `clients.marketing_opt_out` stops campaign emails
(`services/campaigns.ts:79-100`) but not review asks. A STOP text is filed as an ordinary message
(`apps/api/src/routes/messages.ts:74-104`).

**Referrals stop at "won".** The referral page makes a lead, a request and a `referrals` row
(`public.ts:1232-1279`), which moves to quoted and won with the friend's quote
(`supabase/migrations/20261017000300_marketing.sql:165-180`). Nothing sets lost, the reward is
marked given by hand, and nothing asks a client for a referral.

**Invoices already take a discount** (`invoices.discount_amount`, used by promo codes), which is
where a referral credit lands.

**Campaigns** are email blasts to `campaign_audience` (status, tags, no visit in N days), sent 25
at a time with one-click unsubscribe (`services/campaigns.ts:39-130`). Opens and clicks aren't
counted.

**Automations can be called off when what they chase is over**, as a sub's offer does
(`private.job_pay_offer_over()`, `20261025004001_sub_offers.sql:885-904`).

## Decisions

### 1. Review asks with reminders (phase A)

- **The Reviews tab gets a plain form for asking automatically**, Jobber style:
  - **Ask when:** a job is closed / a visit is completed / an invoice is paid in full.
  - **Recurring work:** after the [3rd] visit.
  - **Send by:** text / email / both.
  - **Reminders:** none, one or two, [3] and [5] days later.
- **The form edits the starter rules**, so there's one source of truth and the rules still show in
  Automations.
  - Choosing **an invoice is paid in full** points `review_after_job` at `invoice.paid`.
  - The recurring visit count becomes `settings.reviews.recurring_after_visits` (default 3), which
    the event in `20261030000100_recurring_review_asks.sql` reads instead of its fixed 3.
- **Reminders belong to the ask, not to more rules.** `review_requests` gains `reminders_sent` and
  `next_reminder_at`. A task every few minutes sends the reminders that are due.
  - Reminders go at 1:30pm in the company's time zone.
  - They stop once the link is opened, the client opts out, or Marketing is uninstalled.
- **Quiet hours:** an automatic first ask due between 9pm and 9am goes by email only, as Jobber
  does. Asks sent by hand go right away.
- **One automatic ask per client every 6 months,** replacing 30 days. **Ask a client now** isn't
  held to it, but says when they were last asked.
- **A copied link isn't an ask until it's opened.** It may never reach the client, so it doesn't
  start the 6 months, get reminders or count in the overview until then.
- **A per-client switch, "Don't ask for reviews",** on the client, as in Jobber. Clients who opted
  out of marketing aren't asked either. A STOP text sets `clients.sms_opt_out_at`, and texts to
  them stop. Twilio blocks those texts anyway, but Crewtavo then knows and shows it.
- **Google only, like Jobber.** The review link setting stays one Google link.

### 2. Referral credits and asks (phase B)

- **The reward becomes a credit,** set on the Referrals tab: a fixed amount, or a percentage of the
  friend's first invoice.
- **It's earned when the friend pays their first invoice in full,** not when a quote is approved.
  `referrals.reward_status` becomes pending → earned → applied, or none.
- **Applied to the referrer's next invoice** as a discount, with a line saying what it's for. The
  office can also apply it by hand or mark it given, as today.
- **Asking:** **Ask for referrals** sends a client their link by email, by hand or from a new
  starter rule after a job is closed (off by default, once per client every 6 months). Jobber sends
  no reminders here, and neither do we.
- **Lost:** the friend's request archived or quote lost marks the referral lost.
- **The Referrals tab shows the numbers:**
  - leads, jobs and revenue from referrals
  - credits pending, earned and applied
  - top referrers

### 3. Automated campaigns (phase C)

- **Three automated campaigns,** each with an email to edit and a switch:
  - **Re-engage past clients:** no visit in N days, sent to each client on their own date.
  - **Win back lost quotes:** N days after a quote is marked lost.
  - **Close pending quotes:** N days after a quote is sent and not answered. This takes over the
    `quote_followup` starter rule.
- **They're automation rules underneath,** shown as campaigns. Re-engaging needs one new trigger,
  **A client hasn't had a visit in N days**, checked daily. Clients with a visit scheduled or an
  active recurring job are skipped.
- **More audiences:** city, services on past jobs, has an active recurring job, recurring job
  ending within 30 days (`jobs.ends_on`).
- **Results:**
  - **Opens:** a tracking pixel.
  - **Clicks:** tracked links.
  - **Revenue:** work a recipient books within 30 days of opening one of the campaign's links
    (requests, approved quotes, paid invoices).
- **Email only, like Jobber.**

### 4. Google reviews inside Crewtavo (phase D)

- **A Google Business Profile app** brings in the business's reviews.
  - The **Reviews** tab adds the reviews with rating, count and trend, and **Suggest a reply**,
    drafted with the company's Anthropic key the way message rewrite is.
  - New reviews reach the office through a **Reviews** notification topic.
  - A client's review, matched by name, stops their reminders and future asks.
- **This is the one big difference from Jobber.** Jobber has one Google app that's already
  approved. Every Crewtavo instance needs its own approval:
  - The business's Google profile has to be verified for 60+ days.
  - Approval takes about 14 days.
  - Until it's approved, everything in phases A to C still works.
- **No competitor comparison** (Google's Places API charges per lookup).

### 5. Social posting (phase E)

- **Posts to Facebook and Instagram** through the business's own Meta app. Meta doesn't review an
  app whose admins only post to their own Page, and setup takes about ten minutes with a step-by-step
  guide.
- **Posts to Google Business Profile** once phase D's app is connected.
- **What gets posted:**
  - 5★ reviews, once phase D brings them in
  - job photos the crew or office marked **OK to share**
  - a caption drafted with the Anthropic key
  - posts can be scheduled
- **A Share button for X, LinkedIn or anywhere else.** Neither Jobber nor this plan posts to them
  directly.

### Not copied

- **Jobber's competitor comparison:** costs per lookup.
- **Job follow-up rating emails.**
- **A website builder.**
- **NiceJob's extras:** several review sites on one page, a crew leaderboard, NPS surveys and gifts.
  Any of them can come later.

## Data model

- `companies.settings.marketing`: `{ enabled }`. `companies.settings.reviews`: `{ recurring_after_visits,
  reminders: [{ days }], channel }`. `companies.settings.referrals`: `{ reward: { kind: "amount" | "percent", value }, offer }`.
- `review_requests`: `reminders_sent`, `next_reminder_at`, `reminders_failed`, `reminder_error` (why the
  last reminder failed) and `reminder_note` (why reminders stopped).
- `clients`: `review_opt_out boolean`, `sms_opt_out_at timestamptz`.
- `referrals`: `reward_status` (pending, earned, applied, none), `reward_invoice_id`, `earned_at`.
- `campaigns`: `kind` (one_off, automated), opens and clicks per recipient on
  `campaign_recipients` (`opened_at`, `clicked_at`), and a `campaign_bookings` table for the
  revenue.
- Automations:
  - a trigger `client.inactive`, checked daily
  - an action `request_referral`
  - the recurring-visit count read from settings
- Phase D adds `reviews`. Phase E adds `social_posts` and `attachments.shareable`.

## Build order

| Phase | Ships | Needs |
| --- | --- | --- |
| A. The app and review reminders | **Crewtavo - Marketing** in Apps, the sidebar switch, the Reviews form, reminders, quiet hours, 6-month limit, invoice-paid and visit-completed asks, the recurring visit count, per-client opt-out, STOP | The recurring-work fix, committed |
| B. Referral credits | Credits earned and applied, the automatic referral ask, lost, the Referrals numbers | A |
| C. Automated campaigns | The three automated campaigns, the daily inactive-client trigger, new audiences, opens, clicks and revenue | A |
| D. Google reviews | The Google Business Profile app, reviews in Crewtavo, suggested replies, alerts, stopping asks once reviewed | A, and Google's approval |
| E. Social posting | The Facebook & Instagram app, OK to share, posts and scheduling, posting to Google | A (better with D) |

- **B and C can be built at the same time in separate sessions, and so can D and E.**
- **Each phase is one branch,** with database, API and web tests.
- **Apply for Google's API access early** for crm.brrhi.com's Google Cloud project, so phase D isn't
  waiting on it.

## Release notes for phase A

- **Marketing is an app now.** It's listed in Apps as **Crewtavo - Marketing** and installed for every
  business. Uninstalling it hides Marketing and stops review asks, their reminders and campaigns:
  scheduled campaigns go back to drafts.
- **Reminders now follow review asks, automatic and by hand:** two of them, 3 and 5 days later at
  1:30pm, for anyone who hasn't opened the link. Businesses that already ask automatically start
  sending them now. Set them to **None** in **Marketing → Reviews** to turn them off.
- **Automatic asks go to a client at most once every 6 months,** instead of once a month.
- **Clients who texted STOP have texts off,** shown on their page, including STOPs from before.

## Decisions on the open questions (30 October 2026)

The build went ahead on the plan's leans:

1. **New businesses start with Marketing installed,** as everyone has it today.
2. **Opting out of marketing also stops review asks,** as well as campaigns.
3. **A referral credit is applied to the referrer's next invoice by itself.** The office can still
   apply it by hand or mark it given.
4. **Reminders follow Jobber:** 3 and 5 days after the ask, at 1:30pm in the company's time zone.
5. **No Facebook review link.** The review link stays one Google link, as in Jobber.

## Sources

- Jobber Reviews: https://help.getjobber.com/hc/en-us/articles/20621046897559
- Jobber Marketing Suite: https://help.getjobber.com/hc/en-us/articles/20959257809815
- Jobber pricing: https://www.getjobber.com/pricing/
- Jobber Referrals: https://help.getjobber.com/hc/en-us/articles/25316299579799
- Jobber Campaigns: https://help.getjobber.com/hc/en-us/articles/19885016029207
- Jobber Social Posting: https://help.getjobber.com/hc/en-us/articles/41154120458519/
- Jobber Website: https://help.getjobber.com/hc/en-us/articles/25620058162455
- Jobber Job follow-ups: https://help.getjobber.com/hc/en-us/articles/115009739988
- Google Business Profile API prerequisites: https://developers.google.com/my-business/content/prereqs
- Meta access levels: https://developers.facebook.com/docs/graph-api/overview/access-levels
