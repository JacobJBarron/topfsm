-- Database tests for roofing estimates (20261023001000_roofing_estimates): estimate templates are
-- read by everyone in the business and changed only by the office with the Settings area, one
-- default each; a saved signature is its owner's alone; roof packages are read by the people who
-- price work and changed by the price list's people, and go away with their services; a quote keeps
-- a sane price range and lets go of a deleted template or package; and a client's yes to a range
-- (accept_hub_range) only comes from the server, counts once, stops the "any questions?" follow-up
-- and tells the office, which every business is set up to hear.
-- Run with scripts/test-db.sh (plain Postgres + prelude.sql). Any failed check stops with an error.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create schema t_roofing;
grant usage on schema t_roofing to anon, authenticated, service_role;
create function t_roofing.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAIL: %', p_what; end if;
  raise notice 'ok - %', p_what;
end $$;
create function t_roofing.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then raise notice 'ok - % (%)', p_what, sqlerrm; return; end;
  raise exception 'FAIL (expected an error): %', p_what;
end $$;
grant execute on all functions in schema t_roofing to anon, authenticated, service_role;

-- Two small signatures (the database only checks the shape, not the picture).
\set sig_eli 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
\set sig_eli_again 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNkYGD4z8DAwMAAAA0AAf9F8dvOAAAAAElFTkSuQmCC'
\set sig_rosa 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAEUlEQVR42mNkYPhfzwAHjFIAAD+bA/2l3XyRAAAAAElFTkSuQmCC'

insert into auth.users (id, email, raw_user_meta_data) values
  ('e57a0000-0000-0000-0000-000000000001', 'owner@ridgetop.test', '{"full_name": "Rosa Ridge"}'),
  ('e57a0000-0000-0000-0000-000000000002', 'admin@ridgetop.test', '{"full_name": "Abe Admin"}'),
  ('e57a0000-0000-0000-0000-000000000003', 'office@ridgetop.test', '{"full_name": "Olga Office"}'),
  ('e57a0000-0000-0000-0000-000000000004', 'estimator@ridgetop.test', '{"full_name": "Eli Estimator"}'),
  ('e57a0000-0000-0000-0000-000000000005', 'crew@ridgetop.test', '{"full_name": "Cam Crew"}'),
  ('e57a0000-0000-0000-0000-000000000006', 'ops@ridgetop.test', '{"full_name": "Opal Ops"}'),
  ('e57a0000-0000-0000-0000-000000000007', 'owner@hilltop.test', '{"full_name": "Hal Hilltop"}'),
  ('e57a0000-0000-0000-0000-000000000008', 'owner@brandnew.test', '{"full_name": "Nell Newco"}');

-- ===== Two roofing businesses ===================================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select public.create_company('Ridge Top Roofing', 'roofing_exteriors') as co \gset
select id as ops_role from public.company_roles where company_id = :'co' and name = 'Operations manager' \gset
insert into public.memberships (company_id, user_id, role, role_id) values
  (:'co', 'e57a0000-0000-0000-0000-000000000002', 'admin', null),
  (:'co', 'e57a0000-0000-0000-0000-000000000003', 'office', null),
  (:'co', 'e57a0000-0000-0000-0000-000000000004', 'estimator', null),
  (:'co', 'e57a0000-0000-0000-0000-000000000005', 'field_crew', null),
  -- Office level, but the Settings area is off (the starter "Operations manager" role).
  (:'co', 'e57a0000-0000-0000-0000-000000000006', 'office', :'ops_role');
insert into public.services (company_id, name, unit, unit_price, unit_cost, formula) values (:'co', 'Architectural shingle roof', 'square', 560, 330, 'squares') returning id as roof \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost, formula) values (:'co', 'Standing-seam metal roof', 'square', 1150, 700, 'squares') returning id as metal_roof \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost, formula) values (:'co', 'Ridge vent', 'ft', 9, 4, 'ridge_ft') returning id as ridge \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'Pipe boot', 'ea', 85, 30) returning id as boots \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'Chimney flashing', 'ea', 650, 240) returning id as chimney \gset
insert into public.services (company_id, name, unit, unit_price, unit_cost) values (:'co', 'Rotten decking', 'sheet', 95, 40) returning id as decking \gset
insert into public.clients (company_id, display_name) values (:'co', 'Jo Homeowner') returning id as client \gset
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select public.create_company('Hilltop Exteriors', 'roofing_exteriors') as other \gset
insert into public.services (company_id, name, unit, unit_price, formula) values (:'other', 'Their shingle roof', 'square', 500, 'squares') returning id as other_roof \gset
insert into public.document_templates (company_id, name, is_default) values (:'other', 'Hilltop standard', true) returning id as other_tpl \gset
insert into public.roof_packages (company_id, name, roof_service_id, is_default) values (:'other', 'Their shingles', :'other_roof', true) returning id as other_pkg \gset
commit;

