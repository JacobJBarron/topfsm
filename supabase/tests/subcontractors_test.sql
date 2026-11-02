-- Database tests for subcontractors and their paperwork (20261025001001_subcontractors.sql and
-- 20261025001002_sub_paperwork_reminders.sql): only owners, admins and office staff with the subs
-- area reach subs, their documents and their files; a newer document replaces the one before it;
-- what a sub sends waits to be checked before it replaces a checked one; paperwork is OK, running
-- out, run out or missing by the company's today; and the office (and, unless the company turned it
-- off, the sub) hears before a certificate runs out, from 8 in the morning, once at each step, even
-- when two runs go at once.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1060;
grant usage on schema t1060 to authenticated, service_role;
create function t1060.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1060.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- Whether the other connection (its pid) is held up waiting on this one, given up to 10 seconds to get
-- there: a race test that only slept could pass without the race happening.
create function t1060.waiting_on_me(p_pid integer) returns boolean language plpgsql as $$
begin
  for i in 1..200 loop
    if pg_blocking_pids(p_pid) @> array[pg_backend_pid()] then return true; end if;
    perform pg_sleep(0.05);
  end loop;
  return false;
end $$;
grant execute on all functions in schema t1060 to authenticated, service_role;
-- A second connection, to send reminders at the same time as this one (dblink may already be installed).
set client_min_messages = warning;
create extension if not exists dblink schema t1060;
reset client_min_messages;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset
create table t1060.sent (run text not null, document_id uuid not null, alert text not null, remind_sub boolean not null);
grant all on t1060.sent to service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c1060000-0000-0000-0000-000000000001', 'owner@uniform.test', '{"full_name": "Una Owner"}'),
  ('c1060000-0000-0000-0000-000000000002', 'adam@uniform.test', '{"full_name": "Adam Admin"}'),
  ('c1060000-0000-0000-0000-000000000003', 'olga@uniform.test', '{"full_name": "Olga Office"}'),
  ('c1060000-0000-0000-0000-000000000004', 'dina@uniform.test', '{"full_name": "Dina Dispatcher"}'),
  ('c1060000-0000-0000-0000-000000000005', 'ed@uniform.test', '{"full_name": "Ed Estimator"}'),
  ('c1060000-0000-0000-0000-000000000006', 'fay@uniform.test', '{"full_name": "Fay Foreman"}'),
  ('c1060000-0000-0000-0000-000000000007', 'eli@uniform.test', '{"full_name": "Eli Employee"}'),
  ('c1060000-0000-0000-0000-000000000008', 'vic@victor.test', '{"full_name": "Vic Victor"}'),
  ('c1060000-0000-0000-0000-000000000009', 'max@uniform.test', '{"full_name": "Max Manager"}'),
  ('c1060000-0000-0000-0000-00000000000a', 'kim@kilo.test', '{"full_name": "Kim Kilo"}');

-- Reminders go out from 8 in the morning in the company's time zone, and these tests can't set the
-- clock. So the businesses get time zones where it's daytime now: Uniform's as far ahead as can be,
-- Victor's as far behind. Kilo's is one where it's still early morning.
select name as uniform_tz from pg_timezone_names where name ~ '^Etc/GMT[+-][0-9]+$' and extract(hour from now() at time zone name) between 9 and 20
  order by utc_offset desc limit 1 \gset
select name as victor_tz from pg_timezone_names where name ~ '^Etc/GMT[+-][0-9]+$' and extract(hour from now() at time zone name) between 9 and 20
  order by utc_offset limit 1 \gset
select name as kilo_tz from pg_timezone_names where name ~ '^Etc/GMT[+-][0-9]+$' and extract(hour from now() at time zone name) between 1 and 6
  order by utc_offset limit 1 \gset

-- Uniform Roofing: the owner; Adam, an admin; Olga in the office; Dina in the office as a
-- Dispatcher (no subs area); Max, an Office manager (the starter role); Ed the estimator; Fay,
-- Foreman; Eli on the crew. Victor Paving is another business, and so is Kilo Lawn.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Uniform Roofing', 'roofing', :'uniform_tz') as co \gset
select id as foreman_role from public.company_roles where company_id = :'co' and name = 'Foreman' \gset
select id as employee_role from public.company_roles where company_id = :'co' and name = 'Employee' \gset
select id as manager_role from public.company_roles where company_id = :'co' and name = 'Office manager' \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Dispatcher', 'office', '{schedule,job_costs}') returning id as dispatch_role \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', 'c1060000-0000-0000-0000-000000000002', 'admin', null),
  (:'co', 'c1060000-0000-0000-0000-000000000003', 'office', null),
  (:'co', 'c1060000-0000-0000-0000-000000000004', 'office', :'dispatch_role'),
  (:'co', 'c1060000-0000-0000-0000-000000000005', 'estimator', null),
  (:'co', 'c1060000-0000-0000-0000-000000000006', 'crew_lead', :'foreman_role'),
  (:'co', 'c1060000-0000-0000-0000-000000000007', 'field_crew', :'employee_role'),
  (:'co', 'c1060000-0000-0000-0000-000000000009', 'office', :'manager_role');
set local role authenticated;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
select public.create_company('Victor Paving', 'paving', :'victor_tz') as other \gset
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-00000000000a", "role": "authenticated"}', true);
select public.create_company('Kilo Lawn', 'lawn', :'kilo_tz') as kilo \gset
commit;

-- ===== The subs area ===========================================================================
select t1060.check(private.level_permissions('owner') @> '{subs}' and private.level_permissions('admin') @> '{subs}' and private.level_permissions('office') @> '{subs}',
  'owners, admins and office staff can have the subs area');
