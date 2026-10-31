-- Database tests for review asks on recurring work: a recurring job never completes, so its third
-- visit done is an event of its own, once for each job, and a starter rule asks for a review a day
-- after it (supabase/migrations/20261030000100_recurring_review_asks.sql). The visit is the one the
-- business chooses in Marketing → Reviews, 3 unless it does (20261030000400_recurring_review_visits.sql).
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_recur_review;
grant usage on schema t_recur_review to authenticated, service_role;
create function t_recur_review.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- How many times a job has had its third visit.
create function t_recur_review.events(p_job uuid) returns bigint language sql as $$
  select count(*) from public.activity where subject_type = 'job' and subject_id = p_job and verb = 'job.recurring_third_visit'
$$;
grant execute on all functions in schema t_recur_review to authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data) values
  ('c9100000-0000-0000-0000-000000000001', 'owner@tango.test', '{"full_name": "Tess Tango"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9100000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Tango Lawn', 'lawn_care') as co \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Pat Weekly', 'pat@example.test') returning id as client \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, status)
values (:'co', :'client', 'Weekly mowing', 'recurring', 'FREQ=WEEKLY;BYDAY=TU', current_date, 'active') returning id as mowing \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, status)
values (:'co', :'client', 'Biweekly hedges', 'recurring', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', current_date, 'active') returning id as hedges \gset
insert into public.jobs (company_id, client_id, title, status) values (:'co', :'client', 'Spring cleanup', 'active') returning id as cleanup \gset
commit;

-- ===== A new business has the rule, off like the one for jobs ================================
select t_recur_review.check((select not enabled and trigger = 'job.recurring_third_visit' and delay_minutes = 1440 and conditions = '[]'
                                    and actions = '[{"type": "request_review", "channel": "email"}]'
                               from public.automation_rules where company_id = :'co' and template_key = 'review_recurring'),
  'a new business gets "Ask for a Google review on recurring work", off, a day after the third visit');
update public.automation_rules set enabled = true where company_id = :'co' and template_key in ('review_recurring', 'review_after_job');

set role service_role;
insert into public.visits (company_id, job_id, title, scheduled_on) values
  (:'co', :'mowing', 'Weekly mowing', '2030-05-07'), (:'co', :'mowing', 'Weekly mowing', '2030-05-14'),
  (:'co', :'mowing', 'Weekly mowing', '2030-05-21'), (:'co', :'mowing', 'Weekly mowing', '2030-05-28'),
  (:'co', :'mowing', 'Weekly mowing', '2030-06-04');
insert into public.visits (company_id, job_id, title, kind, scheduled_on) values (:'co', :'mowing', 'Look at the drainage', 'assessment', '2030-05-01');
insert into public.visits (company_id, job_id, title, scheduled_on) values
  (:'co', :'hedges', 'Hedges', '2030-05-10'), (:'co', :'hedges', 'Hedges', '2030-05-24'), (:'co', :'hedges', 'Hedges', '2030-06-07');
insert into public.visits (company_id, job_id, title, scheduled_on) values
  (:'co', :'cleanup', 'Spring cleanup', '2030-04-01'), (:'co', :'cleanup', 'Spring cleanup', '2030-04-02'),
  (:'co', :'cleanup', 'Spring cleanup', '2030-04-03'), (:'co', :'cleanup', 'Spring cleanup', '2030-04-04');
reset role;

-- ===== Weekly mowing: asked once, after the third visit =======================================
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'mowing' and kind = 'assessment';
update public.visits set status = 'completed', completed_at = now() where job_id = :'mowing' and scheduled_on in ('2030-05-07', '2030-05-14');
reset role;
select t_recur_review.check(t_recur_review.events(:'mowing') = 0, 'two visits and an assessment aren''t enough');

set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'mowing' and scheduled_on = '2030-05-21';
reset role;
select t_recur_review.check(t_recur_review.events(:'mowing') = 1, 'the third visit done says so, on the job');
select t_recur_review.check((select count(*) = 1 and bool_and(r.subject_type = 'job' and r.subject_id = :'mowing' and r.status = 'pending'
                                    and r.run_after > now() + interval '23 hours')
                               from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                              where ru.company_id = :'co' and ru.template_key = 'review_recurring'),
  'and the review ask waits a day to go out');
select t_recur_review.check((select count(*) = 0 from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                              where ru.company_id = :'co' and ru.template_key = 'review_after_job'),
  'the rule for finished jobs isn''t started: the job is still going');

set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'mowing' and scheduled_on in ('2030-05-28', '2030-06-04');
update public.visits set status = 'scheduled', completed_at = null where job_id = :'mowing' and scheduled_on = '2030-05-21';
update public.visits set status = 'completed', completed_at = now() where job_id = :'mowing' and scheduled_on = '2030-05-21';
reset role;
select t_recur_review.check(t_recur_review.events(:'mowing') = 1, 'the visits after it, and one reopened and done again, don''t ask again');
select t_recur_review.check((select count(*) = 1 from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                              where ru.company_id = :'co' and ru.template_key = 'review_recurring'),
  'so there''s still one ask');

-- ===== Three visits done at once ==============================================================
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'hedges';
reset role;
select t_recur_review.check(t_recur_review.events(:'hedges') = 1, 'three visits marked done together say so once');

-- ===== A one-off job keeps to "A job is completed" ===========================================
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'cleanup';
reset role;
select t_recur_review.check(t_recur_review.events(:'cleanup') = 0, 'a one-off job''s visits never count');

-- ===== The visit chosen in Marketing → Reviews ================================================
select t_recur_review.check((select description = 'Sends your review link a day after a recurring job reaches the visit you chose in Marketing, once for each job.'
                               from public.automation_rules where company_id = :'co' and template_key = 'review_recurring'),
  'the starter rule says it asks after the visit chosen in Marketing');
select t_recur_review.check(private.review_visits(:'co') = 3, 'until it''s chosen, that''s the 3rd');
select t_recur_review.check(array[private.ordinal(1), private.ordinal(2), private.ordinal(3), private.ordinal(4), private.ordinal(11), private.ordinal(12),
                                   private.ordinal(13), private.ordinal(21), private.ordinal(22), private.ordinal(111)]
                            = '{1st,2nd,3rd,4th,11th,12th,13th,21st,22nd,111th}', 'visits are named the way people say them');
update public.companies set settings = jsonb_set(settings, '{reviews}', '{"recurring_after_visits": "abc"}') where id = :'co';
select t_recur_review.check(private.review_visits(:'co') = 3, 'a count that isn''t a number reads as 3');
update public.companies set settings = jsonb_set(settings, '{reviews}', '{"recurring_after_visits": 0}') where id = :'co';
select t_recur_review.check(private.review_visits(:'co') = 1, '0 reads as 1');
update public.companies set settings = jsonb_set(settings, '{reviews}', '{"recurring_after_visits": 99}') where id = :'co';
select t_recur_review.check(private.review_visits(:'co') = 20, '99 reads as 20');
update public.companies set settings = jsonb_set(settings, '{reviews}', '{"recurring_after_visits": 2.6}') where id = :'co';
select t_recur_review.check(private.review_visits(:'co') = 3, 'and 2.6 as 3, as the app reads it');

update public.companies set settings = jsonb_set(settings, '{reviews}', '{"recurring_after_visits": 5}') where id = :'co';
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c9100000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, status)
values (:'co', :'client', 'Pool service', 'recurring', 'FREQ=WEEKLY;BYDAY=MO', current_date, 'active') returning id as pool \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, status)
values (:'co', :'client', 'Window washing', 'recurring', 'FREQ=MONTHLY', current_date, 'active') returning id as windows \gset
insert into public.jobs (company_id, client_id, title, kind, recurrence_rule, starts_on, status)
values (:'co', :'client', 'Gutter checks', 'recurring', 'FREQ=MONTHLY', current_date, 'active') returning id as gutters \gset
commit;
set role service_role;
insert into public.visits (company_id, job_id, title, scheduled_on)
select :'co', j, 'Visit', '2030-07-01'::date + n from unnest(array[:'pool', :'windows', :'gutters']::uuid[]) j, generate_series(1, 6) n;
reset role;