-- ===== Estimate templates: the office sets them up =============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.document_templates (company_id, name, is_default, settings)
  values (:'co', 'Standard', true, '{"header": "classic", "color": "#2f5d8a", "terms": "Half down, the rest when it''s done.", "company_signs": true}')
  returning id as tpl \gset
select t_roofing.check((select is_default and created_by = 'e57a0000-0000-0000-0000-000000000001' and settings ->> 'header' = 'classic' from public.document_templates where id = :'tpl'),
  'the owner saves the Standard template as the default, and it remembers who made it');
insert into public.document_templates (company_id, name) values (:'co', 'Insurance work') returning id as tpl_insurance \gset
select t_roofing.check((select not is_default and settings = '{}' from public.document_templates where id = :'tpl_insurance'), 'a second template isn''t the default and starts with the standard look');
select t_roofing.expect_error(format('insert into public.document_templates (company_id, name, is_default) values (%L, %L, true)', :'co', 'Also default'), 'a business has one default template');
select t_roofing.expect_error(format('update public.document_templates set is_default = true where id = %L', :'tpl_insurance'), 'even when one is changed to it');
select t_roofing.expect_error(format('insert into public.document_templates (company_id, name, settings) values (%L, %L, %L)', :'co', 'Odd', '[]'), 'a template''s settings are one record');
select t_roofing.expect_error(format('insert into public.document_templates (company_id, name) values (%L, %L)', :'co', '   '), 'a template needs a name');
select t_roofing.expect_error(format('insert into public.document_templates (company_id, name) values (%L, %L)', :'co', repeat('x', 81)), 'a short one');
-- "Make default", the way Settings does it: the old default first, then the new one.
update public.document_templates set is_default = false where company_id = :'co' and is_default;
update public.document_templates set is_default = true where id = :'tpl_insurance';
select t_roofing.check((select count(*) = 1 from public.document_templates where company_id = :'co' and is_default and id = :'tpl_insurance'), 'another template can be made the default');
update public.document_templates set is_default = false where company_id = :'co' and is_default;
update public.document_templates set is_default = true where id = :'tpl';
commit;
select t_roofing.check((select count(*) = 2 from public.document_templates where is_default and company_id in (:'co', :'other')), 'each business has its own default template');

-- An admin and the office change them; Operations (no Settings), estimators and crews only read them.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
update public.document_templates set settings = settings || '{"license": "RC-104882", "show_license": true}' where id = :'tpl';
select t_roofing.check((select settings ->> 'license' = 'RC-104882' from public.document_templates where id = :'tpl'), 'an admin adds the license number');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
insert into public.document_templates (company_id, name) values (:'co', 'Office copy') returning id as tpl_office \gset
update public.document_templates set name = 'Insurance claims' where id = :'tpl_insurance';
select t_roofing.check((select name = 'Insurance claims' from public.document_templates where id = :'tpl_insurance'), 'the office adds and renames templates');
delete from public.document_templates where id = :'tpl_office';
select t_roofing.check((select count(*) = 2 from public.document_templates where company_id = :'co'), 'and deletes them');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 2 from public.document_templates), 'Operations reads the templates to print with');
select t_roofing.expect_error(format('insert into public.document_templates (company_id, name) values (%L, %L)', :'co', 'Ops copy'), 'but without Settings can''t add one');
update public.document_templates set name = 'Ops rename' where id = :'tpl';
delete from public.document_templates where id = :'tpl_insurance';
select t_roofing.check((select count(*) = 2 and bool_and(name <> 'Ops rename') from public.document_templates), 'or change or delete one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 2 from public.document_templates), 'the estimator reads the templates to print and sign with');
select t_roofing.expect_error(format('insert into public.document_templates (company_id, name) values (%L, %L)', :'co', 'My own'), 'but can''t add one');
update public.document_templates set settings = '{"terms": "No warranty."}' where id = :'tpl';
delete from public.document_templates where id = :'tpl_insurance';
select t_roofing.check((select count(*) = 2 from public.document_templates where settings ->> 'terms' is distinct from 'No warranty.'), 'or change or delete one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 2 from public.document_templates), 'field crew can read the templates (everyone in the business prints with them)');
select t_roofing.expect_error(format('insert into public.document_templates (company_id, name) values (%L, %L)', :'co', 'Crew copy'), 'but can''t add one');
update public.document_templates set name = 'Crew rename' where id = :'tpl';
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 0 from public.document_templates where company_id = :'co'), 'another business sees none of them');
select t_roofing.expect_error(format('insert into public.document_templates (company_id, name) values (%L, %L)', :'co', 'Planted'), 'or adds one to this business');
update public.document_templates set name = 'Taken over' where id = :'tpl';
commit;
select t_roofing.check((select name = 'Standard' and is_default from public.document_templates where id = :'tpl'), 'nobody without the right changed the Standard template');

