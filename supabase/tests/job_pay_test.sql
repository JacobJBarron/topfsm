-- Database tests for job pay (20261025003001_job_pay.sql to 20261025003004_job_labor_costs.sql): rate
-- cards; a sub's and a team member's pay on a job, and who reaches it at every level, area and
-- company; the lines and totals worked out here; what moves pay along and what locks it; putting a
-- sub on its visits and taking them off; done by itself when the work is, on the company's day; the
-- suggested lines; marking paid; the 1099 totals and the workers' comp audit; piece pay in pay
-- periods; and job costs counting labor once.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1080;
grant usage on schema t1080 to authenticated, service_role;
create function t1080.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1080.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- The error a statement raises ("<sqlstate>: <message>"), or 'none'.
create function t1080.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1080.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
-- A sub's pay on a job at an agreed price, done and marked paid on a day, as the person signed in.
create function t1080.pay_sub(p_job uuid, p_sub uuid, p_amount numeric, p_paid_on date, p_method text) returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.job_pay_start(p_job, p_sub, null, '{}');
  delete from public.job_pay_lines where job_pay_id = v;
  insert into public.job_pay_lines (company_id, job_pay_id, description, quantity, rate) select company_id, v, 'Agreed price', 1, p_amount from public.job_pay where id = v;
  perform public.job_pay_accept(v);
  perform public.job_pay_mark_done(v, p_paid_on);
  perform public.job_pay_mark_paid(array[v], p_method, p_paid_on);
  return v;
end $$;
-- How many rows a statement changed (row-level security hides rows rather than refusing).
create function t1080.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
-- As p_who, every step of the office's pay functions on p_pay, and starting pay and asking which
-- visits it covers for the payee given, is refused (not found, or not allowed).
create function t1080.refused_all(p_who uuid, p_pay uuid, p_job uuid, p_sub uuid, p_user uuid, p_what text) returns void language plpgsql as $$
declare q text; e text;
begin
  perform t1080.as_user(p_who);
  foreach q in array array[
    format('select public.job_pay_start(%L, %L, %L)', p_job, p_sub, p_user),
    format('select * from public.job_pay_covers(%L, %L, %L)', p_job, p_sub, p_user),
    format('select public.job_pay_accept(%L)', p_pay),
    format('select public.job_pay_mark_done(%L)', p_pay),
    format('select public.job_pay_cancel(%L)', p_pay),
    format('select * from public.job_pay_mark_paid(array[%L]::uuid[], %L)', p_pay, 'check')
  ] loop
    e := t1080.error_of(q);
    perform t1080.check(e like 'P0002:%' or e like '42501:%', p_what || ': ' || q || ' is refused (' || e || ')');
  end loop;
end $$;
grant execute on all functions in schema t1080 to authenticated, service_role;

\set oz 'd1080000-0000-0000-0000-000000000001'
\set opal 'd1080000-0000-0000-0000-000000000002'
\set olly 'd1080000-0000-0000-0000-000000000003'
\set ona 'd1080000-0000-0000-0000-000000000004'
\set lou 'd1080000-0000-0000-0000-000000000005'
\set cy 'd1080000-0000-0000-0000-000000000006'
\set al 'd1080000-0000-0000-0000-000000000007'
\set bo 'd1080000-0000-0000-0000-000000000008'
\set ed 'd1080000-0000-0000-0000-000000000009'
\set pat 'd1080000-0000-0000-0000-000000000010'
\set ada 'd1080000-0000-0000-0000-000000000011'
\set dee 'd1080000-0000-0000-0000-000000000012'
\set apex 'd1080000-0000-0000-0000-0000000000c1'
\set birch 'd1080000-0000-0000-0000-0000000000c2'
\set cedar 'd1080000-0000-0000-0000-0000000000c3'
\set papasub 'd1080000-0000-0000-0000-0000000000c9'

insert into auth.users (id, email, raw_user_meta_data) values
  (:'oz', 'oz@oscar.test', '{"full_name": "Oz Owner"}'),
  (:'opal', 'opal@oscar.test', '{"full_name": "Opal Office"}'),
  (:'olly', 'olly@oscar.test', '{"full_name": "Olly Payroll"}'),
  (:'ona', 'ona@oscar.test', '{"full_name": "Ona Subs"}'),
  (:'lou', 'lou@oscar.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@oscar.test', '{"full_name": "Cy Crew"}'),
  (:'al', 'al@apex.test', '{"full_name": "Al Apex"}'),
  (:'bo', 'bo@birch.test', '{"full_name": "Bo Birch"}'),
  (:'ed', 'ed@oscar.test', '{"full_name": "Ed Estimator"}'),
  (:'pat', 'pat@papa.test', '{"full_name": "Pat Papa"}'),
  (:'ada', 'ada@oscar.test', '{"full_name": "Ada Admin"}'),
  (:'dee', 'dee@oscar.test', '{"full_name": "Dee Crew"}');

-- ===== Oscar Roofing, in New York ==============================================================
-- Oz owns it, Ada is an admin, Opal is in the office with everything an office has; Olly is in the
-- office for payroll (job costs, no subs), Ona for subs (subs, no job costs). Ed estimates, Lou leads
-- the crew, Cy and Dee are on it. Apex Roofing (Al signs in), Birch Gutters Inc (an S corporation;
-- Bo signs in) and Cedar Siding (no sign-in) are subs. The New roof job came from a quote with a roof
-- measurement (15% waste, the latest of two) and grew by a change order.
begin;
set local role authenticated;
select t1080.as_user(:'oz');
select public.create_company('Oscar Roofing', 'general', 'America/New_York') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Payroll clerk', 'office', '{job_costs,timesheets}') returning id as clerk_role \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Sub coordinator', 'office', '{subs,schedule}') returning id as subs_role \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'opal', 'office', null), (:'co', :'olly', 'office', :'clerk_role'), (:'co', :'ona', 'office', :'subs_role'),
  (:'co', :'lou', 'crew_lead', null), (:'co', :'cy', 'field_crew', null), (:'co', :'dee', 'field_crew', null),
  (:'co', :'ed', 'estimator', null), (:'co', :'ada', 'admin', null);
set local role authenticated;
insert into public.subcontractors (id, company_id, name, contact_name, email, address, tax_classification) values
  (:'apex', :'co', 'Apex Roofing', 'Al Apex', 'al@apex.test', '{"line1": "5 Pine Rd", "city": "Dover", "region": "DE", "postal_code": "19901"}', 'individual'),
  (:'birch', :'co', 'Birch Gutters Inc', 'Bo Birch', null, '{}', 's_corp'),
  (:'cedar', :'co', 'Cedar Siding', null, null, '{}', null);
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Roofing', :'lou') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', :'cy'), (:'co', :'crew', :'dee');
insert into public.services (company_id, name, unit, unit_price, unit_cost, labor_cost) values (:'co', 'Architectural shingles', 'sq', 450, 300, 120) returning id as shingles \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'Seamless gutters', 'lf', 12, 5) returning id as gutters \gset
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as client \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '1 Oak St') returning id as prop \gset
insert into public.quotes (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'New roof') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, service_id, name, quantity, unit, unit_price, unit_cost) values
  (:'co', :'quote', :'shingles', 'Architectural shingles', 24, 'sq', 450, 300),
  (:'co', :'quote', :'shingles', 'Shingle credit', 2, 'sq', -50, null);
insert into public.measurements (company_id, property_id, quote_id, geojson, waste_pct, roofing_squares, created_at) values
  (:'co', :'prop', :'quote', '{"type": "FeatureCollection", "features": []}', 10, 23, now() - interval '1 day'),
  (:'co', :'prop', :'quote', '{"type": "FeatureCollection", "features": []}', 15, 24, now());
select public.convert_quote_to_job(:'quote') as j1 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Garage roof') returning id as j2 \gset
insert into public.job_line_items (company_id, job_id, service_id, name, quantity, unit, unit_price, unit_cost) values (:'co', :'j2', :'shingles', 'Architectural shingles', 10, 'sq', 450, 300);
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Gutters') returning id as j3 \gset
insert into public.job_line_items (company_id, job_id, service_id, name, quantity, unit, unit_price, unit_cost) values (:'co', :'j3', :'gutters', 'Seamless gutters', 120, 'lf', 12, 5);
-- More jobs for the year's payments.
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Spring repair') returning id as j4 \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Card job') returning id as j5 \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Last year''s job') returning id as j6 \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'New Year''s Eve job') returning id as j7 \gset
-- The New roof's visits: two on Oct 13; the Garage roof's and the gutters'.
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'prop', 'Tear off', '2026-10-12') returning id as v1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'prop', 'Shingle', '2026-10-13') returning id as v2 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'prop', 'Flashing', '2026-10-13') returning id as v3 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'prop', 'Ridge', '2026-10-14') returning id as v4 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'prop', 'Walk-through', private.company_today(:'co') + 3) returning id as vf \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j2', :'prop', 'Garage', '2026-10-15') returning id as w1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j3', :'prop', 'Hang gutters', private.company_today(:'co') + 2) returning id as g1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on, status, completed_at) values (:'co', :'j3', :'prop', 'Measure gutters', '2026-10-16', 'completed', '2026-10-16T18:00:00Z') returning id as g2 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v1', :'cy'), (:'co', :'v2', :'cy');
-- A change order: three more squares.
insert into public.quotes (company_id, client_id, title, change_order_for) values (:'co', :'client', 'Change order: back porch', :'j1') returning id as co_quote \gset
insert into public.quote_line_items (company_id, quote_id, service_id, name, quantity, unit, unit_price, unit_cost) values (:'co', :'co_quote', :'shingles', 'Architectural shingles', 3, 'sq', 450, 300);
update public.quotes set status = 'sent', sent_at = now() where id = :'co_quote';
commit;
-- The client approves it in the Client Hub (the server, as the service role).
update public.quotes set status = 'approved', approved_at = now() where id = :'co_quote';

