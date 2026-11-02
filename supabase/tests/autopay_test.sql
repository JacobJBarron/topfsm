-- Database tests for autopay (20261101000100_autopay.sql): who reads the saved cards, agreements
-- and charges (the office with the invoices area, never crews or subs); the company's settings and
-- their guard, and tips turned off reaching Stripe invoices already made with one; a finished visit
-- or a one-off job's finished work queueing one charge, due when the company says, only for a
-- client on autopay; reopened visits and work marked not done calling it off; the task's claim,
-- billing, cap and the office's OK, marking sent and how a charge went (declines, bank payments,
-- retries, a new card after them, Stripe credit); which visits it charges without asking (only those
-- it queued itself, a visit freed from an invoice coming off them, and an offline tap keeping its
-- time, checked against when autopay started or was resumed) and what waits while a bank
-- payment is on its way; who's told what, once; the job default and guard; agreements kept as made,
-- and a card changed keeping a pause and each job's choice; the field app's yes or no; expiring
-- cards; Home; leaving a Stripe account; the lawn document terms; grants.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tautopay;
grant usage on schema tautopay to authenticated, service_role, anon;
create function tautopay.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tautopay.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tautopay.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
-- Signs in as someone, for the rest of the transaction.
create function tautopay.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema tautopay to authenticated, service_role, anon;

-- The rest are the server's and the test's own shortcuts, run past row-level security.

-- A client on autopay: a Visa saved on their client page and agreed to, as the server records them.
create function tautopay.ready_client(p_company uuid, p_name text, p_type text default 'card') returns uuid language plpgsql as $$
declare
  v_client uuid;
  v_key text := replace(lower(p_name), ' ', '_');
  v_pm uuid;
begin
  insert into public.clients (company_id, display_name, email) values (p_company, p_name, replace(lower(p_name), ' ', '.') || '@autopay.test')
  returning id into v_client;
  v_pm := public.autopay_save_payment_method(p_company, v_client, case when p_type = 'card' then jsonb_build_object(
      'stripe_payment_method_id', 'pm_' || v_key, 'stripe_customer_id', 'cus_' || v_key, 'stripe_account', 'acct_lawns', 'livemode', false,
      'type', 'card', 'brand', 'visa', 'last4', '4242', 'exp_month', 8, 'exp_year', 2030, 'status', 'active', 'source', 'hub', 'make_default', true)
    else jsonb_build_object(
      'stripe_payment_method_id', 'pm_' || v_key, 'stripe_customer_id', 'cus_' || v_key, 'stripe_account', 'acct_lawns', 'livemode', false,
      'type', 'us_bank_account', 'bank_name', 'Chase', 'last4', '6789', 'status', 'active', 'source', 'hub', 'make_default', true) end);
  perform public.autopay_record_authorization(p_company, v_client, v_pm, 'hub', private.autopay_terms_version(p_company), '203.0.113.7', 'Test browser', 'client', 'client');
  return v_client;
end $$;
-- The client's card (the newest one not removed).
create function tautopay.card(p_client uuid) returns uuid language sql as $$
  select id from public.client_payment_methods where client_id = p_client and status <> 'removed' order by created_at desc, id limit 1
$$;
-- A weekly mow for a client, billed per visit at p_price a visit (or billed another way).
create function tautopay.job(p_company uuid, p_client uuid, p_price numeric default 45, p_kind text default 'recurring', p_billing text default 'per_visit')
returns uuid language plpgsql as $$
declare v_job uuid;
begin
  insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode)
  values (p_company, p_client, case when p_kind = 'recurring' then 'Weekly mow' else 'Spring cleanup' end, p_kind,
          case when p_kind = 'recurring' then 'FREQ=WEEKLY;BYDAY=MO' end, p_billing)
  returning id into v_job;
  insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (p_company, v_job, 'Mowing', 1, 'visit', p_price);
  return v_job;
end $$;
-- A visit on it today, with Cy (field crew) on it.
create function tautopay.visit(p_company uuid, p_job uuid) returns uuid language plpgsql as $$
declare v_visit uuid;
begin
  insert into public.visits (company_id, job_id, title, scheduled_on) values (p_company, p_job, 'Mow', private.company_today(p_company))
  returning id into v_visit;
  insert into public.visit_assignees (company_id, visit_id, user_id) values (p_company, v_visit, 'a7a70000-0000-0000-0000-000000000007');
  return v_visit;
end $$;
-- The job's charge still in play (or its newest, with p_any).
create function tautopay.charge_of(p_job uuid, p_any boolean default false) returns uuid language sql as $$
  select id from public.autopay_charges where job_id = p_job and (p_any or status <> 'called_off') order by created_at desc, id desc limit 1
$$;
-- A charge as "status: last_error".
create function tautopay.state(p_charge uuid) returns text language sql as $$
  select status || coalesce(': ' || last_error, '') from public.autopay_charges where id = p_charge
$$;
-- Due now.
create function tautopay.due(p_charge uuid) returns void language sql as $$
  update public.autopay_charges set due_at = now() - interval '1 minute' where id = p_charge
$$;
-- The task's claim, for one charge: its token. Fails if the claim takes anything else (each
-- scenario leaves nothing else due).
create function tautopay.claim_one(p_company uuid, p_charge uuid) returns uuid language plpgsql as $$
declare
  v_token uuid;
  v_mine boolean;
  v_others text;
begin
  select (array_agg(claim_token))[1], coalesce(bool_or(id = p_charge), false), string_agg(id::text, ', ') filter (where id <> p_charge)
  into v_token, v_mine, v_others from public.claim_autopay_charges(100, p_company);
  if v_others is not null then raise exception 'FAIL: the claim took other charges too: %', v_others; end if;
  return case when v_mine then v_token end;
end $$;
-- Bill, mark sent and say how it went, as the task does once Stripe has answered.
create function tautopay.charge(p_company uuid, p_charge uuid, p_outcome text, p_error text default null, p_decline text default null) returns jsonb
language plpgsql as $$
declare
  v_token uuid := tautopay.claim_one(p_company, p_charge);
  v_bill jsonb;
begin
  v_bill := public.autopay_bill(p_charge, v_token);
  if v_bill ->> 'outcome' <> 'charge' then return v_bill; end if;
  if not public.autopay_mark_sent(p_charge, v_token, round((v_bill ->> 'balance_due')::numeric * 100)::integer) then
    raise exception 'FAIL: mark_sent refused %', p_charge;
  end if;
  perform public.finish_autopay_charge(p_charge, p_outcome, v_token, p_error, p_decline, (v_bill ->> 'balance_due')::numeric);
  return v_bill;
end $$;
-- Notifications about autopay for someone, as "title | body" lines.
create function tautopay.told(p_user uuid, p_like text default '%') returns text language sql as $$
  select string_agg(title || ' | ' || coalesce(body, ''), E'\n' order by created_at, title)
  from public.notifications where user_id = p_user and kind = 'autopay' and title like p_like
$$;

\set olive 'a7a70000-0000-0000-0000-000000000001'
\set ada 'a7a70000-0000-0000-0000-000000000002'
\set opal 'a7a70000-0000-0000-0000-000000000003'
\set otto 'a7a70000-0000-0000-0000-000000000004'
\set eve 'a7a70000-0000-0000-0000-000000000005'
\set lou 'a7a70000-0000-0000-0000-000000000006'
\set cy 'a7a70000-0000-0000-0000-000000000007'
\set sal 'a7a70000-0000-0000-0000-000000000008'
\set mia 'a7a70000-0000-0000-0000-000000000009'
\set pat 'a7a70000-0000-0000-0000-00000000000a'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@autopay.test', '{"full_name": "Olive Owner"}'),
  (:'ada', 'ada@autopay.test', '{"full_name": "Ada Admin"}'),
  (:'opal', 'opal@autopay.test', '{"full_name": "Opal Office"}'),
  (:'otto', 'otto@autopay.test', '{"full_name": "Otto Ops"}'),
  (:'eve', 'eve@autopay.test', '{"full_name": "Eve Estimator"}'),
  (:'lou', 'lou@autopay.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@autopay.test', '{"full_name": "Cy Crew"}'),
  (:'sal', 'sal@autopay.test', '{"full_name": "Sal Sub"}'),
  (:'mia', 'mia@autopay.test', '{"full_name": "Mia Marketing"}'),
  (:'pat', 'pat@autopay.test', '{"full_name": "Pat Paving"}');

-- Autopay Lawns works in daytime somewhere, so card alerts go out now (from 8 in the morning) and
-- "tonight" is hours away.
select name as tz from pg_timezone_names where name ~ '^Etc/GMT[+-][0-9]+$' and extract(hour from now() at time zone name) between 9 and 20
  order by utc_offset desc limit 1 \gset

-- ===== Autopay Lawns ===========================================================================
-- Olive owns it; Ada is an admin; Opal in the office; Otto in the office as an operations manager
-- (no invoices area); Mia in the office for marketing and automations (no invoices area); Eve
-- estimates; Lou leads a crew with Cy on it; Sal is a sub. Pat owns Paving Pros, another business.
begin;
set local role authenticated;
select tautopay.as_user(:'olive');
select public.create_company('Autopay Lawns', 'lawn_exterior', :'tz') as co \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Marketing', 'office', '{marketing,automations}') returning id as mkt_role \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'ada', 'admin', null), (:'co', :'opal', 'office', null), (:'co', :'otto', 'office', :'ops_role'), (:'co', :'eve', 'estimator', null),
  (:'co', :'lou', 'crew_lead', null), (:'co', :'cy', 'field_crew', null), (:'co', :'mia', 'office', :'mkt_role');
set local role authenticated;
insert into public.clients (company_id, display_name, email, phone) values (:'co', 'Pat Lee', 'pat.lee@autopay.test', '+15405550101') returning id as c_pat \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Sam Ortiz', 'sam@autopay.test') returning id as c_sam \gset
commit;
insert into public.subcontractors (id, company_id, name) values ('a7a70000-0000-0000-0000-0000000000c1', :'co', 'Sal''s Mowing');
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', 'a7a70000-0000-0000-0000-0000000000c1');

begin;
set local role authenticated;
select tautopay.as_user(:'pat');
select public.create_company('Paving Pros', 'paving') as other \gset
insert into public.clients (company_id, display_name, email) values (:'other', 'Owen Other', 'owen@autopay.test') returning id as c_other \gset
commit;

-- The words stay the same here and in core (methodLabel, autopayTimingText).
select tautopay.check(private.method_label(jsonb_populate_record(null::public.client_payment_methods, '{"type": "card", "brand": "visa", "last4": "4242"}')) = 'Visa ending 4242'
  and private.method_label(jsonb_populate_record(null::public.client_payment_methods, '{"type": "card", "brand": "amex", "last4": "0005"}')) = 'American Express ending 0005'
  and private.method_label(jsonb_populate_record(null::public.client_payment_methods, '{"type": "card", "brand": "mastercard"}')) = 'Mastercard'
  and private.method_label(jsonb_populate_record(null::public.client_payment_methods, '{"type": "us_bank_account", "bank_name": "Chase", "last4": "6789"}')) = 'Chase ending 6789'
  and private.method_label(jsonb_populate_record(null::public.client_payment_methods, '{"type": "us_bank_account", "last4": "6789"}')) = 'Bank account ending 6789'
  and private.method_label(jsonb_populate_record(null::public.client_payment_methods, '{"type": "link"}')) = 'Link'
  and private.method_label(jsonb_populate_record(null::public.client_payment_methods, '{"type": "cashapp"}')) = 'Cashapp',
  'a saved method reads "Visa ending 4242", "American Express ending 0005", "Chase ending 6789", "Link" (as core methodLabel)');
select tautopay.check(private.autopay_timing_text('{"timing": "now"}') = 'right after each visit'
  and private.autopay_timing_text('{"timing": "end_of_day"}') = 'at the end of the day of each visit'
  and private.autopay_timing_text('{}') = 'at the end of the day of each visit'
  and private.autopay_timing_text('{"timing": "days", "days": 1}') = '1 day after each visit'
  and private.autopay_timing_text('{"timing": "days", "days": 2}') = '2 days after each visit'
  and private.autopay_timing_text('{"timing": "days", "days": 40}') = '14 days after each visit'
  and private.autopay_timing_text('{"timing": "days", "days": "3"}') = '1 day after each visit',
  'when charges go, in core autopayTimingText''s words (days read only as a number, kept within 1 to 14)');

-- ===== Settings ================================================================================

\set terms 'We charge the card on file after each visit is done. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
create function tautopay.settings(p_timing text default 'end_of_day', p_days integer default null, p_max numeric default 500,
  p_terms text default 'We charge the card on file after each visit is done. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.',
  p_enabled boolean default true) returns jsonb language sql as $$
  select jsonb_build_object('enabled', p_enabled, 'terms', p_terms, 'timing', p_timing, 'days', p_days, 'max_amount', p_max, 'receipts', true, 'jobs_default', true, 'card_required', false)
$$;
grant execute on function tautopay.settings(text, integer, numeric, text, boolean) to authenticated;

begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select tautopay.check(tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings())) = '42501: Only owners and admins with the invoices area can change autopay',
  'the office can''t change autopay''s settings');
select tautopay.as_user(:'eve');
select tautopay.check(tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings())) like '42501:%', 'nor can an estimator');
select tautopay.as_user(:'pat');
select tautopay.check(tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings())) like '42501:%', 'nor another business''s owner');
select tautopay.as_user(:'ada');
select tautopay.check(tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings() - 'enabled')) = '22023: Say whether autopay is on'
  and tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings() || '{"terms": "   "}')) = '22023: Write the terms clients agree to'
  and tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings() || jsonb_build_object('terms', repeat('a', 4001)))) = '22023: Write the terms clients agree to'
  and tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings('weekly'))) = '22023: Choose when to charge'
  and tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings('days', 20))) = '22023: Choose 1 to 14 days'
  and tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings('days'))) = '22023: Choose 1 to 14 days'
  and tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings(p_max => 0))) = '22023: The most to charge without asking has to be more than $0'
  and tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings(p_max => 2000000))) = '22023: The most to charge without asking has to be more than $0'
  and tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings() || '{"receipts": "yes"}')) = '22023: Say whether to email receipts'
  and tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings() - 'card_required')) = '22023: Say whether every client needs a card on file',
  'each setting is checked, with a message that says what to fix');
select tautopay.check(tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings())) = '22023: Update your Stripe key on the Apps page to turn on autopay',
  'autopay isn''t turned on while the Stripe key can''t save cards');
select tautopay.check(tautopay.error_of(format('select public.autopay_set_settings(%L, %L)', :'co', tautopay.settings(p_enabled => false))) = 'none',
  'but the rest can be saved with it off');
commit;

-- The Apps page saved what the company's key can do.
insert into public.integrations (company_id, provider, status, settings) values (:'co', 'stripe', 'connected', '{"autopay": true, "refunds": true}');

begin;
set local role authenticated;
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings(p_max => null)) as saved \gset
commit;
select tautopay.check((:'saved'::jsonb) ->> 'terms_version' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$' and (:'saved'::jsonb) ->> 'changed_by' = :'ada'
  and (:'saved'::jsonb) -> 'enabled' = 'true' and (:'saved'::jsonb) -> 'max_amount' = 'null' and (:'saved'::jsonb) -> 'days' = 'null'
  and (:'saved'::jsonb) -> 'card_required' = 'false',
  'an admin with the invoices area turns it on: every key saved, with a version for the terms, who and when');
select tautopay.check(private.autopay_terms_shown(:'co') = :'terms' || E'\n\nWe charge at the end of the day of each visit.',
  'what the client agrees to is the terms, then when they''re charged');

-- What changes the version: the words or when charges go, not saving them again.
create function tautopay.old_version(p_company uuid) returns void language plpgsql as $$
begin
  perform set_config('crewtavo.autopay', 'on', true);
  update public.companies set settings = jsonb_set(settings, '{autopay,terms_version}', '"v-old"') where id = p_company;
  perform set_config('crewtavo.autopay', 'off', true);
end $$;
select tautopay.old_version(:'co');
begin;
set local role authenticated;
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings()) ->> 'terms_version' as v_same \gset
select public.autopay_set_settings(:'co', tautopay.settings(p_terms => 'We charge your card after each visit.')) ->> 'terms_version' as v_words \gset
commit;
select tautopay.old_version(:'co');
begin;
set local role authenticated;
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings(p_terms => 'We charge your card after each visit.', p_timing => 'now')) ->> 'terms_version' as v_timing \gset
commit;
select tautopay.check(:'v_same' = 'v-old' and :'v_words' <> 'v-old' and :'v_timing' <> 'v-old',
  'the terms'' version changes with the words and with the timing, and not when the same are saved again');

-- Settings → Company saves the whole settings object it read a while ago: autopay stays as it is.
begin;
set local role authenticated;
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings()) as saved \gset
update public.companies set settings = (settings - 'autopay') || '{"payment_terms_days": 30, "hub_tips": true}' where id = :'co';
update public.companies set settings = jsonb_set(settings, '{autopay,enabled}', 'false') where id = :'co';
commit;
select tautopay.check((select settings -> 'autopay' from public.companies where id = :'co') = :'saved'::jsonb
    and (select settings -> 'hub_tips' from public.companies where id = :'co') = 'true',
  'a page saving the company''s other settings keeps settings.autopay as autopay_set_settings saved it');
select private.autopay_terms_version(:'co') as ver \gset

-- Tips turned off reach a Stripe invoice the client already made with a tip.
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
insert into public.invoices (company_id, client_id, subject) values (:'co', :'c_sam', 'Edging') returning id as tipped \gset
insert into public.invoices (company_id, client_id, subject) values (:'co', :'c_sam', 'Raking') returning id as untipped \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'tipped', 'Edging', 60), (:'co', :'untipped', 'Raking', 40);
update public.invoices set status = 'sent' where id in (:'tipped', :'untipped');
commit;
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, tip_amount) values
  (:'co', :'tipped', 'in_tipped', 'crewtavo', 'open', 69, 9), (:'co', :'untipped', 'in_untipped', 'crewtavo', 'open', 40, 0);
update public.outbox set done_at = now() where company_id = :'co' and done_at is null;
begin;
set local role authenticated;
select tautopay.as_user(:'ada');
update public.companies set settings = jsonb_set(settings, '{hub_tips}', 'false') where id = :'co';
commit;
select tautopay.check((select count(*) from public.outbox where company_id = :'co' and topic = 'stripe.invoice' and done_at is null and payload ->> 'invoice_id' = :'tipped') = 1
    and (select count(*) from public.outbox where company_id = :'co' and topic = 'stripe.invoice' and done_at is null and payload ->> 'invoice_id' = :'untipped') = 0,
  'turning tips off queues one Stripe sync for an invoice whose Stripe invoice carries a tip, and none for one without');
