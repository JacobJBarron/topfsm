-- Database tests for promo codes once per job (20261031000600_promo_once_per_job.sql): on weekly
-- mowing a $25 code comes off the first invoice only, whichever way invoices are made, never takes an
-- invoice below $0, moves to the next invoice when its invoice is voided or deleted or it's taken off
-- a draft (and never back by itself, but Undo brings it back off the draft it moved to, both parts of
-- a split one), is never doubled (Undo, a change order approved again, a quote deleted), and a code
-- set to every visit comes off every visit; deleting a draft takes the job's lock before the client's;
-- codes already on jobs become once per job without changing invoices already made; a promo code
-- can't change while a bank payment clears, as the app counts one
-- (20261031000610_promo_bank_payments.sql); and a quote keeps the rule it was signed with, a deleted
-- code leaves its rule on quotes, and an invoice takes one code, whichever comes first
-- (20261031000630_promo_undo_and_signed_rule.sql). Begin and commit blocks, so the triggers that wait
-- for commit run.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tpo;
grant usage on schema tpo to authenticated, service_role;
create function tpo.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function tpo.expect_error(p_sql text, p_what text, p_like text default null) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_like is not null and sqlerrm not ilike p_like then
      raise exception 'FAIL (wrong error "%"): %', sqlerrm, p_what;
    end if;
    raise notice 'ok - % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;

-- A weekly mowing job made from an approved quote: one mowing at p_price, taxed at 5%, with p_code on the quote.
create function tpo.mowing(p_client uuid, p_code text, p_price numeric default 40) returns uuid language plpgsql as $$
declare v_co uuid; v_quote uuid; v_job uuid;
begin
  select company_id into v_co from public.clients where id = p_client;
  insert into public.quotes (company_id, client_id, title, tax_rate) values (v_co, p_client, 'Weekly mowing', 0.05) returning id into v_quote;
  insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable, sort) values (v_co, v_quote, 'Mowing', 1, p_price, true, 0);
  if p_code is not null then perform public.apply_promo_code('quote', v_quote, p_code); end if;
  update public.quotes set status = 'approved', approved_at = now() where id = v_quote;
  v_job := public.convert_quote_to_job(v_quote);
  update public.jobs set kind = 'recurring', recurrence_rule = 'FREQ=WEEKLY;BYDAY=MO', billing_mode = 'per_visit', starts_on = '2026-06-01' where id = v_job;
  return v_job;
end $$;
-- A mowing done on p_day.
create function tpo.mowed(p_job uuid, p_day date) returns uuid language plpgsql as $$
declare v_visit uuid;
begin
  insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at)
  select company_id, id, 'Mowing', 'job', 'completed', p_day, (p_day + time '15:00') at time zone 'UTC' from public.jobs where id = p_job
  returning id into v_visit;
  return v_visit;
end $$;
-- The completed visits' invoice, as Invoices → batch and the job page's Invoice visits make it.
create function tpo.bill(p_job uuid) returns uuid language sql as $$ select public.create_invoice_for_job(p_job, 'visits') $$;
-- What an invoice's promo lines take off.
create function tpo.off(p_invoice uuid) returns numeric language sql as $$
  select coalesce(-sum(round(quantity * unit_price, 2)) filter (where discount_quote_id is not null), 0) from public.invoice_line_items where invoice_id = p_invoice
$$;
-- An invoice's promo lines, taxed (T) and untaxed (U): 'T20.00 U5.00'.
create function tpo.parts(p_invoice uuid) returns text language sql as $$
  select coalesce(string_agg(case when taxable then 'T' else 'U' end || round(-quantity * unit_price, 2), ' ' order by taxable desc, sort), '')
    from public.invoice_line_items where invoice_id = p_invoice and discount_quote_id is not null
$$;
-- A weekly mowing ($40, taxed) and bagging ($10, untaxed) job with WEEKLY25 on its quote: $20 taxed and $5 not.
create function tpo.split_job(p_client uuid) returns uuid language plpgsql as $$
declare v_co uuid; v_quote uuid; v_job uuid;
begin
  select company_id into v_co from public.clients where id = p_client;
  insert into public.quotes (company_id, client_id, title, tax_rate) values (v_co, p_client, 'Mowing and bagging', 0.05) returning id into v_quote;
  insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable, sort) values
    (v_co, v_quote, 'Mowing', 1, 40, true, 0), (v_co, v_quote, 'Bagging', 1, 10, false, 1);
  perform public.apply_promo_code('quote', v_quote, 'WEEKLY25');
  update public.quotes set status = 'approved', approved_at = now() where id = v_quote;
  v_job := public.convert_quote_to_job(v_quote);
  update public.jobs set kind = 'recurring', recurrence_rule = 'FREQ=WEEKLY;BYDAY=MO', billing_mode = 'per_visit', starts_on = '2026-06-01' where id = v_job;
  return v_job;
end $$;
create function tpo.figures(p_invoice uuid) returns text language sql as $$
  select subtotal || '/' || tax_amount || '/' || total from public.invoices where id = p_invoice
$$;
create function tpo.send(p_invoice uuid) returns void language sql as $$ update public.invoices set status = 'sent' where id = p_invoice $$;
-- What a job's invoices that aren't void take off for its promo discounts.
create function tpo.job_off(p_job uuid) returns numeric language sql as $$
  select coalesce(sum(tpo.off(id)), 0) from public.invoices where job_id = p_job and status <> 'void'
$$;
grant execute on all functions in schema tpo to authenticated, service_role;

-- Liz owns Meadow Lawn; Ed is an estimator (sales, no Invoices).
insert into auth.users (id, email, raw_user_meta_data) values
  ('b9f50000-0000-0000-0000-000000000001', 'liz@meadow.test', '{"full_name": "Liz Meadow"}'),
  ('b9f50000-0000-0000-0000-000000000002', 'ed@meadow.test', '{"full_name": "Ed Estimator"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Meadow Lawn', 'lawn_care') as co \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'b9f50000-0000-0000-0000-000000000002', 'estimator');
insert into public.clients (company_id, display_name) values (:'co', 'Mo Weekly') returning id as mo \gset
insert into public.clients (company_id, display_name) values (:'co', 'Rae Referrer') returning id as rae \gset
insert into public.promo_codes (company_id, code, kind, value, once_per_client) values
  (:'co', 'WEEKLY25', 'amount', 25, false), (:'co', 'FREE40', 'amount', 40, false), (:'co', 'TEN', 'percent', 10, false),
  (:'co', 'CO10', 'amount', 10, false), (:'co', 'SPRING5', 'amount', 5, false), (:'co', 'THANKS5', 'amount', 5, false);
insert into public.promo_codes (company_id, code, kind, value, once_per_client, every_visit) values (:'co', 'EVERY5', 'amount', 5, false, true);
select tpo.check((select count(*) = 6 from public.promo_codes where company_id = :'co' and not every_visit), 'a new code comes off once per job unless it says otherwise');

-- ===== Once per job: the first invoice only ======================================================
select tpo.mowing(:'mo', 'WEEKLY25') as job1 \gset
select tpo.check((select string_agg(name || ' ' || unit_price || ' ' || coalesce(discount_billing, '-') || ' ' || (discount_key is not null), ', ' order by sort) from public.job_line_items where job_id = :'job1')
  = 'Mowing 40.00 - false, Promo code WEEKLY25 -25.00 once true', 'the job''s promo line is marked once per job, with its quote');
select tpo.check((select discount_key = quote_id from public.job_line_items l join public.jobs j on j.id = l.job_id where l.job_id = :'job1' and l.discount_key is not null), 'keyed by the job''s quote');
select tpo.mowed(:'job1', '2026-06-01');
select tpo.bill(:'job1') as a1 \gset
select tpo.check(tpo.off(:'a1') = 25 and tpo.figures(:'a1') = '15.00/0.75/15.75', 'the first mowing''s invoice takes $25 off, before 5% tax');
select tpo.check((select taxable from public.invoice_line_items where invoice_id = :'a1' and discount_quote_id is not null), 'and its line is taxed like the job''s');
select tpo.send(:'a1');
select tpo.mowed(:'job1', '2026-06-08');
select tpo.bill(:'job1') as a2 \gset
select tpo.check(tpo.off(:'a2') = 0 and tpo.figures(:'a2') = '40.00/2.00/42.00', 'the second mowing is full price');
select tpo.send(:'a2');
select tpo.mowed(:'job1', '2026-06-15');
select tpo.bill(:'job1') as a3 \gset
select tpo.check(tpo.off(:'a3') = 0 and tpo.figures(:'a3') = '40.00/2.00/42.00', 'and so is the third');

-- Three visits on one invoice take $25 off, not $75.
select tpo.mowing(:'mo', 'WEEKLY25') as job2 \gset
select tpo.mowed(:'job2', d) from unnest('{2026-06-01,2026-06-08,2026-06-15}'::date[]) d;
select tpo.bill(:'job2') as b1 \gset
select tpo.check(tpo.off(:'b1') = 25 and tpo.figures(:'b1') = '95.00/4.75/99.75', 'a batch of three visits takes $25 off once');
select tpo.check((select count(*) = 1 from public.invoice_line_items where invoice_id = :'b1' and discount_quote_id is not null), 'on one line');
select tpo.check((select sort > all (select sort from public.invoice_line_items where invoice_id = :'b1' and discount_quote_id is null) from public.invoice_line_items where invoice_id = :'b1' and discount_quote_id is not null),
  'after all the visits');

-- A code worth a whole mowing.
select tpo.mowing(:'mo', 'FREE40') as job3 \gset
select tpo.mowed(:'job3', '2026-06-01');
select tpo.bill(:'job3') as c1 \gset
select tpo.send(:'c1');
select tpo.mowed(:'job3', '2026-06-08');
select tpo.bill(:'job3') as c2 \gset
select tpo.check(tpo.figures(:'c1') = '0.00/0.00/0.00' and tpo.figures(:'c2') = '40.00/2.00/42.00', 'a $40 code on a $40 mowing: the first is free, the next isn''t');