-- Pool service: the 5th visit (its visits are on July 2nd to 7th).
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'pool' and scheduled_on <= '2030-07-04';
reset role;
select t_recur_review.check(t_recur_review.events(:'pool') = 0, 'with the 5th chosen, three visits aren''t enough');
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'pool' and scheduled_on = '2030-07-05';
reset role;
select t_recur_review.check(t_recur_review.events(:'pool') = 0, 'nor four');
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'pool' and scheduled_on = '2030-07-06';
reset role;
select t_recur_review.check(t_recur_review.events(:'pool') = 1, 'the 5th visit says so');
select number as pool_no from public.jobs where id = :'pool' \gset
select t_recur_review.check((select summary = format('Job #%s for Pat Weekly reached its 5th visit', :'pool_no') and data = jsonb_build_object('number', :'pool_no'::integer, 'visits', 5)
                               from public.activity where subject_id = :'pool' and verb = 'job.recurring_third_visit'),
  'saying which visit it was');

-- Gutter checks: the count lowered below the visits it has had.
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'gutters' and scheduled_on <= '2030-07-04';
reset role;
update public.companies set settings = jsonb_set(settings, '{reviews}', '{"recurring_after_visits": 2}') where id = :'co';
select t_recur_review.check(t_recur_review.events(:'gutters') = 0, 'lowering the count past a job''s visits doesn''t ask by itself');
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'gutters' and scheduled_on = '2030-07-05';
reset role;
select t_recur_review.check(t_recur_review.events(:'gutters') = 1, 'the job asks at its next visit');
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'gutters' and scheduled_on = '2030-07-06';
reset role;
select t_recur_review.check(t_recur_review.events(:'gutters') = 1, 'once');

-- Window washing: the 1st.
update public.companies set settings = jsonb_set(settings, '{reviews}', '{"recurring_after_visits": 1}') where id = :'co';
set role service_role;
update public.visits set status = 'completed', completed_at = now() where job_id = :'windows' and scheduled_on = '2030-07-02';
reset role;
select t_recur_review.check(t_recur_review.events(:'windows') = 1, 'with the 1st chosen, the first visit asks');
select t_recur_review.check((select summary like '%reached its 1st visit' from public.activity where subject_id = :'windows' and verb = 'job.recurring_third_visit'),
  'and says the 1st');