begin;
set local role authenticated;
select tautopay.as_user(:'ada');
update public.companies set settings = jsonb_set(settings, '{hub_tips}', 'true') where id = :'co';
update public.companies set settings = jsonb_set(settings, '{hub_tips}', 'false') where id = :'co';
commit;
select tautopay.check((select count(*) from public.outbox where company_id = :'co' and topic = 'stripe.invoice' and done_at is null and payload ->> 'invoice_id' = :'tipped') = 1,
  'and only one is waiting for it, however often tips go off');

-- ===== Saving a card and agreeing ==============================================================

select public.autopay_save_payment_method(:'co', :'c_pat', jsonb_build_object('stripe_payment_method_id', 'pm_pat', 'stripe_customer_id', 'cus_pat',
  'stripe_account', 'acct_lawns', 'livemode', false, 'type', 'card', 'brand', 'visa', 'last4', '4242', 'exp_month', 8, 'exp_year', 2028,
  'status', 'active', 'source', 'hub', 'make_default', true)) as pm_pat \gset
select tautopay.check((select is_default and status = 'active' and source = 'hub' from public.client_payment_methods where id = :'pm_pat'), 'a card saved on the client page is theirs, active and their default');
select tautopay.check(public.autopay_save_payment_method(:'co', :'c_pat', '{"stripe_payment_method_id": "pm_pat", "stripe_customer_id": "cus_pat", "livemode": false, "type": "card", "status": "active"}') = :'pm_pat'
    and (select count(*) from public.client_payment_methods where client_id = :'c_pat') = 1,
  'saving it again (the return page and the webhook both do) keeps the one');
select tautopay.check(tautopay.error_of(format('select public.autopay_save_payment_method(%L, %L, %L)', :'other', :'c_pat', '{"stripe_payment_method_id": "pm_x", "stripe_customer_id": "cus_x", "livemode": false, "type": "card"}')) = 'P0002: Client not found',
  'a card is only saved for one of the company''s own clients');

select tautopay.check(tautopay.error_of(format('select public.autopay_record_authorization(%L, %L, %L, %L, %L)', :'co', :'c_pat', :'pm_pat', 'hub', 'v-old')) = '22023: The terms changed. Read them again and agree',
  'agreeing to terms that have changed since the page showed them is refused');
select tautopay.check(tautopay.error_of(format('select public.autopay_record_authorization(%L, %L, %L, %L, %L)', :'co', :'c_sam', :'pm_pat', 'hub', :'ver')) = 'P0002: That card isn''t saved anymore',
  'and so is agreeing with someone else''s card');
select public.autopay_record_authorization(:'co', :'c_pat', :'pm_pat', 'hub', :'ver', '203.0.113.9', 'Mozilla/5.0 (iPhone)', 'quote', 'client') as auth_pat \gset
select tautopay.check((select terms = :'terms' || E'\n\nWe charge at the end of the day of each visit.' and terms_version = :'ver' and ip = '203.0.113.9'
    and user_agent = 'Mozilla/5.0 (iPhone)' and source = 'hub' and link_kind = 'quote' and link_via = 'client' and payment_method_id = :'pm_pat'
    from public.autopay_authorizations where id = :'auth_pat'),
  'the agreement keeps the whole text as shown, its version, the IP, the browser and the link it was agreed on');
select tautopay.check(public.autopay_record_authorization(:'co', :'c_pat', :'pm_pat', 'hub', :'ver') = :'auth_pat'
    and (select count(*) from public.autopay_authorizations where client_id = :'c_pat') = 1,
  'a second tap is the same agreement');
select tautopay.check((select count(*) from public.outbox where topic = 'autopay.agreed' and payload ->> 'authorization_id' = :'auth_pat') = 1
    and (select data ->> 'card' = 'Visa ending 4242' and data ->> 'source' = 'hub' from public.activity where verb = 'autopay.enabled' and subject_id = :'c_pat'),
  'agreeing queues the client''s copy of what they agreed to and an autopay.enabled event with the card');
select tautopay.check(private.autopay_ready(:'co', :'c_pat') = :'pm_pat', 'Pat is on autopay with that card');

-- ===== Queueing ================================================================================

-- The office makes Pat's weekly mow: on autopay by default (lawn, and Pat agreed).
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, billing_mode)
values (:'co', :'c_pat', 'Weekly mow', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', 'per_visit') returning id as j_pat \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'j_pat', 'Mowing', 1, 'visit', 45);
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'j_pat', 'Mow', private.company_today(:'co')) returning id as v1 \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'j_pat', 'Mow', private.company_today(:'co')) returning id as v2 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v1', :'cy'), (:'co', :'v2', :'cy');
commit;
select tautopay.check((select autopay and autopay_since is not null from public.jobs where id = :'j_pat'),
  'a new recurring per-visit job of a client on autopay starts with autopay on (lawn)');

-- Cy taps Complete.
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'v1';
commit;
select tautopay.charge_of(:'j_pat') as p \gset
select tautopay.check((select count(*) from public.autopay_charges where job_id = :'j_pat') = 1
    and (select status = 'waiting' and bill = 'visits' and invoice_id is null and payment_method_id = :'pm_pat' and client_id = :'c_pat'
         and due_at = (private.company_today(:'co') + 1)::timestamp at time zone :'tz' from public.autopay_charges where id = :'p'),
  'a visit the crew completes queues one charge, due at midnight where the company is');
update public.autopay_charges set due_at = now() + interval '1 hour' where id = :'p';
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'v2';
commit;
select tautopay.check((select count(*) from public.autopay_charges where job_id = :'j_pat') = 1
    and (select due_at = (private.company_today(:'co') + 1)::timestamp at time zone :'tz' from public.autopay_charges where id = :'p'),
  'a second visit the same day joins it, and it goes at the later of the two times');

-- Clients and jobs that aren't charged.
select tautopay.job(:'co', :'c_sam') as j_sam \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.jobs set autopay = true where id = :'j_sam';
commit;
select tautopay.visit(:'co', :'j_sam') as v_sam \gset
select tautopay.ready_client(:'co', 'Pia Paused') as c_pia \gset
select tautopay.job(:'co', :'c_pia') as j_pia \gset
select tautopay.visit(:'co', :'j_pia') as v_pia \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_pia', true);
commit;
select tautopay.ready_client(:'co', 'Nell Needs Card') as c_nell \gset
select tautopay.job(:'co', :'c_nell') as j_nell \gset
select tautopay.visit(:'co', :'j_nell') as v_nell \gset
update public.client_payment_methods set status = 'needs_update' where client_id = :'c_nell';
select tautopay.ready_client(:'co', 'Joe Job Off') as c_joe \gset
select tautopay.job(:'co', :'c_joe') as j_joe \gset
select tautopay.visit(:'co', :'j_joe') as v_joe \gset
select tautopay.job(:'co', :'c_joe', 45, 'recurring', 'fixed_schedule') as j_fixed \gset
select tautopay.visit(:'co', :'j_fixed') as v_fixed \gset
select tautopay.job(:'co', :'c_joe', 45, 'recurring', 'on_completion') as j_reconly \gset
select tautopay.visit(:'co', :'j_reconly') as v_reconly \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.jobs set autopay = false where id = :'j_joe';
commit;
select tautopay.check((select bool_and(not autopay) from public.jobs where id in (:'j_fixed', :'j_reconly')),
  'jobs billed on a fixed schedule, or recurring jobs billed when they''re done, can''t be on autopay');
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id in (:'v_sam', :'v_pia', :'v_nell', :'v_joe', :'v_fixed', :'v_reconly');
commit;
select tautopay.check(not exists (select 1 from public.autopay_charges where job_id in (:'j_sam', :'j_pia', :'j_nell', :'j_joe', :'j_fixed', :'j_reconly')),
  'nothing is queued for a client with no agreement, one paused, one whose card needs updating, a job with autopay off, or a job autopay doesn''t charge');

-- With autopay off in Settings, nothing is queued either.
select tautopay.ready_client(:'co', 'Otis Off') as c_otis \gset
select tautopay.job(:'co', :'c_otis') as j_otis \gset
select tautopay.visit(:'co', :'j_otis') as v_otis \gset
begin;
set local role authenticated;
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings(p_enabled => false));
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'v_otis';
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings());
commit;
select tautopay.check(not exists (select 1 from public.autopay_charges where job_id = :'j_otis'), 'or while autopay is turned off in Settings');
select private.autopay_terms_version(:'co') as ver \gset

-- Right away, and some days on.
begin;
set local role authenticated;
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings('now'));
commit;
select tautopay.ready_client(:'co', 'Nia Now') as c_nia \gset
select tautopay.job(:'co', :'c_nia') as j_nia \gset
select tautopay.visit(:'co', :'j_nia') as v_nia \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'v_nia';
commit;
select tautopay.check((select due_at <= now() from public.autopay_charges where job_id = :'j_nia'), 'with "right away" the charge is due at once');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.call_off_autopay_charge(tautopay.charge_of(:'j_nia'));
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings('days', 7));
commit;
select tautopay.ready_client(:'co', 'Dax Days') as c_dax \gset
select tautopay.job(:'co', :'c_dax') as j_dax \gset
select tautopay.visit(:'co', :'j_dax') as va \gset
select tautopay.visit(:'co', :'j_dax') as vb \gset
select tautopay.visit(:'co', :'j_dax') as vc \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'va';
commit;
select tautopay.charge_of(:'j_dax') as dax \gset
select tautopay.check((select due_at = (private.company_today(:'co') + 8)::timestamp at time zone :'tz' from public.autopay_charges where id = :'dax'),
  'with "7 days after", it''s due at midnight at the end of the seventh day');
-- Six days later, the next week's visit.
update public.autopay_charges set created_at = created_at - interval '6 days', due_at = due_at - interval '6 days' where id = :'dax';
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vb';
commit;
select tautopay.check((select due_at = created_at + interval '8 days' and due_at > now() from public.autopay_charges where id = :'dax'),
  'a visit six days on moves it later, but no more than one wait past when it was queued');
update public.autopay_charges set created_at = created_at - interval '6 days' where id = :'dax';
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vc';
commit;
select tautopay.check((select due_at = created_at + interval '8 days' and due_at < now() and status = 'waiting' from public.autopay_charges where id = :'dax'),
  'so visits every six days never put it off for ever');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.call_off_autopay_charge(:'dax');
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings());
commit;
select private.autopay_terms_version(:'co') as ver \gset

-- A card saved since the client agreed isn't charged until they agree to it.
select tautopay.ready_client(:'co', 'Rex Ready') as c_rex \gset
select tautopay.card(:'c_rex') as rex_card \gset
select public.autopay_save_payment_method(:'co', :'c_rex', jsonb_build_object('stripe_payment_method_id', 'pm_rex_new', 'stripe_customer_id', 'cus_rex',
  'livemode', false, 'type', 'card', 'brand', 'mastercard', 'last4', '4444', 'status', 'active', 'source', 'hub', 'make_default', true)) as rex_new \gset
select tautopay.check((select is_default from public.client_payment_methods where id = :'rex_new') and private.autopay_ready(:'co', :'c_rex') = :'rex_card',
  'a new default card the client didn''t agree to isn''t the one charged: the agreement''s card is');
update public.client_payment_methods set status = 'removed', removed_reason = 'office', is_default = false where id = :'rex_card';
select tautopay.check(private.autopay_ready(:'co', :'c_rex') is null, 'and with the agreed card removed, nothing is charged');

-- ===== Who reads it ============================================================================

insert into public.messages (company_id, client_id, channel, direction, body, related_type, related_id) values
  (:'co', :'c_pat', 'email', 'out', 'Set up autopay here: [autopay link]', 'autopay', :'c_pat'),
  (:'co', :'c_pat', 'sms', 'out', 'We''re on our way', 'visit', :'v1');
create function tautopay.seen(p_table text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I', p_table) into n;
  return n;
end $$;
grant execute on function tautopay.seen(text) to authenticated, anon;
select tautopay.check((select count(*) from public.client_payment_methods where company_id = :'co') > 0
  and (select count(*) from public.autopay_authorizations where company_id = :'co') > 0
  and (select count(*) from public.autopay_charges where company_id = :'co') > 0, 'the company has cards, agreements and charges');
begin;
set local role authenticated;
select tautopay.as_user(:'olive');
select tautopay.check(tautopay.seen('client_payment_methods') > 0 and tautopay.seen('autopay_authorizations') > 0 and tautopay.seen('autopay_charges') > 0, 'the owner reads all three');
select tautopay.as_user(:'ada');
select tautopay.check(tautopay.seen('client_payment_methods') > 0 and tautopay.seen('autopay_authorizations') > 0 and tautopay.seen('autopay_charges') > 0, 'so does an admin');
select tautopay.as_user(:'opal');
select tautopay.check(tautopay.seen('client_payment_methods') > 0 and tautopay.seen('autopay_authorizations') > 0 and tautopay.seen('autopay_charges') > 0, 'and the office with the invoices area');
select tautopay.check((select count(*) from public.messages where related_type = 'autopay') = 1, 'who also read the autopay invite sent');
select tautopay.as_user(:'otto');
select tautopay.check(tautopay.seen('client_payment_methods') + tautopay.seen('autopay_authorizations') + tautopay.seen('autopay_charges') = 0, 'the office without the invoices area reads none of it');
select tautopay.as_user(:'eve');
select tautopay.check(tautopay.seen('client_payment_methods') + tautopay.seen('autopay_authorizations') + tautopay.seen('autopay_charges') = 0, 'nor does an estimator');
select tautopay.check((select count(*) from public.messages where related_type = 'autopay') = 0 and (select count(*) from public.messages where related_type = 'visit') = 1,
  'who reads the client''s other messages but not the autopay invite');
select tautopay.check(not exists (select 1 from public.activity where verb like 'autopay.%'), 'or autopay''s activity (card names), though the client''s other activity is theirs to read');
select tautopay.as_user(:'lou');
select tautopay.check(tautopay.seen('client_payment_methods') + tautopay.seen('autopay_authorizations') + tautopay.seen('autopay_charges') = 0, 'nor a crew lead');
select tautopay.as_user(:'cy');
select tautopay.check(tautopay.seen('client_payment_methods') + tautopay.seen('autopay_authorizations') + tautopay.seen('autopay_charges') = 0, 'nor field crew');
select tautopay.check((select count(*) from public.messages where related_type = 'visit') = 1 and (select count(*) from public.messages where related_type = 'autopay') = 0,
  'Cy, on Pat''s visits, reads Pat''s "on our way" text but not the autopay invite');
select tautopay.as_user(:'sal');
select tautopay.check(tautopay.seen('client_payment_methods') + tautopay.seen('autopay_authorizations') + tautopay.seen('autopay_charges') = 0, 'nor a sub');
select tautopay.as_user(:'pat');
select tautopay.check(tautopay.seen('client_payment_methods') + tautopay.seen('autopay_authorizations') + tautopay.seen('autopay_charges') = 0, 'nor another business');
commit;
begin;
set local role authenticated;
select tautopay.as_user(:'olive');
select tautopay.expect_error(format('insert into public.client_payment_methods (company_id, client_id, stripe_payment_method_id, stripe_customer_id, livemode, type) values (%L, %L, %L, %L, false, %L)',
  :'co', :'c_sam', 'pm_mine', 'cus_mine', 'card'), 'nobody signed in saves a card, not even the owner');
select tautopay.expect_error(format('update public.client_payment_methods set status = %L where id = %L', 'active', :'rex_card'), 'or changes one');
select tautopay.expect_error(format('delete from public.autopay_authorizations where id = %L', :'auth_pat'), 'or deletes an agreement');
select tautopay.expect_error(format('insert into public.autopay_authorizations (company_id, client_id, terms, terms_version, source) values (%L, %L, %L, %L, %L)',
  :'co', :'c_sam', 'Yes', :'ver', 'owner'), 'or writes one');
select tautopay.expect_error(format('update public.autopay_charges set status = %L where id = %L', 'paid', :'p'), 'or marks a charge paid');
select tautopay.expect_error(format('delete from public.autopay_charges where id = %L', :'p'), 'or deletes one');
commit;
begin;
set local role anon;
select tautopay.expect_error('select count(*) from public.client_payment_methods', 'and signed out, there''s nothing to read');
select tautopay.expect_error('select count(*) from public.autopay_charges', 'charges included');
commit;

-- Rules about autopay are for the office with the invoices area.
insert into public.automation_rules (company_id, name, trigger, actions)
values (:'co', 'Tell the office', 'autopay.failed', '[{"type": "notify", "roles": ["owner", "office"], "title": "Autopay failed"}]') returning id as rule \gset
insert into public.automation_runs (company_id, rule_id, subject_type, subject_id) values (:'co', :'rule', 'client', :'c_pat');
begin;
set local role authenticated;
select tautopay.as_user(:'mia');
select tautopay.check((select count(*) from public.automation_rules where company_id = :'co') > 0
    and not exists (select 1 from public.automation_rules where trigger like 'autopay.%') and not exists (select 1 from public.automation_runs where rule_id = :'rule'),
  'the office with automations but not invoices reads the other rules, not one about autopay or its runs');
select tautopay.expect_error(format('insert into public.automation_rules (company_id, name, trigger) values (%L, %L, %L)', :'co', 'Mine', 'autopay.enabled'), 'or makes one');
select tautopay.expect_error(format('insert into public.automation_rules (company_id, name, trigger) values (%L, %L, %L)', :'co', 'Mine', 'payment_method.expiring'), 'about an expiring card either');
select tautopay.as_user(:'eve');
select tautopay.check(not exists (select 1 from public.automation_rules where trigger like 'autopay.%'), 'and an estimator reads none');
select tautopay.as_user(:'opal');
select tautopay.check(tautopay.error_of(format('insert into public.automation_rules (company_id, name, trigger, actions) values (%L, %L, %L, %L)', :'co', 'Note it', 'autopay.failed',
    '[{"type": "add_note", "body": "Card {{autopay.card}} failed"}]')) = '22023: A rule about autopay can''t add a client note (crews can read them)'
  and tautopay.error_of(format('insert into public.automation_rules (company_id, name, trigger, actions) values (%L, %L, %L, %L)', :'co', 'Tell crews', 'autopay.failed',
    '[{"type": "notify", "roles": ["office", "field_crew"], "title": "Failed"}]')) = '22023: Only the office hears about autopay, never the crew'
  and tautopay.error_of(format('insert into public.automation_rules (company_id, name, trigger, actions) values (%L, %L, %L, %L)', :'co', 'Task it', 'autopay.failed',
    '[{"type": "create_task", "title": "Call about {{autopay.card}}"}]')) = '22023: A task can''t carry card or autopay details'
  and tautopay.error_of(format('update public.automation_rules set actions = %L where id = %L', '[{"type": "notify", "roles": ["crew_lead"]}]', :'rule')) like '22023:%',
  'a rule about autopay can''t add a client note, tell the crew or put card details in a task');
select tautopay.check(tautopay.error_of(format('insert into public.automation_rules (company_id, name, trigger, actions) values (%L, %L, %L, %L)', :'co', 'Call them', 'autopay.failed',
    '[{"type": "create_task", "title": "Call {{client.name}} about their card"}, {"type": "send_email", "body": "Update your card: {{autopay.link}}"}]')) = 'none',
  'but the office with the invoices area makes one that emails the client and makes a plain task');
commit;

-- ===== Reopened visits and work called off ====================================================

-- The only finished visit reopened (Cy taps it back) calls the charge off; one of two doesn't.
select tautopay.ready_client(:'co', 'Ria Reopen') as c_ria \gset
select tautopay.job(:'co', :'c_ria') as j_ria \gset
select tautopay.visit(:'co', :'j_ria') as ra \gset
select tautopay.visit(:'co', :'j_ria') as rb \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'ra';
commit;
select tautopay.charge_of(:'j_ria') as ria1 \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'in_progress' where id = :'ra';
commit;
select tautopay.check(tautopay.state(:'ria1') = 'called_off: The visit was reopened', 'reopening the only finished visit calls its charge off');
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id in (:'ra', :'rb');
update public.visits set status = 'in_progress' where id = :'rb';
commit;
select tautopay.check(tautopay.state(tautopay.charge_of(:'j_ria')) = 'waiting'
    and (select visit_ids = array[:'ra']::uuid[] from public.autopay_charges where id = tautopay.charge_of(:'j_ria')),
  'reopening one of two leaves the charge for the other, which no longer names the reopened one');

-- A visit reopened after it was billed: the charge waiting for the office's OK is called off, and
-- the office is told to send the invoice the usual way.
select tautopay.ready_client(:'co', 'Max Mansion') as c_max \gset
select tautopay.job(:'co', :'c_max', 600) as j_max \gset
select tautopay.visit(:'co', :'j_max') as vmax \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vmax';
commit;
select tautopay.charge_of(:'j_max') as max \gset
select tautopay.due(:'max');
select tautopay.check(public.autopay_bill(:'max', tautopay.claim_one(:'co', :'max')) ->> 'outcome' = 'needs_approval', 'a $600 visit is over the $500 limit');
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'in_progress' where id = :'vmax';
commit;
select tautopay.check(tautopay.state(:'max') = 'called_off: A visit on it was reopened'
    and tautopay.told(:'opal', 'Send invoice #%') like 'Send invoice #% to Max Mansion the usual way | A visit on it was reopened'
    and tautopay.told(:'cy') is null
    and (select count(*) from public.outbox where topic = 'stripe.invoice' and done_at is null and payload ->> 'invoice_id' = (select invoice_id::text from public.autopay_charges where id = :'max')) = 1,
  'reopening a visit on an invoice waiting for the office''s OK calls the charge off and tells the office (not the crew)');

-- Invoiced by hand meanwhile: nothing's left for the charge to bill.
select tautopay.ready_client(:'co', 'Hana Hand') as c_hana \gset
select tautopay.job(:'co', :'c_hana') as j_hana \gset
select tautopay.visit(:'co', :'j_hana') as vhana \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vhana';
select tautopay.as_user(:'opal');
select public.create_invoice_for_job(:'j_hana', 'visits');
commit;
select tautopay.charge_of(:'j_hana') as hana \gset
select tautopay.due(:'hana');
select public.autopay_bill(:'hana', tautopay.claim_one(:'co', :'hana')) as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'called_off' and tautopay.state(:'hana') = 'called_off: There are no completed visits waiting to be invoiced',
  'a job the office invoiced by hand is called off when the charge comes to bill it');