-- The mowing price lowered to $15 on the job: never below $0, and the rest on the next one.
select tpo.mowing(:'mo', 'WEEKLY25') as job4 \gset
update public.job_line_items set unit_price = 15 where job_id = :'job4' and name = 'Mowing';
select tpo.mowed(:'job4', '2026-06-01');
select tpo.bill(:'job4') as d1 \gset
select tpo.check(tpo.off(:'d1') = 15 and tpo.figures(:'d1') = '0.00/0.00/0.00', 'a $15 mowing takes $15 of the code, to $0');
select tpo.send(:'d1');
select tpo.mowed(:'job4', '2026-06-08');
select tpo.bill(:'job4') as d2 \gset
select tpo.check(tpo.off(:'d2') = 10 and tpo.figures(:'d2') = '5.00/0.25/5.25', 'and the next takes the other $10');
select tpo.mowed(:'job4', '2026-06-15');
select tpo.bill(:'job4') as d3 \gset
select tpo.check(tpo.off(:'d3') = 0, 'then none');

-- A draft's price lowered after the code went on: cut back to $0, the rest on the next invoice.
select tpo.mowing(:'mo', 'WEEKLY25') as job4b \gset
select tpo.mowed(:'job4b', '2026-06-01');
select tpo.bill(:'job4b') as e1 \gset
update public.invoice_line_items set unit_price = 15 where invoice_id = :'e1' and name = 'Mowing';
select tpo.check(tpo.off(:'e1') = 15 and tpo.figures(:'e1') = '0.00/0.00/0.00', 'a draft lowered to $15 under a $25 code comes to $0, not -$10');
select tpo.check(not exists (select 1 from public.job_discount_skips where invoice_id = :'e1'), 'that isn''t taking it off by hand');
select tpo.mowed(:'job4b', '2026-06-08');
select tpo.bill(:'job4b') as e2 \gset
select tpo.check(tpo.off(:'e2') = 10, 'the $10 it couldn''t take goes on the next invoice');
update public.invoice_line_items set unit_price = 40 where invoice_id = :'e1' and name = 'Mowing';
select tpo.check(tpo.off(:'e1') = 15 and tpo.job_off(:'job4b') = 25, 'raised again, nothing more comes off: $25 in all');

-- Out of order: the third mowing's invoice made first takes it.
select tpo.mowing(:'mo', 'WEEKLY25') as job5 \gset
select tpo.mowed(:'job5', '2026-06-15');
select tpo.bill(:'job5') as f3 \gset
select tpo.mowed(:'job5', '2026-06-01');
select tpo.bill(:'job5') as f1 \gset
select tpo.check(tpo.off(:'f3') = 25 and tpo.off(:'f1') = 0, 'the first invoice made takes it, whichever mowing it''s for');

-- Every visit: $5 off each one, a batch's too, and never below $0.
select tpo.mowing(:'mo', 'EVERY5') as job6 \gset
select tpo.check((select discount_billing = 'every_visit' from public.job_line_items where job_id = :'job6' and discount_key is not null), 'a code set to every visit marks its line so');
select tpo.mowed(:'job6', '2026-06-01');
select tpo.bill(:'job6') as g1 \gset
select tpo.check(tpo.off(:'g1') = 5 and tpo.figures(:'g1') = '35.00/1.75/36.75', 'every visit: $5 off the first mowing');
select tpo.mowed(:'job6', d) from unnest('{2026-06-08,2026-06-15}'::date[]) d;
select tpo.bill(:'job6') as g2 \gset
select tpo.check(tpo.off(:'g2') = 10 and (select count(*) = 2 from public.invoice_line_items where invoice_id = :'g2' and discount_quote_id is not null), 'and $5 off each mowing in a batch');
update public.invoice_line_items set unit_price = 3 where invoice_id = :'g1' and name = 'Mowing';
select tpo.check(tpo.off(:'g1') = 3 and tpo.figures(:'g1') = '0.00/0.00/0.00', 'a mowing lowered to $3 takes $3 of it, not -$2');
update public.invoice_line_items set unit_price = 2 where invoice_id = :'g2' and name = 'Mowing';
select tpo.check(tpo.off(:'g2') = 4 and tpo.figures(:'g2') = '0.00/0.00/0.00', 'two mowings lowered to $2: their $10 off is cut to $4');
select tpo.check((select count(*) = 2 from public.invoice_line_items where invoice_id = :'g2' and discount_quote_id is not null), 'and both lines stay, one at $0');
update public.invoice_line_items set unit_price = 40 where invoice_id = :'g1' and name = 'Mowing';
select tpo.check(tpo.off(:'g1') = 5 and tpo.figures(:'g1') = '35.00/1.75/36.75', 'raised again, the mowing takes its whole $5 off again');
update public.invoice_line_items set unit_price = 40 where invoice_id = :'g2' and name = 'Mowing';
select tpo.check(tpo.off(:'g2') = 10, 'and the two in the batch their $10');

-- 10% of $40 is $4, once: not worked out again on a batch.
select tpo.mowing(:'mo', 'TEN') as job7 \gset
select tpo.mowed(:'job7', d) from unnest('{2026-06-01,2026-06-08,2026-06-15}'::date[]) d;
select tpo.bill(:'job7') as h1 \gset
select tpo.check(tpo.off(:'h1') = 4 and tpo.figures(:'h1') = '116.00/5.80/121.80', 'a 10% code takes the $4 the quote showed, once');
select tpo.mowed(:'job7', '2026-06-22');
select tpo.check(tpo.off(tpo.bill(:'job7')) = 0, 'and not again');

-- The job page's switch, both ways.
select tpo.mowing(:'mo', 'WEEKLY25') as job8 \gset
select discount_key as key8 from public.job_line_items where job_id = :'job8' and discount_key is not null \gset
select tpo.check(public.set_job_discount_billing(:'job8', :'key8', true) = 1, 'a job''s discount switched to every visit');
select tpo.mowed(:'job8', '2026-06-01');
select tpo.check(tpo.off(tpo.bill(:'job8')) = 25, 'comes off the first mowing');
select tpo.mowed(:'job8', '2026-06-08');
select tpo.check(tpo.off(tpo.bill(:'job8')) = 25, 'and the second');
select tpo.check(public.set_job_discount_billing(:'job8', :'key8', false) = 1, 'switched back to the first invoice only');
select tpo.mowed(:'job8', '2026-06-15');
select tpo.check(tpo.off(tpo.bill(:'job8')) = 0, 'it''s been taken off already, so not again');
select tpo.mowing(:'mo', 'EVERY5') as job9 \gset
select discount_key as key9 from public.job_line_items where job_id = :'job9' and discount_key is not null \gset
select public.set_job_discount_billing(:'job9', :'key9', false);
select tpo.mowed(:'job9', d) from unnest('{2026-06-01,2026-06-08}'::date[]) d;
select tpo.check(tpo.off(tpo.bill(:'job9')) = 5, 'an every-visit code switched to once comes off once');
select tpo.check(public.set_job_discount_billing(:'job9', :'key9', false) = 0, 'switching to what it is changes nothing');

-- What a discount can't be.
select tpo.expect_error(format('update public.job_line_items set discount_billing = %L, discount_key = gen_random_uuid() where job_id = %L and name = %L', 'once', :'job9', 'Mowing'),
  'a mowing can''t be held back from invoices as a discount', '%job_line_items_discount_check%');
select tpo.expect_error(format('update public.job_line_items set discount_key = null where job_id = %L and discount_key is not null', :'job9'),
  'a discount line keeps its key', '%job_line_items_discount_check%');

-- ===== Deposits, progress billing and a one-off job's final invoice ==============================
insert into public.quotes (company_id, client_id, title, tax_rate, deposit_amount) values (:'co', :'mo', 'Patio', 0.05, 200) returning id as patio_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'patio_quote', 'Patio', 1, 1000, true);
select public.apply_promo_code('quote', :'patio_quote', 'WEEKLY25');
update public.quotes set status = 'approved', approved_at = now() where id = :'patio_quote';
select public.convert_quote_to_job(:'patio_quote') as patio \gset
select public.create_invoice_for_job(:'patio', 'deposit') as deposit \gset
select public.create_invoice_for_job(:'patio', 'progress', 300) as progress \gset
select tpo.check(tpo.off(:'deposit') = 0 and tpo.off(:'progress') = 0, 'a deposit and progress billing don''t take the code');
select public.create_invoice_for_job(:'patio') as final \gset
select tpo.check((select string_agg(left(name, 12) || ' ' || unit_price, ', ' order by sort) from public.invoice_line_items where invoice_id = :'final')
  = 'Patio 1000.00, Promo code W -25.00, Less deposit -200.00, Less progres -300.00', 'the final invoice takes it where it always did');
select tpo.check(tpo.figures(:'final') = '475.00/33.75/508.75', 'with the same figures as before');
commit;

