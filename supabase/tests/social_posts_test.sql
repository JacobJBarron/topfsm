-- Database tests for social posting (20261031000400_ok_to_share.sql, 20261031000410_social_posts.sql,
-- 20261031000420_automatic_review_posts.sql, 20261031000430_social_notifications.sql,
-- 20261031000440_social_post_fixes.sql, 20261031000450_social_post_words.sql): OK to share
-- marked only through set_photo_shareable, by the team (never another business, never a PDF or
-- HEIC), kept out of plain writes and cleared when the file changes; a client who said no, an
-- invoice's photo and a photo whose record is gone; the office's photo lists; who reads posts and
-- that only the server writes them; the claim (only posts that are due, while Marketing is on, a
-- send that may have gone never repeated and never left stuck, a recorded success winning over a
-- stale claim), how a post's status comes from its networks, retries counted, steps kept only for
-- the claim's worker, cancel (a send out when it's cancelled never tried again) and Post again (its
-- steps made again); a post that may have posted settled by a person; who hears a post didn't all
-- go, and the words; Marketing uninstalled (a send out then never tried again, even once it's back);
-- automatic 5-star posts (the next slot, 3 a day, never twice for a review, never one already posted
-- by hand, never from a first sync, an old review or a re-import, only to networks that are ready,
-- Google's included, cancelled when turned off) and settings.social kept from plain saves; Facebook &
-- Instagram's sign-in notices; and the social topic.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tsp;
grant usage on schema tsp to authenticated, service_role;
create function tsp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tsp.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
create function tsp.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- A review as the server sends it to record_reviews.
create function tsp.item(p_id text, p_rating int, p_posted timestamptz, p_comment text) returns jsonb language sql as $$
  select jsonb_build_object('review_id', p_id, 'external_name', 'accounts/1/locations/9/reviews/' || p_id, 'reviewer_name', 'Rev ' || p_id,
    'reviewer_anonymous', false, 'rating', p_rating, 'comment', p_comment, 'posted_at', p_posted, 'google_updated_at', p_posted)
$$;
-- The automatic post for a review, if there is one.
create function tsp.auto_post(p_company uuid, p_review text) returns public.social_posts language sql as $$
  select * from public.social_posts where company_id = p_company and automatic and review_key = 'locations/9/' || p_review
$$;
-- 10:00 on a day's slot in New York, `p_days` after the first day automatic posts can go.
create function tsp.slot(p_days int, p_time time) returns timestamptz language sql as $$
  select ((now() at time zone 'America/New_York')::date
          + case when (now() at time zone 'America/New_York')::time < time '08:00' then 0 else 1 end + p_days + p_time) at time zone 'America/New_York'
$$;
grant execute on all functions in schema tsp to authenticated, service_role;

\set mia 'f7100000-0000-0000-0000-000000000001'
\set oli 'f7100000-0000-0000-0000-000000000002'
\set dot 'f7100000-0000-0000-0000-000000000003'
\set cal 'f7100000-0000-0000-0000-000000000004'
\set lee 'f7100000-0000-0000-0000-000000000005'
\set oz 'f7100000-0000-0000-0000-000000000006'

-- Mia owns Maple Lawn; Oli is office; Dot is office as a Dispatcher without the marketing area; Cal
-- is on a crew and Lee leads one. Oz owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mia', 'mia@maple.test', '{"full_name": "Mia Owner"}'),
  (:'oli', 'oli@maple.test', '{"full_name": "Oli Office"}'),
  (:'dot', 'dot@maple.test', '{"full_name": "Dot Dispatch"}'),
  (:'cal', 'cal@maple.test', '{"full_name": "Cal Crew"}'),
  (:'lee', 'lee@maple.test', '{"full_name": "Lee Lead"}'),
  (:'oz', 'oz@other.test', '{"full_name": "Oz Other"}');

begin;
set local role authenticated;
select tsp.as_user(:'oz');
select public.create_company('Other Lawn', 'lawn_care') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Olga Other') returning id as olga \gset
commit;

begin;
set local role authenticated;
select tsp.as_user(:'mia');
select public.create_company('Maple Lawn', 'lawn_care') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Dispatcher', 'office', '{schedule,sales}') returning id as dispatcher \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'oli', 'office'), (:'co', :'cal', 'field_crew'), (:'co', :'lee', 'crew_lead');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'dot', 'office', :'dispatcher');
insert into public.clients (company_id, display_name) values (:'co', 'Ana Green') returning id as ana \gset
insert into public.clients (company_id, display_name) values (:'co', 'Bea Stone') returning id as bea \gset
commit;
update public.companies set timezone = 'America/New_York' where id = :'co';

insert into public.properties (company_id, client_id, line1, city) values (:'co', :'ana', '14 Oak St', 'Radford') returning id as ana_home \gset
insert into public.jobs (company_id, client_id, property_id, title) values (:'co', :'ana', :'ana_home', 'Spring cleanup') returning id as job \gset
insert into public.visits (company_id, job_id, property_id, title, scheduled_on) values (:'co', :'job', :'ana_home', 'Spring cleanup', current_date) returning id as visit \gset
insert into public.invoices (company_id, client_id) values (:'co', :'bea') returning id as bea_invoice \gset
insert into public.jobs (company_id, client_id, title) values (:'other', :'olga', 'Mowing') returning id as other_job \gset

-- Cal's photos on the visit (a JPEG, a HEIC), the job's PNG and PDF, a photo on Bea's invoice, and one
-- whose visit was deleted (attachments have no foreign key to what they're on).
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'visit', :'visit', :'co' || '/visit/' || :'visit' || '/a.jpg', 'a.jpg', 'image/jpeg', :'cal') returning id as jpeg \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'visit', :'visit', :'co' || '/visit/' || :'visit' || '/b.heic', 'b.heic', 'image/heic', :'cal') returning id as heic \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'job', :'job', :'co' || '/job/' || :'job' || '/c.png', 'c.png', 'image/png', :'oli') returning id as png \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'job', :'job', :'co' || '/job/' || :'job' || '/d.pdf', 'd.pdf', 'application/pdf', :'oli') returning id as pdf \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'invoice', :'bea_invoice', :'co' || '/invoice/' || :'bea_invoice' || '/e.jpg', 'e.jpg', 'image/jpeg', :'oli') returning id as bea_photo \gset
select gen_random_uuid() as gone \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, created_by) values
  (:'co', 'visit', :'gone', :'co' || '/visit/' || :'gone' || '/f.jpg', 'f.jpg', 'image/jpeg', :'cal') returning id as orphan \gset
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type) values
  (:'other', 'job', :'other_job', :'other' || '/job/' || :'other_job' || '/g.jpg', 'g.jpg', 'image/jpeg') returning id as other_photo \gset

