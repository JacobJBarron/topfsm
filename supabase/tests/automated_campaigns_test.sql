-- Database tests for automated campaigns, audiences and results (20261031000200_automated_campaigns.sql,
-- 20261031000210_campaign_audiences.sql, 20261031000220_campaign_results.sql): the two new starter
-- rules and their backfill; who client.inactive picks, once for each stretch without a visit, 100 a
-- day, each rule at its own N; recording a send once (6 months apart for re-engage, once a quote for
-- win-back), even at the same moment, and a send whose result wasn't recorded counting as sent;
-- past work that's over (a quoted request, a quote nobody answered for long, a job nobody closed);
-- the new audiences; opens and clicks; bookings and revenue after a click (not for work set up
-- before it, retainage once, gone with what they were for); uninstalling and changing a wait;
-- letting a backlog go and emailing it after all; and who reads and runs what.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tac;
grant usage on schema tac to authenticated, service_role;
create function tac.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tac.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
-- How many rows a statement changed (0 when row-level security hid every row from it).
create function tac.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
-- Signs in as someone, for the rest of the transaction.
create function tac.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- A client: an email made from the name unless one is given ('' makes one, null is none).
create function tac.client(p_company uuid, p_name text, p_email text default '', p_status text default 'active') returns uuid language sql as $$
  insert into public.clients (company_id, display_name, email, status)
  values (p_company, p_name, case when p_email = '' then lower(replace(p_name, ' ', '.')) || '@example.test' else p_email end, p_status)
  returning id
$$;
-- A finished job for the client, with one visit (p_kind) completed at p_at. The job's id.
create function tac.visited(p_company uuid, p_client uuid, p_at timestamptz, p_kind text default 'job') returns uuid language plpgsql as $$
declare v_job uuid;
begin
  insert into public.jobs (company_id, client_id, title, status) values (p_company, p_client, 'Cleanup', 'completed') returning id into v_job;
  insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at)
  values (p_company, v_job, 'Cleanup', p_kind, 'completed', (p_at at time zone 'UTC')::date, p_at);
  return v_job;
end $$;
-- Queues a company's client.inactive runs at p_now.
create function tac.emit(p_company uuid, p_now timestamptz, p_cap integer default 100) returns integer language sql as $$
  select public.emit_inactive_clients(p_now, p_cap, p_company)
$$;
-- The clients a rule has runs for, waiting or not.
create function tac.queued(p_rule uuid) returns uuid[] language sql as $$
  select coalesce(array_agg(subject_id order by subject_id), '{}') from public.automation_runs where rule_id = p_rule
$$;
create function tac.rule(p_company uuid, p_key text) returns uuid language sql as $$
  select id from public.automation_rules where company_id = p_company and template_key = p_key
$$;
-- An email sent on an automated campaign, p_ago before now: the recipient row.
create function tac.sent(p_company uuid, p_key text, p_client uuid, p_send text, p_ago interval default '0', p_links text[] default '{}', p_subject uuid default null)
returns bigint language plpgsql as $$
declare v_id bigint;
begin
  select id into v_id from public.begin_campaign_send(p_company, p_key, p_client, (select email from public.clients where id = p_client), 'Name', p_send,
    p_subject => p_subject, p_links => p_links);
  perform public.finish_campaign_send(v_id, 'sent');
  update public.campaign_recipients set sent_at = now() - p_ago where id = v_id;
  return v_id;
end $$;
-- An invoice for a client with one line, sent.
create function tac.invoice(p_company uuid, p_client uuid, p_amount numeric, p_tax numeric default 0, p_job uuid default null) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.invoices (company_id, client_id, tax_rate, issued_on, job_id)
  values (p_company, p_client, p_tax, private.company_today(p_company), p_job) returning id into v_id;
  insert into public.invoice_line_items (company_id, invoice_id, name, quantity, unit, unit_price, taxable)
  values (p_company, v_id, 'Service', 1, 'ea', p_amount, p_tax > 0);
  update public.invoices set status = 'sent' where id = v_id;
  return v_id;
end $$;
-- Pays what's owed on an invoice, with a payment (invoice_totals marks it paid).
create function tac.pay(p_invoice uuid) returns void language sql as $$
  insert into public.payments (company_id, invoice_id, client_id, amount, method)
  select company_id, id, client_id, balance_due, 'check' from public.invoices where id = p_invoice
$$;
-- Waits (up to 5 seconds) for another connection to be waiting on an advisory lock; false if none does.
create function tac.waiting_on_advisory() returns boolean language plpgsql as $$
begin
  for i in 1..50 loop
    if exists (select 1 from pg_locks where locktype = 'advisory' and not granted) then return true; end if;
    perform pg_sleep(0.1);
  end loop;
  return false;
end $$;
grant execute on all functions in schema tac to authenticated, service_role;
set client_min_messages = warning;
create extension if not exists dblink schema tac;
reset client_min_messages;
select extnamespace::regnamespace as dbl from pg_extension where extname = 'dblink' \gset

\set mia 'eac00000-0000-0000-0000-000000000001'
\set oli 'eac00000-0000-0000-0000-000000000002'
\set ivy 'eac00000-0000-0000-0000-000000000003'
\set mo 'eac00000-0000-0000-0000-000000000004'
\set cal 'eac00000-0000-0000-0000-000000000005'
\set oz 'eac00000-0000-0000-0000-000000000006'

-- Mia owns Maple Campaigns; Oli is office; Ivy is office in a Bookkeeper role (Invoices, not
-- Marketing); Mo is office in a Marketer role (Marketing, not Invoices); Cal is field crew. Oz owns
-- the other businesses.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mia', 'mia@maple.test', '{"full_name": "Mia Owner"}'),
  (:'oli', 'oli@maple.test', '{"full_name": "Oli Office"}'),
  (:'ivy', 'ivy@maple.test', '{"full_name": "Ivy Books"}'),
  (:'mo', 'mo@maple.test', '{"full_name": "Mo Marketer"}'),
  (:'cal', 'cal@maple.test', '{"full_name": "Cal Crew"}'),
  (:'oz', 'oz@other.test', '{"full_name": "Oz Other"}');

begin;
set local role authenticated;
select tac.as_user(:'mia');
select public.create_company('Maple Campaigns', 'lawn_care') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'office', '{invoices}') returning id as keeper \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Marketer', 'office', '{marketing,sales}') returning id as marketer \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'oli', 'office'), (:'co', :'cal', 'field_crew');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'ivy', 'office', :'keeper'), (:'co', :'mo', 'office', :'marketer');
commit;
begin;
set local role authenticated;
select tac.as_user(:'oz');
select public.create_company('Birch Lawn', 'lawn_care') as birch \gset
select public.create_company('London Lawns', 'lawn_care') as london \gset
select public.create_company('Pace Lawn', 'lawn_care') as pace \gset
select public.create_company('Duo Lawn', 'lawn_care') as duo \gset
select public.create_company('Booked Lawn', 'lawn_care') as book \gset
select public.create_company('Past Lawn', 'lawn_care') as past \gset
select public.create_company('Vip Lawn', 'lawn_care') as vip \gset
commit;
update public.companies set timezone = 'America/New_York' where id in (:'co', :'birch', :'pace', :'duo', :'book', :'past', :'vip');
update public.companies set timezone = 'Europe/London' where id = :'london';
-- 11am in New York today, when the emitter runs.
select (date_trunc('day', now() at time zone 'America/New_York') + interval '11 hours') at time zone 'America/New_York' as at11 \gset

-- ===== The starter rules =====================================================================
select tac.check((select not enabled and trigger = 'client.inactive' and delay_minutes = 0 and name = 'Re-engage past clients'
                         and description = 'Emails clients a year after their last visit, once each time they go quiet.'
                         and conditions = '[{"field": "days_since_visit", "op": "gte", "value": 365}]'
                         and actions = jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
                           'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr just reply to this email and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}\n{{company.phone}}'))
                    from public.automation_rules where company_id = :'co' and template_key = 'reengage_past_clients'),
  'a new business gets Re-engage past clients: off, at 365 days, with its email');
select tac.check((select not enabled and trigger = 'quote.lost' and delay_minutes = 43200 and name = 'Win back lost quotes'
                         and conditions = '[{"field": "status", "op": "equals", "value": "lost"}]'
                         and actions -> 0 ->> 'subject' = 'Still thinking about {{title}}?' and actions -> 0 ->> 'body' like '%{{link}}%'
                         and actions -> 0 ->> 'body' like E'%\n\nThanks,\n{{company.name}}\n{{company.phone}}' and actions -> 0 ->> 'body' not like '%or call%'
                    from public.automation_rules where company_id = :'co' and template_key = 'win_back_lost_quotes'),
  'and Win back lost quotes: off, 30 days after a quote is marked lost, if it still is, its phone under the name so none leaves no gap');
select tac.check((select count(*) = 14 from public.automation_rules where company_id = :'co'), 'fourteen starter rules in all');
delete from public.automation_rules where company_id in (:'co', :'birch') and template_key in ('reengage_past_clients', 'win_back_lost_quotes', 'review_after_job');
select tac.check(private.add_campaign_rules() >= 4, 'add_campaign_rules gives every business without them the two rules');
select tac.check((select count(*) = 4 from public.automation_rules where company_id in (:'co', :'birch') and template_key in ('reengage_past_clients', 'win_back_lost_quotes') and not enabled)
  and not exists (select 1 from public.automation_rules where company_id in (:'co', :'birch') and template_key = 'review_after_job'),
  'off, and it doesn''t bring back a starter rule the business deleted');
select tac.check(private.add_campaign_rules() = 0, 'run again, it adds nothing');
select tac.check((select bool_and(actions -> 0 ->> 'body' like E'%{{company.name}}\n{{company.phone}}') from public.automation_rules
                   where company_id in (:'co', :'birch') and template_key in ('reengage_past_clients', 'win_back_lost_quotes')),
  'with the wording that reads well without a phone');
