-- Review asks work like Jobber's (docs/marketing-plan.md, phase A): up to two reminders for anyone
-- who hasn't opened the link, at most one automatic ask per client every 6 months, and clients who
-- don't want them aren't asked.
--
--   clients.review_opt_out     "Don't ask for reviews", on the client, edited by the office like
--                              marketing_opt_out (which stops review asks too).
--   clients.sms_opt_out_at     when the client texted STOP; START, UNSTOP or YES clears it. Only the
--                              server sets it (from the Twilio webhook, or when Twilio refuses a text
--                              because of it): nobody signed in can (client_sms_opt_out_guard).
--   review_requests            channel 'both' (by text and email), and the reminders: how many went,
--                              when the next is due and why they stopped. The server's reminder task
--                              (apps/api/src/services/reviews.ts) claims due ones (claim_review_reminders),
--                              so two workers never send the same reminder.
--   begin_review_request       records an ask, unless the client was asked within the last N days:
--                              two workers asking one client at the same moment ask once.
--   postpone_automation_run    a run put back to wait (an automatic ask during quiet hours, to a
--                              client with no email, waits until 9am to be texted).
--
-- Rules whose trigger changes call off the runs waiting from their old trigger (cancel_disabled_runs):
-- Marketing → Reviews moves the starter rule between "a job is completed", "a visit is completed"
-- and "an invoice is paid in full".

-- ---------------------------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------------------------

alter table public.clients
  add column review_opt_out boolean not null default false,
  add column sms_opt_out_at timestamptz;
comment on column public.clients.review_opt_out is 'Don''t ask for reviews';
comment on column public.clients.sms_opt_out_at is 'Texted STOP; cleared by START, UNSTOP or YES';

-- Nobody signed in sets or clears it: only the client can, by texting.
create function private.client_sms_opt_out_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) = 'authenticated' then
    if tg_op = 'UPDATE' then
      new.sms_opt_out_at := old.sms_opt_out_at;
    else
      new.sms_opt_out_at := null;
    end if;
  end if;
  return new;
end $$;
create trigger client_sms_opt_out_guard before insert or update of sms_opt_out_at on public.clients
  for each row execute function private.client_sms_opt_out_guard();

-- What a text means, as packages/core/src/marketing.ts smsKeyword reads it: 'stop', 'start' or null.
-- The whole message, trimmed, in any case, without punctuation at the end.
create function private.sms_keyword(p_body text) returns text
language sql immutable set search_path = '' as $$
  select case
    when w in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT OUT', 'REVOKE') then 'stop'
    when w in ('START', 'UNSTOP', 'YES') then 'start'
  end
  from (select regexp_replace(upper(regexp_replace(btrim(coalesce(p_body, '')), '[[:punct:][:space:]]+$', '')), '\s+', ' ', 'g') as w) x
$$;

-- STOP texts came in as ordinary messages until now. A client whose latest STOP or START was a STOP
-- has texts off from then. Says how many.
create function private.backfill_sms_opt_outs() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.clients c
     set sms_opt_out_at = latest.created_at
    from (
      select distinct on (m.client_id) m.client_id, m.created_at, private.sms_keyword(m.body) as word
        from public.messages m
       where m.channel = 'sms' and m.direction = 'in' and m.client_id is not null and private.sms_keyword(m.body) is not null
       order by m.client_id, m.created_at desc, m.id desc
    ) latest
   where latest.client_id = c.id and latest.word = 'stop' and c.sms_opt_out_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
select private.backfill_sms_opt_outs();

-- ---------------------------------------------------------------------------------------------
-- Review requests and their reminders
-- ---------------------------------------------------------------------------------------------

alter table public.review_requests drop constraint review_requests_channel_check;
alter table public.review_requests add constraint review_requests_channel_check check (channel in ('email', 'sms', 'both', 'link'));
alter table public.review_requests
  add column reminders_sent integer not null default 0 check (reminders_sent between 0 and 10),
  add column next_reminder_at timestamptz,
  add column last_reminder_at timestamptz,
  add column reminder_note text,
  add column reminder_claim uuid,
  add column reminder_locked_until timestamptz;
comment on column public.review_requests.channel is 'How the ask went: email, sms, both, or link (copied by hand)';
comment on column public.review_requests.next_reminder_at is 'When the next reminder is due; null once there are no more';
comment on column public.review_requests.reminder_note is 'Why the last reminder failed, or why reminders stopped';
create index review_requests_reminder_due_idx on public.review_requests (next_reminder_at) where next_reminder_at is not null;

