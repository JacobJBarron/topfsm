-- Database tests: tenant isolation, role rules, totals, numbering and SOP revisions.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema test;
grant usage on schema test to authenticated;

create function test.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;

create function test.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema test to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000001', 'owner@acme.test', '{"full_name": "Avery Owner"}'),
  ('a0000000-0000-0000-0000-000000000002', 'crew@acme.test', '{"full_name": "Casey Crew"}'),
  ('b0000000-0000-0000-0000-000000000001', 'owner@beta.test', '{"full_name": "Blake Owner"}');

select test.check((select count(*) from public.profiles where user_id in ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001')) = 3, 'sign-up creates profiles');

-- ===== Company A: owner sets up and sells a job =================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a0000000-0000-0000-0000-000000000001"}', true);

select public.create_company('Acme Lawn & Landscape', 'lawn_exterior') as company_a \gset
select test.check((select slug from public.companies where id = :'company_a') = 'acme-lawn-landscape', 'company slug from name');

insert into public.memberships (company_id, user_id, role)
values (:'company_a', 'a0000000-0000-0000-0000-000000000002', 'field_crew');

insert into public.clients (company_id, display_name, email) values (:'company_a', 'Jordan Rivera', 'jordan@example.com')
returning id as client_a \gset
insert into public.properties (company_id, client_id, line1, city, lat, lng)
values (:'company_a', :'client_a', '12 Main St', 'Radford', 37.13, -80.57) returning id as property_a \gset
insert into public.property_access (company_id, property_id, gate_code) values (:'company_a', :'property_a', '4321');

insert into public.quotes (company_id, client_id, property_id, title, tax_rate, total)
values (:'company_a', :'client_a', :'property_a', 'Driveway + edging', 0.05, 999999) returning id as quote_a, number as quote_no \gset
select test.check(:'quote_no'::int = 1, 'first quote is number 1');
select test.check((select total from public.quotes where id = :'quote_a') = 0, 'client-supplied total is ignored');

insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values
  (:'company_a', :'quote_a', 'Asphalt', 10, 150.00, true),
  (:'company_a', :'quote_a', 'Edging', 100, 2.50, false);
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, optional, selected)
values (:'company_a', :'quote_a', 'Sealcoat (optional)', 1, 400, true, false);

select test.check((select subtotal from public.quotes where id = :'quote_a') = 1750.00, 'quote subtotal excludes unselected options');
select test.check((select tax_amount from public.quotes where id = :'quote_a') = 75.00, 'tax only on taxable lines');
select test.check((select total from public.quotes where id = :'quote_a') = 1825.00, 'quote total');

insert into public.quotes (company_id, client_id, title) values (:'company_a', :'client_a', 'Second') returning number as quote_no2 \gset
select test.check(:'quote_no2'::int = 2, 'numbers increase per company');

select public.convert_quote_to_job(:'quote_a') as job_a \gset
select test.check((select contract_total from public.job_financials where job_id = :'job_a') = 1750.00, 'job copies selected lines');
select test.check((select status from public.quotes where id = :'quote_a') = 'converted', 'quote marked converted');
select test.check((select status from public.clients where id = :'client_a') = 'active', 'lead becomes active client');
select test.expect_error(format('select public.convert_quote_to_job(%L)', :'quote_a'), 'cannot convert twice');

select public.create_invoice_for_job(:'job_a') as invoice_a \gset
update public.invoices set status = 'sent', tax_rate = 0.05 where id = :'invoice_a';
select test.check((select total from public.invoices where id = :'invoice_a') = 1825.00, 'invoice total');
insert into public.payments (company_id, client_id, invoice_id, amount) values (:'company_a', :'client_a', :'invoice_a', 825.00);
select test.check((select status || ' ' || balance_due from public.invoices where id = :'invoice_a') = 'partially_paid 1000.00', 'partial payment');
insert into public.payments (company_id, client_id, invoice_id, amount) values (:'company_a', :'client_a', :'invoice_a', 1000.00);
select test.check((select status from public.invoices where id = :'invoice_a') = 'paid', 'paid in full');

-- A visit today for the crew member at the property with the gate code.
insert into public.visits (company_id, job_id, property_id, title, starts_at, ends_at)
-- Noon today in the company's zone: always "today" for the dashboard and inside the gate-code window.
values (:'company_a', :'job_a', :'property_a', 'Pave driveway',
        (date_trunc('day', now() at time zone 'America/New_York') + interval '12 hours') at time zone 'America/New_York',
        (date_trunc('day', now() at time zone 'America/New_York') + interval '14 hours') at time zone 'America/New_York')
returning id as visit_a \gset
insert into public.visit_assignees (company_id, visit_id, user_id) values (:'company_a', :'visit_a', 'a0000000-0000-0000-0000-000000000002');

update public.visits set hold_reason = 'Rain likely' where id = :'visit_a';
update public.visits set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = :'visit_a';
select test.check((select hold_reason from public.visits where id = :'visit_a') is null, 'moving a visit to another day clears its weather hold');
update public.visits set starts_at = starts_at - interval '1 day', ends_at = ends_at - interval '1 day' where id = :'visit_a';

-- SOPs: a published page and a draft.
insert into public.sop_pages (company_id, title, body_text, required) values (:'company_a', 'Hot-mix laydown temperatures', 'Minimum mat temperature is 250F at laydown.', true)
returning id as sop_a \gset
insert into public.sop_pages (company_id, title, status) values (:'company_a', 'Draft: new mower procedure', 'draft');
update public.sop_pages set body = '{"type":"doc","content":[{"type":"paragraph"}]}', body_text = 'Minimum mat temperature is 260F.' where id = :'sop_a';
select test.check((select revision from public.sop_pages where id = :'sop_a') = 2, 'editing a page bumps its revision');
select test.check((select count(*) from public.sop_revisions where page_id = :'sop_a') = 2, 'every revision is kept');
select test.check((select count(*) from public.search_sops(:'company_a', 'mat temperature')) = 1, 'full-text search finds the SOP');
update public.sop_pages set cover_path = :'company_a' || '/kb/cover.jpg' where id = :'sop_a';
select test.check((select revision from public.sop_pages where id = :'sop_a') = 2, 'a new cover photo is not a new revision');
select test.expect_error(format('update public.sop_pages set cover_path = %L where id = %L', 'b0000000-0000-0000-0000-000000000000/kb/cover.jpg', :'sop_a'), 'a cover photo comes from the company''s own folder');
select test.expect_error(format('update public.sop_pages set cover_path = %L where id = %L', :'company_a' || '/receipts/cover.jpg', :'sop_a'), 'a cover photo comes from the knowledge base folder');

select test.check((public.dashboard(:'company_a') -> 'workflow' -> 'quotes' ->> 'draft')::int = 1, 'dashboard counts draft quotes');
select test.check((public.dashboard(:'company_a') -> 'today' ->> 'total')::int = 1, 'dashboard lists today''s visit');

select test.expect_error(format('delete from public.memberships where company_id = %L and user_id = %L', :'company_a', 'a0000000-0000-0000-0000-000000000001'), 'last owner cannot leave');
select test.expect_error('select * from public.integration_secrets', 'browser can never read integration secrets');
commit;

-- ===== Company A: field crew =====================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a0000000-0000-0000-0000-000000000002"}', true);

select test.check((select count(*) from public.clients where company_id = :'company_a') = 1, 'crew can see clients');
select test.check((select count(*) from public.invoices) = 0, 'crew cannot see invoices');
select test.check((select count(*) from public.quote_line_items) = 0, 'crew cannot see quote line costs');
select test.check((select gate_code from public.property_access where property_id = :'property_a') = '4321', 'assigned crew sees gate code on visit day');
select test.check((select count(*) from public.sop_pages) = 1, 'crew sees published SOPs only');
select test.expect_error(format('insert into public.quotes (company_id, client_id, title) values (%L, %L, %L)', :'company_a', :'client_a', 'x'), 'crew cannot create quotes');

update public.visits set status = 'in_progress' where id = :'visit_a';
select test.check((select status from public.visits where id = :'visit_a') = 'in_progress', 'crew can update status on their visit');
select test.expect_error(format('update public.visits set starts_at = now() + interval ''2 days'' where id = %L', :'visit_a'), 'crew cannot reschedule');

insert into public.sop_acknowledgements (company_id, page_id, revision) values (:'company_a', :'sop_a', 2);
select test.expect_error(format('insert into public.sop_acknowledgements (company_id, page_id, revision) values (%L, %L, 1)', :'company_a', :'sop_a'), 'old revisions cannot be acknowledged');
commit;

-- ===== Company B: a different business sees none of A =========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b0000000-0000-0000-0000-000000000001"}', true);

select public.create_company('Beta Paving', 'paving') as company_b \gset
select test.check((select count(*) from public.clients) = 0, 'B sees no clients from A');
select test.check((select count(*) from public.quotes) = 0, 'B sees no quotes from A');
select test.check((select count(*) from public.companies) = 1, 'B sees only its own company');
select test.check((select count(*) from public.profiles) = 1, 'B sees only its own profile');
select test.expect_error(format('insert into public.clients (company_id, display_name) values (%L, %L)', :'company_a', 'Intruder'), 'B cannot write into A');
with changed as (update public.clients set display_name = 'Hacked' where id = :'client_a' returning 1)
select test.check((select count(*) from changed) = 0, 'B cannot update A rows');
-- (As field crew: joining as an owner or admin is refused before that, by admin_grants.)
select test.expect_error(format('insert into public.memberships (company_id, user_id, role) values (%L, %L, %L)', :'company_a', 'b0000000-0000-0000-0000-000000000001', 'field_crew'), 'B cannot join A');

-- Composite keys: B can't attach its own row to A's client even with a known id.
insert into public.clients (company_id, display_name) values (:'company_b', 'Beta client') returning id as client_b \gset
select test.expect_error(format('insert into public.quotes (company_id, client_id, title) values (%L, %L, %L)', :'company_b', :'client_a', 'x'), 'cross-company references are rejected');
commit;

\echo 'All database tests passed.'
