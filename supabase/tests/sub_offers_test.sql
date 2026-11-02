-- Database tests for job offers to subs (20261025004001_sub_offers.sql, 20261025004002_sub_pay_seams.sql):
-- sending, changing and taking back an offer, and who can; what a sub sees before they take it; taking
-- it or turning it down (another sub, another company, the team, a turned-off sub or sign-in, too late,
-- a changed offer, two answers at once); the agreed price coming back when a new one is turned down,
-- runs out or is taken back; offers running out; the insurance warning; who hears, and the activity;
-- a sign-in given later joining the visits, and nobody the office took off one put back; owed and paid
-- notices; job costs and the workers' comp audit while a new price waits; the office agreeing an offer;
-- the offer locked while it waits; follow-ups called off; and My jobs' list and totals for a busy sub.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1090;
grant usage on schema t1090 to authenticated, service_role;
create function t1090.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1090.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- The error a statement raises ("<sqlstate>: <message>"), or 'none'.
create function t1090.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1090.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
-- As p_who, sending, changing and taking back p_pay are each refused (not found, or not allowed).
create function t1090.refused_office(p_who uuid, p_pay uuid, p_what text) returns void language plpgsql as $$
declare q text; e text;
begin
  perform t1090.as_user(p_who);
  foreach q in array array[
    format('select public.send_sub_offer(%L)', p_pay),
    format('select public.change_sub_offer(%L, %L)', p_pay, '[{"description": "More", "quantity": 1, "rate": 5000}]'),
    format('select public.withdraw_sub_offer(%L)', p_pay)
  ] loop
    e := t1090.error_of(q);
    perform t1090.check(e like 'P0002:%' or e like '42501:%', p_what || ': ' || q || ' is refused (' || e || ')');
  end loop;
end $$;
-- The 'jobs' notices someone has about a pay, newest last (whoever asks).
create function t1090.told(p_user uuid, p_pay uuid) returns text[] language sql security definer as $$
  select coalesce(array_agg(title order by created_at, id), '{}') from public.notifications where user_id = p_user and kind = 'jobs' and link = '/field/jobs/' || p_pay
$$;
-- Who in the office heard something, by name.
create function t1090.office_heard(p_title text) returns text[] language sql as $$
  select coalesce(array_agg(pr.full_name order by pr.full_name), '{}') from public.notifications n join public.profiles pr on pr.user_id = n.user_id
  where n.kind = 'subs' and n.title = p_title
$$;
-- Whether the other connection (its pid) is held up waiting on this one, given up to 10 seconds to get
-- there: a race test that only slept could pass without the race happening.
create function t1090.waiting_on_me(p_pid integer) returns boolean language plpgsql as $$
begin
  for i in 1..200 loop
    if pg_blocking_pids(p_pid) @> array[pg_backend_pid()] then return true; end if;
    perform pg_sleep(0.05);
  end loop;
  return false;
end $$;
grant execute on all functions in schema t1090 to authenticated, service_role;
-- A second connection, to answer and run the upkeep at the same moment as this one.
set client_min_messages = warning;
create extension if not exists dblink schema t1090;
reset client_min_messages;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset

\set rita 'd1090000-0000-0000-0000-000000000001'
\set olga 'd1090000-0000-0000-0000-000000000002'
\set pam 'd1090000-0000-0000-0000-000000000003'
\set ed 'd1090000-0000-0000-0000-000000000004'
\set lou 'd1090000-0000-0000-0000-000000000005'
\set cy 'd1090000-0000-0000-0000-000000000006'
\set al 'd1090000-0000-0000-0000-000000000007'
\set abe 'd1090000-0000-0000-0000-000000000008'
\set bo 'd1090000-0000-0000-0000-000000000009'
\set dee 'd1090000-0000-0000-0000-00000000000a'
\set sam 'd1090000-0000-0000-0000-00000000000b'
\set bea 'd1090000-0000-0000-0000-00000000000c'
\set ada 'd1090000-0000-0000-0000-00000000000d'
\set ari 'd1090000-0000-0000-0000-00000000000e'
\set ace 'd1090000-0000-0000-0000-00000000000f'
\set apex 'd1090000-0000-0000-0000-0000000000c1'
\set birch 'd1090000-0000-0000-0000-0000000000c2'
\set cedar 'd1090000-0000-0000-0000-0000000000c3'
\set dune 'd1090000-0000-0000-0000-0000000000c4'
\set sierrasub 'd1090000-0000-0000-0000-0000000000c9'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'rita', 'rita@romeo.test', '{"full_name": "Rita Owner"}'),
  (:'olga', 'olga@romeo.test', '{"full_name": "Olga Office"}'),
  (:'pam', 'pam@romeo.test', '{"full_name": "Pam Payroll"}'),
  (:'ed', 'ed@romeo.test', '{"full_name": "Ed Estimator"}'),
  (:'lou', 'lou@romeo.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@romeo.test', '{"full_name": "Cy Crew"}'),
  (:'al', 'al@apex.test', '{"full_name": "Al Apex"}'),
  (:'abe', 'abe@apex.test', '{"full_name": "Abe Apex"}'),
  (:'bo', 'bo@birch.test', '{"full_name": "Bo Birch"}'),
  (:'dee', 'dee@dune.test', '{"full_name": "Dee Dune"}'),
  (:'sam', 'sam@sierra.test', '{"full_name": "Sam Sierra"}'),
  (:'bea', 'bea@birch.test', '{"full_name": "Bea Birch"}'),
  (:'ada', 'ada@romeo.test', '{"full_name": "Ada Admin"}'),
  (:'ari', 'ari@apex.test', '{"full_name": "Ari Apex"}'),
  (:'ace', 'ace@apex.test', '{"full_name": "Ace Apex"}');

-- ===== Romeo Roofing, in New York ==============================================================
-- Rita owns it, Ada is an admin, Olga is in the office with everything an office has, Pam does
-- payroll (no subs area), Ed estimates, Lou leads the crew with Cy on it. Apex Roofing signs in as Al
-- and as Abe, its foreman; Birch Gutters as Bo; Cedar Siding doesn't sign in; Dune Paving's sign-in
-- (Dee) has been taken away. The Smith roof is 24 squares at 12 Oak St in Dover.
begin;
set local role authenticated;
select t1090.as_user(:'rita');
select public.create_company('Romeo Roofing', 'roofing', 'America/New_York') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Payroll clerk', 'office', '{job_costs,timesheets}') returning id as clerk_role \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'olga', 'office', null), (:'co', :'pam', 'office', :'clerk_role'), (:'co', :'ed', 'estimator', null),
  (:'co', :'lou', 'crew_lead', null), (:'co', :'cy', 'field_crew', null), (:'co', :'ada', 'admin', null);
set local role authenticated;
insert into public.subcontractors (id, company_id, name, contact_name, phone) values
  (:'apex', :'co', 'Apex Roofing', 'Al Apex', '+15405550107'),
  (:'birch', :'co', 'Birch Gutters', 'Bo Birch', '+15405550109'),
  (:'cedar', :'co', 'Cedar Siding', null, null),
  (:'dune', :'co', 'Dune Paving', 'Dee Dune', null);
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Roofing', :'lou') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', :'cy');
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'Architectural shingles', 'sq', 450, 300) returning id as shingles \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'Seamless gutters', 'lf', 12, 5) returning id as gutters \gset
insert into public.clients (company_id, display_name, phone) values (:'co', 'Ann Smith', '+15405550150') returning id as client \gset
insert into public.properties (company_id, client_id, line1, city, region) values (:'co', :'client', '12 Oak St', 'Dover', 'DE') returning id as p1 \gset
insert into public.properties (company_id, client_id, line1, city, region) values (:'co', :'client', '4 Elm Rd', 'Milford', 'DE') returning id as p2 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'p1', 'Smith roof') returning id as j1 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'p2', 'Jones gutters') returning id as j2 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'p1', 'Brown porch') returning id as j3 \gset
insert into public.job_line_items (company_id, job_id, service_id, name, quantity, unit, unit_price, sort) values
  (:'co', :'j1', :'shingles', 'Architectural shingles', 24, 'sq', 450, 1), (:'co', :'j1', null, 'Ridge vent', 30, 'lf', 10, 2),
  (:'co', :'j1', null, 'Discount', 1, 'ea', -200, 3), (:'co', :'j2', :'gutters', 'Seamless gutters', 120, 'lf', 12, 1),
  (:'co', :'j3', :'shingles', 'Architectural shingles', 10, 'sq', 450, 1);
