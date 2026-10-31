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
`apps/api/src/routes/googleReviews.ts`, Apps → Google Business Profile, Marketing → Reviews). Phase E isn't. This is the plan.

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
    A click in the first 30 seconds after sending, or a HEAD request, is a link scanner's and isn't
    counted; scanners that click later, like Defender Safe Links, still are.
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
    area), and the campaign page lists who got it and what each did, a page at a time to the last,
    narrowed to **Opened**, **Clicked** or **Booked** when asked, so the one who booked isn't on page
    three. Their pills grow stronger with each step: **Sent** grey, **Opened** blue, **Clicked** green.
    A sent one-off campaign shows its numbers across the page, and its preview greets someone who got it.
  - Each card is short: when it goes, emails waiting, what it brought in, and **Who gets it** folded
    away. A switch that can't be turned on without email says so on the card, and **Send a test** says
    so in Edit email, where a test that went says so too, not in a toast over the dialog's buttons.
    While a card's numbers load it shows a placeholder, and a retry if they don't. Marketing's
    overview adds revenue from campaigns, and the Referrals card what referred clients paid.
  - **Office staff without the Automations area** see each card's state, on or off, and when it goes
    from its rule (`automated_campaign_states`), with its results, not its switch.
  - **Tracked links and pixels keep working while Marketing is uninstalled.** One-off and automated
    emails without a link say "Add a link so clicks and bookings can be counted"; one-off campaigns
    gain a **Client Hub link** token for that.
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
    **Not syncing** meanwhile. A reply Google doesn't take says so the same way.
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
  the old location's reviews after a confirm that says how many, and asks start again for their
  clients, reminders included. Reviews are kept by Google's location and review ids, so the same
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
    use, nothing in the way and Marketing on. The tab checks every 5 seconds while a sync runs, and
    every 30 between the first sync's runs; never while it's waiting on Google or a person.
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
  - **Match to a client…** and **Not this client** on each review. An undo sticks: that review is
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
- Automations:
  - a trigger `client.inactive`, checked hourly from 10am, and a condition `days_since_visit`
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
- Phase E adds `social_posts` and `attachments.shareable`.

## Build order

| Phase | Ships | Needs |
| --- | --- | --- |
| A. The app and review reminders | **Crewtavo - Marketing** in Apps, the sidebar switch, the Reviews form, reminders, quiet hours, 6-month limit, invoice-paid and visit-completed asks, the recurring visit count, per-client opt-out, STOP | The recurring-work fix, committed |
| B. Referral credits | Credits earned and applied, the automatic referral ask, lost, the Referrals numbers | A |
| C. Automated campaigns | The three automated campaigns, the daily inactive-client trigger, new audiences, opens, clicks and revenue | A |
| D. Google reviews (built) | The Google Business Profile app, reviews in Crewtavo, suggested replies, alerts, stopping asks once reviewed | A, and Google's approval |
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
