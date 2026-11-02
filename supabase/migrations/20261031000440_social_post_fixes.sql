-- Social posts, made safer (docs/marketing-plan.md, phase E):
--
--   social_posts.stop_kind  a post someone cancelled, or one Marketing was uninstalled under, while
--                           a network was sending. That send is still recorded when it ends, but one
--                           that ends "try again" is skipped instead, nothing new is made or begun and
--                           the claim never picks the post up again. Post again, and "It isn't there, post it",
--                           lift it: a person asked for those.
--   Post again              starts the networks it puts back from nothing (no unpublished photos or
--                           Instagram containers kept from a try that failed).
--   Who hears               a post that didn't all go tells whoever made it only while they're still
--                           in the office with the marketing area, and otherwise the office, as an
--                           automatic post does. The title tells apart what posted, what didn't and
--                           what may have, and says where to look for each network.

alter table public.social_posts
  add column stop_kind text check (stop_kind in ('cancelled', 'marketing_off'));
comment on column public.social_posts.stop_kind is 'Cancelled, or Marketing uninstalled, partway through: nothing more is sent';

-- "Check your Page.", "Check your Instagram account.", "Check your Business Profile.": where to look
-- for a post that may have gone.
create function private.social_check_words(p_networks text[]) returns text
language sql immutable set search_path = '' as $$
  select case when cardinality(p_networks) = 1 then
    case p_networks[1] when 'facebook' then 'Check your Page.' when 'instagram' then 'Check your Instagram account.' else 'Check your Business Profile.' end
  else 'Check them.' end
$$;

