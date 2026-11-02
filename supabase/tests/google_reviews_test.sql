-- Database tests for Google reviews (20261031000300_google_reviews.sql, 20261031000310_review_notifications.sql,
-- 20261031000320_review_stats.sql, 20261031000330_google_review_fixes.sql,
-- 20261031000340_review_match_choices.sql): names folded the same way whatever the locale, and the
-- client form still writing clients; who reads reviews (office staff with the marketing area of their
-- own company) and that only the server writes them or reads the sync; one sync at a time, and pages
-- of reviews recorded as new, changed or same, odd values cleaned, a reply written here kept from an
-- older page; matching by name (the whole name, or "Ana S." with an ask, the asked client first,
-- nobody when two fit, never an anonymous reviewer, a client matched once, "Not this client" kept); a
-- match stopping reminders and asks at once and an undo lifting it; deletions only for reviews Google
-- says are gone, saying whose stop they lifted; the location's reviews kept to one location, with the
-- office's matches and "Not this client" outliving reviews removed and taken up when they come back;
-- disconnecting; which companies are due; telling the office once, and only of news, and nobody while
-- Marketing is off; the reviews notification topic; and the Reviews tab's numbers.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema tgr;
grant usage on schema tgr to authenticated, service_role;
create function tgr.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
-- The error a statement raises, as "SQLSTATE: message" ('none' when it doesn't).
create function tgr.error_of(p_sql text) returns text language plpgsql as $$
begin
  begin execute p_sql; exception when others then return sqlstate || ': ' || sqlerrm; end;
  return 'none';
end $$;
create function tgr.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true)
$$;
-- A review as the server sends it to record_reviews.
create function tgr.item(p_id text, p_name text, p_rating int, p_posted timestamptz, p_comment text default null, p_reply text default null,
  p_anonymous boolean default false, p_updated timestamptz default null) returns jsonb language sql as $$
  select jsonb_build_object('review_id', p_id, 'external_name', 'accounts/1/locations/9/reviews/' || p_id, 'reviewer_name', p_name,
    'reviewer_photo_url', 'https://lh3.googleusercontent.com/a/' || p_id, 'reviewer_anonymous', p_anonymous, 'rating', p_rating,
    'comment', p_comment, 'posted_at', p_posted, 'google_updated_at', coalesce(p_updated, p_posted),
    'reply_comment', p_reply, 'reply_updated_at', case when p_reply is not null then coalesce(p_updated, p_posted) + interval '1 day' end)
$$;
create function tgr.review(p_company uuid, p_id text) returns public.reviews language sql as $$
  select * from public.reviews where company_id = p_company and review_id = p_id
$$;
grant execute on all functions in schema tgr to authenticated, service_role;

\set mia 'f6100000-0000-0000-0000-000000000001'
\set oli 'f6100000-0000-0000-0000-000000000002'
\set dot 'f6100000-0000-0000-0000-000000000003'
\set eve 'f6100000-0000-0000-0000-000000000004'
\set cal 'f6100000-0000-0000-0000-000000000005'
\set gus 'f6100000-0000-0000-0000-000000000006'
\set oz 'f6100000-0000-0000-0000-000000000007'
-- One moment the reviews are written from, so a review sent again is the same review.
select now() as t0 \gset

-- Mia owns Maple Lawn; Oli is office; Dot is office as a Dispatcher without the marketing area; Eve
-- estimates; Cal is on a crew; Gus is an admin whose role has marketing but not apps. Oz owns
-- another business.
insert into auth.users (id, email, raw_user_meta_data) values
  (:'mia', 'mia@maple.test', '{"full_name": "Mia Owner"}'),
  (:'oli', 'oli@maple.test', '{"full_name": "Oli Office"}'),
  (:'dot', 'dot@maple.test', '{"full_name": "Dot Dispatch"}'),
  (:'eve', 'eve@maple.test', '{"full_name": "Eve Estimator"}'),
  (:'cal', 'cal@maple.test', '{"full_name": "Cal Crew"}'),
  (:'gus', 'gus@maple.test', '{"full_name": "Gus Marketing"}'),
  (:'oz', 'oz@other.test', '{"full_name": "Oz Other"}');

begin;
set local role authenticated;
select tgr.as_user(:'oz');
select public.create_company('Other Lawn', 'lawn_care') as other \gset
insert into public.clients (company_id, display_name) values (:'other', 'Olga Other') returning id as olga \gset
commit;

begin;
set local role authenticated;
select tgr.as_user(:'mia');
select public.create_company('Maple Lawn', 'lawn_care') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Dispatcher', 'office', '{schedule,sales}') returning id as dispatcher \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Marketer', 'admin', '{marketing,reports}') returning id as marketer \gset
insert into public.memberships (company_id, user_id, role) values (:'co', :'oli', 'office'), (:'co', :'eve', 'estimator'), (:'co', :'cal', 'field_crew');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', :'dot', 'office', :'dispatcher'), (:'co', :'gus', 'admin', :'marketer');
-- Written as the client form writes them, signed in: the generated name columns are filled in.
insert into public.clients (company_id, display_name, email) values (:'co', 'Ana Smith', 'ana@example.test') returning id as ana \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Ana Smith', 'ana.two@example.test') returning id as ana2 \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Bob Jones', 'bob@example.test') returning id as bob \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Cara Lee', 'cara@example.test') returning id as cara \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Éric Núñez', 'eric@example.test') returning id as eric \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Dan Old', 'dan@example.test') returning id as dan \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Fay Link', 'fay@example.test') returning id as fay \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Gil Fail', 'gil@example.test') returning id as gil \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Hal Zoe', 'hal@example.test') returning id as hal \gset
insert into public.clients (company_id, display_name, email) values (:'co', 'Zoë Quinn', 'zoe@example.test') returning id as zoe \gset
update public.clients set display_name = 'Zoë Quinn-Ávila' where id = :'zoe';
commit;
update public.companies set timezone = 'America/New_York' where id = :'co';

