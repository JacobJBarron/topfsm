-- Database tests for 20261018000990_policy_lookups.sql and 20261019001030_crew_time_folds.sql:
-- policies check each row against the person's companies, visits and what those reach, and their
-- crews' people, looked up once per query, and give the same answers as the per-row checks they
-- replaced.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t60;
grant usage on schema t60 to authenticated, service_role;
create function t60.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t60.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t60 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b6000000-0000-0000-0000-000000000001', 'owner@lima.test', '{"full_name": "Lo Owner"}'),
  ('b6000000-0000-0000-0000-000000000002', 'owner@mike.test', '{"full_name": "Mo Owner"}'),
  ('b6000000-0000-0000-0000-000000000003', 'both@lima.test', '{"full_name": "Bo Th"}'),
  ('b6000000-0000-0000-0000-000000000004', 'hr@lima.test', '{"full_name": "Hari Admin"}'),
  ('b6000000-0000-0000-0000-000000000005', 'gone@lima.test', '{"full_name": "Gone Away"}'),
  ('b6000000-0000-0000-0000-000000000006', 'lead@lima.test', '{"full_name": "Lee Lead"}'),
  ('b6000000-0000-0000-0000-000000000007', 'crew@lima.test', '{"full_name": "Cree Crew"}'),
  ('b6000000-0000-0000-0000-000000000008', 'helper@lima.test', '{"full_name": "Hal Helper"}'),
  ('b6000000-0000-0000-0000-000000000009', 'hedges@lima.test', '{"full_name": "Ivy Hedges"}'),
  ('b6000000-0000-0000-0000-000000000010', 'sam@siding.test', '{"full_name": "Sam Sub"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Lima Lawn', 'general') as lima \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.company_roles (company_id, name, base_role, permissions) values (:'lima', 'HR admin', 'admin', '{team}') returning id as hr_role \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'lima', 'Kit lead', 'crew_lead', '{equipment}') returning id as kit_role \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'lima', 'b6000000-0000-0000-0000-000000000003', 'office', null),
  (:'lima', 'b6000000-0000-0000-0000-000000000004', 'admin', :'hr_role'),
  (:'lima', 'b6000000-0000-0000-0000-000000000005', 'office', null),
  (:'lima', 'b6000000-0000-0000-0000-000000000006', 'crew_lead', :'kit_role'),
  (:'lima', 'b6000000-0000-0000-0000-000000000007', 'field_crew', null),
  (:'lima', 'b6000000-0000-0000-0000-000000000008', 'field_crew', null),
  (:'lima', 'b6000000-0000-0000-0000-000000000009', 'field_crew', null);
set local role authenticated;
update public.memberships set active = false where company_id = :'lima' and user_id = 'b6000000-0000-0000-0000-000000000005';
insert into public.crews (company_id, name, lead_user_id) values (:'lima', 'Mowing', 'b6000000-0000-0000-0000-000000000006') returning id as crew1 \gset
insert into public.crews (company_id, name) values (:'lima', 'Trees') returning id as crew2 \gset
-- The crew lead leads a second crew too.
insert into public.crews (company_id, name, lead_user_id) values (:'lima', 'Hedges', 'b6000000-0000-0000-0000-000000000006') returning id as crew3 \gset
insert into public.crew_members (company_id, crew_id, user_id) values
  (:'lima', :'crew1', 'b6000000-0000-0000-0000-000000000007'), (:'lima', :'crew1', 'b6000000-0000-0000-0000-000000000008'),
  (:'lima', :'crew3', 'b6000000-0000-0000-0000-000000000009');