select t1060.check(not (private.level_permissions('estimator') @> '{subs}') and not (private.level_permissions('crew_lead') @> '{subs}') and not (private.level_permissions('field_crew') @> '{subs}'),
  'estimators, crew leads and field crew can''t');
select t1060.check(private.level_permissions('crew_lead') = '{schedule,timesheets,equipment}' and private.level_permissions('estimator') = '{sales,schedule,equipment}',
  'and keep exactly the areas they had');
select t1060.check((select array_agg(name order by name) from public.company_roles where company_id = :'co' and 'subs' = any (permissions))
  = '{"General manager","Office manager","Operations manager"}', 'the starter roles that handle job costs handle subs');
select t1060.expect_error(format('update public.company_roles set permissions = %L where id = %L', '{equipment,subs}', :'foreman_role'), 'a Foreman role can''t be given subs');

-- ===== The owner adds a sub and their paperwork ================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.subcontractors (company_id, name, contact_name, phone, email, trade, address, tax_classification)
values (:'co', 'Apex Roofing LLC', 'Al Apex', '+15405550101', 'al@apex.test', 'Roofing', '{"line1": "1 Ridge Rd", "city": "Radford", "region": "VA"}', 'llc_s_corp')
returning id as apex \gset
insert into public.subcontractors (company_id, name, email) values (:'co', 'Blue Gutters', 'blue@gutters.test') returning id as blue \gset
select t1060.check((select created_by = 'c1060000-0000-0000-0000-000000000001' and active and not can_contact_clients and not uses_clock from public.subcontractors where id = :'apex'),
  'a new sub is active, can''t see client contacts and doesn''t clock');
select t1060.expect_error(format('insert into public.subcontractors (company_id, name, tax_classification) values (%L, %L, %L)', :'co', 'Nope', 'trust'), 'the tax classification is one of the W-9''s');
select t1060.expect_error(format('insert into public.subcontractors (company_id, name, email) values (%L, %L, %L)', :'co', 'Nope', 'not an email'), 'an email address looks like one');
select t1060.expect_error(format('insert into public.subcontractors (company_id, name) values (%L, %L)', :'co', '   '), 'a sub has a name');

insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/subs/' || :'apex' || '/w9.pdf', 'c1060000-0000-0000-0000-000000000001');
insert into public.sub_documents (company_id, subcontractor_id, kind, title, path, file_name, content_type, size_bytes)
values (:'co', :'apex', 'w9', 'W-9', :'co' || '/subs/' || :'apex' || '/w9.pdf', 'w9.pdf', 'application/pdf', 120000) returning id as apex_w9 \gset
select t1060.check((select uploaded_via = 'office' and uploaded_by = 'c1060000-0000-0000-0000-000000000001' and verified_by = 'c1060000-0000-0000-0000-000000000001' and verified_at is not null
  from public.sub_documents where id = :'apex_w9'), 'what the office adds is from the office, and counts as checked');
select t1060.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values (%L, %L, %L, %L, %L)',
  :'co', :'apex', 'w9', :'co' || '/subs/' || :'apex' || '/w9-2.pdf', '2030-01-01'), 'a W-9 has no end date');
select t1060.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path) values (%L, %L, %L, %L)',
  :'co', :'apex', 'liability', :'co' || '/subs/' || :'blue' || '/coi.pdf'), 'a document''s file is in its own sub''s folder');
select t1060.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path) values (%L, %L, %L, %L)',
  :'co', :'apex', 'liability', :'co' || '/receipts/coi.pdf'), 'not somewhere else in the company''s files');
select t1060.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path) values (%L, %L, %L, %L)',
  :'co', :'apex', 'liability', :'co' || '/subs/' || :'apex' || '/../../receipts/coi.pdf'), 'and can''t climb out of it');
select t1060.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path) values (%L, %L, %L, %L)',
  :'co', :'apex', 'liability', :'co' || '/subs/' || :'apex' || '/'), 'a folder isn''t a file');
select t1060.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path) values (%L, %L, %L, %L)',
  :'other', :'apex', 'liability', :'other' || '/subs/' || :'apex' || '/coi.pdf'), 'a document is for a sub of the same business');
select t1060.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, uploaded_via) values (%L, %L, %L, %L, %L)',
  :'co', :'apex', 'liability', :'co' || '/subs/' || :'apex' || '/x.pdf', 'link'), 'the office can''t say a document came by link');
select t1060.expect_error(format('update public.sub_documents set path = %L where id = %L', :'co' || '/subs/' || :'apex' || '/moved.pdf', :'apex_w9'), 'or move its file');
select t1060.expect_error(format('update public.sub_documents set superseded_at = now() where id = %L', :'apex_w9'), 'or mark it replaced by hand');
commit;

-- ===== Olga in the office has the area; Max the Office manager too =============================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t1060.check((select count(*) from public.subcontractors where company_id = :'co') = 2, 'the office sees the subs');
select t1060.check((select count(*) from public.sub_documents where company_id = :'co') = 1, 'and their paperwork');
select t1060.check((select count(*) from public.sub_paperwork where company_id = :'co') = 6, 'and its status: three pieces for each active sub');
select t1060.check((select count(*) from storage.objects where name like '%/subs/%') = 1, 'and can open the files');
update public.subcontractors set notes = 'Good on steep roofs', can_contact_clients = true where id = :'apex';
select t1060.check((select notes = 'Good on steep roofs' and can_contact_clients from public.subcontractors where id = :'apex'), 'and change a sub');
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/subs/' || :'blue' || '/coi.pdf', 'c1060000-0000-0000-0000-000000000003');
insert into public.sub_documents (company_id, subcontractor_id, kind, path, carrier, policy_number, expires_on)
values (:'co', :'blue', 'liability', :'co' || '/subs/' || :'blue' || '/coi.pdf', 'Acme Mutual', 'GL-1', private.company_today(:'co') + 200) returning id as blue_gl \gset
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select t1060.check((select count(*) from public.subcontractors where company_id = :'co') = 2 and (select count(*) from storage.objects where name like '%/subs/%') = 2,
  'so does an Office manager');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t1060.check((select count(*) from public.sub_documents where company_id = :'co') = 2 and (select count(*) from storage.objects where name like '%/subs/%') = 2,
  'and an admin');