-- ===== Voided or deleted: it goes on the next invoice =============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.mowing(:'mo', 'WEEKLY25') as job10 \gset
select tpo.mowed(:'job10', '2026-06-01');
select tpo.bill(:'job10') as i1 \gset
select tpo.mowed(:'job10', '2026-06-08');
select tpo.bill(:'job10') as i2 \gset
select tpo.mowing(:'mo', 'WEEKLY25') as job11 \gset
select tpo.mowed(:'job11', '2026-06-01');
select tpo.bill(:'job11') as k1 \gset
select tpo.mowed(:'job11', '2026-06-08');
select tpo.bill(:'job11') as k2 \gset
select tpo.send(:'k2');
select tpo.mowing(:'mo', 'WEEKLY25') as job12 \gset
select tpo.mowed(:'job12', '2026-06-01');
select tpo.bill(:'job12') as m1 \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.invoices set status = 'void' where id in (:'i1', :'k1');
delete from public.invoices where id = :'m1';
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.check(tpo.off(:'i2') = 25 and tpo.job_off(:'job10') = 25, 'the first draft voided: the open draft after it takes the $25 at commit');
select tpo.check(tpo.figures(:'i1') = '15.00/0.75/15.75' and tpo.off(:'i1') = 25, 'the void invoice keeps the figures it was voided with');
select tpo.check((select sent_at is null from public.invoices where id = :'i1'), 'a draft voided isn''t given a sent date (20261031000640_void_draft_not_sent.sql)');
select tpo.check(tpo.off(:'k2') = 0 and tpo.figures(:'k2') = '40.00/2.00/42.00', 'one already sent isn''t changed');
select tpo.mowed(:'job11', '2026-06-15');
select tpo.bill(:'job11') as k3 \gset
select tpo.check(tpo.off(:'k3') = 25 and tpo.job_off(:'job11') = 25, 'the next invoice made takes it instead');
select tpo.bill(:'job12') as m2 \gset
select tpo.check(tpo.off(:'m2') = 25, 'a deleted draft''s discount goes on the next invoice, for the same mowing');
commit;

-- ===== Taken off a draft by hand, and Undo ==========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- No other draft: it waits for the next invoice, which takes it, and never goes back on the first.
select tpo.mowing(:'mo', 'WEEKLY25') as job13 \gset
select tpo.mowed(:'job13', '2026-06-01');
select tpo.bill(:'job13') as n1 \gset
delete from public.invoice_line_items where invoice_id = :'n1' and discount_quote_id is not null;
select tpo.check(tpo.off(:'n1') = 0 and exists (select 1 from public.job_discount_skips where invoice_id = :'n1'), 'taken off a draft by hand, it stays off');
select tpo.mowed(:'job13', '2026-06-08');
select tpo.bill(:'job13') as n2 \gset
select tpo.check(tpo.off(:'n1') = 0 and tpo.off(:'n2') = 25, 'the next invoice takes it, not the draft it came off');
-- Other drafts open: it goes on the next at once, and Undo takes it back off that one.
select tpo.mowing(:'mo', 'WEEKLY25') as job14 \gset
select tpo.mowed(:'job14', '2026-06-01');
select tpo.bill(:'job14') as p1 \gset
select tpo.mowed(:'job14', '2026-06-08');
select tpo.bill(:'job14') as p2 \gset
select tpo.mowed(:'job14', '2026-06-15');
select tpo.bill(:'job14') as p3 \gset
select company_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id as p_key from public.invoice_line_items where invoice_id = :'p1' and discount_quote_id is not null \gset p_
delete from public.invoice_line_items where invoice_id = :'p1' and discount_quote_id is not null;
select tpo.check(tpo.off(:'p1') = 0 and tpo.off(:'p2') = 25 and tpo.off(:'p3') = 0, 'with other drafts open, it goes on the next one');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id)
values (:'p_company_id', :'p1', :'p_name', :'p_quantity', :'p_unit', :'p_unit_price', :'p_taxable', :'p_sort', :'p_p_key');
select tpo.check(tpo.off(:'p1') = 25 and tpo.off(:'p2') = 0 and tpo.off(:'p3') = 0 and tpo.figures(:'p2') = '40.00/2.00/42.00', 'Undo puts it back on the first and takes it off the draft it moved to');
select tpo.check(not exists (select 1 from public.job_discount_skips where invoice_id in (:'p1', :'p2', :'p3')), 'and nothing is left marked as taken off');
-- Taken off again, it goes on the second draft; once that one is sent, Undo is refused.
delete from public.invoice_line_items where invoice_id = :'p1' and discount_quote_id is not null;
select tpo.check(tpo.off(:'p2') = 25, 'taken off again, it goes on the next draft again');
select number as p2_number from public.invoices where id = :'p2' \gset
select tpo.send(:'p2');
select tpo.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id) values (%L, %L, %L, %s, %L, %s, %L, %s, %L)',
  :'p_company_id', :'p1', :'p_name', :'p_quantity', :'p_unit', :'p_unit_price', :'p_taxable', :'p_sort', :'p_p_key'),
  'Undo can''t put it back once the invoice it went on is sent', format('%%went on invoice #%s after it came off here, so it can''t go back on this one%%', :'p2_number'));
select tpo.check(tpo.off(:'p1') = 0 and tpo.off(:'p2') = 25 and tpo.off(:'p3') = 0, 'and it stays where it went');
-- Undo with nowhere else for it: it's back, and the next invoice doesn't take it again.
select tpo.mowing(:'mo', 'WEEKLY25') as job15 \gset
select tpo.mowed(:'job15', '2026-06-01');
select tpo.bill(:'job15') as q1 \gset
select company_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id as q_key from public.invoice_line_items where invoice_id = :'q1' and discount_quote_id is not null \gset q_
delete from public.invoice_line_items where invoice_id = :'q1' and discount_quote_id is not null;
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id)
values (:'q_company_id', :'q1', :'q_name', :'q_quantity', :'q_unit', :'q_unit_price', :'q_taxable', :'q_sort', :'q_q_key');
select tpo.check(tpo.off(:'q1') = 25 and not exists (select 1 from public.job_discount_skips where invoice_id = :'q1'), 'Undo puts it back on the draft');
select tpo.mowed(:'job15', '2026-06-08');
select tpo.check(tpo.off(tpo.bill(:'job15')) = 0, 'and the next invoice doesn''t take it again');
select tpo.expect_error(format('update public.invoice_line_items set unit_price = -40 where invoice_id = %L and discount_quote_id is not null', :'q1'),
  'a promo line can''t be made bigger than the code', '%more than is left of Promo code WEEKLY25%');
select tpo.expect_error(format('update public.invoice_line_items set discount_quote_id = gen_random_uuid() where invoice_id = %L and name = %L', :'q1', 'Mowing'),
  'a mowing can''t be made a promo line', '%stays linked%');
commit;

-- ===== The Taxable box on a promo line ============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- Unticked on a draft's promo line (the line editor saves the box on its own): still $25 off, on one line.
select tpo.mowing(:'mo', 'WEEKLY25', 50) as job22 \gset
select tpo.mowed(:'job22', '2026-06-01');
select tpo.bill(:'job22') as t1 \gset
update public.invoice_line_items set taxable = false where invoice_id = :'t1' and discount_quote_id is not null;
select tpo.check(tpo.off(:'t1') = 25 and (select count(*) = 1 from public.invoice_line_items where invoice_id = :'t1' and discount_quote_id is not null)
  and tpo.figures(:'t1') = '25.00/2.50/27.50', 'Taxable unticked on a draft''s promo line: still $25 off, not $50');
update public.invoice_line_items set taxable = true where invoice_id = :'t1' and discount_quote_id is not null;
select tpo.check(tpo.off(:'t1') = 25 and tpo.figures(:'t1') = '25.00/1.25/26.25', 'and ticked again');
select tpo.send(:'t1');
-- Unticked on the job's own promo line: the next mowing still isn't discounted.
update public.job_line_items set taxable = false where job_id = :'job22' and discount_key is not null;
select tpo.mowed(:'job22', '2026-06-08');
select tpo.bill(:'job22') as t2 \gset
select tpo.check(tpo.off(:'t2') = 0 and tpo.job_off(:'job22') = 25, 'Taxable unticked on the job''s promo line: the next invoice doesn''t take it again');
update public.invoice_line_items set description = 'Front only' where invoice_id = :'t2' and name = 'Mowing';
select tpo.check(tpo.off(:'t2') = 0, 'nor when one of its lines changes');
-- A discount split over taxed and untaxed work: one part's box changed on the draft.
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'mo', 'Mowing and bagging', 0.05) returning id as split_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable, sort) values
  (:'co', :'split_quote', 'Mowing', 1, 40, true, 0), (:'co', :'split_quote', 'Bagging', 1, 10, false, 1);
select public.apply_promo_code('quote', :'split_quote', 'WEEKLY25');
update public.quotes set status = 'approved', approved_at = now() where id = :'split_quote';
select public.convert_quote_to_job(:'split_quote') as job25 \gset
update public.jobs set kind = 'recurring', recurrence_rule = 'FREQ=WEEKLY;BYDAY=MO', billing_mode = 'per_visit', starts_on = '2026-06-01' where id = :'job25';
select tpo.mowed(:'job25', '2026-06-01');
select tpo.bill(:'job25') as t3 \gset
select tpo.check(tpo.off(:'t3') = 25 and (select count(*) = 2 from public.invoice_line_items where invoice_id = :'t3' and discount_quote_id is not null), 'a split discount: $20 taxed and $5 not');
update public.invoice_line_items set taxable = true where invoice_id = :'t3' and discount_quote_id is not null and not taxable;
select tpo.check(tpo.off(:'t3') = 25, 'the untaxed part ticked Taxable: still $25 off');
commit;