insert into public.clients (company_id, display_name) values (:'lima', 'Lima client') returning id as c1 \gset
insert into public.clients (company_id, display_name) values (:'lima', 'Request client') returning id as c2 \gset
insert into public.clients (company_id, display_name) values (:'lima', 'Property client') returning id as c3 \gset
insert into public.clients (company_id, display_name) values (:'lima', 'Nobody''s client');
insert into public.properties (company_id, client_id, line1) values (:'lima', :'c1', '1 Job St') returning id as p1 \gset
insert into public.properties (company_id, client_id, line1) values (:'lima', :'c2', '2 Request Rd') returning id as p2 \gset
insert into public.properties (company_id, client_id, line1) values (:'lima', :'c3', '3 Visit Ave') returning id as p3 \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'lima', :'c1', :'p1', 'Weekly mowing') returning id as j1 \gset
insert into public.jobs (company_id, client_id, title) values (:'lima', :'c1', 'Someone else''s job');
insert into public.requests (company_id, client_id, property_id, title) values (:'lima', :'c2', :'p2', 'Quote me') returning id as r1 \gset
insert into public.requests (company_id, client_id, title) values (:'lima', :'c2', 'Another request');
insert into public.visits (scheduled_on, company_id, job_id, title, crew_id) values (current_date, :'lima', :'j1', 'Mow', :'crew1') returning id as v1 \gset
insert into public.visits (scheduled_on, company_id, request_id, property_id, title, crew_id) values (current_date, :'lima', :'r1', :'p3', 'Assess', :'crew2') returning id as v2 \gset
insert into public.visits (scheduled_on, company_id, title, crew_id) values (current_date, :'lima', 'Crew visit', :'crew1');
insert into public.visits (scheduled_on, company_id, property_id, title) values (current_date, :'lima', :'p1', 'No crew') returning id as v4 \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values
  (:'lima', :'v1', 'b6000000-0000-0000-0000-000000000007'),
  (:'lima', :'v2', 'b6000000-0000-0000-0000-000000000006'),
  (:'lima', :'v4', 'b6000000-0000-0000-0000-000000000008');
insert into public.invoices (company_id, client_id, status, total, balance_due) values (:'lima', :'c1', 'sent', 100, 100);
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select public.create_company('Mike Mowing', 'general') as mike \gset
-- Lima's crew lead is a crew lead in Mike too, without a crew there, and someone on their crew in
-- Lima is on a crew in Mike.
insert into public.memberships (company_id, user_id, role) values (:'mike', 'b6000000-0000-0000-0000-000000000003', 'field_crew'),
  (:'mike', 'b6000000-0000-0000-0000-000000000006', 'crew_lead'), (:'mike', 'b6000000-0000-0000-0000-000000000007', 'field_crew');
insert into public.crews (company_id, name, lead_user_id) values (:'mike', 'Mike crew', 'b6000000-0000-0000-0000-000000000003') returning id as crew4 \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'mike', :'crew4', 'b6000000-0000-0000-0000-000000000007');
commit;
-- Sam signs in as a sub of Lima, on the mowing visit (the server makes a sub's sign-in).
insert into public.subcontractors (company_id, name) values (:'lima', 'Sam''s Siding') returning id as sam_sub \gset
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'lima', 'b6000000-0000-0000-0000-000000000010', 'subcontractor', :'sam_sub');
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'lima', :'v1', 'b6000000-0000-0000-0000-000000000010');

\o
\echo 'Policy lookups'
\o /dev/null

-- The lists give the same answer as the per-row checks, for every person and every company,
-- level, area, crew, visit, client, job, property and request, and every company and person.
begin;
create temp table t60_answers (who uuid, about uuid, what text, per_row boolean, listed boolean, company uuid);
create temp table t60_people as select id from auth.users where id::text like 'b6000000-%';
create temp table t60_things as
  select 'company' as kind, id, null::uuid as crew from public.companies union all select 'company', null, null
  union all select 'crew', c.company_id, c.id from public.crews c union all select 'crew', id, null from public.companies
  union all select 'visit', id, null from public.visits union all select 'client', id, null from public.clients
  union all select 'job', id, null from public.jobs union all select 'property', id, null from public.properties
  union all select 'request', id, null from public.requests;
grant all on t60_answers, t60_people, t60_things to authenticated;
set local role authenticated;
do $$
declare
  u uuid;
  t record;
  r public.member_role[];
  a text;
  c uuid;
  v uuid;
