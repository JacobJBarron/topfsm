-- Database tests for activity events, automations, billing v2, marketing, notifications and privacy.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t2;
grant usage on schema t2 to authenticated, service_role;

create function t2.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAIL: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;

create function t2.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t2 to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000000-0000-0000-0000-000000000001', 'owner@gamma.test', '{"full_name": "Gale Owner"}'),
  ('c0000000-0000-0000-0000-000000000002', 'crew@gamma.test', '{"full_name": "Cory Crew"}');

-- ===== Owner: company, clients, a custom automation =============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);

select public.create_company('Gamma Exteriors', 'general') as co \gset
select t2.check((select count(*) from public.automation_rules where company_id = :'co') > 0, 'new companies get starter automations');
update public.companies set settings = settings || '{"default_tax_rate": 0.1, "payment_terms_days": 15}' where id = :'co';
insert into public.memberships (company_id, user_id, role, labor_rate) values (:'co', 'c0000000-0000-0000-0000-000000000002', 'field_crew', 28);

insert into public.clients (company_id, display_name, email, status, tags) values
  (:'co', 'Ana Active', 'ana@example.com', 'active', '{VIP}'),
  (:'co', 'Ben Lead', 'BEN@example.com', 'lead', '{}'),
  (:'co', 'Opted Out', 'out@example.com', 'active', '{VIP}'),
  (:'co', 'Bad Email', 'not-an-email', 'active', '{}'),
  (:'co', 'Ana Duplicate', 'ANA@example.com ', 'active', '{}');
update public.clients set marketing_opt_out = true where company_id = :'co' and display_name = 'Opted Out';
select id as ana from public.clients where company_id = :'co' and display_name = 'Ana Active' \gset
select id as ben from public.clients where company_id = :'co' and display_name = 'Ben Lead' \gset

insert into public.automation_rules (company_id, name, trigger, delay_minutes, conditions, actions, enabled)
values (:'co', 'Follow up on sent quotes', 'quote.sent', 4320, '[]', '[{"type": "notify", "to": "office", "title": "Follow up"}]', true)
returning id as rule \gset
select t2.expect_error(format('insert into public.automation_rules (company_id, name, trigger, conditions, actions) values (%L, %L, %L, %L, %L)', :'co', 'Bad', 'not a verb', '[]', '[{"type":"notify"}]'), 'rule triggers must look like noun.verb');
select t2.expect_error(format('insert into public.automation_rules (company_id, name, trigger, conditions, actions) values (%L, %L, %L, %L, %L)', :'co', 'No actions', 'quote.sent', '[]', '[]'), 'rules need at least one action');

-- ===== Activity events queue automation runs ==================================================
insert into public.quotes (company_id, client_id, title) values (:'co', :'ana', 'Roof repair') returning id as q1, number as q1_no \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'q1', 'Shingle repair', 1, 1000, true);
update public.quotes set status = 'sent' where id = :'q1';
select t2.check((select count(*) from public.activity where subject_id = :'q1' and verb = 'quote.sent') = 1, 'sending a quote records quote.sent');
select t2.check((select count(*) from public.automation_runs where rule_id = :'rule' and subject_id = :'q1' and status = 'pending') = 1, 'a matching enabled rule queues a run');
select t2.check((select run_after from public.automation_runs where rule_id = :'rule' and subject_id = :'q1') > now() + interval '71 hours', 'the run waits for the rule''s delay');
select t2.expect_error(format('update public.automation_runs set status = %L where rule_id = %L', 'done', :'rule'), 'the browser can''t change automation runs');
update public.automation_rules set enabled = false where id = :'rule';
select t2.check((select status from public.automation_runs where rule_id = :'rule' and subject_id = :'q1') = 'cancelled', 'turning a rule off cancels its waiting runs');
select t2.expect_error('select * from public.claim_automation_runs(5)', 'only the engine can claim runs');

-- ===== Global search ========================================================================
select t2.check((select count(*) from public.global_search(:'co', 'ana') where kind = 'client') = 2, 'search finds clients by name');
select t2.check((select count(*) from public.global_search(:'co', '#' || :'q1_no') where kind = 'quote') = 1, 'search finds quotes by number');
select t2.check((select count(*) from public.global_search(:'co', '%_')) = 0, 'search treats % and _ literally');

