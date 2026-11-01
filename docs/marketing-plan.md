# Marketing as an app: plan

Proposed 30 October 2026. Phase A, the app and review reminders, is built
(`supabase/migrations/20261030000200_marketing_app.sql` to `20261030000600_review_ask_followups.sql`,
`packages/core/src/marketing.ts`, `apps/api/src/services/reviews.ts`, Marketing → Reviews). Phase B,
referral credits and asks, is built (`20261031000100_referral_credits.sql`,
`20261031000110_referral_lost.sql`, `20261031000120_referral_asks.sql`, `apps/api/src/services/referrals.ts`,
Marketing → Referrals, the invoice page's credit rows). Phase C, automated campaigns, more audiences and
results, is built (`20261031000200_automated_campaigns.sql`, `20261031000210_campaign_audiences.sql`,
`20261031000220_campaign_results.sql`, `20261031000230_automated_campaign_fixes.sql`, `apps/api/src/services/automatedCampaigns.ts`,
`packages/core/src/campaigns.ts`, Marketing → Campaigns). Phase D, Google reviews, is built
(`20261031000300_google_reviews.sql`, `20261031000310_review_notifications.sql`, `20261031000320_review_stats.sql`,
`20261031000330_google_review_fixes.sql`, `20261031000340_review_match_choices.sql`, `packages/core/src/reviews.ts`, `apps/api/src/integrations/googleBusiness.ts`, `apps/api/src/services/googleReviews.ts`,
`apps/api/src/routes/googleReviews.ts`, Apps → Google Business Profile, Marketing → Reviews). Phase E, social posting, is built
(`20261031000400_ok_to_share.sql`, `20261031000410_social_posts.sql`, `20261031000420_automatic_review_posts.sql`,
`20261031000430_social_notifications.sql`, `20261031000440_social_post_fixes.sql`, `20261031000450_social_post_words.sql`, `packages/core/src/social.ts`, `apps/api/src/integrations/meta.ts`,
`apps/api/src/services/social.ts`, `apps/api/src/services/metaConnect.ts`, `apps/api/src/routes/social.ts`,
`apps/api/src/lib/shareImage.ts`, `apps/api/src/lib/reviewCard.ts`, Apps → Facebook & Instagram, Marketing → Social, OK to share on
photos). Follow-ups from checking all five end to end are built too (`20261031000500_review_ask_fixes.sql`,
`20261031000510_credit_covered_invoices.sql`, `20261031000520_campaign_fixes.sql`, `20261031000530_social_review_relink.sql`,
`20261031000540_campaign_stop_counts.sql`), and so are fixes to promo codes on recurring work, website
forms and Stripe (`20261031000600_promo_once_per_job.sql` to `20261031000640_void_draft_not_sent.sql`,
release notes below).
This is the plan.

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
  - **Social:** posts to Facebook, Instagram and Google Business Profile (phase E, between Campaigns and Promo codes).
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
  - **Opens are honest** (`track_review_click`), as campaign links count them: a HEAD request (a mail
    link checker), a link preview (iMessage's `facebookexternalhit … Facebot Twitterbot`, Slack,
    WhatsApp and other bots) and anything in the first 30 seconds after the ask or a reminder went (a
    Safe Links-style scanner, a text's preview) still reach the review page but aren't the client
    opening it, so they don't stop the reminders or count in "% opened the review link".
  - **Fewer reminders are said first.** Saving fewer reminders than now (None, or One after Two)
    with asks waiting on one asks before it saves, naming both buttons (**Turn off** / **Keep them**):
    the reminders it stops aren't sent if they're turned back on. The save says how many stopped
    (`reminders_dropped`).
- **Quiet hours:** an automatic first ask due between 9pm and 9am goes by email only, as Jobber
  does. Asks sent by hand go right away.
- **Short links, and texts say how to stop them.** Each ask has a short random token
  (`review_requests.link_token`, 12 letters and digits), so its link is `/api/public/r/<token>`, about
  50 characters instead of a signed one of about 265; signed links already sent keep working. A text
  ask or reminder ends with "Reply STOP to opt out." unless the business's own words already say STOP
  (in capitals), as carriers' A2P rules expect; emails have one-click unsubscribe instead. The default
  ask fits in two text segments.
- **An ask that half went says so.** Asked by text and email with one of them failing, the toast is a
  warning that names the one that didn't go and why ("Asked for a review by text. The email didn't go:
  …"), on Marketing → Reviews, the client's page and the job's. Twilio refusing a number that texted
  STOP is said as texts off ("Ben Clicker texted STOP, so texts to them are off."), not in Twilio's
  words, and an address Resend calls invalid is "That email address isn't valid".
- **The office sees a client's tracked links as a label.** On a client's timeline and in Messages, a
  review link, a campaign's tracked link or an unsubscribe link shows as **Review link** (and so on),
  not the live link: the message is kept as sent, but opening the link there would count as the
  client opening it. **Ask a client now** with **Copy link** picked says **Copy review link**.
- **One automatic ask per client every 6 months,** replacing 30 days. **Ask a client now** isn't
  held to it, but says when they were last asked.
- **A copied link isn't an ask until it's opened.** It may never reach the client, so it doesn't
  start the 6 months, get reminders or count in the overview until then. Once opened, it's an ask
  from the open, not the copy (`private.review_asked_at`): the 6 months, the overview's 30 days, the
  Reviews tab's 12 months and the Google review match's 180 days all count from then.
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
  - **A credit that covers an invoice whole** leaves it at $0.00 with nothing paid: it's paid (the
    work is done and settled, so invoice.paid still fires and a review ask on it still goes), but
    said as a credit. Its activity reads "Invoice #3 for Rita Referrer covered by a referral credit"
    (with `covered_by_credit` and `amount_paid` in its data), the invoice page says "Covered by a
    referral credit", and the **Tell the office when an invoice is paid** starter rule asks for
    something paid (a new **Amount paid** condition on invoices, at least $0.01), so nobody hears
    "Rita Referrer paid $0.00". Rules still in the starter's shape were given it.
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
  - **Email only.** The client's own link on a line of its own is a button named for them, **Your
    referral link** (not the friend's page's **Request a quote**), with the link written out under it
    to copy and pass on. The message is `settings.referrals.message`, with `{{link}}` and `{{rewards}}`
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
    **Given**), and where it went; a friend who was the referrer or already a client says **No credit**
  - **Credits earned** is what isn't on an invoice yet, and says so ("Not on an invoice yet", as
    Marketing's overview does), with the friends still to pay on a line of their own
- **The Client Hub** tells a client the credit that goes on their next invoice, not one the office
  keeps off invoices.
- **Marketing uninstalled:** no referral asks and no "refer a friend" in the Client Hub, but links
  already shared keep working, referrals still earn, and earned credits still go on invoices: the
  business promised them.

### 3. Automated campaigns (phase C, built)

- **Three automated campaigns** on **Marketing → Campaigns**, above the one-off campaigns, each a small
  card with its switch (saved at once), when it goes, what it brought in and **Edit email** (the days,
  the subject and message, a preview and **Send a test**, saved without touching the switch):
  - **Re-engage past clients:** no visit in N days, sent to each client on their own date.
  - **Win back lost quotes:** N days after a quote is marked lost.
  - **Close pending quotes:** N days after a quote is sent and not answered. This takes over the
    `quote_followup` starter rule.
- **They're automation rules underneath,** shown as campaigns, so they still show in Automations.
  Each has its own template key (`reengage_past_clients`, `win_back_lost_quotes`, `quote_followup`).
  A card edits its rule the way Reviews' form does: a rule changed in Automations into something the
  card can't show keeps its shape, the card links to it, and only the switch works. The two new
  rules are off for every business until it turns them on; a deleted one is put back on turning it
  on. The rule page says which campaign a rule is.
