-- Database tests for storage limits (20261028000400_storage_limits.sql): the company's limit is the
-- default, none or its own, chosen by owners and admins who manage settings, and nobody signed in
-- changes it any other way; owners set limits for people and roles, a person's own winning over
-- their role's and a custom role's over its access level's, and owners are never limited; what's used
-- counts the Trash for the company but not for the person, and a plan file the server stored counts
-- for whoever added it; owners and admins see who and what uses it; the gateway's check is the
-- server's alone; subs and other businesses see nothing.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tsl;
grant usage on schema tsl to authenticated, service_role;
create function tsl.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tsl.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
-- Signs in as someone, for the rest of the transaction.
create function tsl.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- Who uses what, in a line: "name used limit source, ...".
create function tsl.people(p jsonb) returns text language sql as $$
  select string_agg(concat_ws(' ', e ->> 'name', e ->> 'used_bytes', coalesce(e ->> 'limit_bytes', '-'), coalesce(e ->> 'limit_source', '-')), ', ' order by n)
  from jsonb_array_elements(p) with ordinality as x(e, n)
$$;
-- Each area's bytes, in a line: "plans 6000, kb 700, ...".
create function tsl.areas(p jsonb) returns text language sql as $$
  select string_agg((e ->> 'area') || ' ' || (e ->> 'bytes'), ', ' order by n) from jsonb_array_elements(p) with ordinality as x(e, n)
$$;
-- The gateway's check, in a line: "company used/limit, user used/limit, owner or not".
create function tsl.snapshot(p_company uuid, p_user uuid) returns text language sql as $$
  select concat_ws(' ', s.company_used || '/' || coalesce(s.company_limit::text, '-'), s.user_used || '/' || coalesce(s.user_limit::text, '-'),
    case when s.user_is_owner then 'owner' else 'not owner' end)
  from public.storage_snapshot(p_company, p_user) s
$$;
-- The overview's Trash and total, "trash of used", or 'too slow' when it runs out of time.
create function tsl.overview_in_time(p_company uuid) returns text language plpgsql as $$
declare
  v jsonb;
begin
  v := public.storage_overview(p_company);
  return (v ->> 'trash_bytes') || ' of ' || (v ->> 'used_bytes');
exception when query_canceled then
  return 'too slow';
end $$;
grant execute on all functions in schema tsl to authenticated, service_role;

\set ann '5e000000-0000-0000-0000-000000000001'
\set ada '5e000000-0000-0000-0000-000000000002'
\set gus '5e000000-0000-0000-0000-000000000003'
\set ola '5e000000-0000-0000-0000-000000000004'
\set eve '5e000000-0000-0000-0000-000000000005'
\set lou '5e000000-0000-0000-0000-000000000006'
\set cy '5e000000-0000-0000-0000-000000000007'
\set sal '5e000000-0000-0000-0000-000000000008'
\set fay '5e000000-0000-0000-0000-000000000009'
\set oz '5e000000-0000-0000-0000-00000000000a'
\set kim '5e000000-0000-0000-0000-00000000000b'

-- Ann owns Summit Roofing; Ada is an admin, Gus an admin whose Bookkeeper role doesn't manage
-- settings; Ola is office, Eve an estimator, Lou a crew lead in a Roof boss role, Cy and Kim field
-- crew; Fay was field crew and isn't any more; Sal signs in for a sub. Oz owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'ann', 'ann@summit.test', '{"full_name": "Ann Owner"}'),
  (:'ada', 'ada@summit.test', '{"full_name": "Ada Admin"}'),
  (:'gus', 'gus@summit.test', '{"full_name": "Gus Books"}'),
  (:'ola', 'ola@summit.test', '{"full_name": "Ola Office"}'),
  (:'eve', 'eve@summit.test', '{"full_name": "Eve Estimator"}'),
  (:'lou', 'lou@summit.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@summit.test', '{"full_name": "Cy Crew"}'),
  (:'sal', 'sub-sal@subs.invalid', '{"full_name": "Sal Siding"}'),
  (:'fay', 'fay@summit.test', '{"full_name": "Fay Former"}'),
  (:'oz', 'oz@other.test', '{"full_name": "Oz Other"}'),
  (:'kim', 'kim@summit.test', '{"full_name": "Kim Crew"}');