-- An ask, unless the client had one (that didn't fail) within the last p_gap_days days: null then.
-- One ask for a client at a time, so two workers can't both find none and both ask. Asks by hand
-- pass no gap.
create function public.begin_review_request(p_company uuid, p_client uuid, p_job uuid default null, p_channel text default 'email',
  p_gap_days integer default null, p_created_by uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('review_ask:' || p_client::text));
  if p_gap_days is not null and exists (
    select 1 from public.review_requests r
     where r.company_id = p_company and r.client_id = p_client and r.status <> 'failed'
       and r.sent_at > now() - make_interval(days => p_gap_days)) then
    return null;
  end if;
  insert into public.review_requests (company_id, client_id, job_id, channel, created_by)
  values (p_company, p_client, p_job, p_channel, p_created_by)
  returning id into v_id;
  return v_id;
end $$;

-- Due reminders, for one worker: a token for the batch, held five minutes. Only asks that went out
-- and whose link nobody opened.
create function public.claim_review_reminders(p_limit integer default 25)
returns setof public.review_requests language plpgsql security definer set search_path = '' as $$
declare v_token uuid := gen_random_uuid();
begin
  return query
  update public.review_requests r
     set reminder_claim = v_token, reminder_locked_until = now() + interval '5 minutes'
   where r.id in (
     select x.id from public.review_requests x
      where x.next_reminder_at <= now() and x.clicked_at is null and x.status = 'sent'
        and (x.reminder_locked_until is null or x.reminder_locked_until < now())
      order by x.next_reminder_at
      limit least(greatest(p_limit, 1), 100)
      for update skip locked)
  returning r.*;
end $$;

-- Right before sending: true if the worker still holds the reminder (and five more minutes), and
-- nobody opened the link since it was claimed.
create function public.renew_review_reminder(p_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.review_requests
     set reminder_locked_until = now() + interval '5 minutes'
   where id = p_id and reminder_claim = p_token and clicked_at is null;
  return found;
end $$;

-- How a reminder went, if the worker still holds it. sent and failed both count, so a reminder that
-- keeps failing can't go round again, and p_next is when the one after is due. stop ends them, with
-- p_note saying why. later moves this one to p_next. A link opened meanwhile has no next one.
create function public.finish_review_reminder(p_id uuid, p_token uuid, p_outcome text, p_next timestamptz default null, p_note text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'stop', 'later') then
    raise exception 'A reminder is sent, failed, stop or later' using errcode = '22023';
  end if;
  update public.review_requests
     set reminders_sent = reminders_sent + case when p_outcome in ('sent', 'failed') then 1 else 0 end,
         last_reminder_at = case when p_outcome in ('sent', 'failed') then now() else last_reminder_at end,
         next_reminder_at = case when p_outcome = 'stop' or clicked_at is not null then null else p_next end,
         reminder_note = case p_outcome when 'sent' then null when 'later' then reminder_note else left(p_note, 500) end,
         reminder_claim = null, reminder_locked_until = null
   where id = p_id and reminder_claim = p_token;
  return found;
end $$;

revoke execute on function public.begin_review_request(uuid, uuid, uuid, text, integer, uuid), public.claim_review_reminders(integer),
  public.renew_review_reminder(uuid, uuid), public.finish_review_reminder(uuid, uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.begin_review_request(uuid, uuid, uuid, text, integer, uuid), public.claim_review_reminders(integer),
  public.renew_review_reminder(uuid, uuid), public.finish_review_reminder(uuid, uuid, text, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Automation runs
-- ---------------------------------------------------------------------------------------------

-- A run put back to wait until p_until, keeping the actions done so far (p_result) and saying why
-- (p_note). Starting it counted an attempt that never happened, so that comes off.
create function public.postpone_automation_run(p_id bigint, p_token uuid, p_until timestamptz, p_result jsonb, p_note text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.automation_runs
     set status = 'pending', run_after = greatest(p_until, now()), result = coalesce(p_result, result), error = left(p_note, 1000),
         attempts = greatest(attempts - 1, 0), locked_until = null, claim_token = null
   where id = p_id and status = 'running' and claim_token = p_token;
  return found;
end $$;
revoke execute on function public.postpone_automation_run(bigint, uuid, timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.postpone_automation_run(bigint, uuid, timestamptz, jsonb, text) to service_role;

-- As in 20261017000200_automations.sql, and a rule that now starts on something else calls off the
-- runs waiting from what it started on before: they'd run under the new conditions.
create or replace function private.cancel_disabled_runs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.enabled and not new.enabled then
    update public.automation_runs set status = 'cancelled', finished_at = now(), error = 'Rule turned off'
    where rule_id = new.id and status = 'pending';
  elsif new.trigger is distinct from old.trigger then
    update public.automation_runs set status = 'cancelled', finished_at = now(), error = 'The rule now starts on something else'
    where rule_id = new.id and status = 'pending';
  end if;
  return null;
end $$;
drop trigger cancel_disabled_runs on public.automation_rules;
create trigger cancel_disabled_runs after update of enabled, trigger on public.automation_rules
  for each row execute function private.cancel_disabled_runs();

revoke all on function private.client_sms_opt_out_guard(), private.sms_keyword(text), private.backfill_sms_opt_outs() from public;

notify pgrst, 'reload schema';