select private.company_today(:'co') as today \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on, starts_at) values
  (:'co', :'j1', :'p1', 'Tear off', :'today'::date + 5, ((:'today'::date + 5) + time '08:00') at time zone 'America/New_York') returning id as v1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'p1', 'Shingle', :'today'::date + 6) returning id as v2 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'p1', 'Rain day', :'today'::date + 7) returning id as vx \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j2', :'p2', 'Hang gutters', :'today'::date + 3) returning id as v3 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j3', :'p1', 'Porch roof', :'today'::date + 1) returning id as v4 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j3', :'p1', 'Porch trim', :'today'::date + 2) returning id as v5 \gset
-- Apex: liability good for a year, workers' comp ending before the roof's second day. Birch sent its
-- liability certificate by link (not checked yet) and has no workers' comp on file.
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', :'apex', 'w9', :'co' || '/subs/' || :'apex' || '/w9.pdf', null),
  (:'co', :'apex', 'liability', :'co' || '/subs/' || :'apex' || '/gl.pdf', :'today'::date + 400),
  (:'co', :'apex', 'workers_comp', :'co' || '/subs/' || :'apex' || '/wc.pdf', :'today'::date + 4);
insert into public.pay_rates (company_id, subcontractor_id, basis, service_id, rate) values
  (:'co', :'apex', 'per_unit', :'shingles', 85), (:'co', :'birch', 'per_unit', :'gutters', 5);
insert into public.pay_rates (company_id, user_id, basis, rate) values (:'co', :'cy', 'per_job', 150);
commit;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on, uploaded_via) values
  (:'co', :'birch', 'liability', :'co' || '/subs/' || :'birch' || '/gl.pdf', :'today'::date + 200, 'link');
-- Other tests run the paperwork reminders for every company: these count as sent already.
update public.sub_documents set alerted_state = private.sub_alert_due(expires_on - private.company_today(company_id)) where company_id = :'co' and expires_on is not null;

-- Sierra Paving: another business, with a sub of its own.
begin;
set local role authenticated;
select t1090.as_user(:'sam');
select public.create_company('Sierra Paving', 'paving', 'America/New_York') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Sierra client') returning id as sc \gset
insert into public.jobs (company_id, client_id, title) values (:'other', :'sc', 'Driveway') returning id as sj \gset
insert into public.subcontractors (id, company_id, name) values (:'sierrasub', :'other', 'Sierra''s sub');
select public.job_pay_start(:'sj', :'sierrasub', null, '{}') as sierra_pay \gset
commit;

-- The sign-ins, as the server makes them.
insert into public.memberships (company_id, user_id, role, subcontractor_id) values
  (:'co', :'al', 'subcontractor', :'apex'), (:'co', :'abe', 'subcontractor', :'apex'),
  (:'co', :'bo', 'subcontractor', :'birch'), (:'co', :'dee', 'subcontractor', :'dune');
update public.memberships set active = false where user_id = :'dee';

-- The office's drafts: Apex on the roof's three visits, Birch on the gutters, Cedar and Dune (who
-- can't sign in) on the gutters too, and Cy's piece pay on the roof. The rain day is cancelled.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.job_pay_start(:'j1', :'apex', null, array[:'v1', :'v2', :'vx']::uuid[]) as pay \gset
select public.job_pay_start(:'j2', :'birch', null, array[:'v3']::uuid[]) as bpay \gset
select public.job_pay_start(:'j2', :'cedar', null, array[:'v3']::uuid[]) as cpay \gset
select public.job_pay_start(:'j2', :'dune', null, array[:'v3']::uuid[]) as dpay \gset
select public.job_pay_start(:'j1', null, :'cy') as cy_pay \gset
insert into public.job_pay_lines (company_id, job_pay_id, description, rate) values (:'co', :'cpay', 'Siding the gable', 400), (:'co', :'dpay', 'Patch', 300);
update public.visits set status = 'cancelled' where id = :'vx';
commit;
delete from public.notifications;

\o
\echo 'Sending offers'
\o /dev/null

-- ===== Sending ==================================================================================
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check((select total = 2040 from public.job_pay where id = :'pay'), 'Apex''s draft: 24 squares at $85');
select t1090.check(t1090.error_of(format('select public.send_sub_offer(%L)', :'cpay')) = '22023: Give them a sign-in first, or agree it with them and press Agree.',
  'a sub without a sign-in can''t be sent an offer: the office agrees it with them instead');
select t1090.check(t1090.error_of(format('select public.send_sub_offer(%L)', :'dpay')) = '22023: Give them a sign-in first, or agree it with them and press Agree.',
  'nor one whose sign-in was taken away');
select t1090.check(t1090.error_of(format('select public.send_sub_offer(%L)', :'cy_pay')) like '22023: Offers are for subs.%', 'piece pay isn''t offered');
commit;
-- A sub the office has turned off isn't sent one either, though its sign-ins are still on.
begin;
update public.subcontractors set active = false where id = :'apex';
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check(t1090.error_of(format('select public.send_sub_offer(%L)', :'pay')) = '22023: Give them a sign-in first, or agree it with them and press Agree.',
  'nor a sub the office turned off, with its sign-ins still on');
rollback;
-- Cedar, agreed by phone: what's wrong with its insurance is recorded as an offer would, and a new
-- price isn't sent to a sub who doesn't sign in.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check((select array_agg((i ->> 'requirement') || '=' || (i ->> 'problem') order by n) = '{liability=missing,workers_comp=missing}'
  from public.job_pay_accept(:'cpay') p, jsonb_array_elements(p.insurance_warning) with ordinality as x(i, n)),
  'agreeing a sub''s draft records what was wrong with their insurance: Cedar has none on file');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'cpay', '[{"description": "Siding the gable", "rate": 450}]'))
  = '22023: Give them a sign-in first, or agree the new price with them and change the lines yourself.', 'a new price for a sub without a sign-in is agreed by changing the lines');
rollback;
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.job_pay_start(:'j3', :'birch', null, '{}') as empty_pay \gset
select t1090.check(t1090.error_of(format('select public.send_sub_offer(%L)', :'empty_pay')) = '22023: Add what you''ll pay them first.', 'an offer of nothing isn''t sent');
select t1090.check(t1090.error_of(format('select public.send_sub_offer(%L, now() - interval %L)', :'pay', '1 minute')) like '22023: Pick a time to answer by that''s still to come.%',
  'the time to answer by is still to come');
select t1090.check(t1090.error_of(format('select public.send_sub_offer(%L, now() + interval %L)', :'pay', '91 days')) like '22023: Give them at most 90 days%', 'and not months away');
rollback;

-- Who else can't send, change or take back Apex's offer.
begin;
set local role authenticated;
select t1090.refused_office(:'pam', :'pay', 'the office without the subs area');
select t1090.refused_office(:'ed', :'pay', 'an estimator');
select t1090.refused_office(:'lou', :'pay', 'a crew lead');
select t1090.refused_office(:'cy', :'pay', 'field crew');
select t1090.refused_office(:'al', :'pay', 'the sub themselves');
select t1090.refused_office(:'sam', :'pay', 'another company''s owner');
select t1090.refused_office(:'olga', :'sierra_pay', 'Romeo''s office, for another company''s pay');
rollback;

-- A rule that chases an offer four hours after it's sent, if it's still waiting by then.
insert into public.automation_rules (company_id, name, trigger, delay_minutes, actions)
values (:'co', 'Chase an offer', 'sub_offer.sent', 240, '[{"type": "notify", "roles": ["owner"], "title": "No answer yet on {{title}}"}]');
-- The follow-ups waiting for a pay's offers.
create function t1090.chases(p_pay uuid) returns text[] language sql as $$
  select coalesce(array_agg(r.status || coalesce(': ' || r.error, '') order by r.id), '{}') from public.automation_runs r
  join public.automation_rules ru on ru.id = r.rule_id join public.activity a on a.id = r.activity_id
  where ru.trigger = 'sub_offer.sent' and a.data ->> 'job_pay_id' = p_pay::text
$$;
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check((select status = 'offered' and offer_round = 1 and offered_by = :'olga' and offered_at > now() - interval '1 minute'
    and respond_by > now() + interval '47 hours' and offer_outcome is null
  from public.send_sub_offer(:'pay', now() + interval '2 days')), 'the office sends Apex the offer, answer within two days');
select t1090.check(t1090.error_of(format('select public.send_sub_offer(%L)', :'pay')) = '22023: This offer is already out, waiting for their answer.', 'once');
select t1090.check(t1090.error_of(format('update public.job_pay_lines set rate = 90 where job_pay_id = %L', :'pay')) = '22023: Change pay while it''s a draft or agreed.',
  'its price is as sent while it waits');
