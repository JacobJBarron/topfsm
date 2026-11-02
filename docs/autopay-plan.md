# Autopay: a card on file, charged when the work is done: plan

Proposed 31 October 2026. The first answers are under [Decided](#decided).

## The short version

- A client saves a card or bank account once, from a Client Hub page that explains what will be
  charged, when, and how to stop it. Stripe checks the card with the bank before it's saved. The
  client's agreement is kept with the exact words they agreed to.
- When a technician taps **Complete** on a visit (or the office marks a one-off job's work
  complete), the server bills it. Crewtavo makes the invoice it makes today. Then, instead of
  emailing a Pay link, Stripe charges the saved card and the client gets a receipt. A short wait
  (the end of the day by default) lets the office catch a wrong tap first.
- A charge that fails falls back to what happens today: the invoice is owed, the client gets the
  Pay link with a way to update their card, and the office is told.
- Everything goes through the company's own Stripe account and the Stripe invoices Crewtavo
  already makes, so fees, deposits, refunds and the books work as they do now. Cards saved in
  Stripe before Crewtavo can be brought in.
- An unhappy client gets a refund, now from a **Refund** button in Crewtavo rather than only in
  Stripe's dashboard. Tips move to the receipt, since autopay skips the Pay screen they sit on.
- It's for every trade, not only lawn care. Lawn & exterior companies get it switched on for
  recurring jobs by default. Big one-off jobs get a cap and the office's OK.
  See [Lawn care only?](#lawn-care-only).
- Build order: the Stripe key and tables, then saving a card, then charging on completion, then
  failed charges, then bringing in cards already in Stripe, then the office's screens and
  automations.

## What the code does today

**Every Stripe invoice waits for the client to pay it.** `createStripeInvoice` makes it with
`collection_method: "send_invoice"` and `auto_advance: false`
(`apps/api/src/integrations/stripe.ts:414-460`). Crewtavo emails the invoice. The Client Hub's Pay
button opens Stripe's hosted page for it (`stripeCheckout`, `stripe.ts:584`; `POST /hub/:token/pay`,
`apps/api/src/routes/public.ts:671`). Nothing saves a payment method: there's no SetupIntent, no
`off_session`, and no payment method column anywhere.

**Each client already has a Stripe customer.** `customerFor` (`stripe.ts:392`) finds one by email
or makes one, and keeps the link in `sync_links`. Saved cards can hang off that customer, and
customers someone already has in Stripe are found by email.

**The company's Stripe key can't save or charge cards.** The key form asks for
`webhook_write, customer_write, invoice_write, charge_read, balance_read,
balance_transaction_source_read, payout_read, connected_account_read`
(`apps/web/src/features/apps/AppDetailPage.tsx:53`). Every company that's connected needs a new
key with more permissions. Connecting a new key already updates the existing webhook's events
(`sameWebhook`, `stripe.ts:229`), so a new key also brings the webhook up to date.

**Crewtavo has no publishable key.** Companies give a secret key only. Stripe's embedded card form
(Elements) needs a publishable key in the browser. Stripe Checkout in setup mode doesn't: the
server makes the page and the client is sent to it, as with Pay today.

**Completing a visit works offline and reaches the server later.** The tap is queued on the phone
and sent when there's signal (`setVisitStatus`, `apps/web/src/features/field/fieldActions.ts:64`;
`lib/offline.ts`). The status change fires `visit.completed` in the database
(`private.activity_visits`, `supabase/migrations/20261017000100_activity_notifications_search.sql:108`).
So the charge has to start on the server, from the database, and never from the phone.

**Billing a job's finished work is already one call.** `create_invoice_for_job(p_job, 'visits')`
bills a per-visit job's completed visits that aren't on an invoice yet. `'standard'` bills a
finished one-off job. `invoiceJobs` calls it for the batch screen (`apps/api/src/services/sales.ts:282`).
A visit is billed only once, because billing it sets `visits.invoice_id`. The function is
`security invoker`, so the server can call it as admin.

**Jobs already say how they're billed.** `jobs.billing_mode` is `per_visit`, `on_completion`,
`fixed_schedule` or `progress` (`supabase/migrations/20261016000200_operations.sql:288`). The
assistant makes recurring jobs `per_visit` (`apps/api/src/assistant-tools/jobs.ts:392`).