-- Autopay turned off for a job, the job archived, the agreement turned off or paused: what wasn't
-- charged is called off; a charge being made or money on its way is left.
create function tautopay.rows(p_company uuid, p_client uuid, p_job uuid) returns void language sql as $$
  insert into public.autopay_charges (company_id, client_id, job_id, bill, due_at, status)
  select p_company, p_client, p_job, 'visits', now() + interval '1 day', s
  from unnest(array['waiting', 'needs_approval', 'failed', 'charging', 'processing', 'needs_client']) s
$$;
create function tautopay.left_of(p_job uuid) returns text language sql as $$
  select string_agg(status, ',' order by status) from public.autopay_charges where job_id = p_job and status <> 'called_off'
$$;
select tautopay.ready_client(:'co', 'Cal Calloff') as c_cal \gset
select tautopay.job(:'co', :'c_cal') as j_cal1 \gset
select tautopay.job(:'co', :'c_cal') as j_cal2 \gset
select tautopay.rows(:'co', :'c_cal', :'j_cal1');
select tautopay.rows(:'co', :'c_cal', :'j_cal2');
update public.autopay_charges set locked_until = now() + interval '5 minutes', claim_token = gen_random_uuid() where client_id = :'c_cal' and status = 'charging';
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.jobs set autopay = false where id = :'j_cal1';
update public.jobs set status = 'archived' where id = :'j_cal2';
commit;
select tautopay.check(tautopay.left_of(:'j_cal1') = 'charging,needs_client,processing' and tautopay.left_of(:'j_cal2') = 'charging,needs_client,processing'
    and (select count(*) from public.autopay_charges where job_id = :'j_cal1' and last_error = 'Autopay was turned off for this job') = 3
    and (select count(*) from public.autopay_charges where job_id = :'j_cal2' and last_error = 'The job was archived') = 3,
  'turning a job''s autopay off, or archiving it, calls off waiting, needs-approval and failed charges, never one being made or on its way');
select tautopay.ready_client(:'co', 'Val Revoked') as c_val \gset
select tautopay.job(:'co', :'c_val') as j_val \gset
select tautopay.rows(:'co', :'c_val', :'j_val');
select tautopay.ready_client(:'co', 'Paz Paused') as c_paz \gset
select tautopay.job(:'co', :'c_paz') as j_paz \gset
select tautopay.rows(:'co', :'c_paz', :'j_paz');
select public.autopay_revoke(:'co', :'c_val', 'client') as revoked \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_paz', true);
commit;
select tautopay.check(:'revoked' = '1' and tautopay.left_of(:'j_val') = 'charging,needs_client,processing' and tautopay.left_of(:'j_paz') = 'charging,needs_client,processing'
    and (select count(*) from public.autopay_charges where job_id = :'j_val' and last_error = 'Autopay was turned off') = 3
    and (select count(*) from public.autopay_charges where job_id = :'j_paz' and last_error = 'Autopay is paused') = 3,
  'the client turning autopay off, or the office pausing it, does the same');
select tautopay.check(tautopay.told(:'opal', '%turned off autopay') = 'Val Revoked turned off autopay | Their invoices go out with the Pay link again.'
    and tautopay.told(:'otto') is null and tautopay.told(:'eve') is null,
  'and the office with the invoices area hears that the client turned it off');
select tautopay.check(public.autopay_revoke(:'co', :'c_val', 'client') = 0, 'turning it off again changes nothing');

-- A reopened visit doesn't touch another invoice's retry.
select tautopay.ready_client(:'co', 'Rhea Retry') as c_rhea \gset
select tautopay.job(:'co', :'c_rhea') as j_rhea \gset
select tautopay.visit(:'co', :'j_rhea') as rha \gset
select tautopay.visit(:'co', :'j_rhea') as rhb \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'rha';
commit;
select tautopay.charge_of(:'j_rhea') as rhea1 \gset
select tautopay.due(:'rhea1');
select tautopay.charge(:'co', :'rhea1', 'declined', 'Your card was declined.', 'card_declined');
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'rhb';
commit;
select tautopay.charge_of(:'j_rhea') as rhea2 \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'scheduled' where id = :'rhb';
commit;
select tautopay.check(tautopay.state(:'rhea2') = 'called_off: The visit was reopened' and tautopay.state(:'rhea1') like 'failed: %',
  'reopening a visit calls off its own charge, not another invoice''s retry');

-- ===== One-off jobs ============================================================================

select tautopay.ready_client(:'co', 'Olly Oneoff') as c_olly \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
insert into public.jobs (company_id, client_id, title, autopay) values (:'co', :'c_olly', 'Spring cleanup', true) returning id as j_one \gset
insert into public.job_line_items (company_id, job_id, name, unit_price) values (:'co', :'j_one', 'Cleanup', 300);
update public.jobs set status = 'requires_invoicing' where id = :'j_one';
commit;
select tautopay.charge_of(:'j_one') as one1 \gset
select tautopay.check((select autopay from public.jobs where id = :'j_one') and (select bill = 'standard' and status = 'waiting' from public.autopay_charges where id = :'one1'),
  'marking a one-off job''s work complete queues its charge');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.jobs set status = 'active' where id = :'j_one';
commit;
select tautopay.check(tautopay.state(:'one1') = 'called_off: The work was marked not done', 'marking it not done calls it off');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.jobs set status = 'requires_invoicing' where id = :'j_one';
update public.jobs set status = 'completed' where id = :'j_one';
commit;
select tautopay.check(tautopay.state(tautopay.charge_of(:'j_one', true)) = 'called_off: The job was closed', 'and so does Close job without an invoice');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.jobs set status = 'active' where id = :'j_one';
update public.jobs set status = 'requires_invoicing' where id = :'j_one';
commit;
select tautopay.charge_of(:'j_one') as one3 \gset
select tautopay.due(:'one3');
select tautopay.claim_one(:'co', :'one3') as tok \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.jobs set status = 'completed' where id = :'j_one';
commit;
select tautopay.check(tautopay.state(:'one3') = 'charging', 'closing the job while its charge is claimed leaves it to the task');
select public.autopay_bill(:'one3', :'tok') as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'called_off' and tautopay.state(:'one3') = 'called_off: The job isn''t waiting to be billed'
    and not exists (select 1 from public.invoices where job_id = :'j_one'),
  'which calls it off on fresh data, with no invoice made');

-- A job made one-off (from a quote) and edited into a recurring per-visit one gets the default.
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
insert into public.jobs (company_id, client_id, title) values (:'co', :'c_olly', 'Lawn care') returning id as j_edit \gset
commit;
select tautopay.check((select not autopay and autopay_since is null from public.jobs where id = :'j_edit'), 'a one-off job doesn''t start on autopay');
begin;
set local role authenticated;
select tautopay.as_user(:'eve');
update public.jobs set kind = 'recurring', recurrence_rule = 'FREQ=WEEKLY;BYDAY=TU', billing_mode = 'per_visit' where id = :'j_edit';
commit;
select tautopay.check((select autopay and autopay_since is not null from public.jobs where id = :'j_edit'),
  'edited into a recurring per-visit job for a client on autopay, it gets the default (whoever edits it)');

-- ===== The task: claim and bill ================================================================

-- Pat's two visits, charged.
select tautopay.due(:'p');
select tautopay.claim_one(:'co', :'p') as tok \gset
select tautopay.check((select count(*) from public.claim_autopay_charges(25, :'co')) = 0, 'a claimed charge isn''t claimed again');
select tautopay.check(public.autopay_bill(:'p', gen_random_uuid()) ->> 'outcome' = 'lost' and tautopay.state(:'p') = 'charging',
  'billing it without the claim gets "lost" and changes nothing');
select public.autopay_bill(:'p', :'tok') as bill \gset
select (:'bill'::jsonb) ->> 'invoice_id' as inv_pat \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'charge' and (:'bill'::jsonb) ->> 'invoice_status' = 'draft' and ((:'bill'::jsonb) ->> 'balance_due')::numeric = 90
    and (:'bill'::jsonb) -> 'method' = jsonb_build_object('id', :'pm_pat', 'stripe_payment_method_id', 'pm_pat', 'stripe_customer_id', 'cus_pat',
      'livemode', false, 'stripe_account', 'acct_lawns', 'type', 'card'),
  'billing makes the draft and says what to charge, and to which card in Stripe');
select tautopay.check((select count(*) from public.invoices where job_id = :'j_pat') = 1 and (select invoice_id from public.autopay_charges where id = :'p') = :'inv_pat'
    and (select bool_and(invoice_id = :'inv_pat') from public.visits where id in (:'v1', :'v2')),
  'one invoice for both visits, linked to the charge');
select tautopay.check(public.autopay_mark_sent(:'p', :'tok', 9001) = false and (select status from public.invoices where id = :'inv_pat') = 'draft',
  'marking it sent for an amount that isn''t the invoice''s changes nothing');
select tautopay.check(public.autopay_mark_sent(:'p', gen_random_uuid(), 9000) = false, 'nor without the claim');
select public.autopay_mark_sent(:'p', :'tok', 9000) as sent \gset
select tautopay.check(:'sent'::boolean and (select status from public.invoices where id = :'inv_pat') = 'sent'
    and (select count(*) from public.invoices where job_id = :'j_pat') = 1,
  'for its exact amount, the invoice is sent (no second invoice)');
-- Stripe paid it, and the task books it as recordPayment does.
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection) values (:'co', :'inv_pat', 'in_auto_pat', 'crewtavo', 'paid', 90, 'charge_automatically');
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_pat', 90, 'card', 'stripe', 'pi_auto_pat');
select tautopay.check(tautopay.state(:'p') = 'charging', 'the payment arriving while the charge is held leaves it to the task');
select tautopay.check(public.finish_autopay_charge(:'p', 'paid', :'tok', null, null, 90), 'the task says it''s paid');
select tautopay.check((select status = 'paid' and charged_amount = 90 and charged_at is not null and claim_token is null from public.autopay_charges where id = :'p')
    and (select count(*) from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'p') = 1,
  'paid, with what Stripe charged, and one receipt queued');
update public.autopay_charges set status = 'paid' where id = :'p';
select tautopay.check(public.finish_autopay_charge(:'p', 'paid', :'tok') = false
    and (select count(*) from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'p') = 1,
  'and no second receipt, however often it''s told');
select tautopay.check(tautopay.error_of(format('select public.finish_autopay_charge(%L, %L, %L)', :'p', 'refunded', :'tok')) = '22023: Unknown outcome', 'an outcome it doesn''t know is refused');

-- Over the limit: it waits for the office's OK, and asks again if the bill grows.
select tautopay.ready_client(:'co', 'Quinn Quarry') as c_quinn \gset
select tautopay.job(:'co', :'c_quinn', 600) as j_quinn \gset
select tautopay.visit(:'co', :'j_quinn') as vq \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vq';
commit;
select tautopay.charge_of(:'j_quinn') as q \gset
select tautopay.due(:'q');
select public.autopay_bill(:'q', tautopay.claim_one(:'co', :'q')) as bill \gset
select (:'bill'::jsonb) ->> 'invoice_id' as inv_q \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and (select status = 'needs_approval' and claim_token is null from public.autopay_charges where id = :'q')
    and (select status from public.invoices where id = :'inv_q') = 'draft',
  'over the limit, the charge waits for the office''s OK and the invoice stays a draft');
select tautopay.check(tautopay.told(:'opal', 'Approve%Quinn%') = 'Approve a $600.00 charge for Quinn Quarry | It''s over your autopay limit, so it waits for your OK.'
    and tautopay.told(:'olive', 'Approve%Quinn%') is not null and tautopay.told(:'otto') is null and tautopay.told(:'mia') is null and tautopay.told(:'cy') is null,
  'and the people who look after money are asked');
begin;
set local role authenticated;
select tautopay.as_user(:'eve');
select tautopay.check(tautopay.error_of(format('select public.approve_autopay_charge(%L)', :'q')) = '42501: Only the office with the invoices area can do that', 'an estimator can''t approve it');
select tautopay.as_user(:'otto');
select tautopay.check(tautopay.error_of(format('select public.approve_autopay_charge(%L)', :'q')) like '42501:%', 'nor the office without the invoices area');
select tautopay.as_user(:'opal');
select public.approve_autopay_charge(:'q');
select tautopay.check(tautopay.error_of(format('select public.approve_autopay_charge(%L)', :'q')) = '22023: This charge isn''t waiting for your OK', 'approving twice says so');
commit;
select tautopay.check((select status = 'waiting' and due_at <= now() and approved_by = :'opal' and approved_amount = 600 from public.autopay_charges where id = :'q'),
  'Approve charge sends it on now, for the amount approved');
-- The office adds to the draft before it goes.
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'inv_q', 'Edging', 50);
commit;
select public.autopay_bill(:'q', tautopay.claim_one(:'co', :'q')) ->> 'outcome' as outcome \gset
select tautopay.check(:'outcome' = 'needs_approval'
    and (select approved_at is null and approved_amount is null from public.autopay_charges where id = :'q'),
  'more than was approved asks again');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.approve_autopay_charge(:'q');
commit;
select tautopay.claim_one(:'co', :'q') as tok \gset
select tautopay.check(public.autopay_bill(:'q', :'tok') ->> 'outcome' = 'charge', 'approved again, it''s charged');
-- While it's being charged, nobody signed in changes what it's charged for.
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select tautopay.check(tautopay.error_of(format('delete from public.invoices where id = %L', :'inv_q')) = '22023: This invoice is being charged automatically right now. Try again in a few minutes'
    and tautopay.error_of(format('insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (%L, %L, %L, 10)', :'co', :'inv_q', 'Extra')) like '22023: This invoice is being charged%'
    and tautopay.error_of(format('update public.invoice_line_items set unit_price = 1 where invoice_id = %L', :'inv_q')) like '22023: This invoice is being charged%'
    and tautopay.error_of(format('delete from public.invoice_line_items where invoice_id = %L', :'inv_q')) like '22023: This invoice is being charged%'
    and tautopay.error_of(format('insert into public.payments (company_id, client_id, invoice_id, amount, method) values (%L, %L, %L, 10, %L)', :'co', :'c_quinn', :'inv_q', 'check')) like '22023: This invoice is being charged%'
    and tautopay.error_of(format('update public.invoices set status = %L where id = %L', 'void', :'inv_q')) like '22023: This invoice is being charged%'
    and tautopay.error_of(format('update public.invoices set tax_rate = 0.05 where id = %L', :'inv_q')) like '22023: This invoice is being charged%',
  'deleting the draft, changing its lines, its tax, voiding it or recording a payment on it waits while it''s charged');
select tautopay.check(tautopay.error_of(format('update public.invoices set notes = %L where id = %L', 'Gate code 1234', :'inv_q')) = 'none', 'a note on it is fine');
commit;
-- The server deleting it meanwhile: nothing is marked sent.
delete from public.invoices where id = :'inv_q';
select tautopay.check(public.autopay_mark_sent(:'q', :'tok', 65000) = false and tautopay.state(:'q') = 'charging', 'a deleted invoice isn''t marked sent');
select public.finish_autopay_charge(:'q', 'retry', :'tok', 'The invoice changed while it was being charged') as finished \gset
select tautopay.check(:'finished'::boolean
    and (select status = 'charging' and claim_token is null and locked_until > now() + interval '9 minutes' and attempts = 3 from public.autopay_charges where id = :'q'),
  'a retry keeps it for 10 minutes, without the claim, and the attempt counts');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.call_off_autopay_charge(:'q');