select t1090.check(t1090.error_of(format('select public.job_pay_cancel(%L)', :'pay')) = '22023: This offer is still waiting for their answer. Withdraw it instead.',
  'an offer waiting for an answer is taken back, not cancelled');
select t1090.check(t1090.error_of(format('update public.job_pay set notes = %L where id = %L', 'Bring a dumpster', :'pay')) = '22023: Withdraw the offer to change it.',
  'its notes are as sent too');
select t1090.check(t1090.error_of(format('delete from public.job_pay_visits where job_pay_id = %L and visit_id = %L', :'pay', :'v2'))
  = '22023: This offer went out for the visits it covers. Withdraw it to change them.', 'and the visits it covers: none taken out');
select t1090.check(t1090.error_of(format('insert into public.job_pay_visits (company_id, job_pay_id, visit_id) values (%L, %L, %L)', :'co', :'pay', :'vx'))
  = '22023: This offer went out for the visits it covers. Withdraw it to change them.', 'or added');
commit;
-- A visit deleted from the schedule still comes out of it, with the database.
begin;
delete from public.visits where id = :'v2';
select t1090.check((select status from public.job_pay where id = :'pay') = 'offered'
  and (select array_agg(visit_id order by visit_id) from public.job_pay_visits where job_pay_id = :'pay') = (select array_agg(x order by x) from unnest(array[:'v1', :'vx']::uuid[]) x),
  'a covered visit deleted from the schedule comes out of the offer');
rollback;
select t1090.check(t1090.chases(:'pay') = '{pending}', 'and the chase is waiting');
-- The rest of the office: Rita sends Birch theirs, with no time to answer by.
begin;
set local role authenticated;
select t1090.as_user(:'rita');
select t1090.check((select status = 'offered' and respond_by is null from public.send_sub_offer(:'bpay')), 'the owner sends Birch theirs, with no time limit');
commit;

-- The insurance warning: what was wrong as each went out. It warned; nothing stopped them.
select t1090.check((select jsonb_array_length(insurance_warning) = 1 and insurance_warning -> 0 ->> 'requirement' = 'workers_comp'
    and insurance_warning -> 0 ->> 'problem' = 'ends_before_work' and insurance_warning -> 0 ->> 'kind' = 'workers_comp'
    and (insurance_warning -> 0 ->> 'expires_on')::date = :'today'::date + 4 and (insurance_warning -> 0 ->> 'work_until')::date = :'today'::date + 6
  from public.job_pay where id = :'pay'), 'Apex''s workers'' comp ends before the roof''s last day (the cancelled rain day doesn''t count)');
select t1090.check((select array_agg((i ->> 'requirement') || '=' || (i ->> 'problem') order by n) = '{liability=unverified,workers_comp=missing}'
  from public.job_pay, jsonb_array_elements(insurance_warning) with ordinality as x(i, n) where id = :'bpay'),
  'Birch''s liability certificate hasn''t been checked, and it has no workers'' comp on file');