**Payments from Stripe are recorded in one place.** Webhooks record a paid Stripe invoice with
its fees (`recordPayment`, `stripe.ts:699`). `invoice.payment_failed` is handled only for bank
payments that bounced (`bankPaymentFailed`, `stripe.ts:749`; `handleStripeEvent`, `stripe.ts:834`).

**The background jobs already have the pieces.** There's an outbox every 5 minutes with backoff and
up to 8 tries (`drainOutbox`, `apps/api/src/tasks.ts:98`) and an hourly upkeep (`tasks.ts:262`). The
upkeep is where expiring cards get flagged, as equipment maintenance is (`20261017001900_equipment.sql`).

**Crews never see prices**, and the database enforces it (`20261017001200_crew_job_privacy.sql`).
The field app may say a client is on autopay but never shows the amount.

**Switching Stripe accounts settles the old account's invoices** (`leaveAccount`, `stripe.ts:273`).
Saved cards belong to one Stripe account and one mode (test or live) and can't follow.

## How it works

### 1. The office turns it on

1. **Apps → Stripe:** "Update your key to turn on autopay." The same create-key link, with more
   permissions. Like the ones today, the names have to be checked against Stripe's form:
   `setup_intent_write`, `payment_method_write`, `payment_intent_write`, `checkout_session_write`,
   `refund_write`.
   Saving the key updates the webhook with the new events (below).
