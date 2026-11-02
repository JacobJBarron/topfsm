-- Social posts (docs/marketing-plan.md, phase E): Marketing → Social posts photos OK to share, a 4 or
-- 5-star Google review as a picture, or words alone, to the business's own Facebook Page, Instagram
-- account and Google Business Profile, now or at a time it picks (apps/api/src/services/social.ts).
--
--   social_posts          what to post, where, when, and how it went. Office staff with the marketing
--                         area read them; only the server writes them, through the functions below.
--   social_post_networks  one row for each place a post goes, moved through waiting → sending →
--                         posted (or retry, failed, unknown, skipped). Each is posted at most once: a
--                         send that may have gone ("unknown") is never repeated without a person.
--   social_post_images    the post's pictures as Meta and Google fetch them, by a random token at
--                         /api/public/social/<token>.jpg, until 7 days after the post finishes.
--                         The server's alone.
--
-- One worker posts a post at a time (claim_social_posts, renewed as it goes). A worker that stopped
-- partway through a send leaves that network "unknown" when its claim runs out, so it's checked by a
-- person instead of posted twice.

-- ---------------------------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------------------------

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  -- photos: 1 to 10 photos OK to share; review: a review's card; text: words alone (not Instagram).
  source text not null check (source in ('photos', 'review', 'text')),
  review_id uuid,
  -- location_id/review_id: names the review across a remove and re-import, and outlives its row.
  review_key text check (length(review_key) <= 600),
  -- Not a foreign key: a photo deleted since is left out when it posts.
  attachment_ids uuid[] not null default '{}',
  caption text not null default '' check (length(caption) <= 2200),
  -- Who wrote the caption: a person, Claude (and a person kept it), or the automatic post's own words.
  caption_by text not null default 'person' check (caption_by in ('person', 'ai', 'default')),
  networks text[] not null check (cardinality(networks) between 1 and 3 and networks <@ '{facebook,instagram,google}'),
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'posting', 'posted', 'partly_posted', 'check', 'failed', 'cancelled')),
  scheduled_for timestamptz,
  automatic boolean not null default false,
  -- Why it's where it is, when that isn't plain ("Marketing was uninstalled").
  note text check (length(note) <= 500),
  claim uuid,
  locked_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id) on delete set null,
  -- Null for an automatic post.
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, review_id) references public.reviews (company_id, id) on delete set null (review_id),
  check (case source when 'photos' then cardinality(attachment_ids) between 1 and 10 else cardinality(attachment_ids) = 0 end),
  check ((source = 'review') = (review_key is not null)),
  check (source <> 'text' or not ('instagram' = any (networks))),
  check (status <> 'scheduled' or scheduled_for is not null)
);
comment on table public.social_posts is 'Posts to the business''s own Facebook Page, Instagram account and Google Business Profile';
create index social_posts_due_idx on public.social_posts (scheduled_for) where status in ('scheduled', 'posting');
create index social_posts_company_idx on public.social_posts (company_id, created_at desc, id desc);
-- A review is posted automatically at most once, a cancelled automatic post included.
create unique index social_posts_auto_review_idx on public.social_posts (company_id, review_key) where automatic;
select private.add_touch_triggers(array['social_posts']);

create table public.social_post_networks (
  post_id uuid not null,
  company_id uuid not null,
  network text not null check (network in ('facebook', 'instagram', 'google')),
  status text not null default 'waiting' check (status in ('waiting', 'sending', 'posted', 'retry', 'failed', 'unknown', 'skipped')),
  -- Sends begun (begin_social_network).
  attempts integer not null default 0,
  -- Times it waited to try again, whether anything was sent or not, and when the first was.
  tries integer not null default 0,
  first_tried_at timestamptz,
  next_attempt_at timestamptz,
  sending_at timestamptz,
  posted_at timestamptz,
  external_id text check (length(external_id) <= 300),
  permalink text check (permalink ~ '^https://' and length(permalink) <= 2000),
  -- What was made on the way that's safe to use again: Facebook's unpublished photos, Instagram's
  -- containers and when they were made.
  steps jsonb not null default '{}',
  error text check (length(error) <= 1000),
  error_kind text check (error_kind in ('signin', 'permission', 'not_linked', 'not_connected', 'limit', 'rate', 'image', 'duplicate', 'rejected', 'removed', 'marketing_off', 'cancelled', 'other')),
  primary key (post_id, network),
  foreign key (company_id, post_id) references public.social_posts (company_id, id) on delete cascade
);
comment on table public.social_post_networks is 'Each place a social post goes, and how it went there';
create index social_post_networks_company_idx on public.social_post_networks (company_id);
-- Finding a post by the id a network gave it, so a check after a timeout never takes another's.
create index social_post_networks_external_idx on public.social_post_networks (company_id, network, external_id) where external_id is not null;

