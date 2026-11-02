-- Database tests for the instance's web address (Settings → Web address): owners and admins see
-- the change in progress, nobody else does, and only the API (service key) writes it.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema twa;
grant usage on schema twa to authenticated, service_role;
create function twa.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function twa.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema twa to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b4000000-0000-0000-0000-000000000001', 'owner@quail.test', '{"full_name": "Quinn Owner"}'),
  ('b4000000-0000-0000-0000-000000000002', 'admin@quail.test', '{"full_name": "Abby Admin"}'),
  ('b4000000-0000-0000-0000-000000000003', 'office@quail.test', '{"full_name": "Otto Office"}'),
  ('b4000000-0000-0000-0000-000000000004', 'owner@robin.test', '{"full_name": "Rae Robin"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b4000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Quail Roofing', 'roofing') as co \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.memberships (company_id, user_id, role) values
  (:'co', 'b4000000-0000-0000-0000-000000000002', 'admin'),
  (:'co', 'b4000000-0000-0000-0000-000000000003', 'office');
set local role authenticated;
select twa.expect_error(format('insert into public.web_address (company_id, domain) values (%L, %L)', :'co', 'app.quail.test'), 'not even the owner writes the address directly');
commit;

-- The API, with the service key.
insert into public.web_address (company_id, domain, records, from_url) values
  (:'co', 'app.quail.test', '[{"type": "CNAME", "purpose": "route", "name": "app.quail.test", "value": null}]', 'https://quail.up.railway.app');
select twa.expect_error(format('insert into public.web_address (company_id, domain) values (%L, %L)', :'co', 'App.Quail.Test/'), 'an address is stored bare and lowercase');
select twa.expect_error(format('update public.web_address set status = %L where company_id = %L', 'paused', :'co'), 'only known statuses');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b4000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select twa.check((select domain = 'app.quail.test' and status = 'waiting' from public.web_address where company_id = :'co'), 'the owner sees the change in progress');
update public.web_address set status = 'done' where company_id = :'co';
commit;
select twa.check((select status = 'waiting' from public.web_address where company_id = :'co'), 'and can''t move it along by hand');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b4000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select twa.check((select count(*) from public.web_address) = 1, 'an admin sees it too');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b4000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select twa.check((select count(*) from public.web_address) = 0, 'office staff don''t');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b4000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select twa.check((select count(*) from public.web_address) = 0, 'nor does another business');
commit;

select twa.check((select updated_at >= started_at from public.web_address where company_id = :'co'), 'changes are timestamped');