select tautopay.check(tautopay.error_of(format('select public.call_off_autopay_charge(%L)', :'q')) = '22023: This charge can''t be called off now', 'a charge called off stays so');
commit;
select tautopay.check(tautopay.state(:'q') = 'called_off: Called off by the office', 'between tries, the office calls it off');

-- Visits finished before the client agreed: the office says first, whatever the amount.
insert into public.clients (company_id, display_name, email) values (:'co', 'Vic Before', 'vic@autopay.test') returning id as c_vic \gset
select public.autopay_save_payment_method(:'co', :'c_vic', '{"stripe_payment_method_id": "pm_vic", "stripe_customer_id": "cus_vic", "livemode": false, "type": "card", "brand": "visa", "last4": "1111", "status": "active", "make_default": true}') as pm_vic \gset
select tautopay.job(:'co', :'c_vic') as j_vic \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.jobs set autopay = true where id = :'j_vic';
commit;
select tautopay.visit(:'co', :'j_vic') as vva \gset
select tautopay.visit(:'co', :'j_vic') as vvb \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vva';
commit;
select public.autopay_record_authorization(:'co', :'c_vic', :'pm_vic', 'hub', :'ver');
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vvb';
commit;
select tautopay.charge_of(:'j_vic') as vic \gset
select tautopay.due(:'vic');
select public.autopay_bill(:'vic', tautopay.claim_one(:'co', :'vic')) as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'vic') = 'needs_approval: Includes visits from before autopay started'
    and tautopay.told(:'opal', 'Approve%Vic%') = 'Approve a $90.00 charge for Vic Before | Includes visits from before autopay started',
  'a bill with visits finished before the client agreed waits for the office''s OK, under the limit too');
select tautopay.check((select visit_ids = array[:'vvb']::uuid[] from public.autopay_charges where id = :'vic'),
  'the charge names only the visit that queued it, not the one finished before the client agreed');

-- Declines: tried again in 3 days, then the client is asked and the card needs updating.
select tautopay.ready_client(:'co', 'Dee Decline') as c_dee \gset
select tautopay.job(:'co', :'c_dee') as j_dee \gset
select tautopay.visit(:'co', :'j_dee') as vdee \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vdee';
commit;
select tautopay.charge_of(:'j_dee') as dee \gset
select tautopay.due(:'dee');
select tautopay.charge(:'co', :'dee', 'declined', 'Your card was declined.', 'card_declined');
select tautopay.check((select status = 'failed' and failures = 1 and attempts = 1 and decline_code = 'card_declined' and due_at > now() + interval '71 hours'
         and claim_token is null from public.autopay_charges where id = :'dee')
    and (select i.status from public.invoices i join public.autopay_charges a on a.invoice_id = i.id where a.id = :'dee') = 'sent',
  'declined once: failed, tried again in 3 days, the invoice sent and owed');
select tautopay.check((select count(*) from public.outbox where topic = 'autopay.notice' and payload = jsonb_build_object('charge_id', :'dee', 'status', 'failed', 'failures', 1)) = 1,
  'the client''s notice is queued');
select tautopay.check(tautopay.told(:'opal', '%Dee%') = format('Autopay failed: Dee Decline | Invoice #%s · Your card was declined. We''ll try again on %s.',
      (select i.number from public.invoices i join public.autopay_charges a on a.invoice_id = i.id where a.id = :'dee'),
      (select to_char(due_at at time zone :'tz', 'Mon FMDD') from public.autopay_charges where id = :'dee'))
    and tautopay.told(:'ada', '%Dee%') is not null and tautopay.told(:'olive', '%Dee%') is not null
    and tautopay.told(:'cy') is null and tautopay.told(:'lou') is null and tautopay.told(:'eve') is null and tautopay.told(:'otto') is null and tautopay.told(:'sal') is null,
  'the office is told when it''ll try again; the crew, estimators and subs aren''t');
select tautopay.check((select data ->> 'card' = 'Visa ending 4242' and data ->> 'reason' = 'Your card was declined.' and data ->> 'status' = 'failed' and data ->> 'client_id' = :'c_dee'
    from public.activity where verb = 'autopay.failed' and subject_id = (select invoice_id from public.autopay_charges where id = :'dee')),
  'and autopay.failed is noted for automations, with the card and why');
begin;
set local role authenticated;
select tautopay.as_user(:'eve');
select tautopay.check(not exists (select 1 from public.activity where verb = 'autopay.failed'), 'an estimator doesn''t read it');
select tautopay.as_user(:'opal');
select tautopay.check(exists (select 1 from public.activity where verb = 'autopay.failed'), 'the office with the invoices area does');
commit;
-- Claimed and let go (the batch ran out of time): nobody is told again.
select (select count(*) from public.notifications where kind = 'autopay') + (select count(*) from public.activity where verb like 'autopay.%')
  + (select count(*) from public.outbox where topic like 'autopay.%') as told_before \gset
select tautopay.due(:'dee');
select public.release_autopay_charges(tautopay.claim_one(:'co', :'dee'), array[:'dee']::uuid[]) as released \gset
select tautopay.check(:'released'::integer = 1
    and (select status = 'failed' and attempts = 1 and claim_token is null from public.autopay_charges where id = :'dee'),
  'a retry claimed and let go is failed again, without using an attempt');
select tautopay.check((select count(*) from public.notifications where kind = 'autopay') + (select count(*) from public.activity where verb like 'autopay.%')
  + (select count(*) from public.outbox where topic like 'autopay.%') = :'told_before', 'and nobody is told anything again');
select tautopay.charge(:'co', :'dee', 'declined', 'Your card was declined.', 'card_declined') as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'invoice_status' = 'sent'
    and (select status = 'needs_client' and failures = 2 from public.autopay_charges where id = :'dee')
    and (select status from public.client_payment_methods where client_id = :'c_dee') = 'needs_update'
    and private.autopay_ready(:'co', :'c_dee') is null,
  'declined again: the client is asked, the card needs updating, and autopay is paused for them');
select tautopay.check(tautopay.told(:'opal', 'Autopay needs Dee%') = 'Autopay needs Dee Decline | The card was declined twice, so autopay is paused until they update it.'
    and (select count(*) from public.outbox where topic = 'autopay.notice' and payload = jsonb_build_object('charge_id', :'dee', 'status', 'needs_client', 'failures', 2)) = 1,
  'the office and the client are told');
select tautopay.due(:'dee');
select tautopay.check((select count(*) from public.claim_autopay_charges(25, :'co')) = 0, 'a charge waiting on the client isn''t tried again');

-- The bank wants the client to confirm (3D Secure).
select tautopay.ready_client(:'co', 'Tao Three') as c_tao \gset
select tautopay.job(:'co', :'c_tao') as j_tao \gset
select tautopay.visit(:'co', :'j_tao') as vtao \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vtao';
commit;
select tautopay.charge_of(:'j_tao') as tao \gset
select tautopay.due(:'tao');
select tautopay.charge(:'co', :'tao', 'needs_client', 'This payment needs to be confirmed.', 'authentication_required');
select tautopay.check(tautopay.state(:'tao') = 'needs_client: This payment needs to be confirmed.'
    and tautopay.told(:'opal', 'Autopay needs Tao%') = 'Autopay needs Tao Three | Their bank wants them to confirm the payment.'
    and (select count(*) from public.outbox where topic = 'autopay.notice' and payload ->> 'charge_id' = :'tao') = 1,
  'a bank that wants the client to confirm: the client is asked, and the office told');

-- A bank payment: on its way, then bounced. Never presented again.
select tautopay.ready_client(:'co', 'Bo Bank', 'us_bank_account') as c_bo \gset
select tautopay.job(:'co', :'c_bo') as j_bo \gset
select tautopay.visit(:'co', :'j_bo') as vbo \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vbo';
commit;
select tautopay.charge_of(:'j_bo') as bo \gset
select tautopay.due(:'bo');
select tautopay.charge(:'co', :'bo', 'processing');
select tautopay.check((select status = 'processing' and charged_amount = 45 and claim_token is null from public.autopay_charges where id = :'bo'), 'a bank payment on its way is processing');
select tautopay.check(public.finish_autopay_charge(:'bo', 'bank_failed') = false and public.finish_autopay_charge(:'bo', 'bank_failed', p_company => :'other') = false
    and public.finish_autopay_charge(:'bo', 'declined', p_company => :'co') = false and tautopay.state(:'bo') = 'processing',
  'the webhook''s path needs the charge''s own company, and only says paid or bounced');
select tautopay.check(public.finish_autopay_charge(:'bo', 'bank_failed', p_company => :'co', p_decline => 'R01'), 'the webhook says it bounced');
select tautopay.check((select status = 'needs_client' and failures = 1 and decline_code = 'R01' from public.autopay_charges where id = :'bo')
    and (select status from public.client_payment_methods where client_id = :'c_bo') = 'needs_update'
    and tautopay.told(:'opal', 'Autopay needs Bo%') = 'Autopay needs Bo Bank | Their bank payment didn''t go through, so autopay is paused until they update it.',
  'a bounced bank payment needs the client, the account needs updating, and the office hears why');
select tautopay.due(:'bo');
select tautopay.check((select count(*) from public.claim_autopay_charges(25, :'co')) = 0, 'and it''s never presented again');

-- Declined twice, then the client updates their card as the notice asks: the charge is tried once
-- on the new card, now, and nobody is told again until that goes.
select tautopay.ready_client(:'co', 'Una Update') as c_una \gset
select tautopay.job(:'co', :'c_una') as j_una \gset
select tautopay.visit(:'co', :'j_una') as vuna \gset
update public.visits set status = 'completed' where id = :'vuna';
select tautopay.charge_of(:'j_una') as una \gset
select tautopay.due(:'una');
select tautopay.charge(:'co', :'una', 'declined', 'Your card was declined.', 'card_declined');
select tautopay.due(:'una');
select tautopay.charge(:'co', :'una', 'declined', 'Your card was declined.', 'card_declined');
select (select count(*) from public.notifications where kind = 'autopay') + (select count(*) from public.outbox where topic = 'autopay.notice') as told_una \gset
select public.autopay_save_payment_method(:'co', :'c_una', '{"stripe_payment_method_id": "pm_una_new", "stripe_customer_id": "cus_una_update", "livemode": false, "type": "card", "brand": "mastercard", "last4": "4444", "status": "active", "make_default": false}') as una_new \gset
select public.autopay_record_authorization(:'co', :'c_una', :'una_new', 'hub', :'ver');
select tautopay.check((select status = 'failed' and failures = 0 and payment_method_id = :'una_new' and due_at <= now() from public.autopay_charges where id = :'una')
    and (select count(*) from public.notifications where kind = 'autopay') + (select count(*) from public.outbox where topic = 'autopay.notice') = :'told_una'::integer,
  'declined twice, then the client agrees to another card: the charge is due now on it, and nobody is told again');
select tautopay.charge(:'co', :'una', 'paid') as bill \gset
select tautopay.check((:'bill'::jsonb) #>> '{method,id}' = :'una_new' and tautopay.state(:'una') = 'paid'
    and (select count(*) from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'una') = 1,
  'and it''s charged to the new card once, with a receipt');
-- Declined twice, then the client agrees to another card while the office has autopay paused:
-- nothing is tried while it's paused, and the charge is due now on the new card once it's resumed.
select tautopay.ready_client(:'co', 'Uri Unpause') as c_uri \gset
select tautopay.job(:'co', :'c_uri') as j_uri \gset
select tautopay.visit(:'co', :'j_uri') as vuri \gset
update public.visits set status = 'completed' where id = :'vuri';
select tautopay.charge_of(:'j_uri') as uri \gset
select tautopay.due(:'uri');
select tautopay.charge(:'co', :'uri', 'declined', 'Your card was declined.', 'card_declined');
select tautopay.due(:'uri');
select tautopay.charge(:'co', :'uri', 'declined', 'Your card was declined.', 'card_declined');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_uri', true);
commit;
select public.autopay_save_payment_method(:'co', :'c_uri', '{"stripe_payment_method_id": "pm_uri_new", "stripe_customer_id": "cus_uri_unpause", "livemode": false, "type": "card", "brand": "visa", "last4": "1616", "status": "active", "make_default": false}') as uri_new \gset
select public.autopay_record_authorization(:'co', :'c_uri', :'uri_new', 'hub', :'ver');
select tautopay.check(tautopay.state(:'uri') like 'needs_client:%', 'while paused, a new card isn''t tried');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_uri', false);
commit;
select tautopay.check((select status = 'failed' and failures = 0 and payment_method_id = :'uri_new' and due_at <= now() from public.autopay_charges where id = :'uri'),
  'once resumed, the charge is due now on the card they agreed to meanwhile');
select tautopay.charge(:'co', :'uri', 'paid') as bill \gset
select tautopay.check((:'bill'::jsonb) #>> '{method,id}' = :'uri_new' and tautopay.state(:'uri') = 'paid', 'and it''s charged to that card');
-- A bounced bank payment, then the client agrees to a bank account still being checked: tried once it's checked.
select tautopay.ready_client(:'co', 'Ned Newbank', 'us_bank_account') as c_ned \gset
select tautopay.job(:'co', :'c_ned') as j_ned \gset
select tautopay.visit(:'co', :'j_ned') as vned \gset
update public.visits set status = 'completed' where id = :'vned';
select tautopay.charge_of(:'j_ned') as ned \gset
select tautopay.due(:'ned');
select tautopay.charge(:'co', :'ned', 'processing');
select public.finish_autopay_charge(:'ned', 'bank_failed', p_company => :'co', p_decline => 'R01');
select public.autopay_save_payment_method(:'co', :'c_ned', '{"stripe_payment_method_id": "pm_ned_new", "stripe_customer_id": "cus_ned_newbank", "livemode": false, "type": "us_bank_account", "bank_name": "Chase", "last4": "1212", "status": "pending", "make_default": false}') as ned_new \gset
select public.autopay_record_authorization(:'co', :'c_ned', :'ned_new', 'hub', :'ver');
select tautopay.check(tautopay.state(:'ned') like 'needs_client:%', 'a bank account still being checked isn''t charged');
select public.autopay_save_payment_method(:'co', :'c_ned', '{"stripe_payment_method_id": "pm_ned_new", "stripe_customer_id": "cus_ned_newbank", "livemode": false, "type": "us_bank_account", "status": "active"}');
select tautopay.check((select status = 'failed' and failures = 0 and payment_method_id = :'ned_new' and due_at <= now() from public.autopay_charges where id = :'ned'),
  'once it''s checked, the bounced charge is due now on it');
select tautopay.charge(:'co', :'ned', 'processing');
select tautopay.check((select status = 'processing' from public.autopay_charges where id = :'ned'), 'and its bank payment is on its way');
-- Not one waiting on the client to confirm with their bank (after a decline, too), nor one paid another way meanwhile.
select tautopay.ready_client(:'co', 'Cal Confirm') as c_cal \gset
select tautopay.job(:'co', :'c_cal') as j_cal \gset
select tautopay.visit(:'co', :'j_cal') as vcal \gset
update public.visits set status = 'completed' where id = :'vcal';
select tautopay.charge_of(:'j_cal') as cal \gset
select tautopay.due(:'cal');
select tautopay.charge(:'co', :'cal', 'declined', 'Your card was declined.', 'card_declined');
select tautopay.due(:'cal');
select tautopay.charge(:'co', :'cal', 'needs_client', 'This payment needs to be confirmed.', 'authentication_required');
select public.autopay_save_payment_method(:'co', :'c_cal', '{"stripe_payment_method_id": "pm_cal_new", "stripe_customer_id": "cus_cal_confirm", "livemode": false, "type": "card", "brand": "visa", "last4": "1313", "status": "active", "make_default": false}') as cal_new \gset
select public.autopay_record_authorization(:'co', :'c_cal', :'cal_new', 'hub', :'ver');
select tautopay.ready_client(:'co', 'Pia Paidcheck') as c_pia \gset
select tautopay.job(:'co', :'c_pia') as j_pia \gset
select tautopay.visit(:'co', :'j_pia') as vpia \gset
update public.visits set status = 'completed' where id = :'vpia';
select tautopay.charge_of(:'j_pia') as pia \gset
select tautopay.due(:'pia');
select tautopay.charge(:'co', :'pia', 'declined', 'Your card was declined.', 'card_declined');
select tautopay.due(:'pia');
select tautopay.charge(:'co', :'pia', 'declined', 'Your card was declined.', 'card_declined') ->> 'invoice_id' as inv_pia \gset
insert into public.payments (company_id, client_id, invoice_id, amount, method, recorded_by) values (:'co', :'c_pia', :'inv_pia', 45, 'check', :'opal');
select public.autopay_save_payment_method(:'co', :'c_pia', '{"stripe_payment_method_id": "pm_pia_new", "stripe_customer_id": "cus_pia_paidcheck", "livemode": false, "type": "card", "brand": "visa", "last4": "1414", "status": "active", "make_default": false}') as pia_new \gset
select public.autopay_record_authorization(:'co', :'c_pia', :'pia_new', 'hub', :'ver');
select tautopay.check(tautopay.state(:'cal') = 'needs_client: This payment needs to be confirmed.' and tautopay.state(:'pia') = 'called_off: Paid another way',
  'a charge waiting on the client to confirm with their bank, or paid another way, isn''t tried on the new card');

-- Stripe credit pays all of it as its Stripe invoice is made, before it's marked sent: the invoice
-- doesn't stay a draft carrying the payment.
select tautopay.ready_client(:'co', 'Kai Credit') as c_cyc \gset
select tautopay.job(:'co', :'c_cyc') as j_cyc \gset
select tautopay.visit(:'co', :'j_cyc') as vcyc \gset
update public.visits set status = 'completed' where id = :'vcyc';
select tautopay.charge_of(:'j_cyc') as cyc \gset
select tautopay.due(:'cyc');
select tautopay.claim_one(:'co', :'cyc') as tok \gset
select public.autopay_bill(:'cyc', :'tok') ->> 'invoice_id' as inv_cyc \gset
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_cyc', 'in_auto_cyc', 'crewtavo', 'paid', 45, 'charge_automatically', 'invoice');
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor_ref, notes) values (:'co', :'c_cyc', :'inv_cyc', 45, 'other', 'in_auto_cyc:credit', 'Account credit in Stripe');
select tautopay.check((select status from public.invoices where id = :'inv_cyc') = 'draft', 'the credit is booked on the draft');
select public.finish_autopay_charge(:'cyc', 'paid', :'tok');
select tautopay.check(tautopay.state(:'cyc') = 'paid' and (select charged_amount is null from public.autopay_charges where id = :'cyc')
    and (select status = 'paid' and sent_at is not null from public.invoices where id = :'inv_cyc')
    and (select count(*) from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'cyc') = 1,
  'paid from Stripe credit: the invoice is sent and so paid, with one receipt and no amount charged to the card');

