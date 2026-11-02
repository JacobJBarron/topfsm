-- Database tests for the review fixes (20261018000800_review_fixes.sql): giving people no more
-- access than you have, job messages and crews, deleting a service that documents use, change
-- orders approved again, and number sequences behind hand-picked numbers.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t41;
grant usage on schema t41 to authenticated, service_role;
create function t41.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t41.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
-- What the server does once the signed-in person's password checks out (the admin_grants migration).
create function t41.password_ok(p_company uuid, p_target uuid) returns void language sql security definer set search_path = '' as $$
  select public.admin_grant_allow(auth.uid(), p_company, p_target)
$$;
grant execute on all functions in schema t41 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('f4100000-0000-0000-0000-000000000001', 'owner@lima.test', '{"full_name": "Lin Owner"}'),
  ('f4100000-0000-0000-0000-000000000002', 'hr@lima.test', '{"full_name": "Hal HR"}'),
  ('f4100000-0000-0000-0000-000000000003', 'hr.second@lima.test', '{"full_name": "Hal Again"}'),
  ('f4100000-0000-0000-0000-000000000004', 'gm@lima.test', '{"full_name": "Gwen Manager"}'),
  ('f4100000-0000-0000-0000-000000000005', 'admin@lima.test', '{"full_name": "Ada Admin"}'),
  ('f4100000-0000-0000-0000-000000000006', 'lead@lima.test', '{"full_name": "Lev Lead"}'),
  ('f4100000-0000-0000-0000-000000000007', 'emp@lima.test', '{"full_name": "Emi Employee"}'),
  ('f4100000-0000-0000-0000-000000000008', 'sales@lima.test', '{"full_name": "Sam Estimator"}'),
  ('f4100000-0000-0000-0000-000000000009', 'office@lima.test', '{"full_name": "Ola Office"}'),
  ('f4100000-0000-0000-0000-000000000010', 'new.hire@lima.test', '{"full_name": "Nia New"}'),
  ('f4100000-0000-0000-0000-000000000011', 'former@lima.test', '{"full_name": "Fay Former"}'),
  ('f4100000-0000-0000-0000-000000000012', 'hr.third@lima.test', '{"full_name": "Hal Thrice"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Lima Landscaping', 'general') as co \gset
select id as gm_role from public.company_roles where company_id = :'co' and name = 'General manager' \gset
select id as foreman_role from public.company_roles where company_id = :'co' and name = 'Foreman' \gset
select id as employee_role from public.company_roles where company_id = :'co' and name = 'Employee' \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'HR admin', 'admin', '{team}') returning id as hr_role \gset
insert into public.memberships (company_id, user_id, role, role_id, active) values
  (:'co', 'f4100000-0000-0000-0000-000000000002', 'admin', :'hr_role', true),
  (:'co', 'f4100000-0000-0000-0000-000000000003', 'field_crew', :'employee_role', true),
  (:'co', 'f4100000-0000-0000-0000-000000000004', 'admin', :'gm_role', true),
  (:'co', 'f4100000-0000-0000-0000-000000000005', 'admin', null, true),
  (:'co', 'f4100000-0000-0000-0000-000000000006', 'crew_lead', :'foreman_role', true),
  (:'co', 'f4100000-0000-0000-0000-000000000007', 'field_crew', :'employee_role', true),
  (:'co', 'f4100000-0000-0000-0000-000000000008', 'estimator', null, true),
  (:'co', 'f4100000-0000-0000-0000-000000000009', 'office', null, true),
  (:'co', 'f4100000-0000-0000-0000-000000000011', 'admin', null, false);
set local role authenticated;
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Planting', 'f4100000-0000-0000-0000-000000000006') returning id as crew \gset
insert into public.crew_members (company_id, crew_id, user_id) values (:'co', :'crew', 'f4100000-0000-0000-0000-000000000007');
insert into public.clients (company_id, display_name) values (:'co', 'Birch Lane') returning id as client \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '9 Birch Ln') returning id as prop \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Front beds') returning id as job, number as job_number \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'job', 'Planting', 1, 'ea', 1200);
insert into public.visits (company_id, job_id, property_id, title, crew_id, scheduled_on) values (:'co', :'job', :'prop', 'Plant beds', :'crew', current_date + 1) returning id as visit \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit', 'f4100000-0000-0000-0000-000000000007');
insert into public.services (company_id, name, unit, unit_price) values (:'co', 'Mulch', 'yd', 60) returning id as mulch \gset
commit;

