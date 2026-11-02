-- Automated campaigns, phase C of docs/marketing-plan.md, Jobber's way: three campaigns on Marketing →
-- Campaigns that send by themselves, each an automation rule underneath (so it still shows in
-- Automations), with its own email and switch.
--
--   Re-engage past clients  reengage_past_clients, on a new trigger, client.inactive: a client whose
--                           last visit was N days ago (the rule's days_since_visit condition, 365 by
--                           default), once each time they go quiet. emit_inactive_clients queues the
--                           runs itself, rule by rule, from 10am in the company's time zone, at most
--                           100 a day for each rule, those who passed N most recently first.
--   Win back lost quotes    win_back_lost_quotes, 30 days after a quote is marked lost.
--   Close pending quotes    quote_followup, the starter rule every business has had, as it is.
--
-- The first two are marketing: email only, with one-click unsubscribe, skipped while Marketing is
-- uninstalled and for clients who opted out, and a client gets at most one re-engage email every 6
-- months. Both are off until a business turns them on.
--
-- Every send is recorded as a recipient of an automated campaign for its template key (one
-- campaigns row each, made when it's first needed), so the results read alike for both kinds:
--   campaigns              kind (one_off, automated) and template_key; an automated row's status
--                          is 'automated', so the one-off sender never touches it.
--   campaign_recipients    a row per send (send_key 'run:' || the automation run, and ':' || n for
--                          the run's later email actions, so a second email is its own), with a random
--                          track_token for its tracked links and pixel, the links it sent, and the
--                          quote it was about (subject_id).

-- ---------------------------------------------------------------------------------------------
-- Campaigns of either kind
-- ---------------------------------------------------------------------------------------------

alter table public.campaigns
  add column kind text not null default 'one_off' check (kind in ('one_off', 'automated')),
  add column template_key text;
alter table public.campaigns drop constraint campaigns_status_check;
alter table public.campaigns add constraint campaigns_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'automated'));
alter table public.campaigns add constraint campaigns_automated_check
  check ((kind = 'automated') = (status = 'automated') and (kind = 'automated') = (template_key is not null));
create unique index campaigns_template_idx on public.campaigns (company_id, template_key) where template_key is not null;