-- The same, but the worker stopped before marking it sent, and the webhook booked the credit on the
-- draft: the next claim takes it as paid, not as "nothing is owed".
select tautopay.ready_client(:'co', 'Kip Stopped') as c_kip \gset
select tautopay.job(:'co', :'c_kip') as j_kip \gset
select tautopay.visit(:'co', :'j_kip') as vkip \gset
update public.visits set status = 'completed' where id = :'vkip';
select tautopay.charge_of(:'j_kip') as kip \gset
select tautopay.due(:'kip');
select tautopay.claim_one(:'co', :'kip') as tok \gset
select public.autopay_bill(:'kip', :'tok') ->> 'invoice_id' as inv_kip \gset
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_kip', 'in_auto_kip', 'crewtavo', 'paid', 45, 'charge_automatically', 'invoice');
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor_ref, notes) values (:'co', :'c_kip', :'inv_kip', 45, 'other', 'in_auto_kip:credit', 'Account credit in Stripe');
select public.finish_autopay_charge(:'kip', 'retry', :'tok', 'The worker stopped');
update public.autopay_charges set locked_until = now() - interval '1 minute' where id = :'kip';
select tautopay.claim_one(:'co', :'kip') as tok \gset
-- Billed in its own statement, so the checks below see what it did.
select public.autopay_bill(:'kip', :'tok') ->> 'outcome' as kip_outcome \gset
select tautopay.check(:'kip_outcome' = 'paid' and tautopay.state(:'kip') = 'paid'
    and (select charged_amount = 0 from public.autopay_charges where id = :'kip')
    and (select status = 'paid' and sent_at is not null from public.invoices where id = :'inv_kip')
    and (select count(*) from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'kip') = 1,
  'paid from Stripe credit on a draft whose worker stopped: the next claim sends it and takes it as paid, with one receipt');

-- Stripe down, then busy: the attempt counts for a retry, not for busy, and a day of busy calls it off.
select tautopay.ready_client(:'co', 'Rio Retry') as c_rio \gset
select tautopay.job(:'co', :'c_rio') as j_rio \gset
select tautopay.visit(:'co', :'j_rio') as vrio \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vrio';
commit;
select tautopay.charge_of(:'j_rio') as rio \gset
select tautopay.due(:'rio');
select tautopay.claim_one(:'co', :'rio') as tok \gset
select public.autopay_bill(:'rio', :'tok');
select public.finish_autopay_charge(:'rio', 'retry', :'tok', 'Stripe is down');
select tautopay.check((select status = 'charging' and attempts = 1 and claim_token is null from public.autopay_charges where id = :'rio')
    and (select count(*) from public.claim_autopay_charges(25, :'co')) = 0,
  'a retry waits 10 minutes before it''s claimed again');
update public.autopay_charges set locked_until = now() - interval '1 minute' where id = :'rio';
select tautopay.claim_one(:'co', :'rio') as tok \gset
select tautopay.check(public.autopay_bill(:'rio', :'tok') ->> 'outcome' = 'charge' and (select count(*) from public.invoices where job_id = :'j_rio') = 1,
  'claimed again, it bills the invoice it already made');
select public.finish_autopay_charge(:'rio', 'busy', :'tok', 'Stripe''s invoice is still being made');
select tautopay.check((select status = 'charging' and attempts = 1 and busy_since is not null and claim_token is null from public.autopay_charges where id = :'rio'),
  'busy gives the attempt back');
update public.autopay_charges set locked_until = now() - interval '1 minute', busy_since = now() - interval '25 hours' where id = :'rio';
select tautopay.claim_one(:'co', :'rio') as tok \gset
select public.autopay_bill(:'rio', :'tok');
select public.finish_autopay_charge(:'rio', 'busy', :'tok', 'Stripe''s invoice is still being made');
select tautopay.check(tautopay.state(:'rio') = 'called_off: Stripe was busy with this for a day. Check the invoice and Stripe'
    and tautopay.told(:'opal', '%Rio%') like 'Send invoice #% to Rio Retry the usual way | Stripe was busy with this for a day. Check the invoice and Stripe',
  'a day of busy calls it off, and the office is told to send the draft the usual way');
select tautopay.check((select count(*) from public.outbox where topic = 'stripe.invoice' and done_at is null
    and payload ->> 'invoice_id' = (select invoice_id::text from public.autopay_charges where id = :'rio')) = 1,
  'with a Stripe sync queued for its invoice');

-- The database's own stop, for a task that kept crashing before it got to its own.
select tautopay.ready_client(:'co', 'Ace Eight') as c_ace \gset
select tautopay.job(:'co', :'c_ace') as j_ace \gset
insert into public.autopay_charges (company_id, client_id, job_id, bill, due_at, status, attempts, claim_token, locked_until)
values (:'co', :'c_ace', :'j_ace', 'visits', now() - interval '1 hour', 'charging', 8, gen_random_uuid(), now() - interval '1 minute') returning id as ace \gset
select tautopay.check((select count(*) from public.claim_autopay_charges(25, :'co')) = 0 and tautopay.state(:'ace') = 'called_off: Stopped after 8 tries. Check the invoice and Stripe',
  'a charge claimed 8 times whose worker stopped is called off, not claimed again');

-- A retry whose invoice was written off, or whose job's autopay was turned off, is never billed again.
create function tautopay.failed_charge(p_company uuid, p_name text) returns uuid language plpgsql as $$
declare v_client uuid; v_job uuid; v_visit uuid; v_charge uuid;
begin
  v_client := tautopay.ready_client(p_company, p_name);
  v_job := tautopay.job(p_company, v_client);
  v_visit := tautopay.visit(p_company, v_job);
  update public.visits set status = 'completed' where id = v_visit;
  v_charge := tautopay.charge_of(v_job);
  perform tautopay.due(v_charge);
  perform tautopay.charge(p_company, v_charge, 'declined', 'Your card was declined.', 'card_declined');
  return v_charge;
end $$;
select tautopay.failed_charge(:'co', 'Fay Written') as fay \gset
select tautopay.failed_charge(:'co', 'Gus Off') as gus \gset
select tautopay.failed_charge(:'co', 'Hal Claimed') as hal \gset
select tautopay.failed_charge(:'co', 'Ivy Check') as ivy \gset
select tautopay.failed_charge(:'co', 'Vera Void') as vera \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.invoices set status = 'written_off' where id = (select invoice_id from public.autopay_charges where id = :'fay');
update public.jobs set autopay = false where id = (select job_id from public.autopay_charges where id = :'gus');
update public.invoices set status = 'void' where id = (select invoice_id from public.autopay_charges where id = :'vera');
commit;
select tautopay.check(tautopay.state(:'fay') = 'called_off: The invoice was written off' and tautopay.state(:'gus') = 'called_off: Autopay was turned off for this job'
    and tautopay.state(:'vera') = 'called_off: The invoice was voided',
  'a retry whose invoice is written off or voided, or whose job''s autopay is turned off, is called off');
select tautopay.check(tautopay.told(:'opal', 'Invoice #%Gus Off%') like 'Invoice #% for Gus Off wasn''t charged | Autopay was turned off for this job. It''s owed as usual; send a reminder if they need the Pay link.',
  'and the office hears when that leaves an invoice owed');
select tautopay.due(:'fay');
select tautopay.due(:'gus');
select tautopay.due(:'hal');
select tautopay.claim_one(:'co', :'hal') as tok \gset
-- Written off in Stripe while it's claimed (the server's sync, so no guard).
update public.invoices set status = 'written_off' where id = (select invoice_id from public.autopay_charges where id = :'hal');
select tautopay.check(public.autopay_bill(:'hal', :'tok') ->> 'outcome' = 'called_off' and tautopay.state(:'hal') = 'called_off: The invoice was written off',
  'and one claimed after its invoice was written off is called off by the billing');

-- ===== Who's told what =========================================================================

-- A check recorded on a failed charge's invoice: paid another way, no receipt.
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
insert into public.payments (company_id, client_id, invoice_id, amount, method)
select a.company_id, a.client_id, a.invoice_id, i.balance_due, 'check' from public.autopay_charges a join public.invoices i on i.id = a.invoice_id where a.id = :'ivy';
commit;
select tautopay.check(tautopay.state(:'ivy') = 'called_off: Paid another way'
    and not exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'ivy')
    and tautopay.told(:'opal', '%Ivy%wasn''t charged%') is null,
  'a check on a failed charge''s invoice: called off as paid another way, no receipt and no notice');
-- The client pays autopay's Stripe invoice on Stripe's page with another card after a decline: the
-- server calls the charge off as paid another way, then books it as settleOwnInvoice does. Nothing
-- names the declined card as having paid: no receipt, no notice, and its Stripe invoice isn't synced.
select tautopay.failed_charge(:'co', 'Mo Othercard') as mo \gset
select invoice_id as inv_mo from public.autopay_charges where id = :'mo' \gset
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_mo', 'in_auto_mo', 'crewtavo', 'open', 45, 'charge_automatically', 'invoice');
update public.outbox set done_at = now() where topic = 'stripe.invoice' and payload ->> 'invoice_id' = :'inv_mo';
update public.autopay_charges set status = 'called_off', last_error = 'Paid another way' where id = :'mo' and status in ('failed', 'needs_client');
select tautopay.check(not exists (select 1 from public.outbox where topic = 'stripe.invoice' and done_at is null and payload ->> 'invoice_id' = :'inv_mo'),
  'called off as paid another way while its payment is being booked, its Stripe invoice isn''t synced');
update public.stripe_invoices set status = 'paid' where stripe_id = 'in_auto_mo';
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref)
  select company_id, client_id, :'inv_mo', 45, 'card', 'stripe', 'pi_hosted_mo' from public.autopay_charges where id = :'mo';
select tautopay.check(tautopay.state(:'mo') = 'called_off: Paid another way' and (select status from public.invoices where id = :'inv_mo') = 'paid'
    and not exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'mo')
    and tautopay.told(:'opal', '%Mo Othercard%wasn''t charged%') is null,
  'paid on Stripe''s page with another card after a decline: called off as paid another way once booked, no receipt and no notice');
-- An approved charge whose invoice the office sent and was paid by check meanwhile: the same.
select tautopay.ready_client(:'co', 'Ann Approved') as c_ann \gset
select tautopay.job(:'co', :'c_ann', 700) as j_ann \gset
select tautopay.visit(:'co', :'j_ann') as vann \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vann';
commit;
select tautopay.charge_of(:'j_ann') as ann \gset
select tautopay.due(:'ann');
select public.autopay_bill(:'ann', tautopay.claim_one(:'co', :'ann')) ->> 'invoice_id' as inv_ann \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.approve_autopay_charge(:'ann');
update public.invoices set status = 'sent' where id = :'inv_ann';
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'c_ann', :'inv_ann', 700, 'check');
commit;
select tautopay.check(tautopay.state(:'ann') = 'called_off: Paid another way' and not exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'ann'),
  'an approved charge whose invoice was paid by check is called off, with no receipt');
-- Waiting for the office's OK, and the office sends it the usual way instead.
select tautopay.ready_client(:'co', 'Uma Usual') as c_uma \gset
select tautopay.job(:'co', :'c_uma', 800) as j_uma \gset
select tautopay.visit(:'co', :'j_uma') as vuma \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vuma';
commit;
select tautopay.charge_of(:'j_uma') as uma \gset
select tautopay.due(:'uma');
select public.autopay_bill(:'uma', tautopay.claim_one(:'co', :'uma')) ->> 'invoice_id' as inv_uma \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.invoices set status = 'sent' where id = :'inv_uma';
commit;
select tautopay.check(tautopay.state(:'uma') = 'called_off: Sent the usual way' and tautopay.told(:'opal', '%Uma%wasn''t charged%') is null,
  'a charge waiting for the OK whose invoice the office sends the usual way is called off, quietly');
-- Called off on a draft by something other than the office: the office is told to send it.
select tautopay.ready_client(:'co', 'Zed Draft') as c_zed \gset
select tautopay.job(:'co', :'c_zed', 900) as j_zed \gset
select tautopay.visit(:'co', :'j_zed') as vzed \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed' where id = :'vzed';
commit;
select tautopay.charge_of(:'j_zed') as zed \gset
select tautopay.due(:'zed');
select public.autopay_bill(:'zed', tautopay.claim_one(:'co', :'zed')) ->> 'invoice_id' as inv_zed \gset
update public.outbox set done_at = now() where topic = 'stripe.invoice' and payload ->> 'invoice_id' = :'inv_zed';
select public.autopay_revoke(:'co', :'c_zed', 'office', :'opal');
select tautopay.check(tautopay.state(:'zed') = 'called_off: Autopay was turned off'
    and tautopay.told(:'opal', 'Send invoice #%Zed%') like 'Send invoice #% to Zed Draft the usual way | Autopay was turned off'
    and (select count(*) from public.outbox where topic = 'stripe.invoice' and done_at is null and payload ->> 'invoice_id' = :'inv_zed') = 1,
  'a charge on a draft called off when autopay is turned off: the office is told to send it the usual way, and its Stripe invoice is synced');

-- ===== What autopay charges without asking =====================================================

\set unqueued 'Includes visits autopay didn''t queue (finished while it was off, or from a voided invoice)'

-- A visit freed by voiding its invoice, billed with the next visit: the office says first.
select tautopay.ready_client(:'co', 'Wes Voided') as c_wes \gset
select tautopay.job(:'co', :'c_wes') as j_wes \gset
select tautopay.visit(:'co', :'j_wes') as wa \gset
select tautopay.visit(:'co', :'j_wes') as wb \gset
update public.visits set status = 'completed' where id = :'wa';
select tautopay.charge_of(:'j_wes') as wes1 \gset
select tautopay.check((select visit_ids = array[:'wa']::uuid[] from public.autopay_charges where id = :'wes1'), 'a charge names the visit that queued it');
select tautopay.due(:'wes1');
select tautopay.charge(:'co', :'wes1', 'declined', 'Your card was declined.', 'card_declined');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.invoices set status = 'void' where id = (select invoice_id from public.autopay_charges where id = :'wes1');
commit;
update public.visits set status = 'completed' where id = :'wb';
select tautopay.charge_of(:'j_wes') as wes2 \gset
select tautopay.due(:'wes2');
select public.autopay_bill(:'wes2', tautopay.claim_one(:'co', :'wes2')) as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'wes2') = 'needs_approval: ' || :'unqueued'
    and (select balance_due = 90 from public.invoices where id = ((:'bill'::jsonb) ->> 'invoice_id')::uuid)
    and (select count(*) from public.visits where id in (:'wa', :'wb') and invoice_id = ((:'bill'::jsonb) ->> 'invoice_id')::uuid) = 2,
  'a visit freed by voiding its invoice, billed with the next one, waits for the office''s OK, under the limit too');
select tautopay.check(tautopay.told(:'opal', 'Approve%Wes%') = 'Approve a $90.00 charge for Wes Voided | ' || :'unqueued', 'and the office is told why');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.approve_autopay_charge(:'wes2');
commit;
select tautopay.check(tautopay.charge(:'co', :'wes2', 'paid') ->> 'outcome' = 'charge' and tautopay.state(:'wes2') = 'paid', 'approved, it''s charged');

-- Paused, then back on: the visit whose charge the pause called off and the one finished while
-- paused are from before it was resumed, so they aren't charged without the office's OK.
select tautopay.ready_client(:'co', 'Pip Paused') as c_pip \gset
select tautopay.job(:'co', :'c_pip') as j_pip \gset
select tautopay.visit(:'co', :'j_pip') as pa \gset
select tautopay.visit(:'co', :'j_pip') as pb \gset
select tautopay.visit(:'co', :'j_pip') as pc \gset
update public.visits set status = 'completed' where id = :'pa';
select tautopay.charge_of(:'j_pip') as pip1 \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_pip', true);
commit;
update public.visits set status = 'completed' where id = :'pb';
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_pip', false);
commit;
update public.visits set status = 'completed' where id = :'pc';
select tautopay.charge_of(:'j_pip') as pip2 \gset
select tautopay.due(:'pip2');
select public.autopay_bill(:'pip2', tautopay.claim_one(:'co', :'pip2')) as bill \gset
select tautopay.check(tautopay.state(:'pip1') = 'called_off: Autopay is paused'
    and (select visit_ids = array[:'pc']::uuid[] from public.autopay_charges where id = :'pip2')
    and (:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'pip2') = 'needs_approval: Includes visits from before autopay started'
    and (select balance_due = 135 from public.invoices where id = ((:'bill'::jsonb) ->> 'invoice_id')::uuid),
  'after a pause, the next charge bills the visits from before and during it too, and waits for the office''s OK');

-- Off in Settings, then on again: a visit finished meanwhile waits for the office's OK.
select tautopay.ready_client(:'co', 'Seth Settings') as c_seth \gset
select tautopay.job(:'co', :'c_seth') as j_seth \gset
select tautopay.visit(:'co', :'j_seth') as sa \gset
select tautopay.visit(:'co', :'j_seth') as sb \gset
update public.visits set status = 'completed' where id = :'sa';
select tautopay.charge_of(:'j_seth') as seth \gset
begin;
set local role authenticated;
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings(p_enabled => false));
commit;
update public.visits set status = 'completed' where id = :'sb';
begin;
set local role authenticated;
select tautopay.as_user(:'ada');
select public.autopay_set_settings(:'co', tautopay.settings());
commit;
select tautopay.due(:'seth');
select public.autopay_bill(:'seth', tautopay.claim_one(:'co', :'seth')) as bill \gset
select tautopay.check((select visit_ids = array[:'sa']::uuid[] from public.autopay_charges where id = :'seth')
    and (:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'seth') = 'needs_approval: ' || :'unqueued',
  'a visit finished while autopay was off in Settings, billed with one from before, waits for the office''s OK');

-- Paused, then resumed, then a Complete tapped offline while it was paused syncs: from before autopay
-- was resumed, so it waits for the office's OK. Changing card since keeps when it was resumed.
select tautopay.ready_client(:'co', 'Ora Offpause') as c_ora \gset
select tautopay.job(:'co', :'c_ora') as j_ora \gset
select tautopay.visit(:'co', :'j_ora') as vora \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_ora', true);
commit;
select paused_at as ora_paused from public.autopay_authorizations where client_id = :'c_ora' and revoked_at is null \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_ora', false);
commit;
select tautopay.check((select paused_at is null and resumed_at > :'ora_paused' from public.autopay_authorizations where client_id = :'c_ora' and revoked_at is null),
  'resuming autopay notes when');
select public.autopay_save_payment_method(:'co', :'c_ora', '{"stripe_payment_method_id": "pm_ora_new", "stripe_customer_id": "cus_ora_offpause", "livemode": false, "type": "card", "brand": "visa", "last4": "1515", "status": "active", "make_default": false}') as ora_new \gset
select public.autopay_record_authorization(:'co', :'c_ora', :'ora_new', 'hub', :'ver');
select tautopay.check((select a.resumed_at = b.resumed_at from public.autopay_authorizations a, public.autopay_authorizations b
                       where a.client_id = :'c_ora' and a.revoked_at is null and b.client_id = :'c_ora' and b.revoked_via = 'replaced'),
  'and changing card keeps it');
