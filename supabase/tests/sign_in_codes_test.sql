-- Database tests for signing in with a code by text (20261025005001_sign_in_codes.sql): phone numbers
-- in one spelling; whose number it is (only the number the office keeps for a sub, never a profile's;
-- only an active sign-in Crewtavo made for an active sub, and nobody's sign-in elsewhere; a number on
-- two sign-ins; other countries only where the company adds them, and who can); and the codes
-- themselves: one use, 10 minutes, 5 tries, 15 wrong tries a day, a new one replacing the old, tied
-- to one account, a number with no sign-in answering as a real one does, only the visitor who asked
-- hearing more than "isn't right", two tries at the same moment, the hourly tidy, and nobody but the
-- server reaching any of it. (Codes by email, 20261025006001_email_sign_in_codes.sql, share the
-- table and functions, which since then say which way the code went: 'text' throughout here. They're
-- tested in email_sign_in_codes_test.sql. Since then too, a code for the account under another number
-- is stopped rather than run out, and the account's 15 wrong tries a day stop a code under another
-- number signing in without saying "too many", so nothing shows that two numbers are one account's.)
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t1100;
grant usage on schema t1100 to authenticated, service_role;
create function t1100.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t1100.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- The error a statement raises ("<sqlstate>: <message>"), or 'none'.
create function t1100.error_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'none';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function t1100.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
-- The subs a number, as typed, belongs to the sign-in of (by business name).
create function t1100.found(p_phone text) returns text[] language sql as $$
  select coalesce(array_agg(s.name order by s.name), '{}')
  from public.sub_sign_ins_for_phone(p_phone) f join public.subcontractors s on s.id = f.subcontractor_id
$$;
-- A 64-character stand-in for a keyed hash.
create function t1100.h(p text) returns text language sql immutable as $$ select repeat(p, 64) $$;
-- Whether another connection (p_pid) is waiting on a lock this one holds, given up to 10 seconds to
-- get there. pg_blocking_pids reads the lock table as it is now, inside an open transaction too.
create function t1100.waiting_on_me(p_pid integer) returns boolean language plpgsql as $$
begin
  for i in 1..200 loop
    if pg_blocking_pids(p_pid) @> array[pg_backend_pid()] then return true; end if;
    perform pg_sleep(0.05);
  end loop;
  return false;
end $$;
grant execute on all functions in schema t1100 to authenticated, service_role;
-- Someone signed out tries too.
grant usage on schema t1100 to anon;
grant execute on function t1100.expect_error(text, text) to anon;
-- A second connection, to try the same code at the same moment as this one.
set client_min_messages = warning;
create extension if not exists dblink schema t1100;
reset client_min_messages;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset

\set oz 'd1100000-0000-0000-0000-000000000001'
\set opal 'd1100000-0000-0000-0000-000000000002'
\set dee 'd1100000-0000-0000-0000-000000000003'
\set cy 'd1100000-0000-0000-0000-000000000004'
\set al 'd1100000-0000-0000-0000-000000000005'
\set bo 'd1100000-0000-0000-0000-000000000006'
\set sid 'd1100000-0000-0000-0000-000000000007'
\set pat 'd1100000-0000-0000-0000-000000000008'
\set hal 'd1100000-0000-0000-0000-000000000009'
\set uma 'd1100000-0000-0000-0000-000000000010'
\set dot 'd1100000-0000-0000-0000-000000000011'
\set dan 'd1100000-0000-0000-0000-000000000012'
\set mo 'd1100000-0000-0000-0000-000000000013'
\set ed 'd1100000-0000-0000-0000-000000000014'
\set lee 'd1100000-0000-0000-0000-000000000015'
\set ada 'd1100000-0000-0000-0000-000000000016'
\set apex 'd1100000-0000-0000-0000-0000000000c1'
\set birch 'd1100000-0000-0000-0000-0000000000c2'
\set cedar 'd1100000-0000-0000-0000-0000000000c3'
\set hazel 'd1100000-0000-0000-0000-0000000000c4'
\set union_jack 'd1100000-0000-0000-0000-0000000000c5'
\set dup_one 'd1100000-0000-0000-0000-0000000000c6'
\set dup_two 'd1100000-0000-0000-0000-0000000000c7'
\set moss 'd1100000-0000-0000-0000-0000000000c8'
\set nell 'd1100000-0000-0000-0000-0000000000c9'

-- ===== Phone numbers in one spelling ============================================================
-- The same list as packages/core/test/phone.test.ts, so phoneE164() and the database agree.
select t1100.check((select bool_and(private.phone_e164(typed) is not distinct from e164) from (values
  ('540-555-0101', '+15405550101'), ('(540) 555-0101', '+15405550101'), ('540.555.0101', '+15405550101'), (' 540 555 0101 ', '+15405550101'),
  ('1 540 555 0101', '+15405550101'), ('1-540-555-0101', '+15405550101'), ('+1 (540) 555-0101', '+15405550101'), ('15405550101', '+15405550101'),
  ('Cell: 540-555-0101', '+15405550101'), ('011 1 540 555 0101', '+15405550101'), ('+44 20 7946 0958', '+442079460958'),
  ('0044 20 7946 0958', '+442079460958'), ('011 44 20 7946 0958', '+442079460958'), ('+52 55 1234 5678', '+525512345678'),
  ('+223456789012345', '+223456789012345'),
  ('555-0101', null), ('054-555-0101', null), ('154-555-0101', null), ('25405550101', null), ('540-555-0101 ext 12', null), ('540+5550101', null),
  ('+1 540 555 010', null), ('+0 123 456 789', null), ('+44 1', null), ('+2234567890123456', null), ('+', null), ('', null), (null, null)
) as t(typed, e164)), 'phone numbers come out in one spelling however they''re typed, as phoneE164 has them');

-- ===== Quill Roofing and Papa Paving ============================================================
-- Oz owns Quill; Ada is its admin; Opal is in its office; Dee is in the office without the subs
-- area; Ed is its estimator; Lee leads a crew; Cy is on the crew. Pat owns Papa Paving. Their subs, and the sign-ins the server made for them:
--   Apex Roofing (Al)        a sign-in made here, with his own number on his profile too
--   Birch Gutters (Bo)       a sign-in made here
--   Cedar Siding (Sid)       Sid's own account, given sub access: not made here
--   Hazel Decks (Hal)        made here, but Hal is also on Papa's crew
--   Union Jack Builders (Uma) made here, with a UK number and no email
--   Dup One (Dot), and Papa's Dup Two (Dan)   two sign-ins with the same number
--   Moss Masonry (Mo)        an account marked for Apex, not Moss
--   Nell's Fencing           no sign-in at all
insert into auth.users (id, email, raw_user_meta_data) values
  (:'oz', 'oz@quill.test', '{"full_name": "Oz Owner"}'), (:'opal', 'opal@quill.test', '{"full_name": "Opal Office"}'),
  (:'dee', 'dee@quill.test', '{"full_name": "Dee Dispatcher"}'), (:'cy', 'cy@quill.test', '{"full_name": "Cy Crew"}'),
  (:'al', 'al@apex.test', '{"full_name": "Al Apex"}'), (:'bo', 'bo@birch.test', '{"full_name": "Bo Birch"}'),
  (:'sid', 'sid@shared.test', '{"full_name": "Sid Shared"}'), (:'pat', 'pat@papa.test', '{"full_name": "Pat Papa"}'),
  (:'hal', 'hal@hazel.test', '{"full_name": "Hal Hazel"}'), (:'uma', 'sub-' || :'union_jack' || '@subs.invalid', '{"full_name": "Uma Union"}'),
  (:'dot', 'dot@dup.test', '{"full_name": "Dot Dup"}'), (:'dan', 'dan@dup.test', '{"full_name": "Dan Dup"}'),
  (:'mo', 'mo@moss.test', '{"full_name": "Mo Moss"}'), (:'ed', 'ed@quill.test', '{"full_name": "Ed Estimator"}'),
  (:'lee', 'lee@quill.test', '{"full_name": "Lee Lead"}'), (:'ada', 'ada@quill.test', '{"full_name": "Ada Admin"}');

begin;
set local role authenticated;
select t1100.as_user(:'oz');
select public.create_company('Quill Roofing', 'roofing') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Dispatcher', 'office', '{schedule}') returning id as dispatch_role \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'opal', 'office', null), (:'co', :'dee', 'office', :'dispatch_role'), (:'co', :'cy', 'field_crew', null),
  (:'co', :'ed', 'estimator', null), (:'co', :'lee', 'crew_lead', null), (:'co', :'ada', 'admin', null);
set local role authenticated;
commit;
begin;
set local role authenticated;
select t1100.as_user(:'pat');
select public.create_company('Papa Paving', 'paving') as other \gset
insert into public.subcontractors (id, company_id, name, phone) values (:'dup_two', :'other', 'Dup Two', '+1 540 555 0177');
commit;
begin;
set local role authenticated;
select t1100.as_user(:'opal');
insert into public.subcontractors (id, company_id, name, contact_name, phone, email) values
  (:'apex', :'co', 'Apex Roofing', 'Al Apex', '(540) 555-0101', 'al@apex.test'),
  (:'birch', :'co', 'Birch Gutters', 'Bo Birch', '540.555.0102', 'bo@birch.test'),
  (:'cedar', :'co', 'Cedar Siding', 'Sid Shared', '540-555-0103', 'sid@shared.test'),
  (:'hazel', :'co', 'Hazel Decks', 'Hal Hazel', '540-555-0104', 'hal@hazel.test'),
  (:'union_jack', :'co', 'Union Jack Builders', 'Uma Union', '+44 20 7946 0958', null),
  (:'dup_one', :'co', 'Dup One', 'Dot Dup', '540-555-0177', 'dot@dup.test'),
  (:'moss', :'co', 'Moss Masonry', 'Mo Moss', '540-555-0108', 'mo@moss.test'),
  (:'nell', :'co', 'Nell''s Fencing', 'Nell', '540-555-0109', null);
select public.set_sub_reminders(:'co', false);
commit;

-- The sign-ins, as the server makes them (it has no signed-in person), and the marks it puts on the
-- accounts it makes (services/subAccess.ts). Sid's account is his own.
insert into public.memberships (company_id, user_id, role, subcontractor_id) values
  (:'co', :'al', 'subcontractor', :'apex'), (:'co', :'bo', 'subcontractor', :'birch'), (:'co', :'sid', 'subcontractor', :'cedar'),
  (:'co', :'hal', 'subcontractor', :'hazel'), (:'co', :'uma', 'subcontractor', :'union_jack'), (:'co', :'dot', 'subcontractor', :'dup_one'),
  (:'other', :'dan', 'subcontractor', :'dup_two'), (:'co', :'mo', 'subcontractor', :'moss');
insert into public.memberships (company_id, user_id, role) values (:'other', :'hal', 'field_crew');
update auth.users u set raw_app_meta_data = jsonb_build_object('provider', 'email', 'crewtavo_sub', m.company_id::text || ':' || m.subcontractor_id::text)
from public.memberships m where m.user_id = u.id and m.role = 'subcontractor' and u.id in (:'al', :'bo', :'hal', :'uma', :'dot', :'dan');
update auth.users set raw_app_meta_data = jsonb_build_object('crewtavo_sub', :'co' || ':' || :'apex') where id = :'mo';
-- Numbers people gave themselves, which never count.
update public.profiles set phone = '540-555-0199' where user_id = :'al';
update public.profiles set phone = '540-555-0144' where user_id = :'cy';
update public.profiles set phone = '540-555-0145' where user_id = :'sid';

-- ===== Whose number it is =======================================================================
begin;
set local role service_role;
select t1100.check(t1100.found('(540) 555-0101') = '{Apex Roofing}' and t1100.found('540-555-0101') = '{Apex Roofing}'
  and t1100.found('+1 540 555 0101') = '{Apex Roofing}' and t1100.found('15405550101') = '{Apex Roofing}',
  'Al''s number finds Apex''s sign-in, however it''s typed and however the office wrote it');
select t1100.check((select row(user_id, company_id, subcontractor_id, company_name)::text from public.sub_sign_ins_for_phone('540-555-0101'))
  = row(:'al'::uuid, :'co'::uuid, :'apex'::uuid, 'Quill Roofing')::text, 'with Al''s account, the company and its name for the text');
select t1100.check(t1100.found('540.555.0102') = '{Birch Gutters}', 'Bo''s finds Birch''s');
select t1100.check(t1100.found('540-555-0199') = '{}', 'the number Al put on his own profile finds nothing: only the office''s counts');
select t1100.check(t1100.found('540-555-0144') = '{}', 'nor does a number on the crew''s profiles');
select t1100.check(t1100.found('540-555-0103') = '{}' and t1100.found('540-555-0145') = '{}', 'Sid signs in with his own account, which Crewtavo didn''t make: no code for it');
select t1100.check(t1100.found('540-555-0108') = '{}', 'nor for an account made for another sub');
select t1100.check(t1100.found('540-555-0104') = '{}', 'nor for Hal, whose sign-in is also on Papa''s crew');
select t1100.check(t1100.found('540-555-0109') = '{}', 'a sub with no sign-in has nothing to sign in to');
select t1100.check(t1100.found('540-555-0177') = '{"Dup One","Dup Two"}' and (select count(*) from public.sub_sign_ins_for_phone('5405550177')) = 2,
  'a number on two sign-ins, at two companies, finds both (and the server sends no code)');
select t1100.check(t1100.found('555-0101') = '{}' and t1100.found('') = '{}' and t1100.found(null) = '{}', 'something that isn''t a whole number finds nothing');
select t1100.check(t1100.found('+44 20 7946 0958') = '{}', 'a UK number gets nothing until the company adds the UK');
commit;

-- Turned off: the sub, or the sign-in.
update public.subcontractors set active = false where id = :'birch';
select t1100.check(t1100.found('540.555.0102') = '{}', 'nothing for a sub the office turned off');
update public.subcontractors set active = true where id = :'birch';
update public.memberships set active = false where user_id = :'bo';
select t1100.check(t1100.found('540.555.0102') = '{}', 'or whose sign-in was removed');
update public.memberships set active = true where user_id = :'bo';
select t1100.check(t1100.found('540.555.0102') = '{Birch Gutters}', 'and found again once it''s back');

-- Hal's place on Papa's crew turned off: still someone else's sign-in, which can be turned back on.
update public.memberships set active = false where user_id = :'hal' and company_id = :'other';
select t1100.check(t1100.found('540-555-0104') = '{}', 'still nothing for Hal once his place on Papa''s crew is turned off: Papa can turn it back on');
update public.memberships set active = true where user_id = :'hal' and company_id = :'other';

-- A new number on file: the old one finds nothing.
update public.subcontractors set phone = '540-555-0112' where id = :'birch';
select t1100.check(t1100.found('540.555.0102') = '{}' and t1100.found('540 555 0112') = '{Birch Gutters}', 'the office changing the number moves it');

-- ===== Other countries ==========================================================================
begin;
set local role authenticated;
select t1100.as_user(:'pat');
select t1100.check(public.set_sub_sign_in_countries(:'other', array['44']) = '{44}', 'Pat adds the UK for Papa');
commit;
select t1100.check(t1100.found('+44 20 7946 0958') = '{}', 'which does nothing for Quill''s sub');

begin;
set local role authenticated;
select t1100.as_user(:'opal');
select t1100.check(public.set_sub_sign_in_countries(:'co', array['44', '+52', '44', '1', ' 61 ']) = '{44,52,61}',
  'Opal, in the office with the subs area, adds the UK, Mexico and Australia: each once, in order, without the US and Canada (always on)');
select t1100.check((select settings -> 'subs' from public.companies where id = :'co') = '{"remind_subs": false, "sign_in_countries": ["44", "52", "61"]}',
  'kept as calling codes next to remind_subs, which stays as it was');
select t1100.expect_error(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{UK}'), 'a calling code is digits');
select t1100.expect_error(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{0044}'), 'without the dialing prefix');
select t1100.expect_error(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{4412}'), 'and 1 to 3 of them');
select t1100.expect_error(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', array(select (20 + n)::text from generate_series(1, 21) n)), 'up to 20 countries');
commit;
select t1100.check(t1100.found('+44 20 7946 0958') = '{Union Jack Builders}' and t1100.found('0044 20 7946 0958') = '{Union Jack Builders}',
  'now Uma''s UK number finds her sign-in');
select t1100.check(t1100.found('+52 55 1234 5678') = '{}', 'and a Mexican number on nobody''s sign-in still finds nothing');

-- Who can't.
begin;
set local role authenticated;
select t1100.as_user(:'dee');
select t1100.check(t1100.error_of(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{33}')) like '42501:%', 'Dee, in the office without the subs area, can''t');
select t1100.as_user(:'ed');
select t1100.check(t1100.error_of(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{33}')) like '42501:%', 'nor can the estimator');
select t1100.as_user(:'lee');
select t1100.check(t1100.error_of(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{33}')) like '42501:%', 'nor a crew lead');
select t1100.as_user(:'cy');
select t1100.check(t1100.error_of(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{33}')) like '42501:%', 'nor can the crew');
select t1100.as_user(:'al');
select t1100.check(t1100.error_of(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{33}')) like '42501:%', 'nor a sub');
select t1100.as_user(:'pat');
select t1100.check(t1100.error_of(format('select public.set_sub_sign_in_countries(%L, %L)', :'co', '{33}')) like '42501:%', 'nor another company''s owner');
commit;
select t1100.check((select settings -> 'subs' -> 'sign_in_countries' from public.companies where id = :'co') = '["44", "52", "61"]', 'Quill''s list is as Opal left it');
select t1100.check(not has_function_privilege('anon', 'public.set_sub_sign_in_countries(uuid, text[])', 'execute'), 'and nobody signed out can');

-- The admin can too.
begin;
set local role authenticated;
select t1100.as_user(:'ada');
select t1100.check(public.set_sub_sign_in_countries(:'co', '{44}') = '{44}', 'Ada, the admin, can change the list');
commit;

-- The owner takes them all off again.
begin;
set local role authenticated;
select t1100.as_user(:'oz');
select t1100.check(public.set_sub_sign_in_countries(:'co', '{}') = '{}', 'the owner can take them off');
commit;
select t1100.check(t1100.found('+44 20 7946 0958') = '{}', 'and the UK number finds nothing again');

-- A list written some other way than through the setting.
update public.companies set settings = jsonb_set(settings, '{subs,sign_in_countries}', '"44"') where id = :'co';
select t1100.check(t1100.found('+44 20 7946 0958') = '{}', 'a setting that isn''t a list opens no country, and the lookup still answers');
update public.companies set settings = jsonb_set(settings, '{subs,sign_in_countries}', '["UK", "44"]') where id = :'co';
select t1100.check(t1100.found('+44 20 7946 0958') = '{Union Jack Builders}', 'something in the list that isn''t a calling code is skipped, and the rest count');
update public.companies set settings = jsonb_set(settings, '{subs,sign_in_countries}', '[44]') where id = :'co';
select t1100.check(t1100.found('+44 20 7946 0958') = '{Union Jack Builders}', 'a calling code kept as a number counts too');
update public.companies set settings = jsonb_set(settings, '{subs,sign_in_countries}', '[]') where id = :'co';

-- ===== The codes ================================================================================
begin;
set local role service_role;
-- Al asks for a code, and types it in.
select public.sign_in_code_save('text', t1100.h('a'), t1100.h('1'), :'al', t1100.h('f'));
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('2'), :'al') = 'wrong', 'a wrong code is wrong');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('1'), :'al') = 'ok', 'the right one works');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('1'), :'al') = 'wrong', 'once');
commit;
select t1100.check((select row(attempts, used_at is not null, expires_at - created_at, ip_hash)::text from private.sign_in_codes where code_hash = t1100.h('1'))
  = row(2, true, interval '10 minutes', t1100.h('f'))::text, 'two tries counted, used, for 10 minutes, with the visitor''s address as a hash');

-- 5 tries, then the code is dead. Al asks from the visitor address 'f'.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1100.h('a'), t1100.h('3'), :'al', t1100.h('f'));
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('4'), :'al', t1100.h('f')) = 'wrong', 'one wrong try');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('4'), :'al', t1100.h('f')) = 'wrong', 'two');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('4'), :'al', t1100.h('f')) = 'wrong', 'three');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('4'), :'al', t1100.h('f')) = 'wrong', 'four');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('4'), :'al', t1100.h('f')) = 'dead', 'the fifth wrong try says the code is used up');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('3'), :'al', t1100.h('f')) = 'dead', 'after five wrong tries even the right code doesn''t work, and Al hears it''s used up');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('3'), :'al', t1100.h('e')) = 'wrong' and public.sign_in_code_check('text', t1100.h('a'), t1100.h('3'), :'al') = 'wrong',
  'someone else trying the number hears only that it isn''t right');