-- A company's automated campaign for a template key, made the first time it's needed. The server's.
create function public.ensure_automated_campaign(p_company uuid, p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_key is null or p_key not in ('reengage_past_clients', 'win_back_lost_quotes', 'quote_followup') then
    raise exception 'Not an automated campaign' using errcode = '22023';
  end if;
  insert into public.campaigns (company_id, name, kind, status, template_key, created_by)
  values (p_company,
          case p_key when 'reengage_past_clients' then 'Re-engage past clients' when 'win_back_lost_quotes' then 'Win back lost quotes' else 'Close pending quotes' end,
          'automated', 'automated', p_key, null)
  on conflict (company_id, template_key) where template_key is not null do nothing;
  select id into v_id from public.campaigns where company_id = p_company and template_key = p_key;
  return v_id;
end $$;
revoke execute on function public.ensure_automated_campaign(uuid, text) from public, anon, authenticated;
grant execute on function public.ensure_automated_campaign(uuid, text) to service_role;

-- As in 20261030000500_marketing_stops.sql, and automated campaigns are the server's: nobody signed
-- in adds, changes or deletes one (they're set up in Marketing → Campaigns, which edits their rules).
create or replace function private.campaign_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) = 'authenticated' then
    if tg_op = 'INSERT' then
      if new.kind <> 'one_off' then
        raise exception 'Automated campaigns are set up in Marketing → Campaigns' using errcode = '22023';
      end if;
      return new;
    end if;
    if old.kind = 'automated' then
      raise exception 'Automated campaigns are set up in Marketing → Campaigns' using errcode = '22023';
    end if;
    if not private.marketing_setting() then
      if tg_op = 'DELETE' then
        if old.status in ('sending') then
          raise exception 'A campaign can''t be deleted while it''s sending' using errcode = '22023';
        end if;
        return old;
      end if;
      if old.status <> 'draft' then
        raise exception 'Only draft campaigns can be edited' using errcode = '22023';
      end if;
      if new.status <> 'draft' or new.sent_count <> old.sent_count or new.recipients_count <> old.recipients_count or new.kind <> old.kind then
        raise exception 'Use Send or Schedule to send a campaign' using errcode = '22023';
      end if;
    end if;
  end if;
  return coalesce(new, old);
end $$;
drop trigger campaign_guard on public.campaigns;
create trigger campaign_guard before insert or update or delete on public.campaigns
  for each row execute function private.campaign_guard();

-- ---------------------------------------------------------------------------------------------
-- A recipient row for each send
-- ---------------------------------------------------------------------------------------------

-- The read policy, the Marketing area and "only the server writes" (20261017000300_marketing.sql,
-- 20261017001000_custom_roles.sql) cover the new columns. Office staff with Marketing can read
-- track_token: it only records an open or a click for one of their own recipients.
alter table public.campaign_recipients
  add column track_token uuid not null default gen_random_uuid(),
  add column links text[] not null default '{}' check (cardinality(links) <= 50),
  add column send_key text not null default '' check (length(send_key) <= 40),
  add column subject_id uuid,
  add column opened_at timestamptz,
  add column open_count integer not null default 0,
  add column clicked_at timestamptz,
  add column last_clicked_at timestamptz,
  add column click_count integer not null default 0;
create unique index campaign_recipients_token_idx on public.campaign_recipients (track_token);
-- One-off campaigns keep one row per address (send_key ''); an automated one has one per send.
-- PostgREST can't name a partial index's predicate, so it's a constraint on all three.
alter table public.campaign_recipients drop constraint campaign_recipients_campaign_id_email_key;
alter table public.campaign_recipients add constraint campaign_recipients_send_unique unique (campaign_id, email, send_key);
create index campaign_recipients_client_click_idx on public.campaign_recipients (client_id, last_clicked_at desc) where last_clicked_at is not null;
create index campaign_recipients_campaign_sent_idx on public.campaign_recipients (campaign_id, sent_at desc);
create index campaign_recipients_client_idx on public.campaign_recipients (campaign_id, client_id);
create index campaign_recipients_subject_idx on public.campaign_recipients (campaign_id, subject_id) where subject_id is not null;

-- As in 20261019001020_send_claims.sql, and it records the links the email carries (p_links), so a
-- tracked link redirects only to one of them. A server from before calling it with two arguments
-- still renews the claim.
drop function public.renew_campaign_recipient(bigint, uuid);
create function public.renew_campaign_recipient(p_id bigint, p_token uuid, p_links text[] default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.campaign_recipients
     set locked_until = now() + interval '5 minutes', links = coalesce(p_links[1:50], links)
   where id = p_id and status = 'sending' and claim_token = p_token;
  return found;
end $$;
revoke execute on function public.renew_campaign_recipient(bigint, uuid, text[]) from public, anon, authenticated;
grant execute on function public.renew_campaign_recipient(bigint, uuid, text[]) to service_role;

-- Records an automated campaign's email right before it's sent (status 'sending'), or says why not:
--   no row         p_gap_days: the client was sent this campaign within that many days.
--                  p_once_per_subject: this campaign already went for the quote.
--   already_sent   the same send (a retried run) went already, so it isn't sent again.
--   in_flight      the same send started in the last 15 minutes and may still be going.
-- An email started counts against the limits from then, so two runs for one client at the same
-- moment send once. The same send left 'sending' for 15 minutes (its worker stopped) is tried
-- again. Another send left 'sending' counts against the limits as if it went: it may have, and only
-- its result wasn't recorded.
create function public.begin_campaign_send(p_company uuid, p_key text, p_client uuid, p_email text, p_name text, p_send_key text,
  p_subject uuid default null, p_gap_days integer default null, p_once_per_subject boolean default false, p_links text[] default '{}')
returns table (id bigint, track_token uuid, already_sent boolean, in_flight boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_campaign uuid := public.ensure_automated_campaign(p_company, p_key);
  v_email text := lower(trim(p_email));
  v_recent constant interval := interval '15 minutes';
  v_row public.campaign_recipients;
begin
  perform pg_advisory_xact_lock(hashtext('campaign_send:' || v_campaign::text || ':' || coalesce(p_client::text, v_email)));
  select * into v_row from public.campaign_recipients r where r.campaign_id = v_campaign and r.email = v_email and r.send_key = p_send_key;
  if found and v_row.status = 'sent' then
    return query select v_row.id, v_row.track_token, true, false;
    return;
  end if;
  if found and v_row.status = 'sending' and v_row.claimed_at > now() - v_recent then
    return query select v_row.id, v_row.track_token, false, true;
    return;
  end if;
  if p_gap_days is not null and exists (
    select 1 from public.campaign_recipients r
     where r.campaign_id = v_campaign and r.client_id = p_client and r.send_key <> p_send_key
       and r.status in ('sent', 'sending') and coalesce(r.sent_at, r.claimed_at) > now() - make_interval(days => p_gap_days)) then
    return;
  end if;
  if coalesce(p_once_per_subject, false) and p_subject is not null and exists (
    select 1 from public.campaign_recipients r
     where r.campaign_id = v_campaign and r.subject_id = p_subject and r.send_key <> p_send_key
       and r.status in ('sent', 'sending')) then
    return;
  end if;
  return query
  insert into public.campaign_recipients as r (company_id, campaign_id, client_id, email, name, send_key, subject_id, links, status, claimed_at)
  values (p_company, v_campaign, p_client, v_email, p_name, p_send_key, p_subject, coalesce(p_links[1:50], '{}'), 'sending', now())
  on conflict (campaign_id, email, send_key) do update
     set status = 'sending', links = excluded.links, error = null, claimed_at = now(), name = excluded.name, subject_id = excluded.subject_id,
         client_id = excluded.client_id
  returning r.id, r.track_token, false, false;
end $$;
revoke execute on function public.begin_campaign_send(uuid, text, uuid, text, text, text, uuid, integer, boolean, text[]) from public, anon, authenticated;
grant execute on function public.begin_campaign_send(uuid, text, uuid, text, text, text, uuid, integer, boolean, text[]) to service_role;

-- How the email begun with begin_campaign_send went: sent or failed (p_error says why).
create function public.finish_campaign_send(p_id bigint, p_status text, p_error text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_status is null or p_status not in ('sent', 'failed') then
    raise exception 'A send is sent or failed' using errcode = '22023';
  end if;
  update public.campaign_recipients
     set status = p_status,
         sent_at = case when p_status = 'sent' then now() else sent_at end,
         error = case when p_status = 'sent' then null else left(p_error, 1000) end
   where id = p_id and status = 'sending';
  return found;
end $$;
revoke execute on function public.finish_campaign_send(bigint, text, text) from public, anon, authenticated;
grant execute on function public.finish_campaign_send(bigint, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Clients who haven't had a visit in a while
-- ---------------------------------------------------------------------------------------------

-- Each rule has its own N, so the daily emitter queues runs rule by rule instead of through an
-- activity row (which every rule on the verb would act on, at the smallest N). A mark is a client's
-- stretch without a visit, for one rule: a newer completed visit starts a new stretch. A mark with
-- no run is a stretch the business chose not to email (Only clients who reach it from now on), until
-- it turns the rule on again choosing Email them too (release_inactive_backlog).
create table public.inactive_client_marks (
  id bigint generated always as identity primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  rule_id uuid not null references public.automation_rules (id) on delete cascade,
  client_id uuid not null,
  last_visit_at timestamptz not null,
  run_id bigint references public.automation_runs (id) on delete set null,
  emitted_at timestamptz not null default now(),
  unique (rule_id, client_id, last_visit_at),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade
);
create index inactive_client_marks_day_idx on public.inactive_client_marks (rule_id, emitted_at desc);
create index inactive_client_marks_run_idx on public.inactive_client_marks (run_id) where run_id is not null;
-- The server's alone: no policies.
alter table public.inactive_client_marks enable row level security;
revoke all on public.inactive_client_marks from authenticated, anon;

-- How many days a client.inactive rule waits: the largest of its days_since_visit conditions (the
-- engine needs every condition to hold), never under 30, or 365 without one. As
-- packages/core/src/campaigns.ts inactiveDays reads it.
create function private.inactive_days(p_conditions jsonb) returns integer
language sql immutable set search_path = '' as $$
  select case when max(v) is null then 365 else greatest(30, max(v)) end
    from (select least(floor((c ->> 'value')::numeric), 100000)::integer as v
            from jsonb_array_elements(case when jsonb_typeof(p_conditions) = 'array' then p_conditions else '[]'::jsonb end) c
           where c ->> 'field' = 'days_since_visit' and c ->> 'op' = 'gte' and (c ->> 'value') ~ '^ *[0-9]+(\.[0-9]+)? *$') x
$$;

-- The company's clients who qualify at p_now for p_days without a visit, with when their last visit
-- was (the stretch). Their last visit is their latest completed job visit or assessment, and its day
-- in the company's time zone is p_days or more before today, and no more than 3 years before (older
-- addresses bounce). Left out: archived clients, clients who opted out of marketing or have no
-- usable email, and clients the business is already working with:
--   recurring work      an active recurring job
--   work sold           an active one-off job with no visit completed yet (one whose visits are done
--                       but nobody closed is past work)
--   visits              a visit to come, or not yet booked
--   an open request     new or at its assessment, as the Client Hub and Pipeline count them (a quoted
--                       request is left to its quote)
--   a quote             approved, or awaiting an answer until it's past its valid-until date (30 days
--                       after it was sent when it has none): a quote nobody answered for years
--                       isn't waiting anymore
create function private.inactive_clients(p_company uuid, p_days integer, p_now timestamptz)
returns table (client_id uuid, last_visit_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with zone as (
    select coalesce(timezone, 'UTC') as tz, (p_now at time zone coalesce(timezone, 'UTC'))::date as today
      from public.companies where id = p_company
  ), last as (
    select x.client_id, max(x.completed_at) as last_visit_at from (
      select j.client_id, v.completed_at from public.visits v join public.jobs j on j.id = v.job_id
       where v.company_id = p_company and v.status = 'completed' and v.kind in ('job', 'assessment') and v.completed_at is not null
      union all
      select q.client_id, v.completed_at from public.visits v join public.requests q on q.id = v.request_id
       where v.company_id = p_company and v.job_id is null and v.status = 'completed' and v.kind in ('job', 'assessment') and v.completed_at is not null
    ) x group by x.client_id
  )
  select l.client_id, l.last_visit_at
    from last l join public.clients c on c.id = l.client_id cross join zone z
   where c.company_id = p_company
     and (l.last_visit_at at time zone z.tz)::date <= z.today - p_days
     and (l.last_visit_at at time zone z.tz)::date >= z.today - 1095
     and c.status <> 'archived' and not c.marketing_opt_out
     and c.email is not null and trim(c.email) ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     and not exists (
       select 1 from public.jobs j
        where j.client_id = c.id and j.status = 'active'
          and (j.kind = 'recurring'
               or not exists (select 1 from public.visits v where v.job_id = j.id and v.status = 'completed' and v.kind in ('job', 'assessment'))))
     and not exists (
       select 1 from public.visits v
         left join public.jobs j on j.id = v.job_id
         left join public.requests q on q.id = v.request_id
        where v.company_id = p_company and coalesce(j.client_id, q.client_id) = c.id
          and v.kind <> 'task' and v.status in ('unscheduled', 'scheduled', 'en_route', 'in_progress')
          and coalesce(v.scheduled_on, (v.starts_at at time zone z.tz)::date, z.today) >= z.today)
     and not exists (select 1 from public.requests q where q.client_id = c.id and q.status in ('new', 'assessment_scheduled', 'assessment_complete'))
     and not exists (
       select 1 from public.quotes q
        where q.client_id = c.id
          and (q.status = 'approved'
               or (q.status in ('sent', 'changes_requested')
                   and coalesce(q.valid_until, (coalesce(q.sent_at, q.updated_at) at time zone z.tz)::date + 30) >= z.today)))
$$;
revoke all on function private.inactive_days(jsonb), private.inactive_clients(uuid, integer, timestamptz) from public;

-- Queues today's client.inactive runs (the hourly "inactive" task, apps/api/src/tasks.ts), for each
-- enabled rule on it in a company with Marketing installed, from 10am to 5pm in the company's time
-- zone (the later hours catch up a missed 10am run), or only p_company's. A client is queued once for
-- each stretch without a visit, and each rule queues at most p_cap a day, those who passed N most
-- recently first, so a business turning it on with a long list of past clients emails them over
-- weeks. Clients sent a re-engage email in the last 6 months (one whose result wasn't recorded
-- included) are left for later, so the cap isn't spent on sends that would be skipped. Says how many
-- it queued.
create function public.emit_inactive_clients(p_now timestamptz default now(), p_cap integer default 100, p_company uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_rule record;
  v_room integer;
  v_campaign uuid;
  v_n integer;
  v_count integer := 0;
begin
  for v_rule in
    select r.id, r.company_id, r.conditions, coalesce(co.timezone, 'UTC') as tz
      from public.automation_rules r join public.companies co on co.id = r.company_id
     where r.enabled and r.trigger = 'client.inactive'
       and co.settings -> 'marketing' ->> 'enabled' = 'true'
       and (p_company is null or r.company_id = p_company)
       and extract(hour from p_now at time zone coalesce(co.timezone, 'UTC')) between 10 and 16
     order by r.id
  loop
    -- Two servers at once queue a rule's clients once.
    perform pg_advisory_xact_lock(hashtext('inactive:' || v_rule.id::text));
    select greatest(0, coalesce(p_cap, 100) - count(*))::integer into v_room
      from public.inactive_client_marks m join public.automation_runs ar on ar.id = m.run_id
     where m.rule_id = v_rule.id and ar.status <> 'cancelled'
       and m.emitted_at >= ((p_now at time zone v_rule.tz)::date)::timestamp at time zone v_rule.tz
       and m.emitted_at < ((p_now at time zone v_rule.tz)::date + 1)::timestamp at time zone v_rule.tz;
    continue when v_room = 0;
    select id into v_campaign from public.campaigns where company_id = v_rule.company_id and template_key = 'reengage_past_clients';
    with picked as materialized (
      select i.client_id, i.last_visit_at
        from private.inactive_clients(v_rule.company_id, private.inactive_days(v_rule.conditions), p_now) i
       where not exists (select 1 from public.inactive_client_marks m
                          where m.rule_id = v_rule.id and m.client_id = i.client_id and m.last_visit_at = i.last_visit_at)
         and not exists (select 1 from public.campaign_recipients cr
                          where cr.campaign_id = v_campaign and cr.client_id = i.client_id
                            and cr.status in ('sent', 'sending') and coalesce(cr.sent_at, cr.claimed_at) > p_now - interval '182 days')
       order by i.last_visit_at desc, i.client_id
       limit v_room
    ), queued as (
      insert into public.automation_runs (company_id, rule_id, subject_type, subject_id, run_after)
      select v_rule.company_id, v_rule.id, 'client', p.client_id, p_now from picked p
      returning id, subject_id
    )
    insert into public.inactive_client_marks (company_id, rule_id, client_id, last_visit_at, run_id, emitted_at)
    select v_rule.company_id, v_rule.id, q.subject_id, p.last_visit_at, q.id, p_now
      from queued q join picked p on p.client_id = q.subject_id
    on conflict (rule_id, client_id, last_visit_at) do update set run_id = excluded.run_id, emitted_at = excluded.emitted_at;
    get diagnostics v_n = row_count;
    v_count := v_count + v_n;
  end loop;
  return v_count;
end $$;
revoke execute on function public.emit_inactive_clients(timestamptz, integer, uuid) from public, anon, authenticated;
grant execute on function public.emit_inactive_clients(timestamptz, integer, uuid) to service_role;

-- Turning Re-engage on with "Only clients who reach it from now on": today's backlog is marked as
-- done, with no run, so only clients who reach N from now on are emailed. The server's.
create function public.skip_inactive_backlog(p_rule uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_rule record;
  v_count integer;
begin
  select id, company_id, conditions into v_rule from public.automation_rules where id = p_rule and trigger = 'client.inactive';
  if not found then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtext('inactive:' || v_rule.id::text));
  insert into public.inactive_client_marks (company_id, rule_id, client_id, last_visit_at, run_id)
  select v_rule.company_id, v_rule.id, i.client_id, i.last_visit_at, null
    from private.inactive_clients(v_rule.company_id, private.inactive_days(v_rule.conditions), now()) i
  on conflict (rule_id, client_id, last_visit_at) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.skip_inactive_backlog(uuid) from public, anon, authenticated;
grant execute on function public.skip_inactive_backlog(uuid) to service_role;

-- Turning Re-engage on with "Email them too": a backlog let go when it was last turned on is emailed
-- after all, so the choice made each time it's turned on holds. Stretches already emailed stay
-- marked. Says how many it let back in. The server's.
create function public.release_inactive_backlog(p_rule uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('inactive:' || p_rule::text));
  delete from public.inactive_client_marks where rule_id = p_rule and run_id is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.release_inactive_backlog(uuid) from public, anon, authenticated;
grant execute on function public.release_inactive_backlog(uuid) to service_role;

-- How many clients Re-engage past clients would email at p_days, for the card: those who qualify
-- today, less the ones already emailed this stretch and those sent it in the last 6 months. A
-- backlog let go counts while the rule is off (turning it on asks again) and not while it's on. It
-- leaves out the daily cap, which the card says in days. For the office with Marketing.
create function public.inactive_client_count(p_company uuid, p_days integer) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rule record;
  v_campaign uuid;
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'marketing')) then
    raise exception 'Campaigns are part of Marketing' using errcode = '42501';
  end if;
  select id, enabled into v_rule from public.automation_rules where company_id = p_company and template_key = 'reengage_past_clients';
  select id into v_campaign from public.campaigns where company_id = p_company and template_key = 'reengage_past_clients';
  return (
    select count(*) from private.inactive_clients(p_company, greatest(30, coalesce(p_days, 365)), now()) i
     where not exists (select 1 from public.inactive_client_marks m
                        where m.rule_id = v_rule.id and m.client_id = i.client_id and m.last_visit_at = i.last_visit_at
                          and (m.run_id is not null or v_rule.enabled))
       and not exists (select 1 from public.campaign_recipients cr
                        where cr.campaign_id = v_campaign and cr.client_id = i.client_id
                          and cr.status in ('sent', 'sending') and coalesce(cr.sent_at, cr.claimed_at) > now() - interval '182 days'));
end $$;
revoke execute on function public.inactive_client_count(uuid, integer) from public, anon;
grant execute on function public.inactive_client_count(uuid, integer) to authenticated;

-- Marketing → Campaigns' automated campaigns as their rules have them, for the office with Marketing
-- who can't read automation_rules (no Automations area): for each, its rule, whether it's on, its
-- days (null when the wait isn't whole days) and how many emails are waiting. Nothing else of the rule.
create function public.automated_campaign_states(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.has_role(p_company, '{owner,admin,office}') and private.has_perm(p_company, 'marketing')) then
    raise exception 'Campaigns are part of Marketing' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'template_key', r.template_key, 'rule_id', r.id, 'enabled', r.enabled,
             'days', case when r.trigger = 'client.inactive' then private.inactive_days(r.conditions)
                          when r.delay_minutes > 0 and r.delay_minutes % 1440 = 0 then r.delay_minutes / 1440 end,
             'waiting', (select count(*) from public.automation_runs ar where ar.rule_id = r.id and ar.status = 'pending'))
           order by r.template_key)
      from public.automation_rules r
     where r.company_id = p_company and r.template_key in ('reengage_past_clients', 'win_back_lost_quotes', 'quote_followup')), '[]'::jsonb);