-- The subs' sign-ins, as the server makes them.
insert into public.memberships (company_id, user_id, role, subcontractor_id) values
  (:'co', :'al', 'subcontractor', :'apex'), (:'co', :'bo', 'subcontractor', :'birch');

-- Papa Paving, another business, with its own sub and pay.
begin;
set local role authenticated;
select t1080.as_user(:'pat');
select public.create_company('Papa Paving', 'general', 'America/Chicago') as other \gset
insert into public.subcontractors (id, company_id, name) values (:'papasub', :'other', 'Papa''s own sub');
insert into public.clients (company_id, display_name) values (:'other', 'Papa client') returning id as pc \gset
insert into public.jobs (company_id, client_id, title) values (:'other', :'pc', 'Driveway') returning id as pj \gset
insert into public.pay_rates (company_id, subcontractor_id, basis, rate) values (:'other', :'papasub', 'per_job', 900);
select public.job_pay_start(:'pj', :'papasub', null, '{}') as papa_pay \gset
commit;

\o
\echo 'Job pay'
\o /dev/null

-- ===== Rate cards ==============================================================================
begin;
set local role authenticated;
select t1080.as_user(:'opal');
insert into public.pay_rates (company_id, subcontractor_id, basis, service_id, rate) values (:'co', :'apex', 'per_unit', :'shingles', 75) returning id as apex_sq \gset
insert into public.pay_rates (company_id, subcontractor_id, basis, rate) values (:'co', :'apex', 'per_day', 200) returning id as apex_day \gset
insert into public.pay_rates (company_id, subcontractor_id, basis, rate, description) values (:'co', :'apex', 'per_job', 150, 'Dumpster haul');
insert into public.pay_rates (company_id, subcontractor_id, basis, rate, active) values (:'co', :'apex', 'per_job', 999, false);
insert into public.pay_rates (company_id, subcontractor_id, basis, service_id, squares_basis, rate) values (:'co', :'birch', 'per_unit', :'shingles', 'roof_no_waste', 60);
insert into public.pay_rates (company_id, user_id, basis, service_id, squares_basis, rate) values (:'co', :'cy', 'per_unit', :'shingles', 'roof_no_waste', 10);
insert into public.pay_rates (company_id, user_id, basis, rate) values (:'co', :'dee', 'per_job', 100);
select t1080.check((select unit = 'sq' from public.pay_rates where id = :'apex_sq') and (select unit = 'day' and squares_basis = 'job' from public.pay_rates where id = :'apex_day'),
  'a rate per unit takes its service''s unit; per day counts days');
select t1080.check(t1080.error_of(format('insert into public.pay_rates (company_id, subcontractor_id, basis, service_id, squares_basis, rate) values (%L, %L, %L, %L, %L, 1)',
  :'co', :'apex', 'per_unit', :'gutters', 'roof_no_waste')) like '22023: Roof squares without waste is only for a rate per square.%', 'roof squares without waste are only for squares');
select t1080.check(t1080.error_of(format('insert into public.pay_rates (company_id, user_id, basis, rate) values (%L, %L, %L, 1)', :'co', :'al', 'per_job'))
  like '22023: Pay rates are for subs and people on your team.%', 'a rate for a person is for someone on the team, not a sub''s sign-in');
select t1080.check(t1080.error_of(format('insert into public.pay_rates (company_id, subcontractor_id, user_id, basis, rate) values (%L, %L, %L, %L, 1)', :'co', :'apex', :'cy', 'per_job'))
  like '23514:%', 'and for one payee, not two');
select t1080.check(t1080.error_of(format('insert into public.pay_rates (company_id, subcontractor_id, basis, rate) values (%L, %L, %L, 1)', :'co', :'apex', 'per_unit'))
  like '23514:%', 'a rate per unit names its service');
select t1080.check(t1080.error_of(format('update public.pay_rates set unit = %L where id = %L', 'ea', :'apex_sq')) like '42501:%', 'the unit is the database''s to keep');
select t1080.check(t1080.error_of(format('update public.pay_rates set user_id = %L where id = %L', :'cy', :'apex_sq')) like '42501:%', 'and who it''s for doesn''t change');
update public.pay_rates set rate = 78 where id = :'apex_sq';
update public.pay_rates set rate = 75 where id = :'apex_sq';
select t1080.check((select rate = 75 from public.pay_rates where id = :'apex_sq'), 'the office changes a rate');
commit;

-- ===== Suggested lines =========================================================================
begin;
set local role authenticated;
select t1080.as_user(:'opal');
create temp table t1080_s as select * from public.job_pay_suggest(:'j1', :'apex', null, array[:'v1', :'v2', :'v3']::uuid[]);
select t1080.check((select array_agg(description || ' ' || trim_scale(quantity) || ' × ' || trim_scale(rate) || ' = ' || amount order by sort) from t1080_s)
    = array['Architectural shingles 27 × 75 = 2025.00', 'Day rate 2 × 200 = 400.00', 'Dumpster haul 1 × 150 = 150.00'],
  'a sub''s active rates: the job''s squares (the change order in, the credit out), the days among the visits, once for the job');
select t1080.check((select note from t1080_s where basis = 'per_unit') = '27 squares of Architectural shingles on the job, change orders included.'
  and (select note from t1080_s where basis = 'per_day') = '2 days on the visits it covers: Oct 12, Oct 13.'
  and (select note from t1080_s where basis = 'per_job') = 'Once for the job.' and not (select bool_or(check_it) from t1080_s),
  'each with a plain note of where its quantity came from');
select t1080.check((select row(quantity, amount, check_it, note)::text from public.job_pay_suggest(:'j1', :'birch'))
    = row(23.48, 1408.80, false, '23.48 squares without the roof measurement''s 15% waste. The job has 27 squares.')::text,
  'roof squares without waste: the job''s squares less the latest measurement''s waste, to 2 places');
select t1080.check((select quantity = 10 and check_it and note = 'The job''s 10 squares, waste included: its quote has no roof measurement to take the waste out. Check it.'
    from public.job_pay_suggest(:'j2', :'birch')),
  'without a measurement, the job''s squares, flagged');
select t1080.check((select array_agg(row(quantity, check_it)::text order by sort) from public.job_pay_suggest(:'j3', :'apex')) = array['(0,t)', '(0,t)', '(1,f)'],
  'nothing to count (no shingles on the job, no visits chosen): nought, flagged');
select t1080.check((select row(quantity, amount)::text from public.job_pay_suggest(:'j1', null, :'cy')) = row(23.48, 234.80)::text,
  'a team member''s rates the same way');
select t1080.check(t1080.error_of(format('select * from public.job_pay_suggest(%L, %L, null, array[%L]::uuid[])', :'j1', :'apex', :'w1')) like '22023: Choose visits on this job.%',
  'the visits are the job''s');
select t1080.check(t1080.error_of(format('select * from public.job_pay_suggest(%L, %L, %L)', :'j1', :'apex', :'cy')) like '42501:%', 'one payee at a time');
rollback;

-- Who may ask.
begin;
set local role authenticated;
select t1080.as_user(:'olly');
select t1080.check(t1080.error_of(format('select * from public.job_pay_suggest(%L, %L)', :'j1', :'apex')) like '42501:%', 'without the subs area, not for a sub');
select t1080.check((select count(*) from public.job_pay_suggest(:'j1', null, :'cy')) = 1, 'job costs is enough for a team member''s');
select t1080.as_user(:'ona');
select t1080.check(t1080.error_of(format('select * from public.job_pay_suggest(%L, null, %L)', :'j1', :'cy')) like '42501:%', 'and without job costs, not for a team member');
select t1080.as_user(:'lou');
select t1080.check(t1080.error_of(format('select * from public.job_pay_suggest(%L, %L)', :'j1', :'apex')) like 'P0002:%', 'not for a crew lead');
select t1080.as_user(:'ed');
select t1080.check(t1080.error_of(format('select * from public.job_pay_suggest(%L, %L)', :'j1', :'apex')) like 'P0002:%', 'or an estimator');
select t1080.as_user(:'al');
select t1080.check(t1080.error_of(format('select * from public.job_pay_suggest(%L, %L)', :'j1', :'apex')) like 'P0002:%', 'or the sub themselves');
select t1080.as_user(:'pat');
select t1080.check(t1080.error_of(format('select * from public.job_pay_suggest(%L, %L)', :'j1', :'apex')) like 'P0002:%', 'or another business');
rollback;

-- ===== A sub's pay: a draft, its lines and total ==============================================
begin;
set local role authenticated;
select t1080.as_user(:'opal');
select public.job_pay_start(:'j1', :'apex', null, array[:'v1', :'v2', :'vf']::uuid[]) as pay_a \gset
select t1080.check((select status = 'draft' and total = 2775 from public.job_pay where id = :'pay_a')
  and (select count(*) from public.job_pay_lines where job_pay_id = :'pay_a') = 3
  and (select array_agg(visit_id order by visit_id) from public.job_pay_visits where job_pay_id = :'pay_a') = (select array_agg(x order by x) from unnest(array[:'v1', :'v2', :'vf']::uuid[]) x),
  'new pay is a draft covering the visits chosen, with the lines its rates suggest (27 × 75, 3 days × 200, 150)');
