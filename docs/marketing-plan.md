# Marketing as an app: plan

Proposed 30 October 2026. Phase A, the app and review reminders, is built
(`supabase/migrations/20261030000200_marketing_app.sql` to `20261030000600_review_ask_followups.sql`,
`packages/core/src/marketing.ts`, `apps/api/src/services/reviews.ts`, Marketing → Reviews). Phase B,
referral credits and asks, is built (`20261031000100_referral_credits.sql`,
`20261031000110_referral_lost.sql`, `20261031000120_referral_asks.sql`, `apps/api/src/services/referrals.ts`,
Marketing → Referrals, the invoice page's credit rows). Phases C to E aren't. This is the plan.

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

**Referrals stopped at "won"** before phase B. The referral page made a lead, a request and a
`referrals` row, which moved to quoted and won with the friend's quote
(`supabase/migrations/20261017000300_marketing.sql:165-180`). Nothing set lost, the reward was
marked given by hand, and nothing asked a client for a referral.

**Invoices already take a discount** (`invoices.discount_amount`), but it holds a promo code's
discount or the office's typed one, so a referral credit has a column of its own beside it
(`invoices.credit_amount`, below).

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

### 2. Referral credits and asks (phase B, built)

- **The reward is a credit,** set on the Referrals tab: a fixed amount (up to $10,000), or a
  percentage (1 to 100) of the friend's first job, after discounts and before tax.
  - **Its terms are fixed when the friend arrives** (`referrals.reward_kind`, `reward_value`), so a
    changed setting doesn't change what was promised: "Friends already referred keep the credit they
    were offered."
- **It's earned when the friend pays their first invoice in full,** not when a quote is approved.
  - The first paid invoice that charged something: a standard or visits invoice whose charges
    after discounts are above $0. A deposit or progress invoice doesn't count, since the work isn't
    done yet, and a percent of a job's final invoice counts the deposits and progress billing it
    takes off, so it's the whole job. A $0 invoice doesn't count either: the next one is the first.
  - `reward_amount` is fixed then: the amount, or the percent rounded to cents.
  - `reward_status`: pending (the friend hasn't paid) → earned → applied, plus issued ("Given",
    outside Crewtavo) and none, with `no_reward_reason`: not set, self, already a client, lost or
    by hand.
  - **No credit** for a friend who is the referrer, or was already a client. Both are decided by
    email and phone (its last 10 digits, as texts are matched) when the friend arrives: the
    referrer's own, or another client's who has had a job or a non-void invoice. When they pay,
    the referrer match is checked again, and a friend with a job from before, or an invoice dated
    before the referral (a Stripe history import), was already a client. The office can overrule
    a wrong match with **Give a credit anyway**, and then the friend's first paid invoice from the
    day they were referred earns it.
  - **No duplicate lead** when the friend is that client: the same email, or the same phone and
    name. Their request goes on that client, at an address of theirs that matches or a new one. A
    phone alone may be someone else at home, and an archived client stays archived, so those are a
    new lead as before.
  - An activity, `referral.earned`, on the referrer: the office sees it in the feed (only the
    office with Marketing or Invoices, since it carries the credit) and Automations can send a
    thank-you, with `{{referral.name}}`, `{{referral.credit}}` and `{{referral.invoice}}`. It says
    how much went on which invoice and what's still to go ("$10.00 went on invoice #3, and $15.00
    goes on their next one"); its data names the referrer's invoice (`invoice_id`,
    `invoice_number`) apart from the one the friend paid (`friend_invoice_id`).
  - **Not paid after all:** a payment removed, refunded or a dispute lost takes the credit back. It
    comes off the referrer's invoices that can still change and is pending again, so the friend's
    next paid invoice earns it. Another paid invoice of the friend's keeps it earned. Part of it
    used already (on a paid invoice, or given outside Crewtavo) stays where it is, the rest is kept
    off invoices for the office to decide, and the office hears either way (`referral.unpaid`).