end $$;
revoke execute on function public.automated_campaign_states(uuid) from public, anon;
grant execute on function public.automated_campaign_states(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The two new starter rules, off
-- ---------------------------------------------------------------------------------------------

-- As in 20261031000120_referral_asks.sql, with Re-engage past clients and Win back lost quotes, both
-- off until a business turns them on in Marketing → Campaigns. Their emails link to the client's
-- Client Hub, where they can ask for work, so clicks and bookings can be counted.
create or replace function private.install_default_automations(p_company uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare office jsonb := '["owner", "admin", "office"]';
begin
  insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  values
    (p_company, 'notify_quote_approved', 'Tell the office when a quote is approved',
     'A notification for the office as soon as a client approves.', 'quote.approved', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Quote #{{number}} approved',
       'body', '{{client.name}} approved “{{title}}” ({{total}}).')), true),
    (p_company, 'notify_changes_requested', 'Tell the office when a client asks for changes',
     null, 'quote.changes_requested', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Changes requested on quote #{{number}}',
       'body', '{{client.name}} wants changes to “{{title}}”.')), true),
    (p_company, 'notify_range_accepted', 'Tell the office when a client says yes to a price range',
     'A notification to book the site visit.', 'quote.range_accepted', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', '["owner", "admin", "office", "estimator"]'::jsonb,
       'title', '{{client.name}} wants a visit', 'body', 'They said yes to the price range for “{{title}}”. Book the site visit.')), true),
    (p_company, 'notify_new_request', 'Tell the office about new online requests',
     'Requests from your booking forms and the Client Hub.', 'request.created', 0,
     jsonb_build_array(jsonb_build_object('field', 'source', 'op', 'in', 'value', jsonb_build_array('web_form', 'hub', 'referral'))),
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'New request from {{client.name}}',
       'body', '{{title}}')), true),
    (p_company, 'notify_invoice_paid', 'Tell the office when an invoice is paid',
     null, 'invoice.paid', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'notify', 'roles', office, 'title', 'Invoice #{{number}} paid',
       'body', '{{client.name}} paid {{total}}.')), true),
    (p_company, 'quote_followup', 'Follow up on quotes after 3 days',
     'Emails the client if they haven''t answered a quote three days after you send it.', 'quote.sent', 4320,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'sent')),
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Following up on your quote from {{company.name}}',
       'body', E'Hi {{client.first_name}},\n\nJust checking whether you had any questions about quote #{{number}} ({{total}}). You can review and approve it here:\n\n{{link}}\n\nThanks,\n{{company.name}}')), true),
    (p_company, 'invoice_overdue', 'Remind clients when an invoice is past due',
     null, 'invoice.overdue', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: invoice #{{number}} from {{company.name}} is past due',
       'body', E'Hi {{client.first_name}},\n\nThis is a friendly reminder that invoice #{{number}} has a balance of {{balance}}. You can view and pay it here:\n\n{{link}}\n\nThank you,\n{{company.name}}')), true),
    (p_company, 'visit_reminder', 'Remind clients the day before a visit',
     'Sent the day before each scheduled visit or assessment.', 'visit.reminder', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_email',
       'subject', 'Reminder: {{company.name}} is coming {{date}}',
       'body', E'Hi {{client.first_name}},\n\nThis is a reminder that {{company.name}} is scheduled to visit {{address}} on {{date}}{{time}}.\n\nQuestions? Reply to this email or call {{company.phone}}.')), false),
    (p_company, 'on_my_way', 'Text the client when the crew is on the way',
     'Sent when a crew taps “On my way” in the app.', 'visit.en_route', 0, '[]',
     jsonb_build_array(jsonb_build_object('type', 'send_sms',
       'body', 'Hi {{client.first_name}}, this is {{company.name}}. Our crew is on the way to {{address}} now.')), false),
    (p_company, 'review_after_job', 'Ask for a Google review after a job',
     'Sends your review link a day after a job is completed.', 'job.completed', 1440,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'review_recurring', 'Ask for a Google review on recurring work',
     'Sends your review link a day after a recurring job reaches the visit you chose in Marketing, once for each job.', 'job.recurring_third_visit', 1440, '[]',
     jsonb_build_array(jsonb_build_object('type', 'request_review', 'channel', 'email')), false),
    (p_company, 'referral_after_job', 'Ask for referrals after a job',
     'Emails your referral link a week after a job is completed.', 'job.completed', 10080,
     jsonb_build_array(jsonb_build_object('field', 'kind', 'op', 'not_equals', 'value', 'recurring')),
     jsonb_build_array(jsonb_build_object('type', 'request_referral')), false),
    (p_company, 'reengage_past_clients', 'Re-engage past clients',
     'Emails clients a year after their last visit, once each time they go quiet.', 'client.inactive', 0,
     jsonb_build_array(jsonb_build_object('field', 'days_since_visit', 'op', 'gte', 'value', 365)),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
       'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr reply to this email or call {{company.phone}} and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}')), false),
    (p_company, 'win_back_lost_quotes', 'Win back lost quotes',
     'Emails the client 30 days after a quote is marked lost, if it still is.', 'quote.lost', 43200,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'lost')),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'Still thinking about {{title}}?',
       'body', E'Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn''t right, or you''d like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email or call {{company.phone}}.\n\nThanks,\n{{company.name}}')), false)
  on conflict (company_id, template_key) do nothing;