-- ===== Names ===============================================================================
select tgr.check(bool_and(private.name_key(name) is not distinct from want), 'names fold to plain letters' ||
                 coalesce(', but not ' || string_agg(name, ' | ') filter (where private.name_key(name) is distinct from want), ''))
  from (values
    ('Ana Smith', 'ana smith'), ('  ANA   SMITH ', 'ana smith'), ('O’Brien-Núñez, Éric', 'obrien nunez eric'), ('ÉRIC Ñúñez', 'eric nunez'),
    (E'Éric', 'eric'), ('Ana S.', 'ana s'), ('Straße Æsir Œuvre', 'strasse aesir oeuvre'), ('Łukasz Dvořák', 'lukasz dvorak'),
    ('Mike''s Pizza & Co.', 'mikes pizza co'), ('İsmail Işık', 'ismail isik'), ('', null), ('...', null), (null, null)
  ) t(name, want);
select tgr.check(private.name_short('Ana Maria Smith') = 'ana s' and private.name_short('Ana') is null and private.name_short('ÉRIC NÚÑEZ') = 'eric n',
  'a client''s short name is the first name and the last initial');
select tgr.check((select prosrc !~* 'lower\(|upper\(|\[\[:' from pg_proc where oid = 'private.name_key(text)'::regprocedure),
  'and the folding doesn''t depend on the locale');
select tgr.check((select name_key = 'zoe quinn avila' and name_short = 'zoe a' from public.clients where id = :'zoe'),
  'a client added and renamed signed in has its name keys, kept up to date');
select tgr.check(not exists (select 1 from public.clients where name_key is distinct from private.name_key(display_name)),
  'every client already here has its name key');
select tgr.check(has_function_privilege('authenticated', 'private.name_key(text)', 'execute') and has_function_privilege('authenticated', 'private.name_short(text)', 'execute'),
  'and the people who write clients can run the name keys');

-- ===== Asks to match against ================================================================
-- Ana (one of two) was asked last week; Cara by email ten days ago; Dan 200 days ago; Fay's copied
-- link was never opened; Gil's ask failed; Hal's copied link was opened.
insert into public.review_requests (company_id, client_id, channel, sent_at) values (:'co', :'ana', 'email', now() - interval '7 days') returning id as ana_ask \gset
insert into public.review_requests (company_id, client_id, channel, sent_at, next_reminder_at) values (:'co', :'cara', 'email', now() - interval '10 days', now() + interval '1 day') returning id as cara_ask \gset
insert into public.review_requests (company_id, client_id, channel, sent_at) values (:'co', :'dan', 'email', now() - interval '200 days');
insert into public.review_requests (company_id, client_id, channel, sent_at) values (:'co', :'fay', 'link', now() - interval '5 days');
insert into public.review_requests (company_id, client_id, channel, status, sent_at) values (:'co', :'gil', 'email', 'failed', now() - interval '5 days');
insert into public.review_requests (company_id, client_id, channel, status, sent_at, clicked_at) values (:'co', :'hal', 'link', 'clicked', now() - interval '5 days', now() - interval '4 days') returning id as hal_ask \gset
-- Bob has reminders still to come from an ask a while ago (not lately enough to count for a "Bob J." name).
insert into public.review_requests (company_id, client_id, channel, sent_at, next_reminder_at) values (:'co', :'bob', 'email', now() - interval '250 days', now() + interval '1 day') returning id as bob_ask \gset

-- ===== One sync at a time ====================================================================
begin;
set local role service_role;
select public.set_review_location(:'co', 'accounts/1', 'locations/9');
select public.claim_review_sync(:'co') as claim \gset
select tgr.check(:'claim' <> '', 'a worker claims the company''s sync');
select tgr.check(public.claim_review_sync(:'co') is null, 'and nobody else can while it''s held');
commit;
update public.review_syncs set locked_until = now() - interval '1 second' where company_id = :'co';
begin;
set local role service_role;
select public.claim_review_sync(:'co') as claim \gset
select tgr.check(:'claim' <> '', 'it comes back once the hold runs out');
select tgr.check(tgr.error_of(format('select public.record_reviews(%L, gen_random_uuid(), ''locations/9'', ''[]'')', :'co')) like '55000:%',
  'a worker that lost the claim can''t record reviews');
select tgr.check(tgr.error_of(format('select public.record_reviews(%L, %L, ''locations/8'', ''[]'')', :'co', :'claim')) like '55000:%',
  'nor reviews of a location that isn''t the one picked');
commit;
update public.review_syncs set locked_until = now() + interval '1 minute' where company_id = :'co';

-- ===== Recording a page ======================================================================
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(
  tgr.item('r-ana', 'Ana S.', 5, :'t0'::timestamptz - interval '2 days', 'Great job on the lawn!'),
  tgr.item('r-bob', 'Bob Jones', 4, :'t0'::timestamptz - interval '20 days'),
  tgr.item('r-cara', 'Cara L.', 2, :'t0'::timestamptz - interval '3 days', 'Missed a spot.'),
  tgr.item('r-anon', 'A Google User', 5, :'t0'::timestamptz - interval '1 day', null, null, true),
  tgr.item('r-eric', 'ÉRIC NÚÑEZ', 5, :'t0'::timestamptz - interval '30 days'),
  tgr.item('r-dan', 'Dan O.', 3, :'t0'::timestamptz - interval '1 day'),
  tgr.item('r-fay', 'Fay L.', 4, :'t0'::timestamptz - interval '1 day'),
  tgr.item('r-gil', 'Gil F.', 4, :'t0'::timestamptz - interval '1 day'),
  tgr.item('r-hal', 'Hal Z.', 5, :'t0'::timestamptz - interval '1 day', null, 'Thanks Hal!')
)) as first_page \gset
commit;
select tgr.check(:'first_page' = '{new,new,new,new,new,new,new,new,new}', 'a page of new reviews is recorded as new');
select tgr.check((select locked_until > now() + interval '9 minutes' from public.review_syncs where company_id = :'co'), 'and the page holds the claim longer');
select tgr.check((select count(*) from public.reviews where company_id = :'co' and notify is not null) = 0,
  'the first full sync tells nobody: the office isn''t told of every old review');
select tgr.check((tgr.review(:'co', 'r-hal')).first_replied_at = (tgr.review(:'co', 'r-hal')).reply_updated_at, 'a reply already there has its time as the first reply');