-- ===== Billing v2: deposit, progress, final with credits ======================================
-- The rate on the quote is what the client approved, so invoices use it.
update public.quotes set status = 'approved', tax_rate = 0.10 where id = :'q1';
select public.convert_quote_to_job(:'q1') as job \gset
select public.create_invoice_for_job(:'job', 'deposit', 100) as inv_dep \gset
select t2.check((select subtotal || '/' || tax_amount || '/' || total from public.invoices where id = :'inv_dep') = '100.00/0.00/100.00', 'deposit invoice bills the deposit, untaxed');
select public.create_invoice_for_job(:'job', 'progress', 250) as inv_prog \gset
select t2.check((select subtotal || '/' || tax_amount || '/' || total from public.invoices where id = :'inv_prog') = '250.00/25.00/275.00', 'progress invoice bills the amount, taxed');
select t2.check((select pay_app_number from public.invoices where id = :'inv_prog') = 1, 'progress invoices are numbered as pay applications');
select t2.expect_error(format('select public.create_invoice_for_job(%L, %L, 0)', :'job', 'progress'), 'progress invoices need an amount');
select t2.expect_error(format('select public.create_invoice_for_job(%L, %L)', :'job', 'bogus'), 'unknown invoice types are rejected');
select public.create_invoice_for_job(:'job') as inv_final \gset
-- 1000 of work - 250 progress (taxable) - 100 deposit (untaxed) = 650; tax on 750 = 75.
select t2.check((select subtotal || '/' || tax_amount || '/' || total from public.invoices where id = :'inv_final') = '650.00/75.00/725.00', 'final invoice credits deposit and progress without double-taxing');
select t2.check((select due_on from public.invoices where id = :'inv_final') = (select (now() at time zone timezone)::date + 15 from public.companies where id = :'co'), 'due date follows payment terms, from the company''s local date');

-- ===== Invoice status events (status set by triggers, not by the UPDATE itself) ================
update public.invoices set status = 'sent' where id = :'inv_prog';
insert into public.payments (company_id, client_id, invoice_id, amount) values (:'co', :'ana', :'inv_prog', 275);
select t2.check((select status from public.invoices where id = :'inv_prog') = 'paid', 'a full payment marks the invoice paid');
select t2.check((select count(*) from public.activity where subject_id = :'inv_prog' and verb = 'invoice.paid') = 1, 'paying by payment records invoice.paid');

update public.invoices set status = 'sent' where id = :'inv_final';
insert into public.payments (company_id, client_id, invoice_id, amount) values (:'co', :'ana', :'inv_final', 100);
select t2.check((select status from public.invoices where id = :'inv_final') = 'partially_paid', 'a partial payment before the due date is partially paid');
update public.invoices set due_on = current_date - 3 where id = :'inv_final';
select t2.check((select status from public.invoices where id = :'inv_final') = 'overdue', 'a past-due balance is overdue even if partly paid');
select t2.check((select count(*) from public.activity where subject_id = :'inv_final' and verb = 'invoice.overdue') = 1, 'going past due records invoice.overdue');
select t2.expect_error('select public.mark_overdue_invoices()', 'only the scheduler can run the overdue sweep');

-- ===== Per-visit billing ======================================================================
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on) values (:'co', :'ben', 'Weekly gutter checks', 'recurring', 'FREQ=WEEKLY', current_date - 14) returning id as job2 \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price, taxable) values (:'co', :'job2', 'Gutter check', 1, 80, false);
insert into public.visits (company_id, job_id, title, status, scheduled_on, completed_at) values
  (:'co', :'job2', 'Visit 1', 'completed', current_date - 7, now() - interval '7 days'),
  (:'co', :'job2', 'Visit 2', 'completed', current_date - 1, now() - interval '1 day'),
  (:'co', :'job2', 'Visit 3', 'scheduled', current_date + 6, null);
select public.create_invoice_for_job(:'job2', 'visits') as inv_visits \gset
select t2.check((select subtotal from public.invoices where id = :'inv_visits') = 160.00, 'visits invoice bills each completed visit');
select t2.check((select count(*) from public.visits where job_id = :'job2' and invoice_id = :'inv_visits') = 2, 'billed visits remember their invoice');
select t2.expect_error(format('select public.create_invoice_for_job(%L, %L)', :'job2', 'visits'), 'visits are never billed twice');
update public.invoices set status = 'void' where id = :'inv_visits';
select t2.check((select count(*) from public.visits where job_id = :'job2' and invoice_id is not null) = 0, 'voiding releases the visits for billing again');

-- ===== Campaigns ============================================================================
select t2.check((select count(*) from public.campaign_audience(:'co', '{}')) = 2, 'audience: valid, opted-in, one per email address');
select t2.check((select count(*) from public.campaign_audience(:'co', '{"statuses": ["active"]}')) = 1, 'audience: filter by status');
select t2.check((select email from public.campaign_audience(:'co', '{"tags_any": ["VIP"]}')) = 'ana@example.com', 'audience: tags (opted-out excluded)');
select t2.check((select count(*) from public.campaign_audience(:'co', '{"tags_none": ["VIP"]}') where display_name <> 'Ana Active') = 2, 'audience: excluded tags');
insert into public.campaigns (company_id, name, subject, body) values (:'co', 'Spring tune-up', 'Book now', 'Hi {first_name}') returning id as camp \gset
update public.campaigns set subject = 'Book your spring tune-up' where id = :'camp';
select t2.expect_error(format('update public.campaigns set status = %L where id = %L', 'sent', :'camp'), 'the browser can''t mark a campaign sent');
select t2.expect_error(format('insert into public.campaign_recipients (company_id, campaign_id, email) values (%L, %L, %L)', :'co', :'camp', 'x@example.com'), 'the browser can''t add recipients');
commit;

