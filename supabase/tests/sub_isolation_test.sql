-- Database tests for subs' own sign-ins (20261025002001_subcontractor_level.sql to
-- 20261025002004_sub_paperwork_sign_ins.sql, their pay from 20261025003001_job_pay.sql and their offers
-- from 20261025004001_sub_offers.sql): a sub is an outsider who reaches their own visits, paperwork, pay
-- and offers and nothing else.
--
-- The guard against forgetting: signed in as a sub, every table in public with row-level security
-- and every view is read (the list comes from pg_class as the test runs, not from a list here), and
-- each must show exactly the rows on the allow-list below, or none. Every one holds a row here, so a
-- leak would show: a table added later is empty, and fails until it's given a row (or a reason it
-- can't have one). Whatever the data, the rules that let a sub in must be on the tables decided for
-- them, and every view must run as the person reading it. Every stored file and every function a
-- signed-in person can call is covered too: a new function fails the list below until someone
-- decides what a sub gets from it.
--
-- Then each rule that lets a sub back in, against the other levels and companies it must not let
-- in; what the team keeps; and how sign-ins are made.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1070;
grant usage on schema t1070 to authenticated, service_role;
create function t1070.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1070.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- How many rows a statement changed (0 when row-level security hid every row from it).
create function t1070.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
-- A list in one fixed order, to compare with another.
create function t1070.sorted(p text[]) returns text[] language sql immutable as $$
  select array(select x from unnest(p) x order by x collate "C")
$$;
grant execute on all functions in schema t1070 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('d1070000-0000-0000-0000-000000000001', 'oz@oscar.test', '{"full_name": "Oz Owner"}'),
  ('d1070000-0000-0000-0000-000000000002', 'opal@oscar.test', '{"full_name": "Opal Office"}'),
  ('d1070000-0000-0000-0000-000000000003', 'lou@oscar.test', '{"full_name": "Lou Lead"}'),
  ('d1070000-0000-0000-0000-000000000004', 'cy@oscar.test', '{"full_name": "Cy Crew"}'),
  ('d1070000-0000-0000-0000-000000000005', 'al@apex.test', '{"full_name": "Al Apex"}'),
  ('d1070000-0000-0000-0000-000000000006', 'bo@birch.test', '{"full_name": "Bo Birch"}'),
  ('d1070000-0000-0000-0000-000000000007', 'pat@papa.test', '{"full_name": "Pat Papa"}'),
  ('d1070000-0000-0000-0000-000000000008', 'sid@shared.test', '{"full_name": "Sid Shared"}'),
  ('d1070000-0000-0000-0000-000000000009', 'sub-d1070000-0000-0000-0000-0000000000c3@subs.invalid', '{"full_name": "Cal Cedar"}');
-- The sign-ins the office made for its subs carry their mark (services/subAccess.ts); Sid's is his own.
update auth.users set raw_app_meta_data = jsonb_build_object('crewtavo_sub', 'oscar:' || right(id::text, 1))
where id in ('d1070000-0000-0000-0000-000000000005', 'd1070000-0000-0000-0000-000000000006', 'd1070000-0000-0000-0000-000000000009');

-- Oscar Roofing works in daytime somewhere, so its reminders go out now (from 8 in the morning).
select name as tz from pg_timezone_names where name ~ '^Etc/GMT[+-][0-9]+$' and extract(hour from now() at time zone name) between 9 and 20
  order by utc_offset desc limit 1 \gset

-- ===== Oscar Roofing ===========================================================================
-- Oz owns it; Opal in the office; Lou leads the Roofing crew with Cy on it. Apex Roofing (Al) and
-- Birch Gutters (Bo) are subs who sign in; Cedar Siding (Cal, with no email of their own) is a sub
-- the office has turned off. Papa Paving is another business, owned by Pat.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Oscar Roofing', 'roofing', :'tz') as co \gset
update public.companies set phone = '+15405550100', settings = settings || jsonb_build_object(
  'clock', jsonb_build_object('record_location', true, 'breaks', 'paid'),
  'branding', jsonb_build_object('color', '#225588', 'logo', :'co' || '/logo/d1070000-0000-0000-0000-0000000000f1.png', 'logo_size', jsonb_build_array(96, 48)),
  'working_hours', jsonb_build_object('start', '07:00', 'end', '17:00'),
  'assistants', jsonb_build_object('enabled', true), 'depot', jsonb_build_object('lat', 40.1, 'lng', -75.1),
  'default_tax_rate', 0.06, 'payment_terms_days', 15)
where id = :'co';
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'd1070000-0000-0000-0000-000000000002', 'office'),
  (:'co', 'd1070000-0000-0000-0000-000000000003', 'crew_lead'),
  (:'co', 'd1070000-0000-0000-0000-000000000004', 'field_crew');
insert into public.subcontractors (id, company_id, name, contact_name, phone, email, trade, notes) values
  ('d1070000-0000-0000-0000-0000000000c1', :'co', 'Apex Roofing LLC', 'Al Apex', '+15405550101', 'al@apex.test', 'Roofing', 'Slow to send invoices'),
  ('d1070000-0000-0000-0000-0000000000c2', :'co', 'Birch Gutters', 'Bo Birch', '+15405550102', 'bo@birch.test', 'Gutters', null),
  ('d1070000-0000-0000-0000-0000000000c3', :'co', 'Cedar Siding', 'Cal Cedar', '+15405550103', null, 'Siding', null);
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Roofing', 'd1070000-0000-0000-0000-000000000003') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', 'd1070000-0000-0000-0000-000000000004');
insert into public.clients (company_id, display_name, phone, email) values (:'co', 'Ann Client', '+15405550111', 'ann@client.test') returning id as c1 \gset
insert into public.clients (company_id, display_name, phone) values (:'co', 'Bob Other', '+15405550112') returning id as c2 \gset
insert into public.client_contacts (company_id, client_id, name) values (:'co', :'c1', 'Ann''s husband');
insert into public.properties (company_id, client_id, line1) values (:'co', :'c1', '1 Oak St') returning id as p1 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c2', '2 Elm St') returning id as p2 \gset
insert into public.property_access (company_id, property_id, gate_code, lockbox_code) values (:'co', :'p1', '1234', '77'), (:'co', :'p2', '9999', null);
insert into public.requests (company_id, client_id, property_id, title, details) values (:'co', :'c1', :'p1', 'Roof leak', 'Over the kitchen') returning id as r1 \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'c1', 'New roof') returning id as q1 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price) values (:'co', :'q1', 'Architectural shingles', 24, 450);
insert into public.jobs (company_id, client_id, property_id, title, instructions) values (:'co', :'c1', :'p1', 'New roof', 'Dog in the yard') returning id as j1 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'c2', :'p2', 'Gutters') returning id as j2 \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, sort) values
  (:'co', :'j1', 'Architectural shingles', 24, 'sq', 450, 1), (:'co', :'j1', 'Discount', 1, 'ea', -200, 2), (:'co', :'j2', 'Seamless gutters', 120, 'lf', 12, 1);
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'Architectural shingles', 'sq', 450, 300);
insert into public.equipment (company_id, name, kind) values (:'co', 'Dump trailer', 'trailer') returning id as e1 \gset
insert into public.equipment (company_id, name, kind) values (:'co', 'Shingle lift', 'other') returning id as e2 \gset
insert into public.equipment_plans (company_id, equipment_id, name, every_count, every_unit) values (:'co', :'e1', 'Grease the axle', 3, 'month');
insert into public.equipment_logs (company_id, equipment_id, kind, done_on) values (:'co', :'e1', 'repair', current_date);
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'p1', 'Tear off and shingle', private.company_today(:'co')) returning id as v1 \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j1', :'p1', 'Clean up', private.company_today(:'co') + 1) returning id as v2 \gset
insert into public.visits (company_id, request_id, property_id, title, kind, scheduled_on) values (:'co', :'r1', :'p1', 'Look at the leak', 'assessment', private.company_today(:'co')) returning id as va \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'j2', :'p2', 'Hang gutters', private.company_today(:'co')) returning id as v3 \gset
insert into public.visit_equipment (company_id, visit_id, equipment_id) values (:'co', :'v1', :'e1'), (:'co', :'v2', :'e2');
insert into public.checklist_templates (company_id, name, items, active) values (:'co', 'Roof check', '[]', true) returning id as tmpl_a \gset
insert into public.checklist_templates (company_id, name, items, active) values (:'co', 'Old roof check', '[]', false) returning id as tmpl_b \gset
insert into public.checklist_templates (company_id, name, items, active) values (:'co', 'Retired', '[]', false);
insert into public.checklist_responses (company_id, visit_id, template_id, answers) values (:'co', :'v1', :'tmpl_b', '{"deck": true}'), (:'co', :'v2', :'tmpl_a', '{}');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values
  (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000a1.jpg', 'before.jpg'),
  (:'co', 'visit', :'v2', :'co' || '/visit/' || :'v2' || '/d1070000-0000-0000-0000-0000000000a2.jpg', 'after.jpg'),
  (:'co', 'job', :'j1', :'co' || '/job/' || :'j1' || '/d1070000-0000-0000-0000-0000000000a3.pdf', 'contract.pdf');
insert into public.plan_files (company_id, job_id, title, path, file_name, crew_visible) values
  (:'co', :'j1', 'Roof plan', :'co' || '/plans/d1070000-0000-0000-0000-0000000000b1.pdf', 'roof.pdf', true),
  (:'co', :'j1', 'Signed contract', :'co' || '/plans/d1070000-0000-0000-0000-0000000000b2.pdf', 'contract.pdf', false),
  (:'co', :'j2', 'Gutter plan', :'co' || '/plans/d1070000-0000-0000-0000-0000000000b3.pdf', 'gutters.pdf', true);
insert into public.messages (company_id, client_id, channel, direction, body) values (:'co', :'c1', 'note', 'internal', 'Gate sticks');
insert into public.invoices (company_id, client_id, job_id) values (:'co', :'c1', :'j1');
insert into public.expenses (company_id, amount, user_id, job_id) values (:'co', 54.20, 'd1070000-0000-0000-0000-000000000004', :'j1');
insert into public.job_materials (company_id, job_id, name, quantity, unit, logged_by) values (:'co', :'j1', 'Shingles', 26, 'sq', 'd1070000-0000-0000-0000-000000000001');
insert into public.routes (company_id, crew_id, route_date) values (:'co', :'crew', private.company_today(:'co'));
insert into public.measurements (company_id, property_id, geojson) values (:'co', :'p1', '{"type": "FeatureCollection", "features": []}');
insert into public.sop_categories (company_id, name) values (:'co', 'Safety') returning id as cat \gset
insert into public.sop_pages (company_id, category_id, title, status) values (:'co', :'cat', 'Ladder safety', 'published');
insert into public.promo_codes (company_id, code, kind, value) values (:'co', 'SPRING', 'percent', 10);
insert into public.user_signatures (company_id, user_id, image) values (:'co', 'd1070000-0000-0000-0000-000000000001', 'data:image/png;base64,AAAA');
insert into public.time_entries (company_id, user_id, category, started_at, ended_at) values
  (:'co', 'd1070000-0000-0000-0000-000000000004', 'shop', now() - interval '3 hours', now() - interval '2 hours'),
  (:'co', 'd1070000-0000-0000-0000-000000000005', 'visit', now() - interval '5 hours', now() - interval '4 hours');
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', 'd1070000-0000-0000-0000-0000000000c1', 'w9', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9.pdf', null),
  (:'co', 'd1070000-0000-0000-0000-0000000000c1', 'liability', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/gl.pdf', private.company_today(:'co') + 10),
  (:'co', 'd1070000-0000-0000-0000-0000000000c2', 'w9', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c2/w9.pdf', null);
select public.chat_set_enabled(:'co', true);
select id as general from public.chat_channels where company_id = :'co' and name = 'general' \gset
insert into public.chat_messages (company_id, channel_id, author_id, body) values (:'co', :'general', 'd1070000-0000-0000-0000-000000000001', 'Roof at 1 Oak St starts today');
commit;

-- Papa Paving. Pat puts Al on one of Papa's visits, though Al has no sign-in there.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select public.create_company('Papa Paving', 'paving', :'tz') as other \gset
insert into public.clients (company_id, display_name, phone) values (:'other', 'Papa client', '+15405550199') returning id as pc \gset
insert into public.properties (company_id, client_id, line1) values (:'other', :'pc', '9 Papa Way') returning id as pp \gset
insert into public.property_access (company_id, property_id, gate_code) values (:'other', :'pp', '4242');
insert into public.jobs (company_id, client_id, property_id, title) values (:'other', :'pc', :'pp', 'Driveway') returning id as pj \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'other', :'pj', :'pp', 'Pave the drive', private.company_today(:'other')) returning id as pv \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'other', :'pv', 'd1070000-0000-0000-0000-000000000005');
insert into public.subcontractors (id, company_id, name) values ('d1070000-0000-0000-0000-0000000000c9', :'other', 'Papa''s own sub');
commit;

