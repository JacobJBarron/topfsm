-- Database tests for the audit fixes (20261018000100_audit_fixes.sql): who someone is, one business
-- per instance, time approval, what crews read, money records that stay put, document numbers,
-- approved quotes, change orders, custom roles, checklists, receipts, gate codes and meter dates.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t16;
grant usage on schema t16 to authenticated, service_role;
create function t16.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t16.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t16 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b1000000-0000-0000-0000-000000000001', 'owner@juliet.test', '{"full_name": "Jo Owner"}'),
  ('b1000000-0000-0000-0000-000000000002', 'office@juliet.test', '{"full_name": "Oli Office"}'),
  ('b1000000-0000-0000-0000-000000000003', 'lead@juliet.test', '{"full_name": "Lee Lead"}'),
  ('b1000000-0000-0000-0000-000000000004', 'emp@juliet.test', '{"full_name": "Em Ployee"}'),
  ('b1000000-0000-0000-0000-000000000005', 'mate@juliet.test', '{"full_name": "Mat Crewmate"}'),
  ('b1000000-0000-0000-0000-000000000006', 'sales@juliet.test', '{"full_name": "Sal Estimator"}'),
  ('b1000000-0000-0000-0000-000000000007', 'hr@juliet.test', '{"full_name": "Hari Admin"}'),
  ('b1000000-0000-0000-0000-000000000008', 'outsider@else.test', '{"full_name": "Out Sider"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Juliet Lawn', 'general') as co \gset
select id as foreman_role from public.company_roles where company_id = :'co' and name = 'Foreman' \gset
select id as employee_role from public.company_roles where company_id = :'co' and name = 'Employee' \gset
-- Admin access is given through the server (the admin_grants migration).
reset role;
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'HR admin', 'admin', '{team}') returning id as hr_role \gset
insert into public.memberships (company_id, user_id, role, role_id, labor_rate) values
  (:'co', 'b1000000-0000-0000-0000-000000000002', 'admin', null, 30),
  (:'co', 'b1000000-0000-0000-0000-000000000003', 'crew_lead', :'foreman_role', 34),
  (:'co', 'b1000000-0000-0000-0000-000000000004', 'field_crew', :'employee_role', 22),
  (:'co', 'b1000000-0000-0000-0000-000000000005', 'field_crew', :'employee_role', 21),
  (:'co', 'b1000000-0000-0000-0000-000000000006', 'estimator', null, null),
  (:'co', 'b1000000-0000-0000-0000-000000000007', 'admin', :'hr_role', null);
set local role authenticated;
insert into public.crews (company_id, name, lead_user_id) values (:'co', 'Mowing', 'b1000000-0000-0000-0000-000000000003') returning id as crew_a \gset
insert into public.crews (company_id, name) values (:'co', 'Trees') returning id as crew_b \gset
insert into public.crew_members (company_id, crew_id, user_id) values
  (:'co', :'crew_a', 'b1000000-0000-0000-0000-000000000004'), (:'co', :'crew_a', 'b1000000-0000-0000-0000-000000000005');
