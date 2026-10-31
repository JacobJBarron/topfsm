-- Database tests for referral credits and asks (20261031000100_referral_credits.sql,
-- 20261031000110_referral_lost.sql, 20261031000120_referral_asks.sql): the settings in their new
-- shape; a referral's terms fixed when the friend arrives, and no credit for a friend who is the
-- referrer or was a client already; the credit earned when the friend pays their first invoice that
-- charged something (an amount, or a percent of the job rounded to cents), once; put on the
-- referrer's open draft first, then their oldest open invoice, never more than it can take, never on
-- one made in Stripe or already in the books by itself, and given back when its invoice is voided,
-- deleted, cut back or moved to another client; the office applying, taking off, keeping off, giving
-- and refusing credits; two at once never putting on more than was earned, and a payment never
-- failing over a credit; lost and back again; referrals from before; who reads what; asks once in 6
-- months, even at the same moment; the starter rule; and the numbers.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema trc;
grant usage on schema trc to authenticated, service_role;
create function trc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function trc.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
-- How many rows a statement changed (0 when row-level security hid every row from it).
create function trc.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
-- Signs in as someone, for the rest of the transaction.
create function trc.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- An invoice for a client with one line, sent unless asked for a draft, dated today in the company's time zone.
create function trc.invoice(p_company uuid, p_client uuid, p_amount numeric, p_status text default 'sent', p_taxable boolean default false,
  p_tax numeric default 0, p_kind text default 'standard', p_job uuid default null) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.invoices (company_id, client_id, kind, tax_rate, issued_on, job_id)
  values (p_company, p_client, p_kind, p_tax, private.company_today(p_company), p_job) returning id into v_id;
  insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable)
  values (p_company, v_id, 'Service', 1, 'ea', p_amount, p_taxable);
  if p_status <> 'draft' then
    update public.invoices set status = p_status where id = v_id;
  end if;
  return v_id;
end $$;
-- Pays what's owed on an invoice.
create function trc.pay(p_invoice uuid) returns void language sql as $$
  insert into public.payments (company_id, invoice_id, client_id, amount, method)
  select company_id, id, client_id, balance_due, 'check' from public.invoices where id = p_invoice
$$;
-- A referral from the referral page: the friend's referral id.
create function trc.refer(p_company uuid, p_referrer uuid, p_name text, p_email text default null, p_phone text default null) returns uuid language plpgsql as $$
declare v_request uuid;
begin
  v_request := (public.record_referral(p_company, p_referrer, p_name, p_email, p_phone, '{"line1": "1 Elm St"}', null) ->> 'request_id')::uuid;
  return (select id from public.referrals where request_id = v_request);
end $$;
create function trc.friend(p_referral uuid) returns uuid language sql as $$
  select referred_client_id from public.referrals where id = p_referral
$$;
create function trc.credits(p_referral uuid) returns numeric language sql as $$
  select coalesce(sum(amount), 0) from public.referral_credits where referral_id = p_referral
$$;
create function trc.on_invoice(p_invoice uuid) returns numeric language sql as $$
  select coalesce(sum(amount), 0) from public.referral_credits where invoice_id = p_invoice
$$;
-- Waits (up to 5 seconds) for another connection to be waiting on an advisory lock; false if none does.
create function trc.waiting_on_advisory() returns boolean language plpgsql as $$
begin
  for i in 1..50 loop
    if exists (select 1 from pg_locks where locktype = 'advisory' and not granted) then return true; end if;
    perform pg_sleep(0.1);
  end loop;
  return false;
end $$;
grant execute on all functions in schema trc to authenticated, service_role;
-- A second and third connection, to do things at the same moment (dblink may already be installed).
set client_min_messages = warning;
create extension if not exists dblink schema trc;
reset client_min_messages;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset

\set mia 'e5200000-0000-0000-0000-000000000001'
\set oli 'e5200000-0000-0000-0000-000000000002'
\set ivy 'e5200000-0000-0000-0000-000000000003'
\set mo 'e5200000-0000-0000-0000-000000000004'
\set cal 'e5200000-0000-0000-0000-000000000005'
\set eve 'e5200000-0000-0000-0000-000000000006'
\set oz 'e5200000-0000-0000-0000-000000000007'
\set sue 'e5200000-0000-0000-0000-000000000008'

-- Mia owns Maple Referrals; Oli is office; Ivy is office in a Bookkeeper role (Invoices, not
-- Marketing); Mo is office in a Marketer role (Marketing, not Invoices); Cal is field crew and Eve an
-- estimator. Oz owns another business, and Sue a third, for the numbers.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mia', 'mia@maple.test', '{"full_name": "Mia Owner"}'),
  (:'oli', 'oli@maple.test', '{"full_name": "Oli Office"}'),
  (:'ivy', 'ivy@maple.test', '{"full_name": "Ivy Books"}'),
  (:'mo', 'mo@maple.test', '{"full_name": "Mo Marketer"}'),
  (:'cal', 'cal@maple.test', '{"full_name": "Cal Crew"}'),
  (:'eve', 'eve@maple.test', '{"full_name": "Eve Estimator"}'),
  (:'oz', 'oz@other.test', '{"full_name": "Oz Other"}'),
  (:'sue', 'sue@stats.test', '{"full_name": "Sue Stats"}');

begin;
set local role authenticated;
select trc.as_user(:'oz');
select public.create_company('Other Lawn', 'lawn_care') as other \gset
commit;

begin;
set local role authenticated;
select trc.as_user(:'mia');
select public.create_company('Maple Referrals', 'lawn_care') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'office', '{invoices}') returning id as keeper \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Marketer', 'office', '{marketing,sales}') returning id as marketer \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'oli', 'office'), (:'co', :'cal', 'field_crew'), (:'co', :'eve', 'estimator');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'ivy', 'office', :'keeper'), (:'co', :'mo', 'office', :'marketer');
insert into public.clients (company_id, display_name, email, phone, status) values (:'co', 'Ana Smith', 'ana@example.test', '+1 (540) 555-0100', 'active') returning id as ana \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Bo Brown', 'bo@example.test', 'active') returning id as bo \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Cy Chen', 'cy@example.test', 'active') returning id as cy \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Dee Diaz', 'dee@example.test', 'active') returning id as dee \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Hal Hughes', 'hal@example.test', 'active') returning id as hal \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Kai King', 'kai@example.test', 'active') returning id as kai \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Rae Reed', 'rae@example.test', 'active') returning id as rae \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Tia Tran', 'tia@example.test', 'active') returning id as tia \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Wes West', 'wes@example.test', 'active') returning id as wes \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Olive Old', 'olive@example.test', 'active') returning id as olive \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Vera Vale', 'vera@example.test', 'active') returning id as vera \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Pip Lead', 'pip@example.test', 'lead') returning id as pip \gset
commit;
-- Olive has had work done; Pip is only a lead.
insert into public.jobs (company_id, client_id, title) values (:'co', :'olive', 'Spring cleanup');

-- ===== Settings in the new shape ===============================================================
update public.companies set settings = settings || '{"referral_reward": {"amount": 50}, "referral_offer": " 10% off your first mow "}' where id = :'co';
update public.companies set settings = settings || '{"referral_reward": {"amount": 25}, "referrals": {"offer": "Kept", "message": "Hi {{link}}"}}' where id = :'other';
select trc.check(private.move_referral_settings() = 2, 'move_referral_settings moves the old keys of both businesses');
select trc.check((select settings -> 'referrals' = '{"reward": {"kind": "amount", "value": 50}, "offer": "10% off your first mow"}'
                         and not settings ? 'referral_reward' and not settings ? 'referral_offer' and settings #>> '{marketing,enabled}' = 'true'
                    from public.companies where id = :'co'),
  'an amount becomes a credit of that amount, the offer is trimmed, and the old keys are gone');
select trc.check((select settings -> 'referrals' = '{"reward": {"kind": "amount", "value": 25}, "offer": "Kept", "message": "Hi {{link}}"}' from public.companies where id = :'other'),
  'settings.referrals already there is kept, with the old reward added');
select trc.check(private.move_referral_settings() = 0, 'run again, it changes nothing');
select trc.check((select row(kind, value)::text = '(percent,12.50)' from private.referral_terms('{"referrals": {"reward": {"kind": "percent", "value": 12.5}}}'))
  and (select row(kind, value)::text = '(percent,0)' from private.referral_terms('{"referrals": {"reward": {"kind": "percent", "value": 120}}}'))
  and (select row(kind, value)::text = '(amount,0)' from private.referral_terms('{"referrals": {"reward": {"kind": "amount", "value": 20000}}}'))
  and (select row(kind, value)::text = '(amount,0)' from private.referral_terms('{"referrals": {"reward": {"kind": "gift", "value": 50}}}'))
  and (select row(kind, value)::text = '(amount,0)' from private.referral_terms('{}')),
  'referral_terms: a percent from 1 to 100, an amount up to $10,000, anything else no credit');

begin;
set local role authenticated;
select trc.as_user(:'mia');
-- Saved as Marketing → Referrals saves it (useSettingsSaver), from a copy without settings.marketing.
update public.companies set settings = (settings - 'marketing') || jsonb_build_object('referrals', '{"reward": {"kind": "amount", "value": 50}, "offer": "10% off your first mow", "message": "Hi {{client.first_name}} {{link}} {{rewards}}"}'::jsonb)
 where id = :'co';