select t1080.check(t1080.error_of(format('select public.job_pay_start(%L, %L)', :'j1', :'apex')) like '22023: They already have pay on this job.%', 'one live pay per payee per job');
select t1080.check(t1080.error_of(format('insert into public.job_pay (company_id, job_id, subcontractor_id) values (%L, %L, %L)', :'co', :'j1', :'apex')) like '23505:%',
  'and the database holds to it');
insert into public.job_pay_lines (company_id, job_pay_id, description, quantity, rate) values (:'co', :'pay_a', 'Extra', 3, 0.335) returning id as extra \gset
select t1080.check((select amount = 1.01 and unit = 'job' from public.job_pay_lines where id = :'extra') and (select total = 2776.01 from public.job_pay where id = :'pay_a'),
  'a line''s amount is its quantity × rate to the cent (half a cent rounds up), and the total follows');
update public.job_pay_lines set quantity = 2.333, rate = 10.555 where id = :'extra';
select t1080.check((select amount = 24.62 from public.job_pay_lines where id = :'extra') and (select total = 2799.62 from public.job_pay where id = :'pay_a'), 'changing it, too');
select t1080.check(t1080.error_of(format('update public.job_pay_lines set amount = 1 where id = %L', :'extra')) like '42501:%', 'nobody types an amount');
delete from public.job_pay_lines where id = :'extra';
select t1080.check((select total = 2775 from public.job_pay where id = :'pay_a'), 'and taking a line out');
select t1080.check(t1080.error_of(format('update public.job_pay set total = 1 where id = %L', :'pay_a')) like '42501:%'
  and t1080.error_of(format('update public.job_pay set status = %L where id = %L', 'accepted', :'pay_a')) like '42501:%'
  and t1080.error_of(format('update public.job_pay set paid_amount = 1 where id = %L', :'pay_a')) like '42501:%',
  'its total, status and payment are the database''s: the office changes them through its functions');
update public.job_pay set notes = 'Bring the big ladder' where id = :'pay_a';
select t1080.check(t1080.error_of(format('insert into public.job_pay_visits (company_id, job_pay_id, visit_id) values (%L, %L, %L)', :'co', :'pay_a', :'w1')) like '22023: That visit isn''t on this pay''s job.%',
  'the visits it covers are its job''s');
commit;

-- A sub doesn't see the office's draft.
begin;
set local role authenticated;
select t1080.as_user(:'al');
select t1080.check((select count(*) from public.job_pay) = 0 and (select count(*) from public.job_pay_lines) = 0 and (select count(*) from public.job_pay_visits) = 0,
  'a sub doesn''t see a draft, its lines or visits');
rollback;

-- ===== Agreed: the sub goes on its visits ======================================================
begin;
set local role authenticated;
select t1080.as_user(:'opal');
select t1080.check((select status = 'accepted' from public.job_pay_accept(:'pay_a')), 'the office agrees the price (by phone)');
select t1080.check((select array_agg(visit_id order by visit_id) from public.visit_assignees where user_id = :'al') = (select array_agg(x order by x) from unnest(array[:'v1', :'v2', :'vf']::uuid[]) x)
  and (select bool_and(assigned = array[:'al']::uuid[]) from public.job_pay_visits where job_pay_id = :'pay_a'),
  'the sub''s sign-in goes on the visits it covers, noted as this pay''s doing');
select t1080.check(t1080.error_of(format('select public.job_pay_accept(%L)', :'pay_a')) like '22023: This pay is already agreed.%', 'it''s agreed once');
delete from public.job_pay_visits where job_pay_id = :'pay_a' and visit_id = :'vf';
select t1080.check(not exists (select 1 from public.visit_assignees where user_id = :'al' and visit_id = :'vf'), 'a visit taken out of the pay takes the sub off it');
insert into public.job_pay_visits (company_id, job_pay_id, visit_id) values (:'co', :'pay_a', :'v4');
select t1080.check(exists (select 1 from public.visit_assignees where user_id = :'al' and visit_id = :'v4'), 'and one added puts them on it');
update public.job_pay_lines set rate = 76 where job_pay_id = :'pay_a' and basis = 'per_unit';
update public.job_pay_lines set rate = 75 where job_pay_id = :'pay_a' and basis = 'per_unit';
select t1080.check((select total = 2775 from public.job_pay where id = :'pay_a'), 'lines still change while it''s agreed');
commit;
select t1080.check((select count(*) = 1 and bool_and(body like 'You''re on Walk-through: %' and body like '%You''re off Walk-through%') from public.notifications where user_id = :'al' and kind = 'schedule'),
  'and hears about the one still to come, as the crew does, and about coming off it (not about visits already past)');

-- Al reads his own: the price, its lines and visits. Nobody else's.
begin;
set local role authenticated;
select t1080.as_user(:'al');
select t1080.check((select row(status, total, notes)::text from public.job_pay) = row('accepted', 2775.00, 'Bring the big ladder')::text
  and (select count(*) from public.job_pay_lines) = 3 and (select count(*) from public.job_pay_visits) = 3,
  'a sub reads their own agreed pay, its lines and the visits it covers');
select t1080.check(t1080.error_of(format('update public.job_pay set notes = %L where id = %L', 'More please', :'pay_a')) = 'none'
  and (select notes from public.job_pay) = 'Bring the big ladder', 'but changes nothing on it');
select t1080.check(t1080.error_of(format('insert into public.job_pay_lines (company_id, job_pay_id, description, quantity, rate) values (%L, %L, %L, 1, 500)', :'co', :'pay_a', 'Tip'))
  like '42501:%', 'or adds to it');
select t1080.check(t1080.error_of(format('select public.job_pay_mark_done(%L)', :'pay_a')) like 'P0002:%', 'or marks it done');
delete from public.job_pay_visits;
delete from public.job_pay_lines;
rollback;
select t1080.check((select count(*) from public.job_pay_lines where job_pay_id = :'pay_a') = 3 and (select count(*) from public.job_pay_visits where job_pay_id = :'pay_a') = 3,
  'a sub''s deletes reach nothing');

-- ===== Done by itself, on the company's day ====================================================
begin;
set local role authenticated;
select t1080.as_user(:'opal');
update public.visits set status = 'completed', completed_at = '2026-10-12T21:00:00Z' where id = :'v1';
update public.visits set status = 'completed', completed_at = '2026-10-13T22:00:00Z' where id = :'v2';
select t1080.check((select status = 'accepted' from public.job_pay where id = :'pay_a'), 'not done while a visit it covers is still to do');
-- 11:30 pm in New York on Oct 14 is already Oct 15 in UTC.
update public.visits set status = 'completed', completed_at = '2026-10-15T03:30:00Z' where id = :'v4';
select t1080.check((select status = 'done' and earned_on = '2026-10-14' from public.job_pay where id = :'pay_a'),
  'done once every visit it covers is, earned on the day the last one was completed in the company''s time zone');
update public.visits set status = 'in_progress' where id = :'v4';
select t1080.check((select status = 'accepted' and earned_on is null from public.job_pay where id = :'pay_a'), 'a visit reopened puts it back to agreed');
update public.visits set status = 'completed', completed_at = '2026-10-15T03:30:00Z' where id = :'v4';
select t1080.check((select status = 'done' and earned_on = '2026-10-14' from public.job_pay where id = :'pay_a'), 'and done again when it''s finished');
-- Once done, what it covers and comes to stays.
select t1080.check(t1080.error_of(format('update public.job_pay_lines set quantity = 30 where job_pay_id = %L', :'pay_a')) like '22023: This pay''s work is done, so its lines stay as they are.%', 'its lines are locked');
select t1080.check(t1080.error_of(format('insert into public.job_pay_lines (company_id, job_pay_id, description) values (%L, %L, %L)', :'co', :'pay_a', 'More')) like '22023:%', 'nothing is added');
select t1080.check(t1080.error_of(format('delete from public.job_pay_lines where job_pay_id = %L', :'pay_a')) like '22023:%', 'or taken out');
select t1080.check(t1080.error_of(format('delete from public.job_pay_visits where job_pay_id = %L', :'pay_a')) like '22023: This pay''s work is done, so the visits it covers stay as they are.%', 'the visits it covers stay');
select t1080.check(t1080.error_of(format('delete from public.visits where id = %L', :'v1')) like '22023:%', 'so one of them isn''t deleted (it''s cancelled instead)');
select t1080.check(t1080.error_of(format('select public.job_pay_mark_done(%L)', :'pay_a')) like '22023: This work is already marked done.%', 'and it''s done once');
commit;

-- A sub finishing their own visit finishes their pay. Birch is paid for the garage roof.
begin;
set local role authenticated;
select t1080.as_user(:'opal');
select public.job_pay_start(:'j2', :'birch', null, array[:'w1']::uuid[]) as pay_b \gset
select public.job_pay_accept(:'pay_b');
select t1080.check(exists (select 1 from public.visit_assignees where visit_id = :'w1' and user_id = :'bo'), 'Bo is on the garage visit');
commit;
begin;
set local role authenticated;
select t1080.as_user(:'bo');
update public.visits set status = 'completed' where id = :'w1';
select t1080.check((select status = 'done' and earned_on = private.company_today(:'co') and total = 600 from public.job_pay), 'a sub completing their visit marks their pay done, owed to them today');
commit;