-- Who heard: Apex's two sign-ins, about the job, its days, the work and the price.
select format('Smith roof, %s to %s, 24 squares, $2,040. Answer by %s. Open Crewtavo to accept or decline.',
  to_char(:'today'::date + 5, 'Dy Mon FMDD'), to_char(:'today'::date + 6, 'Dy Mon FMDD'),
  (select to_char(respond_by at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MI AM') from public.job_pay where id = :'pay')) as offer_title \gset
select t1090.check(t1090.told(:'al', :'pay') = array[:'offer_title'] and t1090.told(:'abe', :'pay') = array[:'offer_title'], 'both of Apex''s sign-ins hear: ' || :'offer_title');
select t1090.check((select title like '% Answer by ___ ___ %, %:__ _M. Open %' and body = 'New job offer.' from public.notifications where user_id = :'al' and kind = 'jobs'),
  'with when to answer by in the title (a text carries only the title), in the company''s time');
select t1090.check(not exists (select 1 from public.notifications where kind = 'jobs' and user_id not in (:'al', :'abe', :'bo')),
  'not the office, the crew or a sub whose sign-in was taken away');
select t1090.check((select title from public.notifications where user_id = :'bo' and kind = 'jobs') = 'Jones gutters, ' || to_char(:'today'::date + 3, 'Dy Mon FMDD') || ', 120 lf, $600. Open Crewtavo to accept or decline.'
  and (select body from public.notifications where user_id = :'bo' and kind = 'jobs') = 'New job offer.', 'Birch hears about theirs, with no time to answer by');
select t1090.check((select row(subject_type, subject_id, summary, data ->> 'job_pay_id', data ->> 'insurance_warning')::text from public.activity where verb = 'sub_offer.sent' and subject_id = :'j1')
  = row('job', :'j1', 'Smith roof offered to Apex Roofing ($2,040)', :'pay', 'true')::text, 'the activity sub_offer.sent, on the job, for automations');
select t1090.check((select column_default like '%jobs%' from information_schema.columns where table_name = 'notification_prefs' and column_name = 'sms'),
  'offers come by text too, unless the sub turns it off');

\o
\echo 'What a sub sees before taking it'
\o /dev/null

-- ===== My offers ================================================================================
begin;
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check((select count(*) from public.my_sub_offers()) = 1, 'Al sees one offer: Apex''s');
select t1090.check((select count(*) from public.my_sub_offers(true, :'co')) = 1 and not exists (select 1 from public.my_sub_offers(true, :'other')),
  'at Romeo, and none at another company');
select t1090.check((select row(id, company_id, job_id, job_title, city, region, status, is_change, can_answer, total, offer_round)::text from public.my_sub_offers())
  = row(:'pay'::uuid, :'co'::uuid, :'j1'::uuid, 'Smith roof', 'Dover', 'DE', 'offered', false, true, 2040.00, 1)::text, 'the job''s title, its town, and the price');
select t1090.check((select to_jsonb(o)::text not like '%Oak St%' and to_jsonb(o)::text not like '%Ann Smith%' from public.my_sub_offers() o),
  'not the street address or the client');
select t1090.check((select array(select (v ->> 'scheduled_on')::date from jsonb_array_elements(visits) v) = array[:'today'::date + 5, :'today'::date + 6]
    and visits -> 0 ->> 'starts_at' is not null from public.my_sub_offers()), 'the dates and times of the visits it covers (not the cancelled one)');
select t1090.check((select array(select s ->> 'name' from jsonb_array_elements(scope) s) = '{"Architectural shingles","Ridge vent"}'
    and (select array_agg(distinct k order by k) from jsonb_array_elements(scope) s, jsonb_object_keys(s) k) = '{description,name,quantity,unit}'
    and (scope -> 0 ->> 'quantity')::numeric = 24 from public.my_sub_offers()), 'the work, without the discount or any price');
select t1090.check((select jsonb_array_length(lines) = 1 and lines -> 0 ->> 'description' = 'Architectural shingles' and (lines -> 0 ->> 'amount')::numeric = 2040
    and agreed_total is null from public.my_sub_offers()), 'their own line');
select t1090.check((select insurance_warning from public.my_sub_offers()) = array['Your workers'' comp certificate on file ends before this job.'],
  'and the warning, in their words');
select t1090.check(not exists (select 1 from public.jobs) and not exists (select 1 from public.properties) and not exists (select 1 from public.visits),
  'the job, its address and its visits stay closed until they take it');
select t1090.check((select status from public.job_pay) = 'offered', 'though they read the pay itself, as before');
select t1090.check(not exists (select 1 from public.my_sub_pay_totals(:'other')) and (select row(paid, payments, owed)::text from public.my_sub_pay_totals(:'co')) = row(0, 0, 0)::text,
  'nothing paid or owed yet, and nothing for another company');
select t1090.as_user(:'abe');
select t1090.check((select array_agg(id) from public.my_sub_offers()) = array[:'pay']::uuid[], 'Abe, Apex''s other sign-in, sees the same');
select t1090.as_user(:'bo');
select t1090.check((select array_agg(id) from public.my_sub_offers()) = array[:'bpay']::uuid[]
    and (select insurance_warning from public.my_sub_offers()) = array['We haven''t checked the liability insurance you sent yet.', 'We don''t have your workers'' comp certificate or exemption on file.'],
  'Bo sees only Birch''s, with what''s wrong with its paperwork');
select t1090.as_user(:'olga');
select t1090.check(not exists (select 1 from public.my_sub_offers(true)) and not exists (select 1 from public.my_sub_pay_totals(:'co')), 'the office has no offers or pay of its own');
select t1090.as_user(:'cy');
select t1090.check(not exists (select 1 from public.my_sub_offers(true)), 'nor the crew');
select t1090.as_user(:'sam');
select t1090.check(not exists (select 1 from public.my_sub_offers(true)), 'nor another company''s owner');
select t1090.as_user(:'dee');
select t1090.check(not exists (select 1 from public.my_sub_offers(true)), 'nor a sub whose sign-in was taken away');
select set_config('request.jwt.claims', jsonb_build_object('sub', :'al', 'role', 'authenticated', 'client_id', 'claude')::text, true);
select t1090.check(not exists (select 1 from public.my_sub_offers(true)), 'nor an AI assistant on a sub''s account');
rollback;

-- Birch sends in workers' comp: the warning they see now says so; the one recorded stays as it was.
begin;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on, uploaded_via) values
  (:'co', :'birch', 'workers_comp', :'co' || '/subs/' || :'birch' || '/wc.pdf', :'today'::date + 300, 'link');
set local role authenticated;
select t1090.as_user(:'bo');
select t1090.check((select insurance_warning from public.my_sub_offers()) = array['We haven''t checked the liability insurance you sent yet.', 'We haven''t checked the workers'' comp certificate you sent yet.'],
  'what''s wrong now, for the sub');
select t1090.check((select insurance_warning -> 1 ->> 'problem' from public.job_pay where id = :'bpay') = 'missing', 'and what was wrong when it went out, on the record');
rollback;

\o
\echo 'Answering'
\o /dev/null

-- ===== Who can't answer =========================================================================
begin;
set local role authenticated;
select t1090.as_user(:'bo');
select t1090.check(not public.answer_sub_offer(:'pay', true), 'another sub can''t take Apex''s offer');
select t1090.as_user(:'olga');
select t1090.check(not public.answer_sub_offer(:'pay', true), 'nor the office (it agrees one by phone with Agree)');
select t1090.as_user(:'rita');
select t1090.check(not public.answer_sub_offer(:'pay', false), 'nor the owner');
select t1090.as_user(:'cy');
select t1090.check(not public.answer_sub_offer(:'pay', true), 'nor the crew');
select t1090.as_user(:'sam');
select t1090.check(not public.answer_sub_offer(:'pay', true), 'nor another company''s owner');
select t1090.as_user(:'dee');
select t1090.check(not public.answer_sub_offer(:'dpay', true), 'nor a sub whose sign-in was taken away, for their own pay');
select t1090.as_user(:'al');
select t1090.check(not public.answer_sub_offer(:'bpay', true), 'Al can''t answer Birch''s');
select t1090.check(not public.answer_sub_offer(:'pay', true, null, 2), 'or answer an offer other than the one he saw');
select t1090.check(not public.answer_sub_offer(:'pay', true, null, 1, :'other'), 'or answer it as another company''s');
select t1090.check(t1090.error_of(format('select public.answer_sub_offer(%L, null)', :'pay')) = '22023: Accept it or decline it.', 'an answer is yes or no');
select t1090.check(t1090.error_of(format('select public.answer_sub_offer(%L, false, %L)', :'pay', repeat('x', 501))) like '22023: Keep the reason short%', 'and a reason is short');
select set_config('request.jwt.claims', jsonb_build_object('sub', :'al', 'role', 'authenticated', 'client_id', 'claude')::text, true);
select t1090.check(not public.answer_sub_offer(:'pay', true), 'and an AI assistant on Al''s account can''t answer for him');
rollback;
-- A sub the office has turned off can't, either.
begin;
update public.subcontractors set active = false where id = :'apex';
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check(not public.answer_sub_offer(:'pay', true) and not exists (select 1 from public.my_sub_offers()), 'a sub the office turned off neither sees nor answers it');
rollback;
select t1090.check((select status = 'offered' and answered_at is null from public.job_pay where id = :'pay'), 'it''s still waiting');
select t1090.check(not has_function_privilege('anon', 'public.answer_sub_offer(uuid, boolean, text, integer, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.my_sub_offers(boolean, uuid)', 'execute') and not has_function_privilege('anon', 'public.my_sub_pay_totals(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.send_sub_offer(uuid, timestamptz)', 'execute'),
  'nobody signed out can answer or see offers');

-- ===== Two answers at the same moment ===========================================================
-- Abe takes it; Al, on his own phone at the same moment, turns it down. Al's answer waits for Abe's,
-- then finds it taken.
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
select pid as other_pid from :"dbl".dblink('other', 'select pg_backend_pid()') as t(pid integer) \gset
select :"dbl".dblink_exec('other', 'begin');
select :"dbl".dblink_exec('other', 'set local role authenticated');
select :"dbl".dblink_exec('other', format('set local request.jwt.claims = %L', jsonb_build_object('sub', :'al', 'role', 'authenticated')::text));
begin;
set local role authenticated;
select t1090.as_user(:'abe');
select public.answer_sub_offer(:'pay', true, null, 1) as first_answer \gset
reset role;
select :"dbl".dblink_send_query('other', format('select public.answer_sub_offer(%L, false, %L, 1)', :'pay', 'Too far'));
select t1090.check(t1090.waiting_on_me(:other_pid), 'Al''s answer waits for Abe''s');
commit;
select answered as second_answer from :"dbl".dblink_get_result('other') as t(answered boolean) \gset
select count(*) from :"dbl".dblink_get_result('other') as t(answered boolean);
select :"dbl".dblink_exec('other', 'commit');
select :"dbl".dblink_disconnect('other');
select t1090.check(:'first_answer'::boolean and not :'second_answer'::boolean, 'the first answer counts, and the second gets false');
select t1090.check((select row(status, offer_outcome, answered_by, decline_reason)::text from public.job_pay where id = :'pay') = row('accepted', 'accepted', :'abe'::uuid, null::text)::text,
  'taken by Abe; Al''s "no" didn''t land');
select t1090.check((select array_agg(verb) from public.activity where subject_id = :'j1' and verb like 'sub_offer.%' and verb <> 'sub_offer.sent') = '{sub_offer.accepted}',
  'one answer recorded: sub_offer.accepted');
select t1090.check(t1090.chases(:'pay') = '{"cancelled: The sub took the offer."}', 'and the chase is called off');

-- ===== Taken =====================================================================================
select t1090.check((select count(*) from public.visit_assignees where user_id in (:'al', :'abe')) = 4
  and (select count(*) from public.visit_assignees where user_id in (:'al', :'abe') and visit_id in (:'v1', :'v2')) = 4,
  'Apex''s sign-ins go on the visits it covers (not the cancelled one)');
select t1090.check((select bool_and(assigned @> array[:'al', :'abe']::uuid[]) from public.job_pay_visits where job_pay_id = :'pay' and visit_id in (:'v1', :'v2')),
  'noted on the pay, so cancelling it takes them off again');
select t1090.check((select (accepted_snapshot ->> 'total')::numeric = 2040 and jsonb_array_length(accepted_snapshot -> 'lines') = 1 from public.job_pay where id = :'pay'),
  'what they agreed is kept');
select t1090.check(t1090.office_heard('Apex Roofing accepted Smith roof') = '{"Ada Admin","Olga Office","Rita Owner"}', 'the office with the subs area hears (not Pam, Ed or the crew)');
select t1090.check((select body from public.notifications where user_id = :'olga' and title = 'Apex Roofing accepted Smith roof') = '$2,040. They''re on its visits now.', 'with the price');
begin;
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check((select line1 from public.properties) = '12 Oak St' and (select title from public.jobs) = 'Smith roof' and (select count(*) from public.visits) = 2,
  'now the job, its address and its visits are in My day');
select t1090.check((select row(status, outcome, can_answer, insurance_warning)::text from public.my_sub_offers()) = row('accepted', 'accepted', false, '{}'::text[])::text,
  'and the offer shows as taken');
select t1090.check(not public.answer_sub_offer(:'pay', false), 'taken is taken');
rollback;
-- The office takes Abe off the shingling day. Whatever happens to the price, he stays off it.
delete from public.visit_assignees where user_id = :'abe' and visit_id = :'v2';

\o
\echo 'A new price for agreed work'
\o /dev/null

-- ===== Changing the price =======================================================================
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'pay', '[{"description": "Architectural shingles", "basis": "per_unit", "unit": "sq", "quantity": 24, "rate": 85}]'))
  = '22023: That''s the price they agreed. Change something first.', 'the same price isn''t a new one');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'pay', '[]')) = '22023: Add what you''ll pay them.', 'nor no lines at all');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'pay', '[{"description": "Shingles", "quantity": "lots", "rate": 85}]')) like '22023: Check the quantities and rates%',
  'quantities and rates are numbers');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'pay', '[{"description": " ", "rate": 85}]')) like '22023: Give each line a description%', 'and lines say what they''re for');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'bpay', '[{"description": "Gutters", "rate": 700}]')) like '22023: This offer is still waiting for their answer.%',
  'an offer still waiting is taken back before it''s changed');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'cy_pay', '[{"description": "More", "rate": 200}]')) like '22023: Offers are for subs.%', 'piece pay isn''t offered');