commit;
select trc.check((select settings #>> '{referrals,message}' = 'Hi {{client.first_name}} {{link}} {{rewards}}' and settings #>> '{marketing,enabled}' = 'true' from public.companies where id = :'co'),
  'an admin saving settings.referrals keeps it, and the Marketing switch stays as it was');

-- ===== The referral page =======================================================================
select trc.refer(:'co', :'ana', 'Maria Lopez', 'maria@example.test', '+1 540 555 0200') as maria_ref \gset
select trc.friend(:'maria_ref') as maria \gset
select trc.check((select reward_kind = 'amount' and reward_value = 50 and reward_status = 'pending' and reward_amount = 0 and status = 'new' and no_reward_reason is null
                    from public.referrals where id = :'maria_ref'),
  'record_referral: the credit offered now, pending until the friend pays');
select trc.check((select c.status = 'lead' and c.lead_source = 'Referral' and c.referred_by = :'ana' and c.email = 'maria@example.test'
                         and q.source = 'referral' and q.title = 'Referral from Ana Smith' and p.line1 = '1 Elm St'
                    from public.referrals r join public.clients c on c.id = r.referred_client_id join public.requests q on q.id = r.request_id
                    join public.properties p on p.id = q.property_id where r.id = :'maria_ref'),
  'and makes the lead, their property and the request, as the referral page did');
select trc.check(not has_function_privilege('anon', 'public.record_referral(uuid, uuid, text, text, text, jsonb, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_referral(uuid, uuid, text, text, text, jsonb, text)', 'execute')
  and has_function_privilege('service_role', 'public.record_referral(uuid, uuid, text, text, text, jsonb, text)', 'execute'),
  'only the server records referrals (it checks the link, Turnstile and how often)');

update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "percent", "value": 10}') where id = :'co';
select trc.refer(:'co', :'bo', 'Pat Percent', 'pat@example.test') as pat_ref \gset
select trc.check((select reward_kind = 'percent' and reward_value = 10 and reward_status = 'pending' from public.referrals where id = :'pat_ref'),
  'a percent credit is kept as a percent');
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 0}') where id = :'co';
select trc.refer(:'co', :'ana', 'Nobody Set', 'nobody@example.test') as unset_ref \gset
select trc.check((select reward_status = 'none' and no_reward_reason = 'not_set' from public.referrals where id = :'unset_ref'), 'no credit set: none, not set');
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 50}') where id = :'co';
select trc.refer(:'co', :'ana', 'Ana Again', ' ANA@Example.test ') as self_email_ref \gset
select trc.refer(:'co', :'ana', 'Ana Phone', null, '540.555.0100') as self_phone_ref \gset
select trc.check((select count(*) = 2 from public.referrals where id in (:'self_email_ref', :'self_phone_ref') and reward_status = 'none' and no_reward_reason = 'self'),
  'the referrer''s own email (any case) or phone (its last 10 digits): they referred themselves');
select trc.check(trc.friend(:'self_email_ref') = :'ana'
  and not exists (select 1 from public.clients where company_id = :'co' and display_name = 'Ana Again')
  and (select q.client_id = :'ana' and p.client_id = :'ana' and p.line1 = '1 Elm St'
         from public.referrals r join public.requests q on q.id = r.request_id join public.properties p on p.id = q.property_id where r.id = :'self_email_ref'),
  'their own email is them: the request goes on Ana, at a new address of hers, with no second Ana made');
select trc.check(trc.friend(:'self_phone_ref') <> :'ana' and (select status = 'lead' from public.clients where id = trc.friend(:'self_phone_ref')),
  'their phone with another name may be someone else at home: a new lead the office can sort out');
select public.record_referral(:'co', :'ana', ' ana  SMITH ', null, '(540) 555-0100', '{"line1": "1 elm st "}', null) as again \gset
select trc.check((:'again'::jsonb ->> 'client_id')::uuid = :'ana' and not (:'again'::jsonb ->> 'new_property')::boolean
  and (:'again'::jsonb ->> 'property_id')::uuid = (select q.property_id from public.referrals r join public.requests q on q.id = r.request_id where r.id = :'self_email_ref'),
  'their phone and name is them too, and an address of theirs that matches is used again');
select trc.refer(:'co', :'ana', 'Olive Again', 'Olive@example.test') as olive_ref \gset
select trc.refer(:'co', :'ana', 'Pip Again', 'pip@example.test') as pip_ref \gset
select trc.check((select reward_status = 'none' and no_reward_reason = 'already_client' from public.referrals where id = :'olive_ref')
  and (select reward_status = 'pending' from public.referrals where id = :'pip_ref'),
  'a client who has had work done is already a client; one who is only a lead isn''t');
select trc.check(trc.friend(:'olive_ref') = :'olive' and (select count(*) = 1 from public.clients where company_id = :'co' and lower(email) = 'olive@example.test')
  and trc.friend(:'pip_ref') <> :'pip',
  'the request goes on Olive rather than a second Olive; Pip, only a lead, is a new lead as before');

-- ===== Earning =================================================================================
-- Ana has no open invoice when Maria pays.
select trc.invoice(:'co', :'maria', 200) as maria_inv \gset
select trc.pay(:'maria_inv');
select trc.check((select reward_status = 'earned' and reward_amount = 50 and status = 'won' and earned_invoice_id = :'maria_inv' and earned_at is not null
                    from public.referrals where id = :'maria_ref'),
  'Maria paying her first invoice earns Ana a $50 credit, and the referral is won');
select trc.check((select count(*) = 1 from public.activity where company_id = :'co' and verb = 'referral.earned' and subject_type = 'client' and subject_id = :'ana'
                    and data ->> 'referral_id' = :'maria_ref' and (data ->> 'credit')::numeric = 50 and data ->> 'friend_name' = 'Maria Lopez'
                    and summary = 'Ana Smith earned a $50.00 referral credit: Maria Lopez paid their first invoice. It goes on their next invoice.'),
  'one referral.earned activity on Ana, with the friend, the credit and where it goes');
select trc.check(trc.credits(:'maria_ref') = 0, 'with no open invoice, it stays earned');
select trc.invoice(:'co', :'maria', 120) as maria_inv2 \gset
select trc.pay(:'maria_inv2');
select trc.check((select reward_amount = 50 and earned_invoice_id = :'maria_inv' from public.referrals where id = :'maria_ref')
  and (select count(*) = 1 from public.activity where verb = 'referral.earned' and data ->> 'referral_id' = :'maria_ref'),
  'her second paid invoice earns nothing more');

-- 10% of $480.55 less a $30 promo, taxed: 10% of $450.55 is $45.055, rounded to $45.06.
insert into public.promo_codes (company_id, code, kind, value) values (:'co', 'THIRTY', 'amount', 30) returning id as thirty \gset
select trc.invoice(:'co', trc.friend(:'pat_ref'), 480.55, 'draft', true, 0.07) as pat_inv \gset
update public.invoices set promo_code_id = :'thirty' where id = :'pat_inv';
update public.invoices set status = 'sent' where id = :'pat_inv';
select trc.pay(:'pat_inv');
select trc.check((select reward_status = 'earned' and reward_amount = 45.06 from public.referrals where id = :'pat_ref'),
  'a percent credit is that percent of the first invoice after discounts and before tax, to the cent');

-- A $0 invoice (a promo covered it) isn't their first paid one: the next that charges something is.
insert into public.promo_codes (company_id, code, kind, value) values (:'co', 'FREEMOW', 'percent', 100) returning id as freemow \gset
select trc.refer(:'co', :'cy', 'Zed Zero', 'zed@example.test') as zed_ref \gset
select trc.invoice(:'co', trc.friend(:'zed_ref'), 40, 'draft') as zed_free \gset
update public.invoices set promo_code_id = :'freemow' where id = :'zed_free';
update public.invoices set status = 'sent' where id = :'zed_free';
select trc.check((select status from public.invoices where id = :'zed_free') = 'paid' and (select reward_status from public.referrals where id = :'zed_ref') = 'pending',
  'a $0 paid invoice doesn''t earn');
-- Nor do a deposit or progress billing: the work isn't done yet.
select trc.invoice(:'co', trc.friend(:'zed_ref'), 100, 'sent', false, 0, 'deposit') as zed_deposit \gset
select trc.pay(:'zed_deposit');
select trc.check((select reward_status from public.referrals where id = :'zed_ref') = 'pending', 'a paid deposit doesn''t earn');

-- A percent of a job taken in a deposit and a final invoice is of the whole job: the final invoice
-- takes the deposit off, and counts it back.
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "percent", "value": 10}') where id = :'co';
select trc.refer(:'co', :'vera', 'Jo Job', 'jo@example.test') as jo_ref \gset
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 50}') where id = :'co';
insert into public.jobs (company_id, client_id, title) values (:'co', trc.friend(:'jo_ref'), 'Driveway') returning id as jo_job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'jo_job', 'Asphalt', 1, 'ea', 1000);
select public.create_invoice_for_job(:'jo_job', 'deposit', 200) as jo_deposit \gset
update public.invoices set status = 'sent' where id = :'jo_deposit';
select trc.pay(:'jo_deposit');
select trc.check((select reward_status from public.referrals where id = :'jo_ref') = 'pending', 'the friend''s deposit paid: not yet');
select public.create_invoice_for_job(:'jo_job') as jo_final \gset
update public.invoices set status = 'sent' where id = :'jo_final';
select trc.check((select subtotal from public.invoices where id = :'jo_final') = 800, 'the final invoice takes the $200 deposit off the $1,000 job');
select trc.pay(:'jo_final');
select trc.check((select reward_status = 'earned' and reward_amount = 100 and earned_invoice_id = :'jo_final' from public.referrals where id = :'jo_ref'),
  '10% of the whole $1,000 job, earned when the final invoice is paid');