create table public.social_post_images (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  post_id uuid not null,
  n smallint not null check (n between 0 and 9),
  -- feed: as it is; instagram: padded to a ratio Instagram takes.
  variant text not null check (variant in ('feed', 'instagram')),
  attachment_id uuid,
  path text not null check (length(path) <= 300),
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{32}$'),
  width integer not null,
  height integer not null,
  bytes integer not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (post_id, n, variant),
  foreign key (company_id, post_id) references public.social_posts (company_id, id) on delete cascade
);
comment on table public.social_post_images is 'A social post''s pictures at their public link, until it expires. The server''s alone.';
create index social_post_images_expires_idx on public.social_post_images (expires_at);

alter table public.social_posts enable row level security;
alter table public.social_post_networks enable row level security;
alter table public.social_post_images enable row level security;
create policy social_posts_read on public.social_posts for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
create policy social_post_networks_read on public.social_post_networks for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('social_posts', 'marketing', true);
select private.restrict_area('social_post_networks', 'marketing', true);
-- Only the server writes them.
revoke insert, update, delete on public.social_posts, public.social_post_networks from authenticated;
revoke all on public.social_post_images from authenticated, anon;

-- A post that has started posting can't be taken back to a draft or a time: what it posts was fixed then.
create function private.social_post_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('draft', 'scheduled') and exists (select 1 from public.social_post_networks n where n.post_id = new.id) then
    raise exception 'This post has started posting, so it can''t be changed.' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger social_post_guard before update on public.social_posts
  for each row when (new.status in ('draft', 'scheduled')) execute function private.social_post_guard();

-- ---------------------------------------------------------------------------------------------
-- How a post went
-- ---------------------------------------------------------------------------------------------

-- A post's status from its networks, as packages/core/src/social.ts postStatusOf says it: posting
-- while any is still to go; posted when every one posted; partly_posted when some did; check when
-- none did and one may have; cancelled when every one was called off; otherwise failed.
create function private.social_post_status(p_post uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when count(*) = 0 then null
    when bool_or(n.status in ('waiting', 'sending', 'retry')) then 'posting'
    when bool_and(n.status = 'posted') then 'posted'
    when bool_or(n.status = 'posted') then 'partly_posted'
    when bool_or(n.status = 'unknown') then 'check'
    when bool_and(n.status = 'skipped' and n.error_kind = 'cancelled') then 'cancelled'
    else 'failed'
  end
  from public.social_post_networks n where n.post_id = p_post
$$;

-- Marketing is installed for the company.
create function private.marketing_is_on(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select co.settings -> 'marketing' -> 'enabled' = 'true'::jsonb from public.companies co where co.id = p_company), false)
$$;

-- "Facebook and Instagram", "Google".
create function private.network_words(p_networks text[]) returns text
language sql immutable set search_path = '' as $$
  select case cardinality(n)
    when 0 then ''
    when 1 then n[1]
    else array_to_string(n[1:cardinality(n) - 1], ', ') || ' and ' || n[cardinality(n)] end
  from (select array(select initcap(x) from unnest(p_networks) x order by array_position(array['facebook', 'instagram', 'google'], x)) as n) y
$$;