-- ===== Matching ==============================================================================
select tgr.check((tgr.review(:'co', 'r-ana')).client_id = :'ana' and (tgr.review(:'co', 'r-ana')).match = 'auto'
                 and (tgr.review(:'co', 'r-ana')).review_request_id = :'ana_ask',
  '"Ana S." goes to the Ana Smith who was asked, of the two, and answers her ask');
select tgr.check((tgr.review(:'co', 'r-bob')).client_id = :'bob' and (tgr.review(:'co', 'r-bob')).review_request_id is null,
  'a whole name that fits one client is matched without an ask');
select tgr.check((tgr.review(:'co', 'r-cara')).client_id = :'cara', '"Cara L." is matched with the ask she had');
select tgr.check((tgr.review(:'co', 'r-eric')).client_id = :'eric', 'a name in capitals and accents is matched');
select tgr.check((tgr.review(:'co', 'r-anon')).client_id is null, 'an anonymous reviewer is never matched');
select tgr.check((tgr.review(:'co', 'r-dan')).client_id is null, 'an ask over 180 days before doesn''t count for "Dan O."');
select tgr.check((tgr.review(:'co', 'r-fay')).client_id is null, 'nor a copied link nobody opened');
select tgr.check((tgr.review(:'co', 'r-gil')).client_id is null, 'nor an ask that failed');
select tgr.check((tgr.review(:'co', 'r-hal')).client_id = :'hal', 'and an opened copied link does');
select tgr.check((select reviewed_at from public.review_requests where id = :'ana_ask') = (tgr.review(:'co', 'r-ana')).posted_at
                 and (select reviewed_at from public.review_requests where id = :'cara_ask') is not null,
  'the asks that led to a review are marked');

-- ===== A match stops asks ====================================================================
select tgr.check((select reviewed_at = (tgr.review(:'co', 'r-bob')).posted_at from public.clients where id = :'bob'), 'Bob has left a review');
select tgr.check((select next_reminder_at is null and reminder_note = 'Left a Google review' from public.review_requests where id = :'bob_ask'),
  'which stops the reminders still to come, saying why');
select tgr.check((select next_reminder_at is null and reminder_note = 'Left a Google review' from public.review_requests where id = :'cara_ask'),
  'Cara''s too');
begin;
set local role service_role;
select tgr.check(public.begin_review_request(:'co', :'bob') is null, 'Bob isn''t asked again by hand');
select tgr.check(public.begin_review_request(:'co', :'bob', null, 'email', 182) is null, 'nor automatically');
select tgr.check(public.begin_review_request(:'co', :'dan') is not null, 'and someone who hasn''t reviewed still is');
commit;

begin;
set local role authenticated;
select tgr.as_user(:'mia');
update public.clients set reviewed_at = null, notes = 'Mows Tuesdays' where id = :'bob';
insert into public.clients (company_id, display_name, reviewed_at) values (:'co', 'Ivy New', now()) returning id as ivy \gset
commit;
select tgr.check((select reviewed_at is not null and notes = 'Mows Tuesdays' from public.clients where id = :'bob'),
  'nobody signed in clears it, not even the owner, while their other edits go through');
select tgr.check((select reviewed_at is null from public.clients where id = :'ivy'), 'nor adds a client marked reviewed');

-- Ana Smith #2 can't be matched to "Ana S." too: two reviews of "Ana S." go to the asked Ana once.
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tgr.item('r-ana-again', 'Ana Smith', 4, :'t0'::timestamptz - interval '1 day'))) as again \gset
commit;
select tgr.check((tgr.review(:'co', 'r-ana-again')).client_id = :'ana2',
  'a client already matched to another review isn''t matched again: the other Ana Smith is the one left');

-- Two asked clients of one name: nobody.
insert into public.clients (company_id, display_name) values (:'co', 'Jo Park') returning id as jo1 \gset
insert into public.clients (company_id, display_name) values (:'co', 'Jo Park') returning id as jo2 \gset
insert into public.review_requests (company_id, client_id, channel, sent_at) values (:'co', :'jo1', 'email', now() - interval '3 days'), (:'co', :'jo2', 'sms', now() - interval '4 days');
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tgr.item('r-jo', 'Jo Park', 5, :'t0'::timestamptz - interval '1 day'))) as jo \gset
commit;
select tgr.check((tgr.review(:'co', 'r-jo')).client_id is null, 'two asked clients of the same name leave the review for the office to match');

-- ===== By hand ===============================================================================
select (tgr.review(:'co', 'r-bob')).id as bob_review \gset
select (tgr.review(:'co', 'r-jo')).id as jo_review \gset
begin;
set local role service_role;
select tgr.check(tgr.error_of(format('select public.set_review_client(%L, %L, %L, %L)', :'co', :'jo_review', :'olga', :'mia')) like 'P0002:%',
  'a review can''t be matched to another business''s client');
select tgr.check(tgr.error_of(format('select public.set_review_client(%L, %L, %L, %L)', :'other', :'jo_review', :'olga', :'oz')) like 'P0002:%',
  'nor changed by another business');
select public.set_review_client(:'co', :'jo_review', :'jo1', :'mia') as jo_match \gset
select public.set_review_client(:'co', :'bob_review', null, :'mia') as bob_undo \gset
commit;
select tgr.check((tgr.review(:'co', 'r-jo')).client_id = :'jo1' and (tgr.review(:'co', 'r-jo')).match = 'hand'
                 and (tgr.review(:'co', 'r-jo')).review_request_id is not null,
  'the office matches a review by hand, and the ask it answers is found the same way');
select tgr.check((:'bob_undo'::jsonb ->> 'lifted_client') = :'bob', '"Not this client" says whose asks can go again');
select tgr.check((select reviewed_at is null from public.clients where id = :'bob') and (tgr.review(:'co', 'r-bob')).match_cleared_at is not null,
  'and lifts Bob''s stop');
