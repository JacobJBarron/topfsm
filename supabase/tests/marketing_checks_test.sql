-- Database tests for the Marketing follow-ups (20261031000500_review_ask_fixes.sql,
-- 20261031000510_credit_covered_invoices.sql, 20261031000520_campaign_fixes.sql,
-- 20261031000530_social_review_relink.sql, 20261031000540_campaign_stop_counts.sql): every review
-- ask has a short random link token; a link checker, a preview or a scanner in the first 30 seconds
-- after the ask or a reminder isn't the client opening it, a later open is, once, and stops the
-- reminders; a copied link counts as an ask from when it's opened (the 6 months, the overview, the
-- Google match); an invoice a referral credit covers whole is said as covered, and the paid notice
-- asks for something paid; a run waiting on a busy email service is counted; emails waiting count
-- only quotes still as their rule asks; a review post's review is linked again when it comes back;
-- and a campaign stopped partway (on its page, by uninstalling Marketing, or before every stop wrote
-- its counts) says what went.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmc;
grant usage on schema tmc to authenticated, service_role;
create function tmc.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tmc.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
create function tmc.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- An invoice for a client with one line, sent.
create function tmc.invoice(p_company uuid, p_client uuid, p_amount numeric) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.invoices (company_id, client_id, issued_on) values (p_company, p_client, private.company_today(p_company)) returning id into v_id;
  insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable)
  values (p_company, v_id, 'Mowing', 1, 'ea', p_amount, false);
  update public.invoices set status = 'sent' where id = v_id;
  return v_id;
end $$;
-- Pays what's owed on an invoice.
create function tmc.pay(p_invoice uuid) returns void language sql as $$
  insert into public.payments (company_id, invoice_id, client_id, amount, method)
  select company_id, id, client_id, balance_due, 'check' from public.invoices where id = p_invoice
$$;
grant execute on all functions in schema tmc to authenticated, service_role;

\set mia 'e5c00000-0000-0000-0000-000000000001'

insert into auth.users (id, email, raw_user_meta_data) values (:'mia', 'mia@checks.test', '{"full_name": "Mia Owner"}');

begin;
set local role authenticated;
select tmc.as_user(:'mia');
select public.create_company('Checks Lawn Co', 'lawn_care') as co \gset
commit;
insert into public.clients (company_id, display_name, email, phone, status) values (:'co', 'Pete Nophone', 'pete@example.test', null, 'active') returning id as pete \gset
insert into public.clients (company_id, display_name, email, phone, status) values (:'co', 'Lou Linkcopy', 'lou@example.test', '+12025550111', 'active') returning id as lou \gset
insert into public.clients (company_id, display_name, email, phone, status) values (:'co', 'Rita Referrer', 'rita@example.test', '+12025550112', 'active') returning id as rita \gset
insert into public.clients (company_id, display_name, email, status) values (:'co', 'Quinn Quote', 'quinn@example.test', 'active') returning id as quinn \gset

-- ===== Short links ==============================================================================
select public.begin_review_request(:'co', :'pete', null, 'email') as ask1 \gset
select public.begin_review_request(:'co', :'lou', null, 'email') as ask2 \gset
select link_token as token1 from public.review_requests where id = :'ask1' \gset
select tmc.check((select bool_and(link_token ~ '^[0-9A-Za-z]{12}$') and count(distinct link_token) = count(*) from public.review_requests where id in (:'ask1', :'ask2')),
  'every ask has its own short link token: 12 letters and digits');
select tmc.check(tmc.error_of(format('update public.review_requests set link_token = (select link_token from public.review_requests where id = %L) where id = %L', :'ask1', :'ask2')) like '23505:%',
  'and no two asks share one');
select tmc.check((select count(distinct private.review_link_token()) = 200 from generate_series(1, 200)), 'tokens don''t repeat');