select private.install_default_automations(:'co');
select tac.check((select count(*) = 14 from public.automation_rules where company_id = :'co'), 'setting up the starter rules again adds only what''s missing');
select tac.rule(:'co', 'reengage_past_clients') as reengage \gset
select tac.rule(:'co', 'win_back_lost_quotes') as winback \gset
select tac.rule(:'co', 'quote_followup') as followup \gset
select tac.check(private.inactive_days('[]') = 365 and private.inactive_days('[{"field": "days_since_visit", "op": "gte", "value": 90}, {"field": "days_since_visit", "op": "gte", "value": "200"}]') = 200
  and private.inactive_days('[{"field": "days_since_visit", "op": "gte", "value": 5}]') = 30 and private.inactive_days('[{"field": "status", "op": "equals", "value": "active"}]') = 365,
  'inactive_days: the largest days condition, never under 30, a year without one');

-- ===== Who client.inactive picks =============================================================
select tac.client(:'co', 'In Four Hundred') as c_in \gset
select tac.visited(:'co', :'c_in', :'at11'::timestamptz - interval '400 days');
select tac.client(:'co', 'Out Three Hundred') as c_300 \gset
select tac.visited(:'co', :'c_300', :'at11'::timestamptz - interval '300 days');
select tac.client(:'co', 'Never Visited') as c_none \gset
select tac.client(:'co', 'Future Booked') as c_future \gset
select tac.visited(:'co', :'c_future', :'at11'::timestamptz - interval '400 days') as j_future \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'j_future', 'Spring cleanup', (:'at11'::timestamptz at time zone 'America/New_York')::date + 5);
select tac.client(:'co', 'Past Scheduled') as c_past \gset
select tac.visited(:'co', :'c_past', :'at11'::timestamptz - interval '400 days') as j_past \gset
insert into public.visits (company_id, job_id, title, scheduled_on) values (:'co', :'j_past', 'Missed one', (:'at11'::timestamptz at time zone 'America/New_York')::date - 30);
select tac.client(:'co', 'Recurring Rae') as c_recurring \gset
select tac.visited(:'co', :'c_recurring', :'at11'::timestamptz - interval '400 days');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule) values (:'co', :'c_recurring', 'Weekly mow', 'recurring', 'FREQ=WEEKLY');
select tac.client(:'co', 'Archived Al', '', 'archived') as c_archived \gset
select tac.visited(:'co', :'c_archived', :'at11'::timestamptz - interval '400 days');
select tac.client(:'co', 'Opted Out') as c_optout \gset
update public.clients set marketing_opt_out = true where id = :'c_optout';
select tac.visited(:'co', :'c_optout', :'at11'::timestamptz - interval '400 days');
select tac.client(:'co', 'No Email', null) as c_noemail \gset
select tac.visited(:'co', :'c_noemail', :'at11'::timestamptz - interval '400 days');
select tac.client(:'co', 'Bad Email', 'not-an-email') as c_bademail \gset
select tac.visited(:'co', :'c_bademail', :'at11'::timestamptz - interval '400 days');
select tac.client(:'co', 'Task Tim') as c_task \gset
select tac.visited(:'co', :'c_task', :'at11'::timestamptz - interval '400 days') as j_task \gset
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at)
values (:'co', :'j_task', 'Call about mulch', 'task', 'completed', (:'at11'::timestamptz - interval '10 days')::date, :'at11'::timestamptz - interval '10 days');
select tac.client(:'co', 'Unbooked Uma') as c_unbooked \gset
select tac.visited(:'co', :'c_unbooked', :'at11'::timestamptz - interval '400 days') as j_unbooked \gset
insert into public.visits (company_id, job_id, title, status) values (:'co', :'j_unbooked', 'To book', 'unscheduled');
select tac.client(:'co', 'Active Ava') as c_active \gset
select tac.visited(:'co', :'c_active', :'at11'::timestamptz - interval '400 days');
insert into public.jobs (company_id, client_id, title) values (:'co', :'c_active', 'Sold, not booked');
select tac.client(:'co', 'Request Ray') as c_request \gset
select tac.visited(:'co', :'c_request', :'at11'::timestamptz - interval '400 days');
insert into public.requests (company_id, client_id, title) values (:'co', :'c_request', 'Look at the drainage');
select tac.client(:'co', 'Quoted Quinn') as c_quoted \gset
select tac.visited(:'co', :'c_quoted', :'at11'::timestamptz - interval '400 days');
insert into public.quotes (company_id, client_id, title, status) values (:'co', :'c_quoted', 'Patio', 'sent');
select tac.client(:'co', 'Long Gone') as c_old \gset
select tac.visited(:'co', :'c_old', :'at11'::timestamptz - interval '4 years');
select tac.client(:'co', 'Assessed Ann') as c_assessed \gset
insert into public.requests (company_id, client_id, title, status) values (:'co', :'c_assessed', 'Estimate', 'archived') returning id as r_assessed \gset
insert into public.visits (company_id, request_id, title, kind, status, scheduled_on, completed_at)
values (:'co', :'r_assessed', 'Estimate visit', 'assessment', 'completed', (:'at11'::timestamptz - interval '400 days')::date, :'at11'::timestamptz - interval '400 days');

select tac.check(tac.emit(:'co', :'at11') = 0, 'nothing while the rule is off');
update public.automation_rules set enabled = true where id = :'reengage';
select tac.check(tac.emit(:'co', :'at11'::timestamptz - interval '2 hours') = 0, 'nor before 10am in the company''s time zone');
select tac.check(tac.emit(:'co', :'at11'::timestamptz + interval '6 hours') = 0, 'nor after 5pm');
select tac.check(tac.emit(:'co', :'at11') = 4, 'from 10am, four clients are queued');
select tac.check(tac.queued(:'reengage') = (select array_agg(x order by x) from unnest(array[:'c_in', :'c_past', :'c_task', :'c_assessed']::uuid[]) x),
  'a year since their last visit (an assessment too, and a visit booked in the past that never happened), and a completed task doesn''t count as a visit; not 300 days, no visits, a visit to come or not yet booked, active work, an open request or quote, archived, opted out, no usable email, or 4 years ago');
select tac.check((select bool_and(r.status = 'pending' and r.subject_type = 'client' and r.run_after = :'at11'::timestamptz and r.activity_id is null)
                    from public.automation_runs r where r.rule_id = :'reengage'),
  'runs on the client, due now, with no activity row (the bell isn''t flooded)');
select tac.check((select last_visit_at = :'at11'::timestamptz - interval '400 days' and run_id is not null from public.inactive_client_marks where rule_id = :'reengage' and client_id = :'c_task'),
  'the stretch is marked by their last visit');

-- Marketing off, and another time zone.
select tac.client(:'birch', 'Birch Bea') as b_bea \gset
select tac.visited(:'birch', :'b_bea', :'at11'::timestamptz - interval '400 days');
update public.automation_rules set enabled = true where company_id = :'birch' and template_key = 'reengage_past_clients';
update public.companies set settings = jsonb_set(settings, '{marketing,enabled}', 'false') where id = :'birch';
select tac.check(tac.emit(:'birch', :'at11') = 0, 'nothing while Marketing is off');
update public.companies set settings = jsonb_set(settings, '{marketing,enabled}', 'true') where id = :'birch';
select tac.client(:'london', 'London Lou') as l_lou \gset
select tac.visited(:'london', :'l_lou', :'at11'::timestamptz - interval '400 days');
update public.automation_rules set enabled = true where company_id = :'london' and template_key = 'reengage_past_clients';
-- 9am in New York is the afternoon in London.
select public.emit_inactive_clients(:'at11'::timestamptz - interval '2 hours', 100) as early \gset
select tac.check((select count(*) = 1 from public.automation_runs where company_id = :'london') and (select count(*) = 0 from public.automation_runs where company_id = :'birch'),
  'at the same moment, a company where it''s past 10am is queued and one where it isn''t waits');
select tac.check(tac.emit(:'birch', :'at11') = 1, 'and Birch is queued at its own 10am');

-- ===== Once for each stretch =================================================================
select tac.check(tac.emit(:'co', :'at11'::timestamptz + interval '1 hour') = 0 and tac.emit(:'co', :'at11'::timestamptz + interval '1 day') = 0,
  'later the same day, and the next day, nobody is queued twice');
update public.automation_runs set status = 'cancelled', finished_at = now(), error = 'Cancelled by the office'
 where rule_id = :'reengage' and subject_id = :'c_past';
select tac.check(tac.emit(:'co', :'at11'::timestamptz + interval '2 days') = 0, 'a run the office cancelled stays cancelled');
update public.automation_rules set enabled = false where id = :'reengage';
select tac.check((select count(*) = 0 from public.automation_runs where rule_id = :'reengage' and status = 'pending')
  and (select count(*) = 1 from public.inactive_client_marks where rule_id = :'reengage'),
  'turning the rule off cancels what''s waiting and lets those stretches go');
update public.automation_rules set enabled = true where id = :'reengage';
select tac.emit(:'co', :'at11'::timestamptz + interval '2 days') as reemitted \gset
select tac.check(:'reemitted' = 3
  and (select count(*) = 2 from public.automation_runs where rule_id = :'reengage' and subject_id = :'c_in'),
  'turned on again, the clients it called off are queued again (not the one cancelled by hand)');
-- A new visit starts a new stretch.
select tac.visited(:'co', :'c_in', :'at11'::timestamptz + interval '3 days');
select tac.emit(:'co', :'at11'::timestamptz + interval '200 days');
select tac.check((select count(*) = 2 from public.automation_runs where rule_id = :'reengage' and subject_id = :'c_in'), 'a visit since: not until a year after it');
select tac.emit(:'co', :'at11'::timestamptz + interval '369 days');
select tac.check((select count(*) = 3 from public.automation_runs where rule_id = :'reengage' and subject_id = :'c_in')
  and (select count(distinct last_visit_at) = 2 from public.inactive_client_marks where rule_id = :'reengage' and client_id = :'c_in'),
  'a year after the new visit, a second stretch, queued again');

