-- Database tests for website forms: only owners and admins who connect apps install it, the first
-- install makes a form with a random address that emails the business, only they see and change its
-- forms, and a message finds the client it's from by email or phone (changing nothing about them),
-- or makes a new lead, and lands in Requests.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema wft;
grant usage on schema wft to authenticated, service_role;
create function wft.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function wft.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema wft to authenticated, service_role;

-- Ana owns Pine Lawn; Bo is office; Gus is an admin whose role doesn't connect apps. Ed owns another business.
insert into auth.users (id, email, raw_user_meta_data) values
  ('aa220000-0000-0000-0000-000000000001', 'ana@pine.test', '{"full_name": "Ana Pine"}'),
  ('aa220000-0000-0000-0000-000000000002', 'bo@pine.test', '{"full_name": "Bo Rivers"}'),
  ('aa220000-0000-0000-0000-000000000003', 'gus@pine.test', '{"full_name": "Gus Hale"}'),
  ('aa220000-0000-0000-0000-000000000009', 'ed@oak.test', '{"full_name": "Ed Oak"}');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select public.create_company('Oak Snow', 'general') as other \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Pine Lawn', 'lawn_care', 'America/Chicago') as co \gset
insert into public.company_roles (company_id, name, base_role, permissions) values (:'co', 'Bookkeeper', 'admin', '{invoices,reports}') returning id as keeper \gset
insert into public.memberships (company_id, user_id, role) values (:'co', 'aa220000-0000-0000-0000-000000000002', 'office');
insert into public.memberships (company_id, user_id, role, role_id) values (:'co', 'aa220000-0000-0000-0000-000000000003', 'admin', :'keeper');
commit;

-- ===== Install: owners and admins who connect apps ===========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select wft.expect_error(format('select public.website_forms_set_enabled(%L, true)', :'co'), 'office staff can''t install it');
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select wft.expect_error(format('select public.website_forms_set_enabled(%L, true)', :'co'), 'an admin whose role doesn''t connect apps can''t either');
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
select wft.expect_error(format('select public.website_forms_set_enabled(%L, true)', :'co'), 'nor another business''s owner');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select wft.check(public.website_forms_set_enabled(:'co', true), 'the owner installs it');
select wft.check((select (settings -> 'website_forms' ->> 'enabled')::boolean from public.companies where id = :'co'), 'installed in the company''s settings');
select wft.check((select count(*) = 1 from public.website_forms where company_id = :'co'), 'the first install makes a form');
select wft.check((select name = 'Contact form' and key ~ '^[a-f0-9]{10}$' from public.website_forms where company_id = :'co'), 'called Contact form, at a random address');
select wft.check((select email_to = '{ana@pine.test}' from public.website_forms where company_id = :'co'), 'emailing whoever installed it, when the business has no email of its own');
select public.website_forms_set_enabled(:'co', false);
select wft.check((select count(*) = 1 from public.website_forms where company_id = :'co'), 'uninstalling keeps the form');
select public.website_forms_set_enabled(:'co', true);
select wft.check((select count(*) = 1 from public.website_forms where company_id = :'co'), 'installing again doesn''t make another');
commit;

select id as form, key as form_key from public.website_forms where company_id = :'co' \gset

-- With the business's own address, a new first form emails that.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
update public.companies set email = 'office@oak.test' where id = :'other';
select public.website_forms_set_enabled(:'other', true);
select wft.check((select email_to = '{office@oak.test}' from public.website_forms where company_id = :'other'), 'a business with an email gets its messages there');
commit;

-- ===== Who sees and changes forms ==========================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select wft.check((select count(*) = 1 from public.website_forms), 'the owner sees Pine Lawn''s form and not Oak''s');
update public.website_forms set email_to = '{ana@pine.test,bo@pine.test}', allowed_sites = '{pinelawn.com}' where id = :'form';
select wft.check((select cardinality(email_to) = 2 from public.website_forms where id = :'form'), 'and changes who gets its email');
select wft.expect_error(format('update public.website_forms set redirect_url = %L where id = %L', 'javascript:alert(1)', :'form'), 'a thank-you page is a web address');
select wft.expect_error(format('update public.website_forms set email_to = %L where id = %L', '{a@x.test,b@x.test,c@x.test,d@x.test,e@x.test,f@x.test}', :'form'), 'five people at most');
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
select wft.check((select count(*) = 0 from public.website_forms), 'office staff don''t see forms');
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
select wft.check((select count(*) = 0 from public.website_forms), 'nor an admin without apps');
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000009", "role": "authenticated"}', true);
update public.website_forms set name = 'Hijacked' where id = :'form';
select wft.expect_error(format($q$select public.website_form_request(%L, 'Eve', 'eve@x.test', null, null, '{}', null, 'hi', '{}', '{}', null)$q$, :'form'),
  'nobody signed in makes requests from it');
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select wft.check((select name = 'Contact form' from public.website_forms where id = :'form'), 'another business can''t change it');
commit;