-- ===== Cancelling, and what's deleted =========================================================
begin;
set local role authenticated;
select t1080.as_user(:'opal');
select public.job_pay_start(:'j3', :'apex', null, array[:'g1', :'g2']::uuid[]) as pay_c \gset
select public.job_pay_accept(:'pay_c');
select t1080.check((select count(*) from public.visit_assignees where user_id = :'al' and visit_id in (:'g1', :'g2')) = 2, 'agreed pay puts the sub on the gutter visits, the measuring already done too');
select t1080.check((select status = 'cancelled' from public.job_pay_cancel(:'pay_c')), 'the office cancels it');
select t1080.check(not exists (select 1 from public.visit_assignees where user_id = :'al' and visit_id = :'g1')
  and exists (select 1 from public.visit_assignees where user_id = :'al' and visit_id = :'g2'),
  'which takes the sub off the visit still to come, not off the one they did');
select t1080.check(t1080.error_of(format('select public.job_pay_cancel(%L)', :'pay_c')) like '22023: This pay is already over.%', 'cancelled stays cancelled');
select t1080.check(t1080.error_of(format('select public.job_pay_accept(%L)', :'pay_c')) like '22023: This pay is over.%', 'and isn''t agreed again');
savepoint again;
select public.job_pay_start(:'j3', :'apex') as restarted \gset
select t1080.check((select status = 'draft' from public.job_pay where id = :'restarted'), 'new pay can be started once the old is cancelled');
rollback to savepoint again;
select public.job_pay_start(:'j1', :'cedar', null, '{}') as pay_cedar \gset
select public.job_pay_start(:'j2', :'apex', null, '{}') as pay_apex_draft \gset
select t1080.check(t1080.error_of(format('select public.job_pay_cancel(%L)', :'pay_apex_draft')) like '22023: This pay is still a draft. Delete it instead.%'
  and t1080.error_of(format('update public.job_pay set status = %L where id = %L', 'cancelled', :'pay_apex_draft')) like '42501:%',
  'a draft isn''t cancelled (cancelled pay is the sub''s to read), it''s deleted');
select t1080.check(t1080.error_of(format('delete from public.job_pay where id = %L', :'pay_a')) like '22023: Only a draft or cancelled pay can be deleted.%', 'pay that''s agreed or done isn''t deleted');
select t1080.check(t1080.error_of(format('delete from public.jobs where id = %L', :'j1')) like '22023: This job has pay on record for a sub or the crew.%', 'nor is a job with pay on record');
select t1080.check(t1080.error_of(format('delete from public.subcontractors where id = %L', :'apex')) like '22023: Apex Roofing has pay on record. Turn them off instead.%', 'or a sub with pay on record');
select t1080.check(t1080.error_of(format('delete from public.job_pay where id = %L', :'pay_c')) = 'none', 'cancelled pay can go');
commit;
-- The server can't cancel a draft either, and Al never sees it.
select t1080.check(t1080.error_of(format('update public.job_pay set status = %L where id = %L', 'cancelled', :'pay_apex_draft')) like '22023: Pay that''s draft can''t be cancelled.%',
  'a draft doesn''t move to cancelled, whoever asks');
begin;
set local role authenticated;
select t1080.as_user(:'al');
select t1080.check(not exists (select 1 from public.job_pay where id = :'pay_apex_draft') and not exists (select 1 from public.job_pay_lines where job_pay_id = :'pay_apex_draft'),
  'so the sub still doesn''t see the draft, or its lines');
rollback;

-- ===== Marking a sub's pay paid ===============================================================
begin;
set local role authenticated;
select t1080.as_user(:'ona');
select t1080.check(t1080.error_of(format('select * from public.job_pay_mark_paid(array[%L]::uuid[], null, %L)', :'pay_a', '2026-10-20')) like '22023: Choose how you paid them.%', 'paid says how');
select t1080.check(t1080.error_of(format('select * from public.job_pay_mark_paid(array[%L]::uuid[], %L, %L)', :'pay_a', 'venmo', '2026-10-20')) like '22023: Choose how you paid them.%', 'one of the ways listed');
select t1080.check(t1080.error_of(format('select * from public.job_pay_mark_paid(array[%L]::uuid[], %L, private.company_today(%L) + 1)', :'pay_a', 'check', :'co')) like '22023: Pick the day you paid them.%', 'or on a day still to come');
select t1080.check(t1080.error_of(format('select * from public.job_pay_mark_paid(array[%L, %L]::uuid[], %L, %L, null, 100)', :'pay_a', :'pay_b', 'check', '2026-10-20')) like '22023: Mark them paid one at a time%',
  'one amount is for one payment');
select t1080.check(t1080.error_of(format('select * from public.job_pay_mark_paid(array[%L]::uuid[], %L, %L)', :'pay_apex_draft', 'check', '2026-10-20')) like '22023: Only pay for work that''s done%', 'only done work is paid');
select t1080.check((select count(*) from public.job_pay_mark_paid(array[:'pay_a', :'pay_b']::uuid[], 'check', '2026-10-20', ' 1042 ')) = 2, 'several at once');
select t1080.check((select row(status, paid_amount, method, reference, paid_by, paid_at)::text from public.job_pay where id = :'pay_a')
    = row('paid', 2775.00, 'check', '1042', :'ona'::uuid, '2026-10-20T16:00:00Z'::timestamptz)::text,
  'each at its total, on the day given (noon, the company''s time), how and the reference, by whom');
select t1080.check(t1080.error_of(format('select * from public.job_pay_mark_paid(array[%L]::uuid[], %L, %L)', :'pay_a', 'check', '2026-10-20')) like '22023: Some of this is already marked paid.%', 'paid once');
select t1080.check((select row(status, paid_amount, paid_at, method)::text from public.job_pay_unmark_paid(array[:'pay_a']::uuid[])) = row('done', null, null, null)::text,
  'taking the mark back leaves it done, owed again');
select t1080.check((select method = 'payroll' from public.job_pay_mark_paid(array[:'pay_a']::uuid[], 'payroll', '2026-10-20')), 'a payroll service''s contractor payment counts as paid');
select t1080.check((select count(*) = 1 from public.job_pay_unmark_paid(array[:'pay_a']::uuid[])), 'and is taken back like any other');
select t1080.check((select paid_amount = 2700 from public.job_pay_mark_paid(array[:'pay_a']::uuid[], 'ach', '2026-10-20', null, 2700)), 'and one is paid at an amount of its own');
select t1080.check(t1080.error_of(format('select * from public.job_pay_unmark_paid(array[%L]::uuid[])', :'pay_apex_draft')) like '22023: Some of this isn''t marked paid.%', 'only what''s paid is taken back');
commit;

-- The status rules hold for the server too.
select t1080.check(t1080.error_of(format('update public.job_pay set status = %L where id = %L', 'draft', :'pay_a')) like '22023: Pay that''s paid can''t be draft.%', 'paid goes back to done, nowhere else');
select t1080.check(t1080.error_of(format('update public.job_pay set status = %L where id = %L', 'paid', :'pay_apex_draft')) like '22023:%', 'a draft isn''t paid');
begin;
update public.job_pay set status = 'accepted' where id = :'pay_apex_draft';
update public.job_pay set status = 'done', earned_on = '2026-10-20' where id = :'pay_apex_draft';
select t1080.check(t1080.error_of(format('update public.job_pay set status = %L where id = %L', 'paid', :'pay_apex_draft')) like '23514:%', 'paid needs when, how much and how');
rollback;

-- Who else can mark it paid.
begin;
set local role authenticated;
select t1080.as_user(:'olly');
select t1080.check(t1080.error_of(format('select * from public.job_pay_unmark_paid(array[%L]::uuid[])', :'pay_a')) like 'P0002:%', 'not the office without the subs area');
select t1080.as_user(:'lou');
select t1080.check(t1080.error_of(format('select * from public.job_pay_unmark_paid(array[%L]::uuid[])', :'pay_a')) like 'P0002:%', 'or a crew lead');
select t1080.as_user(:'bo');
select t1080.check(t1080.error_of(format('select * from public.job_pay_unmark_paid(array[%L]::uuid[])', :'pay_b')) like 'P0002:%', 'or the sub');
select t1080.as_user(:'pat');
select t1080.check(t1080.error_of(format('select * from public.job_pay_unmark_paid(array[%L]::uuid[])', :'pay_a')) like 'P0002:%', 'or another business');
rollback;

-- ===== The year's totals for the 1099 =========================================================
begin;
set local role authenticated;
select t1080.as_user(:'opal');
select t1080.pay_sub(:'j4', :'apex', 1000, '2026-03-02', 'check') as pay_j4 \gset
select t1080.pay_sub(:'j5', :'apex', 500, '2026-10-21', 'card_or_app') as pay_j5 \gset
select t1080.pay_sub(:'j6', :'apex', 400, '2025-12-31', 'cash') as pay_j6 \gset
select t1080.pay_sub(:'j7', :'apex', 300, '2025-12-31', 'check') as pay_j7 \gset
commit;
-- Paid at 10 pm on New Year's Eve in New York: already 2026 in UTC.
update public.job_pay set paid_at = '2026-01-01T03:00:00Z' where id = :'pay_j7';

begin;
set local role authenticated;
select t1080.as_user(:'ona');
select t1080.check((select array_agg(row(name, total, payments, card_or_app_total, card_or_app_payments, corporation, tax_classification)::text order by name) from public.sub_1099_totals(:'co', 2026))
    = array[row('Apex Roofing', 3700.00, 2, 500.00, 1, false, 'individual')::text, row('Birch Gutters Inc', 600.00, 1, 0, 0, true, 's_corp')::text],
  '2026: what each sub was paid, card and payment-app payments left out (and counted apart), corporations flagged');
select t1080.check((select row(contact_name, email, address ->> 'city')::text from public.sub_1099_totals(:'co', 2026) where name = 'Apex Roofing') = row('Al Apex', 'al@apex.test', 'Dover')::text,
  'with who to send it to');
