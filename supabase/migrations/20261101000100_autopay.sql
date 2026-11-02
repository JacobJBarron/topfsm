-- Autopay (docs/autopay-plan.md): a client saves a card or bank account once, agrees to be charged,
-- and each finished visit (or a one-off job's finished work) is billed and charged to it on the
-- server, after the company's wait. A charge that fails falls back to the Pay link.
--
--   client_payment_methods   cards and bank accounts saved in the company's Stripe account
--   autopay_authorizations   each client's agreement, with the words they agreed to
--   autopay_charges          a charge queued, waiting for the OK, being made, or done
--   jobs.autopay             whether a job is charged automatically
--   stripe_invoices          .collection (send_invoice | charge_automatically), .purpose (invoice | tip)
--   settings.autopay         the company's terms, timing, cap and receipts (autopay_set_settings)
--
-- How a charge goes. A crew's Complete tap (or the office marking a one-off job's work done) queues
-- a row for the job, due when the company's timing says (autopay_queue, from the visit and job
-- triggers). The 5-minute autopay task (apps/api/src/services/autopay.ts) claims what's due
-- (claim_autopay_charges), has it billed here (autopay_bill: create_invoice_for_job, then the cap
-- and the office's OK), marks the invoice sent once Stripe has its charge_automatically invoice
-- (autopay_mark_sent), charges it in Stripe and says how it went (finish_autopay_charge). The money
-- math stays here, in one transaction per step; Stripe is only ever asked from the server.
--
-- Everything that tells someone something (the receipt, the notice of a failed charge, the office's
-- notifications, the autopay.failed activity) happens in one place, the charge's status trigger,
-- once per change of status, whatever retried. Crews, field crew, crew leads and subs never read
-- any of it: the three tables are for owners, admins and office staff with the invoices area, and
-- the field app asks visit_autopay, which answers yes or no and nothing else.
--
-- Nobody signed in writes these tables: the server (service role) and the functions below do.

-- ---------------------------------------------------------------------------------------------
-- Saved payment methods
-- ---------------------------------------------------------------------------------------------

-- pending: a bank account waiting on microdeposits. needs_update: declined twice, a bank payment
-- bounced, or the bank's mandate went inactive. removed: taken off (by the client changing card, the
-- office, Stripe, a failed check, or the company leaving that Stripe account), and never back: a new
-- setup always makes a new pm_ id. Only the method the client's agreement in force names is charged,
-- and only while it's active (autopay_ready); is_default is for display and Stripe's default.
create table public.client_payment_methods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid not null,
  stripe_payment_method_id text not null check (length(stripe_payment_method_id) between 3 and 255),  -- pm_...
  stripe_customer_id text not null check (length(stripe_customer_id) between 3 and 255),              -- cus_...: the only customer it can be charged on
  stripe_account text check (length(stripe_account) <= 255),   -- acct_...; null when the key can't read it (as stripe_invoices)
  livemode boolean not null,
  type text not null check (type ~ '^[a-z0-9_]{1,40}$'),           -- Stripe's type: card, us_bank_account, link, ...
  brand text check (length(brand) <= 40),                       -- visa, mastercard, ...
  wallet text check (length(wallet) <= 40),                     -- apple_pay, google_pay, ...
  last4 text check (last4 ~ '^[0-9]{4}$'),
  exp_month smallint check (exp_month between 1 and 12),
  exp_year smallint check (exp_year between 2000 and 2200),
  bank_name text check (length(bank_name) <= 120),
  status text not null default 'active' check (status in ('pending', 'active', 'needs_update', 'removed')),
  is_default boolean not null default false,
  source text not null default 'hub' check (source in ('hub', 'stripe_import')),
  -- The kind of Hub link it was saved through ('office': one the office copied; 'legacy': one made
  -- before links were marked as the client's own). A card only an office link saved can be agreed
  -- to from an office link: the office had it in hand. One an unmarked link saved, only from a link
  -- like it (or the client's own).
  saved_via text not null default 'client' check (saved_via in ('client', 'office', 'legacy')),
  removed_at timestamptz,
  removed_reason text check (removed_reason in ('client', 'office', 'stripe', 'account', 'checks', 'replaced')),
  expiry_alerted_for date,                                      -- the expiry month last alerted (emit_card_expiry_alerts)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_payment_methods_company_id_id_key unique (company_id, id),
  constraint client_payment_methods_stripe_key unique (company_id, stripe_payment_method_id),
  constraint client_payment_methods_client_fkey foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade
);
create unique index client_payment_methods_default_idx on public.client_payment_methods (client_id) where is_default and status <> 'removed';
create index client_payment_methods_client_idx on public.client_payment_methods (company_id, client_id);

-- ---------------------------------------------------------------------------------------------
-- Agreements
-- ---------------------------------------------------------------------------------------------

-- Kept as they were made: only pausing, resuming and turning off change one
-- (autopay_authorization_guard). At most one in force (not turned off) per client.
create table public.autopay_authorizations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid not null,
  payment_method_id uuid,
  terms text not null check (length(terms) between 1 and 5000),          -- the whole text as shown: private.autopay_terms_shown
  terms_version text not null check (length(terms_version) between 1 and 40),
  accepted_at timestamptz not null default now(),
  ip text check (length(ip) <= 100),
  user_agent text check (length(user_agent) <= 500),
  source text not null check (source in ('hub', 'confirmed', 'owner')),
  link_kind text check (link_kind in ('client', 'quote', 'invoice')),   -- the Hub link it was agreed on (null for 'owner')
  link_via text check (link_via in ('client', 'office')),               -- 'office': a link copied by the office
  recorded_by uuid references auth.users (id) on delete set null,       -- the owner, for 'owner'
  recorded_by_name text not null default '' check (length(recorded_by_name) <= 200),
  recorded_by_email text check (length(recorded_by_email) <= 320),
  paused_at timestamptz,
  paused_by uuid references auth.users (id) on delete set null,
  resumed_at timestamptz,                                               -- last resumed: visits before it wait for the office's OK (autopay_bill)
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  revoked_via text check (revoked_via in ('client', 'office', 'stripe', 'replaced', 'account')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint autopay_authorizations_company_id_id_key unique (company_id, id),
  constraint autopay_authorizations_client_fkey foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  constraint autopay_authorizations_method_fkey foreign key (company_id, payment_method_id)
    references public.client_payment_methods (company_id, id) on delete set null (payment_method_id),
  check ((revoked_at is null) = (revoked_via is null))
);
create unique index autopay_authorizations_live_idx on public.autopay_authorizations (client_id) where revoked_at is null;
create index autopay_authorizations_client_idx on public.autopay_authorizations (company_id, client_id, accepted_at desc);

-- ---------------------------------------------------------------------------------------------
-- Charges
-- ---------------------------------------------------------------------------------------------

--   waiting        due at due_at; nothing billed yet (or approved, invoice_id set)
--   needs_approval over max_amount, or visits autopay didn't queue itself (from before autopay
--                  started, finished while it was paused or off, or freed by a voided or deleted
--                  invoice); waits for Approve charge
--   charging       the task holds it (claim_token, locked_until); or, with claim_token null, waiting
--                  10 minutes after a busy or retry
--   processing     a bank payment is on its way
--   paid           this charge's charge_automatically Stripe invoice was paid
--   failed         declined once; tried again at due_at (3 days on), or at once on a card the client
--                  agreed to after it needed them (autopay_try_new_card)
--   needs_client   declined twice, a bank payment bounced, Stripe refused the card, or the bank wants
--                  the client to confirm
--   called_off     nothing to bill, autopay off, voided, written off, paid another way, sent the
--                  usual way, too small, or Stripe can't be used (the office is told when one is left
--                  unpaid: autopay_charge_status)
create table public.autopay_charges (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  client_id uuid not null,
  job_id uuid,
  bill text not null check (bill in ('visits', 'standard')),   -- create_invoice_for_job's p_kind
  -- The visits that queued it (autopay_queue), while autopay was in force for the client and job.
  -- Its invoice holding any other visit waits for the office's OK (autopay_bill). One freed by a
  -- voided or deleted invoice comes off it while it's still gathering visits (autopay_visit).
  visit_ids uuid[] not null default '{}',
  invoice_id uuid,
  payment_method_id uuid,                                       -- the card last chosen for it
  due_at timestamptz not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'needs_approval', 'charging', 'processing', 'paid', 'failed', 'needs_client', 'called_off')),
  attempts integer not null default 0,     -- claims taken
  failures integer not null default 0,     -- declines in a row (2 -> needs_client)
  claim_token uuid,
  locked_until timestamptz,
  last_error text check (length(last_error) <= 1000),
  decline_code text check (length(decline_code) <= 100),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  approved_amount numeric(12, 2),          -- the balance the office approved; more than this asks again
  busy_since timestamptz,                  -- first 'busy' in a row; a day of them calls it off
  charged_amount numeric(12, 2),           -- what Stripe charged (its amount_due), for the receipt
  charged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint autopay_charges_company_id_id_key unique (company_id, id),
  constraint autopay_charges_client_fkey foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade,
  constraint autopay_charges_job_fkey foreign key (company_id, job_id) references public.jobs (company_id, id) on delete set null (job_id),
  constraint autopay_charges_invoice_fkey foreign key (company_id, invoice_id) references public.invoices (company_id, id) on delete set null (invoice_id),
  constraint autopay_charges_method_fkey foreign key (company_id, payment_method_id)
    references public.client_payment_methods (company_id, id) on delete set null (payment_method_id)
);
-- One row gathers a job's finished visits until it's billed (create_invoice_for_job bills them all at once).
create unique index autopay_charges_waiting_idx on public.autopay_charges (job_id) where status = 'waiting' and invoice_id is null;
-- An invoice is charged by one row.
create unique index autopay_charges_invoice_idx on public.autopay_charges (invoice_id) where invoice_id is not null and status <> 'called_off';
create index autopay_charges_due_idx on public.autopay_charges (due_at) where status in ('waiting', 'failed', 'charging');
create index autopay_charges_client_idx on public.autopay_charges (company_id, client_id, created_at desc);

-- Owners, admins and office staff with the invoices area read all three; nobody signed in writes them.
select private.add_touch_triggers(array['client_payment_methods', 'autopay_authorizations', 'autopay_charges']);

alter table public.client_payment_methods enable row level security;
create policy client_payment_methods_read on public.client_payment_methods for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('client_payment_methods', 'invoices', true);
revoke insert, update, delete on public.client_payment_methods from authenticated;
revoke all on public.client_payment_methods from anon;

alter table public.autopay_authorizations enable row level security;
create policy autopay_authorizations_read on public.autopay_authorizations for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('autopay_authorizations', 'invoices', true);
revoke insert, update, delete on public.autopay_authorizations from authenticated;
revoke all on public.autopay_authorizations from anon;

alter table public.autopay_charges enable row level security;
create policy autopay_charges_read on public.autopay_charges for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('autopay_charges', 'invoices', true);
revoke insert, update, delete on public.autopay_charges from authenticated;
revoke all on public.autopay_charges from anon;

-- ---------------------------------------------------------------------------------------------
-- Columns on existing tables
-- ---------------------------------------------------------------------------------------------

-- Whether a job is charged automatically. Crews see the word "Autopay", never an amount.
alter table public.jobs add column autopay boolean not null default false;
-- When autopay was last turned on for the job (autopay_job_guard): visits finished before it, or
-- before the client agreed, aren't charged without the office's OK.
alter table public.jobs add column autopay_since timestamptz;

-- How a Stripe invoice is collected. Ones brought in from Stripe say send_invoice whatever Stripe did.
alter table public.stripe_invoices add column collection text not null default 'send_invoice'
  check (collection in ('send_invoice', 'charge_automatically'));
-- A tip added after an invoice was paid is its own Stripe invoice, outside the one-live-per-invoice rule.
alter table public.stripe_invoices add column purpose text not null default 'invoice'
  check (purpose in ('invoice', 'tip'));

-- As in 20261018000900_stripe_connection_fixes.sql, plus: only the invoice's own Stripe invoices
-- count, so a tip charged after it was paid doesn't stand in the way.
drop index public.stripe_invoices_live_idx;
create unique index stripe_invoices_live_idx on public.stripe_invoices (invoice_id)
  where status in ('creating', 'open', 'processing') and detached_at is null and purpose = 'invoice';
