-- Google reviews in Crewtavo (docs/marketing-plan.md, phase D): the Google Business Profile app
-- brings one location's reviews in (apps/api/src/services/googleReviews.ts), each matched to a
-- client by name when only one fits, and a matched review stops that client's review asks, the way
-- Jobber turns them off for a client who already left a Google review.
--
--   clients.name_key, name_short   the client's name as matching compares it (private.name_key,
--                                  mirrored by packages/core/src/reviews.ts nameKey), and the
--                                  "ana s" form Google shortens reviewers' names to.
--   clients.reviewed_at            when their earliest matched review was posted. Set only here
--                                  (client_reviewed_guard). It stops their reminders at once
--                                  ('Left a Google review') and every ask, by hand or automatic.
--   review_requests.reviewed_at    the ask led to a review: Marketing → Reviews counts these.
--   reviews                        the location's reviews, each once (Google's location and review
--                                  ids), with the reply, the matched client and the ask it answers.
--                                  Office staff with the marketing area read them; only the server
--                                  writes them, through the functions below.
--   review_syncs                   each company's sync: one worker at a time (claim_review_sync),
--                                  where the full pass is, what's in the way, and Google's own
--                                  average and count. The server's alone.
--
-- Deleted on Google means marked (deleted_at), not removed, and only once Google says so for that
-- review: a marked review is hidden, left out of the numbers and stops nobody's asks.

-- ---------------------------------------------------------------------------------------------
-- Names
-- ---------------------------------------------------------------------------------------------