-- ===== Messages ==============================================================================
-- Bo's existing client Carla, by email and phone; and an archived Carla from years ago.
begin;
set local role service_role;
insert into public.clients (company_id, status, display_name, email, phone, created_at) values
  (:'co', 'archived', 'Carla (old)', 'carla@home.test', null, now() - interval '3 years'),
  (:'co', 'active', 'Carla Diaz', 'Carla@Home.test', '(540) 555-0101', now() - interval '1 year');
select id as carla from public.clients where display_name = 'Carla Diaz' \gset
insert into public.properties (company_id, client_id, line1, city) values (:'co', :'carla', '12 Oak St', 'Roanoke') returning id as carla_home \gset
commit;

begin;
set local role service_role;
select public.website_form_request(:'form', 'Dee New', ' Dee@New.test ', null, 'Dee''s Diner', '{"line1": "9 Elm Rd", "city": "Salem", "postal_code": "24153"}',
  null, 'Can you mow on Fridays?', '{"service": "Mowing"}', '{"name": "Dee New", "email": "Dee@New.test"}', '{"page": "/contact"}') as sent \gset
select (:'sent'::jsonb ->> 'request_id')::uuid as dee_request \gset
select wft.check(not (:'sent'::jsonb ->> 'matched')::boolean and (:'sent'::jsonb ->> 'new_property')::boolean, 'someone new: a new lead, at a new property');
select wft.check((select c.display_name = 'Dee New' and c.email = 'dee@new.test' and c.company_name = 'Dee''s Diner' and c.status = 'lead' and c.lead_source = 'Website form'
  from public.requests r join public.clients c on c.id = r.client_id where r.id = :'dee_request'), 'the lead has their name, email, business and where they came from');
select wft.check((select r.source = 'web_form' and r.website_form_id = :'form' and r.title = 'Contact form' and r.details = 'Can you mow on Fridays?' and r.number is not null
  and r.answers = '{"service": "Mowing"}' and r.web_visit = '{"page": "/contact"}' and r.status = 'new' from public.requests r where r.id = :'dee_request'),
  'the request: from the website form, titled by the form, with the message, the other answers and the visit');
select wft.check((select p.line1 = '9 Elm Rd' and p.city = 'Salem' and p.postal_code = '24153' from public.requests r join public.properties p on p.id = r.property_id where r.id = :'dee_request'),
  'at the address they typed');

select public.website_form_request(:'form', 'C. Diaz', 'carla@home.test', '555 0000', null, '{"line1": "12 OAK ST "}',
  'Gutter question', 'Do you clean gutters?', '{}', '{"name": "C. Diaz", "phone": "555 0000"}', null) as sent \gset
select wft.check((:'sent'::jsonb ->> 'matched')::boolean and (:'sent'::jsonb ->> 'client_id')::uuid = :'carla', 'the same email, spelled differently: the client it''s from (not the archived one)');
select wft.check((select display_name = 'Carla Diaz' and email = 'Carla@Home.test' and phone = '(540) 555-0101' from public.clients where id = :'carla'), 'the client''s saved name, email and phone stay');
select wft.check((select r.title = 'Gutter question' and r.answers = '{"name": "C. Diaz", "phone": "555 0000"}' and r.property_id = :'carla_home'
  from public.requests r where r.id = (:'sent'::jsonb ->> 'request_id')::uuid), 'what was typed goes on the request, at the client''s property with that first line');
select wft.check(not (:'sent'::jsonb ->> 'new_property')::boolean, 'no new property for an address the client has');

select public.website_form_request(:'form', 'Carla', null, '+1 540-555-0101', null, '{}', null, 'Call me', '{}', '{}', null) as sent \gset
select wft.check((:'sent'::jsonb ->> 'client_id')::uuid = :'carla', 'the same phone number, written differently, finds Carla too');
select wft.check((select property_id is null from public.requests where id = (:'sent'::jsonb ->> 'request_id')::uuid), 'no address: no property');

select public.website_form_request(:'form', null, null, '0044 20 7946 0958', null, '{}', null, 'From London', '{}', '{}', null) as sent \gset
select wft.check((select c.display_name = '0044 20 7946 0958' from public.requests r join public.clients c on c.id = r.client_id where r.id = (:'sent'::jsonb ->> 'request_id')::uuid),
  'no name: the client is called by how to reach them');

select wft.expect_error(format($q$select public.website_form_request(%L, 'Nobody', 'not an email', ' ', null, '{}', null, 'hi', '{}', '{}', null)$q$, :'form'),
  'no way to reach them: refused');
select wft.expect_error($q$select public.website_form_request('00000000-0000-0000-0000-000000000000', 'X', 'x@x.test', null, null, '{}', null, 'hi', '{}', '{}', null)$q$,
  'an unknown form: refused');