update auth.users set raw_app_meta_data = '{"crewtavo_sub": "summit:1"}' where id = :'sal';

begin;
set local role authenticated;
select tsl.as_user(:'oz');
select public.create_company('Other Roofing', 'roofing') as other \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'other', 'Their foreman', 'crew_lead', '{schedule}') returning id as their_role \gset
commit;

begin;
set local role authenticated;
select tsl.as_user(:'ann');
select public.create_company('Summit Roofing', 'roofing') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports}') returning id as keeper \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Roof boss', 'crew_lead', '{schedule}') returning id as foreman \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.memberships (company_id, user_id, role) values
  (:'co', :'ada', 'admin'), (:'co', :'ola', 'office'), (:'co', :'eve', 'estimator'), (:'co', :'cy', 'field_crew'), (:'co', :'kim', 'field_crew');
set local role authenticated;
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'gus', 'admin', :'keeper'), (:'co', :'lou', 'crew_lead', :'foreman');
insert into public.memberships (company_id, user_id, role, active) values (:'co', :'fay', 'field_crew', false);
insert into public.clients (company_id, display_name) values (:'co', 'Ann Client') returning id as c1 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'c1', '14 Oak St') returning id as p1 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'c1', :'p1', 'New roof') returning id as j1 \gset
insert into public.subcontractors (company_id, name) values (:'co', 'Sal''s Siding') returning id as sub \gset
commit;
-- Sal's sign-in, as the server makes it.
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', :'sub');

-- The stored files (as Storage records them, with their size once stored).
\set plan_a :co '/plans/5e000000-0000-0000-0000-0000000000a1.pdf'
\set plan_b :co '/plans/5e000000-0000-0000-0000-0000000000a2.pdf'
\set imported :co '/plans/5e000000-0000-0000-0000-0000000000a3.pdf'
\set receipt :co '/receipts/5e000000-0000-0000-0000-0000000000a6.jpg'
insert into storage.objects (bucket_id, name, owner, metadata) values
  ('files', :'plan_a', :'ola', '{"size": 1000, "mimetype": "application/pdf"}'),
  ('files', :'plan_b', :'ola', '{"size": 300}'),
  -- A Google Drive import: the server stores it, and Eve adds it.
  ('files', :'imported', null, '{"size": 5000}'),
  ('files', :'co' || '/logo/5e000000-0000-0000-0000-0000000000a4.png', null, '{"size": 200}'),
  ('files', :'co' || '/visit/5e000000-0000-0000-0000-0000000000f1/5e000000-0000-0000-0000-0000000000a5.jpg', :'cy', '{"size": 400}'),
  ('files', :'receipt', :'cy', '{"size": 100}'),
  ('files', :'co' || '/kb/5e000000-0000-0000-0000-0000000000a7.jpg', :'lou', '{"size": 700}'),
  ('files', :'co' || '/subs/' || :'sub' || '/5e000000-0000-0000-0000-0000000000a8.pdf', :'sal', '{"size": 250}'),
  ('files', :'co' || '/chat/5e000000-0000-0000-0000-0000000000f2/5e000000-0000-0000-0000-0000000000a9.jpg', :'fay', '{"size": 60}'),
  -- Still on its way: Storage hasn't said how big it is.
  ('files', :'co' || '/plans/5e000000-0000-0000-0000-0000000000aa.pdf', null, null),
  -- Not the company's: another business's, a name that only starts like its folder, another bucket.
  ('files', :'other' || '/plans/5e000000-0000-0000-0000-0000000000b1.pdf', :'oz', '{"size": 9999}'),
  ('files', :'co' || '0/plans/5e000000-0000-0000-0000-0000000000b2.pdf', :'ola', '{"size": 7777}'),
  ('files', :'co' || '_old/plans/5e000000-0000-0000-0000-0000000000b3.pdf', :'ola', '{"size": 7777}');