begin;
set local role service_role;
select tgr.check(public.begin_review_request(:'co', :'bob') is not null, 'so Bob can be asked again');
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tgr.item('r-bob', 'Bob Jones', 4, :'t0'::timestamptz - interval '20 days'))) as bob_again \gset
commit;
select tgr.check(:'bob_again' = '{same}' and (tgr.review(:'co', 'r-bob')).client_id is null,
  'and syncing again doesn''t match the review he said isn''t his');
select tgr.check((select count(*) from public.review_match_choices where company_id = :'co') = 2, 'both choices are kept apart from the reviews');
-- As the migration found the choices made before it.
delete from public.review_match_choices where company_id = :'co';
select private.backfill_review_choices() as backfilled \gset
select tgr.check(:'backfilled' = '2'
                 and (select client_id = :'jo1' from public.review_match_choices where company_id = :'co' and review_id = 'r-jo')
                 and (select client_id is null from public.review_match_choices where company_id = :'co' and review_id = 'r-bob'),
  'choices made before they were kept apart are found from the reviews: the match by hand and "Not this client"');
select tgr.check(private.backfill_review_choices() = 0, 'and run again, it adds nothing');

-- ===== Changes, odd values and the same review elsewhere =====================================
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(
  tgr.item('r-eric', 'ÉRIC NÚÑEZ', 5, :'t0'::timestamptz - interval '30 days'),
  tgr.item('r-hal', 'Hal Z.', 5, :'t0'::timestamptz - interval '1 day', null, 'Thanks so much, Hal!'),
  jsonb_build_object('review_id', 'r-odd', 'external_name', 'accounts/1/locations/9/reviews/r-odd', 'reviewer_name', repeat('N', 300),
    'reviewer_photo_url', 'http://example.test/me.png', 'rating', 7, 'comment', repeat('x', 25000), 'posted_at', now() - interval '40 days'),
  jsonb_build_object('review_id', 'r-slash', 'external_name', 'accounts/1/locations/9/reviews/r-slash', 'reviewer_name', 'Kim',
    'reviewer_photo_url', '//lh3.googleusercontent.com/a/kim', 'rating', 4, 'posted_at', now() - interval '40 days')
)) as changes \gset
commit;
select tgr.check(:'changes' = '{same,changed,new,new}', 'unchanged is same, a changed reply is changed, and odd values are still new');
select tgr.check((tgr.review(:'co', 'r-hal')).first_replied_at < (tgr.review(:'co', 'r-hal')).reply_updated_at
                 or (tgr.review(:'co', 'r-hal')).first_replied_at = (tgr.review(:'co', 'r-hal')).reply_updated_at,
  'an edited reply keeps the time of the first one');

-- A reply written here just after Google gave a page, as the server writes one (postReply, removeReply).
select (tgr.review(:'co', 'r-hal')).first_replied_at as hal_first \gset
update public.reviews set reply_comment = 'Thanks, Hal. See you in spring!', reply_updated_at = :'t0'::timestamptz + interval '1 hour', replied_by = :'mia', reply_written_at = now()
 where company_id = :'co' and review_id = 'r-hal';
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tgr.item('r-hal', 'Hal Z.', 5, :'t0'::timestamptz - interval '1 day', null, 'Thanks so much, Hal!')),
  now() - interval '30 seconds') as older \gset
commit;
select tgr.check(:'older' = '{same}' and (tgr.review(:'co', 'r-hal')).reply_comment = 'Thanks, Hal. See you in spring!' and (tgr.review(:'co', 'r-hal')).replied_by = :'mia',
  'a page Google gave before a reply was written here doesn''t put the old one back, or lose who wrote it');
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tgr.item('r-hal', 'Hal Z.', 5, :'t0'::timestamptz - interval '1 day', null, 'Thanks, Hal. See you in spring!')),
  now() + interval '2 minutes') as later_page \gset
commit;
select tgr.check(:'later_page' = '{changed}' and (tgr.review(:'co', 'r-hal')).reply_updated_at = :'t0'::timestamptz and (tgr.review(:'co', 'r-hal')).replied_by = :'mia',
  'a later page takes Google''s time for it, and keeps who wrote the same words');
update public.reviews set reply_comment = null, reply_updated_at = null, first_replied_at = null, replied_by = null, reply_written_at = now()
 where company_id = :'co' and review_id = 'r-hal';
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tgr.item('r-hal', 'Hal Z.', 5, :'t0'::timestamptz - interval '1 day', null, 'Thanks so much, Hal!')),
  now() - interval '30 seconds') as deleted_here \gset
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tgr.item('r-hal', 'Hal Z.', 5, :'t0'::timestamptz - interval '1 day', null, 'Thanks so much, Hal!')),
  now() + interval '2 minutes') as replied_on_google \gset
commit;
select tgr.check(:'deleted_here' = '{same}' and :'replied_on_google' = '{changed}', 'a reply deleted here stays deleted for an older page, and comes back from a later one');
select tgr.check((tgr.review(:'co', 'r-hal')).reply_comment = 'Thanks so much, Hal!' and (tgr.review(:'co', 'r-hal')).replied_by is null
                 and (tgr.review(:'co', 'r-hal')).first_replied_at = :'t0'::timestamptz,
  'as one made in Google''s own app');
select tgr.check((select length(reviewer_name) = 200 and reviewer_photo_url is null and rating is null and length(comment) = 20000 from public.reviews where review_id = 'r-odd'),
  'a long name and comment are cut short, and an http photo and a rating out of range are left out');
select tgr.check((tgr.review(:'co', 'r-slash')).reviewer_photo_url = 'https://lh3.googleusercontent.com/a/kim', 'a photo address without its https: gets it');
select tgr.check(tgr.error_of(format('update public.reviews set rating = 6 where company_id = %L and review_id = ''r-bob''', :'co')) like '23514:%',
  'stars are 1 to 5');
update public.review_syncs set location_id = 'locations/9' where company_id = :'other';
insert into public.review_syncs (company_id, location_id, claim, locked_until) values (:'other', 'locations/9', 'f6100000-0000-0000-0000-0000000000aa', now() + interval '1 minute')
  on conflict (company_id) do update set location_id = excluded.location_id, claim = excluded.claim, locked_until = excluded.locked_until;