select :'ora_paused'::timestamptz + (resumed_at - :'ora_paused'::timestamptz) / 2 as ora_tap from public.autopay_authorizations where client_id = :'c_ora' and revoked_at is null \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed', completed_at = :'ora_tap' where id = :'vora';
commit;
select tautopay.charge_of(:'j_ora') as ora \gset
select tautopay.due(:'ora');
select public.autopay_bill(:'ora', tautopay.claim_one(:'co', :'ora')) as bill \gset
select tautopay.check((select visit_ids = array[:'vora']::uuid[] from public.autopay_charges where id = :'ora')
    and (:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'ora') = 'needs_approval: Includes visits from before autopay started',
  'a Complete tapped offline while autopay was paused, synced after it was resumed, waits for the office''s OK');

-- Changing card while a charge waits: the client was on autopay all along, so it's charged.
select tautopay.ready_client(:'co', 'Cora Card') as c_cora \gset
select tautopay.job(:'co', :'c_cora') as j_cora \gset
select tautopay.visit(:'co', :'j_cora') as vcora \gset
update public.visits set status = 'completed' where id = :'vcora';
select public.autopay_save_payment_method(:'co', :'c_cora', '{"stripe_payment_method_id": "pm_cora_new", "stripe_customer_id": "cus_cora_card", "livemode": false, "type": "card", "brand": "visa", "last4": "5556", "status": "active", "make_default": false}') as cora_new \gset
select public.autopay_record_authorization(:'co', :'c_cora', :'cora_new', 'hub', :'ver');
select tautopay.charge_of(:'j_cora') as cora \gset
select tautopay.due(:'cora');
select tautopay.charge(:'co', :'cora', 'paid') as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'charge' and (:'bill'::jsonb) #>> '{method,id}' = :'cora_new' and tautopay.state(:'cora') = 'paid'
    and (select count(*) from public.autopay_authorizations where client_id = :'c_cora' and revoked_via = 'replaced') = 1,
  'a visit finished before the client changed card is charged to the new card without asking (a new card doesn''t restart autopay)');

-- Turned off, then agreed again with a new card: a visit finished in between is from before autopay started.
select tautopay.ready_client(:'co', 'Gil Gap') as c_gil \gset
select tautopay.job(:'co', :'c_gil') as j_gil \gset
select tautopay.visit(:'co', :'j_gil') as ga \gset
select tautopay.visit(:'co', :'j_gil') as gb \gset
select public.autopay_revoke(:'co', :'c_gil', 'office', :'opal');
update public.visits set status = 'completed' where id = :'ga';
select public.autopay_save_payment_method(:'co', :'c_gil', '{"stripe_payment_method_id": "pm_gil_new", "stripe_customer_id": "cus_gil_gap", "livemode": false, "type": "card", "brand": "visa", "last4": "5557", "status": "active", "make_default": true}') as gil_new \gset
select public.autopay_record_authorization(:'co', :'c_gil', :'gil_new', 'hub', :'ver');
update public.visits set status = 'completed' where id = :'gb';
select tautopay.charge_of(:'j_gil') as gil \gset
select tautopay.due(:'gil');
select public.autopay_bill(:'gil', tautopay.claim_one(:'co', :'gil')) as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'gil') = 'needs_approval: Includes visits from before autopay started',
  'autopay turned off breaks the run: a visit finished before it was agreed to again is from before autopay started');

-- A charge let go merges into the next one, which takes on its visits.
select tautopay.ready_client(:'co', 'Mel Merge') as c_mel \gset
select tautopay.job(:'co', :'c_mel') as j_mel \gset
select tautopay.visit(:'co', :'j_mel') as ma \gset
select tautopay.visit(:'co', :'j_mel') as mb \gset
update public.visits set status = 'completed' where id = :'ma';
select tautopay.charge_of(:'j_mel') as mel1 \gset
select tautopay.due(:'mel1');
select tautopay.claim_one(:'co', :'mel1') as tok \gset
update public.visits set status = 'completed' where id = :'mb';
select tautopay.charge_of(:'j_mel') as mel2 \gset
select public.release_autopay_charges(:'tok', array[:'mel1']::uuid[]) as released \gset
select tautopay.check(:'released'::integer = 1 and tautopay.state(:'mel1') = 'called_off: Merged into the next charge'
    and (select visit_ids @> array[:'ma', :'mb']::uuid[] and cardinality(visit_ids) = 2 from public.autopay_charges where id = :'mel2'),
  'a charge let go while another gathers the job''s visits merges into it, visits and all');
select tautopay.due(:'mel2');
select tautopay.check(tautopay.charge(:'co', :'mel2', 'paid') ->> 'outcome' = 'charge', 'so both visits are charged without asking');

-- A visit finished while the job's charge is being billed: billed with it, and counted as queued.
select tautopay.ready_client(:'co', 'Abe Absorb') as c_abe \gset
select tautopay.job(:'co', :'c_abe') as j_abe \gset
select tautopay.visit(:'co', :'j_abe') as aa \gset
select tautopay.visit(:'co', :'j_abe') as ab \gset
update public.visits set status = 'completed' where id = :'aa';
select tautopay.charge_of(:'j_abe') as abe1 \gset
select tautopay.due(:'abe1');
select tautopay.claim_one(:'co', :'abe1') as tok \gset
update public.visits set status = 'completed' where id = :'ab';
select tautopay.charge_of(:'j_abe') as abe2 \gset
select public.autopay_bill(:'abe1', :'tok') as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'charge' and ((:'bill'::jsonb) ->> 'balance_due')::numeric = 90
    and (select visit_ids @> array[:'aa', :'ab']::uuid[] from public.autopay_charges where id = :'abe1'),
  'a visit that queued another charge for the job, billed with this one, is charged without asking');
select public.finish_autopay_charge(:'abe1', 'busy', :'tok', 'Stripe''s invoice is still being made');
update public.autopay_charges set locked_until = now() - interval '1 minute' where id = :'abe1';
select tautopay.check(tautopay.charge(:'co', :'abe1', 'paid') ->> 'outcome' = 'charge' and tautopay.state(:'abe1') = 'paid',
  'and still is when it''s tried again');
select tautopay.due(:'abe2');
select tautopay.check(public.autopay_bill(:'abe2', tautopay.claim_one(:'co', :'abe2')) ->> 'outcome' = 'called_off'
    and tautopay.state(:'abe2') = 'called_off: There are no completed visits waiting to be invoiced',
  'the other charge has nothing left to bill');

-- Between tries (charging with no claim), deleting the draft calls the charge off, and its visit,
-- freed, waits for the office's OK when the next charge bills it.
select tautopay.ready_client(:'co', 'Del Deleted') as c_del \gset
select tautopay.job(:'co', :'c_del') as j_del \gset
select tautopay.visit(:'co', :'j_del') as da \gset
select tautopay.visit(:'co', :'j_del') as db \gset
update public.visits set status = 'completed' where id = :'da';
select tautopay.charge_of(:'j_del') as del \gset
select tautopay.due(:'del');
select tautopay.claim_one(:'co', :'del') as tok \gset
select public.autopay_bill(:'del', :'tok') ->> 'invoice_id' as inv_del \gset
select public.finish_autopay_charge(:'del', 'retry', :'tok', 'Stripe is down');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
delete from public.invoices where id = :'inv_del';
commit;
select tautopay.check(tautopay.state(:'del') = 'called_off: The invoice was deleted', 'deleting the draft between tries calls the charge off');
update public.visits set status = 'completed' where id = :'db';
select tautopay.charge_of(:'j_del') as del2 \gset
select tautopay.due(:'del2');
select public.autopay_bill(:'del2', tautopay.claim_one(:'co', :'del2')) as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'del2') = 'needs_approval: ' || :'unqueued',
  'and the next charge, billing the freed visit too, waits for the office''s OK');

-- Invoiced by hand while its charge waits, sent, then voided: the visit comes off the charge, so
-- the charge that bills it again waits for the office's OK.
select tautopay.ready_client(:'co', 'Hal Handvoid') as c_hal \gset
select tautopay.job(:'co', :'c_hal') as j_hal \gset
select tautopay.visit(:'co', :'j_hal') as vhal \gset
update public.visits set status = 'completed' where id = :'vhal';
select tautopay.charge_of(:'j_hal') as hal \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.create_invoice_for_job(:'j_hal', 'visits') as inv_hal \gset
update public.invoices set status = 'sent' where id = :'inv_hal';
update public.invoices set status = 'void' where id = :'inv_hal';
commit;
select tautopay.check((select status = 'waiting' and invoice_id is null and visit_ids = '{}'::uuid[] from public.autopay_charges where id = :'hal')
    and (select invoice_id is null from public.visits where id = :'vhal'),
  'a visit invoiced by hand while its charge waits, then voided, comes off the charge');
select tautopay.due(:'hal');
select public.autopay_bill(:'hal', tautopay.claim_one(:'co', :'hal')) as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'hal') = 'needs_approval: ' || :'unqueued'
    and (select invoice_id = ((:'bill'::jsonb) ->> 'invoice_id')::uuid from public.visits where id = :'vhal'),
  'so billing it again waits for the office''s OK');

-- The same for a draft invoiced by hand and deleted.
select tautopay.ready_client(:'co', 'Dot Dropdraft') as c_dot \gset
select tautopay.job(:'co', :'c_dot') as j_dot \gset
select tautopay.visit(:'co', :'j_dot') as vdot \gset
update public.visits set status = 'completed' where id = :'vdot';
select tautopay.charge_of(:'j_dot') as dot \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.create_invoice_for_job(:'j_dot', 'visits') as inv_dot \gset
delete from public.invoices where id = :'inv_dot';
commit;
select tautopay.check((select status = 'waiting' and visit_ids = '{}'::uuid[] from public.autopay_charges where id = :'dot'),
  'a visit on a draft invoiced by hand and deleted comes off the charge waiting for it');
select tautopay.due(:'dot');
select public.autopay_bill(:'dot', tautopay.claim_one(:'co', :'dot')) as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'dot') = 'needs_approval: ' || :'unqueued',
  'and billing it again waits for the office''s OK');

-- A visit another charge took on while it was billed (step 3), freed when that invoice is voided,
-- comes off the charge it queued too.
select tautopay.ready_client(:'co', 'Ty Takeon') as c_ty \gset
select tautopay.job(:'co', :'c_ty') as j_ty \gset
select tautopay.visit(:'co', :'j_ty') as ta \gset
select tautopay.visit(:'co', :'j_ty') as tb \gset
update public.visits set status = 'completed' where id = :'ta';
select tautopay.charge_of(:'j_ty') as ty1 \gset
select tautopay.due(:'ty1');
select tautopay.claim_one(:'co', :'ty1') as tok \gset
update public.visits set status = 'completed' where id = :'tb';
select tautopay.charge_of(:'j_ty') as ty2 \gset
select public.autopay_bill(:'ty1', :'tok') ->> 'invoice_id' as inv_ty \gset
select public.finish_autopay_charge(:'ty1', 'declined', :'tok', 'Your card was declined.', 'card_declined');
select tautopay.check((select visit_ids = array[:'tb']::uuid[] from public.autopay_charges where id = :'ty2')
    and (select visit_ids @> array[:'ta', :'tb']::uuid[] from public.autopay_charges where id = :'ty1'),
  'a visit billed with another charge is still on the charge it queued');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.invoices set status = 'void' where id = :'inv_ty';
commit;
select tautopay.check(tautopay.state(:'ty1') = 'called_off: The invoice was voided'
    and (select status = 'waiting' and visit_ids = '{}'::uuid[] from public.autopay_charges where id = :'ty2'),
  'voiding that invoice frees it, and it comes off the charge it queued');
select tautopay.due(:'ty2');
select public.autopay_bill(:'ty2', tautopay.claim_one(:'co', :'ty2')) as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'ty2') = 'needs_approval: ' || :'unqueued'
    and (select balance_due = 90 from public.invoices where id = ((:'bill'::jsonb) ->> 'invoice_id')::uuid),
  'so billing both again waits for the office''s OK');

-- An offline Complete keeps the time it was tapped (the field app sends it with the status): a
-- visit done before the client agreed, synced after, waits for the office's OK.
select tautopay.ready_client(:'co', 'Oz Offline') as c_oz \gset
select tautopay.job(:'co', :'c_oz') as j_oz \gset
select tautopay.visit(:'co', :'j_oz') as voz \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
update public.visits set status = 'completed', completed_at = now() - interval '1 hour' where id = :'voz';
commit;
select tautopay.charge_of(:'j_oz') as oz \gset
select tautopay.check((select v.completed_at < a.accepted_at and v.completed_at < now() - interval '50 minutes'
                       from public.visits v, public.autopay_authorizations a where v.id = :'voz' and a.client_id = :'c_oz')
    and (select visit_ids = array[:'voz']::uuid[] from public.autopay_charges where id = :'oz'),
  'a crew''s offline Complete keeps its tap time, and queues the charge when it syncs');
select tautopay.due(:'oz');
select public.autopay_bill(:'oz', tautopay.claim_one(:'co', :'oz')) as bill \gset
select tautopay.check((:'bill'::jsonb) ->> 'outcome' = 'needs_approval' and tautopay.state(:'oz') = 'needs_approval: Includes visits from before autopay started',
  'tapped before the client agreed, it waits for the office''s OK');

-- A sub's offline Complete keeps its tap time too, when it's in the last 3 days and not ahead of
-- now; otherwise it's when it synced. Anything else about when it was done stays the database's.
insert into public.clients (company_id, display_name, email) values (:'co', 'Sue Subvisits', 'sue@autopay.test') returning id as c_sue \gset
select tautopay.job(:'co', :'c_sue') as j_sue \gset
select tautopay.visit(:'co', :'j_sue') as sv1 \gset
select tautopay.visit(:'co', :'j_sue') as sv2 \gset
select tautopay.visit(:'co', :'j_sue') as sv3 \gset
select tautopay.visit(:'co', :'j_sue') as sv4 \gset
select tautopay.visit(:'co', :'j_sue') as sv5 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) select :'co', v, :'sal' from unnest(array[:'sv1', :'sv2', :'sv3', :'sv4', :'sv5']::uuid[]) v;
-- sv5 was finished yesterday, then the office reopened it.
update public.visits set status = 'completed', completed_at = now() - interval '1 day' where id = :'sv5';
update public.visits set status = 'in_progress' where id = :'sv5';
begin;
set local role authenticated;
select tautopay.as_user(:'sal');
update public.visits set status = 'completed', completed_at = now() - interval '2 hours' where id = :'sv1';
update public.visits set status = 'completed', completed_at = now() - interval '5 days' where id = :'sv2';
update public.visits set status = 'completed', completed_at = now() + interval '1 hour' where id = :'sv3';
update public.visits set status = 'in_progress', completed_at = now() - interval '1 hour' where id = :'sv4';
update public.visits set status = 'completed', completed_at = now() - interval '1 hour' where id = :'sv5';
select tautopay.check((select completed_at = now() - interval '2 hours' and completed_by = :'sal' from public.visits where id = :'sv1')
    and (select completed_at = now() and completed_by = :'sal' from public.visits where id = :'sv2')
    and (select completed_at = now() from public.visits where id = :'sv3')
    and (select completed_at is null from public.visits where id = :'sv4')
    and (select completed_at > now() - interval '25 hours' and completed_at < now() - interval '23 hours' from public.visits where id = :'sv5'),
  'a sub''s Complete keeps the tap time sent with it from the last 3 days, never one older or ahead, nor one sent without completing, nor a later one for a visit finished before');
commit;

-- Between tries after it was marked sent, moving it back to draft calls the charge off.
select tautopay.ready_client(:'co', 'Bea Backdraft') as c_bea \gset
select tautopay.job(:'co', :'c_bea') as j_bea \gset
select tautopay.visit(:'co', :'j_bea') as vbea \gset
update public.visits set status = 'completed' where id = :'vbea';
select tautopay.charge_of(:'j_bea') as bea \gset
select tautopay.due(:'bea');
select tautopay.claim_one(:'co', :'bea') as tok \gset
select public.autopay_bill(:'bea', :'tok') ->> 'invoice_id' as inv_bea \gset
select public.autopay_mark_sent(:'bea', :'tok', 4500);
select public.finish_autopay_charge(:'bea', 'retry', :'tok', 'Stripe timed out');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.invoices set status = 'draft' where id = :'inv_bea';
commit;
select tautopay.check(tautopay.state(:'bea') = 'called_off: The invoice went back to draft', 'moving the invoice back to draft between tries calls the charge off');

-- A bank payment on its way: the invoice isn't voided, moved to draft or paid another way meanwhile.
select tautopay.ready_client(:'co', 'Ike Inflight', 'us_bank_account') as c_ike \gset
select tautopay.job(:'co', :'c_ike') as j_ike \gset
select tautopay.visit(:'co', :'j_ike') as vike \gset
update public.visits set status = 'completed' where id = :'vike';
select tautopay.charge_of(:'j_ike') as ike \gset
select tautopay.due(:'ike');
select tautopay.charge(:'co', :'ike', 'processing') ->> 'invoice_id' as inv_ike \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select tautopay.check(tautopay.error_of(format('update public.invoices set status = %L where id = %L', 'void', :'inv_ike')) = '22023: A bank payment for this is on its way. Wait for it to clear, then refund it'
    and tautopay.error_of(format('update public.invoices set status = %L where id = %L', 'draft', :'inv_ike')) = '22023: A bank payment for this is on its way. Wait for it to clear, then refund it'
    and tautopay.error_of(format('insert into public.payments (company_id, client_id, invoice_id, amount, method) values (%L, %L, %L, 45, %L)', :'co', :'c_ike', :'inv_ike', 'check'))
      = '22023: A bank payment for this invoice is on its way. Record a payment once it clears or bounces',
  'while a bank payment is on its way, the office can''t void the invoice, move it to draft or record another payment on it');
select tautopay.check(tautopay.error_of(format('update public.invoices set notes = %L where id = %L', 'Paid by bank', :'inv_ike')) = 'none', 'a note is fine');
commit;
-- The webhook marks autopay's Stripe invoice paid, then books Stripe's payment for it (the server,
-- recorded by no one), as settleOwnInvoice does.
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_ike', 'in_auto_ike', 'crewtavo', 'processing', 45, 'charge_automatically', 'invoice');
update public.stripe_invoices set status = 'paid' where stripe_id = 'in_auto_ike';
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_ike', :'inv_ike', 45, 'ach', 'stripe', 'pi_auto_ike');
select tautopay.check(tautopay.state(:'ike') = 'paid' and (select status from public.invoices where id = :'inv_ike') = 'paid'
    and (select count(*) from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'ike') = 1,
  'Stripe''s payment arriving makes the invoice paid, and the bank payment with it, with one receipt');