-- ===== Saved signatures: each person's own ======================================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
insert into public.user_signatures (company_id, user_id, image) values (:'co', 'e57a0000-0000-0000-0000-000000000004', :'sig_eli');
select t_roofing.check((select count(*) = 1 from public.user_signatures where image = :'sig_eli'), 'the estimator saves their signature');
select t_roofing.expect_error(format('insert into public.user_signatures (company_id, user_id, image) values (%L, %L, %L)', :'co', 'e57a0000-0000-0000-0000-000000000004', :'sig_eli'), 'one per person in a business');
-- "Sign again" saves over it (PUT /api/me/signature upserts).
insert into public.user_signatures (company_id, user_id, image) values (:'co', 'e57a0000-0000-0000-0000-000000000004', :'sig_eli_again')
  on conflict (company_id, user_id) do update set image = excluded.image;
select t_roofing.check((select image = :'sig_eli_again' from public.user_signatures where user_id = 'e57a0000-0000-0000-0000-000000000004'), 'signing again replaces it');
select t_roofing.expect_error(format('insert into public.user_signatures (company_id, user_id, image) values (%L, %L, %L)', :'co', 'e57a0000-0000-0000-0000-000000000001', :'sig_eli'), 'nobody saves a signature for someone else');
select t_roofing.expect_error(format('insert into public.user_signatures (company_id, user_id, image) values (%L, %L, %L)', :'other', 'e57a0000-0000-0000-0000-000000000004', :'sig_eli'), 'or in a business they don''t work for');
select t_roofing.expect_error(format('update public.user_signatures set image = %L where user_id = %L', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', 'e57a0000-0000-0000-0000-000000000004'), 'a signature is a PNG picture');
select t_roofing.expect_error(format('update public.user_signatures set image = %L where user_id = %L', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'e57a0000-0000-0000-0000-000000000004'), 'not a drawing that could carry a script');
select t_roofing.expect_error(format('update public.user_signatures set image = %L where user_id = %L', 'https://example.test/sig.png', 'e57a0000-0000-0000-0000-000000000004'), 'or a link to one');
select t_roofing.expect_error(format('update public.user_signatures set image = %L where user_id = %L', :'sig_eli' || E'\n<script>alert(1)</script>', 'e57a0000-0000-0000-0000-000000000004'), 'with nothing after the picture');
update public.user_signatures set image = 'data:image/png;base64,' || repeat('A', 300000 - 22) where user_id = 'e57a0000-0000-0000-0000-000000000004';
select t_roofing.check((select length(image) = 300000 from public.user_signatures where user_id = 'e57a0000-0000-0000-0000-000000000004'), 'a detailed signature fits, up to 300,000 characters');
select t_roofing.expect_error(format('update public.user_signatures set image = %L where user_id = %L', 'data:image/png;base64,' || repeat('A', 300000 - 21), 'e57a0000-0000-0000-0000-000000000004'), 'and no bigger');
update public.user_signatures set image = :'sig_eli_again' where user_id = 'e57a0000-0000-0000-0000-000000000004';
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 0 from public.user_signatures), 'even the owner can''t see the estimator''s signature');
insert into public.user_signatures (company_id, user_id, image) values (:'co', 'e57a0000-0000-0000-0000-000000000001', :'sig_rosa');
select t_roofing.check((select count(*) = 1 and bool_and(user_id = 'e57a0000-0000-0000-0000-000000000001') from public.user_signatures), 'the owner sees only their own');
update public.user_signatures set image = :'sig_rosa' where user_id = 'e57a0000-0000-0000-0000-000000000004';
delete from public.user_signatures where user_id = 'e57a0000-0000-0000-0000-000000000004';
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 1 and bool_and(image = :'sig_eli_again') from public.user_signatures), 'the owner couldn''t change or delete it, and the estimator still sees only their own');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 0 from public.user_signatures), 'another business sees no signatures');
commit;

