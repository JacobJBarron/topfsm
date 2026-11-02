-- Follow-ups to review asks and their reminders (20261030000300_review_reminders.sql,
-- 20261030000500_marketing_stops.sql), so Marketing → Reviews says what really happened:
--
--   Failed reminders   counted apart from the ones that went (reminders_failed), with why the last
--                      one failed (reminder_error). reminder_note now only says why reminders stopped.
--   Copied links       a link copied by hand isn't an ask until it's opened: it may never reach the
--                      client, so it doesn't start the 6 months (last_review_ask) or count in the
--                      overview's review requests.
--   Stops at once      a client who opts out of review asks or marketing, is archived, or texts STOP
--                      has reminders still to come stopped right then, with the same note the
--                      reminder task would write when it got to them. Clients who did before have
--                      theirs stopped now.

-- ---------------------------------------------------------------------------------------------
-- Failed reminders
-- ---------------------------------------------------------------------------------------------

alter table public.review_requests
  add column reminders_failed integer not null default 0 check (reminders_failed between 0 and 10),
  add column reminder_error text;
comment on column public.review_requests.reminders_failed is 'Reminders that were tried and didn''t go (counted in reminders_sent too, so they aren''t tried again)';
comment on column public.review_requests.reminder_error is 'Why the last reminder that failed didn''t go';
comment on column public.review_requests.reminder_note is 'Why reminders stopped';

-- As in 20261030000500_marketing_stops.sql, and a failed reminder is counted as failed and says why
-- in reminder_error, leaving reminder_note to why they stopped.
create or replace function public.finish_review_reminder(p_id uuid, p_token uuid, p_outcome text, p_next timestamptz default null, p_note text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'stop', 'later') then
    raise exception 'A reminder is sent, failed, stop or later' using errcode = '22023';
  end if;
  update public.review_requests
     set next_reminder_at = case
           when p_outcome = 'stop' or clicked_at is not null or next_reminder_at is null then null
           when p_outcome = 'later' then p_next
           else next_reminder_at end,
         reminder_note = case
           when p_outcome = 'stop' then coalesce(case when next_reminder_at is null then reminder_note end, left(p_note, 500))
           else reminder_note end,
         reminders_failed = reminders_failed + case when p_outcome = 'failed' then 1 else 0 end,
         reminder_error = case when p_outcome = 'failed' then coalesce(left(p_note, 500), 'The reminder wasn''t sent.') else reminder_error end,
         reminder_claim = null, reminder_locked_until = null
   where id = p_id and reminder_claim = p_token;
  return found;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Copied links
-- ---------------------------------------------------------------------------------------------

-- When the client was last asked, as the 6 months count it: an ask that went (not one that failed),
-- and a link copied by hand once it was opened. As the person calling it, so someone signed in
-- learns only what they can read ("Ask a client now" says when the picked client was last asked).
create function public.last_review_ask(p_company uuid, p_client uuid) returns timestamptz
language sql stable security invoker set search_path = '' as $$
  select max(r.sent_at) from public.review_requests r
   where r.company_id = p_company and r.client_id = p_client and r.status <> 'failed'
     and (r.channel <> 'link' or r.clicked_at is not null)
$$;
revoke execute on function public.last_review_ask(uuid, uuid) from public, anon;
grant execute on function public.last_review_ask(uuid, uuid) to authenticated, service_role;

-- As in 20261030000300_review_reminders.sql, the gap counted by last_review_ask.
create or replace function public.begin_review_request(p_company uuid, p_client uuid, p_job uuid default null, p_channel text default 'email',
  p_gap_days integer default null, p_created_by uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('review_ask:' || p_client::text));
  if p_gap_days is not null and public.last_review_ask(p_company, p_client) > now() - make_interval(days => p_gap_days) then
    return null;
  end if;
  insert into public.review_requests (company_id, client_id, job_id, channel, created_by)
  values (p_company, p_client, p_job, p_channel, p_created_by)
  returning id into v_id;
  return v_id;