-- ===== 100 a day =============================================================================
update public.automation_rules set enabled = true where company_id = :'pace' and template_key = 'reengage_past_clients';
select tac.rule(:'pace', 'reengage_past_clients') as pace_rule \gset
select count(*) from (select tac.visited(:'pace', tac.client(:'pace', 'Past ' || n), :'at11'::timestamptz - make_interval(days => 399 + n)) from generate_series(1, 150) n) x;
select tac.check(tac.emit(:'pace', :'at11') = 100, '150 qualify: 100 are queued today');
select tac.check((select min(m.last_visit_at) from public.inactive_client_marks m where m.rule_id = :'pace_rule')
                   > (select max(v.completed_at) from public.visits v join public.jobs j on j.id = v.job_id
                       where j.company_id = :'pace' and j.client_id not in (select client_id from public.inactive_client_marks where rule_id = :'pace_rule')),
  'those who passed a year most recently first');
select tac.check(tac.emit(:'pace', :'at11'::timestamptz + interval '3 hours') = 0, 'later the same day, none');
select tac.check(tac.emit(:'pace', :'at11'::timestamptz + interval '1 day') = 50, 'the next day, the other 50');

-- ===== Each rule at its own N ================================================================
update public.automation_rules set enabled = true, conditions = '[{"field": "days_since_visit", "op": "gte", "value": 90}]'
 where company_id = :'duo' and template_key = 'reengage_past_clients';
select tac.rule(:'duo', 'reengage_past_clients') as duo_90 \gset
insert into public.automation_rules (company_id, name, trigger, conditions, actions)
values (:'duo', 'Re-engage after a year', 'client.inactive', '[{"field": "days_since_visit", "op": "gte", "value": 365}]', '[{"type": "send_email", "subject": "Hi", "body": "Come back"}]')
returning id as duo_365 \gset
insert into public.automation_rules (company_id, name, trigger, conditions, actions)
values (:'duo', 'Re-engage, no days set', 'client.inactive', '[]', '[{"type": "add_tag", "tag": "Quiet"}]')
returning id as duo_none \gset
select tac.client(:'duo', 'Hundred Days') as d_100 \gset
select tac.visited(:'duo', :'d_100', :'at11'::timestamptz - interval '100 days');
select tac.client(:'duo', 'Four Hundred Days') as d_400 \gset
select tac.visited(:'duo', :'d_400', :'at11'::timestamptz - interval '400 days');
select tac.client(:'duo', 'Emailed Lately') as d_emailed \gset
select tac.visited(:'duo', :'d_emailed', :'at11'::timestamptz - interval '400 days');
select tac.sent(:'duo', 'reengage_past_clients', :'d_emailed', 'run:earlier', interval '30 days');
select tac.check(tac.emit(:'duo', :'at11') = 4, 'three rules on client.inactive queue four runs between them');
select tac.check(tac.queued(:'duo_90') = (select array_agg(x order by x) from unnest(array[:'d_100', :'d_400']::uuid[]) x)
  and tac.queued(:'duo_365') = array[:'d_400']::uuid[] and tac.queued(:'duo_none') = array[:'d_400']::uuid[],
  'each at its own N (one without the condition at a year), and nobody sent a re-engage email in the last 6 months');

-- ===== Past work that's over ================================================================
-- Each last visited 400 days ago. Work that's over doesn't keep them out; work still going does.
update public.automation_rules set enabled = true where company_id = :'past' and template_key = 'reengage_past_clients';
select tac.rule(:'past', 'reengage_past_clients') as past_rule \gset
select tac.client(:'past', 'Quoted Then Lost') as p_lost \gset
select tac.visited(:'past', :'p_lost', :'at11'::timestamptz - interval '400 days');
insert into public.requests (company_id, client_id, title, status) values (:'past', :'p_lost', 'Patio', 'quoted') returning id as p_lost_req \gset
insert into public.quotes (company_id, client_id, title, request_id, status, sent_at, updated_at)
values (:'past', :'p_lost', 'Patio', :'p_lost_req', 'lost', now() - interval '230 days', now() - interval '200 days');
select tac.client(:'past', 'Expired Quote') as p_expired \gset
select tac.visited(:'past', :'p_expired', :'at11'::timestamptz - interval '400 days');
insert into public.quotes (company_id, client_id, title, status, valid_until) values (:'past', :'p_expired', 'Fence', 'sent', private.company_today(:'past') - 10);
select tac.client(:'past', 'Undated Old Quote') as p_undated \gset
select tac.visited(:'past', :'p_undated', :'at11'::timestamptz - interval '400 days');
insert into public.quotes (company_id, client_id, title, status) values (:'past', :'p_undated', 'Deck', 'sent') returning id as p_undated_q \gset
update public.quotes set sent_at = now() - interval '200 days', valid_until = null where id = :'p_undated_q';
-- A quote is recent contact for 6 months, whatever came of it: Win back looks after a lost one.
select tac.client(:'past', 'Lost Lately') as p_lost_lately \gset
select tac.visited(:'past', :'p_lost_lately', :'at11'::timestamptz - interval '400 days');
insert into public.quotes (company_id, client_id, title, status) values (:'past', :'p_lost_lately', 'Pergola', 'lost');
select tac.client(:'past', 'Sent Lately') as p_sent_lately \gset
select tac.visited(:'past', :'p_sent_lately', :'at11'::timestamptz - interval '400 days');
insert into public.quotes (company_id, client_id, title, status, valid_until, sent_at)
values (:'past', :'p_sent_lately', 'Shed', 'archived', private.company_today(:'past') - 30, now() - interval '60 days');
select tac.client(:'past', 'Never Closed') as p_open_job \gset
insert into public.jobs (company_id, client_id, title) values (:'past', :'p_open_job', 'Spring cleanup') returning id as p_open_job_id \gset
insert into public.visits (company_id, job_id, title, status, scheduled_on, completed_at)
values (:'past', :'p_open_job_id', 'Cleanup', 'completed', (:'at11'::timestamptz - interval '400 days')::date, :'at11'::timestamptz - interval '400 days');
select tac.client(:'past', 'Recurring Ended') as p_ended \gset
select tac.visited(:'past', :'p_ended', :'at11'::timestamptz - interval '400 days');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, status) values (:'past', :'p_ended', 'Weekly mow', 'recurring', 'FREQ=WEEKLY', 'completed');
select tac.client(:'past', 'Fresh Quote') as p_fresh \gset
select tac.visited(:'past', :'p_fresh', :'at11'::timestamptz - interval '400 days');
insert into public.quotes (company_id, client_id, title, status, valid_until) values (:'past', :'p_fresh', 'Gutters', 'sent', private.company_today(:'past') + 10);
select tac.client(:'past', 'Changes Asked') as p_changes \gset
select tac.visited(:'past', :'p_changes', :'at11'::timestamptz - interval '400 days');
insert into public.quotes (company_id, client_id, title, status) values (:'past', :'p_changes', 'Walkway', 'changes_requested') returning id as p_changes_q \gset
update public.quotes set sent_at = now() - interval '10 days', valid_until = null where id = :'p_changes_q';
select tac.client(:'past', 'Approved Abe') as p_approved \gset
select tac.visited(:'past', :'p_approved', :'at11'::timestamptz - interval '400 days');
insert into public.quotes (company_id, client_id, title, status) values (:'past', :'p_approved', 'Retaining wall', 'approved');
select tac.client(:'past', 'Assessed Open') as p_assessing \gset
select tac.visited(:'past', :'p_assessing', :'at11'::timestamptz - interval '400 days');
insert into public.requests (company_id, client_id, title, status) values (:'past', :'p_assessing', 'Drainage', 'assessment_complete');
select tac.client(:'past', 'Running Recurring') as p_recurring \gset
select tac.visited(:'past', :'p_recurring', :'at11'::timestamptz - interval '400 days');
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule) values (:'past', :'p_recurring', 'Weekly mow', 'recurring', 'FREQ=WEEKLY');
select tac.client(:'past', 'Sold Sam') as p_sold \gset
select tac.visited(:'past', :'p_sold', :'at11'::timestamptz - interval '400 days');
insert into public.jobs (company_id, client_id, title) values (:'past', :'p_sold', 'New patio') returning id as p_sold_job \gset
insert into public.visits (company_id, job_id, title, kind, status, scheduled_on, completed_at)
values (:'past', :'p_sold_job', 'Call about pavers', 'task', 'completed', (:'at11'::timestamptz - interval '20 days')::date, :'at11'::timestamptz - interval '20 days');
-- One whose re-engage email went out but wasn't recorded sent (still 'sending', a day on).
select tac.client(:'past', 'Unrecorded Ursula') as p_unrecorded \gset
select tac.visited(:'past', :'p_unrecorded', :'at11'::timestamptz - interval '400 days');
select id as p_unrecorded_send from public.begin_campaign_send(:'past', 'reengage_past_clients', :'p_unrecorded', 'unrecorded.ursula@example.test', 'Ursula', 'run:earlier', p_gap_days => 182) \gset
update public.campaign_recipients set claimed_at = now() - interval '1 day' where id = :'p_unrecorded_send';
select tac.check(tac.emit(:'past', :'at11') = 5, 'five of them are queued');
select tac.check(tac.queued(:'past_rule') = (select array_agg(x order by x) from unnest(array[:'p_lost', :'p_expired', :'p_undated', :'p_open_job', :'p_ended']::uuid[]) x),
  'a request quoted and then lost, a quote past its valid-until date or sent long ago without one, a job whose visits are done though nobody closed it, and recurring work that ended don''t keep a client out');
select tac.check(not (tac.queued(:'past_rule') && array[:'p_fresh', :'p_changes', :'p_approved', :'p_assessing', :'p_recurring', :'p_sold', :'p_unrecorded']::uuid[]),
  'a quote still in date, changes asked for lately, an approved quote, a request at its assessment, active recurring work, a job sold with only a task done, and an email that went unrecorded do');
select tac.check(not (tac.queued(:'past_rule') && array[:'p_lost_lately', :'p_sent_lately']::uuid[]),
  'and so does a quote marked lost or sent in the last 6 months, so a client isn''t re-engaged on top of Win back');