commit;

-- ===== Everyone else: nothing ==================================================================
-- Dina's own upload there (made by the server, say) is still out of her reach.
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/subs/' || :'blue' || '/dina.pdf', 'c1060000-0000-0000-0000-000000000004');
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/visit/photo.jpg', 'c1060000-0000-0000-0000-000000000004');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t1060.check((select count(*) from public.subcontractors) = 0 and (select count(*) from public.sub_documents) = 0 and (select count(*) from public.sub_paperwork) = 0,
  'office staff without the subs area see no subs, paperwork or status');
select t1060.check((select count(*) from storage.objects where name like '%/subs/%') = 0, 'or their files, even one they uploaded');
select t1060.check((select count(*) from storage.objects where name like '%/visit/%') = 1, 'though the team''s other files stay open to them');
select t1060.expect_error(format('insert into public.subcontractors (company_id, name) values (%L, %L)', :'co', 'Sneaky Sub'), 'and they can''t add a sub');
select t1060.expect_error(format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)', 'files', :'co' || '/subs/' || :'blue' || '/fake.pdf', 'c1060000-0000-0000-0000-000000000004'),
  'or put a file in a sub''s folder');
delete from storage.objects where name = :'co' || '/subs/' || :'blue' || '/dina.pdf';
update public.subcontractors set name = 'Hacked' where id = :'apex';
commit;
select t1060.check((select count(*) from storage.objects where name like '%/subs/%/dina.pdf') = 1, 'or remove one, even their own');
select t1060.check((select name from public.subcontractors where id = :'apex') = 'Apex Roofing LLC', 'or change a sub');

select set_config('t1060.co', :'co', false);
do $$
declare u text;
begin
  foreach u in array array['c1060000-0000-0000-0000-000000000005', 'c1060000-0000-0000-0000-000000000006', 'c1060000-0000-0000-0000-000000000007', 'c1060000-0000-0000-0000-000000000008'] loop
    perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true);
    set local role authenticated;
    perform t1060.check((select count(*) from public.subcontractors) = 0 and (select count(*) from public.sub_documents) = 0 and (select count(*) from public.sub_paperwork) = 0,
      u || ' sees no subs, paperwork or status');
    perform t1060.check((select count(*) from storage.objects where name like '%/subs/%') = 0, u || ' opens no sub''s files');
    perform t1060.expect_error(format('insert into public.subcontractors (company_id, name) values (%L, %L)',
      current_setting('t1060.co'), 'Sneaky Sub'), u || ' can''t add a sub');
    perform t1060.expect_error(format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'files',
      current_setting('t1060.co') || '/subs/x/fake.pdf'), u || ' can''t put a file in a sub''s folder');
    reset role;
  end loop;
end $$;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
-- Victor's own subs and files are his alone.
insert into public.subcontractors (company_id, name, phone) values (:'other', 'Valley Sealcoat', '+15405550199') returning id as valley \gset
insert into storage.objects (bucket_id, name, owner) values ('files', :'other' || '/subs/' || :'valley' || '/coi.pdf', 'c1060000-0000-0000-0000-000000000008');
select t1060.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path) values (%L, %L, %L, %L)',
  :'co', :'apex', 'other', :'co' || '/subs/' || :'apex' || '/x.pdf'), 'another business can''t add paperwork to a sub that isn''t theirs');
select t1060.check((select count(*) from public.subcontractors) = 1 and (select count(*) from storage.objects where name like '%/subs/%') = 1, 'another business sees only their own subs and files');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t1060.check((select count(*) from public.subcontractors where company_id = :'other') = 0 and (select count(*) from storage.objects where name like :'other' || '/%') = 0,
  'and Uniform''s owner sees none of Victor''s');
commit;

-- ===== Paperwork a sub sends by link, and checking it =========================================
-- The server records it (services/subs.ts): unchecked, by link.
set role service_role;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, file_name, expires_on, uploaded_via)
values (:'co', :'apex', 'liability', :'co' || '/subs/' || :'apex' || '/coi-2026.pdf', 'coi-2026.pdf', private.company_today(:'co') + 30, 'link') returning id as apex_gl \gset
reset role;
select t1060.check((select verified_at is null and verified_by is null and uploaded_by is null and uploaded_via = 'link' from public.sub_documents where id = :'apex_gl'),
  'paperwork a sub sends by link waits to be checked');
select t1060.check((select count(*) = 4 and bool_and(link = '/subs/' || :'apex' and title = 'Apex Roofing LLC sent their liability insurance')
  from public.notifications where kind = 'subs' and company_id = :'co'), 'and the office with the subs area hears about it');
select t1060.check((select array_agg(user_id order by user_id) from public.notifications where kind = 'subs' and company_id = :'co')
  = array['c1060000-0000-0000-0000-000000000001', 'c1060000-0000-0000-0000-000000000002', 'c1060000-0000-0000-0000-000000000003', 'c1060000-0000-0000-0000-000000000009']::uuid[],
  'the owner, the admin, the office and the Office manager; not Dina, the estimator or the crew');
select t1060.check((select state = 'expiring' and verified = false and document_id = :'apex_gl' from public.sub_paperwork where subcontractor_id = :'apex' and requirement = 'liability'),
  'it counts as on file, marked unchecked');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.sub_documents set verified_at = '2001-01-01' where id = :'apex_gl';