-- The sender (no end-user role) moves the campaign along; then it's locked for editing.
update public.campaigns set status = 'sending' where name = 'Spring tune-up';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t2.expect_error($$update public.campaigns set subject = 'Changed' where name = 'Spring tune-up'$$, 'sending campaigns can''t be edited');
select t2.expect_error($$delete from public.campaigns where name = 'Spring tune-up'$$, 'sending campaigns can''t be deleted');
commit;

-- ===== Referrals advance with the referred client's quotes ===================================
select id as co from public.companies where name = 'Gamma Exteriors' \gset
select id as ana from public.clients where company_id = :'co' and display_name = 'Ana Active' \gset
select id as ben from public.clients where company_id = :'co' and display_name = 'Ben Lead' \gset
insert into public.referrals (company_id, referrer_client_id, referred_client_id, referred_name) values (:'co', :'ana', :'ben', 'Ben Lead') returning id as ref \gset
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0000000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t2.expect_error(format('insert into public.referrals (company_id, referrer_client_id, referred_name) values (%L, %L, %L)', :'co', :'ana', 'Fake'), 'referrals are only created by the referral page');
insert into public.quotes (company_id, client_id, title) values (:'co', :'ben', 'Gutters') returning id as q2 \gset
update public.quotes set status = 'sent' where id = :'q2';
select t2.check((select status from public.referrals where id = :'ref') = 'quoted', 'referral moves to quoted when the friend gets a quote');
update public.quotes set status = 'approved' where id = :'q2';
select t2.check((select status from public.referrals where id = :'ref') = 'won', 'referral is won when the quote is approved');
select t2.check((select reward_status from public.referrals where id = :'ref') = 'pending', 'and its credit waits for the friend to pay their first invoice');
commit;

-- ===== Notifications are private to each person =============================================
insert into public.notifications (company_id, user_id, title) values
  (:'co', 'c0000000-0000-0000-0000-000000000001', 'For the owner'),
  (:'co', 'c0000000-0000-0000-0000-000000000002', 'For the crew');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select t2.check((select count(*) from public.notifications) = 1, 'people only see their own notifications');
with changed as (update public.notifications set read_at = now() where title = 'For the owner' returning 1)
select t2.check((select count(*) from changed) = 0, 'people can''t mark someone else''s notifications read');
select t2.expect_error(format('insert into public.notifications (company_id, user_id, title) values (%L, %L, %L)', :'co', 'c0000000-0000-0000-0000-000000000002', 'Spoof'), 'notifications come from the engine only');

-- ===== Pay rates stay with the office =========================================================
select t2.check((select count(*) from public.memberships where company_id = :'co') = 2, 'crew can see who is on the team');
select t2.expect_error('select labor_rate from public.memberships', 'crew can''t read pay rates');

-- ===== Crew activity feed and files ===========================================================
select t2.check((select count(*) from public.activity where verb like 'quote.%') = 0, 'crew don''t see sales activity');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name) values (:'co', 'job', :'co', :'co' || '/job/' || :'co' || '/photo.jpg', 'photo.jpg') returning id as mine \gset
commit;

insert into public.attachments (company_id, owner_type, owner_id, path, file_name, created_by)
values (:'co', 'job', :'co', :'co' || '/job/' || :'co' || '/receipt.jpg', 'receipt.jpg', 'c0000000-0000-0000-0000-000000000001');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0000000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
with gone as (delete from public.attachments where file_name = 'receipt.jpg' returning 1)
select t2.check((select count(*) from gone) = 0, 'crew can''t delete files others uploaded');
with gone as (delete from public.attachments where file_name = 'photo.jpg' returning 1)
select t2.check((select count(*) from gone) = 1, 'crew can delete their own uploads');
commit;

-- ===== The overdue sweep uses each company's local date =======================================
alter table public.invoices disable trigger invoice_totals;
update public.invoices set status = 'sent', due_on = current_date - 2 where company_id = :'co' and kind = 'deposit';
alter table public.invoices enable trigger invoice_totals;
set role service_role;
select public.mark_overdue_invoices() as swept \gset
reset role;
select t2.check(:'swept'::int >= 1, 'the overdue sweep flags past-due invoices');
select t2.check((select status from public.invoices where company_id = :'co' and kind = 'deposit') = 'overdue', 'swept invoice is overdue');
select t2.check((select count(*) from public.activity a join public.invoices i on i.id = a.subject_id where i.company_id = :'co' and i.kind = 'deposit' and a.verb = 'invoice.overdue') = 1, 'the sweep records invoice.overdue for automations');

\echo 'All v2 feature tests passed.'
