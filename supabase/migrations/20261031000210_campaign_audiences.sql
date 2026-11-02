-- More ways to pick who a one-off campaign goes to (docs/marketing-plan.md, phase C), as Jobber's
-- segments: the city they're in, the services they've had, and their recurring work.
--
--   cities             any of these cities, from one of the client's properties or their billing
--                      address, in any case
--   services           had any of these services: a line on a job that's done or has had a visit
--                      completed (recurring work too), by the service's name or the line's own
--   recurring          'yes' or 'no': has an active recurring job, or doesn't
--   recurring_ending   true: an active recurring job ends in the next 30 days (jobs.ends_on)

-- As in 20261017000900_audience_dedupe.sql, with the four new filters.
create or replace function public.campaign_audience(p_company_id uuid, p_audience jsonb)
returns table (client_id uuid, display_name text, email text)
language sql stable security invoker set search_path = '' as $$
  select distinct on (lower(trim(c.email))) c.id, c.display_name, lower(trim(c.email))
  from public.clients c
  where c.company_id = p_company_id
    and c.email is not null
    and trim(c.email) ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and not c.marketing_opt_out
    and (coalesce(jsonb_array_length(p_audience -> 'statuses'), 0) = 0
         or c.status in (select jsonb_array_elements_text(p_audience -> 'statuses')))
    and (coalesce(jsonb_array_length(p_audience -> 'tags_any'), 0) = 0
         or c.tags && array(select jsonb_array_elements_text(p_audience -> 'tags_any')))
    and not (c.tags && array(select jsonb_array_elements_text(coalesce(p_audience -> 'tags_none', '[]'))))
    and (coalesce((p_audience ->> 'no_visit_days')::integer, 0) <= 0 or not exists (
         select 1 from public.visits v join public.jobs j on j.id = v.job_id
         where j.client_id = c.id and v.status = 'completed'
           and v.completed_at > now() - make_interval(days => (p_audience ->> 'no_visit_days')::integer)))
    and (coalesce(jsonb_array_length(p_audience -> 'cities'), 0) = 0
         or exists (select 1 from public.properties p
                     where p.client_id = c.id
                       and lower(trim(p.city)) in (select lower(trim(x)) from jsonb_array_elements_text(p_audience -> 'cities') x))
         or lower(trim(c.billing_address ->> 'city')) in (select lower(trim(x)) from jsonb_array_elements_text(p_audience -> 'cities') x))
    and (coalesce(jsonb_array_length(p_audience -> 'services'), 0) = 0 or exists (
         select 1 from public.job_line_items l
           join public.jobs j on j.id = l.job_id
           left join public.services s on s.id = l.service_id
          where j.client_id = c.id
            and (j.status in ('requires_invoicing', 'completed')
                 or exists (select 1 from public.visits v where v.job_id = j.id and v.status = 'completed'))
            and lower(trim(coalesce(s.name, l.name))) in (select lower(trim(x)) from jsonb_array_elements_text(p_audience -> 'services') x)))
    and (coalesce(p_audience ->> 'recurring', '') not in ('yes', 'no')
         or (p_audience ->> 'recurring' = 'yes') = exists (
              select 1 from public.jobs j where j.client_id = c.id and j.kind = 'recurring' and j.status = 'active'))
    and (p_audience -> 'recurring_ending' is distinct from 'true'::jsonb or exists (
         select 1 from public.jobs j
          where j.client_id = c.id and j.kind = 'recurring' and j.status = 'active'
            and j.ends_on between private.company_today(p_company_id) and private.company_today(p_company_id) + 30))
  order by lower(trim(c.email)), c.created_at
$$;

-- The cities and services the audience form offers: the company's own, each once (by lower-case
-- value, labelled with its most common spelling), the most used first, up to 200 of each. As the
-- person asking, so they see only what they can read.
create function public.campaign_audience_choices(p_company uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  with cities as (
    select city from public.properties where company_id = p_company and trim(coalesce(city, '')) <> ''
    union all
    select billing_address ->> 'city' from public.clients
     where company_id = p_company and trim(coalesce(billing_address ->> 'city', '')) <> ''
  ), services as (
    select coalesce(s.name, l.name) as name
      from public.job_line_items l
      join public.jobs j on j.id = l.job_id
      left join public.services s on s.id = l.service_id
     where l.company_id = p_company and trim(coalesce(s.name, l.name, '')) <> ''
       and (j.status in ('requires_invoicing', 'completed')
            or exists (select 1 from public.visits v where v.job_id = j.id and v.status = 'completed'))
  ), city_counts as (
    select lower(trim(city)) as value, trim(city) as label, count(*) as n from cities group by 1, 2
  ), service_counts as (
    select lower(trim(name)) as value, trim(name) as label, count(*) as n from services group by 1, 2
  )
  select jsonb_build_object(
    'cities', coalesce((
      select jsonb_agg(jsonb_build_object('value', value, 'label', label, 'count', n) order by n desc, label)
        from (select value, (array_agg(label order by n desc, label))[1] as label, sum(n)::integer as n
                from city_counts group by value order by sum(n) desc, value limit 200) t), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object('value', value, 'label', label, 'count', n) order by n desc, label)
        from (select value, (array_agg(label order by n desc, label))[1] as label, sum(n)::integer as n
                from service_counts group by value order by sum(n) desc, value limit 200) t), '[]'::jsonb))
$$;
revoke execute on function public.campaign_audience_choices(uuid) from public, anon;
grant execute on function public.campaign_audience_choices(uuid) to authenticated;

notify pgrst, 'reload schema';