-- Nor does a referrer's own deposit take their credit: it's the money that secures the job.
select trc.invoice(:'co', :'vera', 300, 'sent', false, 0, 'deposit') as vera_deposit \gset
select trc.check(trc.on_invoice(:'vera_deposit') = 0 and (select reward_status from public.referrals where id = :'jo_ref') = 'earned',
  'a deposit invoice doesn''t take a credit');
select trc.invoice(:'co', :'vera', 300) as vera_inv \gset
select trc.check(trc.on_invoice(:'vera_inv') = 100, 'the next invoice that isn''t a deposit does');

-- Self and already-a-client referrals earn nothing, even when paid.
select trc.pay(trc.invoice(:'co', trc.friend(:'self_email_ref'), 90));
-- Olive paid for older work too, from before she was referred.
select trc.invoice(:'co', :'olive', 70) as olive_old \gset
update public.invoices set issued_on = issued_on - 60 where id = :'olive_old';
select trc.pay(:'olive_old');
select trc.invoice(:'co', trc.friend(:'olive_ref'), 90) as olive_inv \gset
select trc.pay(:'olive_inv');
select trc.check((select count(*) = 2 from public.referrals where id in (:'self_email_ref', :'olive_ref') and reward_status = 'none' and reward_amount = 0),
  'self and already-a-client referrals earn nothing when the friend pays');
-- One that was made as the same client earns nothing either, whenever it was made.
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name, reward_value) values (:'co', :'kai', :'kai', 'Kai King', 50) returning id as kai_self \gset
select trc.pay(trc.invoice(:'co', :'kai', 70));
select trc.check((select reward_status = 'none' and no_reward_reason = 'self' and status = 'won' from public.referrals where id = :'kai_self'),
  'a referral of the referrer themselves is no credit when they pay');

-- History brought in quietly from Stripe: a friend's old paid invoice means they were a client already.
select trc.refer(:'co', :'cy', 'Ida Import', 'ida@example.test') as ida_ref \gset
select public.stripe_import_invoice(:'co', jsonb_build_object('stripe_id', 'in_ida_old', 'status', 'paid', 'number', 'OLD-1', 'amount_due', 300,
  'issued_on', '2024-03-01', 'customer', jsonb_build_object('id', 'cus_ida', 'name', 'Ida Import', 'email', 'ida@example.test'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Mowing', 'quantity', 1, 'unit_price', 300)),
  'payment', jsonb_build_object('amount', 300, 'method', 'card', 'processor_ref', 'ch_ida_old', 'received_at', '2024-03-02T12:00:00Z')), true) as ida_inv \gset
select trc.check((select client_id from public.invoices where id = :'ida_inv') = trc.friend(:'ida_ref')
  and (select reward_status = 'none' and no_reward_reason = 'already_client' from public.referrals where id = :'ida_ref')
  and not exists (select 1 from public.activity where verb = 'referral.earned' and data ->> 'referral_id' = :'ida_ref'),
  'a Stripe history import of a referred lead''s old paid invoice earns nothing: they were a client already');

-- ===== Applying ================================================================================
-- Ana's credit from Maria waits for her next invoice: a draft made from a job gets it as its lines go in.
insert into public.jobs (company_id, client_id, title) values (:'co', :'ana', 'Patio') returning id as ana_job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable) values (:'co', :'ana_job', 'Pavers', 1, 'ea', 300, true);
select public.create_invoice_for_job(:'ana_job') as d1 \gset
select trc.check(trc.on_invoice(:'d1') = 50 and (select credit_amount = 50 and total = 250 from public.invoices where id = :'d1'),
  'a new draft for Ana gets Maria''s credit at commit');
select trc.check((select reward_status = 'applied' and applied_at is not null from public.referrals where id = :'maria_ref')
  and (select note = 'Referral credit: thanks for referring Maria' and automatic from public.referral_credits where referral_id = :'maria_ref'),
  'the referral is applied, with a note saying what the credit is for');
-- Nia pays while Ana's draft is open: hers lands on it at once.
select trc.refer(:'co', :'ana', 'Nia New', 'nia@example.test') as nia_ref \gset
select trc.pay(trc.invoice(:'co', trc.friend(:'nia_ref'), 150));
select trc.check(trc.on_invoice(:'d1') = 100 and (select reward_status from public.referrals where id = :'nia_ref') = 'applied',
  'a credit earned while the referrer has an open invoice goes on it straight away');
select trc.check((select summary like '% It went on invoice #%' and (data ->> 'invoice_number')::bigint = (select number from public.invoices where id = :'d1')
                    from public.activity where verb = 'referral.earned' and data ->> 'referral_id' = :'nia_ref'),
  'and the activity says which invoice it went on');
update public.invoices set tax_rate = 0.05 where id = :'d1';
update public.invoices set status = 'sent' where id = :'d1';
select trc.check((select credit_amount = 100 and tax_amount = 10 and total = 210 and balance_due = 210 and status = 'sent' from public.invoices where id = :'d1'),
  'credits come off before tax: $300 less $100 is $200, taxed at 5% is $210');

-- Drafts first: Dee's credit goes on her draft, not her older invoice awaiting payment.
select trc.invoice(:'co', :'dee', 200) as dee_sent \gset
update public.invoices set issued_on = issued_on - 10 where id = :'dee_sent';
select trc.invoice(:'co', :'dee', 200, 'draft') as dee_draft \gset
select trc.refer(:'co', :'dee', 'Gus Green', 'gus@example.test') as gus_ref \gset
select trc.pay(trc.invoice(:'co', trc.friend(:'gus_ref'), 80));
select trc.check(trc.on_invoice(:'dee_draft') = 50 and trc.on_invoice(:'dee_sent') = 0, 'a credit goes on the referrer''s open draft first');

-- The cap: Cy's $100 credit on a $60 invoice takes $60, and the next invoice takes the rest.
select trc.invoice(:'co', :'cy', 60) as c1 \gset
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 100}') where id = :'co';
select trc.refer(:'co', :'cy', 'Fay Fox', 'fay@example.test') as fay_ref \gset
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 50}') where id = :'co';
select trc.invoice(:'co', trc.friend(:'fay_ref'), 500) as fay_inv \gset
select trc.pay(:'fay_inv');
select trc.check(trc.on_invoice(:'c1') = 60 and (select total = 0 and status = 'paid' from public.invoices where id = :'c1')
  and (select reward_status = 'earned' and reward_amount = 100 from public.referrals where id = :'fay_ref'),
  'a $100 credit on a $60 invoice puts $60 on (covered completely, it''s paid) and $40 stays earned');
select trc.check((select summary = format('Cy Chen earned a $100.00 referral credit: Fay Fox paid their first invoice. $60.00 went on invoice #%s, and $40.00 goes on their next one.',
                                         (select number from public.invoices where id = :'c1'))
                         and data ->> 'invoice_id' = :'c1' and data ->> 'friend_invoice_id' = :'fay_inv' and (data ->> 'applied')::numeric = 60
                    from public.activity where verb = 'referral.earned' and data ->> 'referral_id' = :'fay_ref'),
  'the activity says how much went on which invoice and what''s still to go, and names Cy''s invoice apart from the one Fay paid');
select trc.invoice(:'co', :'cy', 200, 'sent', true, 0.1) as c2 \gset
select trc.check(trc.on_invoice(:'c2') = 40 and (select reward_status from public.referrals where id = :'fay_ref') = 'applied'
  and (select tax_amount = 16 and total = 176 from public.invoices where id = :'c2'),
  'the next invoice takes the $40 left, and is taxed on what''s left');
-- Half taxed, half not, with a credit that covers it all: the total is the tax, never below.
select trc.invoice(:'co', :'cy', 50, 'draft', true, 0.1) as c3 \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable) values (:'co', :'c3', 'Untaxed', 1, 'ea', 50, false);
select trc.check((select bool_and(total >= tax_amount and total >= 0) from public.invoices where company_id = :'co'),
  'no invoice''s total is below its tax');

-- A promo added to an invoice with credits on it: the newest is cut back and goes on the next one.
insert into public.promo_codes (company_id, code, kind, value) values (:'co', 'BIG250', 'amount', 250) returning id as big \gset
update public.invoices set promo_code_id = :'big' where id = :'d1';
select trc.check(trc.on_invoice(:'d1') = 50 and (select discount_amount = 250 and credit_amount = 50 and total = 0 from public.invoices where id = :'d1')
  and (select string_agg(r.referred_name, ',') from public.referral_credits c join public.referrals r on r.id = c.referral_id where c.invoice_id = :'d1') = 'Maria Lopez'
  and (select reward_status from public.referrals where id = :'nia_ref') = 'earned',
  'a $250 promo on the $300 invoice leaves room for $50: Nia''s newer credit comes off and is earned again');
select trc.invoice(:'co', :'ana', 90) as a2 \gset
select trc.check(trc.on_invoice(:'a2') = 50 and (select reward_status from public.referrals where id = :'nia_ref') = 'applied', 'and goes on Ana''s next invoice');

-- Voided before it's paid: given back, and on the next open invoice. A draft deleted: the same.
select trc.invoice(:'co', :'ana', 400, 'draft') as a3 \gset
update public.invoices set status = 'void' where id = :'a2';
select trc.check(trc.on_invoice(:'a2') = 0 and trc.on_invoice(:'a3') = 50, 'voiding an invoice gives its credit back, and it goes on the next open one');
select trc.check((select status = 'void' and subtotal = 90 and credit_amount = 50 and total = 40 and balance_due = 40 from public.invoices where id = :'a2'),
  'and the void invoice keeps the figures it was sent with, credit and all');