insert into storage.buckets (id, name) values ('tsl-elsewhere', 'tsl-elsewhere');
insert into storage.objects (bucket_id, name, owner, metadata) values ('tsl-elsewhere', :'co' || '/plans/5e000000-0000-0000-0000-0000000000b4.pdf', :'ola', '{"size": 7777}');
begin;
set local role authenticated;
select tsl.as_user(:'ola');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'Site plan', :'plan_a', 'site.pdf');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'Old sketch', :'plan_b', 'sketch.pdf') returning id as sketch \gset
select public.drive_trash_file(:'sketch');
select tsl.as_user(:'eve');
insert into public.plan_files (company_id, job_id, title, path, file_name) values (:'co', :'j1', 'Spec book', :'imported', 'spec.pdf');
commit;
-- A receipt taken off its expense, in the Trash.
insert into public.trashed_files (company_id, path, source, label) values (:'co', :'receipt', 'receipt', 'Receipt');

\o
\echo 'Storage limits'
\o /dev/null

-- ===== Who calls what ===========================================================================
select tsl.check(has_function_privilege('authenticated', 'public.storage_overview(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.storage_set_limit(uuid, text, bigint)', 'execute')
    and has_function_privilege('authenticated', 'public.storage_set_allowance(uuid, uuid, text, bigint)', 'execute'),
  'the team calls storage_overview, storage_set_limit and storage_set_allowance (each checks who)');
select tsl.check(not has_function_privilege('authenticated', 'public.storage_snapshot(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.storage_set_default(uuid, bigint, text)', 'execute')
    and has_function_privilege('service_role', 'public.storage_snapshot(uuid, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.storage_set_default(uuid, bigint, text)', 'execute'),
  'the gateway''s check and the default are the server''s alone');
select tsl.check(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'storage\_%' and has_function_privilege('anon', p.oid, 'execute')),
  'nobody signed out calls any of them');
begin;
set local role authenticated;
select tsl.as_user(:'ann');
select tsl.check(tsl.error_of(format('select * from public.storage_snapshot(%L, %L)', :'co', :'ann')) like '42501:%', 'not even an owner asks for the gateway''s check');
select tsl.check(tsl.error_of(format('select public.storage_set_default(%L, 1, %L)', :'co', 'Mine')) like '42501:%', 'or sets the default');
rollback;

-- ===== The company's limit ======================================================================
begin;
set local role authenticated;
select tsl.as_user(:'cy');
select public.storage_overview(:'co') as o \gset
rollback;
select tsl.check((:'o'::jsonb ->> 'limit_mode') = 'default' and :'o'::jsonb -> 'limit_bytes' = 'null' and :'o'::jsonb -> 'default_bytes' = 'null'
    and :'o'::jsonb -> 'default_basis' = 'null', 'at first the limit is the default, and with no reading from Railway there''s none');
set role service_role;
select tsl.snapshot(:'co', null) as snap \gset
reset role;
select tsl.check(:'snap' = '8010/- 0/- not owner', 'and the gateway finds no limit: ' || :'snap');

set role service_role;
select public.storage_set_default(:'co', 50000, '  Railway Hobby bucket ');
reset role;
select xmin::text as stamp, settings -> 'storage' as stored from public.companies where id = :'co' \gset
select tsl.check(:'stored'::jsonb = '{"default_bytes": 50000, "default_basis": "Railway Hobby bucket"}', 'the server sets the default, and why: ' || :'stored');
set role service_role;
select public.storage_set_default(:'co', 50000, 'Railway Hobby bucket');
reset role;
select tsl.check((select xmin::text = :'stamp' from public.companies where id = :'co'), 'the same default again changes nothing');
set role service_role;
select tsl.check(tsl.error_of(format('select public.storage_set_default(%L, 0, %L)', :'co', 'Nothing')) like '22023:%', 'a default is more than 0 bytes');
select tsl.snapshot(:'co', null) as snap \gset
reset role;
select tsl.check(:'snap' = '8010/50000 0/- not owner', 'the default is the limit until the company picks another: ' || :'snap');

begin;
set local role authenticated;
select tsl.as_user(:'ola');
select tsl.check(tsl.error_of(format('select public.storage_set_limit(%L, %L, 6000)', :'co', 'custom'))
  = '42501: Only owners and admins who manage settings can change the storage limit.', 'office staff can''t change the limit');