begin
  for u in select id from t60_people loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    for t in select * from t60_things loop
      case t.kind
      when 'company' then
        insert into t60_answers values (u, t.id, 'member', private.is_member(t.id), t.id = any (private.member_companies()));
        foreach r slice 1 in array array[['owner','owner'], ['owner','admin'], ['office','office'], ['field_crew','crew_lead'], ['subcontractor','subcontractor']]::public.member_role[][] loop
          insert into t60_answers values (u, t.id, r::text, private.has_role(t.id, r), t.id = any (private.role_companies(r)));
        end loop;
        foreach a in array array['invoices', 'team', 'apps', 'schedule', 'equipment', 'nothing'] loop
          insert into t60_answers values (u, t.id, a, private.has_perm(t.id, a), t.id = any (private.perm_companies(a)));
        end loop;
        insert into t60_answers values (u, t.id, 'manages_equipment', private.manages_equipment(t.id),
          t.id = any (private.role_companies('{owner,admin,office,estimator,crew_lead}')) and t.id = any (private.perm_companies('equipment')));
      when 'crew' then
        insert into t60_answers values (u, t.crew, 'schedules_crew', private.schedules_crew(t.id, t.crew),
          (t.id = any (private.role_companies('{owner,admin,office,estimator,crew_lead}')) and t.id = any (private.perm_companies('schedule')))
          or (t.id = any (private.role_companies('{crew_lead}')) and coalesce((t.id, t.crew) in (select p.company_id, p.crew_id from private.my_crew_pairs() p), false)));
      when 'visit' then
        insert into t60_answers values (u, t.id, 'assigned_to_visit', private.assigned_to_visit(t.id), t.id in (select private.my_assigned_visits()));
        insert into t60_answers values (u, t.id, 'works_visit', private.works_visit(t.id),
          t.id in (select private.my_assigned_visits()) or coalesce(private.visit_crew(t.id) in (select p.crew_id from private.my_crew_pairs() p), false));
      when 'client' then
        insert into t60_answers values (u, t.id, 'crew_sees_client', private.crew_sees_client(t.id), t.id in (select private.crew_clients()));
      when 'job' then
        insert into t60_answers values (u, t.id, 'crew_sees_job', private.crew_sees_job(t.id), t.id in (select private.crew_jobs()));
      when 'property' then
        insert into t60_answers values (u, t.id, 'crew_sees_property', private.crew_sees_property(t.id), t.id in (select private.crew_properties()));
      when 'request' then
        insert into t60_answers values (u, t.id, 'crew_sees_request', private.crew_sees_request(t.id), t.id in (select private.crew_requests()));
      end case;
    end loop;
  end loop;
  -- Is this person on my crew, in this company? For every company and person, and none, asked by
  -- everyone, and by nobody signed in. on_my_crew answers NULL about no one, and to nobody signed
  -- in, and so must its list.
  for u in select id from t60_people union all select null loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    for c in select id from t60_things where kind = 'company' loop
      for v in select id from t60_people union all select null loop
        insert into t60_answers values (u, v, 'on_my_crew', private.on_my_crew(c, v),
          v = auth.uid() or coalesce((c, v) in (select p.company_id, p.user_id from private.my_crew_people() p), false), c);
      end loop;
    end loop;
  end loop;
end $$;
reset role;
select t60.check((select count(distinct who) from t60_answers) = 10, 'every person was asked');
select t60.check((select bool_and(not per_row) from t60_answers where who = 'b6000000-0000-0000-0000-000000000010' and what = 'member')
  and (select bool_or(per_row) from t60_answers where who = 'b6000000-0000-0000-0000-000000000010' and what = '{subcontractor,subcontractor}'),
  'a sub is no member of any company, though they have a sign-in at the Subcontractor level');
select t60.check(not exists (select 1 from t60_answers where what <> 'on_my_crew' and per_row is distinct from coalesce(listed, false)),
  'the lists answer exactly as the per-row checks do' || coalesce(': ' || (select string_agg(distinct what, ', ') from t60_answers where what <> 'on_my_crew' and per_row is distinct from coalesce(listed, false)), ''));
select t60.check(not exists (select 1 from t60_answers where what = 'on_my_crew' and per_row is distinct from listed)
  and exists (select 1 from t60_answers where what = 'on_my_crew' and per_row is null),
  'and so does the crew list, NULL about no one included' || coalesce(': ' || (select string_agg(format('%s about %s in %s', who, about, company), ', ')
    from t60_answers where what = 'on_my_crew' and per_row is distinct from listed), ''));
