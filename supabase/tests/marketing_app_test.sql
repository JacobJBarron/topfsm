-- Database tests for Crewtavo - Marketing as an app and review reminders
-- (20261030000200_marketing_app.sql, 20261030000300_review_reminders.sql,
-- 20261030000500_marketing_stops.sql, 20261030000600_review_ask_followups.sql): every business has it installed, new ones too; only owners
-- and admins who connect apps install and uninstall it, and a page saving other settings can't;
-- uninstalling stops reminders for good, puts scheduled campaigns back to drafts and stops ones
-- sending; the client's review and text opt-outs (only the server sets texts off, and old STOP texts
-- count, read as the webhook reads them whatever the locale); asks by text and email; the reminder
-- columns stay the server's; one ask per client within the gap, even at the same moment; reminders
-- claimed once, counted right before they go, finished by the worker that holds them, and stops made
-- meanwhile kept, and failed ones counted apart with why; a copied link not counted as an ask until
-- it's opened (last_review_ask, the overview's numbers); a client's opt-outs, archiving and STOP
-- stopping reminders at once; a run put back to wait; runs called off when their rule starts on
-- something else; and the after-job starter rule leaving recurring jobs to their own rule.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tmk;
grant usage on schema tmk to authenticated, service_role;
create function tmk.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tmk.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
-- How many rows a statement changed (0 when row-level security hid every row from it).
create function tmk.changed(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;
-- Signs in as someone, for the rest of the transaction.
create function tmk.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema tmk to authenticated, service_role;

\set mia 'e5100000-0000-0000-0000-000000000001'
\set oli 'e5100000-0000-0000-0000-000000000002'
\set gus 'e5100000-0000-0000-0000-000000000003'
\set dot 'e5100000-0000-0000-0000-000000000004'
\set oz 'e5100000-0000-0000-0000-000000000005'

-- Mia owns Maple Lawn; Oli is office; Gus is an admin whose role doesn't connect apps; Dot is office
-- in a Dispatcher role without the marketing area. Oz owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mia', 'mia@maple.test', '{"full_name": "Mia Owner"}'),
  (:'oli', 'oli@maple.test', '{"full_name": "Oli Office"}'),
  (:'gus', 'gus@maple.test', '{"full_name": "Gus Books"}'),
  (:'dot', 'dot@maple.test', '{"full_name": "Dot Dispatch"}'),
  (:'oz', 'oz@other.test', '{"full_name": "Oz Other"}');

begin;
set local role authenticated;
select tmk.as_user(:'oz');
select public.create_company('Other Lawn', 'lawn_care') as other \gset
insert into public.clients (company_id, display_name, phone) values (:'other', 'Olga Other', '+15405550111') returning id as olga \gset
commit;

begin;
set local role authenticated;
select tmk.as_user(:'mia');
select public.create_company('Maple Lawn', 'lawn_care') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports,marketing}') returning id as keeper \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Dispatcher', 'office', '{schedule,sales}') returning id as dispatcher \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'oli', 'office');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'gus', 'admin', :'keeper'), (:'co', :'dot', 'office', :'dispatcher');
insert into public.clients (company_id, display_name, email, phone) values (:'co', 'Ana Smith', 'ana@example.test', '+15405550100') returning id as ana \gset
insert into public.clients (company_id, display_name, phone) values (:'co', 'Ben Stop', '+15405550101') returning id as ben \gset
insert into public.clients (company_id, display_name, phone) values (:'co', 'Cy Started', '+15405550102') returning id as cy \gset
insert into public.clients (company_id, display_name, phone) values (:'co', 'Di Chatty', '+15405550103') returning id as di \gset
insert into public.clients (company_id, display_name, phone) values (:'co', 'Fay Emoji', '+15405550105') returning id as fay \gset
commit;

-- ===== Installed for everyone ================================================================
select tmk.check((select settings -> 'marketing' = '{"enabled": true}' from public.companies where id = :'co'),
  'a new business starts with Marketing installed');

update public.companies set settings = (settings - 'marketing') || '{"review_url": "https://g.page/r/maple"}' where id = :'co';
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": false}') where id = :'other';
select private.install_marketing() as installed \gset
select tmk.check(:installed >= 1, 'install_marketing turns it on for a business that never had the switch');
select tmk.check((select settings -> 'marketing' = '{"enabled": true}' and settings ->> 'review_url' = 'https://g.page/r/maple' from public.companies where id = :'co'),
  'and keeps the rest of its settings');