set role service_role;
select t_roofing.check((select count(*) = 2 from public.user_signatures where company_id = :'co'), 'the server reads a salesperson''s signature to sign for the business');
reset role;

-- ===== Roof packages: the price list's people set them up ======================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
insert into public.roof_packages (company_id, name, style, roof_service_id, is_default) values (:'co', 'Architectural shingle', 'shingle', :'roof', true) returning id as pkg \gset
select t_roofing.check((select price_mode = 'manual' and markup_pct = 70 and sort = 0 from public.roof_packages where id = :'pkg'), 'a package starts priced by hand, with a 70% markup ready for ABC prices');
insert into public.roof_packages (company_id, name, style, roof_service_id, price_mode, markup_pct, sort) values (:'co', 'Standing-seam metal', 'metal', :'metal_roof', 'follow', 45, 1) returning id as metal \gset
insert into public.roof_package_items (company_id, package_id, service_id, kind, sort) values (:'co', :'pkg', :'ridge', 'included', 0);
insert into public.roof_package_items (company_id, package_id, service_id, kind, quantity, sort) values (:'co', :'pkg', :'boots', 'included', 3, 1);
insert into public.roof_package_items (company_id, package_id, service_id, kind, sort) values (:'co', :'pkg', :'chimney', 'quick', 0);
insert into public.roof_package_items (company_id, package_id, service_id, kind, sort) values (:'co', :'pkg', :'decking', 'quick', 1);
insert into public.roof_package_items (company_id, package_id, service_id, kind, quantity) values (:'co', :'metal', :'boots', 'included', 3);
insert into public.roof_package_items (company_id, package_id, service_id, kind) values (:'co', :'metal', :'chimney', 'quick');
select t_roofing.check((select count(*) = 4 from public.roof_package_items where package_id = :'pkg')
                   and (select quantity = 3 from public.roof_package_items where package_id = :'pkg' and service_id = :'boots'),
  'the owner puts the ridge vent and 3 pipe boots on the shingle roof, with chimney and decking as quick adds');
select t_roofing.expect_error(format('insert into public.roof_packages (company_id, name, is_default) values (%L, %L, true)', :'co', 'Also default'), 'a business has one default package');
select t_roofing.expect_error(format('insert into public.roof_packages (company_id, name, style) values (%L, %L, %L)', :'co', 'Slate', 'slate'), 'a package''s picture is one of the styles');
select t_roofing.expect_error(format('insert into public.roof_packages (company_id, name, price_mode) values (%L, %L, %L)', :'co', 'Guess', 'guess'), 'it''s priced by hand or follows ABC');
select t_roofing.expect_error(format('update public.roof_packages set markup_pct = -1 where id = %L', :'metal'), 'the markup isn''t below nothing');
select t_roofing.expect_error(format('update public.roof_packages set markup_pct = 1001 where id = %L', :'metal'), 'or above 1000%');
select t_roofing.expect_error(format('insert into public.roof_packages (company_id, name) values (%L, %L)', :'co', ' '), 'a package needs a name');
select t_roofing.expect_error(format('insert into public.roof_package_items (company_id, package_id, service_id, kind) values (%L, %L, %L, %L)', :'co', :'pkg', :'metal_roof', 'extra'), 'a package''s service is always on the roof or a quick add');
select t_roofing.expect_error(format('insert into public.roof_package_items (company_id, package_id, service_id, kind, quantity) values (%L, %L, %L, %L, 0)', :'co', :'metal', :'decking', 'included'), 'it starts with at least a little');
select t_roofing.expect_error(format('insert into public.roof_package_items (company_id, package_id, service_id, kind) values (%L, %L, %L, %L)', :'co', :'pkg', :'chimney', 'quick'), 'and is a quick add only once');
select t_roofing.expect_error(format('insert into public.roof_package_items (company_id, package_id, service_id, kind) values (%L, %L, %L, %L)', :'co', :'pkg', :'other_roof', 'included'), 'a package can''t use another business''s service');
select t_roofing.expect_error(format('insert into public.roof_packages (company_id, name, roof_service_id) values (%L, %L, %L)', :'co', 'Borrowed', :'other_roof'), 'or price its roof with one');
select t_roofing.expect_error(format('insert into public.roof_package_items (company_id, package_id, service_id, kind) values (%L, %L, %L, %L)', :'co', :'other_pkg', :'chimney', 'quick'), 'or add to another business''s package');
-- "Make default", the way the Packages page does it.
update public.roof_packages set is_default = false where company_id = :'co' and is_default;
update public.roof_packages set is_default = true where id = :'metal';
select t_roofing.check((select count(*) = 1 from public.roof_packages where company_id = :'co' and is_default and id = :'metal'), 'another package can be made the default');
update public.roof_packages set is_default = false where company_id = :'co' and is_default;
update public.roof_packages set is_default = true where id = :'pkg';
commit;
select t_roofing.check((select count(*) = 3 from pg_constraint where conname in
  ('roof_packages_company_id_roof_service_id_fkey', 'roof_package_items_company_id_package_id_fkey', 'quotes_roof_package_fkey')),
  'the links the app''s package queries name are there');