-- A name as matching compares it: composed, folded to plain letters (upper and lower case both, so
-- the database's locale doesn't matter), apostrophes and loose accent marks dropped, anything else
-- that isn't a plain letter or digit a space, spaces run together. Null when nothing is left. The
-- same lists as packages/core/src/reviews.ts NAME_FOLDS, which a test compares with this file.
-- Execute stays open to everyone: the generated columns below call it as whoever writes a client.
create function private.name_key(p_name text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select nullif(btrim(regexp_replace(
    translate(
      replace(replace(replace(replace(replace(replace(normalize(coalesce(p_name, ''), nfc), 'ß', 'ss'), 'ẞ', 'ss'), 'æ', 'ae'), 'Æ', 'ae'), 'œ', 'oe'), 'Œ', 'oe'),
      'ÀàÁáÂâÃãÄäÅåĀāĂăĄąÇçĆćĈĉĊċČčĎďĐđÈèÉéÊêËëĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħÌìÍíÎîÏïĨĩĪīĬĭĮįıĴĵĶķĹĺĻļĽľĿŀŁłÑñŃńŅņŇňÒòÓóÔôÕõÖöØøŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšȘșŢţŤťŦŧȚțÙùÚúÛûÜüŨũŪūŬŭŮůŰűŲųŴŵÝýŸÿŶŷŹźŻżŽžİABCDEFGHIJKLMNOPQRSTUVWXYZ''’‘ʼ`̧̨̀́̂̃̄̆̇̈̊̋̌',
      'aaaaaaaaaaaaaaaaaaccccccccccddddeeeeeeeeeeeeeeeeeegggggggghhhhiiiiiiiiiiiiiiiiijjkkllllllllllnnnnnnnnoooooooooooooooooorrrrrrssssssssssttttttttuuuuuuuuuuuuuuuuuuuuwwyyyyyyzzzzzziabcdefghijklmnopqrstuvwxyz'),
    '[^abcdefghijklmnopqrstuvwxyz0123456789]+', ' ', 'g')), '')
$$;

-- A client's name as Google shortens a reviewer's: "Ana Maria Smith" → "ana s". Null for one word.
create function private.name_short(p_name text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case when cardinality(w) >= 2 then w[1] || ' ' || left(w[cardinality(w)], 1) end
  from (select string_to_array(private.name_key(p_name), ' ') as w) x
$$;
grant execute on function private.name_key(text), private.name_short(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Clients and their asks
-- ---------------------------------------------------------------------------------------------

alter table public.clients
  add column name_key text generated always as (private.name_key(display_name)) stored,
  add column name_short text generated always as (private.name_short(display_name)) stored,
  add column reviewed_at timestamptz;
comment on column public.clients.name_key is 'The name as review matching compares it (private.name_key)';
comment on column public.clients.name_short is 'The name as Google shortens a reviewer''s: first name and last initial';
comment on column public.clients.reviewed_at is 'When their earliest matched Google review was posted. Set only by the reviews table; stops review asks.';
create index clients_name_key_idx on public.clients (company_id, name_key) where name_key is not null;
create index clients_name_short_idx on public.clients (company_id, name_short) where name_short is not null;

alter table public.review_requests add column reviewed_at timestamptz;
comment on column public.review_requests.reviewed_at is 'The ask led to a Google review: when that review was posted';

-- On while the reviews table writes clients.reviewed_at, for the rest of that statement's transaction.
create function private.reviewed_setting() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('crewtavo.reviewed', true), '') = 'on'
$$;

-- Nobody signed in sets it or clears it: it follows the reviews matched to the client.
create function private.client_reviewed_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) = 'authenticated' and not private.reviewed_setting() then
    if tg_op = 'UPDATE' then
      new.reviewed_at := old.reviewed_at;
    else
      new.reviewed_at := null;
    end if;
  end if;
  return new;
end $$;
create trigger client_reviewed_guard before insert or update of reviewed_at on public.clients
  for each row execute function private.client_reviewed_guard();

-- As in 20261030000600_review_ask_followups.sql, and a client matched to a Google review has the
-- reminders still to come stopped, as reminderPlan says when it gets to them.
create or replace function private.client_stops_review_reminders() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_note text;
begin
  v_note := case
    when new.review_opt_out and not old.review_opt_out then 'They asked not to get review requests'
    when new.marketing_opt_out and not old.marketing_opt_out then 'They unsubscribed from marketing'
    when new.status = 'archived' and old.status is distinct from 'archived' then 'The client was archived'
    when new.reviewed_at is not null and old.reviewed_at is null then 'Left a Google review'
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
drop trigger client_stops_review_reminders on public.clients;
create trigger client_stops_review_reminders after update of review_opt_out, marketing_opt_out, status, sms_opt_out_at, reviewed_at on public.clients
  for each row execute function private.client_stops_review_reminders();

-- As in 20261030000600_review_ask_followups.sql, and a client who already left a Google review isn't
-- asked again, by hand or automatically. Undoing the match in Marketing → Reviews asks them again.
create or replace function public.begin_review_request(p_company uuid, p_client uuid, p_job uuid default null, p_channel text default 'email',
  p_gap_days integer default null, p_created_by uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('review_ask:' || p_client::text));
  if exists (select 1 from public.clients c where c.company_id = p_company and c.id = p_client and c.reviewed_at is not null) then
    return null;
  end if;
  if p_gap_days is not null and public.last_review_ask(p_company, p_client) > now() - make_interval(days => p_gap_days) then
    return null;
  end if;
  insert into public.review_requests (company_id, client_id, job_id, channel, created_by)
  values (p_company, p_client, p_job, p_channel, p_created_by)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------------------------

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  provider text not null default 'google' check (provider = 'google'),
  -- Google's own ids: the same location reached through another account path is the same review.
  location_id text not null check (location_id ~ '^locations/[^/]+$' and length(location_id) <= 200),
  review_id text not null check (length(review_id) between 1 and 300),
  -- accounts/…/locations/…/reviews/…, what the v4 API is called with. It can change.
  external_name text not null check (length(external_name) <= 500),
  reviewer_name text check (length(reviewer_name) <= 200),
  reviewer_photo_url text check (reviewer_photo_url ~ '^https://' and length(reviewer_photo_url) <= 2000),
  reviewer_anonymous boolean not null default false,
  -- Null when Google sends STAR_RATING_UNSPECIFIED.
  rating smallint check (rating between 1 and 5),
  comment text check (length(comment) <= 20000),
  posted_at timestamptz not null,
  google_updated_at timestamptz not null,
  reply_comment text check (length(reply_comment) <= 4096),
  reply_updated_at timestamptz,
  -- When a reply first appeared: editing it later doesn't make the review look answered late.
  first_replied_at timestamptz,
  replied_by uuid references auth.users (id) on delete set null,
  client_id uuid,
  match text not null default 'none' check (match in ('auto', 'hand', 'none')),
  matched_at timestamptz,
  matched_by uuid references auth.users (id) on delete set null,
  -- Someone said "Not this client": never matched automatically again.
  match_cleared_at timestamptz,
  review_request_id uuid,
  -- The office is to be told: 'new' (a review just in) or 'lowered' (changed down to 1 or 2 stars).
  notify text check (notify in ('new', 'lowered')),
  notified_at timestamptz,
  notified_rating smallint,
  seen_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, location_id, review_id),
  unique (company_id, id),
  check ((client_id is null) = (match = 'none')),
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete set null (client_id),
  foreign key (company_id, review_request_id) references public.review_requests (company_id, id) on delete set null (review_request_id)
);
comment on table public.reviews is 'Google reviews of the company''s location, brought in by the Google Business Profile app';
create index reviews_company_posted_idx on public.reviews (company_id, posted_at desc) where deleted_at is null;
create index reviews_client_idx on public.reviews (client_id) where client_id is not null;
create index reviews_request_idx on public.reviews (review_request_id) where review_request_id is not null;
create index reviews_notify_idx on public.reviews (company_id) where notify is not null and notified_at is null;
alter table public.reviews enable row level security;
create policy reviews_read on public.reviews for select to authenticated
  using (private.has_role(company_id, '{owner,admin,office}'));
