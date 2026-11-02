-- Database tests for agreeing to the Crewtavo License: who can agree for a business, what's kept,
-- who can see it, and that nobody can change the record afterwards.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t15;
grant usage on schema t15 to authenticated, service_role;
create function t15.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t15.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t15 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('af000000-0000-0000-0000-000000000001', 'owner@oscar.test', '{"full_name": "Olive Owner"}'),
  ('af000000-0000-0000-0000-000000000002', 'admin@oscar.test', '{"full_name": "Abe Admin"}'),
  ('af000000-0000-0000-0000-000000000003', 'office@oscar.test', '{"full_name": "Ola Office"}'),
  ('af000000-0000-0000-0000-000000000004', 'owner@papa.test', '{"full_name": "Pat Papa"}');

-- ===== The owner sets up the business and agrees ================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "af000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Oscar Lawn', 'lawn_care') as co \gset
select public.accept_terms(:'co', '2026-10-17') as agreed \gset
select t15.check((select full_name = 'Olive Owner' and email = 'owner@oscar.test' and role = 'owner' and version = '2026-10-17'
  from public.terms_acceptances where id = :'agreed'), 'the record keeps who agreed, as what, and to which version');
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'af000000-0000-0000-0000-000000000002', 'admin'),
  (:'co', 'af000000-0000-0000-0000-000000000003', 'office');
set local role authenticated;
select t15.expect_error(format('update public.terms_acceptances set version = %L where id = %L', 'old', :'agreed'), 'not even the owner can change an agreement');
select t15.expect_error(format('delete from public.terms_acceptances where id = %L', :'agreed'), 'or remove one');
select t15.expect_error(format('insert into public.terms_acceptances (company_id, full_name, role, version) values (%L, %L, %L, %L)', :'co', 'Someone', 'owner', 'x'),
  'agreements are only made through accept_terms');
commit;

-- ===== An admin can agree and see the history; the office can't ================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "af000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select public.accept_terms(:'co', '2027-01-01');
select t15.check((select count(*) from public.terms_acceptances where company_id = :'co') = 2, 'admins see every agreement for the business');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "af000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t15.expect_error(format('select public.accept_terms(%L, %L)', :'co', '2026-10-17'), 'office staff can''t agree for the business');
select t15.check((select count(*) from public.terms_acceptances) = 0, 'or see the agreements');
commit;

-- ===== Another business's owner can't agree for this one =======================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "af000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t15.expect_error(format('select public.accept_terms(%L, %L)', :'co', '2026-10-17'), 'an outsider can''t agree for a business');
select t15.check((select count(*) from public.terms_acceptances) = 0, 'or see its agreements');
commit;

-- ===== Agreements outlast the person who made them =============================================
delete from auth.users where id = 'af000000-0000-0000-0000-000000000002';
select t15.check((select user_id is null and full_name = 'Abe Admin' from public.terms_acceptances where version = '2027-01-01'),
  'when someone''s account is deleted, their agreement keeps their name');

\echo 'All license agreement tests passed.'