-- ===== Undo of a discount in two parts, taxed and untaxed ==========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- Both parts taken off the first draft go on the second; Undo the taxed part first, then the untaxed.
select tpo.split_job(:'mo') as job29 \gset
select tpo.mowed(:'job29', '2026-06-01');
select tpo.bill(:'job29') as sa \gset
select tpo.mowed(:'job29', '2026-06-08');
select tpo.bill(:'job29') as sb \gset
select tpo.check(tpo.parts(:'sa') = 'T20.00 U5.00' and tpo.parts(:'sb') = '', 'a split discount: $20 taxed and $5 untaxed on the first draft');
select company_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id as k from public.invoice_line_items where invoice_id = :'sa' and discount_quote_id is not null and taxable \gset sat_
select company_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id as k from public.invoice_line_items where invoice_id = :'sa' and discount_quote_id is not null and not taxable \gset sau_
delete from public.invoice_line_items where invoice_id = :'sa' and discount_quote_id is not null and taxable;
delete from public.invoice_line_items where invoice_id = :'sa' and discount_quote_id is not null and not taxable;
select tpo.check(tpo.parts(:'sa') = '' and tpo.parts(:'sb') = 'T20.00 U5.00', 'both parts taken off, one at a time: both go on the next draft');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id)
values (:'sat_company_id', :'sa', :'sat_name', :'sat_quantity', :'sat_unit', :'sat_unit_price', :'sat_taxable', :'sat_sort', :'sat_k');
select tpo.check(tpo.parts(:'sa') = 'T20.00' and tpo.parts(:'sb') = 'U5.00', 'Undo of the taxed part takes the taxed part back, not the untaxed one');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id)
values (:'sau_company_id', :'sa', :'sau_name', :'sau_quantity', :'sau_unit', :'sau_unit_price', :'sau_taxable', :'sau_sort', :'sau_k');
select tpo.check(tpo.parts(:'sa') = 'T20.00 U5.00' and tpo.parts(:'sb') = '' and tpo.figures(:'sb') = '50.00/2.00/52.00',
  'and Undo of the untaxed part then takes it back too: the first draft as it was, the second without it');
select tpo.check(not exists (select 1 from public.job_discount_skips where invoice_id in (:'sa', :'sb')), 'with nothing left marked as taken off');
-- The other order: the untaxed part first.
select tpo.split_job(:'mo') as job30 \gset
select tpo.mowed(:'job30', '2026-06-01');
select tpo.bill(:'job30') as sc \gset
select tpo.mowed(:'job30', '2026-06-08');
select tpo.bill(:'job30') as sd \gset
select company_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id as k from public.invoice_line_items where invoice_id = :'sc' and discount_quote_id is not null and taxable \gset sct_
select company_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id as k from public.invoice_line_items where invoice_id = :'sc' and discount_quote_id is not null and not taxable \gset scu_
delete from public.invoice_line_items where invoice_id = :'sc' and discount_quote_id is not null and taxable;
delete from public.invoice_line_items where invoice_id = :'sc' and discount_quote_id is not null and not taxable;
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id)
values (:'scu_company_id', :'sc', :'scu_name', :'scu_quantity', :'scu_unit', :'scu_unit_price', :'scu_taxable', :'scu_sort', :'scu_k');
select tpo.check(tpo.parts(:'sc') = 'U5.00' and tpo.parts(:'sd') = 'T20.00', 'Undo of the untaxed part first takes back the untaxed part');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id)
values (:'sct_company_id', :'sc', :'sct_name', :'sct_quantity', :'sct_unit', :'sct_unit_price', :'sct_taxable', :'sct_sort', :'sct_k');
select tpo.check(tpo.parts(:'sc') = 'T20.00 U5.00' and tpo.parts(:'sd') = '' and not exists (select 1 from public.job_discount_skips where invoice_id in (:'sc', :'sd')),
  'then the taxed part: the first draft as it was, the second without it');
commit;

-- ===== Every visit: a copy cut back comes back ======================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.mowing(:'mo', 'EVERY5') as job23 \gset
select tpo.mowed(:'job23', '2026-06-01');
select tpo.bill(:'job23') as u1 \gset
-- The mowing removed (to put another service in, say): the $5 line stays at $0, and Undo brings it back.
select company_id, name, description, quantity, unit, unit_price, taxable, sort from public.invoice_line_items where invoice_id = :'u1' and name = 'Mowing' \gset u_
delete from public.invoice_line_items where invoice_id = :'u1' and name = 'Mowing';
select tpo.check(tpo.figures(:'u1') = '0.00/0.00/0.00' and (select unit_price = 0 from public.invoice_line_items where invoice_id = :'u1' and discount_quote_id is not null),
  'the mowing removed: the every-visit line stays, at $0');
insert into public.invoice_line_items (company_id, invoice_id, name, description, quantity, unit, unit_price, taxable, sort)
values (:'u_company_id', :'u1', :'u_name', :'u_description', :'u_quantity', :'u_unit', :'u_unit_price', :'u_taxable', :'u_sort');
select tpo.check(tpo.off(:'u1') = 5 and tpo.figures(:'u1') = '35.00/1.75/36.75', 'Undo puts the mowing back, and its $5 off with it');
-- Cut by hand, it stays cut; taken off, it stays off. The next visit has its own.
update public.invoice_line_items set unit_price = -2 where invoice_id = :'u1' and discount_quote_id is not null;
update public.invoice_line_items set unit_price = 1 where invoice_id = :'u1' and name = 'Mowing';
update public.invoice_line_items set unit_price = 40 where invoice_id = :'u1' and name = 'Mowing';
select tpo.check(tpo.off(:'u1') = 1, 'cut to $2 by hand, then the price lowered and raised: it doesn''t grow back past what was left');
delete from public.invoice_line_items where invoice_id = :'u1' and discount_quote_id is not null;
update public.invoice_line_items set unit_price = 45 where invoice_id = :'u1' and name = 'Mowing';
select tpo.check(tpo.off(:'u1') = 0, 'taken off by hand, it stays off');
select tpo.mowed(:'job23', '2026-06-08');
select tpo.check(tpo.off(tpo.bill(:'job23')) = 5, 'and the next visit takes its $5');
commit;

-- ===== Never taken: retainage, and drafts with a payment or in Stripe ==============================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- A one-off job holding back 10%: the code taken off its final draft waits, and the retainage
-- invoice never takes it.
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'mo', 'Driveway', 0.05) returning id as drive_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'drive_quote', 'Driveway', 1, 1000, true);
select public.apply_promo_code('quote', :'drive_quote', 'WEEKLY25');
update public.quotes set status = 'approved', approved_at = now() where id = :'drive_quote';
select public.convert_quote_to_job(:'drive_quote') as drive \gset
update public.jobs set retainage_pct = 10 where id = :'drive';
select public.create_invoice_for_job(:'drive') as drive_final \gset
delete from public.invoice_line_items where invoice_id = :'drive_final' and discount_quote_id is not null;
select tpo.send(:'drive_final');
select public.create_invoice_for_job(:'drive', 'retainage') as drive_retainage \gset
update public.invoice_line_items set description = 'Held back on the final invoice' where invoice_id = :'drive_retainage';
select tpo.check(tpo.off(:'drive_retainage') = 0 and (public.job_promo_discounts(:'drive') -> 0 ->> 'left')::numeric = 25,
  'a retainage invoice never takes the code, even while it waits');
-- Weekly mowing: three drafts, the second with a check recorded and the third paid by bank through Stripe.
select tpo.mowing(:'mo', 'WEEKLY25') as job24 \gset
select tpo.mowed(:'job24', '2026-06-01');
select tpo.bill(:'job24') as w1 \gset
select tpo.mowed(:'job24', '2026-06-08');
select tpo.bill(:'job24') as w2 \gset
select tpo.mowed(:'job24', '2026-06-15');
select tpo.bill(:'job24') as w3 \gset
commit;
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'mo', :'w2', 10, 'check');
insert into public.stripe_invoices (company_id, invoice_id, origin, status, amount_due, stripe_id) values (:'co', :'w3', 'crewtavo', 'processing', 42, 'in_w3');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.invoices set status = 'void' where id = :'w1';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.check((select status = 'draft' from public.invoices where id = :'w2'), 'the draft with a check is still a draft');
select tpo.check(tpo.off(:'w2') = 0 and tpo.off(:'w3') = 0, 'the first draft voided: the code passes over a draft with a payment and one with a bank payment on its way');
update public.invoice_line_items set description = 'Front and back' where invoice_id = :'w2' and name = 'Mowing';
select tpo.check(tpo.off(:'w2') = 0, 'nor when one of its lines changes');
select tpo.mowed(:'job24', '2026-06-22');
select tpo.bill(:'job24') as w4 \gset
select tpo.check(tpo.off(:'w4') = 25 and tpo.job_off(:'job24') = 25, 'the next invoice takes it');
commit;

-- ===== Never doubled: a change order approved again, a quote deleted ===============================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.mowing(:'mo', 'WEEKLY25') as job16 \gset
insert into public.quotes (company_id, client_id, title, tax_rate, change_order_for) values (:'co', :'mo', 'Add edging', 0.05, :'job16') returning id as edging \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'edging', 'Edging', 1, 20, true);
select public.apply_promo_code('quote', :'edging', 'CO10');
update public.quotes set status = 'sent', sent_at = now() where id = :'edging';
update public.quotes set status = 'approved', approved_at = now() where id = :'edging';
select tpo.check((select discount_billing = 'once' and discount_key = :'edging' from public.job_line_items where job_id = :'job16' and name = 'Change order discount'),
  'a change order''s code is once per job too, keyed by the change order');
select tpo.mowed(:'job16', '2026-06-01');
select tpo.bill(:'job16') as r1 \gset
select tpo.check(tpo.off(:'r1') = 35 and tpo.figures(:'r1') = '25.00/1.25/26.25', 'the first invoice takes the job''s code and the change order''s');
select tpo.send(:'r1');
update public.quotes set status = 'sent' where id = :'edging';
update public.quotes set status = 'approved', approved_at = now() where id = :'edging';
select tpo.check((select count(*) = 1 from public.job_line_items where job_id = :'job16' and name = 'Change order discount'), 'approved again, its discount is on the job once');
select tpo.mowed(:'job16', '2026-06-08');
select tpo.bill(:'job16') as r2 \gset
select tpo.check(tpo.off(:'r2') = 0 and tpo.figures(:'r2') = '60.00/3.00/63.00', 'and it isn''t taken off again');
-- The quote the job came from deleted: the job still knows its code came off.
select quote_id as job16_quote from public.jobs where id = :'job16' \gset
delete from public.quotes where id = :'job16_quote';
select tpo.mowed(:'job16', '2026-06-15');
select tpo.check(tpo.off(tpo.bill(:'job16')) = 0, 'a deleted quote doesn''t bring the code back');
commit;

