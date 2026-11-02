-- Database tests for Charge card (20261101000200_manual_charges.sql): who may charge saved cards
-- (the office with the invoices area, never crews, estimators or subs); what request_manual_charges
-- says for each invoice (queued, not found, not owed, no card, already under way, autopay off, the
-- amount changed from what the office saw), one at a time, at most 50, with an activity row for
-- each; the list of invoices it can charge, and what's collecting the rest (a charge, a bank payment
-- on its way; one made in Stripe isn't listed); the task
-- charging a manual charge with no job, visits or cap to check, a draft marked sent; a decline
-- needing the client at once without pausing the card, and a new card trying it again; what calls
-- one off (the invoice changed, autopay turned off for the client or in Settings); one live charge
-- an invoice, a paid one not counting, and charged again after a refund, paid only by its own Stripe
-- invoice; the starter terms; grants.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmanual;
grant usage on schema tmanual to authenticated, service_role, anon;
create function tmanual.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tmanual.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
-- Signs in as someone, for the rest of the transaction.
create function tmanual.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema tmanual to authenticated, service_role, anon;

-- The rest are the server's and the test's own shortcuts, run past row-level security.

-- A client on autopay: a Visa saved on their client page and agreed to, as the server records them.
create function tmanual.ready_client(p_company uuid, p_name text) returns uuid language plpgsql as $$
declare
  v_client uuid;
  v_key text := 'm_' || replace(lower(p_name), ' ', '_');
  v_pm uuid;
begin
  insert into public.clients (company_id, display_name, email) values (p_company, p_name, replace(lower(p_name), ' ', '.') || '@manual.test')
  returning id into v_client;
  v_pm := public.autopay_save_payment_method(p_company, v_client, jsonb_build_object(
    'stripe_payment_method_id', 'pm_' || v_key, 'stripe_customer_id', 'cus_' || v_key, 'stripe_account', 'acct_charge', 'livemode', false,
    'type', 'card', 'brand', 'visa', 'last4', '4242', 'exp_month', 8, 'exp_year', 2030, 'status', 'active', 'source', 'hub', 'make_default', true));
  perform public.autopay_record_authorization(p_company, v_client, v_pm, 'hub', private.autopay_terms_version(p_company), '203.0.113.7', 'Test browser', 'client', 'client');
  return v_client;
end $$;
-- An invoice for a client, for p_amount: sent, or left a draft.
create function tmanual.invoice(p_company uuid, p_client uuid, p_amount numeric, p_draft boolean default false) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.invoices (company_id, client_id, subject) values (p_company, p_client, 'Mowing') returning id into v_id;
  insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (p_company, v_id, 'Mowing', p_amount);
  if not p_draft then update public.invoices set status = 'sent' where id = v_id; end if;
  return v_id;
end $$;
-- The invoice's newest charge.
create function tmanual.charge_of(p_invoice uuid) returns uuid language sql as $$
  select id from public.autopay_charges where invoice_id = p_invoice order by created_at desc, id desc limit 1
$$;
-- A charge as "status: last_error".
create function tmanual.state(p_charge uuid) returns text language sql as $$
  select status || coalesce(': ' || last_error, '') from public.autopay_charges where id = p_charge
$$;
-- The task's claim: its token, and how many it took.
create function tmanual.claim(p_company uuid, out token uuid, out taken integer) language sql as $$
  select (array_agg(claim_token))[1], count(*)::integer from public.claim_autopay_charges(100, p_company)
$$;
-- Bill, mark sent and say how it went, as the task does once Stripe has answered.
create function tmanual.charge(p_charge uuid, p_token uuid, p_outcome text, p_error text default null, p_decline text default null) returns jsonb
language plpgsql as $$
declare
  v_bill jsonb := public.autopay_bill(p_charge, p_token);
begin
  if v_bill ->> 'outcome' <> 'charge' then return v_bill; end if;
  if not public.autopay_mark_sent(p_charge, p_token, round((v_bill ->> 'balance_due')::numeric * 100)::integer) then
    raise exception 'FAIL: mark_sent refused %', p_charge;
  end if;
  perform public.finish_autopay_charge(p_charge, p_outcome, p_token, p_error, p_decline, (v_bill ->> 'balance_due')::numeric);
  return v_bill;
end $$;
-- Notifications about autopay for someone, as "title | body" lines.
create function tmanual.told(p_user uuid, p_like text default '%') returns text language sql as $$
  select string_agg(title || ' | ' || coalesce(body, ''), E'\n' order by created_at, title)
  from public.notifications where user_id = p_user and kind = 'autopay' and title like p_like