select t1060.check((select verified_at > now() - interval '1 minute' and verified_by = 'c1060000-0000-0000-0000-000000000003' from public.sub_documents where id = :'apex_gl'),
  'checking it stamps who and when, whatever time the browser sends');
update public.sub_documents set verified_at = null where id = :'apex_gl';
select t1060.check((select verified_at is null and verified_by is null from public.sub_documents where id = :'apex_gl'), 'and it can be unchecked');
update public.sub_documents set verified_at = now() where id = :'apex_gl';
commit;

-- ===== A newer document replaces the one before ================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on)
values (:'co', :'apex', 'liability', :'co' || '/subs/' || :'apex' || '/coi-2027.pdf', private.company_today(:'co') + 395) returning id as apex_gl2 \gset
select t1060.check((select superseded_at is not null and superseded_by = :'apex_gl2' from public.sub_documents where id = :'apex_gl'), 'a new certificate replaces the old one');
select t1060.check((select document_id = :'apex_gl2' and state = 'ok' from public.sub_paperwork where subcontractor_id = :'apex' and requirement = 'liability'), 'which no longer counts');
-- An old certificate found in a drawer, filed for the record.
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on)
values (:'co', :'apex', 'liability', :'co' || '/subs/' || :'apex' || '/coi-2024.pdf', private.company_today(:'co') - 300) returning id as apex_gl0 \gset
select t1060.check((select superseded_by = :'apex_gl2' from public.sub_documents where id = :'apex_gl0') and (select superseded_at is null from public.sub_documents where id = :'apex_gl2'),
  'one that ended before the current one is kept, but doesn''t replace it');
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', :'apex', 'license', :'co' || '/subs/' || :'apex' || '/state.pdf', private.company_today(:'co') + 10),
  (:'co', :'apex', 'license', :'co' || '/subs/' || :'apex' || '/city.pdf', private.company_today(:'co') + 400);
select t1060.check((select count(*) from public.sub_documents where subcontractor_id = :'apex' and kind = 'license' and superseded_at is null) = 2, 'a sub can hold several licenses');
-- Removing the newest puts back the one it replaced.
delete from public.sub_documents where id = :'apex_gl2';
select t1060.check((select superseded_at is null and superseded_by is null from public.sub_documents where id = :'apex_gl'), 'removing a document puts back the one it replaced');
select t1060.check((select superseded_by = :'apex_gl' from public.sub_documents where id = :'apex_gl0'), 'and what that one replaced stays replaced');
commit;

-- ===== Status by the company's today ===========================================================
-- Workers' comp: Apex has an exemption; Blue nothing. A third sub has every kind lapsing.
set role service_role;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', :'apex', 'wc_exemption', :'co' || '/subs/' || :'apex' || '/exempt.pdf', private.company_today(:'co') + 90);
insert into public.subcontractors (company_id, name) values (:'co', 'Cedar Siding') returning id as cedar \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', :'cedar', 'liability', :'co' || '/subs/' || :'cedar' || '/gl.pdf', private.company_today(:'co') - 1),
  (:'co', :'cedar', 'workers_comp', :'co' || '/subs/' || :'cedar' || '/wc.pdf', private.company_today(:'co'));
insert into public.subcontractors (company_id, name, active) values (:'co', 'Gone Gutters', false) returning id as gone \gset
reset role;
select t1060.check((select array_agg(requirement || '=' || state order by requirement) from public.sub_paperwork where subcontractor_id = :'apex')
  = '{liability=expiring,w9=ok,workers_comp=ok}', 'Apex: W-9 on file, liability ends within 30 days, workers'' comp covered by an exemption');
select t1060.check((select kind = 'wc_exemption' and days_left = 90 from public.sub_paperwork where subcontractor_id = :'apex' and requirement = 'workers_comp'), 'which says which kind covers it');
select t1060.check((select days_left is null and expires_on is null and verified from public.sub_paperwork where subcontractor_id = :'apex' and requirement = 'w9'), 'a W-9 never runs out');
select t1060.check((select array_agg(requirement || '=' || state order by requirement) from public.sub_paperwork where subcontractor_id = :'blue')
  = '{liability=ok,w9=missing,workers_comp=missing}', 'Blue: no W-9 or workers'' comp');
select t1060.check((select document_id is null and verified is null from public.sub_paperwork where subcontractor_id = :'blue' and requirement = 'w9'), 'missing means no document');
select t1060.check((select array_agg(requirement || '=' || state || ':' || coalesce(days_left::text, '-') order by requirement) from public.sub_paperwork where subcontractor_id = :'cedar')
  = '{liability=expired:-1,w9=missing:-,workers_comp=expiring:0}', 'Cedar: liability ran out yesterday, workers'' comp ends today (still covered)');
select t1060.check(not exists (select 1 from public.sub_paperwork where subcontractor_id = :'gone'), 'inactive subs have no status');
-- The company's today, not the server's or another business's: Valley's certificate ends on the day
-- before Uniform's today, and Victor's company is (for a moment) where the date is another one.
set role service_role;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on)
values (:'other', :'valley', 'liability', :'other' || '/subs/' || :'valley' || '/coi.pdf', private.company_today(:'co') - 1) returning id as valley_gl \gset
reset role;
begin;
update public.companies set timezone = (select name from pg_timezone_names where name ~ '^Etc/GMT[+-][0-9]+$'
  and (now() at time zone name)::date <> private.company_today(:'co') limit 1) where id = :'other';
select t1060.check(private.company_today(:'other') <> private.company_today(:'co'), 'Victor''s today is another day than Uniform''s');
select t1060.check((select days_left = (private.company_today(:'co') - 1) - private.company_today(:'other') and days_left <> -1
    and state = case when days_left < 0 then 'expired' else 'expiring' end
  from public.sub_paperwork where subcontractor_id = :'valley' and requirement = 'liability'),
  'so a certificate that ran out yesterday at Uniform''s is counted by Victor''s day');