begin;
set local role service_role;
select public.record_reviews(:'other', 'f6100000-0000-0000-0000-0000000000aa', 'locations/9', jsonb_build_array(tgr.item('r-bob', 'Bob Jones', 1, :'t0'::timestamptz - interval '20 days'))) as elsewhere \gset
commit;
select tgr.check(:'elsewhere' = '{new}' and (select count(*) from public.reviews where review_id = 'r-bob') = 2,
  'the same review can belong to two businesses');

-- ===== Reading reviews =======================================================================
create table tgr.seen (who text primary key, n bigint);
grant all on tgr.seen to authenticated;
begin;
set local role authenticated;
select tgr.as_user(:'oli');
insert into tgr.seen select 'oli', count(*) from public.reviews;
select tgr.as_user(:'mia');
insert into tgr.seen select 'mia', count(*) from public.reviews;
select tgr.as_user(:'dot');
insert into tgr.seen select 'dot', count(*) from public.reviews;
select tgr.as_user(:'eve');
insert into tgr.seen select 'eve', count(*) from public.reviews;
select tgr.as_user(:'cal');
insert into tgr.seen select 'cal', count(*) from public.reviews;
select tgr.as_user(:'oz');
insert into tgr.seen select 'oz', count(*) from public.reviews;
select tgr.as_user(:'mia');
select tgr.check(tgr.error_of(format('insert into public.reviews (company_id, location_id, review_id, external_name, posted_at, google_updated_at) values (%L, ''locations/9'', ''x'', ''x'', now(), now())', :'co')) like '42501:%',
  'nobody signed in adds a review');
select tgr.check(tgr.error_of(format('update public.reviews set comment = ''Changed'' where company_id = %L', :'co')) like '42501:%', 'or changes one');
select tgr.check(tgr.error_of(format('delete from public.reviews where company_id = %L', :'co')) like '42501:%', 'or deletes one');
select tgr.check(tgr.error_of('select * from public.review_syncs') like '42501:%', 'or reads the sync');
select tgr.check(tgr.error_of('select * from public.review_match_choices') like '42501:%', 'or the office''s match choices');
commit;
select tgr.check((select n from tgr.seen where who = 'oli') = (select count(*) from public.reviews where company_id = :'co') and (select n from tgr.seen where who = 'mia') > 0,
  'the office with the marketing area reads the company''s reviews');
select tgr.check((select n from tgr.seen where who = 'dot') = 0, 'office staff without the marketing area read none');
select tgr.check((select n from tgr.seen where who = 'eve') = 0 and (select n from tgr.seen where who = 'cal') = 0, 'nor estimators or crews');
select tgr.check((select n from tgr.seen where who = 'oz') = 1, 'and another business reads only its own');
select tgr.check(bool_and(not has_function_privilege(r, f, 'execute')), 'only the server runs the sync''s functions')
  from unnest(array['anon', 'authenticated']) r,
       unnest(array['public.claim_review_sync(uuid, integer)', 'public.record_reviews(uuid, uuid, text, jsonb, timestamptz)', 'public.mark_deleted_reviews(uuid, uuid, text, uuid[])',
                    'public.set_review_client(uuid, uuid, uuid, uuid)', 'public.set_review_location(uuid, text, text)', 'public.end_review_sync(uuid, boolean)',
                    'public.review_syncs_due(integer)', 'public.claim_review_notices(uuid, uuid)', 'public.note_review_access(uuid, uuid, text, text, text)',
                    'private.marketing_office(uuid)', 'private.apps_admins(uuid)', 'private.review_match(uuid)', 'private.unreviewed(uuid[])',
                    'private.review_take_choice()']) f;

-- ===== Telling the office ====================================================================
select tgr.check(array(select private.marketing_office(:'co') order by 1) = array[:'mia', :'oli', :'gus']::uuid[]
                   or (select array_agg(u order by u) from private.marketing_office(:'co') u) = (select array_agg(u order by u) from unnest(array[:'mia', :'oli', :'gus']::uuid[]) u),
  'the marketing office is the owner, office staff and admins with the area, not a dispatcher, estimator or crew');
begin;
set local role service_role;
select tgr.check(public.note_review_access(:'co', :'claim', 'in', 'Your Google reviews are in: 13 reviews, 4.3 average', 'See them in Marketing → Reviews.'),
  'the first full pass finishing tells the office');
select tgr.check(not public.note_review_access(:'co', :'claim', 'in', 'Again', null), 'once');
commit;
select tgr.check((select first_synced_at is not null from public.review_syncs where company_id = :'co'), 'and records it finished');
select tgr.check((select count(*) from public.notifications where company_id = :'co' and kind = 'review_access') = 3
                 and not exists (select 1 from public.notifications where company_id = :'co' and kind = 'review_access' and user_id in (:'dot', :'eve', :'cal')),
  'the people with the marketing area hear');

begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(
  tgr.item('r-new', 'Lou New', 5, :'t0'::timestamptz - interval '1 day', 'Lovely work'),
  tgr.item('r-low', 'Max Low', 1, :'t0'::timestamptz - interval '2 days', 'Never showed up.'),
  tgr.item('r-old', 'Ned Old', 5, :'t0'::timestamptz - interval '40 days'),
  tgr.item('r-eric', 'ÉRIC NÚÑEZ', 1, :'t0'::timestamptz - interval '30 days', 'Changed my mind', null, false, :'t0'::timestamptz - interval '1 hour')
)) as later \gset
select tgr.check(public.claim_review_notices(:'co', gen_random_uuid()) = 0, 'a worker without the claim tells nobody');
select public.claim_review_notices(:'co', :'claim') as told \gset
select tgr.check(public.claim_review_notices(:'co', :'claim') = 0, 'and each review is told once');
commit;
select tgr.check(:told = 3, 'new reviews from the last 14 days, and one changed down to 1 star, tell the office');
select tgr.check((tgr.review(:'co', 'r-old')).notify is null, 'a review posted before then doesn''t');
select tgr.check((select array_agg(kind || ': ' || title order by title) from public.notifications where user_id = :'oli' and kind like 'review%' and kind <> 'review_access')
                   = '{"review: Lou New left a 5-star review","review_low: Max Low left a 1-star review","review_low: ÉRIC NÚÑEZ changed their review to 1 star"}',
  'in plain words, low ratings as review_low');