-- ===== A rule's other conditions ===========================================================
-- Changed in Automations to "client tags include vip": counted, queued and let go as the engine
-- checks it, so clients it would skip don't use up the day's 100 or their stretch.
select tac.check(private.client_conditions_hold('[{"field": "client.tags", "op": "includes", "value": ["VIP"]}]', 'active', '{vip,mow}', null, 400)
  and not private.client_conditions_hold('[{"field": "client.tags", "op": "includes", "value": ["vip"]}]', 'active', '{mow}', null, 400)
  and private.client_conditions_hold('[{"field": "client.tags", "op": "excludes", "value": ["vip"]}]', 'active', '{}', null, 400)
  and private.client_conditions_hold('[{"field": "status", "op": "equals", "value": "active"}, {"field": "client.lead_source", "op": "contains", "value": "goo"}]', 'active', '{}', 'Google', 400)
  and not private.client_conditions_hold('[{"field": "client.status", "op": "not_equals", "value": "lead"}]', 'lead', '{}', null, 400)
  and private.client_conditions_hold('[{"field": "status", "op": "in", "value": "lead, active"}]', 'active', '{}', null, 400)
  and private.client_conditions_hold('[{"field": "days_since_visit", "op": "gte", "value": 365}, {"field": "days_since_visit", "op": "lte", "value": 500}]', 'active', '{}', null, 400)
  and not private.client_conditions_hold('[{"field": "days_since_visit", "op": "lte", "value": 300}]', 'active', '{}', null, 400)
  and not private.client_conditions_hold('[{"field": "days_since_visit", "op": "gte", "value": "a year"}]', 'active', '{}', null, 400)
  and not private.client_conditions_hold('[{"field": "amount", "op": "gte", "value": 100}]', 'active', '{}', null, 400)
  and private.client_conditions_hold('[{"field": "amount", "op": "lte", "value": 100}]', 'active', '{}', null, 400),
  'client_conditions_hold checks tags, status, lead source and days as the engine does, a field a client hasn''t as empty');
update public.automation_rules set enabled = true,
       conditions = '[{"field": "days_since_visit", "op": "gte", "value": 400}, {"field": "client.tags", "op": "includes", "value": ["vip"]}]'
 where company_id = :'vip' and template_key = 'reengage_past_clients';
select tac.rule(:'vip', 'reengage_past_clients') as vip_rule \gset
select tac.client(:'vip', 'Maria Vip') as v_maria \gset
select tac.visited(:'vip', :'v_maria', :'at11'::timestamptz - interval '420 days');
update public.clients set tags = '{vip}' where id = :'v_maria';
select tac.sent(:'vip', 'reengage_past_clients', :'v_maria', 'run:earlier', interval '30 days');
select tac.client(:'vip', 'Val Vip') as v_val \gset
select tac.visited(:'vip', :'v_val', :'at11'::timestamptz - interval '420 days');
update public.clients set tags = '{VIP, mow}' where id = :'v_val';
select count(*) from (select tac.visited(:'vip', tac.client(:'vip', 'Plain ' || n), :'at11'::timestamptz - interval '420 days') from generate_series(1, 5) n) x;
begin;
set local role authenticated;
select tac.as_user(:'oz');
select tac.check(public.inactive_client_count(:'vip', 400) = 1,
  'the count is only the vip client not emailed lately, not every client past the days');
commit;
select tac.check(tac.emit(:'vip', :'at11', 1) = 1 and tac.queued(:'vip_rule') = array[:'v_val']::uuid[]
  and not exists (select 1 from public.inactive_client_marks where rule_id = :'vip_rule' and client_id <> :'v_val'),
  'only the client the rule would email is queued, and only their stretch is marked');
-- A run the engine skipped (the tag came off in between) leaves room in the day's cap.
update public.automation_runs set status = 'skipped', finished_at = now() where rule_id = :'vip_rule';
select tac.client(:'vip', 'Vic Vip') as v_vic \gset
select tac.visited(:'vip', :'v_vic', :'at11'::timestamptz - interval '410 days');
update public.clients set tags = '{vip}' where id = :'v_vic';
select tac.check(tac.emit(:'vip', :'at11'::timestamptz + interval '1 hour', 1) = 1 and :'v_vic' = any (tac.queued(:'vip_rule')),
  'a skipped run doesn''t count against the day''s cap');
update public.automation_runs set status = 'done', finished_at = now() where rule_id = :'vip_rule' and status = 'pending';
update public.automation_rules set enabled = false where id = :'vip_rule';
select tac.client(:'vip', 'Wren Vip') as v_wren \gset
select tac.visited(:'vip', :'v_wren', :'at11'::timestamptz - interval '410 days');
update public.clients set tags = '{vip}' where id = :'v_wren';
select public.skip_inactive_backlog(:'vip_rule') as vip_let_go \gset
select tac.check(:'vip_let_go' = 2
  and (select array_agg(client_id order by client_id) from public.inactive_client_marks where rule_id = :'vip_rule' and run_id is null)
      = (select array_agg(x order by x) from unnest(array[:'v_wren', :'v_maria']::uuid[]) x),
  'letting the backlog go marks only the clients the rule would email (the vip emailed lately too), not the others');

-- ===== Recording a send ======================================================================
select tac.client(:'co', 'Send Sam') as s_sam \gset
select * from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_sam', ' SAM@Example.test ', 'Send Sam', 'run:1', p_gap_days => 182, p_links => array['https://maple.test/a']) \gset first_
select tac.check(:'first_already_sent' = 'f' and :'first_in_flight' = 'f'
  and (select status = 'sending' and email = 'sam@example.test' and send_key = 'run:1' and links = array['https://maple.test/a'] and claimed_at is not null
         from public.campaign_recipients where id = :'first_id'),
  'begin_campaign_send records the email as it starts, on the automated campaign, address trimmed and lower case');
select tac.check((select kind = 'automated' and status = 'automated' and name = 'Re-engage past clients' from public.campaigns where company_id = :'co' and template_key = 'reengage_past_clients'),
  'the automated campaign is made the first time it''s needed');