update public.invoices set notes = 'Voided by mistake' where id = :'a2';
select trc.check((select credit_amount = 50 and total = 40 from public.invoices where id = :'a2'), 'even when it''s saved again');
delete from public.invoices where id = :'a3';
select trc.check((select reward_status = 'earned' and applied_at is null from public.referrals where id = :'nia_ref') and trc.credits(:'nia_ref') = 0,
  'deleting a draft gives its credit back too (with nowhere to go, it stays earned)');

-- Moved to another client before it's paid: the credit stays the referrer's (and Bo's own goes on).
select trc.invoice(:'co', :'ana', 80, 'draft') as a_move \gset
select trc.check(trc.on_invoice(:'a_move') = 50, 'Nia''s credit on a new draft of Ana''s');
update public.invoices set client_id = :'bo' where id = :'a_move';
select trc.check((select reward_status from public.referrals where id = :'nia_ref') = 'earned'
  and not exists (select 1 from public.referral_credits where invoice_id = :'a_move' and referral_id = :'nia_ref')
  and (select reward_status from public.referrals where id = :'pat_ref') = 'applied',
  'an invoice moved to another client loses the credit, which is earned again, and takes the new client''s');

-- Paid (the promo and the credit cover it all), it keeps its credit.
select trc.check((select status from public.invoices where id = :'d1') = 'paid' and trc.on_invoice(:'d1') = 50, 'a paid invoice keeps its credit');

-- ===== The office's part =======================================================================
select id as maria_credit from public.referral_credits where invoice_id = :'d1' \gset
begin;
set local role authenticated;
select trc.as_user(:'oli');
select trc.check(trc.error_of(format('select public.remove_referral_credit(%L)', :'maria_credit')) like '22023: A credit stays on an invoice once it''s paid%',
  'remove_referral_credit refuses on a paid invoice');
-- Keep Nia's off invoices: Ana's next draft doesn't get it.
select trc.check(public.referral_auto_apply(:'nia_ref', false) = 0, 'referral_auto_apply keeps it off invoices');
commit;
select trc.invoice(:'co', :'ana', 80, 'draft') as a4 \gset
select trc.check(trc.on_invoice(:'a4') = 0, 'a credit kept off invoices doesn''t go on by itself');
begin;
set local role authenticated;
select trc.as_user(:'oli');
select trc.check(public.apply_referral_credit(:'nia_ref', :'a4') = 50, 'apply_referral_credit puts it on the invoice chosen');
commit;
select trc.check((select reward_status from public.referrals where id = :'nia_ref') = 'applied'
  and (select not automatic and created_by = :'oli' from public.referral_credits where referral_id = :'nia_ref'),
  'applied by hand, by Oli');
select id as nia_credit from public.referral_credits where referral_id = :'nia_ref' \gset
begin;
set local role authenticated;
select trc.as_user(:'oli');
select public.remove_referral_credit(:'nia_credit');
select trc.check(public.referral_auto_apply(:'nia_ref', true) = 0, 'turned back on, there''s nowhere else for it');
commit;
select trc.check(trc.on_invoice(:'a4') = 0 and (select reward_status = 'earned' and auto_apply from public.referrals where id = :'nia_ref')
  and exists (select 1 from public.referral_credit_skips where referral_id = :'nia_ref' and invoice_id = :'a4'),
  'taken off by hand, it''s earned again and never goes back on that invoice by itself');
select trc.invoice(:'co', :'ana', 75, 'draft') as a5 \gset
select trc.check(trc.on_invoice(:'a5') = 50, 'it goes on the next one instead');

-- Given outside Crewtavo: what isn't on invoices of an earned credit, or a set amount still to come.
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 80}') where id = :'co';
select trc.refer(:'co', :'kai', 'Lu Long', 'lu@example.test') as lu_ref \gset
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 50}') where id = :'co';
select trc.invoice(:'co', :'kai', 30, 'draft') as k1 \gset
select trc.pay(trc.invoice(:'co', trc.friend(:'lu_ref'), 300));
select trc.check(trc.on_invoice(:'k1') = 30 and (select reward_status from public.referrals where id = :'lu_ref') = 'earned', 'Kai''s $80 credit: $30 on his draft');
select trc.refer(:'co', :'kai', 'Mae May', 'mae@example.test') as mae_ref \gset
select trc.refer(:'co', :'bo', 'Ned Nash', 'ned@example.test') as ned_ref \gset
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "percent", "value": 10}') where id = :'co';
select trc.refer(:'co', :'bo', 'Opal Odd', 'opal@example.test') as opal_ref \gset
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 50}') where id = :'co';
begin;
set local role authenticated;
select trc.as_user(:'mo');
select public.referral_set_given(:'lu_ref');
select public.referral_set_given(:'mae_ref');
select trc.check(trc.error_of(format('select public.referral_set_given(%L)', :'opal_ref')) like '22023: This credit is worked out when their friend pays%',
  'a percent credit still to be worked out can''t be marked given');
select trc.check(trc.error_of(format('select public.referral_set_given(%L)', :'maria_ref')) like '22023: All of this credit is on invoices already%',
  'nor one that''s all on invoices');
select public.referral_no_reward(:'ned_ref');
select trc.check(trc.error_of(format('select public.referral_no_reward(%L)', :'lu_ref')) like '22023:%', 'a credit given can''t be taken away');
commit;
select trc.check((select reward_status = 'issued' and reward_amount = 80 and given_amount = 50 and reward_issued_at is not null from public.referrals where id = :'lu_ref') and trc.credits(:'lu_ref') = 30
  and (select reward_status = 'issued' and reward_amount = 50 and given_amount = 50 from public.referrals where id = :'mae_ref')
  and (select reward_status = 'none' and no_reward_reason = 'by_hand' from public.referrals where id = :'ned_ref'),
  'referral_set_given: Lu''s $50 rest is given ($30 stays on the draft), Mae''s $50 is given before she pays; referral_no_reward: none for Ned');
-- The $30 on Kai's draft comes off (the draft is deleted): it's owed again, not given.
delete from public.invoices where id = :'k1';
select trc.check((select reward_status = 'earned' and given_amount = 50 and reward_issued_at is not null from public.referrals where id = :'lu_ref')
  and trc.credits(:'lu_ref') = 0 and private.referral_credit_left(:'lu_ref') = 30,
  'a given credit whose part on an invoice comes off is earned again for that part, and the given part stays given');
begin;
set local role authenticated;
select trc.as_user(:'mo');
select trc.check(trc.error_of(format('select public.referral_no_reward(%L)', :'lu_ref')) like '22023: Part of this credit was given outside Crewtavo%',
  'and it can''t be made no credit, since part of it was given');
commit;
select trc.invoice(:'co', :'kai', 100, 'draft') as k2 \gset
select trc.check(trc.on_invoice(:'k2') = 30 and (select reward_status = 'applied' and given_amount = 50 from public.referrals where id = :'lu_ref'),
  'the $30 goes on Kai''s next invoice, and the credit is all used: $30 applied, $50 given');
-- Cutting back a credit (a discount saved on its invoice) still goes through, and what's cut is owed again.
update public.invoices set discount_amount = 90 where id = :'k2';
select trc.check(trc.credits(:'lu_ref') = 10 and (select reward_status = 'earned' and given_amount = 50 from public.referrals where id = :'lu_ref')
  and private.referral_credit_left(:'lu_ref') = 20,
  'a $90 discount on the $100 draft leaves room for $10: the rest of Lu''s credit is earned again');

-- Give a credit anyway: Olive was matched as a client already, and has paid since. It's earned at once.
begin;
set local role authenticated;
select trc.as_user(:'mo');
select trc.check(public.referral_give_credit(:'olive_ref') = 'applied', 'referral_give_credit on a friend who already paid earns it at once (and it goes on Ana''s open invoice)');
select trc.check(public.referral_give_credit(:'self_phone_ref') = 'pending', 'and one whose friend hasn''t paid is pending again');
select trc.check(trc.error_of(format('select public.referral_give_credit(%L)', :'kai_self')) like '22023:%'
  and trc.error_of(format('select public.referral_give_credit(%L)', :'unset_ref')) like '22023:%',
  'but not for a client referring themselves, or one made with no credit set');
commit;
select trc.check((select credit_anyway and reward_amount = 50 and earned_invoice_id = :'olive_inv' from public.referrals where id = :'olive_ref'),
  'a credit given anyway is fixed at what was offered, and earned by work from after the referral, not Olive''s older invoice');

-- An invoice in QuickBooks isn't changed by itself; by hand it can be.
select trc.invoice(:'co', :'hal', 120) as h1 \gset
insert into public.sync_links (company_id, provider, entity, local_id, external_id) values (:'co', 'quickbooks', 'invoice', :'h1', 'qb-77');
select trc.refer(:'co', :'hal', 'Quin Quick', 'quin@example.test') as quin_ref \gset
select trc.pay(trc.invoice(:'co', trc.friend(:'quin_ref'), 90));
select trc.check(trc.on_invoice(:'h1') = 0 and (select reward_status from public.referrals where id = :'quin_ref') = 'earned',
  'an invoice already in the books doesn''t get a credit by itself');