- **Re-engage past clients** is a new trigger, **A client hasn't had a visit in a while**
  (`client.inactive`):
  - **N is the rule's own condition,** "days since their last visit is at least N" (from 30 to 730,
    chosen as 1, 2, 3, 6, 9 or 12 months, 18 months or 2 years). The rule stays the one place it's
    set. With two such conditions the largest counts, since every condition has to hold.
  - **Conditions added in Automations count everywhere,** not only on the run. A rule given "client tags
    include vip" is counted (the card, the turn-on question, the server's refusal), queued and let go
    with all its conditions, checked in the database as the engine checks them
    (`private.client_conditions_hold`), so clients it would skip don't use up the day's 100 or their
    stretch. A run the engine still skips on its conditions (a tag taken off in between) lets the
    stretch go, and skipped runs don't count against the 100.
  - **A year by default,** so it reaches a client at the same time of year as their last visit, when
    that work comes round again. A shorter wait would email lawn clients over winter.
  - **A client's last visit** is their latest completed job visit or assessment (a task doesn't
    count), and the days are counted in the company's own dates.
  - **Checked hourly from 10am to 5pm in the company's time zone** (the later hours catch up a missed
    10am run), so every client who reaches N on a day is emailed that morning. The runs are queued
    rule by rule, not through an activity row, so two rules at different N each fire at their own N
    and the activity feed isn't flooded.
  - **Once each time they go quiet:** a new completed visit starts a new stretch. A run the office
    cancels stays cancelled; one called off by turning the rule off, or by uninstalling Marketing, is
    sent again once it's back on, a run already being sent at that moment included.
  - **Not sent to** archived clients, clients who opted out of marketing or have no usable email,
    clients the business is working with, or anyone whose last visit was over 3 years ago (those
    addresses bounce). Working with them means:
    - **recurring work:** an active recurring job
    - **work sold:** an active one-off job with no visit completed yet. One whose visits are done but
      that nobody closed is past work.
    - **a visit** booked or not yet booked
    - **an open request:** new or at its assessment, as the Client Hub and Pipeline count them. A
      quoted request is left to its quote, so a client whose quote was lost isn't kept out for good.
    - **a quote** approved, or awaiting an answer until its valid-until date (30 days after it was
      sent when it has none). A quote nobody answered for years isn't waiting anymore.
    - **a recent quote:** one sent, or marked lost, in the last 6 months, whatever came of it. A quote
      is recent contact, not "a while", and Win back looks after a lost one (its wait is at most 180
      days), so a client isn't emailed "it's been a while" the day their quote is lost and then a
      win-back email for it.
  - **At most once every 6 months** (182 days) for each client, recorded as the email starts, so two
    at once send once. An email whose result couldn't be recorded (it went, and the database didn't
    answer) is tried three times, then counts as sent for the 6 months anyway, and its first open or
    click records it sent.
  - **A busy email service isn't a failure:** an email Resend turns away for too many at once (429,
    though not its daily or monthly limit) or its own trouble (5xx) is recorded failed and its run
    waits and tries again 1, 2, 4 and then 8 minutes later (`automation_runs.busy_tries`), failing only
    after that; the client stays queued and counted meanwhile. The batch stops there, its other runs put
    back for the next pass, and campaign emails go at most about two a second for each company, as
    one-off campaigns do.
  - **100 a day for each rule,** those who passed N most recently first, so a business turning it on
    with 2,000 past clients emails them over about three weeks. Turning it on with clients who already
    qualify asks first: **Email them too** (with **100 a day** when there are more than 100), or **Only clients who reach it from now on**,
    which marks today's backlog as done. The switch waits for that count, and the server refuses to
    turn it on without a choice while any qualify. A backlog let go isn't let go for good: turning it
    off and on again asks again, and **Email them too** then emails them. Lowering N says how many more
    it adds first.
  - **Nothing is queued while the business can't email** (email not connected, or no APP_URL), so a
    disconnected mailbox doesn't use up each client's stretch; a run that fails for that lets the
    stretch go too.
  - **Any rule on client.inactive is Re-engage,** a copy made in Automations included: marketing,
    with the same 6 months, recorded on the same campaign.
- **The starter emails read well for a business with no phone.** Re-engage and Win back ask for a reply,
  and put `{{company.phone}}` on its own line under the company's name, where an empty one leaves no
  gap. Rules still sending the first wording were given the new one; a changed email was left alone.
- **`{{link}}` on a line of its own is a button named for where it goes:** **Request work** for the
  Client Hub's home (Re-engage, Win back and one-off campaigns, as the Hub names that page), **View
  online** for a quote's page (Close pending quotes). The preview and **Send a test** draw the same
  button. A campaign email's Hub link lasts a year, as a review link does, since campaign emails are
  kept longer than a quote's or invoice's; a tracked link to one that has expired since, or one that
  isn't there, gets a page saying so, in the business's look when it's known. The Hub link isn't
  renewed on a click: that would make an old email a Hub key that never expires.
- **Win back lost quotes:** N days (30 by default, 1 to 180) after a quote is marked lost, if it still
  is. Not if the client has since approved another quote (or one went straight to a job), has an
  active job or a newer job, sent a request, or been sent a newer quote. Once for each quote. Its
  `{{link}}` is the client's Client Hub home, where they can ask for work: a lost quote can't be
  approved.