select t1080.check((select array_agg(row(name, total, payments)::text) from public.sub_1099_totals(:'co', 2025)) = array[row('Apex Roofing', 700.00, 2)::text],
  '2025: by the day paid in the company''s time zone, New Year''s Eve at 10 pm included');
select t1080.check(not exists (select 1 from public.sub_1099_totals(:'co', 2024)), 'a year without payments has none');
savepoint payroll;
select public.job_pay_unmark_paid(array[:'pay_a']::uuid[]);
select public.job_pay_mark_paid(array[:'pay_a']::uuid[], 'payroll', '2026-10-20', null, 2700);
select t1080.check((select row(total, payments, payroll_total, payroll_payments)::text from public.sub_1099_totals(:'co', 2026) where name = 'Apex Roofing') = row(3700.00, 2, 2700.00, 1)::text,
  'a payroll service''s payment counts, and is counted apart too (the service may file that 1099)');
rollback to savepoint payroll;
select t1080.check(t1080.error_of(format('select * from public.sub_1099_totals(%L, null)', :'co')) like '22023: Choose a year.%', 'a year is needed');
select t1080.as_user(:'olly');
select t1080.check(t1080.error_of(format('select * from public.sub_1099_totals(%L, 2026)', :'co')) like '42501:%', 'not for the office without the subs area');
select t1080.as_user(:'ed');
select t1080.check(t1080.error_of(format('select * from public.sub_1099_totals(%L, 2026)', :'co')) like '42501:%', 'or an estimator');
select t1080.as_user(:'cy');
select t1080.check(t1080.error_of(format('select * from public.sub_1099_totals(%L, 2026)', :'co')) like '42501:%', 'or the crew');
select t1080.as_user(:'al');
select t1080.check(t1080.error_of(format('select * from public.sub_1099_totals(%L, 2026)', :'co')) like '42501:%', 'or a sub');
select t1080.as_user(:'pat');
select t1080.check(t1080.error_of(format('select * from public.sub_1099_totals(%L, 2026)', :'co')) like '42501:%', 'or another business');
rollback;

-- ===== The workers' comp audit ================================================================
-- Apex's workers' comp: one to Oct 12, replaced by one from Oct 14; a certificate they sent for Oct
-- 13 that the office hasn't checked. Birch has none.
begin;
set local role authenticated;
select t1080.as_user(:'opal');
insert into public.sub_documents (company_id, subcontractor_id, kind, path, carrier, policy_number, starts_on, expires_on) values
  (:'co', :'apex', 'workers_comp', :'co' || '/subs/' || :'apex' || '/wc-2026a.pdf', 'Acme Mutual', 'WC-1', '2026-01-01', '2026-10-12') returning id as wc_a \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path, carrier, policy_number, starts_on, expires_on) values
  (:'co', :'apex', 'workers_comp', :'co' || '/subs/' || :'apex' || '/wc-2026b.pdf', 'Acme Mutual', 'WC-2', '2026-10-14', '2027-10-13') returning id as wc_b \gset
commit;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, starts_on, expires_on, uploaded_via) values
  (:'co', :'apex', 'workers_comp', :'co' || '/subs/' || :'apex' || '/wc-gap.pdf', '2026-10-13', '2026-10-13', 'link');
select t1080.check((select superseded_by = :'wc_b' from public.sub_documents where id = :'wc_a'), 'the first certificate was replaced');

begin;
set local role authenticated;
select t1080.as_user(:'ona');
create temp table t1080_wc as select * from public.sub_wc_audit(:'co', '2026-01-01', '2026-12-31');
select t1080.check((select array_agg(row(sub_name, job_title, work_dates, coverage, amount, covered_amount, uncovered_amount)::text order by sub_name, work_dates[1]) from t1080_wc)
    = array[
      row('Apex Roofing', 'Spring repair', '{2026-03-02}'::date[], 'yes', 1000.00, 1000.00, 0.00)::text,
      row('Apex Roofing', 'New roof', '{2026-10-12,2026-10-13,2026-10-14}'::date[], 'partly', 2700.00, 1800.00, 900.00)::text,
      row('Apex Roofing', 'Card job', '{2026-10-21}'::date[], 'yes', 500.00, 500.00, 0.00)::text,
      row('Birch Gutters Inc', 'Garage roof', '{2026-10-15}'::date[], 'no', 600.00, 0.00, 600.00)::text],
  'each sub''s pay by the days worked (its completed visits, or the day it was done), covered, not or partly, split by days');
select t1080.check((select array_agg(d ->> 'policy_number' || ':' || (d ->> 'replaced') order by d ->> 'policy_number') from t1080_wc, jsonb_array_elements(documents) d where job_title = 'New roof')
    = array['WC-1:true', 'WC-2:false'] and (select covered_dates from t1080_wc where job_title = 'New roof') = '{2026-10-12,2026-10-14}',
  'the certificates that covered it, the replaced one included; one the office hasn''t checked doesn''t count');
select t1080.check((select sum(covered_amount) = 3300 and sum(uncovered_amount) = 1500 from t1080_wc), 'covered and not covered add up');
select t1080.check(not exists (select 1 from t1080_wc where job_title in ('Gutters', 'Last year''s job', 'New Year''s Eve job')), 'not cancelled pay, or work outside the dates');
select t1080.check((select row(coverage, amount, pay_amount)::text from public.sub_wc_audit(:'co', '2026-10-13', '2026-10-13')) = row('no', 900.00, 2700.00)::text,
  'a day on its own, with its share of the pay');
-- A policy year ending Oct 13: the New roof's work is on both sides of it.
select t1080.check((select row(amount, pay_amount, covered_amount, uncovered_amount, work_dates)::text from public.sub_wc_audit(:'co', '2025-10-14', '2026-10-13') where job_title = 'New roof')
    = row(1800.00, 2700.00, 900.00, 900.00, '{2026-10-12,2026-10-13}'::date[])::text
  and (select row(amount, covered_amount, uncovered_amount, coverage)::text from public.sub_wc_audit(:'co', '2026-10-14', '2027-10-13') where job_title = 'New roof')
    = row(900.00, 900.00, 0.00, 'yes')::text,
  'pay with work on both sides of the dates is split by days: each report counts its share, and the shares add up to what was paid');
select t1080.check(t1080.error_of(format('select * from public.sub_wc_audit(%L, %L, %L)', :'co', '2026-12-31', '2026-01-01')) like '22023:%', 'the end is on or after the start');
select t1080.check(t1080.error_of(format('select * from public.sub_wc_audit(%L, %L, %L)', :'co', '2020-01-01', '2026-01-01')) like '22023: Choose two years at most.%', 'two years at most');
select t1080.as_user(:'olly');
select t1080.check(t1080.error_of(format('select * from public.sub_wc_audit(%L, %L, %L)', :'co', '2026-01-01', '2026-12-31')) like '42501:%', 'not for the office without the subs area');
select t1080.as_user(:'lou');
select t1080.check(t1080.error_of(format('select * from public.sub_wc_audit(%L, %L, %L)', :'co', '2026-01-01', '2026-12-31')) like '42501:%', 'or a crew lead');
select t1080.as_user(:'bo');
select t1080.check(t1080.error_of(format('select * from public.sub_wc_audit(%L, %L, %L)', :'co', '2026-01-01', '2026-12-31')) like '42501:%', 'or a sub');
select t1080.as_user(:'pat');
select t1080.check(t1080.error_of(format('select * from public.sub_wc_audit(%L, %L, %L)', :'co', '2026-01-01', '2026-12-31')) like '42501:%', 'or another business');
rollback;

-- What counts as cover: only workers' comp (not liability insurance), and a certificate or an
-- exemption without a start date as a year up to its end (20261025007007_wc_exemption_dates.sql),
-- saying so.
begin;
set local role authenticated;
select t1080.as_user(:'opal');
insert into public.sub_documents (company_id, subcontractor_id, kind, path, carrier, starts_on, expires_on) values
  (:'co', :'birch', 'liability', :'co' || '/subs/' || :'birch' || '/gl.pdf', 'Big Insurer', '2026-01-01', '2026-12-31');
select t1080.check((select coverage from public.sub_wc_audit(:'co', '2026-01-01', '2026-12-31') where job_title = 'Garage roof') = 'no', 'liability insurance isn''t workers'' comp');
insert into public.sub_documents (company_id, subcontractor_id, kind, path, carrier, policy_number, expires_on) values
  (:'co', :'birch', 'workers_comp', :'co' || '/subs/' || :'birch' || '/wc-late.pdf', 'Acme Mutual', 'WC-9', '2027-10-20');
select t1080.check((select coverage from public.sub_wc_audit(:'co', '2026-01-01', '2026-12-31') where job_title = 'Garage roof') = 'no',
  'a certificate with no start date doesn''t cover work from more than a year before it ends');
savepoint exemption;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', :'birch', 'wc_exemption', :'co' || '/subs/' || :'birch' || '/exempt.pdf', '2026-12-31');
select t1080.check((select coverage = 'yes' and documents @> '[{"kind": "wc_exemption", "starts_on": null, "dates_assumed": true}]' from public.sub_wc_audit(:'co', '2026-01-01', '2026-12-31') where job_title = 'Garage roof'),
  'an exemption without a start date covers the work in the year up to its end, and is listed, saying its dates were assumed');
rollback to savepoint exemption;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', :'birch', 'wc_exemption', :'co' || '/subs/' || :'birch' || '/exempt-late.pdf', '2027-12-31');
select t1080.check((select coverage from public.sub_wc_audit(:'co', '2026-01-01', '2026-12-31') where job_title = 'Garage roof') = 'no',
  'but not work from more than a year before it ends: a missing start date never covers all earlier work');