-- A post with nothing left to send finishes: its status from its networks, the claim let go, and
-- its pictures' links expiring 7 days from now. A post that didn't all go tells whoever made it
-- (the office with the marketing area, for an automatic one), while Marketing is on.
create function private.finish_social_post(p_post uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  p public.social_posts;
  v_status text := private.social_post_status(p_post);
  v_posted text[];
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
    select array_agg(network) filter (where status = 'posted'), array_agg(network) filter (where status <> 'posted')
      into v_posted, v_not from public.social_post_networks where post_id = p_post;
    v_title := case v_status
      when 'partly_posted' then 'A post went to ' || private.network_words(v_posted) || ' but not ' || private.network_words(v_not)
      when 'check' then 'A post may have gone to ' || private.network_words(v_not) || '. Check the Page.'
      else 'A post didn''t go to ' || private.network_words(v_not) end;
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select p.company_id, u.user_id, 'social_failed', left(v_title, 300), nullif(left(btrim(p.caption), 200), ''), '/marketing?tab=social&post=' || p.id
      from (select p.created_by where p.created_by is not null and not p.automatic
            union select o from private.marketing_office(p.company_id) o where p.automatic or p.created_by is null) as u(user_id);
  end if;
  return v_status;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------------------------

-- Posts for a worker to post, one claim each (p_hold_seconds, renewed as it goes): those whose time
-- has come, and those partway through whose claim ran out with a network due to try again, while
-- Marketing is installed. `p_post` is Post now: that post only. Each one's networks are made the
-- first time. Before that, a post whose claim ran out with a network still sending (the worker
-- stopped after it may have sent) has that network marked unknown, for a person to check, and
-- finishes if nothing else is left: never posted twice, never stuck.
create function public.claim_social_posts(p_limit integer default 1, p_hold_seconds integer default 300, p_post uuid default null)
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
       set status = 'unknown', error = 'Crewtavo stopped partway. It may have posted, check the Page.', error_kind = null
     where post_id = r.id and status = 'sending';
    update public.social_posts set claim = null, locked_until = null where id = r.id;
    perform private.finish_social_post(r.id);
  end loop;

  for r in
    select p.id, p.company_id from public.social_posts p
      join public.companies co on co.id = p.company_id
     where co.settings -> 'marketing' -> 'enabled' = 'true'::jsonb
       and (p_post is null or p.id = p_post)
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

-- Holds the claim a while longer, for a worker still working on the post: false once it isn't theirs.
create function private.hold_social_post(p_post uuid, p_claim uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.social_posts set locked_until = greatest(locked_until, now() + interval '5 minutes')
   where id = p_post and claim = p_claim and status = 'posting';
  return found;
end $$;

-- What a network made on the way that's safe to use again (Facebook's unpublished photos, Instagram's
-- containers), kept for its next try, with the claim held a while longer. False once the claim isn't
-- the worker's.
create function public.save_social_steps(p_post uuid, p_claim uuid, p_network text, p_steps jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not private.hold_social_post(p_post, p_claim) then return false; end if;
  update public.social_post_networks set steps = coalesce(p_steps, '{}') where post_id = p_post and network = p_network;
  return found;
end $$;

-- Just before the call that can't be taken back (Facebook's post, Instagram's publish, Google's
-- create): the network is sending, so a worker that stops now leaves it for a person to check. Only
-- from waiting or retry, while the post is the worker's and Marketing is installed.
create function public.begin_social_network(p_post uuid, p_claim uuid, p_network text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare p public.social_posts;
begin
  select * into p from public.social_posts where id = p_post for update;
  if not found or p.claim is distinct from p_claim or p.status <> 'posting' or not private.marketing_is_on(p.company_id) then
    return false;
  end if;
  update public.social_post_networks
     set status = 'sending', attempts = attempts + 1, sending_at = now(), error = null, error_kind = null
   where post_id = p_post and network = p_network and status in ('waiting', 'retry');
  if not found then return false; end if;
  perform private.hold_social_post(p_post, p_claim);
  return true;
end $$;

-- How a network went: posted (with its id and link), retry (at p_retry_at), failed, unknown (it may
-- have gone) or skipped. A success is recorded even when the claim has moved on (a recorded post
-- always wins over "may have posted"); anything else only by the worker holding the claim. A post
-- with nothing left to send finishes. Says the post's status, or null when nothing changed.
create function public.end_social_network(p_post uuid, p_claim uuid, p_network text, p_status text, p_external_id text default null,
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

-- The worker lets the post go while its networks wait to try again (the claim picks it up then).
create function public.release_social_post(p_post uuid, p_claim uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.social_posts set claim = null, locked_until = null where id = p_post and claim = p_claim;
  return found;
end $$;

-- ---------------------------------------------------------------------------------------------
-- The office's changes, made by the server once it has checked who's asking
-- ---------------------------------------------------------------------------------------------

-- Cancel post: a scheduled one is cancelled; one partway through has the networks still to go
-- skipped, and finishes once nothing is sending. Says the post's status, or null when it's neither.
create function public.cancel_social_post(p_company uuid, p_post uuid, p_by uuid) returns text
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
  update public.social_posts set cancelled_by = p_by, updated_by = p_by where id = p_post;
  if exists (select 1 from public.social_post_networks x where x.post_id = p_post and x.status = 'sending') then return 'posting'; end if;
  return private.finish_social_post(p_post);
end $$;

-- Post again: the networks that failed or were skipped go again, as soon as a worker can, while
-- Marketing is installed. One that may have posted waits for a person (resolve_social_network). The
-- post stays what it was, so it posts the same words and pictures everywhere. Says how many.
create function public.retry_social_post(p_company uuid, p_post uuid, p_by uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  p public.social_posts;
  v_count integer;
begin
  select * into p from public.social_posts where company_id = p_company and id = p_post for update;
  if not found or p.status not in ('failed', 'partly_posted', 'check') or not private.marketing_is_on(p_company) then return 0; end if;
  update public.social_post_networks
     set status = 'waiting', next_attempt_at = now(), tries = 0, first_tried_at = null, error = null, error_kind = null
   where post_id = p_post and status in ('failed', 'skipped');
  get diagnostics v_count = row_count;
  if v_count > 0 then
    update public.social_posts set status = 'posting', finished_at = null, claim = null, locked_until = null, note = null, updated_by = p_by where id = p_post;
  end if;
  return v_count;
end $$;

-- A network that may have posted, settled by a person: it's on the Page (posted, with its link if
-- they have one), or it isn't, so it goes again. Says the post's status, or null when the network
-- wasn't waiting on that.
create function public.resolve_social_network(p_company uuid, p_post uuid, p_network text, p_posted boolean, p_permalink text, p_by uuid) returns text
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
  update public.social_posts set status = 'posting', finished_at = null, updated_by = p_by,
         claim = case when status = 'posting' then claim end, locked_until = case when status = 'posting' then locked_until end
   where id = p_post;
  return 'posting';
end $$;

revoke all on function private.social_post_guard(), private.social_post_status(uuid), private.marketing_is_on(uuid), private.network_words(text[]),
  private.finish_social_post(uuid), private.hold_social_post(uuid, uuid) from public;
revoke execute on function public.claim_social_posts(integer, integer, uuid), public.save_social_steps(uuid, uuid, text, jsonb),
  public.begin_social_network(uuid, uuid, text), public.end_social_network(uuid, uuid, text, text, text, text, text, text, timestamptz, jsonb),
  public.release_social_post(uuid, uuid), public.cancel_social_post(uuid, uuid, uuid), public.retry_social_post(uuid, uuid, uuid),
  public.resolve_social_network(uuid, uuid, text, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_social_posts(integer, integer, uuid), public.save_social_steps(uuid, uuid, text, jsonb),
  public.begin_social_network(uuid, uuid, text), public.end_social_network(uuid, uuid, text, text, text, text, text, text, timestamptz, jsonb),
  public.release_social_post(uuid, uuid), public.cancel_social_post(uuid, uuid, uuid), public.retry_social_post(uuid, uuid, uuid),
  public.resolve_social_network(uuid, uuid, text, boolean, text, uuid) to service_role;

select private.fold_member_checks();

notify pgrst, 'reload schema';