select private.restrict_area('reviews', 'marketing', true);
-- Only the server writes reviews.
revoke insert, update, delete on public.reviews from authenticated;

-- A client deleted (the foreign key clears client_id) leaves the review unmatched.
create function private.review_unmatched() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.match := 'none';
  new.matched_at := null;
  return new;
end $$;
create trigger review_unmatched before update of client_id on public.reviews
  for each row when (new.client_id is null and old.client_id is not null) execute function private.review_unmatched();

-- A review matched, unmatched, deleted on Google or back again: the clients it was and is matched to
-- get reviewed_at from their live reviews, and the ask it answers is marked or cleared.
create function private.reviews_client_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_clients uuid[] := array_remove(array[
    case when tg_op <> 'INSERT' then old.client_id end,
    case when tg_op <> 'DELETE' then new.client_id end], null);
  v_old_request uuid := case when tg_op <> 'INSERT' then old.review_request_id end;
  v_new_request uuid := case when tg_op <> 'DELETE' and new.deleted_at is null then new.review_request_id end;
begin
  if cardinality(v_clients) > 0 then
    perform set_config('crewtavo.reviewed', 'on', true);
    update public.clients c
       set reviewed_at = x.first
      from (select cl.id,
                   (select min(r.posted_at) from public.reviews r
                     where r.company_id = cl.company_id and r.client_id = cl.id and r.deleted_at is null) as first
              from public.clients cl where cl.id = any (v_clients)) x
     where c.id = x.id and c.reviewed_at is distinct from x.first;
    perform set_config('crewtavo.reviewed', '', true);
  end if;
  if v_old_request is not null and v_old_request is distinct from v_new_request then
    update public.review_requests q set reviewed_at = null
     where q.id = v_old_request and q.reviewed_at is not null
       and not exists (select 1 from public.reviews r where r.review_request_id = v_old_request and r.deleted_at is null and r.id <> old.id);
  end if;
  if v_new_request is not null then
    update public.review_requests q set reviewed_at = new.posted_at
     where q.id = v_new_request and q.reviewed_at is distinct from new.posted_at;
  end if;
  return null;
end $$;
create trigger reviews_client_inserted after insert on public.reviews
  for each row when (new.client_id is not null or new.review_request_id is not null) execute function private.reviews_client_changed();
create trigger reviews_client_changed after update of client_id, deleted_at, review_request_id on public.reviews
  for each row when (old.client_id is distinct from new.client_id or old.deleted_at is distinct from new.deleted_at
                     or old.review_request_id is distinct from new.review_request_id)
  execute function private.reviews_client_changed();
create trigger reviews_client_deleted after delete on public.reviews
  for each row when (old.client_id is not null or old.review_request_id is not null) execute function private.reviews_client_changed();

-- ---------------------------------------------------------------------------------------------
-- Syncing
-- ---------------------------------------------------------------------------------------------