select '[{"description": "Architectural shingles", "basis": "per_unit", "unit": "sq", "quantity": 26, "rate": 85}]' as sq26 \gset
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L, now() - interval %L)', :'pay', :'sq26', '1 minute')) like '22023: Pick a time to answer by that''s still to come.%',
  'a new price''s time to answer by is still to come');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L, now() + interval %L)', :'pay', :'sq26', '91 days')) like '22023: Give them at most 90 days%', 'and not months away');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'pay', (select jsonb_agg(jsonb_build_object('description', 'Line ' || n, 'rate', 1)) from generate_series(1, 51) n)))
  = '22023: Keep it to 50 lines.', 'it has 50 lines at most');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'pay', '[{"description": "Shingles", "basis": "per_unit", "unit": "squaresquaresquaresqu", "quantity": 26, "rate": 85}]'))
  like '22023: Keep each unit short%', 'with short units');
select t1090.check(t1090.error_of(format('select public.change_sub_offer(%L, %L)', :'pay', '[{"description": "Shingles", "basis": "per_hour", "rate": 85}]'))
  = '22023: Each line is per unit, per job or per day.', 'per unit, per job or per day');
select t1090.check((select status = 'accepted' and total = 2040 from public.job_pay where id = :'pay'), 'nothing changed by any of that');
commit;
-- 26 squares: the new price goes to Apex as an offer, and they stay on the roof.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check((select status = 'offered' and offer_round = 2 and total = 2210 and (accepted_snapshot ->> 'total')::numeric = 2040 and respond_by is not null
  from public.change_sub_offer(:'pay', ('[{"description": "Architectural shingles", "basis": "per_unit", "unit": "sq", "quantity": 26, "rate": 85, "service_id": "' || :'shingles' || '"}]')::jsonb, now() + interval '1 day')),
  'the office changes it to 26 squares: $2,210, with the $2,040 they agreed kept');
select t1090.check((select service_id = :'shingles' and quantity = 26 from public.job_pay_lines where job_pay_id = :'pay'), 'the new line, from its service');
select t1090.check((select amount from public.job_pay_costs(array[:'j1']::uuid[])) = 2040, 'job costs count the agreed price while the new one waits');
commit;
select t1090.check((select count(*) from public.visit_assignees where user_id in (:'al', :'abe')) = 3, 'Apex stays on the visits meanwhile (Abe off the one he was taken off)');
select t1090.check((t1090.told(:'al', :'pay'))[2] like 'New price for Smith roof: $2,210 (was $2,040). Answer by ___ ___ %, %:__ _M. Open Crewtavo to accept or decline.',
  'Apex hears about the new price, and when to answer by');
select t1090.check((select count(*) from public.activity where verb = 'sub_offer.sent' and subject_id = :'j1' and data ->> 'change' = 'true'
  and summary = 'New price for Smith roof sent to Apex Roofing ($2,210, was $2,040)' and (data ->> 'total')::numeric = 2210 and (data ->> 'was')::numeric = 2040) = 1,
  'recorded as a new offer: sub_offer.sent, at the new price, with the one agreed');
begin;
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check((select row(is_change, can_answer, total, agreed_total, offer_round)::text from public.my_sub_offers() where id = :'pay') = row(true, true, 2210.00, 2040.00, 2)::text
  and (select (agreed_lines -> 0 ->> 'quantity')::numeric = 24 from public.my_sub_offers() where id = :'pay'), 'Al sees the new price beside the one he agreed');
rollback;
-- The rules hold for the server too: a new price goes back to the agreed one, or is cancelled.
select t1090.check(t1090.error_of(format('update public.job_pay set status = %L where id = %L', 'declined', :'pay')) like '22023: A new price they haven''t taken goes back%',
  'a new price isn''t declined like a first offer');

-- Turned down: agreed again at 24 squares, $2,040.
begin;
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check(public.answer_sub_offer(:'pay', false, 'Same roof, same price', 2), 'Al turns the new price down');
commit;
select t1090.check((select row(status, offer_outcome, total, decline_reason, answered_by)::text from public.job_pay where id = :'pay')
  = row('accepted', 'declined', 2040.00, 'Same roof, same price', :'al'::uuid)::text, 'the pay is agreed again at $2,040, with his reason');
select t1090.check((select array_agg(row(description, quantity, rate, amount, service_id)::text) from public.job_pay_lines where job_pay_id = :'pay')
  = array[row('Architectural shingles', 24.000, 85.0000, 2040.00, :'shingles'::uuid)::text], 'the agreed line is back');
select t1090.check((select count(*) from public.visit_assignees where user_id in (:'al', :'abe')) = 3
  and not exists (select 1 from public.visit_assignees where user_id = :'abe' and visit_id = :'v2'),
  'and Apex is still on the visits, with nobody the office took off put back');
select t1090.check(t1090.office_heard('Apex Roofing declined the new price for Smith roof') = '{"Ada Admin","Olga Office","Rita Owner"}'
  and (select body from public.notifications where user_id = :'olga' and title = 'Apex Roofing declined the new price for Smith roof')
    = '“Same roof, same price” The price they agreed ($2,040) stands.', 'the office hears, with the reason');
select t1090.check((select summary = 'Apex Roofing declined the new price for Smith roof ($2,210): Same roof, same price'
    and (data ->> 'total')::numeric = 2210 and (data ->> 'was')::numeric = 2040 and data ->> 'reason' = 'Same roof, same price'
  from public.activity where verb = 'sub_offer.declined' and subject_id = :'j1'),
  'sub_offer.declined, with the price turned down and the one that stands');

-- Run out: agreed again too. Two upkeep runs at once expire it once.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.change_sub_offer(:'pay', '[{"description": "Architectural shingles", "basis": "per_unit", "unit": "sq", "quantity": 27, "rate": 85}]', now() + interval '1 hour');
commit;
update public.job_pay set respond_by = now() - interval '1 minute' where id = :'pay';
begin;
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check(not public.answer_sub_offer(:'pay', true, null, 3), 'past the time to answer by, it can''t be taken');
select t1090.check((select can_answer from public.my_sub_offers() where id = :'pay') = false, 'and says so');
rollback;
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
select :"dbl".dblink_exec('other', 'begin; set local role service_role');
select n as other_run from :"dbl".dblink('other', 'select public.expire_sub_offers()') as t(n integer) \gset
set role service_role;
select public.expire_sub_offers() as this_run \gset
reset role;
select :"dbl".dblink_exec('other', 'commit');
select :"dbl".dblink_disconnect('other');
select t1090.check(:other_run = 1 and :this_run = 0, 'one run expires it; the other, at the same moment, leaves it');
set role service_role;
select public.expire_sub_offers() as next_run \gset
reset role;
select t1090.check(:next_run = 0, 'and the next run finds nothing');
select t1090.check((select row(status, offer_outcome, total, answered_by)::text from public.job_pay where id = :'pay') = row('accepted', 'expired', 2040.00, null::uuid)::text,
  'run out: agreed again at $2,040');
select t1090.check(t1090.office_heard('The new price for Smith roof ran out') = '{"Ada Admin","Olga Office","Rita Owner"}'
  and (select body from public.notifications where user_id = :'olga' and title = 'The new price for Smith roof ran out') = 'Apex Roofing didn''t answer. The price they agreed ($2,040) stands.',
  'the office hears');
select t1090.check((select count(*) from public.activity where verb = 'sub_offer.expired' and subject_id = :'j1'
  and (data ->> 'total')::numeric = 2295 and (data ->> 'was')::numeric = 2040) = 1, 'sub_offer.expired, once, with the price that ran out ($2,295) and the one that stands');