-- The sign-ins, as the server makes them (it has no signed-in person).
insert into public.memberships (company_id, user_id, role, subcontractor_id) values
  (:'co', 'd1070000-0000-0000-0000-000000000005', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c1'),
  (:'co', 'd1070000-0000-0000-0000-000000000006', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c2'),
  (:'co', 'd1070000-0000-0000-0000-000000000009', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c3');
update public.subcontractors set active = false where id = 'd1070000-0000-0000-0000-0000000000c3';

-- The office puts Al on today's roof visit and the look at the leak, Bo on the gutters, and Cal on
-- the roof too; Cy is on the roof visit and the clean-up.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.visit_assignees (company_id, visit_id, user_id) values
  (:'co', :'v1', 'd1070000-0000-0000-0000-000000000005'), (:'co', :'va', 'd1070000-0000-0000-0000-000000000005'),
  (:'co', :'v3', 'd1070000-0000-0000-0000-000000000006'), (:'co', :'v1', 'd1070000-0000-0000-0000-000000000009'),
  (:'co', :'v1', 'd1070000-0000-0000-0000-000000000004'), (:'co', :'v2', 'd1070000-0000-0000-0000-000000000004');
commit;
select t1070.check((select count(*) from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000005' and kind = 'schedule' and company_id = :'co') = 1,
  'a sub put on visits hears about it, as the crew does');
select t1070.check(not exists (select 1 from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000009'),
  'but not a sub the office turned off (push, text or email), though they''re still on the visit');

-- Pay for the work: Apex's agreed price for the roof (Al is already on its visit), a draft for Apex on
-- the gutters, Birch's agreed price for the gutters, and Cy's piece pay on the roof.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.pay_rates (company_id, subcontractor_id, basis, rate, description) values (:'co', 'd1070000-0000-0000-0000-0000000000c1', 'per_job', 1800, 'Tear off and shingle');
insert into public.pay_rates (company_id, subcontractor_id, basis, rate) values (:'co', 'd1070000-0000-0000-0000-0000000000c2', 'per_job', 600);
insert into public.pay_rates (company_id, user_id, basis, rate) values (:'co', 'd1070000-0000-0000-0000-000000000004', 'per_job', 150);
select public.job_pay_start(:'j1', 'd1070000-0000-0000-0000-0000000000c1', null, array[:'v1']::uuid[]) as al_pay \gset
select public.job_pay_accept(:'al_pay');
select public.job_pay_start(:'j2', 'd1070000-0000-0000-0000-0000000000c1', null, '{}') as al_draft \gset
select public.job_pay_start(:'j2', 'd1070000-0000-0000-0000-0000000000c2', null, array[:'v3']::uuid[]) as bo_pay \gset
select public.job_pay_accept(:'bo_pay');
select public.job_pay_start(:'j1', null, 'd1070000-0000-0000-0000-000000000004') as cy_pay \gset
select public.job_pay_accept(:'cy_pay');
commit;

-- Their own things, and the stored files.
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('d1070000-0000-0000-0000-000000000005', 'https://push.example/al', 'p256dh-al-xxxxxxxxxxxxxxxx', 'auth-al-x'),
  ('d1070000-0000-0000-0000-000000000002', 'https://push.example/opal', 'p256dh-opal-xxxxxxxxxxxxxx', 'auth-opal');
insert into public.notification_prefs (company_id, user_id) values (:'co', 'd1070000-0000-0000-0000-000000000005'), (:'co', 'd1070000-0000-0000-0000-000000000002');
delete from public.notifications;
insert into public.notifications (company_id, user_id, kind, title) values
  (:'co', 'd1070000-0000-0000-0000-000000000005', 'schedule', 'You''re on Tear off and shingle'),
  (:'co', 'd1070000-0000-0000-0000-000000000005', 'subs', 'Your liability insurance ends in 10 days'),
  (:'co', 'd1070000-0000-0000-0000-000000000002', 'subs', 'Apex Roofing LLC''s liability insurance ends in 10 days'),
  (:'co', 'd1070000-0000-0000-0000-000000000006', 'schedule', 'You''re on Hang gutters'),
  (:'other', 'd1070000-0000-0000-0000-000000000005', 'schedule', 'You''re on Pave the drive');
insert into storage.objects (bucket_id, name, owner) values
  ('files', :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000a1.jpg', 'd1070000-0000-0000-0000-000000000004'),
  ('files', :'co' || '/visit/' || :'va' || '/d1070000-0000-0000-0000-0000000000a4.jpg', 'd1070000-0000-0000-0000-000000000002'),
  ('files', :'co' || '/visit/' || :'v2' || '/d1070000-0000-0000-0000-0000000000a2.jpg', 'd1070000-0000-0000-0000-000000000004'),
  ('files', :'co' || '/visit/' || :'v3' || '/d1070000-0000-0000-0000-0000000000a5.jpg', 'd1070000-0000-0000-0000-000000000006'),
  ('files', :'co' || '/job/' || :'j1' || '/d1070000-0000-0000-0000-0000000000a3.pdf', 'd1070000-0000-0000-0000-000000000001'),
  ('files', :'co' || '/plans/d1070000-0000-0000-0000-0000000000b1.pdf', 'd1070000-0000-0000-0000-000000000001'),
  ('files', :'co' || '/plans/d1070000-0000-0000-0000-0000000000b2.pdf', 'd1070000-0000-0000-0000-000000000001'),
  ('files', :'co' || '/plans/d1070000-0000-0000-0000-0000000000b3.pdf', 'd1070000-0000-0000-0000-000000000001'),
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9.pdf', 'd1070000-0000-0000-0000-000000000002'),
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/gl.pdf', 'd1070000-0000-0000-0000-000000000002'),
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c2/w9.pdf', 'd1070000-0000-0000-0000-000000000002'),
  ('files', :'co' || '/avatars/d1070000-0000-0000-0000-000000000005/d1070000-0000-0000-0000-0000000000d1.jpg', null),
  ('files', :'co' || '/avatars/d1070000-0000-0000-0000-000000000002/d1070000-0000-0000-0000-0000000000d2.jpg', null),
  ('files', :'co' || '/receipts/d1070000-0000-0000-0000-0000000000d3.jpg', 'd1070000-0000-0000-0000-000000000004'),
  ('files', :'co' || '/chat/' || :'general' || '/d1070000-0000-0000-0000-0000000000d4.jpg', 'd1070000-0000-0000-0000-000000000001'),
  ('files', :'co' || '/logo/d1070000-0000-0000-0000-0000000000f1.png', null),
  ('files', :'co' || '/tickets/' || :'j1' || '/d1070000-0000-0000-0000-0000000000d5.jpg', 'd1070000-0000-0000-0000-000000000001'),
  ('files', :'other' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000d6.jpg', 'd1070000-0000-0000-0000-000000000007'),
  ('files', :'other' || '/visit/' || :'pv' || '/d1070000-0000-0000-0000-0000000000d7.jpg', 'd1070000-0000-0000-0000-000000000007');

-- One row in each table the rest of the fixture leaves empty, so a leak in any of them would show
-- in the sweep below (written as the server would, past row-level security).
select id as shingles_service from public.services where company_id = :'co' limit 1 \gset
select id as ladder_page from public.sop_pages where company_id = :'co' limit 1 \gset
select id as first_chat from public.chat_messages where company_id = :'co' limit 1 \gset
select id as roof_invoice from public.invoices where company_id = :'co' limit 1 \gset
insert into public.app_secrets (name, ciphertext) values ('t1070', 'sealed');
insert into public.assistant_calls (company_id, user_id, tool, ok) values (:'co', 'd1070000-0000-0000-0000-000000000001', 'list_jobs', true);
insert into public.assistant_connections (user_id, client_id, level) values ('d1070000-0000-0000-0000-000000000001', 't1070-client', 'read');
insert into public.calendar_sources (company_id, kind, app, name) values (:'co', 'file', 'ics_calendar', 'Holidays') returning id as cal_source \gset
insert into public.calendar_events (company_id, source_id, key, title, starts_on, ends_on, all_day) values (:'co', :'cal_source', 'k1', 'Closed', current_date, current_date, true);
insert into public.calendar_feeds (company_id, user_id, token_hash, token_sealed) values (:'co', 'd1070000-0000-0000-0000-000000000002', repeat('a', 64), 'sealed');
insert into public.campaigns (company_id, name) values (:'co', 'Spring tune-up') returning id as campaign \gset
insert into public.campaign_recipients (company_id, campaign_id, email) values (:'co', :'campaign', 'ann@client.test');
insert into public.chat_reads (company_id, channel_id, user_id) values (:'co', :'general', 'd1070000-0000-0000-0000-000000000001');
insert into public.chat_reactions (company_id, channel_id, message_id, user_id, kind) values (:'co', :'general', :'first_chat', 'd1070000-0000-0000-0000-000000000002', 'seen');
insert into public.document_templates (company_id, name) values (:'co', 'Plain');
insert into public.equipment_financials (company_id, equipment_id, purchase_price) values (:'co', :'e1', 4200);
insert into public.intake_forms (company_id, slug, name) values (:'co', 'roof-quote', 'Roof quote');
insert into public.integrations (company_id, provider) values (:'co', 'quickbooks');
insert into public.integration_secrets (company_id, provider, ciphertext) values (:'co', 'quickbooks', 'sealed');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price) values (:'co', :'roof_invoice', 'Architectural shingles', 24, 450);
insert into public.outbox (company_id, topic) values (:'co', 't1070');
insert into public.pay_periods (company_id, starts_on, ends_on) values (:'co', current_date - 6, current_date) returning id as period \gset
insert into public.pay_period_lines (company_id, period_id, user_id, hours, amount) values (:'co', :'period', 'd1070000-0000-0000-0000-000000000004', 1, 20);
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'c1', :'roof_invoice', 100, 'check');
insert into public.payouts (company_id, processor_ref, amount, status, arrival_on) values (:'co', 'po_t1070', 100, 'paid', current_date);
insert into public.recurrence_skips (company_id, job_id, recurrence_key) values (:'co', :'j1', 'k1');
insert into public.referrals (company_id, referrer_client_id, referred_name) values (:'co', :'c1', 'Neighbor Ned');
-- A referral credit Ann earned, which goes on her new invoice as its line goes in, one taken off
-- another invoice, and an ask for referrals.
insert into public.referrals (company_id, referrer_client_id, referred_name, reward_value, reward_amount, reward_status, earned_at)
values (:'co', :'c1', 'Neighbor Nia', 50, 50, 'earned', now()) returning id as earned_ref \gset
insert into public.invoices (company_id, client_id) values (:'co', :'c1') returning id as credit_invoice \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price) values (:'co', :'credit_invoice', 'Gutter cleaning', 1, 200);
insert into public.referral_credit_skips (company_id, referral_id, invoice_id) values (:'co', :'earned_ref', :'roof_invoice');
insert into public.referral_asks (company_id, client_id) values (:'co', :'c1');
insert into public.review_requests (company_id, client_id) values (:'co', :'c1');
-- A Google review of Ann's, and the company's review sync.
insert into public.review_syncs (company_id, account, location_id) values (:'co', 'accounts/1070', 'locations/1070');
insert into public.reviews (company_id, location_id, review_id, external_name, reviewer_name, rating, posted_at, google_updated_at, client_id, match)
values (:'co', 'locations/1070', 'r1070', 'accounts/1070/locations/1070/reviews/r1070', 'Ann C.', 5, now(), now(), :'c1', 'hand');
insert into public.review_match_choices (company_id, location_id, review_id, client_id) values (:'co', 'locations/1070', 'r1070', :'c1');
-- A photo of Ann's marked OK to share, and a social post of it, how it went on Facebook and its picture's link.
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, shareable, shareable_at)
values (:'co', 'client', :'c1', :'co' || '/client/' || :'c1' || '/porch.jpg', 'porch.jpg', 'image/jpeg', true, now()) returning id as porch \gset
insert into public.social_posts (company_id, source, attachment_ids, caption, networks, status) values (:'co', 'photos', array[:'porch']::uuid[], 'New porch steps', '{facebook}', 'posting') returning id as social_post \gset
insert into public.social_post_networks (post_id, company_id, network, status) values (:'social_post', :'co', 'facebook', 'posted');
insert into public.social_post_images (company_id, post_id, n, variant, attachment_id, path, token, width, height, bytes, expires_at)
values (:'co', :'social_post', 0, 'feed', :'porch', :'co' || '/social/' || :'social_post' || '/0-feed.jpg', repeat('b', 32), 10, 10, 100, now() + interval '7 days');
insert into public.roof_packages (company_id, name) values (:'co', 'Good') returning id as roof_package \gset
insert into public.roof_package_items (company_id, package_id, service_id, kind) values (:'co', :'roof_package', :'shingles_service', 'included');
insert into public.service_materials (company_id, service_id, item_number, name, uom, per_unit) values (:'co', :'shingles_service', 'ABC-1', 'Shingle bundle', 'BD', 3);
insert into public.sop_acknowledgements (company_id, page_id, revision, user_id) values (:'co', :'ladder_page', 1, 'd1070000-0000-0000-0000-000000000004');
insert into public.stripe_invoices (company_id, origin) values (:'co', 'crewtavo');
insert into public.sync_links (company_id, provider, entity, local_id, external_id) values (:'co', 'quickbooks', 'client', :'c1', 'qb-1');
insert into public.terms_acceptances (company_id, user_id, role, version) values (:'co', 'd1070000-0000-0000-0000-000000000001', 'owner', 't1070');
insert into public.web_address (company_id, domain) values (:'co', 'oscar.example');
insert into public.web_daily (company_id, day, kind, key) values (:'co', current_date, 'total', '');
insert into public.web_hits (company_id, day, visitor, path, entry, device) values (:'co', current_date, 'v1', '/', true, 'phone');
insert into public.drive_folders (company_id, name) values (:'co', 'Company files');
insert into public.trashed_files (company_id, path, source, label) values (:'co', :'co' || '/receipts/d1070000-0000-0000-0000-0000000000d8.jpg', 'receipt', 'Receipt');
insert into public.storage_allowances (company_id, role_key, limit_bytes) values (:'co', 'field_crew', 1000000000);
-- Cy's clocked time on the roof visit, with where he clocked in: what time_entry_places gives the
-- people who check time, and never a sub (below).
insert into public.time_entries (company_id, user_id, visit_id, job_id, category, started_at, ended_at, in_place) values
  (:'co', 'd1070000-0000-0000-0000-000000000004', :'v1', :'j1', 'visit', now() - interval '2 hours', now() - interval '1 hour', '{"lat": 37.27, "lng": -79.94}')
  returning id as cy_entry \gset

\o
\echo 'Subcontractors shut out by default'
\o /dev/null

-- ===== The sweep: everything Al can read, signed in as a sub ==================================
-- Every table with row-level security, and every view, in public, as pg_class lists them now.
create table t1070.seen (tbl text primary key, visible bigint);
grant all on t1070.seen to authenticated;
create table t1070.allowed (tbl text primary key, visible bigint not null);
insert into t1070.allowed values
  ('visits', 2), ('visit_assignees', 2), ('jobs', 1), ('properties', 1), ('requests', 1), ('property_access', 1),
  ('checklist_templates', 2), ('checklist_responses', 1), ('attachments', 1), ('visit_equipment', 1), ('equipment', 1),
  ('plan_files', 1), ('notifications', 2), ('notification_prefs', 1), ('memberships', 1), ('profiles', 1),
  ('sub_documents', 2), ('sub_paperwork', 3), ('push_subscriptions', 1), ('storage.objects', 6),
  ('job_pay', 1), ('job_pay_lines', 1), ('job_pay_visits', 1);
create function t1070.sweep() returns void language plpgsql as $$
declare t record; n bigint;
begin
  delete from t1070.seen;
  for t in
    select c.oid::regclass::text as tbl from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and ((c.relkind in ('r', 'p') and c.relrowsecurity) or c.relkind = 'v')
  loop
    begin
      execute format('select count(*) from %s', t.tbl) into n;
    exception when insufficient_privilege then
      n := null; -- not even granted: nobody signed in reads it
    end;
    insert into t1070.seen values (t.tbl, n);
  end loop;
  -- And the stored files, whose rules are in the storage schema.
  insert into t1070.seen select 'storage.objects', count(*) from storage.objects;
end $$;
grant execute on function t1070.sweep() to authenticated;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.sweep();
commit;
select t1070.check((select count(*) from t1070.seen) >= 85, 'every table and view in public was read: ' || (select count(*) from t1070.seen));
select t1070.check(not exists (
  select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relkind in ('m', 'f') and has_table_privilege('authenticated', c.oid, 'select')),
  'no materialized view or foreign table in public is readable (row-level security doesn''t cover them, so the sweep can''t)');
select t1070.check(not exists (
  select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  'and every table in public has row-level security, so the sweep reaches it');
select t1070.check(not exists (select 1 from t1070.allowed a where not exists (select 1 from t1070.seen s where s.tbl = a.tbl)),
  'the allow-list names tables that exist');
select t1070.check(not exists (select 1 from t1070.seen s left join t1070.allowed a on a.tbl = s.tbl where coalesce(s.visible, 0) <> coalesce(a.visible, 0)),
  'a sub sees exactly the allow-list, and nothing in any other table'
  || coalesce(': ' || (select string_agg(format('%s %s (expected %s)', s.tbl, coalesce(s.visible, 0), coalesce(a.visible, 0)), ', ' order by s.tbl)
       from t1070.seen s left join t1070.allowed a on a.tbl = s.tbl where coalesce(s.visible, 0) <> coalesce(a.visible, 0)), ''));

-- A table that's empty here can't show a leak, whatever its rules: what each holds in the fixture,
-- read past row-level security. Each one outside the allow-list has a row to be kept from Al, or is
-- on t1070.unseeded with why it can't have one here. A table added later is empty here too, so it
-- fails until someone seeds it (or says why not), and the sweep then covers it.
create table t1070.total (tbl text primary key, n bigint not null);
do $$
declare t record; n bigint;
begin
  for t in select tbl from t1070.seen where tbl <> 'storage.objects' loop
    execute format('select count(*) from %s', t.tbl) into n;
    insert into t1070.total values (t.tbl, n);
  end loop;
end $$;
-- Tables that can't hold a row in this fixture, with why: none so far (add one only with a reason).
create table t1070.unseeded (tbl text primary key, reason text not null);
select t1070.check(not exists (
    select 1 from t1070.total t
    where t.n = 0 and not exists (select 1 from t1070.allowed a where a.tbl = t.tbl) and not exists (select 1 from t1070.unseeded u where u.tbl = t.tbl)),
  'every table and view the sweep reads holds a row in the fixture, so a leak in it would show'
  || coalesce(': empty here: ' || (select string_agg(t.tbl, ', ' order by t.tbl) from t1070.total t
       where t.n = 0 and not exists (select 1 from t1070.allowed a where a.tbl = t.tbl) and not exists (select 1 from t1070.unseeded u where u.tbl = t.tbl)), ''));
select t1070.check(not exists (select 1 from t1070.unseeded u join t1070.total t on t.tbl = u.tbl where t.n > 0),
  'and a table said to be empty here is (take it off the list once it has a row)'
  || coalesce(': ' || (select string_agg(u.tbl, ', ') from t1070.unseeded u join t1070.total t on t.tbl = u.tbl where t.n > 0), ''));

-- Whatever the data, the rules that let a sub back in are only on these tables (a new table whose
-- rules copy one of these lists' patterns fails here until it's decided what a sub sees in it), and
-- every view runs as the person reading it, under their row-level security (one that ran as its
-- owner would show everything, which an empty table here wouldn't reveal).
select t1070.check(t1070.sorted(array(
    select distinct p.schemaname || '.' || p.tablename from pg_policies p
    where p.schemaname in ('public', 'storage')
      and concat(p.qual, ' ', p.with_check) ~ 'private\.(worker_companies|sub_companies|sub_clock_companies|my_subs|my_sub_ids|my_sub_visits)\(')) = t1070.sorted(array[
    'public.attachments', 'public.checklist_responses', 'public.checklist_templates', 'public.equipment', 'public.job_pay', 'public.jobs', 'public.memberships',
    'public.notification_prefs', 'public.notifications', 'public.plan_files', 'public.properties', 'public.requests', 'public.sub_documents', 'public.time_entries',
    'public.visit_assignees', 'public.visit_equipment', 'public.visits', 'storage.objects']),
  'the rules that let a sub in are on the tables decided for them, and no others');
select t1070.check(not exists (
    select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'v' and not coalesce(c.reloptions @> array['security_invoker=true'], false)),
  'every view in public runs as the person reading it (security_invoker)'
  || coalesce(': ' || (select string_agg(c.relname, ', ') from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relkind = 'v' and not coalesce(c.reloptions @> array['security_invoker=true'], false)), ''));

-- And the right rows.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.check((select array_agg(title order by title) from public.visits) = '{"Look at the leak","Tear off and shingle"}', 'their visits, in their company only');
select t1070.check((select array_agg(user_id) from public.visit_assignees) = '{d1070000-0000-0000-0000-000000000005,d1070000-0000-0000-0000-000000000005}', 'and only themselves on them');
select t1070.check((select array_agg(title) from public.jobs) = '{"New roof"}' and (select array_agg(title) from public.requests) = '{"Roof leak"}'
  and (select array_agg(line1) from public.properties) = '{"1 Oak St"}', 'the job, request and property behind them');
select t1070.check((select gate_code = '1234' and lockbox_code = '77' from public.property_access), 'the gate and lockbox codes for today''s visit there');
select t1070.check((select array_agg(name order by name) from public.checklist_templates) = '{"Old roof check","Roof check"}', 'the checklists to fill in, and the one already used on their visit');
select t1070.check((select array_agg(file_name) from public.attachments) = '{before.jpg}' and (select array_agg(name) from public.equipment) = '{"Dump trailer"}'
  and (select array_agg(title) from public.plan_files) = '{"Roof plan"}', 'their visit''s photo, what to bring, and the job''s plan marked for the crew');
select t1070.check((select count(*) from public.notifications where company_id <> :'co') = 0 and (select role = 'subcontractor' and active from public.memberships),
  'their own notifications here (not another company''s) and their own sign-in');
select t1070.check((select array_agg(full_name) from public.profiles) = '{"Al Apex"}', 'their own profile, no one else''s');
select t1070.check((select array_agg(kind order by kind) from public.sub_documents) = '{liability,w9}'
  and (select array_agg(requirement || '=' || state order by requirement) from public.sub_paperwork) = '{liability=expiring,w9=ok,workers_comp=missing}',
  'their own paperwork and its status');
select t1070.check(not exists (select 1 from public.subcontractors), 'not the subs table, which has the office''s notes about them');
select t1070.check((select count(*) from public.time_entries) = 0, 'no time while the company hasn''t put them on the clock');
select t1070.check((select row(status, total)::text from public.job_pay) = '(accepted,1800.00)'
  and (select row(description, amount)::text from public.job_pay_lines) = '("Tear off and shingle",1800.00)'
  and (select array_agg(visit_id) from public.job_pay_visits) = array[:'v1']::uuid[],
  'their own agreed pay: the price, its line and the visit it covers (not the office''s draft, Birch''s pay or the crew''s)');
select t1070.check(not exists (select 1 from public.pay_rates), 'not their rate card');
select t1070.check(t1070.sorted(array(select name from storage.objects)) = t1070.sorted(array[
    :'co' || '/avatars/d1070000-0000-0000-0000-000000000005/d1070000-0000-0000-0000-0000000000d1.jpg',
    :'co' || '/plans/d1070000-0000-0000-0000-0000000000b1.pdf',
    :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/gl.pdf',
    :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9.pdf',
    :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000a1.jpg',
    :'co' || '/visit/' || :'va' || '/d1070000-0000-0000-0000-0000000000a4.jpg']),
  'files: their visits'' photos, their job''s plan for the crew, their own paperwork and photo; nothing else, and nothing filed under another company');
commit;

-- Their notifications: marking them read, and choosing how they hear.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.check(t1070.changed('update public.notifications set read_at = now() where read_at is null') = 2, 'a sub marks their notifications here read');
select t1070.check(t1070.changed(format('update public.notification_prefs set sms = %L where user_id = %L', '{schedule}', 'd1070000-0000-0000-0000-000000000005')) = 1
  and t1070.changed(format('update public.notification_prefs set sms = %L where user_id = %L', '{schedule}', 'd1070000-0000-0000-0000-000000000002')) = 0,
  'and sets how they hear, not how anyone else does');
select t1070.expect_error(format('insert into public.notification_prefs (company_id, user_id) values (%L, %L)', :'other', 'd1070000-0000-0000-0000-000000000005'),
  'not at a company they don''t sign in to');
select t1070.expect_error(format('insert into public.notification_prefs (company_id, user_id) values (%L, %L)', :'co', 'd1070000-0000-0000-0000-000000000004'),
  'or for someone else');
rollback;

-- Writing to the rest is refused.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.expect_error(format('insert into public.clients (company_id, display_name) values (%L, %L)', :'co', 'Mine'), 'a sub can''t add a client');
select t1070.expect_error(format('insert into public.jobs (company_id, client_id, title) values (%L, %L, %L)', :'co', :'c1', 'Mine'), 'or a job');
select t1070.expect_error(format('insert into public.visits (company_id, title, scheduled_on) values (%L, %L, current_date)', :'co', 'Mine'), 'or a visit');
select t1070.expect_error(format('insert into public.visit_assignees (company_id, visit_id, user_id) values (%L, %L, %L)', :'co', :'v2', 'd1070000-0000-0000-0000-000000000005'), 'or put themselves on another visit');
select t1070.expect_error(format('insert into public.invoices (company_id, client_id) values (%L, %L)', :'co', :'c1'), 'or an invoice');
select t1070.expect_error(format('insert into public.messages (company_id, client_id, channel, direction, body) values (%L, %L, %L, %L, %L)', :'co', :'c1', 'note', 'internal', 'Hi'), 'or a note on a client');
select t1070.expect_error(format('insert into public.expenses (company_id, amount, user_id, job_id) values (%L, 10, %L, %L)', :'co', 'd1070000-0000-0000-0000-000000000005', :'j1'), 'or a receipt');
select t1070.expect_error(format('insert into public.job_materials (company_id, job_id, name, quantity, unit, logged_by) values (%L, %L, %L, 1, %L, %L)', :'co', :'j1', 'Nails', 'box', 'd1070000-0000-0000-0000-000000000005'), 'or materials');
select t1070.expect_error(format('insert into public.chat_messages (company_id, channel_id, author_id, body) values (%L, %L, %L, %L)', :'co', :'general', 'd1070000-0000-0000-0000-000000000005', 'Hi'), 'or post in team chat');
select t1070.expect_error(format('insert into public.time_entries (company_id, user_id, category, started_at) values (%L, %L, %L, now())', :'co', 'd1070000-0000-0000-0000-000000000005', 'visit'), 'or clock in');
select t1070.expect_error(format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', :'co', 'd1070000-0000-0000-0000-000000000005', 'field_crew'), 'or join the team');
select t1070.expect_error(format('insert into public.subcontractors (company_id, name) values (%L, %L)', :'co', 'Me too'), 'or add a sub');
select t1070.expect_error(format('insert into public.crew_members (company_id, crew_id, user_id) values (%L, %L, %L)', :'co', :'crew', 'd1070000-0000-0000-0000-000000000005'), 'or join a crew');
select t1070.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/notes/mine.txt', 'd1070000-0000-0000-0000-000000000005'), 'or store a file outside their folders');
select t1070.expect_error(format('insert into public.job_pay (company_id, job_id, subcontractor_id) values (%L, %L, %L)', :'co', :'j1', 'd1070000-0000-0000-0000-0000000000c1'), 'or start pay');
select t1070.expect_error(format('insert into public.job_pay_lines (company_id, job_pay_id, description, quantity, rate) values (%L, %L, %L, 1, 500)', :'co', :'al_pay', 'Bonus'), 'or add to their own price');
select t1070.expect_error(format('insert into public.job_pay_visits (company_id, job_pay_id, visit_id) values (%L, %L, %L)', :'co', :'al_pay', :'v2'), 'or put it on another visit');
select t1070.expect_error(format('insert into public.pay_rates (company_id, subcontractor_id, basis, rate) values (%L, %L, %L, 999)', :'co', 'd1070000-0000-0000-0000-0000000000c1', 'per_job'), 'or set their own rate');
select t1070.check(t1070.changed(format('update public.jobs set title = %L where id = %L', 'Mine', :'j1')) = 0
  and t1070.changed(format('update public.properties set line1 = %L where id = %L', 'Mine', :'p1')) = 0
  and t1070.changed(format('update public.property_access set gate_code = %L where property_id = %L', '0000', :'p1')) = 0
  and t1070.changed(format('update public.requests set title = %L where id = %L', 'Mine', :'r1')) = 0
  and t1070.changed(format('update public.memberships set active = false where user_id = %L', 'd1070000-0000-0000-0000-000000000005')) = 0
  and t1070.changed(format('update public.profiles set full_name = %L where user_id = %L', 'Mine', 'd1070000-0000-0000-0000-000000000002')) = 0
  and t1070.changed(format('update public.companies set name = %L where id = %L', 'Mine', :'co')) = 0
  and t1070.changed(format('update public.visits set notes = %L where id = %L', 'Mine', :'v2')) = 0
  and t1070.changed(format('update public.equipment set name = %L where id = %L', 'Mine', :'e1')) = 0
  and t1070.changed(format('update public.checklist_templates set name = %L where id = %L', 'Mine', :'tmpl_a')) = 0
  and t1070.changed(format('delete from public.checklist_responses where visit_id = %L', :'v1')) = 0
  and t1070.changed(format('delete from public.visits where id = %L', :'v1')) = 0
  and t1070.changed(format('delete from public.sub_documents where subcontractor_id = %L', 'd1070000-0000-0000-0000-0000000000c1')) = 0
  and t1070.changed(format('update public.job_pay set notes = %L where id = %L', 'Pay me more', :'al_pay')) = 0
  and t1070.changed(format('update public.job_pay_lines set rate = 9999 where job_pay_id = %L', :'al_pay')) = 0
  and t1070.changed(format('delete from public.job_pay_visits where job_pay_id = %L', :'al_pay')) = 0
  and t1070.changed(format('delete from public.job_pay where id = %L', :'al_pay')) = 0,
  'and what they can read, they can''t change beyond their visit''s status and notes (or delete)');
select t1070.check((select gate_code from public.property_access where property_id = :'p1') = '1234', 'the codes are as they were');
rollback;

-- ===== Functions =================================================================================
-- Every function a signed-in person can call. A new one fails this list until someone decides
-- what a sub gets from it, and adds it below.
select t1070.check(array(
  select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute') order by 1) = array[
  'accept_terms(uuid, text)', 'answer_sub_offer(uuid, boolean, text, integer, uuid)', 'apply_promo_code(text, uuid, text, uuid, uuid[])',
  'apply_quote_options(uuid, jsonb, text, uuid[], jsonb)', 'apply_referral_credit(uuid, uuid)', 'automated_campaign_states(uuid)', 'campaign_audience(uuid, jsonb)', 'campaign_audience_choices(uuid)',
  'campaign_recipient_results(uuid, integer, integer, text)', 'campaign_results(uuid, uuid)', 'careers_set_enabled(uuid, boolean)',
  'change_sub_offer(uuid, jsonb, timestamp with time zone)', 'chat_create_channel(uuid, text, text, text, text, uuid)', 'chat_mark_read(uuid)', 'chat_members(uuid)', 'chat_overview(uuid)',
  'chat_save_roles(uuid, jsonb, jsonb)', 'chat_set_enabled(uuid, boolean)', 'company_basics(uuid)', 'convert_quote_to_job(uuid)',
  'create_company(text, text, text)', 'create_invoice_for_job(uuid, text, numeric)', 'dashboard(uuid)',
  'drive_clients(uuid, text, integer)', 'drive_list(uuid, text, uuid, text, integer)', 'drive_restore(text, uuid)', 'drive_root(uuid)',
  'drive_set_enabled(uuid, boolean)', 'drive_trash(uuid)', 'drive_trash_file(uuid)', 'drive_trash_folder(uuid)', 'drive_trash_version(uuid)',
  'drive_versions(uuid)', 'duplicate_quote(uuid)',
  'equipment_conflicts(uuid, uuid[], date, timestamp with time zone, timestamp with time zone, uuid)', 'global_search(uuid, text, integer)', 'inactive_client_count(uuid, integer)',
  'job_material_costs(uuid)', 'job_pay_accept(uuid, uuid[])', 'job_pay_cancel(uuid)', 'job_pay_costs(uuid[])', 'job_pay_covers(uuid, uuid, uuid)', 'job_pay_mark_done(uuid, date)',
  'job_pay_mark_paid(uuid[], text, date, text, numeric)', 'job_pay_start(uuid, uuid, uuid, uuid[])', 'job_pay_suggest(uuid, uuid, uuid, uuid[])',
  'job_pay_unmark_paid(uuid[])', 'job_scope(uuid)', 'last_referral_ask(uuid, uuid)', 'last_review_ask(uuid, uuid)', 'marketing_set_enabled(uuid, boolean)', 'marketing_summary(uuid)', 'material_choices(uuid)', 'my_crew_ids(uuid)', 'my_sub_offers(boolean, uuid)', 'my_sub_pay_totals(uuid)',
  'promo_code_usage(uuid)', 'put_quote_package(uuid, uuid, jsonb, boolean)', 'record_photos(uuid, uuid, uuid)',
  'referral_auto_apply(uuid, boolean)', 'referral_credits_for(uuid, uuid)', 'referral_give_credit(uuid)', 'referral_no_reward(uuid)', 'referral_set_given(uuid)',
  'referral_stats(uuid, timestamp with time zone, timestamp with time zone)',
  'remove_promo_code(text, uuid)', 'remove_quote_option(uuid, uuid)', 'remove_referral_credit(uuid)', 'review_stats(uuid)',
  'search_sops(uuid, text, integer, boolean)', 'send_sub_offer(uuid, timestamp with time zone)', 'set_photo_shareable(uuid, boolean)', 'set_sub_reminders(uuid, boolean)',
  'set_sub_sign_in_countries(uuid, text[])', 'sign_quote(uuid, jsonb, uuid, numeric)', 'social_photos(uuid, timestamp with time zone, uuid, integer, uuid)',
  'storage_overview(uuid)', 'storage_set_allowance(uuid, uuid, text, bigint)', 'storage_set_limit(uuid, text, bigint)', 'sub_1099_totals(uuid, integer)', 'sub_wc_audit(uuid, date, date)', 'time_entry_places(uuid, uuid[])',
  'trash_delete_forever(uuid, jsonb)', 'visit_contact(uuid)', 'web_analytics_save(uuid, jsonb)', 'web_stats(uuid, date, date)',
  'website_forms_set_enabled(uuid, boolean)', 'withdraw_sub_offer(uuid)']::text[],
  'the functions a signed-in person can call are the known list (a new one needs a decision about subs, here)');
-- Signing in with a code, by text or by email (20261025005001_sign_in_codes.sql,
-- 20261025006001_email_sign_in_codes.sql), is the server's alone, which is why none of it is on the
-- list: nobody signed in or out finds whose number or address it is, or makes or tries a code.
select t1070.check(not exists (select 1 from unnest(array['public.sign_in_code_save(text, text, text, uuid, text)', 'public.sign_in_code_check(text, text, text, uuid, text)',
    'public.sign_in_codes_save(text, text, uuid[], text[], text)', 'public.sign_in_codes_check(text, text, uuid[], text[], text)',
    'public.sub_sign_ins_for_phone(text)', 'public.sub_sign_ins_for_email(text)', 'public.tidy_sign_in_codes()', 'public.sub_notice_contacts(uuid[])']) as f
  where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  'signing in with a code, by text or by email, and where a sub''s notices go, are the server''s alone');
-- So are the storage gateway's check before an upload and the default limit (20261028000400_storage_limits.sql).
select t1070.check(not exists (select 1 from unnest(array['public.storage_snapshot(uuid, uuid)', 'public.storage_set_default(uuid, bigint, text)']) as f
  where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  'the storage check before an upload, and the default limit, are the server''s alone');
-- And so are the referral page's lead and recording a referral ask (20261031000100_referral_credits.sql,
-- 20261031000120_referral_asks.sql): the server checks the link, Turnstile and the 6 months first.
select t1070.check(not exists (select 1 from unnest(array['public.record_referral(uuid, uuid, text, text, text, jsonb, text)',
    'public.begin_referral_ask(uuid, uuid, boolean, integer, uuid)']) as f
  where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  'recording a referral and a referral ask are the server''s alone');

-- The owner sees where Cy clocked in, so the check on a sub below is about a real entry with a place.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t1070.check((select (in_place ->> 'lat')::numeric = 37.27 from public.time_entry_places(:'co', array[:'cy_entry']::uuid[])), 'time_entry_places gives the owner where Cy clocked in');
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
-- What a sub gets from each: their own visits' and jobs' (as the allow-list), or nothing.
select t1070.check((select array_agg(name order by sort) from public.job_scope(:'j1')) = '{"Architectural shingles"}' and (select quantity = 24 and unit = 'sq' from public.job_scope(:'j1')),
  'job_scope: what to do on their job, without the discount or any price');
select t1070.check(not exists (select 1 from public.job_scope(:'j2')), 'and nothing for a job they aren''t on');
select t1070.check((select row(name, phone, email)::text from public.visit_contact(:'v1')) = '("Ann Client",,)', 'visit_contact: the client''s name, without their phone or email');
select t1070.check(not exists (select 1 from public.visit_contact(:'v3')) and not exists (select 1 from public.visit_contact(:'pv')), 'and nothing about visits they aren''t on, here or elsewhere');
select t1070.check((select row(name, timezone, currency, phone, logo)::text = row('Oscar Roofing', :'tz'::text, 'USD'::text, '+15405550100'::text, :'co' || '/logo/d1070000-0000-0000-0000-0000000000f1.png')::text
    and array(select jsonb_object_keys(settings) order by 1) = '{branding,clock,working_hours}' from public.company_basics(:'co')),
  'company_basics: the name, time zone, currency, phone and logo, and only the clock, branding and working hours settings');
select t1070.check(not exists (select 1 from public.company_basics(:'other')), 'and nothing about another company');
select t1070.check(public.my_crew_ids(:'co') = '{}' and not exists (select 1 from public.material_choices(:'co')) and not exists (select 1 from public.job_material_costs(:'j1'))
  and not exists (select 1 from public.time_entry_places(:'co', array[:'cy_entry']::uuid[])) and not exists (select 1 from public.chat_overview(:'co'))
  and not exists (select 1 from public.chat_members(:'general')),
  'no crews, price list, material costs, clock places or chat');
select t1070.expect_error(format('select public.chat_mark_read(%L)', :'general'), 'chat_mark_read refuses');
select t1070.expect_error(format('select public.chat_set_enabled(%L, false)', :'co'), 'chat_set_enabled refuses');
select t1070.expect_error(format('select public.chat_create_channel(%L, %L, %L)', :'co', 'subs', 'everyone'), 'chat_create_channel refuses');
select t1070.expect_error(format('select public.chat_save_roles(%L, %L, %L)', :'co', '[]', '[]'), 'chat_save_roles refuses');
select t1070.expect_error(format('select public.web_stats(%L, current_date - 7, current_date)', :'co'), 'web_stats refuses');
select t1070.expect_error(format('select public.web_analytics_save(%L, %L)', :'co', '{"enabled": true}'), 'web_analytics_save refuses');
select t1070.expect_error(format('select public.set_sub_reminders(%L, false)', :'co'), 'set_sub_reminders refuses');
select t1070.expect_error(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{44}'), 'set_sub_sign_in_countries refuses');
select t1070.expect_error(format('select public.accept_terms(%L, %L)', :'co', '1'), 'accept_terms refuses');
select t1070.expect_error(format('select public.create_company(%L)', 'Al''s Roofing'), 'create_company refuses a sign-in the office made for a sub');
select t1070.expect_error(format('select public.create_invoice_for_job(%L)', :'j1'), 'create_invoice_for_job refuses, though they see the job');
select t1070.expect_error(format('select public.convert_quote_to_job(%L)', :'q1'), 'convert_quote_to_job finds no quote');
select t1070.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'quote', :'q1', 'SPRING'), 'apply_promo_code finds no quote');
-- The estimate's options, its package and signing it on the iPad (20261025000100_contracts_and_options.sql)
-- run as the caller, and a sub sees no quote.
select t1070.expect_error(format('select public.apply_quote_options(%L, %L, %L)', :'q1', '[]', 'add'), 'apply_quote_options finds no quote');
select t1070.expect_error(format('select public.remove_quote_option(%L, %L)', :'q1', gen_random_uuid()), 'remove_quote_option finds no quote');
select t1070.expect_error(format('select public.duplicate_quote(%L)', :'q1'), 'duplicate_quote finds no quote');
select t1070.expect_error(format('select public.put_quote_package(%L, %L, %L)', :'q1', gen_random_uuid(), '[]'), 'put_quote_package finds no quote');
select t1070.check(public.sign_quote(:'q1', '{"name": "Al"}') is null, 'sign_quote finds no quote to sign');
select public.remove_promo_code('quote', :'q1');
select t1070.check(not exists (select 1 from public.global_search(:'co', 'Ann')) and not exists (select 1 from public.global_search(:'co', 'roof'))
  and not exists (select 1 from public.search_sops(:'co', 'ladder')) and not exists (select 1 from public.campaign_audience(:'co', '{}'))
  and not exists (select 1 from public.promo_code_usage(:'co')),
  'search, guides, marketing audiences and promo codes find nothing');
-- Drive is the team's: its lists show a sub nothing (not even the plan they can open), and its
-- switch, Company files and the Trash refuse them.
select t1070.check(not exists (select 1 from public.drive_list(:'co', 'recent')) and not exists (select 1 from public.drive_list(:'co', 'search', null, 'roof'))
  and not exists (select 1 from public.drive_clients(:'co')) and not exists (select 1 from public.drive_trash(:'co'))
  and not exists (select 1 from public.drive_versions((select id from public.plan_files limit 1))),
  'drive_list, drive_clients, drive_versions and drive_trash find nothing');
select t1070.expect_error(format('select public.drive_set_enabled(%L, true)', :'co'), 'drive_set_enabled refuses');
select t1070.expect_error(format('select public.drive_root(%L)', :'co'), 'drive_root refuses');
select t1070.expect_error(format('select public.drive_trash_file(%L)', (select id from public.plan_files limit 1)), 'drive_trash_file refuses, though they see the plan');
select t1070.expect_error(format('select public.drive_trash_version(%L)', (select id from public.plan_files limit 1)), 'drive_trash_version refuses');
select t1070.expect_error(format('select public.drive_trash_folder(%L)', (select id from public.drive_folders limit 1)), 'drive_trash_folder finds no folder');
select t1070.expect_error(format('select public.drive_restore(%L, %L)', 'other', gen_random_uuid()), 'drive_restore finds nothing to restore');
select t1070.expect_error(format('select * from public.trash_delete_forever(%L, %L)', :'co', '[]'), 'trash_delete_forever refuses');
-- Storage is the team's: how much is used, and its limits.
select t1070.expect_error(format('select public.storage_overview(%L)', :'co'), 'storage_overview refuses');
select t1070.expect_error(format('select public.storage_set_limit(%L, %L)', :'co', 'none'), 'storage_set_limit refuses');
select t1070.expect_error(format('select public.storage_set_allowance(%L, %L, null, 1)', :'co', 'd1070000-0000-0000-0000-000000000005'), 'storage_set_allowance refuses');
-- Referral credits and their numbers are the office's.
select t1070.expect_error(format('select public.apply_referral_credit(%L, %L)', gen_random_uuid(), gen_random_uuid()), 'apply_referral_credit refuses');
select t1070.expect_error(format('select public.remove_referral_credit(%L)', gen_random_uuid()), 'remove_referral_credit refuses');
select t1070.expect_error(format('select public.referral_auto_apply(%L)', gen_random_uuid()), 'referral_auto_apply refuses');
select t1070.expect_error(format('select public.referral_set_given(%L)', gen_random_uuid()), 'referral_set_given refuses');
select t1070.expect_error(format('select public.referral_no_reward(%L)', gen_random_uuid()), 'referral_no_reward refuses');
select t1070.expect_error(format('select public.referral_give_credit(%L)', gen_random_uuid()), 'referral_give_credit refuses');
select t1070.expect_error(format('select public.referral_stats(%L)', :'co'), 'referral_stats refuses');
select t1070.check(not exists (select 1 from public.referral_credits_for(:'co', :'c1')), 'referral_credits_for finds nothing');
-- Campaigns' results, and who a campaign would reach, are the office's too.
select t1070.expect_error(format('select public.campaign_results(%L)', :'co'), 'campaign_results refuses');
select t1070.expect_error(format('select public.campaign_recipient_results(%L)', gen_random_uuid()), 'campaign_recipient_results refuses');
select t1070.expect_error(format('select public.inactive_client_count(%L, 365)', :'co'), 'inactive_client_count refuses');
select t1070.expect_error(format('select public.automated_campaign_states(%L)', :'co'), 'automated_campaign_states refuses');
select t1070.check(public.campaign_audience_choices(:'co') = '{"cities": [], "services": []}', 'campaign_audience_choices finds nothing');
select t1070.check((select (public.marketing_summary(:'co') ->> 'opted_out')::int = 0
  and public.last_referral_ask(:'co', :'c1') is null and public.marketing_summary(:'co') -> 'referral_revenue' = 'null'::jsonb
  and public.last_review_ask(:'co', :'c1') is null
  and (public.dashboard(:'co') -> 'receivables' ->> 'total')::numeric = 0
  and (public.dashboard(:'co') -> 'workflow' -> 'quotes' ->> 'draft')::int = 0
  and coalesce((public.dashboard(:'co') -> 'today' ->> 'total')::int, 0) = 0),
  'the dashboard, marketing summary and when a client was last asked count nothing (they run as the person, who can''t read the company)');
select t1070.check((select (s ->> 'count')::int = 0 and (s ->> 'asks_12m')::int = 0 and s -> 'average' = 'null'::jsonb from (select public.review_stats(:'co') as s) x),
  'Google reviews'' numbers count nothing either');
-- Social posts are the office's: a sub marks no photo OK to share and gets none to post.
select t1070.expect_error(format('select public.set_photo_shareable(%L, true)', :'porch'), 'set_photo_shareable refuses');
select t1070.expect_error(format('select * from public.social_photos(%L)', :'co'), 'social_photos refuses');
select t1070.check(not exists (select 1 from public.record_photos(:'co', null, :'c1')), 'record_photos finds none of the client''s photos');
select t1070.check((select array_agg(visit_id) from public.equipment_conflicts(:'co', array[:'e1', :'e2']::uuid[], private.company_today(:'co') + 1, null, null)) is null
  and (select array_agg(visit_id) from public.equipment_conflicts(:'co', array[:'e1']::uuid[], private.company_today(:'co'), null, null)) = array[:'v1']::uuid[],
  'equipment_conflicts only sees their own visits');
-- Their pay is the office's to set, agree, finish and mark paid; they read it, nothing more.
select t1070.expect_error(format('select * from public.job_pay_suggest(%L, %L)', :'j1', 'd1070000-0000-0000-0000-0000000000c1'), 'job_pay_suggest refuses, even for their own pay');
select t1070.expect_error(format('select public.job_pay_start(%L, %L)', :'j1', 'd1070000-0000-0000-0000-0000000000c1'), 'job_pay_start refuses');
select t1070.expect_error(format('select * from public.job_pay_covers(%L, %L)', :'j1', 'd1070000-0000-0000-0000-0000000000c1'), 'job_pay_covers refuses');
select t1070.expect_error(format('select public.job_pay_accept(%L)', :'al_draft'), 'job_pay_accept refuses');
select t1070.expect_error(format('select public.job_pay_mark_done(%L)', :'al_pay'), 'job_pay_mark_done refuses');
select t1070.expect_error(format('select public.job_pay_cancel(%L)', :'al_pay'), 'job_pay_cancel refuses');
select t1070.expect_error(format('select * from public.job_pay_mark_paid(array[%L]::uuid[], %L)', :'al_pay', 'check'), 'job_pay_mark_paid refuses');
select t1070.expect_error(format('select * from public.job_pay_unmark_paid(array[%L]::uuid[])', :'al_pay'), 'job_pay_unmark_paid refuses');
select t1070.expect_error(format('select * from public.sub_1099_totals(%L, 2026)', :'co'), 'sub_1099_totals refuses');
select t1070.expect_error(format('select * from public.sub_wc_audit(%L, current_date - 30, current_date)', :'co'), 'sub_wc_audit refuses');
select t1070.check(not exists (select 1 from public.job_pay_costs(array[:'j1', :'j2']::uuid[])), 'job_pay_costs gives nothing');
-- Their offers are theirs to read and answer; sending, changing and taking one back is the office's.
select t1070.check(not exists (select 1 from public.my_sub_offers()) and (select array_agg(id) from public.my_sub_offers(true)) = array[:'al_pay']::uuid[],
  'my_sub_offers: none waiting, and with everything, only their own agreed pay (not the office''s draft, or Birch''s)');
select t1070.check(not public.answer_sub_offer(:'al_pay', true) and not public.answer_sub_offer(:'al_draft', true) and not public.answer_sub_offer(:'bo_pay', false),
  'answer_sub_offer: nothing to answer, theirs or Birch''s');
select t1070.check((select row(paid, payments, owed, owed_jobs)::text from public.my_sub_pay_totals(:'co')) = row(0, 0, 0, 0)::text
  and not exists (select 1 from public.my_sub_pay_totals(:'other')), 'my_sub_pay_totals: their own (nothing paid or owed yet), and nothing for another company');
select t1070.expect_error(format('select public.send_sub_offer(%L)', :'al_draft'), 'send_sub_offer refuses, even for their own pay');
select t1070.expect_error(format('select public.change_sub_offer(%L, %L)', :'al_pay', '[{"description": "Pay me more", "rate": 9999}]'), 'change_sub_offer refuses');
select t1070.expect_error(format('select public.withdraw_sub_offer(%L)', :'al_pay'), 'withdraw_sub_offer refuses');
rollback;

-- An AI assistant connected to Al's account gets none of it.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated", "client_id": "claude"}', true);
select t1070.sweep();
commit;
select t1070.check(not exists (select 1 from t1070.seen where visible > 0 and tbl not in ('profiles', 'push_subscriptions')),
  'an AI assistant on a sub''s account reads nothing of the company, stored files included'
  || coalesce(': ' || (select string_agg(tbl || ' ' || visible, ', ') from t1070.seen where visible > 0 and tbl not in ('profiles', 'push_subscriptions')), ''));
-- What the functions give a sub, for each sign-in that shouldn't reach anything (here and below).
create function t1070.sub_functions_empty() returns boolean language sql as $$
  select not exists (select 1 from public.job_scope(current_setting('t1070.j1')::uuid))
    and not exists (select 1 from public.visit_contact(current_setting('t1070.v1')::uuid))
    and not exists (select 1 from public.company_basics(current_setting('t1070.co')::uuid))
    and not exists (select 1 from public.my_sub_offers(true))
    and not exists (select 1 from public.my_sub_pay_totals(current_setting('t1070.co')::uuid))
$$;
grant execute on function t1070.sub_functions_empty() to authenticated;
select set_config('t1070.j1', :'j1', false), set_config('t1070.v1', :'v1', false), set_config('t1070.co', :'co', false);
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated", "client_id": "claude"}', true);
select t1070.check(t1070.sub_functions_empty(), 'and job_scope, visit_contact, company_basics and my_sub_offers give it nothing');
rollback;

\o
\echo 'Letting a sub back in'
\o /dev/null

-- ===== Their visit: status and notes =============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
update public.visits set status = 'en_route' where id = :'v1';
update public.visits set status = 'in_progress', notes = 'Found soft decking by the chimney' where id = :'v1';
select t1070.check((select status = 'in_progress' and notes like 'Found soft%' from public.visits where id = :'v1'), 'a sub moves their visit along and leaves notes for the office');
select t1070.expect_error(format('update public.visits set title = %L where id = %L', 'Easy job', :'v1'), 'but doesn''t rename it');
select t1070.expect_error(format('update public.visits set scheduled_on = scheduled_on + 1 where id = %L', :'v1'), 'or move it');
select t1070.expect_error(format('update public.visits set crew_id = %L where id = %L', :'crew', :'v1'), 'or give it to a crew');
select t1070.expect_error(format('update public.visits set hold_reason = %L where id = %L', 'Rain', :'v1'), 'or put it on hold');
select t1070.expect_error(format('update public.visits set status = %L where id = %L', 'cancelled', :'v1'), 'or cancel it');
select t1070.expect_error(format('update public.visits set status = %L where id = %L', 'unscheduled', :'v1'), 'or take it off the schedule');
update public.visits set completed_at = now() - interval '3 days' where id = :'v1';
select t1070.check((select completed_at is null from public.visits where id = :'v1'), 'or say when it was done');
update public.visits set status = 'completed', completed_by = 'd1070000-0000-0000-0000-000000000002' where id = :'v1';
select t1070.check((select status = 'completed' and completed_at > now() - interval '1 minute' and completed_by = 'd1070000-0000-0000-0000-000000000005' from public.visits where id = :'v1'),
  'completing it records when, and that it was them, whatever they sent');
select t1070.check((select status = 'done' and earned_on = private.company_today(:'co') from public.job_pay), 'and their pay for it is done, owed to them from today');
select t1070.expect_error(format('update public.visits set status = %L where id = %L', 'in_progress', :'v1'), 'once it''s done, the office reopens it');
update public.visits set notes = 'All done, nails swept' where id = :'v1';
select t1070.check((select notes from public.visits where id = :'v1') = 'All done, nails swept', 'they can still add to the notes');
rollback;

-- The crew keeps what they had on a visit a sub is on too.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
update public.visits set title = 'Tear off, shingle and flash' where id = :'v1';
update public.visits set status = 'cancelled' where id = :'v1';
select t1070.check((select status = 'cancelled' and title like '%flash' from public.visits where id = :'v1'), 'the crew can still rename and cancel their own visit, as before');
rollback;

-- ===== Checklists, photos and files on their visits ============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
update public.checklist_responses set answers = '{"deck": true, "flashing": true}', completed_at = now() where visit_id = :'v1';
insert into public.checklist_responses (company_id, visit_id, template_id, answers) values (:'co', :'va', :'tmpl_a', '{}');
select t1070.check((select count(*) from public.checklist_responses) = 2, 'a sub fills in the checklists on their visits');
select t1070.expect_error(format('insert into public.checklist_responses (company_id, visit_id, answers) values (%L, %L, %L)', :'co', :'v2', '{}'), 'not on someone else''s');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values
  (:'co', 'visit', :'v1', :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000e1.jpg', 'chimney.jpg');
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000e1.jpg', 'd1070000-0000-0000-0000-000000000005');
select t1070.check((select count(*) from public.attachments) = 2, 'and adds photos to them');
select t1070.expect_error(format('insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (%L, %L, %L, %L, %L)',
  :'co', 'visit', :'v2', :'co' || '/visit/' || :'v2' || '/x.jpg', 'x.jpg'), 'not to a visit they aren''t on');
select t1070.expect_error(format('insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (%L, %L, %L, %L, %L)',
  :'co', 'visit', :'v1', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c2/w9.pdf', 'w9.pdf'), 'and a photo on their visit is a file in its folder, not someone''s paperwork');
select t1070.expect_error(format('insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (%L, %L, %L, %L, %L)',
  :'co', 'job', :'j1', :'co' || '/job/' || :'j1' || '/x.pdf', 'x.pdf'), 'or a file on the job itself');
select t1070.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/visit/' || :'v2' || '/x.jpg', 'd1070000-0000-0000-0000-000000000005'),
  'files go only in their own visits'' folders');
select t1070.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'other' || '/visit/' || :'pv' || '/x.jpg', 'd1070000-0000-0000-0000-000000000005'),
  'not another company''s, though someone there put them on a visit');
select t1070.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/plans/d1070000-0000-0000-0000-0000000000e2.pdf', 'd1070000-0000-0000-0000-000000000005'),
  'or with the plans');
select t1070.check(t1070.changed(format('delete from storage.objects where name = %L', :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000a1.jpg')) = 0,
  'they can''t delete a photo someone else took');
select t1070.check(t1070.changed(format('delete from public.attachments where path = %L', :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000e1.jpg')) = 1,
  'they take back a photo they added');
select t1070.check(t1070.changed(format('delete from public.attachments where path = %L', :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000a1.jpg')) = 0,
  'not one someone else took');
select t1070.check(t1070.changed(format('delete from storage.objects where name = %L', :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000e1.jpg')) = 0,
  'nobody signed in deletes a stored file, their own photo included');
reset role;
select t1070.check((select source = 'visit_photo' and deleted_by = 'd1070000-0000-0000-0000-000000000005' from public.trashed_files
  where path = :'co' || '/visit/' || :'v1' || '/d1070000-0000-0000-0000-0000000000e1.jpg'), 'the photo they took back is in the Trash, for the server to delete');
rollback;

-- ===== Their paperwork ============================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
-- Their files, as Storage records them once stored (its type and size from what was sent).
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/new-gl.pdf', 'd1070000-0000-0000-0000-000000000005', '{"mimetype": "application/pdf", "size": 48213}'),
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/wc.pdf', 'd1070000-0000-0000-0000-000000000005', '{"mimetype": "application/pdf", "size": 1000}'),
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/license.jpg', 'd1070000-0000-0000-0000-000000000005', '{"mimetype": "image/jpeg", "size": 2000}'),
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9-signed.heic', 'd1070000-0000-0000-0000-000000000005', '{"mimetype": "image/heic", "size": 3000}'),
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/page.html', 'd1070000-0000-0000-0000-000000000005', '{"mimetype": "text/html", "size": 300}'),
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/logo.svg', 'd1070000-0000-0000-0000-000000000005', '{"mimetype": "image/svg+xml", "size": 300}');
insert into public.sub_documents (company_id, subcontractor_id, kind, path, file_name, content_type, size_bytes, carrier, expires_on) values
  (:'co', 'd1070000-0000-0000-0000-0000000000c1', 'liability', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/new-gl.pdf', 'new-gl.pdf', 'text/plain', 1, 'Acme Mutual', private.company_today(:'co') + 365)
returning id as sent_gl \gset
select t1070.check((select uploaded_via = 'sub' and uploaded_by = 'd1070000-0000-0000-0000-000000000005' and verified_at is null and verified_by is null and superseded_at is null
  from public.sub_documents where id = :'sent_gl'), 'a sub sends in a certificate: theirs, from them, waiting for the office to check it');
select t1070.check((select content_type = 'application/pdf' and size_bytes = 48213 from public.sub_documents where id = :'sent_gl'),
  'with the file''s type and size as Storage has them, not as the browser said');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values (%L, %L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'liability', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/page.html', private.company_today(:'co') + 30),
  'a web page isn''t paperwork, whatever its name');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, title) values (%L, %L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'other', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/logo.svg', 'Logo'),
  'nor a drawing that can run scripts');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, title) values (%L, %L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'other', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/nothing.pdf', 'Nothing'),
  'a document needs its file stored first');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path) values (%L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'w9', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9.pdf'),
  'and one they stored themselves: not the office''s file');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values (%L, %L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'workers_comp', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/wc.pdf', private.company_today(:'co') + 6 * 366),
  'a certificate that ends more than five years away is checked again');
insert into public.sub_documents (company_id, subcontractor_id, kind, path, title, expires_on) values
  (:'co', 'd1070000-0000-0000-0000-0000000000c1', 'license', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/license.jpg', 'Contractor license', private.company_today(:'co') + 6 * 366);
insert into public.sub_documents (company_id, subcontractor_id, kind, path) values
  (:'co', 'd1070000-0000-0000-0000-0000000000c1', 'w9', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9-signed.heic');
select t1070.check((select count(*) from public.sub_documents where uploaded_via = 'sub' and verified_at is null and kind in ('license', 'w9')) = 2,
  'a license can run longer, and a W-9 has no end date: both waiting for the office');
select t1070.check(t1070.changed(format('delete from storage.objects where name = %L', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/page.html')) = 0,
  'a file of theirs that the database turned down stays for the server to tidy away (nobody signed in deletes a stored file)');
select t1070.check((select state = 'expiring' and waiting from public.sub_paperwork where requirement = 'liability'),
  'the checked one still counts until the office checks the new one, and the new one shows as waiting');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, verified_at) values (%L, %L, %L, %L, now())',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'w9', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9-again.pdf'), 'they can''t send one in as checked');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, uploaded_via) values (%L, %L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'w9', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9-again.pdf', 'office'), 'or as the office''s');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values (%L, %L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'workers_comp', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/wc.pdf', private.company_today(:'co') - 1),
  'a certificate that''s already run out is refused');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path) values (%L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'workers_comp', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/wc.pdf'), 'and one without the date it ends');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path) values (%L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c2', 'w9', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c2/mine.pdf'), 'they can''t send paperwork in for another sub');
select t1070.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c2/mine.pdf', 'd1070000-0000-0000-0000-000000000005'),
  'or into another sub''s folder');
select t1070.check(t1070.changed(format('update public.sub_documents set expires_on = expires_on + 365 where id = %L', :'sent_gl')) = 0
  and t1070.changed(format('update public.sub_documents set verified_at = now() where id = %L', :'sent_gl')) = 0,
  'they can''t change one, or check it themselves');
select t1070.check(t1070.changed(format('update storage.objects set owner = owner where name = %L', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9.pdf')) = 0
  and t1070.changed(format('delete from storage.objects where name = %L', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/w9.pdf')) = 0
  and t1070.changed(format('delete from storage.objects where name = %L', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/new-gl.pdf')) = 0
  and t1070.changed(format('delete from storage.objects where name = %L', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/license.jpg')) = 0,
  'or replace or remove their paperwork''s files, checked or not');
commit;
-- Each one tells the office, so a sub sends at most 20 a day.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
do $$
declare co text := current_setting('t1070.co');
begin
  for i in 1..17 loop
    insert into storage.objects (bucket_id, name, owner, metadata) values
      ('files', co || '/subs/d1070000-0000-0000-0000-0000000000c1/more-' || i || '.pdf', 'd1070000-0000-0000-0000-000000000005', '{"mimetype": "application/pdf", "size": 10}');
    insert into public.sub_documents (company_id, subcontractor_id, kind, path, title) values
      (co::uuid, 'd1070000-0000-0000-0000-0000000000c1', 'other', co || '/subs/d1070000-0000-0000-0000-0000000000c1/more-' || i || '.pdf', 'More');
  end loop;
end $$;
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('files', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/one-too-many.pdf', 'd1070000-0000-0000-0000-000000000005', '{"mimetype": "application/pdf", "size": 10}');
select t1070.check((select count(*) from public.sub_documents where uploaded_via = 'sub') = 20, 'twenty sent today');
select t1070.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, title) values (%L, %L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-0000000000c1', 'other', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c1/one-too-many.pdf', 'More'),
  'the twenty-first waits until tomorrow');
rollback;
-- The office heard, and checks it.
select t1070.check((select count(*) from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000002' and title = 'Apex Roofing LLC sent their liability insurance') = 1,
  'the office hears a sub sent paperwork, to check it');

-- ===== Their time, while the company has them on the clock ======================================
update public.subcontractors set uses_clock = true where id = 'd1070000-0000-0000-0000-0000000000c1';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.check((select count(*) from public.time_entries) = 1, 'on the clock, a sub sees their own time');
insert into public.time_entries (company_id, user_id, visit_id, job_id, category, started_at) values (:'co', 'd1070000-0000-0000-0000-000000000005', :'v1', :'j1', 'visit', now() - interval '30 minutes')
returning id as al_clock \gset
update public.time_entries set ended_at = now() where id = :'al_clock';
select t1070.check((select count(*) from public.time_entries where ended_at is not null) = 2, 'and clocks in and out');
select t1070.expect_error(format('update public.time_entries set approved_at = now() where id = %L', :'al_clock'), 'but doesn''t approve it');
select t1070.expect_error(format('insert into public.time_entries (company_id, user_id, category, started_at) values (%L, %L, %L, now())', :'co', 'd1070000-0000-0000-0000-000000000004', 'shop'),
  'or clock someone else in');
select t1070.check(not exists (select 1 from public.time_entries where user_id <> 'd1070000-0000-0000-0000-000000000005'), 'or see anyone else''s');
select t1070.expect_error(format('insert into public.time_entries (company_id, user_id, visit_id, job_id, category, started_at) values (%L, %L, %L, %L, %L, now())',
  :'co', 'd1070000-0000-0000-0000-000000000005', :'v3', :'j2', 'visit'), 'or put time on a visit and job they aren''t on');
select t1070.expect_error(format('insert into public.time_entries (company_id, user_id, job_id, category, started_at) values (%L, %L, %L, %L, now())',
  :'co', 'd1070000-0000-0000-0000-000000000005', :'j2', 'other'), 'or on a job they aren''t on');
select t1070.expect_error(format('update public.time_entries set visit_id = %L, job_id = %L where id = %L', :'v3', :'j2', :'al_clock'), 'or move their own time there');
insert into public.time_entries (company_id, user_id, visit_id, category, started_at) values (:'co', 'd1070000-0000-0000-0000-000000000005', :'va', 'assessment', now() - interval '10 minutes')
returning id as al_running \gset
commit;
-- The office takes them off the clock while it's running: it stops, since they can't stop it now.
update public.subcontractors set uses_clock = false where id = 'd1070000-0000-0000-0000-0000000000c1';
select t1070.check((select ended_at is not null and ended_at > now() - interval '1 minute' from public.time_entries where id = :'al_running'),
  'turning their clock off stops one they left running');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.check((select count(*) from public.time_entries) = 0, 'off the clock again, their time closes to them');
select t1070.check(t1070.changed(format('delete from public.time_entries where user_id = %L', 'd1070000-0000-0000-0000-000000000005')) = 0, 'and they can''t remove it');
rollback;
select t1070.check((select count(*) from public.time_entries where user_id = 'd1070000-0000-0000-0000-000000000005') = 3, 'the office keeps it');
-- And when their sign-in is removed (or the sub turned off), the same.
update public.subcontractors set uses_clock = true where id = 'd1070000-0000-0000-0000-0000000000c1';
insert into public.time_entries (company_id, user_id, visit_id, category, started_at) values (:'co', 'd1070000-0000-0000-0000-000000000005', :'v1', 'visit', now() - interval '5 minutes')
returning id as al_running \gset
update public.memberships set active = false where user_id = 'd1070000-0000-0000-0000-000000000005' and company_id = :'co';
select t1070.check((select ended_at is not null from public.time_entries where id = :'al_running'), 'removing their sign-in stops a clock they left running');
update public.memberships set active = true where user_id = 'd1070000-0000-0000-0000-000000000005' and company_id = :'co';
insert into public.time_entries (company_id, user_id, visit_id, category, started_at) values (:'co', 'd1070000-0000-0000-0000-000000000004', :'v1', 'visit', now() - interval '5 minutes')
returning id as cy_running \gset
update public.subcontractors set active = false where id = 'd1070000-0000-0000-0000-0000000000c2';
update public.subcontractors set active = true where id = 'd1070000-0000-0000-0000-0000000000c2';
select t1070.check((select ended_at is null from public.time_entries where id = :'cy_running'), 'the crew''s clock keeps running through any of it');
delete from public.time_entries where id in (:'al_running', :'cy_running');
update public.subcontractors set uses_clock = false where id = 'd1070000-0000-0000-0000-0000000000c1';

-- ===== Client contact, by the office's choice ===================================================
update public.subcontractors set can_contact_clients = true where id = 'd1070000-0000-0000-0000-0000000000c1';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.check((select row(name, phone, email)::text from public.visit_contact(:'v1')) = '("Ann Client",+15405550111,ann@client.test)', 'with Can contact clients on, a sub gets the phone and email');
select t1070.check(not exists (select 1 from public.clients), 'still without reading clients');
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t1070.check((select row(name, phone)::text from public.visit_contact(:'v1')) = '("Ann Client",+15405550111)', 'the crew on the visit gets them, as they read the client anyway');
select t1070.check(not exists (select 1 from public.visit_contact(:'v3')), 'not for a visit they aren''t on');
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t1070.check((select phone from public.visit_contact(:'v3')) = '+15405550112', 'a crew lead, who reads every client, for any visit');
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t1070.check((select row(name, phone)::text from public.visit_contact(:'v3')) = '("Bob Other",)' and not exists (select 1 from public.visit_contact(:'v1')),
  'another sub: the name on their own visit only, and no phone unless their office allows it');
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t1070.check(not exists (select 1 from public.visit_contact(:'v1')), 'another company''s owner gets nothing');
rollback;
update public.subcontractors set can_contact_clients = false where id = 'd1070000-0000-0000-0000-0000000000c1';

-- ===== Other levels and companies get nothing from the rules that let a sub in ==================
-- Bo, another sub: only his own visit and paperwork.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t1070.check((select array_agg(title) from public.visits) = '{"Hang gutters"}' and (select array_agg(title) from public.jobs) = '{Gutters}'
  and (select array_agg(gate_code) from public.property_access) = '{9999}' and not exists (select 1 from public.attachments) and (select array_agg(title) from public.plan_files) = '{"Gutter plan"}'
  and (select array_agg(kind) from public.sub_documents) = '{w9}' and (select count(*) from public.sub_paperwork) = 3
  and (select count(*) from public.notifications) = 1 and not exists (select 1 from public.equipment),
  'another sub sees their own visit, its job, codes and plan, and their own paperwork; not Al''s');
select t1070.check(t1070.sorted(array(select name from storage.objects)) = t1070.sorted(array[:'co' || '/plans/d1070000-0000-0000-0000-0000000000b3.pdf',
    :'co' || '/subs/d1070000-0000-0000-0000-0000000000c2/w9.pdf', :'co' || '/visit/' || :'v3' || '/d1070000-0000-0000-0000-0000000000a5.jpg']),
  'and only their own files');
commit;
-- Cal: a sub the office turned off. Their sign-in reaches nothing.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select t1070.sweep();
commit;
select t1070.check(not exists (select 1 from t1070.seen where visible > 0 and tbl <> 'profiles'), 'a sub the office turned off reads nothing but their own profile, no files either'
  || coalesce(': ' || (select string_agg(tbl || ' ' || visible, ', ') from t1070.seen where visible > 0 and tbl <> 'profiles'), ''));
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select t1070.check(t1070.sub_functions_empty(), 'and job_scope, visit_contact, company_basics and my_sub_offers give them nothing');
rollback;
-- Al with his sign-in taken away.
update public.memberships set active = false where user_id = 'd1070000-0000-0000-0000-000000000005';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.sweep();
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.check(t1070.sub_functions_empty(), 'with their sign-in taken away, job_scope, visit_contact, company_basics and my_sub_offers give a sub nothing');
rollback;
update public.memberships set active = true where user_id = 'd1070000-0000-0000-0000-000000000005';
select t1070.check(not exists (select 1 from t1070.seen where visible > 0 and tbl not in ('profiles', 'push_subscriptions')), 'and they read nothing of the company, no files either'
  || coalesce(': ' || (select string_agg(tbl || ' ' || visible, ', ') from t1070.seen where visible > 0 and tbl not in ('profiles', 'push_subscriptions')), ''));
select t1070.check(exists (select 1 from t1070.seen where tbl = 'memberships') and (select visible from t1070.seen where tbl = 'memberships') = 0, 'not even their own sign-in');

-- Pat, another company's owner, reads none of Oscar's through them; and the Papa visit Al was put
-- on doesn't let Al into Papa.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t1070.check(not exists (select 1 from public.visits where company_id = :'co') and not exists (select 1 from public.sub_documents where company_id = :'co')
  and not exists (select 1 from public.sub_paperwork where company_id = :'co') and not exists (select 1 from storage.objects where name like :'co' || '/%'),
  'another company''s owner reads none of it');
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t1070.check(not exists (select 1 from public.visits where company_id = :'other') and not exists (select 1 from public.property_access where company_id = :'other'),
  'a visit at a company they don''t sign in to lets a sub into nothing there');
commit;

-- ===== The team keeps what it had ================================================================
-- The rules that let a sub back in are about a sub's own sign-ins: for every level of the team
-- there are none, so those rules give them nothing.
create function t1070.staff_sub_lists() returns boolean language plpgsql as $$
declare u uuid; ok boolean := true;
begin
  for u in select unnest(array['d1070000-0000-0000-0000-000000000001', 'd1070000-0000-0000-0000-000000000002', 'd1070000-0000-0000-0000-000000000003',
                               'd1070000-0000-0000-0000-000000000004', 'd1070000-0000-0000-0000-000000000007']::uuid[]) loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    ok := ok and private.sub_companies() = '{}' and not exists (select private.my_sub_ids()) and not exists (select 1 from private.my_sub_visits())
      and private.sub_clock_companies() = '{}' and private.worker_companies() = private.member_companies() and cardinality(private.member_companies()) = 1;
  end loop;
  return ok;
end $$;
grant execute on function t1070.staff_sub_lists() to authenticated;
begin;
set local role authenticated;
select t1070.check(t1070.staff_sub_lists(), 'owners, the office, crew leads, field crew and another company''s owner have no sub sign-ins, and work only for their own company');
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t1070.check((select name from public.company_basics(:'co')) = 'Oscar Roofing', 'company_basics answers the team too');
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t1070.check(not exists (select 1 from public.company_basics(:'co')) and not exists (select 1 from public.job_scope(:'j1')), 'but not another company''s owner');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t1070.check((select array_agg(title order by title) from public.visits) = '{"Clean up","Tear off and shingle"}'
  and (select array_agg(display_name) from public.clients) = '{"Ann Client"}' and (select count(*) from public.client_contacts) = 1
  and (select count(*) from public.crews) = 1 and (select count(*) from public.visit_assignees) = 6 and (select count(*) from public.equipment) = 2
  and (select count(*) from public.checklist_templates) = 3 and (select count(*) from public.attachments) = 4 and (select count(*) from public.time_entries) = 2,
  'field crew read what they always did (their own two time entries, and Ann''s porch photo OK to share)');
select t1070.check((select count(*) from public.memberships where company_id = :'co') = 7 and (select count(*) from public.profiles where full_name in ('Al Apex', 'Bo Birch')) = 2,
  'and see the subs on the team''s visits: their sign-ins and profiles');
select t1070.check(not exists (select 1 from public.subcontractors) and not exists (select 1 from public.sub_documents) and not exists (select 1 from public.sub_paperwork)
  and not exists (select 1 from storage.objects where name like '%/subs/%'), 'but not their paperwork, which is the office''s');
select t1070.check((select count(*) from storage.objects where name like :'co' || '/visit/%') = 4 and (select count(*) from storage.objects where name like :'co' || '/plans/%') = 3,
  'the team reads stored files as before');
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t1070.check((select count(*) from public.subcontractors) = 3 and (select count(*) from public.sub_paperwork) = 6 and (select count(*) from public.time_entries) = 5,
  'the office sees every sub, their paperwork status (turned-off ones aside) and everyone''s time');
select t1070.check((select array_agg(subcontractor_id order by subcontractor_id) from public.memberships where role = 'subcontractor')
  = '{d1070000-0000-0000-0000-0000000000c1,d1070000-0000-0000-0000-0000000000c2,d1070000-0000-0000-0000-0000000000c3}', 'and which sign-in is which sub''s');
commit;

\o
\echo 'Sub sign-ins'
\o /dev/null

-- ===== Who makes a sub's sign-in ================================================================
-- Only the server: from a browser nobody adds one, turns a membership into one, or one into the team's.
-- (Sid is a second owner here, so Oz changing his own membership isn't stopped for leaving no owner.)
begin;
insert into public.memberships (company_id, user_id, role) values (:'co', 'd1070000-0000-0000-0000-000000000008', 'owner');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t1070.expect_error(format('insert into public.memberships (company_id, user_id, role, subcontractor_id) values (%L, %L, %L, %L)',
  :'co', 'd1070000-0000-0000-0000-000000000008', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c2'), 'the owner can''t give a sub a sign-in from the browser');
select t1070.expect_error(format('update public.memberships set role = %L where company_id = %L and user_id = %L', 'field_crew', :'co', 'd1070000-0000-0000-0000-000000000005'),
  'or turn a sub''s into the team''s');
select t1070.expect_error(format('update public.memberships set role = %L, subcontractor_id = %L where company_id = %L and user_id = %L', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c2', :'co', 'd1070000-0000-0000-0000-000000000004'),
  'or the crew''s into a sub''s');
select t1070.expect_error(format('update public.memberships set role = %L, subcontractor_id = %L where company_id = %L and user_id = %L', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c2', :'co', 'd1070000-0000-0000-0000-000000000001'),
  'or their own');
select t1070.expect_error(format('update public.memberships set active = true where company_id = %L and user_id = %L', :'co', 'd1070000-0000-0000-0000-000000000009'),
  'or give a sub''s back');
select t1070.expect_error(format('update public.memberships set role_id = (select id from public.company_roles where company_id = %L and name = %L) where company_id = %L and user_id = %L',
  :'co', 'Employee', :'co', 'd1070000-0000-0000-0000-000000000006'), 'or give a sub a custom role');
select t1070.expect_error(format('insert into public.company_roles (company_id, name, base_role) values (%L, %L, %L)', :'co', 'Trusted sub', 'subcontractor'),
  'a custom role can''t be at the Subcontractor level');
select t1070.expect_error(format('insert into public.crew_members (company_id, crew_id, user_id) values (%L, %L, %L)', :'co', :'crew', 'd1070000-0000-0000-0000-000000000005'),
  'a sub can''t be put on a crew');
select t1070.expect_error(format('update public.crews set lead_user_id = %L where id = %L', 'd1070000-0000-0000-0000-000000000005', :'crew'), 'or lead one');

select t1070.check(t1070.changed(format('delete from public.memberships where company_id = %L and user_id = %L', :'co', 'd1070000-0000-0000-0000-000000000009')) = 1,
  'an owner can still remove a sub''s sign-in, as anyone''s');
rollback;
-- An admin, on their own membership.
begin;
insert into public.memberships (company_id, user_id, role) values (:'co', 'd1070000-0000-0000-0000-000000000008', 'admin');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
select t1070.expect_error(format('update public.memberships set role = %L, subcontractor_id = %L where company_id = %L and user_id = %L', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c2', :'co', 'd1070000-0000-0000-0000-000000000008'),
  'nobody turns their own membership into a sub''s');
rollback;

-- The server's: the level and the sub go together, and the sub is one of the company's.
select t1070.expect_error(format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', :'co', 'd1070000-0000-0000-0000-000000000008', 'subcontractor'),
  'a sub''s sign-in says which sub');
select t1070.expect_error(format('insert into public.memberships (company_id, user_id, role, subcontractor_id) values (%L, %L, %L, %L)', :'co', 'd1070000-0000-0000-0000-000000000008', 'field_crew', 'd1070000-0000-0000-0000-0000000000c2'),
  'and only a sub''s does');
select t1070.expect_error(format('insert into public.memberships (company_id, user_id, role, subcontractor_id) values (%L, %L, %L, %L)', :'co', 'd1070000-0000-0000-0000-000000000008', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c9'),
  'and it''s a sub of that company');
select t1070.expect_error(format('insert into public.memberships (company_id, user_id, role, subcontractor_id) values (%L, %L, %L, %L)', :'co', 'd1070000-0000-0000-0000-000000000004', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c2'),
  'someone on the team can''t also be a sub of the same company');
select t1070.expect_error(format('insert into public.chat_role_rules (company_id, channel_id, role, can_see) values (%L, %L, %L, true)', :'co', :'general', 'subcontractor'),
  'team chat has no rules for subs');
select t1070.expect_error(format('insert into public.chat_role_settings (company_id, role) values (%L, %L)', :'co', 'subcontractor'), 'or settings');
select t1070.check(private.level_permissions('subcontractor') = '{}', 'the Subcontractor level has no areas');

-- Someone on one company's team and a sub of another gets each by its own rules.
insert into public.memberships (company_id, user_id, role) values (:'other', 'd1070000-0000-0000-0000-000000000008', 'field_crew');
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', 'd1070000-0000-0000-0000-000000000008', 'subcontractor', 'd1070000-0000-0000-0000-0000000000c2');
-- Birch's agreed pay covers the gutters, so a sign-in given to Birch goes on that visit (20261025004002_sub_pay_seams.sql).
select t1070.check(exists (select 1 from public.visit_assignees where visit_id = :'v3' and user_id = 'd1070000-0000-0000-0000-000000000008'),
  'a sign-in given to a sub later goes on the visit their agreed pay covers');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
select t1070.check(private.member_companies() = array[:'other']::uuid[] and private.sub_companies() = array[:'co']::uuid[]
  and t1070.sorted(private.worker_companies()::text[]) = t1070.sorted(array[:'co', :'other']),
  'on Papa''s team and Birch''s sign-in at Oscar: a member of Papa, a sub of Oscar, and working for both');
select t1070.check((select array_agg(title) from public.visits where company_id = :'co') = '{"Hang gutters"}' and (select count(*) from public.clients where company_id = :'co') = 0,
  'at Oscar, only the sub''s visits');
select t1070.check(not exists (select 1 from public.chat_channels) and (select count(*) from public.profiles) = 2,
  'not Oscar''s team chat, and only the profiles of Papa''s team');
select public.create_company('Sid''s Siding') as sids \gset
select t1070.check(:'sids' is not null, 'with a place on a team, they can still set up a business of their own');
rollback;
-- Someone with their own account, whom an office gave sub access: the office can't stop them
-- starting a business.
begin;
update auth.users set raw_app_meta_data = '{}' where id = 'd1070000-0000-0000-0000-000000000006';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "d1070000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select public.create_company('Bo''s Gutters') as bos \gset
select t1070.check(:'bos' is not null, 'their own account, with only sub access the office gave it, can still set up a business');
rollback;
delete from public.visit_assignees where user_id = 'd1070000-0000-0000-0000-000000000008';
delete from public.memberships where user_id = 'd1070000-0000-0000-0000-000000000008';

-- ===== Reminders reach the sub's sign-in ========================================================
-- Al's liability insurance ends in 10 days (the one the office has on file; the one he sent is
-- waiting for the office to check it, so he isn't reminded). Birch's ends in 5, and nothing's waiting.
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', 'd1070000-0000-0000-0000-0000000000c2', 'liability', :'co' || '/subs/d1070000-0000-0000-0000-0000000000c2/gl.pdf', private.company_today(:'co') + 5);
delete from public.notifications;
begin;
set local role service_role;
select count(*) as alerts from public.emit_sub_document_alerts(true, true) \gset
commit;
select t1070.check(:alerts = 2, 'two certificates are running out');
select t1070.check((select count(*) from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000002' and kind = 'subs') = 2, 'the office hears about both');
select t1070.check((select row(kind, title, link)::text from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000006')
  = '(subs,"Your liability insurance ends in 5 days",/field/paperwork)', 'the sub with a sign-in hears too, and the notification opens their paperwork');
select t1070.check(not exists (select 1 from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000005'), 'not a sub who already sent the new one');
select t1070.check((select body from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000006') like 'It ends % Send us the new one under My paperwork.', 'saying what to do');

-- With reminding subs turned off (Settings → Subs), the office still hears; the sub doesn't.
update public.sub_documents set alerted_state = null where company_id = :'co';
delete from public.notifications;
update public.companies set settings = jsonb_set(settings, '{subs}', '{"remind_subs": false}') where id = :'co';
begin;
set local role service_role;
select count(*) as alerts from public.emit_sub_document_alerts(true, true) \gset
commit;
select t1070.check(:alerts = 2 and (select count(*) from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000002' and kind = 'subs') = 2
  and not exists (select 1 from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000006'),
  'with reminding subs turned off, the office hears and the sub doesn''t');
update public.companies set settings = settings #- '{subs,remind_subs}' where id = :'co';
-- A sub whose sign-in was removed isn't told either.
update public.sub_documents set alerted_state = null where company_id = :'co';
delete from public.notifications;
update public.memberships set active = false where user_id = 'd1070000-0000-0000-0000-000000000006';
begin;
set local role service_role;
select count(*) as alerts from public.emit_sub_document_alerts(true, true) \gset
commit;
select t1070.check(:alerts = 2 and (select count(*) from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000002' and kind = 'subs') = 2
  and not exists (select 1 from public.notifications where user_id = 'd1070000-0000-0000-0000-000000000006'),
  'nor is a sub whose sign-in was removed');
update public.memberships set active = true where user_id = 'd1070000-0000-0000-0000-000000000006';

-- ===== Signing a person out everywhere ===========================================================
-- When the office removes a sign-in, the server ends its sessions, so an old phone can't come back.
insert into auth.sessions (id, user_id) values
  ('d1070000-0000-0000-0000-0000000000e5', 'd1070000-0000-0000-0000-000000000005'), ('d1070000-0000-0000-0000-0000000000e6', 'd1070000-0000-0000-0000-000000000005'),
  ('d1070000-0000-0000-0000-0000000000e7', 'd1070000-0000-0000-0000-000000000002');
insert into auth.refresh_tokens (session_id, user_id, token) values ('d1070000-0000-0000-0000-0000000000e5', 'd1070000-0000-0000-0000-000000000005', 'r1');
select t1070.check(not has_function_privilege('authenticated', 'public.end_sessions(uuid)', 'execute') and not has_function_privilege('anon', 'public.end_sessions(uuid)', 'execute'),
  'nobody signed in can sign someone out');
begin;
set local role service_role;
select public.end_sessions('d1070000-0000-0000-0000-000000000005') as ended \gset
commit;
select t1070.check(:ended = 2 and not exists (select 1 from auth.sessions where user_id = 'd1070000-0000-0000-0000-000000000005') and not exists (select 1 from auth.refresh_tokens)
  and exists (select 1 from auth.sessions where user_id = 'd1070000-0000-0000-0000-000000000002'),
  'the server ends every session of that person, with its refresh tokens, and no one else''s');

\o
\echo 'All sub isolation tests passed.'