select tsl.as_user(:'gus');
select tsl.check(tsl.error_of(format('select public.storage_set_limit(%L, %L, 6000)', :'co', 'custom')) like '42501:%', 'nor an admin whose role doesn''t manage settings');
select tsl.as_user(:'sal');
select tsl.check(tsl.error_of(format('select public.storage_set_limit(%L, %L)', :'co', 'none')) like '42501:%', 'nor a sub');
select tsl.as_user(:'oz');
select tsl.check(tsl.error_of(format('select public.storage_set_limit(%L, %L)', :'co', 'none')) like '42501:%', 'nor another business''s owner');
select tsl.as_user(:'ada');
select tsl.check(tsl.error_of(format('select public.storage_set_limit(%L, %L)', :'co', 'custom')) like '22023: A limit of your own needs a size%', 'a limit of their own needs a size');
select tsl.check(tsl.error_of(format('select public.storage_set_limit(%L, %L, 0)', :'co', 'custom')) like '22023:%', 'of more than 0');
select tsl.check(tsl.error_of(format('select public.storage_set_limit(%L, %L, 20000000000000000)', :'co', 'custom')) = '22023: A limit can be 10,000,000 GB at most.', 'and not absurdly big');
select tsl.check(tsl.error_of(format('select public.storage_set_limit(%L, %L)', :'co', 'lots')) = '22023: Choose the default limit, no limit, or a limit of your own.', 'the choice is one of three');
select public.storage_set_limit(:'co', 'custom', 6000) as stored \gset
select tsl.check((:'stored'::jsonb ->> 'limit_bytes')::bigint = 6000 and :'stored'::jsonb ->> 'changed_by' = :'ada' and :'stored'::jsonb ? 'changed_at'
    and (:'stored'::jsonb ->> 'default_bytes')::bigint = 50000, 'an admin who manages settings sets a limit of the company''s own, with who and when, and the default stays');
select tsl.check((select (public.storage_overview(:'co') ->> 'limit_mode') = 'custom' and (public.storage_overview(:'co') ->> 'limit_bytes')::bigint = 6000),
  'the overview shows it');
commit;
set role service_role;
select tsl.snapshot(:'co', null) as snap \gset
reset role;
select tsl.check(:'snap' = '8010/6000 0/- not owner', 'and the gateway holds the company to it: ' || :'snap');

begin;
set local role authenticated;
select tsl.as_user(:'ann');
select public.storage_set_limit(:'co', 'none', 123) as stored \gset
select tsl.check(:'stored'::jsonb -> 'limit_bytes' = 'null' and :'stored'::jsonb ->> 'changed_by' = :'ann', 'the owner takes the limit off (a size with it means nothing)');
select tsl.check((select (public.storage_overview(:'co') ->> 'limit_mode') = 'none' and public.storage_overview(:'co') -> 'limit_bytes' = 'null'), 'no limit, whatever the default');
commit;
set role service_role;
select tsl.snapshot(:'co', null) as snap \gset
reset role;
select tsl.check(:'snap' = '8010/- 0/- not owner', 'and the gateway finds none: ' || :'snap');

begin;
set local role authenticated;
select tsl.as_user(:'ann');
select public.storage_set_limit(:'co', 'default') as stored \gset
select tsl.check(not (:'stored'::jsonb ? 'limit_bytes') and (public.storage_overview(:'co') ->> 'limit_bytes')::bigint = 50000
    and public.storage_overview(:'co') ->> 'limit_mode' = 'default', 'and goes back to the default');
-- A page saving other settings, with what it read before, or trying to set the limit itself.
update public.companies set settings = settings || '{"maps": {"style": "satellite"}}' || '{"storage": {"limit_bytes": 1}}' where id = :'co';
select tsl.check((select settings -> 'maps' ->> 'style' = 'satellite' and settings -> 'storage' = :'stored'::jsonb from public.companies where id = :'co'),
  'the company''s other settings save, and the limit stays as it was when someone signed in writes it');