select tac.check((select in_flight from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_sam', 'sam@example.test', 'Send Sam', 'run:1', p_gap_days => 182)),
  'the same send again while the first may still be going: in flight, not sent twice');
select tac.check(not exists (select 1 from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_sam', 'sam@example.test', 'Send Sam', 'run:2', p_gap_days => 182)),
  'another run for the client meanwhile is refused: an email started counts');
select public.finish_campaign_send(:'first_id', 'sent') as finished \gset
select tac.check(:'finished' and (select status = 'sent' and sent_at is not null from public.campaign_recipients where id = :'first_id'),
  'finish_campaign_send records it sent');
select tac.check((select already_sent and id = :'first_id' from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_sam', 'sam@example.test', 'Send Sam', 'run:1', p_gap_days => 182)),
  'a retried run whose email went is told so');
select tac.check(not exists (select 1 from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_sam', 'sam@example.test', 'Send Sam', 'run:3', p_gap_days => 182)),
  'another re-engage email within 6 months is refused');
update public.campaign_recipients set sent_at = now() - interval '183 days' where id = :'first_id';
select tac.check(exists (select 1 from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_sam', 'sam@example.test', 'Send Sam', 'run:3', p_gap_days => 182)),
  'after 6 months it goes');
select id as stale from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_sam', 'sam@example.test', 'Send Sam', 'run:4') \gset
update public.campaign_recipients set claimed_at = now() - interval '20 minutes' where id = :'stale';
select tac.check((select not in_flight and not already_sent and id = :'stale' from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_sam', 'sam@example.test', 'Send Sam', 'run:4')),
  'one left sending for 15 minutes (its worker stopped) is tried again');
-- Win back, once for each quote.
insert into public.quotes (company_id, client_id, title) values (:'co', :'s_sam', 'Patio') returning id as q_patio \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'s_sam', 'Fence') returning id as q_fence \gset
select tac.sent(:'co', 'win_back_lost_quotes', :'s_sam', 'run:10', p_subject => :'q_patio');
select tac.check(not exists (select 1 from public.begin_campaign_send(:'co', 'win_back_lost_quotes', :'s_sam', 'sam@example.test', 'Send Sam', 'run:11', :'q_patio', null, true)),
  'a second win-back email for the same quote is refused');
select id as fence_send from public.begin_campaign_send(:'co', 'win_back_lost_quotes', :'s_sam', 'sam@example.test', 'Send Sam', 'run:12', :'q_fence', null, true) \gset
select tac.check(:'fence_send' is not null and (select subject_id = :'q_fence' from public.campaign_recipients where id = :'fence_send'), 'another quote''s goes, recording the quote');
select public.finish_campaign_send(:'fence_send', 'failed', 'The mail server said no.');
select tac.check(exists (select 1 from public.begin_campaign_send(:'co', 'win_back_lost_quotes', :'s_sam', 'sam@example.test', 'Send Sam', 'run:13', :'q_fence', null, true))
  and (select error = 'The mail server said no.' from public.campaign_recipients where id = :'fence_send'),
  'a failed one doesn''t count, and says why');
select tac.check((select count(distinct track_token) = count(*) from public.campaign_recipients), 'every send has its own token');
-- A send whose result wasn't recorded (finish_campaign_send failed after the email went).
select tac.client(:'co', 'Stuck Stu') as s_stu \gset
select id as stuck from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_stu', 'stuck.stu@example.test', 'Stu', 'run:60', p_gap_days => 182, p_links => array['https://maple.test/a']) \gset
update public.campaign_recipients set claimed_at = now() - interval '2 hours' where id = :'stuck';
select tac.check(not exists (select 1 from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_stu', 'stuck.stu@example.test', 'Stu', 'run:61', p_gap_days => 182)),
  'an email left sending counts against the 6 months as if it went');
select public.track_campaign_open((select track_token from public.campaign_recipients where id = :'stuck')) as stuck_opened \gset
select tac.check(:'stuck_opened' and (select status = 'sent' and sent_at = claimed_at and opened_at is not null from public.campaign_recipients where id = :'stuck'),
  'its first open shows it went: it''s recorded sent, from when it started, and the open counts');
select tac.client(:'co', 'Stuck Sue') as s_sue \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'s_sue', 'Shed') returning id as q_shed \gset
select id as stuck2 from public.begin_campaign_send(:'co', 'win_back_lost_quotes', :'s_sue', 'stuck.sue@example.test', 'Sue', 'run:62', :'q_shed', null, true, array['https://maple.test/b']) \gset
update public.campaign_recipients set claimed_at = now() - interval '2 hours' where id = :'stuck2';
select public.track_campaign_click((select track_token from public.campaign_recipients where id = :'stuck2'), 0) as stuck2_link \gset
select tac.check(:'stuck2_link' = 'https://maple.test/b' and (select status = 'sent' and click_count = 1 and clicked_at is not null from public.campaign_recipients where id = :'stuck2'),
  'and so does a click');
select tac.check(not exists (select 1 from public.begin_campaign_send(:'co', 'win_back_lost_quotes', :'s_sue', 'stuck.sue@example.test', 'Sue', 'run:63', :'q_fence', null, true)),
  'a win-back email left sending counts for its quote too');
-- Two at the same moment.
select tac.client(:'co', 'Twin Tess') as s_tess \gset
select :"dbl".dblink_connect('other', 'dbname=' || current_database());
begin;
select id from public.begin_campaign_send(:'co', 'reengage_past_clients', :'s_tess', 'twin.tess@example.test', 'Twin Tess', 'run:20', p_gap_days => 182);
select :"dbl".dblink_send_query('other', format('select count(*) from public.begin_campaign_send(%L, %L, %L, %L, %L, %L, p_gap_days => 182)',
  :'co', 'reengage_past_clients', :'s_tess', 'twin.tess@example.test', 'Twin Tess', 'run:21'));
select tac.waiting_on_advisory() as twin_waited \gset
commit;
select n as twin_second from :"dbl".dblink_get_result('other') as t(n bigint) \gset
select count(*) from :"dbl".dblink_get_result('other') as t(n bigint);
select tac.check(:'twin_waited' and :'twin_second' = 0 and (select count(*) = 1 from public.campaign_recipients where client_id = :'s_tess'),
  'two runs for one client at the same moment record one email');
-- The tests after these make dblink their own way: it goes again if it was this file's.
select :"dbl".dblink_disconnect('other');
do $$
begin
  if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'dblink' and n.nspname = 'tac') then
    drop extension dblink;
  end if;
end $$;
-- One-off campaigns still have one row per address.
insert into public.campaigns (company_id, name, subject, body) values (:'co', 'Spring', 'Spring is here', 'Book now please') returning id as spring \gset
insert into public.campaign_recipients (company_id, campaign_id, client_id, email, name) values (:'co', :'spring', :'s_sam', 'sam@example.test', 'Sam');
insert into public.campaign_recipients (company_id, campaign_id, client_id, email, name) values (:'co', :'spring', :'s_sam', 'sam@example.test', 'Sam')
  on conflict (campaign_id, email, send_key) do nothing;
select tac.check((select count(*) = 1 from public.campaign_recipients where campaign_id = :'spring'), 'a one-off campaign''s Send still takes each address once');

-- ===== Audiences =============================================================================
select tac.client(:'book', 'City Cat') as a_cat \gset
insert into public.properties (company_id, client_id, line1, city) values (:'book', :'a_cat', '1 Main St', ' Blacksburg ');
select tac.client(:'book', 'Billing Bo') as a_bo \gset
update public.clients set billing_address = '{"line1": "2 Elm", "city": "BLACKSBURG"}' where id = :'a_bo';
select tac.client(:'book', 'Christie Cho') as a_cho \gset
insert into public.properties (company_id, client_id, line1, city) values (:'book', :'a_cho', '3 Oak St', 'Christiansburg');
select tac.client(:'book', 'Same Address', 'city.cat@example.test') as a_dupe \gset
insert into public.properties (company_id, client_id, line1, city) values (:'book', :'a_dupe', '9 Main St', 'Blacksburg');
insert into public.services (company_id, name, unit_price) values (:'book', 'Mulching', 50) returning id as mulch \gset
select tac.client(:'book', 'Serviced Sue') as a_sue \gset
select tac.visited(:'book', :'a_sue', now() - interval '20 days') as sue_job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'book', :'sue_job', 'Aeration', 1, 'ea', 80);
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price, service_id) values (:'book', :'sue_job', 'Mulch the beds', 1, 'ea', 50, :'mulch');
select tac.client(:'book', 'Sold Sid') as a_sid \gset
insert into public.jobs (company_id, client_id, title) values (:'book', :'a_sid', 'Aerate') returning id as sid_job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'book', :'sid_job', 'Aeration', 1, 'ea', 80);
select tac.client(:'book', 'Weekly Wes') as a_wes \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, ends_on) values (:'book', :'a_wes', 'Weekly mow', 'recurring', 'FREQ=WEEKLY', private.company_today(:'book') + 20) returning id as wes_job \gset
insert into public.job_line_items (company_id, job_id, name, quantity, unit, unit_price) values (:'book', :'wes_job', 'Weekly mow', 1, 'ea', 45);
insert into public.visits (company_id, job_id, title, status, scheduled_on, completed_at) values (:'book', :'wes_job', 'Mow', 'completed', private.company_today(:'book') - 7, now() - interval '7 days');
select tac.client(:'book', 'Later Lee') as a_lee \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, ends_on) values (:'book', :'a_lee', 'Weekly mow', 'recurring', 'FREQ=WEEKLY', private.company_today(:'book') + 40);
select tac.client(:'book', 'Done Dot') as a_dot \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, status, ends_on) values (:'book', :'a_dot', 'Weekly mow', 'recurring', 'FREQ=WEEKLY', 'completed', private.company_today(:'book') + 10);
update public.clients set tags = '{VIP}' where id in (:'a_cat', :'a_bo');
update public.clients set status = 'lead' where id = :'a_bo';
-- Another business's city and service.
select tac.client(:'pace', 'Elsewhere Eve') as e_eve \gset
insert into public.properties (company_id, client_id, line1, city) values (:'pace', :'e_eve', '1 Far Rd', 'Roanoke');

begin;
set local role authenticated;
select tac.as_user(:'oz');
select tac.check((select array_agg(display_name order by display_name) = '{"Billing Bo","City Cat"}' from public.campaign_audience(:'book', '{"cities": ["blacksburg"]}')),
  'a city, from a property or the billing address, in any case, and one address once');
select tac.check((select array_agg(display_name order by display_name) = '{"Billing Bo","Christie Cho","City Cat"}' from public.campaign_audience(:'book', '{"cities": ["Blacksburg ", "christiansburg"]}')),
  'any of several cities');
select tac.check((select array_agg(display_name order by display_name) = '{"Serviced Sue"}' from public.campaign_audience(:'book', '{"services": ["aeration"]}'))
  and (select array_agg(display_name order by display_name) = '{"Serviced Sue"}' from public.campaign_audience(:'book', '{"services": ["MULCHING"]}')),
  'services from a completed job''s lines, by the line''s name or its service''s, not from work not done yet');
select tac.check((select array_agg(display_name order by display_name) = '{"Weekly Wes"}' from public.campaign_audience(:'book', '{"services": ["Weekly mow"]}')),
  'and recurring work that has had a visit');
select tac.check((select array_agg(display_name order by display_name) = '{"Later Lee","Weekly Wes"}' from public.campaign_audience(:'book', '{"recurring": "yes"}'))
  and (select not ('Later Lee' = any (array_agg(display_name)) or 'Weekly Wes' = any (array_agg(display_name))) and 'Done Dot' = any (array_agg(display_name))
         from public.campaign_audience(:'book', '{"recurring": "no"}')),
  'has an active recurring job, or doesn''t (a finished one doesn''t count)');
select tac.check((select array_agg(display_name order by display_name) = '{"Weekly Wes"}' from public.campaign_audience(:'book', '{"recurring_ending": true}')),
  'a recurring job ending in the next 30 days: 20 days in, not 40, nor one that''s finished');
select tac.check((select array_agg(display_name order by display_name) = '{"City Cat"}' from public.campaign_audience(:'book', '{"cities": ["blacksburg"], "statuses": ["active"], "tags_any": ["VIP"]}'))
  and (select array_agg(display_name) = '{"Same Address"}' from public.campaign_audience(:'book', '{"cities": ["blacksburg"], "tags_none": ["VIP"]}')),
  'with status and tags as before, each address once after them');
select tac.check((select count(*) = 8 from public.campaign_audience(:'book', '{}')), 'and no filters is everyone with an email, each address once');
select public.campaign_audience_choices(:'book') as choices \gset
select tac.check((:'choices'::jsonb -> 'cities') = '[{"value": "blacksburg", "label": "Blacksburg", "count": 3}, {"value": "christiansburg", "label": "Christiansburg", "count": 1}]'
  and (select array_agg(e ->> 'label' order by e ->> 'label') from jsonb_array_elements(:'choices'::jsonb -> 'services') e) = '{Aeration,Mulching,"Weekly mow"}'
  and (:'choices'::jsonb -> 'services' -> 0 ->> 'count')::int = 1,
  'campaign_audience_choices: the business''s own cities and services, each once, the most used first');
select tac.as_user(:'mia');
select tac.check(public.campaign_audience_choices(:'book') = '{"cities": [], "services": []}', 'another business sees none of them');
commit;

-- ===== Opens and clicks ======================================================================
select tac.client(:'book', 'Track Tia') as t_tia \gset
select tac.sent(:'book', 'reengage_past_clients', :'t_tia', 'run:30', interval '1 hour', array['https://maple.test/book', 'https://maple.test/hub?x=1']) as t1 \gset
select track_token as t1_token from public.campaign_recipients where id = :'t1' \gset
select public.track_campaign_open(:'t1_token') and public.track_campaign_open(:'t1_token') as opened \gset
select tac.check(:'opened' and (select opened_at is not null and open_count = 2 and clicked_at is null and click_count = 0 from public.campaign_recipients where id = :'t1'),
  'an open is recorded the first time and counted each time; an open isn''t a click');