-- One made in Stripe never does.
select public.stripe_import_invoice(:'co', jsonb_build_object('stripe_id', 'in_hal_new', 'status', 'open', 'number', 'S-9', 'amount_due', 70,
  'issued_on', private.company_today(:'co'), 'customer', jsonb_build_object('id', 'cus_hal', 'name', 'Hal Hughes', 'email', 'hal@example.test'),
  'lines', jsonb_build_array(jsonb_build_object('name', 'Trim', 'quantity', 1, 'unit_price', 70)))) as hal_stripe \gset
select trc.check((select client_id from public.invoices where id = :'hal_stripe') = :'hal' and trc.on_invoice(:'hal_stripe') = 0
  and (select reward_status from public.referrals where id = :'quin_ref') = 'earned',
  'an invoice imported from Stripe isn''t credited');
begin;
set local role authenticated;
select trc.as_user(:'oli');
select trc.check(trc.error_of(format('select public.apply_referral_credit(%L, %L)', :'quin_ref', :'hal_stripe')) like '22023: This invoice can''t take a credit%',
  'nor by hand');
select trc.check(public.apply_referral_credit(:'quin_ref', :'h1') = 50, 'by hand it can go on the invoice in QuickBooks (the page says to change it there too)');
commit;

-- ===== Two at once =============================================================================
-- Rae's credit, kept off invoices, applied by hand by two people at once to two invoices.
select trc.refer(:'co', :'rae', 'Sol Sun', 'sol@example.test') as sol_ref \gset
select trc.pay(trc.invoice(:'co', trc.friend(:'sol_ref'), 90));
update public.referrals set auto_apply = false where id = :'sol_ref';
select trc.invoice(:'co', :'rae', 100) as r1 \gset
select trc.invoice(:'co', :'rae', 100) as r2 \gset
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
select :"dbl".dblink_exec('other', format('set role authenticated; set request.jwt.claims = %L', json_build_object('sub', :'oli', 'role', 'authenticated')::text));
begin;
set local role authenticated;
select trc.as_user(:'oli');
select public.apply_referral_credit(:'sol_ref', :'r1');
select :"dbl".dblink_send_query('other', format('select public.apply_referral_credit(%L, %L)', :'sol_ref', :'r2'));
commit;
-- The other one is refused ("Nothing is left of this credit to apply").
set client_min_messages = warning;
select count(*) from :"dbl".dblink_get_result('other', false) as t(x text);
select count(*) from :"dbl".dblink_get_result('other', false) as t(x text);
reset client_min_messages;
select trc.check(trc.credits(:'sol_ref') = 50 and trc.on_invoice(:'r1') = 50 and trc.on_invoice(:'r2') = 0,
  'two people applying one credit at once put it on once');
select :"dbl".dblink_exec('other', 'reset role; reset request.jwt.claims');

-- Two friends of Tia pay at the same moment, against her one $60 invoice.
select trc.invoice(:'co', :'tia', 60) as t1 \gset
select trc.refer(:'co', :'tia', 'Uma Upton', 'uma@example.test') as uma_ref \gset
select trc.refer(:'co', :'tia', 'Vic Vance', 'vic@example.test') as vic_ref \gset
select trc.invoice(:'co', trc.friend(:'uma_ref'), 100) as uma_inv \gset
select trc.invoice(:'co', trc.friend(:'vic_ref'), 100) as vic_inv \gset
begin;
select trc.pay(:'uma_inv');
select :"dbl".dblink_send_query('other', format('select trc.pay(%L)', :'vic_inv'));
commit;
select count(*) from :"dbl".dblink_get_result('other', false) as t(x text);
select count(*) from :"dbl".dblink_get_result('other', false) as t(x text);
select trc.check(trc.on_invoice(:'t1') = 60 and (select status from public.invoices where id = :'vic_inv') = 'paid'
  and (select count(*) = 2 from public.referrals where id in (:'uma_ref', :'vic_ref') and reward_status in ('earned', 'applied'))
  and trc.credits(:'uma_ref') + trc.credits(:'vic_ref') = 60,
  'two friends paying at once: both earn, and the invoice takes no more than it can');

-- A friend pays while someone is saving the referrer's other invoice: no deadlock, the payment goes
-- through, and the credit lands on that invoice when its save commits.
select trc.invoice(:'co', :'wes', 30, 'draft') as w1 \gset
select trc.invoice(:'co', :'wes', 100, 'draft') as w2 \gset
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 80}') where id = :'co';
select trc.refer(:'co', :'wes', 'Xan Xu', 'xan@example.test') as xan_ref \gset
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 50}') where id = :'co';
select trc.invoice(:'co', trc.friend(:'xan_ref'), 100) as xan_inv \gset
select :"dbl".dblink_exec('other', format('begin; update public.invoices set notes = %L where id = %L', 'Saving', :'w2'));
select trc.pay(:'xan_inv');
select trc.check((select status from public.invoices where id = :'xan_inv') = 'paid' and trc.on_invoice(:'w1') = 30 and trc.on_invoice(:'w2') = 0,
  'the payment goes through, and the credit goes on the invoice nobody is saving');
select :"dbl".dblink_exec('other', 'commit');
select trc.check(trc.on_invoice(:'w2') = 50 and (select reward_status from public.referrals where id = :'xan_ref') = 'applied',
  'the rest lands on the other invoice when its save commits');

-- The other order: Ray's only open invoice is being saved, his friend's payment earns the credit
-- (and skips that invoice), and the save commits before the payment does. The save waits for the
-- payment, and the credit lands on it.
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Ray Rowe', 'ray@example.test', 'active') returning id as ray \gset
select trc.invoice(:'co', :'ray', 100, 'draft') as ray1 \gset
select trc.refer(:'co', :'ray', 'Sky Sato', 'sky@example.test') as sky_ref \gset
select trc.invoice(:'co', trc.friend(:'sky_ref'), 100) as sky_inv \gset
select :"dbl".dblink_exec('other', format('begin; update public.invoices set notes = %L where id = %L', 'Saving', :'ray1'));
begin;
select trc.pay(:'sky_inv');
select trc.check(trc.on_invoice(:'ray1') = 0 and (select reward_status from public.referrals where id = :'sky_ref') = 'earned',
  'the payment earns the credit and leaves the invoice being saved alone');
select :"dbl".dblink_send_query('other', 'commit');
select trc.waiting_on_advisory() as save_waited \gset
commit;
select count(*) from :"dbl".dblink_get_result('other', false) as t(x text);
select count(*) from :"dbl".dblink_get_result('other', false) as t(x text);
select trc.check(:'save_waited' and trc.on_invoice(:'ray1') = 50 and (select reward_status from public.referrals where id = :'sky_ref') = 'applied',
  'a save committing first waits for the payment, and the credit lands on that invoice');

-- Ray's draft deleted while an office action holds his lock: the delete waits for the lock before
-- it touches his referral, so that action can still take the referral (no deadlock).
begin;
select pg_advisory_xact_lock(hashtext('referral_credit:' || :'ray'));
select :"dbl".dblink_send_query('other', format('delete from public.invoices where id = %L', :'ray1'));
select trc.waiting_on_advisory() as delete_waited \gset
select trc.check(:'delete_waited' and trc.error_of(format('select 1 from public.referrals where id = %L for update nowait', :'sky_ref')) = 'none',
  'a draft being deleted takes the referrer''s lock before their referral''s row');
commit;
select count(*) from :"dbl".dblink_get_result('other', false) as t(x text);
select count(*) from :"dbl".dblink_get_result('other', false) as t(x text);
select trc.check(not exists (select 1 from public.invoices where id = :'ray1') and trc.credits(:'sky_ref') = 0
  and (select reward_status from public.referrals where id = :'sky_ref') = 'earned',
  'and once it goes through, the credit is earned again');
select :"dbl".dblink_disconnect('other');

-- ===== Not paid after all ======================================================================
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Una Undo', 'una@example.test', 'active') returning id as una \gset
select trc.invoice(:'co', :'una', 200, 'draft') as u1 \gset
select trc.refer(:'co', :'una', 'Pia Pay', 'pia@example.test') as pia_ref \gset
select trc.invoice(:'co', trc.friend(:'pia_ref'), 120) as pia_inv \gset
select trc.pay(:'pia_inv');
select trc.check(trc.on_invoice(:'u1') = 50 and (select reward_status from public.referrals where id = :'pia_ref') = 'applied', 'Pia pays: Una''s $50 credit goes on her draft');
-- The payment was recorded by mistake and is deleted.
delete from public.payments where invoice_id = :'pia_inv';
select trc.check((select status from public.invoices where id = :'pia_inv') = 'sent'
  and (select reward_status = 'pending' and reward_amount = 0 and earned_at is null and earned_invoice_id is null and applied_at is null and status = 'won'
         from public.referrals where id = :'pia_ref')
  and trc.on_invoice(:'u1') = 0 and (select credit_amount = 0 and total = 200 from public.invoices where id = :'u1'),
  'a payment removed: the credit wasn''t earned after all, comes off Una''s draft, and is pending again');
select trc.check((select count(*) = 1 from public.activity where verb = 'referral.unpaid' and subject_type = 'client' and subject_id = :'una' and data ->> 'referral_id' = :'pia_ref'
                    and summary like 'Pia Pay''s invoice #% isn''t paid anymore, so Una Undo''s $50.00 referral credit waits for them to pay again.'),
  'and the office hears about it');
select trc.pay(:'pia_inv');
select trc.check(trc.on_invoice(:'u1') = 50 and (select reward_status = 'applied' and reward_amount = 50 and earned_invoice_id = :'pia_inv' from public.referrals where id = :'pia_ref'),
  'paid again, it''s earned again and goes back on the draft');