insert into public.clients (company_id, display_name) values (:'co', 'Maple Court HOA') returning id as client \gset
insert into public.clients (company_id, display_name) values (:'co', 'Drafty Client') returning id as client2 \gset
insert into public.properties (company_id, client_id, line1) values (:'co', :'client', '1 Maple Ct') returning id as prop \gset
insert into public.property_access (company_id, property_id, gate_code) values (:'co', :'prop', '1234#');
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'client', :'prop', 'Weekly mowing') returning id as job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'co', :'job', 'Mow', 1, 'visit', 100);
-- An anytime visit today (a day, no time) for crew A; a visit for crew B tomorrow.
insert into public.visits (company_id, job_id, property_id, title, crew_id, scheduled_on) values (:'co', :'job', :'prop', 'Mow Maple Ct', :'crew_a', private.company_today(:'co')) returning id as visit_a \gset
insert into public.visits (company_id, job_id, title, crew_id, scheduled_on) values (:'co', :'job', 'Trim trees', :'crew_b', private.company_today(:'co') + 1) returning id as visit_b \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'co', :'visit_a', 'b1000000-0000-0000-0000-000000000004');
-- A sent invoice (which billed visit A) with one line, a draft with one line, an empty draft, and a
-- draft for another client.
insert into public.invoices (company_id, client_id, job_id) values (:'co', :'client', :'job') returning id as inv_sent \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'co', :'inv_sent', 'Mow', 1, 'visit', 100) returning id as line_sent \gset
update public.invoices set status = 'sent', sent_at = now() where id = :'inv_sent';
update public.visits set invoice_id = :'inv_sent' where id = :'visit_a';
insert into public.invoices (company_id, client_id) values (:'co', :'client') returning id as inv_draft \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price) values (:'co', :'inv_draft', 'Edging', 1, 'ea', 40);
insert into public.invoices (company_id, client_id) values (:'co', :'client') returning id as inv_empty \gset
insert into public.invoices (company_id, client_id) values (:'co', :'client2') returning id as inv_client2 \gset
-- Messages: an invoice and a quote we sent (amounts and the client's Hub link), the client's reply
-- about the quote, and a plain note.
insert into public.messages (company_id, client_id, channel, direction, body, related_type, related_id) values
  (:'co', :'client', 'email', 'out', 'Here''s your invoice for $100.00: https://ops.test/hub/SIGNED', 'invoice', :'inv_sent'),
  (:'co', :'client', 'email', 'out', 'Here''s your quote ($900.00): https://ops.test/hub/SIGNED2', 'quote', null),
  (:'co', :'client', 'note', 'in', 'Can you start on Tuesday?', 'quote', null),
  (:'co', :'client', 'note', 'internal', 'Dog in the back yard', null, null);
insert into public.equipment (company_id, name, kind, meter, crew_id) values (:'co', 'Zero-turn', 'mower', 'hours', :'crew_a') returning id as mower \gset
commit;

-- ===== Who someone is =========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
update public.profiles set full_name = 'Em Ployee-Smith' where user_id = 'b1000000-0000-0000-0000-000000000004';
select t16.check((select full_name from public.profiles where user_id = 'b1000000-0000-0000-0000-000000000004') = 'Em Ployee-Smith', 'people still edit their own name');
select t16.expect_error('update public.profiles set email = ''new.hire@juliet.test'' where user_id = ''b1000000-0000-0000-0000-000000000004''', 'but not the email the invite and sign-in routes go by');
commit;

update auth.users set email = 'em.ployee@juliet.test' where id = 'b1000000-0000-0000-0000-000000000004';
select t16.check((select email from public.profiles where user_id = 'b1000000-0000-0000-0000-000000000004') = 'em.ployee@juliet.test', 'a changed sign-in email is copied to the profile');

begin;
set local role service_role;
select t16.check(public.user_id_for_email('  EM.Ployee@Juliet.TEST ') = 'b1000000-0000-0000-0000-000000000004', 'the server finds an account by its sign-in email, ignoring case and spaces');
select t16.check(public.user_id_for_email('em_ployee@juliet.test') is null, 'exactly: "_" is not a wildcard');
select t16.check(public.user_id_for_email('nobody@juliet.test') is null, 'and an unknown email finds no one');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t16.expect_error('select public.user_id_for_email(''owner@juliet.test'')', 'signed-in people can''t look up accounts by email');
commit;

-- ===== One business per instance ===============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
select t16.check(public.create_company('Elsewhere Ltd') is not null, 'without the instance setting, anyone signed in can start a business');
rollback;
begin;
insert into private.instance (single_company) values (true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t16.expect_error('select public.create_company(''Rogue Co'')', 'a one-business instance refuses a second business, even called directly');
rollback;
begin;
-- A brand-new one-business instance still gets its first business.
delete from public.companies;
insert into private.instance (single_company) values (true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
select t16.check(public.create_company('First Co') is not null, 'a one-business instance makes its first business');
select t16.expect_error('select public.create_company(''Second Co'')', 'and only that one');
rollback;

-- ===== Time is approved by people who may, at the real rate =====================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t16.expect_error(format('insert into public.time_entries (company_id, user_id, started_at, ended_at, approved_at) values (%L, %L, now() - interval ''3 hours'', now(), now())', :'co', 'b1000000-0000-0000-0000-000000000004'), 'an employee can''t add their own time already approved');
insert into public.time_entries (company_id, user_id, started_at, ended_at, labor_rate) values (:'co', 'b1000000-0000-0000-0000-000000000004', now() - interval '3 hours', now(), 999) returning id as te \gset
update public.time_entries set labor_rate = 150 where id = :'te';
commit;
-- Rates are read back as the test runner: nobody reads them on time entries directly.
select t16.check((select labor_rate from public.time_entries where id = :'te') is null, 'or choose their own pay rate when adding time');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t16.expect_error(format('insert into public.time_entries (company_id, user_id, started_at, ended_at, approved_at) values (%L, %L, now() - interval ''3 hours'', now(), now())', :'co', 'b1000000-0000-0000-0000-000000000004'), 'the starter Foreman (no timesheets area) can''t add approved time for the crew');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.time_entries set approved_at = now() where id = :'te';
commit;
select t16.check((select labor_rate from public.time_entries where id = :'te') = 22, 'approved time is paid at the person''s rate, not one they typed');

-- ===== What crews and estimators read ===========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t16.check((select count(*) from public.messages where company_id = :'co' and body like '%/hub/%') = 0, 'crews don''t read the invoices and quotes we send (amounts and the client''s Hub link)');
select t16.check((select count(*) from public.messages where company_id = :'co' and direction in ('in', 'internal')) = 2, 'but do read what the client wrote and notes about the client');
select t16.expect_error(format('insert into public.activity (company_id, verb, subject_type, subject_id, summary) values (%L, %L, %L, %L, %L)', :'co', 'invoice.overdue', 'invoice', :'inv_sent', 'Invoice overdue'), 'nobody adds activity by hand (it sets off emails and texts to clients)');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t16.check((select count(*) from public.messages where company_id = :'co' and body like '%/hub/%') = 0, 'the Foreman doesn''t read them either');
commit;

insert into public.activity (company_id, actor_id, verb, subject_type, subject_id, summary) values
  (:'co', null, 'invoice.sent', 'invoice', :'inv_sent', 'Invoice #1 sent ($100.00)'),
  (:'co', null, 'visit.completed', 'visit', :'visit_a', 'Mow Maple Ct done');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t16.check((select count(*) from public.messages where company_id = :'co' and related_type = 'quote' and direction = 'out') = 1, 'estimators read the quotes we send');
select t16.check((select count(*) from public.messages where company_id = :'co' and related_type = 'invoice') = 0, 'but not invoices');
select t16.check((select count(*) from public.activity where company_id = :'co' and subject_type = 'invoice') = 0, 'or invoice activity');
select t16.check((select count(*) from public.activity where company_id = :'co' and summary = 'Mow Maple Ct done') = 1, 'while other activity shows as before');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t16.check((select count(*) from public.messages where company_id = :'co' and related_type = 'invoice') = 1, 'the office reads invoice messages');
select t16.check((select count(*) from public.activity where company_id = :'co' and summary = 'Invoice #1 sent ($100.00)') = 1, 'and invoice activity');
commit;

-- ===== Visits ==================================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t16.expect_error(format('update public.visits set invoice_id = null where id = %L', :'visit_a'), 'the crew can''t un-bill a visit (it would be billed again)');
update public.visits set status = 'en_route' where id = :'visit_a';
select t16.check((select status from public.visits where id = :'visit_a') = 'en_route', 'but still updates its status');
select t16.check((select gate_code from public.property_access where property_id = :'prop') = '1234#', 'and sees the gate code all day on an anytime visit, in the company''s time zone');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select t16.expect_error(format('update public.visits set status = %L where id = %L', 'cancelled', :'visit_b'), 'the Foreman can''t cancel another crew''s visit');
update public.visits set notes = 'Bring the edger' where id = :'visit_a';
select t16.check((select notes from public.visits where id = :'visit_a') = 'Bring the edger', 'but changes their own crew''s');
commit;

-- ===== Checklists follow the visit ==============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
insert into public.checklist_responses (company_id, visit_id, answers) values (:'co', :'visit_a', '{"gate_closed": true}');
select t16.check((select count(*) from public.checklist_responses where visit_id = :'visit_a') = 1, 'someone on the visit''s crew fills in its checklist');
select t16.expect_error(format('insert into public.checklist_responses (company_id, visit_id, answers) values (%L, %L, %L)', :'co', :'visit_b', '{}'), 'but not another crew''s');
commit;

-- ===== Receipts in Storage =====================================================================
insert into storage.objects (bucket_id, name, owner) values
  ('files', :'co' || '/receipts/fuel.jpg', 'b1000000-0000-0000-0000-000000000002'),
  ('files', :'co' || '/visits/' || :'visit_a' || '/after.jpg', 'b1000000-0000-0000-0000-000000000002');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t16.check((select count(*) from storage.objects where name like :'co' || '/receipts/%') = 0, 'an employee can''t list other people''s receipts');
select t16.check((select count(*) from storage.objects where name like :'co' || '/visits/%') = 1, 'but sees visit photos as before');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t16.check((select count(*) from storage.objects where name like :'co' || '/receipts/%') = 1, 'whoever uploaded a receipt still sees it');
commit;

-- ===== Document numbers and approved quotes =====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title, number) values (:'co', :'client', 'Spring cleanup', 999999) returning id as quote, number as quote_number \gset
select t16.check(:'quote_number'::bigint <> 999999, 'document numbers come from the sequence, not the request');
select t16.expect_error(format('update public.quotes set number = 424242 where id = %L', :'quote'), 'and don''t change afterwards');
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'quote', 'Cleanup', 1, 'ea', 300);
commit;
-- The client approves it in the Client Hub (the server, as the service role).
update public.quotes set status = 'sent', sent_at = now() where id = :'quote';
update public.quotes set status = 'approved', approved_at = now() where id = :'quote';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t16.expect_error(format('update public.quote_line_items set unit_price = 1 where quote_id = %L', :'quote'), 'an approved quote keeps the prices the client approved');
commit;

-- A change order approved, re-opened and approved again joins its job once.
insert into public.quotes (company_id, client_id, title, change_order_for) values (:'co', :'client', 'Add aeration', :'job') returning id as change \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'co', :'change', 'Aeration', 1, 'ea', 250);
update public.quotes set status = 'sent', sent_at = now() where id = :'change';
update public.quotes set status = 'approved', approved_at = now() where id = :'change';
update public.quotes set status = 'sent' where id = :'change';
update public.quotes set status = 'approved', approved_at = now() where id = :'change';
select t16.check((select count(*) from public.job_line_items where job_id = :'job' and source_quote_id = :'change') = 1, 'a change order approved twice adds its lines to the job once');
select t16.check((select status from public.quotes where id = :'change') = 'converted', 'and is marked added to the job');