-- ===== OK to share ============================================================================
begin;
set local role authenticated;
select tsp.as_user(:'lee');
select tsp.check((select (public.set_photo_shareable(:'jpeg', true) ->> 'shareable')::boolean), 'a crew lead marks a crew member''s photo OK to share');
select tsp.check((select shareable and shareable_by = :'lee' and shareable_at is not null from public.attachments where id = :'jpeg'), 'saying who and when');
select tsp.as_user(:'cal');
select tsp.check(tsp.error_of(format('select public.set_photo_shareable(%L, true)', :'pdf')) = '22023: Only JPEG and PNG photos can be posted. Save this one as a JPEG and add it again.',
  'a PDF can''t be marked');
select tsp.check(tsp.error_of(format('select public.set_photo_shareable(%L, true)', :'heic')) like '22023: Only JPEG and PNG%', 'nor a HEIC photo');
select tsp.check(tsp.error_of(format('select public.set_photo_shareable(%L, true)', :'orphan')) = '22023: This photo isn''t on a job, visit or client anymore, so it can''t be posted.',
  'nor one whose visit is gone');
select tsp.as_user(:'oz');
select tsp.check(tsp.error_of(format('select public.set_photo_shareable(%L, true)', :'png')) like '42501:%', 'another business can''t mark it');
select tsp.as_user(:'oli');
update public.attachments set shareable = true, shareable_at = now() where id = :'png';
select tsp.check((select not shareable from public.attachments where id = :'png'), 'a plain update can''t mark a photo, even the office''s');
insert into public.attachments (company_id, owner_type, owner_id, path, file_name, content_type, shareable, shareable_at)
values (:'co', 'job', :'job', :'co' || '/job/' || :'job' || '/h.jpg', 'h.jpg', 'image/jpeg', true, now()) returning id as fresh \gset
select tsp.check((select not shareable and shareable_at is null from public.attachments where id = :'fresh'), 'nor can a new one start marked');
select tsp.check((select (public.set_photo_shareable(:'bea_photo', true) ->> 'shareable')::boolean), 'an invoice''s photo can be marked, as its client''s');
select tsp.check((select (public.set_photo_shareable(:'png', true) ->> 'shareable')::boolean), 'and the office marks the job''s PNG');
commit;

update public.attachments set path = :'co' || '/job/' || :'job' || '/c2.png' where id = :'png';
select tsp.check((select not shareable and shareable_by is null from public.attachments where id = :'png'), 'a replaced file isn''t OK to share by itself, whoever replaces it');

begin;
set local role authenticated;
select tsp.as_user(:'cal');
select public.set_photo_shareable(:'png', true);
select public.set_photo_shareable(:'png', false);
select tsp.check((select not shareable and shareable_by is null and shareable_at is null from public.attachments where id = :'png'), 'turning it off clears who and when');
select public.set_photo_shareable(:'png', true);
commit;

-- ===== The client's choice ====================================================================
begin;
set local role authenticated;
select tsp.as_user(:'oli');
update public.clients set social_photos_opt_out = true where id = :'bea';
select tsp.check((select social_photos_opt_out from public.clients where id = :'bea'), 'the office sets a client''s "Don''t post photos of this client''s property"');
select tsp.check(tsp.error_of(format('select public.set_photo_shareable(%L, true)', :'bea_photo')) = '22023: This client asked us not to post photos of their property.',
  'and their photos can''t be marked then');
select tsp.check((select array_agg(id order by created_at) from public.social_photos(:'co')) = array[:'jpeg', :'png']::uuid[],
  'the photos to post leave out a client who said no, and other businesses''');
select tsp.check((select count(distinct client_ref) = 1 and bool_and(job_number is not null) from public.social_photos(:'co')),
  'and say which are of one client without saying who');
select tsp.check((select array_agg(id) from public.social_photos(:'co', p_job => :'job')) is not null
                 and not exists (select 1 from public.social_photos(:'co', p_job => gen_random_uuid())), 'narrowed to one job');
select tsp.check((select cant_share from public.record_photos(:'co', :'job') where id = :'heic') = 'format'
                 and (select can_share from public.record_photos(:'co', :'job') where id = :'jpeg')
                 and not exists (select 1 from public.record_photos(:'co', :'job') where id = :'pdf'),
  'a job''s photos say which can''t be posted, and why');