-- ===== Honest opens =============================================================================
update public.review_requests set next_reminder_at = now() + interval '3 days' where id = :'ask1';
-- Each open on its own, then a look: a statement doesn't see what a function it calls changed.
select public.track_review_click(p_token => :'token1', p_count => false) as found \gset
select tmc.check(:'found'::uuid = :'co'::uuid
  and (select clicked_at is null and status = 'sent' and next_reminder_at is not null from public.review_requests where id = :'ask1'),
  'a HEAD request or a link preview (p_count false) finds the ask and records nothing');
select public.track_review_click(p_token => :'token1') as found \gset
select tmc.check(:'found'::uuid = :'co'::uuid
  and (select clicked_at is null and next_reminder_at is not null from public.review_requests where id = :'ask1'),
  'an open seconds after the ask went (a mail scanner, a text''s preview) isn''t counted, and the reminders stay');
update public.review_requests set sent_at = now() - interval '2 minutes' where id = :'ask1';
select public.track_review_click(p_company => :'co', p_id => :'ask1') as found \gset
select tmc.check(:'found'::uuid = :'co'::uuid
  and (select status = 'clicked' and clicked_at is not null and next_reminder_at is null from public.review_requests where id = :'ask1'),
  'an open later is the client''s: counted, and the reminders stop (by the signed link''s company and ask)');
select clicked_at as first_click from public.review_requests where id = :'ask1' \gset
select pg_sleep(0.01);
select public.track_review_click(p_token => :'token1');
select tmc.check((select clicked_at = :'first_click'::timestamptz from public.review_requests where id = :'ask1'), 'once: opening it again keeps the first open');
-- A reminder just went: a scan of it isn't an open either.
update public.review_requests set sent_at = now() - interval '4 days', last_reminder_at = now(), reminders_sent = 1, next_reminder_at = now() + interval '2 days' where id = :'ask2';
select public.track_review_click(p_company => :'co', p_id => :'ask2');
select tmc.check((select clicked_at is null and next_reminder_at is not null from public.review_requests where id = :'ask2'),
  'an open in the first 30 seconds after a reminder isn''t counted');
select tmc.check(public.track_review_click(p_token => 'ZZZZZZZZZZZZ') is null and public.track_review_click(p_company => :'co', p_id => gen_random_uuid()) is null
  and public.track_review_click() is null,
  'a token or ask that isn''t there finds nothing');
select tmc.check(not has_function_privilege('anon', 'public.track_review_click(uuid, uuid, text, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.track_review_click(uuid, uuid, text, boolean)', 'execute')
  and has_function_privilege('service_role', 'public.track_review_click(uuid, uuid, text, boolean)', 'execute'),
  'only the server records opens');

-- ===== A copied link counts from when it's opened ===============================================
select public.begin_review_request(:'co', :'lou', null, 'link') as copied \gset
update public.review_requests set sent_at = now() - interval '100 days' where id = :'copied';
-- Lou's emailed ask (ask2) went 4 days ago; the copied link isn't an ask yet.
select tmc.check((select public.last_review_ask(:'co', :'lou') < now() - interval '3 days'), 'a link copied 100 days ago and never opened isn''t an ask');
delete from public.review_requests where id = :'ask2';
select tmc.check(public.last_review_ask(:'co', :'lou') is null, 'nor is it with nothing else');
select tmc.check(private.review_ask(:'co', :'lou', now()) is null, 'nor an ask a review answers');
select public.track_review_click(p_company => :'co', p_id => :'copied');
select tmc.check((select public.last_review_ask(:'co', :'lou') between now() - interval '1 minute' and now()),
  'opened today, it''s an ask from today: the 6 months run from the open, not the copy');
select tmc.check(public.begin_review_request(:'co', :'lou', null, 'email', 182) is null, 'so an automatic ask waits 6 months from today');
select tmc.check(private.review_ask(:'co', :'lou', now() + interval '1 day') = :'copied'::uuid
  and private.review_ask(:'co', :'lou', now() - interval '1 day') is null,
  'and a review posted after the open answers it, one before doesn''t');
select tmc.check(private.review_asked_at('sent', 'link', now() - interval '100 days', null) is null
  and private.review_asked_at('failed', 'email', now(), null) is null
  and private.review_asked_at('sent', 'email', '2026-01-01', null) = '2026-01-01'::timestamptz,
  'review_asked_at: when it went, a copied link when opened, a failed ask never');