- **Close pending quotes is `quote_followup`, and it isn't marketing.** It follows up a quote the
  client asked for, so it keeps today's behaviour: it keeps running while Marketing is uninstalled,
  reaches clients who unsubscribed from marketing, and has no unsubscribe link. It's tracked and
  shown under Campaigns. Its starter name and description follow the days ("Follow up on quotes
  after 5 days"); a name someone wrote stays. A second email added to it in Automations goes too, as
  before: each email action of a run is its own send. Marketing's off screen and the uninstall
  question say follow-ups keep going only while the rule is on.
- **A changed wait moves the runs still waiting,** for every rule: Close pending quotes changed from 3
  days to 5 holds for quotes already sent. Turning Close pending quotes or Win back off with emails
  waiting says how many first, since turning it back on doesn't send them, and turning one on covers
  quotes from then on.
- **Emails waiting are the ones that would still send** (`private.campaign_waiting`): a quote's only
  while it's still there and has the status its rule asks for (awaiting a response, or lost), on the
  card and in the question before turning one off. A run whose quote was approved since is skipped when
  it comes due, as before.
- **More audiences** for one-off campaigns: city (a property's or the billing address, picked from
  the business's own cities), services on past jobs (a line's service or name, on a job that's done or
  has had a visit, recurring work included), recurring work (one choice: any, has an active recurring
  job, one ending in the next 30 days by `jobs.ends_on`, or none). A sent campaign shows its audience
  in words, its cities and services as they were picked (they're matched in any case).
- **Results,** one view for both kinds:
  - **Every send is a recipient row:** an automated campaign is a `campaigns` row (kind
    `automated`) for each template key, made the first time it's needed, with a row per email.
  - **Opens:** a tracking image. They're approximate: Apple Mail and some others load images to
    protect privacy, and the page says so. An open alone isn't a click.
  - **Clicks:** each http and https link (up to 50) goes through a tracked link that redirects only
    to the link stored for that email, never anywhere the request says. Each email has a random
    token, so a link reveals no ids and can't be used to guess another's. A click counts as an open.
    A click in the first 30 seconds after sending, a HEAD request, or a link preview (a chat app's or a
    bot's user agent) is a link scanner's and isn't counted; scanners that click later, like Defender
    Safe Links, still are.
  - **Bookings:** "opening one of the campaign's links" reads as clicking one. A request or an
    approved quote within 30 days of a click is a booking, attributed to the latest click, across
    campaigns. A request and the quote made from it are one booking.
  - **Revenue:** what that work has been paid, before tax and retainage held back (`total -
    tax_amount - retainage_amount`; the retainage invoice that bills it later books the rest, so a job
    counts once), whenever it's paid: an invoice goes with the booked quote or request behind it. An
    invoice with no booked work behind it counts when it's paid within 30 days of a click and its work
    (its job, or the invoice itself) was set up after the click, so a recurring client's routine
    invoices, an old quote's job or an overdue invoice aren't the campaign's. An invoice that stops
    being paid loses its revenue, and a request or quote deleted (or its client) its booking. Stripe
    history imports book nothing. Referral revenue (phase B) still counts `total - tax_amount`, with
    retainage in it; a follow-up.
  - Each campaign and card shows sent, opened %, clicked %, bookings and revenue (with the Invoices
    area; a one-off campaign's row says its count once, on that line), and the campaign page lists who got it and what each did, a page at a time to the last,
    narrowed to **Opened**, **Clicked** or **Booked** when asked, so the one who booked isn't on page
    three. Their pills grow stronger with each step: **Sent** grey, **Opened** blue, **Clicked** green.
    A sent one-off campaign shows its numbers across the page, and its preview greets someone who got it.
    Its preview and audience are the campaign's own as saved, and when sending finishes the numbers and
    the list are read once more. Its sent and failed counts are written whatever its status, so one
    stopped partway says what went ("Stopped · 3 of 10 sent"), and they move every few emails while it
    sends. They're taken from its recipients as it's stopped, by **Stop** or by uninstalling Marketing
    while it sends (`private.campaign_stop_counts`), and campaigns stopped before that were counted
    again (`private.backfill_stopped_campaign_counts`).
  - **Previews draw the email as it goes:** the company's phone for `{{company.phone}}` (GET /me sends
    it), the company's name and address above Unsubscribe, and the subject in fixed dark colours on the
    always-white sheet, in dark mode too.
  - Each card is short: when it goes, emails waiting, what it brought in, and **Who gets it** folded
    away. A switch that can't be turned on without email says so on the card, and **Send a test** says
    so in Edit email, where a test that went says so too, not in a toast over the dialog's buttons.
    While a card's numbers load it shows a placeholder, and a retry if they don't. Marketing's
    overview adds revenue from campaigns, and the Referrals card what referred clients paid.
  - **Office staff without the Automations area** see each card's state, on or off, and when it goes
    from its rule (`automated_campaign_states`), with its results, not its switch.
  - **Tracked links and pixels keep working while Marketing is uninstalled.** One-off and automated
    emails without a link say "Add a link so clicks and bookings can be counted"; one-off campaigns
    gain a **Client Hub link** token for that. **Write with AI** may use `{{link}}` and
    `{{company.phone}}` and is asked to put `{{link}}` on its own line before the sign-off; a draft
    that leaves it out gets it there (`withHubLink`). Close pending quotes' token is **Quote link (View
    online)**, since its link is the quote's page.
- **Email only, like Jobber.** Every marketing email has one-click unsubscribe and the company's
  address: campaigns, review asks and their reminders, and referral asks. While Marketing is
  uninstalled, Re-engage and Win back don't send (their waiting emails are called off), and turning
  them on is refused. Uninstalling says how many win-back emails are waiting, since they're cancelled
  for good; past clients still due a re-engage email get it once Marketing is back.

### 4. Google reviews inside Crewtavo (phase D, built)

- **A Google Business Profile app** in Apps, under a new **Marketing** category, brings in one
  location's reviews. It signs in like Google Calendar, with the server's Google app
  (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) or the company's own (its keys pasted on the app's
  page), with the one scope `business.manage`.
- **This is the one big difference from Jobber.** Jobber has one Google app that's already
  approved. Every Crewtavo instance's Google Cloud project needs its own approval of the Business
  Profile APIs, and so does a company's own Google app:
  - The business's Google profile has to be verified for 60+ days.
  - Approval takes about 2 weeks (Google says 14 days), said the same way everywhere.
  - Until then Google answers with zero quota (429 `RESOURCE_EXHAUSTED`, or 403 on a list), which
    is told apart from APIs not turned on (`SERVICE_DISABLED`), a sign-in to reconnect (401, a
    missing scope, `invalid_grant`), a lost or unverified location, Google being busy, and other
    errors (`googleProblem`). Access refused on one location is approval while the location is
    still listed, and a lost location once it isn't. Only a call about the location can say it's
    suspended: a suspended Google Cloud project (`CONSUMER_SUSPENDED`, "Consumer 'projects/…' has
    been suspended") is the project's problem, said as such and tried again later.
  - Signing in still works and finishes as installed, waiting on Google: the page says so (**Waiting
    on Google**), with Google's form, the project number it asks for (the start of the OAuth client
    ID) and who fills it in. Crewtavo asks again every 6 hours, and **Check again** asks now, on the app
    page and, for owners and admins who connect apps, on the Reviews tab; it says what Google answered
    either way. Everything in phases A to C keeps working. Back from signing in, the page says it's
    installed and when reviews start, and leaves the wait itself to the callout below it.
  - **Nothing that can't work yet is offered while it waits:** no **Sync now** (the server refuses it
    too), no replies or **Suggest a reply**, and no filters over an empty list: the list shows once
    there are reviews here or they're on their way.
  - **Other errors are said plainly** ("Reviews couldn't be brought in from Google just now."), with
    when Crewtavo tries again; Google's own words stay in `problem_detail`. The app's status says
    **Not syncing** meanwhile. A reply Google doesn't take says so the same way. Errors back off from 30
    minutes over problems of one kind in a row, so the first ordinary error after waiting on approval
    tries again in 30 minutes, not 6 hours.
  - **A reply refused on the location** says what's in the way, as a sync would: Google's approval
    while the location is still listed, or that the account can't manage it anymore. **Sync now** on a
    sign-in that expired says to Reconnect.