-- Estimators and Operations price with them but don't change them; the office and admins do.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 2 from public.roof_packages) and (select count(*) = 6 from public.roof_package_items), 'the estimator sees both packages and what''s in them');
select t_roofing.expect_error(format('insert into public.roof_packages (company_id, name) values (%L, %L)', :'co', 'Mine'), 'but can''t add a package');
select t_roofing.expect_error(format('insert into public.roof_package_items (company_id, package_id, service_id, kind) values (%L, %L, %L, %L)', :'co', :'metal', :'decking', 'quick'), 'or a quick add');
update public.roof_packages set markup_pct = 5 where id = :'metal';
delete from public.roof_package_items where package_id = :'pkg';
select t_roofing.check((select markup_pct = 45 from public.roof_packages where id = :'metal') and (select count(*) = 4 from public.roof_package_items where package_id = :'pkg'), 'or change the markup or take things out');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000006", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 2 from public.roof_packages), 'Operations sees the packages');
select t_roofing.expect_error(format('insert into public.roof_packages (company_id, name) values (%L, %L)', :'co', 'Ops package'), 'but without Settings can''t add one');
update public.roof_packages set name = 'Ops rename' where id = :'pkg';
select t_roofing.check((select name = 'Architectural shingle' from public.roof_packages where id = :'pkg'), 'or rename one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.roof_packages set markup_pct = 50 where id = :'metal';
select t_roofing.check((select markup_pct = 50 from public.roof_packages where id = :'metal'), 'the office changes the metal roof''s markup');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000002", "role": "authenticated"}', true);
insert into public.roof_package_items (company_id, package_id, service_id, kind, sort) values (:'co', :'metal', :'decking', 'quick', 1);
select t_roofing.check((select count(*) = 3 from public.roof_package_items where package_id = :'metal'), 'an admin adds a quick add to the metal roof');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 0 from public.roof_packages) and (select count(*) = 0 from public.roof_package_items), 'field crew don''t see packages or their prices');
select t_roofing.expect_error(format('insert into public.roof_packages (company_id, name) values (%L, %L)', :'co', 'Crew package'), 'or add one');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000007", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 0 from public.roof_packages where company_id = :'co') and (select count(*) = 0 from public.roof_package_items where company_id = :'co'), 'another business sees none of them');
select t_roofing.expect_error(format('insert into public.roof_packages (company_id, name) values (%L, %L)', :'co', 'Planted'), 'or adds one to this business');
commit;

-- ===== Quotes: the template, the package and the range =========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
-- A: the range goes out and the client says yes.
insert into public.quotes (company_id, client_id, title, roof_package_id, template_id) values (:'co', :'client', 'New roof', :'pkg', :'tpl_insurance') returning id as quote_a \gset
insert into public.quote_line_items (company_id, quote_id, service_id, name, quantity, unit, unit_price, unit_cost, formula, sort) values
  (:'co', :'quote_a', :'roof', 'Architectural shingle roof', 28, 'square', 560, 330, 'squares', 0),
  (:'co', :'quote_a', :'ridge', 'Ridge vent', 48, 'ft', 9, 4, 'ridge_ft', 1),
  (:'co', :'quote_a', :'boots', 'Pipe boot', 3, 'ea', 85, 30, null, 2);
