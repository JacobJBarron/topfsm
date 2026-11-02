-- Follow-ups to review asks (docs/marketing-plan.md, decision 1), from checking them end to end:
--
--   Honest opens        a link scanner or a text's link preview isn't the client opening the link:
--                       a HEAD request records nothing, and nor does a request in the first 30
--                       seconds after the ask or a reminder went (track_review_click), as campaign
--                       links already count (track_campaign_click). Only a real open stops the
--                       reminders.
--   Short links         every ask has a short random token (review_requests.link_token), so its
--                       link is /api/public/r/<12 letters and digits> instead of a signed token
--                       of about 265 characters: a text with it fits in fewer segments. Links
--                       already sent keep working.
--   Copied links        a link copied by hand is an ask from when it's opened, not from when it
--                       was copied: the 6 months (last_review_ask), the overview's 30 days
--                       (marketing_summary), the Google review match's 180 days (private.review_ask)
--                       and the Reviews tab's 12 months (review_stats) all count from then
--                       (private.review_asked_at).
--   Which visit         the recurring-work event says the visit the job reached, not the visit
--                       chosen in Marketing: after the count is lowered, a job past it has the
--                       event at its next visit, and says that one.

-- ---------------------------------------------------------------------------------------------
-- Short links
-- ---------------------------------------------------------------------------------------------

-- 12 letters and digits from a random UUID's random bytes (not its version and variant bytes):
-- about 71 bits, so a link can't be guessed.
create function private.review_link_token() returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', get_byte(u.b, x.i) % 62 + 1, 1), '' order by x.n)
    from (select uuid_send(gen_random_uuid()) as b) u,
         unnest(array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13]) with ordinality as x(i, n)
$$;
revoke all on function private.review_link_token() from public;

-- Every ask gets one, those already made too (their reminders go with the short link).
alter table public.review_requests add column link_token text not null default private.review_link_token();
create unique index review_requests_link_token_idx on public.review_requests (link_token);
comment on column public.review_requests.link_token is 'The short random token in the ask''s link (/api/public/r/<token>), in its reminders too';

-- ---------------------------------------------------------------------------------------------
-- Honest opens
-- ---------------------------------------------------------------------------------------------