rollback;

-- The edges, the same as the core helper's (packages/core/test/subs.test.ts).
select t1060.check((select array_agg(coalesce(private.sub_alert_due(n), '-') order by i) from unnest(array[31, 30, 8, 7, 1, 0, -5, null]) with ordinality as x(n, i))
  = '{-,d30,d30,d7,d7,expired,expired,-}', 'reminders are due at 30 days, 7 days and on the day it ends');
begin;
update public.sub_documents set expires_on = private.company_today(:'co') + 31 where id = :'blue_gl';
select t1060.check((select state = 'ok' and days_left = 31 from public.sub_paperwork where subcontractor_id = :'blue' and requirement = 'liability'), 'a certificate ending in 31 days is OK');
rollback;

-- ===== Reminders before a certificate runs out =================================================
-- Apex's liability ends in 30 days, Cedar's liability ended yesterday and its workers' comp ends
-- today, Apex's exemption in 90 (not yet), Blue's liability in 200. Apex's licenses and W-9 never
-- remind, and nor does the old certificate Apex's replaced. Valley's ends in 8 days at Victor's.
-- Kilo's ends in 5, but it's still early morning there.
delete from public.notifications;
update public.sub_documents set expires_on = private.company_today(:'other') + 8 where id = :'valley_gl';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-00000000000a", "role": "authenticated"}', true);
insert into public.subcontractors (company_id, name, email) values (:'kilo', 'Kilo Mowing Crew', 'crew@kilo.test') returning id as kilo_sub \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on)
values (:'kilo', :'kilo_sub', 'liability', :'kilo' || '/subs/' || :'kilo_sub' || '/gl.pdf', private.company_today(:'kilo') + 5);
commit;
insert into public.subcontractors (company_id, name, email) values (:'co', 'Dormant Decks', 'dd@decks.test') returning id as dormant \gset
set role service_role;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', :'dormant', 'liability', :'co' || '/subs/' || :'dormant' || '/gl.pdf', private.company_today(:'co') + 3);
reset role;
update public.subcontractors set active = false where id = :'dormant';

-- Two runs at once: the other connection takes the reminders and hasn't finished; this one leaves them.
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
select :"dbl".dblink_exec('other', 'begin; set role service_role');
insert into t1060.sent select 'other', document_id, alert, remind_sub
  from :"dbl".dblink('other', 'select document_id, alert, remind_sub from public.emit_sub_document_alerts(true, true)') as t(document_id uuid, alert text, remind_sub boolean);
set role service_role;
insert into t1060.sent select 'this', document_id, alert, remind_sub from public.emit_sub_document_alerts(true, true);
reset role;
select :"dbl".dblink_exec('other', 'commit');
select :"dbl".dblink_disconnect('other');
select t1060.check((select count(*) from t1060.sent where run = 'other') = 4, 'a run sends each reminder that''s due');
select t1060.check((select count(*) from t1060.sent where run = 'this') = 0, 'and a run at the same time doesn''t send them again');
set role service_role;
insert into t1060.sent select 'again', document_id, alert, remind_sub from public.emit_sub_document_alerts(true, true);
reset role;
select t1060.check((select count(*) from t1060.sent where run = 'again') = 0, 'nor does the next one');
select t1060.check((select array_agg(s.name || ':' || d.kind || '=' || t.alert || ':' || t.remind_sub order by s.name, d.kind) from t1060.sent t
  join public.sub_documents d on d.id = t.document_id join public.subcontractors s on s.id = d.subcontractor_id where s.company_id = :'co')
  = '{"Apex Roofing LLC:liability=d30:true","Cedar Siding:liability=expired:false","Cedar Siding:workers_comp=expired:false"}',
  'Apex at 30 days, Cedar on the day each ends (or after); only subs with an email or phone are reminded themselves');
select t1060.check((select count(*) from public.notifications where kind = 'subs' and company_id = :'co') = 12, 'the office hears about each one: four people, three certificates');
select t1060.check((select count(*) from public.notifications where kind = 'subs' and company_id = :'co'
  and user_id in ('c1060000-0000-0000-0000-000000000004', 'c1060000-0000-0000-0000-000000000005', 'c1060000-0000-0000-0000-000000000006', 'c1060000-0000-0000-0000-000000000007')) = 0,
  'not people without the subs area');
select t1060.check((select title = 'Apex Roofing LLC''s liability insurance ends in 30 days'
  and body = format('It ends %s. We''re sending them a link to send in a new one.', to_char(private.company_today(:'co') + 30, 'Mon FMDD, YYYY'))
  and link = '/subs/' || :'apex' from public.notifications where user_id = 'c1060000-0000-0000-0000-000000000003' and title like 'Apex%'), 'saying when it ends, and that the sub is being asked for a new one');
select t1060.check((select count(*) = 2 from public.notifications where user_id = 'c1060000-0000-0000-0000-000000000003' and title in
  ('Cedar Siding''s liability insurance has run out', 'Cedar Siding''s workers'' comp certificate ends today')), 'or that it has run out, or ends today');
select t1060.check((select body = format('It ends %s.', to_char(private.company_today(:'co'), 'Mon FMDD, YYYY')) from public.notifications
  where user_id = 'c1060000-0000-0000-0000-000000000003' and title like 'Cedar%today'), 'without promising a reminder to a sub Crewtavo can''t reach');
select t1060.check((select alert = 'd30' and remind_sub from t1060.sent t join public.sub_documents d on d.id = t.document_id
  where d.subcontractor_id = :'valley'), 'Victor''s sub is reminded by Victor''s today, by text');
