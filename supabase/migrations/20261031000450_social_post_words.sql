-- Social posts' words (docs/marketing-plan.md, phase E): an automatic post's notification names its
-- day as Marketing → Social lists it, "Nov 2" past tomorrow, never a weekday, which could be weeks
-- out ("posts Mon at 10 AM" while the list said "Posts Nov 2 at 10 AM").

-- "today at 10 AM", "tomorrow at 1 PM", "Nov 6 at 4 PM", as packages/core/src/social.ts autoPostWhen says it.
create or replace function private.auto_post_when(p_at timestamptz, p_tz text) returns text
language sql stable set search_path = '' as $$
  select case (p_at at time zone p_tz)::date - (now() at time zone p_tz)::date
           when 0 then 'today' when 1 then 'tomorrow' else to_char(p_at at time zone p_tz, 'Mon FMDD') end
         || ' at ' || to_char(p_at at time zone p_tz, 'FMHH12') || case when to_char(p_at at time zone p_tz, 'MI') = '00' then '' else ':' || to_char(p_at at time zone p_tz, 'MI') end
         || ' ' || to_char(p_at at time zone p_tz, 'AM')
$$;