-- A review link opened, found by its short token or by the signed link's company and ask. It's
-- counted (p_count: a GET from something that isn't a link preview) once, and only 30 seconds or
-- more after the ask or its latest reminder went: a mail scanner or a text's link preview opens it
-- straight away. An open stops the reminders. The company the ask is for, or null when there's no
-- such ask. The server's alone.
create function public.track_review_click(p_company uuid default null, p_id uuid default null, p_token text default null, p_count boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_row public.review_requests;
begin
  if p_token is not null then
    select * into v_row from public.review_requests where link_token = p_token;
  elsif p_company is not null and p_id is not null then
    select * into v_row from public.review_requests where company_id = p_company and id = p_id;
  end if;
  if v_row.id is null then
    return null;
  end if;
  if coalesce(p_count, false) and v_row.clicked_at is null
     and now() - coalesce(v_row.last_reminder_at, v_row.sent_at) >= interval '30 seconds' then
    update public.review_requests
       set status = 'clicked', clicked_at = now(), next_reminder_at = null
     where id = v_row.id and clicked_at is null;
  end if;
  return v_row.company_id;
end $$;
revoke execute on function public.track_review_click(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.track_review_click(uuid, uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Copied links count from when they're opened
-- ---------------------------------------------------------------------------------------------

-- When an ask counts as made: when it went, or for a link copied by hand when it was opened (null
-- until then). An ask that failed never counts.
create function private.review_asked_at(p_status text, p_channel text, p_sent timestamptz, p_clicked timestamptz) returns timestamptz
language sql immutable set search_path = '' as $$
  select case when p_status = 'failed' then null when p_channel = 'link' then p_clicked else p_sent end
$$;
grant execute on function private.review_asked_at(text, text, timestamptz, timestamptz) to authenticated, service_role;

-- As in 20261030000600_review_ask_followups.sql, a copied link counted from when it was opened.
create or replace function public.last_review_ask(p_company uuid, p_client uuid) returns timestamptz
language sql stable security invoker set search_path = '' as $$
  select max(private.review_asked_at(r.status, r.channel, r.sent_at, r.clicked_at)) from public.review_requests r
   where r.company_id = p_company and r.client_id = p_client
$$;

-- As in 20261031000300_google_reviews.sql, the 180 days counted from when the ask was made (a copied
-- link's open).
create or replace function private.review_ask(p_company uuid, p_client uuid, p_posted timestamptz) returns uuid
language sql stable security definer set search_path = '' as $$
  select r.id from public.review_requests r
   where r.company_id = p_company and r.client_id = p_client
     and private.review_asked_at(r.status, r.channel, r.sent_at, r.clicked_at) <= p_posted
     and private.review_asked_at(r.status, r.channel, r.sent_at, r.clicked_at) > p_posted - interval '180 days'
   order by private.review_asked_at(r.status, r.channel, r.sent_at, r.clicked_at) desc
   limit 1
$$;

-- As in 20261031000230_automated_campaign_fixes.sql, review requests counted from when they were
-- made (a copied link's open), and the opened ones among them.
create or replace function public.marketing_summary(p_company_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'campaigns_sent', (select count(*) from public.campaigns where company_id = p_company_id and status = 'sent'),
    'emails_sent_30d', (select count(*) filter (where r.status = 'sent') from public.campaign_recipients r
                         where r.company_id = p_company_id and r.sent_at > now() - interval '30 days'),
    'automated_sent_30d', (select count(*) from public.campaign_recipients r join public.campaigns c on c.id = r.campaign_id
                            where r.company_id = p_company_id and c.kind = 'automated' and r.status = 'sent' and r.sent_at > now() - interval '30 days'),
    'reviews_requested_30d', (select count(*) from public.review_requests r
                               where r.company_id = p_company_id
                                 and private.review_asked_at(r.status, r.channel, r.sent_at, r.clicked_at) > now() - interval '30 days'),
    'reviews_clicked_30d', (select count(*) from public.review_requests r
                             where r.company_id = p_company_id and r.clicked_at is not null
                               and private.review_asked_at(r.status, r.channel, r.sent_at, r.clicked_at) > now() - interval '30 days'),
    'referrals_total', (select count(*) from public.referrals where company_id = p_company_id
                         and coalesce(no_reward_reason, '') not in ('self', 'already_client')),
    'referrals_won', (select count(*) from public.referrals where company_id = p_company_id and status = 'won'
                       and coalesce(no_reward_reason, '') not in ('self', 'already_client')),
    'credits_owed', (select coalesce(sum(r.reward_amount - r.given_amount - coalesce((select sum(c.amount) from public.referral_credits c where c.referral_id = r.id), 0)), 0)
                       from public.referrals r where r.company_id = p_company_id and r.reward_status = 'earned'),
    'referral_revenue', private.referral_revenue(p_company_id),
    'campaign_revenue', case when private.has_role(p_company_id, '{owner,admin,office}') and private.has_perm(p_company_id, 'invoices') then
                          (select coalesce(sum(b.amount), 0) from public.campaign_bookings b where b.company_id = p_company_id and b.kind = 'invoice') end,
    'opted_out', (select count(*) from public.clients where company_id = p_company_id and marketing_opt_out)
  )
$$;

-- As in 20261031000320_review_stats.sql, asks counted over 12 months from when they were made.
create or replace function public.review_stats(p_company uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with zone as (select coalesce((select c.timezone from public.companies c where c.id = p_company), 'UTC') as tz),
  live as (
    select r.* from public.reviews r
     where r.company_id = p_company and r.deleted_at is null
       and r.location_id = coalesce(private.review_location(p_company), r.location_id)
  ),
  year as (select * from live where posted_at > now() - interval '12 months'),
  asks as (
    select q.* from public.review_requests q
     where q.company_id = p_company
       and private.review_asked_at(q.status, q.channel, q.sent_at, q.clicked_at) > now() - interval '12 months'
  )
  select jsonb_build_object(
    'count', (select count(*) from live),
    'average', (select round(avg(rating), 2) from live),
    'by_stars', (select jsonb_object_agg(s::text, (select count(*) from live where rating = s)) from generate_series(1, 5) s),
    'needs_reply', (select count(*) from live where reply_comment is null),
    'replied', (select count(*) from live where reply_comment is not null),
    'count_12m', (select count(*) from year),
    'replied_12m', (select count(*) from year where first_replied_at is not null),
    'median_reply_hours', (select round(percentile_cont(0.5) within group (order by extract(epoch from (first_replied_at - posted_at)) / 3600)::numeric, 1)
                             from year where first_replied_at is not null),
    'months', (select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'count', m.count, 'rating_sum', m.rating_sum, 'rated', m.rated) order by m.month), '[]')
                 from (select to_char(l.posted_at at time zone z.tz, 'YYYY-MM') as month, count(*) as count, coalesce(sum(l.rating), 0) as rating_sum, count(l.rating) as rated
                         from live l cross join zone z
                        where l.posted_at at time zone z.tz >= date_trunc('month', now() at time zone z.tz) - interval '11 months'
                        group by 1) m),
    'unmatched', (select count(*) from live where client_id is null and not reviewer_anonymous),
    'asks_12m', (select count(*) from asks),
    'asks_reviewed_12m', (select count(*) from asks where reviewed_at is not null)
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Which visit
-- ---------------------------------------------------------------------------------------------

-- As in 20261030000400_recurring_review_visits.sql, saying the visit the job reached (its completed
-- job visits), which is the chosen one unless the count was lowered past where the job was.
create or replace function private.activity_visits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_job record; v_after integer; v_done integer;
begin
  if new.status is distinct from old.status and new.status in ('en_route', 'in_progress', 'completed') then
    v_client := private.visit_client(new);
    perform private.emit(new.company_id,
      case new.status when 'completed' then 'visit.completed' when 'in_progress' then 'visit.started' else 'visit.en_route' end,
      'visit', new.id,
      format('%s: %s%s',
        case new.status when 'completed' then 'Visit completed' when 'in_progress' then 'Visit started' else 'On the way' end,
        new.title, case when v_client is null then '' else ' (' || private.client_name(v_client) || ')' end),
      jsonb_build_object('kind', new.kind, 'client_id', v_client));
  end if;

  -- A recurring job's visit to ask after done, once for each job. Assessments, tasks and events on
  -- it aren't visits of the work. Cheapest first: a one-off job's visits stop at the job, and a
  -- recurring job's after it at the activity it already has, before anything is counted.
  if new.status = 'completed' and old.status is distinct from 'completed' and new.kind = 'job' and new.job_id is not null then
    select j.id, j.number, j.client_id into v_job from public.jobs j where j.id = new.job_id and j.kind = 'recurring';
    if found then
      v_after := coalesce(private.review_visits(new.company_id), 3);
      -- Two visits finished at the same moment both count to it; only one of them says so.
      perform pg_advisory_xact_lock(hashtext('job.recurring_third_visit:' || v_job.id::text));
      if not exists (select 1 from public.activity a
                      where a.subject_type = 'job' and a.subject_id = v_job.id and a.verb = 'job.recurring_third_visit') then
        select count(*) into v_done from public.visits v where v.job_id = v_job.id and v.kind = 'job' and v.status = 'completed';
        if v_done >= v_after then
          perform private.emit(new.company_id, 'job.recurring_third_visit', 'job', v_job.id,
            format('Job #%s for %s reached its %s visit', v_job.number, private.client_name(v_job.client_id), private.ordinal(v_done)),
            jsonb_build_object('number', v_job.number, 'visits', v_done));
        end if;
      end if;
    end if;
  end if;
  return null;
end $$;

notify pgrst, 'reload schema';
