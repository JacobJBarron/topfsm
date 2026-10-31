-- Database tests for tax rates kept to 0.0001% (20261019001000_tax_rate_precision.sql): New York
-- City's 8.875% is stored as 0.08875 and charged as 8.875% on quotes, invoices and the invoices made
-- from a job, and the upgrade leaves rates and totals already stored as they were.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t87;
grant usage on schema t87 to authenticated, service_role;
create function t87.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t87.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t87 to authenticated, service_role;

select t87.check((select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.quotes'::regclass and attname = 'tax_rate') = 'numeric(8,6)', 'quotes keep six decimals of a tax rate');
select t87.check((select format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.invoices'::regclass and attname = 'tax_rate') = 'numeric(8,6)', 'and so do invoices');

insert into auth.users (id, email, raw_user_meta_data) values
  ('a8750000-0000-0000-0000-000000000001', 'owner@manhattan.test', '{"full_name": "Nia Owner"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8750000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Manhattan Windows', 'general') as co \gset
insert into public.clients (company_id, display_name) values (:'co', 'Park Avenue Co-op') returning id as client \gset

-- ===== 8.875% is 8.875% ========================================================================
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'client', 'Window cleaning', 0.08875) returning id as quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values
  (:'co', :'quote', 'Windows', 1, 1000, true),
  (:'co', :'quote', 'Travel', 1, 50, false);
select t87.check((select tax_rate = 0.08875 and tax_rate::text = '0.088750' from public.quotes where id = :'quote'), 'a quote keeps 8.875% as 0.08875');
-- 8.88% (the rate rounded to four decimals) would be $88.80.
select t87.check((select subtotal || '/' || tax_amount || '/' || total from public.quotes where id = :'quote') = '1050.00/88.75/1138.75', '8.875% of $1,000.00 taxable is $88.75');

insert into public.invoices (company_id, client_id, subject, tax_rate) values (:'co', :'client', 'Window cleaning', 0.08875) returning id as inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, taxable) values (:'co', :'inv', 'Windows', 1, 1000, true);
select t87.check((select tax_rate::text || '/' || tax_amount || '/' || total from public.invoices where id = :'inv') = '0.088750/88.75/1088.75', 'an invoice at 8.875% charges $88.75 on $1,000.00');

-- Other rates with a third decimal, and a rate typed with more decimals than are kept.
update public.invoices set tax_rate = 0.07375 where id = :'inv';
select t87.check((select tax_rate = 0.07375 and tax_amount = 73.75 from public.invoices where id = :'inv'), '7.375% stays 7.375%');
update public.invoices set tax_rate = 0.0887549 where id = :'inv';
select t87.check((select tax_rate::text || '/' || tax_amount from public.invoices where id = :'inv') = '0.088755/88.76', 'a rate is rounded to 0.0001%, and its tax half away from zero');
select t87.expect_error(format('update public.invoices set tax_rate = 1 where id = %L', :'inv'), 'a rate is still under 100%');
select t87.expect_error(format('update public.invoices set tax_rate = -0.000001 where id = %L', :'inv'), 'and not negative');

-- ===== The rate follows the work to its invoices ================================================
select public.convert_quote_to_job(:'quote') as job \gset
select public.create_invoice_for_job(:'job') as final \gset
select t87.check((select tax_rate::text || '/' || tax_amount from public.invoices where id = :'final') = '0.088750/88.75', 'the job''s invoice uses the quote''s 8.875%');

-- A job without a quote uses the company's default rate (its invoices used to have no tax).
update public.companies set settings = settings || '{"default_tax_rate": 0.09125}' where id = :'co';
insert into public.jobs (company_id, client_id, title) values (:'co', :'client', 'Storm windows') returning id as job2 \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit_price, taxable) values (:'co', :'job2', 'Storm windows', 1, 1000, true);
select public.create_invoice_for_job(:'job2') as inv2 \gset
select t87.check((select tax_rate::text || '/' || tax_amount from public.invoices where id = :'inv2') = '0.091250/91.25', 'a job without a quote is taxed at the company''s 9.125% default');
commit;

-- ===== The upgrade leaves what's stored as it was ================================================
-- Put the columns back the way a live instance had them, store rates there, and widen them again
-- as 20261019001000_tax_rate_precision.sql does. All rolled back. Referral credits follow invoices
-- at commit (20261031000100_referral_credits.sql), and a column can't change while that waits, so
-- here they follow as each statement ends.
begin;
set constraints referral_credits_follow immediate;
alter table public.quotes alter column tax_rate type numeric(6, 4);
alter table public.invoices alter column tax_rate type numeric(6, 4);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a8750000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'client', 'Texas job', 0.0825) returning id as old_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'old_quote', 'Windows', 1, 1000, true);
insert into public.invoices (company_id, client_id, subject, tax_rate) values (:'co', :'client', 'Texas job', 0.0825) returning id as old_inv \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, taxable) values (:'co', :'old_inv', 'Windows', 1, 1000, true);
-- What the old columns did to 8.875%.
insert into public.invoices (company_id, client_id, subject, tax_rate) values (:'co', :'client', 'Rounded', 0.08875) returning id as rounded \gset
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit_price, taxable) values (:'co', :'rounded', 'Windows', 1, 1000, true);
select q.tax_amount || '/' || q.total || '/' || q.updated_at as quote_before, i.tax_amount || '/' || i.total || '/' || i.updated_at as invoice_before
from public.quotes q, public.invoices i where q.id = :'old_quote' and i.id = :'old_inv' \gset
reset role;
select t87.check((select tax_rate = 0.0888 and tax_amount = 88.80 from public.invoices where id = :'rounded'), 'before the upgrade, 8.875% was stored as 0.0888 and charged $88.80');

alter table public.quotes alter column tax_rate type numeric(8, 6);
alter table public.invoices alter column tax_rate type numeric(8, 6);
select t87.check((select tax_rate = 0.0825 and tax_amount || '/' || total || '/' || updated_at = :'quote_before' from public.quotes where id = :'old_quote'), 'an existing quote at 8.25% is unchanged by the upgrade');
select t87.check((select tax_rate = 0.0825 and tax_amount || '/' || total || '/' || updated_at = :'invoice_before' from public.invoices where id = :'old_inv'), 'and so is an existing invoice');
select t87.check((select tax_rate = 0.0888 and tax_amount = 88.80 from public.invoices where id = :'rounded'), 'a rate already rounded stays as it was saved');
rollback;

\echo 'All tax rate precision tests passed.'