-- Una's invoice with the credit is paid, and then Pia's payment is refunded: the credit is used already.
update public.invoices set status = 'sent' where id = :'u1';
select trc.pay(:'u1');
insert into public.payments (company_id, invoice_id, client_id, amount, method)
select company_id, id, client_id, -amount_paid, 'card' from public.invoices where id = :'pia_inv';
select trc.check((select status from public.invoices where id = :'pia_inv') = 'sent'
  and (select reward_status = 'applied' and reward_amount = 50 and not auto_apply from public.referrals where id = :'pia_ref') and trc.on_invoice(:'u1') = 50,
  'refunded after Una paid the invoice with the credit on it: the credit stays there, and the rest would be kept off invoices');
select trc.check((select summary like 'Pia Pay''s invoice #% isn''t paid anymore, but $50.00 of Una Undo''s $50.00 referral credit is used already (on invoice #%). Anything left is kept off invoices until you decide.'
                    from public.activity where verb = 'referral.unpaid' and data ->> 'referral_id' = :'pia_ref' order by created_at desc limit 1),
  'and the office hears where it went');
-- A friend with another paid invoice still earned it.
select trc.refer(:'co', :'una', 'Quill Two', 'quill@example.test') as quill_ref \gset
select trc.invoice(:'co', trc.friend(:'quill_ref'), 80) as quill1 \gset
select trc.pay(:'quill1');
select trc.invoice(:'co', trc.friend(:'quill_ref'), 90) as quill2 \gset
select trc.pay(:'quill2');
delete from public.payments where invoice_id = :'quill1';
select trc.check((select reward_status = 'earned' and reward_amount = 50 and earned_invoice_id = :'quill2' from public.referrals where id = :'quill_ref'),
  'a friend who has paid another invoice keeps the credit earned, now from that one');
-- An invoice whose discounts already cover it has no room, and says so.
insert into public.promo_codes (company_id, code, kind, value) values (:'co', 'ALLFREE', 'percent', 100) returning id as allfree \gset
select trc.invoice(:'co', :'una', 40, 'draft') as u2 \gset
update public.invoices set promo_code_id = :'allfree' where id = :'u2';
begin;
set local role authenticated;
select trc.as_user(:'oli');
select trc.check(trc.error_of(format('select public.apply_referral_credit(%L, %L)', :'quill_ref', :'u2')) like '22023: Discounts and credits already cover this invoice''s charges%',
  'apply_referral_credit on an open invoice its discounts cover says there''s no room');
commit;

-- ===== Marketing uninstalled ===================================================================
-- Referrals already made still earn, and credits still go on invoices: the business promised them.
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Max Mute', 'max@example.test', 'active') returning id as max \gset
select trc.refer(:'co', :'max', 'Nell North', 'nell@example.test') as nell_ref \gset
select trc.refer(:'co', :'max', 'Odo Oak', 'odo@example.test') as odo_ref \gset
select trc.invoice(:'co', :'max', 60) as m1 \gset
begin;
set local role authenticated;
select trc.as_user(:'mia');
select public.marketing_set_enabled(:'co', false);
commit;
select trc.check((select settings #>> '{marketing,enabled}' = 'false' from public.companies where id = :'co'), 'Marketing is uninstalled');
select trc.pay(trc.invoice(:'co', trc.friend(:'nell_ref'), 100));
select trc.check((select reward_status from public.referrals where id = :'nell_ref') = 'applied' and trc.on_invoice(:'m1') = 50
  and exists (select 1 from public.activity where verb = 'referral.earned' and data ->> 'referral_id' = :'nell_ref'),
  'a friend paying earns the credit, the office hears, and it goes on Max''s open invoice');
select trc.pay(trc.invoice(:'co', trc.friend(:'odo_ref'), 100));
select trc.check(trc.on_invoice(:'m1') = 60 and trc.credits(:'odo_ref') = 10 and (select reward_status from public.referrals where id = :'odo_ref') = 'earned',
  'the next one fills the invoice, and the rest stays earned');
select trc.invoice(:'co', :'max', 100, 'draft') as m2 \gset
select trc.check(trc.on_invoice(:'m2') = 40 and (select reward_status from public.referrals where id = :'odo_ref') = 'applied',
  'and an invoice made while Marketing is off takes it');
begin;
set local role authenticated;
select trc.as_user(:'mia');
select public.marketing_set_enabled(:'co', true);
commit;

-- ===== Only through the functions ==============================================================
begin;
set local role authenticated;
select trc.as_user(:'mia');
select trc.check(trc.error_of(format('insert into public.referral_credits (company_id, referral_id, invoice_id, amount, note) values (%L, %L, %L, 1, %L)', :'co', :'quin_ref', :'h1', 'x')) like '42501:%'
  and trc.error_of(format('update public.referral_credits set amount = 1 where referral_id = %L', :'quin_ref')) like '42501:%'
  and trc.error_of(format('delete from public.referral_credits where referral_id = %L', :'quin_ref')) like '42501:%'
  and trc.error_of(format('update public.referrals set reward_status = %L where id = %L', 'issued', :'pat_ref')) like '42501:%',
  'even the owner changes credits and referrals only through the functions');
commit;
select trc.check(trc.error_of(format('insert into public.referral_credits (company_id, referral_id, invoice_id, amount, note) values (%L, %L, %L, 100, %L)', :'co', :'pat_ref', :'a5', 'x')) like '22023:%',
  'the guard refuses more than was earned, or an invoice of someone else''s, whoever writes it');
select trc.check(trc.error_of(format('delete from public.referrals where id = %L', :'maria_ref')) = 'none', 'the server can delete a referral whose credit is on a paid invoice');

-- ===== Lost ====================================================================================
select trc.refer(:'co', :'bo', 'Lia Lost', 'lia@example.test') as lia_ref \gset
select trc.friend(:'lia_ref') as lia \gset
update public.requests set status = 'archived' where id = (select request_id from public.referrals where id = :'lia_ref');
select trc.check((select status = 'lost' and lost_at is not null and reward_status = 'none' and no_reward_reason = 'lost' from public.referrals where id = :'lia_ref'),
  'the friend''s request archived: lost, and the credit with it');
update public.requests set status = 'new' where id = (select request_id from public.referrals where id = :'lia_ref');
select trc.check((select status = 'new' and lost_at is null and reward_status = 'pending' from public.referrals where id = :'lia_ref'), 'restored, it''s back');
insert into public.quotes (company_id, client_id, title) values (:'co', :'lia', 'Mowing') returning id as lq1 \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'lia', 'Mulch') returning id as lq2 \gset
update public.quotes set status = 'sent' where id in (:'lq1', :'lq2');
update public.quotes set status = 'lost' where id = :'lq1';
select trc.check((select status from public.referrals where id = :'lia_ref') = 'quoted', 'a lost quote with another open quote stays quoted');
update public.quotes set status = 'lost' where id = :'lq2';
select trc.check((select status = 'lost' and reward_status = 'none' and no_reward_reason = 'lost' from public.referrals where id = :'lia_ref'),
  'the last open quote lost: lost');
insert into public.quotes (company_id, client_id, title) values (:'co', :'lia', 'Edging') returning id as lq3 \gset
update public.quotes set status = 'sent' where id = :'lq3';
select trc.check((select status = 'quoted' and reward_status = 'pending' and no_reward_reason is null from public.referrals where id = :'lia_ref'),
  'a new quote sent brings it back to quoted');
update public.quotes set status = 'lost' where id = :'lq3';
select trc.pay(trc.invoice(:'co', :'lia', 50));
select trc.check((select status = 'won' and reward_status = 'earned' and reward_amount = 50 from public.referrals where id = :'lia_ref'),
  'lost, and then a paid invoice: won and earned');
update public.requests set status = 'archived' where id = (select request_id from public.referrals where id = :'lia_ref');
select trc.check((select status = 'won' and reward_status = 'earned' from public.referrals where id = :'lia_ref'), 'an earned referral isn''t lost');
-- With no credit set: lost, and then the friend pays for a job made without a quote. It's won.
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 0}') where id = :'co';
select trc.refer(:'co', :'bo', 'Nan Noset', 'nan@example.test') as nan_ref \gset
update public.companies set settings = jsonb_set(settings, '{referrals,reward}', '{"kind": "amount", "value": 50}') where id = :'co';
update public.requests set status = 'archived' where id = (select request_id from public.referrals where id = :'nan_ref');
select trc.check((select status = 'lost' and reward_status = 'none' and no_reward_reason = 'not_set' from public.referrals where id = :'nan_ref'), 'a referral with no credit is lost too');
select trc.pay(trc.invoice(:'co', trc.friend(:'nan_ref'), 75));
select trc.check((select status = 'won' and lost_at is null and reward_status = 'none' and no_reward_reason = 'not_set' from public.referrals where id = :'nan_ref'),
  'a paid invoice wins it back, whatever its credit');
-- A lost referral whose friend pays a deposit: won, and the credit waits for the job's invoice.
select trc.refer(:'co', :'bo', 'Dex Deposit', 'dex@example.test') as dex_ref \gset
update public.requests set status = 'archived' where id = (select request_id from public.referrals where id = :'dex_ref');
select trc.pay(trc.invoice(:'co', trc.friend(:'dex_ref'), 100, 'sent', false, 0, 'deposit'));
select trc.check((select status = 'won' and lost_at is null and reward_status = 'pending' and no_reward_reason is null from public.referrals where id = :'dex_ref'),
  'a paid deposit wins a lost referral back, and its credit is still to come');