select tsp.check((select cant_share from public.record_photos(:'co', null, :'bea') where id = :'bea_photo') = 'client_opt_out',
  'a client''s photos, an invoice''s included, say they asked not to be posted');
select tsp.as_user(:'dot');
select tsp.check(tsp.error_of(format('select * from public.social_photos(%L)', :'co')) like '42501:%', 'office staff without the marketing area get no photos to post');
commit;
select tsp.check((select shareable from public.attachments where id = :'bea_photo'), 'a photo marked before the client said no stays marked, and isn''t offered');

-- ===== Posts: who reads them ==================================================================
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": true}') where id in (:'co', :'other');
insert into public.social_posts (company_id, source, attachment_ids, caption, networks, status, scheduled_for, created_by)
values (:'co', 'photos', array[:'jpeg']::uuid[], 'Fresh mulch', '{facebook,instagram}', 'scheduled', now() - interval '1 minute', :'oli') returning id as p1 \gset
insert into public.social_posts (company_id, source, attachment_ids, caption, networks, status, scheduled_for, created_by)
values (:'co', 'photos', array[:'jpeg']::uuid[], 'Next week', '{facebook}', 'scheduled', now() + interval '1 day', :'oli') returning id as later \gset
insert into public.social_posts (company_id, source, caption, networks, status, scheduled_for)
values (:'other', 'text', 'Spring is here', '{facebook}', 'scheduled', now() - interval '1 minute') returning id as theirs \gset
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": false}') where id = :'other';

select tsp.check(tsp.error_of(format($$insert into public.social_posts (company_id, source, caption, networks) values (%L, 'text', 'x', '{instagram}')$$, :'co')) like '23514:%',
  'words alone can''t go to Instagram');
select tsp.check(tsp.error_of(format($$insert into public.social_posts (company_id, source, attachment_ids, caption, networks) values (%L, 'photos', '{}', 'x', '{facebook}')$$, :'co')) like '23514:%',
  'a photos post needs photos');

begin;
set local role service_role;
select * from public.claim_social_posts(10) \gset c_
commit;
select tsp.check(:'c_id' = :'p1', 'the claim takes the post that''s due, not one for later or one while Marketing is off');
begin;
set local role service_role;
select tsp.check(not exists (select 1 from public.claim_social_posts(10)), 'and a second claim never gets the same post');
commit;
select tsp.check((select status = 'posting' and started_at is not null and claim = :'c_claim' from public.social_posts where id = :'p1')
                 and (select array_agg(network || ':' || status order by network) = '{facebook:waiting,instagram:waiting}' from public.social_post_networks where post_id = :'p1'),
  'it''s posting, with a row waiting for each network');

begin;
set local role authenticated;
select tsp.as_user(:'oli');
select tsp.check((select count(*) from public.social_posts) = 2 and (select count(*) from public.social_post_networks) = 2, 'office staff with the marketing area read the posts and how they went');
select tsp.check(tsp.error_of(format($$insert into public.social_posts (company_id, source, caption, networks) values (%L, 'text', 'x', '{facebook}')$$, :'co')) like '42501:%',
  'but can''t write them: only the server does');
select tsp.check(tsp.error_of(format('update public.social_posts set caption = %L', 'changed')) like '42501:%', 'nor change them');
select tsp.check(tsp.error_of('select count(*) from public.social_post_images') like '42501:%', 'and the pictures'' links aren''t theirs to read');
select tsp.as_user(:'dot');
select tsp.check((select count(*) from public.social_posts) = 0 and (select count(*) from public.social_post_networks) = 0, 'office staff without the area read none');
select tsp.as_user(:'oz');
select tsp.check((select count(*) from public.social_posts) = 1, 'and another business reads only its own');
commit;

-- ===== Posting ================================================================================
insert into public.social_post_images (company_id, post_id, n, variant, attachment_id, path, token, width, height, bytes, expires_at)
values (:'co', :'p1', 0, 'feed', :'jpeg', :'co' || '/social/' || :'p1' || '/0-feed.jpg', repeat('a', 32), 100, 100, 1000, now() + interval '30 days');
begin;
set local role service_role;
select tsp.check(not public.begin_social_network(:'p1', gen_random_uuid(), 'facebook'), 'only the worker holding the claim begins a send');
select tsp.check(public.begin_social_network(:'p1', :'c_claim', 'facebook'), 'which marks the network sending');
select tsp.check(public.end_social_network(:'p1', :'c_claim', 'facebook', 'posted', '1_2', 'https://www.facebook.com/1_2') = 'posting', 'Facebook posted, the post is still going');
select tsp.check(not public.begin_social_network(:'p1', :'c_claim', 'facebook'), 'and a network that posted is never begun again');
select tsp.check(public.end_social_network(:'p1', :'c_claim', 'instagram', 'retry', null, null, 'Instagram is busy', 'rate', now() - interval '1 second') = 'posting',
  'Instagram waits to try again');
commit;
select tsp.check((select tries = 1 and first_tried_at is not null and attempts = 0 from public.social_post_networks where post_id = :'p1' and network = 'instagram'),
  'a wait counts as a try, though nothing was sent');