begin;
set local role authenticated;
select tmc.as_user(:'mia');
select public.marketing_summary(:'co') as summary \gset
select public.review_stats(:'co') as stats \gset
commit;
select tmc.check((:'summary'::jsonb ->> 'reviews_requested_30d')::int = 2 and (:'summary'::jsonb ->> 'reviews_clicked_30d')::int = 2,
  'the overview counts the copied link opened today, and Pete''s ask, both opened');
select tmc.check((:'stats'::jsonb ->> 'asks_12m')::int = 2, 'and so do the Reviews tab''s 12 months');

-- ===== An invoice a referral credit covers whole ================================================
update public.companies set settings = settings || '{"referrals": {"reward": {"kind": "amount", "value": 15}}}' where id = :'co';
select tmc.invoice(:'co', :'rita', 15) as rita_inv \gset
select (public.record_referral(:'co', :'rita', 'Fiona Friend', 'fiona@example.test', null, '{"line1": "7 Birch Rd"}', null) ->> 'client_id')::uuid as fiona \gset
select tmc.invoice(:'co', :'fiona', 120) as fiona_inv \gset
select tmc.pay(:'fiona_inv');
select tmc.check((select status = 'paid' and amount_paid = 0 and credit_amount = 15 and total = 0 from public.invoices where id = :'rita_inv'),
  'Rita''s $15 invoice takes Fiona''s $15 credit whole: paid, with nothing paid');
select tmc.check((select summary = format('Invoice #%s for Rita Referrer covered by a referral credit', i.number)
                         and (a.data ->> 'covered_by_credit')::boolean and (a.data ->> 'amount_paid')::numeric = 0
                    from public.activity a join public.invoices i on i.id = a.subject_id
                   where a.subject_id = :'rita_inv' and a.verb = 'invoice.paid'),
  'its activity says a referral credit covered it, not "paid by Rita Referrer ($0.00)"');
select tmc.check((select summary like 'Invoice #% paid by Fiona Friend ($120.00)' and not (data ->> 'covered_by_credit')::boolean and (data ->> 'amount_paid')::numeric = 120
                    from public.activity where subject_id = :'fiona_inv' and verb = 'invoice.paid'),
  'an invoice paid in money still says who paid what');
select tmc.check((select conditions = '[{"field": "amount_paid", "op": "gte", "value": 0.01}]'::jsonb from public.automation_rules where company_id = :'co' and template_key = 'notify_invoice_paid'),
  'the paid notice asks for something paid, so nobody hears "Rita Referrer paid $0.00"');
select tmc.check((select count(*) = 1 from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                   where ru.company_id = :'co' and ru.template_key = 'notify_invoice_paid' and r.subject_id = :'rita_inv'),
  'invoice.paid still fires for it (a review ask after a paid invoice still goes): the engine skips the notice on its condition');

-- ===== A busy email service =====================================================================
select id as followup from public.automation_rules where company_id = :'co' and template_key = 'quote_followup' \gset
insert into public.automation_runs (company_id, rule_id, subject_type, subject_id, status, attempts, claim_token, locked_until)
values (:'co', :'followup', 'client', :'quinn', 'running', 1, '00000000-0000-4000-8000-00000000c1a1', now() + interval '5 minutes') returning id as busy_run \gset
select public.postpone_automation_run(:'busy_run', '00000000-0000-4000-8000-00000000c1a1', now() + interval '1 minute', '[]', 'Resend got too many emails at once.', true) as held \gset
select tmc.check(:'held'::boolean
  and (select status = 'pending' and busy_tries = 1 and attempts = 0 and run_after > now() from public.automation_runs where id = :'busy_run'),
  'a run waiting on a busy email service is put back and counted, without using an attempt');