select t60.check((select array_agg(about order by about) from t60_answers where what = 'on_my_crew' and per_row and who = 'b6000000-0000-0000-0000-000000000006' and company = :'lima')
  = '{b6000000-0000-0000-0000-000000000006,b6000000-0000-0000-0000-000000000007,b6000000-0000-0000-0000-000000000008,b6000000-0000-0000-0000-000000000009}',
  'a crew lead of two crews has both crews'' people');
select t60.check((select array_agg(about order by about) from t60_answers where what = 'on_my_crew' and per_row and who = 'b6000000-0000-0000-0000-000000000006' and company = :'mike')
  = '{b6000000-0000-0000-0000-000000000006}'
  and (select array_agg(about order by about) from t60_answers where what = 'on_my_crew' and per_row and who = 'b6000000-0000-0000-0000-000000000003' and company = :'mike')
  = '{b6000000-0000-0000-0000-000000000003,b6000000-0000-0000-0000-000000000007}',
  'in that company only: their crew''s person on a crew in another company counts there for that crew''s lead, not them');
select t60.check(not exists (select 1 from t60_answers where what <> 'nothing' group by what having not bool_or(per_row)),
  'every kind of check says yes to someone' || coalesce(': not ' || (select string_agg(w, ', ') from (select what as w from t60_answers where what <> 'nothing' group by what having not bool_or(per_row)) x), ''));
select t60.check(not exists (select 1 from t60_answers group by what having bool_and(per_row)), 'and no to someone');
rollback;

-- Every helper still has the body its list mirrors: one that changes needs its list changed too.
select t60.check(not exists (select private.changed_folded_helpers()),
  'the folded helpers are unchanged' || coalesce(': ' || (select string_agg(h, ', ') from private.changed_folded_helpers() h), ''));

-- No policy is left checking each row with a security definer function.
select t60.check(not exists (
  select 1 from pg_policy p join pg_class t on t.oid = p.polrelid join pg_namespace n on n.oid = t.relnamespace
  where n.nspname in ('public', 'storage')
    and concat(pg_get_expr(p.polqual, p.polrelid), ' ', pg_get_expr(p.polwithcheck, p.polrelid))
        ~ '(^|[^''])private\.(has_role|has_perm|is_member|manages_equipment|schedules_crew|assigned_to_visit|works_visit|crew_sees_[a-z]+|on_my_crew)\('),
  'no policy checks each row with has_role, has_perm, is_member or a crew helper (end a migration that adds one with select private.fold_member_checks())');
select t60.check(private.fold_member_checks() = 0, 'running the rewrite again changes nothing');
select t60.check(not exists (select from private.member_fold_changes()), 'and nothing is left for scripts/migrate.mjs to rewrite');
select t60.check(pg_get_expr(polqual, polrelid) !~ 'COALESCE', 'a check on a column that can''t be NULL is written plainly, so its index can be used')
from pg_policy where polname = 'invoices_area';
select t60.check(current_setting('lock_timeout') = '0', 'the rewrite leaves the lock timeout as it found it');
select t60.check(e ~ 'private\.visit_crew\(visit_id\) IN \( SELECT p\.crew_id' and e ~ 'visit_id IN \( SELECT private\.my_assigned_visits',
  'a crew member''s checklist looks up the visit''s crew, not every visit of the crew: ' || e)
from (select pg_get_expr(polqual, polrelid) as e from pg_policy where polname = 'checklist_responses_read') x;
select t60.check(e ~ '\(company_id, user_id\) IN \( SELECT p\.company_id,\s+p\.user_id\s+FROM private\.my_crew_people\(\)' and e !~ 'COALESCE\(\(\(company_id, user_id\)',
  'a crew lead''s time is checked against their crews'' people, looked up once, plainly as neither column can be NULL: ' || e)
from (select pg_get_expr(polqual, polrelid) as e from pg_policy where polname = 'time_entries_read') x;
select t60.check(private.fold_member_expr('private.on_my_crew(company_id, who)', '{company_id}')
  = '((who = (SELECT auth.uid())) OR (COALESCE(((company_id, who) IN (SELECT p.company_id, p.user_id FROM private.my_crew_people() p)), false)))',
  'and wrapped where the person can be missing, keeping on_my_crew''s own NULL for that row');