select opened_at as t1_opened from public.campaign_recipients where id = :'t1' \gset
select public.track_campaign_click(:'t1_token', 1) as t1_link \gset
select tac.check(:'t1_link' = 'https://maple.test/hub?x=1'
  and (select clicked_at is not null and last_clicked_at is not null and click_count = 1 and open_count = 2 and opened_at = :'t1_opened'::timestamptz
         from public.campaign_recipients where id = :'t1'),
  'a click goes to the link stored for it, and is counted');
select tac.check(public.track_campaign_click(gen_random_uuid(), 0) is null and public.track_campaign_click(:'t1_token', 2) is null and public.track_campaign_click(:'t1_token', -1) is null
  and not public.track_campaign_open(gen_random_uuid()),
  'a token nobody has, or a link it doesn''t have, is nothing');
select tac.check(public.track_campaign_click(:'t1_token', 0, false) = 'https://maple.test/book' and (select click_count = 1 from public.campaign_recipients where id = :'t1'),
  'a HEAD request still says where it goes, but isn''t counted');
select tac.client(:'book', 'Clicker Cy') as t_cy \gset
select tac.sent(:'book', 'reengage_past_clients', :'t_cy', 'run:31', interval '1 hour', array['https://maple.test/book']) as t2 \gset
select public.track_campaign_click((select track_token from public.campaign_recipients where id = :'t2'), 0) as t2_link \gset
select tac.check(:'t2_link' = 'https://maple.test/book'
  and (select opened_at is not null and open_count = 1 and clicked_at is not null from public.campaign_recipients where id = :'t2'),
  'a click counts as an open too');
select tac.client(:'book', 'Scanned Sky') as t_sky \gset
select tac.sent(:'book', 'reengage_past_clients', :'t_sky', 'run:32', interval '0', array['https://maple.test/book']) as t3 \gset
select tac.check(public.track_campaign_click((select track_token from public.campaign_recipients where id = :'t3'), 0) = 'https://maple.test/book'
  and (select clicked_at is null and click_count = 0 and opened_at is null from public.campaign_recipients where id = :'t3'),
  'a click in the first 30 seconds is a link scanner''s: it goes, and isn''t counted');
select id as t4 from public.begin_campaign_send(:'book', 'reengage_past_clients', :'t_sky', 'scanned.sky@example.test', 'Sky', 'run:33', p_links => array['https://maple.test/book']) \gset
select tac.check(not public.track_campaign_open((select track_token from public.campaign_recipients where id = :'t4')), 'an email not sent yet isn''t opened');

-- ===== Bookings ==============================================================================
insert into public.campaigns (company_id, name, subject, body, status) values (:'book', 'Fall', 'Fall', 'Book your fall cleanup', 'sent') returning id as fall \gset
-- A one-off campaign's recipient who clicked p_ago before now.
create function tac.clicked(p_campaign uuid, p_client uuid, p_ago interval) returns bigint language sql as $$
  insert into public.campaign_recipients (company_id, campaign_id, client_id, email, name, status, sent_at, clicked_at, last_clicked_at, opened_at, click_count, open_count)
  select c.company_id, p_campaign, c.id, c.email, c.display_name, 'sent', now() - p_ago - interval '1 hour', now() - p_ago, now() - p_ago, now() - p_ago, 1, 1
    from public.clients c where c.id = p_client
  returning id
$$;
select tac.client(:'book', 'Booker Bea') as k_bea \gset
select tac.clicked(:'fall', :'k_bea', interval '10 days') as k_bea_r \gset
insert into public.requests (company_id, client_id, title) values (:'book', :'k_bea', 'Fall cleanup') returning id as k_bea_req \gset
select tac.check((select campaign_id = :'fall' and recipient_id = :'k_bea_r' and kind = 'request' and chain_id = :'k_bea_req' and amount is null
                    from public.campaign_bookings where record_id = :'k_bea_req'),
  'a request 10 days after a click is booked to that campaign');
select tac.client(:'book', 'Late Lou') as k_lou \gset
select tac.clicked(:'fall', :'k_lou', interval '31 days');
insert into public.requests (company_id, client_id, title) values (:'book', :'k_lou', 'Too late');
select tac.client(:'book', 'Opener Oona') as k_oona \gset
insert into public.campaign_recipients (company_id, campaign_id, client_id, email, status, sent_at, opened_at, open_count)
values (:'book', :'fall', :'k_oona', 'opener.oona@example.test', 'sent', now() - interval '2 days', now() - interval '1 day', 1);
insert into public.requests (company_id, client_id, title) values (:'book', :'k_oona', 'Opened only');
insert into public.requests (company_id, client_id, title) values (:'book', :'t_sky', 'Scanned only');
select tac.check((select count(*) = 0 from public.campaign_bookings where client_id in (:'k_lou', :'k_oona', :'t_sky')),
  'none 31 days after the click, after an open alone, or after a link scanner''s click');
select tac.client(:'book', 'Two Times') as k_two \gset
select tac.clicked(:'fall', :'k_two', interval '20 days');
select tac.sent(:'book', 'win_back_lost_quotes', :'k_two', 'run:40', interval '6 days', array['https://maple.test/book']) as k_two_wb \gset
update public.campaign_recipients set clicked_at = now() - interval '5 days', last_clicked_at = now() - interval '5 days', click_count = 1 where id = :'k_two_wb';
insert into public.requests (company_id, client_id, title) values (:'book', :'k_two', 'Which one') returning id as k_two_req \gset
select tac.check((select recipient_id = :'k_two_wb' from public.campaign_bookings where record_id = :'k_two_req'), 'the latest click wins, across campaigns');
-- The request's quote is approved: the same booking, on the same campaign.
insert into public.quotes (company_id, client_id, title, request_id) values (:'book', :'k_bea', 'Fall cleanup', :'k_bea_req') returning id as k_bea_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'book', :'k_bea_quote', 'Cleanup', 1, 'ea', 1000);
update public.quotes set status = 'sent' where id = :'k_bea_quote';
update public.quotes set status = 'approved', approved_at = now() where id = :'k_bea_quote';
select tac.check((select campaign_id = :'fall' and recipient_id = :'k_bea_r' and chain_id = :'k_bea_req' from public.campaign_bookings where record_id = :'k_bea_quote'),
  'an approved quote from a booked request goes with that booking');
select tac.client(:'book', 'Straight Through') as k_st \gset
select tac.clicked(:'fall', :'k_st', interval '3 days') as k_st_r \gset
insert into public.quotes (company_id, client_id, title) values (:'book', :'k_st', 'Gutters') returning id as k_st_quote \gset
update public.quotes set status = 'sent' where id = :'k_st_quote';
update public.quotes set status = 'converted', converted_at = now() where id = :'k_st_quote';
select tac.check((select recipient_id = :'k_st_r' and kind = 'quote' and chain_id = :'k_st_quote' from public.campaign_bookings where record_id = :'k_st_quote'),
  'a quote converted to a job straight from sent is a booking');
-- 45 days after the click, the work is done and paid: its revenue, before tax, through the quote.
update public.campaign_recipients set last_clicked_at = now() - interval '45 days', clicked_at = now() - interval '45 days' where id = :'k_bea_r';
insert into public.jobs (company_id, client_id, title, quote_id) values (:'book', :'k_bea', 'Fall cleanup', :'k_bea_quote') returning id as k_bea_job \gset
select tac.invoice(:'book', :'k_bea', 1000, 0.10, :'k_bea_job') as k_bea_inv \gset
select tac.pay(:'k_bea_inv');
select tac.check((select status = 'paid' from public.invoices where id = :'k_bea_inv')
  and (select recipient_id = :'k_bea_r' and campaign_id = :'fall' and amount = 1000 and chain_id = :'k_bea_req' from public.campaign_bookings where record_id = :'k_bea_inv'),
  'a payment that pays the invoice off records its revenue, total less tax, on the booking behind it, 45 days after the click');
delete from public.payments where invoice_id = :'k_bea_inv';
select tac.check((select status <> 'paid' from public.invoices where id = :'k_bea_inv') and not exists (select 1 from public.campaign_bookings where record_id = :'k_bea_inv'),
  'the payment removed, it''s no longer counted');
select tac.pay(:'k_bea_inv');
-- An invoice with no booked work behind it: within 30 days of a click, or not at all.
select tac.invoice(:'book', :'k_st', 200) as k_st_inv \gset
select tac.pay(:'k_st_inv');
select tac.invoice(:'book', :'k_lou', 300) as k_lou_inv \gset
select tac.pay(:'k_lou_inv');
select tac.check((select amount = 200 and recipient_id = :'k_st_r' from public.campaign_bookings where record_id = :'k_st_inv')
  and not exists (select 1 from public.campaign_bookings where record_id = :'k_lou_inv'),
  'an invoice with no booked work counts when it''s paid within 30 days of a click, and not after');
begin;
select set_config('crewtavo.quiet', 'on', true);
insert into public.requests (company_id, client_id, title) values (:'book', :'k_st', 'Imported') returning id as quiet_req \gset
commit;
select tac.check(not exists (select 1 from public.campaign_bookings where record_id = :'quiet_req'), 'a quiet import (Stripe history) books nothing');
delete from public.invoices where id = :'k_st_inv';
select tac.check(not exists (select 1 from public.campaign_bookings where record_id = :'k_st_inv'), 'nor does a deleted invoice');

begin;
set local role authenticated;
select tac.as_user(:'oz');
select tac.check((select e ->> 'campaign_id' = :'fall' and (e ->> 'sent')::int = 5 and (e ->> 'opened')::int = 5 and (e ->> 'clicked')::int = 4
                         and (e ->> 'bookings')::int = 2 and (e ->> 'revenue')::numeric = 1000
                    from jsonb_array_elements(public.campaign_results(:'book', :'fall')) e),
  'campaign_results: sent, opened and clicked; a request and its quote are one booking; revenue paid before tax');
