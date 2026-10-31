-- Google reviews (docs/marketing-plan.md, phase D): a match the office made, or undid, outlives the
-- review's row. Change location removes a location's reviews, and disconnecting can too, so coming
-- back to that location brought the reviews in again with the office's choices lost: a review it had
-- said wasn't Tom's ("Not this client") was matched to Tom again, and his asks stopped again.
--
--   review_match_choices   the office's choice for one of Google's reviews (by its location and
--                          review ids): the client it matched by hand, or none for "Not this client".
--                          Kept when the review's row is removed, and taken up again when the review
--                          comes back. The server's alone, written by set_review_client.

create table public.review_match_choices (
  company_id uuid not null references public.companies (id) on delete cascade,
  location_id text not null check (location_id ~ '^locations/[^/]+$' and length(location_id) <= 200),
  review_id text not null check (length(review_id) between 1 and 300),
  -- Null: "Not this client", so the review is never matched automatically.
  client_id uuid,
  chosen_at timestamptz not null default now(),
  chosen_by uuid references auth.users (id) on delete set null,
  primary key (company_id, location_id, review_id),
  -- A client deleted takes their match with them: the review can be matched again.
  foreign key (company_id, client_id) references public.clients (company_id, id) on delete cascade
);
comment on table public.review_match_choices is 'The office''s match, or "Not this client", for each Google review, kept when the review''s row is removed';
create index review_match_choices_client_idx on public.review_match_choices (client_id) where client_id is not null;
alter table public.review_match_choices enable row level security;
revoke all on public.review_match_choices from authenticated, anon;

-- The choices already made, from the reviews still here. Says how many it kept.
create function private.backfill_review_choices() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.review_match_choices (company_id, location_id, review_id, client_id, chosen_at, chosen_by)
  select r.company_id, r.location_id, r.review_id, case when r.match = 'hand' then r.client_id end,
         coalesce(case when r.match = 'hand' then r.matched_at else r.match_cleared_at end, now()), r.matched_by
    from public.reviews r
   where r.match = 'hand' or (r.match = 'none' and r.match_cleared_at is not null)
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.backfill_review_choices() from public;
select private.backfill_review_choices();

-- A review brought in again takes up the office's choice: matched by hand to that client (with the
-- ask it answers, found as set_review_client finds it), or kept from being matched automatically.
create function private.review_take_choice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v public.review_match_choices;
begin
  select * into v from public.review_match_choices m
   where m.company_id = new.company_id and m.location_id = new.location_id and m.review_id = new.review_id;
  if not found then return new; end if;
  if v.client_id is null then
    new.client_id := null;
    new.match := 'none';
    new.matched_at := null;
    new.match_cleared_at := v.chosen_at;
  else
    new.client_id := v.client_id;
    new.match := 'hand';
    new.matched_at := v.chosen_at;
    new.match_cleared_at := null;
    new.review_request_id := private.review_ask(new.company_id, v.client_id, new.posted_at);
  end if;
  new.matched_by := v.chosen_by;
  return new;
end $$;
create trigger review_take_choice before insert on public.reviews
  for each row execute function private.review_take_choice();

-- As in 20261031000300_google_reviews.sql, and the choice is kept apart from the review's row, so it
-- holds if the review is removed and comes back.
create or replace function public.set_review_client(p_company uuid, p_review uuid, p_client uuid, p_by uuid) returns jsonb
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
  insert into public.review_match_choices (company_id, location_id, review_id, client_id, chosen_at, chosen_by)
  values (p_company, v.location_id, v.review_id, p_client, now(), p_by)
  on conflict (company_id, location_id, review_id) do update
    set client_id = excluded.client_id, chosen_at = excluded.chosen_at, chosen_by = excluded.chosen_by;
  if v.client_id is not null and v.client_id is distinct from p_client then
    select c.id into v_lifted from public.clients c where c.id = v.client_id and c.reviewed_at is null;
  end if;
  return jsonb_build_object('client_id', p_client, 'lifted_client', v_lifted);
end $$;

revoke all on function private.review_take_choice() from public;
revoke execute on function public.set_review_client(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_review_client(uuid, uuid, uuid, uuid) to service_role;

notify pgrst, 'reload schema';