end $$;

-- As in 20261017000300_marketing.sql, and review requests count the asks that went (a copied link
-- once it was opened), with how many of those were opened.
create or replace function public.marketing_summary(p_company_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'campaigns_sent', (select count(*) from public.campaigns where company_id = p_company_id and status = 'sent'),
    'emails_sent_30d', (select count(*) filter (where r.status = 'sent') from public.campaign_recipients r
                         where r.company_id = p_company_id and r.sent_at > now() - interval '30 days'),
    'reviews_requested_30d', (select count(*) from public.review_requests
                               where company_id = p_company_id and sent_at > now() - interval '30 days'
                                 and status <> 'failed' and (channel <> 'link' or clicked_at is not null)),
    'reviews_clicked_30d', (select count(*) from public.review_requests
                             where company_id = p_company_id and sent_at > now() - interval '30 days' and clicked_at is not null),
    'referrals_total', (select count(*) from public.referrals where company_id = p_company_id),
    'referrals_won', (select count(*) from public.referrals where company_id = p_company_id and status = 'won'),
    'rewards_pending', (select coalesce(sum(reward_amount), 0) from public.referrals where company_id = p_company_id and status = 'won' and reward_status = 'pending'),
    'opted_out', (select count(*) from public.clients where company_id = p_company_id and marketing_opt_out)
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- A client's stops, at once
-- ---------------------------------------------------------------------------------------------

-- Reminders still to come stop for good when the client opts out of review asks or marketing or is
-- archived, and the ones that could only go by text when they text STOP (an ask by text and email
-- keeps its emails, unless there's no address to send them to). The notes are the reminder task's
-- (packages/core/src/marketing.ts reminderPlan).
create function private.client_stops_review_reminders() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_note text;
begin
  v_note := case
    when new.review_opt_out and not old.review_opt_out then 'They asked not to get review requests'
    when new.marketing_opt_out and not old.marketing_opt_out then 'They unsubscribed from marketing'
    when new.status = 'archived' and old.status is distinct from 'archived' then 'The client was archived'
  end;
  if v_note is not null then
    update public.review_requests set next_reminder_at = null, reminder_note = v_note
     where company_id = new.company_id and client_id = new.id and next_reminder_at is not null;
  end if;
  if new.sms_opt_out_at is not null and old.sms_opt_out_at is null then
    update public.review_requests set next_reminder_at = null, reminder_note = 'They texted STOP'
     where company_id = new.company_id and client_id = new.id and next_reminder_at is not null
       and (channel = 'sms' or (channel = 'both' and coalesce(new.email, '') !~ '@'));
  end if;
  return null;
end $$;
revoke all on function private.client_stops_review_reminders() from public;
create trigger client_stops_review_reminders after update of review_opt_out, marketing_opt_out, status, sms_opt_out_at on public.clients
  for each row execute function private.client_stops_review_reminders();

-- Clients who opted out, were archived or texted STOP before this have their reminders stopped now,
-- as the trigger would have. Says how many.
create function private.stop_opted_out_reminders() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.review_requests r
     set next_reminder_at = null,
         reminder_note = case
           when c.review_opt_out then 'They asked not to get review requests'
           when c.marketing_opt_out then 'They unsubscribed from marketing'
           when c.status = 'archived' then 'The client was archived'
           else 'They texted STOP' end
    from public.clients c
   where c.company_id = r.company_id and c.id = r.client_id and r.next_reminder_at is not null
     and (c.review_opt_out or c.marketing_opt_out or c.status = 'archived'
          or (c.sms_opt_out_at is not null and (r.channel = 'sms' or (r.channel = 'both' and coalesce(c.email, '') !~ '@'))));
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.stop_opted_out_reminders() from public;
select private.stop_opted_out_reminders();

notify pgrst, 'reload schema';