select t_roofing.expect_error(format('update public.quotes set range_low = 21050, range_high = 18300 where id = %L', :'quote_a'), 'a range''s low end isn''t above its high end');
select t_roofing.expect_error(format('update public.quotes set range_low = 18300 where id = %L', :'quote_a'), 'a range has both ends');
select t_roofing.expect_error(format('update public.quotes set range_high = 21050 where id = %L', :'quote_a'), 'both of them');
select t_roofing.expect_error(format('update public.quotes set range_low = -10, range_high = 100 where id = %L', :'quote_a'), 'and isn''t below nothing');
select t_roofing.expect_error(format('update public.quotes set range_lines = %L where id = %L', '{"name": "Roof"}', :'quote_a'), 'the lines a range came from are a list');
select t_roofing.expect_error(format('update public.quotes set template_id = %L where id = %L', :'other_tpl', :'quote_a'), 'a quote can''t print with another business''s template');
select t_roofing.expect_error(format('update public.quotes set roof_package_id = %L where id = %L', :'other_pkg', :'quote_a'), 'or use another business''s package');
update public.quotes set range_low = 19000, range_high = 19000 where id = :'quote_a';
select t_roofing.check((select range_low = range_high from public.quotes where id = :'quote_a'), 'a range can be one price');
update public.quotes set range_low = 18300, range_high = 21050, range_sent_at = now(),
  range_lines = '[{"name": "Architectural shingle roof", "quantity": 28, "unit": "square", "unit_price": 560, "total": 15680}]',
  status = 'sent', sent_at = now()
  where id = :'quote_a';
select t_roofing.check((select range_low = 18300 and range_high = 21050 and jsonb_array_length(range_lines) = 1 and template_id = :'tpl_insurance' and roof_package_id = :'pkg'
                          from public.quotes where id = :'quote_a'), 'the office sends Jo a range of $18,300 to $21,050');

-- B: another client's range, still out.
insert into public.quotes (company_id, client_id, title, roof_package_id) values (:'co', :'client', 'Garage roof', :'pkg') returning id as quote_b \gset
update public.quotes set range_low = 6200, range_high = 7150, range_sent_at = now(), range_lines = '[]', status = 'sent', sent_at = now() where id = :'quote_b';
-- C: the range is worked out but not sent.
insert into public.quotes (company_id, client_id, title, roof_package_id) values (:'co', :'client', 'Shed roof', :'pkg') returning id as quote_c \gset
update public.quotes set range_low = 2100, range_high = 2450 where id = :'quote_c';
-- D: an exact price, no range.
insert into public.quotes (company_id, client_id, title) values (:'co', :'client', 'Gutters') returning id as quote_d \gset
update public.quotes set status = 'sent', sent_at = now() where id = :'quote_d';
-- E: the salesperson already set the price on site.
insert into public.quotes (company_id, client_id, title, roof_package_id) values (:'co', :'client', 'Porch roof', :'pkg') returning id as quote_e \gset
update public.quotes set range_low = 3100, range_high = 3600, range_sent_at = now(), status = 'sent', sent_at = now(), priced_on_site_at = now() where id = :'quote_e';
-- F: signed already.
insert into public.quotes (company_id, client_id, title, roof_package_id) values (:'co', :'client', 'Barn roof', :'pkg') returning id as quote_f \gset
update public.quotes set range_low = 9100, range_high = 10500, range_sent_at = now(), status = 'sent', sent_at = now() where id = :'quote_f';
update public.quotes set status = 'approved', approved_at = now(), approval = '{"name": "Jo Homeowner", "method": "in_person"}' where id = :'quote_f';
-- G: the client asked a question about the range first.
insert into public.quotes (company_id, client_id, title, roof_package_id) values (:'co', :'client', 'Cabin roof', :'pkg') returning id as quote_g \gset
update public.quotes set range_low = 11200, range_high = 12900, range_sent_at = now(), status = 'sent', sent_at = now() where id = :'quote_g';
update public.quotes set status = 'changes_requested' where id = :'quote_g';
commit;

select number as a_number from public.quotes where id = :'quote_a' \gset
select t_roofing.check((select count(*) = 1 from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                         where ru.template_key = 'quote_followup' and r.subject_id = :'quote_a' and r.status = 'pending'),
  'sending the range queued the 3-day follow-up');

-- ===== Saying yes to a range only comes from the server ========================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
select t_roofing.expect_error(format('select public.accept_hub_range(%L, %L)', :'co', :'quote_a'), 'even the owner can''t say yes for the client');
rollback;
begin;
set local role anon;
select t_roofing.expect_error(format('select public.accept_hub_range(%L, %L)', :'co', :'quote_a'), 'and nobody without an account calls it directly');
rollback;
select t_roofing.check((select range_accepted_at is null from public.quotes where id = :'quote_a'), 'so the range is still waiting');

