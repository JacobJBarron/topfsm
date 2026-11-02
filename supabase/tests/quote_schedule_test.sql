-- Database tests for a quote that says how often (weekly mowing): converting it makes a recurring
-- job billed per visit, with its schedule, and a first visit that went by while the client decided
-- moves to today. A quote without one still makes a one-off job.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tqs;
grant usage on schema tqs to authenticated, service_role;

create function tqs.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;
grant execute on all functions in schema tqs to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('f5000000-0000-0000-0000-000000000001', 'owner@mow.test', '{"full_name": "Mo Owner"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f5000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Mow Masters', 'landscaping') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Joshua Viars') returning id as client \gset

-- ===== How often carries onto the job ========================================================
insert into public.quotes (company_id, client_id, title, recurrence_rule, active_months, starts_on, ends_on)
  values (:'co', :'client', 'Mowing', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', '{4,5,6,7,8,9,10}', '2099-04-07', '2099-10-31') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'quote', 'Mow', 1, 'visit', 55);
select public.convert_quote_to_job(:'quote') as job \gset
select tqs.check((select kind = 'recurring' and billing_mode = 'per_visit' from public.jobs where id = :'job'), 'a quote that repeats becomes a recurring job billed per visit');
select tqs.check((select recurrence_rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' and active_months = '{4,5,6,7,8,9,10}' from public.jobs where id = :'job'), 'with how often and its season');
select tqs.check((select starts_on = '2099-04-07' and ends_on = '2099-10-31' from public.jobs where id = :'job'), 'and its first and last dates');
select tqs.check((select contract_total from public.job_financials where job_id = :'job') = 55, 'its price is the price of a visit');

-- ===== A first visit already gone by is today ================================================
insert into public.quotes (company_id, client_id, title, recurrence_rule, starts_on)
  values (:'co', :'client', 'Weekly mowing', 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO', '2000-01-03') returning id as late \gset
select public.convert_quote_to_job(:'late') as late_job \gset
select tqs.check((select starts_on from public.jobs where id = :'late_job') = (select (now() at time zone coalesce(timezone, 'UTC'))::date from public.companies where id = :'co'), 'a first visit that went by moves to today');
insert into public.quotes (company_id, client_id, title, recurrence_rule) values (:'co', :'client', 'Leaf pickup', 'FREQ=WEEKLY;INTERVAL=1;BYDAY=FR') returning id as undated \gset
select public.convert_quote_to_job(:'undated') as undated_job \gset
select tqs.check((select starts_on from public.jobs where id = :'undated_job') = (select (now() at time zone coalesce(timezone, 'UTC'))::date from public.companies where id = :'co'), 'and one without a first visit starts today');

-- ===== One time stays one-off ================================================================
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Spring cleanup') returning id as once \gset
select public.convert_quote_to_job(:'once') as once_job \gset
select tqs.check((select kind = 'one_off' and billing_mode = 'on_completion' and recurrence_rule is null and starts_on is null from public.jobs where id = :'once_job'), 'a one-time quote still makes a one-off job');
commit;

\echo 'All quote schedule tests passed.'