-- ===== A referral credit on the same invoice ======================================================
insert into public.referrals (company_id, referrer_client_id, referred_name, status, reward_status, reward_amount, earned_at)
values (:'co', :'rae', 'Sam Friend', 'won', 'earned', 30, now());
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.mowing(:'rae', 'WEEKLY25') as job17 \gset
select tpo.mowed(:'job17', '2026-06-01');
select tpo.bill(:'job17') as s1 \gset
select tpo.mowed(:'job17', '2026-06-08');
select tpo.bill(:'job17') as s2 \gset
commit;
select tpo.check((select credit_amount = 15 from public.invoices where id = :'s1') and (select credit_amount = 15 from public.invoices where id = :'s2'),
  'Rae''s $30 credit: $15 on the first invoice after the code, $15 on the second');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.invoices set status = 'void' where id = :'s1';
commit;
select tpo.check(tpo.off(:'s2') = 25 and (select credit_amount = 15 and total >= tax_amount and total >= 0 from public.invoices where id = :'s2'),
  'the code moves onto the second invoice beside the credit, and it never goes below its tax');
select tpo.check((select reward_status = 'earned' from public.referrals where referrer_client_id = :'rae'), 'the credit the first one gave back waits for Rae''s next invoice');
-- A draft with a credit deleted: its credit comes off at once, which locks Rae (referral_credit_changed),
-- so the job's lock is taken before that, as making an invoice takes them (no deadlock between the two).
create function tpo.job_lock_held() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('tpo.job_locked', (exists (select 1 from pg_catalog.pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted and l.objsubid = 1
      and ((l.classid::bigint << 32) | l.objid::bigint) = pg_catalog.hashtextextended('invoice-for-job:' || current_setting('tpo.job'), 0)))::text, true);
  return old;
end $$;
create trigger tpo_job_lock_held after delete on public.referral_credits for each row execute function tpo.job_lock_held();
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.mowing(:'rae', 'WEEKLY25') as job31 \gset
select tpo.mowed(:'job31', '2026-06-01');
select tpo.bill(:'job31') as v1 \gset
commit;
select tpo.check((select credit_amount = 15 from public.invoices where id = :'v1'), 'Rae''s $15 left goes on her next draft');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select set_config('tpo.job', :'job31', true);
delete from public.invoices where id = :'v1';
select tpo.check(current_setting('tpo.job_locked', true) = 'true', 'deleting a draft with a credit: the job''s lock is held before its credit comes off');
commit;
drop trigger tpo_job_lock_held on public.referral_credits;
select tpo.check((select reward_status = 'earned' from public.referrals where referrer_client_id = :'rae'), 'and the credit waits again');

-- ===== The job page's words ======================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select number as d1_number from public.invoices where id = :'d1' \gset
select number as d2_number from public.invoices where id = :'d2' \gset
select tpo.check(public.job_promo_discounts(:'job4') = jsonb_build_array(jsonb_build_object(
    'key', (select quote_id from public.jobs where id = :'job4'), 'name', 'Promo code WEEKLY25', 'billing', 'once', 'amount', 25.00, 'placed', 25.00, 'left', 0,
    'invoices', jsonb_build_array(jsonb_build_object('id', :'d1', 'number', :'d1_number'::bigint, 'amount', 15.00), jsonb_build_object('id', :'d2', 'number', :'d2_number'::bigint, 'amount', 10.00)))),
  'the job page hears where each part of the code went');
select tpo.mowing(:'mo', 'WEEKLY25') as job18 \gset
select tpo.check((public.job_promo_discounts(:'job18') -> 0 ->> 'left')::numeric = 25 and public.job_promo_discounts(:'job18') -> 0 -> 'invoices' = '[]', 'and that a new job''s code is still to go');
select tpo.check(public.job_promo_discounts(:'job6') -> 0 ->> 'billing' = 'every_visit' and public.job_promo_discounts(:'job6') -> 0 -> 'left' = 'null', 'an every-visit code has nothing left to go');
select tpo.check((public.job_promo_discounts(:'patio') -> 0 ->> 'placed')::numeric = 25, 'a one-off job''s code is on its final invoice');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select tpo.check((select d ->> 'billing' = 'once' and (d ->> 'amount')::numeric = 25 and d -> 'placed' = 'null' and d -> 'left' = 'null' and d -> 'invoices' = 'null'
                    from jsonb_array_elements(public.job_promo_discounts(:'job4')) d),
  'an estimator without the Invoices area hears the rule, not where it went');
select tpo.expect_error(format('select private.place_job_discounts(%L)', :'job18'), 'nor can they place a job''s discount', '%Job not found%');
select tpo.expect_error(format('select * from private.job_discounts_left(%L)', :'job18'), 'or read what''s left of it', '%Job not found%');
commit;

-- ===== Marketing → Promo codes: jobs already using a code ========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select id as spring5 from public.promo_codes where company_id = :'co' and code = 'SPRING5' \gset
select tpo.mowing(:'mo', 'SPRING5') as job19 \gset
select tpo.mowing(:'mo', 'SPRING5') as job20 \gset
select tpo.mowing(:'mo', 'SPRING5') as job21 \gset
update public.jobs set status = 'archived' where id = :'job21';
select tpo.check(public.promo_code_jobs(:'spring5', true) = 2 and public.promo_code_jobs(:'spring5', false) = 0, 'two open jobs use SPRING5 once per job');
update public.promo_codes set every_visit = true where id = :'spring5';
select tpo.check(public.set_promo_code_jobs(:'spring5', true) = 2, 'Change them too changes both');
select tpo.check((select count(*) = 2 from public.job_line_items where job_id in (:'job19', :'job20') and discount_billing = 'every_visit')
  and (select discount_billing = 'once' from public.job_line_items where job_id = :'job21' and discount_key is not null), 'and leaves the archived job be');
select tpo.check(public.promo_code_jobs(:'spring5', true) = 0, 'then none are left to change');
commit;

-- ===== A quote keeps the rule it was signed with, and a deleted code leaves its rule ===============
-- (20261031000630_promo_undo_and_signed_rule.sql)
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.promo_codes (company_id, code, kind, value, once_per_client, every_visit) values (:'co', 'SIGNED5', 'amount', 5, false, true) returning id as signed5 \gset
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'mo', 'Signed mowing', 0.05) returning id as sq \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'sq', 'Mowing', 1, 40, true);
select public.apply_promo_code('quote', :'sq', 'SIGNED5');
select tpo.check((select promo_every_visit is null from public.quotes where id = :'sq'), 'an open quote follows its code''s setting');
update public.quotes set status = 'approved', approved_at = now() where id = :'sq';
select tpo.check((select promo_every_visit from public.quotes where id = :'sq'), 'approved, it keeps the rule the client signed');
update public.promo_codes set every_visit = false where id = :'signed5';
select tpo.check((select promo_every_visit from public.quotes where id = :'sq'), 'the code switched afterwards doesn''t change it');
select public.convert_quote_to_job(:'sq') as sjob \gset
select tpo.check((select discount_billing = 'every_visit' from public.job_line_items where job_id = :'sjob' and discount_key is not null), 'and the job takes the rule the client approved');
select public.set_job_discount_billing(:'sjob', :'sq', false);
select tpo.check((select promo_every_visit and status = 'converted' from public.quotes where id = :'sq'), 'nor does switching the job change what the quote says');
-- A code deleted while a quote still has it: the job made later takes it off once, as the code said.
insert into public.promo_codes (company_id, code, kind, value, once_per_client) values (:'co', 'DELME10', 'amount', 10, false) returning id as delme \gset
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'mo', 'Mowing', 0.05) returning id as dq \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'dq', 'Mowing', 1, 45, true);
select public.apply_promo_code('quote', :'dq', 'DELME10');
insert into public.quotes (company_id, client_id, title, tax_rate) values (:'co', :'mo', 'Mowing', 0.05) returning id as dq2 \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit_price, taxable) values (:'co', :'dq2', 'Mowing', 1, 45, true);
select public.apply_promo_code('quote', :'dq2', 'DELME10');
delete from public.promo_codes where id = :'delme';
select tpo.check((select promo_code_id is null and discount_amount = 10 and promo_every_visit = false from public.quotes where id = :'dq'),
  'a deleted code leaves its discount and its rule on a quote still using it');
update public.quotes set status = 'approved', approved_at = now() where id = :'dq';
select public.convert_quote_to_job(:'dq') as djob \gset
update public.jobs set kind = 'recurring', recurrence_rule = 'FREQ=WEEKLY;BYDAY=MO', billing_mode = 'per_visit', starts_on = '2026-06-01' where id = :'djob';
select tpo.check((select discount_billing = 'once' from public.job_line_items where job_id = :'djob' and unit_price < 0), 'its job takes it off once');
select tpo.mowed(:'djob', '2026-06-01');
select tpo.check(tpo.off(tpo.bill(:'djob')) = 10, 'off the first mowing');
select tpo.mowed(:'djob', '2026-06-08');
select tpo.check(tpo.off(tpo.bill(:'djob')) = 0, 'and not the second');
update public.quotes set discount_amount = 8 where id = :'dq2';
select tpo.check((select promo_every_visit is null from public.quotes where id = :'dq2'), 'a discount typed over it is the office''s own, with no rule');
commit;