select t1060.check((select array_agg(user_id::text || ': ' || title) from public.notifications where company_id = :'other')
  = array['c1060000-0000-0000-0000-000000000008: Valley Sealcoat''s liability insurance ends in 8 days'],
  'and Victor hears about it, not Uniform''s office');
select t1060.check(not exists (select 1 from t1060.sent t join public.sub_documents d on d.id = t.document_id where d.company_id = :'kilo')
  and not exists (select 1 from public.notifications where company_id = :'kilo' and kind = 'subs'),
  'nothing goes out before 8 in the morning, the company''s time');
select t1060.check((select alerted_state is null from public.sub_documents where company_id = :'kilo'), 'it waits for the morning');

-- Getting closer: Apex's certificate comes due again at 7 days, once.
update public.sub_documents set expires_on = private.company_today(:'co') + 6 where id = :'apex_gl';
set role service_role;
select t1060.check((select array_agg(alert) from public.emit_sub_document_alerts(true, true)) = '{d7}', 'a certificate that gets closer reminds at 7 days');
select t1060.check((select count(*) from public.emit_sub_document_alerts(true, true)) = 0, 'once');
reset role;
-- A new end date further out only reminds again for what's still to come.
update public.sub_documents set expires_on = private.company_today(:'co') + 20 where id = :'apex_gl';
select t1060.check((select alerted_state = 'd30' from public.sub_documents where id = :'apex_gl'), 'moving the end date out takes back the reminders it hasn''t reached');
update public.sub_documents set expires_on = private.company_today(:'co') + 19 where id = :'apex_gl';
select t1060.check((select alerted_state = 'd30' from public.sub_documents where id = :'apex_gl'), 'and fixing a date by a day doesn''t send the same one again');
update public.sub_documents set expires_on = private.company_today(:'co') + 100 where id = :'apex_gl';
select t1060.check((select alerted_state is null from public.sub_documents where id = :'apex_gl'), 'a renewed date starts over');

-- The sub sends the new certificate. Until the office checks it, the one on file still counts and
-- reminds the office, but the sub isn't asked again.
update public.sub_documents set expires_on = private.company_today(:'co') + 5 where id = :'apex_gl';
delete from public.notifications;
set role service_role;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on, uploaded_via)
values (:'co', :'apex', 'liability', :'co' || '/subs/' || :'apex' || '/coi-renewed.pdf', private.company_today(:'co') + 365, 'link') returning id as apex_renewed \gset
reset role;
select t1060.check((select superseded_at is null from public.sub_documents where id = :'apex_gl'), 'what a sub sends doesn''t replace a checked certificate');
select t1060.check((select document_id = :'apex_gl' and state = 'expiring' and verified and waiting from public.sub_paperwork where subcontractor_id = :'apex' and requirement = 'liability'),
  'the checked one keeps counting, and the new one waits');
set role service_role;
select t1060.check((select array_agg(alert || ':' || remind_sub) from public.emit_sub_document_alerts(true, true)) = '{d7:false}',
  'the office still hears it''s running out, and the sub isn''t asked for what they sent');
reset role;
select t1060.check((select bool_and(body like '%They''ve sent a new one. Have a look and verify it.') from public.notifications where title like 'Apex%ends in 5 days'),
  'the office is told to verify the new one');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.sub_documents set verified_at = now() where id = :'apex_renewed';
commit;
select t1060.check((select superseded_by = :'apex_renewed' from public.sub_documents where id = :'apex_gl'), 'verifying it replaces the old one');
select t1060.check((select document_id = :'apex_renewed' and state = 'ok' and not waiting from public.sub_paperwork where subcontractor_id = :'apex' and requirement = 'liability'),
  'which then counts');
set role service_role;
select t1060.check((select count(*) from public.emit_sub_document_alerts(true, true)) = 0, 'a replaced certificate doesn''t remind');
reset role;

-- The sub is only promised a link when the server can send one: a text needs texting set up, an
-- email the server's email or the company's own mailbox.
insert into public.subcontractors (company_id, name, phone) values (:'co', 'Hotel Hauling', '+15405550177') returning id as hotel \gset
insert into public.subcontractors (company_id, name, email) values (:'co', 'India Insulation', 'ii@insulation.test') returning id as india \gset
set role service_role;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on) values
  (:'co', :'hotel', 'liability', :'co' || '/subs/' || :'hotel' || '/gl.pdf', private.company_today(:'co') + 20),
  (:'co', :'india', 'liability', :'co' || '/subs/' || :'india' || '/gl.pdf', private.company_today(:'co') + 20);
select t1060.check((select array_agg(subcontractor_id::text || ':' || remind_sub order by subcontractor_id) from public.emit_sub_document_alerts())
  = (select array_agg(id::text || ':false' order by id) from public.subcontractors where id in (:'hotel', :'india')), 'with no way to text or email, no sub is promised a link');
reset role;
select t1060.check((select count(*) = 8 and bool_and(body not like '%link%') from public.notifications where title like 'Hotel%' or title like 'India%'), 'and the office isn''t told one is coming');
update public.sub_documents set expires_on = private.company_today(:'co') + 6 where subcontractor_id in (:'hotel', :'india');
insert into public.integrations (company_id, provider, status) values (:'co', 'email', 'connected');
set role service_role;
select t1060.check((select array_agg(subcontractor_id::text || ':' || remind_sub order by subcontractor_id) from public.emit_sub_document_alerts())
  = (select array_agg(id::text || ':' || (id = :'india') order by id) from public.subcontractors where id in (:'hotel', :'india')), 'the company''s own mailbox reaches a sub with an email');
reset role;
delete from public.integrations where company_id = :'co' and provider = 'email';