-- Paid by the server some other way: part on the Pay link's Stripe invoice, the rest marked paid in
-- Stripe. Neither is autopay's own, so the bank payment is still on its way.
select tautopay.ready_client(:'co', 'Kit Keepgoing', 'us_bank_account') as c_kit \gset
select tautopay.job(:'co', :'c_kit') as j_kit \gset
select tautopay.visit(:'co', :'j_kit') as vkit \gset
update public.visits set status = 'completed' where id = :'vkit';
select tautopay.charge_of(:'j_kit') as kit \gset
select tautopay.due(:'kit');
select tautopay.charge(:'co', :'kit', 'processing') ->> 'invoice_id' as inv_kit \gset
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_kit', 'in_auto_kit', 'crewtavo', 'processing', 45, 'charge_automatically', 'invoice');
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_kit', :'inv_kit', 20, 'card', 'stripe', 'pi_paylink_kit');
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor_ref, notes) values (:'co', :'c_kit', :'inv_kit', 25, 'other', 'in_paylink_kit:paid', 'Marked paid in Stripe');
select tautopay.check((select status from public.invoices where id = :'inv_kit') = 'paid' and tautopay.state(:'kit') = 'processing'
    and not exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'kit'),
  'an invoice paid through Stripe but not by autopay''s own Stripe invoice leaves the bank payment on its way, with no receipt');
-- In a Stripe account Crewtavo has since left (its Stripe invoice detached), Crewtavo won't hear how
-- it ends: the office was told to check it there and record it here once it clears.
select tautopay.ready_client(:'co', 'Lea Left', 'us_bank_account') as c_lea \gset
select tautopay.job(:'co', :'c_lea') as j_lea \gset
select tautopay.visit(:'co', :'j_lea') as vlea \gset
update public.visits set status = 'completed' where id = :'vlea';
select tautopay.charge_of(:'j_lea') as lea \gset
select tautopay.due(:'lea');
select tautopay.charge(:'co', :'lea', 'processing') ->> 'invoice_id' as inv_lea \gset
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose, detached_at)
  values (:'co', :'inv_lea', 'in_auto_lea', 'crewtavo', 'processing', 45, 'charge_automatically', 'invoice', now());
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select tautopay.check(tautopay.error_of(format('update public.invoices set status = %L where id = %L', 'void', :'inv_lea')) = 'none',
  'once the Stripe account its bank payment is in was left, the office can void the invoice');
rollback;
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select tautopay.check(tautopay.error_of(format('insert into public.payments (company_id, client_id, invoice_id, amount, method) values (%L, %L, %L, 45, %L)', :'co', :'c_lea', :'inv_lea', 'ach')) = 'none',
  'or record the bank payment once it clears there');
commit;
select tautopay.check((select status from public.invoices where id = :'inv_lea') = 'paid' and tautopay.state(:'lea') = 'processing'
    and not exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'lea'),
  'which isn''t taken for autopay''s own, with no receipt');
-- Paid some other way (a payment booked before this rule, by the server): the bank payment is left
-- for the webhook, and a bounce after it is still heard.
select tautopay.ready_client(:'co', 'Jo Joint', 'us_bank_account') as c_jo \gset
select tautopay.job(:'co', :'c_jo') as j_jo \gset
select tautopay.visit(:'co', :'j_jo') as vjo \gset
update public.visits set status = 'completed' where id = :'vjo';
select tautopay.charge_of(:'j_jo') as jo \gset
select tautopay.due(:'jo');
select tautopay.charge(:'co', :'jo', 'processing') ->> 'invoice_id' as inv_jo \gset
insert into public.payments (company_id, client_id, invoice_id, amount, method, recorded_by) values (:'co', :'c_jo', :'inv_jo', 45, 'check', :'opal');
select tautopay.check((select status from public.invoices where id = :'inv_jo') = 'paid' and tautopay.state(:'jo') = 'processing'
    and not exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'jo'),
  'an invoice paid by check while the bank payment is on its way leaves the charge on its way, with no receipt');
select tautopay.check(public.finish_autopay_charge(:'jo', 'bank_failed', p_company => :'co', p_decline => 'R01'), 'the webhook can still say it bounced');
select tautopay.check(tautopay.state(:'jo') like 'needs_client:%' and (select status from public.client_payment_methods where client_id = :'c_jo') = 'needs_update',
  'so the bank account is marked to update and never charged again');

-- Declined, then the client pays autopay's own Stripe invoice by bank on Stripe's page: the card
-- isn't tried again while that's on its way, and once it clears the charge is paid, with no receipt.
select tautopay.ready_client(:'co', 'Bo Bankpay') as c_bo \gset
select tautopay.job(:'co', :'c_bo') as j_bo \gset
select tautopay.visit(:'co', :'j_bo') as vbo \gset
update public.visits set status = 'completed' where id = :'vbo';
select tautopay.charge_of(:'j_bo') as bo \gset
select tautopay.due(:'bo');
select tautopay.charge(:'co', :'bo', 'declined', 'Your card was declined.', 'card_declined') ->> 'invoice_id' as inv_bo \gset
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_bo', 'in_auto_bo', 'crewtavo', 'processing', 45, 'charge_automatically', 'invoice');
select tautopay.due(:'bo');
select tautopay.check(tautopay.claim_one(:'co', :'bo') is null and tautopay.state(:'bo') like 'failed: %',
  'a failed charge isn''t tried again while a bank payment for its invoice is on its way in Stripe');
update public.stripe_invoices set status = 'open' where stripe_id = 'in_auto_bo';
select tautopay.claim_one(:'co', :'bo') as tok \gset
select tautopay.check(:'tok' <> '' and public.release_autopay_charges(:'tok', array[:'bo']::uuid[]) = 1 and tautopay.state(:'bo') like 'failed: %',
  'once it bounces (its Stripe invoice open again), the card is tried as usual');
update public.stripe_invoices set status = 'processing' where stripe_id = 'in_auto_bo';
update public.stripe_invoices set status = 'paid' where stripe_id = 'in_auto_bo';
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_bo', :'inv_bo', 45, 'ach', 'stripe', 'pi_hosted_bo');
select tautopay.check(tautopay.state(:'bo') = 'paid' and (select status from public.invoices where id = :'inv_bo') = 'paid'
    and not exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'bo'),
  'when the client''s bank payment clears, the charge is paid, with no receipt');
-- Between tries after a busy Stripe (that bank payment on its way), it clearing makes the charge
-- paid with no receipt; between tries after a retry (autopay's own try went through), with one.
select tautopay.ready_client(:'co', 'Bix Busygap') as c_bix \gset
select tautopay.job(:'co', :'c_bix') as j_bix \gset
select tautopay.visit(:'co', :'j_bix') as vbix \gset
update public.visits set status = 'completed' where id = :'vbix';
select tautopay.charge_of(:'j_bix') as bix \gset
select tautopay.due(:'bix');
select tautopay.claim_one(:'co', :'bix') as tok \gset
select public.autopay_bill(:'bix', :'tok') ->> 'invoice_id' as inv_bix \gset
select public.autopay_mark_sent(:'bix', :'tok', 4500);
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_bix', 'in_auto_bix', 'crewtavo', 'processing', 45, 'charge_automatically', 'invoice');
select public.finish_autopay_charge(:'bix', 'busy', :'tok', 'A payment for this is on its way');
update public.stripe_invoices set status = 'paid' where stripe_id = 'in_auto_bix';
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_bix', :'inv_bix', 45, 'ach', 'stripe', 'pi_hosted_bix');
select tautopay.check(tautopay.state(:'bix') = 'paid' and (select claim_token is null and locked_until is null and busy_since is null from public.autopay_charges where id = :'bix')
    and not exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'bix'),
  'a charge waiting out a busy Stripe is paid when the client''s bank payment clears, with no receipt');
select tautopay.ready_client(:'co', 'Rex Retrygap') as c_rex \gset
select tautopay.job(:'co', :'c_rex') as j_rex \gset
select tautopay.visit(:'co', :'j_rex') as vrex \gset
update public.visits set status = 'completed' where id = :'vrex';
select tautopay.charge_of(:'j_rex') as rex \gset
select tautopay.due(:'rex');
select tautopay.claim_one(:'co', :'rex') as tok \gset
select public.autopay_bill(:'rex', :'tok') ->> 'invoice_id' as inv_rex \gset
select public.autopay_mark_sent(:'rex', :'tok', 4500);
select public.finish_autopay_charge(:'rex', 'retry', :'tok', 'Stripe timed out');
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_rex', 'in_auto_rex', 'crewtavo', 'paid', 45, 'charge_automatically', 'invoice');
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_rex', :'inv_rex', 45, 'card', 'stripe', 'pi_auto_rex');
select tautopay.check(tautopay.state(:'rex') = 'paid'
    and (select count(*) from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'rex') = 1,
  'and one waiting out a retry is paid when its own charge turns out to have gone through, with one receipt');
-- Its own bank payment on its way after a retry lost Stripe's answer: claimed again, the task says
-- it's on its way (not busy), so the invoice is guarded while it clears, with one receipt.
select tautopay.ready_client(:'co', 'Pru Processing', 'us_bank_account') as c_pru \gset
select tautopay.job(:'co', :'c_pru') as j_pru \gset
select tautopay.visit(:'co', :'j_pru') as vpru \gset
update public.visits set status = 'completed' where id = :'vpru';
select tautopay.charge_of(:'j_pru') as pru \gset
select tautopay.due(:'pru');
select tautopay.claim_one(:'co', :'pru') as tok \gset
select public.autopay_bill(:'pru', :'tok') ->> 'invoice_id' as inv_pru \gset
select public.autopay_mark_sent(:'pru', :'tok', 4500);
select public.finish_autopay_charge(:'pru', 'retry', :'tok', 'Stripe timed out');
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_pru', 'in_auto_pru', 'crewtavo', 'processing', 45, 'charge_automatically', 'invoice');
update public.autopay_charges set locked_until = now() - interval '1 minute' where id = :'pru';
select tautopay.claim_one(:'co', :'pru') as tok \gset
select public.autopay_bill(:'pru', :'tok') ->> 'outcome' as pru_bill \gset
select public.finish_autopay_charge(:'pru', 'processing', :'tok', null, null, 45);
select tautopay.check(:'pru_bill' = 'charge' and (select status = 'processing' and charged_amount = 45 from public.autopay_charges where id = :'pru')
    and private.autopay_clearing(:'inv_pru'),
  'claimed again while its own bank payment is on its way, it''s on its way, and the invoice is guarded');
update public.stripe_invoices set status = 'paid' where stripe_id = 'in_auto_pru';
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pru', :'inv_pru', 45, 'ach', 'stripe', 'pi_auto_pru');
select tautopay.check(tautopay.state(:'pru') = 'paid'
    and (select count(*) from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'pru') = 1,
  'and once it clears it''s paid, with one receipt');

-- Which kind of Hub link a card was saved through.
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_office", "stripe_customer_id": "cus_sam", "livemode": false, "type": "card", "brand": "visa", "last4": "0003", "status": "active", "saved_via": "office"}') as sam_office \gset
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_client", "stripe_customer_id": "cus_sam", "livemode": false, "type": "card", "brand": "visa", "last4": "0004", "status": "active"}') as sam_client \gset
select tautopay.check((select saved_via from public.client_payment_methods where id = :'sam_office') = 'office'
    and (select saved_via from public.client_payment_methods where id = :'sam_client') = 'client',
  'a card keeps the kind of Hub link it was saved through: the office''s, or the client''s when not said');
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_office", "stripe_customer_id": "cus_sam", "livemode": false, "type": "card", "status": "active", "source": "stripe_import"}');
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_client", "stripe_customer_id": "cus_sam", "livemode": false, "type": "card", "status": "active", "saved_via": "office"}');
select tautopay.check((select saved_via from public.client_payment_methods where id = :'sam_office') = 'office'
    and (select saved_via from public.client_payment_methods where id = :'sam_client') = 'office',
  'saved again, it changes only when that''s said (a card brought in from Stripe later doesn''t undo it)');
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_legacy", "stripe_customer_id": "cus_sam", "livemode": false, "type": "card", "brand": "visa", "last4": "0006", "status": "active", "saved_via": "legacy"}') as sam_legacy \gset
select tautopay.check((select saved_via from public.client_payment_methods where id = :'sam_legacy') = 'legacy',
  'or one made before links were marked as the client''s own');
select tautopay.check(tautopay.error_of(format('select public.autopay_save_payment_method(%L, %L, %L)', :'co', :'c_sam',
    '{"stripe_payment_method_id": "pm_sam_odd", "stripe_customer_id": "cus_sam", "livemode": false, "type": "card", "saved_via": "crew"}')) = '22023: Say which link the card was saved through',
  'and it''s the client''s, the office''s or an unmarked one''s');

-- ===== Jobs ====================================================================================

begin;
set local role authenticated;
select tautopay.as_user(:'eve');
insert into public.jobs (company_id, client_id, title, autopay) values (:'co', :'c_sam', 'Mulch', true) returning id as j_eve \gset
select tautopay.check(tautopay.error_of(format('update public.jobs set autopay = false where id = %L', :'j_edit')) like '42501:%'
    and tautopay.error_of(format('update public.jobs set autopay = false where id = %L', :'j_pat')) = '42501: Only the office with the invoices area can turn autopay on or off for a job',
  'an estimator can''t turn a job''s autopay on or off');
select tautopay.as_user(:'otto');
select tautopay.check(tautopay.error_of(format('update public.jobs set autopay = false where id = %L', :'j_pat')) like '42501:%', 'nor can the office without the invoices area');
select tautopay.as_user(:'opal');
select tautopay.check(tautopay.error_of(format('update public.jobs set autopay = true where id = %L', :'j_fixed')) = '22023: Autopay works with recurring jobs billed per visit, or one-off jobs billed when the work is done',
  'a job autopay doesn''t charge can''t be put on it');
commit;
select tautopay.check((select not autopay from public.jobs where id = :'j_eve'), 'an estimator making a job can''t choose autopay for it');
select tautopay.check((select bool_and(autopay) from public.jobs where id in (:'j_edit', :'j_pat')), 'the jobs are as they were');

-- ===== Agreements ==============================================================================

select tautopay.check(tautopay.error_of(format('update public.autopay_authorizations set terms = %L where id = %L', 'Something else', :'auth_pat')) = '42501: An agreement is kept as it was made. It can only be paused or turned off'
    and tautopay.error_of(format('update public.autopay_authorizations set ip = %L where id = %L', '10.0.0.1', :'auth_pat')) like '42501:%'
    and tautopay.error_of(format('update public.autopay_authorizations set accepted_at = now() - interval ''1 year'' where id = %L', :'auth_pat')) like '42501:%',
  'an agreement''s words, IP and date are kept as they were, even by the server');
select id as auth_val from public.autopay_authorizations where client_id = :'c_val' \gset
select tautopay.check(tautopay.error_of(format('update public.autopay_authorizations set revoked_at = null, revoked_via = null where id = %L', :'auth_val')) = '22023: An agreement that was turned off stays off',
  'one turned off stays off');

-- Changing card: the new agreement replaces the old, and what was waiting goes to the new card.
select tautopay.ready_client(:'co', 'Rae Replace') as c_rae \gset
select tautopay.card(:'c_rae') as rae_old \gset
select id as auth_rae from public.autopay_authorizations where client_id = :'c_rae' \gset
select tautopay.job(:'co', :'c_rae') as j_rae \gset
select tautopay.visit(:'co', :'j_rae') as vrae \gset
update public.visits set status = 'completed' where id = :'vrae';
select public.autopay_save_payment_method(:'co', :'c_rae', '{"stripe_payment_method_id": "pm_rae_new", "stripe_customer_id": "cus_rae_replace", "livemode": false, "type": "card", "brand": "amex", "last4": "0005", "status": "active", "make_default": false}') as rae_new \gset
select tautopay.check((select is_default from public.client_payment_methods where id = :'rae_old'), 'a card saved while the client has an agreement for another isn''t made the default');
select public.autopay_record_authorization(:'co', :'c_rae', :'rae_new', 'hub', :'ver', null, null, 'client', 'office') as auth_rae2 \gset
select tautopay.check((select revoked_via = 'replaced' and revoked_at is not null from public.autopay_authorizations where id = :'auth_rae')
    and (select revoked_at is null and payment_method_id = :'rae_new' and link_via = 'office' from public.autopay_authorizations where id = :'auth_rae2')
    and (select is_default from public.client_payment_methods where id = :'rae_new') and not (select is_default from public.client_payment_methods where id = :'rae_old'),
  'agreeing with a new card replaces the old agreement and makes the new card the default');
select tautopay.check(tautopay.state(tautopay.charge_of(:'j_rae')) = 'waiting' and private.autopay_ready(:'co', :'c_rae') = :'rae_new',
  'and the charge waiting goes to the new card, not called off');

-- Only a client's first agreement in a run switches their jobs on (lawn): changing card leaves a
-- job the office took off autopay off.
insert into public.clients (company_id, display_name, email) values (:'co', 'Jay Twojobs', 'jay@autopay.test') returning id as c_jay \gset
select tautopay.job(:'co', :'c_jay') as j_jay1 \gset
select tautopay.job(:'co', :'c_jay') as j_jay2 \gset
select public.autopay_save_payment_method(:'co', :'c_jay', '{"stripe_payment_method_id": "pm_jay", "stripe_customer_id": "cus_jay", "livemode": false, "type": "card", "brand": "visa", "last4": "1111", "status": "active", "make_default": true}') as jay_card \gset
select tautopay.check((select bool_and(not autopay) from public.jobs where id in (:'j_jay1', :'j_jay2')), 'a client''s jobs made before they agree aren''t on autopay');
select public.autopay_record_authorization(:'co', :'c_jay', :'jay_card', 'hub', :'ver');
select tautopay.check((select bool_and(autopay) from public.jobs where id in (:'j_jay1', :'j_jay2')), 'agreeing switches them on');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
update public.jobs set autopay = false where id = :'j_jay2';
commit;
select public.autopay_save_payment_method(:'co', :'c_jay', '{"stripe_payment_method_id": "pm_jay_new", "stripe_customer_id": "cus_jay", "livemode": false, "type": "card", "brand": "visa", "last4": "2222", "status": "active", "make_default": false}') as jay_new \gset
select public.autopay_record_authorization(:'co', :'c_jay', :'jay_new', 'hub', :'ver');
select tautopay.check(private.autopay_ready(:'co', :'c_jay') = :'jay_new'
    and (select autopay from public.jobs where id = :'j_jay1') and (select not autopay from public.jobs where id = :'j_jay2'),
  'changing card leaves a job the office took off autopay off');
