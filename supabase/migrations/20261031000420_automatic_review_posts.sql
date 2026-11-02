-- Automatic 5-star posts (docs/marketing-plan.md, phase E), off until the office turns them on in
-- Marketing → Social: a new 5-star Google review with words is scheduled to post at 10 AM, 1 PM or
-- 4 PM in the company's time zone, at most 3 a day, starting the next day (or today, before 8 AM),
-- so the office can change or cancel it first. Never one from the first full sync or a re-import
-- (record_reviews marks only news 'new': after the first full pass, and posted in the last 14 days),
-- never twice for a review, and only to the networks ready when it's scheduled.
--
--   settings.social   {auto: {enabled, networks}}: written only by social_set_auto (the server),
--                     which turning it off also cancels the automatic posts still scheduled.
--                     Nothing signed in changes it (social_settings_guard), as with settings.marketing.
--
-- Uninstalling Marketing puts scheduled posts back to drafts, and a post partway through stops before
-- its next network (marketing_set_enabled).

-- ---------------------------------------------------------------------------------------------
-- Where a post can go
-- ---------------------------------------------------------------------------------------------

-- Facebook & Instagram signed in with a Page picked (the server saves the Page's token with it), and
-- for Instagram, the Page's Instagram account picked too.
create function private.meta_ready(p_company uuid, p_network text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select i.status = 'connected' and coalesce(i.settings ->> 'page_id', '') <> ''
       and (p_network = 'facebook' or coalesce(i.settings ->> 'ig_user_id', '') <> '')
      from public.integrations i where i.company_id = p_company and i.provider = 'meta'), false)
$$;

-- Google Business Profile signed in, its location in use and nothing in the way but a passing error.
create function private.google_ready(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.integrations i
      join public.review_syncs s on s.company_id = i.company_id
     where i.company_id = p_company and i.provider = 'google_business' and i.status = 'connected'
       and s.location_id is not null and i.settings ->> 'location' = s.location_id
       and coalesce(s.problem, 'error') = 'error')
$$;

create function private.social_network_ready(p_company uuid, p_network text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_network
    when 'facebook' then private.meta_ready(p_company, 'facebook')
    when 'instagram' then private.meta_ready(p_company, 'instagram')
    when 'google' then private.google_ready(p_company)
    else false end
$$;

-- The networks automatic posts go to, as packages/core/src/social.ts socialSettings reads them:
-- none while they're off.
create function private.social_settings_auto(p_settings jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array(
    select u.n from unnest(array['facebook', 'instagram', 'google']) with ordinality as u(n, i)
     where p_settings -> 'social' -> 'auto' ->> 'enabled' = 'true'
       and jsonb_typeof(p_settings -> 'social' -> 'auto' -> 'networks') = 'array'
       and (p_settings -> 'social' -> 'auto' -> 'networks') ? u.n
     order by u.i), '{}')
$$;

-- ---------------------------------------------------------------------------------------------
-- Only the server changes settings.social
-- ---------------------------------------------------------------------------------------------

-- On while social_set_auto writes, for the rest of that statement's transaction.
create function private.social_setting() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('crewtavo.social', true), '') = 'on'
$$;

-- Someone signed in saving settings keeps settings.social as it was, as marketing_settings_guard
-- does: a page saving the company's other settings from an older copy can't turn automatic posts
-- back on, or off without cancelling the ones scheduled.
create function private.social_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.social_setting() or (select auth.uid()) is null
     or new.settings -> 'social' is not distinct from old.settings -> 'social' then
    return new;
  end if;
  new.settings := case when old.settings -> 'social' is null then coalesce(new.settings, '{}') - 'social'
    else jsonb_set(coalesce(new.settings, '{}'), '{social}', old.settings -> 'social') end;
  return new;
end $$;
create trigger social_settings_guard before update of settings on public.companies
  for each row execute function private.social_settings_guard();