update public.requests set status = 'new' where id = (select request_id from public.referrals where id = :'dex_ref');
update public.requests set status = 'archived' where id = (select request_id from public.referrals where id = :'dex_ref');
select trc.check((select status from public.referrals where id = :'dex_ref') = 'won', 'and a won referral isn''t lost again');
insert into public.quotes (company_id, client_id, title) values (:'co', trc.friend(:'pip_ref'), 'Hedges') returning id as pq \gset
update public.quotes set status = 'sent' where id = :'pq';
update public.quotes set status = 'approved' where id = :'pq';
select trc.check((select status = 'won' and reward_status = 'pending' from public.referrals where id = :'pip_ref'),
  'a quote approved wins the referral, and the credit waits for the friend to pay');

-- ===== Referrals from before ===================================================================
-- Rows as the old referral page and tab left them: an amount, a reward pending, given, or none.
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Old Friend', 'oldfriend@example.test', 'active') returning id as old_friend \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Quiet Friend', 'quiet@example.test', 'lead') returning id as quiet_friend \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Ana Twin', 'ana@example.test', 'lead') returning id as ana_twin \gset
-- Late Friend was new when referred; a client with the same email (entered again later) had work after.
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Late Friend', 'late@example.test', 'lead') returning id as late_friend \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Late Again', 'late@example.test', 'active') returning id as late_again \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'late_again', 'Gutters');
select trc.invoice(:'co', :'late_again', 60);
-- Dot Direct had a quote lost, then a job made without one, and paid for it.
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Dot Direct', 'dot@example.test', 'active') returning id as dot \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'dot', 'Hedges') returning id as dot_quote \gset
update public.quotes set status = 'sent' where id = :'dot_quote';
update public.quotes set status = 'lost' where id = :'dot_quote';
select trc.pay(trc.invoice(:'co', :'dot', 140));
select trc.invoice(:'co', :'old_friend', 220) as old_inv \gset
select trc.pay(:'old_inv');
select trc.invoice(:'co', :'dee', 500) as dee_open \gset
alter table public.referrals disable trigger referral_defaults;
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name, status, reward_amount, reward_status)
values (:'co', :'dee', :'old_friend', 'Old Friend', 'won', 40, 'pending') returning id as old_won \gset
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name, status, reward_amount, reward_status, reward_issued_at)
values (:'co', :'dee', :'old_friend', 'Old Friend', 'won', 25, 'issued', now()) returning id as old_issued \gset
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name, reward_amount, reward_status)
values (:'co', :'dee', :'quiet_friend', 'Quiet Friend', 30, 'pending') returning id as old_waiting \gset
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name, reward_amount, reward_status)
values (:'co', :'ana', :'ana_twin', 'Ana Twin', 30, 'pending') returning id as old_self \gset
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name, reward_amount, reward_status, created_at)
values (:'co', :'dee', :'late_friend', 'Late Friend', 30, 'pending', now() - interval '30 days') returning id as old_late \gset
alter table public.referrals enable trigger referral_defaults;
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name, status, reward_status)
values (:'co', :'bo', :'dot', 'Dot Direct', 'new', 'none') returning id as old_direct \gset
select trc.check(trc.on_invoice(:'dee_open') = 0, 'before the backfill, nothing is on Dee''s open invoice');
select trc.check(private.backfill_referral_credits() >= 4, 'backfill_referral_credits changes the rows from before');
select trc.check((select reward_status = 'applied' and reward_amount = 40 and reward_kind = 'amount' and reward_value = 40 and earned_invoice_id = :'old_inv'
                         and earned_at = (select received_at from public.payments where invoice_id = :'old_inv')
                    from public.referrals where id = :'old_won'),
  'won and pending, with a paid invoice: earned with its amount, when the friend paid');
select trc.check(trc.credits(:'old_won') = 40 and (select invoice_id from public.referral_credits where referral_id = :'old_won') = :'dee_draft',
  'and it goes on the open draft Dee has now, as one earned today would');
select trc.check((select reward_status = 'issued' and reward_value = 25 and given_amount = 25 from public.referrals where id = :'old_issued')
  and (select reward_status = 'pending' and reward_kind = 'amount' and reward_value = 30 from public.referrals where id = :'old_waiting')
  and (select reward_status = 'none' and no_reward_reason = 'self' from public.referrals where id = :'old_self'),
  'given stays given (all of it), pending gets its terms, and a friend with the referrer''s email earns nothing');
select trc.check((select reward_status = 'pending' and no_reward_reason is null from public.referrals where id = :'old_late'),
  'a client with the friend''s email whose work came after the referral doesn''t make them a client already');
select trc.check((select status = 'won' and reward_status = 'none' from public.referrals where id = :'old_direct'),
  'a referral whose friend has paid an invoice is won, though no quote moved it on');
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name, reward_status) values (:'co', :'dee', :'quiet_friend', 'Quiet Friend', 'none') returning id as none_old \gset
select trc.check((select no_reward_reason from public.referrals where id = :'none_old') = 'not_set', 'a referral made with no credit and no reason has none set');
-- Lost from before: a new referral whose request was archived, with nothing open.
alter table public.requests disable trigger referral_request_archived;
update public.requests set status = 'archived' where id = (select request_id from public.referrals where id = :'unset_ref');
alter table public.requests enable trigger referral_request_archived;
select trc.check(private.backfill_lost_referrals() >= 1, 'backfill_lost_referrals loses referrals');
select trc.check((select status = 'lost' and lost_at is not null from public.referrals where id = :'unset_ref'), 'one whose request was archived, with nothing open');
-- Had Dot's referral not been won by the backfill, her lost quote still wouldn't lose it: she paid.
update public.referrals set status = 'new' where id = :'old_direct';
select private.backfill_lost_referrals();
select trc.check((select status from public.referrals where id = :'old_direct') = 'new', 'a friend who has paid for work isn''t lost');

-- ===== Who reads what ==========================================================================
begin;
set local role authenticated;
select trc.as_user(:'oli');
select trc.check((select count(*) > 0 from public.referrals) and (select count(*) > 0 from public.referral_credits)
  and (select count(*) > 0 from public.activity where verb = 'referral.earned'),
  'the office reads referrals, their credits and the earned activity');
select trc.check((select count(*) = 1 from public.referral_credits_for(:'co', :'tia')), 'referral_credits_for gives the office what''s left of Tia''s credits');
commit;
begin;
set local role authenticated;
select trc.as_user(:'ivy');
select trc.check((select count(*) = 0 from public.referrals) and (select count(*) > 0 from public.referral_credits)
  and (select count(*) = 1 from public.referral_credits_for(:'co', :'tia'))
  and (select friend = 'Vic' and friend_name = 'Vic Vance' and credit_left = 40 and auto_apply from public.referral_credits_for(:'co', :'tia')),
  'Invoices without Marketing: the credits on invoices and what''s left of them, not the referrals');
select trc.check((select count(*) > 0 from public.activity where verb = 'referral.earned'), 'and the earned activity');
select trc.check(trc.error_of(format('select public.referral_stats(%L)', :'co')) like '42501:%'
  and trc.error_of(format('select public.referral_set_given(%L)', :'pat_ref')) like '42501:%'
  and trc.error_of(format('select public.referral_no_reward(%L)', :'pat_ref')) like '42501:%'
  and trc.error_of(format('select public.referral_give_credit(%L)', :'pat_ref')) like '42501:%',
  'and can''t see the numbers or change a referral''s credit');
select trc.check((public.marketing_summary(:'co') ->> 'referral_revenue') is not null, 'marketing_summary''s revenue is theirs to see');
commit;
begin;
set local role authenticated;
select trc.as_user(:'mo');
select trc.check((select count(*) > 0 from public.referrals) and (select count(*) > 0 from public.referral_credits)
  and not exists (select 1 from public.referral_credits_for(:'co', :'tia')),
  'Marketing without Invoices: the referrals and their credits, not the invoice page''s list');
select trc.check(trc.error_of(format('select public.apply_referral_credit(%L, %L)', :'nia_ref', :'a5')) like '42501:%'
  and trc.error_of(format('select public.remove_referral_credit(%L)', (select id from public.referral_credits limit 1))) like '42501:%'
  and trc.error_of(format('select public.referral_auto_apply(%L)', :'nia_ref')) like '42501:%',
  'and can''t put credits on invoices or take them off');
select trc.check((public.referral_stats(:'co') -> 'revenue') = 'null'::jsonb and (public.marketing_summary(:'co') -> 'referral_revenue') = 'null'::jsonb,
  'what referred clients paid is null, not $0, without Invoices');
commit;
begin;
set local role authenticated;
select trc.as_user(:'cal');
select trc.check((select count(*) = 0 from public.referrals) and (select count(*) = 0 from public.referral_credits) and (select count(*) = 0 from public.referral_asks)
  and (select count(*) = 0 from public.referral_credit_skips) and (select count(*) = 0 from public.activity where verb like 'referral.%')
  and not exists (select 1 from public.referral_credits_for(:'co', :'ana')) and public.last_referral_ask(:'co', :'ana') is null,
  'field crew see no referrals, credits, asks or referral activity');
select trc.check(trc.error_of(format('select public.apply_referral_credit(%L, %L)', :'nia_ref', :'a5')) like 'P0002:%'
  and trc.error_of(format('select public.referral_set_given(%L)', :'pat_ref')) like 'P0002:%'
  and trc.error_of(format('select public.referral_stats(%L)', :'co')) like '42501:%',
  'and the functions refuse them');