select tgr.check((select body = 'Never showed up.' and link = '/marketing?tab=reviews&review=' || (tgr.review(:'co', 'r-low')).id
                    from public.notifications where user_id = :'oli' and title like 'Max Low%'),
  'with what they wrote and a link to the review');
select tgr.check(not exists (select 1 from public.notifications where user_id in (:'dot', :'eve', :'cal') and kind like 'review%'),
  'only to people with the marketing area');

-- A review deleted on Google and brought back isn't news.
update public.reviews set deleted_at = now() where company_id = :'co' and review_id = 'r-new';
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tgr.item('r-new', 'Lou New', 5, :'t0'::timestamptz - interval '1 day', 'Lovely work'))) as back \gset
select tgr.check(public.claim_review_notices(:'co', :'claim') = 0, 'a review coming back tells nobody again');
commit;
select tgr.check(:'back' = '{changed}' and (tgr.review(:'co', 'r-new')).deleted_at is null, 'and it''s shown again');

begin;
set local role service_role;
select tgr.check(public.note_review_access(:'co', :'claim', 'signin', 'Google sign-in expired', 'Reconnect it in Apps.'), 'a sign-in that needs Reconnect tells someone');
select tgr.check(not public.note_review_access(:'co', :'claim', 'signin', 'Google sign-in expired', null), 'once');
select public.note_review_access(:'co', :'claim', 'ok');
select tgr.check(public.note_review_access(:'co', :'claim', 'signin', 'Google sign-in expired', null), 'and again after it was fixed');
commit;
select tgr.check((select array_agg(distinct user_id) from public.notifications where company_id = :'co' and title = 'Google sign-in expired') = array[:'mia']::uuid[],
  'only owners and admins who connect apps hear about the sign-in');

begin;
set local role service_role;
select tgr.check(public.note_review_access(:'co', :'claim', 'pick', 'Pick the location for your Google reviews', 'Google lets Crewtavo in now.'),
  'Google letting Crewtavo in with a location to pick tells someone');
select tgr.check(not public.note_review_access(:'co', :'claim', 'pick', 'Pick the location for your Google reviews', null), 'once');
commit;
select tgr.check((select array_agg(distinct user_id) from public.notifications where company_id = :'co' and title = 'Pick the location for your Google reviews') = array[:'mia']::uuid[]
                 and (select link from public.notifications where company_id = :'co' and title = 'Pick the location for your Google reviews') = '/apps/google_business',
  'owners and admins who connect apps, with a link to the app');
update public.companies set settings = jsonb_set(settings, '{marketing,enabled}', 'false') where id = :'co';
begin;
set local role service_role;
select tgr.check(not public.note_review_access(:'co', :'claim', 'location', 'Google reviews can''t reach your location', null), 'while Marketing is off, nobody is told');
commit;
select tgr.check((select access_notice = 'pick' from public.review_syncs where company_id = :'co')
                 and not exists (select 1 from public.notifications where company_id = :'co' and title = 'Google reviews can''t reach your location'),
  'and it isn''t recorded as told');
update public.companies set settings = jsonb_set(settings, '{marketing,enabled}', 'true') where id = :'co';
begin;
set local role service_role;
select tgr.check(public.note_review_access(:'co', :'claim', 'location', 'Google reviews can''t reach your location', null), 'so it tells them once Marketing is back');
commit;

-- ===== Deletions =============================================================================
update public.review_syncs set full_started_at = now() where company_id = :'co';
select pg_sleep(0.01);
begin;
set local role service_role;
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(tgr.item('r-ana', 'Ana S.', 5, :'t0'::timestamptz - interval '2 days', 'Great job on the lawn!'))) as seen \gset
select public.mark_deleted_reviews(:'co', :'claim', 'locations/9', array[(tgr.review(:'co', 'r-ana')).id, (tgr.review(:'co', 'r-cara')).id]) as marked \gset
commit;
select tgr.check((:'marked'::jsonb ->> 'marked')::int = 1 and (tgr.review(:'co', 'r-ana')).deleted_at is null and (tgr.review(:'co', 'r-cara')).deleted_at is not null,
  'only a review the full pass didn''t see is marked deleted');
select tgr.check((select reviewed_at is null from public.clients where id = :'cara') and (select reviewed_at is null from public.review_requests where id = :'cara_ask'),
  'and its client can be asked again');
select tgr.check(:'marked'::jsonb -> 'lifted_clients' = jsonb_build_array(:'cara'::uuid)
                 and (select next_reminder_at is null and reminder_note = 'Left a Google review' from public.review_requests where id = :'cara_ask'),
  'saying whose stop it lifted, so the server gives the ask it stopped its reminders back (liftReviewStops)');

-- ===== The Reviews tab's numbers =============================================================
update public.reviews set posted_at = (date_trunc('month', now() at time zone 'UTC') + interval '2 hours') at time zone 'UTC',
  google_updated_at = (date_trunc('month', now() at time zone 'UTC') + interval '2 hours') at time zone 'UTC'
 where company_id = :'co' and review_id = 'r-new';
update public.reviews set first_replied_at = posted_at + interval '10 hours', reply_comment = 'Thanks!' where company_id = :'co' and review_id = 'r-low';
begin;
set local role authenticated;
select tgr.as_user(:'oli');
select public.review_stats(:'co') as stats \gset
select tgr.as_user(:'dot');
select public.review_stats(:'co') as hidden \gset
commit;
select tgr.check((:'stats'::jsonb ->> 'count')::int = (select count(*) from public.reviews where company_id = :'co' and deleted_at is null),
  'the numbers count the location''s live reviews');
select tgr.check((:'stats'::jsonb ->> 'average')::numeric = (select round(avg(rating), 2) from public.reviews where company_id = :'co' and deleted_at is null)
                 and (:'stats'::jsonb -> 'by_stars' ->> '1')::int = 2,
  'with their average and how many of each');
select tgr.check((:'stats'::jsonb ->> 'median_reply_hours')::numeric > 0 and (:'stats'::jsonb ->> 'replied_12m')::int = 2,
  'and the time to reply, from the first reply');