create table public.review_syncs (
  company_id uuid primary key references public.companies (id) on delete cascade,
  provider text not null default 'google' check (provider = 'google'),
  -- The location reviews come from: the single source of truth. Reviews of any other are removed.
  account text check (length(account) <= 200),
  location_id text check (location_id ~ '^locations/[^/]+$' and length(location_id) <= 200),
  claim uuid,
  locked_until timestamptz,
  next_sync_at timestamptz,
  -- The full pass, which finds replies made on Google and reviews deleted there: when it started,
  -- where it is and how many it has seen.
  full_started_at timestamptz,
  full_page_token text check (length(full_page_token) <= 2000),
  full_seen integer not null default 0,
  -- The first full pass finished: new reviews tell the office from then.
  first_synced_at timestamptz,
  full_synced_at timestamptz,
  last_synced_at timestamptz,
  problem text check (problem in ('approval', 'not_enabled', 'signin', 'pick', 'location', 'error')),
  problem_detail text check (length(problem_detail) <= 500),
  problem_since timestamptz,
  failures integer not null default 0,
  -- The last access notice sent (signin or location), so each change tells the office once.
  access_notice text check (access_notice in ('signin', 'location')),
  -- What Google says about the location, the figures customers see.
  average_rating numeric(3, 2),
  total_reviews integer,
  updated_at timestamptz not null default now()
);
comment on table public.review_syncs is 'Each company''s Google review sync: the server''s alone';
alter table public.review_syncs enable row level security;
revoke all on public.review_syncs from authenticated, anon;
select private.add_touch_triggers(array['review_syncs']);