-- ===== One promo code to an invoice ===============================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.mowing(:'mo', 'WEEKLY25') as job26 \gset
select tpo.mowed(:'job26', '2026-06-01');
select tpo.bill(:'job26') as x1 \gset
select tpo.mowed(:'job26', '2026-06-08');
select tpo.bill(:'job26') as x2 \gset
select tpo.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'invoice', :'x1', 'THANKS5'),
  'an invoice with its job''s code doesn''t take another on top', '%already has a promo code''s discount%');
select tpo.check((public.apply_promo_code('invoice', :'x2', 'THANKS5') ->> 'discount_amount')::numeric = 5, 'the next one, without it, can');
-- The other way round: taken off the first draft, the job's code passes over the one with THANKS5.
select company_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id as k from public.invoice_line_items where invoice_id = :'x1' and discount_quote_id is not null \gset x1_
delete from public.invoice_line_items where invoice_id = :'x1' and discount_quote_id is not null;
select tpo.check(tpo.off(:'x2') = 0 and tpo.figures(:'x2') = '40.00/1.75/36.75', 'the job''s code doesn''t go on a draft with a code of its own');
select tpo.check((public.job_promo_discounts(:'job26') -> 0 ->> 'left')::numeric = 25, 'it waits for the next invoice');
-- The first draft takes a code before Undo: Undo can't put the job's back on top.
select public.apply_promo_code('invoice', :'x1', 'SPRING5');
select tpo.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id) values (%L, %L, %L, %s, %L, %s, %L, %s, %L)',
  :'x1_company_id', :'x1', :'x1_name', :'x1_quantity', :'x1_unit', :'x1_unit_price', :'x1_taxable', :'x1_sort', :'x1_k'),
  'Undo doesn''t put the job''s code on a draft that took a code of its own meanwhile', '%has promo code SPRING5%');
select tpo.mowed(:'job26', '2026-06-15');
select tpo.bill(:'job26') as x3 \gset
select tpo.check(tpo.off(:'x1') = 0 and tpo.off(:'x2') = 0 and tpo.off(:'x3') = 25 and tpo.job_off(:'job26') = 25, 'the next invoice made takes it, once');
-- An every-visit copy taken off, a code put on, then Undo: refused too.
select tpo.mowing(:'mo', 'EVERY5') as job27 \gset
select tpo.mowed(:'job27', '2026-06-01');
select tpo.bill(:'job27') as y1 \gset
select company_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id as k from public.invoice_line_items where invoice_id = :'y1' and discount_quote_id is not null \gset y1_
delete from public.invoice_line_items where invoice_id = :'y1' and discount_quote_id is not null;
select public.apply_promo_code('invoice', :'y1', 'THANKS5');
select tpo.expect_error(format('insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id) values (%L, %L, %L, %s, %L, %s, %L, %s, %L)',
  :'y1_company_id', :'y1', :'y1_name', :'y1_quantity', :'y1_unit', :'y1_unit_price', :'y1_taxable', :'y1_sort', :'y1_k'),
  'nor an every-visit copy', '%has promo code THANKS5%');
select tpo.check(tpo.off(:'y1') = 0 and tpo.figures(:'y1') = '40.00/1.75/36.75', 'that draft keeps just its own code');
-- Voided at commit: the job's code passes over the draft with THANKS5 and waits.
select tpo.mowing(:'mo', 'WEEKLY25') as job28 \gset
select tpo.mowed(:'job28', '2026-06-01');
select tpo.bill(:'job28') as z1 \gset
select tpo.mowed(:'job28', '2026-06-08');
select tpo.bill(:'job28') as z2 \gset
select public.apply_promo_code('invoice', :'z2', 'THANKS5');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.invoices set status = 'void' where id = :'z1';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.check(tpo.off(:'z2') = 0 and tpo.figures(:'z2') = '40.00/1.75/36.75', 'a draft voided: its code doesn''t go on the open draft with a code of its own');
select tpo.mowed(:'job28', '2026-06-15');
select tpo.bill(:'job28') as z3 \gset
select tpo.check(tpo.off(:'z3') = 25 and tpo.job_off(:'job28') = 25, 'the next invoice made takes it');
commit;

-- ===== A bank payment clearing ===================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.invoices (company_id, client_id, subject) values (:'co', :'mo', 'Hedges') returning id as hedges \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'hedges', 'Hedges', 100);
select public.apply_promo_code('invoice', :'hedges', 'THANKS5');
insert into public.invoices (company_id, client_id, subject) values (:'co', :'mo', 'Edging') returning id as edges \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'edges', 'Edging', 100);
update public.invoices set status = 'sent' where id in (:'hedges', :'edges');
insert into public.quotes (company_id, client_id, title) values (:'co', :'mo', 'Fall cleanup') returning id as fall \gset
insert into public.quote_line_items (company_id, quote_id, name, unit_price) values (:'co', :'fall', 'Cleanup', 300);
commit;
insert into public.stripe_invoices (company_id, invoice_id, origin, status, amount_due, stripe_id) values
  (:'co', :'hedges', 'crewtavo', 'processing', 95, 'in_hedges'), (:'co', :'edges', 'crewtavo', 'processing', 100, 'in_edges');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.expect_error(format('select public.remove_promo_code(%L, %L)', 'invoice', :'hedges'), 'a code can''t come off while a bank payment clears', '%bank payment for this invoice is on its way%');
select tpo.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'invoice', :'edges', 'THANKS5'), 'or go on', '%bank payment for this invoice is on its way%');
select tpo.check((select promo_code_id is not null and discount_amount = 5 from public.invoices where id = :'hedges'), 'the code stays as it was');
select tpo.check((public.apply_promo_code('quote', :'fall', 'THANKS5') ->> 'discount_amount')::numeric = 5, 'quotes aren''t held up');
commit;
update public.stripe_invoices set status = 'void' where stripe_id in ('in_hedges', 'in_edges');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.remove_promo_code('invoice', :'hedges');
select tpo.check((select promo_code_id is null from public.invoices where id = :'hedges'), 'once it''s over, the code comes off');
select tpo.check((public.apply_promo_code('invoice', :'edges', 'THANKS5') ->> 'discount_amount')::numeric = 5, 'and goes on');
commit;
-- As the app counts one (waiting() in apps/api/src/integrations/stripe.ts): one in a Stripe account
-- Crewtavo has since left counts for the 30 days a bank payment can take, and test money doesn't
-- hold up a live key.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.invoices (company_id, client_id, subject) values (:'co', :'mo', 'Mulch') returning id as mulch \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'mulch', 'Mulch', 100);
select public.apply_promo_code('invoice', :'mulch', 'THANKS5');
insert into public.invoices (company_id, client_id, subject) values (:'co', :'mo', 'Leaves') returning id as leaves \gset
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'leaves', 'Leaves', 100);
update public.invoices set status = 'sent' where id in (:'mulch', :'leaves');
commit;
insert into public.stripe_invoices (company_id, invoice_id, origin, status, amount_due, stripe_id, detached_at) values
  (:'co', :'mulch', 'crewtavo', 'processing', 95, 'in_mulch', now() - interval '31 days'),
  (:'co', :'leaves', 'crewtavo', 'processing', 100, 'in_leaves', now() - interval '29 days');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.remove_promo_code('invoice', :'mulch');
select tpo.check((select promo_code_id is null from public.invoices where id = :'mulch'), 'one in a Stripe account left 31 days ago has cleared or bounced: the code comes off');
select tpo.check((public.apply_promo_code('invoice', :'mulch', 'THANKS5') ->> 'discount_amount')::numeric = 5, 'and goes on');
select tpo.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'invoice', :'leaves', 'THANKS5'), 'one left 29 days ago may still clear', '%bank payment for this invoice is on its way%');
commit;
update public.stripe_invoices set livemode = false, detached_at = null where stripe_id = 'in_leaves';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.expect_error(format('select public.apply_promo_code(%L, %L, %L)', 'invoice', :'leaves', 'THANKS5'), 'test money holds up a test key, and the deployment''s', '%bank payment for this invoice is on its way%');
commit;
insert into public.integrations (company_id, provider, status, settings) values (:'co', 'stripe', 'connected', '{"livemode": true}');
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b9f50000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select tpo.check((public.apply_promo_code('invoice', :'leaves', 'THANKS5') ->> 'discount_amount')::numeric = 5, 'but not the company''s own live key');
commit;
delete from public.integrations where company_id = :'co' and provider = 'stripe';

-- ===== Codes already on jobs, from before =========================================================
-- Rows shaped like old ones: promo lines with nothing to say they're once per job, copied onto every
-- invoice as create_invoice_for_job used to (it copies lines without discount_billing to each one).
select id as weekly25 from public.promo_codes where company_id = :'co' and code = 'WEEKLY25' \gset
select id as co10 from public.promo_codes where company_id = :'co' and code = 'CO10' \gset
create function tpo.old_job(p_co uuid, p_client uuid, p_promo uuid, p_promo_sort integer default 100000) returns uuid language plpgsql as $$
declare v_quote uuid; v_job uuid;
begin
  insert into public.quotes (company_id, client_id, title, tax_rate, status, promo_code_id) values (p_co, p_client, 'Old mowing', 0.05, 'converted', p_promo) returning id into v_quote;
  insert into public.jobs (company_id, client_id, quote_id, title, kind, recurrence_rule, billing_mode)
  values (p_co, p_client, v_quote, 'Old mowing', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', 'per_visit') returning id into v_job;
  insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort) values
    (p_co, v_job, 'Mowing', 1, 'ea', 40, true, 0), (p_co, v_job, 'Promo code WEEKLY25', 1, 'ea', -25, true, p_promo_sort);
  return v_job;