update public.companies set settings = settings - 'storage' where id = :'co';
select tsl.check((select settings -> 'storage' = :'stored'::jsonb from public.companies where id = :'co'), 'or leaves it out');
commit;
begin;
select set_config('request.jwt.claims', '', true);
update public.companies set settings = jsonb_set(settings, '{storage}', settings -> 'storage' || '{"warned": {"80": "2026-10-28T12:00:00Z"}, "limit_bytes": 7}') where id = :'co';
select tsl.check((select settings -> 'storage' -> 'warned' ->> '80' = '2026-10-28T12:00:00Z' and not (settings -> 'storage' ? 'limit_bytes') from public.companies where id = :'co'),
  'the server notes its warnings, but doesn''t change the limit itself');
update public.companies set settings = settings - 'storage' where id = :'co';
select tsl.check((select settings -> 'storage' ->> 'changed_by' = :'ann' and not (settings -> 'storage' ? 'default_bytes') from public.companies where id = :'co'),
  'and when it leaves settings.storage out, who chose the limit stays');
rollback;

-- ===== Limits for people and roles ==============================================================
begin;
set local role authenticated;
select tsl.as_user(:'ada');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, %L, null, 1000)', :'co', :'cy'))
  = '42501: Only owners can set storage limits for people and roles.', 'an admin can''t set a limit for a person');
select tsl.as_user(:'oz');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, null, %L, 1000)', :'co', 'office')) like '42501:%', 'nor another business''s owner for a role');
select tsl.as_user(:'ann');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, null, null, 1000)', :'co')) = '22023: Choose one person or one role.', 'a limit is for a person or a role');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, %L, %L, 1000)', :'co', :'cy', 'office')) = '22023: Choose one person or one role.', 'not both');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, %L, null, 1000)', :'co', :'ann')) = '22023: Owners aren''t limited.', 'owners aren''t limited');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, null, %L, 1000)', :'co', 'owner')) = '22023: Owners aren''t limited.', 'nor is the Owner level');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, %L, null, 1000)', :'co', :'sal')) like '22023: Subcontractors aren''t limited%', 'nor a sub');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, null, %L, 1000)', :'co', 'subcontractor')) = '22023: That role wasn''t found.', 'nor the Subcontractor level');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, %L, null, 1000)', :'co', :'oz')) = '22023: That person isn''t on your team.', 'a person on the team');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, null, %L, 1000)', :'co', :'their_role')) = '22023: That role wasn''t found.', 'a role of the company''s');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, null, %L, 1000)', :'co', gen_random_uuid())) = '22023: That role wasn''t found.', 'that''s there');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, null, %L, 1000)', :'co', 'boss')) = '22023: That role wasn''t found.', 'or an access level');
select tsl.check(tsl.error_of(format('select public.storage_set_allowance(%L, %L, null, 0)', :'co', :'cy')) like '22023: A limit needs a size of more than 0 GB%', 'a limit is more than 0');
select public.storage_set_allowance(:'co', null, 'field_crew', 1000);
select public.storage_set_allowance(:'co', null, 'field_crew', 2000);
select public.storage_set_allowance(:'co', null, 'crew_lead', 5000);
select public.storage_set_allowance(:'co', null, upper(:'foreman'), 800);
select public.storage_set_allowance(:'co', null, ' office ', 1500);
select public.storage_set_allowance(:'co', null, 'estimator', 100);
select public.storage_set_allowance(:'co', :'cy', null, 3000);
select public.storage_set_allowance(:'co', :'ada', null, 999);
select public.storage_set_allowance(:'co', :'kim', null, 4000);
select tsl.check((select count(*) = 1 and min(limit_bytes) = 2000 and min(created_by::text) = :'ann' from public.storage_allowances where role_key = 'field_crew'),
  'the owner sets a limit for an access level, and setting it again changes it');
select tsl.check((select count(*) = 1 from public.storage_allowances where role_key = :'foreman' and limit_bytes = 800), 'and for a custom role, however its id is written');
select public.storage_set_allowance(:'co', null, 'estimator', null);
select tsl.check(not exists (select 1 from public.storage_allowances where role_key = 'estimator'), 'no limit takes it off');
select tsl.check((select count(*) from public.storage_allowances) = 7, 'owners see every limit');
select tsl.check(tsl.error_of(format('insert into public.storage_allowances (company_id, role_key, limit_bytes) values (%L, %L, 1)', :'co', 'admin')) like '42501:%',
  'and change them only through storage_set_allowance');
