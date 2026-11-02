-- Database tests for giving admin access (20261101000200_admin_grants.sql): the browser can't give
-- it straight to the database, the server can once the giver's password checks out, and everything
-- else people do with the team still works as before.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tag;
grant usage on schema tag to authenticated, service_role;
create function tag.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tag.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- Refused by the new guard itself, not by some other rule.
create function tag.refused(p_sql text, p_what text, p_message text default 'Give admin access from Settings → People') returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlstate = '42501' and sqlerrm = p_message then raise notice 'ok - %', p_what; return; end if;
    raise exception 'FAIL (refused for another reason: % %): %', sqlstate, sqlerrm, p_what;
  end;
  raise exception 'FAIL (expected a refusal): %', p_what;
end $$;
create function tag.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- What the server does once the signed-in person's password checks out (routes/account.ts).
create function tag.password_ok(p_company uuid, p_target uuid) returns void language sql security definer set search_path = '' as $$
  select public.admin_grant_allow(auth.uid(), p_company, p_target)
$$;
grant execute on all functions in schema tag to authenticated, service_role;

\set olive 'a6000000-0000-4000-8000-000000000001'
\set ada 'a6000000-0000-4000-8000-000000000002'
\set hal 'a6000000-0000-4000-8000-000000000003'
\set bea 'a6000000-0000-4000-8000-000000000004'
\set opal 'a6000000-0000-4000-8000-000000000005'
\set cy 'a6000000-0000-4000-8000-000000000006'
\set nia 'a6000000-0000-4000-8000-000000000007'
\set ned 'a6000000-0000-4000-8000-000000000008'
\set kept 'a6000000-0000-4000-8000-0000000000e1'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@kilo.test', '{"full_name": "Olive Owner"}'),
  (:'ada', 'ada@kilo.test', '{"full_name": "Ada Admin"}'),
  (:'hal', 'hal@kilo.test', '{"full_name": "Hal HR"}'),
  (:'bea', 'bea@kilo.test', '{"full_name": "Bea Books"}'),
  (:'opal', 'opal@kilo.test', '{"full_name": "Opal Office"}'),
  (:'cy', 'cy@kilo.test', '{"full_name": "Cy Crew"}'),
  (:'nia', 'nia@kilo.test', '{"full_name": "Nia New"}'),
  (:'ned', 'ned@else.test', '{"full_name": "Ned Newbiz"}');

-- ===== The rule ================================================================================
select tag.check(private.admin_level('owner', null) and private.admin_level('admin', null) and not private.admin_level('office', null), 'owners and plain admins are admin-level, office isn''t');
select tag.check(private.admin_level('admin', '{invoices,team}') and private.admin_level('admin', '{settings}') and private.admin_level('admin', '{apps}'), 'so is an admin role with apps, settings or team');
select tag.check(not private.admin_level('admin', '{invoices,reports}') and not private.admin_level('admin', '{}') and not private.admin_level('office', '{settings}'), 'but not one without them, or an office role with settings');

-- ===== Kilo Lawns: made in the browser, as always ==============================================
-- Olive makes the business (its first owner, and its starter roles, General manager among them).
begin;
set local role authenticated;
select tag.as_user(:'olive');
select public.create_company('Kilo Lawns', 'general') as co \gset
select tag.check((select role from public.memberships where company_id = :'co' and user_id = :'olive') = 'owner', 'making a business still makes its owner');
select id as gm_role from public.company_roles where company_id = :'co' and name = 'General manager' \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
select tag.check(private.admin_level('admin', (select permissions from public.company_roles where id = :'gm_role')), 'and its starter General manager role, which is admin-level');
-- Roles that aren't admin-level are made in the browser as before.
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports}') returning id as books_role \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Spare', 'admin', '{invoices}') returning id as spare_role \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Front office', 'office', '{settings,schedule}') returning id as front_role \gset
-- And people who aren't, invited in the browser.
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'bea', 'admin', :'books_role'), (:'co', :'opal', 'office', :'front_role'), (:'co', :'cy', 'field_crew', null);
select tag.check((select role from public.memberships where company_id = :'co' and user_id = :'bea') = 'admin', 'an admin role without apps, settings or team is given in the browser');
commit;

