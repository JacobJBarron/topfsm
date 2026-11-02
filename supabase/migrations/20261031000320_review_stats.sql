-- Marketing → Reviews' numbers for Google reviews (docs/marketing-plan.md, phase D), read as the
-- person asking, so someone without the marketing area sees none. Only the location reviews come
-- from now, and not reviews deleted on Google.
--
--   count, average, by_stars      all time
--   needs_reply, replied          all time
--   count_12m, replied_12m        reviews posted in the last 12 months, and how many of those have
--                                 a reply: the response rate
--   median_reply_hours            the middle time from a review to its first reply, over those
--   months                        the last 12 months in the company's time zone: [{month, count,
--                                 rating_sum, rated}] (months with none are left out)
--   unmatched                     reviews with a name and no client
--   asks_12m, asks_reviewed_12m   asks that went in the last 12 months, and how many led to a review
create function public.review_stats(p_company uuid) returns jsonb
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
     where q.company_id = p_company and q.sent_at > now() - interval '12 months' and q.status <> 'failed'
       and (q.channel <> 'link' or q.clicked_at is not null)
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
revoke execute on function public.review_stats(uuid) from public, anon;
grant execute on function public.review_stats(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