- **Applied to the referrer's next invoice by itself** (`referral_credits`, one row for each invoice
  a credit is on, with its note, "Referral credit: thanks for referring Maria"):
  - **Where:** the referrer's open draft first, then their oldest invoice awaiting payment or past
    due. It has to have no payments, not be made in Stripe or have a bank payment on its way, not
    be a deposit or retainage release, and not be in QuickBooks or Zoho Books already (or on its
    way there): those keep the total they were sent, so the credit waits for the next invoice. A
    draft gets it as its lines go in, so it's on before the invoice is sent.
  - **When:** the moment it's earned, and whenever one of the referrer's invoices is made or changed
    (at commit, so a new invoice has all its lines first).
  - **Never more than the invoice:** up to what's left of its charges after discounts. Tax is still
    owed, so the total is never negative. What doesn't fit stays earned for the next invoice, so a
    credit can be split over two.
  - **If the room shrinks** before it's paid (a promo added, a discount typed), the newest credit
    is cut back and the rest goes on the next open invoice.
  - **Given back** when its invoice is voided, deleted or moved to another client before it's paid,
    and it goes on the next open invoice. Once the invoice is paid, the credit stays. A void invoice
    keeps the figures it was sent with: its page and paper still show the credit, as **Referral
    credit**.
  - **On the invoice:** a credit row after the discount on the invoice page, the paper, the Client
    Hub and Stripe's line items. Payments and the Hub's pay button read the balance, which already
    has it. QuickBooks and Zoho get it with the discount.
  - **Two at once:** every path takes the referrer's lock first, then the referral, then invoices
    nobody else is changing (one being changed gets the credit when its change commits), and the
    database re-checks the sums on every write. A problem placing a credit never fails a payment or
    an invoice save: the credit stays earned.
- **By hand:**
  - **Apply to an invoice…** a chosen open invoice of the referrer, one already in QuickBooks too
    (the page says to change it there).
  - **Remove** it from an unpaid invoice: it's earned again and goes on their next invoice, never
    back on that one by itself.
  - **Keep off invoices** and **Apply automatically again**.
  - **Mark given** for a credit given outside Crewtavo (what isn't on invoices, or a set amount
    before the friend pays), and **No credit for this one**. What was given is recorded
    (`given_amount`): a part on an invoice that comes off later is earned again, not counted as given.
- **Asking:** **Ask for referrals** emails a client their link, from the Referrals tab or the client's
  page, and a new starter rule, `referral_after_job`, asks a week after a job is completed (after the
  review ask and its reminders; off by default, not after recurring work). Jobber sends no
  reminders here, and neither do we.
  - **Email only.** The message is `settings.referrals.message`, with `{{link}}` and `{{rewards}}`
    (what the friend gets, then what the client gets, each on its own line). The offer is written
    to the friend ("10% off your first service"), so the email and the Client Hub quote it: "For
    your friends: “10% off your first service”".
  - **Ask automatically** turns on only while Marketing is installed, there's a credit or an offer,
    and email is connected. It always turns off.
  - **At most once per client every 6 months** (`referral_asks`). Every ask that went counts, by hand
    too, as review asks do. Asking by hand isn't held to it but says when they were last asked.
    Copying the link records nothing.
  - **Not asked:** clients who opted out of marketing, archived clients, clients with no email, or
    while Referrals has no credit and no offer. An automatic ask waits while the client's review
    reminders are still going out.
  - Recurring clients aren't asked automatically; the tab says to ask them by hand. A rule on the
    recurring-visit trigger, as `review_recurring` does for reviews, is a follow-up.
- **Lost:** the friend's request archived, or their quote marked lost with no other open quote, job
  or invoice, marks the referral lost, and a credit still to come with it. Earned credits stay. A
  friend who has paid for work or had a job completed isn't lost. It comes back when the work does:
  a quote sent or approved, the request restored, or an invoice paid. Any paid invoice wins the
  referral, a deposit too, whatever its credit; the credit still waits for the first invoice that
  isn't a deposit or progress billing.