select tautopay.visit(:'co', :'j_jay2') as vjay \gset
update public.visits set status = 'completed' where id = :'vjay';
select tautopay.check(not exists (select 1 from public.autopay_charges where job_id = :'j_jay2'), 'so its next visit queues nothing');
select public.autopay_revoke(:'co', :'c_jay', 'client');
select public.autopay_save_payment_method(:'co', :'c_jay', '{"stripe_payment_method_id": "pm_jay_third", "stripe_customer_id": "cus_jay", "livemode": false, "type": "card", "brand": "visa", "last4": "3333", "status": "active", "make_default": true}') as jay_third \gset
select public.autopay_record_authorization(:'co', :'c_jay', :'jay_third', 'hub', :'ver');
select tautopay.check((select bool_and(autopay) from public.jobs where id in (:'j_jay1', :'j_jay2')),
  'agreeing again after turning autopay off starts a new run, which switches the jobs on');

-- Changing card while the office has autopay paused: the new agreement is paused too, until the
-- office resumes it.
select tautopay.ready_client(:'co', 'Pam Pausecard') as c_pam \gset
select tautopay.job(:'co', :'c_pam') as j_pam \gset
select tautopay.visit(:'co', :'j_pam') as vpam \gset
select id as auth_pam from public.autopay_authorizations where client_id = :'c_pam' \gset
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_pam', true);
commit;
select public.autopay_save_payment_method(:'co', :'c_pam', '{"stripe_payment_method_id": "pm_pam_new", "stripe_customer_id": "cus_pam_pausecard", "livemode": false, "type": "card", "brand": "visa", "last4": "4444", "status": "active", "make_default": false}') as pam_new \gset
select public.autopay_record_authorization(:'co', :'c_pam', :'pam_new', 'hub', :'ver') as auth_pam2 \gset
select tautopay.check((select revoked_via = 'replaced' from public.autopay_authorizations where id = :'auth_pam')
    and (select a.payment_method_id = :'pam_new' and a.revoked_at is null and a.paused_by = :'opal' and a.paused_at = (select b.paused_at from public.autopay_authorizations b where b.id = :'auth_pam')
         from public.autopay_authorizations a where a.id = :'auth_pam2')
    and private.autopay_ready(:'co', :'c_pam') is null,
  'changing card while the office has autopay paused keeps it paused, on the new agreement');
update public.visits set status = 'completed' where id = :'vpam';
select tautopay.check(not exists (select 1 from public.autopay_charges where job_id = :'j_pam'), 'so a visit finished meanwhile queues nothing');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.autopay_pause(:'c_pam', false);
commit;
select tautopay.check(private.autopay_ready(:'co', :'c_pam') = :'pam_new', 'resumed by the office, it charges the new card');

-- Turned off by the client: an old link can't switch it back on with the card on file.
select tautopay.ready_client(:'co', 'Tia Turnoff') as c_tia \gset
select tautopay.card(:'c_tia') as tia_card \gset
select public.autopay_revoke(:'co', :'c_tia', 'client');
select tautopay.check(tautopay.error_of(format('select public.autopay_record_authorization(%L, %L, %L, %L, %L)', :'co', :'c_tia', :'tia_card', 'hub', :'ver')) = '22023: Add your card again to turn autopay back on',
  'after the client turned autopay off, the card on file can''t be agreed to again');
select public.autopay_save_payment_method(:'co', :'c_tia', '{"stripe_payment_method_id": "pm_tia_new", "stripe_customer_id": "cus_tia_turnoff", "livemode": false, "type": "card", "brand": "visa", "last4": "1881", "status": "active", "make_default": true}') as tia_new \gset
select tautopay.error_of(format('select public.autopay_record_authorization(%L, %L, %L, %L, %L)', :'co', :'c_tia', :'tia_new', 'hub', :'ver')) as recorded \gset
select tautopay.check(:'recorded' = 'none' and private.autopay_ready(:'co', :'c_tia') = :'tia_new',
  'but a card saved since can');
select tautopay.ready_client(:'co', 'Oda Officeoff') as c_oda \gset
select public.autopay_revoke(:'co', :'c_oda', 'office', :'opal');
select tautopay.check(tautopay.error_of(format('select public.autopay_record_authorization(%L, %L, %L, %L, %L)', :'co', :'c_oda', tautopay.card(:'c_oda'), 'hub', :'ver')) like '22023: Add your card again%',
  'and the same after the office turned it off');

-- A removed card never comes back.
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_gone", "stripe_customer_id": "cus_sam", "livemode": false, "type": "card", "brand": "visa", "last4": "0002", "status": "active"}') as sam_gone \gset
update public.client_payment_methods set status = 'removed', removed_reason = 'checks' where id = :'sam_gone';
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_gone", "stripe_customer_id": "cus_sam", "livemode": false, "type": "card", "status": "active", "make_default": true}') as sam_again \gset
select tautopay.check(:'sam_again' = :'sam_gone'
    and (select status = 'removed' and not is_default from public.client_payment_methods where id = :'sam_gone'),
  'saving a removed card again (a late webhook, a replayed setup) leaves it removed');
-- A bank account being verified, then verified.
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_bank", "stripe_customer_id": "cus_sam", "livemode": false, "type": "us_bank_account", "bank_name": "Chase", "last4": "6789", "status": "pending"}') as sam_bank \gset
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_bank", "stripe_customer_id": "cus_sam", "livemode": false, "type": "us_bank_account", "status": "active"}');
select public.autopay_save_payment_method(:'co', :'c_sam', '{"stripe_payment_method_id": "pm_sam_bank", "stripe_customer_id": "cus_sam", "livemode": false, "type": "us_bank_account", "status": "pending"}');
select tautopay.check((select status = 'active' and bank_name = 'Chase' from public.client_payment_methods where id = :'sam_bank'),
  'a bank account waiting on microdeposits becomes active once verified, and a late "pending" doesn''t undo it');

-- The owner vouches for clients who agreed some other way.
insert into public.clients (company_id, display_name, email) values (:'co', 'Kim Imported', 'kim@autopay.test') returning id as c_kim \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Hank Hub', 'hank@autopay.test') returning id as c_hank \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Olga Optout', 'olga@autopay.test') returning id as c_olga \gset
select public.autopay_save_payment_method(:'co', :'c_kim', '{"stripe_payment_method_id": "pm_kim", "stripe_customer_id": "cus_kim", "livemode": false, "type": "card", "brand": "visa", "last4": "4000", "status": "active", "source": "stripe_import", "make_default": true}') as pm_kim \gset
select public.autopay_save_payment_method(:'co', :'c_hank', '{"stripe_payment_method_id": "pm_hank", "stripe_customer_id": "cus_hank", "livemode": false, "type": "card", "brand": "visa", "last4": "4001", "status": "active", "source": "hub", "make_default": true}');
select public.autopay_save_payment_method(:'co', :'c_olga', '{"stripe_payment_method_id": "pm_olga", "stripe_customer_id": "cus_olga", "livemode": false, "type": "card", "brand": "visa", "last4": "4002", "status": "active", "source": "stripe_import", "make_default": true}') as pm_olga \gset
select public.autopay_record_authorization(:'co', :'c_olga', :'pm_olga', 'confirmed', :'ver', null, null, 'client', 'client');
select public.autopay_revoke(:'co', :'c_olga', 'client');
select public.autopay_save_payment_method(:'other', :'c_other', '{"stripe_payment_method_id": "pm_owen", "stripe_customer_id": "cus_owen", "livemode": false, "type": "card", "brand": "visa", "last4": "4003", "status": "active", "source": "stripe_import", "make_default": true}');
begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select tautopay.check(tautopay.error_of(format('select public.autopay_vouch(%L, %L, %L)', :'co', array[:'c_kim']::uuid[], :'ver')) = '42501: Only owners can record that clients agreed',
  'only owners record that clients agreed');
select tautopay.as_user(:'olive');
select tautopay.check(tautopay.error_of(format('select public.autopay_vouch(%L, %L, %L)', :'co', array[:'c_kim']::uuid[], 'v-old')) = '22023: The terms changed. Read them again and agree',
  'with today''s terms');
select public.autopay_vouch(:'co', array[:'c_kim', :'c_hank', :'c_olga', :'c_other']::uuid[], :'ver') as vouched \gset
commit;
select tautopay.check(:'vouched' = '1' and (select source = 'owner' and recorded_by = :'olive' and recorded_by_name = 'Olive Owner' and recorded_by_email = 'olive@autopay.test'
      and payment_method_id = :'pm_kim' and terms = private.autopay_terms_shown(:'co') and link_kind is null from public.autopay_authorizations where client_id = :'c_kim' and revoked_at is null)
    and not exists (select 1 from public.autopay_authorizations where client_id in (:'c_hank', :'c_other') or (client_id = :'c_olga' and revoked_at is null)),
  'the owner''s tick records an agreement in their name for a card brought in from Stripe, skipping one saved on the client page, one who turned autopay off, and another business''s client');
select tautopay.check(not exists (select 1 from public.activity where verb = 'autopay.enabled' and subject_id = :'c_kim')
    and not exists (select 1 from public.outbox o join public.autopay_authorizations a on a.id::text = o.payload ->> 'authorization_id' where a.client_id = :'c_kim'),
  'and sets off no autopay.enabled rule or copy for each client at once');

-- ===== The field app, expiring cards, Home =====================================================

select tautopay.visit(:'co', :'j_sam') as v_sam2 \gset
-- One of Pat's visits Cy isn't on.
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'j_pat', 'Mow', private.company_today(:'co') + 7) returning id as v_pat_later \gset
begin;
set local role authenticated;
select tautopay.as_user(:'cy');
select tautopay.check(public.visit_autopay(:'v1') and not public.visit_autopay(:'v_sam2') and not public.visit_autopay(:'vdee'),
  'the field app hears "Autopay" for a visit of a client on autopay, not for one who isn''t (or whose card needs updating)');
select tautopay.check(not public.visit_autopay(:'v_pat_later'), 'nor for a visit they aren''t on (they can''t see it)');
select tautopay.as_user(:'sal');
select tautopay.check(not public.visit_autopay(:'v1'), 'and a sub hears nothing about it');
commit;

select tautopay.ready_client(:'co', 'Exa Expiring') as c_exa \gset
update public.client_payment_methods
set exp_month = extract(month from date_trunc('month', private.company_today(:'co')) + interval '1 month'),
    exp_year = extract(year from date_trunc('month', private.company_today(:'co')) + interval '1 month')
where client_id = :'c_exa';
select public.emit_card_expiry_alerts() as alerts \gset
select tautopay.check(:'alerts'::integer >= 1 and (select count(*) from public.activity where verb = 'payment_method.expiring' and subject_id = :'c_exa') = 1
    and (select summary = 'Exa Expiring''s Visa ending 4242 expires next month' and data ->> 'card' = 'Visa ending 4242'
         and data ->> 'expires' = (select lpad(exp_month::text, 2, '0') || '/' || right(exp_year::text, 2) from public.client_payment_methods where client_id = :'c_exa')
         from public.activity where verb = 'payment_method.expiring' and subject_id = :'c_exa'),
  'a card on autopay that expires next month sets off one payment_method.expiring, with the card and when');
select public.emit_card_expiry_alerts();
select tautopay.check((select count(*) from public.activity where verb = 'payment_method.expiring' and subject_id = :'c_exa') = 1, 'once per expiry');

-- Declined, then the client pays by bank on Stripe's page: not a failed charge on Home while it clears.
select tautopay.failed_charge(:'co', 'Lia Laterbank') as lia \gset
select invoice_id as inv_lia from public.autopay_charges where id = :'lia' \gset
insert into public.stripe_invoices (company_id, invoice_id, stripe_id, origin, status, amount_due, collection, purpose)
  values (:'co', :'inv_lia', 'in_auto_lia', 'crewtavo', 'processing', 45, 'charge_automatically', 'invoice');

begin;
set local role authenticated;
select tautopay.as_user(:'opal');
select public.dashboard(:'co') as home \gset
select tautopay.as_user(:'eve');
select public.dashboard(:'co') as eve_home \gset
select tautopay.as_user(:'cy');
select public.dashboard(:'co') as cy_home \gset
commit;
select tautopay.check(((:'home'::jsonb) #>> '{workflow,invoices,autopay_failed}')::integer = (select count(*) from public.autopay_charges where company_id = :'co' and status in ('failed', 'needs_client')) - 1
    and ((:'home'::jsonb) #>> '{workflow,invoices,autopay_failed}')::integer > 0
    and not exists (select 1 from jsonb_array_elements((:'home'::jsonb) -> 'attention') e where e ->> 'link' = '/invoices/' || :'inv_lia')
    and ((:'home'::jsonb) #>> '{workflow,invoices,autopay_approval}')::integer = (select count(*) from public.autopay_charges where company_id = :'co' and status = 'needs_approval')
    and ((:'home'::jsonb) #>> '{workflow,invoices,autopay_failed_value}')::numeric > 0
    and (:'home'::jsonb) #>> '{attention,0,kind}' = 'autopay_failed'
    and exists (select 1 from jsonb_array_elements((:'home'::jsonb) -> 'attention') e where e ->> 'kind' = 'autopay_approval' and e ->> 'title' like 'Charge needs your OK: Invoice #%'),
  'Home shows the office failed charges (not one whose invoice a bank payment is clearing) and ones waiting for its OK, first among what needs attention');
select tautopay.check(not exists (select 1 from public.autopay_charges where company_id = :'co' and status = 'needs_approval' and last_error is null)
    and exists (select 1 from jsonb_array_elements((:'home'::jsonb) -> 'attention') e
                where e ->> 'kind' = 'autopay_approval' and e ->> 'detail' in ('Includes visits from before autopay started', :'unqueued'))
    and not exists (select 1 from jsonb_array_elements((:'home'::jsonb) -> 'attention') e
                    where e ->> 'kind' = 'autopay_approval' and e ->> 'detail' like '%over your autopay limit'),
  'a charge waiting for the office''s OK for its visits says so on Home, not that it''s over the limit');
select tautopay.check(((:'eve_home'::jsonb) #>> '{workflow,invoices,autopay_failed}')::integer = 0 and ((:'cy_home'::jsonb) #>> '{workflow,invoices,autopay_approval}')::integer = 0
    and not exists (select 1 from jsonb_array_elements((:'eve_home'::jsonb) -> 'attention') e where e ->> 'kind' like 'autopay%')
    and not exists (select 1 from jsonb_array_elements((:'cy_home'::jsonb) -> 'attention') e where e ->> 'kind' like 'autopay%'),
  'and none of it to estimators or crews');

-- Lawn companies' estimate templates with the old starter terms get the lawn ones.
insert into public.document_templates (company_id, name, settings) values
  (:'co', 'Old starter', jsonb_build_object('terms', E'Payment: a deposit to get on the schedule, and the rest when the work is done.\nChanges: anything not listed here is extra, and only with your OK.\nWarranty: we stand behind our workmanship, plus the manufacturer''s warranty on materials.')),
  (:'co', 'Our own', '{"terms": "Pay when we''re done."}'),
  (:'other', 'Paving starter', jsonb_build_object('terms', E'Payment: a deposit to get on the schedule, and the rest when the work is done.\nChanges: anything not listed here is extra, and only with your OK.\nWarranty: we stand behind our workmanship, plus the manufacturer''s warranty on materials.'));
select private.autopay_lawn_terms();
select tautopay.check((select settings ->> 'terms' from public.document_templates where company_id = :'co' and name = 'Old starter') like 'Payment: due after each visit, or charged to your card on file if you''re on autopay.%'
    and (select settings ->> 'terms' from public.document_templates where company_id = :'co' and name = 'Our own') = 'Pay when we''re done.'
    and (select settings ->> 'terms' from public.document_templates where company_id = :'other') like 'Payment: a deposit%',
  'a lawn company''s template with the old starter terms gets the lawn starter; its own words and other trades'' are left');

-- ===== Leaving the Stripe account =============================================================

select count(distinct a.client_id) as on_autopay from public.autopay_authorizations a
where a.company_id = :'co' and a.revoked_at is null
  and exists (select 1 from public.client_payment_methods m where m.client_id = a.client_id and m.status <> 'removed' and not m.livemode) \gset
select public.autopay_account_left(:'co', false, 'acct_lawns') as left_count \gset
select tautopay.check(:'left_count'::integer = :'on_autopay'::integer and :'left_count'::integer > 0
    and not exists (select 1 from public.client_payment_methods where company_id = :'co' and status <> 'removed')
    and (select bool_and(removed_reason = 'account' and not is_default) from public.client_payment_methods where company_id = :'co' and removed_at is not null)
    and not exists (select 1 from public.autopay_authorizations where company_id = :'co' and revoked_at is null)
    and (select count(*) from public.autopay_authorizations where company_id = :'co' and revoked_via = 'account') = :'left_count'::integer,
  'leaving the Stripe account removes its cards and ends the agreements on them');
select tautopay.check(tautopay.told(:'opal', 'Autopay needs setting up again%') like format('Autopay needs setting up again for %s clients | Their saved cards were in the Stripe account you switched from: %%', :'left_count')
    and (select count(*) from public.notifications where user_id = :'opal' and title like 'Autopay needs setting up again%') = 1 and tautopay.told(:'otto') is null,
  'and the office is told once who needs to set it up again');
select tautopay.check(exists (select 1 from public.client_payment_methods where company_id = :'other' and status = 'active'), 'another business''s cards are untouched');

-- ===== Who calls what ==========================================================================

select tautopay.check(bool_and(not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')
    and has_function_privilege('service_role', f, 'execute')),
  'the task''s and the Hub''s functions are the server''s alone')
from unnest(array['public.claim_autopay_charges(integer, uuid)', 'public.autopay_bill(uuid, uuid)', 'public.autopay_mark_sent(uuid, uuid, integer)',
  'public.finish_autopay_charge(uuid, text, uuid, text, text, numeric, uuid)', 'public.release_autopay_charges(uuid, uuid[])',
  'public.autopay_save_payment_method(uuid, uuid, jsonb)', 'public.autopay_record_authorization(uuid, uuid, uuid, text, text, text, text, text, text)',
  'public.autopay_revoke(uuid, uuid, text, uuid)', 'public.autopay_account_left(uuid, boolean, text)', 'public.emit_card_expiry_alerts()']) f;
select tautopay.check(bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')),
  'the team''s functions are for people signed in (each checks who), never signed out')
from unnest(array['public.approve_autopay_charge(uuid)', 'public.call_off_autopay_charge(uuid)', 'public.autopay_pause(uuid, boolean)',
  'public.autopay_set_settings(uuid, jsonb)', 'public.autopay_vouch(uuid, uuid[], text)', 'public.visit_autopay(uuid)']) f;
select tautopay.check(has_function_privilege('authenticated', 'private.client_on_autopay(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'private.autopay_ready(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'private.autopay_queue(uuid, text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'private.autopay_call_off_client(uuid, text)', 'execute'),
  'of the helpers, signed-in people reach only the yes or no visit_autopay asks');
select tautopay.check(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like '%autopay%' or p.proname = 'emit_card_expiry_alerts') and has_function_privilege('anon', p.oid, 'execute')),
  'nobody signed out calls any of them');

-- ===== Tidy up =================================================================================

delete from public.companies where id in (:'co', :'other');
delete from auth.users where email like '%@autopay.test';

\o
\echo 'All autopay tests passed.'