- **Marketing is a requirement.** While Marketing is off, Install is disabled ("Install Crewtavo -
  Marketing first: your Google reviews show in Marketing → Reviews."). Installed, and Marketing
  uninstalled later, the page shows **Paused**: nothing is brought in, no notifications, replies,
  suggestions and Sync now answer "Marketing is off", and the reviews, matches and stops stay. It has
  no **Open** then, and doesn't point at Marketing → Reviews, which isn't there.
- **Sign-in expired:** the page is about **Reconnect**: no **Change location** (it lists through the
  sign-in) and no review link offer until it's back.
- **Install never signs in straight away.** It opens **Before you sign in**: Google's access request
  first (it's the step that takes weeks), then this app's redirect address, the scope and the three
  APIs for the Google Cloud project, then **Sign in with Google**. Instances that already use Google
  Calendar sign-in have to add the new redirect address (`/api/apps/google_business/callback`) and
  the scope to their project.
- **Google's account chooser shows on every sign-in** (`prompt=select_account consent`): the account
  that manages the Business Profile often isn't the one signed in to the browser. Signed in with a
  Google account that manages no Business Profile, the page says so and offers **Sign in with another
  Google account**, which the location picker offers too.
- **One location per company.** With only one, it's picked by itself; otherwise the office picks it,
  read again from Google (nothing the browser sends about it is kept). **Change location** removes
  the old location's reviews after a confirm that says how many ("The 1 review … is removed"), and asks
  start again for any clients they matched, reminders included. Reviews are kept by Google's location and review ids, so the same
  location reached through another account path keeps its reviews and matches.
- **Reconnecting after Uninstall kept the reviews** takes their location up again when the new
  sign-in still reaches it. When it doesn't (another Google account, or the profile moved or was made
  again), that's a location to pick, not a lost one, and nobody is notified: the person who signed in
  is on the page, which shows the locations to pick from. Picking another asks first, since the kept
  reviews are removed, even when it's the account's only location. Whenever the app is signed in with
  no location in use, the picker shows, so there's always a way on.
- **Google's review link** (`metadata.newReviewUri`) is offered on the app page and in Reviews →
  Your review link when the company's is empty or different: **Use this link** or **Keep mine**,
  never used without asking. **Keep mine** holds for that location.
- **Syncing**, every 30 minutes (`review_sync`, and **Sync now**, at most once every two minutes),
  one worker per company (`claim_review_sync`, renewed each page):
  - **Bringing in your reviews: 250 of 1,240** shows only while they're coming in: the location in
    use, nothing in the way and Marketing on. Google's count is saved with every page, the last one's
    too, so it reads "of 1,240" from the first page and "30 of 30" for a location whose reviews fit on
    one, before "Your Google reviews are in". Before the first page there's nothing to count, so it says
    **Bringing in your reviews**, never "0 so far". The tab checks every 5 seconds while a sync runs, and
    every 30 between the first sync's runs; never while it's waiting on Google or a person. The app page
    checks every 5 seconds while it shows, and its banner from signing in moves on once a location is
    picked or Google lets Crewtavo in.
  - **Sync now** says "Checking Google for new reviews". Pressed again within two minutes, "Google was
    checked a moment ago. Try again in a couple of minutes." comes as a note, not an error.
  - From the top, newest changes first, stopping at the first review already here unchanged.
  - Once a day, and on the first sync, a full pass through every review (up to 10,000), saved page
    by page so a pass cut short carries on, finds replies made in Google's own app (they may not
    change a review's update time) and reviews deleted there. A page token Google turns down starts
    the pass again.
  - **Deleted on Google means marked, not deleted,** and only for a review a complete pass didn't
    see and Google then answers 404 for, one by one (25 a run): a review the list skipped as it
    shifted isn't marked, and its client isn't asked again by mistake. A marked review is hidden,
    left out of the numbers and stops nobody's asks; if it comes back it's restored without a
    notification.
  - **A reply Google answers 404 for** isn't proof the review is gone (deleting a reply already
    deleted in Google's own app does that), so Google is asked about the review itself: only a review
    Google no longer has is marked, and deleting a reply Google no longer has clears it here too.
  - **A reply written here wins over an older page** (`reviews.reply_written_at`, passed the time the
    page was fetched): a page Google gave before a reply was posted, changed or deleted in Crewtavo, or
    up to a minute after (Google's list can take a moment), doesn't put the old reply back or lose who
    wrote it. A later page is Google's word, as before.
- **Matching, Jobber's stop.** A review is matched to a client by name (folded the same way in the
  database and the browser: case, accents in either case whatever the database's locale,
  apostrophes, punctuation and spaces):
  - The whole name can match without an ask; Google's "First L." form needs a review ask in the 180
    days before the review (one that counts as `last_review_ask` counts it).
  - The asked client wins; two asked, or two of the same name with none asked, leaves it for the
    office. A client already matched to another review isn't matched again, and anonymous reviewers
    never are. Couples and business names stay unmatched for the office to match by hand.
  - **Match to a client…** and **Not this client** on each review. Its suggestions show what tells two
    clients apart (an email, else a phone, an address or a business name), and two of the same name
    only pick one for **Match**, never match on one click. An undo sticks: that review is
    never matched automatically again. Both are kept apart from the review (`review_match_choices`),
    so they hold when its row is removed (**Change location** away and back, or disconnecting with the
    reviews removed) and the review comes in again: matched by hand to the same client, or left alone.
  - The ask a review answers is recorded (`review_requests.reviewed_at`), shown as **Left a review**
    and counted as **Asks that led to a review**.
- **A matched review stops every review ask** for that client: their reminders still to come stop
  with "Left a Google review", and `begin_review_request` refuses new ones, automatic and by hand,
  copied links too. The refusal says how to fix a wrong match ("Not them? Undo the match in
  Marketing → Reviews.") and the client's page shows "Left a 4-star Google review", linking to it,
  with its **Reviews** switch off and "Left a Google review, so not asked". **Ask a client now** says
  only that, with **See their review** to undo a wrong match, and no button or last-asked line.
  Undoing the match lifts the stop: the client's newest stopped ask gets its next reminder back,
  timed as changing the reminder days would, but not while Marketing is off or for an ask from
  before it was last installed (uninstalling stops reminders for good). The same happens whichever way
  a client's last review goes: deleted on Google, removed by **Change location**, or removed on
  disconnecting (the database says whose stop it lifted, `lifted_clients`, and the server gives the
  reminders back). Reviews kept after disconnecting still stop their clients' asks: the client did
  leave a review.
- **Referral asks keep going after a review.** A happy reviewer is the best referrer, and stopping
  their review reminders even lets an automatic referral ask go sooner, since it waits on them.
- **The Reviews tab**, laid out like Referrals: the numbers across the top (Google's own average and
  count, so they match what customers see, then the response rate, time to the first reply and asks
  that led to a review, over 12 months), the ask settings and **Ask a client now** as before, the
  monthly trend in the narrow column (counts charted, averages as plain figures under it, "—" for an
  empty month), then **Your Google reviews** at full width, then **Recent requests**.
  - On a phone (where the columns stack) the numbers come after the ask settings and **Ask a client
    now**, just above the list: Marketing's own numbers are above the tabs already, and the form comes
    before long content. Time to reply is short ("2 days") so it stays on one line.
  - The trend shows whenever there are reviews here, also under what's in the way, and "N reviews need
    a reply" only while replies can be posted.
  - Filters: **Needs a reply**, stars, **Matched** / **Not matched**, 25 at a time. A notification's
    link (`?review=`) shows that review first with its reply open; a client's page (`?client=`) shows
    only theirs.
  - The numbers show once there's something to count (the first sync done, Google's own count, or
    reviews here), so waiting on Google's approval doesn't say "0 reviews on Google".
  - Each review: stars, the reviewer's photo or initials, the date and its reply status on one line
    with the menu, so on a phone the words and the reply editor get the row's width; then the words
    with **More**, the client it's matched to ("Matched by name" for an automatic match), and its
    reply. A reviewer Google sent without a name is "A Google user" (a person icon, not initials), and
    "the review" in the confirms.
  - **See their review** (from Ask a client now, on the tab itself, or a client's page) shows that
    client's reviews and brings the list into view.
  - **Replies post publicly on Google**: posting and editing are confirmed with the text shown.
    "Replied 2 days ago by Mia", or "Replied on Google…" for one made in Google's app. **Suggest a
    reply** and **Rewrite** draft one with the company's Claude key (or the server's), never adding
    prices, dates, promises, offers or names not in the review, by first name only when it looks like
    one, in the review's own language, and for 1 or 2 stars an apology and the company's own phone or
    email from Settings, none made up. The phone goes in as the app shows it ("(540) 555-0100"), since
    it may end up in a public reply. Nothing posts without a person.
  - Not connected: a small card in the narrow column says what it adds and that Google approves each
    server first; waiting on Google, the same spot shows that, and office staff are told an owner or
    admin can act. Disconnected with the reviews kept, the same spot offers owners and admins **Connect
    Google Business Profile**, and tells office staff to ask one. The ask settings stay first either way.
- **Notifications:** a **Google reviews** topic ("New reviews, low ratings first. Email only for 1 and
  2 stars"), by push and email by default for everyone (only people with the marketing area get
  them). A review tells the office once, when it's first brought in after the first full sync and
  was posted in the last 14 days, so connecting doesn't announce every old review, nor the two
  weeks spent waiting on Google. The first full sync sends one "Your Google reviews are in: 132
  reviews, 4.8 average" instead. A review changed from 3 stars or more to 1 or 2 tells it again. A
  sign-in that needs Reconnect, a lost location, or a location to pick once Google lets Crewtavo in on
  a later try (nobody's looking then), tells owners and admins who connect apps once each time. None
  of these go while Marketing is uninstalled, and a problem isn't recorded as told then, so it tells
  them once Marketing is back. Owners and admins who connect apps without the marketing area see the
  topic too ("When Google Business Profile needs signing in again or a location picked"), so they can
  turn it off (`reviewNoticesFor`). Low ratings come first, and several at once lead to Marketing →
  Reviews.
- **Disconnecting** keeps the reviews already brought in (the confirm says so) with a box to remove
  them, and signs out at Google, except when Google Calendar uses the same Google app: Google
  revokes the whole sign-in, so then it's left, and the page says where to remove it.
- **Docs:** the app's Setup guide and Website point at Google's pages
  (`https://developers.google.com/my-business/content/prereqs`, `https://www.google.com/business/`)
  until `crewtavo.com/docs/connections/google-business-profile/` is written in crewtavo-website.
- **No competitor comparison** (Google's Places API charges per lookup).

### 5. Social posting (phase E, built)

- **Posts to Facebook and Instagram** through the business's own Meta app. There's no Crewtavo Meta
  app: each business makes one at developers.facebook.com (about ten minutes, with the guide on the
  app's page), and Meta doesn't review an app whose admins only post to their own Page, since
  Standard Access works for people with a role on it.
- **Posts to Google Business Profile** with phase D's connection (`localPosts`, the same
  `business.manage` scope), once Google has approved access and a location is in use.
- **What gets posted:**
  - photos the crew or office marked **OK to share** (1 to 10), as one post or a carousel
  - a 4 or 5-star Google review as a square card (`lib/reviewCard.ts`)
  - words alone, for Facebook and Google (Instagram needs a picture)
  - a caption a person writes, or drafts with **Suggest a caption** (the company's Claude key); Google
    needs one to post, so **Post now** and **Schedule post** wait for it there (a draft doesn't)
  - now, or scheduled to a date and time in the company's time zone
- **Photos picked before the composer opens** (a post being changed, **Post these photos** on a job's
  or client's page) are read by id (`GET /social/photos/picked`), so they show in the preview and can
  be taken off even when they aren't among the 48 newest. Any that can't be posted anymore (not OK to
  share, the client said no, gone) are taken off, saying why. A network a post being changed can't
  post to anymore (Facebook & Instagram disconnected, Google not ready) is taken off the same way.
- **A Share button for X, LinkedIn or anywhere else** (**Share elsewhere**): the pictures as they post
  (without their location) and the caption, through the browser's share sheet where it takes files,
  otherwise a download for each picture and **Copy caption**. Neither Jobber nor Crewtavo posts to them.
  From the composer it opens over it, and closing it comes back to the post as written.

What was decided building it:

- **Verified against Meta's and Google's docs (31 October 2026).** Graph API v26.0 (29 July 2026), set
  once (`GRAPH_VERSION`, `integrations/metaConfig.ts`). The short-lived token is swapped for a
  long-lived one (`fb_exchange_token`, about 60 days); `/me/accounts` with it gives Page tokens that
  don't expire. Facebook photos through `/{page}/photos` (`url`, `caption`), several as unpublished
  photos attached to a `/{page}/feed` post, words alone through `/feed`. Instagram through
  `/{ig-user}/media` (JPEG only, 4:5 to 1.91:1, up to 1440 px across; carousels of item containers)
  and `/media_publish`, its daily limit read each time from `content_publishing_limit` (Meta's own
  pages give 50 and 100). Google through `v4/accounts/*/locations/*/localPosts` (`topicType
  STANDARD`, `summary`, `media[].sourceUrl`). Error codes from Meta's error handling guide: 190 and its
  subcodes (and 492) are a sign-in, 10 and 200 to 299 a permission, 4, 17, 341 (and 32, 613, 80001,
  from memory) throttling, 368, 1 and 2 temporary. **Meta's API can't say whether an app is Live**
  (the App Modes page and the Application node have nothing for it), so the person ticks **I switched
  my app to Live**, and until then the app page and the Social tab say posts stay hidden from the
  public. Not verified: whether Meta's IG user endpoints take a Page token (Crewtavo uses the Page
  token for Instagram too, so posting doesn't stop when the 60-day sign-in does; widely reported to
  work), the exact names in Meta's app dashboard, and Google's 1,500-character limit and phone rule.
- **Permissions:** `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
  `business_management` (Pages reached through a business portfolio aren't listed without it),
  `instagram_basic`, `instagram_content_publish`. A Page in a business portfolio also needs
  `ads_management` and `ads_read` for Instagram (Meta's content publishing guide): the Page picker
  reads the Page's business and asks for **Reconnect with business Page permissions** before any post
  fails. A Facebook Login for Business **Configuration ID** can be pasted instead (under **More
  options**); without one, Crewtavo asks for the permissions itself. A permission a network posts
  with that sign-in didn't get (`pages_manage_posts` for Facebook; `instagram_basic` and
  `instagram_content_publish` for Instagram, with `pages_show_list` and `pages_read_engagement` for
  both, as Meta's permissions reference gives their dependencies, checked 31 October 2026) makes it **Needs attention** under **Where it posts**, naming the permission; the composer
  doesn't offer it and the server refuses it until someone reconnects and allows it. A connection
  with no permissions on record isn't held up.
- **Two sign-ins.** The person's long-lived token only lists Pages and permissions; every post uses
  the Page's token. A Page token that stops working (190 or 492 on a post, or `debug_token` in the
  daily check) marks the app **Needs attention** and tells owners and admins who connect apps once;
  the person's token running out only says "Sign in again to change the Page", and posting goes on.
  Signing in again keeps the Page picked when it's still listed (with a fresh token). Owners and admins
  hear 7 days before Meta's data access runs out (`data_access_expires_at`). Disconnecting revokes
  with the app's own token (`DELETE /{user}/permissions`), so it works after the 60 days too, and keeps
  only whether the app is Live, since the app (its keys) stays: connecting again with it doesn't ask
  again. New app keys start again from nothing, Live included; the same App ID with its secret pasted
  again keeps Live.
- **Privacy page for going Live:** the business website's `/privacy`, suggested with **Copy** as the
  first line of the guide ("Before you start"), used for both the privacy policy URL and the data
  deletion instructions. With no website on file, the guide says to add one first. A privacy page
  hosted by Crewtavo is a follow-up: it's legal text the business has to own.
- **Photo formats:** JPEG (jpeg-js) and PNG (pngjs 7.0.0, MIT, alpha laid on white) only. HEIC, WebP,
  GIF and TIFF can't be posted: the only pure decoders are WASM or LGPL. **OK to share** is refused on
  them ("Only JPEG and PNG photos can be posted. Save this one as a JPEG and add it again."); iPhones
  already send JPEG from the photo picker. Shared photos are turned by their EXIF orientation, at most
  2048 px, quality 85, re-encoded with no EXIF, ICC or other metadata (no GPS of a client's home).
  Instagram's copy is padded, never cropped, into 4:5 to 1.91:1 (a carousel's to a square), in the
  brand colour or a light grey. Photos over 50 MP aren't decoded.
- **The review card:** SVG drawn to pixels by `@resvg/resvg-wasm` 2.6.2 (MPL-2.0) with static Figtree
  Regular and SemiBold (OFL-1.1, vendored in `apps/api/assets/fonts`), then a 1080 × 1080 JPEG by
  jpeg-js: nothing native, so it works in the one bundled server and for automatic posts with no
  browser. `scripts/build-server.mjs` copies the `.wasm`, the fonts and both licences into
  `dist/server/assets/` (NOTICE lists no third-party licences, so it's unchanged), and builds
  `scripts/render-card.mjs --check` to prove it. Gold stars drawn as paths, the words fitted with
  Figtree's own widths (`fitCardText`, `FIGTREE_WIDTHS`): as large as fits the room left (72 px for a
  short review, down to 40 px over up to 8 lines, then cut with "…"), with the stars and "— Ana S."
  centred together above the business, so a short review fills the card instead of leaving a gap. The
  logo on a white plate (logos are made for light backgrounds) or the business's name (set smaller
  when it's long), and "Google review" in words at 34 px, which still reads at a feed's size. Emoji are
  left out (Figtree has none, and a colour emoji font is large): the composer says "The card leaves
  out its emoji" on such a review and under its preview, so the words never change quietly. The
  composer's preview is the server's own JPEG. Reviews in other scripts get no card yet.
- **Never a client's name or address.** A caption that names the chosen photos' clients or the
  review's matched client (their whole name, or a street address's number and street) is refused; a
  last name on its own ("Green") is only a warning. **Post now** checks first (`POST
  /social/posts/check`, saving nothing), so a refusal is said before the "posts publicly" confirm, and
  it's brought into view. Checked again when it posts, review words
  included, since a review is matched after it comes in. Reviewers are "Ana S." or "A Google user".
  The guide and the photo hints remind the crew and office that a house number, a car plate or a face
  shows a home too. A client's **Can be posted on social pages** switch (off: "No social photos")
  keeps their photos out everywhere.
- **Each network posted at most once.** One row per network (`social_post_networks`) moves through
  waiting → sending → posted (or retry, failed, unknown, skipped). It's marked sending just before the
  call that can't be taken back; a worker that stops then leaves it **Unconfirmed** when its claim runs
  out, and the post finishes. A timeout after sending gets one read-only look by caption (made since a
  minute before the send, with as many pictures, and not another post's), else **Unconfirmed**, where a
  person looks where it says (**Check your Page**, **your Instagram account** or **your Business
  Profile**: Google has no Page) and says **It's on the Page** (**on Instagram**, **on the profile**)
  or **It isn't there, post it**. A success recorded late always wins.
  - **An unclear answer to the call that publishes is a send that may have gone too:** a 5xx (an HTML
    502 from Meta's edge included) or Meta's codes -1, 1 and 2 on `/{page}/photos`, `/{page}/feed` or
    `/media_publish`, and a 5xx from Google's `localPosts`. Meta sometimes makes the post and still
    answers "An unknown error occurred". Only a definite no (throttling, 429, a permission, the daily
    limit) is tried again by itself.
  - **Google's sign-in is refreshed before the network is marked sending,** so a refresh that times out
    is a plain failure to try again, never taken for a post that may have gone.
  - **Instagram's container is asked first:** one Instagram says is `PUBLISHED` (a publish that heard
    back unclearly, or **It isn't there, post it** when it was) is recorded as posted, with its link
    when the look by caption finds it, never published again. One it turned down (`ERROR`) is dropped.
  - **What's made on the way is kept for the pictures it was made from:** Facebook's unpublished photos
    and Instagram's item and carousel containers are kept between tries with the picture links they
    were made with (`steps.images`), and made again when those change. A photo taken off OK to share,
    or whose client said no, between tries is never posted from an old container, and a carousel left
    with one photo posts as one. **Post again** starts each network it puts back from nothing.
  - Other failures wait 2, 4, 8, 16, then 32 minutes, then fail; Instagram's limit and a container still
    being made wait up to a day. Posts are claimed one at a time, and **Post now** posts that post alone.
    **Post again** puts back only what failed or was skipped; a post that started can't be edited.
  - **Cancel post** partway through skips what's still to go and marks the post stopped
    (`social_posts.stop_kind`): a send out at that moment is recorded when it ends, but one that comes
    back "try again" is skipped, nothing more is made or begun, and the claim never picks the post up
    again. **Post again** and **It isn't there, post it** lift it: a person asked.
- **Photos inside Crewtavo** (the composer's grid and preview, the posts' thumbnails) are sent as their
  storage paths and signed in the browser (`lib/files.ts` `signedUrls`), as a job's Photos card does:
  a self-hosted server reaches Storage at `127.0.0.1` through its own gateway, so a link signed there
  would point at the viewer's own computer.
- **This server's address has to be public for pictures:** Meta and Google fetch them from it. On an
  http or private address the composer says so and offers only **Save draft** and **Share elsewhere**
  for photos and reviews (words alone still post), the server refuses to schedule them, automatic posts
  can't be turned on, and **Where it posts** says why. A post already scheduled fails with the reason.
- **Pictures' public links:** `/api/public/social/<32-character random token>.jpg`, made when it posts,
  never naming an id, until 7 days after the post finishes; unknown and expired are the same 404, and
  Marketing isn't asked. Files go a day after their links. A photo left out of a post between tries
  (not OK to share anymore, or its client said no) has its link and file removed at once.
- **Automatic 5-star posts** (off by default, **Post 5-star reviews automatically** on the Social tab):
  a new 5-star review with words (as phase D marks news: after the first full sync, posted in the last
  14 days, so no first sync, re-import or location change posts old reviews) is scheduled for 10 AM, 1
  PM or 4 PM in the company's time zone, at most 3 a day, from the next day (or today, before 8 AM),
  only to the networks ready then, never twice for a review (a cancelled one, or one posted by hand,
  included). Its caption is "Another 5-star review from a happy client. Thank you!" until a person
  changes it: no AI caption posts unread. The office hears when it goes ("A 5-star review posts tomorrow
  at 10 AM", push only), and can change its caption, networks or time, or cancel it; its review stays
  (the composer shows it without a choice, and the server refuses another). The Social tab says the
  same-day rule. While it's on, the last network ticked can't be unticked: turning it off is how it
  stops. Turning it off cancels the ones scheduled, after saying how many. Only the server writes
  `settings.social` (`social_set_auto`, kept from plain saves by `social_settings_guard`). A place it's
  set to that can't post now (Facebook & Instagram uninstalled, Instagram not linked to the Page, a
  permission missing) shows unticked with why and stays saved, so posts go there again once it can;
  with nowhere left that can post, the switch says **Paused** with what to do, rather than On.
- **A review that comes back:** a review post keeps `review_key`, so when its review's row is removed
  (disconnecting with the reviews removed, or **Change location** away and back) and the same review
  comes in again, the post is linked to it again (`private.relink_social_posts`) and posts when it's
  due. One whose review isn't here says "The review isn't in Crewtavo anymore", not that Google removed it,
  and says what to do only when there's something: "Connect Google Business Profile to bring it back"
  while it's disconnected, "Google Business Profile is set to another location now" after **Change
  location** away, and nothing more while it's connected to the review's own location.
- **Facebook & Instagram disconnected:** posts still scheduled skip them ("Facebook & Instagram was
  disconnected") and still go to Google; Uninstall's confirm says how many won't go, and **Post again**
  sends them once it's connected again. Google's problems are phase D's: not approved isn't offered,
  a sign-in or location to fix fails with what to do, a passing error tries again.
- **Marketing uninstalled:** scheduled posts go back to drafts ("Marketing was uninstalled"), a post
  partway through stops before its next network (a send already out is still recorded, and one that
  comes back "try again" is skipped, marked stopped like a cancel), nothing is claimed or scheduled
  automatically, the Social tab goes with Marketing and the **OK to share** toggles hide (their values
  kept). Links already given out work until they expire. Installing again posts nothing by itself.
- **Not automation rules.** Automatic posts aren't messages to clients, so they're a setting with a
  database trigger, not a starter rule.
- **Notifications:** a **Social posts** topic: an automatic post scheduled (`social_scheduled`, bell
  and push, "A 5-star review posts tomorrow at 10 AM", or "Nov 6 at 10 AM" past tomorrow, as the list
  says it: `private.auto_post_when` and core's `autoPostWhen`), a post that didn't all go or may have gone, and Facebook & Instagram needing a sign-in
  (`social_failed`, email too). A post that didn't all go tells whoever made it while they're still in
  the office with the marketing area, and otherwise the office, as an automatic post does. Its title
  keeps what posted, what didn't and what may have apart ("A post went to Facebook and may have gone to
  Instagram. Check your Instagram account."), so nobody posts again what may be there.
- **The screens:** the Social tab lists **Drafts and scheduled** above **Posts**, with "No posts yet"
  only when there are none at all; a notification's post is scrolled to once. **Cancel post** and
  turning automatic posts off name both buttons (**Keep it**, **Leave it on**). The composer dates
  photos by their visit as written. In the field, photos that can't be marked OK to share say so
  (a photo the browser shrank is stored as the JPEG it is, so it can be). A client's **Can be posted on
  social pages** switch refreshes their Photos card at once, **Mark all OK to share** carries on past a
  photo it's refused and says how many it marked, and the Page picker offers **Sign in with another
  Facebook account** when the sign-in manages no Page it can post as. **Check again** on Apps →
  Facebook & Instagram opens the Page picker with **Post to Instagram too** ticked once Instagram is
  linked.
  **Drafts and scheduled** is in the order posts go (posting, then scheduled by time, then drafts,
  newest first). A post that finishes posting while the tab is open moves to **Posts** without a reload.
  The networks the person ticked are kept: a words-alone post leaves Instagram off, and photos put it
  back, here and in what's remembered for the next post. With several photos and Google ticked, the
  composer says Google Business Profile shows only the first. A review picked with **Post on social** is
  scrolled to in the list. Until the Meta app is Live, **Post now** says Facebook and Instagram keep the
  post hidden from the public (only people with a role on the Meta app see it) and only the networks
  that are public are called public. A review's post shows its first words and who wrote it ("— Ana S."), with the card in
  small (the brand colour and gold stars), so automatic posts with the same caption are told apart; on
  phones the status moves under the caption and the picture gets smaller. A caption whose last name
  may be a client's is said in the save's toast. The composer opens without putting the cursor in the
  caption (photos come first). **Mark all OK to share** counts the photos as it marks them. A client's
  no is said once on a Photos card, and a job's own page doesn't repeat its number in each group. In the
  field, a photo that can't be marked has a **Can't share** label where the toggle would be, and the
  toggle once on is white with a green check, which shows on a green lawn. Rows picked from a list (the
  Page picker, the composer's reviews) are bordered with a class (`choice-row`): an inline border with a
  `borderColor` React clears left three sides the text's colour.

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
  last reminder failed), `reminder_note` (why reminders stopped) and `link_token` (the short link's
  random token). `track_review_click` records an open (the server's alone).
- `clients`: `review_opt_out boolean`, `sms_opt_out_at timestamptz`.
- `referrals`: `reward_status` (pending, earned, applied, issued, none), `reward_kind`, `reward_value`,
  `earned_at`, `earned_invoice_id` (the friend's paid invoice), `applied_at`, `given_amount`, `auto_apply`,
  `credit_anyway`, `no_reward_reason`, `lost_at`. Changed only through the database's functions.
- `referral_credits` (referral, invoice, amount, note) in place of a `reward_invoice_id`, since a credit
  can be split over invoices, and `referral_credit_skips` (invoices someone took a credit off).
  `invoices.credit_amount` is what an invoice takes of its credits, worked out with its totals.
- `referral_asks`: each ask for referrals, automatic or not, sent or failed.
- `campaigns`: `kind` (one_off, automated) and `template_key` (an automated campaign's rule, one
  row each; its status is `automated`, so the one-off sender never touches it).
- `campaign_recipients`: `track_token` (random), `links` (what its tracked links go to), `send_key`
  (`''` for a one-off campaign, `run:<automation run>` for an automated send, `run:<run>:<n>` for the
  run's later email actions; unique with the campaign and email), `subject_id` (the quote), `opened_at`, `open_count`, `clicked_at`,
  `last_clicked_at`, `click_count`.
- `campaign_bookings`: requests, approved quotes and paid invoices after a click (`chain_id` ties a
  request, its quote and invoice together), with each invoice's amount before tax.
- `campaign_recipient_results(…, p_filter)`: everyone, or those who opened, clicked or booked.
  `marketing_summary` adds `automated_sent_30d`, so the overview says how many of the month's emails
  were automated. `campaign_audience_choices` counts each city's and service's clients.
- `inactive_client_marks`: each client's stretch without a visit, for each client.inactive rule,
  with the run that emails it (none when the business let the backlog go, until it chooses **Email
  them too**: `release_inactive_backlog`).
- `automated_campaign_states`: each automated campaign's switch, days and emails waiting, for the
  office with Marketing who can't read its rule.
- `automation_runs.busy_tries`: waits for a busy email service, counted by `postpone_automation_run`'s
  `p_busy`.
- Automations:
  - a trigger `client.inactive`, checked hourly from 10am, and a condition `days_since_visit`
  - a condition `amount_paid` on invoices (the paid notice's)
  - an action `request_referral`, and a trigger `referral.earned`
  - the recurring-visit count read from settings
  - fourteen starter rules, with `referral_after_job`, `reengage_past_clients` and
    `win_back_lost_quotes`
- `reviews` (phase D): one location's Google reviews, each once by Google's location and review ids
  (`external_name` is what the v4 API is called with), the reviewer, stars (null for none), words,
  the reply and when it first appeared (`first_replied_at`, for time to reply), the matched client
  and how (`match`: auto, hand, none; `match_cleared_at` after **Not this client**), the ask it
  answers, whether the office is to be told (`notify`: new or lowered) and when it was, and
  `deleted_at`, and `reply_written_at` (a reply posted, changed or deleted from Crewtavo). Office staff
  with the marketing area read them; only the server writes them. `mark_deleted_reviews`,
  `set_review_location` and `end_review_sync` say how many and whose stop they lifted (`lifted_clients`).
- `review_match_choices` (phase D): the office's match by hand, or "Not this client" (no client), for
  each Google review by its location and review ids, kept when the review's row is removed and taken up
  when it comes back. The server's alone, written by `set_review_client`.
- `review_syncs`: each company's sync, the server's alone: the claim, the location (the one source
  of truth for which location's reviews are kept), the full pass's place, the first and last
  passes, what's in the way (`problem`: approval, not_enabled, signin, pick, location, error, with
  `problem_detail`), the access notice last sent (signin, location, pick), and Google's own average and
  count. The location is kept on disconnecting with the reviews, and is in use again only once the
  app is set to it.
- `clients.name_key`, `name_short` (generated from the name), `clients.reviewed_at` (set only by
  the reviews table) and `review_requests.reviewed_at`. `review_stats` gives the Reviews tab's
  numbers as the person asking; `notification_prefs` takes `reviews`.
- `attachments.shareable`, `shareable_by`, `shareable_at` (phase E): OK to share, changed only by
  `set_photo_shareable` (the team, JPEG and PNG, a client who hasn't said no) and cleared when the file
  changes (`attachment_share_guard`). `clients.social_photos_opt_out`: "Don't post photos of this
  client's property". `record_photos` (a job's or a client's photos for the office) and `social_photos`
  (the photos OK to share, for the composer, keyset on created_at and id).
- `social_posts` (phase E): source (photos, review, text), the photos, the review (and `review_key`,
  which outlives its row), caption and who wrote it, networks, status (draft, scheduled, posting,
  posted, partly_posted, check, failed, cancelled), the time, automatic, the claim, and `stop_kind`
  (cancelled, marketing_off: stopped partway, so nothing more is sent). Office staff with the
  marketing area read them; only the server writes them. `GET /social/posts?list=upcoming` orders
  them by `scheduled_for` (drafts, which have none, last) and pages after the last row's
  `scheduled_for`, `created_at` and id.
- `social_post_networks`: each network's state, attempts and tries, the id and link it was given, its
  error and kind, and the steps safe to use again (unpublished photos, Instagram containers, and the
  picture links they were made from).
- `social_post_images`: each post's pictures at their random-token link, until they expire. The
  server's alone.
- `companies.settings.social`: `{ auto: { enabled, networks } }`, written only by `social_set_auto`.
  The `meta` integration's settings: the Page and Instagram account, the permissions granted and
  declined, `live_confirmed_at` (the one setting kept when it's disconnected), `data_access_expires_at`,
  `access_notice`; its secret keeps the app's keys (a Configuration ID too), the person's long-lived
  token and the Page's token.

## Build order

| Phase | Ships | Needs |
| --- | --- | --- |
| A. The app and review reminders | **Crewtavo - Marketing** in Apps, the sidebar switch, the Reviews form, reminders, quiet hours, 6-month limit, invoice-paid and visit-completed asks, the recurring visit count, per-client opt-out, STOP | The recurring-work fix, committed |
| B. Referral credits | Credits earned and applied, the automatic referral ask, lost, the Referrals numbers | A |
| C. Automated campaigns | The three automated campaigns, the daily inactive-client trigger, new audiences, opens, clicks and revenue | A |
| D. Google reviews (built) | The Google Business Profile app, reviews in Crewtavo, suggested replies, alerts, stopping asks once reviewed | A, and Google's approval |
| E. Social posting (built) | The Facebook & Instagram app, OK to share, posts and scheduling, posting to Google, automatic 5-star posts, review cards | A (better with D) |

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
- **Opens are counted honestly:** a mail scanner or a text's link preview opening the link doesn't
  stop the reminders or count as opened.
- **Review texts are shorter and say how to stop them:** a short link, and "Reply STOP to opt out." at
  the end of each text ask and reminder.
- **Turning reminders off says how many waiting reminders it stops** before it saves.

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
- **An invoice a credit covers whole** says it was covered by a referral credit, and the office isn't
  told it was paid $0.00.
- **Referral ask emails** show the client's own link as **Your referral link**, written out under the
  button to copy.

## Release notes for phase C

- **Automated campaigns** on **Marketing → Campaigns**: **Re-engage past clients** emails clients a year
  after their last visit (or the time you choose), **Win back lost quotes** emails a client 30 days
  after a quote is marked lost, and **Close pending quotes** is the quote follow-up every business
  already has, now with its own card. The first two are off until you turn them on. **Edit email**
  changes the days and the email, with a preview and a test.
- **Re-engage sends at most 100 a day** for each rule, newest first, and asks before emailing the
  clients who already qualify (and asks again each time it's turned on). A client gets it at most once every 6 months, never while you're
  working with them or for 6 months after a quote, and not if their last visit was over 3 years ago.
  Conditions you add to its rule in Automations count in its numbers too.
- **Close pending quotes isn't marketing:** it keeps going while Marketing is uninstalled and reaches
  clients who unsubscribed from marketing, as it always has.
- **Results for every campaign:** sent, opened, clicked, bookings and revenue, on each campaign and
  card, with who got it and what each did. Opens are approximate.
- **More audiences:** city, services on past jobs and recurring work, picked from lists that say how
  many clients have each.
- **A changed wait moves follow-ups still waiting,** on any automation rule.
- **Uninstalling Marketing** stops automated campaigns too; links and images already sent keep working.
- **A busy email service doesn't lose emails:** automated campaign emails Resend turns away for now are
  tried again by themselves.
- **Write with AI** drafts include the Client Hub link, so their clicks and bookings are counted.
- **A campaign stopped partway says what went** ("Stopped · 3 of 10 sent"), whether it was stopped on
  its page or by uninstalling Marketing, campaigns stopped before this included.

## Release notes for phase D

- **Google reviews in Crewtavo,** with the new **Google Business Profile** app in Apps (it needs
  Crewtavo - Marketing). Google approves each Crewtavo server's access to reviews first: your
  Business Profile has to have been verified for 60 days or more, and Google takes about 2 weeks.
  Sign in any time: the app waits on Google, says so, and starts once Google approves. Review asks
  keep working meanwhile. Apply early for crm.brrhi.com's Google Cloud project.
- **Servers that already use Google Calendar sign-in** add the new redirect address
  (`…/api/apps/google_business/callback`), the `business.manage` scope and the three Business Profile
  APIs to their Google Cloud project before signing in. The app's **Before you sign in** lists them.
- **Marketing → Reviews** shows your reviews: Google's average and count, the response rate, time to
  reply, a monthly trend and asks that led to a review, then every review with its stars, words,
  matched client and reply.
- **Reply from Crewtavo,** posted publicly on Google after you confirm, with **Suggest a reply** to
  start from (it needs a Claude key).
- **Google reviews notifications:** new reviews by push and email, low ratings first; the email
  carries only 1 and 2 stars. Your Google reviews' first sync sends one "Your Google reviews are in"
  instead of a notification for every old review.
- **Asks stop for clients who already left a Google review,** matched by name, reminders included.
  **Not this client** undoes a wrong match and asks can go again, with their reminders; so does a
  review deleted on Google or removed. A match you made or undid holds if the review is removed and
  comes back.
- **Disconnecting keeps the reviews** already brought in, unless you tick the box to remove them.
  Installing it again picks up where it was, or asks you to pick a location when the Google account
  you sign in with doesn't have that one.
- **Sign in with another Google account** from the app page, for a Google account that doesn't manage
  your Business Profile.
- **Match to a client…** shows each suggestion's email, phone or address, so two clients with the same
  name are told apart.

## Release notes for phase E

- **OK to share on photos.** Crews tap the corner of a visit photo, and the office marks them on a job's
  or client's new **Photos** card (**Mark all OK to share** does a whole job), so the office can post
  them. It works without signal on a job, and a client's page has **Can be posted on social pages** for
  anyone who'd rather not. HEIC and WebP photos can't be posted yet: JPEG and PNG can.
- **Facebook & Instagram** in Apps (it needs Crewtavo - Marketing). Make your own Meta app in about ten
  minutes with the guide on its page, sign in, pick your Page and its Instagram account, then **switch
  your Meta app to Live**: until it's Live, nobody but you sees the posts. You'll need a privacy page
  on your website that says how to ask for data to be deleted.
- **Marketing → Social:** post photos OK to share, a 4 or 5-star Google review as a picture, or words
  alone, now or at a time you pick, with **Suggest a caption**. Each post shows its link on each network
  or what went wrong, and posts that started never post twice. **Share elsewhere** takes the pictures
  and caption anywhere else, like X, LinkedIn or Nextdoor. **Post on social** is on a review's menu, and
  **Post these photos** on a job's Photos card.
- **Post 5-star reviews automatically** (off until you turn it on): new 5-star reviews with words post
  at 10 AM, 1 PM or 4 PM, at most 3 a day, with time to change or cancel each one.
- **Google posts** go to your Business Profile once Google Business Profile is approved.
- **Cloudflare (crm.brrhi.com):** allow `/api/public/social/*` past bot protection, so Meta's and
  Google's crawlers can fetch the pictures.
- **Uninstalling Marketing** puts scheduled posts back to drafts and stops one partway through.
- **Photos and review cards need Crewtavo at a public https address,** since Meta and Google fetch
  them from it. On a local or office-only address, Marketing → Social says so before you post: words
  alone still post, and **Share elsewhere** works for the rest.
- **Posts never go twice.** A post Meta or Google may have made (no answer, or an unclear one) is
  **Unconfirmed** until you check: your Page, your Instagram account or your Business Profile. A post
  you cancel while it's posting never goes later.
- **Scheduled review posts survive reconnecting:** a review removed and brought in again is the post's
  again.

## Release notes for promo code fixes

Built in `20261031000600_promo_once_per_job.sql`, `20261031000610_promo_bank_payments.sql`,
`20261031000620_website_form_promo.sql`, `20261031000630_promo_undo_and_signed_rule.sql` and
`20261031000640_void_draft_not_sent.sql`, with `packages/core/src/promos.ts` and the job page's note
(`apps/web/src/features/jobs/JobDiscountNote.tsx`).

- **Promo codes come off once per job.** On recurring work a code now comes off the first invoice
  only, however invoices are made (one visit at a time, a batch of visits, or out of order), and a
  deposit, progress or retainage invoice never takes it, nor a draft with a payment, in Stripe or
  with a promo code of its own. If that invoice is voided or deleted before it's paid, or the code is
  taken off a draft, it goes on the next one. The question before voiding or deleting says so, and the
  toast says which invoice it moved to, or that it waits for the next. Taken off a draft, it never
  goes back on that draft by itself, but the toast's **Undo** puts it back there and takes it off the
  draft it moved to; once that invoice is sent, it stays there and Undo says so, as it does when the
  draft took a promo code of its own meanwhile. To keep it on every visit, turn on
  **Marketing → Promo codes** → a code → **Take it off every visit of recurring work**; the form says
  what each choice does, with the code's own value. Turning it on or off for a code that jobs already
  use asks whether to change those jobs too (**Change them too**, or **Change it too** for one job, /
  **Only new jobs**); closing that question saves nothing.
- **Existing codes are once per job now.** Repeating was almost certainly a mistake, so every code
  starts with the switch off. Recurring jobs that already took a code off an invoice don't take it
  again, a job with no invoices yet takes it once, and invoices already made keep what they have: a
  draft someone took the code off, or cut it on, keeps it that way. A change order's typed discount
  is never taken for its code's. The job page says which rule a job follows and where the code went,
  and **Take it off every visit instead** puts one job back the way it was. A job whose invoices were
  made while the code came off every visit (from before, or before its code or the job was switched)
  says so beside them: "It's on invoices #4, #5 and #6, made while it came off every visit. Later
  invoices don't take it." A recurring job's **Contract** and its **Job costing** price say they
  include the one-time discount.
- **A discount never takes an invoice below $0, and never comes off twice.** A visit priced under the
  code takes what it can, and the rest goes on the next invoice; an every-visit code comes off up to
  the visit's price, and comes back when the visit's price does (a line removed and put back, a price
  lowered and raised). Changing the **Taxable** box on a discount line, on the job or a draft, doesn't
  take it off again.
- **A promo code's line stays the code's.** Its price and quantity can't be typed (remove the line to
  take it off), and it has no **Duplicate**, since a copy would come off every visit.
- **Quotes say how a code comes off:** "Promo code WEEKLY25 · one-time discount" or "· off every visit",
  on the quote, its paper and the Client Hub. While the quote is open it follows the code's switch.
  Once the client approves it (or it's made a job straight away), it keeps the rule it was approved
  with (`quotes.promo_every_visit`), and so does the job made from it: switching the code later, or
  the job on its page, doesn't change what a signed quote says. Quotes approved before this said
  nothing about it, and still don't.
- **A code deleted before its quote becomes a job still comes off as the code said.** Deleting a code
  leaves its rule on the quotes still using it, so a recurring job made from one later takes the
  discount off its first invoice only (named **Discount**, since the code is gone), not every visit.
  A discount the office types over it is a plain discount again. Codes deleted before this left a
  typed discount, which can't be told from one the office typed.
- **One promo code to an invoice.** An invoice that has its job's code on a line doesn't take a second
  code on top, in the office (no **Add promo code**) or the Client Hub; the database refuses it too.
  The other way round, the job's code passes over a draft that has a code of its own and waits for
  the next draft without one, or the next invoice.
- **Website forms check promo codes.** A field named promo, promo_code, promocode, coupon, coupon_code
  or discount_code (in any case, with spaces or dashes) is checked. A valid code is ready to apply on
  the quote. One that isn't valid still keeps the request, and the request, the quote and the office's
  email say why.
- **Booking forms on your website pick up `?promo=`** from the page's link, so a link like
  yoursite.com/quote?promo=SPRING15 fills in the code. **A form already on your site needs the code
  copied again** from **Online booking → Embed** and pasted over the old one: the old code doesn't hand
  on `?promo=`. On Wix, GoDaddy and Google Sites, which put the code in a frame of its own, share the
  form's own link with `?promo=` and the code on the end instead. `utm_*` isn't handed on: the form
  doesn't read it, and with Website Analytics installed a booking is already linked to the visit that
  brought it in, campaign link included (`bookingVisit`).
- **Stripe invoices ignore coupons on a Stripe customer,** so clients pay exactly what Crewtavo billed.
  Coupons you attached to a customer in Stripe no longer come off Crewtavo invoices. Use a Crewtavo
  promo code instead.
- **Promo codes can't change while a bank payment is clearing,** on the invoice page and in the Client
  Hub. One still clearing in a Stripe account Crewtavo has since left holds it up for 30 days at most,
  as it holds up **Pay**.
- **A draft voided isn't "Sent".** Voiding a draft gave it a sent date; it no longer does. Invoices
  voided before keep theirs.
- **Still to do:** the embedding page on crewtavo.com (in crewtavo-website) needs the `?promo=` line and
  the note about pasting the code again, and Stripe's `discounts` and `discountable` were checked in its
  current API reference but not against the pinned `2024-06-20` version in test mode.

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