update public.automation_runs set status = 'running', claim_token = '00000000-0000-4000-8000-00000000c1a2' where id = :'busy_run';
select public.postpone_automation_run(:'busy_run', '00000000-0000-4000-8000-00000000c1a2', now() + interval '9 hours', '[]', 'Quiet hours') as held \gset
select tmc.check(:'held'::boolean and (select busy_tries = 1 from public.automation_runs where id = :'busy_run'),
  'any other wait isn''t counted as busy');
select tmc.check(not has_function_privilege('authenticated', 'public.postpone_automation_run(bigint, uuid, timestamptz, jsonb, text, boolean)', 'execute'),
  'only the server puts runs back');
delete from public.automation_runs where id = :'busy_run';

-- ===== Emails waiting ===========================================================================
insert into public.quotes (company_id, client_id, title) values (:'co', :'quinn', 'Patio') returning id as q_waiting \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'quinn', 'Fence') returning id as q_approved \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'quinn', 'Gate') returning id as q_gone \gset
update public.quotes set status = 'sent', sent_at = now() where id in (:'q_waiting', :'q_approved', :'q_gone');
select tmc.check((select count(*) = 3 from public.automation_runs where rule_id = :'followup' and status = 'pending'), 'three quotes sent: three follow-ups queued');
update public.quotes set status = 'approved' where id = :'q_approved';
delete from public.quotes where id = :'q_gone';
select tmc.check(private.campaign_waiting(:'followup') = 1,
  'only the quote still awaiting a response counts as waiting: not one approved since, nor one deleted');
select tmc.check(private.wanted_status('[{"field": "status", "op": "equals", "value": "Sent"}]') = 'sent'
  and private.wanted_status('[{"field": "client.tags", "op": "includes", "value": ["vip"]}]') is null and private.wanted_status(null) is null,
  'wanted_status reads a rule''s "its status is" condition');
begin;
set local role authenticated;
select tmc.as_user(:'mia');
select public.automated_campaign_states(:'co') as states \gset
commit;
select tmc.check((select (e ->> 'waiting')::int = 1 from jsonb_array_elements(:'states'::jsonb) e where e ->> 'template_key' = 'quote_followup'),
  'the card and the turn-off question say 1 email waiting');
update public.automation_rules set conditions = '[]' where id = :'followup';
select tmc.check(private.campaign_waiting(:'followup') = 2, 'a rule with no status condition counts each quote that''s still there');

-- ===== A review post's review comes back ========================================================
insert into public.reviews (company_id, location_id, review_id, external_name, reviewer_name, rating, comment, posted_at, google_updated_at)
values (:'co', 'locations/9', 'r1', 'accounts/1/locations/9/reviews/r1', 'Gail Park', 5, 'Wonderful crew', now() - interval '1 day', now()) returning id as gail \gset
insert into public.social_posts (company_id, source, review_id, review_key, caption, networks, status, scheduled_for, automatic)
values (:'co', 'review', :'gail', 'locations/9/r1', 'Another 5-star review from a happy client. Thank you!', '{facebook}', 'scheduled', now() + interval '1 day', true) returning id as gail_post \gset
-- Disconnected with the reviews removed: the post keeps its review_key, not its review.
delete from public.reviews where id = :'gail';
select tmc.check((select review_id is null and review_key = 'locations/9/r1' from public.social_posts where id = :'gail_post'), 'removing the review leaves the post its key');
insert into public.reviews (company_id, location_id, review_id, external_name, reviewer_name, rating, comment, posted_at, google_updated_at)
values (:'co', 'locations/9', 'r1', 'accounts/2/locations/9/reviews/r1', 'Gail Park', 5, 'Wonderful crew', now() - interval '1 day', now()) returning id as gail_again \gset
select tmc.check((select review_id = :'gail_again' from public.social_posts where id = :'gail_post'),
  'brought in again, the same review is the post''s again, by its location and review ids');
insert into public.reviews (company_id, location_id, review_id, external_name, reviewer_name, rating, comment, posted_at, google_updated_at)
values (:'co', 'locations/9', 'r2', 'accounts/2/locations/9/reviews/r2', 'Ivan Ortiz', 5, 'Great', now(), now());
select tmc.check((select count(*) = 1 from public.social_posts where company_id = :'co' and review_id is not null), 'another review links nothing');