select t1090.check(not exists (select 1 from public.visit_assignees where user_id = :'abe' and visit_id = :'v2'), 'Abe still off the shingling day');
select t1090.check(not has_function_privilege('authenticated', 'public.expire_sub_offers()', 'execute') and not has_function_privilege('anon', 'public.expire_sub_offers()', 'execute'),
  'only the server runs the upkeep');

-- Taken back: agreed again, and Apex hears.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.change_sub_offer(:'pay', '[{"description": "Architectural shingles", "basis": "per_unit", "unit": "sq", "quantity": 25, "rate": 85}]');
select t1090.check((select row(status, offer_outcome, total)::text from public.withdraw_sub_offer(:'pay')) = row('accepted', 'withdrawn', 2040.00)::text, 'the office takes the new price back');
select t1090.check(t1090.error_of(format('select public.withdraw_sub_offer(%L)', :'pay')) = '22023: They''ve already agreed this pay.', 'once');
commit;
select t1090.check(t1090.told(:'al', :'pay') @> array['The new price for Smith roof was withdrawn']
  and (select body from public.notifications where user_id = :'al' and title = 'The new price for Smith roof was withdrawn') = 'The price you agreed ($2,040) stands.', 'Apex hears');
select t1090.check(not exists (select 1 from public.activity where verb not in ('sub_offer.sent', 'sub_offer.accepted', 'sub_offer.declined', 'sub_offer.expired') and verb like 'sub_offer.%'),
  'taking one back isn''t an answer to react to');
select t1090.check(not exists (select 1 from public.visit_assignees where user_id = :'abe' and visit_id = :'v2'), 'and Abe is still off the shingling day');

-- Taken: agreed at the new price.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.change_sub_offer(:'pay', '[{"description": "Architectural shingles", "basis": "per_unit", "unit": "sq", "quantity": 26, "rate": 85}]');
select t1090.as_user(:'al');
select t1090.check(public.answer_sub_offer(:'pay', true, null, 5), 'Al takes the new price');
commit;
select t1090.check((select row(status, offer_outcome, total, (accepted_snapshot ->> 'total')::numeric)::text from public.job_pay where id = :'pay') = row('accepted', 'accepted', 2210.00, 2210.00)::text,
  'agreed at $2,210, now what''s kept');
select t1090.check(t1090.office_heard('Apex Roofing accepted the new price for Smith roof') = '{"Ada Admin","Olga Office","Rita Owner"}', 'the office hears');
select t1090.check(not exists (select 1 from public.visit_assignees where user_id = :'abe' and visit_id = :'v2'), 'taken, Abe stays off the shingling day too');
select t1090.check(t1090.chases(:'pay') = '{"cancelled: The sub took the offer.","cancelled: The sub turned the offer down.","cancelled: The offer ran out.","cancelled: The offer was withdrawn.","cancelled: The sub took the offer."}',
  'each new price''s chase is called off as it ends');
-- Ari gets a sign-in while the office has Apex turned off: he goes on the roof once Apex is back on.
-- Abe, whom the office took off the shingling day, stays off it.
update public.subcontractors set active = false where id = :'apex';
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'ari', 'subcontractor', :'apex');
select t1090.check(not exists (select 1 from public.visit_assignees where user_id = :'ari'), 'not while Apex is turned off');
update public.subcontractors set active = true where id = :'apex';
select t1090.check((select array_agg(visit_id order by visit_id) from public.visit_assignees where user_id = :'ari') = (select array_agg(x order by x) from unnest(array[:'v1', :'v2']::uuid[]) x)
  and (select bool_and(assigned @> array[:'ari']::uuid[]) from public.job_pay_visits where job_pay_id = :'pay' and visit_id in (:'v1', :'v2')),
  'turned back on, the sign-in made meanwhile goes on the visits, noted on the pay');
select t1090.check(not exists (select 1 from public.visit_assignees where user_id = :'abe' and visit_id = :'v2') and exists (select 1 from public.visit_assignees where user_id = :'abe' and visit_id = :'v1'),
  'and Abe stays off the day he was taken off, on the other');
select t1090.check(t1090.error_of(format('update public.job_pay set status = %L where id = %L', 'offered', :'pay')) like '22023: Offers go out from the job%',
  'an agreed price goes back to the sub only as a change');

-- A new price waiting while the work gets done: turned down, the agreed lines come back first, and
-- then the pay is done, owed at the agreed price.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.change_sub_offer(:'pay', '[{"description": "Architectural shingles", "basis": "per_unit", "unit": "sq", "quantity": 28, "rate": 85}]');
update public.visits set status = 'completed' where id in (:'v1', :'v2');
commit;
select t1090.check((select status = 'offered' and total = 2380 from public.job_pay where id = :'pay'), 'the work is finished while the new price waits');
-- The workers' comp audit counts it as agreed work, at the agreed price; a first offer that's
-- waiting isn't work given yet, even with its visit done.
begin;
update public.visits set status = 'completed' where id = :'v3';
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check((select row(status, pay_amount, amount, cardinality(work_dates))::text from public.sub_wc_audit(:'co', :'today'::date - 1, :'today'::date + 10) where job_pay_id = :'pay')
  = row('accepted', 2210.00, 2210.00, 1)::text, 'the workers'' comp audit lists the roof as agreed, at $2,210 on the day both visits were finished (today, ahead of the days they were booked for), not the new $2,380');
select t1090.check(not exists (select 1 from public.sub_wc_audit(:'co', :'today'::date - 1, :'today'::date + 10) where job_pay_id = :'bpay'),
  'Birch''s offer, still waiting, isn''t on it');
rollback;
begin;
set local role authenticated;
select t1090.as_user(:'abe');
select t1090.check(public.answer_sub_offer(:'pay', false), 'Abe turns it down');
commit;
select t1090.check((select row(status, total, earned_on)::text from public.job_pay where id = :'pay') = row('done', 2210.00, :'today'::date)::text,
  'the pay is done at the agreed $2,210, owed from today');
select t1090.check((select array_agg(quantity) from public.job_pay_lines where job_pay_id = :'pay') = '{26.000}', 'with its agreed line');
select t1090.check(t1090.told(:'al', :'pay') @> array['Owed: $2,210 for Smith roof'] and t1090.told(:'abe', :'pay') @> array['Owed: $2,210 for Smith roof'],
  'Apex hears what it''s owed');
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.job_pay_mark_paid(array[:'pay']::uuid[], 'check', :'today'::date);
commit;
select t1090.check(t1090.told(:'al', :'pay') @> array['Paid $2,210 on ' || to_char(:'today'::date, 'Mon FMDD')]
  and (select body from public.notifications where user_id = :'al' and title like 'Paid %') = 'Smith roof, by check.', 'and when it''s paid');
begin;
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check((select row(year, paid, payments, owed, owed_jobs)::text from public.my_sub_pay_totals(:'co'))
  = row(extract(year from now() at time zone 'America/New_York')::integer, 2210.00, 1, 0, 0)::text, 'Al''s totals: $2,210 paid this year, nothing owed');
rollback;
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.job_pay_unmark_paid(array[:'pay']::uuid[]);
select public.job_pay_mark_paid(array[:'pay']::uuid[], 'check', :'today'::date);
commit;
select t1090.check((select count(*) from public.notifications where user_id = :'al' and kind = 'jobs' and (title like 'Paid %' or title like 'Owed: %')) = 2,
  'a paid mark taken back and put on again isn''t news twice');
select t1090.check(not exists (select 1 from public.notifications where kind = 'jobs' and user_id = :'cy'), 'piece pay isn''t a sub''s to hear about');

\o
\echo 'First offers that end'
\o /dev/null

-- ===== Turned down, and offered to someone else ================================================
-- A rule: text the owner when a sub turns a job down.
insert into public.automation_rules (company_id, name, trigger, actions)
values (:'co', 'Tell me when a sub says no', 'sub_offer.declined', '[{"type": "notify", "roles": ["owner"], "title": "A sub turned down {{title}}"}]');
begin;
set local role authenticated;
select t1090.as_user(:'bo');
select t1090.check(public.answer_sub_offer(:'bpay', false), 'Bo turns down the gutters, without a reason');
commit;
select t1090.check((select row(status, offer_outcome, decline_reason)::text from public.job_pay where id = :'bpay') = row('declined', 'declined', null::text)::text, 'declined');
select t1090.check(t1090.chases(:'bpay') = '{"cancelled: The sub turned the offer down."}', 'its chase called off');
begin;
set local role authenticated;
select t1090.as_user(:'bo');
select t1090.check((select scope = '[]' and jsonb_array_length(visits) = 1 from public.my_sub_offers(true) where id = :'bpay'),
  'Bo still sees the offer he turned down, with its day, but no longer the work');