commit;
select t1100.check((select attempts from private.sign_in_codes where code_hash = t1100.h('3')) = 5, 'and the count stops at five');

-- 10 minutes.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1100.h('a'), t1100.h('5'), :'al', t1100.h('f'));
commit;
update private.sign_in_codes set expires_at = clock_timestamp() - interval '1 second' where code_hash = t1100.h('5');
begin;
set local role service_role;
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('5'), :'al', t1100.h('f')) = 'expired', 'a code past its 10 minutes has run out');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('6'), :'al', t1100.h('f')) = 'expired', 'whatever is typed');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('5'), :'al', t1100.h('e')) = 'wrong' and public.sign_in_code_check('text', t1100.h('a'), t1100.h('5'), :'al') = 'wrong',
  'only the visitor who asked hears it ran out: anyone else hears it isn''t right, as for a number nobody asked a code for');
commit;
select t1100.check((select attempts from private.sign_in_codes where code_hash = t1100.h('5')) = 0, 'and those tries don''t count');

-- A new code: the one before stops working, for that number and for the account under another.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1100.h('a'), t1100.h('7'), :'al');
select public.sign_in_code_save('text', t1100.h('b'), t1100.h('8'), :'al', t1100.h('f'));
select public.sign_in_code_save('text', t1100.h('a'), t1100.h('9'), :'al');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('7'), :'al') = 'wrong', 'asking again: the first code no longer works');
select t1100.check(public.sign_in_code_check('text', t1100.h('b'), t1100.h('8'), :'al', t1100.h('f')) = 'wrong', 'nor one for the same account asked for with another number, even when it''s right');
select t1100.check(public.sign_in_code_check('text', t1100.h('a'), t1100.h('9'), :'al') = 'ok', 'the newest one does');
commit;
select t1100.check((select count(*) from private.sign_in_codes where user_id = :'al' and used_at is null and stopped_at is null and expires_at > clock_timestamp()) = 0, 'Al has no code left that works');