-- A helper that has changed isn't folded into policies (its list no longer says the same).
begin;
create or replace function private.crew_sees_job(p_job uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.my_visits() v where v.job_id = p_job and v.status <> 'cancelled')
$$;
select t60.check((select array_agg(h) from private.changed_folded_helpers() h) = '{private.crew_sees_job(uuid)}', 'a changed helper is noticed');
select t60.check(private.fold_member_expr('(private.crew_sees_job(job_id) OR private.is_member(company_id))', '{job_id,company_id}')
  = '(private.crew_sees_job(job_id) OR (company_id = ANY ((SELECT private.member_companies())::uuid[])))', 'and left checking each row');
rollback;
begin;
create or replace function private.has_role(p_company uuid, p_roles public.member_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = (select auth.uid()) and m.active and m.role = any (p_roles) and m.role_id is null)
$$;
select t60.check(private.fold_member_expr('private.manages_equipment(company_id)', '{company_id}') = 'private.manages_equipment(company_id)'
  and private.fold_member_expr('private.schedules_crew(company_id, crew_id)', '{company_id}') = 'private.schedules_crew(company_id, crew_id)',
  'helpers folded into has_role''s list are left too when has_role changes');
rollback;
begin;
create or replace function private.on_my_crew(p_company uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user = (select auth.uid()) or exists (select 1 from public.crews c where c.company_id = p_company and c.lead_user_id = p_user)
$$;
select t60.check((select array_agg(h) from private.changed_folded_helpers() h) = '{"private.on_my_crew(uuid,uuid)"}'
  and private.fold_member_expr('private.on_my_crew(company_id, user_id)', '{company_id,user_id}') = 'private.on_my_crew(company_id, user_id)',
  'a changed on_my_crew is left checking each row');
rollback;
begin;
create or replace function private.my_crews(p_company uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.crews c where c.company_id = p_company and c.lead_user_id = (select auth.uid()) and c.active
$$;
select t60.check(private.fold_member_expr('private.on_my_crew(company_id, user_id)', '{company_id,user_id}') = 'private.on_my_crew(company_id, user_id)'
  and private.fold_member_expr('private.schedules_crew(company_id, crew_id)', '{company_id}') = 'private.schedules_crew(company_id, crew_id)',
  'and so are the checks that go through my_crews when it changes');
rollback;

-- A policy added the old way is rewritten, and still lets in exactly who it did: a NOT over a check
-- on a column that can be NULL still lets a row with no value in, and a check named inside a string
-- is left alone.
create table public.t60_notes (id serial primary key, company_id uuid not null, other_company uuid, label text);
alter table public.t60_notes enable row level security;
grant select on public.t60_notes to authenticated;
create policy t60_notes_read on public.t60_notes for select to authenticated
  using (private.has_role(company_id, '{owner,office}') and private.is_member(company_id)
         and not private.is_member(other_company) and label is distinct from 'private.is_member(company_id)');
insert into public.t60_notes (company_id, other_company, label) select id, null, name from public.companies where name in ('Lima Lawn', 'Mike Mowing');
insert into public.t60_notes (company_id, other_company, label) select id, id, 'own other' from public.companies where name = 'Lima Lawn';
insert into public.t60_notes (company_id, label) select id, 'private.is_member(company_id)' from public.companies where name = 'Lima Lawn';
create policy t60_notes_named on public.t60_notes for select to authenticated using (private.is_member(company_id) and label = 'private.has_role(');
-- Tables too busy to lock in time (here: no time at all) are left as they are, for later.
set deadlock_timeout = '30ms';
select t60.check(private.fold_member_checks(null, interval '0 seconds') = -1, 'when the tables stay busy the rewrite gives up');
reset deadlock_timeout;
select t60.check((select count(*) from private.member_fold_changes()) = 2 and pg_get_expr(polqual, polrelid) ~ 'private\.has_role\(',
  'and changes nothing, leaving them to be rewritten later') from pg_policy where polname = 't60_notes_read';
select t60.check(current_setting('lock_timeout') = '0', 'with the lock timeout put back');
select t60.check(private.fold_member_checks('public.t60_notes') = 2, 'one table''s policies can be rewritten on their own');
select t60.check(current_setting('lock_timeout') = '0', 'and the lock timeout is put back after');
select t60.check(e ~ 'role_companies' and e ~ 'COALESCE\(\(other_company = ANY' and e ~ '''private\.is_member\(company_id\)''' and e !~ '[^'']private\.(has_role|is_member)\(',
  'to check against the lists, NULL-safe where the column can be empty, with the string as it was: ' || e)
from (select pg_get_expr(polqual, polrelid) as e from pg_policy where polname = 't60_notes_read') x;
select t60.check(e ~ 'member_companies' and e ~ '''private\.has_role\(''', 'a check named inside a string stays as it was: ' || e)
from (select pg_get_expr(polqual, polrelid) as e from pg_policy where polname = 't60_notes_named') x;
drop policy t60_notes_named on public.t60_notes;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t60.check((select array_agg(label) from public.t60_notes) = '{Lima Lawn}', 'office in one company and crew in another reads only the first');
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t60.check(not exists (select 1 from public.t60_notes), 'an inactive member reads nothing');
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t60.check((select array_agg(label) from public.t60_notes) = '{Mike Mowing}', 'an owner reads their own company''s');
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000010", "role": "authenticated"}', true);
select t60.check(not exists (select 1 from public.t60_notes), 'and a sub reads nothing a member would');
rollback;
drop table public.t60_notes;

-- A crew check on a person who can be missing is rewritten too, and still lets in exactly who it
-- did: on_my_crew says NULL, not no, about a row with nobody's name, so a NOT over it still keeps
-- that row out.
create table public.t60_crew_notes (id serial primary key, company_id uuid not null, who uuid, label text);
alter table public.t60_crew_notes enable row level security;
grant select on public.t60_crew_notes to authenticated;
create policy t60_crew_notes_read on public.t60_crew_notes for select to authenticated
  using (private.is_member(company_id) and not private.on_my_crew(company_id, who));
insert into public.t60_crew_notes (company_id, who, label)
  select co.id, w.who, co.name || ': ' || w.label from public.companies co cross join (values
    ('b6000000-0000-0000-0000-000000000003'::uuid, 'office'), ('b6000000-0000-0000-0000-000000000006', 'lead'),
    ('b6000000-0000-0000-0000-000000000007', 'crew'), ('b6000000-0000-0000-0000-000000000009', 'hedges'), (null, 'nobody')) as w(who, label)
  where co.id in (:'lima', :'mike');
create temp table t60_seen (who uuid, folded boolean, labels text[]);
grant all on t60_seen to authenticated;
create function t60.read_crew_notes(p_folded boolean) returns void language plpgsql as $$
declare
  u uuid;
begin
  for u in select ('b6000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 10) g loop
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    insert into t60_seen select u, p_folded, array(select label from public.t60_crew_notes order by label);
  end loop;
end $$;
grant execute on function t60.read_crew_notes(boolean) to authenticated;
begin;
set local role authenticated;
select t60.read_crew_notes(false);
commit;
select t60.check(private.fold_member_checks('public.t60_crew_notes') = 1, 'a crew check added the old way is rewritten');
begin;
set local role authenticated;
select t60.read_crew_notes(true);
commit;
select t60.check((select count(*) from t60_seen) = 20
  and not exists (select 1 from t60_seen b join t60_seen a on a.who = b.who and a.folded and not b.folded where a.labels is distinct from b.labels),
  'and everyone reads the same rows as before');
select t60.check((select labels from t60_seen where folded and who = 'b6000000-0000-0000-0000-000000000006')
  = '{"Lima Lawn: office","Mike Mowing: crew","Mike Mowing: hedges","Mike Mowing: office"}',
  'a crew lead reads the rows about people off their crews in each company, not the ones about nobody');
select t60.check(e ~ 'COALESCE\(\(\(company_id, who\) IN' and e !~ 'on_my_crew', 'written NULL-safe on the person: ' || e)
from (select pg_get_expr(polqual, polrelid) as e from pg_policy where polname = 't60_crew_notes_read') x;
drop function t60.read_crew_notes(boolean);
drop table t60_seen;
drop table public.t60_crew_notes;

-- A crew lead's time entries through the rewritten policies: their own and both their crews'
-- people's, in their company only, and only the unapproved ones to change.
begin;
insert into public.time_entries (company_id, user_id, category, started_at, ended_at, notes, approved_at)
  select w.co, w.who, 'shop', now() - interval '3 hours', now() - interval '2 hours', w.label, w.approved from (values
    (:'lima'::uuid, 'b6000000-0000-0000-0000-000000000006'::uuid, 'Lima: lead', null::timestamptz),
    (:'lima', 'b6000000-0000-0000-0000-000000000007', 'Lima: crew', null), (:'lima', 'b6000000-0000-0000-0000-000000000007', 'Lima: crew approved', now()),
    (:'lima', 'b6000000-0000-0000-0000-000000000008', 'Lima: helper', null), (:'lima', 'b6000000-0000-0000-0000-000000000009', 'Lima: hedges', null),
    (:'lima', 'b6000000-0000-0000-0000-000000000003', 'Lima: office', null), (:'lima', 'b6000000-0000-0000-0000-000000000004', 'Lima: admin', null),
    (:'mike', 'b6000000-0000-0000-0000-000000000007', 'Mike: crew', null), (:'mike', 'b6000000-0000-0000-0000-000000000003', 'Mike: lead', null)
  ) as w(co, who, label, approved);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t60.check((select array_agg(notes order by notes) from public.time_entries where company_id in (:'lima', :'mike'))
  = '{"Lima: crew","Lima: crew approved","Lima: hedges","Lima: helper","Lima: lead"}',
  'a crew lead reads their own time and both their crews'', not the office''s, nor another company''s');
insert into public.time_entries (company_id, user_id, category, started_at, ended_at, notes)
  values (:'lima', 'b6000000-0000-0000-0000-000000000009', 'shop', now() - interval '5 hours', now() - interval '4 hours', 'Lima: hedges, by the lead');
select t60.check((select count(*) from public.time_entries where notes = 'Lima: hedges, by the lead') = 1, 'adds time for someone on their second crew');
select t60.expect_error(format('insert into public.time_entries (company_id, user_id, category, started_at) values (%L, %L, ''shop'', now())', :'lima', 'b6000000-0000-0000-0000-000000000003'),
  'but not for someone off their crews');
select t60.expect_error(format('insert into public.time_entries (company_id, user_id, category, started_at) values (%L, %L, ''shop'', now())', :'mike', 'b6000000-0000-0000-0000-000000000007'),
  'nor in another company, for someone on their crew here');
with x as (update public.time_entries set notes = notes || ' (fixed)' where company_id = :'lima' and notes in ('Lima: helper', 'Lima: office', 'Lima: crew approved') returning notes)
select t60.check((select array_agg(notes) from x) = '{"Lima: helper (fixed)"}', 'changes their crew''s unapproved time, not someone else''s or approved time');
with x as (delete from public.time_entries where company_id = :'lima' and notes in ('Lima: hedges', 'Lima: admin', 'Lima: crew approved') returning notes)
select t60.check((select array_agg(notes) from x) = '{"Lima: hedges"}', 'and deletes the same');
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t60.check((select array_agg(notes order by notes) from public.time_entries where company_id in (:'lima', :'mike'))
  = '{"Lima: crew","Lima: crew approved","Mike: crew"}', 'someone on the crew reads only their own time, in both companies');
rollback;

-- What crews read through the rewritten policies.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t60.check((select array_agg(title order by title) from public.visits) = '{Mow}', 'crew read their own visit');
select t60.check((select array_agg(display_name order by display_name) from public.clients) = '{"Lima client"}', 'and its client');
select t60.check((select array_agg(title) from public.jobs) = '{"Weekly mowing"}', 'and its job');
select set_config('request.jwt.claims', '{"sub": "b6000000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t60.check((select count(*) from public.visits v join public.companies co on co.id = v.company_id where co.name = 'Lima Lawn') = 4, 'a crew lead reads every visit');
select t60.check((select count(*) from public.clients c join public.companies co on co.id = c.company_id where co.name = 'Lima Lawn') = 4, 'and every client');
rollback;

\o
\echo 'All policy lookup tests passed.'