end $$;

-- Every business gets the two new rules, off. Running install_default_automations again would bring
-- back starter rules a business deleted, so only these are added. Says how many.
create function private.add_campaign_rules() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.automation_rules (company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  select r.* from public.companies c cross join lateral (values
    (c.id, 'reengage_past_clients', 'Re-engage past clients',
     'Emails clients a year after their last visit, once each time they go quiet.', 'client.inactive', 0,
     jsonb_build_array(jsonb_build_object('field', 'days_since_visit', 'op', 'gte', 'value', 365)),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'It''s been a while, {{client.first_name}}',
       'body', E'Hi {{client.first_name}},\n\nIt''s been a while since we last worked together, and we''d love to help again. If anything around the property needs attention, you can ask for a visit online:\n\n{{link}}\n\nOr reply to this email or call {{company.phone}} and we''ll get you on the schedule.\n\nThanks,\n{{company.name}}')), false),
    (c.id, 'win_back_lost_quotes', 'Win back lost quotes',
     'Emails the client 30 days after a quote is marked lost, if it still is.', 'quote.lost', 43200,
     jsonb_build_array(jsonb_build_object('field', 'status', 'op', 'equals', 'value', 'lost')),
     jsonb_build_array(jsonb_build_object('type', 'send_email', 'subject', 'Still thinking about {{title}}?',
       'body', E'Hi {{client.first_name}},\n\nA while ago we sent you a quote for {{title}}. If the timing wasn''t right, or you''d like us to take another look at the price or the work, you can ask us for a fresh quote online:\n\n{{link}}\n\nOr just reply to this email or call {{company.phone}}.\n\nThanks,\n{{company.name}}')), false)
  ) r(company_id, template_key, name, description, trigger, delay_minutes, conditions, actions, enabled)
  on conflict (company_id, template_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.add_campaign_rules() from public;
select private.add_campaign_rules();

-- ---------------------------------------------------------------------------------------------
-- Uninstalling, turning a rule off and changing its wait
-- ---------------------------------------------------------------------------------------------

-- As in 20261030000500_marketing_stops.sql. Uninstalling also calls off the re-engage and win-back
-- emails still waiting (and any rule's on client.inactive), so installing again sends nothing late.
-- Their stretches are let go, so the clients still without a visit are emailed again once it's
-- installed (the engine lets go those of runs it had already claimed: services/automations.ts).
-- Close pending quotes isn't marketing, and keeps going.
create or replace function public.marketing_set_enabled(p_company uuid, p_enabled boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_stopped uuid[];
begin
  if not (private.has_role(p_company, '{owner,admin}') and private.has_perm(p_company, 'apps')) then
    raise exception 'Only owners and admins who connect apps can install Marketing' using errcode = '42501';
  end if;
  perform set_config('crewtavo.marketing', 'on', true);
  update public.companies
     set settings = jsonb_set(coalesce(settings, '{}'), '{marketing}',
       (case when jsonb_typeof(settings -> 'marketing') = 'object' then settings -> 'marketing' else '{}'::jsonb end)
         || jsonb_build_object('enabled', p_enabled, 'changed_at', now()))
   where id = p_company;
  if not p_enabled then
    update public.review_requests
       set next_reminder_at = null, reminder_note = 'Marketing was uninstalled'
     where company_id = p_company and next_reminder_at is not null;
    delete from public.campaign_recipients r
     using public.campaigns cp
     where cp.id = r.campaign_id and cp.company_id = p_company and cp.status = 'scheduled';
    update public.campaigns set status = 'draft', scheduled_at = null, recipients_count = 0
     where company_id = p_company and status = 'scheduled';
    -- Stopped first: a run partway through its batch checks this before each email.
    with stopped as (
      update public.campaigns set status = 'cancelled', finished_at = now()
       where company_id = p_company and status = 'sending'
      returning id)
    select coalesce(array_agg(id), '{}') into v_stopped from stopped;
    update public.campaign_recipients set status = 'skipped', error = 'Marketing was uninstalled'
     where campaign_id = any (v_stopped) and status in ('pending', 'sending');
    with cancelled as (
      update public.automation_runs r set status = 'cancelled', finished_at = now(), error = 'Marketing was uninstalled'
        from public.automation_rules ru
       where ru.id = r.rule_id and ru.company_id = p_company and r.status = 'pending'
         and (ru.template_key in ('reengage_past_clients', 'win_back_lost_quotes') or ru.trigger = 'client.inactive')
      returning r.id)
    delete from public.inactive_client_marks m using cancelled c where m.run_id = c.id;
  end if;
  perform set_config('crewtavo.marketing', '', true);
  return p_enabled;
end $$;

-- As in 20261030000300_review_reminders.sql, and a client.inactive run it calls off lets the client's
-- stretch go, so turning the rule on again emails them. One the office cancels by hand stays
-- cancelled (POST /api/automations/runs/:id/cancel leaves its stretch marked).
create or replace function private.cancel_disabled_runs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.enabled and not new.enabled then
    with cancelled as (
      update public.automation_runs set status = 'cancelled', finished_at = now(), error = 'Rule turned off'
       where rule_id = new.id and status = 'pending'
      returning id)
    delete from public.inactive_client_marks m using cancelled c where m.run_id = c.id;
  elsif new.trigger is distinct from old.trigger then
    with cancelled as (
      update public.automation_runs set status = 'cancelled', finished_at = now(), error = 'The rule now starts on something else'
       where rule_id = new.id and status = 'pending'
      returning id)
    delete from public.inactive_client_marks m using cancelled c where m.run_id = c.id;
  end if;
  return null;
end $$;

-- A rule's new wait moves its runs still waiting: they go that long after what started them (or now,
-- when that's past). So "3 days" on Close pending quotes changed to 5 holds for quotes already sent.
create function private.move_waiting_runs() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.automation_runs r
     set run_after = greatest(now(), coalesce((select a.created_at from public.activity a where a.id = r.activity_id), r.created_at)
                                     + make_interval(mins => new.delay_minutes))
   where r.rule_id = new.id and r.status = 'pending';
  return null;
end $$;
create trigger move_waiting_runs after update of delay_minutes on public.automation_rules
  for each row when (new.delay_minutes is distinct from old.delay_minutes) execute function private.move_waiting_runs();

revoke all on function private.move_waiting_runs() from public;

select private.fold_member_checks();

notify pgrst, 'reload schema';
