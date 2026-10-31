-- Social posts tell the office (docs/marketing-plan.md, phase E): a notification topic of their own,
-- "social", for an automatic post scheduled (kind social_scheduled, by push only) and a post that
-- didn't all go or may have gone, or Facebook & Instagram needing a new sign-in (social_failed, by
-- email too: packages/core/src/notifications.ts byEmail). Only the office with the marketing area,
-- and owners and admins who connect apps, get them, so it's on for everyone and nobody's other
-- choices change.

-- As in 20261031000310_review_notifications.sql, with social.
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.notification_prefs'::regclass and contype = 'c' loop
    execute format('alter table public.notification_prefs drop constraint %I', c);
  end loop;
end $$;
alter table public.notification_prefs add constraint notification_prefs_topics_check check (
  email <@ array['schedule','client','equipment','subs','jobs','time','alerts','chat','hosting','reviews','social']
  and sms <@ array['schedule','client','equipment','subs','jobs','time','alerts','chat','hosting','reviews','social']
  and push <@ array['schedule','client','equipment','subs','jobs','time','alerts','chat','hosting','reviews','social']
);
alter table public.notification_prefs alter column email set default '{schedule,jobs,hosting,reviews,social}';
alter table public.notification_prefs alter column push set default '{schedule,client,equipment,subs,jobs,time,alerts,chat,hosting,reviews,social}';

-- People who already chose get social posts by email and push too, with the rest of their choices
-- as they were. Says how many changed.
create function private.backfill_social_topic() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.notification_prefs
     set email = case when 'social' = any (email) then email else array_append(email, 'social') end,
         push = case when 'social' = any (push) then push else array_append(push, 'social') end
   where not ('social' = any (email)) or not ('social' = any (push));
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function private.backfill_social_topic() from public;
select private.backfill_social_topic();