-- As in 20261031000410_social_posts.sql, with who hears it and its title as above.
create or replace function private.finish_social_post(p_post uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p public.social_posts;
  v_status text := private.social_post_status(p_post);
  v_posted text[];
  v_unknown text[];
  v_not text[];
  v_title text;
begin
  if v_status is null or v_status = 'posting' then return v_status; end if;
  update public.social_posts
     set status = v_status, finished_at = now(), claim = null, locked_until = null,
         cancelled_at = case when v_status = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end
   where id = p_post
  returning * into p;
  update public.social_post_images set expires_at = least(expires_at, now() + interval '7 days') where post_id = p_post;
  if v_status in ('failed', 'partly_posted', 'check') and private.marketing_is_on(p.company_id) then
    select array_agg(network) filter (where status = 'posted'), array_agg(network) filter (where status = 'unknown'),
           array_agg(network) filter (where status not in ('posted', 'unknown'))
      into v_posted, v_unknown, v_not from public.social_post_networks where post_id = p_post;
    v_title := case v_status
      when 'partly_posted' then 'A post went to ' || private.network_words(v_posted)
        || case when v_not is not null then ' but not ' || private.network_words(v_not) else '' end
        || case when v_unknown is not null then ' and may have gone to ' || private.network_words(v_unknown) || '. ' || private.social_check_words(v_unknown) else '' end
      when 'check' then case when v_not is not null then 'A post didn''t go to ' || private.network_words(v_not) || ' and may have gone to ' else 'A post may have gone to ' end
        || private.network_words(v_unknown) || '. ' || private.social_check_words(v_unknown)
      else 'A post didn''t go to ' || private.network_words(v_not) end;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select p.company_id, u.user_id, 'social_failed', left(v_title, 300), nullif(left(btrim(p.caption), 200), ''), '/marketing?tab=social&post=' || p.id
      from (select o from private.marketing_office(p.company_id) o
             where not p.automatic and o = p.created_by
            union
            -- Nobody made it, or whoever did has left the office or lost the marketing area.
            select o from private.marketing_office(p.company_id) o
             where p.automatic or p.created_by is null
                or not exists (select 1 from private.marketing_office(p.company_id) m where m = p.created_by)) as u(user_id);
  end if;
  return v_status;
end $$;

-- As in 20261031000410_social_posts.sql: a post that was stopped is never claimed to post again.
create or replace function public.claim_social_posts(p_limit integer default 1, p_hold_seconds integer default 300, p_post uuid default null)
returns table (id uuid, company_id uuid, claim uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  r record;
  v_claim uuid;
begin
  for r in
    select p.id from public.social_posts p
     where p.status = 'posting' and coalesce(p.locked_until, '-infinity') < now()
       and (p_post is null or p.id = p_post)
       and exists (select 1 from public.social_post_networks n where n.post_id = p.id and n.status = 'sending')
     for update of p skip locked
  loop
    update public.social_post_networks
       set status = 'unknown', error = 'Crewtavo stopped partway, so it may have posted.', error_kind = null
     where post_id = r.id and status = 'sending';
    update public.social_posts set claim = null, locked_until = null where id = r.id;
    perform private.finish_social_post(r.id);
  end loop;

  for r in
    select p.id, p.company_id from public.social_posts p
      join public.companies co on co.id = p.company_id
     where co.settings -> 'marketing' -> 'enabled' = 'true'::jsonb
       and (p_post is null or p.id = p_post)
       and p.stop_kind is null
       and ((p.status = 'scheduled' and p.scheduled_for <= now())
         or (p.status = 'posting' and coalesce(p.locked_until, '-infinity') < now()
             and exists (select 1 from public.social_post_networks n where n.post_id = p.id and n.status in ('waiting', 'retry')
                           and coalesce(n.next_attempt_at, '-infinity') <= now())))
     order by coalesce(p.scheduled_for, p.created_at), p.id
     limit least(greatest(coalesce(p_limit, 1), 1), 25)
     for update of p skip locked
  loop
    v_claim := gen_random_uuid();
    update public.social_posts
       set status = 'posting', started_at = coalesce(started_at, now()), claim = v_claim,
           locked_until = now() + make_interval(secs => greatest(coalesce(p_hold_seconds, 300), 30))
     where id = r.id;
    insert into public.social_post_networks (post_id, company_id, network)
    select r.id, r.company_id, x from public.social_posts p, unnest(p.networks) x where p.id = r.id
    on conflict do nothing;
    id := r.id;
    company_id := r.company_id;
    claim := v_claim;
    return next;
  end loop;
end $$;

-- As in 20261031000410_social_posts.sql, and false once the post was stopped or the network isn't
-- still to go, so nothing more is made for it.
create or replace function public.save_social_steps(p_post uuid, p_claim uuid, p_network text, p_steps jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.social_posts where id = p_post and stop_kind is not null) then return false; end if;
  if not private.hold_social_post(p_post, p_claim) then return false; end if;
  update public.social_post_networks set steps = coalesce(p_steps, '{}')
   where post_id = p_post and network = p_network and status in ('waiting', 'retry');
  return found;
end $$;

-- As in 20261031000410_social_posts.sql: nothing begins once the post was stopped.
create or replace function public.begin_social_network(p_post uuid, p_claim uuid, p_network text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare p public.social_posts;
begin
  select * into p from public.social_posts where id = p_post for update;
  if not found or p.claim is distinct from p_claim or p.status <> 'posting' or p.stop_kind is not null or not private.marketing_is_on(p.company_id) then
    return false;
  end if;
  update public.social_post_networks
     set status = 'sending', attempts = attempts + 1, sending_at = now(), error = null, error_kind = null
   where post_id = p_post and network = p_network and status in ('waiting', 'retry');
  if not found then return false; end if;
  perform private.hold_social_post(p_post, p_claim);
  return true;
end $$;

-- As in 20261031000410_social_posts.sql. On a post that was stopped, a network that would try again
-- is skipped instead, saying why: the send that was out is recorded, and nothing goes later.
create or replace function public.end_social_network(p_post uuid, p_claim uuid, p_network text, p_status text, p_external_id text default null,
  p_permalink text default null, p_error text default null, p_kind text default null, p_retry_at timestamptz default null, p_steps jsonb default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  p public.social_posts;
  n public.social_post_networks;
begin
  if p_status not in ('posted', 'retry', 'failed', 'unknown', 'skipped') then
    raise exception 'A network ends posted, retry, failed, unknown or skipped' using errcode = '22023';
  end if;
  select * into p from public.social_posts where id = p_post for update;
  if not found then return null; end if;
  select * into n from public.social_post_networks where post_id = p_post and network = p_network for update;
  if not found then return null; end if;
  if p_status = 'posted' and p_external_id is not null and n.status in ('sending', 'unknown') then
    null;
  elsif p.claim is distinct from p_claim then
    return null;
  elsif p_status = 'unknown' and n.status <> 'sending' then
    return null;
  elsif p_status = 'posted' and n.status <> 'sending' then
    return null;
  elsif p_status in ('retry', 'failed', 'skipped') and n.status not in ('waiting', 'retry', 'sending') then
    return null;
  end if;
  if p_status = 'retry' and p.stop_kind is not null then
    p_status := 'skipped';
    p_kind := p.stop_kind;
    p_error := case p.stop_kind when 'cancelled' then 'Cancelled' else 'Marketing was uninstalled' end;
  end if;
  update public.social_post_networks
     set status = p_status,
         external_id = case when p_status = 'posted' then left(p_external_id, 300) else external_id end,
         permalink = case when p_status = 'posted' and p_permalink ~ '^https://' then left(p_permalink, 2000) when p_status = 'posted' then null else permalink end,
         posted_at = case when p_status = 'posted' then now() else posted_at end,
         error = case when p_status = 'posted' then null else left(p_error, 1000) end,
         error_kind = case when p_status in ('posted', 'unknown') then null else p_kind end,
         next_attempt_at = case when p_status = 'retry' then coalesce(p_retry_at, now() + interval '2 minutes') end,
         tries = case when p_status = 'retry' then tries + 1 else tries end,
         first_tried_at = case when p_status = 'retry' then coalesce(first_tried_at, now()) else first_tried_at end,
         steps = coalesce(p_steps, steps)
   where post_id = p_post and network = p_network;
  if exists (select 1 from public.social_post_networks x where x.post_id = p_post and x.status in ('waiting', 'sending', 'retry')) then
    if p.claim = p_claim then perform private.hold_social_post(p_post, p_claim); end if;
    return 'posting';
  end if;
  return private.finish_social_post(p_post);
end $$;

-- As in 20261031000410_social_posts.sql, and a post partway through is marked stopped, so a send
-- that's out and comes back "try again" isn't tried again.
create or replace function public.cancel_social_post(p_company uuid, p_post uuid, p_by uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare p public.social_posts;
begin
  select * into p from public.social_posts where company_id = p_company and id = p_post for update;
  if not found then return null; end if;
  if p.status = 'scheduled' then
    update public.social_posts set status = 'cancelled', cancelled_at = now(), cancelled_by = p_by, updated_by = p_by where id = p_post;
    return 'cancelled';
  end if;
  if p.status <> 'posting' then return null; end if;
  update public.social_post_networks set status = 'skipped', error = 'Cancelled', error_kind = 'cancelled', next_attempt_at = null
   where post_id = p_post and status in ('waiting', 'retry');
  update public.social_posts set stop_kind = 'cancelled', cancelled_by = p_by, updated_by = p_by where id = p_post;
  if exists (select 1 from public.social_post_networks x where x.post_id = p_post and x.status = 'sending') then return 'posting'; end if;
  return private.finish_social_post(p_post);
end $$;

-- As in 20261031000410_social_posts.sql. A person asked for it, so a stop is lifted, and each network
-- put back starts from nothing: a container Instagram turned down, or photos made from pictures taken
-- out since, aren't used again.
create or replace function public.retry_social_post(p_company uuid, p_post uuid, p_by uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  p public.social_posts;
  v_count integer;
begin
  select * into p from public.social_posts where company_id = p_company and id = p_post for update;
  if not found or p.status not in ('failed', 'partly_posted', 'check') or not private.marketing_is_on(p_company) then return 0; end if;
  update public.social_post_networks
     set status = 'waiting', next_attempt_at = now(), tries = 0, first_tried_at = null, error = null, error_kind = null, steps = '{}'
   where post_id = p_post and status in ('failed', 'skipped');
  get diagnostics v_count = row_count;
  if v_count > 0 then
    update public.social_posts set status = 'posting', finished_at = null, claim = null, locked_until = null, note = null, stop_kind = null, updated_by = p_by where id = p_post;
  end if;
  return v_count;
end $$;

-- As in 20261031000410_social_posts.sql, and "It isn't there, post it" lifts a stop: a person asked.
-- Its steps are kept, so Instagram can still say its container went up after all.
create or replace function public.resolve_social_network(p_company uuid, p_post uuid, p_network text, p_posted boolean, p_permalink text, p_by uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare p public.social_posts;
begin
  select * into p from public.social_posts where company_id = p_company and id = p_post for update;
  if not found then return null; end if;
  if p_posted then
    update public.social_post_networks
       set status = 'posted', posted_at = coalesce(sending_at, now()), error = null, error_kind = null,
           permalink = case when p_permalink ~ '^https://' then left(p_permalink, 2000) end
     where post_id = p_post and network = p_network and status = 'unknown';
    if not found then return null; end if;
    update public.social_posts set updated_by = p_by where id = p_post;
    if p.status = 'posting' then return 'posting'; end if;
    return private.finish_social_post(p_post);
  end if;
  if not private.marketing_is_on(p_company) then return null; end if;
  update public.social_post_networks
     set status = 'waiting', next_attempt_at = now(), error = null, error_kind = null, tries = 0, first_tried_at = null
   where post_id = p_post and network = p_network and status = 'unknown';
  if not found then return null; end if;
  update public.social_posts set status = 'posting', finished_at = null, updated_by = p_by, stop_kind = null,
         claim = case when status = 'posting' then claim end, locked_until = case when status = 'posting' then locked_until end
   where id = p_post;
  return 'posting';
end $$;

-- As in 20261031000420_automatic_review_posts.sql, and a post partway through is marked stopped, so
-- a send that's out and comes back "try again" is skipped, and installing again posts nothing by itself.
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
    update public.social_posts set stop_kind = coalesce(stop_kind, 'marketing_off')
     where company_id = p_company and status = 'posting';
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

revoke all on function private.social_check_words(text[]) from public;

notify pgrst, 'reload schema';