-- ===== Giving people access: no more than you have ==============================================
-- An admin whose custom role has only "team", working through another account of theirs.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t41.expect_error(format('update public.memberships set role = %L, role_id = null where company_id = %L and user_id = %L', 'admin', :'co', 'f4100000-0000-0000-0000-000000000003'), 'an admin with only the team area can''t make their other account a plain admin');
select t41.expect_error(format('update public.memberships set role_id = %L where company_id = %L and user_id = %L', :'gm_role', :'co', 'f4100000-0000-0000-0000-000000000003'), 'or give it a custom role with more areas than theirs');
select t41.expect_error(format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', :'co', 'f4100000-0000-0000-0000-000000000010', 'office'), 'or invite someone as plain office');
select t41.expect_error(format('insert into public.memberships (company_id, user_id, role, role_id, active) values (%L, %L, %L, null, true) on conflict (company_id, user_id) do update set role = excluded.role, role_id = excluded.role_id, active = excluded.active', :'co', 'f4100000-0000-0000-0000-000000000003', 'admin'), 'or re-invite their other account as admin (the invite route''s upsert)');
select t41.expect_error(format('update public.memberships set active = true where company_id = %L and user_id = %L', :'co', 'f4100000-0000-0000-0000-000000000011'), 'or bring back a removed admin');
select t41.expect_error(format('update public.memberships set user_id = %L where company_id = %L and user_id = %L', 'f4100000-0000-0000-0000-000000000010', :'co', 'f4100000-0000-0000-0000-000000000005'), 'or move a plain admin''s membership to another account');
select t41.expect_error(format('insert into public.company_roles (company_id, name, base_role, permissions) values (%L, %L, %L, %L)', :'co', 'Everything', 'admin', '{team,invoices}'), 'or make a role with areas they don''t have');
select t41.expect_error(format('update public.company_roles set permissions = %L where id = %L', '{schedule,equipment}', :'foreman_role'), 'or add areas to a role someone else has');
select t41.expect_error(format('delete from public.company_roles where id = %L', :'foreman_role'), 'or delete one (its people would get every area of their level)');

-- What they can do: invite and re-invite people with roles within their own, rename roles, set pay.
insert into public.memberships (company_id, user_id, role, role_id, active) values (:'co', 'f4100000-0000-0000-0000-000000000010', 'field_crew', :'employee_role', true)
  on conflict (company_id, user_id) do update set role = excluded.role, role_id = excluded.role_id, active = excluded.active;
select t41.check((select role_id from public.memberships where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000010') = :'employee_role', 'they still invite people as Employee');
insert into public.memberships (company_id, user_id, role, role_id, active) values (:'co', 'f4100000-0000-0000-0000-000000000003', 'field_crew', null, true)
  on conflict (company_id, user_id) do update set role = excluded.role, role_id = excluded.role_id, active = excluded.active;
select t41.check((select role from public.memberships where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000003') = 'field_crew', 'and re-invite someone as field crew');
-- (Admin access goes through the server, which asks for their password first.)
select t41.password_ok(:'co', 'f41000d0-0000-4000-8000-000000000001');
insert into public.company_roles (id, company_id, name, base_role, permissions) values ('f41000d0-0000-4000-8000-000000000001', :'co', 'Front desk', 'admin', '{team}') returning id as desk_role \gset
select t41.password_ok(:'co', 'f4100000-0000-0000-0000-000000000003');
update public.memberships set role_id = :'desk_role' where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000003';
select t41.check((select role from public.memberships where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000003') = 'admin', 'and give a role with only the areas they have, at their level');
update public.company_roles set name = 'Crew foreman' where id = :'foreman_role';
select t41.check((select name from public.company_roles where id = :'foreman_role') = 'Crew foreman', 'renaming a role with more areas is fine');
with changed as (update public.memberships set labor_rate = 40 where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000005' returning user_id)
select t41.check((select count(*) from changed) = 1, 'and so is setting a plain admin''s pay rate');
commit;
-- Nor can they bring a plain admin over from a business of their own, where they're the owner.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select public.create_company('Hal on the Side', 'general') as side \gset
select t41.password_ok(:'side', 'f4100000-0000-0000-0000-000000000012');
insert into public.memberships (company_id, user_id, role) values (:'side', 'f4100000-0000-0000-0000-000000000012', 'admin');
select t41.expect_error(format('update public.memberships set company_id = %L where company_id = %L and user_id = %L', :'co', :'side', 'f4100000-0000-0000-0000-000000000012'), 'or move a membership in from another business');
rollback;

-- A general manager (everything but connecting apps).
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t41.expect_error(format('update public.memberships set role = %L, role_id = null where company_id = %L and user_id = %L', 'admin', :'co', 'f4100000-0000-0000-0000-000000000003'), 'a general manager can''t make someone a plain admin (it includes apps)');
update public.memberships set role = 'office', role_id = null where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000003';
select t41.check((select role from public.memberships where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000003') = 'office', 'but makes them office');
select t41.password_ok(:'co', 'f4100000-0000-0000-0000-000000000003');
update public.memberships set role_id = :'gm_role' where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000003';
select t41.check((select role_id from public.memberships where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000003') = :'gm_role', 'or a general manager like them');
rollback;

-- A plain admin and the owner give any role.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t41.password_ok(:'co', 'f4100000-0000-0000-0000-000000000010');
update public.memberships set role = 'admin', role_id = null where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000010';
select t41.check((select role from public.memberships where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000010') = 'admin', 'a plain admin makes someone admin');
delete from public.company_roles where id = :'desk_role';
select t41.check((select role_id is null from public.memberships where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000003'), 'and deletes a role people have');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.memberships set active = true where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000011';
update public.company_roles set permissions = '{schedule,timesheets,equipment}' where id = :'foreman_role';
select t41.check((select active from public.memberships where company_id = :'co' and user_id = 'f4100000-0000-0000-0000-000000000011')
  and (select 'schedule' = any (permissions) from public.company_roles where id = :'foreman_role'), 'the owner brings people back and changes any role');
rollback;

-- ===== Job messages and crews ===================================================================
-- What the server writes: an automation's job email and note (with the contract total), a visit
-- reminder, Stripe's note about a payment with no invoice; and what the client and the team wrote.
insert into public.messages (company_id, client_id, channel, direction, body, related_type, related_id, sent_by, external_id) values
  (:'co', :'client', 'email', 'out', 'Your job is booked: $1,200.00', 'job', :'job', null, 'em_1'),
  (:'co', :'client', 'note', 'internal', 'Job total is $1,200.00', 'job', :'job', null, null),
  (:'co', :'client', 'sms', 'out', 'We''ll be there tomorrow', 'visit', :'visit', null, 'sm_1'),
  (:'co', :'client', 'note', 'internal', 'The client disputed the $1,200.00 payment with their bank', null, null, null, 'dp_1:opened'),
  (:'co', :'client', 'sms', 'in', 'Gate is on the left', null, null, null, 'SM_in'),
  (:'co', :'client', 'note', 'internal', 'Dog in the yard', null, null, 'f4100000-0000-0000-0000-000000000009', null);
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t41.check((select count(*) from public.messages where client_id = :'client' and body like '%$1,200%') = 0, 'crews don''t read job messages or payment notes (the contract total)');
select t41.check((select count(*) from public.messages where client_id = :'client') = 3, 'but still read the visit reminder, what the client wrote and the team''s notes');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t41.check((select count(*) from public.messages where client_id = :'client' and body like '%$1,200%') = 0, 'nor do crew leads');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
select t41.check((select count(*) from public.messages where client_id = :'client' and related_type = 'job') = 2, 'estimators (who see job totals) read job messages');
select t41.check((select count(*) from public.messages where client_id = :'client' and body like '%disputed%') = 0, 'but not payment notes');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select t41.check((select count(*) from public.messages where client_id = :'client') = 6, 'the office reads them all');
commit;

-- ===== Deleting a service that documents use ===================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Mulch beds') returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, service_id, name, quantity, unit, unit_price) values (:'co', :'quote', :'mulch', 'Mulch', 4, 'yd', 60) returning id as quote_line \gset
insert into public.invoices (company_id, client_id) values (:'co', :'client') returning id as invoice \gset
insert into public.invoice_line_items (company_id, invoice_id, service_id, name, quantity, unit, unit_price) values (:'co', :'invoice', :'mulch', 'Mulch', 4, 'yd', 60) returning id as invoice_line \gset
update public.invoices set status = 'sent' where id = :'invoice';
commit;
-- The client approves the quote in the Client Hub (the server).
update public.quotes set status = 'sent', sent_at = now() where id = :'quote';
update public.quotes set status = 'approved', approved_at = now() where id = :'quote';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select t41.expect_error(format('update public.quote_line_items set service_id = null, quantity = 1 where id = %L', :'quote_line'), 'an approved quote''s line can''t change along with clearing its service');
delete from public.services where id = :'mulch';
select t41.check((select count(*) from public.services where id = :'mulch') = 0, 'a service on an approved quote and a sent invoice can be deleted');
select t41.check((select service_id is null and unit_price = 60 from public.quote_line_items where id = :'quote_line')
  and (select service_id is null and unit_price = 60 from public.invoice_line_items where id = :'invoice_line'), 'their lines keep everything but the link to it');
select t41.expect_error(format('update public.quote_line_items set unit_price = 1 where id = %L', :'quote_line'), 'the approved quote''s lines still can''t change otherwise');
select t41.expect_error(format('update public.invoice_line_items set name = %L where id = %L', 'Free mulch', :'invoice_line'), 'nor can the sent invoice''s');
commit;

-- ===== A change order approved again ===========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title, change_order_for, discount_amount) values (:'co', :'client', 'Add edging', :'job', 30) returning id as change \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price, sort) values (:'co', :'change', 'Edging', 2, 'ea', 150, 0) returning id as edging \gset
commit;
update public.quotes set status = 'sent', sent_at = now() where id = :'change';
update public.quotes set status = 'approved', approved_at = now() where id = :'change';
select t41.check((select contract_total from public.job_financials where job_id = :'job') = 1470, 'an approved change order joins its job, less its discount (1200 + 300 - 30)');
-- Re-opened, changed (one more length of edging, lights, a bigger discount) and approved again.
update public.quotes set status = 'sent' where id = :'change';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
update public.quote_line_items set quantity = 3 where id = :'edging';
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price, sort) values (:'co', :'change', 'Lights', 1, 'ea', 200, 1);
update public.quotes set discount_amount = 50 where id = :'change';
commit;
update public.quotes set status = 'approved', approved_at = now() where id = :'change';
select t41.check((select status from public.quotes where id = :'change') = 'converted', 'approved again, it''s added to the job');
select t41.check((select contract_total from public.job_financials where job_id = :'job') = 1800, 'and the job''s total is what was approved last (1200 + 450 + 200 - 50)');
select t41.check((select string_agg(name || ' x' || quantity::integer, ', ' order by sort) from public.job_line_items where source_quote_id = :'change' and name <> 'Change order discount') = 'Edging x3, Lights x1', 'its lines on the job are its current ones, once');
select t41.check((select count(*) = 1 and sum(unit_price) = -50 from public.job_line_items where source_quote_id = :'change' and name = 'Change order discount'), 'with one discount, the current one');
select t41.check((select count(*) from public.job_line_items where job_id = :'job' and source_quote_id is null and name = 'Planting') = 1, 'and the job''s own lines stay');
-- A discount left on the job by a change order that was deleted, and one typed in by hand with the
-- same name, aren't a later change order's to take off when it's approved again.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title, change_order_for, discount_amount) values (:'co', :'client', 'Add a gate', :'job', 40) returning id as gate \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'gate', 'Gate', 1, 'ea', 300);
insert into public.quotes (company_id, client_id, title, change_order_for) values (:'co', :'client', 'Add a bench', :'job') returning id as bench \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'bench', 'Bench', 1, 'ea', 100);
commit;
update public.quotes set status = 'sent', sent_at = now() where id = :'gate';
update public.quotes set status = 'approved', approved_at = now() where id = :'gate';
update public.quotes set status = 'sent' where id = :'gate';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
delete from public.quotes where id = :'gate';
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'job', 'Change order discount', 1, 'ea', -10);
commit;
select t41.check((select contract_total from public.job_financials where job_id = :'job') = 2050, 'a deleted change order''s lines stay on the job (1800 + 300 - 40, and 10 off typed in)');
update public.quotes set status = 'sent', sent_at = now() where id = :'bench';
update public.quotes set status = 'approved', approved_at = now() where id = :'bench';
update public.quotes set status = 'sent' where id = :'bench';
update public.quotes set status = 'approved', approved_at = now() where id = :'bench';
select t41.check((select contract_total from public.job_financials where job_id = :'job') = 2150, 'a later change order approved twice adds only its own lines (2050 + 100)');
select t41.check((select count(*) from public.job_line_items where job_id = :'job' and name = 'Change order discount' and source_quote_id is null) = 2, 'and leaves the other discounts as they were');

-- ===== Number sequences behind hand-picked numbers =============================================
-- Documents numbered by hand ahead of the sequence (as the app allowed before), and a sequence
-- that's already further along than any document.
insert into public.quotes (company_id, client_id, title, number) values (:'co', :'client', 'Old quote', 500);
insert into public.invoices (company_id, client_id, number) values (:'co', :'client', 77);
insert into public.jobs (company_id, client_id, title, number) values (:'co', :'client', 'Old job', 40);
insert into public.requests (company_id, client_id, title, number) values (:'co', :'client', 'Old request', 3);
insert into public.number_sequences (company_id, kind, next_value) values (:'co', 'requests', 900)
  on conflict (company_id, kind) do update set next_value = excluded.next_value;
select private.catch_up_number_sequences();
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "f4100000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'New quote') returning number as quote_number \gset
insert into public.invoices (company_id, client_id) values (:'co', :'client') returning number as invoice_number \gset
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'New job') returning number as job_number \gset
insert into public.requests (company_id, client_id, title) values (:'co', :'client', 'New request') returning number as request_number \gset
select t41.check(:'quote_number' = '501' and :'invoice_number' = '78' and :'job_number' = '41', 'the next documents are numbered after the highest ones');
select t41.check(:'request_number' = '900', 'and a sequence never goes back');
commit;

\echo 'All review fix tests passed.'