commit;
begin;
set local role authenticated;
select trc.as_user(:'eve');
select trc.check((select count(*) = 0 from public.activity where verb like 'referral.%') and (select count(*) > 0 from public.activity where verb = 'client.created'),
  'an estimator reads the client activity, but not the referral credits in it');
commit;
begin;
set local role authenticated;
select trc.as_user(:'oz');
select trc.check((select count(*) = 0 from public.referrals) and (select count(*) = 0 from public.referral_credits)
  and not exists (select 1 from public.referral_credits_for(:'co', :'ana')),
  'another business sees none of it');
select trc.check(trc.error_of(format('select public.apply_referral_credit(%L, %L)', :'nia_ref', :'a5')) like 'P0002:%', 'nor applies its credits');
commit;

-- ===== Asks ====================================================================================
select trc.check(not has_function_privilege('authenticated', 'public.begin_referral_ask(uuid, uuid, boolean, integer, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.begin_referral_ask(uuid, uuid, boolean, integer, uuid)', 'execute'),
  'only the server records asks');
select public.begin_referral_ask(:'co', :'ana', true, 182) as ask1 \gset
select trc.check(:'ask1' <> '' and public.begin_referral_ask(:'co', :'ana', true, 182) is null, 'an automatic ask once within 6 months');
select trc.check(public.begin_referral_ask(:'co', :'ana', false, null, :'oli') is not null, 'one by hand isn''t held to it');
select trc.check(public.begin_referral_ask(:'co', :'bo', false, null) is not null and public.begin_referral_ask(:'co', :'bo', true, 182) is null,
  'and counts toward it');
update public.referral_asks set status = 'failed' where client_id = :'cy';
select public.begin_referral_ask(:'co', :'cy', true, 182);
update public.referral_asks set status = 'failed' where client_id = :'cy';
select trc.check(public.begin_referral_ask(:'co', :'cy', true, 182) is not null, 'asks that failed don''t count');
select public.begin_referral_ask(:'co', :'dee', true, 182);
update public.referral_asks set sent_at = now() - interval '200 days' where client_id = :'dee';
select trc.check(public.begin_referral_ask(:'co', :'dee', true, 182) is not null, 'nor ones from before the gap');
-- Two workers asking Kai at the same moment ask once.
select :"dbl".dblink_connect('asker', 'dbname=' || current_database());
begin;
select public.begin_referral_ask(:'co', :'kai', true, 182) is not null as first_asked \gset
select :"dbl".dblink_send_query('asker', format('select public.begin_referral_ask(%L, %L, true, 182)', :'co', :'kai'));
commit;
select (select id from :"dbl".dblink_get_result('asker') as t(id uuid)) is null as second_skipped \gset
select count(*) from :"dbl".dblink_get_result('asker') as t(id uuid);
select :"dbl".dblink_disconnect('asker');
select trc.check(:'first_asked' and :'second_skipped' and (select count(*) = 1 from public.referral_asks where client_id = :'kai'), 'two asks at the same moment ask once');
begin;
set local role authenticated;
select trc.as_user(:'oli');
select trc.check(public.last_referral_ask(:'co', :'ana') is not null and (select count(*) > 0 from public.referral_asks), 'the office reads when a client was last asked');
commit;
begin;
set local role authenticated;
select trc.as_user(:'ivy');
select trc.check(public.last_referral_ask(:'co', :'ana') is null and (select count(*) = 0 from public.referral_asks), 'without Marketing, not');
commit;

-- ===== The starter rule ========================================================================
select trc.check((select count(*) = 1 from public.automation_rules where company_id = :'other' and template_key = 'referral_after_job'),
  'a new business gets the referral_after_job rule');
select trc.check((select not enabled and trigger = 'job.completed' and delay_minutes = 10080 and name = 'Ask for referrals after a job'
                         and conditions = '[{"field": "kind", "op": "not_equals", "value": "recurring"}]' and actions = '[{"type": "request_referral"}]'
                    from public.automation_rules where company_id = :'co' and template_key = 'referral_after_job'),
  'off, a week after a job is completed, not after recurring work, asking for referrals');
delete from public.automation_rules where company_id in (:'co', :'other') and template_key in ('referral_after_job', 'review_after_job');
select trc.check(private.add_referral_rule() >= 2, 'add_referral_rule gives every business without the rule one');
select trc.check((select count(*) = 2 from public.automation_rules where company_id in (:'co', :'other') and template_key = 'referral_after_job' and not enabled)
  and not exists (select 1 from public.automation_rules where company_id in (:'co', :'other') and template_key = 'review_after_job'),
  'off, and it doesn''t bring back a starter rule the business deleted');
select trc.check(private.add_referral_rule() = 0, 'run again, it adds nothing');

-- ===== The numbers =============================================================================
begin;
set local role authenticated;
select trc.as_user(:'sue');
select public.create_company('Stats Lawn', 'lawn_care') as stats \gset
insert into public.clients (company_id, display_name, email, status) values (:'stats', 'Al Adams', 'al@stats.test', 'active') returning id as al \gset
insert into public.clients (company_id, display_name, email, status) values (:'stats', 'Bea Bell', 'bea@stats.test', 'active') returning id as bea \gset
commit;
update public.companies set settings = settings || '{"referrals": {"reward": {"kind": "amount", "value": 50}}}' where id = :'stats';
select trc.refer(:'stats', :'al', 'Fred One', 'f1@stats.test') as f1 \gset
select trc.refer(:'stats', :'al', 'Al Self', 'al@stats.test') as f3 \gset
update public.companies set settings = settings || '{"referrals": {"reward": {"kind": "percent", "value": 10}}}' where id = :'stats';
select trc.refer(:'stats', :'al', 'Fran Two', 'f2@stats.test') as f2 \gset
update public.companies set settings = settings || '{"referrals": {"reward": {"kind": "amount", "value": 30}}}' where id = :'stats';
select trc.refer(:'stats', :'bea', 'Gil Four', 'f4@stats.test') as f4 \gset
update public.companies set settings = settings || '{"referrals": {"reward": {"kind": "amount", "value": 20}}}' where id = :'stats';
select trc.refer(:'stats', :'bea', 'Gia Five', 'f5@stats.test') as f5 \gset
select trc.pay(trc.invoice(:'stats', trc.friend(:'f1'), 200, 'sent', true, 0.1));
select trc.pay(trc.invoice(:'stats', trc.friend(:'f3'), 100));
select trc.invoice(:'stats', :'bea', 100) as bea_inv \gset
select trc.pay(trc.invoice(:'stats', trc.friend(:'f4'), 400));
begin;
set local role authenticated;
select trc.as_user(:'sue');
select public.referral_set_given(:'f5');
select public.referral_stats(:'stats') as stats_now \gset
select public.marketing_summary(:'stats') as summary_now \gset
commit;
select trc.check(trc.friend(:'f3') = :'al', 'Al referring himself is Al');
select trc.check((:'stats_now'::jsonb ->> 'leads')::int = 4 and (:'stats_now'::jsonb ->> 'won')::int = 2 and (:'stats_now'::jsonb ->> 'revenue')::numeric = 600,
  'referral_stats: 4 leads and 2 won (not Al referring himself), and $600 paid by referred clients before tax (Fred''s $20 tax left out)');
select trc.check(:'stats_now'::jsonb -> 'credits' = '{"pending": 0, "pending_count": 1, "pending_percent": 1, "earned": 50, "applied": 30, "given": 20}',
  'credits: one percent still pending, $50 earned, $30 applied and $20 given');
select trc.check((select array_agg(e ->> 'name' order by n) = '{"Bea Bell","Al Adams"}'
                    from jsonb_array_elements(:'stats_now'::jsonb -> 'top_referrers') with ordinality x(e, n))
  and :'stats_now'::jsonb -> 'top_referrers' -> 1 = jsonb_build_object('client_id', :'al', 'name', 'Al Adams', 'referrals', 2, 'won', 1, 'revenue', 200),
  'top referrers: the most won first, then what their friends paid');
select trc.check((:'summary_now'::jsonb ->> 'referrals_total')::int = 4 and (:'summary_now'::jsonb ->> 'referrals_won')::int = 2
  and (:'summary_now'::jsonb ->> 'credits_owed')::numeric = 50 and (:'summary_now'::jsonb ->> 'referral_revenue')::numeric = 600
  and not (:'summary_now'::jsonb ? 'rewards_pending'),
  'marketing_summary: referrals, won, credits owed and what referred clients paid');
begin;
set local role authenticated;
select trc.as_user(:'sue');
select trc.check((public.referral_stats(:'stats', now() + interval '1 day') ->> 'leads')::int = 0
  and (public.referral_stats(:'stats', now() - interval '1 day', now() + interval '1 day') ->> 'leads')::int = 4,
  'referral_stats counts the referrals made in the range');
commit;

-- ===== Cleaning up =============================================================================
-- Deleting a business with credits on invoices, as the server does, goes through.
delete from public.companies where id in (:'co', :'stats', :'other');
select trc.check(not exists (select 1 from public.referral_credits where company_id in (:'co', :'stats'))
  and not exists (select 1 from public.referrals where company_id in (:'co', :'stats')),
  'deleting a business takes its referrals and credits with it');
delete from auth.users where id in (:'mia', :'oli', :'ivy', :'mo', :'cal', :'eve', :'oz', :'sue');
set client_min_messages = warning;
drop schema trc cascade;
reset client_min_messages;

\o
\echo 'All referral tests passed.'