-- Post 5-star reviews automatically, on or off, and where. Turning it on needs one of the networks
-- ready; turning it off cancels the automatic posts still scheduled. Writes settings.social alone.
-- Says {enabled, networks, cancelled}.
create function public.social_set_auto(p_company uuid, p_enabled boolean, p_networks text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_networks text[];
  v_cancelled integer := 0;
begin
  v_networks := array(select u.n from unnest(array['facebook', 'instagram', 'google']) with ordinality as u(n, i)
                       where u.n = any (coalesce(p_networks, '{}')) order by u.i);
  if p_enabled then
    if cardinality(v_networks) = 0 then
      raise exception 'Pick where automatic posts go.' using errcode = '22023';
    end if;
    if not exists (select 1 from unnest(v_networks) n where private.social_network_ready(p_company, n)) then
      raise exception 'Connect Facebook & Instagram or Google Business Profile first.' using errcode = '22023';
    end if;
  end if;
  perform set_config('crewtavo.social', 'on', true);
  update public.companies
     set settings = jsonb_set(coalesce(settings, '{}'), '{social}',
       (case when jsonb_typeof(settings -> 'social') = 'object' then settings -> 'social' else '{}'::jsonb end)
         || jsonb_build_object('auto', jsonb_build_object('enabled', p_enabled, 'networks', to_jsonb(v_networks))))
   where id = p_company;
  perform set_config('crewtavo.social', '', true);
  if not p_enabled then
    update public.social_posts set status = 'cancelled', cancelled_at = now(), note = 'Automatic posts were turned off'
     where company_id = p_company and automatic and status = 'scheduled';
    get diagnostics v_cancelled = row_count;
  end if;
  return jsonb_build_object('enabled', p_enabled, 'networks', to_jsonb(v_networks), 'cancelled', v_cancelled);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Scheduling them
-- ---------------------------------------------------------------------------------------------

-- What an automatic post's words are until a person changes them: packages/core/src/social.ts
-- DEFAULT_REVIEW_CAPTION, which a test compares with this.
create function private.default_review_caption() returns text
language sql immutable set search_path = '' as $$
  select 'Another 5-star review from a happy client. Thank you!'::text
$$;

-- The next time an automatic post can go, as packages/core/src/social.ts nextAutoSlot picks it: 10:00,
-- 13:00 or 16:00 in the company's time zone, at most 3 automatic posts a day (cancelled ones don't
-- count), from today when it's before 08:00 there and otherwise tomorrow, up to 60 days out. Null
-- when none is free.
create function private.next_auto_post_slot(p_company uuid, p_tz text) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_local timestamp := now() at time zone p_tz;
  v_first date := case when v_local::time < time '08:00' then v_local::date else v_local::date + 1 end;
  v_day date;
  v_slot time;
  v_at timestamptz;
begin
  for d in 0..60 loop
    v_day := v_first + d;
    if (select count(*) from public.social_posts p
         where p.company_id = p_company and p.automatic and p.status <> 'cancelled' and p.scheduled_for is not null
           and (p.scheduled_for at time zone p_tz)::date = v_day) >= 3 then
      continue;
    end if;
    foreach v_slot in array array[time '10:00', time '13:00', time '16:00'] loop
      v_at := (v_day + v_slot) at time zone p_tz;
      if not exists (select 1 from public.social_posts p
                      where p.company_id = p_company and p.automatic and p.status <> 'cancelled' and p.scheduled_for = v_at) then
        return v_at;
      end if;
    end loop;
  end loop;
  return null;
end $$;

-- "today at 10 AM", "tomorrow at 1 PM", "Tue at 4 PM", as packages/core/src/social.ts autoPostWhen says it.
create function private.auto_post_when(p_at timestamptz, p_tz text) returns text
language sql stable set search_path = '' as $$
  select case (p_at at time zone p_tz)::date - (now() at time zone p_tz)::date
           when 0 then 'today' when 1 then 'tomorrow' else to_char(p_at at time zone p_tz, 'Dy') end
         || ' at ' || to_char(p_at at time zone p_tz, 'FMHH12') || case when to_char(p_at at time zone p_tz, 'MI') = '00' then '' else ':' || to_char(p_at at time zone p_tz, 'MI') end
         || ' ' || to_char(p_at at time zone p_tz, 'AM')
$$;

-- A 5-star review just brought in as news, with words: an automatic post is scheduled when they're
-- on and one of their networks is ready, unless this review has been posted (or scheduled) already,
-- and the office with the marketing area hears when it goes. The review's words are checked against
-- the client it's matched to when it posts (apps/api/src/services/social.ts), since matching comes
-- after this. Nothing here can stop the review being saved: a problem is a warning.
create function private.auto_review_post() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  co public.companies;
  v_networks text[];
  v_key text := new.location_id || '/' || new.review_id;
  v_tz text;
  v_at timestamptz;
  v_id uuid;