select tac.check((select (e ->> 'bookings')::int = 1 and e ->> 'kind' = 'automated' and e ->> 'template_key' = 'win_back_lost_quotes'
                    from jsonb_array_elements(public.campaign_results(:'book')) e where e ->> 'template_key' = 'win_back_lost_quotes'),
  'and each automated campaign the same way');
select public.campaign_recipient_results(:'fall') as fall_people \gset
select tac.check((:'fall_people'::jsonb ->> 'total')::int = 5
  and (select (e ->> 'bookings')::int = 1 and (e ->> 'revenue')::numeric = 1000 and e ->> 'clicked_at' is not null
         from jsonb_array_elements(:'fall_people'::jsonb -> 'recipients') e where (e ->> 'id')::bigint = :'k_bea_r'),
  'campaign_recipient_results: each recipient with what they opened, clicked and booked');
select tac.check(jsonb_array_length(public.campaign_recipient_results(:'fall', 2, 0) -> 'recipients') = 2
  and jsonb_array_length(public.campaign_recipient_results(:'fall', 2, 4) -> 'recipients') = 1,
  'a page at a time');
select tac.check((public.marketing_summary(:'book') ->> 'campaign_revenue')::numeric = 1000, 'marketing_summary: what campaigns brought in');
commit;

-- Work set up before the click isn't what the campaign brought in.
insert into public.campaigns (company_id, name, subject, body, status) values (:'book', 'Winter', 'Winter', 'Book your snow removal', 'sent') returning id as winter \gset
select tac.client(:'book', 'Regular Reg') as k_reg \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule) values (:'book', :'k_reg', 'Weekly mow', 'recurring', 'FREQ=WEEKLY') returning id as k_reg_job \gset
update public.jobs set created_at = now() - interval '200 days' where id = :'k_reg_job';
select tac.clicked(:'winter', :'k_reg', interval '5 days');
select tac.invoice(:'book', :'k_reg', 120, 0, :'k_reg_job') as k_reg_inv \gset
select tac.pay(:'k_reg_inv');
select tac.client(:'book', 'Overdue Otto') as k_otto \gset
select tac.invoice(:'book', :'k_otto', 90) as k_otto_inv \gset
update public.invoices set created_at = now() - interval '40 days' where id = :'k_otto_inv';
select tac.clicked(:'winter', :'k_otto', interval '5 days');
select tac.pay(:'k_otto_inv');
select tac.check(not exists (select 1 from public.campaign_bookings where record_id in (:'k_reg_inv', :'k_otto_inv')),
  'paying for recurring work set up months before the click, or an invoice from before it, books nothing');
select tac.client(:'book', 'Called In Cora') as k_cora \gset
select tac.clicked(:'winter', :'k_cora', interval '5 days') as k_cora_r \gset
insert into public.jobs (company_id, client_id, title) values (:'book', :'k_cora', 'Snow removal') returning id as k_cora_job \gset
select tac.invoice(:'book', :'k_cora', 150, 0, :'k_cora_job') as k_cora_inv \gset
select tac.pay(:'k_cora_inv');
select tac.check((select amount = 150 and recipient_id = :'k_cora_r' from public.campaign_bookings where record_id = :'k_cora_inv'),
  'a job set up after the click, with no request or quote, counts when it''s paid');
-- Retainage held back is booked once: on the invoice less it, then on the retainage invoice.
select tac.client(:'book', 'Roof Rita') as k_rita \gset
select tac.clicked(:'winter', :'k_rita', interval '5 days') as k_rita_r \gset
insert into public.quotes (company_id, client_id, title) values (:'book', :'k_rita', 'Re-roof') returning id as k_rita_quote \gset
insert into public.quote_line_items (company_id, quote_id, name, quantity, unit, unit_price) values (:'book', :'k_rita_quote', 'Re-roof', 1, 'ea', 10000);
update public.quotes set status = 'sent' where id = :'k_rita_quote';
update public.quotes set status = 'approved', approved_at = now() where id = :'k_rita_quote';
insert into public.jobs (company_id, client_id, title, quote_id, retainage_pct) values (:'book', :'k_rita', 'Re-roof', :'k_rita_quote', 10) returning id as k_rita_job \gset
insert into public.job_line_items (company_id, job_id, name, unit_price, taxable) values (:'book', :'k_rita_job', 'Re-roof', 10000, false);
select public.create_invoice_for_job(:'k_rita_job') as k_rita_inv \gset
update public.invoices set status = 'sent' where id = :'k_rita_inv';
select tac.pay(:'k_rita_inv');
select tac.check((select status = 'paid' and retainage_amount = 1000 from public.invoices where id = :'k_rita_inv')
  and (select amount = 9000 and recipient_id = :'k_rita_r' from public.campaign_bookings where record_id = :'k_rita_inv'),
  'an invoice with retainage held back books what was paid, less the retainage');
select public.create_invoice_for_job(:'k_rita_job', 'retainage') as k_rita_ret \gset
update public.invoices set status = 'sent' where id = :'k_rita_ret';
select tac.pay(:'k_rita_ret');
select tac.check((select sum(amount) = 10000 from public.campaign_bookings where record_id in (:'k_rita_inv', :'k_rita_ret'))
  and (select recipient_id = :'k_rita_r' from public.campaign_bookings where record_id = :'k_rita_ret'),
  'and the retainage invoice the rest, on the same booking: the job counts once, $10,000');
-- A request or quote deleted isn't a booking anymore, nor is a deleted client's.
select tac.client(:'book', 'Twice Tara') as k_tara \gset
select tac.clicked(:'winter', :'k_tara', interval '2 days');
insert into public.requests (company_id, client_id, title) values (:'book', :'k_tara', 'Snow removal') returning id as k_tara_req \gset
insert into public.requests (company_id, client_id, title) values (:'book', :'k_tara', 'Snow removal (again)') returning id as k_tara_dupe \gset
select tac.check((select count(*) = 2 from public.campaign_bookings where record_id in (:'k_tara_req', :'k_tara_dupe')), 'both requests are booked');
delete from public.requests where id = :'k_tara_dupe';
select tac.check(not exists (select 1 from public.campaign_bookings where record_id = :'k_tara_dupe')
  and exists (select 1 from public.campaign_bookings where record_id = :'k_tara_req'),
  'the one deleted isn''t a booking anymore');
select tac.client(:'book', 'Gone Gil') as k_gil \gset
select tac.clicked(:'winter', :'k_gil', interval '2 days');
insert into public.requests (company_id, client_id, title) values (:'book', :'k_gil', 'Plowing') returning id as k_gil_req \gset
insert into public.quotes (company_id, client_id, title) values (:'book', :'k_gil', 'Plowing') returning id as k_gil_quote \gset
update public.quotes set status = 'sent' where id = :'k_gil_quote';
update public.quotes set status = 'approved', approved_at = now() where id = :'k_gil_quote';
select tac.check((select count(*) = 2 from public.campaign_bookings where record_id in (:'k_gil_req', :'k_gil_quote')), 'a request and an approved quote are booked');
delete from public.clients where id = :'k_gil';
select tac.check(not exists (select 1 from public.campaign_bookings where record_id in (:'k_gil_req', :'k_gil_quote')),
  'deleting the client takes its bookings with its requests and quotes');
begin;
set local role authenticated;
select tac.as_user(:'oz');
select tac.check(jsonb_array_length(public.campaign_recipient_results(:'winter', 2, 0) -> 'recipients') = 2
  and (public.campaign_recipient_results(:'winter', 50, 4) -> 'recipients') -> 0 is not null
  and jsonb_array_length(public.campaign_recipient_results(:'winter', 50, 600) -> 'recipients') = 0
  and (public.campaign_recipient_results(:'winter', 50, 600) ->> 'total')::int = 6,
  'recipients page from any offset, past 500 too, with the total');
commit;

-- ===== Who reads and runs what ===============================================================
-- Maple's own booking and results to look at.
update public.campaigns set status = 'sent' where id = :'spring';
select tac.clicked(:'spring', :'c_task', interval '2 days');
insert into public.requests (company_id, client_id, title) values (:'co', :'c_task', 'Back again');
begin;
set local role authenticated;
select tac.as_user(:'oli');
select tac.check((select count(*) = 1 from public.campaign_bookings where company_id = :'co'), 'the office reads its bookings');
select tac.check(tac.error_of(format('insert into public.campaign_bookings (company_id, campaign_id, recipient_id, kind, record_id, chain_id) values (%L, %L, 1, %L, gen_random_uuid(), gen_random_uuid())', :'co', :'spring', 'request')) like '42501:%',
  'but can''t add one');
select tac.check(tac.error_of(format('update public.campaign_recipients set opened_at = now(), click_count = 9 where campaign_id = %L', :'spring')) like '42501:%',
  'nor change a recipient''s opens and clicks');
select tac.check(tac.error_of('select count(*) from public.inactive_client_marks') like '42501:%', 'inactive_client_marks are the server''s');
select tac.check(tac.error_of(format('insert into public.campaigns (company_id, name, kind, status, template_key) values (%L, %L, %L, %L, %L)', :'co', 'Mine', 'automated', 'automated', 'reengage_past_clients')) like '22023:%Marketing → Campaigns%',
  'nobody signed in adds an automated campaign');
select tac.check(tac.error_of(format('update public.campaigns set name = %L where company_id = %L and template_key = %L', 'Renamed', :'co', 'reengage_past_clients')) like '22023:%'
  and tac.error_of(format('delete from public.campaigns where company_id = %L and template_key = %L', :'co', 'reengage_past_clients')) like '22023:%',
  'or changes or deletes one');
insert into public.campaigns (company_id, name) values (:'co', 'Summer') returning id as summer \gset
select tac.check(tac.changed(format('update public.campaigns set name = %L where id = %L', 'Summer, edited', :'summer')) = 1, 'drafts are added and edited as before');
select tac.check(tac.error_of(format('update public.campaigns set kind = %L, status = %L, template_key = %L where id = %L', 'automated', 'automated', 'quote_followup', :'summer')) like '22023:%',
  'and a draft can''t be made automated');