-- Tied to one account.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1100.h('c'), t1100.h('a'), :'al');
select t1100.check(public.sign_in_code_check('text', t1100.h('c'), t1100.h('a'), :'bo') = 'wrong', 'a code texted for Al doesn''t sign in Bo');
select t1100.check(public.sign_in_code_check('text', t1100.h('c'), t1100.h('a'), null) = 'wrong', 'or anyone, once the number is nobody''s (a sign-in turned off since)');
select t1100.check(public.sign_in_code_check('text', t1100.h('c'), t1100.h('a'), :'al') = 'ok', 'only Al');
commit;

-- A number with no sign-in: a code nobody has, answering as a real one does.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1100.h('d'), t1100.h('b'), null, t1100.h('f'));
select t1100.check(public.sign_in_code_check('text', t1100.h('d'), t1100.h('b'), null) = 'wrong' and public.sign_in_code_check('text', t1100.h('d'), t1100.h('b'), :'al') = 'wrong',
  'a number with no sign-in never signs anyone in');
select t1100.check(public.sign_in_code_check('text', t1100.h('e'), t1100.h('b'), :'al', t1100.h('f')) = 'wrong', 'nor does a number nobody asked a code for');
commit;
update private.sign_in_codes set expires_at = clock_timestamp() - interval '1 second' where address_hash = t1100.h('d');
begin;
set local role service_role;
select t1100.check(public.sign_in_code_check('text', t1100.h('d'), t1100.h('b'), null, t1100.h('f')) = 'expired', 'and after 10 minutes it has run out, as a real code would');
select t1100.check(public.sign_in_code_check('text', t1100.h('d'), t1100.h('b'), null, t1100.h('e')) = 'wrong', 'to the visitor who asked, and isn''t right to anyone else');
commit;