-- ===== A stopped campaign says what went =========================================================
-- Stopped on its page while it sends: 2 sent, 1 failed and 1 still to go.
insert into public.campaigns (company_id, name, subject, body, status, recipients_count, sent_count)
values (:'co', 'Fall cleanup', 'Fall', 'Book your fall cleanup', 'sending', 4, 0) returning id as fall \gset
insert into public.campaign_recipients (company_id, campaign_id, email, name, status) values
  (:'co', :'fall', 'ann@example.test', 'Ann', 'sent'), (:'co', :'fall', 'bo@example.test', 'Bo', 'sent'),
  (:'co', :'fall', 'cy@example.test', 'Cy', 'failed'), (:'co', :'fall', 'di@example.test', 'Di', 'pending');
update public.campaigns set status = 'cancelled', finished_at = now() where id = :'fall';
select tmc.check((select sent_count = 2 and failed_count = 1 from public.campaigns where id = :'fall'),
  'a campaign stopped partway keeps what went: "Stopped · 2 of 4 sent", 1 failed');
-- Stopped by uninstalling Marketing while it sends, between batches.
insert into public.campaigns (company_id, name, subject, body, status, recipients_count, sent_count)
values (:'co', 'Gutters', 'Gutters', 'Book your gutter cleaning', 'sending', 3, 0) returning id as gutters \gset
insert into public.campaign_recipients (company_id, campaign_id, email, name, status) values
  (:'co', :'gutters', 'ann@example.test', 'Ann', 'sent'), (:'co', :'gutters', 'bo@example.test', 'Bo', 'pending'),
  (:'co', :'gutters', 'cy@example.test', 'Cy', 'pending');
begin;
set local role authenticated;
select tmc.as_user(:'mia');
select public.marketing_set_enabled(:'co', false);
commit;
select tmc.check((select status = 'cancelled' and sent_count = 1 and failed_count = 0 from public.campaigns where id = :'gutters')
  and (select count(*) = 2 from public.campaign_recipients where campaign_id = :'gutters' and status = 'skipped'),
  'uninstalling Marketing stops a sending campaign with its counts written: "Stopped · 1 of 3 sent"');
begin;
set local role authenticated;
select tmc.as_user(:'mia');
select public.marketing_set_enabled(:'co', true);
commit;
-- Stopped before every stop wrote its counts: 3 of 10 went, and it says 0.
insert into public.campaigns (company_id, name, subject, body, status, recipients_count, sent_count, failed_count, finished_at)
values (:'co', 'Campaign Oct 31', 'Oct 31', 'Book now', 'cancelled', 10, 0, 0, now()) returning id as old_stop \gset
insert into public.campaign_recipients (company_id, campaign_id, email, name, status)
select :'co', :'old_stop', format('client%s@example.test', n), format('Client %s', n), case when n <= 3 then 'sent' else 'skipped' end
  from generate_series(1, 10) n;
-- A sent campaign's counts are the sender's: the backfill leaves them be.
insert into public.campaigns (company_id, name, subject, body, status, recipients_count, sent_count, finished_at)
values (:'co', 'Spring', 'Spring', 'Book your spring cleanup', 'sent', 5, 5, now()) returning id as spring \gset
select private.backfill_stopped_campaign_counts() as recounted \gset
select tmc.check(:'recounted'::int = 1 and (select sent_count = 3 and failed_count = 0 from public.campaigns where id = :'old_stop'),
  'a campaign stopped before is counted again from its recipients: "Stopped · 3 of 10 sent"');
select tmc.check((select sent_count = 5 from public.campaigns where id = :'spring') and (select sent_count = 2 from public.campaigns where id = :'fall'),
  'and only stopped campaigns whose counts were wrong are touched');
select tmc.check(private.backfill_stopped_campaign_counts() = 0, 'run again, it changes nothing');

set client_min_messages = warning;
drop schema tmc cascade;
reset client_min_messages;

\o
\echo 'All Marketing follow-up tests passed.'