rollback to savepoint exemption;
insert into public.sub_documents (company_id, subcontractor_id, kind, path) values
  (:'co', :'birch', 'wc_exemption', :'co' || '/subs/' || :'birch' || '/exempt-undated.pdf');
select t1080.check((select coverage from public.sub_wc_audit(:'co', '2026-01-01', '2026-12-31') where job_title = 'Garage roof') = 'no',
  'one with no dates at all counts from the day it was added, not before');
rollback to savepoint exemption;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, carrier, policy_number, expires_on) values
  (:'co', :'birch', 'workers_comp', :'co' || '/subs/' || :'birch' || '/wc-now.pdf', 'Acme Mutual', 'WC-10', '2027-03-01');
select t1080.check((select coverage = 'yes' and documents @> '[{"policy_number": "WC-10", "starts_on": null, "dates_assumed": true}]' and not documents @> '[{"policy_number": "WC-9"}]'
    from public.sub_wc_audit(:'co', '2026-01-01', '2026-12-31') where job_title = 'Garage roof'),
  'one ending within a year of the work covers it, taken as a one-year policy and saying so');
rollback;
select t1080.check(private.wc_doc_term('wc_exemption', null, null, '2026-11-01') = daterange('2026-11-01', null, '[]')
  and private.wc_doc_term('wc_exemption', '2026-02-01', null, '2026-11-01') = daterange('2026-02-01', null, '[]')
  and private.wc_doc_term('wc_exemption', null, '2026-12-31', '2026-11-01') = daterange('2026-01-01', '2026-12-31', '[]'),
  'an exemption''s days: from the day it was added with no dates, from its start with no end, a year up to its end with no start');

-- ===== A team member's piece pay, and their pay period =========================================
begin;
set local role authenticated;
select t1080.as_user(:'olly');
select t1080.check((select row(quantity, check_it, note)::text from public.job_pay_suggest(:'j1', null, :'cy'))
    = row(0, true, 'Other pay on this job already counts 27 squares, so none is left. Check it.')::text,
  'Apex''s pay already counts the roof''s squares, so Cy''s suggested share is what''s left (none), flagged (20261025007005_per_unit_pay_shares.sql)');
select public.job_pay_start(:'j1', null, :'cy') as pay_cy \gset
-- The office gives Cy his share.
update public.job_pay_lines set quantity = 23.48 where job_pay_id = :'pay_cy' and basis = 'per_unit';
select t1080.check((select array_agg(visit_id order by visit_id) from public.job_pay_visits where job_pay_id = :'pay_cy') = (select array_agg(x order by x) from unnest(array[:'v1', :'v2']::uuid[]) x)
  and (select total = 234.80 from public.job_pay where id = :'pay_cy'), 'a team member''s pay covers the visits they''re on, at their rate');
select t1080.check((select row(status, earned_on)::text from public.job_pay_accept(:'pay_cy')) = row('done', '2026-10-13'::date)::text,
  'agreed after the work, it''s done straight away, on the day the last of their visits was finished');
select t1080.check(not exists (select 1 from public.visit_assignees where visit_id in (:'v1', :'v2') and user_id not in (:'cy', :'al')), 'nobody is put on a visit for a team member''s pay');
select public.job_pay_start(:'j2', null, :'dee', '{}') as pay_dee \gset
select public.job_pay_accept(:'pay_dee');
select t1080.check((select row(status, earned_on, total)::text from public.job_pay_mark_done(:'pay_dee', '2026-10-16')) = row('done', '2026-10-16'::date, 100.00)::text,
  'pay with no visits is marked done by the office');
select t1080.check(t1080.error_of(format('select * from public.job_pay_mark_paid(array[%L]::uuid[], %L, %L)', :'pay_cy', 'check', '2026-10-20')) like '22023: Pay for people on your team is paid with their pay period%',
  'a team member''s isn''t marked paid on its own');
select t1080.check(t1080.error_of(format('select public.job_pay_start(%L, %L)', :'j3', :'apex')) like '42501:%', 'job costs without subs: no sub''s pay');
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', '2026-10-12', '2026-10-18') returning id as period \gset
select t1080.check(t1080.error_of(format('insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, paid_amount, method, paid_at) values (%L, %L, %L, 8, 160, 160, %L, now())',
  :'co', :'period', :'cy', 'payroll_service')) like '22023: Their piece pay for this period has changed since you looked (it''s now $234.80).%',
  'a line marked paid has to carry the piece pay the database counts for the period');
insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, piece_amount, paid_amount, method, reference, paid_at, paid_by)
  values (:'co', :'period', :'cy', 8, 394.80, 234.80, 394.80, 'payroll_service', 'Run 42', '2026-10-19T16:00:00Z', :'olly');
select t1080.check((select row(status, paid_amount, method, reference, pay_period_id, paid_at)::text from public.job_pay where id = :'pay_cy')
    = row('paid', 234.80, 'payroll', 'Run 42', :'period'::uuid, '2026-10-19T16:00:00Z'::timestamptz)::text,
  'marking them paid for the period pays their piece pay in it, with it');
select t1080.check((select status from public.job_pay where id = :'pay_dee') = 'done', 'and nobody else''s');
-- Locked while the mark holds.
select t1080.check(t1080.error_of(format('update public.job_pay set notes = %L where id = %L', 'x', :'pay_cy')) like '22023: This pay is in a pay period that''s been marked paid.%', 'it stays as it was paid');
select t1080.check(t1080.error_of(format('select public.job_pay_cancel(%L)', :'pay_cy')) like '22023: This pay is marked paid.%', 'isn''t cancelled');
select t1080.check(t1080.error_of(format('select * from public.job_pay_unmark_paid(array[%L]::uuid[])', :'pay_cy')) like '22023: This was paid with a pay period.%', 'or taken back on its own');
select public.job_pay_start(:'j3', null, :'cy', '{}') as pay_cy2 \gset
select public.job_pay_accept(:'pay_cy2');
select t1080.check(t1080.error_of(format('select public.job_pay_mark_done(%L, %L)', :'pay_cy2', '2026-10-14')) like '22023: That day is in a pay period that''s been marked paid.%',
  'no new work is marked done in a period they''ve been paid for');
select t1080.check((select earned_on = '2026-10-19' from public.job_pay_mark_done(:'pay_cy2', '2026-10-19')), 'the next week is open');
-- Taking the period's mark back.
update public.pay_period_lines set paid_at = null, paid_by = null, paid_amount = null, method = null, reference = null where period_id = :'period' and user_id = :'cy';
select t1080.check((select row(status, paid_at, pay_period_id)::text from public.job_pay where id = :'pay_cy') = row('done', null, null)::text,
  'taking the period''s mark back puts their piece pay back to done');
update public.pay_period_lines set paid_at = now(), method = 'check' where period_id = :'period' and user_id = :'cy';
select t1080.check((select row(status, method)::text from public.job_pay where id = :'pay_cy') = row('paid', 'check')::text, 'marked paid again, by check');
delete from public.pay_periods where id = :'period';
select t1080.check((select row(status, pay_period_id)::text from public.job_pay where id = :'pay_cy') = row('done', null)::text, 'and a period deleted leaves it done, for the next one');
commit;

-- ===== Who sees pay ===========================================================================
-- Names to read pay by, whoever's looking (a sub can't read most jobs, or the subs table).
create table t1080.names as
  select id, title as name from public.jobs union all select id, name from public.subcontractors union all select user_id, full_name from public.profiles;
grant select on t1080.names to authenticated;
create function t1080.seen() returns text language sql as $$
  select coalesce(string_agg(j.name || ':' || s.name || ':' || p.status, ', ' order by j.name collate "C", s.name collate "C"), '')
  from public.job_pay p join t1080.names j on j.id = p.job_id join t1080.names s on s.id = coalesce(p.subcontractor_id, p.user_id)
$$;
create function t1080.counts() returns int[] language sql as $$
  select array[(select count(*)::int from public.pay_rates), (select count(*)::int from public.job_pay), (select count(*)::int from public.job_pay_lines), (select count(*)::int from public.job_pay_visits)]
$$;
grant execute on all functions in schema t1080 to authenticated;
-- The company's lines and covered visits, on the team's pay and on subs'.
select count(*) filter (where p.user_id is not null) as team_lines, count(*) filter (where p.subcontractor_id is not null) as sub_lines
from public.job_pay_lines l join public.job_pay p on p.id = l.job_pay_id where p.company_id = :'co' \gset
select count(*) filter (where p.user_id is not null) as team_visits, count(*) filter (where p.subcontractor_id is not null) as sub_visits
from public.job_pay_visits v join public.job_pay p on p.id = v.job_pay_id where p.company_id = :'co' \gset

begin;
set local role authenticated;
select t1080.as_user(:'oz');
select t1080.check(t1080.counts()::text = (select format('{%s,%s,%s,%s}', (select count(*) from public.pay_rates where company_id = :'co'), (select count(*) from public.job_pay where company_id = :'co'),
    (select count(*) from public.job_pay_lines where company_id = :'co'), (select count(*) from public.job_pay_visits where company_id = :'co'))) and (t1080.counts())[2] = 11,
  'the owner sees all of the company''s rates and pay, and nothing of another''s: ' || t1080.counts()::text);