end $$;
select tpo.old_job(:'co', :'mo', :'weekly25') as old1 \gset
select tpo.mowed(:'old1', '2026-05-04');
select tpo.bill(:'old1') as o1a \gset
select tpo.send(:'o1a');
select tpo.mowed(:'old1', '2026-05-11');
select tpo.bill(:'old1') as o1b \gset
select tpo.check((select count(*) = 2 from public.invoice_line_items where invoice_id in (:'o1a', :'o1b') and name = 'Promo code WEEKLY25' and discount_quote_id is null),
  'before: the old job took its code off every mowing');
select string_agg(tpo.figures(id) || '@' || updated_at, ',' order by number) as old_figures from public.invoices where id in (:'o1a', :'o1b') \gset
select updated_at as old1_updated from public.jobs where id = :'old1' \gset
-- Moved up or down on the job page, so its lines were numbered again.
select tpo.old_job(:'co', :'mo', :'weekly25', 1) as old2 \gset
select tpo.mowed(:'old2', '2026-05-04');
select tpo.bill(:'old2') as o2a \gset
select tpo.send(:'o2a');
select tpo.old_job(:'co', :'mo', :'weekly25') as old3 \gset
select tpo.old_job(:'co', :'mo', :'weekly25') as old4 \gset
select tpo.mowed(:'old4', '2026-05-04');
select tpo.bill(:'old4') as o4a \gset
update public.invoices set status = 'void' where id = :'o4a';
-- Two change orders with the same code and the same discount, each copied onto both visits.
select tpo.old_job(:'co', :'mo', null) as old5 \gset
delete from public.job_line_items where job_id = :'old5' and name like 'Promo code %';
insert into public.quotes (company_id, client_id, title, status, change_order_for, promo_code_id) values (:'co', :'mo', 'Edging', 'converted', :'old5', :'co10') returning id as co_a \gset
insert into public.quotes (company_id, client_id, title, status, change_order_for, promo_code_id) values (:'co', :'mo', 'Hedges', 'converted', :'old5', :'co10') returning id as co_b \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort, source_quote_id) values
  (:'co', :'old5', 'Change order discount', 1, 'ea', -10, true, 100000, :'co_a'), (:'co', :'old5', 'Change order discount', 1, 'ea', -10, true, 100000, :'co_b');
select tpo.mowed(:'old5', d) from unnest('{2026-05-04,2026-05-11}'::date[]) d;
select tpo.bill(:'old5') as o5a \gset
select tpo.send(:'o5a');
-- Drafts the office changed: one with the code taken off, one with it cut to $10.
select tpo.old_job(:'co', :'mo', :'weekly25') as old6 \gset
select tpo.mowed(:'old6', '2026-05-04');
select tpo.bill(:'old6') as o6a \gset
delete from public.invoice_line_items where invoice_id = :'o6a' and name = 'Promo code WEEKLY25';
select tpo.old_job(:'co', :'mo', :'weekly25') as old7 \gset
select tpo.mowed(:'old7', '2026-05-04');
select tpo.bill(:'old7') as o7a \gset
update public.invoice_line_items set unit_price = -10 where invoice_id = :'o7a' and name = 'Promo code WEEKLY25';
-- A one-off job whose final draft had the code taken off and put on the invoice itself instead.
insert into public.quotes (company_id, client_id, title, tax_rate, status, promo_code_id) values (:'co', :'mo', 'Old patio', 0.05, 'converted', :'weekly25') returning id as old8_quote \gset
insert into public.jobs (company_id, client_id, quote_id, title) values (:'co', :'mo', :'old8_quote', 'Old patio') returning id as old8 \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort) values
  (:'co', :'old8', 'Patio', 1, 'ea', 500, true, 0), (:'co', :'old8', 'Promo code WEEKLY25', 1, 'ea', -25, true, 100000);
select public.create_invoice_for_job(:'old8') as o8a \gset
delete from public.invoice_line_items where invoice_id = :'o8a' and name = 'Promo code WEEKLY25';
select public.apply_promo_code('invoice', :'o8a', 'THANKS5');
-- A change order with a typed $10 discount, then one with a code: the same line name.
select tpo.old_job(:'co', :'mo', null) as old9 \gset
delete from public.job_line_items where job_id = :'old9' and name like 'Promo code %';
insert into public.quotes (company_id, client_id, title, status, change_order_for) values (:'co', :'mo', 'Edging', 'converted', :'old9') returning id as co_typed \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort, source_quote_id) values
  (:'co', :'old9', 'Change order discount', 1, 'ea', -10, true, 100000, :'co_typed');
select tpo.mowed(:'old9', d) from unnest('{2026-05-04,2026-05-11}'::date[]) d;
select tpo.bill(:'old9') as o9a \gset
select tpo.send(:'o9a');
insert into public.quotes (company_id, client_id, title, status, change_order_for, promo_code_id) values (:'co', :'mo', 'Hedges', 'converted', :'old9', :'co10') returning id as co_code \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort, source_quote_id) values
  (:'co', :'old9', 'Change order discount', 1, 'ea', -30, true, 100000, :'co_code');
-- And the same, with both $10 and on an invoice together.
select tpo.old_job(:'co', :'mo', null) as old10 \gset
delete from public.job_line_items where job_id = :'old10' and name like 'Promo code %';
insert into public.quotes (company_id, client_id, title, status, change_order_for) values (:'co', :'mo', 'Edging', 'converted', :'old10') returning id as co_typed2 \gset
insert into public.quotes (company_id, client_id, title, status, change_order_for, promo_code_id) values (:'co', :'mo', 'Hedges', 'converted', :'old10', :'co10') returning id as co_code2 \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort, source_quote_id) values
  (:'co', :'old10', 'Change order discount', 1, 'ea', -10, true, 100000, :'co_typed2'), (:'co', :'old10', 'Change order discount', 1, 'ea', -10, true, 100000, :'co_code2');
select tpo.mowed(:'old10', d) from unnest('{2026-05-04,2026-05-11}'::date[]) d;
select tpo.bill(:'old10') as o10a \gset
select tpo.send(:'o10a');
-- The Taxable box changed since the code went on an invoice: on the job's line, and on a draft's copy.
select tpo.old_job(:'co', :'mo', :'weekly25') as old11 \gset
select tpo.mowed(:'old11', '2026-05-04');
select tpo.bill(:'old11') as o11a \gset
select tpo.send(:'o11a');
update public.job_line_items set taxable = false where job_id = :'old11' and name = 'Promo code WEEKLY25';
select tpo.old_job(:'co', :'mo', :'weekly25') as old12 \gset
select tpo.mowed(:'old12', '2026-05-04');
select tpo.bill(:'old12') as o12a \gset
update public.invoice_line_items set taxable = false where invoice_id = :'o12a' and name = 'Promo code WEEKLY25';
-- A change order's typed discount (untaxed) and one with a code (taxed), the typed one's copy ticked Taxable on the draft.
select tpo.old_job(:'co', :'mo', null) as old13 \gset
delete from public.job_line_items where job_id = :'old13' and name like 'Promo code %';
insert into public.quotes (company_id, client_id, title, status, change_order_for) values (:'co', :'mo', 'Edging', 'converted', :'old13') returning id as co_typed3 \gset
insert into public.quotes (company_id, client_id, title, status, change_order_for, promo_code_id) values (:'co', :'mo', 'Hedges', 'converted', :'old13', :'co10') returning id as co_code3 \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort, source_quote_id) values
  (:'co', :'old13', 'Change order discount', 1, 'ea', -10, false, 100000, :'co_typed3'), (:'co', :'old13', 'Change order discount', 1, 'ea', -30, true, 100001, :'co_code3');
select tpo.mowed(:'old13', '2026-05-04');
select tpo.bill(:'old13') as o13a \gset
update public.invoice_line_items set taxable = true where invoice_id = :'o13a' and name = 'Change order discount' and not taxable;
-- The same two, the code's copy cut to $20 on the draft: its price changed, and it's the other part from the typed one.
select tpo.old_job(:'co', :'mo', null) as old14 \gset
delete from public.job_line_items where job_id = :'old14' and name like 'Promo code %';
insert into public.quotes (company_id, client_id, title, status, change_order_for) values (:'co', :'mo', 'Edging', 'converted', :'old14') returning id as co_typed4 \gset
insert into public.quotes (company_id, client_id, title, status, change_order_for, promo_code_id) values (:'co', :'mo', 'Hedges', 'converted', :'old14', :'co10') returning id as co_code4 \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort, source_quote_id) values
  (:'co', :'old14', 'Change order discount', 1, 'ea', -10, false, 100000, :'co_typed4'), (:'co', :'old14', 'Change order discount', 1, 'ea', -30, true, 100001, :'co_code4');
select tpo.mowed(:'old14', '2026-05-04');
select tpo.bill(:'old14') as o14a \gset
update public.invoice_line_items set unit_price = -20 where invoice_id = :'o14a' and name = 'Change order discount' and taxable;
-- A typed discount and a code's of the same name, both taxed, both copies unticked on the draft.
select tpo.old_job(:'co', :'mo', null) as old15 \gset
delete from public.job_line_items where job_id = :'old15' and name like 'Promo code %';
insert into public.quotes (company_id, client_id, title, status, change_order_for) values (:'co', :'mo', 'Edging', 'converted', :'old15') returning id as co_typed5 \gset
insert into public.quotes (company_id, client_id, title, status, change_order_for, promo_code_id) values (:'co', :'mo', 'Hedges', 'converted', :'old15', :'co10') returning id as co_code5 \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, taxable, sort, source_quote_id) values
  (:'co', :'old15', 'Change order discount', 1, 'ea', -10, true, 100000, :'co_typed5'), (:'co', :'old15', 'Change order discount', 1, 'ea', -30, true, 100001, :'co_code5');