select wft.check((select count(*) = 4 from public.requests where website_form_id = :'form'), 'four requests from the form');
commit;

-- ===== Promo codes (20261031000620_website_form_promo.sql) ===================================
insert into public.promo_codes (company_id, code, kind, value, ends_on, once_per_client, new_clients_only) values
  (:'co', 'SPRING15', 'percent', 15, null, true, false),
  (:'co', 'OLD10', 'amount', 10, current_date - 30, true, false),
  (:'co', 'WELCOME20', 'amount', 20, null, true, true),
  (:'co', 'ONCE5', 'amount', 5, null, true, false),
  (:'co', 'LONGSPRINGSPECIAL-2026-X', 'amount', 5, null, false, false);
-- Carla has had work done, and has used ONCE5 on a quote.
insert into public.jobs (company_id, client_id, title) values (:'co', :'carla', 'Gutters');
insert into public.quotes (company_id, client_id, title, status, promo_code_id)
select :'co', :'carla', 'Gutters', 'sent', id from public.promo_codes where company_id = :'co' and code = 'ONCE5';

begin;
set local role service_role;
select public.website_form_request(p_form => :'form', p_name => 'Fay New', p_email => 'fay@new.test', p_details => 'Spring cleanup?',
  p_answers => '{"Promo Code": " spring 15 "}', p_promo => ' spring 15 ') as sent \gset
select wft.check(:'sent'::jsonb ->> 'promo_code' = 'SPRING15' and :'sent'::jsonb -> 'promo_problem' = 'null', 'a valid code, in any case and with spaces, is ready for the quote');
select wft.check((select promo_code = 'SPRING15' and rejected_promo_code is null and answers = '{"Promo Code": " spring 15 "}' from public.requests where id = (:'sent'::jsonb ->> 'request_id')::uuid),
  'kept as the code is spelled, with what was typed still among the answers');

select public.website_form_request(p_form => :'form', p_name => 'Gil New', p_email => 'gil@new.test', p_promo => 'old10') as sent \gset
select wft.check((select promo_code is null and rejected_promo_code = 'old10' and promo_problem = 'That code expired on ' || to_char(current_date - 30, 'FMMonth FMDD') || '.'
                    from public.requests where id = (:'sent'::jsonb ->> 'request_id')::uuid), 'an expired code keeps the request, and says why it wasn''t applied');
select public.website_form_request(p_form => :'form', p_name => 'Hal New', p_email => 'hal@new.test', p_promo => 'NOPE') as sent \gset
select wft.check(:'sent'::jsonb ->> 'promo_problem' = 'There''s no active code with that name.' and :'sent'::jsonb ->> 'rejected_promo_code' = 'NOPE',
  'an unknown code is said in the office''s words');

select public.website_form_request(p_form => :'form', p_name => 'Ivy New', p_email => 'ivy@new.test', p_promo => 'welcome20') as sent \gset
select wft.check(:'sent'::jsonb ->> 'promo_code' = 'WELCOME20', 'a new customers'' code works for a new lead');
select public.website_form_request(p_form => :'form', p_name => 'Carla', p_email => 'carla@home.test', p_promo => 'WELCOME20') as sent \gset
select wft.check((:'sent'::jsonb ->> 'client_id')::uuid = :'carla' and :'sent'::jsonb ->> 'promo_problem' = 'That code is for new customers, and this client has worked with you before.',
  'and not for a client who''s had work done');
select public.website_form_request(p_form => :'form', p_name => 'Carla', p_email => 'carla@home.test', p_promo => 'once5') as sent \gset
select wft.check(:'sent'::jsonb ->> 'promo_problem' = 'This client has already used that code.' and :'sent'::jsonb -> 'promo_code' = 'null',
  'a code each client uses once, used already');

select public.website_form_request(p_form => :'form', p_name => 'Jo New', p_email => 'jo@new.test', p_promo => '  Long Spring Special-2026-X ') as sent \gset
select wft.check(:'sent'::jsonb ->> 'promo_code' = 'LONGSPRINGSPECIAL-2026-X', 'a long code typed with spaces is kept as the code, which fits');
select public.website_form_request(p_form => :'form', p_name => 'Kit New', p_email => 'kit@new.test', p_promo => repeat('Z', 300)) as sent \gset
select wft.check((select char_length(rejected_promo_code) = 40 and promo_problem is not null from public.requests where id = (:'sent'::jsonb ->> 'request_id')::uuid),
  'anything far too long is cut to 40 characters, and the request is still made');
select wft.check((select count(*) = 12 from public.requests where website_form_id = :'form'), 'every message became a request, codes or not');
commit;

-- ===== Deleting a form keeps its requests ======================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "aa220000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.website_forms where id = :'form';
select wft.check((select count(*) = 0 from public.website_forms where id = :'form'), 'the owner deletes the form');
select wft.check((select count(*) = 1 from public.requests where id = :'dee_request' and website_form_id is null), 'its requests stay in Requests');
commit;