-- The company turns reminders to subs off: the office still hears, the sub doesn't.
select settings - 'subs' as settings_before from public.companies where id = :'co' \gset
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select public.set_sub_reminders(:'co', false);
commit;
select t1060.check((select settings -> 'subs' = '{"remind_subs": false}' from public.companies where id = :'co'), 'the office turns off reminders to subs');
select t1060.check((select settings - 'subs' = :'settings_before'::jsonb from public.companies where id = :'co'), 'and nothing else in the company''s settings changes');
update public.sub_documents set expires_on = private.company_today(:'co') + 10 where id = :'blue_gl';
delete from public.notifications;
set role service_role;
select t1060.check((select bool_and(not remind_sub) and count(*) = 1 from public.emit_sub_document_alerts(true, true)), 'then subs aren''t reminded');
reset role;
select t1060.check((select count(*) = 4 and bool_and(body not like '%link%') from public.notifications where kind = 'subs' and company_id = :'co'), 'but the office is, without the promise');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t1060.expect_error(format('select public.set_sub_reminders(%L, true)', :'co'), 'only the office with the subs area changes it');
reset role;
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
select t1060.expect_error(format('select public.set_sub_reminders(%L, true)', :'co'), 'and never another business');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t1060.expect_error('select * from public.emit_sub_document_alerts(true, true)', 'only the server sends reminders');
commit;

-- ===== Workers' comp: a certificate and an exemption replace each other =======================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.subcontractors (company_id, name, email) values (:'co', 'Delta Drywall', 'dd@drywall.test') returning id as delta \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on)
values (:'co', :'delta', 'workers_comp', :'co' || '/subs/' || :'delta' || '/wc.pdf', private.company_today(:'co') + 5) returning id as delta_wc \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path)
values (:'co', :'delta', 'wc_exemption', :'co' || '/subs/' || :'delta' || '/exempt.pdf') returning id as delta_ex \gset
-- And the other way round: a crew that was exempt takes on workers and gets a certificate.
insert into public.subcontractors (company_id, name, email) values (:'co', 'Echo Electric', 'ee@electric.test') returning id as echo \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path)
values (:'co', :'echo', 'wc_exemption', :'co' || '/subs/' || :'echo' || '/exempt.pdf') returning id as echo_ex \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on)
values (:'co', :'echo', 'workers_comp', :'co' || '/subs/' || :'echo' || '/wc.pdf', private.company_today(:'co') + 200) returning id as echo_wc \gset
commit;
select t1060.check((select superseded_by = :'delta_ex' from public.sub_documents where id = :'delta_wc')
  and (select kind = 'wc_exemption' and state = 'ok' from public.sub_paperwork where subcontractor_id = :'delta' and requirement = 'workers_comp'),
  'an exemption replaces a workers'' comp certificate');
set role service_role;
select t1060.check(not exists (select 1 from public.emit_sub_document_alerts(true, true) where subcontractor_id = :'delta'), 'and the certificate stops reminding');
reset role;
select t1060.check((select superseded_by = :'echo_wc' from public.sub_documents where id = :'echo_ex')
  and (select kind = 'workers_comp' and days_left = 200 from public.sub_paperwork where subcontractor_id = :'echo' and requirement = 'workers_comp'),
  'and a certificate replaces an exemption, which has no end date');
select t1060.check((select count(*) from public.sub_documents where subcontractor_id in (:'delta', :'echo') and superseded_at is null) = 2, 'leaving one each on file');

-- ===== What a sub sends waits for the office ==================================================
-- Foxtrot's certificate ends in 6 days and has had its 7-day reminder.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.subcontractors (company_id, name, email) values (:'co', 'Foxtrot Fencing', 'ff@fencing.test') returning id as fox \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on)
values (:'co', :'fox', 'liability', :'co' || '/subs/' || :'fox' || '/gl.pdf', private.company_today(:'co') + 6) returning id as fox_gl \gset
commit;
set role service_role;
select t1060.check((select array_agg(alert) from public.emit_sub_document_alerts(true, true) where subcontractor_id = :'fox') = '{d7}', 'Foxtrot is reminded at 7 days');
reset role;
-- The office files a clearer scan of the same certificate.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on)
values (:'co', :'fox', 'liability', :'co' || '/subs/' || :'fox' || '/gl-scan.pdf', private.company_today(:'co') + 6) returning id as fox_scan \gset
commit;
select t1060.check((select superseded_by = :'fox_scan' from public.sub_documents where id = :'fox_gl') and (select alerted_state = 'd7' from public.sub_documents where id = :'fox_scan'),
  'the same certificate filed again keeps the reminders already sent');
set role service_role;
select t1060.check(not exists (select 1 from public.emit_sub_document_alerts(true, true) where subcontractor_id = :'fox'), 'so it doesn''t remind again');
-- The sub sends it too, then one with a date far off. Neither hides the one on file.
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on, uploaded_via)
values (:'co', :'fox', 'liability', :'co' || '/subs/' || :'fox' || '/sent.pdf', private.company_today(:'co') + 6, 'link') returning id as fox_sent \gset
select t1060.check(not exists (select 1 from public.emit_sub_document_alerts(true, true) where subcontractor_id = :'fox'), 'nor does the same one sent by the sub');
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on, uploaded_via)
values (:'co', :'fox', 'liability', :'co' || '/subs/' || :'fox' || '/far.pdf', '9999-12-31', 'link') returning id as fox_far \gset
select t1060.expect_error(format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, uploaded_via) values (%L, %L, %L, %L, %L)',
  :'co', :'fox', 'liability', :'co' || '/subs/' || :'fox' || '/undated.pdf', 'link'), 'a certificate a sub sends has an end date');
reset role;
select t1060.check((select superseded_by = :'fox_far' from public.sub_documents where id = :'fox_sent'), 'the sub''s newer upload replaces the one they sent before');
select t1060.check((select document_id = :'fox_scan' and state = 'expiring' and days_left = 6 and verified and waiting from public.sub_paperwork where subcontractor_id = :'fox' and requirement = 'liability'),
  'and the office''s certificate still shows when it really ends');