begin;
set local role service_role;
select public.release_social_post(:'p1', :'c_claim');
select * from public.claim_social_posts(10) \gset c2_
select tsp.check(:'c2_id' = :'p1', 'let go, it''s claimed again once its network is due');
select tsp.check(not public.save_social_steps(:'p1', :'c_claim', 'instagram', '{"container": "old"}')
                 and (select steps = '{}' from public.social_post_networks where post_id = :'p1' and network = 'instagram'),
  'steps are kept only for the worker holding the claim, not one whose claim moved on');
select tsp.check(public.save_social_steps(:'p1', :'c2_claim', 'instagram', '{"container": "c1"}'), 'the worker keeps its steps');
select tsp.check(not public.save_social_steps(:'p1', :'c2_claim', 'facebook', '{"media_fbids": ["x"]}'), 'but not for a network that posted');
select tsp.check(public.end_social_network(:'p1', :'c2_claim', 'instagram', 'failed', null, null, 'Instagram turned it down', 'image') = 'partly_posted', 'one posted and one failed is partly posted');
commit;
select tsp.check((select finished_at is not null and claim is null from public.social_posts where id = :'p1')
                 and (select expires_at <= now() + interval '7 days 1 minute' from public.social_post_images where post_id = :'p1'),
  'a finished post lets go of its claim, and its pictures'' links run out 7 days on');
select tsp.check(exists (select 1 from public.notifications where user_id = :'oli' and kind = 'social_failed' and title = 'A post went to Facebook but not Instagram'),
  'and whoever made it hears it didn''t all go');
select tsp.check(tsp.error_of(format('update public.social_posts set status = %L, scheduled_for = now() where id = %L', 'scheduled', :'p1')) like '55000:%',
  'a post that started posting can''t go back to a time');

begin;
set local role service_role;
select tsp.check(public.retry_social_post(:'co', :'p1', :'oli') = 1, 'Post again puts back the network that failed');
commit;
select tsp.check((select status = 'posting' and claim is null from public.social_posts where id = :'p1')
                 and (select status = 'waiting' and tries = 0 and steps = '{}' from public.social_post_networks where post_id = :'p1' and network = 'instagram')
                 and (select status = 'posted' from public.social_post_networks where post_id = :'p1' and network = 'facebook'),
  'and only it, made again from nothing: the post stays posting, never back to something to edit');

-- A worker that stopped after it may have sent: its network is unknown when the claim runs out, never sent again, and the post finishes.
insert into public.social_posts (company_id, source, caption, networks, status, scheduled_for)
values (:'co', 'text', 'Booking spring cleanups', '{facebook}', 'scheduled', now() - interval '1 minute') returning id as p2 \gset
begin;
set local role service_role;
select * from public.claim_social_posts(1, 300, :'p2') \gset c3_
select tsp.check(:'c3_id' = :'p2', 'Post now claims that post alone');
select public.begin_social_network(:'p2', :'c3_claim', 'facebook');
commit;
update public.social_posts set locked_until = now() - interval '1 second' where id = :'p2';
begin;
set local role service_role;
select * from public.claim_social_posts(10, 300, :'p2');
commit;
select tsp.check((select status = 'unknown' from public.social_post_networks where post_id = :'p2') and (select status = 'check' and finished_at is not null from public.social_posts where id = :'p2'),
  'a one-network post whose worker stopped mid-send ends unconfirmed, not stuck posting');
begin;
set local role service_role;
select tsp.check(public.end_social_network(:'p2', :'c3_claim', 'facebook', 'posted', '1_9', 'https://www.facebook.com/1_9') = 'posted',
  'and a success recorded late by the old worker still wins');
select tsp.check(public.resolve_social_network(:'co', :'p2', 'facebook', true, null, :'oli') is null, 'so there''s nothing left for a person to settle');
commit;

-- Cancel post partway through: what's still to go is skipped.
insert into public.social_posts (company_id, source, attachment_ids, caption, networks, status, scheduled_for)
values (:'co', 'photos', array[:'jpeg']::uuid[], 'Edging', '{facebook,instagram}', 'scheduled', now() - interval '1 minute') returning id as p3 \gset
begin;
set local role service_role;
select * from public.claim_social_posts(1, 300, :'p3') \gset c4_
select public.begin_social_network(:'p3', :'c4_claim', 'facebook');
select public.end_social_network(:'p3', :'c4_claim', 'facebook', 'posted', '1_3', null);
select tsp.check(public.cancel_social_post(:'co', :'p3', :'oli') = 'partly_posted', 'cancelling a post partway through skips what''s left');
select tsp.check(public.cancel_social_post(:'co', :'later', :'oli') = 'cancelled', 'and cancels a scheduled one');
commit;
select tsp.check((select error_kind = 'cancelled' from public.social_post_networks where post_id = :'p3' and network = 'instagram'), 'saying why');
begin;
set local role service_role;
select tsp.check(public.retry_social_post(:'co', :'p3', :'oli') = 1, 'Post again after a cancel puts back what was cancelled: a person asked');
select * from public.claim_social_posts(1, 300, :'p3') \gset c4b_
select tsp.check(:'c4b_id' = :'p3' and public.begin_social_network(:'p3', :'c4b_claim', 'instagram'), 'and it''s claimed and sent again');
select tsp.check(public.end_social_network(:'p3', :'c4b_claim', 'instagram', 'posted', '17_3', null) = 'posted', 'so it posts');
commit;