rollback;
begin;
update public.job_pay set answered_at = now() - interval '31 days' where id = :'bpay';
set local role authenticated;
select t1090.as_user(:'bo');
select t1090.check(not exists (select 1 from public.my_sub_offers(true) where id = :'bpay'), 'after 30 days, not at all');
rollback;
select t1090.check((select body from public.notifications where user_id = :'olga' and title = 'Birch Gutters declined Jones gutters') = 'You can offer it to another sub from the job.',
  'the office hears, and what it can do');
select t1090.check((select count(*) from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
  where ru.trigger = 'sub_offer.declined' and r.subject_type = 'job' and r.subject_id = :'j2') = 1, 'and the rule runs, on the job');
begin;
set local role authenticated;
select t1090.as_user(:'olga');
insert into public.pay_rates (company_id, subcontractor_id, basis, service_id, rate) values (:'co', :'apex', 'per_unit', :'gutters', 10);
select public.job_pay_start(:'j2', :'apex', null, array[:'v3']::uuid[]) as apex_gutters \gset
select t1090.check(t1090.error_of(format('select public.job_pay_start(%L, %L)', :'j2', :'apex')) like '22023: They already have pay on this job.%', 'one live pay per sub per job');
select public.job_pay_start(:'j2', :'birch', null, array[:'v3']::uuid[]) as birch_again \gset
select t1090.check((select status = 'draft' from public.job_pay where id = :'birch_again'), 'Birch can be offered it again later, too');
select public.send_sub_offer(:'apex_gutters', now() + interval '1 hour');
commit;
select t1090.check((select status from public.job_pay where id = :'apex_gutters') = 'offered', 'the office offers the gutters to Apex instead');

-- ===== Run out ==================================================================================
update public.job_pay set respond_by = now() - interval '1 minute' where id = :'apex_gutters';
set role service_role;
select public.expire_sub_offers() as expired \gset
reset role;
select t1090.check(:expired = 1 and (select row(status, offer_outcome)::text from public.job_pay where id = :'apex_gutters') = row('expired', 'expired')::text, 'unanswered in time, it runs out');
select t1090.check(t1090.office_heard('Apex Roofing didn''t answer in time: Jones gutters') = '{"Ada Admin","Olga Office","Rita Owner"}'
  and (select summary from public.activity where verb = 'sub_offer.expired' and subject_id = :'j2') = 'Apex Roofing didn''t answer the offer for Jones gutters in time',
  'the office hears, and sub_offer.expired');

-- ===== Taken back ===============================================================================
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.job_pay_start(:'j2', :'apex', null, array[:'v3']::uuid[]) as apex_again \gset
select public.send_sub_offer(:'apex_again');
select t1090.check((select row(status, offer_outcome)::text from public.withdraw_sub_offer(:'apex_again')) = row('withdrawn', 'withdrawn')::text, 'an offer taken back is over');
select t1090.check(t1090.error_of(format('select public.withdraw_sub_offer(%L)', :'apex_again')) = '22023: This offer is already over.', 'once');
select t1090.check(t1090.error_of(format('select public.withdraw_sub_offer(%L)', :'cpay')) = '22023: This offer hasn''t gone out yet.', 'a draft has nothing to take back');
commit;
select t1090.check(t1090.told(:'al', :'apex_again') @> array['Jones gutters, ' || to_char(:'today'::date + 3, 'Dy Mon FMDD') || ', 120 lf, $1,200. Open Crewtavo to accept or decline.',
  'The offer for Jones gutters was withdrawn'] and cardinality(t1090.told(:'al', :'apex_again')) = 2, 'Apex hears it went out, and that it was taken back');
begin;
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check(not public.answer_sub_offer(:'apex_again', true), 'it can''t be taken');
select t1090.check((select array_agg(outcome order by id) from public.my_sub_offers() where job_id = :'j2') = (select array_agg(x order by id) from (values (:'apex_gutters'::uuid, 'expired'), (:'apex_again'::uuid, 'withdrawn')) v(id, x)),
  'Al''s recent offers show the gutters ran out, then were taken back');
select t1090.check((select count(*) from public.my_sub_offers(true)) = 3, 'and all his pay, with the roof');
rollback;

\o
\echo 'A new price, cancelled; a sign-in given later'
\o /dev/null

-- ===== Cancelling pay with a new price waiting ==================================================
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.job_pay_start(:'j3', :'apex', null, array[:'v4', :'v5']::uuid[]) as porch \gset
select t1090.check((select status = 'accepted' and total = 850 and (accepted_snapshot ->> 'total')::numeric = 850 and insurance_warning is null from public.job_pay_accept(:'porch')),
  'the porch, agreed with Apex by phone, kept as agreed (nothing wrong with its insurance for these days)');
select public.change_sub_offer(:'porch', '[{"description": "Porch roof", "quantity": 1, "rate": 1000}]');
commit;
select t1090.check((select count(*) from public.visit_assignees where visit_id in (:'v4', :'v5') and user_id in (:'al', :'abe', :'ari')) = 6, 'Apex is on the porch visits');

-- While the new price waits, the porch roof is done and Ace gets a sign-in: he goes on the trim day
-- only. The new price turned down, nobody is put on the day that's done.
begin;
update public.visits set status = 'completed' where id = :'v4';
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'ace', 'subcontractor', :'apex');
select t1090.check((select array_agg(visit_id) from public.visit_assignees where user_id = :'ace') = array[:'v5']::uuid[], 'Ace goes on the visit still to do');
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check(public.answer_sub_offer(:'porch', false), 'Al turns the new price down');
select t1090.as_user(:'olga');
select t1090.check((select row(status, total)::text from public.job_pay where id = :'porch') = row('accepted', 850.00)::text, 'agreed again at $850');
reset role;
select t1090.check((select array_agg(visit_id) from public.visit_assignees where user_id = :'ace') = array[:'v5']::uuid[],
  'and Ace isn''t put on the porch roof he didn''t work');
rollback;

-- Taking a visit out of the new price waiting isn't how it's changed; a visit deleted from the
-- schedule still comes out of it, and the sub off it with it.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check(t1090.error_of(format('delete from public.job_pay_visits where job_pay_id = %L and visit_id = %L', :'porch', :'v5'))
  = '22023: This offer went out for the visits it covers. Withdraw it to change them.', 'a new price waiting keeps its visits');
reset role;
delete from public.visits where id = :'v5';
select t1090.check((select status from public.job_pay where id = :'porch') = 'offered'
  and (select array_agg(visit_id) from public.job_pay_visits where job_pay_id = :'porch') = array[:'v4']::uuid[], 'a visit deleted from the schedule comes out of it');
select t1090.check((select count(*) from public.visit_assignees where visit_id = :'v4' and user_id in (:'al', :'abe', :'ari')) = 3, 'and Apex stays on the other');
rollback;

begin;
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check((select status from public.job_pay_cancel(:'porch')) = 'cancelled', 'pay with a new price waiting can be cancelled');
select t1090.check(not exists (select 1 from public.visit_assignees where visit_id in (:'v4', :'v5') and user_id in (:'al', :'abe', :'ari')), 'taking Apex off its visits');
select t1090.as_user(:'al');
select t1090.check(not exists (select 1 from public.my_sub_offers(true) where id = :'porch'), 'cancelled pay isn''t in Al''s jobs');
commit;

-- ===== The office agrees an offer for the sub ==================================================
-- They said yes on the phone: Agree takes the offer as it went out, puts them on the job and tells them.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.job_pay_start(:'j3', :'apex', null, array[:'v4', :'v5']::uuid[]) as porch2 \gset
select public.send_sub_offer(:'porch2');
select t1090.check(t1090.error_of(format('select public.job_pay_accept(%L, %L)', :'porch2', array[:'v4']::uuid[]))
  = '22023: This offer went out for the visits it covers. Withdraw it to change them.', 'Agree takes the offer''s visits as they went out');
select t1090.check((select row(status, offer_outcome, answered_by, (accepted_snapshot ->> 'total')::numeric = total)::text from public.job_pay_accept(:'porch2'))
  = row('accepted', 'accepted', :'olga'::uuid, true)::text, 'Olga agrees it: taken, by her, and kept as agreed');
select t1090.check((select count(*) from public.visit_assignees where visit_id in (:'v4', :'v5') and user_id in (:'al', :'abe', :'ari')) = 6
  and (select bool_and(assigned @> array[:'al', :'abe', :'ari']::uuid[]) from public.job_pay_visits where job_pay_id = :'porch2'), 'Apex goes on its visits, noted on the pay');