select t1080.as_user(:'ada');
select t1080.check((t1080.counts())[2] = 11, 'so does an admin');
select t1080.as_user(:'opal');
select t1080.check((t1080.counts())[2] = 11, 'and the office with both areas');
select t1080.as_user(:'olly');
select t1080.check(t1080.seen() = 'Garage roof:Dee Crew:done, Gutters:Cy Crew:done, New roof:Cy Crew:done' and (t1080.counts())[1] = 2
    and (t1080.counts())[3] = :team_lines and (t1080.counts())[4] = :team_visits and :team_visits > 0,
  'the office with job costs and not subs: the team''s pay, its lines and visits, and rates, no sub''s: ' || t1080.seen() || ' ' || t1080.counts()::text);
select t1080.as_user(:'ona');
select t1080.check(t1080.seen() not like '%Crew%' and (t1080.counts())[2] = 8 and (t1080.counts())[1] = 5
    and (t1080.counts())[3] = :sub_lines and (t1080.counts())[4] = :sub_visits,
  'the office with subs and not job costs: subs'' pay, its lines and visits, and rates, not the team''s: ' || t1080.seen() || ' ' || t1080.counts()::text);
select t1080.check(t1080.error_of(format('insert into public.job_pay (company_id, job_id, user_id) values (%L, %L, %L)', :'co', :'j3', :'dee')) like '42501:%', 'and can''t give the team piece pay');
select t1080.check(t1080.error_of(format('insert into public.pay_rates (company_id, user_id, basis, rate) values (%L, %L, %L, 5)', :'co', :'dee', 'per_job')) like '42501:%', 'or rates');
select t1080.as_user(:'olly');
select t1080.check(t1080.error_of(format('insert into public.job_pay (company_id, job_id, subcontractor_id) values (%L, %L, %L)', :'co', :'j3', :'cedar')) like '42501:%', 'nor the other way round');
select t1080.as_user(:'ed');
select t1080.check(t1080.counts() = '{0,0,0,0}', 'an estimator sees none');
select t1080.check(t1080.error_of(format('insert into public.job_pay (company_id, job_id, subcontractor_id) values (%L, %L, %L)', :'co', :'j3', :'cedar')) like '42501:%', 'or adds any');
select t1080.as_user(:'lou');
select t1080.check(t1080.counts() = '{0,0,0,0}', 'nor does a crew lead');
select t1080.as_user(:'cy');
select t1080.check(t1080.counts() = '{0,0,0,0}', 'and a team member doesn''t read their own piece pay, as they don''t read their rate');
select t1080.as_user(:'al');
select t1080.check(t1080.seen() = 'Card job:Apex Roofing:paid, Last year''s job:Apex Roofing:paid, New Year''s Eve job:Apex Roofing:paid, New roof:Apex Roofing:paid, Spring repair:Apex Roofing:paid'
    and t1080.counts() = '{0,5,7,3}',
  'a sub reads their own pay (not the draft or what was deleted), its lines and visits, and no rates: ' || t1080.seen() || ' ' || t1080.counts()::text);
select t1080.as_user(:'bo');
select t1080.check(t1080.seen() = 'Garage roof:Birch Gutters Inc:paid', 'Bo reads Birch''s');
select t1080.as_user(:'pat');
select t1080.check(t1080.seen() = 'Driveway:Papa''s own sub:draft', 'another business sees only its own');
rollback;

-- Changing lines and covered visits, and the office's functions, by anyone who doesn't handle that
-- pay. Drafts, so the database's lock on done work doesn't answer first: Apex's draft on the garage
-- roof (covering its visit), and a draft of Dee's on the gutters.
-- As whoever's signed in, nothing is added to a pay's lines or visits (p_company: the business it's in), and nothing changed or deleted.
create function t1080.untouched(p_company uuid, p_pay uuid, p_visit uuid, p_what text) returns void language plpgsql as $$
begin
  perform t1080.check(t1080.error_of(format('insert into public.job_pay_lines (company_id, job_pay_id, description, quantity, rate) values (%L, %L, %L, 1, 500)',
    p_company, p_pay, 'Bonus')) like '42501:%', p_what || ': adds no line');
  perform t1080.check(t1080.error_of(format('insert into public.job_pay_visits (company_id, job_pay_id, visit_id) values (%L, %L, %L)',
    p_company, p_pay, p_visit)) like '42501:%', p_what || ': covers no visit');
  perform t1080.check(t1080.changed(format('update public.job_pay_lines set rate = 9999 where job_pay_id = %L', p_pay)) = 0
    and t1080.changed(format('delete from public.job_pay_lines where job_pay_id = %L', p_pay)) = 0
    and t1080.changed(format('delete from public.job_pay_visits where job_pay_id = %L', p_pay)) = 0, p_what || ': changes and deletes nothing');
end $$;
grant execute on function t1080.untouched(uuid, uuid, uuid, text) to authenticated;
begin;
set local role authenticated;
select t1080.as_user(:'opal');
insert into public.job_pay_visits (company_id, job_pay_id, visit_id) values (:'co', :'pay_apex_draft', :'w1');
select t1080.as_user(:'olly');
select public.job_pay_start(:'j3', null, :'dee', array[:'g1']::uuid[]) as team_draft \gset
select t1080.as_user(:'ona');
select t1080.untouched(:'co', :'team_draft', :'g2', 'the office without job costs, on a team member''s pay');
select t1080.as_user(:'olly');
select t1080.untouched(:'co', :'pay_apex_draft', :'w1', 'the office without the subs area, on a sub''s');
select t1080.as_user(:'ed');
select t1080.untouched(:'co', :'pay_apex_draft', :'w1', 'an estimator');
select t1080.as_user(:'lou');
select t1080.untouched(:'co', :'team_draft', :'g2', 'a crew lead');
select t1080.as_user(:'cy');
select t1080.untouched(:'co', :'team_draft', :'g2', 'the crew');
select t1080.as_user(:'pat');
select t1080.untouched(:'co', :'pay_apex_draft', :'w1', 'another business');
select t1080.as_user(:'oz');
select t1080.check((select count(*) from public.job_pay_lines where job_pay_id = :'pay_apex_draft') = 3 and (select count(*) from public.job_pay_lines where job_pay_id = :'team_draft') = 1
  and (select array_agg(visit_id) from public.job_pay_visits where job_pay_id = :'pay_apex_draft') = array[:'w1']::uuid[]
  and (select array_agg(visit_id) from public.job_pay_visits where job_pay_id = :'team_draft') = array[:'g1']::uuid[],
  'and the lines and visits are as they were');
-- The office's functions, refused for each the same way: by whose pay it is, at every level, and in another business.
select t1080.refused_all(:'olly', :'pay_apex_draft', :'j3', :'cedar', null, 'the office without the subs area, on a sub''s pay');
select t1080.refused_all(:'ona', :'pay_dee', :'j3', null, :'dee', 'the office without job costs, on a team member''s');
select t1080.refused_all(:'ona', :'team_draft', :'j3', null, :'cy', 'or their draft');
select t1080.refused_all(:'ed', :'pay_apex_draft', :'j3', :'cedar', null, 'an estimator');
select t1080.refused_all(:'lou', :'pay_apex_draft', :'j3', :'cedar', null, 'a crew lead');
select t1080.refused_all(:'cy', :'team_draft', :'j3', null, :'cy', 'the crew, even for their own');
select t1080.refused_all(:'al', :'pay_apex_draft', :'j3', :'apex', null, 'a sub, even for their own');
select t1080.refused_all(:'pat', :'pay_apex_draft', :'j3', :'cedar', null, 'another business');
rollback;

-- ===== Which visits pay covers, and who goes on them ===========================================
begin;
set local role authenticated;
select t1080.as_user(:'opal');
select t1080.check((select row(visit_ids, sign_ins)::text from public.job_pay_covers(:'j1', :'apex'))
    = row((select array_agg(visit_id order by s.scheduled_on, s.starts_at, s.id) from public.job_pay_visits jv join public.visits s on s.id = jv.visit_id where jv.job_pay_id = :'pay_a'), 1)::text
  and (select row(visit_ids, sign_ins)::text from public.job_pay_covers(:'j1', :'cedar')) = row('{}'::uuid[], 0)::text,
  'before new pay: the visits it would cover (their pay''s on the job already, else theirs) and how many of a sub''s sign-ins go on them');
-- A visit Dee's crew has, with nobody on it by name.
insert into public.visits (company_id, job_id, property_id, title, scheduled_on, crew_id) values (:'co', :'j1', :'prop', 'Cleanup', '2026-10-15', :'crew') returning id as crewvisit \gset
select t1080.check((select row(visit_ids, sign_ins)::text from public.job_pay_covers(:'j1', null, :'dee')) = row(array[:'crewvisit']::uuid[], null::integer)::text,
  'a team member''s include the visits their crew has');
select public.job_pay_start(:'j1', null, :'dee') as dee_crew \gset
select t1080.check((select array_agg(visit_id) from public.job_pay_visits where job_pay_id = :'dee_crew') = array[:'crewvisit']::uuid[], 'and pay started for them covers those');
select t1080.check(t1080.error_of(format('insert into public.job_pay (company_id, job_id, user_id) values (%L, %L, %L)', :'co', :'j1', :'cy')) like '23505:%',
  'one live pay per team member per job, too');
select t1080.check(t1080.error_of(format('insert into public.job_pay (company_id, job_id, user_id) values (%L, %L, %L)', :'co', :'j3', :'al')) like '22023: Piece pay is for people on your team.%',
  'piece pay isn''t for a sub''s sign-in');
-- Agreed with nothing ticked: it covers nothing (the office marks it done itself).
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'w1', :'cy');
select public.job_pay_start(:'j2', null, :'cy', array[:'w1']::uuid[]) as cy_none \gset
delete from public.job_pay_visits where job_pay_id = :'cy_none';
select t1080.check((select status = 'accepted' from public.job_pay_accept(:'cy_none')), 'agreed with nothing ticked, it isn''t done');
select t1080.check(not exists (select 1 from public.job_pay_visits where job_pay_id = :'cy_none'),
  'a team member''s pay agreed with every visit unticked covers none, not the visits they''re on');
