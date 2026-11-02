-- Google reviews, after a review of phase D (docs/marketing-plan.md):
--
--   Stops lifted every way     A review deleted on Google, another location's reviews removed, or the
--                              reviews removed on disconnecting say whose stop they lifted
--                              (lifted_clients), as "Not this client" does, so the server gives their
--                              stopped asks their reminders back (liftReviewStops), not only new asks.
--   Replies written here       reviews.reply_written_at: a page Google gave before a reply was posted,
--                              changed or deleted in Crewtavo doesn't put the old one back, or lose who
--                              wrote it (record_reviews' p_fetched_at).
--   A location to pick         review_syncs.access_notice takes 'pick': Google letting Crewtavo in on a
--                              later try, with a location still to pick, tells owners and admins who
--                              connect apps once.
--   Marketing off              Access notices wait while Marketing is uninstalled: Paused means no
--                              notifications.

-- ---------------------------------------------------------------------------------------------
-- Reviews and their sync
-- ---------------------------------------------------------------------------------------------

alter table public.reviews add column reply_written_at timestamptz;
comment on column public.reviews.reply_written_at is 'When someone last posted, changed or deleted the reply from Crewtavo';

alter table public.review_syncs drop constraint review_syncs_access_notice_check;
alter table public.review_syncs add constraint review_syncs_access_notice_check check (access_notice in ('signin', 'location', 'pick'));

-- Of these clients, the ones no live review stops anymore: their stopped asks can get reminders back.
create function private.unreviewed(p_clients uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(c.id order by c.id), '[]') from public.clients c where c.id = any (coalesce(p_clients, '{}')) and c.reviewed_at is null
$$;

-- As in 20261031000300_google_reviews.sql, and a reply written here after the page was fetched
-- (p_fetched_at), or a minute before (Google's list can take a moment to show it), is kept: the page
-- is older than it.
drop function public.record_reviews(uuid, uuid, text, jsonb);
create function public.record_reviews(p_company uuid, p_claim uuid, p_location_id text, p_reviews jsonb, p_fetched_at timestamptz default null) returns text[]
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

    if v_old.reply_written_at > coalesce(p_fetched_at, now()) - interval '1 minute' then
      v_reply := v_old.reply_comment;
      v_reply_at := v_old.reply_updated_at;
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

-- As in 20261031000300_google_reviews.sql, saying how many were marked and whose stop they lifted:
-- {marked, lifted_clients}.
drop function public.mark_deleted_reviews(uuid, uuid, text, uuid[]);
create function public.mark_deleted_reviews(p_company uuid, p_claim uuid, p_location_id text, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_sync public.review_syncs;
  v_count integer;
  v_clients uuid[];
begin
  select * into v_sync from public.review_syncs where company_id = p_company for update;
  if not found or v_sync.claim is distinct from p_claim or v_sync.location_id is distinct from p_location_id or v_sync.full_started_at is null then
    raise exception 'This sync was stopped: the location changed or another sync took over' using errcode = '55000';
  end if;
  with marked as (
    update public.reviews set deleted_at = now()
     where company_id = p_company and location_id = p_location_id and id = any (coalesce(p_ids, '{}'))
       and deleted_at is null and seen_at < v_sync.full_started_at
    returning client_id
  )
  select count(*), array_agg(client_id) filter (where client_id is not null) into v_count, v_clients from marked;
  return jsonb_build_object('marked', v_count, 'lifted_clients', private.unreviewed(v_clients));
end $$;

-- As in 20261031000300_google_reviews.sql, saying how many reviews were removed and whose stop they
-- lifted: {removed, lifted_clients}.
drop function public.set_review_location(uuid, text, text);
create function public.set_review_location(p_company uuid, p_account text, p_location_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_sync public.review_syncs;
  v_count integer;
  v_clients uuid[];
begin
  insert into public.review_syncs (company_id) values (p_company) on conflict (company_id) do nothing;
  select * into v_sync from public.review_syncs where company_id = p_company for update;
  with gone as (
    delete from public.reviews where company_id = p_company and location_id <> p_location_id
    returning case when deleted_at is null then client_id end as client_id
  )
  select count(*), array_agg(client_id) filter (where client_id is not null) into v_count, v_clients from gone;
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
  return jsonb_build_object('removed', v_count, 'lifted_clients', private.unreviewed(v_clients));
end $$;

-- As in 20261031000300_google_reviews.sql, saying how many were removed and whose stop they lifted:
-- {removed, lifted_clients}.
drop function public.end_review_sync(uuid, boolean);
create function public.end_review_sync(p_company uuid, p_remove boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer := 0;
  v_clients uuid[];
begin
  perform 1 from public.review_syncs where company_id = p_company for update;
  if p_remove then
    with gone as (
      delete from public.reviews where company_id = p_company
      returning case when deleted_at is null then client_id end as client_id
    )
    select count(*), array_agg(client_id) filter (where client_id is not null) into v_count, v_clients from gone;
    delete from public.review_syncs where company_id = p_company;
  else
    update public.review_syncs
       set claim = null, locked_until = null, next_sync_at = null, problem = null, problem_detail = null, problem_since = null,
           failures = 0, access_notice = null, full_started_at = null, full_page_token = null, full_seen = 0
     where company_id = p_company;
  end if;
  return jsonb_build_object('removed', v_count, 'lifted_clients', private.unreviewed(v_clients));
end $$;

-- As in 20261031000300_google_reviews.sql, with 'pick' (Google let Crewtavo in on a later try, and a
-- location is still to pick: owners and admins who connect apps hear). A problem tells nobody while
-- Marketing is uninstalled, and isn't recorded as told, so it tells them once Marketing is back.
create or replace function public.note_review_access(p_company uuid, p_claim uuid, p_kind text, p_title text default null, p_body text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind is null or p_kind not in ('in', 'signin', 'location', 'pick', 'ok') then
    raise exception 'Access is in, signin, location, pick or ok' using errcode = '22023';
  end if;
  if p_kind = 'in' then
    update public.review_syncs set first_synced_at = now() where company_id = p_company and claim = p_claim and first_synced_at is null;
  elsif p_kind = 'ok' then
    update public.review_syncs set access_notice = null where company_id = p_company and access_notice is not null;
    return false;
  else
    if not exists (select 1 from public.companies co where co.id = p_company and co.settings -> 'marketing' -> 'enabled' = 'true'::jsonb) then
      return false;
    end if;
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

revoke all on function private.unreviewed(uuid[]) from public;
revoke execute on function public.record_reviews(uuid, uuid, text, jsonb, timestamptz), public.mark_deleted_reviews(uuid, uuid, text, uuid[]),
  public.set_review_location(uuid, text, text), public.end_review_sync(uuid, boolean) from public, anon, authenticated;
grant execute on function public.record_reviews(uuid, uuid, text, jsonb, timestamptz), public.mark_deleted_reviews(uuid, uuid, text, uuid[]),
  public.set_review_location(uuid, text, text), public.end_review_sync(uuid, boolean) to service_role;

notify pgrst, 'reload schema';