-- The people who look after marketing: owners, admins and office staff with the area.
create function private.marketing_office(p_company uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id
  from public.memberships m
  left join public.company_roles cr on cr.id = m.role_id
  where m.company_id = p_company and m.active and m.role in ('owner', 'admin', 'office')
    and 'marketing' = any (coalesce(cr.permissions, private.level_permissions(m.role)))
$$;

-- The people who can reconnect an app: owners and admins with the apps area.
create function private.apps_admins(p_company uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.user_id
  from public.memberships m
  left join public.company_roles cr on cr.id = m.role_id
  where m.company_id = p_company and m.active and m.role in ('owner', 'admin')
    and 'apps' = any (coalesce(cr.permissions, private.level_permissions(m.role)))
$$;

-- The location reviews come from now, for someone who can read them (review_stats keeps to it).
create function private.review_location(p_company uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.location_id from public.review_syncs s
   where s.company_id = p_company and private.has_role(p_company, '{owner,admin,office}')
$$;
grant execute on function private.review_location(uuid) to authenticated, service_role;

-- The ask a review answers: the client's latest one that counts (not failed, and a copied link only
-- once opened, as last_review_ask counts them) in the 180 days before the review was posted.
create function private.review_ask(p_company uuid, p_client uuid, p_posted timestamptz) returns uuid
language sql stable security definer set search_path = '' as $$
  select r.id from public.review_requests r
   where r.company_id = p_company and r.client_id = p_client and r.status <> 'failed'
     and (r.channel <> 'link' or r.clicked_at is not null)
     and r.sent_at <= p_posted and r.sent_at > p_posted - interval '180 days'
   order by r.sent_at desc
   limit 1
$$;

-- The client a review is matched to automatically, and the ask it answers, as
-- packages/core/src/reviews.ts pickMatch picks: of the clients whose name fits (the whole name, or
-- "Ana S." against name_short) and who aren't matched to another live review, the one asked lately
-- when exactly one was; with none asked, the one whose whole name fits when exactly one does.
-- Anonymous reviewers are never matched. Nulls when no one fits that way.
create function private.review_match(p_review uuid, out client_id uuid, out request_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.reviews;
  v_key text;
  v_short boolean;
  v_asked uuid[];
  v_asks uuid[];
  v_all uuid[];
begin
  select * into v from public.reviews r where r.id = p_review;
  if not found or v.reviewer_anonymous then return; end if;
  v_key := private.name_key(v.reviewer_name);
  if v_key is null then return; end if;
  v_short := v_key ~ '^[a-z0-9]+ [a-z0-9]$';
  select coalesce(array_agg(x.id) filter (where x.ask is not null), '{}'), coalesce(array_agg(x.ask) filter (where x.ask is not null), '{}'), coalesce(array_agg(x.id), '{}')
    into v_asked, v_asks, v_all
    from (
      select c.id, private.review_ask(c.company_id, c.id, v.posted_at) as ask
        from public.clients c
       where c.company_id = v.company_id
         and case when v_short then c.name_short = v_key else c.name_key = v_key end
         and not exists (select 1 from public.reviews o
                          where o.company_id = c.company_id and o.client_id = c.id and o.id <> v.id and o.deleted_at is null)
    ) x;
  if cardinality(v_asked) = 1 then
    client_id := v_asked[1];
    request_id := v_asks[1];
  elsif cardinality(v_asked) = 0 and not v_short and cardinality(v_all) = 1 then
    client_id := v_all[1];
  end if;
end $$;

-- One worker syncs a company at a time: a claim held p_hold_seconds (renewed by record_reviews), or
-- null while another worker holds it. The row is made the first time.
create function public.claim_review_sync(p_company uuid, p_hold_seconds integer default 600) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_claim uuid := gen_random_uuid();
begin
  insert into public.review_syncs (company_id) values (p_company) on conflict (company_id) do nothing;
  update public.review_syncs
     set claim = v_claim, locked_until = now() + make_interval(secs => greatest(coalesce(p_hold_seconds, 600), 30))
   where company_id = p_company and (locked_until is null or locked_until < now());
  if not found then return null; end if;
  return v_claim;
end $$;

-- Matches a review automatically if nobody matched it, or said it's not that client, meanwhile.
create function private.auto_match_review(p_review uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare m record;
begin
  select * into m from private.review_match(p_review);
  if m.client_id is null then return; end if;
  update public.reviews
     set client_id = m.client_id, match = 'auto', matched_at = now(), review_request_id = m.request_id
   where id = p_review and match = 'none' and client_id is null and match_cleared_at is null and deleted_at is null;
end $$;

-- A page of reviews from Google, for the worker holding the company's claim on that location: each
-- one is 'new', 'changed' (stars, words, the reply or Google's update time) or 'same'. Values that
-- wouldn't fit are cleaned rather than refused, so one odd review can't stall the sync. A new review
-- tells the office once the first full pass has finished, if it was posted in the last 14 days; one
-- changed from 3 stars or more down to 1 or 2 tells it again. Unmatched reviews are matched when
-- someone now fits (a client added or renamed), unless someone said it isn't them. Each page holds
-- the claim another ten minutes.
create function public.record_reviews(p_company uuid, p_claim uuid, p_location_id text, p_reviews jsonb) returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  v_sync public.review_syncs;
  v_item jsonb;
  v_old public.reviews;
  v_id uuid;
  v_out text[] := '{}';
  v_name text;
  v_photo text;
  v_rating smallint;
  v_comment text;
  v_reply text;
  v_reply_at timestamptz;
  v_posted timestamptz;
  v_updated timestamptz;
  v_lowered boolean;
begin
  select * into v_sync from public.review_syncs where company_id = p_company for update;
  if not found or v_sync.claim is distinct from p_claim or v_sync.location_id is distinct from p_location_id then
    raise exception 'This sync was stopped: the location changed or another sync took over' using errcode = '55000';
  end if;
  update public.review_syncs set locked_until = greatest(locked_until, now() + interval '10 minutes') where company_id = p_company;

  for v_item in select value from jsonb_array_elements(coalesce(p_reviews, '[]')) loop
    v_name := left(nullif(btrim(v_item ->> 'reviewer_name'), ''), 200);
    v_photo := nullif(btrim(v_item ->> 'reviewer_photo_url'), '');
    if v_photo like '//%' then v_photo := 'https:' || v_photo; end if;
    if v_photo !~ '^https://' or length(v_photo) > 2000 then v_photo := null; end if;
    v_rating := case when (v_item ->> 'rating') ~ '^[1-5]$' then (v_item ->> 'rating')::smallint end;
    v_comment := left(nullif(v_item ->> 'comment', ''), 20000);
    v_reply := left(nullif(v_item ->> 'reply_comment', ''), 4096);
    v_reply_at := case when v_reply is not null then (v_item ->> 'reply_updated_at')::timestamptz end;
    v_posted := (v_item ->> 'posted_at')::timestamptz;
    v_updated := coalesce((v_item ->> 'google_updated_at')::timestamptz, v_posted);

    select * into v_old from public.reviews r
     where r.company_id = p_company and r.location_id = p_location_id and r.review_id = v_item ->> 'review_id'
     for update;
    if not found then
      insert into public.reviews (company_id, location_id, review_id, external_name, reviewer_name, reviewer_photo_url, reviewer_anonymous,
        rating, comment, posted_at, google_updated_at, reply_comment, reply_updated_at, first_replied_at, notify)
      values (p_company, p_location_id, v_item ->> 'review_id', left(v_item ->> 'external_name', 500), v_name, v_photo,
        coalesce((v_item ->> 'reviewer_anonymous')::boolean, false), v_rating, v_comment, v_posted, v_updated, v_reply, v_reply_at,
        case when v_reply is not null then coalesce(v_reply_at, now()) end,
        case when v_sync.first_synced_at is not null and v_posted > now() - interval '14 days' then 'new' end)
      returning id into v_id;
      perform private.auto_match_review(v_id);
      v_out := v_out || 'new'::text;
      continue;
    end if;

    if v_old.deleted_at is null and v_old.rating is not distinct from v_rating and v_old.comment is not distinct from v_comment
       and v_old.reply_comment is not distinct from v_reply and v_old.reply_updated_at is not distinct from v_reply_at
       and v_old.google_updated_at is not distinct from v_updated and v_old.reviewer_name is not distinct from v_name
       and v_old.reviewer_photo_url is not distinct from v_photo and v_old.external_name = left(v_item ->> 'external_name', 500) then
      update public.reviews set seen_at = now() where id = v_old.id;
      v_out := v_out || 'same'::text;
    else
      v_lowered := coalesce(v_old.rating >= 3 and v_rating <= 2, false) and v_sync.first_synced_at is not null
        and v_updated > now() - interval '14 days';
      update public.reviews
         set external_name = left(v_item ->> 'external_name', 500), reviewer_name = v_name, reviewer_photo_url = v_photo,
             reviewer_anonymous = coalesce((v_item ->> 'reviewer_anonymous')::boolean, false), rating = v_rating, comment = v_comment,
             google_updated_at = v_updated, reply_comment = v_reply, reply_updated_at = v_reply_at,
             first_replied_at = case when v_reply is null then null else coalesce(first_replied_at, v_reply_at, now()) end,
             -- A reply changed on Google wasn't written here.
             replied_by = case when v_reply is distinct from reply_comment then null else replied_by end,
             notify = case when v_lowered then 'lowered' else notify end,
             notified_at = case when v_lowered then null else notified_at end,
             seen_at = now(), deleted_at = null
       where id = v_old.id;
      v_out := v_out || 'changed'::text;
    end if;
    if v_old.client_id is null and v_old.match_cleared_at is null then
      perform private.auto_match_review(v_old.id);
    end if;
  end loop;
  return v_out;
end $$;

-- Marks the reviews Google says are gone (a 404 for each, after a full pass that didn't see them),
-- if they're still unseen since that pass started. Their clients can be asked again. Says how many.
create function public.mark_deleted_reviews(p_company uuid, p_claim uuid, p_location_id text, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_sync public.review_syncs;
  v_count integer;
begin
  select * into v_sync from public.review_syncs where company_id = p_company for update;
  if not found or v_sync.claim is distinct from p_claim or v_sync.location_id is distinct from p_location_id or v_sync.full_started_at is null then
    raise exception 'This sync was stopped: the location changed or another sync took over' using errcode = '55000';
  end if;
  update public.reviews set deleted_at = now()
   where company_id = p_company and location_id = p_location_id and id = any (coalesce(p_ids, '{}'))
     and deleted_at is null and seen_at < v_sync.full_started_at;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- A review matched to a client by hand, or (p_client null) "Not this client", which also keeps it
-- from being matched automatically again. Both must be the company's. The ask it answers is the
-- client's latest that counts before the review, as review_match picks it. lifted_client is the
-- client who was matched before and has no other live review now: their asks can go again.
create function public.set_review_client(p_company uuid, p_review uuid, p_client uuid, p_by uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.reviews;
  v_lifted uuid;
begin
  select * into v from public.reviews r where r.company_id = p_company and r.id = p_review and r.deleted_at is null for update;
  if not found then raise exception 'That review isn''t here' using errcode = 'P0002'; end if;
  if p_client is not null then
    if not exists (select 1 from public.clients c where c.company_id = p_company and c.id = p_client) then
      raise exception 'That client isn''t here' using errcode = 'P0002';
    end if;
    update public.reviews
       set client_id = p_client, match = 'hand', matched_at = now(), matched_by = p_by, match_cleared_at = null,
           review_request_id = private.review_ask(p_company, p_client, v.posted_at)
     where id = p_review;
  else
    update public.reviews
       set client_id = null, match = 'none', matched_at = null, matched_by = p_by, match_cleared_at = now(), review_request_id = null
     where id = p_review;
  end if;
  if v.client_id is not null and v.client_id is distinct from p_client then
    select c.id into v_lifted from public.clients c where c.id = v.client_id and c.reviewed_at is null;
  end if;
  return jsonb_build_object('client_id', p_client, 'lifted_client', v_lifted);
end $$;

-- The location picked (Apps → Google Business Profile), with the reviews of any other location
-- removed (their clients can be asked again) and syncing started again from the top: a running
-- sync stops at its next page. Says how many reviews were removed.
create function public.set_review_location(p_company uuid, p_account text, p_location_id text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_sync public.review_syncs;
  v_count integer;
begin
  insert into public.review_syncs (company_id) values (p_company) on conflict (company_id) do nothing;
  select * into v_sync from public.review_syncs where company_id = p_company for update;
  delete from public.reviews where company_id = p_company and location_id <> p_location_id;
  get diagnostics v_count = row_count;
  update public.review_syncs
     set account = p_account, location_id = p_location_id, claim = null, locked_until = null, next_sync_at = now(),
         problem = null, problem_detail = null, problem_since = null, failures = 0, access_notice = null,
         full_started_at = case when v_sync.location_id is distinct from p_location_id then null else full_started_at end,
         full_page_token = case when v_sync.location_id is distinct from p_location_id then null else full_page_token end,
         full_seen = case when v_sync.location_id is distinct from p_location_id then 0 else full_seen end,
         first_synced_at = case when v_sync.location_id is distinct from p_location_id then null else first_synced_at end,
         full_synced_at = case when v_sync.location_id is distinct from p_location_id then null else full_synced_at end,
         average_rating = case when v_sync.location_id is distinct from p_location_id then null else average_rating end,
         total_reviews = case when v_sync.location_id is distinct from p_location_id then null else total_reviews end
   where company_id = p_company;
  return v_count;
end $$;

-- Disconnecting: syncing stops (a running sync stops at its next page). The reviews stay, and keep
-- stopping their clients' asks, unless p_remove: then they're removed too and asks can go again.
-- Says how many were removed.
create function public.end_review_sync(p_company uuid, p_remove boolean) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0;
begin
  perform 1 from public.review_syncs where company_id = p_company for update;
  if p_remove then
    delete from public.reviews where company_id = p_company;
    get diagnostics v_count = row_count;
    delete from public.review_syncs where company_id = p_company;
  else
    update public.review_syncs
       set claim = null, locked_until = null, next_sync_at = null, problem = null, problem_detail = null, problem_since = null,
           failures = 0, access_notice = null, full_started_at = null, full_page_token = null, full_seen = 0
     where company_id = p_company;
  end if;
  return v_count;
end $$;

-- Companies whose reviews are due: Google Business Profile connected and Marketing installed, not
-- waiting on a person (a location to pick, a location problem, a sign-in), due within the next two
-- minutes (the scheduler runs on the minute) and not being synced now. A connection with no row yet
-- is due at once.
create function public.review_syncs_due(p_limit integer default 25) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select i.company_id
    from public.integrations i
    join public.companies co on co.id = i.company_id
    left join public.review_syncs s on s.company_id = i.company_id
   where i.provider = 'google_business' and i.status = 'connected'
     and co.settings -> 'marketing' -> 'enabled' = 'true'::jsonb
     and coalesce(s.problem, '') not in ('pick', 'location', 'signin')
     and coalesce(s.next_sync_at, '-infinity') <= now() + interval '2 minutes'
     and (s.locked_until is null or s.locked_until < now())
   order by coalesce(s.next_sync_at, '-infinity'), i.company_id
   limit least(greatest(coalesce(p_limit, 25), 1), 100)
$$;

-- The office's notification for a review, as packages/core/src/reviews.ts reviewNotice words it.
create function private.review_notice_title(r public.reviews) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(case when r.reviewer_anonymous then '' else btrim(r.reviewer_name) end, ''), 'Someone')
    || case
         when r.notify = 'lowered' and r.rating is not null then ' changed their review to ' || r.rating || case when r.rating = 1 then ' star' else ' stars' end
         when r.rating is not null then ' left a ' || r.rating || '-star review'
         else ' left a review' end
$$;
create function private.review_notice_body(r public.reviews) returns text
language sql immutable set search_path = '' as $$
  select case
    when t = '' then case when r.rating is not null then 'No comment, just stars.' end
    when length(t) > 200 then rtrim(left(t, 199)) || '…'
    else t end
  from (select btrim(regexp_replace(coalesce(r.comment, ''), '\s+', ' ', 'g')) as t) x
$$;

-- Tells the office with the marketing area about each review waiting to be told, once: marked told
-- and the notifications made together, so neither happens without the other. Only while it's still
-- news (posted, or for one changed down, changed, in the last 14 days): the rest are let go. 1 and 2
-- stars are review_low, which also goes by email. Says how many reviews were told.
create function public.claim_review_notices(p_company uuid, p_claim uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_sync public.review_syncs;
  v_count integer;
begin
  select * into v_sync from public.review_syncs where company_id = p_company for update;
  if not found or v_sync.claim is distinct from p_claim then return 0; end if;
  update public.reviews set notify = null
   where company_id = p_company and notify is not null and notified_at is null
     and (deleted_at is not null or location_id is distinct from v_sync.location_id
          or (case notify when 'new' then posted_at else google_updated_at end) <= now() - interval '14 days');
  with told as (
    update public.reviews r set notified_at = now(), notified_rating = r.rating
     where r.company_id = p_company and r.notify is not null and r.notified_at is null and r.deleted_at is null
    returning r as review
  ), sent as (
    insert into public.notifications (company_id, user_id, kind, title, body, link)
    select p_company, o.user_id, case when (t.review).rating <= 2 then 'review_low' else 'review' end,
           left(private.review_notice_title(t.review), 300), private.review_notice_body(t.review), '/marketing?tab=reviews&review=' || (t.review).id
      from told t cross join private.marketing_office(p_company) as o(user_id)
    returning 1
  )
  select count(*) into v_count from told;
  return v_count;
end $$;

-- A change in whether reviews can come in, told once each time: 'in' when the first full pass
-- finishes (it's recorded as finished here, and the office with the marketing area hears "Your
-- Google reviews are in"); 'signin' or 'location' when that problem starts (owners and admins who
-- connect apps hear, since they fix it); 'ok' when it clears, so the next problem tells them again.
-- True when a notification went.
create function public.note_review_access(p_company uuid, p_claim uuid, p_kind text, p_title text default null, p_body text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind is null or p_kind not in ('in', 'signin', 'location', 'ok') then
    raise exception 'Access is in, signin, location or ok' using errcode = '22023';
  end if;
  if p_kind = 'in' then
    update public.review_syncs set first_synced_at = now() where company_id = p_company and claim = p_claim and first_synced_at is null;
  elsif p_kind = 'ok' then
    update public.review_syncs set access_notice = null where company_id = p_company and access_notice is not null;
    return false;
  else
    update public.review_syncs set access_notice = p_kind where company_id = p_company and access_notice is distinct from p_kind;
  end if;
  if not found or p_title is null then return false; end if;
  insert into public.notifications (company_id, user_id, kind, title, body, link)
  select p_company, u.user_id, 'review_access', left(p_title, 300), p_body,
         case when p_kind = 'in' then '/marketing?tab=reviews' else '/apps/google_business' end
    from (select o from private.marketing_office(p_company) o where p_kind = 'in'
          union select a from private.apps_admins(p_company) a where p_kind <> 'in') as u(user_id);
  return true;
end $$;

revoke all on function private.reviewed_setting(), private.client_reviewed_guard(), private.review_unmatched(), private.reviews_client_changed(),
  private.marketing_office(uuid), private.apps_admins(uuid), private.review_ask(uuid, uuid, timestamptz), private.review_match(uuid),
  private.auto_match_review(uuid), private.review_notice_title(public.reviews), private.review_notice_body(public.reviews) from public;
grant execute on function private.marketing_office(uuid), private.apps_admins(uuid) to service_role;
revoke execute on function public.claim_review_sync(uuid, integer), public.record_reviews(uuid, uuid, text, jsonb),
  public.mark_deleted_reviews(uuid, uuid, text, uuid[]), public.set_review_client(uuid, uuid, uuid, uuid),
  public.set_review_location(uuid, text, text), public.end_review_sync(uuid, boolean), public.review_syncs_due(integer),
  public.claim_review_notices(uuid, uuid), public.note_review_access(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_review_sync(uuid, integer), public.record_reviews(uuid, uuid, text, jsonb),
  public.mark_deleted_reviews(uuid, uuid, text, uuid[]), public.set_review_client(uuid, uuid, uuid, uuid),
  public.set_review_location(uuid, text, text), public.end_review_sync(uuid, boolean), public.review_syncs_due(integer),
  public.claim_review_notices(uuid, uuid), public.note_review_access(uuid, uuid, text, text, text) to service_role;

select private.fold_member_checks();

notify pgrst, 'reload schema';