begin
  begin
    if coalesce(new.comment, '') !~ '[A-Za-z0-9À-ɏ]' then return null; end if;
    select * into co from public.companies where id = new.company_id;
    if not found or not (co.settings -> 'marketing' ->> 'enabled' = 'true') then return null; end if;
    v_networks := array(select n from unnest(private.social_settings_auto(co.settings)) n where private.social_network_ready(co.id, n));
    if cardinality(v_networks) = 0 then return null; end if;
    perform pg_advisory_xact_lock(hashtextextended('social_auto:' || co.id::text, 0));
    if exists (select 1 from public.social_posts p
                where p.company_id = co.id and p.review_key = v_key
                  and (p.automatic or p.status in ('scheduled', 'posting', 'posted', 'partly_posted', 'check'))) then
      return null;
    end if;
    v_tz := coalesce(nullif(co.timezone, ''), 'UTC');
    v_at := private.next_auto_post_slot(co.id, v_tz);
    if v_at is null then return null; end if;
    insert into public.social_posts (company_id, source, review_id, review_key, caption, caption_by, networks, status, scheduled_for, automatic)
    values (co.id, 'review', new.id, v_key, private.default_review_caption(), 'default', v_networks, 'scheduled', v_at, true)
    on conflict (company_id, review_key) where automatic do nothing
    returning id into v_id;
    if v_id is null then return null; end if;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select co.id, o, 'social_scheduled', 'A 5-star review posts ' || private.auto_post_when(v_at, v_tz),
           'It goes to ' || private.network_words(v_networks) || '. Change or cancel it before then.', '/marketing?tab=social&post=' || v_id
      from private.marketing_office(co.id) o;
  exception when others then
    raise warning 'A 5-star review wasn''t scheduled to post: %', sqlerrm;
  end;
  return null;
end $$;
create trigger auto_review_post after insert on public.reviews
  for each row when (new.notify = 'new' and new.rating = 5) execute function private.auto_review_post();

-- ---------------------------------------------------------------------------------------------
-- Facebook & Instagram needing someone
-- ---------------------------------------------------------------------------------------------

-- A change in whether Facebook & Instagram can post, told to owners and admins who connect apps
-- once each time: 'signin' (the Page's sign-in stopped working), 'expiring' (Meta asks for a new
-- sign-in soon), or 'ok' when it's fine again, so the next problem tells them again. Not while
-- Marketing is uninstalled, and then not recorded as told either. True when a notification went.
create function public.note_meta_access(p_company uuid, p_kind text, p_title text default null, p_body text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind is null or p_kind not in ('signin', 'expiring', 'ok') then
    raise exception 'Access is signin, expiring or ok' using errcode = '22023';
  end if;
  if p_kind = 'ok' then
    update public.integrations set settings = settings - 'access_notice'
     where company_id = p_company and provider = 'meta' and settings ? 'access_notice';
    return false;
  end if;
  if not private.marketing_is_on(p_company) then return false; end if;
  update public.integrations set settings = jsonb_set(coalesce(settings, '{}'), '{access_notice}', to_jsonb(p_kind))
   where company_id = p_company and provider = 'meta' and settings ->> 'access_notice' is distinct from p_kind;
  if not found or p_title is null then return false; end if;
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select p_company, a, 'social_failed', left(p_title, 300), p_body, '/apps/meta' from private.apps_admins(p_company) a;
  return true;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Uninstalling Marketing
-- ---------------------------------------------------------------------------------------------

-- As in 20261031000200_automated_campaigns.sql. Uninstalling also puts scheduled social posts back
-- to drafts, and a post partway through stops before its next network: the ones still to go are
-- skipped, and it finishes once nothing is sending (a send that's out is still recorded).
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
    update public.social_posts set status = 'draft', scheduled_for = null, note = 'Marketing was uninstalled'
     where company_id = p_company and status = 'scheduled';
    update public.social_post_networks n
       set status = 'skipped', error_kind = 'marketing_off', error = 'Marketing was uninstalled', next_attempt_at = null
      from public.social_posts p
     where p.id = n.post_id and p.company_id = p_company and p.status = 'posting' and n.status in ('waiting', 'retry');
    perform private.finish_social_post(p.id) from public.social_posts p
     where p.company_id = p_company and p.status = 'posting'
       and not exists (select 1 from public.social_post_networks n where n.post_id = p.id and n.status = 'sending');
  end if;
  perform set_config('crewtavo.marketing', '', true);
  return p_enabled;
end $$;

revoke all on function private.meta_ready(uuid, text), private.google_ready(uuid), private.social_network_ready(uuid, text),
  private.social_settings_auto(jsonb), private.social_setting(), private.social_settings_guard(), private.default_review_caption(),
  private.next_auto_post_slot(uuid, text), private.auto_post_when(timestamptz, text), private.auto_review_post() from public;
grant execute on function private.meta_ready(uuid, text), private.google_ready(uuid), private.social_network_ready(uuid, text) to service_role;
revoke execute on function public.social_set_auto(uuid, boolean, text[]), public.note_meta_access(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.social_set_auto(uuid, boolean, text[]), public.note_meta_access(uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';
