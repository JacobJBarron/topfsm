-- A review post's review comes back (docs/marketing-plan.md, phase E): disconnecting Google Business
-- Profile with its reviews removed, or Change location away and back, deletes the reviews' rows, and
-- social_posts.review_id goes to null with them. The same reviews come in again with the same
-- location and review ids, so a post still to go is linked to its review again by review_key (which
-- outlives the row), and posts when it's due instead of failing with "The review was removed from
-- Google". services/social.ts looks a review up by review_key too, for a post a sync hasn't reached.

create function private.relink_social_posts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.social_posts
     set review_id = new.id
   where company_id = new.company_id and review_key = new.location_id || '/' || new.review_id and review_id is null;
  return null;
end $$;
revoke all on function private.relink_social_posts() from public;
create trigger relink_social_posts after insert on public.reviews
  for each row execute function private.relink_social_posts();

create index social_posts_unlinked_review_idx on public.social_posts (company_id, review_key) where review_id is null and review_key is not null;

-- Posts whose review is here again already are linked now.
update public.social_posts p
   set review_id = r.id
  from public.reviews r
 where p.review_id is null and p.review_key is not null
   and r.company_id = p.company_id and p.review_key = r.location_id || '/' || r.review_id;

notify pgrst, 'reload schema';