select tsl.check(tsl.error_of(format('update public.storage_allowances set limit_bytes = 1 where company_id = %L', :'co')) like '42501:%', 'not by hand');
select tsl.as_user(:'ada');
select tsl.check((select count(*) from public.storage_allowances) = 7, 'admins see them too');
select tsl.as_user(:'ola');
select tsl.check((select count(*) from public.storage_allowances) = 0, 'office staff don''t');
select tsl.as_user(:'cy');
select tsl.check((select count(*) from public.storage_allowances) = 0, 'nor the crew, even their own');
select tsl.as_user(:'sal');
select tsl.check((select count(*) from public.storage_allowances) = 0, 'nor a sub');
select tsl.as_user(:'oz');
select tsl.check((select count(*) from public.storage_allowances) = 0, 'nor another business''s owner');
commit;

-- ===== What's used ==============================================================================
begin;
set local role authenticated;
select tsl.as_user(:'cy');
select public.storage_overview(:'co') as o \gset
rollback;
select tsl.check((:'o'::jsonb ->> 'used_bytes')::bigint = 8010 and (:'o'::jsonb ->> 'trash_bytes')::bigint = 400 and (:'o'::jsonb ->> 'files')::int = 10,
  'the company''s total counts every stored file in its folder, the Trash''s too, and nothing outside it: ' || (:'o'::jsonb - 'me')::text);
select tsl.check(:'o'::jsonb -> 'me' = '{"used_bytes": 400, "limit_bytes": 3000, "limit_source": "person"}',
  'the crew see their own use (not their receipt in the Trash) and their own limit, which wins over their role''s: ' || (:'o'::jsonb -> 'me')::text);
select tsl.check(not (:'o'::jsonb ?| array['by_person', 'by_area', 'roles']), 'but not who else uses what');
select tsl.check((:'o'::jsonb ->> 'limit_mode') = 'default' and (:'o'::jsonb ->> 'limit_bytes')::bigint = 50000 and (:'o'::jsonb ->> 'default_bytes')::bigint = 50000
  and :'o'::jsonb ->> 'default_basis' = 'Railway Hobby bucket', 'and see the limit, and where the default comes from');

begin;
set local role authenticated;
select tsl.as_user(:'lou');
select tsl.check(public.storage_overview(:'co') -> 'me' = '{"used_bytes": 700, "limit_bytes": 800, "limit_source": "role"}', 'a custom role''s limit wins over its access level''s');
select tsl.as_user(:'eve');
select tsl.check(public.storage_overview(:'co') -> 'me' = '{"used_bytes": 5000, "limit_bytes": null, "limit_source": null}',
  'a plan file the server stored counts for whoever added it, and with no limit set there''s none');
select tsl.as_user(:'ola');
select tsl.check(public.storage_overview(:'co') -> 'me' = '{"used_bytes": 1000, "limit_bytes": 1500, "limit_source": "role"}',
  'what''s in the Trash doesn''t count for the person who uploaded it');
select tsl.as_user(:'ann');
select public.storage_overview(:'co') as o \gset
select tsl.as_user(:'sal');
select tsl.check(tsl.error_of(format('select public.storage_overview(%L)', :'co')) = '42501: Only the team can see how much storage is used.', 'a sub sees nothing');
select tsl.as_user(:'fay');
select tsl.check(tsl.error_of(format('select public.storage_overview(%L)', :'co')) like '42501:%', 'nor someone no longer on the team');
select tsl.as_user(:'oz');
select tsl.check(tsl.error_of(format('select public.storage_overview(%L)', :'co')) like '42501:%', 'nor another business''s owner');
select tsl.check((public.storage_overview(:'other') ->> 'used_bytes')::bigint = 9999, 'who sees their own');
rollback;
select tsl.check(:'o'::jsonb -> 'me' = '{"used_bytes": 0, "limit_bytes": null, "limit_source": null}', 'owners are never limited');
select tsl.check(tsl.people(:'o'::jsonb -> 'by_person') = 'Eve Estimator 5000 - -, Ola Office 1000 1500 role, Lou Lead 700 800 role, Cy Crew 400 3000 person, '
    || 'Sal Siding 250 - -, Ada Admin 0 999 person, Ann Owner 0 - -, Gus Books 0 - -, Kim Crew 0 4000 person, Fay Former 60 - -, Uploaded by Crewtavo 200 - -',
  'owners and admins see what each person uses and their limit, then those no longer on the team, then what the server stored for nobody: ' || tsl.people(:'o'::jsonb -> 'by_person'));