select tpo.mowed(:'old15', '2026-05-04');
select tpo.bill(:'old15') as o15a \gset
update public.invoice_line_items set taxable = false where invoice_id = :'o15a' and name = 'Change order discount';
select string_agg(tpo.figures(id) || '@' || updated_at, ',' order by number) as flipped_figures from public.invoices where id in (:'o11a', :'o12a', :'o13a', :'o14a', :'o15a') \gset

select tpo.check(private.backfill_job_discounts() >= 11, 'the backfill marks the old jobs'' promo lines once per job');
select tpo.check((select count(*) = 6 from public.job_line_items where job_id in (:'old1', :'old2', :'old3', :'old4', :'old5') and discount_billing = 'once')
  and (select count(*) = 4 from public.job_line_items where job_id in (:'old1', :'old2', :'old3', :'old4') and discount_key = (select quote_id from public.jobs where id = job_id)),
  'each keyed by its quote, a change order''s by the change order');
select tpo.check((select count(*) = 2 from public.invoice_line_items where invoice_id in (:'o1a', :'o1b') and discount_quote_id = (select quote_id from public.jobs where id = :'old1')),
  'and links the invoices they were copied to, a draft''s too');
select tpo.check((select string_agg(tpo.figures(id) || '@' || updated_at, ',' order by number) from public.invoices where id in (:'o1a', :'o1b')) = :'old_figures',
  'without changing what they add up to, or when they were last changed');
select tpo.check((select updated_at = :'old1_updated' from public.jobs where id = :'old1'), 'nor the job');
select tpo.mowed(:'old1', '2026-05-18');
select tpo.check(tpo.off(tpo.bill(:'old1')) = 0, 'a job that already took its code off doesn''t take it again');
select tpo.check(tpo.off(:'o2a') = 25, 'lines numbered again are found too');
select tpo.mowed(:'old2', '2026-05-11');
select tpo.check(tpo.off(tpo.bill(:'old2')) = 0, 'and that job doesn''t take it again either');
select tpo.mowed(:'old3', d) from unnest('{2026-05-04,2026-05-11}'::date[]) d;
select tpo.check(tpo.off(tpo.bill(:'old3')) = 25, 'a job with no invoices yet takes it once');
select tpo.mowed(:'old3', '2026-05-18');
select tpo.check(tpo.off(tpo.bill(:'old3')) = 0, 'and only once');
select tpo.check(tpo.off(:'o4a') = 25, 'a void invoice''s line is linked');
select tpo.mowed(:'old4', '2026-05-11');
select tpo.check(tpo.off(tpo.bill(:'old4')) = 25, 'but doesn''t hold it: the next invoice takes it');
select tpo.check((select count(*) filter (where discount_quote_id = :'co_a') = 2 and count(*) filter (where discount_quote_id = :'co_b') = 2
                    from public.invoice_line_items where invoice_id = :'o5a'), 'two change orders alike each get their own lines');
select tpo.mowed(:'old5', '2026-05-18');
select tpo.check(tpo.off(tpo.bill(:'old5')) = 0, 'so neither comes off again');
-- Drafts the office changed before keep it so, when they're edited and after.
select tpo.check(not exists (select 1 from public.job_discount_skips where invoice_id in (:'o1a', :'o1b', :'o2a', :'o5a'))
  and (select count(*) = 3 from public.job_discount_skips where invoice_id in (:'o6a', :'o7a', :'o8a')), 'a draft holding less than the code is skipped, as if it was taken off by hand');
update public.invoice_line_items set description = 'Front and back' where invoice_id = :'o6a' and name = 'Mowing';
select tpo.check(tpo.off(:'o6a') = 0, 'a draft the code was taken off before keeps it off when it''s edited');
select tpo.mowed(:'old6', '2026-05-11');
select tpo.check(tpo.off(tpo.bill(:'old6')) = 25, 'and the next invoice takes it, as when it''s taken off now');
update public.invoice_line_items set description = 'Front and back' where invoice_id = :'o7a' and name = 'Mowing';
select tpo.check(tpo.off(:'o7a') = 10, 'one cut to $10 keeps $10 off');
select tpo.mowed(:'old7', '2026-05-11');
select tpo.check(tpo.off(tpo.bill(:'old7')) = 15, 'and the next invoice takes the other $15');
update public.invoice_line_items set description = 'Pavers' where invoice_id = :'o8a' and name = 'Patio';
select tpo.check(tpo.off(:'o8a') = 0 and (select discount_amount = 5 from public.invoices where id = :'o8a'),
  'a one-off job''s final draft with the code on the invoice instead doesn''t take the line again too');
-- A typed change-order discount is never taken for a code's.
select tpo.check((select count(*) = 2 and bool_and(discount_quote_id is null) from public.invoice_line_items where invoice_id = :'o9a' and name = 'Change order discount'),
  'a typed change-order discount''s copies aren''t linked to a code''s of the same name');
select tpo.mowed(:'old9', '2026-05-18');
select tpo.bill(:'old9') as o9b \gset
select tpo.check(tpo.off(:'o9b') = 30 and tpo.figures(:'o9b') = '0.00/0.00/0.00', 'so the code''s $30 comes off the next invoice, beside the typed $10');
select tpo.check((select count(*) filter (where discount_quote_id = :'co_code2') = 2 and count(*) filter (where discount_quote_id is null) = 2
                    from public.invoice_line_items where invoice_id = :'o10a' and name = 'Change order discount'),
  'with the same price, one line for each visit is the code''s and one stays typed');
select tpo.mowed(:'old10', '2026-05-18');
select tpo.check(tpo.off(tpo.bill(:'old10')) = 0, 'and the code doesn''t come off again');
-- A Taxable box changed since: still the code's copy.
select tpo.check((select count(*) = 2 and bool_and(discount_quote_id is not null) from public.invoice_line_items where invoice_id in (:'o11a', :'o12a') and name = 'Promo code WEEKLY25'),
  'a copy whose Taxable box differs from the job''s line (changed on the job, or on the draft) is linked too');
select tpo.check((select string_agg(tpo.figures(id) || '@' || updated_at, ',' order by number) from public.invoices where id in (:'o11a', :'o12a', :'o13a', :'o14a', :'o15a')) = :'flipped_figures',
  'still without changing what they add up to, or when they were last changed');
select tpo.check(not exists (select 1 from public.job_discount_skips where invoice_id in (:'o11a', :'o12a', :'o13a', :'o15a')), 'they hold the whole code, so none is skipped');
select tpo.mowed(:'old11', '2026-05-11');
select tpo.check(tpo.off(tpo.bill(:'old11')) = 0, 'so a job whose promo line was unticked doesn''t take the code again');
select tpo.mowed(:'old12', '2026-05-11');
select tpo.check(tpo.off(tpo.bill(:'old12')) = 0, 'nor one whose draft''s copy was');
select tpo.check((select string_agg(case when discount_quote_id is null then 'typed' else 'code' end || ' ' || unit_price, ', ' order by unit_price) from public.invoice_line_items where invoice_id = :'o13a' and name = 'Change order discount')
  = 'code -30.00, typed -10.00', 'a typed discount''s copy ticked Taxable isn''t taken for the code''s of the same name');
select tpo.check((select string_agg(coalesce(discount_quote_id::text, 'typed') || ' ' || unit_price, ', ' order by unit_price) from public.invoice_line_items where invoice_id = :'o14a' and name = 'Change order discount')
  = :'co_code4' || ' -20.00, typed -10.00', 'the code''s copy cut on a draft is still the code''s, beside a typed one of the other part');
select tpo.check((select held = 20 and held_elsewhere = 0 from public.job_discount_skips where invoice_id = :'o14a' and discount_key = :'co_code4'),
  'it holds $20 of the code''s $30, so that draft is skipped');
select tpo.mowed(:'old14', '2026-05-11');
select tpo.check(tpo.off(tpo.bill(:'old14')) = 10 and tpo.off(:'o14a') = 20, 'and the next invoice takes the other $10, not the whole $30 again');
select tpo.check((select string_agg(coalesce(discount_quote_id::text, 'typed') || ' ' || unit_price, ', ' order by unit_price) from public.invoice_line_items where invoice_id = :'o15a' and name = 'Change order discount')
  = :'co_code5' || ' -30.00, typed -10.00', 'a code''s copy unticked on a draft is the code''s beside a typed one of its old part, and the typed one''s copy stays plain');
select tpo.mowed(:'old15', '2026-05-11');
select tpo.check(tpo.off(tpo.bill(:'old15')) = 0, 'so the code doesn''t come off again');
-- Undo on a job from before, whose code is on every invoice: it goes back as it was.
select company_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id as k from public.invoice_line_items where invoice_id = :'o1b' and discount_quote_id is not null \gset o1b_
delete from public.invoice_line_items where invoice_id = :'o1b' and discount_quote_id is not null;
select tpo.check(tpo.off(:'o1b') = 0, 'taken off a draft of a job from before');
insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable, sort, discount_quote_id)
values (:'o1b_company_id', :'o1b', :'o1b_name', :'o1b_quantity', :'o1b_unit', :'o1b_unit_price', :'o1b_taxable', :'o1b_sort', :'o1b_k');
select tpo.check(tpo.off(:'o1b') = 25 and not exists (select 1 from public.job_discount_skips where invoice_id = :'o1b'), 'Undo puts it back as it was');
select tpo.expect_error(format('update public.invoice_line_items set unit_price = -40 where invoice_id = %L and discount_quote_id is not null', :'o1b'),
  'but no bigger', '%more than is left of Promo code WEEKLY25%');
select tpo.check(private.backfill_job_discounts() = 0, 'run again, it finds nothing more');
select tpo.check(not has_function_privilege('authenticated', 'private.backfill_job_discounts()', 'execute'), 'nobody signed in can run the backfill');

\echo 'All promo once-per-job tests passed.'