select t1090.check(t1090.told(:'al', :'porch2') @> array['Brown porch is yours at $850'], 'and Al is told it''s his');
select t1090.as_user(:'al');
select t1090.check(not public.answer_sub_offer(:'porch2', false), 'so there''s nothing left to answer');
-- A new price, agreed on the phone too: it's what's kept, so a later one turned down comes back to it.
select t1090.as_user(:'olga');
select public.change_sub_offer(:'porch2', '[{"description": "Porch roof", "quantity": 1, "rate": 1000}]');
select t1090.check((select row(status, total, (accepted_snapshot ->> 'total')::numeric)::text from public.job_pay_accept(:'porch2')) = row('accepted', 1000.00, 1000.00)::text,
  'Olga agrees the new price: $1,000, now kept as agreed');
select t1090.check(t1090.told(:'al', :'porch2') @> array['Your price for Brown porch is now $1,000 (was $850)'], 'and Al is told');
select public.change_sub_offer(:'porch2', '[{"description": "Porch roof", "quantity": 1, "rate": 1200}]');
select t1090.as_user(:'al');
select t1090.check(public.answer_sub_offer(:'porch2', false), 'Al turns down $1,200');
select t1090.check((select total from public.job_pay where id = :'porch2') = 1000, 'back to the $1,000 agreed on the phone, not the $850 before it');
rollback;

-- ===== A sign-in given later ====================================================================
-- Birch's porch trim, agreed by phone with Bo; the first visit is done before Bea, Birch's new
-- helper, gets a sign-in.
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.job_pay_start(:'j3', :'birch', null, array[:'v4', :'v5']::uuid[]) as trim_pay \gset
insert into public.job_pay_lines (company_id, job_pay_id, description, rate) values (:'co', :'trim_pay', 'Trim', 450);
select public.job_pay_accept(:'trim_pay');
update public.visits set status = 'completed' where id = :'v4';
commit;
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'bea', 'subcontractor', :'birch');
select t1090.check((select array_agg(visit_id) from public.visit_assignees where user_id = :'bea') = array[:'v5']::uuid[], 'Bea goes on the visit still to do, not the one already done');
select t1090.check((select assigned @> array[:'bea']::uuid[] from public.job_pay_visits where job_pay_id = :'trim_pay' and visit_id = :'v5'), 'noted on the pay');
select t1090.check(exists (select 1 from public.notifications where user_id = :'bea' and kind = 'schedule'), 'and she hears she''s on it');
select t1090.check((select insurance_warning is not null from public.job_pay where id = :'trim_pay'), 'agreed by phone, Birch''s insurance gaps are on the record');
-- Her sign-in taken away, she comes off the visit (the office does that); given back, she's on again.
update public.memberships set active = false where user_id = :'bea';
delete from public.visit_assignees where user_id = :'bea';
update public.memberships set active = true where user_id = :'bea';
select t1090.check((select array_agg(visit_id) from public.visit_assignees where user_id = :'bea') = array[:'v5']::uuid[], 'a sign-in given back goes on again');
-- The office takes her off the visit: turning Birch off and back on doesn't put her back.
delete from public.visit_assignees where user_id = :'bea';
update public.subcontractors set active = false where id = :'birch';
update public.subcontractors set active = true where id = :'birch';
select t1090.check(not exists (select 1 from public.visit_assignees where user_id = :'bea') and exists (select 1 from public.visit_assignees where user_id = :'bo' and visit_id = :'v5'),
  'turned off and on, Birch keeps its place, and Bea stays off the visit the office took her off');
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select public.job_pay_cancel(:'trim_pay');
commit;
select t1090.check(not exists (select 1 from public.visit_assignees where visit_id = :'v5' and user_id in (:'bo', :'bea'))
  and exists (select 1 from public.visit_assignees where visit_id = :'v4' and user_id = :'bo'), 'cancelled, they come off the visit to do; Bo stays on the one he did');
select t1090.check(not exists (select 1 from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id join public.activity a on a.id = r.activity_id
  join public.job_pay p on p.id = (a.data ->> 'job_pay_id')::uuid where ru.trigger = 'sub_offer.sent' and r.status = 'pending' and p.status <> 'offered'),
  'no chase is left waiting for an offer that''s over');

\o
\echo 'Who reads offer activity'
\o /dev/null

-- ===== Activity ==================================================================================
begin;
set local role authenticated;
select t1090.as_user(:'olga');
select t1090.check((select count(*) from public.activity where verb like 'sub_offer.%') >= 10, 'the office with the subs area reads offer activity');
select t1090.as_user(:'rita');
select t1090.check((select count(*) from public.activity where verb like 'sub_offer.%') >= 10, 'so does the owner');
select t1090.as_user(:'ed');
select t1090.check(not exists (select 1 from public.activity where verb like 'sub_offer.%') and exists (select 1 from public.activity where verb = 'job.created'),
  'an estimator reads the job''s other activity, not what subs were offered');
select t1090.as_user(:'pam');
select t1090.check(not exists (select 1 from public.activity where verb like 'sub_offer.%'), 'nor the office without the subs area');
select t1090.as_user(:'lou');
select t1090.check(not exists (select 1 from public.activity where verb like 'sub_offer.%'), 'nor a crew lead');
select t1090.as_user(:'al');
select t1090.check(not exists (select 1 from public.activity), 'nor a sub');
select t1090.as_user(:'sam');
select t1090.check(not exists (select 1 from public.activity where company_id = :'co'), 'nor another company');
rollback;

\o
\echo 'My jobs for a busy sub'
\o /dev/null

-- ===== A long list ==============================================================================
-- Apex has been paid for 520 jobs in the last hours, many once offered with a time to answer by
-- long gone, and has three jobs agreed on the phone long ago and still to do. Al is also a sub of
-- Sierra Paving, which has paid him once.
begin;
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'other', :'al', 'subcontractor', :'sierrasub');
set local session_replication_role = replica;
insert into public.jobs (id, company_id, client_id, title)
select ('d1090000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, :'co', :'client', 'Busy job ' || n from generate_series(1, 523) n;
insert into public.job_pay (company_id, job_id, subcontractor_id, status, total, earned_on, paid_at, paid_amount, method, respond_by, offered_at, answered_at, offer_outcome, created_at)
select :'co', ('d1090000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, :'apex', 'paid', 100, :'today'::date, now() - make_interval(secs => n), 100, 'check',
  now() - interval '60 days' - make_interval(days => n % 20), now() - interval '70 days', now() - interval '61 days', 'accepted', now() - interval '70 days'
from generate_series(1, 520) n;
insert into public.job_pay (company_id, job_id, subcontractor_id, status, total, created_at)
select :'co', ('d1090000-0000-0000-0001-' || lpad(to_hex(n), 12, '0'))::uuid, :'apex', 'accepted', 50, now() - interval '2 years' from generate_series(521, 523) n;
update public.job_pay set status = 'paid', total = 75, earned_on = :'today'::date, paid_at = now(), paid_amount = 75, method = 'check' where id = :'sierra_pay';
set local session_replication_role = origin;
set local role authenticated;
select t1090.as_user(:'al');
select t1090.check((select count(*) from public.my_sub_offers(true, :'co')) = 500, 'My jobs lists 500 of them at most');
select t1090.check((select count(*) from public.my_sub_offers(true, :'co') where job_title in ('Busy job 521', 'Busy job 522', 'Busy job 523')) = 3,
  'the work still to do comes first, however old');
select t1090.check(exists (select 1 from public.my_sub_offers(true, :'co') where job_title = 'Busy job 1') and not exists (select 1 from public.my_sub_offers(true, :'co') where job_title = 'Busy job 520'),
  'then the newest paid, not the oldest deadlines');
select t1090.check(not exists (select 1 from public.my_sub_offers(true, :'co') where company_id <> :'co'), 'Romeo''s only');
select t1090.check((select array_agg(id) from public.my_sub_offers(true, :'other')) = array[:'sierra_pay']::uuid[], 'and Sierra''s on its own, not counted against Romeo''s');
select t1090.check((select row(paid, payments)::text from public.my_sub_pay_totals(:'co')) = row(2210.00 + 52000, 521)::text,
  'this year''s total counts all of it: $54,210 over 521 payments');
select t1090.check((select row(paid, payments)::text from public.my_sub_pay_totals(:'other')) = row(75.00, 1)::text, 'Sierra''s on its own');
rollback;

\o
\echo 'All sub offer tests passed.'