$$;
-- request_manual_charges as "outcome: reason" lines, in its order, for the amounts given.
create function tmanual.asked_for(p_company uuid, p_invoices uuid[], p_amounts numeric[]) returns text language sql as $$
  select string_agg(outcome || coalesce(': ' || reason, ''), E'\n') from public.request_manual_charges(p_company, p_invoices, p_amounts)
$$;
-- The same for what each invoice owes now, as the office sees it (0 for one they can't see).
create function tmanual.asked(p_company uuid, p_invoices uuid[]) returns text language sql as $$
  select tmanual.asked_for(p_company, p_invoices,
    array(select coalesce((select balance_due from public.invoices where id = u), 0) from unnest(p_invoices) with ordinality t(u, n) order by n))
$$;
grant execute on all functions in schema tmanual to authenticated;

\set olive 'b7b70000-0000-0000-0000-000000000001'
\set opal 'b7b70000-0000-0000-0000-000000000003'
\set otto 'b7b70000-0000-0000-0000-000000000004'
\set eve 'b7b70000-0000-0000-0000-000000000005'
\set lou 'b7b70000-0000-0000-0000-000000000006'
\set cy 'b7b70000-0000-0000-0000-000000000007'
\set sal 'b7b70000-0000-0000-0000-000000000008'
\set pat 'b7b70000-0000-0000-0000-00000000000a'
insert into auth.users (id, email, raw_user_meta_data) values
  (:'olive', 'olive@manual.test', '{"full_name": "Olive Owner"}'),
  (:'opal', 'opal@manual.test', '{"full_name": "Opal Office"}'),
  (:'otto', 'otto@manual.test', '{"full_name": "Otto Ops"}'),
  (:'eve', 'eve@manual.test', '{"full_name": "Eve Estimator"}'),
  (:'lou', 'lou@manual.test', '{"full_name": "Lou Lead"}'),
  (:'cy', 'cy@manual.test', '{"full_name": "Cy Crew"}'),
  (:'sal', 'sal@manual.test', '{"full_name": "Sal Sub"}'),
  (:'pat', 'pat@manual.test', '{"full_name": "Pat Paving"}');

-- ===== Charge Lawns ============================================================================
-- Olive owns it; Opal in the office; Otto in the office as an operations manager (no invoices area);
-- Eve estimates; Lou leads a crew with Cy on it; Sal is a sub. Pat owns Paving Pros, another business.
begin;
set local role authenticated;
select tmanual.as_user(:'olive');
select public.create_company('Charge Lawns', 'lawn_exterior') as co \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
reset role;
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', :'opal', 'office', null), (:'co', :'otto', 'office', :'ops_role'), (:'co', :'eve', 'estimator', null),
  (:'co', :'lou', 'crew_lead', null), (:'co', :'cy', 'field_crew', null);
commit;
insert into public.subcontractors (id, company_id, name) values ('b7b70000-0000-0000-0000-0000000000c1', :'co', 'Sal''s Mowing');
insert into public.memberships (company_id, user_id, role, subcontractor_id) values (:'co', :'sal', 'subcontractor', 'b7b70000-0000-0000-0000-0000000000c1');

begin;
set local role authenticated;
select tmanual.as_user(:'pat');
select public.create_company('Paving Pros', 'paving') as other \gset
insert into public.clients (company_id, display_name, email) values (:'other', 'Owen Other', 'owen@manual.test') returning id as c_owen \gset
commit;

-- ===== The terms clients agree to ==============================================================

select tmanual.check(private.autopay_starter_terms('lawn_exterior') = 'We charge the card on file after each visit is done, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    and private.autopay_starter_terms('paving') = 'We charge the card on file when the work on your job is done, and for other invoices we send you. Charges over the amount we agreed wait until we''ve talked with you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    and private.autopay_starter_terms('roofing_exteriors') = private.autopay_starter_terms('paving')
    and private.autopay_starter_terms('general') = 'We charge the card on file when each visit or job is done, and for other invoices we send you. You''ll get a receipt each time. Turn it off anytime from your client page or by calling us.'
    and private.autopay_starter_terms('snow') = private.autopay_starter_terms('general'),
  'the starter terms say the card is charged for other invoices we send too, for every trade (as core starterAutopayTerms)');
select tmanual.check(private.autopay_terms_shown(:'other') = private.autopay_starter_terms('paving') || E'\n\nWe charge at the end of the day of each visit.',
  'a company that never saved terms of its own has clients agree to the new starter words');

-- ===== Autopay on, and who's on it =============================================================

insert into public.integrations (company_id, provider, status, settings) values (:'co', 'stripe', 'connected', '{"autopay": true, "refunds": true}');
select private.autopay_starter_terms('lawn_exterior') as lawn_terms \gset
begin;
set local role authenticated;
select tmanual.as_user(:'olive');
-- A $20 cap: Charge card goes past it, the office having pressed it.
select public.autopay_set_settings(:'co', jsonb_build_object('enabled', true, 'terms', :'lawn_terms', 'timing', 'end_of_day',
  'days', null, 'max_amount', 20, 'receipts', true, 'jobs_default', false));
commit;

select tmanual.ready_client(:'co', 'Pat Lee') as c_pat \gset
select tmanual.ready_client(:'co', 'Una Update') as c_una \gset
select tmanual.ready_client(:'co', 'Kim Pause') as c_kim \gset
select tmanual.ready_client(:'co', 'Tess Turnoff') as c_tess \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Sam Ortiz', 'sam@manual.test') returning id as c_sam \gset
select id as pm_pat from public.client_payment_methods where client_id = :'c_pat' \gset
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select public.autopay_pause(:'c_kim', true);
commit;

select tmanual.invoice(:'co', :'c_pat', 45) as inv_a \gset
select tmanual.invoice(:'co', :'c_pat', 30, true) as inv_d \gset
select tmanual.invoice(:'co', :'c_pat', 25) as inv_v \gset
update public.invoices set status = 'void' where id = :'inv_v';
select tmanual.invoice(:'co', :'c_pat', 20) as inv_z \gset
insert into public.payments (company_id, client_id, invoice_id, amount, method) values (:'co', :'c_pat', :'inv_z', 20, 'check');
select tmanual.invoice(:'co', :'c_sam', 40) as inv_s \gset
select tmanual.invoice(:'co', :'c_kim', 40) as inv_k \gset
select tmanual.invoice(:'co', :'c_una', 50) as inv_u \gset
select tmanual.invoice(:'other', :'c_owen', 70) as inv_o \gset
select number as n_a from public.invoices where id = :'inv_a' \gset

-- ===== Who may =================================================================================

begin;
set local role authenticated;
select tmanual.as_user(:'cy');
select tmanual.check(tmanual.error_of(format('select * from public.request_manual_charges(%L, %L, %L)', :'co', array[:'inv_a']::uuid[], array[45]::numeric[])) = '42501: Only the office with the invoices area can do that'
    and tmanual.error_of(format('select * from public.chargeable_invoices(%L)', :'co')) = '42501: Only the office with the invoices area can do that',
  'field crew can''t charge cards, nor see which invoices can be');
select tmanual.as_user(:'lou');
select tmanual.check(tmanual.error_of(format('select * from public.request_manual_charges(%L, %L, %L)', :'co', array[:'inv_a']::uuid[], array[45]::numeric[])) like '42501:%'
    and tmanual.error_of(format('select * from public.chargeable_invoices(%L)', :'co')) like '42501:%', 'nor can a crew lead');
select tmanual.as_user(:'eve');
select tmanual.check(tmanual.error_of(format('select * from public.request_manual_charges(%L, %L, %L)', :'co', array[:'inv_a']::uuid[], array[45]::numeric[])) like '42501:%'
    and tmanual.error_of(format('select * from public.chargeable_invoices(%L)', :'co')) like '42501:%', 'nor an estimator');
select tmanual.as_user(:'otto');
select tmanual.check(tmanual.error_of(format('select * from public.request_manual_charges(%L, %L, %L)', :'co', array[:'inv_a']::uuid[], array[45]::numeric[])) like '42501:%'
    and tmanual.error_of(format('select * from public.chargeable_invoices(%L)', :'co')) like '42501:%', 'nor the office without the invoices area');
select tmanual.as_user(:'sal');
select tmanual.check(tmanual.error_of(format('select * from public.request_manual_charges(%L, %L, %L)', :'co', array[:'inv_a']::uuid[], array[45]::numeric[])) like '42501:%'
    and tmanual.error_of(format('select * from public.chargeable_invoices(%L)', :'co')) like '42501:%', 'nor a sub');
select tmanual.as_user(:'pat');
select tmanual.check(tmanual.error_of(format('select * from public.request_manual_charges(%L, %L, %L)', :'co', array[:'inv_a']::uuid[], array[45]::numeric[])) like '42501:%'
    and tmanual.error_of(format('select * from public.chargeable_invoices(%L)', :'co')) like '42501:%', 'nor another business''s owner');
select tmanual.as_user(:'opal');
select tmanual.check(tmanual.error_of(format('select * from public.request_manual_charges(%L, %L, %L)', :'co', array(select gen_random_uuid() from generate_series(1, 51)), array_fill(1::numeric, array[51]))) = '22023: Choose up to 50 invoices at a time',
  'up to 50 at a time');
select tmanual.check(tmanual.error_of(format('select * from public.request_manual_charges(%L, %L, %L)', :'co', array[:'inv_a']::uuid[], '{}'::numeric[])) = '22023: Send the amount you saw for each invoice',
  'with the amount the office saw for each');
commit;
select tmanual.check(not exists (select 1 from public.autopay_charges where company_id = :'co'), 'and nothing was queued by any of them');

-- ===== The list ================================================================================

begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check((select array_agg(x.id order by x.ord) from public.chargeable_invoices(:'co') with ordinality x(id, number, client_id, client_name, balance_due, due_on, status, card, in_progress, live_status, live_detail, ord))
    = array[:'inv_u', :'inv_a']::uuid[],
  'the list: owed invoices whose client has a card they agreed to, newest first; not a draft, a paid or voided one, a client without a card or one paused');
select tmanual.check((select client_name = 'Pat Lee' and client_id = :'c_pat' and balance_due = 45 and status = 'sent' and card = 'Visa ending 4242' and not in_progress and live_status is null and live_detail is null and number = :'n_a'
    from public.chargeable_invoices(:'co') where id = :'inv_a'),
  'each with its number, client, what''s owed, the card''s name and nothing under way');
select tmanual.check((select count(*) from public.chargeable_invoices(:'co', :'inv_d')) = 1 and (select count(*) from public.chargeable_invoices(:'co', :'inv_s')) = 0
    and (select count(*) from public.chargeable_invoices(:'co', :'inv_o')) = 0,
  'asked about one invoice, a draft counts; one without a card, or another business''s, doesn''t');
commit;

-- ===== Charge card =============================================================================

-- What's owed changed from the amount the office confirmed (a line edited in between): nothing goes.
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.asked_for(:'co', array[:'inv_u']::uuid[], array[45]) as asked_changed \gset
commit;
select tmanual.check(:'asked_changed' = 'changed: The amount changed to $50.00. Check it and try again'
    and not exists (select 1 from public.autopay_charges where invoice_id = :'inv_u'),
  'an invoice owing other than the amount the office saw isn''t charged, and says what it owes now');

begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.asked(:'co', array[:'inv_a', :'inv_d', :'inv_a', :'inv_v', :'inv_z', :'inv_s', :'inv_k', :'inv_o']::uuid[]) as asked \gset
commit;
select tmanual.check(:'asked' = E'queued\nqueued\nnot_owed: It was voided\nnot_owed: It''s paid\nno_card: No saved card the client agreed to\nno_card: Autopay is paused for this client\nnot_found: Invoice not found',
  'each invoice once, in order: queued, or why not (voided, paid, no card, paused, another business''s)');
select tmanual.charge_of(:'inv_a') as ch_a \gset
select tmanual.charge_of(:'inv_d') as ch_d \gset
select tmanual.check((select source = 'manual' and status = 'waiting' and due_at <= now() and job_id is null and bill is null and client_id = :'c_pat'
         and payment_method_id = :'pm_pat' and approved_by = :'opal' and requested_by = :'opal' and approved_at is not null and approved_amount = 45
    from public.autopay_charges where id = :'ch_a')
    and (select approved_amount = 30 from public.autopay_charges where id = :'ch_d')
    and (select count(*) from public.autopay_charges where company_id = :'co') = 2,
  'a queued charge is due now, approved by who pressed it for what''s owed, on the card the client agreed to, with no job');
select tmanual.check((select actor_id = :'opal' and subject_type = 'invoice' and summary = format('Charging $45.00 to Pat Lee''s Visa ending 4242 for invoice #%s', :'n_a')
         and data ->> 'card' = 'Visa ending 4242' and (data ->> 'amount')::numeric = 45 and data ->> 'charge_id' = :'ch_a' and data ->> 'requested_by' = :'opal'
    from public.activity where verb = 'autopay.charge_requested' and subject_id = :'inv_a')
    and (select count(*) from public.activity where verb = 'autopay.charge_requested' and company_id = :'co') = 2,
  'an activity row for each: who, which invoice, how much and which card');
begin;
set local role authenticated;
select tmanual.as_user(:'eve');
select tmanual.check(not exists (select 1 from public.activity where verb = 'autopay.charge_requested'), 'an estimator doesn''t read them (they name the card)');
select tmanual.as_user(:'opal');
select tmanual.check(tmanual.asked(:'co', array[:'inv_a']::uuid[]) = 'in_progress: It''s being charged now'
    and (select in_progress and live_status = 'charging' and live_detail = 'It''s being charged now' from public.chargeable_invoices(:'co') where id = :'inv_a'),
  'pressed again, it''s already being charged, and the list says so');
commit;
select tmanual.check(tmanual.error_of(format('insert into public.autopay_charges (company_id, client_id, source, invoice_id, due_at) values (%L, %L, %L, %L, now())',
    :'co', :'c_pat', 'manual', :'inv_a')) like '23505:%',
  'the database holds one live charge to an invoice, whatever made it');
select tmanual.check(tmanual.error_of(format('insert into public.autopay_charges (company_id, client_id, source, bill, invoice_id, due_at) values (%L, %L, %L, %L, %L, now())',
      :'co', :'c_pat', 'manual', 'visits', :'inv_v')) like '23514:%'
    and tmanual.error_of(format('insert into public.autopay_charges (company_id, client_id, invoice_id, due_at) values (%L, %L, %L, now())', :'co', :'c_pat', :'inv_v')) like '23514:%',
  'a manual charge has no bill or job, and autopay''s own always have a bill');

-- The task charges them: no job, visits or cap to check (the draft is over the $20 cap), and the draft is marked sent.
select * from tmanual.claim(:'co') \gset
select tmanual.check(:'taken'::integer = 2, 'the task claims both');
select tmanual.charge(:'ch_a', :'token', 'paid') as bill_a \gset
select tmanual.charge(:'ch_d', :'token', 'paid') as bill_d \gset
select tmanual.check((:'bill_a'::jsonb) ->> 'outcome' = 'charge' and (:'bill_a'::jsonb) ->> 'invoice_status' = 'sent' and ((:'bill_a'::jsonb) ->> 'balance_due')::numeric = 45
    and (:'bill_a'::jsonb) #>> '{method,id}' = :'pm_pat'
    and (:'bill_d'::jsonb) ->> 'outcome' = 'charge' and (:'bill_d'::jsonb) ->> 'invoice_status' = 'draft' and ((:'bill_d'::jsonb) ->> 'balance_due')::numeric = 30,
  'each is billed to the card, the draft over the cap too');
select tmanual.check(tmanual.state(:'ch_a') = 'paid' and tmanual.state(:'ch_d') = 'paid' and (select charged_amount from public.autopay_charges where id = :'ch_d') = 30
    and (select status from public.invoices where id = :'inv_d') = 'sent'
    and (select count(*) from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' in (:'ch_a', :'ch_d')) = 2,
  'both paid, the draft sent (without an email), and a receipt queued for each');

-- Paid, then refunded and owed again: a paid charge doesn't count as live, so it can be charged again.
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_a', 45, 'card', 'stripe', 'pi_manual_a');
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_a', -45, 'card', 'stripe', 'pi_manual_a:refund:4500');
select tmanual.check(tmanual.state(:'ch_a') = 'paid' and (select balance_due from public.invoices where id = :'inv_a') = 45, 'the refund leaves it owed, its charge still paid');
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check(tmanual.asked(:'co', array[:'inv_a']::uuid[]) = 'queued', 'and Charge card queues another');
commit;
select tmanual.check((select count(*) from public.autopay_charges where invoice_id = :'inv_a') = 2, 'next to the paid one');
select tmanual.charge_of(:'inv_a') as ch_a2 \gset
select tmanual.charge(:'ch_a2', (tmanual.claim(:'co')).token, 'paid');

-- ===== A decline ===============================================================================

-- Not tried again by itself: the client gets the notice with the Pay link at once, and the office is
-- told. One decline the office asked for doesn't pause autopay for the client.
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.asked(:'co', array[:'inv_u']::uuid[]);
commit;
select tmanual.charge_of(:'inv_u') as ch_u \gset
select tmanual.charge(:'ch_u', (tmanual.claim(:'co')).token, 'declined', 'Your card was declined.');
select tmanual.check((select status = 'needs_client' and failures = 1 and decline_code = 'card_declined' and claim_token is null from public.autopay_charges where id = :'ch_u')
    and (select status from public.client_payment_methods where client_id = :'c_una') = 'active' and private.autopay_ready(:'co', :'c_una') is not null,
  'declined: it needs the client now, kept as a card decline, and the card isn''t paused');
select tmanual.check((select count(*) from public.outbox where topic = 'autopay.notice' and payload = jsonb_build_object('charge_id', :'ch_u', 'status', 'needs_client', 'failures', 1)) = 1
    and tmanual.told(:'opal', 'Autopay needs Una%') = 'Autopay needs Una Update | The card was declined, so they were sent the Pay link and a way to update their card.'
    and exists (select 1 from public.activity where verb = 'autopay.failed' and subject_id = :'inv_u' and data ->> 'status' = 'needs_client')
    and tmanual.told(:'cy') is null and tmanual.told(:'eve') is null and tmanual.told(:'otto') is null,
  'the client''s notice is queued, the office is told, and autopay.failed is noted; the crew and estimators hear nothing');
update public.autopay_charges set due_at = now() - interval '1 minute' where id = :'ch_u';
select tmanual.check((select taken from tmanual.claim(:'co')) = 0, 'it isn''t tried again by itself');
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check(tmanual.asked(:'co', array[:'inv_u']::uuid[]) = 'in_progress: It''s waiting on the client to pay or update their card'
    and (select in_progress and live_status = 'waiting_on_client' and live_detail = 'It''s waiting on the client to pay or update their card'
         from public.chargeable_invoices(:'co') where id = :'inv_u'),
  'and pressing Charge card again says it waits on the client, as the list does');
commit;
-- The client agrees to another card: it's tried on that one, now, and nobody is told again yet.
select public.autopay_save_payment_method(:'co', :'c_una', '{"stripe_payment_method_id": "pm_m_una_new", "stripe_customer_id": "cus_m_una_update", "livemode": false, "type": "card", "brand": "mastercard", "last4": "4444", "status": "active", "make_default": false}') as una_new \gset
select public.autopay_record_authorization(:'co', :'c_una', :'una_new', 'hub', private.autopay_terms_version(:'co'));
select tmanual.check((select status = 'failed' and failures = 0 and payment_method_id = :'una_new' and due_at <= now() from public.autopay_charges where id = :'ch_u'),
  'the client agrees to another card: the charge is due now on it');
select tmanual.charge(:'ch_u', (tmanual.claim(:'co')).token, 'paid') as bill_u \gset
select tmanual.check((:'bill_u'::jsonb) #>> '{method,id}' = :'una_new' and tmanual.state(:'ch_u') = 'paid', 'and charged to it');

-- ===== What's collecting it already ============================================================

-- A bank payment on its way through Stripe (the client paid the Pay link by bank), and an invoice
-- made in Stripe that's open there: Stripe is collecting both, as the invoice page says.
select tmanual.invoice(:'co', :'c_pat', 70) as inv_b \gset
insert into public.stripe_invoices (company_id, invoice_id, origin, status, collection, amount_due)
values (:'co', :'inv_b', 'crewtavo', 'processing', 'send_invoice', 70) returning id as si_b \gset
select tmanual.invoice(:'co', :'c_pat', 80) as inv_m \gset
insert into public.stripe_invoices (company_id, invoice_id, origin, status, collection, amount_due) values (:'co', :'inv_m', 'stripe', 'open', 'send_invoice', 80);
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check((select in_progress and live_status = 'bank_clearing' and live_detail = 'A bank payment for it is on its way'
         from public.chargeable_invoices(:'co') where id = :'inv_b')
    and not exists (select 1 from public.chargeable_invoices(:'co') where id = :'inv_m')
    and not exists (select 1 from public.chargeable_invoices(:'co', :'inv_m')),
  'the list shows a bank payment on its way as under way, and leaves out one made in Stripe');
select tmanual.check(tmanual.asked(:'co', array[:'inv_b', :'inv_m']::uuid[]) = E'in_progress: A bank payment for it is on its way\nnot_owed: It was made in Stripe. Charge it there',
  'and Charge card queues neither');
commit;
select tmanual.check(not exists (select 1 from public.autopay_charges where invoice_id in (:'inv_b', :'inv_m')), 'nothing was queued for them');
-- In a Stripe account Crewtavo has since left, it may still clear there for 30 days (as the charge
-- task counts it): still under way. After that it no longer holds the invoice back.
update public.stripe_invoices set detached_at = now() where id = :'si_b';
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check((select in_progress and live_status = 'bank_clearing' from public.chargeable_invoices(:'co') where id = :'inv_b'),
  'one in a Stripe account Crewtavo left still holds it back while it may clear there');
commit;
update public.stripe_invoices set detached_at = now() - interval '31 days' where id = :'si_b';
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check((select not in_progress and live_status is null from public.chargeable_invoices(:'co') where id = :'inv_b'),
  'and not once it can no longer clear');
commit;
-- An invoice made in Stripe is charged there even once it's no longer open in Stripe (paid, then
-- refunded and owed again; or detached after a switch of account).
update public.stripe_invoices set status = 'paid' where invoice_id = :'inv_m';
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check(not exists (select 1 from public.chargeable_invoices(:'co') where id = :'inv_m')
    and tmanual.asked(:'co', array[:'inv_m']::uuid[]) = 'not_owed: It was made in Stripe. Charge it there',
  'one made in Stripe and paid there is never offered or queued');
commit;
delete from public.invoices where id in (:'inv_b', :'inv_m');

-- ===== Charged again after a refund ============================================================

-- Its first charge's own Stripe invoice paid it, then a refund left it owed: a later charge is paid
-- only by a Stripe invoice of its own, never by that old one when the client pays another way.
select tmanual.invoice(:'co', :'c_pat', 50) as inv_r \gset
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.asked(:'co', array[:'inv_r']::uuid[]);
commit;
select tmanual.charge_of(:'inv_r') as ch_r1 \gset
insert into public.stripe_invoices (company_id, invoice_id, origin, status, collection, amount_due) values (:'co', :'inv_r', 'crewtavo', 'paid', 'charge_automatically', 50);
select tmanual.charge(:'ch_r1', (tmanual.claim(:'co')).token, 'paid');
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_r', 50, 'card', 'stripe', 'pi_r1');
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_r', -50, 'card', 'stripe', 'pi_r1:refund:5000');
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check(tmanual.asked(:'co', array[:'inv_r']::uuid[]) = 'queued', 'refunded and owed again, it''s charged again');
commit;
select tmanual.charge_of(:'inv_r') as ch_r2 \gset
-- The client pays the Pay link on Stripe's page before the task gets to it.
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_r', 50, 'card', 'stripe', 'pi_r_page');
select tmanual.check((select status from public.invoices where id = :'inv_r') = 'paid' and tmanual.state(:'ch_r2') = 'called_off: Paid another way'
    and not exists (select 1 from public.outbox where topic = 'autopay.receipt' and payload ->> 'charge_id' = :'ch_r2'),
  'paid on Stripe''s page: the new charge was paid another way, not by the old Stripe invoice, and there''s no receipt');
-- Again, the client paying while the task holds the charge.
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_r', -50, 'card', 'stripe', 'pi_r_page:refund:5000');
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.asked(:'co', array[:'inv_r']::uuid[]);
commit;
select tmanual.charge_of(:'inv_r') as ch_r3 \gset
select token as tok_r3 from tmanual.claim(:'co') \gset
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_r', 50, 'card', 'stripe', 'pi_r_page2');
select public.autopay_bill(:'ch_r3', :'tok_r3') as bill_r3 \gset
select tmanual.check((:'bill_r3'::jsonb) ->> 'outcome' = 'called_off' and (:'bill_r3'::jsonb) ->> 'reason' = 'Paid another way'
    and tmanual.state(:'ch_r3') = 'called_off: Paid another way',
  'and billing it finds it paid another way');
-- Its own Stripe invoice, made since it was queued, paying it: that's the charge's.
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_r', -50, 'card', 'stripe', 'pi_r_page2:refund:5000');
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.asked(:'co', array[:'inv_r']::uuid[]);
commit;
select tmanual.charge_of(:'inv_r') as ch_r4 \gset
select token as tok_r4 from tmanual.claim(:'co') \gset
insert into public.stripe_invoices (company_id, invoice_id, origin, status, collection, amount_due) values (:'co', :'inv_r', 'crewtavo', 'paid', 'charge_automatically', 50);
insert into public.payments (company_id, client_id, invoice_id, amount, method, processor, processor_ref) values (:'co', :'c_pat', :'inv_r', 50, 'card', 'stripe', 'pi_r4');
select tmanual.check(public.autopay_bill(:'ch_r4', :'tok_r4') ->> 'outcome' = 'paid' and tmanual.state(:'ch_r4') = 'paid',
  'one paid by its own Stripe invoice is paid by the card');

-- ===== What calls one off ======================================================================

-- The invoice changed after Charge card was pressed: never charged for more than the office saw.
select tmanual.invoice(:'co', :'c_pat', 60, true) as inv_c \gset
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.asked(:'co', array[:'inv_c']::uuid[]);
commit;
insert into public.invoice_line_items (company_id, invoice_id, name, unit_price) values (:'co', :'inv_c', 'Edging', 15);
select tmanual.charge_of(:'inv_c') as ch_c \gset
select tmanual.charge(:'ch_c', (tmanual.claim(:'co')).token, 'paid') as bill_c \gset
select tmanual.check((:'bill_c'::jsonb) ->> 'outcome' = 'called_off'
    and tmanual.state(:'ch_c') = 'called_off: The invoice changed after Charge card was pressed. Charge it again'
    and (select status from public.invoices where id = :'inv_c') = 'draft'
    and tmanual.told(:'opal', 'Send invoice #%') like 'Send invoice #% to Pat Lee the usual way | The invoice changed after Charge card was pressed. Charge it again',
  'an invoice that grew after Charge card was pressed is called off, left a draft, and the office told');

-- The client turns autopay off before it's charged.
select tmanual.invoice(:'co', :'c_tess', 35) as inv_t \gset
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.asked(:'co', array[:'inv_t']::uuid[]);
commit;
select tmanual.charge_of(:'inv_t') as ch_t \gset
select public.autopay_revoke(:'co', :'c_tess', 'client');
select tmanual.check(tmanual.state(:'ch_t') = 'called_off: Autopay was turned off'
    and tmanual.told(:'opal', 'Invoice #% for Tess%') like 'Invoice #% for Tess Turnoff wasn''t charged | Autopay was turned off. It''s owed as usual; send a reminder if they need the Pay link.',
  'autopay turned off for the client calls it off, and the office is told');

-- Autopay turned off in Settings after it was pressed, then before it's pressed.
select tmanual.invoice(:'co', :'c_pat', 15) as inv_e \gset
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.asked(:'co', array[:'inv_e']::uuid[]);
select tmanual.as_user(:'olive');
select public.autopay_set_settings(:'co', jsonb_build_object('enabled', false, 'terms', :'lawn_terms', 'timing', 'end_of_day',
  'days', null, 'max_amount', 20, 'receipts', true, 'jobs_default', false));
commit;
select tmanual.charge_of(:'inv_e') as ch_e \gset
select tmanual.charge(:'ch_e', (tmanual.claim(:'co')).token, 'paid');
select tmanual.check(tmanual.state(:'ch_e') = 'called_off: Autopay is turned off in Settings', 'turned off in Settings after it was pressed: called off');
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check(tmanual.asked(:'co', array[:'inv_e']::uuid[]) = 'autopay_off: Turn on autopay in Settings → Payments'
    and not exists (select 1 from public.chargeable_invoices(:'co')) and not exists (select 1 from public.chargeable_invoices(:'co', :'inv_e')),
  'and before: nothing to charge, and nothing listed');
select tmanual.as_user(:'olive');
select public.autopay_set_settings(:'co', jsonb_build_object('enabled', true, 'terms', :'lawn_terms', 'timing', 'end_of_day',
  'days', null, 'max_amount', 20, 'receipts', true, 'jobs_default', false));
commit;
update public.integrations set settings = '{"autopay": false}' where company_id = :'co' and provider = 'stripe';
begin;
set local role authenticated;
select tmanual.as_user(:'opal');
select tmanual.check(tmanual.asked(:'co', array[:'inv_e']::uuid[]) = 'autopay_off: Update your Stripe key on the Apps page'
    and not exists (select 1 from public.chargeable_invoices(:'co')),
  'nor while the Stripe key can''t charge cards');
commit;

-- ===== Who calls what ==========================================================================

select tmanual.check(bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute')),
  'Charge card and its list are for people signed in (each checks who), never signed out')
from unnest(array['public.request_manual_charges(uuid, uuid[], numeric[])', 'public.chargeable_invoices(uuid, uuid)']) f;
select tmanual.check(not has_function_privilege('authenticated', 'private.manual_charges_on(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'private.live_charge(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'private.stripe_collects(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'private.autopay_paid_by_charge(uuid, timestamp with time zone)', 'execute'),
  'and their helpers are the database''s own');

-- ===== Tidy up =================================================================================

delete from public.companies where id in (:'co', :'other');
delete from auth.users where email like '%@manual.test';

\o
\echo 'All manual charge tests passed.'
