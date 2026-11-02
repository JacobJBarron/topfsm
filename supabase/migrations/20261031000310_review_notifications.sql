-- Google reviews tell the office (docs/marketing-plan.md, phase D): a notification topic of its own,
-- "reviews", for new reviews (kind review), ones of 1 or 2 stars (review_low) and reviews starting
-- or stopping coming in (review_access). By push and email unless someone turns it off; the email
-- carries only review_low and review_access (packages/core/src/notifications.ts byEmail). Only
-- people with the marketing area get them (private.marketing_office), so it's on for everyone, and
-- nobody's other choices change.

-- As in 20261025004001_sub_offers.sql, with reviews.
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.notification_prefs'::regclass and contype = 'c' loop
    execute format('alter table public.notification_prefs drop constraint %I', c);
  end loop;
end $$;
alter table public.notification_prefs add constraint notification_prefs_topics_check check (
  email <@ array['schedule','client','equipment','subs','jobs','time','alerts','chat','hosting','reviews']
  and sms <@ array['schedule','client','equipment','subs','jobs','time','alerts','chat','hosting','reviews']
  and push <@ array['schedule','client','equipment','subs','jobs','time','alerts','chat','hosting','reviews']
);
alter table public.notification_prefs alter column email set default '{schedule,jobs,hosting,reviews}';
alter table public.notification_prefs alter column push set default '{schedule,client,equipment,subs,jobs,time,alerts,chat,hosting,reviews}';

-- People who already chose get reviews by email and push too, with the rest of their choices as
-- they were. Says how many changed.
create function private.backfill_review_topic() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.notification_prefs
     set email = case when 'reviews' = any (email) then email else array_append(email, 'reviews') end,
         push = case when 'reviews' = any (push) then push else array_append(push, 'reviews') end
   where not ('reviews' = any (email)) or not ('reviews' = any (push));
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.backfill_review_topic() from public;
select private.backfill_review_topic();