select tgr.check((select jsonb_object_agg(m ->> 'month', (m ->> 'count')::int) from jsonb_array_elements(:'stats'::jsonb -> 'months') m)
                   = (select jsonb_object_agg(month, n) from (
                        select to_char(posted_at at time zone 'America/New_York', 'YYYY-MM') as month, count(*)::int as n from public.reviews
                         where company_id = :'co' and deleted_at is null
                           and posted_at at time zone 'America/New_York' >= date_trunc('month', now() at time zone 'America/New_York') - interval '11 months'
                         group by 1) x)
                 and to_char((tgr.review(:'co', 'r-new')).posted_at at time zone 'UTC', 'YYYY-MM') <> to_char((tgr.review(:'co', 'r-new')).posted_at at time zone 'America/New_York', 'YYYY-MM'),
  'months go by the company''s time zone: a review at 2am on the 1st in UTC is the month before in New York');
select tgr.check((:'stats'::jsonb ->> 'asks_reviewed_12m')::int >= 2 and (:'stats'::jsonb ->> 'asks_12m')::int > (:'stats'::jsonb ->> 'asks_reviewed_12m')::int,
  'and the asks that led to a review');
select tgr.check((:'hidden'::jsonb ->> 'count')::int = 0 and (:'hidden'::jsonb ->> 'asks_12m')::int = 0 and :'hidden'::jsonb -> 'average' = 'null',
  'without the marketing area, all zeros');

-- ===== Clients and asks deleted ==============================================================
-- Cara, a lead with an ask and a matched (live) review, is deleted with her ask.
update public.reviews set deleted_at = null where company_id = :'co' and review_id = 'r-cara';
select tgr.check((select reviewed_at is not null from public.clients where id = :'cara'), 'Cara''s review is back');
delete from public.clients where id = :'cara';
select tgr.check((tgr.review(:'co', 'r-cara')).client_id is null and (tgr.review(:'co', 'r-cara')).match = 'none'
                 and (tgr.review(:'co', 'r-cara')).review_request_id is null and (tgr.review(:'co', 'r-cara')).company_id = :'co',
  'deleting a client who was asked and reviewed leaves the review unmatched');

-- ===== The old stops still work ==============================================================
insert into public.review_requests (company_id, client_id, channel, next_reminder_at) values (:'co', :'dan', 'email', now() + interval '1 day') returning id as dan_ask \gset
update public.clients set review_opt_out = true where id = :'dan';
select tgr.check((select reminder_note = 'They asked not to get review requests' from public.review_requests where id = :'dan_ask'),
  'opting out still stops reminders, with its own note');

-- ===== Picking another location, and disconnecting ===========================================
select (tgr.review(:'co', 'r-ana')).id as ana_review \gset
-- Hal's review was deleted on Google, so his stop was lifted then.
update public.reviews set deleted_at = now() where company_id = :'co' and review_id = 'r-hal';
begin;
set local role service_role;
select tgr.check(public.set_review_location(:'co', 'accounts/77', 'locations/9') = '{"removed": 0, "lifted_clients": []}', 'the same location under another account keeps every review');
select public.set_review_location(:'co', 'accounts/1', 'locations/10') as moved \gset
commit;
select tgr.check((:'moved'::jsonb ->> 'removed')::int > 0 and not exists (select 1 from public.reviews where company_id = :'co'), 'another location removes the old one''s reviews');
select tgr.check((select reviewed_at is null from public.clients where id = :'ana'), 'and their clients can be asked again');
select tgr.check(:'moved'::jsonb -> 'lifted_clients' @> jsonb_build_array(:'ana'::uuid, :'ana2'::uuid, :'eric'::uuid)
                 and not (:'moved'::jsonb -> 'lifted_clients' @> jsonb_build_array(:'hal'::uuid)),
  'saying whose stop they lifted, not a client whose review was already marked deleted');
select tgr.check((select location_id = 'locations/10' and claim is null and first_synced_at is null and next_sync_at <= now() and problem is null
                    from public.review_syncs where company_id = :'co'),
  'syncing starts again from the top, quietly, and a running sync stops');
select tgr.check(exists (select 1 from public.reviews where company_id = :'other'), 'another business''s reviews stay');
select tgr.check((select client_id is null from public.review_match_choices where company_id = :'co' and review_id = 'r-bob')
                 and (select client_id = :'jo1' from public.review_match_choices where company_id = :'co' and review_id = 'r-jo'),
  'the office''s choices outlive the reviews removed: "Not this client" and a match by hand');

-- Back to the first location: its reviews come in again, and the office's choices hold.
begin;
set local role service_role;
select public.set_review_location(:'co', 'accounts/1', 'locations/9');
select public.claim_review_sync(:'co') as claim \gset
select public.record_reviews(:'co', :'claim', 'locations/9', jsonb_build_array(
  tgr.item('r-bob', 'Bob Jones', 4, :'t0'::timestamptz - interval '20 days'),
  tgr.item('r-jo', 'Jo Park', 5, :'t0'::timestamptz - interval '1 day'),
  tgr.item('r-eric', 'ÉRIC NÚÑEZ', 5, :'t0'::timestamptz - interval '30 days'))) as back \gset
commit;
select tgr.check((tgr.review(:'co', 'r-bob')).client_id is null and (tgr.review(:'co', 'r-bob')).match_cleared_at is not null
                 and (select reviewed_at is null from public.clients where id = :'bob'),
  'a review the office said isn''t Bob''s isn''t matched to him again when it comes back, and his asks keep going');
select tgr.check((tgr.review(:'co', 'r-jo')).client_id = :'jo1' and (tgr.review(:'co', 'r-jo')).match = 'hand'
                 and (tgr.review(:'co', 'r-jo')).review_request_id is not null and (select reviewed_at is not null from public.clients where id = :'jo1'),
  'one matched by hand comes back matched by hand, with the ask it answers, and stops Jo''s asks again');
select tgr.check((tgr.review(:'co', 'r-eric')).client_id = :'eric' and (tgr.review(:'co', 'r-eric')).match = 'auto',
  'one nobody chose for is matched automatically, as before');