-- ===== The browser can't give admin access =====================================================
begin;
set local role authenticated;
select tag.as_user(:'olive');
select tag.refused(format('update public.memberships set role = %L, role_id = null where company_id = %L and user_id = %L', 'admin', :'co', :'cy'), 'the owner can''t make someone admin from the browser');
select tag.refused(format('update public.memberships set role_id = %L where company_id = %L and user_id = %L', :'gm_role', :'co', :'cy'), 'or give them an admin-level custom role');
select tag.refused(format('update public.memberships set role = %L, role_id = null where company_id = %L and user_id = %L', 'owner', :'co', :'bea'), 'or make an admin an owner');
select tag.refused(format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', :'co', :'nia', 'admin'), 'or invite someone as admin');
select tag.refused(format('insert into public.memberships (company_id, user_id, role, role_id, active) values (%L, %L, %L, null, true) on conflict (company_id, user_id) do update set role = excluded.role, role_id = excluded.role_id, active = excluded.active', :'co', :'cy', 'admin'), 'or re-invite someone as admin (the invite''s upsert)');
select tag.refused(format('update public.company_roles set permissions = %L where id = %L', '{invoices,reports,settings}', :'books_role'), 'or give a role someone has the settings area');
select tag.refused(format('update public.company_roles set permissions = %L where id = %L', '{invoices,apps}', :'spare_role'), 'or a role nobody has yet the apps area');
select tag.refused(format('update public.company_roles set base_role = %L where id = %L', 'admin', :'front_role'), 'or move a role with settings up to the admin level (its people would follow)');
select tag.refused(format('insert into public.company_roles (company_id, name, base_role, permissions) values (%L, %L, %L, %L)', :'co', 'Everything', 'admin', '{team}'), 'or make an admin-level role');
select tag.refused(format('delete from public.company_roles where id = %L', :'books_role'), 'or delete an admin role people have, which would give them every area', 'Move its people to another role first: deleting it would give them admin access');
select tag.refused(format('update public.memberships set user_id = %L where company_id = %L and user_id = %L', :'nia', :'co', :'olive'), 'or hand their own owner''s membership to another account');
rollback;

-- What still works in the browser: pay, taking access away and back, roles below admin, renaming,
-- taking areas away, and deleting roles that don't give admin access.
begin;
set local role authenticated;
select tag.as_user(:'olive');
with changed as (update public.memberships set labor_rate = 41 where company_id = :'co' and user_id = :'bea' returning 1)
select tag.check((select count(*) from changed) = 1, 'setting an admin''s pay rate');
update public.memberships set active = false where company_id = :'co' and user_id = :'bea';
update public.memberships set active = true where company_id = :'co' and user_id = :'bea';
select tag.check((select active from public.memberships where company_id = :'co' and user_id = :'bea'), 'taking an admin''s access away and giving it back');
update public.memberships set role = 'office', role_id = null where company_id = :'co' and user_id = :'cy';
update public.memberships set role_id = :'ops_role' where company_id = :'co' and user_id = :'cy';
select tag.check((select role from public.memberships where company_id = :'co' and user_id = :'cy') = 'office', 'giving someone a role below admin');
update public.memberships set role = 'office', role_id = null where company_id = :'co' and user_id = :'bea';
select tag.check((select role from public.memberships where company_id = :'co' and user_id = :'bea') = 'office', 'and moving an admin down');
update public.company_roles set name = 'Manager', permissions = '{sales,invoices,team}' where id = :'gm_role';
select tag.check((select name = 'Manager' and permissions = '{sales,invoices,team}' from public.company_roles where id = :'gm_role'), 'renaming an admin-level role, and taking areas from it');
update public.company_roles set permissions = '{invoices,reports,job_costs}' where id = :'books_role';
select tag.check((select 'job_costs' = any (permissions) from public.company_roles where id = :'books_role'), 'giving a role areas that aren''t admin-level');
delete from public.company_roles where id = :'books_role';
delete from public.company_roles where id = :'front_role';
select tag.check(not exists (select 1 from public.company_roles where id in (:'books_role', :'front_role')), 'and deleting roles nobody has, or that don''t give admin access');
rollback;

-- ===== The server, once the password checks out ================================================
begin;
set local role authenticated;
select tag.as_user(:'olive');
select tag.expect_error(format('select public.admin_grant_allow(%L, %L, %L)', :'olive', :'co', :'cy'), 'the browser can''t open the minute itself');
select tag.expect_error('select * from private.admin_grants', 'or see who has one');
select tag.password_ok(:'co', :'cy');
update public.memberships set role = 'admin', role_id = null where company_id = :'co' and user_id = :'cy';
select tag.check((select role from public.memberships where company_id = :'co' and user_id = :'cy') = 'admin', 'once the password checks out, the owner makes someone admin');
update public.memberships set role = 'owner' where company_id = :'co' and user_id = :'cy';
select tag.check((select role from public.memberships where company_id = :'co' and user_id = :'cy') = 'owner', 'or an owner, within the minute');
select tag.refused(format('update public.memberships set role_id = %L where company_id = %L and user_id = %L', :'gm_role', :'co', :'opal'), 'the minute is for that person only');
select tag.password_ok(:'co', :'kept');
insert into public.company_roles (id, company_id, name, base_role, permissions) values (:'kept', :'co', 'Everything', 'admin', '{team}');
select tag.password_ok(:'co', :'spare_role');
update public.company_roles set permissions = '{invoices,apps}' where id = :'spare_role';
select tag.check((select count(*) from public.company_roles where (id = :'kept') or (id = :'spare_role' and 'apps' = any (permissions))) = 2, 'and makes or raises an admin-level role, by its id');
select tag.password_ok(:'co', :'nia');
insert into public.memberships (company_id, user_id, role, role_id, active) values (:'co', :'nia', 'admin', null, true)
  on conflict (company_id, user_id) do update set role = excluded.role, role_id = excluded.role_id, active = excluded.active;
select tag.check((select role from public.memberships where company_id = :'co' and user_id = :'nia') = 'admin', 'and invites someone as admin');
commit;

-- The minute is the giver's, and only lasts a minute.
begin;
set local role authenticated;
select tag.as_user(:'olive');
select tag.password_ok(:'co', :'opal');
select tag.as_user(:'nia');
select tag.refused(format('update public.memberships set role = %L, role_id = null where company_id = %L and user_id = %L', 'admin', :'co', :'opal'), 'another admin can''t use the owner''s minute');
select tag.as_user(:'olive');
reset role;
update private.admin_grants set expires_at = now() - interval '1 second' where user_id = :'olive' and target = :'opal';
set local role authenticated;
select tag.refused(format('update public.memberships set role = %L, role_id = null where company_id = %L and user_id = %L', 'admin', :'co', :'opal'), 'and a minute that''s over lets nothing through');
rollback;

-- Every other rule still holds with the minute open.
begin;
set local role authenticated;
select tag.as_user(:'olive');
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Team only', 'admin', '{invoices}') returning id as hr_role \gset
reset role;
update public.company_roles set permissions = '{team}' where id = :'hr_role';
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'hal', 'admin', :'hr_role');
set local role authenticated;
select tag.as_user(:'hal');
select tag.password_ok(:'co', :'opal');
select tag.expect_error(format('update public.memberships set role = %L, role_id = null where company_id = %L and user_id = %L', 'admin', :'co', :'opal'), 'an admin with only the team area still can''t give every area');
-- Nia, a plain admin.
select tag.as_user(:'nia');
select tag.password_ok(:'co', :'opal');
select tag.expect_error(format('update public.memberships set role = %L, role_id = null where company_id = %L and user_id = %L', 'owner', :'co', :'opal'), 'only owners make owners');
select tag.password_ok(:'co', :'nia');
select tag.expect_error(format('update public.memberships set role_id = %L where company_id = %L and user_id = %L', :'gm_role', :'co', :'nia'), 'and nobody changes their own role');
rollback;

-- ===== Unaffected: the server's own key, and a new business =====================================
begin;
set local role service_role;
select set_config('request.jwt.claims', '', true);
update public.memberships set role = 'admin', role_id = null where company_id = :'co' and user_id = :'opal';
select tag.check((select role from public.memberships where company_id = :'co' and user_id = :'opal') = 'admin', 'the server''s own key gives access as before');
rollback;
begin;
set local role authenticated;
select tag.as_user(:'ned');
select public.create_company('Ned Newbiz', 'general') as other \gset
select tag.check((select role from public.memberships where company_id = :'other' and user_id = :'ned') = 'owner'
  and exists (select 1 from public.company_roles where company_id = :'other' and name = 'General manager'), 'someone new makes their own business, with its starter roles');
rollback;