-- ===== Invoices stay on record ==================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t16.expect_error(format('delete from public.invoices where id = %L', :'inv_sent'), 'a sent invoice can''t be deleted (void it instead)');
select t16.expect_error(format('update public.invoice_line_items set invoice_id = %L where id = %L', :'inv_draft', :'line_sent'), 'a sent invoice''s line can''t be moved onto a draft');
delete from public.invoices where id = :'inv_empty';
select t16.check((select count(*) from public.invoices where id = :'inv_empty') = 0, 'a draft without payments is deleted');
update public.invoices set status = 'void' where id = :'inv_sent';
select t16.expect_error(format('update public.invoices set status = %L where id = %L', 'sent', :'inv_sent'), 'a void invoice stays void (its visits may be on a new one)');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t16.expect_error(format('delete from public.clients where id = %L', :'client'), 'a client with invoices on record is archived, not deleted');
delete from public.clients where id = :'client2';
select t16.check((select count(*) from public.invoices where id = :'inv_client2') = 0, 'a client with only a draft is deleted, draft and all');
commit;

-- ===== Custom roles can't loosen themselves =====================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t16.expect_error(format('update public.memberships set role_id = null where company_id = %L and user_id = %L', :'co', 'b1000000-0000-0000-0000-000000000007'), 'an admin with a custom role can''t take it off themselves');
select t16.expect_error(format('update public.company_roles set permissions = %L where id = %L', '{team,invoices}', :'hr_role'), 'or add areas to the role they have');
update public.company_roles set name = 'People admin' where id = :'hr_role';
select t16.check((select name from public.company_roles where id = :'hr_role') = 'People admin', 'renaming it is fine');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.company_roles set permissions = '{team,invoices}' where id = :'hr_role';
select t16.check((select 'invoices' = any (permissions) from public.company_roles where id = :'hr_role'), 'the owner changes it');
commit;

-- ===== Meter readings ==========================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1000000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t16.expect_error(format('insert into public.equipment_logs (company_id, equipment_id, kind, done_on, meter_reading) values (%L, %L, %L, %L, 1)', :'co', :'mower', 'reading', '2099-01-01'), 'a meter reading can''t be dated in the future');
insert into public.equipment_logs (company_id, equipment_id, kind, done_on, meter_reading) values (:'co', :'mower', 'reading', private.company_today(:'co'), 120);
select t16.check((select count(*) from public.equipment_logs where equipment_id = :'mower') = 1, 'today''s reading is logged');
commit;

\echo 'All audit fix tests passed.'