set role service_role;
select t_roofing.check(public.accept_hub_range(:'other', :'quote_a') is null, 'another business''s link says yes to nothing');
select t_roofing.check(public.accept_hub_range(:'co', gen_random_uuid()) is null, 'a quote that isn''t there says yes to nothing');
select t_roofing.check(answer.at is not null, 'Jo says yes to the range'), answer.at as accepted from (select public.accept_hub_range(:'co', :'quote_a') as at) answer \gset
select t_roofing.check(public.accept_hub_range(:'co', :'quote_a') is null, 'saying yes again changes nothing');
select t_roofing.check(public.accept_hub_range(:'co', :'quote_c') is null, 'a range that wasn''t sent can''t be said yes to');
select t_roofing.check(public.accept_hub_range(:'co', :'quote_d') is null, 'nor an exact price with no range');
select t_roofing.check(public.accept_hub_range(:'co', :'quote_e') is null, 'nor a range already priced on site');
select t_roofing.check(public.accept_hub_range(:'co', :'quote_f') is null, 'nor a signed estimate');
select t_roofing.check(public.accept_hub_range(:'co', :'quote_g') is not null, 'a client who asked a question can still say yes');
reset role;

select t_roofing.check((select range_accepted_at = :'accepted'::timestamptz and status = 'sent' and priced_on_site_at is null and range_low = 18300 and range_high = 21050
                          from public.quotes where id = :'quote_a'), 'the quote remembers when Jo said yes, and is otherwise unchanged');
select t_roofing.check((select bool_and(range_accepted_at is null) from public.quotes where id in (:'quote_b', :'quote_c', :'quote_d', :'quote_e', :'quote_f')), 'no other quote was said yes to');
select t_roofing.check((select count(*) = 1 from public.activity where subject_id = :'quote_a' and verb = 'quote.range_accepted'), 'the activity feed shows the yes once');
select t_roofing.check((select summary = format('Jo Homeowner said yes to $18,300.00 to $21,050.00 for quote #%s', :'a_number')
                               and (data ->> 'number')::bigint = :a_number and (data ->> 'range_low')::numeric = 18300 and (data ->> 'range_high')::numeric = 21050
                               and actor_id is null and company_id = :'co' and subject_type = 'quote'
                          from public.activity where subject_id = :'quote_a' and verb = 'quote.range_accepted'),
  'with who said yes, to what range, on which quote');
select t_roofing.check((select count(*) = 0 from public.activity where verb = 'quote.range_accepted' and subject_id in (:'quote_b', :'quote_c', :'quote_d', :'quote_e', :'quote_f')), 'and nothing for the others');

-- The follow-up ("any questions about your quote?") would ask what Jo just answered.
select t_roofing.check((select status = 'cancelled' and error = 'The client said yes to the price range.' and finished_at is not null
                          from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                         where ru.template_key = 'quote_followup' and r.subject_id = :'quote_a'), 'Jo''s 3-day follow-up is called off');
select t_roofing.check((select count(*) = 1 and bool_and(r.status = 'pending') from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                         where ru.template_key = 'quote_followup' and r.subject_id = :'quote_b'), 'another quote''s follow-up still goes out');
select t_roofing.check((select count(*) = 1 and bool_and(r.status = 'pending') from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                         where ru.template_key = 'quote_followup' and r.subject_id = :'quote_d'), 'and one that said yes to nothing keeps its follow-up');
select t_roofing.check((select status = 'cancelled' from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                         where ru.template_key = 'quote_followup' and r.subject_id = :'quote_g'), 'the follow-up of the client who asked a question is called off too');
select t_roofing.check((select count(*) = 1 and bool_and(r.status = 'pending') from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                         where ru.template_key = 'notify_changes_requested' and r.subject_id = :'quote_g'), 'but not the office''s note about their question');

-- The office hears about it.
select t_roofing.check((select count(*) = 1 and bool_and(r.status = 'pending' and r.run_after <= now() and r.subject_type = 'quote')
                          from public.automation_runs r join public.automation_rules ru on ru.id = r.rule_id
                         where ru.template_key = 'notify_range_accepted' and r.subject_id = :'quote_a'), 'a note to book the site visit is on its way to the office');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 1 from public.activity where subject_id = :'quote_a' and verb = 'quote.range_accepted'), 'the estimator sees that Jo said yes');
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000005", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 0 from public.activity where verb = 'quote.range_accepted'), 'field crew don''t see prices in the feed');
commit;

-- The office sends a new range (send-range clears the old answer); Jo can say yes to that one.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000003", "role": "authenticated"}', true);
update public.quotes set range_low = 18500, range_high = 21300, range_sent_at = now(), range_accepted_at = null, priced_on_site_at = null where id = :'quote_a';
commit;
set role service_role;
select t_roofing.check(public.accept_hub_range(:'co', :'quote_a') is not null, 'a range sent again can be said yes to again');
reset role;
select t_roofing.check((select count(*) = 2 from public.activity where subject_id = :'quote_a' and verb = 'quote.range_accepted')
                   and (select summary like 'Jo Homeowner said yes to $18,500.00 to $21,300.00 %' from public.activity where subject_id = :'quote_a' and verb = 'quote.range_accepted' order by id desc limit 1),
  'and the feed shows the new range');