-- Cancelled while Facebook is sending: that send is recorded, but "try again" is skipped, and nothing goes later.
insert into public.social_posts (company_id, source, attachment_ids, caption, networks, status, scheduled_for, created_by)
values (:'co', 'photos', array[:'jpeg']::uuid[], 'Hedges', '{facebook,instagram}', 'scheduled', now() - interval '1 minute', :'oli') returning id as p7 \gset
begin;
set local role service_role;
select * from public.claim_social_posts(1, 300, :'p7') \gset c7_
select public.begin_social_network(:'p7', :'c7_claim', 'facebook');
select tsp.check(public.cancel_social_post(:'co', :'p7', :'oli') = 'posting', 'cancelling while a send is out waits for it');
select tsp.check((select stop_kind = 'cancelled' from public.social_posts where id = :'p7'), 'marked stopped');
select tsp.check(not public.save_social_steps(:'p7', :'c7_claim', 'instagram', '{"items": ["x"]}') and not public.begin_social_network(:'p7', :'c7_claim', 'instagram'),
  'and nothing more is made or begun for it');
select tsp.check(public.end_social_network(:'p7', :'c7_claim', 'facebook', 'retry', null, null, 'Facebook asked Crewtavo to slow down', 'rate', now() - interval '1 second') = 'cancelled',
  'a send that comes back "try again" is skipped, and the post is cancelled');
commit;
select tsp.check((select status = 'skipped' and error_kind = 'cancelled' and next_attempt_at is null from public.social_post_networks where post_id = :'p7' and network = 'facebook'),
  'saying why');
begin;
set local role service_role;
select tsp.check(not exists (select 1 from public.claim_social_posts(10, 300, :'p7')), 'and the claim never takes it again');
commit;

-- Unconfirmed after a cancel: the title says what didn't go and what may have, to whoever made it, and
-- "It isn't there, post it" lifts the stop.
insert into public.social_posts (company_id, source, caption, networks, status, scheduled_for, created_by)
values (:'co', 'text', 'Gutter cleaning', '{facebook,google}', 'scheduled', now() - interval '1 minute', :'oli') returning id as p9 \gset
begin;
set local role service_role;
select * from public.claim_social_posts(1, 300, :'p9') \gset c9_
select public.begin_social_network(:'p9', :'c9_claim', 'facebook');
select public.cancel_social_post(:'co', :'p9', :'oli');
commit;
update public.social_posts set locked_until = now() - interval '1 second' where id = :'p9';
begin;
set local role service_role;
select * from public.claim_social_posts(10, 300, :'p9');
commit;
select tsp.check((select status = 'check' from public.social_posts where id = :'p9'), 'a send whose worker stopped, and the rest cancelled, is unconfirmed');
select tsp.check((select array_agg(user_id) from public.notifications where kind = 'social_failed' and body = 'Gutter cleaning') = array[:'oli']::uuid[]
                 and exists (select 1 from public.notifications where body = 'Gutter cleaning' and title = 'A post didn''t go to Google and may have gone to Facebook. Check your Page.'),
  'whoever made it hears what didn''t go, what may have, and where to look');
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": false}') where id = :'co';
begin;
set local role service_role;
select tsp.check(public.resolve_social_network(:'co', :'p9', 'facebook', false, null, :'oli') is null, '"It isn''t there, post it" waits while Marketing is off');
commit;
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": true}') where id = :'co';
begin;
set local role service_role;
select tsp.check(public.resolve_social_network(:'co', :'p9', 'facebook', false, null, :'oli') = 'posting', 'and otherwise puts it back');
commit;
select tsp.check((select status = 'posting' and claim is null and finished_at is null and stop_kind is null from public.social_posts where id = :'p9')
                 and (select status = 'waiting' and next_attempt_at <= now() from public.social_post_networks where post_id = :'p9' and network = 'facebook')
                 and (select status from public.social_post_networks where post_id = :'p9' and network = 'google') = 'skipped',
  'posting again with the stop lifted, only that network');
begin;
set local role service_role;
select * from public.claim_social_posts(1, 300, :'p9') \gset c9b_
select tsp.check(:'c9b_id' = :'p9' and public.begin_social_network(:'p9', :'c9b_claim', 'facebook'), 'so the claim takes it, and it''s sent');
select public.end_social_network(:'p9', :'c9b_claim', 'facebook', 'posted', '1_9b', null);
commit;

-- Partly posted with one unconfirmed: said apart, and its maker, who lost the marketing area, isn't told: the office is.
insert into public.social_posts (company_id, source, attachment_ids, caption, networks, status, scheduled_for, created_by)
values (:'co', 'photos', array[:'jpeg']::uuid[], 'Fresh sod', '{facebook,instagram}', 'scheduled', now() - interval '1 minute', :'dot') returning id as p10 \gset
begin;
set local role service_role;
select * from public.claim_social_posts(1, 300, :'p10') \gset c10_
select public.begin_social_network(:'p10', :'c10_claim', 'facebook');
select public.end_social_network(:'p10', :'c10_claim', 'facebook', 'posted', '1_10', null);
select public.begin_social_network(:'p10', :'c10_claim', 'instagram');
select tsp.check(public.end_social_network(:'p10', :'c10_claim', 'instagram', 'unknown', null, null, 'It may have posted.') = 'partly_posted', 'one posted and one unconfirmed is partly posted');
commit;
select tsp.check(exists (select 1 from public.notifications where body = 'Fresh sod' and title = 'A post went to Facebook and may have gone to Instagram. Check your Instagram account.'),
  'and the title says to check Instagram, not that it didn''t go');
select tsp.check((select array_agg(user_id order by user_id) from public.notifications where body = 'Fresh sod') = (select array_agg(o order by o) from private.marketing_office(:'co') o)
                 and not exists (select 1 from public.notifications where body = 'Fresh sod' and user_id = :'dot'),
  'someone who can''t read posts anymore isn''t told: the office with the marketing area is');

