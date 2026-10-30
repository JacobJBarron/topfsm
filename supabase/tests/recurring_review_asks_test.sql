-- Database tests for review asks on recurring work: a recurring job never completes, so its third
-- visit done is an event of its own, once for each job, and a starter rule asks for a review a day
-- after it (supabase/migrations/20261030000100_recurring_review_asks.sql).
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