-- ===== Deleting a template, a service or a package ============================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
delete from public.document_templates where id = :'tpl_insurance';
select t_roofing.check((select template_id is null and title = 'New roof' from public.quotes where id = :'quote_a'), 'a quote whose template is deleted prints with the default');

delete from public.services where id = :'ridge';
select t_roofing.check((select count(*) = 3 from public.roof_package_items where package_id = :'pkg')
                   and not exists (select 1 from public.roof_package_items where service_id = :'ridge'), 'deleting a service takes it out of every package');
select t_roofing.check((select service_id is null from public.quote_line_items where quote_id = :'quote_a' and name = 'Ridge vent'), 'and leaves the estimate''s line as it was');

delete from public.services where id = :'roof';
select t_roofing.check((select roof_service_id is null and name = 'Architectural shingle' from public.roof_packages where id = :'pkg'), 'a package whose roof service is deleted stays, without a roof price');

delete from public.roof_packages where id = :'pkg';
select t_roofing.check((select count(*) = 0 from public.roof_package_items where package_id = :'pkg'), 'deleting a package deletes what was in it');
select t_roofing.check((select count(*) = 3 from public.roof_package_items where package_id = :'metal'), 'and leaves the other packages alone');
select t_roofing.check((select bool_and(roof_package_id is null) and count(*) = 6 from public.quotes where id in (:'quote_a', :'quote_b', :'quote_c', :'quote_e', :'quote_f', :'quote_g')),
  'its quotes stay, without a package');
select t_roofing.check((select count(*) = 3 from public.quote_line_items where quote_id = :'quote_a'), 'with all their lines');
commit;

-- ===== Every business hears about a yes ========================================================
select t_roofing.check((select count(*) = 0 from public.companies c
                         where (select count(*) from public.automation_rules r where r.company_id = c.id and r.template_key = 'notify_range_accepted') <> 1),
  'every business has the "wants a visit" rule once');
select t_roofing.check((select enabled and trigger = 'quote.range_accepted' and delay_minutes = 0 and conditions = '[]'
                               and actions -> 0 ->> 'type' = 'notify'
                               and actions -> 0 -> 'roles' = '["owner", "admin", "office", "estimator"]'
                               and actions -> 0 ->> 'title' = '{{client.name}} wants a visit'
                          from public.automation_rules where company_id = :'co' and template_key = 'notify_range_accepted'),
  'it notifies the office and the estimators at once, and is on');

begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000008", "role": "authenticated"}', true);
select public.create_company('Brand New Roofing', 'roofing_exteriors') as newco \gset
commit;
select t_roofing.check((select count(*) = 1 from public.automation_rules where company_id = :'newco' and template_key = 'notify_range_accepted' and enabled),
  'a new business gets it');
select t_roofing.check((select count(*) = 11 from public.automation_rules where company_id = :'newco' and template_key in
  ('notify_quote_approved', 'notify_changes_requested', 'notify_range_accepted', 'notify_new_request', 'notify_invoice_paid',
   'quote_followup', 'invoice_overdue', 'visit_reminder', 'on_my_way', 'review_after_job', 'review_recurring')), 'along with all the other starter rules');
select private.install_default_automations(:'newco');
select t_roofing.check((select count(*) = 11 from public.automation_rules where company_id = :'newco'), 'setting up the starter rules again adds nothing');
delete from public.companies where id = :'newco';

-- ===== Someone who leaves can't use their signature there ======================================
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000001", "role": "authenticated"}', true);
update public.memberships set active = false where company_id = :'co' and user_id = 'e57a0000-0000-0000-0000-000000000004';
commit;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "e57a0000-0000-0000-0000-000000000004", "role": "authenticated"}', true);
select t_roofing.check((select count(*) = 0 from public.user_signatures), 'an estimator who left no longer sees their signature');
select t_roofing.expect_error(format('insert into public.user_signatures (company_id, user_id, image) values (%L, %L, %L) on conflict (company_id, user_id) do update set image = excluded.image',
  :'co', 'e57a0000-0000-0000-0000-000000000004', :'sig_eli'), 'or saves a new one');
commit;
update public.memberships set active = true where company_id = :'co' and user_id = 'e57a0000-0000-0000-0000-000000000004';

\o
\echo 'All roofing estimate tests passed.'