-- The office deletes the far-off one, and verifies the one before it.
delete from public.sub_documents where id = :'fox_far';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.sub_documents set verified_at = now() where id = :'fox_sent';
commit;
select t1060.check((select superseded_by = :'fox_sent' from public.sub_documents where id = :'fox_scan') and (select alerted_state = 'd7' from public.sub_documents where id = :'fox_sent'),
  'verifying the same certificate keeps the reminders already sent');
set role service_role;
select t1060.check(not exists (select 1 from public.emit_sub_document_alerts(true, true) where subcontractor_id = :'fox'), 'so it doesn''t remind again either');
reset role;

-- Golf's sub sends a certificate that ends before the office's. It waits to be verified where the
-- office will see it, and verifying it files it as the older one.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.subcontractors (company_id, name) values (:'co', 'Golf Gutters') returning id as golf \gset
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on)
values (:'co', :'golf', 'liability', :'co' || '/subs/' || :'golf' || '/gl.pdf', private.company_today(:'co') + 200) returning id as golf_gl \gset
commit;
delete from public.notifications;
set role service_role;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, expires_on, uploaded_via)
values (:'co', :'golf', 'liability', :'co' || '/subs/' || :'golf' || '/sent.pdf', private.company_today(:'co') + 100, 'link') returning id as golf_sent \gset
reset role;
select t1060.check((select superseded_at is null and verified_at is null from public.sub_documents where id = :'golf_sent')
  and (select document_id = :'golf_gl' and waiting from public.sub_paperwork where subcontractor_id = :'golf' and requirement = 'liability'),
  'an older certificate a sub sends waits to be verified, not filed away');
select t1060.check((select count(*) = 4 and bool_and(title = 'Golf Gutters sent their liability insurance' and body = 'Have a look and verify it.') from public.notifications where company_id = :'co'),
  'and the office is asked to verify it');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.sub_documents set verified_at = now() where id = :'golf_sent';
commit;
select t1060.check((select superseded_by = :'golf_gl' from public.sub_documents where id = :'golf_sent') and (select superseded_at is null from public.sub_documents where id = :'golf_gl'),
  'verified, it''s the older one, kept for the record');

-- Two sent at the same moment: the second waits for the first, then replaces it.
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
select pid as other_pid from :"dbl".dblink('other', 'select pg_backend_pid()') as t(pid integer) \gset
begin;
set local role service_role;
insert into public.sub_documents (company_id, subcontractor_id, kind, path, uploaded_via)
values (:'co', :'golf', 'w9', :'co' || '/subs/' || :'golf' || '/w9-a.pdf', 'link');
select :"dbl".dblink_send_query('other', format('insert into public.sub_documents (company_id, subcontractor_id, kind, path, uploaded_via) values (%L, %L, %L, %L, %L)',
  :'co', :'golf', 'w9', :'co' || '/subs/' || :'golf' || '/w9-b.pdf', 'link'));
reset role;
select t1060.check(t1060.waiting_on_me(:other_pid), 'the second one waits for the first');
commit;
select count(*) from :"dbl".dblink_get_result('other') as t(status text);
select count(*) from :"dbl".dblink_get_result('other') as t(status text);
select :"dbl".dblink_disconnect('other');
select t1060.check((select array_agg(path order by path) from public.sub_documents where subcontractor_id = :'golf' and kind = 'w9' and superseded_at is null)
  = array[:'co' || '/subs/' || :'golf' || '/w9-b.pdf'], 'only one of them stays current');

-- ===== Files in a sub's folder: removing them =================================================
insert into storage.objects (bucket_id, name, owner) values ('files', :'co' || '/subs/' || :'apex' || '/server.pdf', null);
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
update storage.objects set owner = 'c1060000-0000-0000-0000-000000000004' where name like '%/subs/%';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c1060000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update storage.objects set owner = 'c1060000-0000-0000-0000-000000000003' where name like '%/subs/%';
delete from storage.objects where name in (:'co' || '/subs/' || :'blue' || '/dina.pdf', :'co' || '/subs/' || :'apex' || '/server.pdf');
commit;
select t1060.check((select count(*) from storage.objects where name in (:'co' || '/subs/' || :'blue' || '/dina.pdf', :'co' || '/subs/' || :'apex' || '/server.pdf')) = 2,
  'nobody signed in removes a file in a sub''s folder, not even the office with the subs area (paperwork taken out goes in the Trash)');
select t1060.check((select owner = 'c1060000-0000-0000-0000-000000000001' from storage.objects where name = :'co' || '/subs/' || :'apex' || '/w9.pdf'), 'and no one changes one in place');

-- ===== Notification settings ===================================================================
select t1060.check((select column_default like '%subs%' from information_schema.columns where table_name = 'notification_prefs' and column_name = 'push'), 'sub reminders come by push unless turned off');
insert into public.notification_prefs (company_id, user_id, email, sms, push) values (:'co', 'c1060000-0000-0000-0000-000000000003', '{subs}', '{subs}', '{subs}');
select t1060.check(true, 'and can come by email and text too');

-- A sub that's removed takes its paperwork with it.
select count(*) as cedar_docs from public.sub_documents where subcontractor_id = :'cedar' \gset
delete from public.subcontractors where id = :'cedar';
select t1060.check((select count(*) from public.sub_documents where subcontractor_id = :'cedar') = 0, 'removing a sub removes its paperwork');
select t1060.check((select count(*) from public.trashed_files where source = 'sub_document' and source_id = :'cedar') = :cedar_docs and :cedar_docs > 0,
  'and its files go in the Trash');