select tsl.check((select e ->> 'role' = 'crew_lead' and e ->> 'role_name' = 'Roof boss' and e ->> 'user_id' = :'lou' from jsonb_array_elements(:'o'::jsonb -> 'by_person') e where e ->> 'name' = 'Lou Lead')
    and (select e ->> 'role' = 'office' and e ->> 'role_name' = 'Office' from jsonb_array_elements(:'o'::jsonb -> 'by_person') e where e ->> 'name' = 'Ola Office')
    and (select e -> 'role' = 'null' and e -> 'user_id' = 'null' from jsonb_array_elements(:'o'::jsonb -> 'by_person') e where e ->> 'name' = 'Uploaded by Crewtavo')
    and (select e -> 'role' = 'null' and e ->> 'user_id' = :'fay' from jsonb_array_elements(:'o'::jsonb -> 'by_person') e where e ->> 'name' = 'Fay Former'),
  'each with their access level and role''s name; no role for those no longer on the team or for Crewtavo');
select tsl.check(tsl.areas(:'o'::jsonb -> 'by_area') = 'plans 6000, kb 700, trash 400, visit 400, subs 250, logo 200, chat 60',
  'and what each area uses, the Trash on its own: ' || tsl.areas(:'o'::jsonb -> 'by_area'));
select tsl.check((select string_agg(concat_ws(' ', e ->> 'role_key', e ->> 'name', e ->> 'limit_bytes'), ', ' order by n)
    from jsonb_array_elements(:'o'::jsonb -> 'roles') with ordinality as x(e, n))
    = 'office Office 1500, crew_lead Crew lead 5000, field_crew Field crew 2000, ' || :'foreman' || ' Roof boss 800',
  'and the limits set for roles, access levels first');
begin;
set local role authenticated;
select tsl.as_user(:'ada');
select tsl.check(public.storage_overview(:'co') -> 'by_person' = :'o'::jsonb -> 'by_person', 'admins see who uses what too');
rollback;

-- A Trash too big for memory doesn't slow the overview down: its files aren't each compared with
-- every path in the Trash. Here memory is made small, so 10,000 paths don't fit; compared one by
-- one, 20,000 files would take far longer than the 5 seconds allowed.
begin;
create temp table tsl_big as
  select i, :'co' || '/visit/' || gen_random_uuid() || '/' || gen_random_uuid() || '.jpg' as name from generate_series(1, 20000) i;
insert into storage.objects (bucket_id, name, owner, metadata) select 'files', b.name, :'cy', '{"size": 10}' from tsl_big b;
insert into public.trashed_files (company_id, path, source) select :'co', b.name, 'visit_photo' from tsl_big b where b.i <= 10000;
analyze storage.objects;
analyze public.trashed_files;
set local work_mem = '64kB';
set local hash_mem_multiplier = 1;
set local statement_timeout = '5s';
set local role authenticated;
select tsl.as_user(:'ann');
select tsl.overview_in_time(:'co') as big \gset
rollback;
select tsl.check(:'big' = '100400 of 208010', 'a Trash too big for memory doesn''t slow the overview down, and still counts: ' || :'big');

-- ===== The gateway's check ======================================================================
set role service_role;
select tsl.snapshot(:'co', :'cy') as cy_snap, tsl.snapshot(:'co', :'lou') as lou_snap, tsl.snapshot(:'co', :'eve') as eve_snap,
  tsl.snapshot(:'co', :'ola') as ola_snap, tsl.snapshot(:'co', :'ann') as ann_snap, tsl.snapshot(:'co', :'oz') as stranger_snap,
  tsl.snapshot(:'co', :'sal') as sal_snap, tsl.snapshot(:'other', :'oz') as oz_snap, tsl.snapshot(gen_random_uuid(), null) as nowhere_snap,
  (select count(*) from public.storage_snapshot(:'co', :'cy')) as snap_rows \gset