begin;
set local role service_role;
select public.set_review_client(:'co', (tgr.review(:'co', 'r-bob')).id, :'bob', :'mia');
commit;
select tgr.check((select client_id = :'bob' from public.review_match_choices where company_id = :'co' and review_id = 'r-bob'),
  'a later choice replaces the earlier one');
begin;
set local role service_role;
select public.set_review_client(:'co', (tgr.review(:'co', 'r-bob')).id, null, :'mia');
select public.set_review_location(:'co', 'accounts/1', 'locations/10');
commit;
select tgr.check((select reviewed_at is null from public.clients where id = :'bob') and (select reviewed_at is null from public.clients where id = :'jo1'),
  'and leaving the location again lifts the stops');

begin;
set local role service_role;
select public.claim_review_sync(:'co') as claim \gset
select public.record_reviews(:'co', :'claim', 'locations/10', jsonb_build_array(tgr.item('r-ten', 'Bob Jones', 5, :'t0'::timestamptz - interval '1 day')));
select tgr.check(public.end_review_sync(:'co', false) = '{"removed": 0, "lifted_clients": []}', 'disconnecting can keep the reviews');
commit;
select tgr.check(exists (select 1 from public.reviews where company_id = :'co') and (select reviewed_at is not null from public.clients where id = :'bob')
                 and (select claim is null and next_sync_at is null and location_id = 'locations/10' from public.review_syncs where company_id = :'co'),
  'which keep stopping their clients'' asks, while syncing stops');
begin;
set local role service_role;
select tgr.check(public.end_review_sync(:'co', true) = jsonb_build_object('removed', 1, 'lifted_clients', jsonb_build_array(:'bob'::uuid)), 'or remove them, saying whose stop they lifted');
commit;
select tgr.check(not exists (select 1 from public.reviews where company_id = :'co') and not exists (select 1 from public.review_syncs where company_id = :'co')
                 and (select reviewed_at is null from public.clients where id = :'bob'),
  'and then asks can go again');

-- ===== Who's due =============================================================================
insert into public.integrations (company_id, provider, status) values (:'co', 'google_business', 'connected'), (:'other', 'google_business', 'connected');
delete from public.review_syncs where company_id = :'other';
create function tgr.due(p_company uuid) returns boolean language sql as $$ select p_company in (select public.review_syncs_due(100)) $$;
select tgr.check(tgr.due(:'co') and tgr.due(:'other'), 'a connection with no sync yet is due at once');
insert into public.review_syncs (company_id, next_sync_at) values (:'co', now() + interval '1 minute');
select tgr.check(tgr.due(:'co'), 'and one due within the minute is due now, so a run every 30 minutes doesn''t slip an hour');
update public.review_syncs set next_sync_at = now() + interval '5 minutes' where company_id = :'co';
select tgr.check(not tgr.due(:'co'), 'one due later isn''t');
update public.review_syncs set next_sync_at = now() - interval '1 minute', problem = 'approval' where company_id = :'co';
select tgr.check(tgr.due(:'co'), 'waiting on Google''s approval, with no location yet, it''s tried again');
update public.review_syncs set problem = 'pick' where company_id = :'co';
select tgr.check(not tgr.due(:'co'), 'a location to pick waits for someone to pick it');
update public.review_syncs set problem = 'location' where company_id = :'co';
select tgr.check(not tgr.due(:'co'), 'so does a problem with the location');
update public.review_syncs set problem = null, locked_until = now() + interval '5 minutes' where company_id = :'co';
select tgr.check(not tgr.due(:'co'), 'one being synced isn''t due');
update public.review_syncs set locked_until = null where company_id = :'co';
update public.integrations set status = 'error' where company_id = :'co' and provider = 'google_business';
select tgr.check(not tgr.due(:'co'), 'nor one whose sign-in needs reconnecting');
update public.integrations set status = 'disconnected' where company_id = :'co' and provider = 'google_business';
select tgr.check(not tgr.due(:'co'), 'nor a disconnected one');
update public.integrations set status = 'connected' where company_id = :'co' and provider = 'google_business';
update public.companies set settings = jsonb_set(settings, '{marketing,enabled}', 'false') where id = :'co';
select tgr.check(not tgr.due(:'co'), 'nor while Marketing is uninstalled');
update public.companies set settings = jsonb_set(settings, '{marketing,enabled}', 'true') where id = :'co';
select tgr.check(tgr.due(:'co'), 'and it''s due again once it''s back');

-- ===== The reviews notification topic ========================================================
select tgr.check((select column_default like '%reviews%' from information_schema.columns where table_name = 'notification_prefs' and column_name = 'email')
                 and (select column_default like '%reviews%' from information_schema.columns where table_name = 'notification_prefs' and column_name = 'push')
                 and (select column_default not like '%reviews%' from information_schema.columns where table_name = 'notification_prefs' and column_name = 'sms'),
  'Google reviews come by push and email unless someone turns them off');
insert into public.notification_prefs (company_id, user_id, email, sms, push) values (:'co', :'oli', '{schedule}', '{jobs}', '{chat}');
select tgr.check(private.backfill_review_topic() >= 1, 'people who already chose get Google reviews too');
select tgr.check((select email = '{schedule,reviews}' and sms = '{jobs}' and push = '{chat,reviews}' from public.notification_prefs where company_id = :'co' and user_id = :'oli'),
  'with the rest of their choices as they were');
select tgr.check(private.backfill_review_topic() = 0, 'run again, it changes nothing');
update public.notification_prefs set email = '{reviews}', push = '{}' where company_id = :'co' and user_id = :'oli';
select tgr.check((select email = '{reviews}' from public.notification_prefs where company_id = :'co' and user_id = :'oli'), 'reviews is a topic someone can choose');
select tgr.check(tgr.error_of(format('update public.notification_prefs set email = ''{google}'' where company_id = %L', :'co')) like '23514:%',
  'and unknown topics are still refused');

-- ===== Done ================================================================================
delete from public.companies where id in (:'co', :'other');

set client_min_messages = warning;
drop schema tgr cascade;
reset client_min_messages;

\o
\echo 'All Google review tests passed.'