2. **Settings → Payments → Autopay**, with a short checklist:
   - **Terms.** The text clients agree to, from a starter for the company's trade. The lawn one
     reads: "We charge the card on file after each visit is done, and for other invoices we send
     you. You'll get a receipt each time. Turn it off anytime from your client page or by calling
     us." Every trade's starter says the card is also charged for other invoices, which is what
     lets the office use [Charge card](#9-charge-card).
   - **When to charge:** right away, at the end of the day (default), or a set number of days after.
   - **Most to charge without asking.** Over this, the office approves first. Blank means no limit.
   - **Whether to email receipts.**

   What clients may save isn't a Crewtavo setting. Checkout offers whatever payment methods are
   turned on in the company's Stripe dashboard that can be saved for later: cards, Apple Pay and
   Google Pay (which save a card), Link, and US bank accounts.
3. **Inviting clients:** a "Set up autopay" link by email or text. It goes to one client from their
   page, to many from the Clients list, or by automation (for example when a quote is approved).
   The email, "Set up autopay with (the business)", asks the client to save a card securely with
   Stripe, and its button reads **Save your card**. A client with a card brought in from Stripe
   gets "Confirm autopay with (the business)" instead: "We have your Visa ending 4242 on file. Tap
   below to confirm we can charge it after each visit", with a **Confirm autopay** button.
   Receipts and notices keep **Manage autopay**. The link is the same in all of them.

### 2. The client saves a card (the onboarding)

A Client Hub page, `/hub/:token/autopay`, reached from:

- the invite link;
- the client's Hub home ("Pay automatically" card);
- a paid invoice, when the client opens it again ("Paid. Pay automatically next time?", with no
  "this card": it may have been paid by check). Paying by hand ends on Stripe's own invoice page,
  which doesn't come back to the Hub, so the offer isn't at the end of paying;
- approving a quote for recurring work ("Approve and set up autopay").

The page has three short steps:

1. **How it works.** In plain words: what gets charged, when, the receipt that follows each charge,
   and how to stop it. It shows the company's terms, the next visit, and the price per visit if the
   job has one.
2. **Add a card or bank account.** The server makes a Stripe Checkout Session in `setup` mode for
   the client's customer, with `usage: off_session` and metadata naming the company, client and
   invitation. The client fills it in on Stripe's page. Crewtavo never sees the card number.
3. **Agree and finish.** The checkbox (unticked) with the terms. Then a confirmation: "Visa ending
   4242 is set up. We'll charge it after each visit." The client can also change the card, or turn
   autopay off.

**Making sure the card is valid.** Stripe confirms a setup with the client's bank. It may place a
small hold that it releases, and it asks for 3D Secure when the bank wants it. Doing this while the
client is there is what lets later charges go through when they aren't. On `setup_intent.succeeded`,
Crewtavo also:

- refuses a card whose CVC or postal-code check came back `fail`, and says why;
- sets it as the customer's default (`invoice_settings.default_payment_method`);
- saves the brand, last four, expiry, and the bank name for ACH.

A bank account is checked by Stripe instantly through the client's bank sign-in, or by
microdeposits. It can't be charged until it's verified.

The checkbox goes in when the setup comes back. The words, the terms version, the time, the IP and
the browser are kept in `autopay_authorizations`. Card networks require that agreement before a
business charges a saved card without the client there. It's also what wins a dispute that says
"I never agreed to this."

### 3. The technician taps Complete, and the card is charged

1. The visit becomes `completed` (or the office marks a one-off job's work complete). A trigger adds
   or moves an `autopay_charges` row for the job, due when the company's timing says. This happens
   only when the job has autopay on and the client has a usable saved card and an agreement still
   in force.
2. A new `autopay` task (every 5 minutes, alongside the outbox) claims the rows that are due:
   - It calls `create_invoice_for_job` (`visits` or `standard`). Nothing left to bill (the visit
     was reopened, or the office already invoiced it) means the row is called off.
   - Over the cap: the invoice waits as a draft for the office ("Approve charge"). It waits the
     same way, whatever the amount, when it bills visits autopay didn't queue itself: ones freed by
     voiding or deleting an invoice, finished while autopay was paused or off, or from before the
     client agreed. Autopay only charges without asking for visits finished while it was in force
     (a new card doesn't restart that). Under Stripe's minimum (`minimumCharge`): it's left for the
     next charge, or sent the usual way.
   - Otherwise it marks the invoice sent without emailing it. It makes the Stripe invoice with
     `collection_method: "charge_automatically"` and the saved card, and finalizes it.
   - It charges it with `POST /v1/invoices/:id/pay` and `off_session: true`. Idempotency keys
     (`crewtavo-autopay-<row>`) mean a retry never charges twice.
3. `invoice.paid` comes in and `recordPayment` books it as today. A receipt goes to the client and
   `payment.received` fires for automations. The receipt carries a fresh link to the client's Hub
   page. Hub links run out (120 days for the client's page, `apps/api/src/lib/links.ts:31`), and
   this way a client on autopay always has one that works for changing their card or turning it off.

**When a client isn't happy with a visit,** the office refunds it from the invoice, as it can
today. Stripe keeps its fee on a refund. The end-of-day wait is there so a visit tapped by mistake
is caught before it's charged.

Weekly or monthly billing (one charge for every finished visit since the last) would be a later
addition. It's left out of the first version: see [Decided](#decided).

**Why a Stripe invoice and not a bare charge.** Crewtavo's payment, fee, refund, dispute, deposit
and books code all work from Stripe invoices. One way for money to come in means autopay needs no
second copy of that code.

**What the crew sees:** an "Autopay" tag on the visit, no amount. The charge happens on the server
whatever the phone does, so a visit completed with no signal is charged once it syncs.

### 4. When a charge fails

| What Stripe says | What happens |
| --- | --- |
| Declined (`invoice.payment_failed`, `card_declined`, `expired_card`...) | The invoice stays owed. The client gets the Pay link and an "Update your card" link. The office is notified. Crewtavo tries again after 3 days, once. Two failures in a row pause autopay for that client until they update the card. |
| The bank wants the client to confirm (`invoice.payment_action_required`) | The client gets Stripe's page for that invoice to confirm it. No retry. |
| A bank payment is on its way (`payment_intent.processing`) | As today: "A bank payment is on its way". No reminders. A bounce later goes through `bankPaymentFailed`. Until it clears or bounces, the invoice can't be voided, moved back to draft or paid another way (it would be paid twice). One in a Stripe account the business has since left is theirs to follow there, as any bank payment there. |
| The card was removed in Stripe (`payment_method.detached`) | The card is marked removed and autopay pauses. The office is told. |
| The bank sent new card details (`payment_method.automatically_updated`) | The expiry or last four is updated. Nothing else changes. |

The Stripe account's own Billing emails ("Send emails about failed payments") would double up on
Crewtavo's. The Apps page says to turn them off.

### 5. Cards already in Stripe

For businesses already saving cards in Stripe: "Bring in your Stripe history"
(`importFromStripe`, `stripe.ts:1131`) also reads each matched customer's default payment method.
The Apps page then says: "14 clients have a card saved in Stripe." Two ways to use them:

- **Ask them (recommended).** A "Confirm autopay" link. The client sees the card ending 4242 and
  the terms, and taps once. There's no card to enter again.
- **The owner vouches for them.** For clients who already agreed with the business some other way.
  The owner ticks "These clients agreed to be charged automatically". That's kept as the agreement,
  with who ticked it and when. Owners only.

Cards set up for one-off payments may not be good for charges without the client there. A charge
that Stripe refuses for that reason falls through to the failed-charge path. The client then gets
the setup link.

**Moving over without charging twice.** Crewtavo already brings in invoices made in Stripe. A
client charged from Stripe's dashboard and from Crewtavo for the same visit would pay twice. So the
client page shows "Charged from Crewtavo since 3 November". Clients move over one by one, and the
business stops charging each one in Stripe from that day.

### 6. What changes in the Client Hub

Seen on a demo instance (31 October 2026) with a weekly-mow client. Today the Hub home lists
"Waiting on you" (quotes to approve, invoices with **Pay $45.00**), the next visit, Request work and
Message us, and Recent (visits done, payments "by card"). The invoice page has the bill, the
terms, **Add a tip for the crew?** and **Pay $45.00 by card or bank**.

| Where | Today | With autopay |
| --- | --- | --- |
| Home, client on autopay | An invoice card with **Pay** after every visit | No invoice card. A small card: "Paid automatically · Visa ending 4242", **Change card**, **Turn off** |
| Home, client not on autopay | Nothing about it | A **Pay automatically** card that starts the onboarding (if the company has autopay on) |
| Recent | "Payment on invoice #2 · $45.00 by card" | "Charged automatically to Visa 4242" |
| Invoice page | Tip, then **Pay** | "Paid automatically with Visa 4242 on Oct 27", or "Charged tonight" during the wait. **Add a tip** stays (below) |
| A paid invoice, opened again | The bill, marked paid | "Paid. Pay automatically next time?" (paying by hand ends on Stripe's own page, which doesn't come back here) |
| Approving a recurring quote | **Approve** | **Approve and set up autopay** |
| The office | **Copy Client Hub link** only (`apps/web/src/features/clients/ClientPage.tsx:204`) | **Send autopay invite** by text or email, one client or many |

### 7. Tips

The tip question sits just before Pay, which autopay skips. So:

- the receipt after each automatic charge says "Add a tip for the crew?", linking to the invoice
  page, which keeps its tip choices;
- a tip chosen there is charged to the saved card as its own small Stripe invoice. Crewtavo already
  books tip-only Stripe payments (commit `ad573b7`), and `stripeCheckout` already makes tip
  invoices;
- tips stay off unless the company has them on (`settings.hub_tips`), as today.

**Only the client's own links tip on the card or confirm with one tap.** Staff can copy links and
type any address into a send, so a link has to prove it's the client's before it can charge their
saved card for a tip, or confirm a card they didn't save through that link (section 5). Links
minted from this build carry a mark (`own: 1`) when they go to the client's own email or phone on
file: a quote or invoice sent to them, the autopay invite, receipt and notice, the copy of their
agreement, an automation's email or text to them, and any link the Hub makes from one of those. A
send typed to any other address carries the office's copy instead. A link without the mark (every
link from before this build, and every office copy) still approves, signs, pays and sets up
autopay through Stripe's page, but counts as the office's for those two: no tip on the saved card,
and a card saved through one is kept as saved by the office (`saved_via`).

### 8. Refunds from Crewtavo

Today a card payment is refunded in Stripe's dashboard, and the refund shows up in Crewtavo when
Stripe reports it (`apps/web/src/features/invoices/InvoicePage.tsx:279`). Refunds are how a business
on autopay handles an unhappy client, so the invoice page gets **Refund** for Stripe payments:

- all of it or part of it;
- `POST /v1/refunds` on the charge, with an idempotency key;
- it's recorded the way it is today, from `charge.refunded`.

The Stripe key needs `refund_write` for this.

### 9. Charge card

The office can also charge an unpaid invoice to the client's saved card straight away, on top of
autopay's own charge after each visit:

- **Charge card** on the invoice page charges that one invoice. It counts a draft too (it's marked
  sent, without an email, once charged).
- **Charge cards** on the Invoices list shows every sent invoice that's owed and whose client has a
  card they agreed to, newest first, and charges the ones picked, 50 to a request. An invoice with
  something collecting it already is shown with what that is (being charged now, waiting on the
  client, autopay will try it again, waiting for your OK, a bank payment on its way), and can't be
  picked.

Who can press them: owners, admins and office staff with the invoices area, while autopay is on and
the Stripe key can charge cards. Crews, estimators and subs can't, and never see the list. Each
press is noted in the activity: who, which invoice, how much and which card.

It's an autopay charge like any other, so the receipt, the guards against paying twice and the
webhooks work the same. It goes past the cap, since the office pressed it. It isn't offered while
Stripe is collecting the invoice: a bank payment on its way, or an invoice made in Stripe that's
open there.

**The confirmed amount.** The office confirms the amount it sees, and that's the most that's
charged. If what's owed changed by the time the press arrives (a line was edited), nothing is
charged and it says "The amount changed to $60.00. Check it and try again". If the invoice grows
after that, before the card is charged, the charge is called off and the office is told to charge
it again.

**No retry after a decline.** A declined Charge card isn't tried again by itself. The client gets
the notice with the Pay link and a way to update their card at once, and the office is told. One
decline the office asked for doesn't pause autopay for the client. A card they agree to after that
is charged straight away.

After a refund, an invoice that's owed again can be charged again. Only that charge's own Stripe
invoice counts as paid by the card: if the client pays on Stripe's page instead, it was paid
another way, and no receipt goes.

## The Stripe side, in one place

| Step | What's used in Stripe | In Crewtavo today |
| --- | --- | --- |
| Connect | A restricted key with the added permissions. Crewtavo's webhook, updated with the new events | `connectStripe`, `sameWebhook` (`stripe.ts:139`, `:229`) |
| One customer per client | Customer | `customerFor`, `sync_links` (`stripe.ts:392`) |
| Save a card | Checkout Session in `setup` mode, which makes a SetupIntent (`usage: off_session`) and a PaymentMethod. That becomes the customer's `invoice_settings.default_payment_method` | New |
| Check the card | The SetupIntent confirmed with the bank, 3D Secure when it asks, `card.checks` for CVC and ZIP | New |
| Charge | Invoice with `collection_method: charge_automatically`, finalized, then `POST /v1/invoices/:id/pay` with `off_session: true` | `createStripeInvoice` makes `send_invoice` ones (`stripe.ts:414`) |
| Record it | `invoice.paid` with its charge and fees, then payouts | `recordPayment`, `savePayout` (as today) |
| Failed | `invoice.payment_failed`, `invoice.payment_action_required` | Only bank payments that bounce (`bankPaymentFailed`) |
| Tip later | A tip-only invoice on the saved card | Tip-only payments are booked already |
| Refund | `POST /v1/refunds`, then `charge.refunded` | Refunds are recorded, but only issued in Stripe's dashboard |
| Card changes | `payment_method.automatically_updated`, `payment_method.detached` | New |
| Cards already saved | Each customer's default payment method, read on import | `importFromStripe` (`stripe.ts:1131`) brings in invoices and customers |

Everything stays in the business's own Stripe account. Saved cards belong to that account, not to
Crewtavo, so a business that leaves Crewtavo keeps its customers' cards in Stripe.

## What changes

**Tables** (each with `company_id`, RLS like `payments`, no crew access):

- `client_payment_methods`: `client_id`, `stripe_payment_method_id`, `stripe_account`, `livemode`,
  `type` (`card` / `us_bank_account`), `brand`, `last4`, `exp_month`, `exp_year`, `bank_name`,
  `status` (`active`, `needs_update`, `removed`), `is_default`.
- `autopay_authorizations`: `client_id`, `payment_method_id`, `terms` (the text as shown),
  `terms_version`, `accepted_at`, `ip`, `user_agent`, `source` (`hub`, `confirmed`, `owner`),
  `recorded_by`, `revoked_at`, `revoked_by`.
- `autopay_charges`: `client_id`, `job_id`, `invoice_id`, `due_at`, `status` (`waiting`,
  `needs_approval`, `charging`, `paid`, `failed`, `needs_client`, `called_off`), `attempts`,
  `last_error`.
- `jobs.autopay` (default from the client, on for new recurring jobs in the lawn preset).
- `stripe_invoices.collection` (`send_invoice` / `charge_automatically`).
- `companies.settings.autopay`: terms, timing, cap, receipts.

**Stripe events** added to `STRIPE_EVENTS`: `checkout.session.completed` (setup mode; already
listened for), `setup_intent.succeeded`, `setup_intent.setup_failed`, `payment_method.detached`,
`payment_method.automatically_updated`, `invoice.payment_action_required`, `mandate.updated` (ACH).

**API:** `POST /hub/:token/autopay/setup` (makes the setup page; rate-limited like `/pay`),
`POST /hub/:token/autopay/confirm` (the agreement), `POST /hub/:token/autopay/off`.
Office routes: invite, pause, remove card, approve charge, Charge card (`POST /invoices/charge`, `GET /invoices/chargeable`).

**Automations:** new triggers "Autopay is set up", "An autopay charge fails" and "A saved card
expires next month" (hourly upkeep). A new action, "Invite to autopay". The existing
`payment.received` and `invoice.paid` fire for autopay charges as for any other.

**Screens:** the client page's Autopay card (method, agreed when, invite, pause, remove). An autopay
switch on the job page. Settings → Payments → Autopay. "Autopay failed" and
"Needs approval" on Invoices and on Home. The Hub's autopay page. The tag on the field visit.

**Switching Stripe accounts or mode:** saved cards from the old account are marked `removed`,
autopay pauses, and the office is told which clients need to set it up again.

## Build order

| Phase | What | Size | Done when |
| --- | --- | --- | --- |
| A | Key permissions and the "update your key" prompt, the new webhook events, the tables and RLS, the settings | Small, ~700 lines | A company can update its key, and pgTAP tests show crews can't read any of it |
| B | The Hub autopay page: setup-mode Checkout, the checks, the agreement, turning it off. The Hub home's autopay card, "Pay automatically next time?" on a paid invoice opened again, **Approve and set up autopay**, **Send autopay invite**. Lawn starter terms (below) | Medium, ~1,400 | A test card saves, a card that fails its checks is refused, and the agreement is kept |
| C | Charging on completion: the trigger, `autopay_charges`, the task, the cap, receipts, and the Hub's "Paid automatically" states | Medium, ~1,100 | A visit completed offline is charged once after it syncs, and a reopened visit isn't charged |
| D | Failed charges: retries, confirmation by the client, pausing, notices. **Refund** from the invoice page | Small, ~900 | Stripe's test cards for declines and 3D Secure each end where the table says. A refund from Crewtavo shows up in Stripe and back |
| E | Cards already in Stripe: import, "Confirm autopay", the owner's checkbox, the date each client moved over | Small, ~500 | An imported customer's card is charged after one tap |
| F | Tips on the receipt, the automations, the office's lists, the field tag | Small, ~800 | A tip added from a receipt is charged to the saved card. "Autopay failed" shows on Home and the invoice list |

A business with cards already saved in Stripe gets the most from E. It can go right after D, before
the Hub page in B is polished.

## Rolling it out to a business that charges by hand in Stripe today

1. **Try it in Stripe's test mode first.** Connect a test key to a test copy of Crewtavo. Complete a
   visit for a test client with `4242…`, then with `4000 0000 0000 0341` (saves, then declines).
2. **Update the live key** on the Apps page. Crewtavo updates its webhook in the same step.
3. **Turn autopay on** in Settings → Payments: lawn terms, "end of the day", a cap, receipts, tips.
4. **Bring in the Stripe history.** Clients are matched to Stripe customers by email, and Crewtavo
   lists the ones with a card saved.
5. **Move clients over.** Send "Confirm autopay" texts, or tick the owner's box for clients who
   agreed already. Each client's page shows the day they moved. Stop charging that client in
   Stripe's dashboard from then on.
6. **New clients** get **Approve and set up autopay** on their quote, or an invite from their page.
7. **For the first weeks,** watch "Autopay failed" on Home. Check each day's charges in Stripe
   against the visits completed.

**Tests,** as for Stripe today: Vitest for the webhook handlers and the task with Stripe stubbed
(`apps/api/test/stripe.test.ts`), pgTAP for the trigger, the RLS and charging only once
(`supabase/tests/`), and a Playwright run in Stripe test mode (`e2e/billing.spec.ts`): save
`4242…`, complete a visit, see it paid. Stripe's `4000 0000 0000 0341` saves fine and then declines,
which covers phase D. `4000 0027 6000 3184` asks for 3D Secure every time.

## How big it is

About 4,500 to 5,500 lines with tests, across 40 to 50 files and 3 or 4 migrations. For scale:

- **Running invoices through Stripe** was 2,222 lines in its first commit (`f6238eb`). It came to
  about 4,300 lines on the Stripe files after eight follow-ups for money edge cases.
- **Subcontractors** came to about 27,800 lines and **Drive** to about 21,700.

So autopay is about the size of the Stripe work. Like that work, most of the risk is in the money
edge cases, not the screens: charging twice, charging the wrong amount, a webhook that comes late
or twice, a visit reopened after it was billed. That's where the tests go.

## Lawn care only?

Build it for every company, and switch it on by default where it fits best.

- **The code doesn't know about trades here.** Billing follows the job (`billing_mode`, recurring
  or not), not the company's `trade_preset`. A lawn-only version would add a special case in every
  place this touches, for no gain.
- **The same need is everywhere recurring work is:** mowing, but also landscape maintenance,
  snow per push (Crewtavo already makes on-demand visits for snow and storm cleanup), and
  window, gutter or pressure washing. Any of these can run on the `general` or `lawn_exterior`
  preset today.
- **Paving and roofing want it differently.** For them it's for the deposit and the final balance
  on a big job. Large charges without the client there are declined and disputed more often. So
  for those trades it's off by default, the cap matters, and charges over it wait for the office.
- **Where the trade does matter is the defaults.** In the `lawn_exterior` preset
  (`packages/core/src/presets/lawn_exterior.json`) autopay is on for new recurring jobs, the
  terms say "after each visit", and the Hub's copy talks about visits. The other presets get their
  own starter terms and leave it off.

## Found along the way

- **Every trade gets the same document terms.** `DEFAULT_TERMS` (`packages/core/src/documents.ts:64`)
  talks about deposits and the manufacturer's warranty on materials. A lawn company's invoices show
  it too. Phase B gives each preset its own starter. The lawn one says payment is due after each
  visit, or charged to the card on file with autopay. The contract starters already differ by trade
  (`packages/core/src/contracts.ts:332`). The document template doesn't.
- **The office can only copy a client's Hub link,** not send it. Phase B's **Send autopay invite**
  covers autopay. A general "Send Client Hub link" could ride along.

## Not in this plan

- Charging a card fee (surcharging). The rules differ by state and card brand.
- Fixed monthly plans that charge the same amount whether or not a visit happened
  (`billing_mode = 'fixed_schedule'`). That's Stripe subscriptions, and its own plan.
- Card readers in the field (Stripe Terminal).
- Stripe Connect for the hosted version. This plan works with each company's own key and with the
  server's shared key.

## Decided

31 October 2026:

1. **Charge after each visit.** That's how lawn businesses on Stripe charge today: by hand, one
   charge per visit from the dashboard, on a card already saved there. Weekly and monthly billing
   are left out of the first version.
2. **Payment methods: whatever Stripe supports.** Cards are the usual case. Checkout offers what's
   turned on in the Stripe dashboard, so there's no Crewtavo setting for it.
3. **No hold from the field.** A client who isn't happy gets a refund from the invoice. The
   end-of-day wait covers visits tapped by mistake.
4. **Cards already saved in Stripe matter most,** so phase E gets built early (see
   [Build order](#build-order)), along with moving clients over one by one so no visit is charged
   twice.