-- ===== Marketing uninstalled ==================================================================
insert into public.social_posts (company_id, source, caption, networks, status, scheduled_for)
values (:'co', 'text', 'Fall leaves', '{facebook,google}', 'scheduled', now() - interval '1 minute') returning id as p4 \gset
insert into public.social_posts (company_id, source, caption, networks, status, scheduled_for)
values (:'co', 'text', 'Aeration', '{facebook,google}', 'scheduled', now() - interval '1 minute') returning id as p5 \gset
insert into public.social_posts (company_id, source, caption, networks, status, scheduled_for)
values (:'co', 'text', 'Snow plowing', '{facebook}', 'scheduled', now() + interval '2 days') returning id as p6 \gset
begin;
set local role service_role;
select * from public.claim_social_posts(1, 300, :'p4') \gset c5_
select * from public.claim_social_posts(1, 300, :'p5') \gset c6_
select public.begin_social_network(:'p5', :'c6_claim', 'facebook');
commit;
insert into public.social_posts (company_id, source, caption, networks, status, scheduled_for)
values (:'co', 'text', 'Leaf cleanup', '{facebook}', 'scheduled', now() - interval '1 minute') returning id as p8 \gset
begin;
set local role service_role;
select * from public.claim_social_posts(1, 300, :'p8') \gset c8_
select public.begin_social_network(:'p8', :'c8_claim', 'facebook');
commit;
begin;
set local role authenticated;
select tsp.as_user(:'mia');
select public.marketing_set_enabled(:'co', false);
commit;
select tsp.check((select status = 'draft' and scheduled_for is null and note = 'Marketing was uninstalled' from public.social_posts where id = :'p6'),
  'uninstalling puts a scheduled post back to a draft, saying why');
select tsp.check((select status = 'failed' from public.social_posts where id = :'p4')
                 and (select bool_and(status = 'skipped' and error_kind = 'marketing_off') from public.social_post_networks where post_id = :'p4'),
  'a post partway through has what''s left skipped, and finishes');
select tsp.check((select status = 'posting' from public.social_posts where id = :'p5')
                 and (select status from public.social_post_networks where post_id = :'p5' and network = 'facebook') = 'sending',
  'but one with a send out isn''t finished until it''s recorded');
select tsp.check(not exists (select 1 from public.notifications where kind = 'social_failed' and body = 'Fall leaves'), 'and nobody is told while Marketing is off');
begin;
set local role service_role;
select tsp.check(not public.begin_social_network(:'p5', :'c6_claim', 'google'), 'no new send begins while Marketing is off');
select tsp.check(public.end_social_network(:'p5', :'c6_claim', 'facebook', 'posted', '1_5', null) = 'partly_posted', 'and the send that was out is still recorded');
insert into public.social_posts (company_id, source, caption, networks, status, scheduled_for) values (:'co', 'text', 'Due', '{facebook}', 'scheduled', now() - interval '1 minute');
select tsp.check(not exists (select 1 from public.claim_social_posts(10)), 'nothing is claimed while Marketing is off');
commit;
begin;
set local role authenticated;
select tsp.as_user(:'mia');
select public.marketing_set_enabled(:'co', true);
commit;
select tsp.check((select status from public.social_posts where id = :'p6') = 'draft', 'installing it again leaves drafts as drafts');
delete from public.social_posts where caption = 'Due';
select tsp.check((select status = 'posting' and stop_kind = 'marketing_off' from public.social_posts where id = :'p8'), 'a post with a send out when Marketing went stays marked stopped');
begin;
set local role service_role;
select tsp.check(public.end_social_network(:'p8', :'c8_claim', 'facebook', 'retry', null, null, 'Facebook asked Crewtavo to slow down', 'rate', now() - interval '1 second') = 'failed',
  'so a send that comes back "try again" is skipped, even with Marketing back, and the post finishes');
select tsp.check(not exists (select 1 from public.claim_social_posts(10, 300, :'p8')), 'installing again posts nothing by itself');
commit;
select tsp.check((select status = 'skipped' and error_kind = 'marketing_off' from public.social_post_networks where post_id = :'p8'), 'saying why');

-- ===== Automatic 5-star posts =================================================================
insert into public.integrations (company_id, provider, status, settings) values (:'co', 'meta', 'connected', '{"page_id": "100", "ig_user_id": "200"}');
begin;
set local role service_role;
select tsp.check(public.social_set_auto(:'co', true, '{facebook,instagram,google}') ->> 'enabled' = 'true', 'the server turns automatic posts on');
select public.set_review_location(:'co', 'accounts/1', 'locations/9');
select public.claim_review_sync(:'co') as claim \gset
select tsp.check(tsp.error_of(format('select public.social_set_auto(%L, true, %L)', :'other', '{facebook}')) = '22023: Connect Facebook & Instagram or Google Business Profile first.',
  'but not with no network ready');