select tmk.check((select settings #>> '{marketing,enabled}' = 'false' from public.companies where id = :'other'),
  'a business that uninstalled it keeps it off');
select tmk.check(private.install_marketing() = 0, 'run again, it changes nothing');
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": true}') where id = :'other';

-- ===== Only the switch changes it ============================================================
begin;
set local role authenticated;
select tmk.as_user(:'mia');
-- A page saving settings from a copy read before Marketing was uninstalled, or without it at all.
update public.companies set settings = (settings - 'marketing') || '{"review_message": "Thanks! {{link}}"}' where id = :'co';
select tmk.check((select settings -> 'marketing' = '{"enabled": true}' and settings ->> 'review_message' = 'Thanks! {{link}}' from public.companies where id = :'co'),
  'a settings save that leaves Marketing out keeps it as it was, and saves the rest');
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": false}') where id = :'co';
select tmk.check((select settings #>> '{marketing,enabled}' = 'true' from public.companies where id = :'co'),
  'nor does one that flips it: even the owner goes through Install and Uninstall');
commit;

-- Reminders due in both businesses, to see Uninstall stop only its own.
insert into public.review_requests (company_id, client_id, channel, next_reminder_at) values
  (:'co', :'ana', 'email', now() + interval '2 days'), (:'other', :'olga', 'sms', now() + interval '2 days');
-- And campaigns: one scheduled (a Black Friday offer), one partway through sending, one sent, a draft,
-- and the other business's scheduled one.
insert into public.campaigns (company_id, name, subject, body, status, scheduled_at, recipients_count)
values (:'co', 'Black Friday', 'Black Friday: 20% off', 'Twenty percent off every fall cleanup.', 'scheduled', now() + interval '3 days', 1) returning id as friday \gset
insert into public.campaigns (company_id, name, subject, body, status, scheduled_at, started_at, recipients_count)
values (:'co', 'Fall cleanup', 'Fall cleanup', 'Book your fall cleanup today.', 'sending', now() - interval '1 hour', now() - interval '1 hour', 3) returning id as fall \gset
insert into public.campaigns (company_id, name, status, finished_at) values (:'co', 'Spring', 'sent', now() - interval '30 days') returning id as spring \gset
insert into public.campaigns (company_id, name) values (:'co', 'Winter') returning id as winter \gset
insert into public.campaigns (company_id, name, subject, body, status, scheduled_at, recipients_count)
values (:'other', 'Other promo', 'Promo', 'Something on sale this week.', 'scheduled', now() + interval '1 day', 1) returning id as promo \gset
insert into public.campaign_recipients (company_id, campaign_id, client_id, email, name, status) values
  (:'co', :'friday', :'ana', 'ana@example.test', 'Ana Smith', 'pending'),
  (:'co', :'fall', :'ana', 'ana@example.test', 'Ana Smith', 'sent'),
  (:'co', :'fall', null, 'bo@example.test', 'Bo', 'pending'),
  (:'co', :'fall', null, 'cal@example.test', 'Cal', 'sending'),
  (:'other', :'promo', :'olga', 'olga@example.test', 'Olga Other', 'pending');

begin;
set local role authenticated;
select tmk.as_user(:'oli');
select tmk.check(tmk.error_of(format('select public.marketing_set_enabled(%L, false)', :'co')) = '42501: Only owners and admins who connect apps can install Marketing',
  'the office can''t uninstall Marketing');
select tmk.as_user(:'gus');
select tmk.check(tmk.error_of(format('select public.marketing_set_enabled(%L, false)', :'co')) like '42501:%', 'nor an admin whose role doesn''t connect apps');
select tmk.as_user(:'oz');
select tmk.check(tmk.error_of(format('select public.marketing_set_enabled(%L, false)', :'co')) like '42501:%', 'nor another business''s owner');
select tmk.as_user(:'mia');
select tmk.check(public.marketing_set_enabled(:'co', false) = false, 'the owner uninstalls it');
select tmk.check((select settings #>> '{marketing,enabled}' = 'false' and settings #> '{marketing,changed_at}' is not null from public.companies where id = :'co'),
  'which turns it off and says when');
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": true}') where id = :'co';
select tmk.check((select settings #>> '{marketing,enabled}' = 'false' from public.companies where id = :'co'), 'and a stale settings save can''t put it back on');
commit;
select tmk.check((select next_reminder_at is null and reminder_note = 'Marketing was uninstalled' from public.review_requests where company_id = :'co'),
  'uninstalling stops its reminders for good, saying why');
select tmk.check((select next_reminder_at is not null from public.review_requests where company_id = :'other'), 'and only its own');
select tmk.check((select status = 'draft' and scheduled_at is null and recipients_count = 0 from public.campaigns where id = :'friday')
                 and not exists (select 1 from public.campaign_recipients where campaign_id = :'friday'),
  'uninstalling puts a scheduled campaign back to a draft, its audience to be taken again when it''s scheduled');
select tmk.check((select status = 'cancelled' and finished_at is not null from public.campaigns where id = :'fall'),
  'and stops one that''s sending where it is');
select tmk.check((select array_agg(status || ': ' || coalesce(error, '') order by email) = '{"sent: ","skipped: Marketing was uninstalled","skipped: Marketing was uninstalled"}'
                    from public.campaign_recipients where campaign_id = :'fall'),
  'its recipients still to go are skipped, saying why, and the ones it sent stay sent');
select tmk.check((select status from public.campaigns where id = :'spring') = 'sent' and (select status from public.campaigns where id = :'winter') = 'draft',
  'sent campaigns and drafts are left as they are');
select tmk.check((select status = 'scheduled' from public.campaigns where id = :'promo')
                 and exists (select 1 from public.campaign_recipients where campaign_id = :'promo'),
  'and another business''s campaigns too');

begin;
set local role authenticated;
select tmk.as_user(:'mia');
select tmk.check(public.marketing_set_enabled(:'co', true), 'installing it again works');
commit;
select tmk.check((select next_reminder_at is null from public.review_requests where company_id = :'co'), 'and doesn''t bring back reminders that were due');
select tmk.check((select status from public.campaigns where id = :'friday') = 'draft' and (select status from public.campaigns where id = :'fall') = 'cancelled',
  'nor sends campaigns late: the scheduled one waits as a draft for a new date');
begin;
set local role authenticated;
select tmk.as_user(:'mia');
select tmk.check(tmk.error_of(format('update public.campaigns set name = ''Fall again'' where id = %L', :'fall')) = '22023: Only draft campaigns can be edited',
  'Uninstall gets past the campaign guard, and nobody else does');
commit;
-- The server writes settings with nobody signed in, and goes through.
update public.companies set settings = jsonb_set(settings, '{marketing,enabled}', 'false') where id = :'other';
select tmk.check((select settings #>> '{marketing,enabled}' = 'false' from public.companies where id = :'other'), 'the server (nobody signed in) can change it');
update public.companies set settings = jsonb_set(settings, '{marketing,enabled}', 'true') where id = :'other';

-- ===== The client's opt-outs ================================================================
begin;
set local role authenticated;
select tmk.as_user(:'oli');
select tmk.check(tmk.changed(format('update public.clients set review_opt_out = true where id = %L', :'ana')) = 1, 'the office turns off review asks for a client');
commit;
select tmk.check((select review_opt_out from public.clients where id = :'ana'), 'and it''s kept');
update public.clients set review_opt_out = false where id = :'ana';

begin;
set local role authenticated;
select tmk.as_user(:'mia');
update public.clients set sms_opt_out_at = now() where id = :'ana';
insert into public.clients (company_id, display_name, phone, sms_opt_out_at) values (:'co', 'Eve Imported', '+15405550104', now()) returning id as eve \gset
commit;
select tmk.check((select sms_opt_out_at is null from public.clients where id = :'ana'), 'nobody signed in turns a client''s texts off, not even the owner');
select tmk.check((select sms_opt_out_at is null from public.clients where id = :'eve'), 'nor adds a client with texts off');
set role service_role;
update public.clients set sms_opt_out_at = now() where id = :'ana';
reset role;
select tmk.check((select sms_opt_out_at is not null from public.clients where id = :'ana'), 'the server does, from a STOP text');
begin;
set local role authenticated;
select tmk.as_user(:'mia');
update public.clients set sms_opt_out_at = null, notes = 'Prefers email' where id = :'ana';
commit;
select tmk.check((select sms_opt_out_at is not null and notes = 'Prefers email' from public.clients where id = :'ana'),
  'and the office can''t turn them back on (only START does), while its other edits go through');
update public.clients set sms_opt_out_at = null where id = :'ana';

-- STOP texts from before: the latest STOP or START says.
insert into public.messages (company_id, client_id, channel, direction, body, created_at) values
  (:'co', :'fay', 'sms', 'in', 'STOP 🛑', now() - interval '2 days'),
  (:'co', :'ben', 'sms', 'in', 'Hi, is Tuesday ok?', now() - interval '9 days'),
  (:'co', :'ben', 'sms', 'in', 'Stop.', now() - interval '8 days'),
  (:'co', :'ben', 'sms', 'in', 'thanks', now() - interval '7 days'),
  (:'co', :'cy', 'sms', 'in', 'STOP', now() - interval '6 days'),
  (:'co', :'cy', 'sms', 'in', 'start', now() - interval '5 days'),
  (:'co', :'di', 'sms', 'in', 'Please stop by Tuesday', now() - interval '4 days'),
  (:'co', :'di', 'sms', 'out', 'STOP', now() - interval '3 days');
select tmk.check(private.sms_keyword(' stop! ') = 'stop' and private.sms_keyword('Opt  Out') = 'stop' and private.sms_keyword('REVOKE') = 'stop'
                 and private.sms_keyword('Unstop') = 'start' and private.sms_keyword('yes.') = 'start' and private.sms_keyword('stop by') is null,
  'texts are read as STOP or START only when the whole message is the word');
-- The same texts as packages/core/test/marketing.test.ts "reads STOP and START as Twilio does".
select tmk.check(bool_and(private.sms_keyword(body) is not distinct from word),
                 'and read exactly as the Twilio webhook reads them' || coalesce(', but not ' || string_agg(body, ' | ') filter (where private.sms_keyword(body) is distinct from word), ''))
  from (values
    ('STOP 🛑', 'stop'), ('Stop ✋', 'stop'), ('STOP🙏', 'stop'), ('stop 👍', 'stop'), ('STOP +', 'stop'), ('Stop €', 'stop'), ('Stop ❤️', 'stop'),
    (E'\nSTOP\n', 'stop'), (E'\tstop\r\n', 'stop'), (E'opt\tout', 'stop'), ('quit…', 'stop'), ('Yes 👍', 'start'),
    ('STOP STOP', null), ('ſtop', null), ('¡STOP', null), ('stöp', null), ('stop2', null), (E'OPT\u00a0OUT', null), (E'\u00a0STOP', null), ('', null)
  ) t(body, word);
-- Character classes and upper() read letters by the database's locale (ICU on Supabase's image,
-- libc on the one these tests run on): the reading uses neither, so it can't depend on one.
select tmk.check((select prosrc !~* '\[\[:|upper\(|lower\(|\\s|\\w' from pg_proc where oid = 'private.sms_keyword(text)'::regprocedure),
  'and the reading doesn''t depend on the locale');
select private.backfill_sms_opt_outs() as backfilled \gset
select tmk.check(:backfilled = 2, 'two clients'' latest STOP or START was a STOP');
select tmk.check((select sms_opt_out_at is not null from public.clients where id = :'fay'), 'an emoji after STOP still counts');
select tmk.check((select sms_opt_out_at = (select created_at from public.messages where client_id = :'ben' and body = 'Stop.') from public.clients where id = :'ben'),
  'they have texts off from when they texted it');
select tmk.check((select sms_opt_out_at is null from public.clients where id = :'cy'), 'a STOP and then a START leaves texts on');
select tmk.check((select sms_opt_out_at is null from public.clients where id = :'di'), 'and an ordinary text, or one the office sent, isn''t a STOP');

-- ===== Review requests ======================================================================
insert into public.review_requests (company_id, client_id, channel) values (:'co', :'ana', 'both') returning id as both_ask \gset
select tmk.check(true, 'an ask by text and email is recorded as both');
select tmk.check(tmk.error_of(format('insert into public.review_requests (company_id, client_id, channel) values (%L, %L, ''pigeon'')', :'co', :'ana')) like '23514:%',
  'and nothing else new');

begin;
set local role authenticated;
select tmk.as_user(:'mia');
select tmk.check(tmk.error_of(format('update public.review_requests set reminders_sent = 5 where id = %L', :'both_ask')) like '42501:%',
  'nobody signed in changes a review request''s reminders');
select tmk.check(tmk.error_of('select * from public.claim_review_reminders(10)') like '42501:%', 'nor claims reminders');
select tmk.check(tmk.error_of(format('select public.finish_review_reminder(%L, gen_random_uuid(), ''stop'')', :'both_ask')) like '42501:%', 'nor finishes one');
select tmk.check(tmk.error_of(format('select public.start_review_reminder(%L, gen_random_uuid())', :'both_ask')) like '42501:%', 'nor starts one');
select tmk.check(tmk.error_of(format('select public.begin_review_request(%L, %L)', :'co', :'ana')) like '42501:%', 'nor records an ask past the server');
select tmk.check(tmk.error_of('select public.postpone_automation_run(1, gen_random_uuid(), now(), ''[]'')') like '42501:%', 'nor puts back an automation run');
select tmk.check((select count(*) >= 1 from public.review_requests where id = :'both_ask'), 'the owner reads review requests');
select tmk.as_user(:'dot');
select tmk.check((select count(*) = 0 from public.review_requests where company_id = :'co'), 'a member without the marketing area doesn''t');
select tmk.as_user(:'oz');
select tmk.check((select count(*) = 0 from public.review_requests where company_id = :'co'), 'nor another business');
commit;

-- One ask for a client within the gap, however many workers ask at once.
set role service_role;
select public.begin_review_request(:'co', :'cy', null, 'sms', 182) as first_ask \gset
select tmk.check(:'first_ask' <> '', 'an ask is recorded');
select tmk.check(public.begin_review_request(:'co', :'cy', null, 'sms', 182) is null, 'a second automatic ask inside 6 months isn''t');
select tmk.check(public.begin_review_request(:'co', :'cy', null, 'link', null) is not null, 'an ask by hand isn''t held to it');
update public.review_requests set status = 'failed' where client_id = :'cy';
select tmk.check(public.begin_review_request(:'co', :'cy', null, 'sms', 182) is not null, 'asks that failed don''t count');
update public.review_requests set sent_at = now() - interval '183 days' where client_id = :'cy';
select tmk.check(public.begin_review_request(:'co', :'cy', null, 'sms', 182) is not null, 'nor ones from before the gap');
reset role;

-- ===== Claiming, starting and finishing reminders ============================================
delete from public.review_requests where company_id in (:'co', :'other');
insert into public.review_requests (company_id, client_id, channel, next_reminder_at) values (:'co', :'ana', 'email', now() - interval '1 minute') returning id as due \gset
insert into public.review_requests (company_id, client_id, channel, status, clicked_at, next_reminder_at) values (:'co', :'ana', 'email', 'clicked', now(), now() - interval '1 minute') returning id as opened \gset
insert into public.review_requests (company_id, client_id, channel, status, next_reminder_at) values (:'co', :'ana', 'email', 'failed', now() - interval '1 minute') returning id as failed \gset
insert into public.review_requests (company_id, client_id, channel, next_reminder_at) values (:'co', :'ana', 'email', now() + interval '1 day') returning id as later \gset

-- Due again and claimed: the worker's token, as :token.
create function tmk.claim(p_id uuid) returns uuid language plpgsql as $$
declare v_token uuid;
begin
  update public.review_requests set next_reminder_at = now() - interval '1 minute', reminder_claim = null, reminder_locked_until = null where id = p_id;
  select reminder_claim into v_token from public.claim_review_reminders(25) where id = p_id;
  return v_token;
end $$;
grant execute on function tmk.claim(uuid) to service_role;

set role service_role;
create temp table claimed as select id, reminder_claim from public.claim_review_reminders(25);
select tmk.check((select array_agg(id) = array[:'due'::uuid] from claimed), 'only a due reminder whose link nobody opened, for an ask that went, is claimed');
select reminder_claim as token from claimed \gset
select tmk.check((select count(*) = 0 from public.claim_review_reminders(25)), 'a second worker claims nothing while the first holds it');
select tmk.check(not public.start_review_reminder(:'due', gen_random_uuid(), now() + interval '2 days'), 'another worker can''t start it');
select tmk.check(not public.finish_review_reminder(:'due', gen_random_uuid(), 'sent'), 'nor finish it');
update public.review_requests set reminder_locked_until = now() - interval '1 second' where id = :'due';
drop table claimed;
create temp table claimed as select id, reminder_claim from public.claim_review_reminders(25);
select tmk.check((select count(*) = 1 and bool_and(reminder_claim <> :'token') from claimed), 'once the claim runs out, the next worker claims it with its own');
select tmk.check(not public.start_review_reminder(:'due', :'token', now() + interval '2 days'), 'and the first one''s is gone');
select reminder_claim as token from claimed \gset
drop table claimed;

select tmk.check(public.start_review_reminder(:'due', :'token', now() + interval '2 days'), 'the worker that holds it starts it, right before sending');
select tmk.check((select reminders_sent = 1 and last_reminder_at is not null and next_reminder_at > now() + interval '47 hours'
                         and reminder_claim = :'token' and reminder_locked_until > now() + interval '4 minutes'
                    from public.review_requests where id = :'due'),
  'which counts it and says when the next is due, holding the claim five more minutes');
-- The worker stopped after sending, before it could say so (a database blip, a redeploy).
update public.review_requests set reminder_locked_until = now() - interval '1 second' where id = :'due';
select tmk.check((select count(*) = 0 from public.claim_review_reminders(25)), 'so a reminder that went but wasn''t finished isn''t claimed and sent again');
select tmk.check(public.finish_review_reminder(:'due', :'token', 'sent'), 'sent');
select tmk.check((select reminders_sent = 1 and next_reminder_at > now() + interval '47 hours' and reminder_claim is null and reminder_note is null
                    from public.review_requests where id = :'due'),
  'counts it once, keeps when the next is due and lets go of the claim');
select tmk.check(tmk.error_of(format('select public.finish_review_reminder(%L, gen_random_uuid(), ''maybe'')', :'due')) like '22023:%', 'a reminder is sent, failed, stop or later');

select tmk.claim(:'due') as token \gset
select tmk.check(public.start_review_reminder(:'due', :'token'), 'the last one starts with none after it');
select tmk.check(public.finish_review_reminder(:'due', :'token', 'failed', null, 'The mail server said no.'), 'failed');
select tmk.check((select reminders_sent = 2 and reminders_failed = 1 and reminder_error = 'The mail server said no.' and reminder_note is null and next_reminder_at is null
                    from public.review_requests where id = :'due'),
  'counts it too, so it can''t go round again, as failed and not sent, saying why apart from why reminders stop');

select tmk.claim(:'due') as token \gset
select tmk.check(public.finish_review_reminder(:'due', :'token', 'later', now() + interval '3 hours'), 'later');
select tmk.check((select reminders_sent = 2 and next_reminder_at between now() + interval '2 hours' and now() + interval '4 hours' from public.review_requests where id = :'due'),
  'moves it without counting it');

select tmk.claim(:'due') as token \gset
select tmk.check(public.finish_review_reminder(:'due', :'token', 'stop', null, 'They unsubscribed from marketing'), 'stop');
select tmk.check((select next_reminder_at is null and reminder_note = 'They unsubscribed from marketing' and reminder_claim is null from public.review_requests where id = :'due'),
  'ends them for good, saying why');

-- The link opened while the reminder was being sent.
select tmk.claim(:'due') as token \gset
update public.review_requests set status = 'clicked', clicked_at = now(), next_reminder_at = null where id = :'due';
select tmk.check(not public.start_review_reminder(:'due', :'token', now() + interval '2 days'), 'a link opened after the claim isn''t reminded about');
select tmk.check(public.finish_review_reminder(:'due', :'token', 'later', now() + interval '3 hours'), 'a worker that decided before it still finishes');
select tmk.check((select next_reminder_at is null from public.review_requests where id = :'due'), 'without a next one for a link that was opened');
update public.review_requests set status = 'sent', clicked_at = null where id = :'due';
reset role;

-- Uninstalled after the claim, before the worker sent it.
set role service_role;
select tmk.claim(:'due') as token \gset
reset role;
begin;
set local role authenticated;
select tmk.as_user(:'mia');
select public.marketing_set_enabled(:'co', false);
commit;
set role service_role;
select tmk.check(not public.start_review_reminder(:'due', :'token', now() + interval '2 days'), 'a reminder Uninstall stopped after the claim isn''t sent');
select tmk.check(public.finish_review_reminder(:'due', :'token', 'later', now() + interval '3 hours'), 'and a worker that decided before still finishes');
select tmk.check((select next_reminder_at is null and reminder_note = 'Marketing was uninstalled' from public.review_requests where id = :'due'),
  'leaving it stopped, saying why');
reset role;
begin;
set local role authenticated;
select tmk.as_user(:'mia');
select public.marketing_set_enabled(:'co', true);
commit;

-- Uninstalled while it was being sent.
set role service_role;
select tmk.claim(:'due') as token \gset
select tmk.check(public.start_review_reminder(:'due', :'token', now() + interval '2 days'), 'a reminder is started');
reset role;
begin;
set local role authenticated;
select tmk.as_user(:'mia');
select public.marketing_set_enabled(:'co', false);
commit;
set role service_role;
select tmk.check(public.finish_review_reminder(:'due', :'token', 'sent'), 'Uninstall comes before it''s finished');
select tmk.check((select next_reminder_at is null and reminder_note = 'Marketing was uninstalled' from public.review_requests where id = :'due'),
  'the next one doesn''t come back, and the note says why');
reset role;
begin;
set local role authenticated;
select tmk.as_user(:'mia');
select public.marketing_set_enabled(:'co', true);
commit;
select tmk.check((select next_reminder_at is null from public.review_requests where id = :'due'), 'nor once Marketing is installed again');

-- A newer ask (services/reviews.ts) replaced it while it was being sent.
set role service_role;
select tmk.claim(:'due') as token \gset
select tmk.check(public.start_review_reminder(:'due', :'token', now() + interval '2 days'), 'another reminder is started');
update public.review_requests set next_reminder_at = null, reminder_note = 'A newer ask replaced it' where id = :'due';
select tmk.check(public.finish_review_reminder(:'due', :'token', 'failed', null, 'The mail server said no.'), 'and fails');
select tmk.check((select next_reminder_at is null and reminder_note = 'A newer ask replaced it' and reminders_failed = 2 from public.review_requests where id = :'due'),
  'one series at a time: the older ask''s don''t come back next to the new one''s');
reset role;

-- A reminder that failed while more are to come.
set role service_role;
update public.review_requests set reminders_sent = 0, reminders_failed = 0, reminder_error = null, reminder_note = null where id = :'due';
select tmk.claim(:'due') as token \gset
select tmk.check(public.start_review_reminder(:'due', :'token', now() + interval '2 days'), 'a first reminder is started');
select tmk.check(public.finish_review_reminder(:'due', :'token', 'failed', null, 'Texting isn''t set up on this Crewtavo yet.'), 'and fails');
select tmk.check((select reminders_sent = 1 and reminders_failed = 1 and reminder_error = 'Texting isn''t set up on this Crewtavo yet.' and reminder_note is null
                         and next_reminder_at > now() + interval '47 hours'
                    from public.review_requests where id = :'due'),
  'the next one keeps its time, and the failure is there to show next to it');
select tmk.claim(:'due') as token \gset
select tmk.check(public.start_review_reminder(:'due', :'token'), 'the second is started');
select tmk.check(public.finish_review_reminder(:'due', :'token', 'sent'), 'and goes');
select tmk.check((select reminders_sent = 2 and reminders_failed = 1 and reminder_error is not null from public.review_requests where id = :'due'),
  'one sent and one failed, the failure still saying why');
reset role;

begin;
set local role authenticated;
select tmk.as_user(:'mia');
select tmk.check(tmk.error_of(format('update public.review_requests set reminders_failed = 0, reminder_error = null where id = %L', :'due')) like '42501:%',
  'nobody signed in changes a reminder''s failures');
select tmk.check((select reminder_error is not null from public.review_requests where id = :'due'), 'the owner reads them');
select tmk.as_user(:'dot');
select tmk.check((select count(*) = 0 from public.review_requests where id = :'due'), 'a member without the marketing area doesn''t');
commit;

-- ===== A copied link isn't an ask until it's opened ==========================================
delete from public.review_requests where company_id in (:'co', :'other');
insert into public.review_requests (company_id, client_id, channel, sent_at) values (:'co', :'di', 'link', now() - interval '1 day') returning id as copied \gset
insert into public.review_requests (company_id, client_id, channel, status, sent_at) values (:'co', :'di', 'email', 'failed', now() - interval '2 hours');
set role service_role;
select tmk.check(public.last_review_ask(:'co', :'di') is null, 'a copied link nobody opened, and an ask that failed, aren''t when the client was last asked');
select tmk.check(public.begin_review_request(:'co', :'di', null, 'email', 182) is not null, 'so an automatic ask still goes');
delete from public.review_requests where client_id = :'di' and channel = 'email';
update public.review_requests set status = 'clicked', clicked_at = now() where id = :'copied';
select tmk.check(public.last_review_ask(:'co', :'di') between now() - interval '25 hours' and now() - interval '23 hours', 'once it''s opened, it''s when they were last asked');
select tmk.check(public.begin_review_request(:'co', :'di', null, 'email', 182) is null, 'and holds automatic asks for 6 months');
reset role;
insert into public.review_requests (company_id, client_id, channel) values (:'co', :'di', 'link'), (:'co', :'di', 'sms');
insert into public.review_requests (company_id, client_id, channel, status) values (:'co', :'di', 'email', 'failed');
select tmk.check((select (s ->> 'reviews_requested_30d')::int = 2 and (s ->> 'reviews_clicked_30d')::int = 1
                    from (select public.marketing_summary(:'co') as s) x),
  'the overview counts the asks that went and the opened link, not the failed ask or the link nobody opened');
begin;
set local role authenticated;
select tmk.as_user(:'mia');
select tmk.check(public.last_review_ask(:'co', :'di') is not null, 'the owner learns when a client was last asked');
select tmk.as_user(:'oz');
select tmk.check(public.last_review_ask(:'co', :'di') is null, 'another business doesn''t');
select tmk.as_user(:'dot');
select tmk.check(public.last_review_ask(:'co', :'di') is null, 'nor a member without the marketing area');
commit;

-- ===== A client's stops, at once ============================================================
delete from public.review_requests where company_id in (:'co', :'other');
-- Ben's old STOP (read from his texts above) is cleared, for him to text it again.
update public.clients set email = 'ben@example.test', sms_opt_out_at = null where id = :'ben';
insert into public.review_requests (company_id, client_id, channel, next_reminder_at) values
  (:'co', :'ana', 'email', now() + interval '2 days'),
  (:'co', :'ben', 'sms', now() + interval '2 days'), (:'co', :'ben', 'both', now() + interval '2 days'),
  (:'co', :'cy', 'both', now() + interval '2 days'),
  (:'co', :'fay', 'email', now() + interval '2 days'),
  (:'other', :'olga', 'sms', now() + interval '2 days');
begin;
set local role authenticated;
select tmk.as_user(:'oli');
update public.clients set review_opt_out = true where id = :'ana';
update public.clients set status = 'archived' where id = :'fay';
commit;
select tmk.check((select next_reminder_at is null and reminder_note = 'They asked not to get review requests' from public.review_requests where client_id = :'ana'),
  'turning off a client''s review asks stops their reminders right then, saying why');
select tmk.check((select next_reminder_at is null and reminder_note = 'The client was archived' from public.review_requests where client_id = :'fay'),
  'and so does archiving them');
-- Unsubscribing by the email's link (the server, nobody signed in).
update public.clients set marketing_opt_out = true where id = :'cy';
select tmk.check((select next_reminder_at is null and reminder_note = 'They unsubscribed from marketing' from public.review_requests where client_id = :'cy'),
  'and unsubscribing from marketing');
-- Ben texts STOP.
set role service_role;
update public.clients set sms_opt_out_at = now() where id = :'ben';
reset role;
select tmk.check((select next_reminder_at is null and reminder_note = 'They texted STOP' from public.review_requests where client_id = :'ben' and channel = 'sms'),
  'a STOP stops reminders that could only go by text');
select tmk.check((select next_reminder_at is not null and reminder_note is null from public.review_requests where client_id = :'ben' and channel = 'both'),
  'and one by text and email keeps going by email');
update public.clients set sms_opt_out_at = null where id = :'ben';
update public.review_requests set next_reminder_at = now() + interval '2 days', reminder_note = null where client_id = :'ben';
update public.clients set email = null where id = :'ben';
set role service_role;
update public.clients set sms_opt_out_at = now() where id = :'ben';
reset role;
select tmk.check((select bool_and(next_reminder_at is null and reminder_note = 'They texted STOP') from public.review_requests where client_id = :'ben'),
  'unless they have no email address to go to');
select tmk.check((select next_reminder_at is not null from public.review_requests where client_id = :'olga'), 'only the client''s own reminders stop');
update public.clients set review_opt_out = false, marketing_opt_out = false, status = 'active', sms_opt_out_at = null where id in (:'ana', :'cy', :'fay', :'ben');
select tmk.check((select count(*) = 0 from public.review_requests where company_id = :'co' and next_reminder_at is not null),
  'opting back in doesn''t bring stopped reminders back');

-- Opted out before the trigger was there: stopped once, by the migration.
alter table public.clients disable trigger client_stops_review_reminders;
update public.clients set review_opt_out = true where id = :'ana';
update public.clients set status = 'archived' where id = :'fay';
update public.clients set sms_opt_out_at = now() where id = :'ben';
alter table public.clients enable trigger client_stops_review_reminders;
delete from public.review_requests where company_id = :'co';
update public.clients set email = 'ben@example.test' where id = :'ben';
insert into public.review_requests (company_id, client_id, channel, next_reminder_at) values
  (:'co', :'ana', 'email', now() + interval '2 days'), (:'co', :'fay', 'email', now() + interval '2 days'),
  (:'co', :'ben', 'sms', now() + interval '2 days'), (:'co', :'ben', 'both', now() + interval '2 days'), (:'co', :'cy', 'email', now() + interval '2 days');
select tmk.check(private.stop_opted_out_reminders() = 3, 'reminders of clients who opted out, were archived or texted STOP before are stopped');
select tmk.check((select array_agg(reminder_note order by reminder_note) from public.review_requests where company_id = :'co' and next_reminder_at is null)
                 = array['The client was archived', 'They asked not to get review requests', 'They texted STOP'],
  'each saying why');
select tmk.check((select count(*) = 2 from public.review_requests where company_id = :'co' and next_reminder_at is not null),
  'and the rest keep going: an ask by both still emails a client who texted STOP, and Cy never opted out');
update public.clients set review_opt_out = false, status = 'active', sms_opt_out_at = null where id in (:'ana', :'fay', :'ben');

-- ===== Automation runs put back to wait =====================================================
insert into public.automation_rules (company_id, name, trigger, delay_minutes, actions, enabled)
values (:'co', 'Ask after visits', 'visit.completed', 0, '[{"type": "request_review", "channel": "sms"}]', true) returning id as rule \gset
insert into public.automation_runs (company_id, rule_id, subject_type, subject_id, run_after, result)
values (:'co', :'rule', 'visit', gen_random_uuid(), now() - interval '1 minute', '[]') returning id as run \gset
set role service_role;
select claim_token as run_token from public.claim_automation_runs(100, :'co') where id = :run \gset
select tmk.check(public.start_automation_run(:run, :'run_token'), 'a run is started');
select tmk.check(not public.postpone_automation_run(:run, gen_random_uuid(), now() + interval '10 hours', '[]'), 'only the worker that holds it puts it back');
select tmk.check(public.postpone_automation_run(:run, :'run_token', now() + interval '10 hours', '[{"type": "add_note", "ok": true, "detail": "Added a note"}]', 'Quiet hours: waits until 9am'),
  'the worker that holds it does');
reset role;
select tmk.check((select status = 'pending' and run_after > now() + interval '9 hours' and attempts = 0 and claim_token is null and locked_until is null
                         and error = 'Quiet hours: waits until 9am' and result -> 0 ->> 'type' = 'add_note'
                    from public.automation_runs where id = :run),
  'waiting again until then, keeping what it did, saying why, and without using an attempt');

-- A rule moved to another trigger calls off the runs waiting from the old one.
update public.automation_rules set trigger = 'invoice.paid' where id = :'rule';
select tmk.check((select status = 'cancelled' and error = 'The rule now starts on something else' from public.automation_runs where id = :run),
  'a rule that now starts on something else calls off its waiting runs');
insert into public.automation_runs (company_id, rule_id, subject_type, subject_id, run_after) values (:'co', :'rule', 'invoice', gen_random_uuid(), now() + interval '1 day') returning id as run2 \gset
update public.automation_rules set name = 'Ask after paid invoices' where id = :'rule';
select tmk.check((select status = 'pending' from public.automation_runs where id = :run2), 'renaming it doesn''t');
update public.automation_rules set enabled = false where id = :'rule';
select tmk.check((select status = 'cancelled' and error = 'Rule turned off' from public.automation_runs where id = :run2), 'and turning it off still does');

-- ===== Recurring work waits for its own rule ================================================
select tmk.check((select trigger = 'job.completed' and conditions = '[{"field": "kind", "op": "not_equals", "value": "recurring"}]'
                    from public.automation_rules where company_id = :'co' and template_key = 'review_after_job'),
  'a new business''s "Ask for a Google review after a job" leaves recurring jobs to the recurring rule');
update public.automation_rules set conditions = '[]' where company_id = :'co' and template_key = 'review_after_job';
update public.automation_rules set conditions = '[]', trigger = 'job.completed' where company_id = :'other' and template_key = 'review_after_job';
update public.automation_rules set conditions = '[{"field": "client.tags", "op": "includes", "value": ["VIP"]}]'
 where company_id = :'other' and template_key = 'review_after_job';
select tmk.check(private.leave_recurring_to_its_rule() >= 1, 'a rule shaped as it came has recurring jobs left out');
select tmk.check((select conditions = '[{"field": "kind", "op": "not_equals", "value": "recurring"}]' from public.automation_rules where company_id = :'co' and template_key = 'review_after_job'),
  'like a new business''s');
select tmk.check((select conditions -> 0 ->> 'field' = 'client.tags' from public.automation_rules where company_id = :'other' and template_key = 'review_after_job'),
  'and one with conditions of its own keeps them');

-- ===== Done ================================================================================
delete from public.companies where id in (:'co', :'other');

set client_min_messages = warning;
drop schema tmk cascade;
reset client_min_messages;

\o
\echo 'All Marketing tests passed.'