select tac.check((select bool_or((e ->> 'quote_number') is not null)
                    from jsonb_array_elements(public.campaign_recipient_results((select id from public.campaigns where company_id = :'co' and template_key = 'win_back_lost_quotes')) -> 'recipients') e),
  'a win-back email names its quote');
select tac.check((public.campaign_recipient_results(:'spring', 50, 0, 'booked') ->> 'total')::int = 1
  and (select bool_and((e ->> 'bookings')::int > 0 or (e ->> 'revenue')::numeric > 0) from jsonb_array_elements(public.campaign_recipient_results(:'spring', 50, 0, 'booked') -> 'recipients') e)
  and (public.campaign_recipient_results(:'spring', 50, 0, 'clicked') ->> 'total')::int <= (public.campaign_recipient_results(:'spring', 50, 0, 'opened') ->> 'total')::int
  and (public.campaign_recipient_results(:'spring', 50, 0, 'opened') ->> 'total')::int <= (public.campaign_recipient_results(:'spring') ->> 'total')::int
  and (select bool_and(e ->> 'clicked_at' is not null) from jsonb_array_elements(public.campaign_recipient_results(:'spring', 50, 0, 'clicked') -> 'recipients') e),
  'who got it can be narrowed to those who opened, clicked or booked, with the narrowed total');
select tac.check((select (e ->> 'revenue') is not null from jsonb_array_elements(public.campaign_results(:'co')) e where e ->> 'campaign_id' = :'spring')
  and public.inactive_client_count(:'co', 365) >= 0,
  'the office reads results and the count');
select public.automated_campaign_states(:'co') as states \gset
select tac.check(jsonb_array_length(:'states'::jsonb) = 3
  and (select (e ->> 'enabled')::boolean and (e ->> 'days')::int = 365 and (e ->> 'waiting')::int >= 0 and e ->> 'rule_id' = :'reengage'
         from jsonb_array_elements(:'states'::jsonb) e where e ->> 'template_key' = 'reengage_past_clients')
  and (select (e ->> 'days')::int = 3 and (e ->> 'enabled')::boolean from jsonb_array_elements(:'states'::jsonb) e where e ->> 'template_key' = 'quote_followup')
  and (select not (e ->> 'enabled')::boolean and (e ->> 'days')::int = 30 from jsonb_array_elements(:'states'::jsonb) e where e ->> 'template_key' = 'win_back_lost_quotes')
  and not (select bool_or(e ? 'actions' or e ? 'conditions') from jsonb_array_elements(:'states'::jsonb) e),
  'automated_campaign_states: each campaign''s switch, days and emails waiting, and nothing else of its rule');
select tac.as_user(:'mo');
select tac.check((select count(*) = 0 from public.campaign_bookings), 'the office without Invoices reads no bookings');
select tac.check((select e -> 'revenue' = 'null'::jsonb and (e ->> 'bookings')::int = 1 from jsonb_array_elements(public.campaign_results(:'co')) e where e ->> 'campaign_id' = :'spring')
  and (select bool_and(e -> 'revenue' = 'null'::jsonb) from jsonb_array_elements(public.campaign_recipient_results(:'spring') -> 'recipients') e)
  and public.marketing_summary(:'co') -> 'campaign_revenue' = 'null'::jsonb,
  'and sees bookings, but no revenue, anywhere');
select tac.as_user(:'ivy');
select tac.check(tac.error_of(format('select public.campaign_results(%L)', :'co')) like '42501:%'
  and tac.error_of(format('select public.campaign_recipient_results(%L)', :'spring')) like '42501:%'
  and tac.error_of(format('select public.inactive_client_count(%L, 365)', :'co')) like '42501:%'
  and tac.error_of(format('select public.automated_campaign_states(%L)', :'co')) like '42501:%',
  'without Marketing, no results, counts or states');
select tac.as_user(:'cal');
select tac.check((select count(*) = 0 from public.campaign_bookings) and tac.error_of(format('select public.campaign_results(%L)', :'co')) like '42501:%',
  'nor for the crew');
select tac.as_user(:'oz');
select tac.check(tac.error_of(format('select public.campaign_recipient_results(%L)', :'spring')) like '42501:%', 'nor for another business');
commit;
select tac.check(not exists (select 1 from unnest(array['public.track_campaign_open(uuid)', 'public.track_campaign_click(uuid, integer, boolean)',
    'public.begin_campaign_send(uuid, text, uuid, text, text, text, uuid, integer, boolean, text[])', 'public.finish_campaign_send(bigint, text, text)',
    'public.emit_inactive_clients(timestamp with time zone, integer, uuid)', 'public.ensure_automated_campaign(uuid, text)', 'public.skip_inactive_backlog(uuid)',
    'public.release_inactive_backlog(uuid)',
    'public.renew_campaign_recipient(bigint, uuid, text[])']) as f
  where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  'tracking, recording sends and queueing runs are the server''s alone');

-- ===== How many would go, and letting the backlog go ===========================================
select tac.check(public.skip_inactive_backlog(:'pace_rule') = 0, 'a backlog all queued already has nothing to let go');
select tac.client(:'pace', 'Quiet Quincy') as p_quincy \gset
select tac.visited(:'pace', :'p_quincy', now() - interval '500 days');
begin;
set local role authenticated;
select tac.as_user(:'oz');
select tac.check(public.inactive_client_count(:'pace', 365) = 1, 'inactive_client_count leaves out clients already queued this stretch');
commit;
select public.skip_inactive_backlog(:'pace_rule') as let_go \gset
select tac.check(:'let_go' = 1 and (select run_id is null from public.inactive_client_marks where client_id = :'p_quincy')
  and tac.emit(:'pace', :'at11'::timestamptz + interval '2 days') = 0,
  'Only clients who reach it from now on: today''s backlog is marked done, with no email');
begin;
set local role authenticated;
select tac.as_user(:'oz');
select tac.check(public.inactive_client_count(:'pace', 365) = 0, 'while it''s on, the backlog let go isn''t counted');
commit;
-- The other 150 were emailed; then the office turns it off, and on again choosing to email the backlog.
update public.automation_runs set status = 'done', finished_at = now() where rule_id = :'pace_rule' and status = 'pending';
update public.automation_rules set enabled = false where id = :'pace_rule';
begin;
set local role authenticated;
select tac.as_user(:'oz');
select tac.check(public.inactive_client_count(:'pace', 365) = 1, 'turned off, it''s counted again, so turning it on asks again');
commit;
select public.release_inactive_backlog(:'pace_rule') as released \gset
select tac.check(:'released' = 1 and not exists (select 1 from public.inactive_client_marks where client_id = :'p_quincy'),
  'Email them too lets the backlog let go before back in');
update public.automation_rules set enabled = true where id = :'pace_rule';
select tac.check(tac.emit(:'pace', :'at11'::timestamptz + interval '2 days') = 1 and :'p_quincy' = any (tac.queued(:'pace_rule')),
  'and they''re queued, while those already emailed this stretch aren''t');

-- ===== Uninstalling, and a changed wait ======================================================
update public.automation_rules set enabled = true where id = :'winback';
select tac.client(:'co', 'Lost Lin') as w_lin \gset
insert into public.quotes (company_id, client_id, title) values (:'co', :'w_lin', 'Retaining wall') returning id as w_quote \gset
update public.quotes set status = 'sent' where id = :'w_quote';
update public.quotes set status = 'lost' where id = :'w_quote';
select tac.check((select count(*) = 1 from public.automation_runs where rule_id = :'winback' and subject_id = :'w_quote' and status = 'pending')
  and (select count(*) = 1 from public.automation_runs where rule_id = :'followup' and subject_id = :'w_quote' and status = 'pending'),
  'a quote sent and lost waits for its follow-up and its win-back email');
select run_after as followup_after from public.automation_runs where rule_id = :'followup' and subject_id = :'w_quote' \gset
update public.automation_rules set delay_minutes = 7200 where id = :'followup';
select tac.check((select r.run_after = a.created_at + interval '5 days' from public.automation_runs r join public.activity a on a.id = r.activity_id
                    where r.rule_id = :'followup' and r.subject_id = :'w_quote'),
  'changing the wait from 3 days to 5 moves the follow-up still waiting');
update public.activity set created_at = created_at - interval '2 days' where id = (select activity_id from public.automation_runs where rule_id = :'followup' and subject_id = :'w_quote');
update public.automation_rules set delay_minutes = 60 where id = :'followup';
select tac.check((select run_after between now() - interval '1 minute' and now() + interval '1 minute' from public.automation_runs where rule_id = :'followup' and subject_id = :'w_quote'),
  'and a wait that''s already past runs it now');
update public.automation_rules set delay_minutes = 4320 where id = :'followup';
select count(*) as reengage_waiting from public.automation_runs where rule_id = :'reengage' and status = 'pending' \gset
begin;
set local role authenticated;
select tac.as_user(:'mia');
select public.marketing_set_enabled(:'co', false);
commit;
select tac.check(:'reengage_waiting'::int > 0
  and (select count(*) = 0 from public.automation_runs where rule_id in (:'reengage', :'winback') and status = 'pending')
  and (select bool_and(error = 'Marketing was uninstalled') from public.automation_runs r where rule_id = :'winback' and subject_id = :'w_quote')
  and (select count(*) = 1 from public.automation_runs where rule_id = :'followup' and subject_id = :'w_quote' and status = 'pending'),
  'uninstalling Marketing calls off re-engage and win-back emails still waiting, and not the quote follow-up');
select tac.check(tac.emit(:'co', :'at11'::timestamptz + interval '3 days') = 0, 'and nothing is queued while it''s off');
begin;
set local role authenticated;
select tac.as_user(:'mia');
select public.marketing_set_enabled(:'co', true);
commit;
select tac.check(tac.emit(:'co', :'at11'::timestamptz + interval '3 days') > 0, 'installed again, the clients it called off are queued at the next 10am');

\o
\echo 'All automated campaign tests passed.'