rollback;

-- Agreeing with the visits chosen then.
begin;
set local role authenticated;
select t1080.as_user(:'opal');
select public.job_pay_start(:'j1', :'birch', null, array[:'v1']::uuid[]) as birch_pay \gset
select t1080.check(t1080.error_of(format('select public.job_pay_accept(%L, array[%L]::uuid[])', :'birch_pay', :'w1')) like '22023: Choose visits on this job.%', 'the visits chosen are the job''s');
select t1080.check((select status = 'accepted' from public.job_pay_accept(:'birch_pay', array[:'v3', :'vf']::uuid[])), 'agreed with the visits chosen');
select t1080.check((select array_agg(visit_id order by visit_id) from public.job_pay_visits where job_pay_id = :'birch_pay') = (select array_agg(x order by x) from unnest(array[:'v3', :'vf']::uuid[]) x),
  'agreeing with visits chosen covers exactly those');
select t1080.check((select array_agg(visit_id order by visit_id) from public.visit_assignees where user_id = :'bo' and visit_id in (:'v1', :'v3', :'vf')) = (select array_agg(x order by x) from unnest(array[:'v3', :'vf']::uuid[]) x)
    and (select bool_and(assigned = array[:'bo']::uuid[]) from public.job_pay_visits where job_pay_id = :'birch_pay'),
  'and puts the sub on those, not on the one taken out');
rollback;

-- Someone already on a visit stays on it.
begin;
set local role authenticated;
select t1080.as_user(:'opal');
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'v3', :'bo');
select public.job_pay_start(:'j1', :'birch', null, array[:'v3']::uuid[]) as birch_pay \gset
select public.job_pay_accept(:'birch_pay');
select t1080.check((select assigned from public.job_pay_visits where job_pay_id = :'birch_pay') = '{}', 'a sub already on the visit isn''t noted as this pay''s doing');
select public.job_pay_cancel(:'birch_pay');
select t1080.check(exists (select 1 from public.visit_assignees where visit_id = :'v3' and user_id = :'bo'), 'so cancelling the pay leaves them on it');
select public.job_pay_start(:'j1', :'birch', null, array[:'v3']::uuid[]) as birch_again \gset
select public.job_pay_accept(:'birch_again');
delete from public.job_pay_visits where job_pay_id = :'birch_again';
select t1080.check(exists (select 1 from public.visit_assignees where visit_id = :'v3' and user_id = :'bo'), 'and so does taking the visit out of it');
rollback;

-- A sign-in that's been turned off isn't put on visits.
begin;
update public.memberships set active = false where company_id = :'co' and user_id = :'bo';
set local role authenticated;
select t1080.as_user(:'opal');
select t1080.check((select sign_ins from public.job_pay_covers(:'j1', :'birch')) = 0, 'a sub whose sign-in is off has none to put on visits');
select public.job_pay_start(:'j1', :'birch', null, array[:'v3']::uuid[]) as birch_pay \gset
select public.job_pay_accept(:'birch_pay');
select t1080.check(not exists (select 1 from public.visit_assignees where visit_id = :'v3' and user_id = :'bo') and (select assigned from public.job_pay_visits where job_pay_id = :'birch_pay') = '{}',
  'so agreeing their pay puts nobody on the visit');
rollback;

-- Marked done by the office with a visit still to do: reopening another visit doesn't undo that.
begin;
set local role authenticated;
select t1080.as_user(:'opal');
select public.job_pay_start(:'j1', :'birch', null, array[:'v2', :'v3']::uuid[]) as birch_pay \gset
select public.job_pay_accept(:'birch_pay');
select public.job_pay_mark_done(:'birch_pay', '2026-10-20');
update public.visits set status = 'in_progress' where id = :'v2';
select t1080.check((select row(status, earned_on)::text from public.job_pay where id = :'birch_pay') = row('done', '2026-10-20'::date)::text,
  'pay the office marked done, with a visit it covers still open, stays done when another is reopened');
update public.visits set status = 'completed', completed_at = '2026-10-13T22:00:00Z' where id = :'v2';
select t1080.check((select row(status, earned_on)::text from public.job_pay where id = :'birch_pay') = row('done', '2026-10-20'::date)::text, 'and when it''s finished again');
rollback;

-- ===== Done by itself, after a pay period's been paid ==========================================
-- Dee is marked paid for Oct 5 to 11. Work she finished on Oct 8, agreed now, counts from Oct 12: in
-- the next period, not one she's been paid for (where it would never be paid).
begin;
set local role authenticated;
select t1080.as_user(:'opal');
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', '2026-10-05', '2026-10-11') returning id as p1 \gset
insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, piece_amount, paid_amount, method, paid_at, paid_by)
  values (:'co', :'p1', :'dee', 0, 0, 0, 0, 'check', '2026-10-12T16:00:00Z', :'opal');
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', '2026-10-12', '2026-10-18') returning id as p2 \gset
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', '2026-10-19', '2026-10-25') returning id as p3 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on, status, completed_at) values (:'co', :'j3', :'prop', 'Downspouts', '2026-10-08', 'completed', '2026-10-08T16:00:00Z') returning id as x1 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'x1', :'dee');
select public.job_pay_start(:'j3', null, :'dee') as dee_late \gset
select t1080.check((select row(status, earned_on)::text from public.job_pay_accept(:'dee_late')) = row('done', '2026-10-12'::date)::text,
  'agreed after work finished in a period they''ve been paid for, it''s done from the day after that period');
reset role;
select t1080.check(not exists (select 1 from private.period_piece(:'p1', :'dee') where id = :'dee_late') and exists (select 1 from private.period_piece(:'p2', :'dee') where id = :'dee_late'),
  'so the next period pays it, not the paid one');
set local role authenticated;
select t1080.as_user(:'opal');
-- Oct 12 to 18 is paid too (her piece pay in it with it). A visit she finishes on Oct 9 now counts from Oct 19.
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'prop', 'Touch-up', '2026-10-09') returning id as x2 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'x2', :'dee');
select public.job_pay_start(:'j1', null, :'dee') as dee_open \gset
select public.job_pay_accept(:'dee_open');
insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount, piece_amount, paid_amount, method, paid_at, paid_by)
  values (:'co', :'p2', :'dee', 0, 200, 200, 200, 'check', '2026-10-19T16:00:00Z', :'opal');
select t1080.check((select status from public.job_pay where id = :'dee_late') = 'paid', 'that period paid her piece pay in it');
update public.visits set status = 'completed', completed_at = '2026-10-09T16:00:00Z' where id = :'x2';
select t1080.check((select row(status, earned_on)::text from public.job_pay where id = :'dee_open') = row('done', '2026-10-19'::date)::text,
  'a visit completed on a day in a paid period finishes the pay on the first day after every paid period that day runs into');
reset role;
select t1080.check(exists (select 1 from private.period_piece(:'p3', :'dee') where id = :'dee_open') and not exists (select 1 from private.period_piece(:'p2', :'dee') where id = :'dee_open'),
  'and the next open period counts it');
rollback;

-- ===== Job costs ==============================================================================
select t1080.check((select array_agg(unit_labor_cost order by name, quantity) from public.job_line_items where job_id = :'j1') = '{120,120,120}'::numeric[],
  'lines going on a job take the labor in their service''s cost: from the quote, its change order and by hand');
select t1080.check((select unit_labor_cost from public.job_line_items where job_id = :'j3') is null, 'a service without a labor cost has none');
begin;
set local role authenticated;
select t1080.as_user(:'opal');
select t1080.check((select array_agg(row(job_id = :'j1', amount, payees)::text order by amount desc) from public.job_pay_costs(array[:'j1', :'j2', :'j3']::uuid[]))
    = array[row(true, 2934.80, 2)::text, row(false, 700.00, 2)::text, row(false, 0.00, 1)::text],
  'each job''s sub and crew pay that''s agreed, done or paid (what was paid, else the total), not drafts or cancelled pay');
select t1080.as_user(:'olly');
select t1080.check((select count(*) from public.job_pay_costs(array[:'j1']::uuid[])) = 1, 'for the office with job costs, subs'' pay included');
select t1080.as_user(:'ona');
select t1080.check(not exists (select 1 from public.job_pay_costs(array[:'j1']::uuid[])), 'not without job costs');
select t1080.as_user(:'lou');
select t1080.check(not exists (select 1 from public.job_pay_costs(array[:'j1']::uuid[])), 'or for a crew lead');
select t1080.as_user(:'al');
select t1080.check(not exists (select 1 from public.job_pay_costs(array[:'j1']::uuid[])), 'or a sub');
select t1080.as_user(:'pat');
select t1080.check(not exists (select 1 from public.job_pay_costs(array[:'j1']::uuid[])), 'or another business');
rollback;

-- A service a paid line names still comes off the price list (with its rates); the line keeps its words and numbers.
begin;
set local role authenticated;
select t1080.as_user(:'opal');
delete from public.services where id = :'shingles';
select t1080.check((select row(description, service_id, pay_rate_id, amount)::text from public.job_pay_lines where job_pay_id = :'pay_a' and basis = 'per_unit')
    = row('Architectural shingles', null::uuid, null::uuid, 2025.00)::text and not exists (select 1 from public.pay_rates where service_id = :'shingles'),
  'a service on paid pay can still be deleted: its rates go, and the paid line keeps what it said');
rollback;

\o
\echo 'All job pay tests passed.'