commit;
begin;
set local role authenticated;
select tsp.as_user(:'mia');
update public.companies set settings = settings || '{"social": {"auto": {"enabled": false, "networks": []}}}' where id = :'co';
commit;
select tsp.check((select settings #>> '{social,auto,enabled}' = 'true' from public.companies where id = :'co'), 'and a plain settings save can''t turn them off without cancelling them');
begin;
set local role authenticated;
select tsp.as_user(:'mia');
update public.companies set settings = settings - 'social' where id = :'co';
commit;
select tsp.check((select settings #>> '{social,auto,enabled}' = 'true' from public.companies where id = :'co'), 'nor can one saved from a copy without them');

-- The first full sync isn't finished: nothing old is posted.
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tsp.item('first', 5, now() - interval '1 day', 'Great work on the lawn')));
commit;
select tsp.check(tsp.auto_post(:'co', 'first') is null, 'nothing is scheduled during the first full sync');
update public.review_syncs set first_synced_at = now() - interval '1 day' where company_id = :'co';

begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(
  tsp.item('r1', 5, now() - interval '1 hour', 'They did a wonderful job'),
  tsp.item('r2', 5, now() - interval '1 hour', 'Very happy with the crew'),
  tsp.item('r3', 5, now() - interval '1 hour', 'Fast, friendly, on time'),
  tsp.item('r4', 5, now() - interval '1 hour', 'Best lawn care around'),
  tsp.item('quiet', 5, now() - interval '1 hour', null),
  tsp.item('emoji', 5, now() - interval '1 hour', '👍👍'),
  tsp.item('four', 4, now() - interval '1 hour', 'Pretty good'),
  tsp.item('old', 5, now() - interval '15 days', 'Great work back then')));
commit;
select tsp.check((select status = 'scheduled' and source = 'review' and caption = 'Another 5-star review from a happy client. Thank you!' and caption_by = 'default'
                    and networks = '{facebook,instagram}' and created_by is null and scheduled_for = tsp.slot(0, '10:00') from tsp.auto_post(:'co', 'r1')),
  'a new 5-star review with words is scheduled for 10 AM in the company''s time zone, to the networks that are ready');
select tsp.check((tsp.auto_post(:'co', 'r2')).scheduled_for = tsp.slot(0, '13:00') and (tsp.auto_post(:'co', 'r3')).scheduled_for = tsp.slot(0, '16:00'),
  'the next ones take 1 PM and 4 PM');
select tsp.check((tsp.auto_post(:'co', 'r4')).scheduled_for = tsp.slot(1, '10:00'), 'and a fourth goes the next day: 3 a day at most');
select tsp.check(tsp.auto_post(:'co', 'quiet') is null and tsp.auto_post(:'co', 'emoji') is null, 'a review with no words, or only emoji, isn''t posted');
select tsp.check(tsp.auto_post(:'co', 'four') is null, 'nor a 4-star one');
select tsp.check(tsp.auto_post(:'co', 'old') is null, 'nor one posted 15 days ago');
select tsp.check(exists (select 1 from public.notifications where kind = 'social_scheduled' and user_id = :'oli' and title like 'A 5-star review posts % at 10 AM'
                    and link like '/marketing?tab=social&post=%' and body = 'It goes to Facebook and Instagram. Change or cancel it before then.'),
  'the office with the marketing area hears when it goes');
select tsp.check(private.auto_post_when(now() + interval '1 day', 'UTC') like 'tomorrow at %'
                 and private.auto_post_when(timestamptz '2027-03-04 15:00+00', 'America/New_York') = 'Mar 4 at 10 AM'
                 and private.auto_post_when(timestamptz '2027-03-04 18:30+00', 'America/New_York') = 'Mar 4 at 1:30 PM',
  'its day is said as Marketing → Social lists it: a date past tomorrow, never a weekday that could be weeks out');
select tsp.check(not exists (select 1 from public.notifications where kind = 'social_scheduled' and user_id = :'dot'), 'not office staff without the area');

-- A cancelled automatic post frees its slot, but its review is never scheduled again.
update public.social_posts set status = 'cancelled' where id = (tsp.auto_post(:'co', 'r2')).id;
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tsp.item('r5', 5, now() - interval '1 hour', 'Wonderful again')));
commit;
select tsp.check((tsp.auto_post(:'co', 'r5')).scheduled_for = tsp.slot(0, '13:00'), 'a cancelled post''s slot is taken by the next review');
delete from public.reviews where company_id = :'co' and review_id = 'r2';
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tsp.item('r2', 5, now() - interval '1 hour', 'Very happy with the crew')));
commit;
select tsp.check((select count(*) from public.social_posts where company_id = :'co' and review_key = 'locations/9/r2') = 1, 'but its review isn''t posted automatically again');

-- No network ready: nothing is scheduled.
update public.integrations set settings = '{}' where company_id = :'co' and provider = 'meta';
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tsp.item('r6', 5, now() - interval '1 hour', 'Lovely work')));
commit;
select tsp.check(tsp.auto_post(:'co', 'r6') is null, 'a review that comes in with no network ready isn''t scheduled');
update public.integrations set settings = '{"page_id": "100"}' where company_id = :'co' and provider = 'meta';

-- A re-import after changing location away and back is no news.
begin;
set local role service_role;
select public.set_review_location(:'co', 'accounts/1', 'locations/10');
select public.set_review_location(:'co', 'accounts/1', 'locations/9');
select public.claim_review_sync(:'co') as claim2 \gset
select public.record_reviews(:'co', :'claim2', 'locations/9', jsonb_build_array(tsp.item('r7', 5, now() - interval '1 hour', 'Great again')));
commit;
select tsp.check(tsp.auto_post(:'co', 'r7') is null, 'reviews brought in again after changing location aren''t posted');