reset role;
select tsl.check(:'cy_snap' = '8010/50000 400/3000 not owner' and :snap_rows = 1, 'the gateway gets the company''s use and limit, and the person''s own: ' || :'cy_snap');
select tsl.check(:'lou_snap' = '8010/50000 700/800 not owner', 'a custom role''s limit: ' || :'lou_snap');
select tsl.check(:'eve_snap' = '8010/50000 5000/- not owner', 'a plan file the server stored for her: ' || :'eve_snap');
select tsl.check(:'ola_snap' = '8010/50000 1000/1500 not owner', 'the Trash not counted for the person: ' || :'ola_snap');
select tsl.check(:'ann_snap' = '8010/50000 0/- owner', 'an owner, never limited: ' || :'ann_snap');
select tsl.check(:'sal_snap' = '8010/50000 250/- not owner', 'a sub, never limited: ' || :'sal_snap');
select tsl.check(:'stranger_snap' = '8010/50000 0/- not owner', 'someone not in the company: ' || :'stranger_snap');
select tsl.check(:'oz_snap' = '9999/- 9999/- owner', 'another business, its own: ' || :'oz_snap');
select tsl.check(:'nowhere_snap' = '0/- 0/- not owner', 'and a company it doesn''t know: ' || :'nowhere_snap');

-- Moving a file to the Trash frees the person's allowance; the company's total keeps it until it's purged.
begin;
set local role authenticated;
select tsl.as_user(:'ola');
select public.drive_trash_file(id) from public.plan_files where path = :'plan_a';
commit;
set role service_role;
select tsl.snapshot(:'co', :'ola') as ola_snap \gset
reset role;
select tsl.check(:'ola_snap' = '8010/50000 0/1500 not owner', 'a file moved to the Trash frees its uploader''s allowance, and still counts for the company: ' || :'ola_snap');

-- An owner is never limited, whatever was set before they became one.
update public.memberships set role = 'owner' where company_id = :'co' and user_id = :'ada';
set role service_role;
select tsl.snapshot(:'co', :'ada') as ada_snap \gset
reset role;
select tsl.check(:'ada_snap' = '8010/50000 0/- owner', 'a person made an owner isn''t limited: ' || :'ada_snap');
update public.memberships set role = 'admin' where company_id = :'co' and user_id = :'ada';
set role service_role;
select tsl.snapshot(:'co', :'ada') as ada_snap \gset
reset role;
select tsl.check(:'ada_snap' = '8010/50000 0/999 not owner', 'and is again once they''re an admin: ' || :'ada_snap');

-- ===== Limits that go =============================================================================
begin;
set local role authenticated;
select tsl.as_user(:'ann');
delete from public.company_roles where id = :'foreman';
commit;
select tsl.check(not exists (select 1 from public.storage_allowances where role_key = :'foreman'), 'a custom role''s limit goes with it');
set role service_role;
select tsl.snapshot(:'co', :'lou') as lou_snap \gset
reset role;
select tsl.check(:'lou_snap' = '8010/50000 700/5000 not owner', 'and those who had it are held to their access level''s: ' || :'lou_snap');
delete from public.memberships where company_id = :'co' and user_id = :'kim';
select tsl.check(not exists (select 1 from public.storage_allowances where user_id = :'kim'), 'a person''s limit goes when they leave the team');
delete from public.companies where id = :'co';
delete from public.companies where id = :'other';
select tsl.check(not exists (select 1 from public.storage_allowances where company_id in (:'co', :'other')), 'and every limit goes with the company');
delete from storage.objects where bucket_id = 'tsl-elsewhere' or name like '%/plans/5e000000-0000-0000-0000-0000000000b_.pdf' or name like :'co' || '/%';
delete from storage.buckets where id = 'tsl-elsewhere';

set client_min_messages = warning;
drop schema tsl cascade;
reset client_min_messages;

\o
\echo 'All storage limits tests passed.'