-- One tip at a time for an invoice.
create unique index stripe_invoices_live_tip_idx on public.stripe_invoices (invoice_id)
  where status in ('creating', 'open', 'processing') and detached_at is null and purpose = 'tip';

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- The people who look after money: owners, admins and office staff with the invoices area.
create function private.money_office(p_company uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id
  from public.memberships m
  left join public.company_roles cr on cr.id = m.role_id
  where m.company_id = p_company and m.active and m.role in ('owner', 'admin', 'office')
    and 'invoices' = any (coalesce(cr.permissions, private.level_permissions(m.role)))
$$;

-- A notification for each of them (kind 'autopay').
create function private.autopay_notify(p_company uuid, p_title text, p_body text, p_link text) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select p_company, u, 'autopay', left(p_title, 300), p_body, p_link
  from private.money_office(p_company) u
$$;

-- settings.autopay, always an object.
create function private.autopay_of(p_settings jsonb) returns jsonb
language sql immutable security definer set search_path = '' as $$
  select case when jsonb_typeof(p_settings -> 'autopay') = 'object' then p_settings -> 'autopay' else '{}'::jsonb end
$$;

-- Days after a visit with timing 'days': read only when it's a number, rounded and kept within 1 to
-- 14, else 1 (core autopaySettings reads them the same way).
create function private.autopay_days(p_autopay jsonb) returns integer
language sql immutable security definer set search_path = '' as $$
  select case when jsonb_typeof(p_autopay -> 'days') = 'number'
    then least(greatest(round((p_autopay -> 'days')::numeric), 1), 14)::integer else 1 end
$$;

-- When charges go, in the words core autopayTimingText uses: "right after each visit", "at the end
-- of the day of each visit", "2 days after each visit".
create function private.autopay_timing_text(p_autopay jsonb) returns text
language sql immutable security definer set search_path = '' as $$
  select case p_autopay ->> 'timing'
    when 'now' then 'right after each visit'
    when 'days' then private.autopay_days(p_autopay) || case when private.autopay_days(p_autopay) = 1 then ' day' else ' days' end || ' after each visit'
    else 'at the end of the day of each visit'
  end
$$;

-- The starter terms for a trade, as core starterAutopayTerms has them (for a company that turned
-- autopay on before saving terms of its own; autopay_set_settings always saves them).
create function private.autopay_starter_terms(p_trade text) returns text
language sql immutable security definer set search_path = '' as $$
  select case
    when p_trade = 'lawn_exterior' then
      'We charge the card on file after each visit is done. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    when p_trade in ('paving', 'roofing_exteriors') then
      'We charge the card on file when the work on your job is done. Charges over the amount we agreed wait until we''ve talked with you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    else
      'We charge the card on file when each visit or job is done. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
  end
$$;

-- The version of the terms a client agrees to now (core autopaySettings' default for one never saved).
create function private.autopay_terms_version(p_company uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(private.autopay_of(c.settings) ->> 'terms_version', ''), 'starter-' || coalesce(nullif(c.trade_preset, ''), 'general') || '-1')
  from public.companies c where c.id = p_company
$$;

-- The whole agreement text as the client sees it: the terms, a blank line, then "We charge " and the
-- timing (core autopayTimingText's words, exactly), as a sentence. Stored as the agreement's terms.
create function private.autopay_terms_shown(p_company uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(case when jsonb_typeof(a -> 'terms') = 'string' then nullif(btrim(a ->> 'terms'), '') end, private.autopay_starter_terms(c.trade_preset))
    || E'\n\n' || 'We charge ' || private.autopay_timing_text(a) || '.'
  from public.companies c cross join lateral (select private.autopay_of(c.settings) as a) x
  where c.id = p_company
$$;

-- "Visa ending 4242", "Chase ending 6789", "Link": the same words as core methodLabel.
create function private.method_label(pm public.client_payment_methods) returns text
language sql immutable security definer set search_path = '' as $$
  select case
    when pm.type = 'card' then
      coalesce(case lower(nullif(pm.brand, '')) when 'amex' then 'American Express' when 'mastercard' then 'Mastercard' else initcap(nullif(pm.brand, '')) end, 'Card')
      || coalesce(' ending ' || nullif(pm.last4, ''), '')
    when pm.type = 'us_bank_account' then coalesce(nullif(pm.bank_name, ''), 'Bank account') || coalesce(' ending ' || nullif(pm.last4, ''), '')
    when pm.type = 'link' then 'Link'
    else initcap(replace(coalesce(nullif(pm.type, ''), 'payment method'), '_', ' ')) || coalesce(' ending ' || nullif(pm.last4, ''), '')
  end
$$;

-- A saved method's words by its id, or null.
create function private.method_label_of(p_method uuid) returns text
language sql stable security definer set search_path = '' as $$
  select private.method_label(pm) from public.client_payment_methods pm where pm.id = p_method
$$;

/**
 * The card or bank account to charge a client now, or null: the company has autopay on, the client
 * has an agreement in force (not turned off, not paused), and the method that agreement names is
 * active. A card saved since (Change card left halfway, a bank account verified late, one brought
 * in from Stripe) is never charged until the client agrees to it.
 */
create function private.autopay_ready(p_company uuid, p_client uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select pm.id
  from public.autopay_authorizations a
  join public.client_payment_methods pm on pm.id = a.payment_method_id and pm.company_id = a.company_id
  where a.company_id = p_company and a.client_id = p_client and a.revoked_at is null and a.paused_at is null
    and pm.client_id = p_client and pm.status = 'active'
    and (select private.autopay_of(c.settings) -> 'enabled' = 'true'::jsonb from public.companies c where c.id = p_company)
$$;

-- Whether a client's new recurring per-visit job starts on autopay: the company says so
-- (settings.autopay.jobs_default) and the client is on autopay now.
create function private.autopay_job_default(p_company uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select private.autopay_of(c.settings) -> 'jobs_default' = 'true'::jsonb from public.companies c where c.id = p_company), false)
    and private.autopay_ready(p_company, p_client) is not null
$$;

-- For the field app (visit_autopay): whether a client is charged automatically now, yes or no.
create function private.client_on_autopay(p_company uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.autopay_ready(p_company, p_client) is not null
$$;

-- When a charge queued now falls due, in the company's time zone: now, local midnight tonight (the
-- end of the day), or local midnight at the end of the day that many days on.
create function private.autopay_due(p_company uuid) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_autopay jsonb;
  v_tz text;
  v_today date;
begin
  select private.autopay_of(c.settings), coalesce(c.timezone, 'UTC') into v_autopay, v_tz from public.companies c where c.id = p_company;
  v_today := (now() at time zone coalesce(v_tz, 'UTC'))::date;
  return case v_autopay ->> 'timing'
    when 'now' then now()
    when 'days' then (v_today + private.autopay_days(v_autopay) + 1)::timestamp at time zone v_tz
    else (v_today + 1)::timestamp at time zone v_tz
  end;
end $$;

-- Call off what hasn't been charged yet for a job (p_bill null: both kinds): rows 'waiting' (billed
-- or not), 'needs_approval' and 'failed'. Never 'charging' (autopay_bill re-checks it on fresh data),
-- 'processing' (money is on its way) or 'needs_client' (the client was already asked).
-- p_unbilled_only: only the row still gathering visits (waiting, invoice_id null), for a reopened
-- visit or work marked not done, which mustn't touch other invoices' retries.
create function private.autopay_call_off(p_job uuid, p_bill text, p_reason text, p_unbilled_only boolean default false) returns void
language sql security definer set search_path = '' as $$
  update public.autopay_charges
  set status = 'called_off', last_error = p_reason, claim_token = null, locked_until = null, busy_since = null
  where job_id = p_job and (p_bill is null or bill = p_bill)
    and status in ('waiting', 'needs_approval', 'failed')
    and (not p_unbilled_only or (status = 'waiting' and invoice_id is null))
$$;

-- The same for all of a client's jobs.
create function private.autopay_call_off_client(p_client uuid, p_reason text) returns void
language sql security definer set search_path = '' as $$
  update public.autopay_charges
  set status = 'called_off', last_error = p_reason, claim_token = null, locked_until = null, busy_since = null
  where client_id = p_client and status in ('waiting', 'needs_approval', 'failed')
$$;

-- Whether an invoice was paid by its autopay charge: its charge_automatically Stripe invoice is paid
-- (only autopay makes those).
create function private.autopay_paid_by_charge(p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.stripe_invoices s
    where s.invoice_id = p_invoice and s.collection = 'charge_automatically' and s.purpose = 'invoice' and s.status = 'paid'
  )
$$;

-- Whether autopay's bank payment for an invoice is on its way where Crewtavo hears how it ends: its
-- charge 'processing', and its Stripe invoice not in a Stripe account Crewtavo has since left
-- (detached). One there is the office's to follow, as any bank payment there: they were told to
-- check it in that account and record it here once it clears.
create function private.autopay_clearing(p_invoice uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.autopay_charges a where a.invoice_id = p_invoice and a.status = 'processing')
    and not exists (
      select 1 from public.stripe_invoices s
      where s.invoice_id = p_invoice and s.collection = 'charge_automatically' and s.purpose = 'invoice'
        and s.status = 'processing' and s.detached_at is not null
    )
$$;

-- A stripe.invoice sync for an invoice, as enqueue_stripe queues it: one waiting job per invoice.
create function private.autopay_enqueue_stripe(p_company uuid, p_invoice uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.outbox (company_id, topic, payload)
  select p_company, 'stripe.invoice', jsonb_build_object('invoice_id', p_invoice)
  where coalesce(current_setting('crewtavo.quiet', true), '') <> 'on'
    and not exists (
      select 1 from public.outbox o
      where o.topic = 'stripe.invoice' and o.payload ->> 'invoice_id' = p_invoice::text
        and o.done_at is null and o.dead_at is null and o.locked_until is null
    )
$$;

-- A charge leaving autopay_bill without being charged: its new status and why, the claim let go,
-- and the answer the task gets.
create function private.autopay_bill_end(p_charge uuid, p_status text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_invoice uuid;
begin
  update public.autopay_charges
  set status = p_status, last_error = p_reason, claim_token = null, locked_until = null, busy_since = null,
      charged_at = case when p_status = 'paid' then coalesce(charged_at, now()) else charged_at end
  where id = p_charge
  returning invoice_id into v_invoice;
  return jsonb_build_object('outcome', p_status, 'reason', p_reason, 'invoice_id', v_invoice);
end $$;

-- ---------------------------------------------------------------------------------------------
-- settings.autopay and its guard
-- ---------------------------------------------------------------------------------------------

-- Whether autopay_set_settings is changing settings.autopay in this transaction.
create function private.autopay_setting() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(current_setting('crewtavo.autopay', true), '') = 'on'
$$;

-- Nobody changes settings.autopay but through autopay_set_settings: a page that saves the company's
-- other settings with what it read a while ago (Settings → Company does) keeps it as it is.
create function private.autopay_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.autopay_setting() or new.settings -> 'autopay' is not distinct from old.settings -> 'autopay' then
    return new;
  end if;
  new.settings := case when old.settings -> 'autopay' is null then coalesce(new.settings, '{}') - 'autopay'
                  else jsonb_set(coalesce(new.settings, '{}'), '{autopay}', old.settings -> 'autopay') end;
  return new;
end $$;
create trigger autopay_settings_guard before update of settings on public.companies
  for each row execute function private.autopay_settings_guard();

-- Tips turned off: every invoice with a live Stripe invoice of ours that carries a tip gets a
-- stripe.invoice sync, which voids it (syncStripeInvoice treats it as stale) and makes one without
-- the tip. As enqueue_stripe, one waiting job per invoice.
create function private.hub_tips_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.outbox (company_id, topic, payload)
  select distinct s.company_id, 'stripe.invoice', jsonb_build_object('invoice_id', s.invoice_id)
  from public.stripe_invoices s
  where s.company_id = new.id and s.origin = 'crewtavo' and s.purpose = 'invoice' and s.tip_amount > 0
    and s.status in ('creating', 'open') and s.detached_at is null and s.invoice_id is not null
    and not exists (select 1 from public.outbox o where o.topic = 'stripe.invoice'
                    and o.payload ->> 'invoice_id' = s.invoice_id::text and o.done_at is null and o.dead_at is null and o.locked_until is null);
  return null;
end $$;
create trigger hub_tips_changed after update of settings on public.companies
  for each row when ((old.settings -> 'hub_tips') = 'true'::jsonb and (new.settings -> 'hub_tips') is distinct from 'true'::jsonb)
  execute function private.hub_tips_changed();

/**
 * Settings → Payments: autopay's terms, timing, cap and receipts. Owners and admins with the
 * invoices area. Takes the whole autopay object from the screen; returns settings.autopay as saved.
 * terms_version changes when the terms, the timing or the days do: a client agrees to when they're
 * charged as well as to the words.
 */
create function public.autopay_set_settings(p_company uuid, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb;
  v_terms text;
  v_timing text := p_settings ->> 'timing';
  v_days integer;
  v_max numeric;
  v_version text;
  v_saved jsonb;
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'invoices')) then
    raise exception 'Only owners and admins with the invoices area can change autopay' using errcode = '42501';
  end if;
  if jsonb_typeof(p_settings -> 'enabled') is distinct from 'boolean' then
    raise exception 'Say whether autopay is on' using errcode = '22023';
  end if;
  if jsonb_typeof(p_settings -> 'terms') is distinct from 'string' or length(btrim(p_settings ->> 'terms')) not between 1 and 4000 then
    raise exception 'Write the terms clients agree to' using errcode = '22023';
  end if;
  v_terms := btrim(p_settings ->> 'terms');
  if v_timing is null or v_timing not in ('now', 'end_of_day', 'days') then
    raise exception 'Choose when to charge' using errcode = '22023';
  end if;
  if v_timing = 'days' then
    if jsonb_typeof(p_settings -> 'days') is distinct from 'number'
       or (p_settings -> 'days')::numeric not between 1 and 14 or (p_settings -> 'days')::numeric <> trunc((p_settings -> 'days')::numeric) then
      raise exception 'Choose 1 to 14 days' using errcode = '22023';
    end if;
    v_days := (p_settings -> 'days')::numeric::integer;
  end if;
  if p_settings -> 'max_amount' is not null and p_settings -> 'max_amount' <> 'null'::jsonb then
    if jsonb_typeof(p_settings -> 'max_amount') <> 'number'
       or (p_settings -> 'max_amount')::numeric <= 0 or (p_settings -> 'max_amount')::numeric > 1000000 then
      raise exception 'The most to charge without asking has to be more than $0' using errcode = '22023';
    end if;
    v_max := round((p_settings -> 'max_amount')::numeric, 2);
  end if;
  if jsonb_typeof(p_settings -> 'receipts') is distinct from 'boolean' then
    raise exception 'Say whether to email receipts' using errcode = '22023';
  end if;
  if jsonb_typeof(p_settings -> 'jobs_default') is distinct from 'boolean' then
    raise exception 'Say whether new recurring jobs start on autopay' using errcode = '22023';
  end if;
  if jsonb_typeof(p_settings -> 'card_required') is distinct from 'boolean' then
    raise exception 'Say whether every client needs a card on file' using errcode = '22023';
  end if;
  -- The key's saved capability (apps/api/src/integrations/stripe.ts stripeCapabilities): a company
  -- calling this straight through the API gets the same answer as PUT /autopay/settings.
  if p_settings -> 'enabled' = 'true'::jsonb and not exists (
    select 1 from public.integrations i
    where i.company_id = p_company and i.provider = 'stripe' and i.status = 'connected' and i.settings -> 'autopay' = 'true'::jsonb
  ) then
    raise exception 'Update your Stripe key on the Apps page to turn on autopay' using errcode = '22023';
  end if;

  select private.autopay_of(c.settings) into v_old from public.companies c where c.id = p_company for update;
  v_version := case
    when nullif(v_old ->> 'terms_version', '') is null
      or v_old -> 'terms' is distinct from to_jsonb(v_terms)
      or v_old -> 'timing' is distinct from to_jsonb(v_timing)
      or coalesce(v_old -> 'days', 'null'::jsonb) is distinct from coalesce(to_jsonb(v_days), 'null'::jsonb)
    then to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')
    else v_old ->> 'terms_version'
  end;

  perform set_config('crewtavo.autopay', 'on', true);
  update public.companies c
  set settings = jsonb_set(coalesce(c.settings, '{}'), '{autopay}', jsonb_build_object(
    'enabled', p_settings -> 'enabled',
    'terms', v_terms,
    'terms_version', v_version,
    'timing', v_timing,
    'days', v_days,
    'max_amount', v_max,
    'receipts', p_settings -> 'receipts',
    'jobs_default', p_settings -> 'jobs_default',
    'card_required', p_settings -> 'card_required',
    'changed_at', now(),
    'changed_by', (select auth.uid())))
  where c.id = p_company
  returning c.settings -> 'autopay' into v_saved;
  perform set_config('crewtavo.autopay', 'off', true);
  return v_saved;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Queueing
-- ---------------------------------------------------------------------------------------------

/**
 * A finished visit (p_bill 'visits') or a one-off job's finished work ('standard'): queue its
 * charge, or move the one waiting for the job to the later of the two due times, but never more
 * than one wait past when the row was made (a weekly visit with a 7-day wait would otherwise put
 * the charge off for ever). Nothing when the job isn't on autopay or the client has nothing to charge.
 * p_visit, the visit finished, joins the row's visit_ids: the visits autopay may charge without
 * asking (autopay_bill).
 */
create function private.autopay_queue(p_job uuid, p_bill text, p_visit uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  v_pm uuid;
  v_autopay jsonb;
  v_wait interval;
  v_visits uuid[] := case when p_visit is null then '{}'::uuid[] else array[p_visit] end;
begin
  select * into j from public.jobs where id = p_job;
  if not found or not j.autopay or j.status = 'archived' then return; end if;
  if (p_bill = 'visits' and (j.kind <> 'recurring' or j.billing_mode <> 'per_visit'))
     or (p_bill = 'standard' and (j.kind <> 'one_off' or j.billing_mode <> 'on_completion')) then return; end if;
  v_pm := private.autopay_ready(j.company_id, j.client_id);
  if v_pm is null then return; end if;
  select private.autopay_of(c.settings) into v_autopay from public.companies c where c.id = j.company_id;
  v_wait := case when v_autopay ->> 'timing' = 'days' then make_interval(days => private.autopay_days(v_autopay) + 1) else interval '1 day' end;
  insert into public.autopay_charges (company_id, client_id, job_id, bill, payment_method_id, due_at, visit_ids)
  values (j.company_id, j.client_id, j.id, p_bill, v_pm, private.autopay_due(j.company_id), v_visits)
  on conflict (job_id) where status = 'waiting' and invoice_id is null
  do update set due_at = least(greatest(public.autopay_charges.due_at, excluded.due_at), public.autopay_charges.created_at + v_wait),
                payment_method_id = excluded.payment_method_id,
                visit_ids = case when excluded.visit_ids <@ public.autopay_charges.visit_ids then public.autopay_charges.visit_ids
                                 else public.autopay_charges.visit_ids || excluded.visit_ids end;
end $$;

-- A visit finished (queue its charge, naming the visit) or reopened (call off what it would have
-- been charged for). A visit freed by a voided or deleted invoice stays finished, so it queues
-- nothing, and it comes off the visit_ids of every charge still gathering visits (one it queued
-- before the office invoiced it by hand, or one whose visits a billed charge took on): the charge
-- that bills it later asks first. (Not when it's invoiced: autopay_bill's step 3 takes those on.)
-- A problem here must never stop the crew's tap: an offline tap syncs later and would fail then, so
-- it's noted as a warning and the visit goes on as it was saved. The office still sees the visits
-- under "Ready to invoice". Fires on every update (20261017000700_status_triggers.sql explains why).
create function private.autopay_visit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.kind <> 'job' or new.job_id is null then
      return null;
    end if;
    if tg_op = 'UPDATE' and old.invoice_id is not null and new.invoice_id is null then
      update public.autopay_charges set visit_ids = array_remove(visit_ids, new.id)
      where job_id = new.job_id and invoice_id is null and status in ('waiting', 'charging') and new.id = any (visit_ids);
    end if;
    if new.status = 'completed' and (tg_op = 'INSERT' or old.status is distinct from 'completed') and new.invoice_id is null then
      perform private.autopay_queue(new.job_id, 'visits', new.id);
    elsif tg_op = 'UPDATE' and old.status = 'completed' and new.status <> 'completed' then
      if new.invoice_id is null then
        if not exists (
          select 1 from public.visits v
          where v.job_id = new.job_id and v.id <> new.id and v.kind = 'job' and v.status = 'completed' and v.invoice_id is null
        ) then
          perform private.autopay_call_off(new.job_id, 'visits', 'The visit was reopened', true);
        else
          -- The other visits keep the charge; this one joins it again when it's finished again.
          update public.autopay_charges set visit_ids = array_remove(visit_ids, new.id)
          where job_id = new.job_id and status = 'waiting' and invoice_id is null and new.id = any (visit_ids);
        end if;
      else
        -- Billed already, not yet charged. A charge being made is caught by autopay_bill's re-check;
        -- money on its way, a client already asked, or a charge paid are left alone.
        update public.autopay_charges
        set status = 'called_off', last_error = 'A visit on it was reopened', claim_token = null, locked_until = null, busy_since = null
        where invoice_id = new.invoice_id and status in ('waiting', 'needs_approval', 'failed');
      end if;
    end if;
  exception when others then
    raise warning 'autopay: %', sqlerrm;
  end;
  return null;
end $$;
create trigger autopay after insert or update on public.visits
  for each row execute function private.autopay_visit();

-- As in 20261025002003_sub_field_app.sql, plus: an offline Complete keeps the time it was tapped,
-- which the field app sends with it (completed_at alongside status 'completed'), when that's in
-- the last 3 days and not ahead of now and the visit was never finished before (a reopened one
-- keeps its first date); otherwise it's now, as before. The rest of when it was
-- finished, and by whom, is still the database's to say. (For everyone else visit_defaults keeps
-- a completed_at that's given.) Autopay's date check (autopay_bill) needs the tap time: a visit
-- done before the client agreed, synced after, isn't charged without the office's OK.
create or replace function private.visit_sub_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  free constant text[] := array['status', 'notes', 'completed_at', 'completed_by', 'updated_at'];
begin
  if (select auth.uid()) is null or not (old.company_id = any (private.sub_companies())) then return new; end if;
  if to_jsonb(new) - free is distinct from to_jsonb(old) - free then
    raise exception 'You can change a visit''s status and notes. Ask the office about anything else.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and (old.status in ('completed', 'cancelled') or new.status not in ('scheduled', 'en_route', 'in_progress', 'completed')) then
    raise exception 'Ask the office to cancel, move or reopen this visit.' using errcode = '42501';
  end if;
  new.completed_at := case
    when new.status = 'completed' and old.completed_at is null
         and new.completed_at <= now() and new.completed_at >= now() - interval '3 days' then new.completed_at
    when new.status = 'completed' then coalesce(old.completed_at, now())
    else old.completed_at end;
  new.completed_by := case when new.status = 'completed' and old.completed_at is null then (select auth.uid()) else old.completed_by end;
  return new;
end $$;

-- A one-off job's work marked done queues its charge; marked not done, or closed without an invoice,
-- calls it off. Autopay turned off for the job, or the job archived, calls off what's left.
create function private.autopay_job_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'active' and new.status = 'requires_invoicing' then
    perform private.autopay_queue(new.id, 'standard');
  elsif old.status = 'requires_invoicing' and new.status = 'active' then
    perform private.autopay_call_off(new.id, 'standard', 'The work was marked not done', true);
  elsif old.status = 'requires_invoicing' and new.status = 'completed' then
    -- JobPage's Close job, without an invoice. Safe while billing: create_invoice_for_job makes the
    -- same change from inside autopay_bill, when the row is 'charging', which this doesn't touch.
    perform private.autopay_call_off(new.id, 'standard', 'The job was closed', true);
  end if;
  if old.autopay and not new.autopay then
    perform private.autopay_call_off(new.id, null, 'Autopay was turned off for this job');
  end if;
  if new.status = 'archived' and old.status <> 'archived' then
    perform private.autopay_call_off(new.id, null, 'The job was archived');
  end if;
  return null;
end $$;
create trigger autopay after update on public.jobs
  for each row execute function private.autopay_job_changed();

-- Which jobs can be on autopay (core autopayAllowed: recurring jobs billed per visit, one-off jobs
-- billed when the work is done), who may switch it, and the default for clients on autopay: new
-- recurring per-visit jobs start with it on when the company says so (settings.autopay.jobs_default),
-- and so does a job edited into one (a job made from a quote starts one-off). autopay_since is when
-- it was last turned on, kept by the database.
create function private.autopay_job_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_allowed boolean := (new.kind = 'recurring' and new.billing_mode = 'per_visit') or (new.kind = 'one_off' and new.billing_mode = 'on_completion');
  v_signed_in boolean := (select auth.uid()) is not null;
begin
  if tg_op = 'INSERT' then
    if new.autopay and (not v_allowed
        or (v_signed_in and not (private.has_role(new.company_id, '{owner,admin,office}') and private.has_perm(new.company_id, 'invoices')))) then
      new.autopay := false;
    end if;
    if not new.autopay and new.kind = 'recurring' and new.billing_mode = 'per_visit' and private.autopay_job_default(new.company_id, new.client_id) then
      new.autopay := true;
    end if;
    new.autopay_since := case when new.autopay then now() end;
    return new;
  end if;

  -- Who chose to switch it: checked before the job type or the default changes it.
  if new.autopay is distinct from old.autopay and v_signed_in
     and not (private.has_role(new.company_id, '{owner,admin,office}') and private.has_perm(new.company_id, 'invoices')) then
    raise exception 'Only the office with the invoices area can turn autopay on or off for a job' using errcode = '42501';
  end if;
  if not v_allowed then
    if new.autopay and not old.autopay then
      raise exception 'Autopay works with recurring jobs billed per visit, or one-off jobs billed when the work is done' using errcode = '22023';
    end if;
    new.autopay := false;
  elsif (new.kind, new.billing_mode) is distinct from (old.kind, old.billing_mode) and new.kind = 'recurring' and new.billing_mode = 'per_visit'
        and not old.autopay and not new.autopay and private.autopay_job_default(new.company_id, new.client_id) then
    new.autopay := true;
  end if;
  new.autopay_since := case when new.autopay and not old.autopay then now() else old.autopay_since end;
  return new;
end $$;
create trigger autopay_guard before insert or update on public.jobs
  for each row execute function private.autopay_job_guard();

-- ---------------------------------------------------------------------------------------------
-- Agreements: kept as made, and what follows from one
-- ---------------------------------------------------------------------------------------------

-- An agreement is the record a card network asks for: only pausing, resuming and turning off change
-- it, and one turned off stays off. (Deleting a client deletes theirs.)
create function private.autopay_authorization_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if to_jsonb(new) - array['paused_at', 'paused_by', 'resumed_at', 'revoked_at', 'revoked_by', 'revoked_via', 'updated_at']
     is distinct from to_jsonb(old) - array['paused_at', 'paused_by', 'resumed_at', 'revoked_at', 'revoked_by', 'revoked_via', 'updated_at'] then
    raise exception 'An agreement is kept as it was made. It can only be paused or turned off' using errcode = '42501';
  end if;
  if old.revoked_at is not null and to_jsonb(new) - 'updated_at' is distinct from to_jsonb(old) - 'updated_at' then
    raise exception 'An agreement that was turned off stays off' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger guard before update on public.autopay_authorizations
  for each row execute function private.autopay_authorization_guard();

-- The client agreed to another card (or the bank account they agreed to was verified since), and
-- it's the one charged now: each charge two declines or a bounced bank payment left waiting on
-- them (the notice asked them to pay or update their card), whose invoice is still owed, is tried
-- once on it now. Not one waiting on them to confirm with their bank (3D Secure: that's done on
-- Stripe's page), nor one paid another way meanwhile (called off already).
create function private.autopay_try_new_card(p_client uuid, p_method uuid) returns void
language sql security definer set search_path = '' as $$
  update public.autopay_charges a
  set status = 'failed', due_at = now(), failures = 0, payment_method_id = p_method
  from public.invoices i
  where a.client_id = p_client and a.status = 'needs_client' and a.payment_method_id is distinct from p_method
    and i.id = a.invoice_id and i.status in ('sent', 'partially_paid', 'overdue') and i.balance_due > 0
    -- A second decline, or a bounce (failures counted, a code given that isn't the bank asking).
    and (a.failures >= 2 or (a.failures = 1 and a.decline_code is not null
         and a.decline_code not in ('authentication_required', 'invoice_payment_intent_requires_action', 'requires_action', 'card_action_required')))
$$;

-- A client agreed: autopay.enabled for automations and the client's copy of what they agreed to
-- (not for the owner's tick on many clients at once, which would set off a rule for each), and their
-- active recurring per-visit jobs switched on when the company says so. Only for the first agreement
-- in a run: one that replaces another (a card changed or the terms agreed again, the old one turned
-- off as 'replaced' in the same call, so at the same now()) leaves each job as the office has it.
-- A charge a decline or a bounce left waiting on them is tried on the new card (autopay_try_new_card).
create function private.autopay_agreed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.source <> 'owner' then
    perform private.emit(new.company_id, 'autopay.enabled', 'client', new.client_id,
      format('%s set up autopay', private.client_name(new.client_id)),
      jsonb_build_object('card', private.method_label_of(new.payment_method_id), 'source', new.source));
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'autopay.agreed', jsonb_build_object('authorization_id', new.id));
    if private.autopay_ready(new.company_id, new.client_id) = new.payment_method_id then
      perform private.autopay_try_new_card(new.client_id, new.payment_method_id);
    end if;
  end if;
  if exists (select 1 from public.companies c where c.id = new.company_id and private.autopay_of(c.settings) -> 'jobs_default' = 'true'::jsonb)
     and not exists (select 1 from public.autopay_authorizations a
                     where a.company_id = new.company_id and a.client_id = new.client_id and a.id <> new.id
                       and a.revoked_via = 'replaced' and a.revoked_at = new.accepted_at) then
    update public.jobs set autopay = true
    where company_id = new.company_id and client_id = new.client_id
      and kind = 'recurring' and billing_mode = 'per_visit' and status = 'active' and not autopay;
  end if;
  return null;
end $$;
create trigger agreed after insert on public.autopay_authorizations
  for each row execute function private.autopay_agreed();

-- Turned off or paused: what wasn't charged yet is called off (the office is told about any invoice
-- that leaves unpaid). A card changed (revoked_via 'replaced') isn't turned off: the new agreement
-- takes over, and the charges waiting go to the new card. Turned off by the client: the office hears.
create function private.autopay_agreement_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    if new.revoked_via <> 'replaced' then
      perform private.autopay_call_off_client(new.client_id, 'Autopay was turned off');
    end if;
    if new.revoked_via = 'client' then
      perform private.autopay_notify(new.company_id, format('%s turned off autopay', private.client_name(new.client_id)),
        'Their invoices go out with the Pay link again.', '/clients/' || new.client_id);
    end if;
  elsif new.paused_at is not null and old.paused_at is null and new.revoked_at is null then
    perform private.autopay_call_off_client(new.client_id, 'Autopay is paused');
  end if;
  return null;
end $$;
create trigger changed after update on public.autopay_authorizations
  for each row execute function private.autopay_agreement_changed();

-- A card taken off: when it was the card of the agreement in force, what wasn't charged is called
-- off. Taken off in Stripe, the office hears, since nobody here did it. A bank account verified
-- that the client agreed to: a charge left waiting on them is tried on it (autopay_try_new_card).
create function private.autopay_method_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'removed' and old.status <> 'removed' then
    if exists (select 1 from public.autopay_authorizations a
               where a.client_id = new.client_id and a.revoked_at is null and a.payment_method_id = new.id) then
      perform private.autopay_call_off_client(new.client_id, 'The card was removed');
    end if;
    if new.removed_reason = 'stripe' then
      perform private.autopay_notify(new.company_id, format('%s''s card was removed', private.client_name(new.client_id)),
        'It was taken off in Stripe, so autopay is paused until they add another.', '/clients/' || new.client_id);
    end if;
  elsif new.status = 'active' and old.status = 'pending' and private.autopay_ready(new.company_id, new.client_id) = new.id then
    perform private.autopay_try_new_card(new.client_id, new.id);
  end if;
  return null;
end $$;
create trigger method_changed after update of status on public.client_payment_methods
  for each row execute function private.autopay_method_changed();

-- ---------------------------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------------------------

-- What happens to an invoice's charge when the invoice changes some other way. Paid by the charge's
-- own Stripe invoice (autopay_paid_by_charge: settling marks it paid before booking the payment):
-- money on its way has arrived, and a charge still to be made or retried is done, between tries
-- too (charging with no claim; the receipt goes only when it wasn't waiting out a busy Stripe, as
-- then the client paid on Stripe's page themselves: autopay_charge_status). Paid some other
-- way: a bank payment on its way is left 'processing' for the webhook to settle or bounce, and a
-- charge still to be made or retried is called off. No receipt for those, receipts going only from
-- 'charging' and 'processing'. Voided, written off or back to draft:
-- what wasn't charged is called off, between tries too (charging with no claim: no Stripe call is
-- under way); 'processing' is left: the bank payment settles or bounces on its own, and the webhook
-- moves the row then. Sent by hand while it waited for the office's OK: that's the office's answer.
create function private.autopay_invoice_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'paid' and old.status <> 'paid' then
    if private.autopay_paid_by_charge(new.id) then
      update public.autopay_charges
      set status = 'paid', charged_at = coalesce(charged_at, now()), last_error = null, claim_token = null, locked_until = null, busy_since = null
      where invoice_id = new.id
        and (status in ('processing', 'failed', 'needs_client', 'waiting', 'needs_approval') or (status = 'charging' and claim_token is null));
    else
      update public.autopay_charges
      set status = 'called_off', last_error = 'Paid another way', claim_token = null, locked_until = null, busy_since = null
      where invoice_id = new.id and status in ('failed', 'needs_client', 'waiting', 'needs_approval');
    end if;
  elsif new.status in ('void', 'written_off', 'draft') and old.status <> new.status then
    update public.autopay_charges
    set status = 'called_off', claim_token = null, locked_until = null, busy_since = null,
        last_error = case new.status when 'void' then 'The invoice was voided' when 'written_off' then 'The invoice was written off'
                     else 'The invoice went back to draft' end
    where invoice_id = new.id
      and (status in ('waiting', 'needs_approval', 'failed', 'needs_client') or (status = 'charging' and claim_token is null));
  end if;
  if old.status = 'draft' and new.status <> 'draft' then
    update public.autopay_charges
    set status = 'called_off', last_error = 'Sent the usual way', claim_token = null, locked_until = null, busy_since = null
    where invoice_id = new.id and status = 'needs_approval';
  end if;
  return null;
end $$;
create trigger autopay after update on public.invoices
  for each row execute function private.autopay_invoice_changed();

-- While an invoice is being charged (its charge 'charging' with a claim), the people who could
-- change what it's charged for wait: it isn't moved to draft, voided, written off or deleted, and its
-- discount, promo code and tax rate stay. While a bank payment for it is on its way ('processing'),
-- it isn't voided or moved to draft either: the money would land on an invoice that no longer asks
-- for it. Written off is fine (the payment arriving makes it paid after all), and so is all of it
-- once the Stripe account it's in was left (autopay_clearing): the office follows it there. The
-- task's own writes and the webhook's run as the service role. A draft deleted while its charge waits, or between
-- tries (charging with no claim), calls the charge off first: nothing is left to charge, and its
-- visits, freed, aren't billed again without the office's OK.
create function private.autopay_invoice_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null
     and exists (select 1 from public.autopay_charges a where a.invoice_id = old.id and a.status = 'charging' and a.claim_token is not null)
     and (tg_op = 'DELETE'
          or (new.status in ('draft', 'void', 'written_off') and new.status is distinct from old.status)
          or new.discount_amount is distinct from old.discount_amount
          or new.promo_code_id is distinct from old.promo_code_id
          or new.tax_rate is distinct from old.tax_rate) then
    raise exception 'This invoice is being charged automatically right now. Try again in a few minutes' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and tg_op = 'UPDATE'
     and new.status in ('draft', 'void') and new.status is distinct from old.status
     and private.autopay_clearing(old.id) then
    raise exception 'A bank payment for this is on its way. Wait for it to clear, then refund it' using errcode = '22023';
  end if;
  if tg_op = 'DELETE' then
    update public.autopay_charges
    set status = 'called_off', last_error = 'The invoice was deleted', claim_token = null, locked_until = null, busy_since = null
    where invoice_id = old.id
      and (status in ('waiting', 'needs_approval', 'failed', 'needs_client') or (status = 'charging' and claim_token is null));
    return old;
  end if;
  return new;
end $$;
create trigger autopay_guard before update or delete on public.invoices
  for each row execute function private.autopay_invoice_guard();

-- The same for its lines.
create function private.autopay_invoice_lines_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and exists (
    select 1 from public.autopay_charges a
    where a.invoice_id in (case when tg_op <> 'DELETE' then new.invoice_id end, case when tg_op <> 'INSERT' then old.invoice_id end)
      and a.status = 'charging' and a.claim_token is not null
  ) then
    raise exception 'This invoice is being charged automatically right now. Try again in a few minutes' using errcode = '22023';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger autopay_guard before insert or update or delete on public.invoice_line_items
  for each row execute function private.autopay_invoice_lines_guard();

-- And a payment recorded on it, by anyone signed in, while it's being charged or while a bank
-- payment for it is on its way (autopay_clearing): the client would pay twice once it clears.
-- Stripe's own payments come from the server (service role).
create function private.autopay_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null and new.invoice_id is not null and exists (
    select 1 from public.autopay_charges a where a.invoice_id = new.invoice_id and a.status = 'charging' and a.claim_token is not null
  ) then
    raise exception 'This invoice is being charged automatically right now. Try again in a few minutes' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and new.invoice_id is not null and private.autopay_clearing(new.invoice_id) then
    raise exception 'A bank payment for this invoice is on its way. Record a payment once it clears or bounces' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger autopay_guard before insert on public.payments
  for each row execute function private.autopay_payment_guard();

-- Activity (20261031000510_credit_covered_invoices.sql), plus: whether autopay is charging the
-- invoice, for automations that treat those differently.
create or replace function private.activity_invoices() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_client text := private.client_name(new.client_id);
  v_data jsonb := jsonb_build_object('number', new.number, 'total', new.total, 'balance_due', new.balance_due,
    'autopay', exists (select 1 from public.autopay_charges a where a.invoice_id = new.id and a.status <> 'called_off'));
  v_credit boolean := coalesce(new.amount_paid, 0) = 0 and coalesce(new.credit_amount, 0) > 0;
begin
  if (tg_op = 'INSERT' and new.status <> 'draft') or (tg_op = 'UPDATE' and new.status is distinct from old.status) then
    case new.status
      when 'sent' then
        if tg_op = 'INSERT' or old.status = 'draft' then
          perform private.emit(new.company_id, 'invoice.sent', 'invoice', new.id, format('Invoice #%s sent to %s (%s)', new.number, v_client, private.money(new.total)), v_data);
        end if;
      when 'paid' then
        perform private.emit(new.company_id, 'invoice.paid', 'invoice', new.id,
          case
            when v_credit then format('Invoice #%s for %s covered by a referral credit', new.number, v_client)
            when coalesce(new.amount_paid, 0) = 0 then format('Invoice #%s for %s had nothing to pay', new.number, v_client)
            else format('Invoice #%s paid by %s (%s)', new.number, v_client, private.money(new.total)) end,
          v_data || jsonb_build_object('amount_paid', coalesce(new.amount_paid, 0), 'covered_by_credit', v_credit));
      when 'overdue' then
        if tg_op = 'INSERT' or old.status <> 'written_off' then
          perform private.emit(new.company_id, 'invoice.overdue', 'invoice', new.id, format('Invoice #%s for %s is past due (%s owing)', new.number, v_client, private.money(new.balance_due)), v_data);
        end if;
      when 'written_off' then
        perform private.emit(new.company_id, 'invoice.written_off', 'invoice', new.id, format('Invoice #%s for %s written off (%s)', new.number, v_client, private.money(new.balance_due)), v_data);
      else null;
    end case;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- A charge's status: who's told what, once per change
-- ---------------------------------------------------------------------------------------------

-- paid (from charging or processing): the receipt, but not between tries after a busy Stripe
-- (charging, no claim, busy_since set): autopay charged nothing then, so the client paid its Stripe
-- invoice on Stripe's page themselves. failed and needs_client: the client's notice,
-- the office's notification and autopay.failed, only when it's a new failure (so a claim released
-- back to 'failed' tells nobody twice). needs_approval: the office. called_off with an invoice left
-- as a draft or still owed: its Stripe invoice is brought in step (syncStripeInvoice voids a
-- charge_automatically one nothing will pay now) and the office is told, unless it did it itself.
-- Not when it was paid another way and that payment is still being booked (the server calls a
-- charge off just before it books the client paying autopay's Stripe invoice with another card).
create function private.autopay_charge_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_client text := private.client_name(new.client_id);
  v_link text := case when new.invoice_id is not null then '/invoices/' || new.invoice_id else '/clients/' || new.client_id end;
  v_tz text;
  v_card text := private.method_label_of(new.payment_method_id);
  v_bank boolean;
  v_body text;
  i public.invoices;
begin
  if new.invoice_id is not null then
    select * into i from public.invoices where id = new.invoice_id;
  end if;
  select coalesce(c.timezone, 'UTC') into v_tz from public.companies c where c.id = new.company_id;

  if new.status = 'paid' and (old.status = 'processing'
                              or (old.status = 'charging' and (old.claim_token is not null or old.busy_since is null))) then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'autopay.receipt', jsonb_build_object('charge_id', new.id));

  elsif new.status in ('failed', 'needs_client')
        and (new.failures > old.failures or (new.status = 'needs_client' and old.status in ('charging', 'processing'))) then
    insert into public.outbox (company_id, topic, payload)
    values (new.company_id, 'autopay.notice', jsonb_build_object('charge_id', new.id, 'status', new.status, 'failures', new.failures));
    if new.status = 'failed' then
      perform private.autopay_notify(new.company_id, format('Autopay failed: %s', v_client),
        format('Invoice #%s · %s. We''ll try again on %s.', i.number, rtrim(coalesce(new.last_error, 'The card was declined'), '.'),
               to_char(new.due_at at time zone v_tz, 'Mon FMDD')),
        v_link);
    else
      v_bank := old.status = 'processing'
        or exists (select 1 from public.client_payment_methods pm where pm.id = new.payment_method_id and pm.type = 'us_bank_account');
      v_body := case
        when new.failures > old.failures and v_bank then 'Their bank payment didn''t go through, so autopay is paused until they update it.'
        when new.failures > old.failures then 'The card was declined twice, so autopay is paused until they update it.'
        when new.last_error is null or new.decline_code in ('authentication_required', 'invoice_payment_intent_requires_action', 'requires_action')
          then 'Their bank wants them to confirm the payment.'
        else new.last_error
      end;
      perform private.autopay_notify(new.company_id, format('Autopay needs %s', v_client), v_body, v_link);
    end if;
    if new.invoice_id is not null then
      perform private.emit(new.company_id, 'autopay.failed', 'invoice', new.invoice_id,
        format('Autopay failed for invoice #%s (%s)', i.number, v_client),
        jsonb_build_object('client_id', new.client_id, 'card', v_card, 'reason', new.last_error, 'status', new.status));
    end if;

  elsif new.status = 'needs_approval' then
    perform private.autopay_notify(new.company_id, format('Approve a %s charge for %s', private.money(i.balance_due), v_client),
      coalesce(new.last_error, 'It''s over your autopay limit, so it waits for your OK.'), v_link);

  elsif new.status = 'called_off' and new.invoice_id is not null and i.id is not null
        and new.last_error is distinct from 'The invoice was deleted' then
    if i.status = 'draft' then
      perform private.autopay_enqueue_stripe(new.company_id, new.invoice_id);
      if new.last_error is null or new.last_error not in ('Called off by the office', 'The invoice went back to draft') then
        perform private.autopay_notify(new.company_id, format('Send invoice #%s to %s the usual way', i.number, v_client), new.last_error, v_link);
      end if;
    elsif i.status in ('sent', 'partially_paid', 'overdue') and i.balance_due > 0 and new.last_error is distinct from 'Paid another way' then
      perform private.autopay_enqueue_stripe(new.company_id, new.invoice_id);
      if new.last_error is null or new.last_error not in ('Called off by the office', 'Sent the usual way') then
        perform private.autopay_notify(new.company_id, format('Invoice #%s for %s wasn''t charged', i.number, v_client),
          format('%s. It''s owed as usual; send a reminder if they need the Pay link.', rtrim(coalesce(new.last_error, 'Autopay was called off'), '.')), v_link);
      end if;
    end if;
  end if;
  return null;
end $$;
create trigger status_changed after update of status on public.autopay_charges
  for each row when (old.status is distinct from new.status)
  execute function private.autopay_charge_status();

-- ---------------------------------------------------------------------------------------------
-- Who reads what about autopay
-- ---------------------------------------------------------------------------------------------

-- Estimators read activity whose subject isn't an invoice; autopay's carries card names and why a
-- charge failed, so only the office with the invoices area reads it.
create policy activity_autopay on public.activity as restrictive for select to authenticated
  using ((not starts_with(verb, 'autopay.') and not starts_with(verb, 'payment_method.'))
         or (private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'invoices')));

-- As in 20261018000800_review_fixes.sql, plus: messages about autopay (related_type 'autopay')
-- are read only by the office with the invoices area, like invoice messages. Autopay invites and
-- what rules on autopay.* send carry card names and the client's own link.
drop policy messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (
  private.is_member(company_id) and case
    when direction <> 'in' and (related_type in ('invoice', 'autopay') or (related_type is null and channel = 'note' and external_id is not null)) then
      private.has_role(company_id, '{owner,admin,office}') and private.has_perm(company_id, 'invoices')
    when direction <> 'in' and related_type in ('quote', 'job') then
      private.has_role(company_id, '{owner,admin,office,estimator}')
    else
      private.has_role(company_id, '{owner,admin,office,estimator,crew_lead}')
      or (client_id is not null and private.crew_sees_client(client_id))
  end
);

-- Automation rules about autopay (as 20261025007001_sub_offer_rules.sql, area 'invoices'): read,
-- made, changed and deleted only with the invoices area, and their runs read only with it too.
create policy automation_rules_autopay on public.automation_rules as restrictive for all to authenticated
  using ((not starts_with(trigger, 'autopay.') and not starts_with(trigger, 'payment_method.')) or private.has_perm(company_id, 'invoices'))
  with check ((not starts_with(trigger, 'autopay.') and not starts_with(trigger, 'payment_method.')) or private.has_perm(company_id, 'invoices'));
create policy automation_runs_autopay on public.automation_runs as restrictive for select to authenticated
  using (private.has_perm(company_id, 'invoices') or exists (
    select 1 from public.automation_rules r where r.id = rule_id
    and not starts_with(r.trigger, 'autopay.') and not starts_with(r.trigger, 'payment_method.')));

-- What a rule about autopay may do, whoever saves it: no client note (crews read them), only the
-- office told, and no card or autopay details in a task (crews see tasks on the schedule).
create function private.autopay_rule_actions() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actions jsonb := case when jsonb_typeof(new.actions) = 'array' then new.actions else '[]'::jsonb end;
begin
  if not starts_with(new.trigger, 'autopay.') and not starts_with(new.trigger, 'payment_method.') then
    return new;
  end if;
  if exists (select 1 from jsonb_array_elements(v_actions) a where a ->> 'type' = 'add_note') then
    raise exception 'A rule about autopay can''t add a client note (crews can read them)' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_actions) a
    cross join lateral jsonb_array_elements_text(case when jsonb_typeof(a -> 'roles') = 'array' then a -> 'roles' else '[]' end) r(role)
    where a ->> 'type' = 'notify' and r.role not in ('owner', 'admin', 'office')
  ) then
    raise exception 'Only the office hears about autopay, never the crew' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_actions) a where a ->> 'type' = 'create_task' and strpos(coalesce(a ->> 'title', ''), '{{autopay.') > 0) then
    raise exception 'A task can''t carry card or autopay details' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger autopay_actions before insert or update of trigger, actions on public.automation_rules
  for each row execute function private.autopay_rule_actions();

-- ---------------------------------------------------------------------------------------------
-- The task's functions (service role)
-- ---------------------------------------------------------------------------------------------

/**
 * The task's batch: due charges, and ones whose worker stopped. The task itself stops a row on its
 * 6th claim after asking Stripe; this only catches rows a crashing task never got to. A failed or
 * waiting charge whose invoice has a bank payment on its way in Stripe (the client paying it on
 * Stripe's page) waits: once it clears the invoice is paid, and if it bounces it's tried as usual.
 */
create function public.claim_autopay_charges(p_limit integer default 25, p_company uuid default null)
returns setof public.autopay_charges
language plpgsql security definer set search_path = '' as $$
declare
  v_token uuid := gen_random_uuid();
begin
  update public.autopay_charges
  set status = 'called_off', claim_token = null, locked_until = null, busy_since = null,
      last_error = 'Stopped after 8 tries. Check the invoice and Stripe'
  where status = 'charging' and locked_until < now() and attempts >= 8
    and (p_company is null or company_id = p_company);

  return query
  update public.autopay_charges a
  set status = 'charging', locked_until = now() + interval '5 minutes', claim_token = v_token, attempts = a.attempts + 1
  where a.id in (
    select x.id from public.autopay_charges x
    where ((x.status in ('waiting', 'failed') and x.due_at <= now()
            and not exists (select 1 from public.stripe_invoices s
                            where s.invoice_id = x.invoice_id and s.status = 'processing' and s.detached_at is null))
           or (x.status = 'charging' and x.locked_until < now()))
      and (p_company is null or x.company_id = p_company)
    order by x.due_at
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update skip locked
  )
  returning a.*;
end $$;

/**
 * Bill a claimed charge: make its invoice (a draft) when it has none, then say what to do next.
 * Runs only while the caller holds the claim. Money stays in one transaction here.
 *
 * Returns {outcome: 'charge', invoice_id, invoice_status, balance_due, method: {id,
 * stripe_payment_method_id, stripe_customer_id, livemode, stripe_account, type}}, or {outcome:
 * 'called_off' | 'paid' | 'needs_approval' | 'lost', reason, invoice_id}. All but 'charge' and 'lost'
 * have already written the row and let go of the claim.
 */
create function public.autopay_bill(p_charge uuid, p_token uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
  j public.jobs;
  i public.invoices;
  m public.client_payment_methods;
  v_autopay jsonb;
  v_pm uuid;
  v_invoice uuid;
  v_accepted timestamptz;
  v_since timestamptz;
  v_reason text;
  v_max numeric;
begin
  select * into r from public.autopay_charges where id = p_charge for update;
  if not found or p_token is null or r.status <> 'charging' or r.claim_token is distinct from p_token then
    return jsonb_build_object('outcome', 'lost', 'reason', null, 'invoice_id', r.invoice_id);
  end if;

  -- 1. Billed already (a retry, or an approved charge): what's become of the invoice.
  if r.invoice_id is not null then
    select * into i from public.invoices where id = r.invoice_id for update;
    if i.status = 'paid' then
      if private.autopay_paid_by_charge(i.id) then
        return private.autopay_bill_end(r.id, 'paid', null);   -- went through before its worker stopped
      end if;
      return private.autopay_bill_end(r.id, 'called_off', 'Paid another way');
    end if;
    -- Stripe credit paid its own Stripe invoice in full before it was marked sent (its worker stopped
    -- between): sent now, as finish_autopay_charge does, so invoice_totals makes it paid.
    if i.status = 'draft' and i.balance_due <= 0 and private.autopay_paid_by_charge(i.id) then
      update public.invoices set status = 'sent' where id = i.id and status = 'draft';
      -- Nothing on the card: a draft is only paid before /pay, so by credit.
      update public.autopay_charges set charged_amount = 0 where id = r.id;
      return private.autopay_bill_end(r.id, 'paid', null);
    end if;
    if i.status not in ('draft', 'sent', 'partially_paid', 'overdue') or i.balance_due <= 0 then
      return private.autopay_bill_end(r.id, 'called_off', case i.status when 'void' then 'The invoice was voided'
        when 'written_off' then 'The invoice was written off' else 'Nothing is owed on it' end);
    end if;
  end if;

  -- 2. Still on, on fresh data (the same checks billed or not; the status trigger tells the office
  -- when that leaves an invoice unpaid).
  select * into j from public.jobs where id = r.job_id;
  select private.autopay_of(c.settings) into v_autopay from public.companies c where c.id = r.company_id;
  v_pm := private.autopay_ready(r.company_id, r.client_id);
  if j.id is null or not j.autopay or j.status = 'archived' then
    return private.autopay_bill_end(r.id, 'called_off', 'Autopay is off for this job');
  end if;
  if v_autopay -> 'enabled' is distinct from 'true'::jsonb then
    return private.autopay_bill_end(r.id, 'called_off', 'Autopay is turned off in Settings');
  end if;
  if v_pm is null then
    return private.autopay_bill_end(r.id, 'called_off', 'Autopay is off for this client');
  end if;
  if r.bill = 'standard' and r.invoice_id is null and j.status <> 'requires_invoicing' then
    return private.autopay_bill_end(r.id, 'called_off', 'The job isn''t waiting to be billed');
  end if;
  if r.bill = 'visits' and r.invoice_id is not null
     and exists (select 1 from public.visits v where v.invoice_id = r.invoice_id and v.status <> 'completed') then
    return private.autopay_bill_end(r.id, 'called_off', 'A visit on it was reopened');
  end if;
  update public.autopay_charges set payment_method_id = v_pm where id = r.id;

  -- 3. No invoice yet: make it, as the office's Invoice button would (this runs as the function's
  -- owner, past row-level security). It bills every finished visit of the job not yet billed. Those
  -- that queued another of the job's charges still gathering visits (one made while this was
  -- claimed) count as queued for this one too: that charge has nothing left to bill.
  if r.invoice_id is null then
    begin
      v_invoice := public.create_invoice_for_job(r.job_id, r.bill);
    exception when sqlstate '22023' or sqlstate 'P0002' then
      return private.autopay_bill_end(r.id, 'called_off', left(sqlerrm, 1000));
    end;
    update public.autopay_charges a
    set invoice_id = v_invoice,
        visit_ids = a.visit_ids || array(
          select distinct x
          from public.autopay_charges o cross join lateral unnest(o.visit_ids) x
          join public.visits v on v.id = x and v.invoice_id = v_invoice
          where o.job_id = r.job_id and o.id <> r.id and o.status in ('waiting', 'charging') and o.invoice_id is null
            and x <> all (a.visit_ids))
    where a.id = r.id
    returning a.visit_ids into r.visit_ids;
    r.invoice_id := v_invoice;
  end if;
  select * into i from public.invoices where id = r.invoice_id for update;

  -- 4. Asking first, only while the invoice is still a draft. Autopay charges without the office's
  -- OK only for visits it queued itself (visit_ids: finished while autopay was in force for the
  -- client and the job). A visit freed by a voided or deleted invoice, or finished while autopay
  -- was paused, off in Settings or off for the job, wasn't, so the bill waits for Approve charge.
  -- The dates are checked too, for a visit finished offline (or marked done later) before autopay
  -- started, or while it was paused, and queued when it synced (an offline Complete keeps its tap
  -- time as completed_at: visit_defaults, visit_sub_guard): from the start of the client's unbroken
  -- run of agreements (a card changed, revoked_via 'replaced', doesn't break it), from when the
  -- job's autopay went on, and from when the office last resumed it (resumed_at).
  if i.status = 'draft' then
    if r.bill = 'visits' and r.approved_at is null then
      select min(a.accepted_at) into v_accepted from public.autopay_authorizations a
      where a.company_id = r.company_id and a.client_id = r.client_id
        and a.accepted_at > coalesce((
          select max(b.revoked_at) from public.autopay_authorizations b
          where b.company_id = r.company_id and b.client_id = r.client_id and b.revoked_at is not null and b.revoked_via <> 'replaced'
        ), '-infinity'::timestamptz);
      select greatest(v_accepted, coalesce(j.autopay_since, '-infinity'::timestamptz), coalesce(a.resumed_at, '-infinity'::timestamptz))
      into v_since from public.autopay_authorizations a
      where a.company_id = r.company_id and a.client_id = r.client_id and a.revoked_at is null;
      v_reason := case
        when exists (select 1 from public.visits v where v.invoice_id = i.id and v.completed_at < v_since)
          then 'Includes visits from before autopay started'
        when exists (select 1 from public.visits v where v.invoice_id = i.id and v.id <> all (r.visit_ids))
          then 'Includes visits autopay didn''t queue (finished while it was off, or from a voided invoice)'
      end;
      if v_reason is not null then
        update public.autopay_charges
        set status = 'needs_approval', last_error = v_reason, claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
        return jsonb_build_object('outcome', 'needs_approval', 'reason', v_reason, 'invoice_id', i.id);
      end if;
    end if;
    v_max := case when jsonb_typeof(v_autopay -> 'max_amount') = 'number' then (v_autopay -> 'max_amount')::numeric end;
    if v_max is not null and i.balance_due > v_max and (r.approved_at is null or i.balance_due > r.approved_amount) then
      update public.autopay_charges
      set status = 'needs_approval', last_error = null, claim_token = null, locked_until = null, busy_since = null,
          approved_at = null, approved_by = null, approved_amount = null
      where id = r.id;
      return jsonb_build_object('outcome', 'needs_approval', 'reason', null, 'invoice_id', i.id);
    end if;
  end if;

  -- 5. Charge it: the claim is held for the Stripe calls.
  update public.autopay_charges set locked_until = now() + interval '5 minutes' where id = r.id;
  select * into m from public.client_payment_methods where id = v_pm;
  return jsonb_build_object(
    'outcome', 'charge', 'invoice_id', i.id, 'invoice_status', i.status, 'balance_due', i.balance_due,
    'method', jsonb_build_object('id', m.id, 'stripe_payment_method_id', m.stripe_payment_method_id,
      'stripe_customer_id', m.stripe_customer_id, 'livemode', m.livemode, 'stripe_account', m.stripe_account, 'type', m.type));
end $$;

/**
 * Mark a claimed charge's draft invoice sent (no email), once the Stripe invoice for it is made.
 * False, and nothing changes, unless the caller holds the claim and the invoice is still there,
 * still owed and still for exactly the amount Stripe will charge (p_amount_cents: the Stripe
 * invoice's lines total, before any customer balance; a charge carries no tip).
 */
create function public.autopay_mark_sent(p_charge uuid, p_token uuid, p_amount_cents integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
  i public.invoices;
begin
  select * into r from public.autopay_charges where id = p_charge for update;
  if not found or p_token is null or r.status <> 'charging' or r.claim_token is distinct from p_token or r.invoice_id is null then
    return false;
  end if;
  select * into i from public.invoices where id = r.invoice_id for update;
  if not found or i.status not in ('draft', 'sent', 'partially_paid', 'overdue') or round(i.balance_due * 100) is distinct from p_amount_cents then
    return false;
  end if;
  update public.invoices set status = 'sent' where id = i.id and status = 'draft';
  update public.autopay_charges set locked_until = now() + interval '5 minutes' where id = r.id;
  return true;
end $$;

/**
 * How a charge went. False when the caller no longer holds it. With p_token: the task, while it
 * holds the claim. Without: the webhook, for a bank payment on its way ('processing'), only 'paid'
 * or 'bank_failed', and only for p_company's own charge.
 *
 *   paid          paid, with what Stripe charged
 *   processing    a bank payment is on its way
 *   declined      failed, tried again in 3 days; the second in a row needs the client, and the card
 *                 needs updating
 *   bank_failed   a bank payment bounced: needs the client, never retried (presenting a closed or
 *                 unauthorized account again breaks Nacha rules and costs a fee)
 *   needs_client  the client has to do something (confirm with their bank, a card Stripe refused)
 *   called_off    with why
 *   retry         Stripe was down or rate-limited, or the task threw: tried again in 10 minutes, and
 *                 the attempt counts
 *   busy          Stripe's invoice is still being made, or a bank payment is on its way: tried again
 *                 in 10 minutes without using an attempt, and called off after a day of it
 */
create function public.finish_autopay_charge(p_id uuid, p_outcome text, p_token uuid default null,
  p_error text default null, p_decline text default null, p_amount numeric default null, p_company uuid default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
  v_error text := left(p_error, 1000);
  v_decline text := left(p_decline, 100);
begin
  if p_outcome is null or p_outcome not in ('paid', 'processing', 'declined', 'bank_failed', 'needs_client', 'called_off', 'retry', 'busy') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  select * into r from public.autopay_charges where id = p_id for update;
  if not found then
    return false;
  end if;
  if p_token is not null then
    if r.status <> 'charging' or r.claim_token is distinct from p_token or (p_company is not null and r.company_id <> p_company) then
      return false;
    end if;
  elsif p_company is null or r.company_id <> p_company or r.status <> 'processing' or p_outcome not in ('paid', 'bank_failed') then
    return false;
  end if;

  case p_outcome
    when 'paid' then
      update public.autopay_charges
      set status = 'paid', charged_at = now(), charged_amount = coalesce(p_amount, charged_amount), last_error = null,
          claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
      -- Paid before it was marked sent (Stripe credit paid it all as its Stripe invoice was made):
      -- it's sent, so it doesn't stay a draft carrying a payment (invoice_totals then makes it paid).
      update public.invoices set status = 'sent' where id = r.invoice_id and status = 'draft';
    when 'processing' then
      update public.autopay_charges
      set status = 'processing', charged_amount = p_amount, claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
    when 'declined' then
      if r.failures + 1 >= 2 then
        update public.client_payment_methods set status = 'needs_update' where id = r.payment_method_id and status = 'active';
        update public.autopay_charges
        set status = 'needs_client', failures = r.failures + 1, last_error = v_error, decline_code = v_decline,
            claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
      else
        update public.autopay_charges
        set status = 'failed', failures = r.failures + 1, due_at = now() + interval '3 days', last_error = v_error, decline_code = v_decline,
            claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
      end if;
    when 'bank_failed' then
      update public.client_payment_methods set status = 'needs_update' where id = r.payment_method_id and status = 'active';
      update public.autopay_charges
      set status = 'needs_client', failures = r.failures + 1, last_error = coalesce(v_error, 'The bank payment didn''t go through'),
          decline_code = coalesce(v_decline, 'bank_failed'), claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
    when 'needs_client' then
      update public.autopay_charges
      set status = 'needs_client', last_error = v_error, decline_code = v_decline, claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
    when 'called_off' then
      update public.autopay_charges
      set status = 'called_off', last_error = v_error, claim_token = null, locked_until = null, busy_since = null
      where id = r.id;
    when 'retry' then
      update public.autopay_charges
      set claim_token = null, locked_until = now() + interval '10 minutes', last_error = v_error
      where id = r.id;
    when 'busy' then
      if r.busy_since < now() - interval '1 day' then
        update public.autopay_charges
        set status = 'called_off', last_error = 'Stripe was busy with this for a day. Check the invoice and Stripe',
            claim_token = null, locked_until = null, busy_since = null
        where id = r.id;
      else
        update public.autopay_charges
        set claim_token = null, locked_until = now() + interval '10 minutes', last_error = v_error,
            attempts = greatest(r.attempts - 1, 0), busy_since = coalesce(r.busy_since, now())
        where id = r.id;
      end if;
  end case;
  return true;
end $$;

/**
 * Claimed but never started (the batch stopped early): back as they were, without using an attempt.
 * One still gathering visits whose job has another waiting row by now is called off: that row bills
 * them all, and takes on its visit_ids. Returns how many were let go.
 */
create function public.release_autopay_charges(p_token uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_merged integer;
  v_back integer;
begin
  with merged as (
    update public.autopay_charges a
    set status = 'called_off', last_error = 'Merged into the next charge', claim_token = null, locked_until = null, busy_since = null,
        attempts = greatest(a.attempts - 1, 0)
    where a.id = any (p_ids) and a.claim_token = p_token and a.status = 'charging' and a.invoice_id is null
      and exists (select 1 from public.autopay_charges o where o.job_id = a.job_id and o.id <> a.id and o.status = 'waiting' and o.invoice_id is null)
    returning a.job_id, a.visit_ids
  ), by_job as (
    select m.job_id, array_agg(distinct x) as visit_ids from merged m cross join lateral unnest(m.visit_ids) x group by m.job_id
  ), taken_on as (
    update public.autopay_charges o
    set visit_ids = o.visit_ids || array(select x from unnest(b.visit_ids) x where x <> all (o.visit_ids))
    from by_job b
    where o.job_id = b.job_id and o.status = 'waiting' and o.invoice_id is null
    returning o.id
  )
  select count(*) into v_merged from merged;
  update public.autopay_charges a
  set status = case when a.failures > 0 then 'failed' else 'waiting' end, attempts = greatest(a.attempts - 1, 0),
      claim_token = null, locked_until = null
  where a.id = any (p_ids) and a.claim_token = p_token and a.status = 'charging';
  get diagnostics v_back = row_count;
  return v_merged + v_back;
end $$;

/**
 * Save a card or bank account from Stripe (a finished setup, or one brought in). Updates the one
 * already saved with that Stripe id. make_default: it becomes the client's default.
 *
 * p_method: stripe_payment_method_id, stripe_customer_id, stripe_account, livemode, type, brand,
 * wallet, last4, exp_month, exp_year, bank_name, status ('pending' | 'active'), source ('hub' |
 * 'stripe_import'), saved_via ('client' | 'office' | 'legacy': the kind of Hub link whose setup saved
 * it, from the setup's crewtavo_via; 'client' when not said), make_default (boolean). A removed one always
 * stays removed (a late or repeated webhook, or a replayed session_id, can't bring it back; its id
 * comes back unchanged). A pending bank account becomes active once verified, never the other way.
 * Saved again, saved_via changes only when p_method says it (a card brought in from Stripe later
 * doesn't undo it). Callers pass make_default false while the client has an agreement in force for
 * another method.
 */
create function public.autopay_save_payment_method(p_company uuid, p_client uuid, p_method jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_pm text := nullif(btrim(p_method ->> 'stripe_payment_method_id'), '');
  v_status text := coalesce(nullif(p_method ->> 'status', ''), 'active');
  v_source text := coalesce(nullif(p_method ->> 'source', ''), 'hub');
  v_via text := nullif(p_method ->> 'saved_via', '');
  v_old public.client_payment_methods;
  v_id uuid;
begin
  if not exists (select 1 from public.clients c where c.id = p_client and c.company_id = p_company) then
    raise exception 'Client not found' using errcode = 'P0002';
  end if;
  if v_pm is null then
    raise exception 'Say which card to save' using errcode = '22023';
  end if;
  if v_status not in ('pending', 'active') then
    raise exception 'A card is saved as pending or active' using errcode = '22023';
  end if;
  if v_source not in ('hub', 'stripe_import') then
    raise exception 'Say where the card came from' using errcode = '22023';
  end if;
  if v_via is not null and v_via not in ('client', 'office', 'legacy') then
    raise exception 'Say which link the card was saved through' using errcode = '22023';
  end if;

  select * into v_old from public.client_payment_methods
  where company_id = p_company and stripe_payment_method_id = v_pm for update;
  if found then
    if v_old.client_id <> p_client then
      raise exception 'That card is saved for another client' using errcode = '22023';
    end if;
    if v_old.status = 'removed' then
      return v_old.id;
    end if;
    update public.client_payment_methods
    set stripe_customer_id = coalesce(nullif(p_method ->> 'stripe_customer_id', ''), stripe_customer_id),
        stripe_account = coalesce(nullif(p_method ->> 'stripe_account', ''), stripe_account),
        livemode = coalesce(case when jsonb_typeof(p_method -> 'livemode') = 'boolean' then (p_method ->> 'livemode')::boolean end, livemode),
        type = coalesce(nullif(p_method ->> 'type', ''), type),
        brand = coalesce(nullif(p_method ->> 'brand', ''), brand),
        wallet = coalesce(nullif(p_method ->> 'wallet', ''), wallet),
        last4 = coalesce(nullif(p_method ->> 'last4', ''), last4),
        exp_month = coalesce(case when jsonb_typeof(p_method -> 'exp_month') = 'number' then (p_method -> 'exp_month')::numeric::smallint end, exp_month),
        exp_year = coalesce(case when jsonb_typeof(p_method -> 'exp_year') = 'number' then (p_method -> 'exp_year')::numeric::smallint end, exp_year),
        bank_name = coalesce(nullif(p_method ->> 'bank_name', ''), bank_name),
        status = case when status = 'pending' and v_status = 'active' then 'active' else status end,
        saved_via = coalesce(v_via, saved_via)
    where id = v_old.id;
    v_id := v_old.id;
  else
    insert into public.client_payment_methods (company_id, client_id, stripe_payment_method_id, stripe_customer_id, stripe_account,
      livemode, type, brand, wallet, last4, exp_month, exp_year, bank_name, status, source, saved_via)
    values (p_company, p_client, v_pm, nullif(p_method ->> 'stripe_customer_id', ''), nullif(p_method ->> 'stripe_account', ''),
      case when jsonb_typeof(p_method -> 'livemode') = 'boolean' then (p_method ->> 'livemode')::boolean end,
      nullif(p_method ->> 'type', ''), nullif(p_method ->> 'brand', ''), nullif(p_method ->> 'wallet', ''), nullif(p_method ->> 'last4', ''),
      case when jsonb_typeof(p_method -> 'exp_month') = 'number' then (p_method -> 'exp_month')::numeric::smallint end,
      case when jsonb_typeof(p_method -> 'exp_year') = 'number' then (p_method -> 'exp_year')::numeric::smallint end,
      nullif(p_method ->> 'bank_name', ''), v_status, v_source, coalesce(v_via, 'client'))
    returning id into v_id;
  end if;

  if p_method -> 'make_default' = 'true'::jsonb then
    update public.client_payment_methods set is_default = false
    where client_id = p_client and company_id = p_company and is_default and id <> v_id;
    update public.client_payment_methods set is_default = true where id = v_id and not is_default;
  end if;
  return v_id;
end $$;

/**
 * The client's agreement, from the Hub: the terms as they are now, which the page showed as
 * p_terms_version. An agreement already in force for another card is replaced, and a pause on it
 * (and when it was last resumed) carries over: changing card doesn't end it (the office resumes
 * autopay). Same card and same terms: the one in force (a second tap, or a retry).
 *
 * p_source 'hub' (a card saved on Stripe's page) or 'confirmed' (one brought in from Stripe, confirmed
 * with one tap). After the client or the office turned autopay off, an old link can't switch it back
 * on with the card that was on file: that takes a card saved since (a fresh Stripe setup).
 */
create function public.autopay_record_authorization(p_company uuid, p_client uuid, p_payment_method uuid,
  p_source text, p_terms_version text, p_ip text default null, p_user_agent text default null,
  p_link_kind text default null, p_link_via text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  m public.client_payment_methods;
  v_live public.autopay_authorizations;
  v_last public.autopay_authorizations;
  v_id uuid;
begin
  if p_source is null or p_source not in ('hub', 'confirmed') then
    raise exception 'Say how the client agreed' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company and private.autopay_of(c.settings) -> 'enabled' = 'true'::jsonb) then
    raise exception 'Autopay is turned off' using errcode = '22023';
  end if;
  if p_terms_version is distinct from private.autopay_terms_version(p_company) then
    raise exception 'The terms changed. Read them again and agree' using errcode = '22023';
  end if;
  select * into m from public.client_payment_methods
  where id = p_payment_method and company_id = p_company and client_id = p_client and status in ('active', 'pending');
  if not found then
    raise exception 'That card isn''t saved anymore' using errcode = 'P0002';
  end if;

  -- One at a time for a client, so two taps don't both replace the agreement.
  perform pg_advisory_xact_lock(hashtextextended('autopay-agreement:' || p_client::text, 0));
  select * into v_last from public.autopay_authorizations
  where company_id = p_company and client_id = p_client order by accepted_at desc, created_at desc limit 1;
  if v_last.revoked_via in ('client', 'office') and v_last.revoked_at > m.created_at then
    raise exception 'Add your card again to turn autopay back on' using errcode = '22023';
  end if;

  select * into v_live from public.autopay_authorizations
  where company_id = p_company and client_id = p_client and revoked_at is null for update;
  if found then
    if v_live.payment_method_id = m.id and v_live.terms_version = p_terms_version then
      return v_live.id;
    end if;
    update public.autopay_authorizations set revoked_at = now(), revoked_via = 'replaced' where id = v_live.id;
  end if;

  -- The card agreed to is the client's default (here, and only here, for a client with an agreement).
  update public.client_payment_methods set is_default = false
  where client_id = p_client and company_id = p_company and is_default and id <> m.id;
  update public.client_payment_methods set is_default = true where id = m.id and not is_default;

  insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, ip, user_agent,
    source, link_kind, link_via, paused_at, paused_by, resumed_at)
  values (p_company, p_client, m.id, private.autopay_terms_shown(p_company), p_terms_version, left(p_ip, 100), left(p_user_agent, 500),
    p_source, p_link_kind, p_link_via, v_live.paused_at, v_live.paused_by, v_live.resumed_at)
  returning id into v_id;
  return v_id;
end $$;

/** Turn off a client's autopay. Returns how many agreements were turned off (0 or 1). */
create function public.autopay_revoke(p_company uuid, p_client uuid, p_via text, p_by uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if p_via is null or p_via not in ('client', 'office', 'stripe', 'account') then
    raise exception 'Say who turned autopay off' using errcode = '22023';
  end if;
  update public.autopay_authorizations
  set revoked_at = now(), revoked_via = p_via, revoked_by = p_by
  where company_id = p_company and client_id = p_client and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

/**
 * The company stopped using a Stripe account (or switched test and live): its saved methods can't
 * be charged with the new key. They're removed, their agreements end, and the office is told once
 * which clients need to set it up again. Returns how many clients.
 */
create function public.autopay_account_left(p_company uuid, p_livemode boolean, p_account text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_methods uuid[];
  v_clients uuid[];
  v_count integer;
  v_names text;
begin
  with gone as (
    update public.client_payment_methods
    set status = 'removed', removed_at = now(), removed_reason = 'account', is_default = false
    where company_id = p_company and status <> 'removed' and livemode = p_livemode
      and (p_account is null or stripe_account is null or stripe_account = p_account)
    returning id, client_id
  )
  select array_agg(id), array_agg(distinct client_id) into v_methods, v_clients from gone;
  if v_methods is null then
    return 0;
  end if;

  with ended as (
    update public.autopay_authorizations
    set revoked_at = now(), revoked_via = 'account'
    where company_id = p_company and client_id = any (v_clients) and revoked_at is null
    returning client_id
  )
  select array_agg(distinct client_id) into v_clients from ended;

  -- A bank payment that hasn't settled in the clearing time won't be heard of now.
  update public.autopay_charges
  set status = 'called_off', last_error = 'The Stripe account it was in was switched away from. Check it there',
      claim_token = null, locked_until = null, busy_since = null
  where company_id = p_company and status = 'processing' and payment_method_id = any (v_methods)
    and updated_at < now() - interval '30 days';

  v_count := coalesce(cardinality(v_clients), 0);
  if v_count > 0 then
    select string_agg(n, ', ') into v_names from (
      select c.display_name as n from public.clients c where c.id = any (v_clients) order by c.display_name limit 10
    ) x;
    perform private.autopay_notify(p_company,
      format('Autopay needs setting up again for %s client%s', v_count, case when v_count = 1 then '' else 's' end),
      'Their saved cards were in the Stripe account you switched from: ' || v_names, '/clients');
  end if;
  return v_count;
end $$;

/**
 * Cards expiring next month (hourly, from 8 in the morning where the company is): one
 * payment_method.expiring event each, once per expiry. Returns how many.
 */
create function public.emit_card_expiry_alerts() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  pm public.client_payment_methods;
  v_count integer := 0;
begin
  for pm in
    with due as (
      select m.id
      from public.client_payment_methods m
      join public.companies c on c.id = m.company_id
      where m.status = 'active' and m.is_default and m.type in ('card', 'link')
        and m.exp_year is not null and m.exp_month is not null
        and exists (select 1 from public.autopay_authorizations a where a.client_id = m.client_id and a.company_id = m.company_id and a.revoked_at is null)
        and make_date(m.exp_year, m.exp_month, 1) = (date_trunc('month', private.company_today(m.company_id)) + interval '1 month')::date
        and extract(hour from now() at time zone c.timezone) >= 8   -- in the morning, not at midnight
        and m.expiry_alerted_for is distinct from make_date(m.exp_year, m.exp_month, 1)
      for update of m skip locked
    )
    update public.client_payment_methods m
    set expiry_alerted_for = make_date(m.exp_year, m.exp_month, 1)
    from due where m.id = due.id
    returning m.*
  loop
    perform private.emit(pm.company_id, 'payment_method.expiring', 'client', pm.client_id,
      format('%s''s %s expires next month', private.client_name(pm.client_id), private.method_label(pm)),
      jsonb_build_object('payment_method_id', pm.id, 'card', private.method_label(pm),
        'expires', lpad(pm.exp_month::text, 2, '0') || '/' || right(pm.exp_year::text, 2)));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------------------------
-- The team's functions (each checks the caller)
-- ---------------------------------------------------------------------------------------------

/** Approve charge: a charge over the limit goes ahead now. */
create function public.approve_autopay_charge(p_charge uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
begin
  select * into r from public.autopay_charges where id = p_charge for update;
  if not found or not (private.has_role(r.company_id, '{owner,admin,office}') and private.has_perm(r.company_id, 'invoices')) then
    raise exception 'Only the office with the invoices area can do that' using errcode = '42501';
  end if;
  if r.status <> 'needs_approval' then
    raise exception 'This charge isn''t waiting for your OK' using errcode = '22023';
  end if;
  update public.autopay_charges
  set status = 'waiting', due_at = now(), last_error = null, approved_by = (select auth.uid()), approved_at = now(),
      approved_amount = (select i.balance_due from public.invoices i where i.id = r.invoice_id)
  where id = r.id;
end $$;

/** Call it off: the invoice is left for the office to send the usual way (or as it is). */
create function public.call_off_autopay_charge(p_charge uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.autopay_charges;
begin
  select * into r from public.autopay_charges where id = p_charge for update;
  if not found or not (private.has_role(r.company_id, '{owner,admin,office}') and private.has_perm(r.company_id, 'invoices')) then
    raise exception 'Only the office with the invoices area can do that' using errcode = '42501';
  end if;
  -- Between tries after a busy or retry (charging with no claim), no Stripe call is under way.
  if not (r.status in ('waiting', 'needs_approval', 'failed', 'needs_client') or (r.status = 'charging' and r.claim_token is null)) then
    raise exception 'This charge can''t be called off now' using errcode = '22023';
  end if;
  update public.autopay_charges
  set status = 'called_off', last_error = 'Called off by the office', claim_token = null, locked_until = null, busy_since = null
  where id = r.id;
end $$;

/**
 * Pause or resume a client's autopay (their agreement stays). Resuming notes when (resumed_at): a
 * visit finished before it, synced later, waits for the office's OK (autopay_bill). A card the
 * client agreed to while it was paused is tried now on each charge left waiting on them
 * (autopay_try_new_card), as it would have been had it not been paused.
 */
create function public.autopay_pause(p_client uuid, p_paused boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := (select c.company_id from public.clients c where c.id = p_client);
  v_id uuid;
begin
  if v_company is null or not (private.has_role(v_company, '{owner,admin,office}') and private.has_perm(v_company, 'invoices')) then
    raise exception 'Only the office with the invoices area can do that' using errcode = '42501';
  end if;
  select a.id into v_id from public.autopay_authorizations a where a.client_id = p_client and a.company_id = v_company and a.revoked_at is null for update;
  if v_id is null then
    raise exception 'This client isn''t on autopay' using errcode = 'P0002';
  end if;
  if coalesce(p_paused, false) then
    update public.autopay_authorizations set paused_at = now(), paused_by = (select auth.uid()) where id = v_id and paused_at is null;
  else
    update public.autopay_authorizations set paused_at = null, paused_by = null, resumed_at = now() where id = v_id and paused_at is not null;
    if found and private.autopay_ready(v_company, p_client) is not null then
      perform private.autopay_try_new_card(p_client, private.autopay_ready(v_company, p_client));
    end if;
  end if;
end $$;

/**
 * The owner vouches that these clients agreed some other way (they're charged by hand in Stripe
 * today): each with an active default card brought in from Stripe and no agreement in force gets
 * one in the owner's name, with today's terms. Owners only. Returns how many. A client whose card
 * was saved on their client page, one who turned autopay off themselves, and another company's
 * client are skipped and not counted.
 */
create function public.autopay_vouch(p_company uuid, p_clients uuid[], p_terms_version text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_name text;
  v_email text;
  v_terms text;
  r record;
  v_count integer := 0;
begin
  if not private.has_role(p_company, '{owner}') then
    raise exception 'Only owners can record that clients agreed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company and private.autopay_of(c.settings) -> 'enabled' = 'true'::jsonb) then
    raise exception 'Autopay is turned off' using errcode = '22023';
  end if;
  if p_terms_version is distinct from private.autopay_terms_version(p_company) then
    raise exception 'The terms changed. Read them again and agree' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_clients), 0) > 500 then
    raise exception 'Choose up to 500 clients at a time' using errcode = '22023';
  end if;
  select coalesce(p.full_name, '') into v_name from public.profiles p where p.user_id = v_user;
  select u.email into v_email from auth.users u where u.id = v_user;
  v_terms := private.autopay_terms_shown(p_company);

  for r in
    select distinct on (c.id) c.id as client_id, pm.id as method_id
    from public.clients c
    join public.client_payment_methods pm on pm.client_id = c.id and pm.company_id = p_company
    where c.company_id = p_company and c.id = any (coalesce(p_clients, '{}'))
      and pm.is_default and pm.status = 'active' and pm.source = 'stripe_import'
      and not exists (select 1 from public.autopay_authorizations a where a.client_id = c.id and a.revoked_at is null)
      and not exists (select 1 from public.autopay_authorizations a where a.client_id = c.id and a.revoked_via = 'client')
    order by c.id
  loop
    insert into public.autopay_authorizations (company_id, client_id, payment_method_id, terms, terms_version, source,
      recorded_by, recorded_by_name, recorded_by_email)
    values (p_company, r.client_id, r.method_id, v_terms, p_terms_version, 'owner',
      v_user, left(coalesce(v_name, ''), 200), left(v_email, 320));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

/** For the field app: whether a visit's job is charged automatically, without any amount. */
create function public.visit_autopay(p_visit uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce((select j.autopay and private.client_on_autopay(j.company_id, j.client_id)
                   from public.visits v join public.jobs j on j.id = v.job_id where v.id = p_visit), false)
$$;
-- The caller's own row-level security on visits and jobs decides whether they get an answer.

-- ---------------------------------------------------------------------------------------------
-- Home
-- ---------------------------------------------------------------------------------------------

-- As in 20261017001400_job_financials.sql, plus autopay on Home: failed charges and ones waiting for
-- the office's OK, counted with the invoices and first among the things that need attention. It
-- runs as the caller, so row-level security keeps them off crew and estimator Home screens. A failed
-- charge whose invoice has a bank payment on its way (the client paying it on Stripe's page) isn't
-- one: nothing is tried while it clears (claim_autopay_charges).
create or replace function public.dashboard(p_company uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with co as (
    select coalesce(timezone, 'UTC') as tz from public.companies where id = p_company
  ),
  bounds as (
    select (date_trunc('day', now() at time zone co.tz)) at time zone co.tz as day_start,
           (date_trunc('day', now() at time zone co.tz) + interval '1 day') at time zone co.tz as day_end,
           (now() at time zone co.tz)::date as today,
           (date_trunc('month', now() at time zone co.tz)) at time zone co.tz as month_start,
           (date_trunc('month', now() at time zone co.tz) - interval '1 month') at time zone co.tz as last_month_start
    from co
  ),
  today_visits as (
    select v.id, v.title, v.kind, v.status, v.starts_at, v.ends_at, v.scheduled_on, v.job_id, v.hold_reason,
           c.id as client_id, c.display_name as client, cr.name as crew, cr.color as crew_color,
           p.line1 as address
    from public.visits v
    cross join bounds b
    left join public.jobs j on j.id = v.job_id
    left join public.requests r on r.id = v.request_id
    left join public.clients c on c.id = coalesce(j.client_id, r.client_id)
    left join public.crews cr on cr.id = v.crew_id
    left join public.properties p on p.id = v.property_id
    where v.company_id = p_company and v.status <> 'cancelled'
      and ((v.starts_at >= b.day_start and v.starts_at < b.day_end) or (v.starts_at is null and v.scheduled_on = b.today))
  ),
  autopay_failed as (
    select a.invoice_id, a.client_id, a.last_error from public.autopay_charges a
    where a.company_id = p_company and a.status in ('failed', 'needs_client')
      and not exists (select 1 from public.stripe_invoices s where s.invoice_id = a.invoice_id and s.status = 'processing' and s.detached_at is null)
  ),
  owing as (
    select c.id as client_id, c.display_name as client, sum(i.balance_due) as owed
    from public.invoices i join public.clients c on c.id = i.client_id
    where i.company_id = p_company and i.status in ('sent', 'partially_paid', 'overdue') and i.balance_due > 0
    group by c.id, c.display_name
  )
  select jsonb_build_object(
    'workflow', jsonb_build_object(
      'requests', (
        select jsonb_build_object(
          'new', count(*) filter (where status = 'new'),
          'assessment_complete', count(*) filter (where status = 'assessment_complete'),
          'overdue', count(*) filter (where status = 'new' and created_at < now() - interval '2 days'))
        from public.requests where company_id = p_company),
      'quotes', (
        select jsonb_build_object(
          'awaiting', count(*) filter (where status in ('sent', 'changes_requested')),
          'awaiting_value', coalesce(sum(total) filter (where status in ('sent', 'changes_requested')), 0),
          'approved', count(*) filter (where status = 'approved'),
          'approved_value', coalesce(sum(total) filter (where status = 'approved'), 0),
          'draft', count(*) filter (where status = 'draft'),
          'draft_value', coalesce(sum(total) filter (where status = 'draft'), 0))
        from public.quotes where company_id = p_company),
      'jobs', (
        select jsonb_build_object(
          'to_invoice', count(*) filter (where j.status = 'requires_invoicing'),
          'to_invoice_value', coalesce(sum(f.contract_total) filter (where j.status = 'requires_invoicing'), 0),
          'active', count(*) filter (where j.status = 'active'))
        from public.jobs j left join public.job_financials f on f.job_id = j.id where j.company_id = p_company),
      'invoices', (
        select jsonb_build_object(
          'awaiting', count(*) filter (where status in ('sent', 'partially_paid', 'overdue')),
          'awaiting_value', coalesce(sum(balance_due) filter (where status in ('sent', 'partially_paid', 'overdue')), 0),
          'past_due', count(*) filter (where status = 'overdue'),
          'past_due_value', coalesce(sum(balance_due) filter (where status = 'overdue'), 0),
          'draft', count(*) filter (where status = 'draft'),
          'autopay_failed', (select count(*) from autopay_failed),
          'autopay_failed_value', coalesce((select sum(i.balance_due) from autopay_failed a join public.invoices i on i.id = a.invoice_id), 0),
          'autopay_approval', (select count(*) from public.autopay_charges a where a.company_id = p_company and a.status = 'needs_approval'))
        from public.invoices where company_id = p_company)
    ),
    'today', jsonb_build_object(
      'total', (select count(*) from today_visits),
      'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from today_visits group by status) s), '{}'),
      'visits', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', id, 'title', title, 'kind', kind, 'status', status, 'starts_at', starts_at, 'ends_at', ends_at,
          'scheduled_on', scheduled_on, 'job_id', job_id, 'client_id', client_id, 'client', client,
          'crew', crew, 'crew_color', crew_color, 'address', address, 'hold_reason', hold_reason)
          order by starts_at nulls last, title)
        from today_visits), '[]')
    ),
    'receivables', jsonb_build_object(
      'clients_owing', (select count(*) from owing),
      'total', coalesce((select sum(owed) from owing), 0),
      'top', coalesce((select jsonb_agg(jsonb_build_object('client_id', client_id, 'client', client, 'owed', owed) order by owed desc)
                       from (select * from owing order by owed desc limit 5) t), '[]')
    ),
    'month', (
      select jsonb_build_object(
        'collected', coalesce((select sum(amount) from public.payments where company_id = p_company and received_at >= b.month_start), 0),
        'collected_last', coalesce((select sum(amount) from public.payments where company_id = p_company and received_at >= b.last_month_start and received_at < b.month_start), 0),
        'invoiced', coalesce((select sum(total) from public.invoices where company_id = p_company and status not in ('draft', 'void') and issued_on >= b.month_start::date), 0),
        'won', coalesce((select sum(total) from public.quotes where company_id = p_company and approved_at >= b.month_start), 0),
        'won_count', (select count(*) from public.quotes where company_id = p_company and approved_at >= b.month_start)
      ) from bounds b
    ),
    'attention', coalesce((
      select jsonb_agg(item) from (
        select jsonb_build_object('kind', 'autopay_failed', 'title', 'Autopay failed: ' || c.display_name,
                                  'detail', 'Invoice #' || i.number || coalesce(' · ' || a.last_error, ''), 'link', '/invoices/' || i.id) as item
        from autopay_failed a join public.invoices i on i.id = a.invoice_id join public.clients c on c.id = a.client_id
        union all
        -- Why it waits: the reason autopay_bill gave (visits it didn't queue), else the cap.
        select jsonb_build_object('kind', 'autopay_approval', 'title', 'Charge needs your OK: Invoice #' || i.number,
                                  'detail', coalesce(a.last_error, '$' || to_char(i.balance_due, 'FM999,999,990.00') || ' is over your autopay limit'),
                                  'link', '/invoices/' || i.id)
        from public.autopay_charges a join public.invoices i on i.id = a.invoice_id
        where a.company_id = p_company and a.status = 'needs_approval'
        union all
        select jsonb_build_object('kind', 'quote', 'title', 'Quote #' || number || ': changes requested',
                                  'detail', title, 'link', '/quotes/' || id)
        from public.quotes where company_id = p_company and status = 'changes_requested'
        union all
        select jsonb_build_object('kind', 'quote', 'title', 'Quote #' || number || ' approved: convert to a job',
                                  'detail', title, 'link', '/quotes/' || id)
        from public.quotes where company_id = p_company and status = 'approved'
        union all
        select jsonb_build_object('kind', 'visit', 'title', 'Weather hold: ' || title,
                                  'detail', hold_reason, 'link', '/schedule')
        from public.visits where company_id = p_company and hold_reason is not null and status = 'scheduled'
        union all
        select jsonb_build_object('kind', 'invoice', 'title', 'Invoice #' || number || ' is past due',
                                  'detail', '$' || to_char(balance_due, 'FM999,999,990.00') || ' owing', 'link', '/invoices/' || id)
        from public.invoices where company_id = p_company and status = 'overdue'
        limit 10
      ) a), '[]')
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Lawn document terms already saved
-- ---------------------------------------------------------------------------------------------

-- Lawn companies whose estimate template still has the starter terms (written for paving and
-- roofing) get the lawn starter (packages/core/src/documents.ts TRADE_TERMS). A function so the
-- database tests can run it on a template of their own; returns how many it changed.
create function private.autopay_lawn_terms() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  update public.document_templates t
  set settings = jsonb_set(t.settings, '{terms}', to_jsonb(E'Payment: due after each visit, or charged to your card on file if you''re on autopay.\nSkipped visits: if we can''t do a visit, we''ll tell you, and you won''t be charged for it.\nOur work: if something isn''t right, tell us within two days and we''ll come back or refund the visit.'::text))
  from public.companies c
  where c.id = t.company_id and c.trade_preset = 'lawn_exterior'
    and t.settings ->> 'terms' = E'Payment: a deposit to get on the schedule, and the rest when the work is done.\nChanges: anything not listed here is extra, and only with your OK.\nWarranty: we stand behind our workmanship, plus the manufacturer''s warranty on materials.';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
select private.autopay_lawn_terms();

-- ---------------------------------------------------------------------------------------------
-- Who calls what
-- ---------------------------------------------------------------------------------------------

revoke all on function private.money_office(uuid), private.autopay_notify(uuid, text, text, text), private.autopay_of(jsonb),
  private.autopay_days(jsonb), private.autopay_timing_text(jsonb), private.autopay_starter_terms(text), private.autopay_terms_version(uuid),
  private.autopay_terms_shown(uuid), private.method_label(public.client_payment_methods), private.method_label_of(uuid),
  private.autopay_ready(uuid, uuid), private.autopay_job_default(uuid, uuid), private.client_on_autopay(uuid, uuid), private.autopay_due(uuid),
  private.autopay_call_off(uuid, text, text, boolean), private.autopay_call_off_client(uuid, text), private.autopay_paid_by_charge(uuid), private.autopay_clearing(uuid),
  private.autopay_enqueue_stripe(uuid, uuid), private.autopay_bill_end(uuid, text, text), private.autopay_setting(),
  private.autopay_settings_guard(), private.hub_tips_changed(), private.autopay_queue(uuid, text, uuid), private.autopay_visit(),
  private.autopay_job_changed(), private.autopay_job_guard(), private.autopay_authorization_guard(), private.autopay_try_new_card(uuid, uuid), private.autopay_agreed(),
  private.autopay_agreement_changed(), private.autopay_method_changed(), private.autopay_invoice_changed(),
  private.autopay_invoice_guard(), private.autopay_invoice_lines_guard(), private.autopay_payment_guard(),
  private.autopay_charge_status(), private.autopay_rule_actions(), private.autopay_lawn_terms() from public;
-- visit_autopay runs as the caller; private isn't exposed through PostgREST.
grant execute on function private.client_on_autopay(uuid, uuid) to authenticated;

revoke execute on function public.claim_autopay_charges(integer, uuid), public.autopay_bill(uuid, uuid),
  public.autopay_mark_sent(uuid, uuid, integer), public.finish_autopay_charge(uuid, text, uuid, text, text, numeric, uuid),
  public.release_autopay_charges(uuid, uuid[]), public.autopay_save_payment_method(uuid, uuid, jsonb),
  public.autopay_record_authorization(uuid, uuid, uuid, text, text, text, text, text, text), public.autopay_revoke(uuid, uuid, text, uuid),
  public.autopay_account_left(uuid, boolean, text), public.emit_card_expiry_alerts() from public, anon, authenticated;
grant execute on function public.claim_autopay_charges(integer, uuid), public.autopay_bill(uuid, uuid),
  public.autopay_mark_sent(uuid, uuid, integer), public.finish_autopay_charge(uuid, text, uuid, text, text, numeric, uuid),
  public.release_autopay_charges(uuid, uuid[]), public.autopay_save_payment_method(uuid, uuid, jsonb),
  public.autopay_record_authorization(uuid, uuid, uuid, text, text, text, text, text, text), public.autopay_revoke(uuid, uuid, text, uuid),
  public.autopay_account_left(uuid, boolean, text), public.emit_card_expiry_alerts() to service_role;

revoke execute on function public.approve_autopay_charge(uuid), public.call_off_autopay_charge(uuid), public.autopay_pause(uuid, boolean),
  public.autopay_set_settings(uuid, jsonb), public.autopay_vouch(uuid, uuid[], text), public.visit_autopay(uuid) from public, anon;
grant execute on function public.approve_autopay_charge(uuid), public.call_off_autopay_charge(uuid), public.autopay_pause(uuid, boolean),
  public.autopay_set_settings(uuid, jsonb), public.autopay_vouch(uuid, uuid[], text), public.visit_autopay(uuid) to authenticated;

-- The policies above check the company the per-row way; rewrite them like the others (see
-- 20261018000990_policy_lookups.sql).
select private.fold_member_checks();

notify pgrst, 'reload schema';