-- Turning it off cancels the automatic posts still scheduled, and says how many.
begin;
set local role service_role;
select tsp.check((public.social_set_auto(:'co', false, '{facebook}') ->> 'cancelled')::int = 4, 'turning automatic posts off cancels the ones scheduled, and says how many');
commit;
select tsp.check(not exists (select 1 from public.social_posts where company_id = :'co' and automatic and status = 'scheduled'), 'none is left scheduled');
update public.review_syncs set first_synced_at = now() - interval '1 day' where company_id = :'co';
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim2', 'locations/9', jsonb_build_array(tsp.item('r8', 5, now() - interval '1 hour', 'Another great job')));
commit;
select tsp.check(tsp.auto_post(:'co', 'r8') is null, 'and with them off, a new 5-star review isn''t scheduled');

-- Google is ready only signed in, at the location in use, with nothing in the way but a passing error.
insert into public.integrations (company_id, provider, status, settings) values (:'co', 'google_business', 'connected', '{"location": "locations/9"}');
select tsp.check(private.social_network_ready(:'co', 'google'), 'Google Business Profile at the location in use is ready to post to');
update public.review_syncs set problem = 'error' where company_id = :'co';
select tsp.check(private.social_network_ready(:'co', 'google'), 'and stays ready through a passing error');
update public.review_syncs set problem = 'approval' where company_id = :'co';
select tsp.check(not private.social_network_ready(:'co', 'google'), 'but not while Google hasn''t approved it');
update public.review_syncs set problem = null where company_id = :'co';
update public.integrations set settings = '{"location": "locations/10"}' where company_id = :'co' and provider = 'google_business';
select tsp.check(not private.social_network_ready(:'co', 'google'), 'nor signed in at another location');
begin;
set local role service_role;
select public.social_set_auto(:'co', true, '{facebook,google}');
select public.record_reviews(:'co', :'claim2', 'locations/9', jsonb_build_array(tsp.item('r9', 5, now() - interval '1 hour', 'Neat and quick')));
commit;
select tsp.check((tsp.auto_post(:'co', 'r9')).networks = '{facebook}', 'so an automatic post leaves it out');
update public.integrations set settings = '{"location": "locations/9"}' where company_id = :'co' and provider = 'google_business';
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim2', 'locations/9', jsonb_build_array(tsp.item('r10', 5, now() - interval '1 hour', 'Super friendly')));
commit;
select tsp.check((tsp.auto_post(:'co', 'r10')).networks = '{facebook,google}', 'and takes it in once it''s ready');

-- A review already posted by hand isn't posted automatically.
insert into public.social_posts (company_id, source, review_key, caption, networks, status, created_by)
values (:'co', 'review', 'locations/9/r11', 'Thanks!', '{facebook}', 'posted', :'oli');
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim2', 'locations/9', jsonb_build_array(tsp.item('r11', 5, now() - interval '1 hour', 'Top notch')));
commit;
select tsp.check(tsp.auto_post(:'co', 'r11') is null and (select count(*) from public.social_posts where company_id = :'co' and review_key = 'locations/9/r11') = 1,
  'a review already posted by hand gets no automatic post');
begin;
set local role service_role;
select public.social_set_auto(:'co', false, '{facebook}');
commit;

-- ===== Facebook & Instagram's sign-in ==========================================================
begin;
set local role service_role;
select tsp.check(public.note_meta_access(:'co', 'signin', 'Facebook & Instagram needs signing in again', 'Posts stop.'), 'a sign-in that stopped tells owners and admins who connect apps');
select tsp.check(not public.note_meta_access(:'co', 'signin', 'Facebook & Instagram needs signing in again', 'Posts stop.'), 'once');
commit;
select tsp.check((select count(*) = 1 from public.notifications where title = 'Facebook & Instagram needs signing in again' and user_id = :'mia')
                 and not exists (select 1 from public.notifications where title = 'Facebook & Instagram needs signing in again' and user_id = :'oli')
                 and (select settings ->> 'access_notice' = 'signin' from public.integrations where company_id = :'co' and provider = 'meta'),
  'and it''s recorded as told');
begin;
set local role service_role;
select tsp.check(not public.note_meta_access(:'co', 'ok'), 'fine again says nothing');
commit;
select tsp.check((select not settings ? 'access_notice' from public.integrations where company_id = :'co' and provider = 'meta'), 'but clears what was told');
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": false}') where id = :'co';
begin;
set local role service_role;
select tsp.check(not public.note_meta_access(:'co', 'signin', 'Facebook & Instagram needs signing in again', 'Posts stop.'), 'nothing is told while Marketing is off');
commit;
select tsp.check((select not settings ? 'access_notice' from public.integrations where company_id = :'co' and provider = 'meta')
                 and (select count(*) = 1 from public.notifications where title = 'Facebook & Instagram needs signing in again'),
  'nor recorded as told, so it''s told once Marketing is back');
update public.companies set settings = jsonb_set(settings, '{marketing}', '{"enabled": true}') where id = :'co';
begin;
set local role service_role;
select tsp.check(public.note_meta_access(:'co', 'signin', 'Facebook & Instagram needs signing in again', 'Posts stop.'), 'and it is');
commit;

-- ===== Notifications ==========================================================================
select tsp.check((select pg_get_expr(d.adbin, d.adrelid) like '%social%' from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                   where d.adrelid = 'public.notification_prefs'::regclass and a.attname = 'push'),
  'social posts are a notification topic, on by default');
select tsp.check(tsp.error_of(format($$insert into public.notification_prefs (company_id, user_id, email, sms, push) values (%L, %L, '{social}', '{}', '{social}')$$, :'co', :'oli')) = 'none',
  'which people can choose');