- **The Referrals tab shows the numbers** (`referral_stats`, which Metrics' Clients tab uses too):
  - what referred clients have paid before tax, as a percent credit counts it (needs the Invoices
    area), and credits earned, applied and given, all to the cent
  - how many friends haven't paid yet
  - top referrers, by jobs won and then revenue
  - a friend who was the referrer or already a client isn't a lead, a job won or revenue, there or
    in Marketing's overview
  - every referral, newest first, a page at a time, with the friend's progress (**New lead**,
    **Quoted**, **Won**, **Lost**) until there's a credit, then the credit's (**Earned**, **Applied**,
    **Given**), and where it went
- **The Client Hub** tells a client the credit that goes on their next invoice, not one the office
  keeps off invoices.
- **Marketing uninstalled:** no referral asks and no "refer a friend" in the Client Hub, but links
  already shared keep working, referrals still earn, and earned credits still go on invoices: the
  business promised them.

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
  reminders: [{ days }], channel }`. `companies.settings.referrals`: `{ reward: { kind: "amount" | "percent", value }, offer, message }`,
  in place of `settings.referral_reward` and `settings.referral_offer` (moved by the migration).
- `review_requests`: `reminders_sent`, `next_reminder_at`, `reminders_failed`, `reminder_error` (why the
  last reminder failed) and `reminder_note` (why reminders stopped).
- `clients`: `review_opt_out boolean`, `sms_opt_out_at timestamptz`.
- `referrals`: `reward_status` (pending, earned, applied, issued, none), `reward_kind`, `reward_value`,
  `earned_at`, `earned_invoice_id` (the friend's paid invoice), `applied_at`, `given_amount`, `auto_apply`,
  `credit_anyway`, `no_reward_reason`, `lost_at`. Changed only through the database's functions.
- `referral_credits` (referral, invoice, amount, note) in place of a `reward_invoice_id`, since a credit
  can be split over invoices, and `referral_credit_skips` (invoices someone took a credit off).
  `invoices.credit_amount` is what an invoice takes of its credits, worked out with its totals.
- `referral_asks`: each ask for referrals, automatic or not, sent or failed.
- `campaigns`: `kind` (one_off, automated), opens and clicks per recipient on
  `campaign_recipients` (`opened_at`, `clicked_at`), and a `campaign_bookings` table for the
  revenue.
- Automations:
  - a trigger `client.inactive`, checked daily
  - an action `request_referral`, and a trigger `referral.earned`
  - the recurring-visit count read from settings
  - twelve starter rules, with `referral_after_job`
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

## Release notes for phase B

- **Referral credits are earned when the friend pays.** Set a **$ amount** or a **% of their first job**
  in **Marketing → Referrals**. The credit goes on the client's next invoice by itself once their
  friend pays their first invoice, with a line saying what it's for. Rewards marked given before
  stay given, and ones waiting on a friend who has already paid are earned now and go on the
  client's open invoice. A friend's payment removed or refunded takes the credit back.
- **Ask for referrals** emails a client their own link, from **Marketing → Referrals** or the client's
  page. Turn on **Ask automatically** to ask a week after each job, at most once every 6 months.
- **Credits on invoices** show after the discount, on the invoice, its paper, the Client Hub and
  Stripe. **Apply referral credit** and **Remove** are on the invoice page, and a referral's menu can
  apply it to an invoice you choose, keep it off invoices, mark it given or say no credit.
- **No credit** for a client who refers themselves or a friend who was already a client, with
  **Give a credit anyway** when that's wrong.
- **Lost referrals:** a friend's request archived, or their last quote lost, marks the referral lost
  until the work comes back.
- **The numbers:** what referred clients paid, credits earned, applied and given, and top referrers,
  on the Referrals tab, with **Referrals** on **Metrics → Clients**.
- **Uninstalling Marketing** stops referral asks too. Credits clients have earned still go on their
  invoices.

## Decisions on the open questions (30 October 2026)

The build went ahead on the plan's leans:

1. **New businesses start with Marketing installed,** as everyone has it today.
2. **Opting out of marketing also stops review asks,** as well as campaigns.
3. **A referral credit is applied to the referrer's next invoice by itself.** The office can still
   apply it by hand or mark it given. Phase B's rules for where and when are under decision 2.
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