-- ===== 15 wrong tries in a day ==================================================================
-- Each new code starts its 5 tries over, so the number and the account get 15 wrong tries a day in
-- all. Uma's number ('l') uses up three codes; a fourth doesn't work even with the right code, and
-- neither does one for her account under another number ('n'). A number with no sign-in ('m') goes
-- the same way.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1100.h('l'), t1100.h('1'), :'uma', t1100.h('f'));
select public.sign_in_code_check('text', t1100.h('l'), t1100.h('0'), :'uma', t1100.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('text', t1100.h('l'), t1100.h('2'), :'uma', t1100.h('f'));
select public.sign_in_code_check('text', t1100.h('l'), t1100.h('0'), :'uma', t1100.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('text', t1100.h('l'), t1100.h('3'), :'uma', t1100.h('f'));
select public.sign_in_code_check('text', t1100.h('l'), t1100.h('0'), :'uma', t1100.h('f')) from generate_series(1, 4);
select t1100.check(public.sign_in_code_check('text', t1100.h('l'), t1100.h('3'), :'uma', t1100.h('f')) = 'ok', 'fourteen wrong tries across three codes, and the right one still works');
select public.sign_in_code_save('text', t1100.h('l'), t1100.h('4'), :'uma', t1100.h('f'));
select t1100.check(public.sign_in_code_check('text', t1100.h('l'), t1100.h('0'), :'uma', t1100.h('f')) = 'wrong', 'the fifteenth wrong try');
select public.sign_in_code_save('text', t1100.h('l'), t1100.h('5'), :'uma', t1100.h('f'));
select t1100.check(public.sign_in_code_check('text', t1100.h('l'), t1100.h('5'), :'uma', t1100.h('f')) = 'locked', 'after it, a new code doesn''t work even when it''s right');
select t1100.check(public.sign_in_code_check('text', t1100.h('l'), t1100.h('5'), :'uma', t1100.h('e')) = 'wrong', 'and anyone but the visitor who asked hears only that it isn''t right');
select public.sign_in_code_save('text', t1100.h('n'), t1100.h('6'), :'uma', t1100.h('f'));
select t1100.check(public.sign_in_code_check('text', t1100.h('n'), t1100.h('6'), :'uma', t1100.h('f')) = 'wrong', 'nor does one for Uma''s account under another number, which hears only that it isn''t right');
select public.sign_in_code_save('text', t1100.h('m'), t1100.h('1'), null, t1100.h('f'));
select public.sign_in_code_check('text', t1100.h('m'), t1100.h('0'), null, t1100.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('text', t1100.h('m'), t1100.h('2'), null, t1100.h('f'));
select public.sign_in_code_check('text', t1100.h('m'), t1100.h('0'), null, t1100.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('text', t1100.h('m'), t1100.h('3'), null, t1100.h('f'));
select public.sign_in_code_check('text', t1100.h('m'), t1100.h('0'), null, t1100.h('f')) from generate_series(1, 5);
select public.sign_in_code_save('text', t1100.h('m'), t1100.h('4'), null, t1100.h('f'));
select t1100.check(public.sign_in_code_check('text', t1100.h('m'), t1100.h('4'), null, t1100.h('f')) = 'locked', 'a number with no sign-in answers the same after 15 wrong tries');
commit;
select t1100.check((select array_agg(attempts order by created_at) from private.sign_in_codes where address_hash in (t1100.h('l'), t1100.h('n'))) = '{5,5,5,1,0,1}',
  'tries after the number''s 15th aren''t counted, a try past the account''s 15 under another number is, and a used code''s right try isn''t a wrong one');

-- ===== Two tries at the same moment =============================================================
-- Bo types his code on two phones at once. The second waits for the first, then finds it used.
begin;
set local role service_role;
select public.sign_in_code_save('text', t1100.h('r'), t1100.h('c'), :'bo');
commit;
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
select pid as other_pid from :"dbl".dblink('other', 'select pg_backend_pid()') as t(pid integer) \gset
select :"dbl".dblink_exec('other', 'begin; set local role service_role');
begin;
set local role service_role;
select public.sign_in_code_check('text', t1100.h('r'), t1100.h('c'), :'bo') as first_try \gset
reset role;
select :"dbl".dblink_send_query('other', format('select public.sign_in_code_check(''text'', %L, %L, %L)', t1100.h('r'), t1100.h('c'), :'bo'));
select t1100.check(t1100.waiting_on_me(:other_pid), 'the second try waits for the first');
commit;
select r as second_try from :"dbl".dblink_get_result('other') as t(r text) \gset
select count(*) from :"dbl".dblink_get_result('other') as t(r text);
select :"dbl".dblink_exec('other', 'commit');
select :"dbl".dblink_disconnect('other');
select t1100.check(:'first_try' = 'ok' and :'second_try' = 'wrong', 'the first try signs in, and the second at the same moment gets wrong');
select t1100.check((select row(attempts, used_at is not null)::text from private.sign_in_codes where address_hash = t1100.h('r')) = row(1, true)::text, 'used once, one try counted');

-- ===== The hourly tidy ==========================================================================
update private.sign_in_codes set created_at = now() - interval '25 hours' where address_hash in (t1100.h('a'), t1100.h('b'));
select count(*) as old_codes from private.sign_in_codes where created_at < now() - interval '1 day' \gset
select count(*) as all_codes from private.sign_in_codes \gset
begin;
set local role service_role;
select public.tidy_sign_in_codes() as tidied \gset
commit;
select t1100.check(:old_codes > 0 and :tidied = :old_codes and (select count(*) from private.sign_in_codes) = :all_codes - :old_codes,
  'the hourly upkeep clears codes over a day old, and keeps the rest');

-- ===== Nobody but the server ====================================================================
select t1100.check(not has_table_privilege('authenticated', 'private.sign_in_codes', 'select') and not has_table_privilege('anon', 'private.sign_in_codes', 'select')
  and not has_table_privilege('authenticated', 'private.sign_in_codes', 'insert') and not has_table_privilege('service_role', 'private.sign_in_codes', 'select'),
  'nobody reads or writes the codes directly, the server included (only through its functions)');
select t1100.check((select bool_and(not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and has_function_privilege('service_role', f, 'execute'))
  from unnest(array['public.sign_in_code_save(text, text, text, uuid, text)', 'public.sign_in_code_check(text, text, text, uuid, text)', 'public.tidy_sign_in_codes()',
    'public.sub_sign_ins_for_phone(text)']) as f),
  'saving and checking codes, tidying them and finding whose number it is are for the server''s key only');
begin;
set local role authenticated;
select t1100.as_user(:'al');
select t1100.expect_error('select count(*) from private.sign_in_codes', 'Al can''t read the codes');
select t1100.expect_error(format('select public.sign_in_code_check(''text'', %L, %L, %L)', t1100.h('a'), t1100.h('1'), :'al'), 'or try one himself');
select t1100.expect_error(format('select public.sign_in_code_save(''text'', %L, %L, %L)', t1100.h('a'), t1100.h('1'), :'al'), 'or make one');
select t1100.expect_error('select * from public.sub_sign_ins_for_phone(''540-555-0101'')', 'or look up whose number it is');
select t1100.as_user(:'oz');
select t1100.expect_error('select * from public.sub_sign_ins_for_phone(''540-555-0101'')', 'and neither can the owner');
select t1100.expect_error('select public.tidy_sign_in_codes()', 'or tidy them');
commit;
begin;
set local role anon;
select t1100.expect_error('select * from public.sub_sign_ins_for_phone(''540-555-0101'')', 'nor anyone signed out');
select t1100.expect_error(format('select public.sign_in_code_check(''text'', %L, %L, %L)', t1100.h('a'), t1100.h('1'), :'al'), 'who can''t try a code either');
commit;

\o
\echo 'All sign-in code tests passed.'
